/**
 * 差分同步。
 *
 * 两种模式，语义不同，别混用：
 *
 *   增量（默认）：从收藏列表头部往后翻，直到「连续两页的 id 全都已在本地」为止。
 *     因为列表是按收藏时间倒序的，出现整页已知就说明已经追平，后面只会更旧。
 *     只追加、不标记移除，最省请求 —— 日常跑这个。
 *
 *   全量（--full）：翻完所有页，以服务端为准比对，能发现取消收藏和元数据变更。
 *     请求量随收藏数线性增长（每页至少 2 秒）。
 *
 * 公开与私密是**两个独立的列表**（rest=show / rest=hide），各有自己的总数和分页，
 * 必须分别同步、分别落盘，无法合并成一次翻页。
 *
 * 两个必须存在的安全阀：
 *   1. 全量模式如果绝大多数记录都没在服务端出现（典型场景是 cookie 失效、接口返回
 *      空列表），绝不写入。宁可不更新，也不能把整个收藏夹误标成「已移除」。
 *   2. 旧版本数据没有 id（收藏序号）时拒绝增量同步 —— 否则新记录带序号、旧记录没有，
 *      排序会彻底错乱。必须先跑一次全量完成迁移。
 */
import { normalizeIllust, normalizeNovel } from './pixiv.mjs';
import { diffRecords, readRecords, writeRecords } from './store.mjs';

function localDateString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 全量模式下判定「结果可疑」的阈值：未在服务端出现的记录占比超过它就中止。 */
const SHRINK_GUARD_RATIO = 0.5;
const SHRINK_GUARD_MIN_COUNT = 10;

export class SyncAbort extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncAbort';
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/**
 * 拉取一类收藏并合并到本地文件。
 */
export async function syncKind(client, options) {
  const {
    kind,
    visibility = 'public',
    filePath,
    limit,
    full = false,
    dryRun = false,
    maxPages = 0,
    onProgress,
    label,
  } = options;

  const existing = await readRecords(filePath);
  const knownIds = new Set(existing.map((r) => String(r.pid)));
  const existingById = new Map(existing.map((r) => [String(r.pid), r]));

  // 旧数据迁移保护：没有 id（收藏序号）就建立不起收藏顺序，增量会写出乱序文件。
  const missingSeq = existing.filter((r) => !(Number(r.id) > 0)).length;
  if (missingSeq > 0 && !full) {
    throw new SyncAbort(
      `${label}：本地有 ${missingSeq} 条记录还没有 id（收藏顺序号），属于旧版本数据。` +
        `请先运行一次  node src/cli.mjs sync --full  完成迁移，之后再回到增量模式。`,
    );
  }

  const today = localDateString();
  const fetched = [];
  const fetchedIds = new Set();

  let total = 0;
  let offset = 0;
  let page = 0;
  let consecutiveKnownPages = 0;
  let stoppedReason = '';
  const startedAt = Date.now();

  for (;;) {
    if (maxPages > 0 && page >= maxPages) {
      stoppedReason = `达到本次页数上限 (${maxPages})`;
      break;
    }

    const { total: serverTotal, items } = await client.fetchBookmarkPage(kind, offset, {
      limit,
      visibility,
    });

    if (page === 0) total = serverTotal;

    page += 1;

    if (items.length === 0) {
      stoppedReason = '服务端返回空页';
      break;
    }

    let newInPage = 0;
    for (const { item, bookmark } of items) {
      const record =
        kind === 'novel'
          ? normalizeNovel(item, bookmark, today)
          : normalizeIllust(item, bookmark, today);
      if (!record) continue;

      const pid = record.pid;
      if (fetchedIds.has(pid)) continue;
      fetchedIds.add(pid);

      // first_seen 一旦写过就不该变。
      const previous = existingById.get(pid);
      if (previous?.first_seen) record.first_seen = previous.first_seen;

      if (!knownIds.has(pid)) newInPage += 1;
      fetched.push(record);
    }

    const allKnownInPage = newInPage === 0;
    consecutiveKnownPages = allKnownInPage ? consecutiveKnownPages + 1 : 0;

    if (onProgress) {
      onProgress({
        label,
        page,
        offset,
        fetchedSoFar: fetched.length,
        serverTotal: total,
        newInPage,
        elapsedMs: Date.now() - startedAt,
        limit,
      });
    }

    offset += items.length;

    if (offset >= total) {
      stoppedReason = '已翻到列表末尾';
      break;
    }

    // 追平判断要同时满足两个条件才成立：
    //   a) 连续两页全已知 —— 单页全已知可能是分页位移造成的错觉；
    //   b) 本地记录数已经接近服务端总数 —— 否则说明上次同步是被 --max-pages
    //      截断的半截数据，此时前几页必然"全已知"，若就此停止将永远补不齐。
    const coverage = total > 0 ? existing.length / total : 1;
    if (!full && consecutiveKnownPages >= 2 && coverage >= 0.9) {
      stoppedReason = '连续两页均为已知收藏，判定已追平';
      break;
    }
  }

  // ---- 分配收藏顺序号（id）----
  //
  // fetched 是按收藏时间**倒序**的（index 0 最新）。要让最早的收藏拿到最小序号，
  // 必须从数组末尾往前遍历赋值。序号一旦分配就不再重排 —— 取消收藏只留空洞，
  // 否则取消一条会让后面几千条一起位移，diff 就彻底废了。
  //
  // 顺带处理「重新收藏」：本地标了 removed 却又出现在列表里的记录，视为一次新收藏，
  // 重新编号而不是保留旧序号，这符合「它现在是最新加进去的」这一事实。
  const maxId = existing.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0);
  let nextId = maxId + 1;

  for (let i = fetched.length - 1; i >= 0; i -= 1) {
    const record = fetched[i];
    const previous = existingById.get(String(record.pid));
    const reusable = previous && Number(previous.id) > 0 && !previous.removed;
    record.id = reusable ? Number(previous.id) : nextId;
    if (!reusable) nextId += 1;
  }

  // ---- 合并 ----
  let merged;
  const kept = [];

  if (full) {
    // 全量：以服务端为准，但**不删除**本地记录 —— 服务端没出现的只打 removed 标记，
    // 内容原样留在文件里，改动就是多出一行 `removed: yes`。
    for (const record of existing) {
      if (fetchedIds.has(String(record.pid))) continue;
      kept.push(record.removed ? record : { ...record, removed: 'yes' });
    }
    merged = [...fetched, ...kept];
  } else {
    // 增量：只追加新记录，已有记录原样保留（增量只翻头部几页，没有完整更新视野，
    // 而且接口返回的 tags 顺序并不稳定，拿它覆盖旧值只会制造假 diff）。
    // 例外是「重新收藏」的记录，需要替换掉原来那条带 removed 标记的旧记录。
    const revived = new Set(
      fetched.filter((r) => existingById.get(String(r.pid))?.removed).map((r) => String(r.pid)),
    );
    merged = existing.filter((r) => !revived.has(String(r.pid)));
    for (const record of fetched) {
      const previous = existingById.get(String(record.pid));
      if (!previous || previous.removed) merged.push(record);
    }
  }

  // ---- 安全阀：结果异常缩水时拒绝写入 ----
  if (full && existing.length >= SHRINK_GUARD_MIN_COUNT) {
    const vanished = kept.filter((r) => !existingById.get(String(r.id))?.removed).length;
    if (vanished > existing.length * SHRINK_GUARD_RATIO) {
      throw new SyncAbort(
        `${label}：本次有 ${vanished} 条记录没在服务端出现（本地共 ${existing.length} 条），` +
          `比例过高，已中止且未修改文件 —— 通常是 cookie 失效导致接口返回空列表，请检查后重试。`,
      );
    }
  }

  const diff = diffRecords(existing, merged);

  // 「已移除」单独统计；把只含 removed 变化的条目从 changed 里剔除，避免数字虚高。
  const newlyRemoved = kept.filter((r) => !existingById.get(String(r.id))?.removed);
  const changed = diff.changed.filter((item) => item.fields.some((f) => f.key !== 'removed'));

  const meta = {
    kindLabel: `${kind === 'novel' ? '小说' : '插画/漫画'}（${visibility === 'private' ? '私密' : '公开'}）`,
    lastSync: new Date().toISOString().replace('T', ' ').slice(0, 19),
    sourceTotal: total || undefined,
  };

  if (!dryRun) {
    await writeRecords(filePath, merged, meta);
  }

  return {
    kind,
    visibility,
    label,
    total,
    pages: page,
    fetchedCount: fetched.length,
    localBefore: existing.length,
    localAfter: merged.length,
    unavailableCount: merged.filter((r) => r.status === 'unavailable').length,
    removedCount: merged.filter((r) => r.removed).length,
    added: diff.added,
    removed: newlyRemoved,
    changed,
    stoppedReason,
    elapsedMs: Date.now() - startedAt,
  };
}

export function formatDurationMs(ms) {
  return formatDuration(ms);
}

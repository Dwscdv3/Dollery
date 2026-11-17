/**
 * 差分同步。
 *
 * 两种模式，语义不同，别混用：
 *
 *   增量（默认）：从收藏列表头部往后翻，直到「连续两页的 id 全都已在本地」为止。
 *     因为列表是按收藏时间倒序的，出现整页已知就说明已经追平，后面只会更旧。
 *     只增不删，最省请求 —— 日常跑这个。
 *
 *   全量（--full）：翻完所有页，以服务端为准做镜像，能发现取消收藏和元数据变更。
 *     请求量随收藏数线性增长（每页至少 2 秒），几千条收藏大概要跑十几分钟。
 *
 * 一个必须存在的安全阀：全量模式如果拿到的数据明显少于本地（典型场景是 cookie
 * 失效，接口返回空列表），绝不执行删除。宁可不更新，也不能把备份清空。
 */
import { normalizeIllust, normalizeNovel } from './pixiv.mjs';
import { diffRecords, readRecords, writeRecords } from './store.mjs';

function localDateString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 全量模式下，新数据低于本地这个比例就判定为「结果可疑」，禁止删除。 */
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
 * 拉取某一类收藏并合并到本地文件。
 */
export async function syncKind(client, options) {
  const {
    kind,
    filePath,
    limit,
    full = false,
    dryRun = false,
    maxPages = 0,
    includePrivate = true,
    onProgress,
    label,
  } = options;

  const existing = await readRecords(filePath);
  const knownIds = new Set(existing.map((r) => String(r.id)));
  const existingById = new Map(existing.map((r) => [String(r.id), r]));

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
      includePrivate,
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

      const id = record.id;
      if (fetchedIds.has(id)) continue;
      fetchedIds.add(id);

      // first_seen 一旦写过就不该变；全量模式更新字段时也要保住它。
      const previous = existingById.get(id);
      if (previous?.first_seen) record.first_seen = previous.first_seen;

      if (!knownIds.has(id)) newInPage += 1;
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
    //      截断的半截数据，此时前几页必然"全已知"，若就此停止将永远补不齐后面的记录。
    //      用 90% 而不是 100%，是为了容下「刚新增了几条」这种正常情形：
    //      那时 local 比 total 少一点点，不该被迫翻完全部页面。
    const coverage = total > 0 ? existing.length / total : 1;
    if (!full && consecutiveKnownPages >= 2 && coverage >= 0.9) {
      stoppedReason = '连续两页均为已知收藏，判定已追平';
      break;
    }
  }

  // ---- 合并 ----
  let merged;
  if (full) {
    merged = fetched;
  } else {
    // 增量模式只追加本地没有的新记录，已有记录原样保留。
    // 理由：增量只翻头部几页，本来就没有完整的更新视野；而且接口返回的 tags
    // 顺序并不稳定，拿它覆盖旧值只会制造假 diff。元数据刷新交给 --full。
    merged = [...existing];
    for (const record of fetched) {
      if (!existingById.has(String(record.id))) merged.push(record);
    }
  }

  // ---- 安全阀 ----
  if (
    full &&
    existing.length >= SHRINK_GUARD_MIN_COUNT &&
    merged.length < existing.length * SHRINK_GUARD_RATIO
  ) {
    throw new SyncAbort(
      `${label}：本次只取到 ${merged.length} 条，远少于本地已有的 ${existing.length} 条。` +
        `已中止并保留原文件 —— 通常是 cookie 失效导致接口返回空列表，请检查后重试。`,
    );
  }

  const diff = diffRecords(existing, merged);
  // 增量模式下未抓到的记录仍然留在 merged 里，因此不会产生删除；
  // 只有全量模式才以服务端为准移除已取消收藏的作品（历史留在 git log 里）。
  const removedApplied = full ? diff.removed : [];

  const meta = {
    kindLabel: kind === 'novel' ? '小说' : '插画/漫画',
    lastSync: new Date().toISOString().replace('T', ' ').slice(0, 19),
    sourceTotal: total || undefined,
  };

  if (!dryRun) {
    await writeRecords(filePath, merged, meta);
  }

  return {
    kind,
    label,
    total,
    pages: page,
    fetchedCount: fetched.length,
    localBefore: existing.length,
    localAfter: merged.length,
    unavailableCount: merged.filter((r) => r.status === 'unavailable').length,
    added: diff.added,
    removed: removedApplied,
    changed: diff.changed,
    stoppedReason,
    elapsedMs: Date.now() - startedAt,
    estimatedRemainingMs: 0,
  };
}

export function formatDurationMs(ms) {
  return formatDuration(ms);
}

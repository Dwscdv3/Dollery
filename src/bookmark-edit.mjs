/*
 * Copyright (C) 2026 静瑶 (Dwscdv3)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * 编辑收藏：改收藏标签（bookmark_tags）和公开 / 私密。
 *
 * 顺序仍然是「先远端、后本地」：
 *   1. 拿到 CSRF token（`name="tt"`）。会话内缓存，不需要每次都读编辑页
 *   2. POST /ajax/{illusts|novels}/bookmarks/add 写入 —— 这个接口是 upsert，
 *      已收藏的作品再调一次就是覆盖标签与可见性，不会变成重复收藏
 *   3. 接口返回 200 且 `error: false` 之后，才动本地 JSON
 *
 * 曾经还有一步「回读编辑页二次确认」。它更稳，但编辑页有 120KB，
 * 读一次比写一次还贵，用户确认「200 就算成功」后就去掉了 —— 现在一次保存
 * 只有一个请求（进程刚起、token 还没缓存时是两个），评分是两个
 * （评分要先读一次线上的标签做基准）。
 *
 * 一个已知的能力边界：pixiv 的收藏列表按**收藏时间**排序，而移动公开/私密
 * 不会重置收藏时间。所以跨文件搬迁时只能把记录排到目标文件末尾（id = max+1），
 * 本地顺序会与网站上的真实顺序有偏差 —— 服务端不返回收藏时间戳，没有更好的办法。
 */
import { readDocument, writeRecords } from './store.mjs';
import { applyRating, findRating } from './rating.mjs';

/** Pixiv 的收藏标签上限，编辑页的 `data-limit` 也是 10。 */
export const BOOKMARK_TAG_LIMIT = 10;

/**
 * 没打标签的作品会被 pixiv 自动归到「未分類」，它不是用户的标签。
 * 和 bookmark-tags.mjs 里的过滤保持一致（那边是同步时过滤，这里是写入时过滤）。
 */
const DEFAULT_BOOKMARK_TAGS = new Set(['未分類', '未分类', 'Unclassified', 'Uncategorized']);

export const isDefaultBookmarkTag = (tag) => DEFAULT_BOOKMARK_TAGS.has(tag);

function decodeEntities(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * 标签用空格 / 逗号 / 顿号分隔 —— 和 Pixiv 旧版页面的输入习惯一致。
 * 注意 trim 后再过滤，页面里会带尾随空格（`value="Zwei!! "`）。
 */
export function splitTagValue(raw) {
  return decodeEntities(raw)
    .split(/[,，、;；\s]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag && !isDefaultBookmarkTag(tag));
}

/**
 * 把用户输入整理成可以直接提交的标签数组。
 * 超出上限时返回 error 而不是静默截断 —— 悄悄丢掉用户刚打的标签比报错更糟。
 */
export function normalizeTags(input) {
  const tags = [];
  const list = Array.isArray(input) ? input : [];

  for (const raw of list) {
    for (const tag of splitTagValue(raw)) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }

  if (tags.length > BOOKMARK_TAG_LIMIT) {
    return {
      tags: tags.slice(0, BOOKMARK_TAG_LIMIT),
      error: `收藏标签最多 ${BOOKMARK_TAG_LIMIT} 个，现在是 ${tags.length} 个`,
    };
  }

  return { tags, error: '' };
}

/**
 * 解析旧版编辑页。返回 null 表示页面结构不认识（改版 / 被重定向到登录页）。
 *
 * 页面里这几样东西都在同一个 form 里：
 *   <input type="hidden" name="tt" value="32 位 token">
 *   <input type="text"   name="tag" value="当前标签 空格分隔">
 *   <input type="radio"  name="restrict" value="0|1" checked>
 * 小说页还多一个 `book_id[]`（收藏本身的 id），这里顺手带出来，暂时用不上。
 */
export function parseEditorPage(html) {
  const text = String(html ?? '');
  const inputs = text.match(/<input\b[^>]*>/gi) ?? [];

  const attrOf = (tagText, name) => {
    const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tagText);
    return match ? match[1] : null;
  };

  let token = '';
  let tagRaw = null;
  let restrict = null;
  let bookmarkId = '';

  for (const input of inputs) {
    const name = attrOf(input, 'name');
    if (!name) continue;

    if (name === 'tt' && !token) token = attrOf(input, 'value') ?? '';
    if (name === 'tag' && tagRaw === null) tagRaw = attrOf(input, 'value') ?? '';
    if (name === 'restrict' && restrict === null && /\bchecked\b/i.test(input)) {
      const value = Number(attrOf(input, 'value'));
      if (value === 0 || value === 1) restrict = value;
    }
    if (name === 'book_id[]' && !bookmarkId) bookmarkId = attrOf(input, 'value') ?? '';
  }

  // 有的页面把 token 放在内联 JSON 里，而不是 tt 隐藏字段
  if (!token) {
    const match = /"token"\s*:\s*"([A-Za-z0-9]{32})"/.exec(text);
    if (match) token = match[1];
  }

  // tag 输入框是这套解析的锚点：没有它说明已经不是编辑页了
  if (tagRaw === null) return null;

  return {
    token,
    tags: splitTagValue(tagRaw),
    restrict,
    isPrivate: restrict === 1,
    bookmarkId,
  };
}

/** 编辑页地址：插画和小说在两个不同的脚本里，别混。 */
export function editorPath(kind, pid) {
  return kind === 'novel'
    ? `/novel/bookmark_add.php?id=${encodeURIComponent(pid)}`
    : `/bookmark_add.php?type=illust&illust_id=${encodeURIComponent(pid)}`;
}

/**
 * 读当前收藏状态（标签 + 公开与否 + token）。
 * 拿不到就返回 null —— 调用方必须把它当成「不知道」，而不是「没有标签」。
 *
 * fast=false 用于批量任务：走普通限速队列，连随机长休息也一起等，
 * 而不是像手动编辑那样抢一条快速通道。
 */
export async function readEditorState(
  client,
  kind,
  pid,
  { fast = false, bypassPacer = true } = {},
) {
  const res = await client.html(editorPath(kind, pid), { bypassPacer, fast });
  if (res.status !== 200) return null;

  const parsed = parseEditorPage(res.body);
  // 顺手把 token 存进客户端的会话缓存，后面的写操作就不用再读整页了
  if (parsed?.token) client.csrfToken = parsed.token;
  return parsed;
}

/**
 * 写入。restrict: 0 = 公开，1 = 私密。
 * 标签按数组提交，评论字段留空 —— 网页端也是这么发的。
 *
 * fast=false 用于批量任务：按 intervalMs 一条条排队，而不是连着发。
 */
export async function saveBookmarkToPixiv(client, { kind, pid, tags, isPrivate, token, fast = true }) {
  const endpoint = kind === 'novel' ? '/ajax/novels/bookmarks/add' : '/ajax/illusts/bookmarks/add';
  const payload =
    kind === 'novel'
      ? { novel_id: String(pid), restrict: isPrivate ? 1 : 0, comment: '', tags }
      : { illust_id: String(pid), restrict: isPrivate ? 1 : 0, comment: '', tags };

  return client.ajaxPost(endpoint, payload, { token, fast });
}

/* ═══════════════════════════════════════════════════════════════
 * 本地写入
 *
 * 只有远端写入成功（HTTP 200 + error:false）后才走到这里。两个关键约束：
 *   · id 在单个文件内必须唯一 —— 跨文件搬迁时按目标文件的 max(id)+1 重新编号
 *   · 目标文件里可能还留着这条作品的「已取消收藏」旧记录，这时复活它、沿用原 id，
 *     不要制造两条同 pid 的记录
 * ═══════════════════════════════════════════════════════════════ */

/** kind + 可见性 → 数据文件的键，和 viewer/server.mjs 的 SOURCES 对应。 */
export function sourceKeyOf(kind, isPrivate) {
  if (kind === 'novel') return isPrivate ? 'novelPrivate' : 'novelPublic';
  return isPrivate ? 'illustPrivate' : 'illustPublic';
}

/** 只保留 _meta 里会被重新序列化的三项，其余原样不动。 */
function metaOf(document) {
  const meta = document.meta ?? {};
  return { kindLabel: meta.kind, lastSync: meta.lastSync, sourceTotal: meta.sourceTotal };
}

function nextId(records) {
  return records.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0) + 1;
}

/** 把标签和可见性写进记录（空标签就删字段，和同步层的写法一致）。 */
function applyFields(record, { tags, isPrivate }) {
  if (tags.length > 0) record.bookmark_tags = [...tags];
  else delete record.bookmark_tags;

  record.private_bookmark = isPrivate ? 'yes' : 'no';
  // 能编辑说明作品仍在收藏夹里，之前的「已取消」标记必须清掉
  delete record.removed;
  return record;
}

async function readDoc(filePath) {
  return readDocument(filePath);
}

/**
 * 落盘。返回 { moved, id, source, tags }。
 *
 * 写顺序是先目标、后来源：万一第二步失败，磁盘上会短暂出现两条同 pid 的记录
 * （重复比丢失好收拾），而不是一条都不剩。
 */
export async function writeLocalBookmark({ files, kind, pid, tags, isPrivate, source }) {
  const targetKey = sourceKeyOf(kind, isPrivate);
  const targetFile = files[targetKey];
  if (!targetFile) throw new Error(`没有配置 ${targetKey} 的输出文件`);

  // 兼容调用方没传 source 的情况：在同类两个文件里找
  let originKey = source && files[source] ? source : null;
  if (!originKey) {
    const candidates = kind === 'novel' ? ['novelPublic', 'novelPrivate'] : ['illustPublic', 'illustPrivate'];
    for (const key of candidates) {
      const doc = await readDoc(files[key]);
      if (doc.records.some((record) => String(record.pid) === String(pid))) {
        originKey = key;
        break;
      }
    }
  }

  const apply = (record) => {
    applyFields(record, { tags, isPrivate });
    return record;
  };

  // ── 同一份文件：原地改 ──────────────────────────────
  if (!originKey || originKey === targetKey) {
    const doc = await readDoc(targetFile);
    const record = doc.records.find((item) => String(item.pid) === String(pid));
    if (!record) throw new Error('本地没有这条收藏记录，无法写入');

    apply(record);
    await writeRecords(targetFile, doc.records, metaOf(doc));
    return { moved: false, id: record.id, source: targetKey, tags: [...tags], record };
  }

  // ── 跨文件：从来源删掉，插进目标 ────────────────────
  const originFile = files[originKey];
  const originDoc = await readDoc(originFile);
  const targetDoc = await readDoc(targetFile);

  const originRecord = originDoc.records.find((item) => String(item.pid) === String(pid));
  if (!originRecord) throw new Error('本地没有这条收藏记录，无法写入');

  const existing = targetDoc.records.find((item) => String(item.pid) === String(pid));
  const updated = apply({ ...originRecord });

  if (existing) {
    // 目标文件里已有同 pid：沿用它的 id / first_seen，避免同文件出现重复 id
    updated.id = existing.id;
    if (existing.first_seen) updated.first_seen = existing.first_seen;
    // 它可能还带着「已取消」标记，这里被 applyFields 清掉了
  } else {
    updated.id = nextId(targetDoc.records);
  }

  const targetRecords = targetDoc.records.filter((item) => String(item.pid) !== String(pid));
  targetRecords.push(updated);
  const originRecords = originDoc.records.filter((item) => String(item.pid) !== String(pid));

  // 目标先写：失败时最多留下一条重复记录，不会把作品弄丢
  await writeRecords(targetFile, targetRecords, metaOf(targetDoc));
  await writeRecords(originFile, originRecords, metaOf(originDoc));

  return { moved: true, id: updated.id, source: targetKey, tags: [...tags], record: updated };
}

/** 收藏标签已满、评分塞不进去。带上当前标签，好让界面直接让用户挑一个删。 */
export class BookmarkTagsFullError extends Error {
  constructor(tags, detail = {}) {
    super(`收藏标签已有 ${BOOKMARK_TAG_LIMIT} 个，先删掉一个才能加评分`);
    this.name = 'BookmarkTagsFullError';
    this.code = 'TAGS_FULL';
    this.tags = [...tags];
    this.rating = detail.rating ?? 0;
    this.dropped = detail.dropped ?? '';
  }
}

/**
 * 写入 → 落盘。editBookmark 和 setBookmarkRating 共用这一段。
 *
 * 「成功」的判定是 POST 的 HTTP 200 + `error: false`（`parseAjax` 已经会把
 * `error: true` 变成异常抛出来）。不再回读编辑页二次确认 —— 那一趟要拉 120KB，
 * 比写本身还贵；用户确认「200 就算成功」。
 */
async function commitBookmark({
  client,
  files,
  kind,
  pid,
  tags,
  isPrivate,
  source,
  token,
  fast = true,
}) {
  await saveBookmarkToPixiv(client, { kind, pid, tags, isPrivate, token, fast });

  // writeLocalBookmark 的返回值里已经带上了 tags，直接透传即可
  return writeLocalBookmark({ files, kind, pid, tags, isPrivate, source });
}

/**
 * 完整流程：写入 pixiv → 改本地。
 *
 * 写入失败会抛出，本地文件保持原样。token 有缓存时只有一个请求；
 * 没有缓存（进程刚起）时才先读一次编辑页把 token 拿到。
 *
 * fast=true 是手动编辑的默认值（走快速车道：不排后台队列，也不等 pacer 的长休息）；
 * 批量转换传 false，让每条都按正常间隔排进限速队列。
 */
export async function editBookmark({
  client,
  files,
  kind,
  pid,
  tags,
  isPrivate,
  source,
  fast = true,
}) {
  // token 是会话级的。缓存命中就不必再读一遍 120KB 的编辑页 ——
  // 改收藏的内容（标签 + 可见性）本来就是用户自己给的，不依赖页面上的旧值。
  let token = client.csrfToken || '';

  if (!token) {
    const before = await readEditorState(client, kind, pid, { fast, bypassPacer: fast });
    if (!before) {
      throw new Error('读不到这个作品的编辑页（作品可能已失效，或 Pixiv 改了页面）');
    }
    token = before.token;
    if (!token) throw new Error('编辑页里没有找到 CSRF token，暂时无法写入');
  }

  const run = (useToken) =>
    commitBookmark({ client, files, kind, pid, tags, isPrivate, source, token: useToken, fast });

  try {
    return await run(token);
  } catch (err) {
    // token 失效（换了会话 / 过期）时重读一次再试，别让用户白等一场
    if (token && (err?.status === 400 || err?.status === 403)) {
      client.csrfToken = '';
      const fresh = await readEditorState(client, kind, pid, { fast, bypassPacer: fast });
      if (!fresh?.token) throw err;
      return run(fresh.token);
    }
    throw err;
  }
}

/**
 * 快速改评分：只动 `n/10` 这一个标签。
 *
 * 以**网站上此刻的标签**为基准做替换，而不是用本地缓存的数组 —— 否则本地少记了
 * 一个标签，一次打分就会把它从 pixiv 上抹掉。可见性也沿用线上的值：
 * 这里只想改评分，不该顺带把公开改成私密。
 *
 * 标签满了抛 BookmarkTagsFullError，由上层弹窗让用户挑一个删（再把 drop 传回来）。
 */
export async function setBookmarkRating({
  client,
  files,
  kind,
  pid,
  rating,
  source,
  drop = '',
  fast = true,
}) {
  const before = await readEditorState(client, kind, pid, { fast });
  if (!before) {
    throw new Error('读不到这个作品的编辑页（作品可能已失效，或 Pixiv 改了页面）');
  }
  if (!before.token) {
    throw new Error('编辑页里没有找到 CSRF token，暂时无法写入');
  }

  const dropTag = String(drop ?? '').trim();
  const base = dropTag ? before.tags.filter((tag) => tag !== dropTag) : before.tags;
  const tags = applyRating(base, rating);

  if (tags.length > BOOKMARK_TAG_LIMIT) {
    throw new BookmarkTagsFullError(before.tags, { rating, dropped: dropTag });
  }

  const result = await commitBookmark({
    client,
    files,
    kind,
    pid,
    tags,
    isPrivate: before.isPrivate,
    source,
    token: before.token,
    fast,
  });

  return {
    ...result,
    rating: findRating(result.tags)?.value ?? 0,
  };
}

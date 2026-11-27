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
 * 收藏标签（bookmark tags）同步。
 *
 * 背景：Pixiv 的「收藏标签」是你自己打的私有分类，和作者给作品打的 `tags` 完全是
 * 两套数据。麻烦在于**没有任何接口能直接告诉你某作品有哪些收藏标签**：
 *   · 收藏列表接口的 bookmarkData 只有 { id, private }
 *   · /ajax/illust/{pid}/bookmarkData 同样不带 tags（实测确认）
 *
 * 唯一可行的路径是反向查：先用 /ajax/user/{uid}/illusts/bookmark/tags 拿到
 * 你所有的标签及各自的作品数，再对每个标签翻一遍收藏列表，反推出 pid → 标签。
 *
 * 代价是每个标签至少一次请求。实测一个账号 242 个公开标签 + 626 个私密标签，
 * 首次要 868 次请求（约 30 分钟，2 秒间隔）。所以必须有缓存：
 *   · 用「标签名 + 作品数」的签名判断标签集合有没有变
 *   · 只有变化的标签才重扫，日常增量通常只多 1 次请求
 *   · 扫到一半中断也不会白跑 —— 进度按标签落盘，下次接着来
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { readRecords, writeRecords } from './store.mjs';

const CACHE_FORMAT = 'pixiv-export/tags/1';

/**
 * Pixiv 会把「没打收藏标签」的作品自动归到「未分類」这个默认分类下。
 * 实测某账号 4859 条收藏里 3823 条挂在这个标签下，而真正打过标签的作品
 * 不会同时拥有它。它不是用户打的标签，写进备份只会给大半记录加一行噪声。
 */
const DEFAULT_BOOKMARK_TAGS = new Set(['未分類', '未分类', 'Unclassified', 'Uncategorized']);

function isDefaultTag(tag) {
  return DEFAULT_BOOKMARK_TAGS.has(tag);
}

function signatureOf(tags) {
  return tags
    .map((item) => `${item.tag}\u0000${item.cnt}`)
    .sort()
    .join('\u0001');
}

async function loadCache(cachePath) {
  try {
    const text = await fs.readFile(cachePath, 'utf8');
    const data = JSON.parse(text);
    if (data?.format !== CACHE_FORMAT) return null;
    return data;
  } catch {
    return null;
  }
}

async function saveCache(cachePath, payload) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

/** 从 map 里剥掉指定的一组标签；标签被剥空的 pid 直接移除。 */
function stripTags(map, tagSet) {
  if (tagSet.size === 0) return;
  for (const [pid, tags] of [...map]) {
    const kept = tags.filter((tag) => !tagSet.has(tag));
    if (kept.length === 0) map.delete(pid);
    else if (kept.length !== tags.length) map.set(pid, kept);
  }
}

/**
 * 翻完某个标签下的全部作品，返回 pid 列表。
 */
async function scanTag(client, { kind, visibility, tag, limit, onPage }) {
  const pids = [];
  let offset = 0;

  for (;;) {
    const { total, items } = await client.fetchBookmarkPage(kind, offset, {
      limit,
      visibility,
      tag,
    });

    for (const { item } of items) {
      const pid = String(item?.id ?? item?.illustId ?? '');
      if (pid) pids.push(pid);
    }

    offset += items.length;
    if (onPage) onPage();
    if (items.length === 0 || offset >= total) break;
  }

  return pids;
}

/**
 * 建立（或更新）收藏标签映射。
 *
 * 返回 { map: Map<pid, string[]>, stats }。
 */
export async function updateBookmarkTagMap(client, options) {
  const {
    kind = 'illust',
    visibility = 'public',
    cacheDir,
    limit = 100,
    force = false,
    onProgress,
  } = options;

  const cachePath = path.join(cacheDir, `tags-${kind}-${visibility}.json`);

  const tagInfo = await client.fetchBookmarkTags(kind);
  const tagList = visibility === 'private' ? tagInfo.private : tagInfo.public;
  // 签名排除默认标签：它的计数会随「打了标签的作品数」反向变动，
  // 把它算进去会让每次打标签都触发全量重扫。
  const signature = signatureOf(tagList.filter((item) => !isDefaultTag(item.tag)));

  const cache = force ? null : await loadCache(cachePath);

  // 签名一致且没有未完成的尾巴 —— 直接复用缓存，代价只有刚才那一次请求。
  if (cache && cache.signature === signature && (cache.pending ?? []).length === 0) {
    const map = new Map(Object.entries(cache.map ?? {}));
    // 旧版本缓存可能残留默认标签
    stripTags(map, DEFAULT_BOOKMARK_TAGS);
    return {
      map,
      stats: {
        reused: true,
        tags: tagList.filter((item) => !isDefaultTag(item.tag)).length,
        pending: 0,
        requests: 1,
        truncated: tagInfo.truncated,
      },
    };
  }

  let map = new Map();
  let pending;

  if (cache) {
    map = new Map(Object.entries(cache.map ?? {}));

    // 旧缓存里可能残留默认标签，先剥掉
    stripTags(map, DEFAULT_BOOKMARK_TAGS);

    // 增量：只重扫「作品数变了」和「新出现」的标签，顺手清掉已消失的标签。
    const oldCounts = new Map((cache.tags ?? []).map((item) => [item.tag, item.cnt]));
    const newCounts = new Map(tagList.map((item) => [item.tag, item.cnt]));

    const changed = tagList
      .filter((item) => oldCounts.get(item.tag) !== item.cnt && !isDefaultTag(item.tag))
      .map((i) => i.tag);
    const vanished = [...oldCounts.keys()].filter((tag) => !newCounts.has(tag));

    stripTags(map, new Set([...changed, ...vanished]));

    // 上次没扫完的也要接着来，它们的旧分配已经在上面一并清掉了
    const carried = (cache.pending ?? []).filter(
      (tag) => newCounts.has(tag) && !isDefaultTag(tag),
    );
    pending = [...new Set([...changed, ...carried])];
  } else {
    pending = tagList.map((item) => item.tag).filter((tag) => !isDefaultTag(tag));
  }

  const totalPending = pending.length;
  let requests = 1;
  let scannedPids = 0;

  const counts = new Map(tagList.map((item) => [item.tag, item.cnt]));

  for (let index = 0; index < pending.length; index += 1) {
    const tag = pending[index];

    const pids = await scanTag(client, {
      kind,
      visibility,
      tag,
      limit,
      onPage: () => {
        requests += 1;
      },
    });

    for (const pid of pids) {
      const existing = map.get(pid);
      if (existing) {
        if (!existing.includes(tag)) existing.push(tag);
      } else {
        map.set(pid, [tag]);
      }
    }
    scannedPids += pids.length;

    if (onProgress) {
      await onProgress({
        index: index + 1,
        total: totalPending,
        tag,
        cnt: counts.get(tag) ?? pids.length,
        mapped: map.size,
        requests,
      });
    }

    // 每处理 10 个标签落一次盘，中断了也不至于白跑。
    const isLast = index === pending.length - 1;
    if ((index + 1) % 10 === 0 || isLast) {
      await saveCache(cachePath, {
        format: CACHE_FORMAT,
        kind,
        visibility,
        signature,
        tags: tagList,
        generatedAt: new Date().toISOString(),
        map: Object.fromEntries(map),
        pending: pending.slice(index + 1),
      });
    }
  }

  // 标签全空时也要落一次盘，避免签名对了但缓存文件不存在
  await saveCache(cachePath, {
    format: CACHE_FORMAT,
    kind,
    visibility,
    signature,
    tags: tagList,
    generatedAt: new Date().toISOString(),
    map: Object.fromEntries(map),
    pending: [],
  });

  return {
    map,
    stats: {
      reused: false,
      tags: tagList.length,
      scannedTags: totalPending,
      mapped: map.size,
      scannedPids,
      requests,
      truncated: tagInfo.truncated,
    },
  };
}

/**
 * 把标签映射写进数据文件。只改 bookmark_tags 字段，其他字段原样保留。
 * 返回实际发生变化的记录数。
 */
export async function applyBookmarkTags(filePath, map, meta = {}) {  const records = await readRecords(filePath);
  if (records.length === 0) return 0;

  let changed = 0;

  for (const record of records) {
    const tags = map.get(String(record.pid)) ?? [];
    const current = Array.isArray(record.bookmark_tags) ? record.bookmark_tags : [];

    if (JSON.stringify(tags) !== JSON.stringify(current)) {
      if (tags.length > 0) record.bookmark_tags = tags;
      else delete record.bookmark_tags;
      changed += 1;
    }
  }

  if (changed > 0) await writeRecords(filePath, records, meta);

  return changed;
}

/* ═══════════════════════════════════════════════════════════════
 * 按作品查标签（差分同步用）
 *
 * 上面的「逐标签反推」是全量方案：一次要把所有标签翻一遍。差分只需要处理
 * 本次新增的少数作品，这时候逐作品查就便宜得多 —— 一个作品一次请求。
 *
 * 代价是它走的是网页而不是 JSON 接口，所以更容易随 Pixiv 改版失效；
 * 失败时返回 null，调用方保留原值而不是把标签清空。
 * ═══════════════════════════════════════════════════════════════ */

function decodeEntities(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 标签用空格 / 逗号 / 顿号分隔；页面里会带尾随空格，必须 trim。 */
function splitTagValue(raw) {
  return decodeEntities(raw)
    .split(/[,，、;；\s]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag && !isDefaultTag(tag));
}

/**
 * 查单个作品当前的收藏标签。
 * 返回 string[]（可能是空数组＝确实没打标签），或 null（拿不到，别当作空）。
 */
export async function fetchWorkBookmarkTags(client, kind, pid) {
  const candidates =
    kind === 'novel'
      ? [`/novel/bookmark_add.php?id=${pid}`]
      : [`/bookmark_add.php?type=illust&illust_id=${pid}`];

  for (const path of candidates) {
    let res;
    try {
      res = await client.html(path);
    } catch {
      continue;
    }
    if (res.status !== 200) continue;

    // 页面里是 <input type="text" name="tag" value="...">
    const match = /<input[^>]*name="tag"[^>]*>/i.exec(res.body ?? '');
    if (!match) {
      // 也兼容 value 在 name 前面的写法
      const reversed = /<input[^>]*value="([^"]*)"[^>]*name="tag"/i.exec(res.body ?? '');
      if (reversed) return splitTagValue(reversed[1]);
      return null;
    }
    const value = /value="([^"]*)"/i.exec(match[0]);
    return splitTagValue(value ? value[1] : '');
  }

  return null;
}

function sameTagSet(a, b) {
  if (a.length !== b.length) return false;
  const normalize = (list) => [...list].map((t) => t.toLowerCase()).sort();
  return normalize(a).join('\u0000') === normalize(b).join('\u0000');
}

/**
 * 对指定的一批作品逐个查收藏标签，写回数据文件。
 *
 * 只动这批作品，其余记录原样保留 —— 所以差分同步可以放心调用它，
 * 不会像「整表套用映射」那样把没查到的作品标签清空。
 *
 * 返回 { total, checked, changed, failed }。
 */
export async function refreshBookmarkTags(client, options) {
  const { filePath, kind, pids, meta = {}, onProgress } = options;

  const records = await readRecords(filePath);
  if (records.length === 0) return { total: 0, checked: 0, changed: 0, failed: 0 };

  const byPid = new Map(records.map((record) => [String(record.pid), record]));
  const targets = [];
  const seen = new Set();

  for (const raw of pids) {
    const pid = String(raw ?? '');
    if (!pid || seen.has(pid) || !byPid.has(pid)) continue;
    seen.add(pid);
    targets.push(pid);
  }

  let checked = 0;
  let changed = 0;
  let failed = 0;

  for (let index = 0; index < targets.length; index += 1) {
    const pid = targets[index];
    const record = byPid.get(pid);

    const tags = await fetchWorkBookmarkTags(client, kind, pid).catch(() => null);

    if (tags === null) {
      failed += 1;
    } else {
      const current = Array.isArray(record.bookmark_tags) ? record.bookmark_tags : [];
      if (!sameTagSet(tags, current)) {
        if (tags.length > 0) record.bookmark_tags = tags;
        else delete record.bookmark_tags;
        changed += 1;
      }
      checked += 1;
    }

    if (onProgress) {
      await onProgress({ index: index + 1, total: targets.length, pid, tags, changed, failed });
    }
  }

  if (changed > 0) await writeRecords(filePath, records, meta);

  return { total: targets.length, checked, changed, failed };
}

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
 * 标签组：把同义标签并成一组，搜索时自动展开成 (a OR b OR c)。
 *
 * 组没有名字，`id` 只为编辑时定位；界面上要显示名字时取「计数最多的成员」
 * （由调用方算，这里只管成员本身）。
 *
 * 文件很小、读写都在本地，所以按 mtime + size 缓存：服务端是唯一写入口，
 * 但手改 JSON 之后也应该立刻生效，每次请求 stat 一下最省事。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const FORMAT_VERSION = 1;

/**
 * pixiv 把「没打标签」的作品自动归到「未分類」，它不是用户的标签，
 * 和 src/bookmark-edit.mjs 里的过滤保持一致。这里不引那个模块，
 * 免得只为了一个常量把 store / rating 一起拉进来。
 */
const DEFAULT_BOOKMARK_TAGS = new Set(['未分類', '未分类', 'Unclassified', 'Uncategorized']);

/** 标签比较用的归一化：和 /api/tags 的计数口径一致（trim + 小写）。 */
export function normalizeTagKey(tag) {
  return String(tag ?? '').trim().toLowerCase();
}

/**
 * 校验 + 归一化。规则：
 *   · 成员去空白、去重（大小写不敏感）、丢掉「未分類」这类默认标签
 *   · 少于两个成员的组丢弃（一个标签成不了组，也就不该落盘）
 *   · 同一个标签只允许在一个组里；真出现跨组重复时先到先得，重复项记为冲突
 */
export function normalizeGroups(input) {
  const groups = [];
  const owner = new Map(); // 归一化标签 -> 组 id
  const takenIds = new Set();
  const conflicts = [];
  let dropped = 0;

  const source = Array.isArray(input) ? input : [];

  // 先把所有显式 id 圈出来：新建组自动分配 id 时不能撞上后面才出现的组
  const reservedIds = new Set(
    source.map((raw) => String(raw?.id ?? '').trim()).filter((id) => id),
  );
  const nextFreeId = () => {
    let n = 1;
    for (;;) {
      const id = `g${n}`;
      if (!takenIds.has(id) && !reservedIds.has(id)) return id;
      n += 1;
    }
  };

  for (const raw of source) {
    const tags = [];
    const local = new Set();

    for (const value of Array.isArray(raw?.tags) ? raw.tags : []) {
      const tag = String(value ?? '').trim();
      const key = normalizeTagKey(tag);
      if (!key || DEFAULT_BOOKMARK_TAGS.has(tag) || local.has(key)) continue;
      local.add(key);
      tags.push(tag);
    }

    if (tags.length < 2) {
      dropped += 1;
      continue;
    }

    let id = String(raw?.id ?? '').trim();
    if (!id || takenIds.has(id)) id = nextFreeId();

    const kept = [];
    for (const tag of tags) {
      const key = normalizeTagKey(tag);
      const holder = owner.get(key);
      if (holder) {
        conflicts.push({ tag, keptIn: holder, droppedFrom: id });
        continue;
      }
      owner.set(key, id);
      kept.push(tag);
    }

    if (kept.length < 2) {
      dropped += 1;
      continue;
    }

    takenIds.add(id);
    groups.push({ id, tags: kept });
  }

  return { groups, conflicts, dropped };
}

export function createTagGroupStore(filePath, { log = () => {} } = {}) {
  let cache = { mtimeMs: -1, size: -1, groups: [] };

  /** 读文件（带缓存）。解析失败就当没有组，不要让查看器起不来。 */
  function read() {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      cache = { mtimeMs: -1, size: -1, groups: [] };
      return cache;
    }

    if (stat.mtimeMs === cache.mtimeMs && stat.size === cache.size) return cache;

    try {
      const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const { groups } = normalizeGroups(doc?.groups ?? []);
      cache = { mtimeMs: stat.mtimeMs, size: stat.size, groups };
    } catch (err) {
      log(`标签组文件解析失败，暂时按空处理：${err.message}`);
      cache = { mtimeMs: stat.mtimeMs, size: stat.size, groups: [] };
    }

    return cache;
  }

  /** @returns {Array<{id: string, tags: string[]}>} */
  function list() {
    return read().groups;
  }

  /** 找到包含该标签的组（归一化比较），没有就返回 null。 */
  function groupOf(tag) {
    const key = normalizeTagKey(tag);
    if (!key) return null;
    for (const group of read().groups) {
      if (group.tags.some((member) => normalizeTagKey(member) === key)) return group;
    }
    return null;
  }

  /** 整体替换（编辑器的保存就是一次整体提交）。 */
  async function replace(input) {
    const result = normalizeGroups(input);

    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const doc = {
      _meta: { version: FORMAT_VERSION, updatedAt: new Date().toISOString() },
      groups: result.groups,
    };

    // 先写临时文件再改名：中途崩溃也不会留下半个 JSON
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, filePath);

    try {
      const stat = fs.statSync(filePath);
      cache = { mtimeMs: stat.mtimeMs, size: stat.size, groups: result.groups };
    } catch {
      cache = { mtimeMs: -1, size: -1, groups: result.groups };
    }

    return result;
  }

  return { list, groupOf, replace, path: filePath };
}

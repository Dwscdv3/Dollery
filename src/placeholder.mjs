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
 * 识别「占位元数据」。
 *
 * 作品在 pixiv 上失效之后，收藏接口不再返回真实信息，而是塞一套占位值：
 *   title / description / author 都是 `-----`
 *   author_id = "0"，published = "1970-01-01"，width/height = 100，pages = 1
 *
 * 这些值「非空」，但没有任何信息量。判空用 `.trim()` 是不够的 ——
 * 判断「这条记录还有没有可看的元数据」必须把它们排除掉，
 * 否则会把一堆横杠当成标题，界面显示出来也难看。
 */
export const PLACEHOLDER_TEXT_RE = /^[-—–ー~_\s]*$/;

/** 视作占位：空串、纯横杠/破折号/下划线/波浪线、纯空白。 */
export function isPlaceholderText(value) {
  const text = String(value ?? '').trim();
  if (!text) return true;
  return PLACEHOLDER_TEXT_RE.test(text);
}

/**
 * 这条记录还有没有「真的能看」的元数据。
 *
 * 只看内容字段，不看 pid/收藏顺序这类结构性字段 —— 后者对失效作品总是有的，
 * 拿它判断会把所有记录都算成「有元数据」。
 */
export function hasUsableMeta(record) {
  if (!record) return false;

  if (!isPlaceholderText(record.title)) return true;
  if (!isPlaceholderText(record.description)) return true;
  if (!isPlaceholderText(record.author)) return true;
  if (Array.isArray(record.tags) && record.tags.length > 0) return true;
  if (Array.isArray(record.bookmark_tags) && record.bookmark_tags.length > 0) return true;

  return false;
}

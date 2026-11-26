/**
 * 批量把「组内其它成员标签」换成目标标签。
 *
 * 纯数据部分：只负责算出每个作品改完之后的标签数组，不碰网络和磁盘，
 * 方便单独断言。真正的逐条写入在 viewer/server.mjs 里（要排队、要限速）。
 *
 * 两条刻意的规则：
 *   · 只替换组内成员，其它收藏标签原样保留 —— 换标签不该顺手清掉别的分类；
 *   · 以本地缓存为基准（用户选择），所以调用方给的 `before` 就是最终写入的底稿，
 *     这里不再回读线上。
 */

/** 和 /api/tags 的计数口径一致。 */
export function normalizeTagKey(tag) {
  return String(tag ?? '').trim().toLowerCase();
}

/**
 * @param {object} input
 * @param {Array<object>} input.records  全量记录（带 source 字段）
 * @param {string} input.source          要处理哪一个来源
 * @param {string[]} input.members       组内全部成员标签
 * @param {string} input.target          目标标签（必须是 members 之一）
 * @returns {Array<{pid:string, kind:string, isPrivate:boolean, before:string[], after:string[]}>}
 */
export function planTagConversion({ records, source, members, target }) {
  const targetTag = String(target ?? '').trim();
  const targetKey = normalizeTagKey(targetTag);
  if (!targetKey) return [];

  const memberKeys = new Set();
  for (const member of Array.isArray(members) ? members : []) {
    const key = normalizeTagKey(member);
    if (key) memberKeys.add(key);
  }
  if (!memberKeys.has(targetKey)) return [];

  const items = [];
  const isPrivate = /Private$/.test(String(source ?? ''));

  for (const record of Array.isArray(records) ? records : []) {
    if (record.source !== source) continue;
    if (record.removed === 'yes') continue;
    if (record.status === 'unavailable') continue;

    const before = Array.isArray(record.bookmark_tags) ? record.bookmark_tags : [];
    if (before.length === 0) continue;

    const after = [];
    const seen = new Set();
    let changed = false;

    for (const raw of before) {
      const tag = String(raw ?? '').trim();
      if (!tag) continue;

      const key = normalizeTagKey(tag);
      // 组内成员（含目标自己）统一写成目标标签的原始拼写
      const next = memberKeys.has(key) ? targetTag : tag;
      if (next !== tag) changed = true;

      const nextKey = normalizeTagKey(next);
      if (seen.has(nextKey)) {
        // 目标标签本来就在、又要塞进来一个成员，去重后总数会变少
        changed = true;
        continue;
      }
      seen.add(nextKey);
      after.push(next);
    }

    if (!changed) continue;

    items.push({
      pid: String(record.pid),
      kind: record.type === 'novel' ? 'novel' : 'illust',
      isPrivate,
      before: [...before],
      after,
    });
  }

  return items;
}

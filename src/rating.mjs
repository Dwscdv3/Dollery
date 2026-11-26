/**
 * 评分 —— 收藏标签体系里的一类特殊标签，格式固定为 `n/10`（n = 1~10 的整数）。
 *
 * 它不是独立字段：pixiv 没有「评分」这个东西，一切都存在 bookmark_tags 里。
 * 所以这里的函数都只做两件事 —— 从标签数组里把它认出来、或者替换掉它，
 * 其余标签原样保留（顺序也不动，否则每次改分都会在 git diff 里挪动一整行）。
 *
 * 一个必须知道的副作用：评分会占掉 10 个收藏标签里的一个位置。标签已满且
 * 原本没有评分时，塞不进去 —— 这时应该让用户挑一个删掉，而不是偷偷丢掉别的标签。
 */
export const RATING_TAG_LIMIT = 10;

/** 只认 `1/10` ~ `10/10`。`0/10`、`11/10`、`9/10 分` 都不算。 */
const RATING_PATTERN = /^(\d{1,2})\s*\/\s*10$/;

/** 判断单个标签是不是评分标签；是则返回 1~10 的分值，否则 null。 */
export function parseRatingTag(tag) {
  const matched = RATING_PATTERN.exec(String(tag ?? '').trim());
  if (!matched) return null;

  const value = Number(matched[1]);
  return Number.isInteger(value) && value >= 1 && value <= 10 ? value : null;
}

/** 在标签数组里找评分。返回 { value, tag, index }，没有则 null。 */
export function findRating(tags) {
  const list = Array.isArray(tags) ? tags : [];

  for (let index = 0; index < list.length; index += 1) {
    const value = parseRatingTag(list[index]);
    if (value !== null) return { value, tag: String(list[index]), index };
  }

  return null;
}

/** 去掉所有评分标签（理论上最多一个，历史脏数据可能不止一个）。 */
export function stripRating(tags) {
  return (Array.isArray(tags) ? tags : []).filter((tag) => parseRatingTag(tag) === null);
}

/**
 * 把评分设成 value（1~10），或传 0 表示清除。
 *
 * 位置策略：原来有评分就**顶替它原来那一格**，没有就追加到末尾。
 * 这样改分在 git diff 里只是同一行里的数字变化，不会多出一行删除 + 一行新增。
 */
export function applyRating(tags, value) {
  const list = Array.isArray(tags) ? tags : [];
  const kept = [];
  let insertAt = -1;

  for (const tag of list) {
    if (parseRatingTag(tag) !== null) {
      if (insertAt < 0) insertAt = kept.length;
      continue;
    }
    kept.push(tag);
  }

  const next = Number(value);
  // 非法值（比如 11）原样返回，别顺手把已有的评分抹掉
  if (!Number.isInteger(next) || next < 0 || next > RATING_TAG_LIMIT) return list.slice();
  if (next === 0) return kept;

  if (insertAt < 0) insertAt = kept.length;
  kept.splice(Math.min(insertAt, kept.length), 0, `${next}/10`);
  return kept;
}

/**
 * 本地元数据的读写层。
 *
 * 格式是 JSON，但序列化是手写的而不是 JSON.stringify(obj, null, 2) —— 目的是让
 * git diff 说人话：
 *   · 每条记录独立成块，一个字段一行，改标题就只变那一行
 *   · 标签数组内联成 `["a", "b"]`，不会因为数组元素多就把文件撑成几百行
 *
 * 三个必须守住的约束：
 *   1. 序列化是幂等的 —— 读进来再写出去必须逐字节相同，否则每次同步都会产生
 *      无意义的 diff。
 *   2. 排序稳定 —— 按 id 升序（收藏顺序），取消收藏不会重排。
 *   3. 字段顺序固定 —— FIELD_ORDER 决定书写顺序，不随对象键序漂移。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 字段顺序即文件中的书写顺序。改动这里等于改变整个文件的形状，慎动。
 *
 * 两个「标签」字段来源完全不同，别混：
 *   tags          —— 作者给作品打的标签，所有访客都能看到
 *   bookmark_tags —— 你自己收藏时打的私有分类标签，只有本人可见
 *
 * 只收「稳定字段」：作品固有属性或收藏关系本身。点赞数、收藏数、浏览数这类
 * 每天都变的数字刻意不记 —— 它们会让每次同步产生几千行噪声 diff，把真正
 * 有价值的变更（新收藏、标题改动）淹掉。何况插画侧的收藏接口根本不返回这些数。
 */
export const FIELD_ORDER = [
  'id',
  'pid',
  'type',
  'title',
  'author',
  'author_id',
  'published',
  'pages',
  'width',
  'height',
  'text_length',
  'language',
  'tags',
  'bookmark_tags',
  'x_restrict',
  'ai_type',
  'private_bookmark',
  'status',
  'removed',
  'first_seen',
  'url',
];

const FORMAT_ID = 'pixiv-export/2';

/** 判断一个值是否值得写进文件。数字 0 是有效值（比如 x_restrict: 0）。 */
function hasValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/** 数组内联成一行，其余交给 JSON.stringify。 */
function serializeValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
  }
  return JSON.stringify(value);
}

/**
 * 把记录数组渲染成 JSON 文本。meta 写进 `_meta`，不参与记录解析。
 */
export function serialize(records, meta = {}) {
  const metaFields = {
    format: FORMAT_ID,
    kind: meta.kindLabel,
    count: records.length,
    lastSync: meta.lastSync,
    sourceTotal: meta.sourceTotal,
  };

  const metaLines = Object.entries(metaFields).filter(([, value]) => hasValue(value));
  const lines = [];

  lines.push('{');
  lines.push('  "_meta": {');
  metaLines.forEach(([key, value], index) => {
    const comma = index < metaLines.length - 1 ? ',' : '';
    lines.push(`    ${JSON.stringify(key)}: ${serializeValue(value)}${comma}`);
  });
  lines.push('  },');
  lines.push('  "records": [');

  records.forEach((record, recordIndex) => {
    const keys = FIELD_ORDER.filter((key) => hasValue(record[key]));
    lines.push('    {');
    keys.forEach((key, index) => {
      const comma = index < keys.length - 1 ? ',' : '';
      lines.push(`      ${JSON.stringify(key)}: ${serializeValue(record[key])}${comma}`);
    });
    lines.push(`    }${recordIndex < records.length - 1 ? ',' : ''}`);
  });

  lines.push('  ]');
  lines.push('}');

  return `${lines.join('\n')}\n`;
}

/**
 * 解析 JSON 文本。结构不对时给出能定位问题的报错，而不是让 JSON.parse 甩一句
 * "Unexpected token" 了事。
 */
export function parse(text) {
  const trimmed = String(text).trim();
  if (trimmed === '') return { meta: {}, records: [] };

  let document;
  try {
    document = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`备份文件不是合法的 JSON：${err.message}`);
  }

  const records = Array.isArray(document) ? document : (document.records ?? []);
  if (!Array.isArray(records)) {
    throw new Error('备份文件结构不对：应当有 records 数组。');
  }

  return {
    meta: document._meta ?? {},
    records: records.filter((record) => record && typeof record === 'object'),
  };
}

/**
 * 按收藏顺序排列：id 升序，最早收藏的排在最前面。
 *
 * id 是「收藏顺序号」，不是作品 id（那是 pid）。它一经分配就不再重排 —— 哪怕中间
 * 取消了收藏也不会让后面的记录往前挪，否则取消一条就会导致几千行一起位移，
 * diff 彻底失效。取消只留空洞，靠 removed 字段标记。
 *
 * 没有 id 的记录（首次迁移前的旧数据）排在最后；两者都没有时退化为 pid 降序，
 * 保证输出结果稳定可复现。
 */
export function sortRecords(records) {
  return [...records].sort((a, b) => {
    const seqA = Number(a.id);
    const seqB = Number(b.id);
    const hasA = Number.isFinite(seqA) && seqA > 0;
    const hasB = Number.isFinite(seqB) && seqB > 0;

    if (hasA && hasB && seqA !== seqB) return seqA - seqB;
    if (hasA !== hasB) return hasA ? -1 : 1;
    return String(b.pid).localeCompare(String(a.pid));
  });
}

/**
 * 差分比较前先把「等价于空」的值归一化。
 *
 * undefined / null / '' / [] 在文件里都不会出现，也就是完全一样。比较时不归一化的话，
 * `undefined → ''` 这种看不见的变化会被报成「字段变更」，一次就刷出几千条假 diff。
 */
function normalizeForCompare(value) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return value;
}

/**
 * 字段级差分。返回新增 / 消失 / 变更三类，变更里带上具体字段，
 * 这样同步结束后能直接告诉用户「改了什么」，而不只是「变了 N 条」。
 *
 * 匹配键用 pid（作品 id）而不是 id（收藏序号）—— id 会随取消收藏产生空洞，
 * 但作品身份是稳定的。用 pid 匹配，收藏序号变化才会被当成一次「字段变更」。
 */
export function diffRecords(before, after) {
  const keyOf = (record) => String(record.pid ?? record.id);
  const beforeMap = new Map(before.map((r) => [keyOf(r), r]));
  const afterMap = new Map(after.map((r) => [keyOf(r), r]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, record] of afterMap) {
    const old = beforeMap.get(key);
    if (!old) {
      added.push(record);
      continue;
    }
    const fields = [];
    for (const field of FIELD_ORDER) {
      const a = JSON.stringify(normalizeForCompare(old[field]));
      const b = JSON.stringify(normalizeForCompare(record[field]));
      if (a !== b) fields.push({ key: field, from: old[field], to: record[field] });
    }
    if (fields.length > 0) changed.push({ pid: key, id: record.id, record, fields });
  }

  for (const [key, record] of beforeMap) {
    if (!afterMap.has(key)) removed.push(record);
  }

  return { added, removed, changed };
}

export async function readDocument(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return { meta: {}, records: [] };
    throw err;
  }
}

export async function readRecords(filePath) {
  const { records } = await readDocument(filePath);
  return records;
}

/**
 * 原子写：先写临时文件再 rename。中途崩溃不会留下半截文件，
 * 这对一个用 git 追踪的备份文件很重要 —— 半个文件会让后续所有 diff 失效。
 */
export async function writeRecords(filePath, records, meta = {}) {
  const absolute = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });

  const text = serialize(sortRecords(records), meta);
  const tempPath = `${absolute}.tmp`;

  await fs.writeFile(tempPath, text, 'utf8');
  await fs.rename(tempPath, absolute);

  return text;
}

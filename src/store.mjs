/**
 * 本地元数据的读写层。
 *
 * 存储格式刻意选「每条多行 key: value + 空行分隔」而不是 JSON —— 目的只有一个：
 * 让 git diff 说人话。收藏一条新作品，diff 里就是新增的一个记录块；改了个标题，
 * 就是那么一行变了。JSON 数组里插一条会让后续所有行错位，diff 一团糟。
 *
 * 两个必须守住的约束：
 *   1. 序列化是幂等的 —— 读进来再写出去必须逐字节相同，否则每次同步都会产生
 *      无意义的 diff。
 *   2. 排序稳定 —— 按 id 降序。id 是作品固有属性，不会因为同步顺序变化而漂移。
 *
 * 值里边可能出现的换行和反斜杠会做转义，标签用 CSV 规则处理（标签本身可能带逗号）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 字段顺序即文件中的书写顺序。改动这里等于改变整个文件的形状，慎动。
 *
 * 只收「稳定字段」：作品固有属性或收藏关系本身。点赞数、收藏数、浏览数这类
 * 每天都变的数字刻意不记 —— 它们会让每次同步产生几千行噪声 diff，把真正
 * 有价值的变更（新增收藏、标题改动）淹掉。何况插画侧的收藏接口根本不返回这些数。
 */
export const FIELD_ORDER = [
  'seq',
  'id',
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
  'x_restrict',
  'ai_type',
  'private_bookmark',
  'status',
  'removed',
  'first_seen',
  'url',
];

const HEADER_PREFIX = '#';

function escapeScalar(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function unescapeScalar(value) {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === '\\') {
      out += '\\';
      i += 1;
    } else if (next === 'n') {
      out += '\n';
      i += 1;
    } else if (next === 'r') {
      out += '\r';
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/** 标签按 CSV 规则序列化：含逗号或引号时加引号并把内部引号翻倍。 */
function encodeTags(tags) {
  return tags
    .map((tag) => {
      const text = String(tag);
      if (/[",\\]/.test(text)) {
        return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '""')}"`;
      }
      return text;
    })
    .join(', ');
}

function decodeTags(text) {
  const tags = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '\\' && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
      } else if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' && current.trim() === '') {
      quoted = true;
      current = '';
    } else if (ch === ',') {
      if (current.trim() !== '') tags.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim() !== '') tags.push(current.trim());
  return tags;
}

function formatValue(key, value) {
  if (key === 'tags') {
    return encodeTags(Array.isArray(value) ? value : String(value).split(','));
  }
  return escapeScalar(value);
}

/**
 * 把记录数组渲染成文本。meta 只影响注释头，不参与解析。
 */
export function serialize(records, meta = {}) {
  const lines = [];
  lines.push(`${HEADER_PREFIX} pixiv-export 收藏元数据备份`);
  lines.push(`${HEADER_PREFIX} 格式：每条记录为多行 key: value，记录之间用空行分隔`);
  lines.push(`${HEADER_PREFIX} 由程序自动生成，手工编辑会在下次同步时被覆盖`);
  lines.push(`${HEADER_PREFIX} 按 seq 升序排列，seq=1 是最早收藏的作品`);
  lines.push(`${HEADER_PREFIX} first_seen 表示本程序首次发现该收藏的日期`);
  lines.push(`${HEADER_PREFIX} removed: yes 表示该作品已不在收藏夹中，记录仅为留存历史`);
  lines.push(`${HEADER_PREFIX} 记录数: ${records.length}`);

  if (meta.kindLabel) lines.push(`${HEADER_PREFIX} 类型: ${meta.kindLabel}`);
  if (meta.lastSync) lines.push(`${HEADER_PREFIX} 最后同步: ${meta.lastSync}`);
  if (meta.sourceTotal !== undefined) lines.push(`${HEADER_PREFIX} 服务端总数: ${meta.sourceTotal}`);
  lines.push('');

  for (const record of records) {
    for (const key of FIELD_ORDER) {
      const value = record[key];
      if (value === undefined || value === null || value === '') continue;
      // 空标签列表不写行，避免留下一个没有值的键。
      if (Array.isArray(value) && value.length === 0) continue;
      lines.push(`${key}: ${formatValue(key, value)}`);
    }
    lines.push('');
  }

  // 文件以单个换行收尾，避免多次写入累积尾部空白。
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * 解析文本为记录数组。无法识别的行直接跳过（比如手工加的空注释），
 * 不抛异常 —— 备份文件的价值在于能读出来，不应该因为一行脏数据就整个失败。
 */
export function parse(text) {
  const records = [];
  let current = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    // 只去掉行尾的 \r，不能顺手 trimEnd()。有些作品标题真的以全角空格（U+3000）
    // 结尾，而 trimEnd 会把它一起吃掉 —— 于是文件里的值和内存里的值对不上，
    // 每次全量同步都会把这些记录误报成「标题变更」。实测 4859 条里有 8 条中招。
    const line = rawLine.replace(/\r$/, '');

    if (line === '') {
      if (current && Object.keys(current).length > 0) {
        records.push(current);
        current = null;
      }
      continue;
    }

    if (line.startsWith(HEADER_PREFIX)) continue;

    const separator = line.indexOf(':');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    const rest = line.slice(separator + 1).replace(/^ /, '');
    if (!key) continue;

    if (!current) current = {};

    if (key === 'tags') {
      current.tags = decodeTags(rest);
    } else {
      current[key] = unescapeScalar(rest);
    }
  }

  if (current && Object.keys(current).length > 0) records.push(current);

  // 数字类字段还原成数字，方便后续比较和展示。
  for (const record of records) {
    for (const key of ['seq', 'pages', 'width', 'height', 'text_length', 'x_restrict', 'ai_type']) {
      if (record[key] === undefined || record[key] === '') continue;
      const num = Number(record[key]);
      if (!Number.isNaN(num)) record[key] = num;
    }
  }

  return records;
}

/**
 * 按收藏顺序排列：seq 升序，最早收藏的排在最前面。
 *
 * seq 是「收藏顺序号」，不是作品 id。它一经分配就不再重排 —— 哪怕中间取消了收藏
 * 也不会让后面的记录往前挪，否则取消一条就会导致几千行一起位移，diff 彻底失效。
 * 取消只留空洞，靠 removed 字段标记。
 *
 * 没有 seq 的记录（首次迁移前的旧数据）排在最后；两者都没有时退化为 id 降序，
 * 保证输出结果稳定可复现。
 */
export function sortRecords(records) {
  return [...records].sort((a, b) => {
    const seqA = Number(a.seq);
    const seqB = Number(b.seq);
    const hasA = Number.isFinite(seqA) && seqA > 0;
    const hasB = Number.isFinite(seqB) && seqB > 0;

    if (hasA && hasB && seqA !== seqB) return seqA - seqB;
    if (hasA !== hasB) return hasA ? -1 : 1;
    return String(b.id).localeCompare(String(a.id));
  });
}

/**
 * 差分比较前先把「等价于空」的值归一化。
 *
 * 序列化时 undefined / null / '' / [] 都不会写出任何行，也就是在文件里完全一样。
 * 如果比较时不归一化，`undefined → ''` 这种看不见的变化会被报成「字段变更」，
 * 一次就会刷出几千条假 diff。
 */
function normalizeForCompare(value) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return value;
}

/**
 * 字段级差分。返回新增 / 消失 / 变更三类，变更里带上具体字段，
 * 这样同步结束后能直接告诉用户「改了什么」，而不只是「变了 N 条」。
 */
export function diffRecords(before, after) {
  const beforeMap = new Map(before.map((r) => [String(r.id), r]));
  const afterMap = new Map(after.map((r) => [String(r.id), r]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, record] of afterMap) {
    const old = beforeMap.get(id);
    if (!old) {
      added.push(record);
      continue;
    }
    const fields = [];
    for (const key of FIELD_ORDER) {
      const a = JSON.stringify(normalizeForCompare(old[key]));
      const b = JSON.stringify(normalizeForCompare(record[key]));
      if (a !== b) fields.push({ key, from: old[key], to: record[key] });
    }
    if (fields.length > 0) changed.push({ id, record, fields });
  }

  for (const id of beforeMap.keys()) {
    if (!afterMap.has(id)) removed.push(beforeMap.get(id));
  }

  return { added, removed, changed };
}

export async function readRecords(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
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

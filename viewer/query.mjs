/**
 * 收藏列表的布尔搜索。
 *
 * 语法：
 *   expr    := andExpr (OR andExpr)*
 *   andExpr := notExpr ((AND)? notExpr)*      ← 空格视为隐式 AND
 *   notExpr := NOT notExpr | -notExpr | primary
 *   primary := '(' expr ')' | WORD | "PHRASE"
 *
 * 排除条件有两种写法，等价：
 *   NOT 原神      -原神      -type:novel      -"白 タイツ"      -(a OR b)
 *
 * 所有词项对「标题 / 作者 / pid / 作品标签 / 收藏标签」做统一的不区分大小写包含匹配。
 * 中文没有空格分词，所以一个 WORD 常常就是一整个中文短语，直接 includes 即可。
 *
 * 标签组：词项与某个组员完全相等时，自动展开成 (a OR b OR c)，
 * 组员内部仍按上面的全文口径匹配。
 *
 * 解析失败不抛错：宁可返回一个宽松的 AST，也不要让用户的半截输入把整个列表打成空白。
 */

const KEYWORDS = new Set(['AND', 'OR', 'NOT']);

/**
 * matchField 认识的字段名。展开标签组时要跳过这些词：
 * `type:novel` 不是标签，不该被同义词表影响。
 */
const FIELD_KEYS = new Set(['type', 'ai', 'r18', 'pages', 'ratio', 'date', 'is']);

/**
 * 归一化标签 → 该组全部成员。组只有 1 个成员时没有意义，直接忽略。
 *
 * 值为「成员原串」而不是小写串：matchWord 自己会做不区分大小写的比较，
 * 保留原样方便调试时一眼看出是哪个标签。
 */
function buildExpander(groups) {
  const map = new Map();

  for (const group of Array.isArray(groups) ? groups : []) {
    const members = [];
    const seen = new Set();

    for (const raw of Array.isArray(group?.tags) ? group.tags : []) {
      const tag = String(raw ?? '').trim();
      const key = tag.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      members.push(tag);
    }

    if (members.length < 2) continue;
    for (const key of seen) map.set(key, members);
  }

  return map;
}

/**
 * 把一个词项变成语法树。命中标签组时展开成 (a OR b OR c)。
 *
 * 只在词项与成员**完全相等**时展开 —— 用 includes 的话，搜「東方」会把
 * 「東方Project」那一组也牵进来，搜索范围会莫名其妙地变大。
 */
function wordNode(value, expand) {
  const leaf = { op: 'word', value };
  if (!expand || expand.size === 0) return leaf;

  const colon = value.indexOf(':');
  if (colon > 0 && FIELD_KEYS.has(value.slice(0, colon))) return leaf;

  const members = expand.get(value.trim().toLowerCase());
  if (!members) return leaf;

  let node = null;
  for (const member of members) {
    const child = { op: 'word', value: member.toLowerCase() };
    node = node ? { op: 'or', left: node, right: child } : child;
  }
  return node;
}

function tokenize(text) {
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === '(' || ch === ')') {
      tokens.push({ type: ch });
      i += 1;
      continue;
    }

    // 引号短语：内部空格原样保留
    if (ch === '"') {
      let j = i + 1;
      let buffer = '';
      while (j < text.length && text[j] !== '"') {
        buffer += text[j];
        j += 1;
      }
      tokens.push({ type: 'word', value: buffer.trim().toLowerCase() });
      i = j + 1;
      continue;
    }

    let j = i;
    while (j < text.length && !/[\s()"]/.test(text[j])) j += 1;
    const raw = text.slice(i, j);
    const upper = raw.toUpperCase();

    // 前缀减号 = 排除。注意只认词首：R-18 这种标签里的连字符不受影响。
    // 单独的 "-" 后面可能跟着引号短语或括号，也要当成否定。
    if (raw === '-') {
      tokens.push({ type: 'NOT' });
      i = j;
      continue;
    }
    if (raw.startsWith('-') && raw.length > 1) {
      tokens.push({ type: 'NOT' });
      tokens.push({ type: 'word', value: raw.slice(1).toLowerCase() });
      i = j;
      continue;
    }

    if (KEYWORDS.has(upper)) tokens.push({ type: upper });
    else tokens.push({ type: 'word', value: raw.toLowerCase() });

    i = j;
  }

  return tokens;
}

function parse(tokens, expand = null) {
  let pos = 0;

  const peek = () => tokens[pos];
  const eat = (type) => {
    if (tokens[pos]?.type === type) {
      pos += 1;
      return true;
    }
    return false;
  };

  function parseExpr() {
    let node = parseAnd();
    while (peek()?.type === 'OR') {
      pos += 1;
      node = { op: 'or', left: node, right: parseAnd() };
    }
    return node;
  }

  function parseAnd() {
    let node = parseNot();

    for (;;) {
      const token = peek();
      if (!token) break;

      if (token.type === 'AND') {
        pos += 1;
        node = { op: 'and', left: node, right: parseNot() };
        continue;
      }

      // 隐式 AND：紧跟着的 word / 左括号 / 否定词说明还有个子表达式。
      // NOT 必须算进来，否则 `原神 -風景` 会在 NOT 处断掉，只剩「原神」生效。
      if (token.type === 'word' || token.type === '(' || token.type === 'NOT') {
        node = { op: 'and', left: node, right: parseNot() };
        continue;
      }

      // OR / 右括号 / 其他，交回上层
      break;
    }

    return node;
  }

  function parseNot() {
    if (eat('NOT')) return { op: 'not', expr: parseNot() };
    return parsePrimary();
  }

  function parsePrimary() {
    if (eat('(')) {
      const node = parseExpr();
      eat(')');
      return node;
    }

    const token = peek();
    if (token?.type === 'word') {
      pos += 1;
      return wordNode(token.value, expand);
    }

    // 容错：跳过一个没法识别的 token，返回「恒真」
    pos += 1;
    return { op: 'all' };
  }

  if (tokens.length === 0) return null;

  // 括号不匹配时剩余 token 直接丢弃 —— 宁可少匹配几个词，也不要抛错
  return parseExpr();
}

function truthy(value) {
  return ['yes', '1', 'true', 'y', 'on'].includes(String(value).toLowerCase());
}

function matchNumber(actual, expr) {
  const m = /^(>=|<=|>|<|=)?(\d+)$/.exec(String(expr));
  if (!m) return false;
  const n = Number(m[2]);
  switch (m[1] ?? '=') {
    case '>':
      return actual > n;
    case '>=':
      return actual >= n;
    case '<':
      return actual < n;
    case '<=':
      return actual <= n;
    default:
      return actual === n;
  }
}

/**
 * 日期比较。record.published 形如 "2013-02-16T18:20:25+09:00"，取前 10 位比较，
 * 这样 "2023"、"2023-05"、"2023-05-11" 都能按前缀匹配。
 *   date:2023            → 落在 2023 年内
 *   date:2023-05         → 落在 2023 年 5 月
 *   date:>2023-01-01     → 晚于该日
 *   date:2020..2022      → 闭区间
 */
function matchDate(published, expr) {
  const text = String(published ?? '').slice(0, 10);
  if (!text) return false;

  const raw = String(expr).trim();

  // 区间：a..b（任意一端可省略）
  if (raw.includes('..')) {
    const [from, to] = raw.split('..').map((s) => s.trim());
    if (from && text < from) return false;
    if (to && text > to) return false;
    return Boolean(from || to);
  }

  // 比较：>=2023-01-01 / <2020
  const cmp = /^(>=|<=|>|<)(\d{4}(?:-\d{2}(?:-\d{2})?)?)$/.exec(raw);
  if (cmp) {
    const [, op, value] = cmp;
    const left = text.slice(0, value.length);
    switch (op) {
      case '>':
        return left > value;
      case '>=':
        return left >= value;
      case '<':
        return left < value;
      case '<=':
        return left <= value;
      default:
        return false;
    }
  }

  // 前缀：2023 / 2023-05 / 2023-05-11
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(raw)) return text.startsWith(raw);

  return false;
}

/**
 * 图片比例。用「宽 / 高」判定：
 *   ratio:landscape（横图） portrait（竖图） square（方图）
 *   ratio:>1.5    ratio:<0.7    ratio:1.0（±2% 内算相等）
 * 小说没有尺寸，一律不匹配（用 type:novel 找小说）。
 */
function matchRatio(record, expr) {
  const w = Number(record.width) || 0;
  const h = Number(record.height) || 0;
  if (!w || !h) return false;

  const value = String(expr).trim().toLowerCase();
  const ratio = w / h;

  if (value === 'landscape' || value === 'horizontal' || value === 'wide') return ratio > 1.02;
  if (value === 'portrait' || value === 'vertical' || value === 'tall') return ratio < 0.98;
  if (value === 'square') return ratio >= 0.98 && ratio <= 1.02;

  const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)$/.exec(value);
  if (!m) return false;

  const n = Number(m[2]);
  const op = m[1] ?? '=';
  if (op === '=') return Math.abs(ratio - n) <= 0.02;
  if (op === '>') return ratio > n;
  if (op === '>=') return ratio >= n;
  if (op === '<') return ratio < n;
  return ratio <= n;
}

/**
 * 字段限定。支持作品自身的属性（不是标签）：
 *   type:illust|manga|ugoira|novel
 *   ai:yes / ai:no         是否 AI 生成
 *   r18:yes / r18:no       是否 R-18
 *   pages:>10 / pages:<5 / pages:2
 *   ratio:landscape|portrait|square|>1.5|<0.7
 *   date:2023 / date:2023-05 / date:>2023-01-01 / date:2020..2022
 *   is:ai|r18|ugoira|manga|novel|removed|unavailable|bookmarked
 *
 * 返回 null 表示「不认识这个字段」，交给全文匹配兜底。
 */
function matchField(key, value, record) {
  switch (key) {
    case 'type':
      return String(record.type ?? '').toLowerCase() === value;

    case 'ai': {
      // pixiv 的 aiType 是三态：0 未标注 / 1 作者声明不是 AI / 2 是 AI。
      // 别用 > 0 —— 那会把「明确非 AI」的 1345 条也算成 AI。
      const type = Number(record.ai_type) || 0;
      if (/^[012]$/.test(String(value))) return type === Number(value);
      return truthy(value) === (type === 2);
    }

    case 'r18':
      return truthy(value) === (Number(record.x_restrict) > 0);

    case 'pages':
      return matchNumber(Number(record.pages) || 0, value);

    case 'ratio':
      return matchRatio(record, value);

    case 'date':
      return matchDate(record.published, value);

    case 'is':
      switch (value) {
        case 'ai':
          return Number(record.ai_type) === 2;
        case 'r18':
          return Number(record.x_restrict) > 0;
        case 'ugoira':
          return record.type === 'ugoira';
        case 'manga':
          return record.type === 'manga';
        case 'novel':
          return record.type === 'novel';
        case 'illust':
          return record.type === 'illust';
        case 'removed':
          return record.removed === 'yes';
        case 'unavailable':
          return record.status === 'unavailable';
        case 'bookmarked':
          return record.removed !== 'yes';
        default:
          return false;
      }

    default:
      return null;
  }
}

function matchWord(word, record) {
  if (!word) return true;

  // 先尝试字段语法，再退回全文匹配
  const colon = word.indexOf(':');
  if (colon > 0) {
    const handled = matchField(word.slice(0, colon), word.slice(colon + 1), record);
    if (handled !== null) return handled;
  }

  const fields = [
    record.title,
    record.author,
    record.pid,
    ...(Array.isArray(record.tags) ? record.tags : []),
    ...(Array.isArray(record.bookmark_tags) ? record.bookmark_tags : []),
  ];

  for (const field of fields) {
    if (String(field ?? '').toLowerCase().includes(word)) return true;
  }
  return false;
}

function evaluate(node, record) {
  switch (node.op) {
    case 'and':
      return evaluate(node.left, record) && evaluate(node.right, record);
    case 'or':
      return evaluate(node.left, record) || evaluate(node.right, record);
    case 'not':
      return !evaluate(node.expr, record);
    case 'word':
      return matchWord(node.value, record);
    default:
      return true;
  }
}

/**
 * 编译查询串；空串返回 null 表示「不过滤」。
 *
 * options.groups 是标签组（`[{ id, tags: [...] }]`）：词项命中组员时会展开成
 * `(a OR b OR c)`。展开发生在建树阶段，所以 `-词`、`NOT 词`、括号、
 * 显式 AND/OR 的优先级都由原解析器保证，不需要额外处理。
 */
export function compileQuery(text, options = {}) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  return parse(tokenize(trimmed), buildExpander(options.groups));
}

/** 用编译结果过滤记录。 */
export function matches(ast, record) {
  if (!ast) return true;
  return evaluate(ast, record);
}

/** 查询串里是否用到了布尔语法（用于界面提示）。 */
export function usesBoolean(text) {
  return /\b(AND|OR|NOT)\b/i.test(String(text ?? ''));
}

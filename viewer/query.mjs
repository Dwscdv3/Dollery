/**
 * 收藏列表的布尔搜索。
 *
 * 语法：
 *   expr    := andExpr (OR andExpr)*
 *   andExpr := notExpr ((AND)? notExpr)*      ← 空格视为隐式 AND
 *   notExpr := NOT notExpr | primary
 *   primary := '(' expr ')' | WORD | "PHRASE"
 *
 * 所有词项对「标题 / 作者 / pid / 作品标签 / 收藏标签」做统一的不区分大小写包含匹配。
 * 中文没有空格分词，所以一个 WORD 常常就是一整个中文短语，直接 includes 即可。
 *
 * 解析失败不抛错：宁可返回一个宽松的 AST，也不要让用户的半截输入把整个列表打成空白。
 */

const KEYWORDS = new Set(['AND', 'OR', 'NOT']);

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

    if (KEYWORDS.has(upper)) tokens.push({ type: upper });
    else tokens.push({ type: 'word', value: raw.toLowerCase() });

    i = j;
  }

  return tokens;
}

function parse(tokens) {
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

      // 隐式 AND：紧跟着的 word 或左括号说明还有个子表达式
      if (token.type === 'word' || token.type === '(') {
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
      return { op: 'word', value: token.value };
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
 * 字段限定。支持作品自身的属性（不是标签）：
 *   type:illust|manga|ugoira|novel
 *   ai:yes / ai:no         是否 AI 生成
 *   r18:yes / r18:no       是否 R-18
 *   pages:>10 / pages:<5 / pages:2
 *   is:ai|r18|ugoira|manga|novel|removed|unavailable|bookmarked
 *
 * 返回 null 表示「不认识这个字段」，交给全文匹配兜底。
 */
function matchField(key, value, record) {
  switch (key) {
    case 'type':
      return String(record.type ?? '').toLowerCase() === value;

    case 'ai':
      return truthy(value) === (Number(record.ai_type) > 0);

    case 'r18':
      return truthy(value) === (Number(record.x_restrict) > 0);

    case 'pages':
      return matchNumber(Number(record.pages) || 0, value);

    case 'is':
      switch (value) {
        case 'ai':
          return Number(record.ai_type) > 0;
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

/** 编译查询串；空串返回 null 表示「不过滤」。 */
export function compileQuery(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  return parse(tokenize(trimmed));
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

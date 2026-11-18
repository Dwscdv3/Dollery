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

function matchWord(word, record) {
  if (!word) return true;

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

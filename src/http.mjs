/**
 * 受控 HTTP 层。
 *
 * 两件事是必须守住的底线，其余都是细节：
 *   1. 所有出站请求必须走本机代理（默认 127.0.0.1:7897）。Pixiv 直连在旧版本里
 *      可能"偶尔能通"，所以这里不做任何直连回退 —— 走错路比走不动更糟。
 *   2. 相邻两次请求的开始时间必须间隔 >= intervalMs。Pixiv 对高频访问很敏感，
 *      触发限流后恢复代价远大于慢一点。
 *
 * 限速器是串行的：任务排进队列后严格按顺序执行，不做并发。这里刻意放弃吞吐，
 * 换的是行为可预测。
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { URL } from 'node:url';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 串行限速队列。
 *
 * run() 返回的 Promise 在任务真正执行后兑现；队列内部用 `.then(() => {}, () => {})`
 * 吞掉异常，保证一个任务失败不会把后续任务一起带走。
 */
export class RateLimiter {
  /**
   * @param {number} minIntervalMs 相邻两次请求的最小间隔
   * @param {number} jitterMs 在最小间隔之上再随机加一点
   * @param {import('./pacer.mjs').RequestPacer|null} pacer 粗粒度节奏控制（长暂停），可为空
   * @param {number} fastIntervalMs 快速通道的间隔（用户手动触发的写操作）。0 = 不排队
   */
  constructor(minIntervalMs = 2000, jitterMs = 250, pacer = null, fastIntervalMs = 0) {
    this.minIntervalMs = minIntervalMs;
    this.jitterMs = jitterMs;
    this.pacer = pacer;
    // 快速通道不能比普通通道还慢，否则这个开关就没意义了
    this.fastIntervalMs = Math.max(0, Math.min(fastIntervalMs, minIntervalMs));
    this.nextAllowedAt = 0;
    this.fastAllowedAt = 0;
    this.tail = Promise.resolve();
    this.executed = 0;
  }

  /**
   * @param {() => Promise<any>} task
   * @param {{ bypassPacer?: boolean, fast?: boolean }} [options]
   *   bypassPacer: 用户手动触发的那一次，不等随机长休息
   *   fast: 走快速通道 —— 用户点了保存就盯着界面等，按 2 秒排队会以为卡死了。
   *         默认间隔 0（不额外等待），但仍然是串行执行的；发完之后普通请求
   *         照样按完整间隔排队，所以后台的下载节奏不会被带快。
   */
  run(task, { bypassPacer = false, fast = false } = {}) {
    const result = this.tail.then(async () => {
      // 普通请求要看两条闸门（普通队列和快速通道都可能刚用过），
      // 快速请求只等自己那条更短的。
      const gate = fast
        ? this.fastAllowedAt
        : Math.max(this.nextAllowedAt, this.fastAllowedAt);
      const wait = gate - Date.now();
      if (wait > 0) await sleep(wait);
      // 粗粒度休息在这里等着：整条串行链都卡住，所以队列会真的停下来，
      // 而不是一边「休息」一边继续发请求。
      if (this.pacer) await this.pacer.gate({ bypass: bypassPacer });
      // 抖动是为了避免固定频率的请求特征，兼防止多个进程恰好同频。
      const stamp = Date.now();
      this.nextAllowedAt = stamp + this.minIntervalMs + Math.random() * this.jitterMs;
      this.fastAllowedAt = stamp + this.fastIntervalMs;
      this.executed += 1;
      return task();
    });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

/**
 * 通过 HTTP 代理建立到目标主机的 CONNECT 隧道，返回裸 TCP socket。
 */
function openTunnel(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let proxy;
    try {
      proxy = new URL(proxyUrl);
    } catch {
      reject(new Error(`代理地址格式不正确: ${proxyUrl}`));
      return;
    }

    const req = http.request({
      host: proxy.hostname,
      port: proxy.port || 8080,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      timeout: timeoutMs,
    });

    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(
          new Error(
            `代理拒绝建立隧道 (HTTP ${res.statusCode})。请确认 ${proxyUrl} 正在运行且允许 CONNECT。`,
          ),
        );
        return;
      }
      resolve(socket);
    });

    req.once('error', (err) => {
      reject(new Error(`连接代理 ${proxyUrl} 失败: ${err.message}`));
    });

    req.once('timeout', () => {
      req.destroy(new Error(`连接代理 ${proxyUrl} 超时`));
    });

    req.end();
  });
}

async function openTlsOverTunnel(proxyUrl, host, port, timeoutMs) {
  const raw = await openTunnel(proxyUrl, host, port, timeoutMs);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: raw, servername: host }, () => resolve(socket));
    socket.once('error', (err) => {
      raw.destroy();
      reject(new Error(`与 ${host} 建立 TLS 失败: ${err.message}`));
    });
  });
}

/**
 * 连接池：每个「代理 + 目标主机」复用一个 keep-alive agent。
 *
 * 以前是「一个请求一条隧道，用完即弃」。走代理到 pixiv 时，建隧道 + TLS 握手
 * 本身要 0.6~0.7 秒，编辑收藏一次要发三个请求，光握手就白扔掉 1.3 秒。
 * 改成复用之后，只有第一个请求付这笔钱。
 *
 * socket 由 `createConnection` 懒创建：agent 手里有空闲连接就直接复用，
 * 连接被代理掐断时 Node 会自己再调一次 createConnection，配合上层的重试正好。
 */
const agentPool = new Map();

function agentFor(proxy, host, port, timeoutMs) {
  const key = `${proxy}|${host}:${port}`;
  const existing = agentPool.get(key);
  if (existing) return existing;

  const agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 15000,
    maxSockets: 2,
    maxFreeSockets: 1,
    timeout: 45000,
  });

  // 异步建连：走 CONNECT 隧道，再在隧道上做 TLS
  agent.createConnection = (options, callback) => {
    openTlsOverTunnel(proxy, host, port, timeoutMs)
      .then((socket) => {
        socket.setKeepAlive(true, 15000);
        callback(null, socket);
      })
      .catch((err) => callback(err));
  };

  agentPool.set(key, agent);
  return agent;
}

/** 按 Content-Encoding 解开响应体。解不开就原样返回，交给上层报「不是 JSON」。 */
function decodeBody(buffer, encoding) {
  const kind = String(encoding ?? '').toLowerCase().trim();
  if (!kind || kind === 'identity') return buffer;

  try {
    if (kind === 'gzip' || kind === 'x-gzip') return zlib.gunzipSync(buffer);
    if (kind === 'deflate') return zlib.inflateSync(buffer);
    if (kind === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    // 响应体损坏时保持原样，让调用方走「解析失败」的分支
  }
  return buffer;
}

/**
 * 发起一次 HTTPS 请求。
 *
 * 默认把响应按 UTF-8 解成 `body` 字符串（接口都是 JSON）。
 * 传 `binary: true` 则只给 `buffer` —— 图片、zip 走这条路，按字符串解会损坏文件。
 *
 * `method` / `body` 是为写操作准备的：编辑收藏要 POST JSON，且必须带
 * `Content-Length`，否则 Pixiv 会把请求体当空。body 一律按 UTF-8 编码，
 * 因为唯一的写接口（bookmarks/add）只收 JSON。
 *
 * 文本请求会自动带 `Accept-Encoding: gzip` 并解压：旧版编辑页有 120KB，
 * 走代理时不压缩要一秒多，压完只剩十几 KB。
 */
export async function httpsRequest(
  url,
  { method = 'GET', headers = {}, body = null, proxy = null, timeoutMs = 60000, binary = false } = {},
) {
  const target = new URL(url);
  const port = target.port ? Number(target.port) : 443;
  const path = target.pathname + target.search;

  const agent = proxy ? agentFor(proxy, target.hostname, port, timeoutMs) : false;

  const payload =
    body === null || body === undefined
      ? null
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(String(body), 'utf8');

  // Connection 交给 agent 决定（keep-alive 复用），这里不要再写死 close
  const finalHeaders = { Host: target.host, ...headers };
  if (payload) finalHeaders['Content-Length'] = payload.length;

  if (!binary && !Object.keys(finalHeaders).some((key) => key.toLowerCase() === 'accept-encoding')) {
    finalHeaders['Accept-Encoding'] = 'gzip, deflate, br';
  }

  return new Promise((resolve, reject) => {
    const options = {
      host: target.hostname,
      port,
      path,
      method: String(method || 'GET').toUpperCase(),
      headers: finalHeaders,
      timeout: timeoutMs,
      agent,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const collected = binary ? raw : decodeBody(raw, res.headers['content-encoding']);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer: binary ? collected : undefined,
          body: binary ? undefined : collected.toString('utf8'),
          bytes: collected.length,
        });
      });
      res.once('error', reject);
    });

    req.once('error', (err) => {
      // 偶尔会拿到 message 为空的错误，补一句人话，不然排查时一脸茫然。
      if (!err.message) err.message = `请求失败（${err.code ?? '未知原因'}）: ${url}`;
      reject(err);
    });

    req.once('timeout', () => {
      req.destroy(new Error(`请求超时 (${timeoutMs}ms): ${url}`));
    });

    req.end(payload ?? undefined);
  });
}

/** GET 的便捷入口，保留原签名（大量调用点都按这个来）。 */
export function httpsGet(url, opts = {}) {
  return httpsRequest(url, { ...opts, method: 'GET', body: null });
}

/**
 * 带重试的请求。只对「值得重试」的状态码退避重试：
 *   - 429：明确被限流，等更久再试
 *   - 500/502/503/504：服务端临时故障
 * 4xx 的其他状态码（401/403/400）重试没有意义，通常意味着 cookie 失效或参数不对。
 *
 * 注意退避等待发生在限速队列之外，但重试本身仍排队，所以依然满足 2 秒间隔。
 */
export async function httpsRequestWithRetry(url, opts = {}, { retries = 3, onRetry } = {}) {
  const retryable = new Set([429, 500, 502, 503, 504]);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await httpsRequest(url, opts);
      if (!retryable.has(res.status)) return res;

      lastError = new Error(`HTTP ${res.status}`);
      if (attempt === retries) return res;
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
    }

    // 指数退避，但起步就不低于一个限速周期。
    const backoff = Math.max(opts.intervalMs ?? 2000, 2000) * 2 ** attempt;
    if (onRetry) onRetry(attempt + 1, backoff, lastError);
    await sleep(backoff);
  }

  throw lastError ?? new Error('请求失败');
}

/** 带重试的 GET，保留原签名。 */
export function httpsGetWithRetry(url, opts = {}, options = {}) {
  return httpsRequestWithRetry(url, { ...opts, method: 'GET', body: null }, options);
}

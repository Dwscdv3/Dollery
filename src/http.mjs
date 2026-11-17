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
import { URL } from 'node:url';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 串行限速队列。
 *
 * run() 返回的 Promise 在任务真正执行后兑现；队列内部用 `.then(() => {}, () => {})`
 * 吞掉异常，保证一个任务失败不会把后续任务一起带走。
 */
export class RateLimiter {
  constructor(minIntervalMs = 2000, jitterMs = 250) {
    this.minIntervalMs = minIntervalMs;
    this.jitterMs = jitterMs;
    this.nextAllowedAt = 0;
    this.tail = Promise.resolve();
    this.executed = 0;
  }

  run(task) {
    const result = this.tail.then(async () => {
      const wait = this.nextAllowedAt - Date.now();
      if (wait > 0) await sleep(wait);
      // 抖动是为了避免固定频率的请求特征，兼防止多个进程恰好同频。
      this.nextAllowedAt = Date.now() + this.minIntervalMs + Math.random() * this.jitterMs;
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
 * 发起一次 GET 请求。
 *
 * 默认把响应按 UTF-8 解成 `body` 字符串（接口都是 JSON）。
 * 传 `binary: true` 则只给 `buffer` —— 图片、zip 走这条路，按字符串解会损坏文件。
 */
export async function httpsGet(
  url,
  { headers = {}, proxy = null, timeoutMs = 60000, binary = false } = {},
) {
  const target = new URL(url);
  const port = target.port ? Number(target.port) : 443;
  const path = target.pathname + target.search;

  let agent = false;
  if (proxy) {
    const socket = await openTlsOverTunnel(proxy, target.hostname, port, timeoutMs);
    // 每个请求单独一个 agent：连接用完即弃，配合串行限速最省心。
    agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = (opts, callback) => {
      callback(null, socket);
      return socket;
    };
  }

  return new Promise((resolve, reject) => {
    const options = {
      host: target.hostname,
      port,
      path,
      method: 'GET',
      headers: { Host: target.host, Connection: 'close', ...headers },
      timeout: timeoutMs,
      agent,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const collected = Buffer.concat(chunks);
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

    req.end();
  });
}

/**
 * 带重试的请求。只对「值得重试」的状态码退避重试：
 *   - 429：明确被限流，等更久再试
 *   - 500/502/503/504：服务端临时故障
 * 4xx 的其他状态码（401/403/400）重试没有意义，通常意味着 cookie 失效或参数不对。
 *
 * 注意退避等待发生在限速队列之外，但重试本身仍排队，所以依然满足 2 秒间隔。
 */
export async function httpsGetWithRetry(url, opts = {}, { retries = 3, onRetry } = {}) {
  const retryable = new Set([429, 500, 502, 503, 504]);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await httpsGet(url, opts);
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

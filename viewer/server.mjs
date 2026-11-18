/**
 * 收藏查看器的本地服务。
 *
 * 设计取向：不做框架、不打包二进制，就是「Node 起一个只监听 127.0.0.1 的 HTTP 服务 +
 * 用 Edge 的 --app 模式开一个无地址栏窗口」。这样新增体积为 0，且 AVIF 由 Chromium
 * 原生解码 —— 换成 Rust/GDI+ 方案反而要自己集成 libavif。
 *
 * 三个关键决定：
 *   1. 记录全部预加载进内存（约 1.5 万条 / 十几 MB），换掉每次请求读盘的延迟。
 *   2. 缩略图由 ImageMagick 现场转成 360px JPEG 并落盘缓存。AVIF 解码比 JPEG 慢 3~5 倍，
 *      网格里直接铺原图会让滚动卡住，这一步是必做的而不是优化。
 *   3. 只服务 viewer 目录下的白名单静态文件，且路径经过校验 —— 本地服务也不能留穿越漏洞。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { readDocument } from '../src/store.mjs';
import { downloadRecords } from '../src/download.mjs';
import { PixivClient } from '../src/pixiv.mjs';
import { RateLimiter } from '../src/http.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'images');
const THUMB_DIR = path.join(ROOT, 'viewer', '.thumbs');
const VIEWER_DIR = path.join(ROOT, 'viewer');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const BASE_PORT = 7788;

const SOURCES = [
  { key: 'illustPublic', file: 'bookmarks-illust.json', label: '插画·公开', kind: 'illust' },
  { key: 'illustPrivate', file: 'bookmarks-illust-private.json', label: '插画·私密', kind: 'illust' },
  { key: 'novelPublic', file: 'bookmarks-novel.json', label: '小说·公开', kind: 'novel' },
  { key: 'novelPrivate', file: 'bookmarks-novel-private.json', label: '小说·私密', kind: 'novel' },
];

// ---- 状态 ----

const state = {
  records: [], // 全部记录，带 source 标记
  bySource: new Map(), // sourceKey -> 记录数
  imageIndex: new Map(), // `${pid}` -> { pages: Set<number>, ugoira: bool }
  thumbJobs: new Map(), // 缩略图生成去重
  downloading: new Set(), // 正在下载的 pid
  client: null,
  imageLimiter: null,
  config: null,
};

async function loadConfig() {
  try {
    return JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** 扫描 images/ 目录，建立 pid -> 已下载文件 的索引。 */
async function scanImages() {
  const index = new Map();
  let names = [];
  try {
    names = await fsp.readdir(IMAGES_DIR);
  } catch {
    return index;
  }

  for (const name of names) {
    const pageMatch = name.match(/^(\d+)_p(\d+)\.avif$/);
    if (pageMatch) {
      const pid = pageMatch[1];
      const page = Number(pageMatch[2]);
      if (!index.has(pid)) index.set(pid, { pages: new Set(), ugoira: false });
      index.get(pid).pages.add(page);
      continue;
    }
    const ugoiraMatch = name.match(/^(\d+)_ugoira\.zip$/);
    if (ugoiraMatch) {
      const pid = ugoiraMatch[1];
      if (!index.has(pid)) index.set(pid, { pages: new Set(), ugoira: false });
      index.get(pid).ugoira = true;
      continue;
    }
    const novelMatch = name.match(/^(\d+)\.txt$/);
    if (novelMatch) {
      const pid = novelMatch[1];
      if (!index.has(pid)) index.set(pid, { pages: new Set(), ugoira: false });
      index.get(pid).novel = true;
    }
  }

  return index;
}

async function loadRecords() {
  const all = [];
  const counts = new Map();

  for (const source of SOURCES) {
    const filePath = path.join(ROOT, 'data', source.file);
    let document;
    try {
      document = await readDocument(filePath);
    } catch (err) {
      console.warn(`读取 ${source.file} 失败: ${err.message}`);
      continue;
    }
    counts.set(source.key, document.records.length);
    for (const record of document.records) {
      all.push({ ...record, source: source.key });
    }
  }

  state.records = all;
  state.bySource = counts;
}

async function refreshIndex() {
  state.imageIndex = await scanImages();
}

// ---- 缩略图 ----

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => reject(new Error(`${command} 启动失败: ${err.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}: ${stderr.slice(0, 200)}`)),
    );
  });
}

/**
 * 缩略图转换的并发闸门。
 *
 * 浏览器对同一域名会开 6 个并发连接，而每张缩略图都要启动一个 ImageMagick 进程。
 * 不限制的话，快速滚动会堆起一串 magick 进程抢 CPU，反而让所有图都变慢。
 * 限制到 2 个并发，整体吞吐反而更高。
 */
let activeThumbs = 0;
const thumbQueue = [];
const MAX_CONCURRENT_THUMBS = 2;

async function withThumbSlot(task) {
  if (activeThumbs >= MAX_CONCURRENT_THUMBS) {
    await new Promise((resolve) => thumbQueue.push(resolve));
  }
  activeThumbs += 1;
  try {
    return await task();
  } finally {
    activeThumbs -= 1;
    const next = thumbQueue.shift();
    if (next) next();
  }
}

/** 缩略图路径；不存在就现场生成。同一个文件的并发请求合并成一次转换。 */
async function ensureThumb(pid, page) {
  const target = path.join(THUMB_DIR, `${pid}_p${page}.jpg`);
  if (fs.existsSync(target)) return target;

  const source = path.join(IMAGES_DIR, `${pid}_p${page}.avif`);
  if (!fs.existsSync(source)) return null;

  const jobKey = `${pid}_p${page}`;
  if (state.thumbJobs.has(jobKey)) return state.thumbJobs.get(jobKey);

  const job = withThumbSlot(async () => {
    await fsp.mkdir(THUMB_DIR, { recursive: true });
    // -thumbnail 会按需缩小但不会放大，320px 足够网格用
    await runProcess('magick', [source, '-thumbnail', '320x320', '-quality', '82', target]);
    return target;
  }).finally(() => state.thumbJobs.delete(jobKey));

  state.thumbJobs.set(jobKey, job);
  return job;
}

// ---- HTTP ----

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res, filePath, contentType, cacheControl = 'no-cache') {
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
  });
  fs.createReadStream(filePath).pipe(res);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.avif': 'image/avif',
};

/** 解析查询串。 */
function searchParams(url) {
  return new URL(url, 'http://127.0.0.1').searchParams;
}

function decorate(record) {
  const entry = state.imageIndex.get(String(record.pid));
  const pages = entry ? [...entry.pages].sort((a, b) => a - b) : [];
  return {
    id: record.id,
    pid: record.pid,
    type: record.type,
    title: record.title ?? '',
    author: record.author ?? '',
    pages: record.pages ?? '',
    width: record.width ?? '',
    height: record.height ?? '',
    x_restrict: record.x_restrict ?? 0,
    tags: record.tags ?? [],
    bookmark_tags: record.bookmark_tags ?? [],
    status: record.status ?? '',
    removed: record.removed ?? '',
    source: record.source,
    hasImage: pages.length > 0 || Boolean(entry?.ugoira),
    localPages: pages,
    localNovel: Boolean(entry?.novel),
    localUgoira: Boolean(entry?.ugoira),
    downloading: state.downloading.has(String(record.pid)),
  };
}

async function handleApi(req, res, url) {
  const params = searchParams(url);

  // 列表：支持按来源、关键词、标签筛选
  if (url.startsWith('/api/records')) {
    const source = params.get('source') ?? 'illustPublic';
    const query = (params.get('q') ?? '').trim().toLowerCase();
    const tag = (params.get('tag') ?? '').trim();
    const missingOnly = params.get('missing') === '1';
    const showRemoved = params.get('removed') === '1';
    const offset = Number(params.get('offset') ?? 0);
    const limit = Math.min(Number(params.get('limit') ?? 120), 500);

    let list = state.records.filter((r) => r.source === source);
    if (!showRemoved) list = list.filter((r) => r.removed !== 'yes');
    if (query) {
      list = list.filter(
        (r) =>
          String(r.title ?? '').toLowerCase().includes(query) ||
          String(r.author ?? '').toLowerCase().includes(query) ||
          String(r.pid ?? '').includes(query),
      );
    }
    if (tag) {
      list = list.filter((r) => (r.bookmark_tags ?? []).includes(tag));
    }
    if (missingOnly) {
      list = list.filter((r) => {
        const entry = state.imageIndex.get(String(r.pid));
        return !entry || (entry.pages.size === 0 && !entry.ugoira && !entry.novel);
      });
    }

    const total = list.length;
    const page = list.slice(offset, offset + limit).map(decorate);
    return sendJson(res, 200, { total, offset, limit, items: page });
  }

  if (url.startsWith('/api/state')) {
    return sendJson(res, 200, {
      sources: SOURCES.map((s) => ({
        key: s.key,
        label: s.label,
        count: state.bySource.get(s.key) ?? 0,
      })),
      downloaded: state.imageIndex.size,
      records: state.records.length,
    });
  }

  // 当前来源用到的收藏标签及数量，用于筛选下拉
  if (url.startsWith('/api/tags')) {
    const source = params.get('source') ?? 'illustPublic';
    const counter = new Map();
    for (const record of state.records) {
      if (record.source !== source) continue;
      for (const tag of record.bookmark_tags ?? []) {
        counter.set(tag, (counter.get(tag) ?? 0) + 1);
      }
    }
    const list = [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }));
    return sendJson(res, 200, { tags: list });
  }

  // 按需下载：本地没有时由前端触发
  if (url.startsWith('/api/download') && req.method === 'POST') {
    const body = await readBody(req);
    const pid = String(body.pid ?? '');
    if (!pid) return sendJson(res, 400, { error: '缺少 pid' });

    if (state.downloading.has(pid)) {
      return sendJson(res, 202, { status: 'already-running' });
    }

    const record = state.records.find((r) => String(r.pid) === pid);
    if (!record) return sendJson(res, 404, { error: '记录不存在' });
    if (record.status === 'unavailable') {
      return sendJson(res, 400, { error: '作品已失效，无法下载' });
    }

    state.downloading.add(pid);
    try {
      const summary = await downloadRecords(state.client, {
        records: [record],
        outDir: IMAGES_DIR,
        quality: state.config?.download?.avifQuality ?? 50,
        keepOriginal: false,
        dryRun: false,
        imageLimiter: state.imageLimiter,
        proxy: state.config?.proxy,
      });
      await refreshIndex();

      if (summary.failed > 0) {
        return sendJson(res, 502, { error: summary.errors[0]?.message ?? '下载失败' });
      }
      return sendJson(res, 200, {
        status: 'ok',
        files: summary.files,
        bytes: summary.finalBytes,
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    } finally {
      state.downloading.delete(pid);
    }
  }

  return sendJson(res, 404, { error: 'unknown api' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function serveImage(req, res, url, kind) {
  const match = url.match(/^\/api\/(thumb|full)\/(\d+)\/(\d+)/);
  if (!match) return sendJson(res, 400, { error: 'bad image path' });

  const [, , pid, pageText] = match;
  const page = Number(pageText);

  if (kind === 'thumb') {
    try {
      const thumb = await ensureThumb(pid, page);
      if (!thumb) return sendJson(res, 404, { error: '尚无原图' });
      return sendFile(res, thumb, 'image/jpeg', 'public, max-age=604800');
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  const original = path.join(IMAGES_DIR, `${pid}_p${page}.avif`);
  if (!fs.existsSync(original)) return sendJson(res, 404, { error: '尚未下载' });
  return sendFile(res, original, 'image/avif', 'public, max-age=604800');
}

function serveStatic(req, res, url) {
  const clean = url.split('?')[0];
  const name = clean === '/' ? 'index.html' : clean.slice(1);

  // 白名单 + 防穿越：只允许 viewer 目录下的纯文件名
  if (!/^[\w.-]+$/.test(name)) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }

  const filePath = path.join(VIEWER_DIR, name);
  if (!filePath.startsWith(VIEWER_DIR + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  const ext = path.extname(name).toLowerCase();
  sendFile(res, filePath, CONTENT_TYPES[ext] ?? 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url ?? '/';

    if (url.startsWith('/api/thumb/') || url.startsWith('/api/full/')) {
      const kind = url.startsWith('/api/thumb/') ? 'thumb' : 'full';
      return await serveImage(req, res, url, kind);
    }

    if (url.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    return serveStatic(req, res, url);
  } catch (err) {
    console.error('请求处理失败:', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
});

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`服务已启动: http://127.0.0.1:${port}`);
    if (!process.argv.includes('--no-open')) openBrowser(`http://127.0.0.1:${port}`);
  });
}

function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((p) => fs.existsSync(p));
}

/** 用 Edge 的 --app 模式打开：没有地址栏和标签页，看着就是个独立程序。 */
function openBrowser(url) {
  const edge = findEdge();
  if (!edge) {
    console.log(`没找到 Edge，请手动打开 ${url}`);
    return;
  }
  spawn(edge, [`--app=${url}`, '--window-size=1500,950'], { detached: true, stdio: 'ignore' }).unref();
  console.log('已在应用窗口中打开。');
}

async function main() {
  await fsp.mkdir(THUMB_DIR, { recursive: true });

  state.config = await loadConfig();
  await loadRecords();
  await refreshIndex();

  const cookieFile = path.join(ROOT, state.config.cookieFile ?? '.secrets/cookies.txt');
  let cookie = state.config.cookie ?? '';
  if (!cookie && fs.existsSync(cookieFile)) cookie = (await fsp.readFile(cookieFile, 'utf8')).trim();

  state.client = new PixivClient({
    cookie,
    proxy: state.config.proxy,
    limiter: new RateLimiter(state.config.intervalMs ?? 2000),
    userId: state.config.userId,
  });
  state.imageLimiter = new RateLimiter(state.config.download?.imageIntervalMs ?? 1000);

  console.log(`已加载 ${state.records.length} 条记录，${state.imageIndex.size} 个作品已下载。`);
  listen(BASE_PORT);
}

main().catch((err) => {
  console.error('初始化失败:', err);
  process.exit(1);
});

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
import { downloadRecords, downloadSinglePage } from '../src/download.mjs';
import { PixivClient } from '../src/pixiv.mjs';
import { RateLimiter } from '../src/http.mjs';
import { compileQuery, matches as matchQuery } from './query.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'images');
// 队列连续下载时复用同一个临时目录，由服务端负责生命周期
const TMP_DIR = path.join(IMAGES_DIR, '.tmp');
const THUMB_DIR = path.join(ROOT, 'viewer', '.thumbs');
const VIEWER_DIR = path.join(ROOT, 'viewer');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const BASE_PORT = 7788;

/**
 * 判定「文件是否为可用图片」的快速门槛。
 *
 * 实测很反直觉：一张 64×64 的纯色 AVIF 只有 300 字节。收藏里存在像素画、纯色图这类
 * 极小作品，阈值一旦设成几百字节就会把它们误判成损坏、反复重下。
 * 所以这里压到 64 字节，只拦「0 字节」和「写了一半就断」这种明显情况；
 * 真正的判定交给 magick identify -ping（见 /api/verify）。
 */
const MIN_VALID_BYTES = 64;

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
  client: null,
  imageLimiter: null,
  config: null,
};

/**
 * 下载队列。
 *
 * 前端滚动时会把「视口内且未下载」的作品扔进来，这里串行处理。串行是必须的：
 * 下载本身已经带着 2 秒接口限速和 1 秒图片限速，并发只会让两边互相抢配额。
 *
 * `queued` 是去重的关键 —— 它同时覆盖「排队中」和「正在下载」，前端即使重复提交
 * 同一个 pid 也只会被接受一次。
 */
const queue = {
  pending: [],
  queued: new Set(),
  active: null,
  done: new Set(),
  failed: new Map(),
  running: false,
  processed: 0,
  pageCount: new Map(), // pid -> 页数，用于让短作品先下
};

/**
 * 自动队列单作品的页数上限。
 *
 * 只下首张之后这个限制其实已经用不上了（每个作品固定 1 页），
 * 保留常量只是为了 /api/enqueue 的 skip 语义有地方可调。
 */
const AUTO_MAX_PAGES = 0; // 0 = 不限制

async function loadConfig() {
  try {
    return JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** 文件存在且不算明显损坏。只做大小判断，不碰内容（内容校验见 verify 流程）。 */
async function isFileUsable(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.size >= MIN_VALID_BYTES;
  } catch {
    return false;
  }
}

/** 分批并发 stat，避免 1.5 万个文件同时打开句柄。 */
async function statMany(dir, names, batchSize = 200) {
  const results = [];
  for (let i = 0; i < names.length; i += batchSize) {
    const slice = names.slice(i, i + batchSize);
    const stats = await Promise.all(
      slice.map(async (name) => {
        try {
          const stat = await fsp.stat(path.join(dir, name));
          return { name, size: stat.size };
        } catch {
          return { name, size: 0 };
        }
      }),
    );
    results.push(...stats);
  }
  return results;
}

/** 扫描 images/ 目录，建立 pid -> 已下载文件 的索引。明显损坏的文件当未下载处理。 */
async function scanImages() {
  const index = new Map();
  let names = [];
  try {
    names = await fsp.readdir(IMAGES_DIR);
  } catch {
    return index;
  }

  const stats = await statMany(IMAGES_DIR, names);

  for (const { name, size } of stats) {
    if (size < MIN_VALID_BYTES) continue; // 0 字节或截断，视为没下载

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

/** 把刚下载的文件登记进索引，避免每下完一个就重扫整个 images 目录。 */
function indexDownloadedFiles(files) {
  for (const file of files) {
    const name = path.basename(file);

    const pageMatch = name.match(/^(\d+)_p(\d+)\.avif$/);
    if (pageMatch) {
      const pid = pageMatch[1];
      const entry = state.imageIndex.get(pid) ?? { pages: new Set(), ugoira: false };
      entry.pages.add(Number(pageMatch[2]));
      state.imageIndex.set(pid, entry);
      continue;
    }

    const ugoiraMatch = name.match(/^(\d+)_ugoira\.zip$/);
    if (ugoiraMatch) {
      const pid = ugoiraMatch[1];
      const entry = state.imageIndex.get(pid) ?? { pages: new Set(), ugoira: false };
      entry.ugoira = true;
      state.imageIndex.set(pid, entry);
      continue;
    }

    const novelMatch = name.match(/^(\d+)\.txt$/);
    if (novelMatch) {
      const pid = novelMatch[1];
      const entry = state.imageIndex.get(pid) ?? { pages: new Set(), ugoira: false };
      entry.novel = true;
      state.imageIndex.set(pid, entry);
    }
  }
}

async function downloadByPid(pid) {
  const key = String(pid);
  const record = state.records.find((r) => String(r.pid) === key);
  if (!record) throw new Error('记录不存在');
  if (record.status === 'unavailable') throw new Error('作品已失效');
  if (state.imageIndex.has(key)) return { skipped: true, files: 0 };

  const summary = await downloadRecords(state.client, {
    records: [record],
    outDir: IMAGES_DIR,
    quality: state.config?.download?.avifQuality ?? 50,
    keepOriginal: false,
    dryRun: false,
    imageLimiter: state.imageLimiter,
    proxy: state.config?.proxy,
    // 复用同一个临时目录，队列连续下载时不反复建删
    tempDir: TMP_DIR,
    // 网格只用第一页当缩略图，其余页等用户翻到大图时再取
    firstPageOnly: true,
  });

  if (summary.failed > 0) {
    throw new Error(summary.errors[0]?.message ?? '下载失败');
  }
  indexDownloadedFiles(summary.filePaths ?? []);
  return summary;
}

/**
 * 确保某一页在本地存在，没有就现下。
 *
 * 供大图翻页用：默认只下首张，翻到第 N 页时才走这里补那一页。
 */
async function ensurePage(pid, page) {
  const target = path.join(IMAGES_DIR, `${pid}_p${page}.avif`);
  if (await isFileUsable(target)) return target;

  const key = String(pid);
  const record = state.records.find((r) => String(r.pid) === key);
  if (!record) return null;
  if (record.status === 'unavailable') return null;
  if (record.type === 'novel' || record.type === 'ugoira') return null;

  // 同一页的并发请求合并
  const jobKey = `page:${key}:${page}`;
  if (state.thumbJobs.has(jobKey)) return state.thumbJobs.get(jobKey);

  const job = (async () => {
    await downloadSinglePage(state.client, {
      pid: key,
      page,
      outDir: IMAGES_DIR,
      tmpDir: TMP_DIR,
      imageLimiter: state.imageLimiter,
      proxy: state.config?.proxy,
      quality: state.config?.download?.avifQuality ?? 50,
    });

    const entry = state.imageIndex.get(key) ?? { pages: new Set(), ugoira: false };
    entry.pages.add(page);
    state.imageIndex.set(key, entry);

    return target;
  })().finally(() => state.thumbJobs.delete(jobKey));

  state.thumbJobs.set(jobKey, job);
  return job;
}

function queueSnapshot() {
  return {
    pending: queue.pending.length,
    active: queue.active,
    running: queue.running,
    processed: queue.processed,
    doneCount: queue.done.size,
    failedCount: queue.failed.size,
    // 只回传近期的，够前端把卡片状态对上就行
    doneList: [...queue.done].slice(-300),
    failedList: [...queue.failed.entries()].slice(-50),
  };
}

/**
 * 把一批 pid 塞进队列。
 *
 * 去重靠三层：`queued`（排队+进行中）、`done`、`failed`。任一命中就跳过，
 * 所以前端反复提交同一批 pid 也不会重复下载。
 *
 * `manual: true` 用于用户主动点击 —— 那种情况不下页数限制，也插到队首优先处理。
 */
function enqueue(pids, { manual = false } = {}) {
  let added = 0;
  let skippedLarge = 0;

  for (const raw of pids) {
    const pid = String(raw ?? '');
    if (!pid) continue;
    if (queue.queued.has(pid) || queue.done.has(pid) || queue.failed.has(pid)) continue;

    const record = state.records.find((r) => String(r.pid) === pid);
    if (!record) continue;
    if (record.status === 'unavailable') {
      queue.failed.set(pid, '作品已失效');
      continue;
    }
    if (state.imageIndex.has(pid)) continue;

    const pageCount = Number(record.pages) || 0;
    if (AUTO_MAX_PAGES > 0 && !manual && pageCount > AUTO_MAX_PAGES) {
      // 不入队、也不记失败：卡片保持「点击下载」，用户可以自己决定要不要下
      skippedLarge += 1;
      continue;
    }

    queue.queued.add(pid);
    queue.pageCount.set(pid, pageCount);
    if (manual) queue.pending.unshift(pid);
    else queue.pending.push(pid);
    added += 1;
  }

  // 短作品优先：让用户尽快看到更多图，而不是被一个大合集堵住
  if (added > 0 && !manual) {
    queue.pending.sort((a, b) => (queue.pageCount.get(a) ?? 0) - (queue.pageCount.get(b) ?? 0));
    runQueue();
  } else if (added > 0) {
    runQueue();
  }

  return { added, skippedLarge };
}

async function runQueue() {
  if (queue.running) return;
  queue.running = true;

  while (queue.pending.length > 0) {
    const pid = queue.pending.shift();
    queue.active = pid;

    try {
      await downloadByPid(pid);
      queue.done.add(pid);
    } catch (err) {
      queue.failed.set(pid, err.message);
    } finally {
      queue.queued.delete(pid);
      queue.active = null;
      queue.processed += 1;
    }
  }

  queue.running = false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 全量完整性校验。
 *
 * 用 `magick identify -ping` 只读文件头，不解像素，比真正解码快得多。
 * 发现坏文件就从索引里摘掉 —— 下次浏览时它会被当作「未下载」重新排队。
 *
 * 1.5 万个文件要跑十几分钟，所以只在用户手动触发时执行。
 */
const verifyState = {
  running: false,
  checked: 0,
  total: 0,
  broken: [],
  startedAt: null,
  finishedAt: null,
};

async function runVerify() {
  if (verifyState.running) return;

  verifyState.running = true;
  verifyState.checked = 0;
  verifyState.broken = [];
  verifyState.startedAt = new Date().toISOString();
  verifyState.finishedAt = null;

  let names = [];
  try {
    names = await fsp.readdir(IMAGES_DIR);
  } catch {
    verifyState.running = false;
    return;
  }

  const targets = names.filter((name) => /^\d+_p\d+\.avif$/.test(name));
  verifyState.total = targets.length;

  for (const name of targets) {
    const filePath = path.join(IMAGES_DIR, name);
    try {
      await runProcess('magick', ['identify', '-ping', filePath]);
    } catch {
      verifyState.broken.push(name);
      const match = name.match(/^(\d+)_p(\d+)\.avif$/);
      if (match) {
        const entry = state.imageIndex.get(match[1]);
        if (entry) {
          entry.pages.delete(Number(match[2]));
          if (entry.pages.size === 0 && !entry.ugoira && !entry.novel) {
            state.imageIndex.delete(match[1]);
          }
        }
      }
    }
    verifyState.checked += 1;
  }

  verifyState.running = false;
  verifyState.finishedAt = new Date().toISOString();
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

/** 确定性 PRNG，用于「随机排序」——同一个种子必须每次洗出同样的顺序，否则翻页会重复。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(list, seed) {
  const rand = mulberry32(seed);
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 排序。id 是收藏序号，升序 = 最早收藏在前。
 * 随机排序必须带种子，否则分页请求之间顺序会变，出现重复和漏项。
 */
function orderRecords(list, sort, seed) {
  if (sort === 'desc') return list.slice().sort((a, b) => Number(b.id) - Number(a.id));
  if (sort === 'random') return seededShuffle(list, seed);
  return list.slice().sort((a, b) => Number(a.id) - Number(b.id));
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
    author_id: record.author_id ?? '',
    published: record.published ?? '',
    pages: record.pages ?? '',
    width: record.width ?? '',
    height: record.height ?? '',
    x_restrict: record.x_restrict ?? 0,
    ai_type: record.ai_type ?? 0,
    tags: record.tags ?? [],
    bookmark_tags: record.bookmark_tags ?? [],
    status: record.status ?? '',
    removed: record.removed ?? '',
    url: record.url ?? '',
    source: record.source,
    hasImage: pages.length > 0 || Boolean(entry?.ugoira),
    localPages: pages,
    localNovel: Boolean(entry?.novel),
    localUgoira: Boolean(entry?.ugoira),
    downloading: queue.queued.has(String(record.pid)),
  };
}

async function handleApi(req, res, url) {
  const params = searchParams(url);

  // 列表：支持按来源、布尔查询、标签、作者、缺图筛选，以及三种排序
  if (url.startsWith('/api/records')) {
    const source = params.get('source') ?? 'illustPublic';
    const queryText = (params.get('q') ?? '').trim();
    const tag = (params.get('tag') ?? '').trim();
    const authorId = (params.get('author_id') ?? '').trim();
    const missingOnly = params.get('missing') === '1';
    const showRemoved = params.get('removed') === '1';
    const sort = params.get('sort') ?? 'asc';
    const seed = Number(params.get('seed') ?? 1) || 1;
    const offset = Number(params.get('offset') ?? 0);
    const limit = Math.min(Number(params.get('limit') ?? 120), 500);

    let list = state.records.filter((r) => r.source === source);
    if (!showRemoved) list = list.filter((r) => r.removed !== 'yes');

    if (queryText) {
      const ast = compileQuery(queryText);
      if (ast) list = list.filter((r) => matchQuery(ast, r));
    }

    if (tag) list = list.filter((r) => (r.bookmark_tags ?? []).includes(tag));
    if (authorId) list = list.filter((r) => String(r.author_id ?? '') === authorId);

    if (missingOnly) {
      list = list.filter((r) => {
        const entry = state.imageIndex.get(String(r.pid));
        return !entry || (entry.pages.size === 0 && !entry.ugoira && !entry.novel);
      });
    }

    list = orderRecords(list, sort, seed);

    const total = list.length;
    const page = list.slice(offset, offset + limit).map(decorate);
    return sendJson(res, 200, { total, offset, limit, items: page });
  }

  // 作者聚合：默认按收藏作品数降序
  if (url.startsWith('/api/authors')) {
    const source = params.get('source');
    const queryText = (params.get('q') ?? '').trim();
    const ast = queryText ? compileQuery(queryText) : null;

    const map = new Map();

    for (const record of state.records) {
      if (source && record.source !== source) continue;
      if (record.removed === 'yes') continue;
      if (ast && !matchQuery(ast, record)) continue;
      if (record.status === 'unavailable') continue;

      const key = String(record.author_id || record.author || '未知');
      let entry = map.get(key);
      if (!entry) {
        entry = { author_id: key, name: record.author || '未知', count: 0, done: 0, sources: new Set() };
        map.set(key, entry);
      }
      entry.count += 1;
      entry.sources.add(record.source);
      if (state.imageIndex.has(String(record.pid))) entry.done += 1;
    }

    const authors = [...map.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map((item) => ({ ...item, sources: [...item.sources] }));

    return sendJson(res, 200, { total: authors.length, authors });
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

  // 批量入队：前端滚动时把视口内未下载的作品扔进来
  if (url.startsWith('/api/enqueue') && req.method === 'POST') {
    const body = await readBody(req);
    const pids = Array.isArray(body.pids) ? body.pids : [];
    if (pids.length === 0) return sendJson(res, 400, { error: '缺少 pids' });
    if (pids.length > 500) return sendJson(res, 400, { error: '一次最多 500 个' });

    const { added, skippedLarge } = enqueue(pids);
    return sendJson(res, 200, { added, skippedLarge, queue: queueSnapshot() });
  }

  // 队列状态：前端轮询这个来更新卡片
  if (url.startsWith('/api/queue/clear')) {
    const cleared = queue.pending.length;
    for (const pid of queue.pending) {
      queue.queued.delete(pid);
      queue.pageCount.delete(pid);
    }
    queue.pending = [];
    return sendJson(res, 200, { cleared, queue: queueSnapshot() });
  }

  if (url.startsWith('/api/queue')) {
    return sendJson(res, 200, queueSnapshot());
  }

  // 统计：给下载管理器用的总览
  if (url.startsWith('/api/stats')) {
    const sources = SOURCES.map((source) => {
      let total = 0;
      let done = 0;
      let removed = 0;
      let unavailable = 0;
      for (const record of state.records) {
        if (record.source !== source.key) continue;
        total += 1;
        if (record.removed === 'yes') {
          removed += 1;
          continue;
        }
        if (record.status === 'unavailable') {
          unavailable += 1;
          continue;
        }
        if (state.imageIndex.has(String(record.pid))) done += 1;
      }
      return {
        key: source.key,
        label: source.label,
        total,
        done,
        removed,
        unavailable,
        missing: total - done - removed - unavailable,
      };
    });

    return sendJson(res, 200, {
      sources,
      queue: queueSnapshot(),
      verify: verifyState,
      records: state.records.length,
      downloaded: state.imageIndex.size,
    });
  }

  // 把「所有还没下载的」一次性塞进队列
  if (url.startsWith('/api/enqueue-all')) {
    const source = params.get('source');
    const pids = [];

    for (const record of state.records) {
      if (source && record.source !== source) continue;
      if (record.removed === 'yes') continue;
      if (record.status === 'unavailable') continue;
      if (record.type === 'novel') continue; // 小说没有图片，不参与图片批量下载
      if (state.imageIndex.has(String(record.pid))) continue;
      pids.push(record.pid);
    }

    const { added } = enqueue(pids);
    return sendJson(res, 200, { candidates: pids.length, added, queue: queueSnapshot() });
  }

  // 手动触发全量完整性校验
  if (url.startsWith('/api/verify')) {
    if (!verifyState.running) runVerify();
    return sendJson(res, 202, verifyState);
  }

  // 单个下载（点开大图时用）：入队后阻塞等待它完成，避免和自动队列抢同一份配额
  if (url.startsWith('/api/download') && req.method === 'POST') {
    const body = await readBody(req);
    const pid = String(body.pid ?? '');
    if (!pid) return sendJson(res, 400, { error: '缺少 pid' });

    const record = state.records.find((r) => String(r.pid) === pid);
    if (!record) return sendJson(res, 404, { error: '记录不存在' });
    if (record.status === 'unavailable') {
      return sendJson(res, 400, { error: '作品已失效，无法下载' });
    }

    if (state.imageIndex.has(pid)) {
      return sendJson(res, 200, { status: 'already', files: 0 });
    }

    enqueue([pid], { manual: true });

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (queue.done.has(pid)) {
        const entry = state.imageIndex.get(pid);
        return sendJson(res, 200, {
          status: 'ok',
          files: entry ? entry.pages.size || 1 : 1,
        });
      }
      if (queue.failed.has(pid)) {
        return sendJson(res, 502, { error: queue.failed.get(pid) });
      }
      await sleep(250);
    }

    return sendJson(res, 504, { error: '下载超时，已转入后台队列继续' });
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

  // 大图：本地没有就现下这一页（默认只下首张，翻页时才补）
  try {
    const original = await ensurePage(pid, page);
    if (!original) return sendJson(res, 404, { error: '这一页拿不到（作品已失效或页数不存在）' });
    return sendFile(res, original, 'image/avif', 'public, max-age=604800');
  } catch (err) {
    return sendJson(res, 502, { error: err.message });
  }
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
  await fsp.mkdir(TMP_DIR, { recursive: true });

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

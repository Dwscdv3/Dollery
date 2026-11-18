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
import { RateLimiter, httpsGetWithRetry } from '../src/http.mjs';
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
  const hasImage = state.imageIndex.has(key);

  // 图片已下载时不再重复下，但简介可能还缺，所以仍然要走一遍下面的简介抓取
  if (hasImage) {
    try {
      await ensureDescription(key);
    } catch {
      /* 简介失败不影响结果 */
    }
    return { skipped: true, files: 0, filePaths: [] };
  }

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

  // 下载完立刻把缩略图各档都生成好并永久保存，之后浏览不再触发转换
  for (const file of summary.filePaths ?? []) {
    const match = path.basename(file).match(/^(\d+)_p(\d+)\.avif$/);
    if (match) await generateThumbLevels(match[1], Number(match[2]));
  }

  // 批量下载时顺带把简介也补上，省得以后逐个打开才抓
  try {
    await ensureDescription(key);
  } catch {
    /* 简介失败不影响图片下载 */
  }

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

    await generateThumbLevels(key, page);

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
    // 图片和简介都齐了才算「已完成」，只缺简介也要入队
    const hasImage = state.imageIndex.has(pid);
    const hasDesc = Boolean(record.description) || descCache.has(pid) || record.type === 'novel';
    if (hasImage && hasDesc) continue;

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

/**
 * 缩略图级别。下载时就把 256 / 512 两档生成好并永久保存；
 * 请求时按目标宽度挑不小于它的最小级别，都不够就直接给原图（原图是最高层级）。
 *
 * 关键是按**短边**缩放（`256x256^`）：网格用的是 object-fit: cover，
 * 只保证长边够大时短边会被放大而发虚，所以要让短边达到目标尺寸。
 * 文件名带 `s` 后缀标记新算法，旧缓存自然失效、按需重建。
 */
const THUMB_SIZES = [256, 512];

async function ensureThumbSize(pid, page, size) {
  const target = path.join(THUMB_DIR, `${pid}_p${page}_${size}s.jpg`);
  if (fs.existsSync(target)) return target;

  const source = path.join(IMAGES_DIR, `${pid}_p${page}.avif`);
  if (!fs.existsSync(source)) return null;

  const jobKey = `${pid}_${page}_${size}s`;
  if (state.thumbJobs.has(jobKey)) return state.thumbJobs.get(jobKey);

  const job = withThumbSlot(async () => {
    await fsp.mkdir(THUMB_DIR, { recursive: true });
    // ^ 表示「填满」：短边缩到 size，长边按比例更大
    await runProcess('magick', [source, '-thumbnail', `${size}x${size}^`, '-quality', '82', target]);
    return target;
  }).finally(() => state.thumbJobs.delete(jobKey));

  state.thumbJobs.set(jobKey, job);
  return job;
}

/** 把一张图的所有级别都生成好。下载完成后调用，这样后续请求全部命中缓存。 */
async function generateThumbLevels(pid, page) {
  for (const size of THUMB_SIZES) {
    try {
      await ensureThumbSize(pid, page, size);
    } catch {
      /* 单档失败不影响其他档 */
    }
  }
}

/** 按目标宽度选级别；都不够就退回原图。 */
async function pickThumb(pid, page, wantWidth) {
  for (const size of THUMB_SIZES) {
    if (size < wantWidth) continue;
    const got = await ensureThumbSize(pid, page, size);
    if (got) return { filePath: got, contentType: 'image/jpeg' };
  }

  const original = path.join(IMAGES_DIR, `${pid}_p${page}.avif`);
  if (fs.existsSync(original)) return { filePath: original, contentType: 'image/avif' };
  return null;
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

/** 确保小说正文和封面在本地，缺就现抓。封面来自详情接口的 coverUrl。 */
async function ensureNovel(pid) {
  const key = String(pid);
  const txtPath = path.join(IMAGES_DIR, `${key}.txt`);
  const coverPath = path.join(IMAGES_DIR, `${key}_cover.jpg`);
  const needText = !fs.existsSync(txtPath);
  const needCover = !fs.existsSync(coverPath);

  // 正文和封面都可能单独缺失（老数据只有 txt），所以按需取详情
  if (needText || needCover) {
    const body = await state.client.ajax(`/ajax/novel/${key}`, { lang: 'zh' });

    if (needText) {
      const content = body.content ?? '';
      const wordCount = body.textCount || content.replace(/\s/g, '').length;

      const header = [
        `# ${body.title ?? ''}`,
        `# 作者: ${body.userName ?? ''}`,
        `# 作品: https://www.pixiv.net/novel/show.php?id=${key}`,
        `# 字数: ${wordCount}`,
        '',
      ].join('\n');

      await fsp.writeFile(txtPath, `${header}${content}\n`, 'utf8');

      const entry = state.imageIndex.get(key) ?? { pages: new Set(), ugoira: false };
      entry.novel = true;
      state.imageIndex.set(key, entry);
    }

    if (needCover && body.coverUrl) {
      try {
        const res = await state.imageLimiter.run(() =>
          httpsGetWithRetry(body.coverUrl, {
            proxy: state.config?.proxy,
            binary: true,
            timeoutMs: 60000,
            headers: { Referer: 'https://www.pixiv.net/', 'User-Agent': 'Mozilla/5.0' },
          }),
        );
        if (res.status === 200) await fsp.writeFile(coverPath, res.buffer);
      } catch {
        /* 封面失败不影响阅读 */
      }
    }
  }

  return { txtPath, coverPath };
}

/**
 * 简介（description）只能从详情接口拿。
 *
 * 收藏列表接口虽然也带 description 字段，但实测前 100 条里只有 3 条非空，
 * 而且都是失效作品的 "-----" 占位符。真正的简介在 /ajax/illust/{pid} 里。
 *
 * 逐个补全要 1.5 万次请求（约 8.5 小时），所以改成按需：你打开哪个作品才抓哪个，
 * 结果存进 .cache/descriptions.json，下次直接命中。
 */
const DESC_CACHE = path.join(ROOT, '.cache', 'descriptions.json');
let descCache = new Map();
let descSaveTimer = null;

async function loadDescCache() {
  try {
    descCache = new Map(Object.entries(JSON.parse(await fsp.readFile(DESC_CACHE, 'utf8'))));
  } catch {
    descCache = new Map();
  }
}

function scheduleDescSave() {
  if (descSaveTimer) return;
  descSaveTimer = setTimeout(async () => {
    descSaveTimer = null;
    try {
      await fsp.mkdir(path.dirname(DESC_CACHE), { recursive: true });
      await fsp.writeFile(DESC_CACHE, JSON.stringify(Object.fromEntries(descCache)), 'utf8');
    } catch {
      /* 缓存写失败不影响阅读 */
    }
  }, 2000);
}

/** 简介里可能带 <br> 和 <a>，转成纯文本再给前端。 */
function cleanDescription(raw) {
  return String(raw ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function ensureDescription(pid) {
  const key = String(pid);
  if (descCache.has(key)) return descCache.get(key);

  const record = state.records.find((r) => String(r.pid) === key);
  if (!record) return '';

  // 小说和部分作品的简介在同步时就拿到了，不用再请求
  if (record.description) {
    descCache.set(key, record.description);
    return record.description;
  }

  // 详情接口只对插画有效；小说走 /ajax/novel（正文那边已经带了）
  if (record.type === 'novel') return '';
  if (record.status === 'unavailable') return '';

  const body = await state.client.ajax(`/ajax/illust/${key}`, { lang: 'zh' });
  const text = cleanDescription(body.illustComment ?? body.description ?? '');

  descCache.set(key, text);
  scheduleDescSave();
  record.description = text;

  return text;
}

/** 把缓存里的简介回填进内存记录，重启后也能直接显示。 */
function applyDescCache() {
  let filled = 0;
  for (const record of state.records) {
    if (record.description) continue;
    const cached = descCache.get(String(record.pid));
    if (cached) {
      record.description = cached;
      filled += 1;
    }
  }
  return filled;
}

/** 作者头像：按需拉一次，存到 .thumbs/avatar-{uid}.jpg 永久复用。 */
async function ensureAvatar(uid) {
  const key = String(uid);
  if (!/^\d+$/.test(key)) return null;

  const target = path.join(THUMB_DIR, `avatar-${key}.jpg`);
  if (fs.existsSync(target)) return target;

  const jobKey = `avatar:${key}`;
  if (state.thumbJobs.has(jobKey)) return state.thumbJobs.get(jobKey);

  const job = withThumbSlot(async () => {
    const body = await state.client.ajax(`/ajax/user/${key}`, { lang: 'zh' });
    const url = body.imageBig ?? body.image;
    if (!url) return null;

    const res = await state.imageLimiter.run(() =>
      httpsGetWithRetry(url, {
        proxy: state.config?.proxy,
        binary: true,
        timeoutMs: 30000,
        headers: { Referer: 'https://www.pixiv.net/', 'User-Agent': 'Mozilla/5.0' },
      }),
    );
    if (res.status !== 200) return null;

    await fsp.mkdir(THUMB_DIR, { recursive: true });
    await fsp.writeFile(target, res.buffer);
    return target;
  }).finally(() => state.thumbJobs.delete(jobKey));

  state.thumbJobs.set(jobKey, job);
  return job;
}

/** 拿不到头像时给个灰色人形占位，避免列表里出现破图。 */
function serveFallbackAvatar(res) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" fill="#2b3038"/>' +
    '<circle cx="32" cy="25" r="11" fill="#4a5160"/>' +
    '<ellipse cx="32" cy="58" rx="19" ry="14" fill="#4a5160"/></svg>';
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
  res.end(svg);
}

function decorate(record) {
  const entry = state.imageIndex.get(String(record.pid));
  const pages = entry ? [...entry.pages].sort((a, b) => a - b) : [];
  return {
    id: record.id,
    pid: record.pid,
    type: record.type,
    title: record.title ?? '',
    description: cleanDescription(record.description) === '-----' ? '' : cleanDescription(record.description),
    author: record.author ?? '',
    author_id: record.author_id ?? '',
    published: record.published ?? '',
    pages: record.pages ?? '',
    width: record.width ?? '',
    height: record.height ?? '',
    x_restrict: record.x_restrict ?? 0,
    ai_type: record.ai_type ?? 0,
    text_length: record.text_length ?? '',
    tags: record.tags ?? [],
    bookmark_tags: record.bookmark_tags ?? [],
    status: record.status ?? '',
    removed: record.removed ?? '',
    url: record.url ?? '',
    source: record.source,
    hasImage: pages.length > 0 || Boolean(entry?.ugoira),
    hasCover: record.type === 'novel' ? fs.existsSync(path.join(IMAGES_DIR, `${record.pid}_cover.jpg`)) : false,
    localPages: pages,
    localNovel: Boolean(entry?.novel),
    localUgoira: Boolean(entry?.ugoira),
    downloading: queue.queued.has(String(record.pid)),
  };
}

async function handleApi(req, res, url) {
  const params = searchParams(url);

  // 作者头像
  if (url.startsWith('/api/avatar/')) {
    const uid = url.replace(/^\/api\/avatar\//, '').split('?')[0];
    try {
      const file = await ensureAvatar(uid);
      if (file) return sendFile(res, file, 'image/jpeg', 'public, max-age=86400');
    } catch {
      /* 落到占位图 */
    }
    return serveFallbackAvatar(res);
  }

  // 简介：按需从详情接口补一条
  if (url.startsWith('/api/description/')) {
    const pid = url.replace(/^\/api\/description\//, '').split('?')[0];
    if (!/^\d+$/.test(pid)) return sendJson(res, 400, { error: 'pid 不合法' });
    try {
      const description = await ensureDescription(pid);
      return sendJson(res, 200, { pid, description });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  // 小说正文（缺就现抓，含封面）
  if (url.startsWith('/api/novel/')) {
    const pid = url.replace(/^\/api\/novel\//, '').split('?')[0];
    if (!/^\d+$/.test(pid)) return sendJson(res, 400, { error: 'pid 不合法' });
    try {
      const { txtPath, coverPath } = await ensureNovel(pid);
      const raw = await fsp.readFile(txtPath, 'utf8');
      // 去掉开头那几行 # 抬头，正文单独返回
      const content = raw.replace(/^#[^\n]*\n/gm, '').trim();
      return sendJson(res, 200, { pid, content, cover: fs.existsSync(coverPath) });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  // 封面：小说用抓下来的 jpg，插画退回首图缩略图
  if (url.startsWith('/api/cover/')) {
    const pid = url.replace(/^\/api\/cover\//, '').split('?')[0];
    if (!/^\d+$/.test(pid)) return sendJson(res, 400, { error: 'pid 不合法' });

    const coverPath = path.join(IMAGES_DIR, `${pid}_cover.jpg`);
    if (fs.existsSync(coverPath)) {
      return sendFile(res, coverPath, 'image/jpeg', 'public, max-age=604800');
    }

    const picked = await pickThumb(pid, 0, 512);
    if (picked) return sendFile(res, picked.filePath, picked.contentType, 'public, max-age=604800');
    return sendJson(res, 404, { error: '没有封面' });
  }

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
  // 注意必须精确匹配 —— 用 startsWith 会把 /api/enqueue-all 也拦下来，
  // 导致「一键下载全部」一直报「缺少 pids」
  if ((url === '/api/enqueue' || url.startsWith('/api/enqueue?')) && req.method === 'POST') {
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
      const pid = String(record.pid);
      const hasImg = state.imageIndex.has(pid);
      const hasDesc = Boolean(record.description) || descCache.has(pid);
      if (hasImg && hasDesc) continue;
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
    const wantWidth = Number(searchParams(url).get('w') ?? 0) || 256;
    try {
      const picked = await pickThumb(pid, page, wantWidth);
      if (!picked) return sendJson(res, 404, { error: '尚无原图' });
      return sendFile(res, picked.filePath, picked.contentType, 'public, max-age=604800');
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
  await loadDescCache();
  const filled = applyDescCache();
  if (filled > 0) console.log(`已从缓存回填 ${filled} 条简介。`);

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

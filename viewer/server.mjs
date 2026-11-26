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
import {
  BOOKMARK_TAG_LIMIT,
  BookmarkTagsFullError,
  editBookmark,
  normalizeTags,
  readEditorState,
  setBookmarkRating,
  sourceKeyOf,
} from '../src/bookmark-edit.mjs';
import { RateLimiter, httpsGetWithRetry } from '../src/http.mjs';
import { compileQuery, matches as matchQuery } from './query.mjs';
import { createTagGroupStore } from './tag-groups.mjs';
import { planTagConversion } from '../src/tag-convert.mjs';
import { createGuard, DEFAULT_GUARD } from '../src/guard.mjs';
import { RequestPacer, DEFAULT_PACER } from '../src/pacer.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'images');
// 队列连续下载时复用同一个临时目录，由服务端负责生命周期
const TMP_DIR = path.join(IMAGES_DIR, '.tmp');
const THUMB_DIR = path.join(ROOT, 'viewer', '.thumbs');
const VIEWER_DIR = path.join(ROOT, 'viewer');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const TAG_GROUPS_PATH = path.join(ROOT, 'data', 'tag-groups.json');

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

/** 来源键 → 数据文件的绝对路径。写回本地时用，和读入用的是同一份映射。 */
const DATA_FILES = Object.fromEntries(
  SOURCES.map((source) => [source.key, path.join(ROOT, 'data', source.file)]),
);

// ---- 状态 ----

const state = {
  records: [], // 全部记录，带 source 标记
  bySource: new Map(), // sourceKey -> 记录数
  imageIndex: new Map(), // `${pid}` -> { pages: Set<number>, ugoira: bool }
  thumbJobs: new Map(), // 缩略图生成去重
  client: null,
  imageLimiter: null,
  config: null,
  guard: null, // 防封号守卫，见 src/guard.mjs
  pacer: null, // 请求节奏（随机长休息），见 src/pacer.mjs
  tagGroups: null, // 标签组，见 viewer/tag-groups.mjs
  convert: null, // 正在跑的「组内标签批量转换」任务
};

/**
 * 下载队列。
 *
 * 队列里放的是「任务」，只有一种调度、一套计数：
 *   · 作品任务：{ key: pid, pid, mode }  —— mode=first 只下首张，full 补齐所有页
 *   · 单页任务：{ key: "pid#page", pid, page, resolve, reject }  —— 大图翻页时现取一页
 *
 * 前端滚动时会把「视口内且未下载」的作品扔进来，这里串行处理。串行是必须的：
 * 下载本身已经带着 2 秒接口限速和 1 秒图片限速，并发只会让两边互相抢配额。
 *
 * `queued` 是作品任务的去重表 —— 它同时覆盖「排队中」和「正在下载」，
 * 前端即使重复提交同一个 pid 也只会被接受一次。单页任务按 "pid#page" 去重，
 * 靠 `pageJobs` 里的 Promise 合并同一页的并发请求。
 */
const queue = {
  pending: [], // 任务数组（作品 + 单页），单页任务会被插到队首
  queued: new Map(), // 作品 key(pid) -> 任务
  actives: new Map(), // key -> 任务
  done: new Set(), // 已完成的作品 pid（只记作品，卡片状态要用）
  failed: new Map(), // key -> 错误信息
  running: false,
  processed: 0, // 已完成任务数（作品和单页一起算，不再分两本账）
  pageCount: new Map(), // pid -> 页数，用于让短作品先下
  doneMode: new Map(), // pid -> 完成时的模式，决定还能不能因为「要全页」再入队一次
  pageJobs: new Map(), // "pid#page" -> Promise，同一页的并发请求合并
};

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

/** 按 pid 找内存记录。给了 source 就按来源精确定位 —— 同一个 pid 两边都可能有。 */
function findRecord(pid, source) {
  const key = String(pid);

  if (source) {
    const exact = state.records.find((r) => String(r.pid) === key && r.source === source);
    if (exact) return exact;
  }

  return (
    state.records.find(
      (r) => String(r.pid) === key && r.removed !== 'yes' && r.status !== 'unavailable',
    ) ??
    state.records.find((r) => String(r.pid) === key) ??
    null
  );
}

/** 编辑跨文件搬迁后来源计数会变，重算一遍（只动计数，不重读文件）。 */
function reindexSources() {
  const counts = new Map();
  for (const record of state.records) {
    counts.set(record.source, (counts.get(record.source) ?? 0) + 1);
  }
  state.bySource = counts;
}

/**
 * 收藏编辑的串行闸门。
 *
 * 「写 pixiv → 写本地」不是一个原子操作，两个请求并发跑会互相覆盖
 * 同一个 JSON 文件。这里一次只放一个过去，代价是编辑时要排队，可以接受。
 */
let bookmarkEditTail = Promise.resolve();

function withBookmarkLock(task) {
  const run = bookmarkEditTail.then(task, task);
  bookmarkEditTail = run.then(
    () => {},
    () => {},
  );
  return run;
}

function kindOf(record) {
  return record.type === 'novel' ? 'novel' : 'illust';
}

/**
 * 把写入结果吸收进内存索引，取代原来那条记录。
 * 返回合并后的新对象（界面直接用，不必重新拉列表）。
 */
function absorbEditResult(record, result) {
  const merged = { ...record, ...result.record, source: result.source };
  // 空标签在磁盘上是「删字段」，展开运算不会覆盖旧值，得显式清空
  merged.bookmark_tags = result.record.bookmark_tags ?? [];
  merged.private_bookmark = /Private$/.test(result.source) ? 'yes' : 'no';
  delete merged.removed;

  const index = state.records.indexOf(record);
  if (index >= 0) state.records[index] = merged;
  reindexSources();
  return merged;
}

/* ── 组内标签批量转换 ────────────────────────────────────────
 * 把「同组其它成员标签」统一换成一个目标标签。
 *
 * 几条硬约束：
 *   · 只在当前来源里找作品，只动 bookmark_tags，不碰公开/私密；
 *   · 一条条写，走普通限速通道（fast:false），200 且 error:false 才算成功；
 *   · 每条都过 withBookmarkLock，和手动编辑不会互相覆盖本地文件；
 *   · 连续 3 条都是鉴权 / 限流类错误就停手，免得空转几百次。
 */

const CONVERT_MAX_STREAK = 3;

function convertSnapshot() {
  const job = state.convert;
  if (!job) return null;
  return {
    id: job.id,
    running: job.running,
    source: job.source,
    target: job.target,
    groupId: job.groupId,
    total: job.total,
    done: job.done,
    ok: job.ok,
    failedCount: job.failed.length,
    failed: job.failed.slice(-8),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    aborted: job.aborted,
    stopRequested: job.stopRequested,
  };
}

function startConversion({ source, target, group, items }) {
  const job = {
    id: `c${Date.now().toString(36)}`,
    running: true,
    source,
    target,
    groupId: group.id,
    total: items.length,
    done: 0,
    ok: 0,
    failed: [],
    startedAt: Date.now(),
    finishedAt: null,
    aborted: '',
    stopRequested: false,
  };
  state.convert = job;

  (async () => {
    let streak = 0;

    for (const item of items) {
      if (job.stopRequested) {
        job.aborted = 'stopped';
        break;
      }

      const record = findRecord(item.pid, source);
      if (!record) {
        job.failed.push({ pid: item.pid, error: '本地记录已不存在' });
        job.done += 1;
        continue;
      }

      try {
        const result = await withBookmarkLock(() =>
          editBookmark({
            client: state.client,
            files: DATA_FILES,
            kind: item.kind,
            pid: item.pid,
            tags: item.after,
            isPrivate: item.isPrivate,
            source,
            fast: false,
          }),
        );
        absorbEditResult(record, result);
        job.ok += 1;
        streak = 0;
      } catch (err) {
        job.failed.push({ pid: item.pid, error: err?.message ?? String(err) });
        streak += 1;

        const fatal =
          err?.status === 401 ||
          err?.status === 403 ||
          err?.status === 429 ||
          /登录|cookie|token|未授权|禁止访问/i.test(String(err?.message ?? ''));

        if (streak >= CONVERT_MAX_STREAK && fatal) {
          job.aborted = 'auth';
          break;
        }
      }

      job.done += 1;
    }

    job.running = false;
    job.finishedAt = Date.now();
    console.log(
      `  [转换] 结束：成功 ${job.ok} / 共 ${job.total}，失败 ${job.failed.length}` +
        `${job.aborted ? `（${job.aborted}）` : ''}`,
    );
  })().catch((err) => {
    job.running = false;
    job.finishedAt = Date.now();
    job.aborted = 'error';
    job.failed.push({ pid: '', error: err?.message ?? String(err) });
    console.error('  [转换] 任务异常结束:', err);
  });
}

/**
 * 用系统默认浏览器打开一个链接。
 *
 * 为什么要绕到后端：查看器是用 Edge 的 `--app` 模式跑的，页面里 `window.open`
 * 只会在 Edge 里再开一个无地址栏窗口，而不是用户真正想要的那个浏览器。
 *
 * Windows 走 `rundll32 url.dll,FileProtocolHandler`：它不经过 cmd 解析，
 * URL 里的 `&`、`|` 这些不会被当成命令分隔符（`cmd /c start` 就有这个坑）。
 * 调用方必须先把 URL 限定在 pixiv 域内 —— 这个函数本身不做校验。
 */
function openInDefaultBrowser(target) {
  const options = { detached: true, stdio: 'ignore', windowsHide: true };

  let child;
  if (process.platform === 'win32') {
    child = spawn('rundll32', ['url.dll,FileProtocolHandler', target], options);
  } else if (process.platform === 'darwin') {
    child = spawn('open', [target], options);
  } else {
    child = spawn('xdg-open', [target], options);
  }

  // 系统里没有对应命令时只记一笔，别把服务弄崩
  child.on('error', (err) => {
    process.stderr.write(`打开浏览器失败: ${err.message}\n`);
  });
  child.unref();
}

/** 只允许打开 pixiv 自己的页面，避免这个接口被当成万能命令执行器。 */
function isPixivUrl(raw) {
  try {
    const target = new URL(String(raw));
    return target.protocol === 'https:' && ['www.pixiv.net', 'pixiv.net'].includes(target.hostname);
  } catch {
    return false;
  }
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

/**
 * 下载一个作品。
 *
 * mode 决定下载范围：
 *   first —— 只下首张（滚动时自动触发，省时间和空间）
 *   full  —— 补齐该作品所有缺失的页（点开作品、下载管理里点「全部下载」）
 */
async function downloadByPid(pid, mode = 'full') {
  const key = String(pid);
  const record = state.records.find((r) => String(r.pid) === key);
  if (!record) throw new Error('记录不存在');
  if (record.status === 'unavailable') throw new Error('作品已失效');

  // first：只补首张（滚动触发）；full：补齐所有缺页（点开 / 全部下载）
  const stats = pageStats(record);
  const needPages = mode === 'full' ? stats.have < stats.total : stats.have === 0;

  if (!needPages) {
    await ensureDescription(key).catch(() => {});
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
    // 已存在的页在下载层会自己跳过，所以 full 也是幂等的
    firstPageOnly: mode !== 'full',
  });

  if (summary.failed > 0) {
    throw new Error(summary.errors[0]?.message ?? '下载失败');
  }
  indexDownloadedFiles(summary.filePaths ?? []);

  // 缩略图丢到后台生成，不阻塞队列推进（magick 很吃 CPU，等它会把整条队列拖慢）
  for (const file of summary.filePaths ?? []) {
    const match = path.basename(file).match(/^(\d+)_p(\d+)\.avif$/);
    if (match) void generateThumbLevels(match[1], Number(match[2]));
  }

  // 简介也放后台补，不占用队列的推进节奏
  void ensureDescription(key).catch(() => {});

  return summary;
}

/**
 * 确保某一页在本地存在，没有就现下。
 *
 * 供大图翻页用：默认只下首张，翻到第 N 页时才走这里取那一页。
 * 和作品下载是同一条队列 —— 单页任务插到队首，所以不会被几千个批量任务堵住。
 */
async function ensurePage(pid, page) {
  const target = path.join(IMAGES_DIR, `${pid}_p${page}.avif`);
  if (await isFileUsable(target)) return target;

  const key = String(pid);
  const record = state.records.find((r) => String(r.pid) === key);
  if (!record) return null;
  if (record.status === 'unavailable') return null;
  if (record.type === 'novel' || record.type === 'ugoira') return null;

  return enqueuePage(key, page);
}

/** 入队一个单页任务；同一页的并发请求共享同一个 Promise，不会重复下载。 */
function enqueuePage(pid, page) {
  const jobKey = `${pid}#${page}`;
  const existing = queue.pageJobs.get(jobKey);
  if (existing) return existing;

  const job = new Promise((resolve, reject) => {
    queue.pending.unshift({ key: jobKey, pid, page, resolve, reject });
    runQueue();
  }).finally(() => queue.pageJobs.delete(jobKey));

  queue.pageJobs.set(jobKey, job);
  return job;
}

/** 真正下载一页：落盘 → 更新索引 → 生成缩略图。额度记账交给 worker 统一做。 */
async function downloadPageNow(pid, page) {
  await downloadSinglePage(state.client, {
    pid,
    page,
    outDir: IMAGES_DIR,
    tmpDir: TMP_DIR,
    imageLimiter: state.imageLimiter,
    proxy: state.config?.proxy,
    quality: state.config?.download?.avifQuality ?? 50,
    // 用户就盯着这一页，不等随机休息；其它排队的任务照旧等着
    bypassPacer: true,
  });

  const entry = state.imageIndex.get(pid) ?? { pages: new Set(), ugoira: false };
  entry.pages.add(page);
  state.imageIndex.set(pid, entry);

  await generateThumbLevels(pid, page);

  const filePath = path.join(IMAGES_DIR, `${pid}_p${page}.avif`);
  let bytes = 0;
  try {
    bytes = (await fsp.stat(filePath)).size;
  } catch {
    /* 读不到大小就只记文件数 */
  }
  return { filePath, bytes };
}

/** 所有任务完成后统一记额度，作品和单页不再各记一套。 */
async function bumpQuota({ files = 0, bytes = 0 } = {}) {
  if (!state.guard) return;
  await state.guard.bump({ files: Number(files) || 0, bytes: Number(bytes) || 0 });
}

function queueSnapshot() {
  const actives = [...queue.actives.values()];

  return {
    pending: queue.pending.length,
    active: actives[0]?.pid ?? null,
    activeCount: actives.length,
    // 只回作品 pid：卡片上的「下载中」角标要用，单页任务不算作品在下载
    activeList: [...new Set(actives.filter((t) => t.page === undefined).map((t) => t.pid))],
    running: queue.running,
    processed: queue.processed,
    doneCount: queue.done.size,
    failedCount: queue.failed.size,
    // 只回传近期的，够前端把卡片状态对上就行
    doneList: [...queue.done].slice(-300),
    failedList: [...queue.failed.entries()].slice(-50),
    // 随机休息的倒计时：前端据此显示「还剩 12 分钟」和「立即继续」按钮
    pacer: state.pacer ? state.pacer.status() : null,
  };
}

/**
 * 把一批 pid 塞进队列。
 *
 * 去重靠三层：`queued`（排队+进行中）、`done`、`failed`。但不是一刀切——
 * 还要看「下载范围」：
 *   · 滚动触发的 first 只下首张，一个作品一次就够了；
 *   · 点开作品和「全部下载」要 full（补齐所有页）。
 * 所以一个已经用 first 下过的作品，遇到 full 请求时仍然要再排一次；
 * 反过来 full 下完的作品，再收到 first 请求直接忽略。
 */
function enqueue(pids, { mode = 'first', priority = false } = {}) {
  // 守卫拦着的时候一个都不放行，前端据此显示提示
  if (state.guard) {
    const g = state.guard.status();
    if (g.blocked) return { added: 0, upgraded: 0, blocked: 'guard' };
    if (g.dailyExhausted) return { added: 0, upgraded: 0, blocked: 'daily' };
  }

  const wants = (m) => (m === 'full' ? 'full' : 'first');

  // 某个 pid 是否已经满足了这次请求的范围
  const satisfied = (pid) => {
    if (queue.failed.has(pid)) return true;
    if (!queue.done.has(pid)) return false;
    if (wants(mode) === 'first') return true; // 只下首张，下过一次就够
    return (queue.doneMode.get(pid) ?? 'first') === 'full';
  };

  let added = 0;
  let upgraded = 0;

  for (const raw of pids) {
    const pid = String(raw ?? '');
    if (!pid) continue;

    // 已在队列里：如果这次要得更全，就地升级（正在跑的那个跑完会再看一次）
    const pendingTask = queue.queued.get(pid);
    if (pendingTask) {
      if (wants(mode) === 'full' && pendingTask.mode !== 'full') {
        pendingTask.mode = 'full';
        upgraded += 1;
      }
      continue;
    }

    if (satisfied(pid)) continue;

    // 重新入队意味着它现在算「未完成」—— 之前可能只用 first 下过首张
    queue.done.delete(pid);
    queue.doneMode.delete(pid);

    const record = state.records.find((r) => String(r.pid) === pid);
    if (!record) continue;
    if (record.status === 'unavailable') {
      queue.failed.set(pid, '作品已失效');
      continue;
    }

    const stats = pageStats(record);
    const hasDesc = Boolean(record.description) || descCache.has(pid) || record.type === 'novel';

    if (wants(mode) === 'first') {
      // 只下首张：已经有任意一页就不用再下；但简介缺了仍要走一趟
      if (stats.have > 0 && hasDesc) continue;
    } else if (stats.have >= stats.total && hasDesc) {
      continue;
    }

    const pageCount = Number(record.pages) || 0;
    const task = { key: pid, pid, mode: wants(mode) };

    queue.queued.set(pid, task);
    queue.pageCount.set(pid, pageCount);
    // priority 是「用户点开的这一个」，插到队首；其余一律追加，
    // 避免一次性入队几千个时反复 unshift 变成 O(n²)
    if (priority) queue.pending.unshift(task);
    else queue.pending.push(task);
    added += 1;
  }

  if (added > 0) {
    // 短作品优先：让用户尽快看到更多图，而不是被一个大合集堵住。
    // 单页任务始终留在队首 —— 用户正盯着那一页，不能排到批量任务后面。
    if (!priority) {
      const pages = queue.pending.filter((task) => task.page !== undefined);
      const works = queue.pending.filter((task) => task.page === undefined);
      works.sort((a, b) => (queue.pageCount.get(a.pid) ?? 0) - (queue.pageCount.get(b.pid) ?? 0));
      queue.pending = [...pages, ...works];
    }
    runQueue();
  }

  return { added, upgraded, blocked: null };
}

const QUEUE_CONCURRENCY = 2;

/**
 * 守卫触发后清空待办。已经在跑的几个任务会自然结束，但不会再取新任务。
 */
function stopQueueByGuard(err) {
  const dropped = queue.pending.splice(0);

  // 单页任务的 Promise 必须结掉，否则大图那边的请求会一直挂着等一个不会来的响应
  for (const task of dropped) {
    if (task.page !== undefined) task.reject(err);
  }

  for (const key of [...queue.queued.keys()]) {
    if (queue.actives.has(key)) continue;
    queue.queued.delete(key);
  }

  const headline = String(err.message).split('\n').find((line) => line.trim()) ?? err.message;
  console.warn(`\n[防封号] ${headline.trim()}`);
  if (dropped.length > 0) console.warn(`[防封号] 已清空队列里剩余的 ${dropped.length} 个任务\n`);
}

/** 两个 worker 并行：下载受 1 秒限速约束，但 AVIF 压制是 CPU 活，能重叠起来。 */
async function runQueue() {
  if (queue.running) return;
  queue.running = true;

  try {
    // 队列刚跑空时可能刚好又有新任务进来（比如翻页触发的单页任务），
    // 再兜一圈，避免任务被落在 pending 里没人处理
    do {
      await Promise.all(Array.from({ length: QUEUE_CONCURRENCY }, () => queueWorker()));
    } while (queue.pending.length > 0);
  } finally {
    queue.running = false;
  }
}

/**
 * 队列里只有一种 worker：作品任务和单页任务都在这里跑，
 * 区别只在分派到哪个下载函数，记账、计数、失败处理都走同一段代码。
 */
async function queueWorker() {
  for (;;) {
    const task = queue.pending.shift();
    if (!task) return;

    // 排队期间作品任务可能被升级成 full（用户点开了它），出队时以最新的为准
    const mode = task.mode ?? 'first';
    queue.actives.set(task.key, task);

    try {
      if (task.page !== undefined) {
        const { filePath, bytes } = await downloadPageNow(task.pid, task.page);
        // 先把结果交出去再记账：额度这会儿刚好超了，也不该让已经下好的这一页变破图
        task.resolve(filePath);
        await bumpQuota({ files: 1, bytes });
      } else {
        const summary = await downloadByPid(task.pid, mode);
        queue.done.add(task.pid);
        queue.doneMode.set(task.pid, mode);
        // 记账：真正落盘的文件才算额度，跳过已存在的不算
        await bumpQuota({ files: summary?.files, bytes: summary?.finalBytes });
      }
    } catch (err) {
      if (task.page !== undefined) {
        task.reject(err);
        queue.failed.set(`${task.pid} 第 ${task.page + 1} 页`, err.message);
      } else {
        queue.failed.set(task.pid, err.message);
      }

      // 守卫拦截是「整条队列都要停」，不能只把这个任务记成失败然后接着跑
      if (err?.name === 'GuardTripped' || err?.name === 'DailyLimitReached') {
        stopQueueByGuard(err);
      }
    } finally {
      const upgradedWhileRunning =
        task.page === undefined && task.mode === 'full' && mode === 'first';

      queue.queued.delete(task.key);
      queue.actives.delete(task.key);
      queue.processed += 1;

      // 跑的过程中用户点开了它，但这次只下了首张 —— 再排一次补齐后续页
      if (upgradedWhileRunning) {
        const next = { key: task.pid, pid: task.pid, mode: 'full' };
        queue.queued.set(task.pid, next);
        queue.pending.push(next);
      }
    }
  }
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

/**
 * 一个作品的页数账本。
 *
 * 判断「下没下完」必须按页算而不是按作品算：多页作品只下了首张时，
 * 按作品算会说它已完成，实际上大图翻到第二页还是要现取。
 * 小说和动图各自只有一份产物，按 1 页记。
 */
function pageStats(record) {
  const pid = String(record.pid);
  const entry = state.imageIndex.get(pid);

  if (record.type === 'novel') {
    return { total: 1, have: entry?.novel ? 1 : 0 };
  }
  if (record.type === 'ugoira' || entry?.ugoira) {
    return { total: 1, have: entry?.ugoira ? 1 : 0 };
  }

  const total = Math.max(1, Number(record.pages) || 1);
  const have = entry ? Math.min(entry.pages.size, total) : 0;
  return { total, have };
}

function isComplete(record) {
  const stats = pageStats(record);
  return stats.have >= stats.total;
}

function decorate(record) {
  const entry = state.imageIndex.get(String(record.pid));
  const pages = entry ? [...entry.pages].sort((a, b) => a - b) : [];
  const stats = pageStats(record);
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
    totalPages: stats.total,
    havePages: stats.have,
    complete: stats.have >= stats.total,
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
    // 默认过滤器（f）：与 q 各自编译后 AND，避免 `a OR b` 被外层 AND 改掉优先级
    const filterText = (params.get('f') ?? '').trim();
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

    // 标签组：搜索词命中组员时展开成同义词的 OR
    const groups = state.tagGroups ? state.tagGroups.list() : [];

    if (queryText) {
      const ast = compileQuery(queryText, { groups });
      if (ast) list = list.filter((r) => matchQuery(ast, r));
    }

    if (filterText) {
      const filterAst = compileQuery(filterText, { groups });
      if (filterAst) list = list.filter((r) => matchQuery(filterAst, r));
    }

    if (tag) list = list.filter((r) => (r.bookmark_tags ?? []).includes(tag));
    if (authorId) list = list.filter((r) => String(r.author_id ?? '') === authorId);

    if (missingOnly) {
      // 按页判断：多页作品只下了首张也算「未下载完」
      list = list.filter((r) => !isComplete(r));
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

  // 当前来源用到的标签及数量，用于左栏的标签面板
  // include=1 时把作品本身的标签也算进来；同一作品上的同名标签只计一次，
  // 否则「收藏标签和作品标签重名」会被算成两个作品。
  //
  // 标签组：
  //   · 组内成员按「成员计数之和」排序，并保证挨在一起；
  //   · 组的 union 是去重后的作品数（同一作品打了多个成员标签只算一次），
  //     用来显示；排序仍用 total，两者口径不同，前端会在 title 里注明。
  //   · 两个统计都跟随 include 开关，和单个标签的计数口径一致。
  if (url.startsWith('/api/tags')) {
    const source = params.get('source') ?? 'illustPublic';
    const includeWork = params.get('include') === '1';
    const counter = new Map(); // 原始标签 -> { count, own }
    const byNorm = new Map(); // 归一化标签 -> 次数（处理大小写不一致）
    const groupDocs = state.tagGroups ? state.tagGroups.list() : [];
    const groupSets = new Map(); // 组 id -> Set(pid)

    const norm = (tag) => String(tag ?? '').trim().toLowerCase();

    const groupOfTag = new Map();
    for (const group of groupDocs) {
      groupSets.set(group.id, new Set());
      for (const tag of group.tags) groupOfTag.set(norm(tag), group);
    }

    const bump = (tag, isOwn) => {
      const item = counter.get(tag) ?? { count: 0, own: 0 };
      item.count += 1;
      if (isOwn) item.own += 1;
      counter.set(tag, item);
      const key = norm(tag);
      byNorm.set(key, (byNorm.get(key) ?? 0) + 1);
    };

    for (const record of state.records) {
      if (record.source !== source) continue;

      // 同一作品上的同名标签只算一次；大小写不同视为同一个（和卡片上的去重一致）
      const seen = new Set();
      const pid = String(record.pid ?? '');

      const hit = (tag, isOwn) => {
        bump(tag, isOwn);
        const group = groupOfTag.get(norm(tag));
        if (group) groupSets.get(group.id)?.add(pid);
      };

      for (const tag of record.bookmark_tags ?? []) {
        const key = norm(tag);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        hit(tag, true);
      }

      if (!includeWork) continue;

      for (const tag of record.tags ?? []) {
        const key = norm(tag);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        hit(tag, false);
      }
    }

    const groups = groupDocs
      .map((group) => {
        const members = group.tags.map((tag) => ({
          tag,
          count: byNorm.get(norm(tag)) ?? 0,
        }));
        const total = members.reduce((sum, member) => sum + member.count, 0);
        // 代表名 = 计数最多的成员；并列时取组内靠前的那个（先加入的）
        const representative = members.reduce(
          (best, member) => (member.count > best.count ? member : best),
          members[0],
        );
        return {
          id: group.id,
          tags: [...group.tags],
          members,
          total,
          union: groupSets.get(group.id)?.size ?? 0,
          representative: representative?.tag ?? group.tags[0],
        };
      })
      .sort(
        (a, b) =>
          b.total - a.total || b.union - a.union || a.representative.localeCompare(b.representative, 'zh'),
      );

    const summaryOf = new Map(groups.map((group) => [group.id, group]));

    const list = [...counter.entries()]
      .map(([tag, item]) => {
        const group = groupOfTag.get(norm(tag));
        const summary = group ? summaryOf.get(group.id) : null;
        return {
          tag,
          count: item.count,
          own: item.own,
          groupId: group?.id ?? null,
          group: summary
            ? {
                id: summary.id,
                representative: summary.representative,
                size: summary.tags.length,
                total: summary.total,
                union: summary.union,
              }
            : null,
          // 同组成员共用一个排序键，组内再按自身计数排
          sortKey: summary ? summary.total : item.count,
        };
      })
      .sort((a, b) => {
        if (a.sortKey !== b.sortKey) return b.sortKey - a.sortKey;
        if (a.groupId !== b.groupId) {
          // 成员必须相邻：组间按 id 排，未分组的沉到同分值的后面
          if (!a.groupId) return 1;
          if (!b.groupId) return -1;
          return a.groupId.localeCompare(b.groupId);
        }
        return b.count - a.count || a.tag.localeCompare(b.tag, 'zh');
      });

    return sendJson(res, 200, { tags: list, includeWork, groups });
  }

  /* ── 标签组 ────────────────────────────────────────────────
   * GET 返回当前定义；POST 整体替换（编辑器保存就是一次整体提交）。
   * 校验和归一化都在 tag-groups.mjs 里，这里只负责搬进搬出。
   */
  if (url === '/api/tag-groups' || url.startsWith('/api/tag-groups?')) {
    if (!state.tagGroups) return sendJson(res, 503, { error: '标签组未初始化' });

    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        const result = await state.tagGroups.replace(body.groups ?? []);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    return sendJson(res, 200, { groups: state.tagGroups.list() });
  }

  /* ── 批量转换：启动 / 停止 ────────────────────────────────── */

  // 预览：确认框里要告诉用户会影响多少作品（只算当前来源的收藏标签）
  if (url === '/api/tag-convert/plan' || url.startsWith('/api/tag-convert/plan?')) {
    if (!state.tagGroups) return sendJson(res, 503, { error: '标签组未初始化' });

    const source = params.get('source') ?? 'illustPublic';
    const target = (params.get('target') ?? '').trim();

    if (!SOURCES.some((item) => item.key === source)) {
      return sendJson(res, 400, { error: '来源不合法' });
    }

    const group = target ? state.tagGroups.groupOf(target) : null;
    if (!group) return sendJson(res, 200, { total: 0, target, groupId: null });

    const items = planTagConversion({
      records: state.records,
      source,
      members: group.tags,
      target,
    });

    return sendJson(res, 200, { total: items.length, target, groupId: group.id });
  }

  if (url === '/api/tag-convert/start' && req.method === 'POST') {
    if (!state.tagGroups) return sendJson(res, 503, { error: '标签组未初始化' });

    const body = await readBody(req);
    const source = String(body.source ?? '').trim();
    const target = String(body.target ?? '').trim();

    if (!SOURCES.some((item) => item.key === source)) {
      return sendJson(res, 400, { error: '来源不合法' });
    }
    if (!target) return sendJson(res, 400, { error: '缺少目标标签' });
    if (state.convert?.running) {
      return sendJson(res, 409, { error: '已经有一个转换任务在跑，等它结束或先停止' });
    }

    const group = state.tagGroups.groupOf(target);
    if (!group) return sendJson(res, 400, { error: '这个标签不在任何标签组里' });

    const items = planTagConversion({
      records: state.records,
      source,
      members: group.tags,
      target,
    });

    if (items.length === 0) {
      return sendJson(res, 200, { started: false, total: 0, reason: '没有需要转换的作品' });
    }

    startConversion({ source, target, group, items });
    return sendJson(res, 200, { started: true, total: items.length, job: convertSnapshot() });
  }

  if (url === '/api/tag-convert/stop' && req.method === 'POST') {
    if (!state.convert?.running) {
      return sendJson(res, 200, { ok: true, stopping: false, job: convertSnapshot() });
    }
    // 只置标记：当前这一条写完才收手，已经成功的不会回退
    state.convert.stopRequested = true;
    return sendJson(res, 200, { ok: true, stopping: true, job: convertSnapshot() });
  }

  // 收藏标签的全局使用次数。卡片上的标签位按它排序，把最常用的几个优先露出来。
  // 只在启动和每次改完收藏时取一次，15k 条扫一遍是几毫秒的量级。
  if (url.startsWith('/api/tag-usage')) {
    const usage = new Map();

    for (const record of state.records) {
      const seen = new Set();
      for (const tag of record.bookmark_tags ?? []) {
        const key = String(tag ?? '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        usage.set(key, (usage.get(key) ?? 0) + 1);
      }
    }

    return sendJson(res, 200, { usage: Object.fromEntries(usage) });
  }

  // 交给系统默认浏览器打开。Edge 的 --app 模式里 window.open 只会在 Edge 里再开一窗，
  // 所以链接点击统一走这里。
  if (url === '/api/open' && req.method === 'POST') {
    const body = await readBody(req);
    const target = String(body.url ?? '');

    if (!isPixivUrl(target)) {
      return sendJson(res, 400, { error: '只允许打开 pixiv 的链接' });
    }

    openInDefaultBrowser(new URL(target).toString());
    return sendJson(res, 200, { ok: true });
  }

  /* ── 编辑收藏 ──────────────────────────────────────────────
   * 三个接口：本地选项、从 pixiv 读最新状态、保存。
   * 保存的顺序由 src/bookmark-edit.mjs 保证：写 pixiv 成功 → 改本地。
   */

  // 对话框打开时用：当前标签 / 作品标签 / 我的标签（公开+私密合并），全部来自本地
  if (url.startsWith('/api/bookmark/meta')) {
    const pid = params.get('pid') ?? '';
    if (!/^\d+$/.test(pid)) return sendJson(res, 400, { error: 'pid 不合法' });

    const record = findRecord(pid, params.get('source') ?? '');
    if (!record) return sendJson(res, 404, { error: '找不到这条收藏' });

    const kind = kindOf(record);
    const counter = new Map();
    for (const item of state.records) {
      if (item.source !== sourceKeyOf(kind, false) && item.source !== sourceKeyOf(kind, true)) continue;
      for (const tag of item.bookmark_tags ?? []) {
        counter.set(tag, (counter.get(tag) ?? 0) + 1);
      }
    }

    const myTags = [...counter.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .map(([tag, count]) => ({ tag, count }));

    return sendJson(res, 200, {
      pid: record.pid,
      kind,
      source: record.source,
      private: record.source === sourceKeyOf(kind, true),
      tags: record.bookmark_tags ?? [],
      workTags: record.tags ?? [],
      myTags,
      limit: BOOKMARK_TAG_LIMIT,
      editable: record.removed !== 'yes' && record.status !== 'unavailable',
    });
  }

  // 「从 pixiv 读取」按钮：拿网站上此刻的真实标签和可见性（1 次请求）
  if (url.startsWith('/api/bookmark/state')) {
    const pid = params.get('pid') ?? '';
    if (!/^\d+$/.test(pid)) return sendJson(res, 400, { error: 'pid 不合法' });

    const record = findRecord(pid, params.get('source') ?? '');
    if (!record) return sendJson(res, 404, { error: '找不到这条收藏' });

    try {
      const snapshot = await readEditorState(state.client, kindOf(record), pid, { fast: true });
      if (!snapshot) {
        return sendJson(res, 502, { error: '读不到 pixiv 上的收藏信息（编辑页不可用）' });
      }
      return sendJson(res, 200, { pid, tags: snapshot.tags, private: snapshot.isPrivate });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  // 保存。必须精确匹配，否则 /api/bookmark/xxx 也会掉进这里
  if ((url === '/api/bookmark' || url.startsWith('/api/bookmark?')) && req.method === 'POST') {
    const body = await readBody(req);
    const pid = String(body.pid ?? '');
    if (!/^\d+$/.test(pid)) return sendJson(res, 400, { error: 'pid 不合法' });

    const record = findRecord(pid, String(body.source ?? ''));
    if (!record) return sendJson(res, 404, { error: '找不到这条收藏' });
    if (record.status === 'unavailable') {
      return sendJson(res, 400, { error: '作品已失效，不能编辑收藏' });
    }
    if (record.removed === 'yes') {
      return sendJson(res, 400, { error: '这条收藏已经取消，不能再编辑' });
    }

    const { tags, error } = normalizeTags(body.tags);
    if (error) return sendJson(res, 400, { error });

    const isPrivate = Boolean(body.private);
    const kind = kindOf(record);

    try {
      const result = await withBookmarkLock(() =>
        editBookmark({
          client: state.client,
          files: DATA_FILES,
          kind,
          pid,
          tags,
          isPrivate,
          source: record.source,
        }),
      );

      // 内存同步成刚写入磁盘的样子，界面不必重新拉一整页
      const merged = absorbEditResult(record, result);

      return sendJson(res, 200, {
        ok: true,
        pid,
        moved: result.moved,
        id: result.id,
        source: result.source,
        private: isPrivate,
        tags: result.tags,
        record: decorate(merged),
      });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  /* ── 快速改评分 ────────────────────────────────────────────
   * 评分就是 `n/10` 这个收藏标签，所以走同一条「写 pixiv → 改本地」的链路。
   * 差别只在：以网站上此刻的标签为基准替换，而不是用本地缓存（否则会误删别的标签）。
   */
  if (url === '/api/bookmark/rating' && req.method === 'POST') {
    const body = await readBody(req);
    const pid = String(body.pid ?? '');
    if (!/^\d+$/.test(pid)) return sendJson(res, 400, { error: 'pid 不合法' });

    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 10) {
      return sendJson(res, 400, { error: '评分必须是 1~10 的整数（0 表示清除）' });
    }

    const record = findRecord(pid, String(body.source ?? ''));
    if (!record) return sendJson(res, 404, { error: '找不到这条收藏' });
    if (record.status === 'unavailable') {
      return sendJson(res, 400, { error: '作品已失效，不能评分' });
    }
    if (record.removed === 'yes') {
      return sendJson(res, 400, { error: '这条收藏已经取消，不能评分' });
    }

    const kind = kindOf(record);

    try {
      const result = await withBookmarkLock(() =>
        setBookmarkRating({
          client: state.client,
          files: DATA_FILES,
          kind,
          pid,
          rating,
          source: record.source,
          drop: String(body.drop ?? ''),
        }),
      );

      const merged = absorbEditResult(record, result);

      return sendJson(res, 200, {
        ok: true,
        pid,
        rating: result.rating,
        tags: result.tags,
        moved: result.moved,
        id: result.id,
        source: result.source,
        record: decorate(merged),
      });
    } catch (err) {
      // 标签满了不是错误，是需要用户做一个选择：把当前的标签列表原样带回去
      if (err instanceof BookmarkTagsFullError) {
        return sendJson(res, 409, {
          error: err.message,
          code: err.code,
          tags: err.tags,
          rating: err.rating,
        });
      }
      return sendJson(res, 502, { error: err.message });
    }
  }

  // 批量入队：前端滚动时把视口内未下载的作品扔进来
  // 注意必须精确匹配 —— 用 startsWith 会把 /api/enqueue-all 也拦下来，
  // 导致「一键下载全部」一直报「缺少 pids」
  if ((url === '/api/enqueue' || url.startsWith('/api/enqueue?')) && req.method === 'POST') {
    const body = await readBody(req);
    const pids = Array.isArray(body.pids) ? body.pids : [];
    if (pids.length === 0) return sendJson(res, 400, { error: '缺少 pids' });
    if (pids.length > 500) return sendJson(res, 400, { error: '一次最多 500 个' });

    const { added, blocked } = enqueue(pids);
    return sendJson(res, 200, { added, blocked: blocked ?? null, queue: queueSnapshot() });
  }

  // 队列状态：前端轮询这个来更新卡片
  if (url.startsWith('/api/queue/clear')) {
    const dropped = queue.pending.splice(0);
    for (const task of dropped) {
      if (task.page !== undefined) {
        // 单页任务的 Promise 得结掉，否则等这一页的请求会一直挂着
        task.reject(new Error('队列已清空'));
      } else {
        queue.queued.delete(task.key);
        queue.pageCount.delete(task.pid);
      }
    }
    return sendJson(res, 200, { cleared: dropped.length, queue: queueSnapshot() });
  }

  if (url.startsWith('/api/queue')) {
    return sendJson(res, 200, queueSnapshot());
  }

  // 跳过本轮的随机休息（界面横幅上的「立即继续」）
  if (url.startsWith('/api/pacer/skip') && req.method === 'POST') {
    if (!state.pacer) return sendJson(res, 503, { error: '节奏控制器未初始化' });
    const result = state.pacer.skip();
    return sendJson(res, 200, { ...result, pacer: state.pacer.status(), queue: queueSnapshot() });
  }

  // 解除「过度访问警告」的禁令（界面横幅上的按钮走这里）
  if (url.startsWith('/api/guard/resume') && req.method === 'POST') {
    if (!state.guard) return sendJson(res, 503, { error: '守卫未初始化' });
    const before = state.guard.status();
    await state.guard.resume();
    console.log(`[防封号] 用户手动解除了禁令（原警告 ${before.warnedAt ?? '无'}）`);
    return sendJson(res, 200, { ok: true, guard: state.guard.status() });
  }

  // 统计：给下载管理器用的总览。作品数和页数各算一套 ——
  // 「已下载 120 个作品」和「已下载 300 / 4200 页」是两回事，后者才反映真实进度。
  if (url.startsWith('/api/stats')) {
    // 命令行那边可能刚写了禁令，先把磁盘状态同步进来
    if (state.guard) await state.guard.refresh();

    let allPagesTotal = 0;
    let allPagesDone = 0;

    const sources = SOURCES.map((source) => {
      let total = 0;
      let done = 0;
      let removed = 0;
      let unavailable = 0;
      let pagesTotal = 0;
      let pagesDone = 0;
      let firstMissing = 0; // 一张图都还没有的作品数，用来判断「只下首页」还有没有活干

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

        const stats = pageStats(record);
        pagesTotal += stats.total;
        pagesDone += stats.have;
        if (stats.have >= stats.total) done += 1;
        // 小说没有图片，不参与批量下首页
        if (record.type !== 'novel' && stats.have === 0) firstMissing += 1;
      }

      allPagesTotal += pagesTotal;
      allPagesDone += pagesDone;

      return {
        key: source.key,
        label: source.label,
        total,
        done,
        removed,
        unavailable,
        missing: total - done - removed - unavailable,
        firstMissing,
        pages: { total: pagesTotal, done: pagesDone, missing: pagesTotal - pagesDone },
      };
    });

    return sendJson(res, 200, {
      sources,
      queue: queueSnapshot(),
      verify: verifyState,
      records: state.records.length,
      downloaded: state.imageIndex.size,
      guard: state.guard ? state.guard.status() : null,
      convert: convertSnapshot(),
      pages: { total: allPagesTotal, done: allPagesDone, missing: allPagesTotal - allPagesDone },
    });
  }

  // 把「所有还没下载的」一次性塞进队列
  if (url.startsWith('/api/enqueue-all')) {
    const source = params.get('source');
    // mode=first：每个作品只补首张，不给没图的作品排队补简介
    const wantMode = params.get('mode') === 'first' ? 'first' : 'full';
    const pids = [];

    for (const record of state.records) {
      if (source && record.source !== source) continue;
      if (record.removed === 'yes') continue;
      if (record.status === 'unavailable') continue;
      if (record.type === 'novel') continue; // 小说没有图片，不参与图片批量下载
      const pid = String(record.pid);
      const stats = pageStats(record);

      if (wantMode === 'first') {
        // 已经有任意一页就等于「首张已下」，不用再排
        if (stats.have > 0) continue;
      } else {
        // 页数补齐 + 简介齐全才算完成，只差其中一项也要入队
        const hasDesc = Boolean(record.description) || descCache.has(pid);
        if (isComplete(record) && hasDesc) continue;
      }

      pids.push(record.pid);
    }

    const { added, blocked } = enqueue(pids, { mode: wantMode });
    return sendJson(res, 200, {
      candidates: pids.length,
      added,
      mode: wantMode,
      blocked: blocked ?? null,
      queue: queueSnapshot(),
    });
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

    // 只有「所有页都齐了」才算已在本地；只下了首张的要继续补
    if (isComplete(record)) {
      return sendJson(res, 200, { status: 'already', files: 0 });
    }

    const queued = enqueue([pid], { mode: 'full', priority: true });
    // 守卫拦着就别让它干等 180 秒了，直接把原因说清楚
    if (queued.blocked) {
      return sendJson(res, 429, {
        error:
          queued.blocked === 'guard'
            ? '检测到 pixiv 的过度访问警告，下载已停用。确认风险后可点顶部的「恢复运行」解除。'
            : '今日下载额度已用完，明天会自动恢复，或调大 config.json 里 guard.dailyFileLimit。',
      });
    }

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      // 之前可能被滚动任务用 first 模式下过，那种 done 不算数，要等 full 那次
      if (queue.done.has(pid) && (queue.doneMode.get(pid) ?? 'first') === 'full') {
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

  state.tagGroups = createTagGroupStore(TAG_GROUPS_PATH, {
    log: (text) => console.log(`  [标签组] ${text}`),
  });

  const cookieFile = path.join(ROOT, state.config.cookieFile ?? '.secrets/cookies.txt');
  let cookie = state.config.cookie ?? '';
  if (!cookie && fs.existsSync(cookieFile)) cookie = (await fsp.readFile(cookieFile, 'utf8')).trim();

  // 节奏控制要在两个限速器之前建好：接口和图片共用同一本账，
  // 休息时整条下载线一起停，而不是各停各的。
  state.pacer = new RequestPacer({ ...DEFAULT_PACER, ...(state.config.pacer ?? {}) }, {
    log: (text) => console.log(`  [节奏] ${text}`),
  });

  state.client = new PixivClient({
    cookie,
    proxy: state.config.proxy,
    limiter: new RateLimiter(state.config.intervalMs ?? 2000, 250, state.pacer),
    userId: state.config.userId,
  });
  state.imageLimiter = new RateLimiter(
    state.config.download?.imageIntervalMs ?? 1000,
    250,
    state.pacer,
  );

  state.guard = createGuard({
    client: state.client,
    statePath: path.join(ROOT, '.secrets', 'guard-state.json'),
    thresholds: { ...DEFAULT_GUARD, ...(state.config.guard ?? {}) },
    log: (text) => console.log(`  ${text}`),
  });

  console.log(`已加载 ${state.records.length} 条记录，${state.imageIndex.size} 个作品已下载。`);

  const guardStatus = state.guard.status();
  if (guardStatus.blocked) {
    console.warn(
      '\n⚠️  上次检测到 pixiv 的「过度访问警告」，下载队列已停用。' +
        '\n   在界面点「恢复运行」，或执行 node src/cli.mjs resume。\n',
    );
  } else if (guardStatus.dailyExhausted) {
    console.warn(`\n⚠️  今日下载额度已用完（${guardStatus.daily.files} 个文件），明天自动恢复。\n`);
  }

  // 预热到 pixiv 的连接：走代理建隧道 + TLS 要三秒左右，不预热的话
  // 「第一次编辑收藏 / 打开第一张封面」都得先付这笔握手钱。
  // 不 await —— 启动不等它；失败也无所谓（没代理或 cookie 过期时本地浏览照常可用）。
  if (state.client.cookie) {
    state.client.ajax('/ajax/user/extra', { lang: 'zh' }).catch(() => {});
  }

  listen(BASE_PORT);
}

main().catch((err) => {
  console.error('初始化失败:', err);
  process.exit(1);
});

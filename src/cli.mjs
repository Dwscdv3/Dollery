#!/usr/bin/env node

/*
 * Copyright (C) 2026 静瑶 (Dwscdv3)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * 命令行入口。
 *
 * 设计上尽量「说得清楚」而不是「跑得快」：每一步在干什么、还要多久、
 * 这次改动了几条，都直接打在终端上。收藏同步本来就慢（每页至少 2 秒），
 * 让人不知道进度是最难受的。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RateLimiter } from './http.mjs';
import { PixivClient, PixivError } from './pixiv.mjs';
import { readRecords } from './store.mjs';
import { syncKind, SyncAbort, formatDurationMs } from './sync.mjs';
import { downloadRecords, formatBytes } from './download.mjs';
import { buildChannels, syncTagsForChannel } from './channels.mjs';
import { createGuard, GuardTripped, DailyLimitReached } from './guard.mjs';
import { RequestPacer, DEFAULT_PACER } from './pacer.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const EXAMPLE_PATH = path.join(PROJECT_ROOT, 'config.example.json');

const GUARD_STATE_PATH = path.join(PROJECT_ROOT, '.secrets', 'guard-state.json');

/**
 * 建一个守卫。client 可以为 null（只查状态 / 解除禁令时不需要发请求）。
 */
function makeGuard(config, client = null) {
  return createGuard({
    client,
    statePath: GUARD_STATE_PATH,
    thresholds: config?.guard ?? {},
    log: (text) => console.log(`    ${text}`),
  });
}

const DEFAULT_CONFIG = {
  proxy: 'http://127.0.0.1:7897',
  intervalMs: 2000,
  cookie: '',
  cookieFile: '.secrets/cookies.txt',
  userId: '',
  includeNovels: true,
  includePrivateBookmarks: true,
  pageSize: { illust: 100, novel: 100 },
  maxPagesPerRun: 0,
  output: {
    illustPublic: 'data/bookmarks-illust.json',
    illustPrivate: 'data/bookmarks-illust-private.json',
    novelPublic: 'data/bookmarks-novel.json',
    novelPrivate: 'data/bookmarks-novel-private.json',
  },
  download: {
    dir: 'images',
    avifQuality: 50,
    imageIntervalMs: 1000,
    keepOriginal: false,
  },

  bookmarkTags: {
    enabled: true,
    cacheDir: '.cache',
  },

  // 防封号守卫：默认开启，额度按天算
  guard: {
    enabled: true,
    checkEveryFiles: 100,
    checkEveryRequests: 300,
    minCheckIntervalMs: 200000,
    dailyFileLimit: 2000,
    dailyByteLimit: 0,
  },

  // 请求节奏：攒够若干次请求就整队随机休息一段，模拟真人的使用习惯
  pacer: { ...DEFAULT_PACER },
};

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      flags._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

async function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`config.json 解析失败：${err.message}`);
    }
  }

  // 顺手删掉以 _ 开头的说明字段，免得它们混进配置。
  for (const key of Object.keys(raw)) {
    if (key.startsWith('_')) delete raw[key];
  }

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    pageSize: { ...DEFAULT_CONFIG.pageSize, ...(raw.pageSize ?? {}) },
    download: { ...DEFAULT_CONFIG.download, ...(raw.download ?? {}) },
    bookmarkTags: { ...DEFAULT_CONFIG.bookmarkTags, ...(raw.bookmarkTags ?? {}) },
    guard: { ...DEFAULT_CONFIG.guard, ...(raw.guard ?? {}) },
    pacer: { ...DEFAULT_CONFIG.pacer, ...(raw.pacer ?? {}) },
    // 兼容旧版配置：以前只有 illust / novel 两个输出路径，全部对应到公开收藏。
    output: {
      ...DEFAULT_CONFIG.output,
      ...(raw.output?.illust ? { illustPublic: raw.output.illust } : {}),
      ...(raw.output?.novel ? { novelPublic: raw.output.novel } : {}),
      ...(raw.output ?? {}),
    },
  };
}

async function resolveCookie(config) {
  if (process.env.PIXIV_COOKIE) return process.env.PIXIV_COOKIE.trim();
  if (config.cookie) return String(config.cookie).trim();

  if (config.cookieFile) {
    const cookiePath = path.resolve(PROJECT_ROOT, config.cookieFile);
    try {
      const text = await fs.readFile(cookiePath, 'utf8');
      const cleaned = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .join('; ');
      if (cleaned) return cleaned;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  return '';
}

function printHelp() {
  const lines = [
    '色廊 Dollery — Pixiv 收藏同步与下载',
    '',
    '用法:',
    '  node src/cli.mjs sync [选项]          同步收藏（默认增量）',
    '  node src/cli.mjs download --id 1-5    下载指定序号的作品',
    '  node src/cli.mjs status               查看本地备份概况',
    '  node src/cli.mjs check                检查代理与 cookie 是否可用',
    '  node src/cli.mjs guard                查看防封号守卫状态',
    '  node src/cli.mjs resume               解除「检测到警告」的禁令',
    '',
    'sync 选项:',
    '  --full               全量同步：翻完所有页，能发现取消收藏与字段变更',
    '  --dry-run            只抓取并报告差异，不写入文件',
    '  --illust-only        只同步插画/漫画',
    '  --novel-only         只同步小说',
    '  --public-only        只同步公开收藏',
    '  --private-only       只同步私密收藏',
    '  --max-pages N        本次每条通道最多抓 N 页',
    '  --skip-tags          本次不更新收藏标签',
    '  --rebuild-tags       强制重建收藏标签映射（首次约 30 分钟）',
    '  --interval MS        覆盖请求间隔（默认 2000，不建议低于 2000）',
    '',
    'download 选项:',
    '  --id RANGE           必填，收藏序号：1-5 / 1,3,7 / 1-10,20',
    '  --novel              下载小说正文（默认下插画）',
    '  --public-only        只下公开收藏',
    '  --private-only       只下私密收藏',
    '  --quality N          AVIF 质量，默认 50',
    '  --keep-original      保留原始图片（默认转换后删除）',
    '  --image-interval MS  图片下载间隔，默认 1000',
    '  --out DIR            输出目录，默认 images',
    '  --dry-run            只列出要下什么，不实际下载',
    '  --no-pacer           关闭随机休息（按概率触发的长暂停），赶时间时用',
    '',
    '认证:',
    '  把浏览器登录 pixiv 后的 cookie 写入 .secrets/cookies.txt，',
    '  或设置环境变量 PIXIV_COOKIE，或在 config.json 里填 cookie。',
    '  最省事的写法是只放 PHPSESSID 的值，程序会自动补全。',
    '',
    '防封号:',
    '  每累计 100 个文件 / 300 次请求会查一次站内信（间隔 ≥200 秒），',
    '  一旦发现「过度访问警告」就停止任务并落盘禁令，需 guard / resume 处理。',
    '  每日下载量上限见 config.json 的 guard.dailyFileLimit。',
  ];
  console.log(lines.join('\n'));
}

function relativeToRoot(target) {
  return path.relative(PROJECT_ROOT, path.resolve(PROJECT_ROOT, target)) || target;
}

/** 配置类问题：不是程序坏了，只是还没准备好。单独区分出来给个平静的提示。 */
class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

async function buildClient(config, flags, { pacer = null } = {}) {
  const intervalMs = Number(flags.interval ?? config.intervalMs ?? 2000);
  if (!Number.isFinite(intervalMs) || intervalMs < 500) {
    throw new ConfigError(`请求间隔 ${intervalMs}ms 过小。Pixiv 对高频访问敏感，不要低于 2000ms。`);
  }

  const cookie = await resolveCookie(config);
  if (!cookie) {
    throw new ConfigError(
      [
        '还差一步：没有找到 Pixiv cookie。任选一种方式提供 ——',
        `  1. 新建 ${relativeToRoot(path.join(PROJECT_ROOT, config.cookieFile))}，写入 PHPSESSID 的值`,
        '  2. 设置环境变量 PIXIV_COOKIE',
        '  3. 在 config.json 里填 cookie 字段',
        '',
        '获取方法：浏览器登录 pixiv.net → F12 → Application/存储 → Cookies → 复制 PHPSESSID。',
      ].join('\n'),
    );
  }

  const limiter = new RateLimiter(intervalMs, 250, pacer);
  const client = new PixivClient({
    cookie,
    proxy: config.proxy,
    limiter,
    userId: config.userId,
    verbose: Boolean(flags.verbose),
  });

  return { client, limiter, intervalMs };
}

/**
 * 待同步的通道列表。
 *
 * 公开和私密是服务端两个独立的收藏列表（rest=show / rest=hide），各有自己的
 * 总数和分页，只能分别翻页、分别落盘。所以「插画」实际上对应两条通道。
 */
function printProgress(event) {
  const eta =
    event.serverTotal > 0
      ? ` 预计 ${formatDurationMs(Math.max(0, ((event.serverTotal - event.offset) / event.limit) * 2200))}`
      : '';
  const line =
    `  [${event.label}] 第 ${String(event.page).padStart(2)} 页 ` +
    `本页新增 ${String(event.newInPage).padStart(2)} ` +
    `累计 ${event.fetchedSoFar}/${event.serverTotal || '?'}${eta}`;
  process.stdout.write(`${line}\n`);
}

function printSummary(result) {
  const out = [];
  out.push('');
  out.push(`── ${result.label} ──`);
  out.push(`  服务端收藏总数 : ${result.total || '未知'}`);
  out.push(`  本次请求页数   : ${result.pages}（间隔限速下共 ${formatDurationMs(result.elapsedMs)}）`);
  out.push(`  停止原因       : ${result.stoppedReason}`);
  out.push(`  本地记录       : ${result.localBefore} → ${result.localAfter}`);
  if (result.unavailableCount > 0) {
    out.push(`  其中已失效     : ${result.unavailableCount} 条（作品被删除或转为不可见，已标记 status: unavailable）`);
  }
  if (result.removedCount > 0) {
    out.push(`  累计已移除     : ${result.removedCount} 条（记录保留在文件里，标记 removed: yes）`);
  }
  out.push(
    `  新增 ${result.added.length} 条 · 本次标记移除 ${result.removed.length} 条 · 字段变更 ${result.changed.length} 条`,
  );

  if (result.added.length > 0) {
    out.push('  新增预览:');
    for (const record of result.added.slice(0, 8)) {
      out.push(`    + #${record.id} ${record.pid} 《${record.title || '(无题)'}》 — ${record.author || '未知作者'}`);
    }
    if (result.added.length > 8) out.push(`    … 另有 ${result.added.length - 8} 条`);
  }

  if (result.removed.length > 0) {
    out.push('  本次新标记为已移除:');
    for (const record of result.removed.slice(0, 8)) {
      out.push(`    - #${record.id} ${record.pid} 《${record.title || '(无题)'}》`);
    }
    if (result.removed.length > 8) out.push(`    … 另有 ${result.removed.length - 8} 条`);
  }

  if (result.changed.length > 0) {
    out.push('  字段变更:');
    for (const item of result.changed.slice(0, 5)) {
      const detail = item.fields
        .map((f) => `${f.key}: ${JSON.stringify(f.from)} → ${JSON.stringify(f.to)}`)
        .join('; ');
      out.push(`    ~ #${item.id} ${item.pid} ${detail}`);
    }
    if (result.changed.length > 5) out.push(`    … 另有 ${result.changed.length - 5} 条`);
  }

  console.log(out.join('\n'));
}

/**
 * 同步一条通道的收藏标签。
 *
 * 标签和元数据分两步走：元数据靠翻收藏列表，标签只能靠「逐标签反查」，
 * 两者成本差一个数量级，所以有缓存、有单独的开关。
 */
async function commandSync(flags) {
  const config = await loadConfig();
  const { client, intervalMs } = await buildClient(config, flags);
  const guard = makeGuard(config, client);

  // 上一次运行留下的禁令要先拦住，别一上来就继续发请求
  await guard.assertAllowed();

  const full = Boolean(flags.full);
  const dryRun = Boolean(flags['dry-run']);

  console.log(`代理: ${config.proxy}   请求间隔: ${intervalMs}ms   模式: ${full ? '全量' : '增量'}${dryRun ? '（演练）' : ''}`);

  const userId = await client.resolveUserId();
  console.log(`账号 userId: ${userId}\n`);

  const channels = buildChannels(config, {
    novelOnly: Boolean(flags['novel-only']),
    illustOnly: Boolean(flags['illust-only']),
    publicOnly: Boolean(flags['public-only']),
    privateOnly: Boolean(flags['private-only']),
  });

  if (channels.length === 0) {
    console.log('没有需要同步的收藏类型。');
    return 0;
  }

  // 先算一遍总页数，好在开始前就把预计耗时告诉用户 —— 四条通道加起来可能要十几分钟。
  console.log('');

  const results = [];
  const wantTags = Boolean(config.bookmarkTags.enabled) && !flags['skip-tags'] && !dryRun;

  for (const entry of channels) {
    const filePath = path.resolve(PROJECT_ROOT, entry.file);
    const result = await syncKind(client, {
      kind: entry.kind,
      visibility: entry.visibility,
      label: entry.label,
      filePath,
      limit: Number(config.pageSize[entry.kind] ?? 100),
      full,
      dryRun,
      maxPages: Number(flags['max-pages'] ?? config.maxPagesPerRun ?? 0),
      // 每翻一页就是一次请求，顺便记账（达到阈值会在这里巡检一次站内信）
      onProgress: async (event) => {
        printProgress(event);
        await guard.bump({ requests: 1 });
      },
    });
    results.push(result);

    if (wantTags) {
      await syncTagsForChannel(client, {
        entry,
        config,
        filePath,
        full,
        rebuildTags: Boolean(flags['rebuild-tags']),
        sourceTotal: result.total,
        result,
        guard,
        log: (text) => console.log(text),
      });
    }
  }

  for (const result of results) printSummary(result);

  const totalAdded = results.reduce((sum, r) => sum + r.added.length, 0);
  const totalRemoved = results.reduce((sum, r) => sum + r.removed.length, 0);
  const totalChanged = results.reduce((sum, r) => sum + r.changed.length, 0);

  console.log('');
  if (dryRun) {
    console.log(`演练结束：将新增 ${totalAdded}、移除 ${totalRemoved}、变更 ${totalChanged}（未写入文件）。`);
  } else if (totalAdded + totalRemoved + totalChanged === 0) {
    console.log('本地已是最新，没有变化。');
  } else {
    console.log(`完成：新增 ${totalAdded}、移除 ${totalRemoved}、变更 ${totalChanged}。`);
    console.log('可以用 git diff 查看具体改动，确认后提交。');
  }

  return 0;
}

/**
 * 解析 --id 参数：支持 1-5、1,3,7、1-10,20,30-40 这几种写法。
 */
function parseIdRanges(text) {
  const ids = new Set();

  for (const raw of String(text).split(',')) {
    const part = raw.trim();
    if (!part) continue;

    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = Math.min(Number(range[1]), Number(range[2]));
      const hi = Math.max(Number(range[1]), Number(range[2]));
      if (hi - lo > 20000) {
        throw new ConfigError(`范围 ${lo}-${hi} 太大了（超过 20000 条），请拆成几段跑。`);
      }
      for (let i = lo; i <= hi; i += 1) ids.add(i);
      continue;
    }

    if (/^\d+$/.test(part)) ids.add(Number(part));
  }

  return ids;
}

const DOWNLOAD_TARGETS = {
  'illust:public': { key: 'illustPublic', label: '插画/漫画·公开' },
  'illust:private': { key: 'illustPrivate', label: '插画/漫画·私密' },
  'novel:public': { key: 'novelPublic', label: '小说·公开' },
  'novel:private': { key: 'novelPrivate', label: '小说·私密' },
};

async function commandDownload(flags) {
  const config = await loadConfig();

  // 节奏控制和限速是同一件事的两层：接口限速器（client 里那个）和图片限速器
  // 共用同一个 pacer，休息时两条线一起停，计数也是同一本账。
  const pacer = new RequestPacer(flags['no-pacer'] ? { ...config.pacer, enabled: false } : config.pacer, {
    log: (text) => console.log(`    [节奏] ${text}`),
  });

  const { client } = await buildClient(config, flags, { pacer });
  const guard = makeGuard(config, client);
  await guard.assertAllowed();

  const idText = flags.id;
  if (!idText || idText === true) {
    throw new ConfigError(
      [
        '需要用 --id 指定收藏序号，例如：',
        '  --id 1-5       第 1 到第 5 条',
        '  --id 1,3,7     只下这三条',
        '  --id 1-10,20   组合写法',
        '',
        '序号就是数据文件里的 id 字段（1 = 最早收藏）。',
      ].join('\n'),
    );
  }

  const wanted = parseIdRanges(String(idText));
  if (wanted.size === 0) {
    throw new ConfigError(`--id "${idText}" 解析不出任何序号。`);
  }

  const kind = flags.novel ? 'novel' : 'illust';
  const visibilities = [];
  if (!flags['private-only']) visibilities.push('public');
  if (!flags['public-only']) visibilities.push('private');

  const selected = [];
  for (const visibility of visibilities) {
    const entry = DOWNLOAD_TARGETS[`${kind}:${visibility}`];
    const records = await readRecords(path.resolve(PROJECT_ROOT, config.output[entry.key]));
    for (const record of records) {
      if (wanted.has(Number(record.id))) {
        selected.push({ ...record, sourceLabel: entry.label });
      }
    }
  }

  if (selected.length === 0) {
    console.log(`在${kind === 'novel' ? '小说' : '插画'}收藏里，没有 id 落在范围内的记录。`);
    console.log('提示：公开和私密的 id 是各自独立编号的，可用 --public-only / --private-only 限定。');
    return 0;
  }

  // 已取消收藏、作品本身已失效的，图片大概率也取不到，直接跳过并说明原因
  const usable = [];
  const skippedRemoved = [];
  const skippedUnavailable = [];
  for (const record of selected) {
    if (record.removed) skippedRemoved.push(record);
    else if (record.status === 'unavailable') skippedUnavailable.push(record);
    else usable.push(record);
  }

  const outDir = path.resolve(PROJECT_ROOT, flags.out ?? config.download.dir);
  const quality = Number(flags.quality ?? config.download.avifQuality ?? 50);
  const imageInterval = Number(flags['image-interval'] ?? config.download.imageIntervalMs ?? 1000);
  const keepOriginal = Boolean(flags['keep-original'] ?? config.download.keepOriginal);
  const dryRun = Boolean(flags['dry-run']);

  console.log(`输出目录: ${relativeToRoot(outDir)}`);
  console.log(`命中 ${selected.length} 条，可下载 ${usable.length} 条`);
  if (skippedRemoved.length > 0) console.log(`  跳过 ${skippedRemoved.length} 条：已取消收藏`);
  if (skippedUnavailable.length > 0) console.log(`  跳过 ${skippedUnavailable.length} 条：作品已失效`);
  if (kind === 'novel') {
    console.log(`正文存为 .txt${dryRun ? '   [演练模式]' : ''}`);
  } else {
    console.log(
      `AVIF 质量 ${quality}   图片间隔 ${imageInterval}ms   ${keepOriginal ? '保留原图' : '转换后删除原图'}${dryRun ? '   [演练模式]' : ''}`,
    );
  }

  const pacerStatus = pacer.status();
  if (pacerStatus.enabled) {
    const limits = pacerStatus.limits;
    const chance = Number((limits.pauseChance * 100).toFixed(2));
    const perSec = Math.round(limits.perRequestMs / 1000);
    const decaySec = Math.round(limits.decayMs / 1000);
    const minPause = Math.round(limits.minPauseMs / 60000);
    const maxPause = Math.round(limits.maxPauseMs / 60000);
    console.log(
      `休息节奏: 每个请求 ${chance}% 概率休息；期望时长 = 距上次休息的请求数 × ${perSec} 秒` +
        `（${minPause}~${maxPause} 分钟，Gamma k=${limits.shape}）；` +
        `空闲时每 ${decaySec} 秒回退 1 次计数`,
    );
  } else {
    console.log('休息节奏: 已关闭（--no-pacer）');
  }
  console.log('');

  if (usable.length === 0) return 0;

  const imageLimiter = new RateLimiter(imageInterval, 250, pacer);
  const startedAt = Date.now();

  const summary = await downloadRecords(client, {
    records: usable,
    outDir,
    quality,
    keepOriginal,
    dryRun,
    imageLimiter,
    proxy: config.proxy,
    onProgress: async (event) => {
      const title = event.record.title || '无题';
      if (event.phase === 'start') {
        process.stdout.write(`  [${event.index + 1}/${event.total}] ${event.label} 《${title}》 … `);
        return;
      }
      if (event.phase === 'done') {
        const { result } = event;
        if (dryRun) console.log('演练');
        else if (result.skipped > 0 && result.files.length === 0) console.log(`已存在，跳过 ${result.skipped} 个文件`);
        else console.log(`完成 ${result.files.length} 个文件`);
        // 真正落盘的文件才计入额度：跳过的不算，否则额度会被重复跑消耗掉
        if (!dryRun) await guard.bump({ files: result.files.length, bytes: result.finalBytes });
        return;
      }
      if (event.phase === 'fail') {
        console.log(`失败：${event.message}`);
      }
    },
  });

  console.log('');
  console.log('── 下载结果 ──');
  console.log(`  成功 ${summary.ok} 条 · 跳过已有文件 ${summary.skipped} 个 · 失败 ${summary.failed} 条`);

  if (summary.files > 0) {
    console.log(`  产出 ${summary.files} 个文件，耗时 ${formatDurationMs(Date.now() - startedAt)}`);
    if (kind === 'novel') {
      console.log(`  写入 ${formatBytes(summary.finalBytes)} 文本`);
    } else if (summary.originalBytes > 0) {
      const saved = summary.originalBytes - summary.finalBytes;
      const ratio = (saved / summary.originalBytes) * 100;
      console.log(
        `  原始 ${formatBytes(summary.originalBytes)} → 成品 ${formatBytes(summary.finalBytes)}（省下 ${ratio.toFixed(1)}%）`,
      );
    }
  }

  if (summary.errors.length > 0) {
    console.log('  失败明细:');
    for (const item of summary.errors.slice(0, 8)) {
      console.log(`    #${item.record.id} pid=${item.record.pid}：《${item.record.title || '无题'}》 ${item.message}`);
    }
    if (summary.errors.length > 8) console.log(`    … 另有 ${summary.errors.length - 8} 条`);
  }

  return summary.failed > 0 ? 1 : 0;
}

async function commandStatus() {
  const config = await loadConfig();
  const channels = buildChannels(config, {});

  console.log('本地备份概况\n');
  let grandTotal = 0;

  for (const entry of channels) {
    const absolute = path.resolve(PROJECT_ROOT, entry.file);
    const records = await readRecords(absolute);
    grandTotal += records.length;

    const removedCount = records.filter((r) => r.removed).length;
    const unavailableCount = records.filter((r) => r.status === 'unavailable').length;

    console.log(`── ${entry.label} ──`);
    console.log(
      `  记录数: ${records.length}（在册 ${records.length - removedCount}，已移除 ${removedCount}）`,
    );
    if (unavailableCount > 0) console.log(`  其中作品已失效: ${unavailableCount}`);

    let statLine;
    try {
      const stat = await fs.stat(absolute);
      statLine = `  文件: ${relativeToRoot(absolute)}（${(stat.size / 1024).toFixed(1)} KB，更新于 ${stat.mtime.toLocaleString()}）`;
    } catch {
      statLine = '  文件: 尚未生成';
    }
    console.log(statLine);

    const withSeq = records.filter((r) => Number(r.id) > 0);
    if (withSeq.length > 0) {
      let min = Infinity;
      let max = 0;
      let oldest = withSeq[0];
      for (const record of withSeq) {
        const seq = Number(record.id);
        if (seq < min) min = seq;
        if (seq > max) max = seq;
        if (seq < Number(oldest.id)) oldest = record;
      }
      console.log(`  收藏序号: ${min} ~ ${max}（共 ${withSeq.length} 条有序号）`);
      console.log(`  最早收藏: #${oldest.id} pid=${oldest.pid} 《${oldest.title || '(无题)'}》`);
    }

    const seenDates = records.map((r) => r.first_seen).filter(Boolean).sort();
    if (seenDates.length > 0) {
      console.log(`  记录跨度: ${seenDates[0]} ~ ${seenDates[seenDates.length - 1]}`);
    }
    console.log('');
  }

  console.log(`合计 ${grandTotal} 条记录。`);
  return 0;
}

async function commandCheck(flags) {
  const config = await loadConfig();
  const { client, intervalMs } = await buildClient(config, flags);

  console.log(`1. 配置读取正常（代理 ${config.proxy}，间隔 ${intervalMs}ms）`);

  const userId = await client.resolveUserId();
  console.log(`2. 代理与 cookie 可用，账号 userId = ${userId}`);

  const publicPage = await client.fetchBookmarkPage('illust', 0, { limit: 1, visibility: 'public' });
  const privatePage = await client.fetchBookmarkPage('illust', 0, { limit: 1, visibility: 'private' });
  console.log(
    `3. 收藏接口可达：插画公开 ${publicPage.total} 条，插画私密 ${privatePage.total} 条`,
  );

  console.log('\n一切就绪，可以运行 npm run sync。');
  return 0;
}

/**
 * 查看防封号守卫的状态。不发任何请求，随便跑。
 */
async function commandGuard() {
  const config = await loadConfig();
  const guard = makeGuard(config);
  await guard.load();

  const status = guard.status();
  const limits = status.limits;
  const daily = status.daily;

  console.log('');
  console.log('── 防封号守卫 ──');
  console.log(`  状态         : ${guard.settings.enabled ? '开启' : '关闭（config.json 里 guard.enabled = false）'}`);
  console.log(
    `  巡检阈值     : 每 ${guard.settings.checkEveryFiles} 个文件 / ${guard.settings.checkEveryRequests} 次请求` +
      `（两次间隔 ≥ ${Math.round(guard.settings.minCheckIntervalMs / 1000)} 秒）`,
  );
  console.log(`  上次巡检     : ${status.lastCheckAt ? new Date(status.lastCheckAt).toLocaleString('zh-CN') : '还没查过'}`);
  console.log(
    `  今日下载     : ${daily.files} 个文件 / ${(daily.bytes / 1024 ** 3).toFixed(2)} GB` +
      `${limits.dailyFileLimit > 0 ? `（上限 ${limits.dailyFileLimit} 个）` : '（不限量）'}`,
  );
  console.log(`  自上次巡检   : ${status.overall.files} 个文件 / ${status.overall.requests} 次请求`);

  if (status.blocked) {
    console.log('');
    console.log(`  ⚠️  当前有禁令，所有任务都会被拒绝执行`);
    console.log(`     检测到警告 : ${new Date(status.warnedAt).toLocaleString('zh-CN')}`);
    if (status.warning?.excerpt) console.log(`     站内信摘要 : ${status.warning.excerpt}`);
    console.log('');
    console.log('     确认已经谨慎处理过（比如隔了几天、调大了请求间隔）后，执行：');
    console.log('       node src/cli.mjs resume');
  } else {
    console.log(`  当前禁令     : 无`);
  }
  console.log('');

  return 0;
}

/**
 * 手动解除禁令。
 */
async function commandResume() {
  const config = await loadConfig();
  const guard = makeGuard(config);
  await guard.load();

  const before = guard.status();
  if (!before.blocked) {
    console.log('当前没有禁令，不需要解除。');
    return 0;
  }

  await guard.resume();
  console.log(`已解除禁令（原警告时间 ${new Date(before.warnedAt).toLocaleString('zh-CN')}）。`);
  console.log('');
  console.log('建议同时做两件事，别让它再触发：');
  console.log('  1. config.json 里把 intervalMs 调大（比如 3000~5000）');
  console.log('  2. guard.dailyFileLimit 调小，先少量跑几天');
  return 0;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const command = flags._[0] ?? 'help';

  if (flags.help || command === 'help') {
    printHelp();
    return 0;
  }

  // 首次运行时给个明确的入门提示，而不是让人对着 ENOENT 发愣。
  try {
    await fs.access(CONFIG_PATH);
  } catch {
    try {
      await fs.access(EXAMPLE_PATH);
      console.log(`提示：还没有 config.json，可以先执行  cp config.example.json config.json\n`);
    } catch {
      // 两个都没有就让它按默认值跑
    }
  }

  switch (command) {
    case 'sync':
      return commandSync(flags);
    case 'download':
      return commandDownload(flags);
    case 'status':
      return commandStatus();
    case 'check':
      return commandCheck(flags);
    case 'guard':
      return commandGuard();
    case 'resume':
      return commandResume();
    default:
      console.error(`未知命令: ${command}`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    if (err instanceof ConfigError) {
      console.error(`\n${err.message}`);
      process.exit(1);
    }
    if (err instanceof SyncAbort) {
      console.error(`\n已中止：${err.message}`);
      process.exit(2);
    }
    // 守卫拦截要排在 PixivError 前面：它更具体，提示也更重要
    if (err instanceof GuardTripped) {
      console.error(`\n${err.message}`);
      process.exit(2);
    }
    if (err instanceof DailyLimitReached) {
      console.error(`\n${err.message}`);
      process.exit(3);
    }
    if (err instanceof PixivError) {
      console.error(`\nPixiv 接口出错：${err.message}`);
      if (err.hint) console.error(`建议：${err.hint}`);
      process.exit(1);
    }
    console.error(`\n出错了：${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });

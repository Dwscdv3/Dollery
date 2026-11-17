#!/usr/bin/env node
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
import { updateBookmarkTagMap, applyBookmarkTags } from './bookmark-tags.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const EXAMPLE_PATH = path.join(PROJECT_ROOT, 'config.example.json');

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
    'pixiv-export — 增量备份 Pixiv 收藏元数据',
    '',
    '用法:',
    '  node src/cli.mjs sync [选项]          同步收藏（默认增量）',
    '  node src/cli.mjs download --id 1-5    下载指定序号的作品',
    '  node src/cli.mjs status               查看本地备份概况',
    '  node src/cli.mjs check                检查代理与 cookie 是否可用',
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
    '',
    '认证:',
    '  把浏览器登录 pixiv 后的 cookie 写入 .secrets/cookies.txt，',
    '  或设置环境变量 PIXIV_COOKIE，或在 config.json 里填 cookie。',
    '  最省事的写法是只放 PHPSESSID 的值，程序会自动补全。',
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

async function buildClient(config, flags) {
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

  const limiter = new RateLimiter(intervalMs);
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
function buildChannels(config, flags) {
  const wantIllust = !flags['novel-only'];
  const wantNovel = config.includeNovels && !flags['illust-only'];
  const wantPublic = !flags['private-only'];
  const wantPrivate = !flags['public-only'];

  const channels = [];

  if (wantIllust) {
    if (wantPublic) {
      channels.push({
        kind: 'illust',
        visibility: 'public',
        label: '插画/漫画·公开',
        file: config.output.illustPublic,
      });
    }
    if (wantPrivate) {
      channels.push({
        kind: 'illust',
        visibility: 'private',
        label: '插画/漫画·私密',
        file: config.output.illustPrivate,
      });
    }
  }

  if (wantNovel) {
    if (wantPublic) {
      channels.push({
        kind: 'novel',
        visibility: 'public',
        label: '小说·公开',
        file: config.output.novelPublic,
      });
    }
    if (wantPrivate) {
      channels.push({
        kind: 'novel',
        visibility: 'private',
        label: '小说·私密',
        file: config.output.novelPrivate,
      });
    }
  }

  return channels.filter((channel) => Boolean(channel.file));
}

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
async function syncTagsForChannel(client, { entry, config, filePath, flags, sourceTotal }) {
  const cacheDir = path.resolve(PROJECT_ROOT, config.bookmarkTags.cacheDir);

  const { map, stats } = await updateBookmarkTagMap(client, {
    kind: entry.kind,
    visibility: entry.visibility,
    cacheDir,
    limit: Number(config.pageSize[entry.kind] ?? 100),
    force: Boolean(flags['rebuild-tags']),
    onProgress: (event) => {
      // 868 个标签逐个打印太吵，每 20 个报一次进度
      if (event.index % 20 === 0 || event.index === event.total) {
        console.log(
          `    标签扫描 ${event.index}/${event.total}（当前「${event.tag}」）已映射 ${event.mapped} 个作品`,
        );
      }
    },
  });

  if (stats.truncated) {
    console.log('    注意：Pixiv 标记了 tooManyBookmarkTags，可能有标签没返回。');
  }

  if (stats.reused) {
    console.log(`    收藏标签：缓存有效（${stats.tags} 个标签），未产生额外请求`);
  } else {
    console.log(
      `    收藏标签：扫描 ${stats.scannedTags} 个标签 / ${stats.requests} 次请求，映射 ${stats.mapped} 个作品`,
    );
  }

  const changed = await applyBookmarkTags(filePath, map, {
    kindLabel: entry.label,
    lastSync: new Date().toISOString().replace('T', ' ').slice(0, 19),
    sourceTotal: sourceTotal || undefined,
  });

  if (changed > 0) {
    console.log(`    收藏标签：${changed} 条记录已更新`);
  }

  return { changed, stats };
}

async function commandSync(flags) {
  const config = await loadConfig();
  const { client, intervalMs } = await buildClient(config, flags);
  const full = Boolean(flags.full);
  const dryRun = Boolean(flags['dry-run']);

  console.log(`代理: ${config.proxy}   请求间隔: ${intervalMs}ms   模式: ${full ? '全量' : '增量'}${dryRun ? '（演练）' : ''}`);

  const userId = await client.resolveUserId();
  console.log(`账号 userId: ${userId}\n`);

  const channels = buildChannels(config, flags);

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
      onProgress: printProgress,
    });
    results.push(result);

    if (wantTags) {
      await syncTagsForChannel(client, {
        entry,
        config,
        filePath,
        flags,
        sourceTotal: result.total,
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
  const { client } = await buildClient(config, flags);

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
  console.log('');

  if (usable.length === 0) return 0;

  const imageLimiter = new RateLimiter(imageInterval);
  const startedAt = Date.now();

  const summary = await downloadRecords(client, {
    records: usable,
    outDir,
    quality,
    keepOriginal,
    dryRun,
    imageLimiter,
    proxy: config.proxy,
    onProgress: (event) => {
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
    if (err instanceof PixivError) {
      console.error(`\nPixiv 接口出错：${err.message}`);
      if (err.hint) console.error(`建议：${err.hint}`);
      process.exit(1);
    }
    console.error(`\n出错了：${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });

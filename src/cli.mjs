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
  pageSize: { illust: 48, novel: 24 },
  maxPagesPerRun: 0,
  includeVolatileStats: false,
  output: {
    illust: 'data/bookmarks-illust.txt',
    novel: 'data/bookmarks-novel.txt',
  },
  downloadImages: false,
  imagesDir: 'images',
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
    output: { ...DEFAULT_CONFIG.output, ...(raw.output ?? {}) },
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
    '  node src/cli.mjs sync [选项]     同步收藏（默认增量）',
    '  node src/cli.mjs status          查看本地备份概况',
    '  node src/cli.mjs check           检查代理与 cookie 是否可用',
    '',
    'sync 选项:',
    '  --full               全量同步：翻完所有页，能发现取消收藏与字段变更',
    '  --dry-run            只抓取并报告差异，不写入文件',
    '  --illust-only        只同步插画/漫画',
    '  --novel-only         只同步小说',
    '  --max-pages N        本次每类最多抓 N 页',
    '  --interval MS        覆盖请求间隔（默认 2000，不建议低于 2000）',
    '  --stats              连带记录收藏数/点赞数等易变字段（会让 diff 变吵）',
    '  --download           下载作品图片（尚未实现，仅占位）',
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
  out.push(
    `  新增 ${result.added.length} 条 · 取消 ${result.removed.length} 条 · 字段变更 ${result.changed.length} 条`,
  );

  if (result.added.length > 0) {
    out.push('  新增预览:');
    for (const record of result.added.slice(0, 8)) {
      out.push(`    + ${record.id} 《${record.title || '(无题)'}》 — ${record.author || '未知作者'}`);
    }
    if (result.added.length > 8) out.push(`    … 另有 ${result.added.length - 8} 条`);
  }

  if (result.removed.length > 0) {
    out.push('  已取消收藏:');
    for (const record of result.removed.slice(0, 8)) {
      out.push(`    - ${record.id} 《${record.title || '(无题)'}》`);
    }
    if (result.removed.length > 8) out.push(`    … 另有 ${result.removed.length - 8} 条`);
  }

  if (result.changed.length > 0) {
    out.push('  字段变更:');
    for (const item of result.changed.slice(0, 5)) {
      const keys = item.fields.map((f) => f.key).join(', ');
      out.push(`    ~ ${item.id} (${keys})`);
    }
    if (result.changed.length > 5) out.push(`    … 另有 ${result.changed.length - 5} 条`);
  }

  console.log(out.join('\n'));
}

async function commandSync(flags) {
  if (flags.download) {
    console.log('提示：--download 仅作占位，图片下载功能尚未实现。本次只同步元数据。\n');
  }

  const config = await loadConfig();
  const { client, intervalMs } = await buildClient(config, flags);
  const full = Boolean(flags.full);
  const dryRun = Boolean(flags['dry-run']);

  console.log(`代理: ${config.proxy}   请求间隔: ${intervalMs}ms   模式: ${full ? '全量' : '增量'}${dryRun ? '（演练）' : ''}`);

  const userId = await client.resolveUserId();
  console.log(`账号 userId: ${userId}\n`);

  const kinds = [];
  if (!flags['novel-only']) {
    kinds.push({ kind: 'illust', label: '插画/漫画', file: config.output.illust });
  }
  if (config.includeNovels && !flags['illust-only']) {
    kinds.push({ kind: 'novel', label: '小说', file: config.output.novel });
  }

  if (kinds.length === 0) {
    console.log('没有需要同步的收藏类型。');
    return 0;
  }

  const results = [];
  for (const entry of kinds) {
    const result = await syncKind(client, {
      kind: entry.kind,
      label: entry.label,
      filePath: path.resolve(PROJECT_ROOT, entry.file),
      limit: Number(config.pageSize[entry.kind] ?? (entry.kind === 'novel' ? 24 : 48)),
      full,
      dryRun,
      maxPages: Number(flags['max-pages'] ?? config.maxPagesPerRun ?? 0),
      includePrivate: Boolean(config.includePrivateBookmarks),
      includeVolatileStats: Boolean(flags.stats ?? config.includeVolatileStats),
      onProgress: printProgress,
    });
    results.push(result);
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

async function commandStatus() {
  const config = await loadConfig();
  const entries = [
    { label: '插画/漫画', file: config.output.illust },
    { label: '小说', file: config.output.novel },
  ];

  console.log('本地备份概况\n');
  let total = 0;

  for (const entry of entries) {
    const absolute = path.resolve(PROJECT_ROOT, entry.file);
    const records = await readRecords(absolute);
    total += records.length;

    let statLine = '';
    try {
      const stat = await fs.stat(absolute);
      statLine = `  文件: ${relativeToRoot(absolute)}（${(stat.size / 1024).toFixed(1)} KB，更新于 ${stat.mtime.toLocaleString()}）`;
    } catch {
      statLine = '  文件: 尚未生成';
    }

    console.log(`── ${entry.label} ──`);
    console.log(`  记录数: ${records.length}`);
    console.log(statLine);

    if (records.length > 0) {
      const newest = records.reduce((a, b) => (Number(a.id) > Number(b.id) ? a : b));
      console.log(`  最新作品: ${newest.id} 《${newest.title || '(无题)'}》`);
      const seenDates = records.map((r) => r.first_seen).filter(Boolean).sort();
      if (seenDates.length > 0) {
        console.log(`  记录跨度: ${seenDates[0]} ~ ${seenDates[seenDates.length - 1]}`);
      }
    }
    console.log('');
  }

  console.log(`合计 ${total} 条记录。`);
  return 0;
}

async function commandCheck(flags) {
  const config = await loadConfig();
  const { client, intervalMs } = await buildClient(config, flags);

  console.log(`1. 配置读取正常（代理 ${config.proxy}，间隔 ${intervalMs}ms）`);

  const userId = await client.resolveUserId();
  console.log(`2. 代理与 cookie 可用，账号 userId = ${userId}`);

  const page = await client.fetchBookmarkPage('illust', 0, {
    limit: 1,
    includePrivate: Boolean(config.includePrivateBookmarks),
  });
  console.log(`3. 收藏接口可达，服务端插画收藏总数 = ${page.total}`);

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

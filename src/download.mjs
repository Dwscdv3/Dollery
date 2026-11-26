/**
 * 作品下载。
 *
 * 三类内容各自一套流程：
 *   插画/漫画 —— 逐页抓原图，用 ImageMagick 压成 AVIF(q50)，然后删掉原图
 *   动图 ugoira —— 原样保存官方 zip，不转码（多帧 AVIF 兼容性差，且用户选择先存 zip）
 *   小说 —— 抓正文存成 .txt
 *
 * 两个必须守住的点：
 *   1. i.pximg.net 会校验 Referer，不带 https://www.pixiv.net/ 直接 403。
 *   2. 图片下载走独立限速器，和接口请求分开 —— 接口 2 秒是怕被限流，
 *      CDN 没必要那么慢，否则下几百张图要等到天亮。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { httpsGet, httpsGetWithRetry } from './http.mjs';

const REFERER = 'https://www.pixiv.net/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class DownloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DownloadError';
  }
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      reject(
        new DownloadError(
          `无法启动 ${command}：${err.message}\n` +
            `  图片压缩依赖 ImageMagick，请确认已安装且 magick 命令在 PATH 中。`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new DownloadError(`${command} 退出码 ${code}：${stderr.slice(0, 300)}`));
      }
    });
  });
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 从 URL 里取扩展名，取不到就按 jpg 处理（Pixiv 绝大多数原图是 jpg/png）。 */
function extensionOf(url) {
  try {
    const ext = path.extname(new URL(url).pathname).replace('.', '').toLowerCase();
    return ext || 'jpg';
  } catch {
    return 'jpg';
  }
}

/**
 * 下载单个作品。返回 { files, skipped, originalBytes, finalBytes, kind }。
 */
async function downloadOne(client, record, ctx) {
  const { outDir, tmpDir, imageLimiter, proxy, quality, keepOriginal, dryRun, firstPageOnly } = ctx;
  const result = { files: [], skipped: 0, originalBytes: 0, finalBytes: 0, kind: record.type };

  const saveBinary = async (url, target) => {
    if (await fileExists(target)) {
      result.skipped += 1;
      return false;
    }
    if (dryRun) return false;

    const res = await imageLimiter.run(() =>
      httpsGetWithRetry(url, {
        proxy,
        binary: true,
        timeoutMs: 120000,
        headers: { Referer: REFERER, 'User-Agent': USER_AGENT, Accept: 'image/*,*/*' },
      }),
    );
    if (res.status !== 200) throw new DownloadError(`HTTP ${res.status}`);
    await fs.writeFile(target, res.buffer);
    result.originalBytes += res.bytes;
    result.files.push(target);
    return true;
  };

  // ---- 小说：抓正文存 txt ----
  if (record.type === 'novel') {
    const target = path.join(outDir, `${record.pid}.txt`);
    if (await fileExists(target)) {
      result.skipped += 1;
      return result;
    }
    if (dryRun) return result;

    const body = await client.ajax(`/ajax/novel/${record.pid}`, { lang: 'zh' });
    const content = body.content ?? '';
    // 详情接口不返回字数，用收藏记录里的值，实在没有就按正文字符数算。
    const wordCount = record.text_length || content.replace(/\s/g, '').length;
    const header = [
      `# ${body.title ?? record.title}`,
      `# 作者: ${body.userName ?? record.author}`,
      `# 作品: https://www.pixiv.net/novel/show.php?id=${record.pid}`,
      `# 字数: ${wordCount}`,
      '',
    ].join('\n');
    const text = `${header}${content}\n`;
    await fs.writeFile(target, text, 'utf8');
    const size = Buffer.byteLength(text, 'utf8');
    result.originalBytes += size;
    result.finalBytes += size;
    result.files.push(target);
    return result;
  }

  // ---- 动图：原样保存官方 zip ----
  if (record.type === 'ugoira') {
    const target = path.join(outDir, `${record.pid}_ugoira.zip`);
    const meta = await client.ajax(`/ajax/illust/${record.pid}/ugoira_meta`, { lang: 'zh' });
    const url = meta.originalSrc ?? meta.src;
    if (!url) throw new DownloadError('ugoira_meta 没有返回下载地址');

    const saved = await saveBinary(url, target);
    if (saved) {
      const stat = await fs.stat(target);
      result.finalBytes += stat.size;
    }
    return result;
  }

  // ---- 插画/漫画：逐页下载再压 AVIF ----
  const pages = await client.ajax(`/ajax/illust/${record.pid}/pages`, { lang: 'zh' });
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new DownloadError('pages 接口没有返回任何页面');
  }

  // 浏览器的网格只用第一页做缩略图，所以默认只下首张；
  // 其余页等用户真的翻到大图那一页时再按需取，省空间也省时间。
  const pageCount = firstPageOnly ? 1 : pages.length;

  for (let index = 0; index < pageCount; index += 1) {
    const url = pages[index]?.urls?.original;
    if (!url) continue;

    const target = path.join(outDir, `${record.pid}_p${index}.avif`);
    if (await fileExists(target)) {
      result.skipped += 1;
      continue;
    }
    if (dryRun) continue;

    const tempFile = path.join(tmpDir, `${record.pid}_p${index}.${extensionOf(url)}`);
    const res = await imageLimiter.run(() =>
      httpsGetWithRetry(url, {
        proxy,
        binary: true,
        timeoutMs: 180000,
        headers: { Referer: REFERER, 'User-Agent': USER_AGENT, Accept: 'image/*,*/*' },
      }),
    );
    if (res.status !== 200) throw new DownloadError(`HTTP ${res.status}`);

    await fs.writeFile(tempFile, res.buffer);
    result.originalBytes += res.bytes;

    try {
      await runProcess('magick', [tempFile, '-quality', String(quality), target]);
    } finally {
      // 清理失败不能当成下载失败 —— 成品已经写好了，原图残留最多占点空间，
      // 一轮 rm 抛错就把整个作品判失败是不合理的。
      if (!keepOriginal) {
        try {
          await fs.rm(tempFile, { force: true });
        } catch {
          /* 留给下次清理 */
        }
      }
    }

    const stat = await fs.stat(target);
    result.finalBytes += stat.size;
    result.files.push(target);
  }

  return result;
}

/**
 * 批量下载一批记录。
 *
 * `tempDir` 传入时由调用方负责清理 —— 队列式调用（比如查看器连续下载几十个作品）
 * 不该每下完一个就把临时目录建了又删，那样既浪费又容易撞上系统/沙箱的删除限制。
 */
export async function downloadRecords(client, options) {
  const {
    records,
    outDir,
    quality = 50,
    keepOriginal = false,
    dryRun = false,
    imageLimiter,
    proxy,
    onProgress,
    tempDir,
    firstPageOnly = false,
  } = options;

  await fs.mkdir(outDir, { recursive: true });

  const managesTemp = !tempDir;
  const tmpDir = tempDir ?? path.join(outDir, '.tmp');
  if (!dryRun) await fs.mkdir(tmpDir, { recursive: true });

  const summary = {
    total: records.length,
    ok: 0,
    failed: 0,
    skipped: 0,
    files: 0,
    filePaths: [],
    originalBytes: 0,
    finalBytes: 0,
    errors: [],
  };

  try {
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      const label = `#${record.id} pid=${record.pid}`;

      if (onProgress) await onProgress({ phase: 'start', index: i, total: records.length, record, label });

      try {
        const result = await downloadOne(client, record, {
          outDir,
          tmpDir,
          imageLimiter,
          proxy,
          quality,
          keepOriginal,
          dryRun,
          firstPageOnly,
        });

        summary.ok += 1;
        summary.skipped += result.skipped;
        summary.files += result.files.length;
        summary.filePaths.push(...result.files);
        summary.originalBytes += result.originalBytes;
        summary.finalBytes += result.finalBytes;

        if (onProgress) {
          await onProgress({ phase: 'done', index: i, total: records.length, record, label, result });
        }
      } catch (err) {
        // 守卫的拦截是「整个任务必须停」，不能被当成单个作品的失败吞掉：
        // 否则每日上限会用「每个作品都失败一次」的方式跑完剩余队列。
        if (err?.name === 'GuardTripped' || err?.name === 'DailyLimitReached') throw err;

        summary.failed += 1;
        summary.errors.push({ record, message: err.message });
        if (onProgress) {
          await onProgress({ phase: 'fail', index: i, total: records.length, record, label, message: err.message });
        }
      }
    }
  } finally {
    // 临时目录由调用方提供时，清理由它负责
    if (managesTemp && !dryRun) await fs.rm(tmpDir, { recursive: true, force: true });
  }

  return summary;
}

export { formatBytes };

/**
 * 只下载某一页。
 *
 * 配合「默认只下首张」使用：用户在大图里翻到第 N 页时，才去取那一页。
 * 和批量下载共用同一套限速、重试和压缩参数。
 */
export async function downloadSinglePage(client, options) {
  const {
    pid,
    page,
    outDir,
    tmpDir,
    imageLimiter,
    proxy,
    quality = 50,
    keepOriginal = false,
    // 用户正盯着这一页看，所以这次请求不等队列的随机休息（其它请求照等）
    bypassPacer = false,
  } = options;

  const pages = await client.ajax(`/ajax/illust/${pid}/pages`, { lang: 'zh' }, { bypassPacer });
  if (!Array.isArray(pages) || !pages[page]) {
    throw new DownloadError(`第 ${page} 页不存在（共 ${Array.isArray(pages) ? pages.length : 0} 页）`);
  }

  const url = pages[page].urls?.original;
  if (!url) throw new DownloadError(`第 ${page} 页没有原图地址`);

  const target = path.join(outDir, `${pid}_p${page}.avif`);
  const tempFile = path.join(tmpDir, `${pid}_p${page}.${extensionOf(url)}`);

  const res = await imageLimiter.run(
    () =>
      httpsGetWithRetry(url, {
        proxy,
        binary: true,
        timeoutMs: 180000,
        headers: { Referer: REFERER, 'User-Agent': USER_AGENT, Accept: 'image/*,*/*' },
      }),
    { bypassPacer },
  );
  if (res.status !== 200) throw new DownloadError(`HTTP ${res.status}`);

  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(tempFile, res.buffer);

  try {
    await runProcess('magick', [tempFile, '-quality', String(quality), target]);
  } finally {
    if (!keepOriginal) {
      try {
        await fs.rm(tempFile, { force: true });
      } catch {
        /* 留给下次清理 */
      }
    }
  }

  return target;
}

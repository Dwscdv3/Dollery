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
 * 防封号守卫。
 *
 * 背景（来自 PixivBatchDownloader 的「过度访问警告」笔记，
 * https://github.com/xuejianxianzun/PixivBatchDownloader/blob/master/notes/过度访问警告.md）：
 * pixiv 会在短时间大量下载/抓取后发一封警告站内信，第二次警告很可能直接冻结关注与收藏功能，
 * 再往后有删号的案例。警告是**延迟**发出的（实测 1 小时内到 7 小时都有），所以不能靠
 * 请求失败来判断，只能主动去查站内信。
 *
 * 这个模块做三件事：
 *   1. 记账 —— 累计自上次检查以来的下载文件数和请求数
 *   2. 巡检 —— 达到阈值（默认 100 个文件 / 300 次请求，且距上次 ≥200 秒）就查一次
 *      最近收到的站内信（/rpc/index.php?mode=latest_message_threads2）
 *   3. 拦截 —— 命中警告就落盘一条禁令，之后所有任务直接拒绝，直到手动 resume
 *
 * 另外按天限制下载量：pixiv 惩罚的是「请求频次」而不是单纯的体积（几百 MB 的
 * 几千个小说文件同样危险），所以按文件数计更贴近真实风险。
 *
 * 判定警告邮件的方式刻意只用不随语言变化的特征：发件人是「pixiv事務局」且
 * is_official，正文里含使用条款域名和条款号「14」。用中文关键词判断会在
 * 日语/英语账号上失效。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const FORMAT = 'pixiv-export/guard/1';

/** 只认这段时间内收到的警告：更早的属于「历史记录」，不该拦今天的任务 */
const WARN_WINDOW_MS = 3600 * 1000;

export class GuardTripped extends Error {
  constructor(message, { warning = null } = {}) {
    super(message);
    this.name = 'GuardTripped';
    this.warning = warning;
  }
}

export class DailyLimitReached extends Error {
  constructor(message, { daily } = {}) {
    super(message);
    this.name = 'DailyLimitReached';
    this.daily = daily;
  }
}

export const DEFAULT_GUARD = {
  enabled: true,
  // 距上次检查新增多少才轮到下一次巡检
  checkEveryFiles: 100,
  checkEveryRequests: 300,
  // 两次巡检的最小间隔，避免阈值设得很小后每几个文件就查一次
  minCheckIntervalMs: 200_000,
  // 每天最多下多少个文件（0 = 不限）。几千个小文件同样会触发警告，
  // 所以按文件数而不是体积来算。
  dailyFileLimit: 2000,
  // 每天最多下多少字节（0 = 不限）。文档里提到短期 50GB 是个可能的上限，需要时自己填。
  dailyByteLimit: 0,
};

function localDate(now = new Date()) {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

function blankState() {
  return {
    format: FORMAT,
    warnedAt: null,
    warning: null,
    lastCheckAt: null,
    sinceCheck: { files: 0, requests: 0 },
    daily: { date: localDate(), files: 0, bytes: 0 },
  };
}

/** 在最近收到的站内信里找警告。返回命中的那条，或 null。 */
function findWarning(payload, now = Date.now()) {
  const threads = payload?.body?.message_threads;
  if (!Array.isArray(threads)) return null;

  for (const thread of threads) {
    // 发件人名字是固定的，不随界面语言变化
    if (thread?.thread_name !== 'pixiv事務局') continue;
    if (thread.is_official !== true) continue;

    const content = String(thread.latest_content ?? '');
    // 正文会跟随用户语言，所以只认条款域名和条款号，不认任何自然语言关键词
    if (!content.includes('policies.pixiv.net')) continue;
    if (!content.includes('14')) continue;

    const atMs = Number(thread.modified_at) * 1000;
    if (!Number.isFinite(atMs)) continue;
    if (now - atMs > WARN_WINDOW_MS) continue; // 一小时以前的，当作历史记录放过

    return {
      threadId: String(thread.thread_id ?? ''),
      at: new Date(atMs).toISOString(),
      excerpt: content.replace(/\s+/g, ' ').slice(0, 240),
    };
  }

  return null;
}

/**
 * @param {object} options
 * @param {import('./pixiv.mjs').PixivClient|null} options.client 查询站内信要发请求，resume/status 时可为 null
 * @param {object} options.statePath 状态落盘路径
 * @param {object} [options.thresholds] 覆盖 DEFAULT_GUARD
 * @param {(text: string) => void} [options.log]
 */
export function createGuard({ client = null, statePath, thresholds = {}, log = () => {} }) {
  const settings = { ...DEFAULT_GUARD, ...thresholds };
  const listeners = new Set();

  let state = null; // 内存里的账本，懒加载
  let dirty = false;
  let sinceSave = 0;
  let lastSaveMs = 0; // 本进程最后一次写盘的时间，用来判断文件是不是被别的进程改过
  let checking = null; // 正在进行的巡检，避免并发重复查

  async function load() {
    if (state) return state;
    try {
      const text = await fs.readFile(statePath, 'utf8');
      const parsed = JSON.parse(text);
      state = parsed?.format === FORMAT ? { ...blankState(), ...parsed } : blankState();
    } catch {
      state = blankState();
    }
    return state;
  }

  async function save(force = false) {
    if (!dirty) return;
    // 每写 10 次落一次盘就够了：崩了最多丢 10 个文件的计数，
    // 但省掉每下完一张图就 fs.writeFile 一次。
    sinceSave += 1;
    if (!force && sinceSave < 10) return;

    try {
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      dirty = false;
      sinceSave = 0;
      lastSaveMs = Date.now();
    } catch (err) {
      log(`守卫状态写入失败：${err.message}`);
    }
  }

  function rollDaily() {
    const today = localDate();
    if (state.daily.date !== today) {
      state.daily = { date: today, files: 0, bytes: 0 };
      dirty = true;
    }
  }

  function notify() {
    const snapshot = status();
    for (const fn of listeners) {
      try {
        fn(snapshot);
      } catch {
        /* 监听器出错不该影响守卫本身 */
      }
    }
  }

  function status() {
    const s = state ?? blankState();
    // 跨天时在这里就地翻篇：界面问「今天还能下多少」应该看到新的额度
    if (state) rollDaily();

    const overFiles = settings.dailyFileLimit > 0 && s.daily.files >= settings.dailyFileLimit;
    const overBytes = settings.dailyByteLimit > 0 && s.daily.bytes >= settings.dailyByteLimit;

    return {
      blocked: Boolean(s.warnedAt),
      warnedAt: s.warnedAt,
      warning: s.warning,
      lastCheckAt: s.lastCheckAt,
      overall: s.sinceCheck,
      daily: s.daily,
      dailyExhausted: overFiles || overBytes,
      limits: {
        dailyFileLimit: settings.dailyFileLimit,
        dailyByteLimit: settings.dailyByteLimit,
        checkEveryFiles: settings.checkEveryFiles,
        checkEveryRequests: settings.checkEveryRequests,
        minCheckIntervalMs: settings.minCheckIntervalMs,
      },
    };
  }

  function blockedError() {
    const when = state.warnedAt ? new Date(state.warnedAt).toLocaleString('zh-CN') : '未知时间';
    return new GuardTripped(
      [
        `检测到 pixiv 的过度访问警告（${when}），已停止执行。`,
        '继续跑下去可能让账号被冻结甚至删除，所以这个拦截只能手动解除：',
        '',
        '  node src/cli.mjs guard     # 查看详情',
        '  node src/cli.mjs resume    # 确认风险后解除',
        '',
        '建议至少隔几天再恢复，并把 config.json 里的 intervalMs 调大。',
      ].join('\n'),
      { warning: state.warning },
    );
  }

  /** 有禁令就直接拒绝。每个会发请求的命令开头都该调一次。 */
  async function assertAllowed() {
    const s = await load();
    if (s.warnedAt) throw blockedError();
  }

  async function checkNow() {
    if (!settings.enabled || !client) return null;
    if (checking) return checking;

    checking = (async () => {
      const s = await load();

      let payload = null;
      try {
        payload = await client.fetchRecentMessages(3);
      } catch (err) {
        // 查不到不影响任务，但要说一声，免得以为守卫在正常工作
        log(`守卫巡检失败（忽略）：${err.message}`);
        return null;
      }

      s.lastCheckAt = new Date().toISOString();
      s.sinceCheck = { files: 0, requests: 0 };
      dirty = true;

      const hit = findWarning(payload);
      if (hit) {
        s.warnedAt = new Date().toISOString();
        s.warning = hit;
        dirty = true;
        await save(true);
        notify();
        throw new GuardTripped(
          [
            '',
            '⚠️  检测到 pixiv 的「过度访问警告」站内信',
            `    收到时间：${new Date(hit.at).toLocaleString('zh-CN')}`,
            '',
            '    再被警告一次，账号可能被限制关注/收藏，甚至直接删除。',
            '    已停止当前任务并写入禁令，需手动解除：',
            '',
            '      node src/cli.mjs guard     # 查看详情',
            '      node src/cli.mjs resume    # 解除',
            '',
          ].join('\n'),
          { warning: hit },
        );
      }

      await save(true);
      log(`守卫巡检：最近消息里没有警告（自上次检查累计 ${s.sinceCheck.files} 个文件）`);
      return null;
    })().finally(() => {
      checking = null;
    });

    return checking;
  }

  /**
   * 记账。每下完一个文件、每发一次请求都该调它。
   *
   * 达到巡检阈值会在这里 await 一次网络请求（约 2 秒），所以调用点要能 await。
   * 命中警告会抛出 GuardTripped，调用方应当中断任务。
   */
  async function bump({ files = 0, bytes = 0, requests = 0 } = {}) {
    const s = await load();
    if (s.warnedAt) throw blockedError();

    rollDaily();

    if (files > 0 || bytes > 0) {
      s.daily.files += files;
      s.daily.bytes += bytes;
      s.sinceCheck.files += files;
      dirty = true;
    }
    if (requests > 0) {
      s.sinceCheck.requests += requests;
      dirty = true;
    }

    // 每日上限：命中就直接抛，让调用方停下今天的任务
    const overFiles = settings.dailyFileLimit > 0 && s.daily.files >= settings.dailyFileLimit;
    const overBytes = settings.dailyByteLimit > 0 && s.daily.bytes >= settings.dailyByteLimit;

    if (overFiles || overBytes) {
      await save(true);
      const reason = overFiles
        ? `今日已下载 ${s.daily.files} 个文件（上限 ${settings.dailyFileLimit}）`
        : `今日已下载 ${(s.daily.bytes / 1024 ** 3).toFixed(2)} GB（上限 ${(settings.dailyByteLimit / 1024 ** 3).toFixed(2)} GB）`;
      throw new DailyLimitReached(
        `${reason}，已达今日上限。明天再继续，或调大 config.json 里 guard 的额度。`,
        { daily: s.daily },
      );
    }

    await save();

    if (!settings.enabled || !client) return null;

    // 巡检节流：阈值够 + 距上次够久
    const sinceLast = s.lastCheckAt ? Date.now() - Date.parse(s.lastCheckAt) : Infinity;
    if (sinceLast < settings.minCheckIntervalMs) return null;

    const enoughFiles = s.sinceCheck.files >= settings.checkEveryFiles;
    const enoughRequests = s.sinceCheck.requests >= settings.checkEveryRequests;
    if (!enoughFiles && !enoughRequests && Number.isFinite(sinceLast)) return null;

    return checkNow();
  }

  async function resume() {
    const s = await load();
    const had = s.warnedAt;
    s.warnedAt = null;
    s.warning = null;
    dirty = true;
    await save(true);
    notify();
    return had;
  }

  /**
   * 从磁盘重新读一次状态。
   *
   * 命令行和查看器是两个进程：命令行那边巡检到警告写了禁令，正在跑的查看器
   * 内存里还是旧的，会继续下载。所以界面每次拉状态前都调一次。
   * 本地有未落盘的账本时不覆盖（那说明本进程才是最权威的）。
   */
  async function refresh() {
    try {
      // 谁最后写的就听谁的：文件比本进程写得晚，说明是另一个进程（比如命令行）改的
      const stat = await fs.stat(statePath);
      if (stat.mtimeMs <= lastSaveMs + 500) return;

      const text = await fs.readFile(statePath, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed?.format !== FORMAT) return;

      state = { ...blankState(), ...parsed };
      dirty = false;
      sinceSave = 0;
    } catch {
      /* 文件还不存在或者写到一半，保持现状 */
    }
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    assertAllowed,
    bump,
    checkNow,
    resume,
    refresh,
    status,
    onChange,
    flush: () => save(true),
    settings,
    load,
  };
}

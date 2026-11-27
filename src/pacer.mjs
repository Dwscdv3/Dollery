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
 * 请求节奏模拟：下了一阵就歇一会儿。
 *
 * 为什么还要这一层 —— 限速器（http.mjs 的 RateLimiter）保证的是「相邻两次请求至少
 * 隔 1~2 秒」，但那是一条永远不会断的直线：机器可以连续八小时匀速每秒一张，人不会。
 * pixiv 判定「过度访问」看的是频次和持续时长，长时间匀速本身就是最显眼的特征，
 * 比单次下载量更可疑。所以这里再叠一层粗粒度的休息。
 *
 * 触发方式：概率触发，而不是攒够固定次数。
 *   每个后台请求独立掷一次骰子，命中概率 pauseChance（默认 1%）就休息一次。
 *   这样「什么时候停」不可预测，也不会出现「每 150 次准时停」这种规律。
 *
 * 休息多久：和「距上次休息已经请求了多少次」挂钩，每个请求给期望时长 +perRequestMs
 *   （默认 5 秒）。也就是请求越多越累，触发时该歇得越久。
 *
 * 计数会随时间回落：每过 decayMs（默认 5 秒）连续请求数减 1，最少到 0。
 *   否则一个跑了一夜、每秒才一个请求的慢任务，计数会一直涨到几千，
 *   一触发就是 90 分钟封顶 —— 但它的实际频次一点也不高。
 *   有了回落，计数更接近「最近的请求密度」而不是「开机以来的总数」。
 *
 * 时长的分布：默认用 Erlang-2（Gamma 分布 shape=2），均值固定为
 *   clamp(请求数 × perRequestMs, 下限, 上限)。
 *   为什么不直接等这么久？固定时长本身又是机器特征。
 *   为什么不用指数分布（shape=1）？它同样无记忆、实现最简单，但尾巴太厚，
 *   偶尔会抽到 4~5 倍期望的休息（期望 20 分钟时来一次 90 分钟），体验很差。
 *   Erlang-2 的方差只有指数分布的一半，均值不变，长尾明显收敛；
 *   shape 调到 3~4 会更「规律」，但规律过头就又像机器了。
 *
 * 计数只放内存：进程重启本身就等于一次空窗期，没必要再跨重启累加。
 *
 * 暂停是「协作式」的：gate() 在限速队列里 await，所有走 limit 的请求都会等着。
 * 但用户手动触发的那一次（点开大图翻页）可以 bypass，否则点一下要等半小时。
 */

const POLL_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function formatDuration(ms) {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;

  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分`;
}

function clockOf(ms) {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export const DEFAULT_PACER = {
  enabled: true,
  // 每个后台请求触发一次休息的概率
  pauseChance: 0.01,
  // 距上次休息每多一个请求，本次休息的期望时长 +5 秒
  perRequestMs: 5000,
  // 连续请求数的回落速度：每过这么久减 1（最少到 0）
  decayMs: 5000,
  // 期望时长的上下限：太短没有意义，太长会把一次任务拖到明天
  minPauseMs: 60 * 1000,
  maxPauseMs: 90 * 60 * 1000,
  // Gamma 分布的形状：1 = 指数分布（长尾），2 = Erlang-2（默认），越大越集中
  shape: 2,
};

export class RequestPacer {
  /**
   * @param {object} [thresholds] 覆盖 DEFAULT_PACER
   * @param {{ log?: (text: string) => void }} [options]
   */
  constructor(thresholds = {}, { log = () => {} } = {}) {
    const settings = { ...DEFAULT_PACER, ...thresholds };

    this.enabled = settings.enabled !== false;
    this.pauseChance = clamp(num(settings.pauseChance, DEFAULT_PACER.pauseChance), 0, 1);
    this.perRequestMs = Math.max(0, num(settings.perRequestMs, DEFAULT_PACER.perRequestMs));
    this.decayMs = Math.max(1000, num(settings.decayMs, DEFAULT_PACER.decayMs));
    this.minPauseMs = Math.max(1000, num(settings.minPauseMs, DEFAULT_PACER.minPauseMs));
    this.maxPauseMs = Math.max(this.minPauseMs, num(settings.maxPauseMs, DEFAULT_PACER.maxPauseMs));
    this.shape = clamp(Math.round(num(settings.shape, DEFAULT_PACER.shape)), 1, 8);

    this.log = log;


    this.count = 0; // 距上次休息已经发了多少个请求（会随时间回落）
    this.decayAt = Date.now(); // 上一次结算回落的时间点
    this.total = 0; // 进程启动以来累计请求数，仅用于展示
    this.pauses = 0;
    this.skips = 0;

    this.pauseStartedAt = null;
    this.pauseEndsAt = null;
    this.pauseMs = 0;
    this.pauseRequests = 0; // 触发这次休息时，已连续请求了多少个
  }

  remainingMs(now = Date.now()) {
    if (this.pauseEndsAt === null) return 0;
    return Math.max(0, this.pauseEndsAt - now);
  }

  /**
   * 结算「随时间回落」：每过 decayMs，连续请求数减 1，最少到 0。
   *
   * 用时间差补算而不是真起一个定时器：进程有没有被挂起、有没有睡过头都不影响结果，
   * 也不用担心定时器在测试里到处留着。计数已经是 0 时把基准时间追到当下，
   * 免得空闲很久之后一发请求就被「补扣」掉。
   */
  decay(now = Date.now()) {
    if (this.count <= 0) {
      this.count = 0;
      this.decayAt = now;
      return 0;
    }

    const steps = Math.floor((now - this.decayAt) / this.decayMs);
    if (steps <= 0) return 0;

    this.decayAt += steps * this.decayMs;
    const before = this.count;
    this.count = Math.max(0, this.count - steps);
    return before - this.count;
  }

  /** 下一次触发时，休息时长的期望值（按当前连续请求数算，已夹在上下限内）。 */
  expectedPauseMs(count = this.count) {
    const raw = Math.max(0, Number(count) || 0) * this.perRequestMs;
    return clamp(raw, this.minPauseMs, this.maxPauseMs);
  }

  /**
   * 按 Erlang-k 抽样：k 个独立指数变量之和，均值保持 mean。
   * k=1 时就是指数分布。
   */
  samplePause(mean = this.expectedPauseMs()) {
    let ms = 0;
    for (let i = 0; i < this.shape; i += 1) {
      ms += -Math.log(1 - Math.random()) * (mean / this.shape);
    }
    return clamp(Math.round(ms), this.minPauseMs, this.maxPauseMs);
  }

  /**
   * 在真正发请求之前 await 一下。命中概率就休息，休息时长见 samplePause()。
   *
   * @param {{ bypass?: boolean }} [options] bypass: 用户手动触发的那一次，只这一次不等
   */
  async gate({ bypass = false } = {}) {
    if (!this.enabled) return;

    this.total += 1;

    // 先把「空闲期间该扣的」扣掉，再决定停不停、歇多久
    this.decay();

    if (bypass) {
      // 手动请求照常计数（风险敞口是一样的），但不等，也不掷骰子：
      // 否则点一下就把整队停半小时。
      this.count += 1;
      return;
    }

    // 可能正处在上一次触发、还没走完的休息里
    await this.waitOutPause();

    // 每个后台请求独立掷一次：命中就休息，否则直接放行
    if (this.pauseChance > 0 && Math.random() < this.pauseChance) {
      this.startPause();
      await this.waitOutPause();
    }

    // 队列有两个 worker：上面这段里另一个 worker 可能刚好开了新的一轮休息，
    // 这里再确认一次，免得有一个请求顺着缝溜出去。
    if (this.remainingMs() > 0) await this.waitOutPause();

    this.count += 1;
  }

  /** 等到休息结束（没有在休息就直接返回）。 */
  async waitOutPause() {
    for (;;) {
      const remaining = this.remainingMs();
      if (remaining <= 0) break;
      // 分段睡，好让「立即继续」能在 1 秒内生效，也方便将来加中断
      await sleep(Math.min(remaining, POLL_MS));
    }
    this.clearPause();
  }

  startPause() {
    const now = Date.now();
    const mean = this.expectedPauseMs(this.count);
    const pauseMs = this.samplePause(mean);

    this.pauseRequests = this.count;
    // 休息完就是新的一轮：连续请求数清零，下一次的期望从下限重新长起来
    this.count = 0;
    this.decayAt = now;

    this.pauseStartedAt = now;
    this.pauseEndsAt = now + pauseMs;
    this.pauseMs = pauseMs;
    this.pauses += 1;

    this.log(
      `已请求 ${this.total} 次，触发随机休息 ${formatDuration(pauseMs)}` +
        `（连续 ${this.pauseRequests} 次，约 ${clockOf(this.pauseEndsAt)} 继续）`,
    );
  }

  clearPause() {
    if (this.pauseEndsAt === null) return;
    this.pauseEndsAt = null;
    this.pauseStartedAt = null;
    this.pauseMs = 0;
    this.log('休息结束，继续请求');
  }

  /** 手动提前结束休息。返回是否真的从休息中恢复。 */
  skip() {
    const remaining = this.remainingMs();
    if (remaining <= 0) return { skipped: false, savedMs: 0 };

    this.skips += 1;
    this.clearPause();
    this.log(`已跳过本次休息（提前 ${formatDuration(remaining)} 继续）`);
    return { skipped: true, savedMs: remaining };
  }

  /**
   * 热改参数：查看器的设置面板保存后立即生效，不用重启。
   *
   * 只处理传进来的那几项，没传的保持原样（不能拿默认值覆盖，否则用户只改一项，
   * 其余全被打回默认）。已经在进行中的那一次休息不受影响。
   *
   * @param {object} partial 形如 { pauseChance: 0.02, shape: 2 }
   */
  applySettings(partial = {}) {
    if ('enabled' in partial) this.enabled = partial.enabled !== false;
    if ('pauseChance' in partial) {
      this.pauseChance = clamp(num(partial.pauseChance, this.pauseChance), 0, 1);
    }
    if ('perRequestMs' in partial) {
      this.perRequestMs = Math.max(0, num(partial.perRequestMs, this.perRequestMs));
    }
    if ('decayMs' in partial) {
      this.decayMs = Math.max(1000, num(partial.decayMs, this.decayMs));
    }
    if ('minPauseMs' in partial) {
      this.minPauseMs = Math.max(1000, num(partial.minPauseMs, this.minPauseMs));
    }
    if ('maxPauseMs' in partial) {
      this.maxPauseMs = Math.max(this.minPauseMs, num(partial.maxPauseMs, this.maxPauseMs));
    }
    if ('shape' in partial) {
      this.shape = clamp(Math.round(num(partial.shape, this.shape)), 1, 8);
    }

    // 两个上下限互相依赖：先改下限的话，上限可能已经比它小了
    this.maxPauseMs = Math.max(this.maxPauseMs, this.minPauseMs);
    return this.status();
  }

  status(now = Date.now()) {
    // 报告前先结算回落，否则面板上的「本轮进度」会比实际偏大
    this.decay(now);

    const remainingMs = this.remainingMs(now);

    return {
      enabled: this.enabled,
      paused: remainingMs > 0,
      remainingMs,
      pausedUntil: remainingMs > 0 ? new Date(this.pauseEndsAt).toISOString() : null,
      pauseMs: this.pauseMs,
      pauseStartedAt: this.pauseStartedAt,
      // 本轮进度：距上次休息已经请求了多少 / 现在触发会歇多久
      count: this.count,
      pauseRequests: this.pauseRequests,
      expectedPauseMs: this.expectedPauseMs(this.count),
      total: this.total,
      pauses: this.pauses,
      skips: this.skips,
      limits: {
        pauseChance: this.pauseChance,
        perRequestMs: this.perRequestMs,
        decayMs: this.decayMs,
        minPauseMs: this.minPauseMs,
        maxPauseMs: this.maxPauseMs,
        shape: this.shape,
      },
    };
  }
}

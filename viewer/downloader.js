/* 下载管理器：全量统计、队列进度、批量入队、完整性校验。
 *
 * 数据全部来自 /api/stats，1.5 秒轮询一次。队列在服务端串行跑，
 * 这个页面只负责展示和下命令。
 */

const els = {
  stats: document.getElementById('stats'),
  barFill: document.getElementById('barFill'),
  queueMeta: document.getElementById('queueMeta'),
  hint: document.getElementById('hint'),
  sources: document.getElementById('sources'),
  btnAll: document.getElementById('btnAll'),
  btnClear: document.getElementById('btnClear'),
  btnVerify: document.getElementById('btnVerify'),
  failCard: document.getElementById('failCard'),
  failCount: document.getElementById('failCount'),
  failList: document.getElementById('failList'),
  verifyCard: document.getElementById('verifyCard'),
  verifyBody: document.getElementById('verifyBody'),
  connState: document.getElementById('connState'),
};

let polling = null;
let lastFailSignature = '';

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function renderStats(data) {
  const sum = data.sources.reduce(
    (acc, s) => {
      acc.total += s.total;
      acc.done += s.done;
      acc.missing += s.missing;
      acc.dead += s.removed + s.unavailable;
      return acc;
    },
    { total: 0, done: 0, missing: 0, dead: 0 },
  );

  els.stats.innerHTML = `
    <div class="dl-stat"><div class="v">${sum.total}</div><div class="k">作品总数</div></div>
    <div class="dl-stat done"><div class="v">${sum.done}</div><div class="k">已下载</div></div>
    <div class="dl-stat missing"><div class="v">${sum.missing}</div><div class="k">待下载</div></div>
    <div class="dl-stat dead"><div class="v">${sum.dead}</div><div class="k">已失效 / 已取消</div></div>
  `;
}

function renderQueue(q) {
  const inFlight = (q.active ? 1 : 0) + q.pending;
  const base = q.processed + inFlight;
  const pct = base > 0 ? Math.round((q.processed / base) * 100) : 0;
  els.barFill.style.width = `${pct}%`;

  const parts = [];
  if (q.active) parts.push(`<span class="now">● 正在下载 ${q.active}</span>`);
  if (q.pending > 0) parts.push(`待处理 ${q.pending}`);
  parts.push(`本次完成 ${q.processed}`);
  if (q.failedCount > 0) parts.push(`失败 ${q.failedCount}`);
  if (!inFlight && q.processed === 0) parts.push('队列空闲');

  els.queueMeta.innerHTML = parts.join('<span class="dl-sep">·</span>');
  els.btnClear.disabled = q.pending === 0 && !q.active;

  // 有任务在跑时按钮禁掉，避免重复入队
  els.btnAll.disabled = inFlight > 0;
}

function renderSources(data) {
  els.sources.innerHTML = data.sources
    .map(
      (s) => `
      <div class="dl-source">
        <div class="top">
          <span class="name">${escapeHtml(s.label)}</span>
          <span class="count">${s.done} / ${s.total}</span>
        </div>
        <button data-source="${s.key}" ${s.missing === 0 ? 'disabled' : ''}>
          ${s.missing === 0 ? '已全部下载' : `下载 ${s.missing} 个`}
        </button>
      </div>`,
    )
    .join('');
}

function renderFails(q) {
  const list = q.failedList ?? [];
  if (list.length === 0) {
    els.failCard.hidden = true;
    lastFailSignature = '';
    return;
  }

  const signature = list.map((item) => item[0]).join(',');
  els.failCard.hidden = false;
  els.failCount.textContent = q.failedCount;
  if (signature === lastFailSignature) return;
  lastFailSignature = signature;

  els.failList.innerHTML = list
    .slice()
    .reverse()
    .map(
      ([pid, msg]) => `
      <li><span class="pid">${escapeHtml(pid)}</span><span class="msg">${escapeHtml(msg)}</span></li>`,
    )
    .join('');
}

function renderVerify(verify) {
  if (!verify.startedAt) {
    els.verifyCard.hidden = true;
    return;
  }

  els.verifyCard.hidden = false;
  const pct = verify.total > 0 ? Math.round((verify.checked / verify.total) * 100) : 0;

  let body = '';
  if (verify.running) {
    body += `<div class="dl-verify-line">正在校验 ${verify.checked} / ${verify.total}（${pct}%）…</div>`;
  } else {
    body += `<div class="dl-verify-line">校验完成：共 ${verify.total} 个文件，损坏 ${verify.broken.length} 个。</div>`;
  }

  if (verify.broken.length > 0) {
    body += `<ul class="dl-broken-list">${verify.broken
      .slice(0, 200)
      .map((name) => `<li>${escapeHtml(name)}</li>`)
      .join('')}</ul>`;
    if (!verify.running) {
      body += '<div class="dl-verify-line" style="margin-top:10px">损坏的文件已从索引移除，会在浏览时重新下载。</div>';
    }
  }

  els.verifyBody.innerHTML = body;
}

async function refresh() {
  try {
    const data = await api('/api/stats');
    els.connState.textContent = '已连接';
    els.connState.className = 'dl-conn ok';

    renderStats(data);
    renderQueue(data.queue);
    renderSources(data);
    renderFails(data.queue);
    renderVerify(data.verify);
  } catch (err) {
    els.connState.textContent = '连接断开';
    els.connState.className = 'dl-conn bad';
  }
}

function startPolling() {
  if (polling) return;
  polling = setInterval(refresh, 1500);
}

function setHint(text, isWarn) {
  els.hint.textContent = text;
  els.hint.className = isWarn ? 'dl-hint warn' : 'dl-hint';
}

// ---------- 操作 ----------

els.btnAll.addEventListener('click', async () => {
  els.btnAll.disabled = true;
  setHint('正在统计并加入队列…');
  try {
    const data = await api('/api/enqueue-all', { method: 'POST' });
    setHint(`已加入 ${data.added} 个作品（候选 ${data.candidates} 个）。队列串行执行，请耐心等待。`);
    startPolling();
    await refresh();
  } catch (err) {
    setHint(`加入队列失败：${err.message}`, true);
    els.btnAll.disabled = false;
  }
});

els.btnClear.addEventListener('click', async () => {
  try {
    const data = await api('/api/queue/clear', { method: 'POST' });
    setHint(`已清空队列，移除 ${data.cleared} 个待处理任务。正在下载的那个会跑完。`);
    await refresh();
  } catch (err) {
    setHint(`清空失败：${err.message}`, true);
  }
});

els.btnVerify.addEventListener('click', async () => {
  els.btnVerify.disabled = true;
  setHint('开始校验，这个过程会逐个读取文件头，文件多时需要一段时间…');
  try {
    await api('/api/verify', { method: 'POST' });
    startPolling();
    await refresh();
  } catch (err) {
    setHint(`启动校验失败：${err.message}`, true);
    els.btnVerify.disabled = false;
  }
});

els.sources.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-source]');
  if (!button) return;

  const source = button.dataset.source;
  button.disabled = true;
  setHint(`正在把「${source}」的未下载作品加入队列…`);

  try {
    const data = await api(`/api/enqueue-all?source=${encodeURIComponent(source)}`, { method: 'POST' });
    setHint(`已加入 ${data.added} 个作品。`);
    startPolling();
    await refresh();
  } catch (err) {
    setHint(`加入队列失败：${err.message}`, true);
    button.disabled = false;
  }
});

refresh();
startPolling();

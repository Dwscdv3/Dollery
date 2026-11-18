/* 收藏查看器前端。
 *
 * 两个要点：
 *   1. 缩略图必须懒加载。服务端每张缩略图要现场调 ImageMagick，浏览器一口气发 6 个
 *      并发请求会让服务端排队，滚动手感立刻崩掉。用 IntersectionObserver 只请求视口内的。
 *   2. 点开作品时若本地没有，自动下载一次（用户要的「按需下载」）。下载期间卡片盖一层
 *      转圈，避免重复触发。
 */

const state = {
  sources: [],
  current: null,
  records: [],
  total: 0,
  offset: 0,
  loading: false,
  tag: '',
  query: '',
  missingOnly: false,
  showRemoved: false,
  observer: null,
  autoDownload: true,
  submitted: new Set(), // 已提交过下载的 pid，防止重复入队
  cardMap: new Map(), // pid -> 卡片元素，用于按队列状态刷新
};

const els = {
  tabs: document.getElementById('tabs'),
  search: document.getElementById('search'),
  tagFilter: document.getElementById('tagFilter'),
  missingOnly: document.getElementById('missingOnly'),
  showRemoved: document.getElementById('showRemoved'),
  autoDownload: document.getElementById('autoDownload'),
  queueState: document.getElementById('queueState'),
  counter: document.getElementById('counter'),
  reload: document.getElementById('reload'),
  grid: document.getElementById('grid'),
  sentinel: document.getElementById('sentinel'),
  statusbar: document.getElementById('statusbar'),
  lightbox: document.getElementById('lightbox'),
  lbStage: document.getElementById('lbStage'),
  lbImage: document.getElementById('lbImage'),
  lbTitle: document.getElementById('lbTitle'),
  lbMeta: document.getElementById('lbMeta'),
  lbZoom: document.getElementById('lbZoom'),
  lbClose: document.getElementById('lbClose'),
  lbPrev: document.getElementById('lbPrev'),
  lbNext: document.getElementById('lbNext'),
};

const PAGE_SIZE = 120;

function setStatus(text) {
  els.statusbar.textContent = text;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- 来源标签 ----------

function renderTabs() {
  els.tabs.innerHTML = '';
  for (const source of state.sources) {
    const btn = document.createElement('button');
    btn.dataset.key = source.key;
    btn.innerHTML = `${source.label}<span class="n">${source.count}</span>`;
    if (source.key === state.current) btn.classList.add('active');
    btn.addEventListener('click', () => switchSource(source.key));
    els.tabs.appendChild(btn);
  }
}

function switchSource(key) {
  if (key === state.current) return;
  state.current = key;
  state.tag = '';
  els.tagFilter.value = '';
  for (const btn of els.tabs.children) {
    btn.classList.toggle('active', btn.dataset.key === key);
  }
  loadTags();
  reloadAll();
}

// ---------- 数据加载 ----------

async function loadState() {
  const data = await api('/api/state');
  state.sources = data.sources;

  // 支持 ?source=illustPrivate 直达某个收藏夹
  const fromUrl = new URLSearchParams(location.search).get('source');
  if (fromUrl && data.sources.some((s) => s.key === fromUrl)) {
    state.current = fromUrl;
  }

  if (!state.current) {
    const firstWithData = data.sources.find((s) => s.count > 0) ?? data.sources[0];
    state.current = firstWithData?.key ?? 'illustPublic';
  }
  renderTabs();
}

async function loadTags() {
  try {
    const data = await api(`/api/tags?source=${encodeURIComponent(state.current)}`);
    const options = ['<option value="">全部收藏标签</option>'];
    for (const item of data.tags) {
      options.push(`<option value="${escapeHtml(item.tag)}">${escapeHtml(item.tag)} (${item.count})</option>`);
    }
    els.tagFilter.innerHTML = options.join('');
    els.tagFilter.value = state.tag;
  } catch {
    els.tagFilter.innerHTML = '<option value="">全部收藏标签</option>';
  }
}

function buildQuery(offset) {
  const params = new URLSearchParams({
    source: state.current,
    offset: String(offset),
    limit: String(PAGE_SIZE),
  });
  if (state.query) params.set('q', state.query);
  if (state.tag) params.set('tag', state.tag);
  if (state.missingOnly) params.set('missing', '1');
  if (state.showRemoved) params.set('removed', '1');
  return `/api/records?${params}`;
}

async function loadPage(reset) {
  if (state.loading) return;
  state.loading = true;
  setStatus('加载中…');

  try {
    if (reset) {
      state.offset = 0;
      state.records = [];
      state.cardMap.clear();
      els.grid.innerHTML = '';
    }

    const data = await api(buildQuery(state.offset));
    state.total = data.total;

    if (reset && data.items.length === 0) {
      els.grid.innerHTML = '<div class="empty">这个筛选条件下没有作品。</div>';
    }

    state.records.push(...data.items);
    state.offset += data.items.length;

    for (const record of data.items) {
      els.grid.appendChild(createCard(record));
    }

    updateCounter();
    setStatus(
      data.items.length === 0
        ? '没有更多了'
        : `已显示 ${state.records.length} / ${state.total} 条`,
    );
  } catch (err) {
    setStatus(`加载失败：${err.message}`);
  } finally {
    state.loading = false;
  }
}

function updateCounter() {
  els.counter.textContent = `${state.records.length} / ${state.total}`;
}

function reloadAll() {
  loadPage(true);
}

// ---------- 卡片 ----------

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function createCard(record) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.pid = record.pid;
  card.dataset.id = record.id;
  renderCardInner(card, record);
  card.addEventListener('click', () => openLightbox(record, card));
  state.cardMap.set(String(record.pid), card);

  // 懒加载 + 自动入队：同一份可见性判断做两件事
  if (!state.observer) {
    state.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          state.observer.unobserve(entry.target);

          const img = entry.target.querySelector('img[data-src]');
          if (img) {
            // 淡入效果靠 .loaded 触发，加载失败也要给出可见反馈
            img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
            img.addEventListener(
              'error',
              () => {
                img.classList.add('loaded');
                img.style.opacity = '0.25';
              },
              { once: true },
            );
            img.src = img.dataset.src;
            delete img.dataset.src;
          }

          const target = state.records.find((r) => String(r.pid) === entry.target.dataset.pid);
          if (target) queueForDownload(target);
        }
      },
      { root: els.grid, rootMargin: '400px' },
    );
  }
  state.observer.observe(card);

  return card;
}

function renderCardInner(card, record) {
  const firstPage = record.localPages?.[0] ?? 0;
  const downloadable = record.type === 'illust' || record.type === 'manga';

  let badge = '';
  if (record.removed === 'yes') badge = '<span class="badge danger">已取消</span>';
  else if (record.status === 'unavailable') badge = '<span class="badge warn">已失效</span>';
  else if (record.localUgoira) badge = '<span class="badge">动图</span>';
  else if (record.type === 'novel') badge = '<span class="badge">小说</span>';

  let frame;
  if (record.hasImage && downloadable) {
    const url = `/api/thumb/${record.pid}/${firstPage}`;
    frame = `<img data-src="${url}" alt="">`;
  } else if (record.localNovel) {
    frame = '<div class="placeholder"><span class="icon">📖</span>正文已下载</div>';
  } else if (record.localUgoira) {
    frame = '<div class="placeholder"><span class="icon">🎞</span>动图 zip 已下载</div>';
  } else {
    const failed = Boolean(record.error);
    const icon = failed ? '⚠' : downloadable ? '⬇' : '📄';
    const label = failed ? '下载失败' : downloadable ? '点击下载' : '点击获取';
    frame = `
      <div class="placeholder">
        <span class="icon">${icon}</span>
        <span>${label}</span>
      </div>`;
  }

  const spinner = record.downloading ? '<div class="spinner">下载中</div>' : '';

  card.innerHTML = `
    <div class="frame">${frame}${badge}${spinner}</div>
    <div class="info">
      <div class="title">${escapeHtml(record.title || '(无题)')}</div>
      <div class="sub">#${record.id} · ${escapeHtml(record.author || '未知')}</div>
    </div>
  `;
}

function refreshCard(card, record) {
  renderCardInner(card, record);
  state.observer?.observe(card);
}

// ---------- 自动下载队列 ----------

/* 滚动时把视口内未下载的作品攒一小批再提交，避免每张图一次请求。
   `state.submitted` 是前端侧的防重，服务端还有一层 queued/done/failed 去重。 */

let enqueueBuffer = new Set();
let enqueueTimer = null;

const AUTO_MAX_PAGES = 30; // 与服务端一致：超过这个页数的不自动下载

function queueForDownload(record) {
  if (!state.autoDownload) return;
  if (record.hasImage || record.localNovel || record.localUgoira) return;
  if (record.status === 'unavailable') return;
  if (record.error) return;
  // 大合集自动下会堵住队列好几分钟，留给用户自己点
  if (Number(record.pages) > AUTO_MAX_PAGES) return;

  const pid = String(record.pid);
  if (state.submitted.has(pid)) return;

  state.submitted.add(pid);
  enqueueBuffer.add(pid);

  clearTimeout(enqueueTimer);
  enqueueTimer = setTimeout(flushEnqueue, 120);
}

async function flushEnqueue() {
  if (enqueueBuffer.size === 0) return;

  const pids = [...enqueueBuffer];
  enqueueBuffer.clear();

  try {
    const data = await api('/api/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pids }),
    });
    if (data.added > 0) {
      startPolling();
      applyQueueState(data.queue);
    }
    if (data.skippedLarge > 0) {
      setStatus(`跳过 ${data.skippedLarge} 个页数超过 ${AUTO_MAX_PAGES} 的作品，可点开单独下载`);
    }
  } catch (err) {
    setStatus(`加入下载队列失败：${err.message}`);
  }
}

let pollTimer = null;
let idleTicks = 0;

function startPolling() {
  if (pollTimer) return;
  idleTicks = 0;
  pollTimer = setInterval(pollQueue, 1200);
  pollQueue();
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

async function pollQueue() {
  try {
    const snapshot = await api('/api/queue');
    applyQueueState(snapshot);
    updateQueueLabel(snapshot);

    if (!snapshot.running && snapshot.pending === 0 && !snapshot.active) {
      idleTicks += 1;
      if (idleTicks >= 3) stopPolling();
    } else {
      idleTicks = 0;
    }
  } catch {
    stopPolling();
  }
}

function applyQueueState(snapshot) {
  const done = new Set(snapshot.doneList ?? []);
  const failed = new Map(snapshot.failedList ?? []);
  const active = snapshot.active ? String(snapshot.active) : null;

  for (const record of state.records) {
    const pid = String(record.pid);
    const card = state.cardMap.get(pid);

    if (done.has(pid)) {
      if (!record.hasImage) {
        record.hasImage = true;
        record.localPages = [0];
        record.downloading = false;
        if (card) refreshCard(card, record);
      }
      continue;
    }

    if (failed.has(pid) && !record.error) {
      record.error = failed.get(pid);
      record.downloading = false;
      if (card) refreshCard(card, record);
      continue;
    }

    const isActive = active === pid;
    if (isActive !== record.downloading) {
      record.downloading = isActive;
      if (card) refreshCard(card, record);
    }
  }
}

function updateQueueLabel(snapshot) {
  const busy = snapshot.running || snapshot.pending > 0 || snapshot.active;
  els.queueState.classList.toggle('busy', Boolean(busy));

  if (busy) {
    const parts = [];
    if (snapshot.active) parts.push('下载中');
    if (snapshot.pending > 0) parts.push(`队列 ${snapshot.pending}`);
    if (snapshot.failedCount > 0) parts.push(`失败 ${snapshot.failedCount}`);
    els.queueState.textContent = parts.join(' · ');
  } else if (snapshot.doneCount > 0) {
    els.queueState.textContent = `已下载 ${snapshot.doneCount}`;
  } else {
    els.queueState.textContent = '';
  }
}

// ---------- 按需下载 ----------

async function ensureDownloaded(record, card) {
  if (record.hasImage || record.localNovel || record.localUgoira) return true;
  if (record.error) {
    setStatus(`#${record.id} 之前下载失败：${record.error}`);
    return false;
  }

  record.downloading = true;
  refreshCard(card, record);
  setStatus(`正在下载 #${record.id} 《${record.title || '无题'}》…`);
  startPolling();

  try {
    const data = await api('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: record.pid }),
    });

    record.hasImage = true;
    if (record.type === 'novel') record.localNovel = true;
    if (record.type === 'ugoira') record.localUgoira = true;
    record.localPages = Array.from({ length: data.files || 1 }, (_, i) => i);
    setStatus(`已下载 #${record.id}`);
    state.submitted.add(String(record.pid));
    return true;
  } catch (err) {
    record.error = err.message;
    setStatus(`下载失败：#${record.id} ${err.message}`);
    return false;
  } finally {
    record.downloading = false;
    refreshCard(card, record);
  }
}

// ---------- 大图 ----------

const lb = {
  record: null,
  card: null,
  index: 0,
  scale: 1,
  tx: 0,
  ty: 0,
  dragging: false,
  startX: 0,
  startY: 0,
};

async function openLightbox(record, card) {
  lb.record = record;
  lb.card = card;

  const ok = await ensureDownloaded(record, card);
  if (!ok && !record.hasImage) {
    // 下载失败或非图片类型：不打开大图，避免白屏
    if (record.type === 'novel' || record.type === 'ugoira') {
      setStatus('已保存到 images 目录，可用系统程序打开。');
    }
    return;
  }

  lb.index = 0;
  resetTransform();
  showLightboxPage();
  els.lightbox.hidden = false;
  document.body.style.overflow = 'hidden';
}

function showLightboxPage() {
  const record = lb.record;
  if (!record) return;

  const pages = record.localPages?.length ? record.localPages : [0];
  const page = pages[lb.index] ?? 0;

  els.lbImage.src = `/api/full/${record.pid}/${page}`;
  els.lbTitle.textContent = `#${record.id} 《${record.title || '无题'}》 — ${record.author || '未知'}`;

  const bits = [`pid ${record.pid}`];
  if (pages.length > 1) bits.push(`第 ${lb.index + 1}/${pages.length} 页`);
  if (record.width && record.height) bits.push(`${record.width}×${record.height}`);
  if (record.bookmark_tags?.length) bits.push(record.bookmark_tags.join(' / '));
  els.lbMeta.textContent = bits.join(' · ');

  els.lbPrev.disabled = lb.index === 0 && !hasPrevRecord();
  els.lbNext.disabled = lb.index === pages.length - 1 && !hasNextRecord();
  updateZoomLabel();
  resetTransform();
}

function hasPrevRecord() {
  return state.records.indexOf(lb.record) > 0;
}

function hasNextRecord() {
  const i = state.records.indexOf(lb.record);
  return i >= 0 && i < state.records.length - 1;
}

function resetTransform() {
  lb.scale = 1;
  lb.tx = 0;
  lb.ty = 0;
  applyTransform();
}

function applyTransform() {
  els.lbImage.style.transform = `translate(${lb.tx}px, ${lb.ty}px) scale(${lb.scale})`;
  updateZoomLabel();
}

function updateZoomLabel() {
  els.lbZoom.textContent = `${Math.round(lb.scale * 100)}%`;
}

function stepPage(delta) {
  const record = lb.record;
  if (!record) return;
  const pages = record.localPages?.length ? record.localPages : [0];

  const next = lb.index + delta;
  if (next >= 0 && next < pages.length) {
    lb.index = next;
    showLightboxPage();
    return;
  }

  // 跨作品翻页
  const currentIndex = state.records.indexOf(record);
  const target = state.records[currentIndex + delta];
  const targetCard = els.grid.querySelector(`.card[data-pid="${target?.pid}"]`);
  if (!target) return;
  closeLightbox();
  openLightbox(target, targetCard ?? document.createElement('div'));
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lbImage.removeAttribute('src');
  lb.record = null;
  document.body.style.overflow = '';
}

// 滚轮缩放，以鼠标位置为中心
els.lbStage.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(8, Math.max(0.2, lb.scale * factor));
    const rect = els.lbStage.getBoundingClientRect();
    const cx = event.clientX - rect.left - rect.width / 2;
    const cy = event.clientY - rect.top - rect.height / 2;
    const ratio = next / lb.scale;
    lb.tx = cx - (cx - lb.tx) * ratio;
    lb.ty = cy - (cy - lb.ty) * ratio;
    lb.scale = next;
    applyTransform();
  },
  { passive: false },
);

els.lbStage.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  lb.dragging = true;
  lb.startX = event.clientX - lb.tx;
  lb.startY = event.clientY - lb.ty;
  els.lbStage.classList.add('dragging');
});

window.addEventListener('mousemove', (event) => {
  if (!lb.dragging) return;
  lb.tx = event.clientX - lb.startX;
  lb.ty = event.clientY - lb.startY;
  applyTransform();
});

window.addEventListener('mouseup', () => {
  lb.dragging = false;
  els.lbStage.classList.remove('dragging');
});

els.lbImage.addEventListener('dblclick', () => {
  if (lb.scale > 1) resetTransform();
  else {
    lb.scale = 2.2;
    applyTransform();
  }
});

els.lbClose.addEventListener('click', closeLightbox);
els.lbPrev.addEventListener('click', () => stepPage(-1));
els.lbNext.addEventListener('click', () => stepPage(1));

els.lightbox.addEventListener('click', (event) => {
  if (event.target === els.lightbox) closeLightbox();
});

window.addEventListener('keydown', (event) => {
  if (els.lightbox.hidden) return;
  if (event.key === 'Escape') closeLightbox();
  else if (event.key === 'ArrowLeft') stepPage(-1);
  else if (event.key === 'ArrowRight') stepPage(1);
  else if (event.key === '0') resetTransform();
  else if (event.key === '+' || event.key === '=') {
    lb.scale = Math.min(8, lb.scale * 1.2);
    applyTransform();
  } else if (event.key === '-') {
    lb.scale = Math.max(0.2, lb.scale / 1.2);
    applyTransform();
  }
});

// ---------- 筛选与滚动 ----------

let searchTimer = null;
els.search.addEventListener('input', () => {
  state.query = els.search.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reloadAll, 260);
});

els.tagFilter.addEventListener('change', () => {
  state.tag = els.tagFilter.value;
  reloadAll();
});

els.missingOnly.addEventListener('change', () => {
  state.missingOnly = els.missingOnly.checked;
  reloadAll();
});

els.showRemoved.addEventListener('change', () => {
  state.showRemoved = els.showRemoved.checked;
  reloadAll();
});

// 重新打开开关时，把当前已经渲染的卡片重新过一遍可见性判断
els.autoDownload.addEventListener('change', () => {
  state.autoDownload = els.autoDownload.checked;
  if (!state.autoDownload) {
    setStatus('已暂停自动下载，队列中已有的作品仍会完成。');
    return;
  }
  for (const card of state.cardMap.values()) state.observer?.observe(card);
});

els.reload.addEventListener('click', async () => {
  await loadState();
  await loadTags();
  reloadAll();
});

new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting) && state.offset < state.total && !state.loading) {
      loadPage(false);
    }
  },
  { root: null, rootMargin: '600px' },
).observe(els.sentinel);

// 网格滚动到底时兜底加载（IntersectionObserver 在某些缩放比例下可能漏触发）
els.grid.addEventListener('scroll', () => {
  const nearBottom = els.grid.scrollTop + els.grid.clientHeight > els.grid.scrollHeight - 700;
  if (nearBottom && state.offset < state.total && !state.loading) loadPage(false);
});

// ---------- 启动 ----------

(async function init() {
  try {
    await loadState();
    await loadTags();
    await loadPage(true);
  } catch (err) {
    setStatus(`初始化失败：${err.message}`);
  }
})();

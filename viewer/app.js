/* pixiv 收藏查看器 —— 单页应用
 *
 * 布局：顶栏 + 左栏（作者/标签）+ 网格 + 右栏（下载管理）。
 * 所有偏好（排序、封面比例、卡片宽度、标签显示）存 localStorage。
 */

// ---------- 设置 ----------

const SETTINGS_KEY = 'pixiv-viewer-settings.v2';

const DEFAULT_SETTINGS = {
  sort: 'asc',
  ratio: 'auto', // auto | 3:4 | 1:1 | 4:3 | 16:9
  cardWidth: 210,
  showOwnTags: false,
  showTags: false,
  autoDownload: true,
  tagIncludeWork: false, // 标签面板是否把作品本身的标签也算进来
  leftOpen: false,
  rightOpen: false,
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式之类，忽略 */
  }
}

let settings = loadSettings();

// ---------- 状态 ----------

const state = {
  sources: [],
  current: null,
  records: [],
  total: 0,
  offset: 0,
  loading: false,
  query: '',
  tag: '',
  authorId: '',
  seed: Math.floor(Math.random() * 1e9),
  submitted: new Set(),
  cardMap: new Map(),
  observer: null,
  sidePanel: 'authors',
  sideQuery: '',
  authors: [],
  tags: [],
};

const PAGE_SIZE = 120;

const els = {};
for (const id of [
  'tabs', 'search', 'sortMode', 'btnView', 'queueState', 'counter',
  'reload', 'sideLeft', 'sideTabs', 'sideQuery', 'sideList', 'btnLeft', 'btnRight',
  'searchSuggest', 'tagIncludeWrap', 'tagIncludeWork',
  'grid', 'sentinel', 'statusbar',
  'dlSummary', 'dlBar', 'dlMeta', 'dlAll', 'dlClear', 'dlVerify', 'dlSources', 'dlFails',
  'viewPopover', 'optRatio', 'optWidth', 'optWidthVal', 'optShowOwnTags', 'optShowTags',
  'optAutoDownload', 'optReset',
  'lightbox', 'lbStage', 'lbImage', 'lbPages', 'lbPanel', 'lbTitle', 'lbMeta', 'lbZoom',
  'lbClose', 'lbPrev', 'lbNext',
  'reader', 'rdCover', 'rdCoverBox', 'rdTitle', 'rdAuthor', 'rdTags', 'rdLink', 'rdBody', 'rdClose',
]) {
  els[id] = document.getElementById(id);
}

function setStatus(text) {
  els.statusbar.textContent = text;
}

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

// ---------- 设置应用 ----------

function applySettings() {
  document.documentElement.style.setProperty('--card-w', `${settings.cardWidth}px`);

  els.sortMode.value = settings.sort;
  for (const btn of els.optRatio.querySelectorAll('button')) {
    btn.classList.toggle('on', btn.dataset.v === settings.ratio);
  }
  els.optWidth.value = String(settings.cardWidth);
  els.optWidthVal.textContent = `${settings.cardWidth}px`;
  els.optShowOwnTags.checked = settings.showOwnTags;
  els.optShowTags.checked = settings.showTags;
  els.optAutoDownload.checked = settings.autoDownload;

  document.getElementById('sideLeft')?.classList.toggle('collapsed', !settings.leftOpen);
  document.getElementById('sideRight')?.classList.toggle('collapsed', !settings.rightOpen);
  document.getElementById('btnLeft')?.classList.toggle('on', settings.leftOpen);
  document.getElementById('btnRight')?.classList.toggle('on', settings.rightOpen);

  // 重渲染卡片后必须重新 observe，否则新生成的 img[data-src] 不会被触发加载
  for (const record of state.records) {
    const card = state.cardMap.get(String(record.pid));
    if (card) refreshCard(card, record);
  }
}

// ---------- 来源 ----------

function renderTabs() {
  els.tabs.innerHTML = '';
  for (const source of state.sources) {
    const btn = document.createElement('button');
    btn.dataset.key = source.key;
    btn.innerHTML = `${escapeHtml(source.label)}<span class="n">${source.count}</span>`;
    if (source.key === state.current) btn.classList.add('active');
    btn.addEventListener('click', () => switchSource(source.key));
    els.tabs.appendChild(btn);
  }
}

function switchSource(key) {
  if (key === state.current) return;
  state.current = key;
  state.tag = '';
  state.authorId = '';
  for (const btn of els.tabs.children) btn.classList.toggle('active', btn.dataset.key === key);
  loadSidePanel();
  reloadAll();
}

// ---------- 左栏 ----------

function renderSideTabs() {
  for (const btn of els.sideTabs.children) {
    btn.classList.toggle('active', btn.dataset.panel === state.sidePanel);
  }
}

async function loadSidePanel() {
  renderSideTabs();
  els.tagIncludeWrap.hidden = state.sidePanel !== 'tags';
  els.tagIncludeWork.checked = settings.tagIncludeWork;
  els.sideList.innerHTML = '<div class="side-empty">加载中…</div>';

  try {
    if (state.sidePanel === 'authors') {
      const data = await api(`/api/authors?source=${encodeURIComponent(state.current)}`);
      state.authors = data.authors;
      renderAuthors();
    } else {
      const include = settings.tagIncludeWork ? '&include=1' : '';
      const data = await api(`/api/tags?source=${encodeURIComponent(state.current)}${include}`);
      state.tags = data.tags;
      renderTags();
    }
  } catch (err) {
    els.sideList.innerHTML = `<div class="side-empty">加载失败：${escapeHtml(err.message)}</div>`;
  }
}

function renderAuthors() {
  const filter = state.sideQuery.trim().toLowerCase();
  const list = filter ? state.authors.filter((a) => a.name.toLowerCase().includes(filter)) : state.authors;

  if (list.length === 0) {
    els.sideList.innerHTML = '<div class="side-empty">没有匹配的作者</div>';
    return;
  }

  els.sideList.innerHTML = list
    .slice(0, 400)
    .map(
      (a) => `
      <div class="side-item${a.author_id === state.authorId ? ' active' : ''}" data-author="${escapeHtml(
        a.author_id,
      )}" title="${escapeHtml(a.name)}">
        <img class="avatar" src="/api/avatar/${encodeURIComponent(a.author_id)}" loading="lazy" alt="">
        <span class="name">${escapeHtml(a.name)}</span>
        <span class="cnt">${a.count}</span>
      </div>`,
    )
    .join('');
}

function renderTags() {
  const filter = state.sideQuery.trim().toLowerCase();
  const list = filter ? state.tags.filter((t) => t.tag.toLowerCase().includes(filter)) : state.tags;

  if (list.length === 0) {
    els.sideList.innerHTML = '<div class="side-empty">没有匹配的标签</div>';
    return;
  }

  els.sideList.innerHTML = list
    .map(
      (t) => `
      <div class="side-item" data-tag="${escapeHtml(t.tag)}" title="${escapeHtml(t.tag)}">
        <span class="name">${escapeHtml(t.tag)}</span>
        <span class="cnt">${t.count}</span>
      </div>`,
    )
    .join('');
}

els.sideTabs.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-panel]');
  if (!btn) return;
  state.sidePanel = btn.dataset.panel;
  state.sideQuery = '';
  els.sideQuery.value = '';
  loadSidePanel();
});

els.tagIncludeWork.addEventListener('change', () => {
  settings.tagIncludeWork = els.tagIncludeWork.checked;
  saveSettings();
  loadSidePanel();
});

els.sideList.addEventListener('click', (event) => {
  const authorItem = event.target.closest('[data-author]');
  if (authorItem) {
    const id = authorItem.dataset.author;
    state.authorId = state.authorId === id ? '' : id;
    renderAuthors();
    reloadAll();
    setStatus(state.authorId ? `已筛选作者 ${id}` : '已取消作者筛选');
    return;
  }

  const tagItem = event.target.closest('[data-tag]');
  if (tagItem) addTagToSearch(tagItem.dataset.tag);
});

/** 点标签不是立即筛选，而是把它拼进顶部搜索框（用引号包住，标签里可能有空格）。 */
function addTagToSearch(tag) {
  const term = `"${tag}"`;
  const current = els.search.value.trim();
  const next = current ? `${current} AND ${term}` : term;
  els.search.value = next;
  state.query = next;
  reloadAll();
  setStatus(`已把标签「${tag}」加入搜索条件`);
}

let sideTimer = null;
els.sideQuery.addEventListener('input', () => {
  state.sideQuery = els.sideQuery.value;
  clearTimeout(sideTimer);
  sideTimer = setTimeout(() => {
    if (state.sidePanel === 'authors') renderAuthors();
    else renderTags();
  }, 150);
});

// ---------- 列表 ----------

function buildQuery(offset) {
  const params = new URLSearchParams({
    source: state.current,
    offset: String(offset),
    limit: String(PAGE_SIZE),
    sort: settings.sort,
  });
  if (state.query) params.set('q', state.query);
  if (state.tag) params.set('tag', state.tag);
  if (state.authorId) params.set('author_id', state.authorId);
  if (settings.sort === 'random') params.set('seed', String(state.seed));
  return `/api/records?${params}`;
}

async function loadPage(reset) {
  if (state.loading) return;
  state.loading = true;

  try {
    if (reset) {
      state.offset = 0;
      state.records = [];
      state.cardMap.clear();
      els.grid.innerHTML = '';
      document.querySelector('.grid-wrap').scrollTop = 0;
    }

    const data = await api(buildQuery(state.offset));
    state.total = data.total;

    if (reset && data.items.length === 0) {
      els.grid.innerHTML = '<div class="empty">这个筛选条件下没有作品。</div>';
    }

    state.records.push(...data.items);
    state.offset += data.items.length;

    const frag = document.createDocumentFragment();
    for (const record of data.items) frag.appendChild(createCard(record));
    els.grid.appendChild(frag);

    updateCounter();
    setStatus(
      data.items.length === 0 ? '没有更多了' : `已显示 ${state.records.length} / ${state.total} 条`,
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

function ratioPadding(record) {
  if (settings.ratio === 'auto') {
    const w = Number(record.width);
    const h = Number(record.height);
    if (w > 0 && h > 0) return (h / w) * 100;
    return 133.33;
  }
  const [a, b] = settings.ratio.split(':').map(Number);
  return (b / a) * 100;
}

function thumbUrl(record, page) {
  // 按卡片显示宽度 × 像素密度请求，服务端选不小于该目标的最小级别
  const target = Math.round(settings.cardWidth * (window.devicePixelRatio || 1));
  return `/api/thumb/${record.pid}/${page}?w=${target}`;
}

function createCard(record) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.pid = record.pid;
  renderCardInner(card, record);
  card.addEventListener('click', () => openLightbox(record, card));
  state.cardMap.set(String(record.pid), card);

  if (!state.observer) {
    state.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          state.observer.unobserve(entry.target);

          const img = entry.target.querySelector('img[data-src]');
          if (img) {
            img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
            img.addEventListener(
              'error',
              () => {
                img.classList.add('loaded');
                img.style.opacity = '0.2';
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
      { root: document.querySelector('.grid-wrap'), rootMargin: '400px' },
    );
  }
  state.observer.observe(card);

  return card;
}

function renderCardInner(card, record) {
  const firstPage = record.localPages?.[0] ?? 0;
  const isNovel = record.type === 'novel';
  const downloadable = !isNovel;

  let badge = '';
  if (record.removed === 'yes') badge = '<span class="badge danger">已取消</span>';
  else if (record.status === 'unavailable') badge = '<span class="badge warn">已失效</span>';
  else if (record.localUgoira) badge = '<span class="badge">动图</span>';
  else if (isNovel) badge = '<span class="badge">小说</span>';

  let frame;
  if (record.hasImage && downloadable) {
    frame = `<img data-src="${thumbUrl(record, firstPage)}" alt="">`;
  } else if (isNovel && record.hasCover) {
    frame = `<img data-src="/api/cover/${record.pid}" alt="">`;
  } else if (isNovel) {
    frame = '<div class="placeholder"><span class="icon">📖</span><span>点击阅读</span></div>';
  } else if (record.localNovel) {
    frame = '<div class="placeholder"><span class="icon">📖</span>正文已下载</div>';
  } else if (record.localUgoira) {
    frame = '<div class="placeholder"><span class="icon">🎞</span>动图已下载</div>';
  } else {
    const failed = Boolean(record.error);
    frame = `
      <div class="placeholder">
        <span class="icon">${failed ? '⚠' : downloadable ? '⬇' : '📄'}</span>
        <span>${failed ? '下载失败' : downloadable ? '点击下载' : '点击打开'}</span>
      </div>`;
  }

  const spinner = record.downloading ? '<div class="spinner">下载中</div>' : '';

  const own = settings.showOwnTags ? record.bookmark_tags ?? [] : [];
  const works = settings.showTags ? record.tags ?? [] : [];
  const tagHtml =
    own.length || works.length
      ? `<div class="card-tags">${own
          .slice(0, 4)
          .map((t) => `<span class="card-tag own">${escapeHtml(t)}</span>`)
          .join('')}${works
          .slice(0, 3)
          .map((t) => `<span class="card-tag">${escapeHtml(t)}</span>`)
          .join('')}</div>`
      : '';

  card.innerHTML = `
    <div class="frame" style="padding-top:${ratioPadding(record).toFixed(2)}%">${frame}${badge}${spinner}</div>
    <div class="info">
      <div class="title">${escapeHtml(record.title || '(无题)')}</div>
      <div class="sub"><span class="author-name">${escapeHtml(record.author || '未知')}</span></div>
      ${tagHtml}
    </div>
  `;

  const authorEl = card.querySelector('.author-name');
  if (authorEl && record.author_id) {
    authorEl.addEventListener('click', (event) => {
      event.stopPropagation(); // 别顺带打开大图
      state.authorId = record.author_id;
      renderAuthors();
      reloadAll();
      setStatus(`已筛选作者：${record.author}`);
    });
  }
}

function refreshCard(card, record) {
  renderCardInner(card, record);
  state.observer?.observe(card);
}

// ---------- 自动下载队列 ----------

let enqueueBuffer = new Set();
let enqueueTimer = null;

function queueForDownload(record) {
  if (!settings.autoDownload) return;
  if (record.hasImage || record.localNovel || record.localUgoira || record.hasCover) return;
  if (record.status === 'unavailable') return;
  if (record.error) return;

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
    if (data.added > 0) startPolling();
    if (data.skippedLarge > 0) {
      setStatus(`有 ${data.skippedLarge} 个作品页数过多，未自动下载；点开即可单独补全`);
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
  pollTimer = setInterval(pollQueue, 1300);
  pollQueue();
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

async function pollQueue() {
  try {
    const snapshot = await api('/api/stats');
    applyQueueState(snapshot.queue);
    renderDownloadPanel(snapshot);

    if (!snapshot.queue.running && snapshot.queue.pending === 0 && !snapshot.queue.active) {
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
  const activeSet = new Set((snapshot.activeList ?? (snapshot.active ? [snapshot.active] : [])).map(String));

  for (const record of state.records) {
    const pid = String(record.pid);
    const card = state.cardMap.get(pid);

    if (done.has(pid)) {
      if (!record.hasImage && !record.hasCover) {
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

    const isActive = activeSet.has(pid);
    if (isActive !== record.downloading) {
      record.downloading = isActive;
      if (card) refreshCard(card, record);
    }
  }
}

// ---------- 右栏：下载管理 ----------

function renderDownloadPanel(data) {
  const sum = data.sources.reduce(
    (acc, s) => {
      acc.total += s.total;
      acc.done += s.done;
      acc.dead += s.removed + s.unavailable;
      return acc;
    },
    { total: 0, done: 0, dead: 0 },
  );

  // 计数按「页」而不是「作品」：一个 13 页的作品只下了首张，按作品算会说它完成，
  // 实际上大图翻到第二页还得现取。失效/取消按作品记，那种没有页可算。
  const pages = data.pages ?? { total: 0, done: 0, missing: 0 };

  els.dlSummary.innerHTML = `
    <div class="cell"><div class="v">${pages.total}</div><div class="k">总页数</div></div>
    <div class="cell"><div class="v done">${pages.done}</div><div class="k">已下载</div></div>
    <div class="cell"><div class="v miss">${pages.missing}</div><div class="k">待下载</div></div>
    <div class="cell"><div class="v">${sum.dead}</div><div class="k">失效/取消</div></div>
  `;

  const q = data.queue;
  const inFlight = (q.active ? 1 : 0) + q.pending;
  const base = q.processed + inFlight;
  els.dlBar.style.width = `${base > 0 ? Math.round((q.processed / base) * 100) : 0}%`;

  const bits = [];
  if (q.active) bits.push(`<span class="now">● ${q.active}</span>`);
  if (q.pending > 0) bits.push(`队列 ${q.pending}`);
  if (q.processed > 0) bits.push(`本次完成 ${q.processed} 个作品`);
  if (q.failedCount > 0) bits.push(`失败 ${q.failedCount}`);
  els.dlMeta.innerHTML = bits.length ? bits.join(' · ') : '队列空闲';

  els.queueState.classList.toggle('busy', Boolean(inFlight));
  els.queueState.textContent = inFlight ? `队列 ${inFlight}` : '';

  els.dlAll.disabled = inFlight > 0;
  els.dlClear.disabled = q.pending === 0 && !q.active;

  els.dlSources.innerHTML = data.sources
    .map((s) => {
      // 按来源也按页显示，鼠标悬停给出作品数
      const missingPages = s.pages?.missing ?? s.missing;
      const title = `${s.label}：${s.pages?.done ?? 0}/${s.pages?.total ?? 0} 页 · ${s.done}/${s.total} 个作品`;
      return `
      <button data-source="${s.key}" ${missingPages === 0 ? 'disabled' : ''} title="${escapeHtml(title)}">
        <span>${escapeHtml(s.label)}</span>
        <span class="n">${missingPages === 0 ? '✓' : missingPages}</span>
      </button>`;
    })
    .join('');

  const fails = (q.failedList ?? []).slice(-6).reverse();
  els.dlFails.innerHTML = fails.length
    ? `<div class="side-sub">最近失败</div><ul class="dl-fails">${fails
        .map(([pid, msg]) => `<li>${escapeHtml(pid)} · ${escapeHtml(msg)}</li>`)
        .join('')}</ul>`
    : '';
}

els.dlAll.addEventListener('click', async () => {
  els.dlAll.disabled = true;
  setStatus('正在把全部未下载作品加入队列…');
  try {
    const data = await api('/api/enqueue-all', { method: 'POST' });
    setStatus(`已加入 ${data.added} 个作品（候选 ${data.candidates}），下载会串行进行`);
    startPolling();
  } catch (err) {
    setStatus(`批量下载失败：${err.message}`);
    els.dlAll.disabled = false;
  }
});

els.dlClear.addEventListener('click', async () => {
  try {
    const data = await api('/api/queue/clear', { method: 'POST' });
    setStatus(`已清空队列，移除 ${data.cleared} 个待处理任务`);
    startPolling();
  } catch (err) {
    setStatus(`清空失败：${err.message}`);
  }
});

els.dlVerify.addEventListener('click', async () => {
  els.dlVerify.disabled = true;
  setStatus('开始校验图库，逐个读取文件头…');
  try {
    await api('/api/verify', { method: 'POST' });
    startPolling();
  } catch (err) {
    setStatus(`校验启动失败：${err.message}`);
    els.dlVerify.disabled = false;
  }
});

els.dlSources.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-source]');
  if (!btn) return;
  btn.disabled = true;
  setStatus('正在加入队列…');
  try {
    const data = await api(`/api/enqueue-all?source=${encodeURIComponent(btn.dataset.source)}`, {
      method: 'POST',
    });
    setStatus(`已加入 ${data.added} 个作品`);
    startPolling();
  } catch (err) {
    setStatus(`加入队列失败：${err.message}`);
    btn.disabled = false;
  }
});

// ---------- 大图 ----------

const lb = {
  record: null,
  card: null,
  index: 0,
  scale: 1,
  tx: 0,
  ty: 0,
  fitted: true, // 当前是否处于「适应可用区域」状态（双击时据此判断往哪切）
  dragging: false,
  moved: false,
  startX: 0,
  startY: 0,
  originX: 0,
  originY: 0,
};

let stripPid = null;

async function openLightbox(record, card) {
  if (record.type === 'novel') {
    await openReader(record, card);
    return;
  }

  lb.record = record;
  lb.card = card;
  stripPid = null;
  lb.moved = false;
  lb.index = 0;

  await ensureDownloaded(record, card);
  if (!record.hasImage) return;

  showLightboxPage();
  els.lightbox.hidden = false;
  document.body.style.overflow = 'hidden';

  prefetchPages(record);
  fetchDescription(record);
}

/** 列表接口的简介大多是空的，打开时按需向详情接口要一次，抓到就缓存在服务端。 */
function fetchDescription(record) {
  if (record.description || record.descFetched) return;
  if (record.type === 'novel' || record.status === 'unavailable') return;

  record.descFetched = true;
  api(`/api/description/${record.pid}`)
    .then((data) => {
      if (data.description) {
        record.description = data.description;
        if (lb.record === record) renderInfoPanel(record);
      }
    })
    .catch(() => {});
}

/** 点开作品后把尚未下载的分页逐个取回来（串行，避免抢占当前页的请求）。 */
function prefetchPages(record) {
  const total = Math.max(1, Number(record.pages) || 1);
  if (total <= 1) return;

  const local = new Set(record.localPages ?? []);
  const missing = [];
  for (let i = 0; i < total; i += 1) {
    if (!local.has(i)) missing.push(i);
  }
  if (missing.length === 0) return;

  setStatus(`正在补齐 ${missing.length} 页…`);

  (async () => {
    for (const page of missing) {
      try {
        await fetch(`/api/full/${record.pid}/${page}`);
        record.localPages = [...(record.localPages ?? []), page];
      } catch {
        /* 单页失败不影响其他页 */
      }
    }
    if (lb.record === record) {
      stripPid = null;
      renderPageStrip(record, total, lb.index);
      setStatus('分页已补齐');
    }
  })();
}

function renderPageStrip(record, totalPages, currentPage) {
  if (totalPages <= 1) {
    els.lbPages.innerHTML = '';
    stripPid = null;
    return;
  }

  if (stripPid === String(record.pid)) {
    for (const el of els.lbPages.children) {
      el.classList.toggle('active', Number(el.dataset.page) === currentPage);
    }
    els.lbPages.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    return;
  }

  stripPid = String(record.pid);
  const local = new Set(record.localPages ?? []);
  const frag = document.createDocumentFragment();

  for (let i = 0; i < totalPages; i += 1) {
    const item = document.createElement('div');
    item.className = `lb-page-thumb${i === currentPage ? ' active' : ''}`;
    item.dataset.page = String(i);

    item.innerHTML = local.has(i)
      ? `<img loading="lazy" src="/api/thumb/${record.pid}/${i}?w=200" alt=""><span class="num">${i + 1}</span>`
      : `${i + 1}`;

    item.addEventListener('click', () => {
      lb.index = i;
      showLightboxPage();
    });
    frag.appendChild(item);
  }

  els.lbPages.innerHTML = '';
  els.lbPages.appendChild(frag);
  els.lbPages.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function renderInfoPanel(record) {
  // 精简：分级 / AI / 类型做成胶囊，去掉来源和裸链接行
  const chips = [];
  if (Number(record.x_restrict) === 1) chips.push('<span class="chip-tag r18">R-18</span>');
  if (Number(record.x_restrict) === 2) chips.push('<span class="chip-tag r18">R-18G</span>');
  if (Number(record.ai_type) > 0) chips.push('<span class="chip-tag ai">AI 生成</span>');
  if (record.type === 'manga') chips.push('<span class="chip-tag type">漫画</span>');
  if (record.type === 'ugoira') chips.push('<span class="chip-tag type">动图</span>');
  if (record.removed === 'yes') chips.push('<span class="chip-tag">已取消收藏</span>');
  else if (record.status === 'unavailable') chips.push('<span class="chip-tag">作品已失效</span>');

  const dims = record.width && record.height ? `${record.width} × ${record.height}` : '';
  const pagesText = Number(record.pages) > 1 ? `${record.pages} 页` : '';
  const pub = record.published ? String(record.published).slice(0, 10) : '';
  const metaLine = [dims, pagesText, pub].filter(Boolean).join(' · ');

  const owned = record.bookmark_tags ?? [];
  const tags = record.tags ?? [];

  let html = `<h3 data-open="${escapeHtml(record.url ?? '')}" title="在 pixiv 打开">${escapeHtml(
    record.title || '(无题)',
  )}</h3>`;

  if (record.author) {
    html += `<div class="author-row">${
      record.author_id
        ? `<img class="author-avatar" src="/api/avatar/${escapeHtml(record.author_id)}" loading="lazy" alt="">`
        : ''
    }<span class="author" data-author-page="${
      record.author_id ? `https://www.pixiv.net/users/${record.author_id}` : ''
    }">${escapeHtml(record.author)}</span></div>`;
  }

  if (chips.length) html += `<div class="chips">${chips.join('')}</div>`;
  if (metaLine) html += `<div style="color:var(--muted);margin-bottom:10px">${escapeHtml(metaLine)}</div>`;

  if (owned.length) {
    html += `<div class="section">我的收藏标签</div><div class="taglist">${owned
      .map((t) => `<span class="tag owned">${escapeHtml(t)}</span>`)
      .join('')}</div>`;
  }

  if (tags.length) {
    html += `<div class="section">作品标签 ${tags.length}</div><div class="taglist">${tags
      .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
      .join('')}</div>`;
  }

  if (record.url) {
    html += `<a class="pid-link" href="${escapeHtml(record.url)}" target="_blank" rel="noopener">pid ${escapeHtml(
      record.pid,
    )} →</a>`;
  }

  // 简介放在最底部，跟着面板一起滚动，不单独做成小滚动框
  if (record.description) {
    html += `<div class="section">作品简介</div><div class="desc">${escapeHtml(record.description)}</div>`;
  }

  els.lbPanel.innerHTML = html;
}

els.lbPanel.addEventListener('click', (event) => {
  const title = event.target.closest('h3[data-open]');
  if (title && title.dataset.open) {
    window.open(title.dataset.open, '_blank', 'noopener');
    return;
  }
  const author = event.target.closest('[data-author-page]');
  if (author && author.dataset.authorPage) {
    window.open(author.dataset.authorPage, '_blank', 'noopener');
  }
});

function showLightboxPage() {
  const record = lb.record;
  if (!record) return;

  const totalPages = Math.max(1, Number(record.pages) || 1);
  const page = lb.index;

  els.lbTitle.textContent = `《${record.title || '无题'}》`;
  const bits = [`pid ${record.pid}`];
  if (totalPages > 1) bits.push(`${lb.index + 1}/${totalPages}`);
  els.lbMeta.textContent = bits.join(' · ');

  const hasLocal = (record.localPages ?? []).includes(page);
  if (!hasLocal) els.lbMeta.textContent += ' · 正在取这一页…';

  els.lbImage.onload = () => {
    els.lbMeta.textContent = bits.join(' · ');
    // 解码后才有 naturalWidth/clientWidth，fit 的基准尺寸这时才有效
    if (lb.fitted) resetTransform();
    else applyTransform();
  };
  els.lbImage.onerror = () => {
    els.lbMeta.textContent = `${bits.join(' · ')} · 获取失败`;
  };

  els.lbImage.src = `/api/full/${record.pid}/${page}?t=${Date.now()}`;

  renderPageStrip(record, totalPages, page);
  renderInfoPanel(record);

  els.lbPrev.disabled = lb.index === 0 && !hasPrevRecord();
  els.lbNext.disabled = lb.index === totalPages - 1 && !hasNextRecord();
  resetTransform();
}

/**
 * 沿某个方向找下一个「还能看」的作品。
 *
 * 失效作品（status=unavailable）既没有图也下载不了，翻上去只会被强行弹回网格，
 * 所以翻页时直接跳过它们。
 */
function neighborRecord(delta) {
  const start = state.records.indexOf(lb.record);
  if (start < 0) return null;

  for (let i = start + delta; i >= 0 && i < state.records.length; i += delta) {
    const candidate = state.records[i];
    if (!candidate) continue;
    if (candidate.status === 'unavailable') continue;
    return candidate;
  }
  return null;
}

function hasPrevRecord() {
  return Boolean(neighborRecord(-1));
}

function hasNextRecord() {
  return Boolean(neighborRecord(1));
}

/**
 * 舞台铺满整个窗口，但左右两栏是盖在上面的浮层，所以「可用区域」要把它们刨掉。
 * 返回的是相对舞台的像素几何：left/right 为两栏占宽，width/height 为剩余空间。
 */
function availRect() {
  const W = els.lbStage.clientWidth;
  const H = els.lbStage.clientHeight;

  const left = els.lbPages && els.lbPages.childElementCount > 0 ? els.lbPages.offsetWidth : 0;
  const right = els.lbPanel && els.lbPanel.childElementCount > 0 ? els.lbPanel.offsetWidth : 0;

  return { W, H, left, right, width: Math.max(120, W - left - right), height: H };
}

/**
 * 回到「适应可用区域」：
 * 图片本身按整屏 fit（CSS max-width/max-height），这里再叠一个 scale 把它收进
 * 左右两栏之间的区域，并把中心从屏幕中心平移到可用区域的中心。
 */
function resetTransform() {
  const img = els.lbImage;
  const area = availRect();

  lb.fitted = true;
  lb.tx = (area.left - area.right) / 2; // 可用区域中心相对屏幕中心的偏移
  lb.ty = 0;

  const baseW = img.clientWidth;
  const baseH = img.clientHeight;
  if (!baseW || !baseH) {
    lb.scale = 1;
    applyTransform();
    return;
  }

  // 上限 1：图片比可用区域小时保持原尺寸，不放大（放大只会糊）
  lb.scale = Math.min(area.width / baseW, area.height / baseH, 1);
  applyTransform();
}

function applyTransform() {
  els.lbImage.style.transform = `translate(${lb.tx}px, ${lb.ty}px) scale(${lb.scale})`;
  const ratio = lb.scale / oneToOneScale();
  els.lbZoom.textContent = `${Math.round(ratio * 100)}%`;
}

/** 1:1 显示真实像素时的 scale —— 百分比以它为 100%。 */
function oneToOneScale() {
  const img = els.lbImage;
  const fitWidth = img.clientWidth;
  const natural = img.naturalWidth;
  if (!fitWidth || !natural) return 1;
  return natural / fitWidth;
}

function stepPage(delta) {
  const record = lb.record;
  if (!record) return;

  const totalPages = Math.max(1, Number(record.pages) || 1);
  const next = lb.index + delta;
  if (next >= 0 && next < totalPages) {
    lb.index = next;
    showLightboxPage();
    return;
  }

  const target = neighborRecord(delta);
  if (!target) return;
  const targetCard = state.cardMap.get(String(target.pid));
  closeLightbox();
  openLightbox(target, targetCard);
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lbImage.removeAttribute('src');
  lb.record = null;
  document.body.style.overflow = '';
}

els.lbStage.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= 400;

    const factor = Math.exp(-delta * 0.0016);
    const next = Math.min(8, Math.max(0.15, lb.scale * factor));
    if (next === lb.scale) return;

    const rect = els.lbStage.getBoundingClientRect();
    const cx = event.clientX - rect.left - rect.width / 2;
    const cy = event.clientY - rect.top - rect.height / 2;
    const ratio = next / lb.scale;
    lb.tx = cx - (cx - lb.tx) * ratio;
    lb.ty = cy - (cy - lb.ty) * ratio;
    lb.scale = next;
    lb.fitted = false;
    applyTransform();
  },
  { passive: false },
);

els.lbStage.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  lb.dragging = true;
  lb.moved = false;
  lb.originX = event.clientX;
  lb.originY = event.clientY;
  lb.startX = event.clientX - lb.tx;
  lb.startY = event.clientY - lb.ty;
});

els.lbStage.addEventListener('click', (event) => {
  if (event.target !== els.lbStage) return;
  if (lb.moved) return;
  closeLightbox();
});

window.addEventListener('mousemove', (event) => {
  if (!lb.dragging) return;
  if (Math.hypot(event.clientX - lb.originX, event.clientY - lb.originY) > 4) lb.moved = true;
  lb.tx = event.clientX - lb.startX;
  lb.ty = event.clientY - lb.startY;
  applyTransform();
});

window.addEventListener('mouseup', () => {
  lb.dragging = false;
});

// 双击：适应可用区域 ↔ 1:1（按原图像素）
els.lbImage.addEventListener('dblclick', (event) => {
  event.stopPropagation();
  if (lb.fitted) {
    const target = oneToOneScale();
    if (target > 1.01) {
      const area = availRect();
      lb.fitted = false;
      lb.scale = Math.min(8, target);
      lb.tx = (area.left - area.right) / 2;
      lb.ty = 0;
      applyTransform();
    }
  } else {
    resetTransform();
  }
});

// 窗口尺寸变化时，处于「适应」状态就重新算一遍，否则图片会跑到区域外
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (els.lightbox.hidden || !lb.fitted) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resetTransform, 120);
});

els.lbClose.addEventListener('click', closeLightbox);
els.lbPrev.addEventListener('click', () => stepPage(-1));
els.lbNext.addEventListener('click', () => stepPage(1));

// ---------- 小说阅读器 ----------

async function openReader(record, card) {
  els.reader.hidden = false;
  document.body.style.overflow = 'hidden';

  els.rdTitle.textContent = record.title || '(无题)';
  els.rdAuthor.textContent = record.author || '未知作者';
  els.rdTags.innerHTML = (record.bookmark_tags ?? [])
    .map((t) => `<span>${escapeHtml(t)}</span>`)
    .join('');
  els.rdLink.href = record.url || '#';
  els.rdCoverBox.innerHTML = '<span>加载中…</span>';
  els.rdBody.innerHTML = '<div class="rd-loading">正在读取正文…</div>';

  setStatus(`正在准备《${record.title || '无题'}》…`);

  try {
    const data = await api(`/api/novel/${record.pid}`);
    els.rdCoverBox.innerHTML = data.cover ? `<img src="/api/cover/${record.pid}" alt="">` : '<span>无封面</span>';
    els.rdBody.textContent = data.content || '（正文为空）';
    els.rdBody.scrollTop = 0;
    record.hasCover = Boolean(data.cover);
    record.localNovel = true;
    if (card) refreshCard(card, record);
    setStatus(`已打开《${record.title || '无题'}》`);
  } catch (err) {
    els.rdBody.innerHTML = `<div class="rd-loading">读取失败：${escapeHtml(err.message)}</div>`;
    setStatus(`读取失败：${err.message}`);
  }
}

function closeReader() {
  els.reader.hidden = true;
  els.rdBody.textContent = '';
  document.body.style.overflow = '';
}

els.rdClose.addEventListener('click', closeReader);

// ---------- 单张下载 ----------

async function ensureDownloaded(record, card) {
  if (record.hasImage) return true;
  if (record.error) {
    setStatus(`之前下载失败：${record.error}`);
    return false;
  }

  record.downloading = true;
  if (card) refreshCard(card, record);
  setStatus(`正在下载《${record.title || '无题'}》…`);
  startPolling();

  try {
    const data = await api('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: record.pid }),
    });
    record.hasImage = true;
    record.localPages = Array.from({ length: data.files || 1 }, (_, i) => i);
    state.submitted.add(String(record.pid));
    return true;
  } catch (err) {
    record.error = err.message;
    return false;
  } finally {
    record.downloading = false;
    if (card) refreshCard(card, record);
  }
}

// ---------- 顶栏交互 ----------

let searchTimer = null;
els.search.addEventListener('input', () => {
  state.query = els.search.value.trim();
  showSuggest();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reloadAll, 280);
});

// ---------- 搜索建议：聚焦时列出可用的属性筛选 ----------

const YEAR = new Date().getFullYear();

const FIELD_GROUPS = [
  {
    group: '类型',
    items: [
      ['type:illust', '插画'],
      ['type:manga', '漫画'],
      ['type:ugoira', '动图'],
      ['type:novel', '小说'],
    ],
  },
  {
    group: '属性',
    items: [
      ['is:ai', 'AI 生成'],
      ['NOT is:ai', '非 AI'],
      ['is:r18', 'R-18'],
      ['NOT is:r18', '非 R-18'],
    ],
  },
  {
    group: '图片比例',
    items: [
      ['ratio:landscape', '横图（宽 > 高）'],
      ['ratio:portrait', '竖图（高 > 宽）'],
      ['ratio:square', '方图（±2%）'],
      ['ratio:>1.5', '宽高比 > 1.5'],
      ['ratio:<0.7', '宽高比 < 0.7'],
    ],
  },
  {
    group: '日期范围（发布日期）',
    items: [
      [`date:${YEAR}`, `${YEAR} 年`],
      [`date:${YEAR - 1}`, `${YEAR - 1} 年`],
      [`date:>${YEAR - 1}-01-01`, `${YEAR - 1} 年之后`],
      [`date:${YEAR - 2}..${YEAR}`, '近三年'],
      ['date:<2020-01-01', '2020 年之前'],
    ],
  },
  {
    group: '页数 / 状态',
    items: [
      ['pages:>1', '多页'],
      ['pages:>10', '10 页以上'],
      ['is:unavailable', '已失效'],
      ['NOT is:removed', '仍在收藏'],
    ],
  },
];

/** 光标前正在输入的那一段（用于过滤建议、并在点击时替换掉它） */
function searchTail() {
  const match = /(\S*)$/.exec(els.search.value);
  return match ? match[1] : '';
}

function showSuggest() {
  const keyword = searchTail().toLowerCase();
  const parts = [];
  let count = 0;

  for (const group of FIELD_GROUPS) {
    const items = keyword
      ? group.items.filter(
          ([term, desc]) => term.toLowerCase().includes(keyword) || desc.toLowerCase().includes(keyword),
        )
      : group.items;
    if (items.length === 0) continue;

    parts.push(`<div class="sg-group">${escapeHtml(group.group)}</div>`);
    for (const [term, desc] of items) {
      parts.push(
        `<div class="sg-item" data-term="${escapeHtml(term)}"><code>${escapeHtml(term)}</code>` +
          `<span class="sg-desc">${escapeHtml(desc)}</span></div>`,
      );
      count += 1;
    }
  }

  els.searchSuggest.innerHTML = count
    ? parts.join('')
    : '<div class="sg-empty">没有匹配的属性，可直接写全文关键词</div>';
  els.searchSuggest.hidden = false;
}

function hideSuggest() {
  els.searchSuggest.hidden = true;
}

/** 把条件插到搜索框里，替换掉光标前那段半截输入。 */
function insertSearchTerm(term) {
  const tail = searchTail();
  const value = els.search.value;
  const head = value.slice(0, value.length - tail.length);
  const next = `${head}${term}`;

  els.search.value = next;
  state.query = next.trim();
  hideSuggest();
  reloadAll();
  els.search.focus();
  setStatus(`已插入条件 ${term}`);
}

els.search.addEventListener('focus', showSuggest);

els.search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideSuggest();
});

// 用 mousedown 而不是 click：click 之前会先触发 blur，建议面板可能已被隐藏
els.searchSuggest.addEventListener('mousedown', (event) => {
  event.preventDefault();
  const item = event.target.closest('.sg-item');
  if (item) insertSearchTerm(item.dataset.term);
});

document.addEventListener('click', (event) => {
  if (els.searchSuggest.hidden) return;
  if (event.target === els.search || els.searchSuggest.contains(event.target)) return;
  hideSuggest();
});

els.sortMode.addEventListener('change', () => {
  settings.sort = els.sortMode.value;
  if (settings.sort === 'random') state.seed = Math.floor(Math.random() * 1e9);
  saveSettings();
  reloadAll();
});

els.btnView.addEventListener('click', (event) => {
  event.stopPropagation();
  els.viewPopover.hidden = !els.viewPopover.hidden;
});

document.addEventListener('click', (event) => {
  if (els.viewPopover.hidden) return;
  if (els.viewPopover.contains(event.target) || event.target === els.btnView) return;
  els.viewPopover.hidden = true;
});

els.optRatio.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-v]');
  if (!btn) return;
  settings.ratio = btn.dataset.v;
  saveSettings();
  applySettings();
});

els.optWidth.addEventListener('input', () => {
  settings.cardWidth = Number(els.optWidth.value);
  els.optWidthVal.textContent = `${settings.cardWidth}px`;
  document.documentElement.style.setProperty('--card-w', `${settings.cardWidth}px`);
  saveSettings();
});

els.optShowOwnTags.addEventListener('change', () => {
  settings.showOwnTags = els.optShowOwnTags.checked;
  saveSettings();
  applySettings();
});

els.optShowTags.addEventListener('change', () => {
  settings.showTags = els.optShowTags.checked;
  saveSettings();
  applySettings();
});

els.optAutoDownload.addEventListener('change', () => {
  settings.autoDownload = els.optAutoDownload.checked;
  saveSettings();
});

els.optReset.addEventListener('click', () => {
  settings = { ...DEFAULT_SETTINGS, leftOpen: settings.leftOpen, rightOpen: settings.rightOpen };
  saveSettings();
  applySettings();
  setStatus('视图设置已恢复默认');
});

els.btnLeft.addEventListener('click', () => {
  settings.leftOpen = !settings.leftOpen;
  saveSettings();
  applySettings();
  // 栏刚打开且还没加载过，才去拉作者/标签（连带头像）
  if (settings.leftOpen && state.authors.length === 0 && state.tags.length === 0) loadSidePanel();
});

els.btnRight.addEventListener('click', () => {
  settings.rightOpen = !settings.rightOpen;
  saveSettings();
  applySettings();
});

els.reload.addEventListener('click', async () => {
  state.authorId = '';
  await loadState();
  await loadSidePanel();
  reloadAll();
});

window.addEventListener('keydown', (event) => {
  if (!els.reader.hidden) {
    if (event.key === 'Escape') closeReader();
    return;
  }
  if (els.lightbox.hidden) return;
  if (event.key === 'Escape') closeLightbox();
  else if (event.key === 'ArrowLeft') stepPage(-1);
  else if (event.key === 'ArrowRight') stepPage(1);
  else if (event.key === '0') resetTransform();
});

// 滚动加载
const gridWrap = document.querySelector('.grid-wrap');
gridWrap.addEventListener('scroll', () => {
  if (gridWrap.scrollTop + gridWrap.clientHeight > gridWrap.scrollHeight - 700) {
    if (state.offset < state.total && !state.loading) loadPage(false);
  }
});

new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting) && state.offset < state.total && !state.loading) {
      loadPage(false);
    }
  },
  { rootMargin: '600px' },
).observe(els.sentinel);

// ---------- 启动 ----------

async function loadState() {
  const data = await api('/api/state');
  state.sources = data.sources;

  const params = new URLSearchParams(location.search);

  const fromUrl = params.get('source');
  if (fromUrl && data.sources.some((s) => s.key === fromUrl)) state.current = fromUrl;

  const qParam = params.get('q');
  if (qParam) {
    state.query = qParam;
    els.search.value = qParam;
  }

  const sortParam = params.get('sort');
  if (sortParam && ['asc', 'desc', 'random'].includes(sortParam)) settings.sort = sortParam;

  const authorParam = params.get('author_id');
  if (authorParam) state.authorId = authorParam;

  if (!state.current) {
    const first = data.sources.find((s) => s.count > 0) ?? data.sources[0];
    state.current = first?.key ?? 'illustPublic';
  }
  renderTabs();
}

(async function init() {
  applySettings();
  try {
    await loadState();
    if (settings.leftOpen) await loadSidePanel();
    await loadPage(true);
    await pollQueue();
  } catch (err) {
    setStatus(`初始化失败：${err.message}`);
  }
})();

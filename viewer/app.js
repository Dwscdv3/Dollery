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
  // 封面上的 5 颗星。开启时评分标签不再占用卡片的标签位，改用星星表达
  showRating: true,
  autoDownload: true,
  overlayInfo: false, // 标题 / 作者 / 标签叠在图片上，而不是图片外
  tagIncludeWork: false, // 标签面板是否把作品本身的标签也算进来
  onlyGroups: false, // 标签面板是否只列标签组
  tagSettingsOpen: false, // 标签面板的设置项（含作品标签 / 只看标签组 / 隐藏流行度）是否展开
  hidePopularTags: false, // 隐藏 100users入り、1000users入り 这类流行度标签
  ratingFilter: [], // 评分筛选：选中的分值（1~10），多选按 OR 处理
  defaultFilter: '-is:unavailable', // 默认过滤器：与搜索 AND 连接，默认藏掉已失效的作品
  filterEnabled: true, // 默认过滤器的总开关：关掉后条件保留但不参与查询
  filterOpen: false, // 默认过滤器输入框是否展开（纯 UI 状态，不影响过滤是否生效）
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

/** 随机种子：0 会被服务端当成「没传」，所以从 1 起步。 */
function freshSeed() {
  return Math.floor(Math.random() * 1e9) + 1;
}

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
  seed: freshSeed(),
  submitted: new Set(),
  cardMap: new Map(),
  observer: null,
  sidePanel: 'authors',
  sideQuery: '',
  authors: [],
  tags: [],
  tagGroups: [], // 完整组定义（编辑用）
  groupSummaries: [], // /api/tags 带回的组汇总（带计数）
  expandedGroups: new Set(), // 展开了哪些组卡片（默认全部折叠）
  pendingConvert: null, // 待确认的批量转换
  lastConvert: null, // 上一次轮询到的转换任务快照
  finishedConverts: new Set(),
};

const PAGE_SIZE = 120;

const els = {};
for (const id of [
  'tabs', 'search', 'sortMode', 'btnReshuffle', 'btnView', 'queueState', 'counter',
  'reload', 'sideLeft', 'sideTabs', 'sideQuery', 'sideList', 'btnLeft', 'btnRight',
  'searchSuggest', 'tagIncludeWrap', 'tagIncludeWork',
  'onlyGroupsWrap', 'onlyGroups', 'sideMenu',
  'tagSettingsToggle', 'tagSettings', 'ratingFilter', 'hidePopularWrap', 'hidePopularTags',
  'convertBanner', 'convertText', 'convertFill', 'convertStop', 'pacerFill',
  'tgModal', 'tgTitle', 'tgSub', 'tgClose', 'tgCount', 'tgMembers', 'tgHint',
  'tgSearch', 'tgCandidates', 'tgDissolve', 'tgCancel', 'tgSave',
  'tcModal', 'tcTitle', 'tcClose', 'tcLead', 'tcCancel', 'tcStart',
  'btnFilter', 'filterPill', 'filterEnabled', 'filterBox', 'defaultFilter', 'filterSuggest',
  'grid', 'sentinel', 'guardBanner', 'guardText', 'guardResume',
  'pacerBanner', 'pacerText', 'pacerSkip',
  'dlSummary', 'dlBar', 'dlMeta', 'dlAll', 'dlFirst', 'dlClear', 'dlVerify', 'dlSources', 'dlFails',
  'viewPopover', 'optRatio', 'optWidth', 'optWidthVal', 'optShowOwnTags', 'optShowTags',
  'optShowRating', 'optAutoDownload', 'optOverlayInfo', 'optReset',
  'lightbox', 'lbStage', 'lbImage', 'lbPages', 'lbPanel',
  'lbClose', 'lbPrev', 'lbNext', 'lbCopy',
  'reader', 'rdCover', 'rdCoverBox', 'rdTitle', 'rdAuthor', 'rdTags', 'rdLink', 'rdBody', 'rdClose', 'rdEdit',
  'bmModal', 'bmClose', 'bmSub', 'bmThumb', 'bmWorkTitle', 'bmWorkAuthor', 'bmTagInput', 'bmTagEntry',
  'bmCount', 'bmHint', 'bmWorkTags', 'bmTagSearch', 'bmMineTags', 'bmMineCount', 'bmFetch', 'bmRestrict',
  'bmSave', 'bmCancel', 'bmStatus',
  'bmPick', 'bmPickClose', 'bmPickLead', 'bmPickList', 'bmPickStatus',
  'toast',
]) {
  els[id] = document.getElementById(id);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    // 业务错误码要能传到调用方（例如 TAGS_FULL 需要弹「挑一个删」的窗）
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

/**
 * 用系统默认浏览器打开 pixiv 页面。
 *
 * 查看器是 Edge `--app` 模式起的，页面里 window.open 只会在 Edge 里再开一个窗口，
 * 那就等于「用 Edge 打开」，和用户点链接的预期不符。所以统一走本地服务，
 * 由它调系统默认浏览器。
 */
async function openExternal(url) {
  if (!url) return;
  try {
    await api('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  } catch (err) {
    toast(`打开失败：${err.message}`, 'warn');
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

// ---------- 复制 ----------

const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
  '<path d="M6.2 9.8a2.4 2.4 0 0 0 3.4 0l2.6-2.6a2.4 2.4 0 0 0-3.4-3.4l-1 1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  '<path d="M9.8 6.2a2.4 2.4 0 0 0-3.4 0L3.8 8.8a2.4 2.4 0 0 0 3.4 3.4l1-1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  '</svg>';

let toastTimer = null;

function toast(message, tone = 'ok') {
  const el = els.toast;
  if (!el) return;
  el.textContent = message;
  el.className = `toast ${tone}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 1900);
}

/** 复制纯文本。局域网 http 下没有 clipboard API，退回 execCommand 老路子。 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** 作品页地址：优先用后端给的 url，没有就按 pid 拼一个（小说走 novel 的路由）。 */
function recordLink(record) {
  if (!record) return '';
  if (record.url) return record.url;
  if (!record.pid) return '';
  return record.type === 'novel'
    ? `https://www.pixiv.net/novel/show.php?id=${record.pid}`
    : `https://www.pixiv.net/artworks/${record.pid}`;
}

async function copyLink(record) {
  const link = recordLink(record);
  if (!link) {
    toast('这个作品没有可复制的链接', 'warn');
    return;
  }
  const ok = await copyText(link);
  toast(ok ? '已复制作品链接' : '复制失败，请手动复制地址栏', ok ? 'ok' : 'warn');
}

/** 剪贴板只认 image/png，而本地原图多是 avif，所以统一过一遍 canvas 转码。 */
async function toPngBlob(blob) {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (out) => (out ? resolve(out) : reject(new Error('图片转码失败'))),
      'image/png',
    );
  });
}

/**
 * 把当前页图片塞进剪贴板，可以直接粘到聊天窗口或画图软件里。
 * 需要安全上下文（localhost 或 https）且浏览器支持写图，失败时退回复制链接，
 * 不让按钮看起来「点了没反应」。
 */
async function copyImage(record, page = 0) {
  if (!record) return;
  if (record.type === 'novel') {
    toast('小说没有图片，已改为复制链接', 'warn');
    await copyLink(record);
    return;
  }

  try {
    const res = await fetch(`/api/full/${record.pid}/${page}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const png = await toPngBlob(await res.blob());
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast(Number(record.pages) > 1 ? `已复制第 ${page + 1} 页图片` : '已复制图片，可直接粘贴');
  } catch (err) {
    const ok = await copyText(recordLink(record));
    toast(
      ok ? `复制图片失败，已改为复制链接` : `复制失败：${err.message}`,
      'warn',
    );
  }
}

// ---------- 设置应用 ----------

/** 只同步「是否在过滤」的视觉状态，不碰输入框内容。 */
function syncFilterActive() {
  const text = String(settings.defaultFilter ?? '').trim();
  const active = settings.filterEnabled && text !== '';

  els.filterEnabled.checked = settings.filterEnabled;
  els.filterPill.classList.toggle('on', active);
  els.filterBox.classList.toggle('off', !settings.filterEnabled);
  els.btnFilter.classList.toggle('on', active);
  els.btnFilter.title = active
    ? `默认过滤器：${text}（与搜索 AND，点此展开/收起）`
    : settings.filterEnabled
      ? '默认过滤器：未设置（点此展开）'
      : '默认过滤器已停用（点开关启用）';
}

/** 把默认过滤器的文本 / 展开状态同步到界面。 */
function syncFilterUI() {
  const text = String(settings.defaultFilter ?? '');
  // 正在这个框里打字时别回写，否则 trim 会把刚敲的尾随空格吃掉、光标也会跳
  if (document.activeElement !== els.defaultFilter && els.defaultFilter.value !== text) {
    els.defaultFilter.value = text;
  }
  els.filterBox.hidden = !settings.filterOpen;
  els.btnFilter.setAttribute('aria-expanded', String(Boolean(settings.filterOpen)));
  syncFilterActive();
}

function applySettings({ rerender = true } = {}) {
  document.documentElement.style.setProperty('--card-w', `${settings.cardWidth}px`);

  els.sortMode.value = settings.sort;
  // 「换一批」只在随机排序下有意义
  els.btnReshuffle.hidden = settings.sort !== 'random';
  for (const btn of els.optRatio.querySelectorAll('button')) {
    btn.classList.toggle('on', btn.dataset.v === settings.ratio);
  }
  els.optWidth.value = String(settings.cardWidth);
  els.optWidthVal.textContent = `${settings.cardWidth}px`;
  els.optShowOwnTags.checked = settings.showOwnTags;
  els.optShowTags.checked = settings.showTags;
  els.optShowRating.checked = settings.showRating;
  els.optAutoDownload.checked = settings.autoDownload;
  els.optOverlayInfo.checked = settings.overlayInfo;
  // 信息叠在图上时，卡片高度只由图片决定，CSS 那边靠这个 class 切换
  document.body.classList.toggle('overlay-info', settings.overlayInfo);

  document.getElementById('sideLeft')?.classList.toggle('collapsed', !settings.leftOpen);
  document.getElementById('sideRight')?.classList.toggle('collapsed', !settings.rightOpen);
  document.getElementById('btnLeft')?.classList.toggle('on', settings.leftOpen);
  document.getElementById('btnRight')?.classList.toggle('on', settings.rightOpen);

  syncFilterUI();

  // 卡片外观变了，行高全部作废；只重画视口附近这些行
  if (rerender) {
    resetGridRender();
    scheduleGridPaint(true);
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

// 换类别 / 换面板时可能有多个请求同时在飞，只让最后一次的结果落地
let sidePanelSeq = 0;

async function loadSidePanel() {
  const seq = ++sidePanelSeq;
  const panel = state.sidePanel;
  const source = state.current;

  renderSideTabs();
  els.tagIncludeWork.checked = settings.tagIncludeWork;
  els.onlyGroups.checked = settings.onlyGroups;
  els.hidePopularTags.checked = settings.hidePopularTags;
  renderRatingFilter();
  applyTagPanelVisibility();

  // 换面板 / 换来源时回到顶部，旧的高度缓存保留（按 key 命中，不会串行）
  sidebarView.items = [];
  sidebarView.lastRange = '';
  els.sideList.scrollTop = 0;
  els.sideList.innerHTML = '<div class="side-empty">加载中…</div>';

  try {
    if (panel === 'authors') {
      const data = await api(`/api/authors?source=${encodeURIComponent(source)}`);
      if (seq !== sidePanelSeq) return;
      state.authors = data.authors;
      renderAuthors();
    } else {
      const include = settings.tagIncludeWork ? '&include=1' : '';
      const data = await api(`/api/tags?source=${encodeURIComponent(source)}${include}`);
      if (seq !== sidePanelSeq) return;
      state.tags = data.tags;
      state.groupSummaries = data.groups ?? [];
      state.tagGroups = state.groupSummaries.map((group) => ({ id: group.id, tags: [...group.tags] }));
      renderTags();
    }
  } catch (err) {
    if (seq !== sidePanelSeq) return;
    sidebarView.items = [];
    els.sideList.innerHTML = `<div class="side-empty">加载失败：${escapeHtml(err.message)}</div>`;
  }
}

/* ── 侧栏虚拟列表 ──────────────────────────────────────────
 * 作者和标签都可能上千条，一次性塞进 DOM 会卡住面板。这里只渲染视口附近的一小段，
 * 用上下两个占位块把总高度撑住，滚动条长度从第一帧起就是对的。
 *
 * 每项高度在渲染后实测并缓存（组展开/折叠用不同的 key），所以折叠组、展开组、
 * 头像行混在一起也能算准；滚动时高度变了会同步修正占位块，必要时把 scrollTop
 * 拉回原来的锚点，避免列表内容跳一下。
 */

const sidebarView = {
  items: [],
  heights: new Map(),
  empty: '',
  version: 0,
  lastRange: '',
  frame: 0,
};

function sidebarItemHtml(item) {
  if (item.kind === 'author') return authorRowHtml(item.data);
  if (item.kind === 'group') return groupCardHtml(item.data.group, item.data.expanded, item.data.filtering);
  return tagRowHtml(item.data, item.showBadge);
}

function authorRowHtml(a) {
  return `
    <div class="side-item${a.author_id === state.authorId ? ' active' : ''}"
         data-author="${escapeHtml(a.author_id)}" title="${escapeHtml(a.name)}">
      <img class="avatar" src="/api/avatar/${encodeURIComponent(a.author_id)}" loading="lazy" alt="">
      <span class="name">${escapeHtml(a.name)}</span>
      <span class="cnt">${a.count}</span>
    </div>`;
}

/** 找到高度区间包含 value 的项下标（prefix 长度 = 项数 + 1）。 */
function findSlot(prefix, value) {
  if (value <= 0) return 0;
  let lo = 0;
  let hi = prefix.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, Math.min(lo, prefix.length - 2));
}

function updateSidebarSpacers(topHeight, bottomHeight) {
  const pads = els.sideList.querySelectorAll('.vpad');
  if (pads[0]) pads[0].style.height = `${Math.max(0, topHeight)}px`;
  if (pads[1]) pads[1].style.height = `${Math.max(0, bottomHeight)}px`;
}

function paintSidebar(force = false) {
  const box = els.sideList;
  const items = sidebarView.items;

  // 面板收起时量不到高度，等 ResizeObserver 触发再画
  if (!box.clientHeight) return;

  if (items.length === 0) {
    box.innerHTML = `<div class="side-empty">${escapeHtml(sidebarView.empty || '没有内容')}</div>`;
    sidebarView.lastRange = '';
    return;
  }

  const heights = items.map((item) => sidebarView.heights.get(item.key) ?? item.estimate);
  const prefix = new Array(items.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < items.length; i += 1) prefix[i + 1] = prefix[i] + heights[i];

  const top = box.scrollTop;
  const bottom = top + box.clientHeight;
  const first = findSlot(prefix, top);
  const last = findSlot(prefix, bottom);
  const start = Math.max(0, first - 4);
  const end = Math.min(items.length, last + 5);

  const sig = `${sidebarView.version}:${start}:${end}`;
  if (!force && sig === sidebarView.lastRange) return;
  sidebarView.lastRange = sig;

  const chunks = [];
  for (let i = start; i < end; i += 1) {
    chunks.push(
      `<div class="vitem" data-vkey="${escapeHtml(items[i].key)}">${sidebarItemHtml(items[i])}</div>`,
    );
  }

  box.innerHTML =
    `<div class="vpad" style="height:${prefix[start]}px"></div>` +
    chunks.join('') +
    `<div class="vpad" style="height:${prefix[items.length] - prefix[end]}px"></div>`;

  let changed = false;
  for (const node of box.querySelectorAll('.vitem')) {
    const key = node.dataset.vkey;
    const height = node.getBoundingClientRect().height;
    if (!height) continue;
    const prev = sidebarView.heights.get(key);
    if (prev === undefined || Math.abs(prev - height) > 0.5) {
      sidebarView.heights.set(key, height);
      changed = true;
    }
  }

  if (changed) {
    const next = new Array(items.length + 1);
    next[0] = 0;
    for (let i = 0; i < items.length; i += 1) {
      next[i + 1] = next[i] + (sidebarView.heights.get(items[i].key) ?? items[i].estimate);
    }
    const delta = next[start] - prefix[start];
    updateSidebarSpacers(next[start], next[items.length] - next[end]);
    if (Math.abs(delta) > 0.5) box.scrollTop = top + delta;
    // 总高度变了，通知自绘滚动条重新算滑块长度
    box.dispatchEvent(new Event('scroll'));
    scheduleSidebarPaint();
  }
}

function scheduleSidebarPaint() {
  if (sidebarView.frame) return;
  sidebarView.frame = requestAnimationFrame(() => {
    sidebarView.frame = 0;
    paintSidebar();
  });
}

function setSidebarItems(items, emptyText) {
  sidebarView.items = items;
  sidebarView.empty = emptyText;
  sidebarView.version += 1;
  sidebarView.lastRange = '';
  paintSidebar(true);
}

function renderAuthors() {
  const filter = state.sideQuery.trim().toLowerCase();
  const list = filter ? state.authors.filter((a) => a.name.toLowerCase().includes(filter)) : state.authors;

  setSidebarItems(
    list.map((a) => ({ kind: 'author', key: `a:${a.author_id}`, estimate: 46, data: a })),
    '没有匹配的作者',
  );
}

/* ── 标签面板的显示过滤 ──────────────────────────────────
 * 两类标签不再出现在列表里：
 *   · 评分标签（n/10）—— 改由筛选框下方那排数字按钮承担，列表里再列一遍只是占地方；
 *   · 流行度标签（100users入り 之类）—— 可选隐藏。它们记录的是「这张图在站上有多火」，
 *     不是作品内容，翻标签找人时基本没用。
 *
 * 组的去重计数（union）不跟着扣：它统计的是「组内所有成员的作品合集」，
 * 隐藏某个成员只影响列表行，不改组本身的数目。
 *
 * 流行度标签的实际写法是「<标签名><数量>users入り」，前面经常还挂着作品标签：
 *   500users入り / 1000users入り / 10000users入り / 原神5000users入り
 * 所以只锚尾，不锚头 —— 早先写成 `^\d+users入り$` 时一个都匹配不上。
 */
const POPULAR_TAG_RE = /\d+\s*users入り$/i;

/** 「请整理 users 标签」这类元标签：不带数量，但同样是噪音，跟着流行度开关一起藏。 */
const POPULAR_META_RE = /^usersタグ整理推奨$/i;

function isPopularTag(tag) {
  const text = String(tag ?? '').trim();
  return POPULAR_TAG_RE.test(text) || POPULAR_META_RE.test(text);
}

function isTagHidden(tag) {
  if (ratingValueOfTag(tag)) return true;
  return Boolean(settings.hidePopularTags) && isPopularTag(tag);
}

/** 评分按钮行：1~10 十个按钮，点一下切换选中，多选按 OR 处理。 */
function renderRatingFilter() {
  const chosen = new Set(
    (Array.isArray(settings.ratingFilter) ? settings.ratingFilter : []).map(Number),
  );

  let html = '';
  for (let value = 1; value <= 10; value += 1) {
    const on = chosen.has(value);
    html +=
      `<button type="button" class="rating-chip${on ? ' on' : ''}" data-rating="${value}"` +
      ` aria-pressed="${on ? 'true' : 'false'}" style="--rc:${ratingColor(value)}"` +
      ` title="${value}/10${on ? '（再点取消）' : ''}">${value}</button>`;
  }

  els.ratingFilter.innerHTML = html;
}

/** 随面板切换 / 设置项开关显隐的那几个控件，统一在这里算一遍，免得散落各处。 */
function applyTagPanelVisibility() {
  const isTags = state.sidePanel === 'tags';
  const open = Boolean(settings.tagSettingsOpen);

  els.tagSettingsToggle.hidden = !isTags;
  els.tagSettingsToggle.classList.toggle('on', open);
  els.tagSettingsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');

  els.ratingFilter.hidden = !isTags;
  els.tagSettings.hidden = !isTags || !open;

  els.tagIncludeWrap.hidden = !isTags || !open;
  els.onlyGroupsWrap.hidden = !isTags || !open;
  els.hidePopularWrap.hidden = !isTags || !open;
}

function renderTags() {
  const filter = state.sideQuery.trim().toLowerCase();
  const filtering = filter.length > 0;

  // 筛选时退回扁平列表：点到哪个标签一目了然，也免得卡片在搜索过程中忽开忽合
  if (filtering && !settings.onlyGroups) {
    const list = state.tags.filter((t) => !isTagHidden(t.tag) && t.tag.toLowerCase().includes(filter));
    setSidebarItems(
      list.map((t) => ({
        kind: 'tag',
        key: `t:${t.tag}`,
        estimate: 31,
        data: t,
        showBadge: Boolean(t.group),
      })),
      '没有匹配的标签',
    );
    return;
  }

  // 按显示出来的去重计数排序（和标签行的 count 是同一个口径），
  // 成员计数之和只在并列时作次级参考
  const groups = state.groupSummaries
    .filter(
      (group) =>
        !filtering ||
        group.representative.toLowerCase().includes(filter) ||
        group.tags.some((tag) => !isTagHidden(tag) && tag.toLowerCase().includes(filter)),
    )
    .sort(
      (a, b) =>
        b.union - a.union || b.total - a.total || a.representative.localeCompare(b.representative, 'zh'),
    );

  // 组里的标签不再单独出现在扁平列表里，全部收进组卡片
  const tags = settings.onlyGroups ? [] : state.tags.filter((tag) => !tag.groupId && !isTagHidden(tag.tag));

  const entries = [];

  for (const group of groups) {
    // 成员全被隐藏的组不入列表：虚拟列表按 estimate 估算高度，
    // 留一个渲染为空串的项会让滚动位置算错
    const visibleMembers = group.members.filter((member) => !isTagHidden(member.tag));
    if (visibleMembers.length === 0) continue;

    const expanded = filtering || state.expandedGroups.has(group.id);
    entries.push({
      kind: 'group',
      sort: group.union,
      key: `g:${group.id}:${expanded ? 1 : 0}`,
      estimate: expanded ? 46 + visibleMembers.length * 28 : 40,
      data: { group, expanded, filtering },
    });
  }

  if (!settings.onlyGroups) {
    for (const tag of tags) {
      entries.push({ kind: 'tag', sort: tag.count, key: `t:${tag.tag}`, estimate: 31, data: tag });
    }
  }

  entries.sort((a, b) => {
    if (a.sort !== b.sort) return b.sort - a.sort;
    if (a.kind !== b.kind) return a.kind === 'group' ? -1 : 1;
    const left = a.kind === 'group' ? a.data.group.representative : a.data.tag;
    const right = b.kind === 'group' ? b.data.group.representative : b.data.tag;
    return left.localeCompare(right, 'zh');
  });

  setSidebarItems(
    entries,
    settings.onlyGroups ? '还没有标签组，在标签的 ⋯ 菜单里新建' : '没有标签',
  );
}

function tagRowHtml(t, showGroupBadge) {
  const badge =
    showGroupBadge && t.group
      ? `<span class="tag-link" title="组内 ${t.group.size} 个成员">组</span>`
      : '';

  return `
    <div class="side-item" data-tag="${escapeHtml(t.tag)}" title="${escapeHtml(t.tag)}">
      <span class="name">${escapeHtml(t.tag)}</span>
      ${badge}
      <span class="cnt">${t.count}</span>
      <button class="tag-more" type="button" data-more="${escapeHtml(t.tag)}" title="标签组操作">⋯</button>
    </div>`;
}

/**
 * 组卡片：标题是「当前计数最多的成员」，只是显示名，不是独立的主标签。
 * 展开后 members 全部列出 —— 包括被拿来当标题的那一个。
 *
 * 标题和折叠按钮是两个独立控件：点标题 = 按整组筛选，点左侧三角 = 展开/折叠。
 */
function groupCardHtml(group, expanded, filtering) {
  // 被隐藏的成员（评分 / 流行度）不列出来；整组都藏光了就连卡片一起不显示，
  // 否则会留下一个展开后空空的壳
  const members = group.members
    .filter((member) => !isTagHidden(member.tag))
    .slice()
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'));

  if (members.length === 0) return '';

  const body = expanded
    ? `<div class="tag-group-members">${members
        .map(
          (member) => `
          <div class="side-item" data-tag="${escapeHtml(member.tag)}" title="${escapeHtml(member.tag)}">
            <span class="name">${escapeHtml(member.tag)}</span>
            <span class="cnt">${member.count}</span>
            <button class="tag-more" type="button" data-more="${escapeHtml(member.tag)}" title="标签组操作">⋯</button>
          </div>`,
        )
        .join('')}</div>`
    : '';

  return `
    <div class="tag-group${expanded ? ' open' : ''}${group.union > 0 ? '' : ' zero'}"
         data-group-card="${escapeHtml(group.id)}">
      <div class="tag-group-head" title="${escapeHtml(group.tags.join(' / '))}">
        <button class="tag-group-toggle" type="button" data-toggle-group="${escapeHtml(group.id)}"
                aria-expanded="${expanded ? 'true' : 'false'}"${filtering ? ' disabled' : ''}
                title="${filtering ? '筛选时自动展开' : '展开 / 折叠'}">
          <span class="tag-group-chevron">▸</span>
        </button>
        <button class="tag-group-title" type="button"
                data-group-search="${escapeHtml(group.representative)}"
                title="按整组筛选（${escapeHtml(group.representative)}）">
          ${escapeHtml(group.representative)}
        </button>
        <span class="tag-link" title="组内 ${group.tags.length} 个成员">${group.tags.length}</span>
        <span class="cnt" title="组内共 ${group.union} 个作品（同一作品打了多个成员标签只算一次）；成员计数之和 ${group.total}">${group.union}</span>
        <button class="tag-more" type="button" data-more-group="${escapeHtml(group.id)}" title="标签组操作">⋯</button>
      </div>
      ${body}
    </div>`;
}

els.sideList.addEventListener('scroll', scheduleSidebarPaint, { passive: true });

// 面板折叠/展开、窗口缩放都会改变可用高度，重新画一遍
new ResizeObserver(() => {
  sidebarView.lastRange = '';
  scheduleSidebarPaint();
}).observe(els.sideList);

els.tagIncludeWork.addEventListener('change', () => {
  settings.tagIncludeWork = els.tagIncludeWork.checked;
  saveSettings();
  loadSidePanel();
});

els.onlyGroups.addEventListener('change', () => {
  settings.onlyGroups = els.onlyGroups.checked;
  saveSettings();
  renderTags();
});

els.hidePopularTags.addEventListener('change', () => {
  settings.hidePopularTags = els.hidePopularTags.checked;
  saveSettings();
  renderTags();
});

els.tagSettingsToggle.addEventListener('click', () => {
  settings.tagSettingsOpen = !settings.tagSettingsOpen;
  saveSettings();
  applyTagPanelVisibility();
});

els.ratingFilter.addEventListener('click', (event) => {
  const chip = event.target.closest('.rating-chip');
  if (!chip) return;

  const value = Number(chip.dataset.rating);
  const chosen = new Set(
    (Array.isArray(settings.ratingFilter) ? settings.ratingFilter : []).map(Number),
  );
  if (chosen.has(value)) chosen.delete(value);
  else chosen.add(value);

  settings.ratingFilter = [...chosen].sort((a, b) => a - b);
  saveSettings();
  renderRatingFilter();
  reloadAll();
});

els.sideTabs.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-panel]');
  if (!btn) return;
  state.sidePanel = btn.dataset.panel;
  state.sideQuery = '';
  els.sideQuery.value = '';
  closeSideMenu();
  loadSidePanel();
});

els.sideList.addEventListener('click', (event) => {
  const more = event.target.closest('[data-more]');
  if (more) {
    event.stopPropagation();
    openTagMenu(more.dataset.more, more);
    return;
  }

  const moreGroup = event.target.closest('[data-more-group]');
  if (moreGroup) {
    event.stopPropagation();
    openGroupMenu(moreGroup.dataset.moreGroup, moreGroup);
    return;
  }

  const authorItem = event.target.closest('[data-author]');
  if (authorItem) {
    const id = authorItem.dataset.author;
    state.authorId = state.authorId === id ? '' : id;
    renderAuthors();
    reloadAll();
    return;
  }

  // 组标题 = 展开 / 折叠（筛选时自动展开，按钮置灰）
  const toggle = event.target.closest('[data-toggle-group]');
  if (toggle) {
    if (!toggle.disabled) {
      const id = toggle.dataset.toggleGroup;
      if (state.expandedGroups.has(id)) state.expandedGroups.delete(id);
      else state.expandedGroups.add(id);
      renderTags();
    }
    return;
  }

  // 组标题 = 按整组筛选（服务端会把代表标签展开成全部同义标签）
  const groupSearch = event.target.closest('[data-group-search]');
  if (groupSearch) {
    addTagToSearch(groupSearch.dataset.groupSearch);
    return;
  }

  const tagItem = event.target.closest('[data-tag]');
  if (tagItem) addTagToSearch(tagItem.dataset.tag);
});

// 右键和 ⋯ 打开同一份菜单
els.sideList.addEventListener('contextmenu', (event) => {
  const tagItem = event.target.closest('[data-tag]');
  const card = event.target.closest('[data-group-card]');
  if (!tagItem && !card) return;
  event.preventDefault();
  if (tagItem) openTagMenu(tagItem.dataset.tag, null, event.clientX, event.clientY);
  else openGroupMenu(card.dataset.groupCard, null, event.clientX, event.clientY);
});

/** 点标签不是立即筛选，而是把它拼进顶部搜索框（用引号包住，标签里可能有空格）。 */
function addTagToSearch(tag) {
  const term = `"${tag}"`;
  const current = els.search.value.trim();
  const next = current ? `${current} AND ${term}` : term;
  els.search.value = next;
  state.query = next;
  reloadAll();
}

// ---------- 标签组：行菜单、编辑器、批量迁移 ----------

const normTag = (tag) => String(tag ?? '').trim().toLowerCase();

function groupOfTag(tag) {
  const key = normTag(tag);
  if (!key) return null;
  return state.tagGroups.find((group) => group.tags.some((member) => normTag(member) === key)) ?? null;
}

function groupSummary(id) {
  return state.groupSummaries.find((group) => group.id === id) ?? null;
}

function closeSideMenu() {
  if (els.sideMenu.hidden) return;
  els.sideMenu.hidden = true;
  els.sideMenu.innerHTML = '';
}

/**
 * 菜单统一入口。
 * items: [{ header } | { empty } | { label, sub, danger, action }]
 */
function openSideMenuAt(items, x, y) {
  els.sideMenu.innerHTML = items
    .map((item, index) => {
      if (item.header) return `<div class="sm-title">${escapeHtml(item.header)}</div>`;
      if (item.empty) return `<div class="sm-empty">${escapeHtml(item.empty)}</div>`;
      const sub = item.sub ? `<span class="sm-sub">${escapeHtml(item.sub)}</span>` : '';
      const cls = item.danger ? 'danger' : '';
      return `<button type="button" data-i="${index}" class="${cls}">${escapeHtml(item.label)}${sub}</button>`;
    })
    .join('');

  els.sideMenu.hidden = false;
  els.sideMenu.style.left = '0px';
  els.sideMenu.style.top = '0px';

  const rect = els.sideMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  els.sideMenu.style.left = `${left}px`;
  els.sideMenu.style.top = `${top}px`;

  els.sideMenu.onclick = (event) => {
    const btn = event.target.closest('button[data-i]');
    if (!btn) return;
    const item = items[Number(btn.dataset.i)];
    closeSideMenu();
    if (item?.action) item.action();
  };
}

/** ⋯ 按钮点出来的位置，或右键的鼠标位置。 */
function menuPoint(anchor, x, y) {
  if (typeof x === 'number' && typeof y === 'number') return { x, y };
  const rect = anchor.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}

function reopenMenu(items) {
  const rect = els.sideMenu.getBoundingClientRect();
  openSideMenuAt(items, rect.left, rect.top);
}

function openTagMenu(tag, anchor, x, y) {
  const group = groupOfTag(tag);
  const items = [];

  if (group) {
    const summary = groupSummary(group.id);
    items.push({
      header: `标签组 · ${summary?.representative ?? group.tags[0]}（${group.tags.length} 个成员）`,
    });
    items.push({ label: '编辑成员…', action: () => openGroupEditor(group) });
    items.push({ label: '移到其它组…', action: () => openGroupPicker(tag) });
    items.push({ label: '从组中移出', action: () => removeTagFromGroup(tag) });
    items.push({
      label: '将所有同组收藏标签迁移到此标签',
      sub: '批量',
      action: () => openConvertDialog(tag),
    });
    items.push({ label: '解散组', danger: true, action: () => dissolveGroup(group.id) });
  } else {
    items.push({ header: tag });
    items.push({ label: '新建标签组', action: () => openGroupEditor({ tags: [tag] }) });
    items.push({ label: '添加到组…', action: () => openGroupPicker(tag) });
  }

  const point = menuPoint(anchor, x, y);
  openSideMenuAt(items, point.x, point.y);
}

function openGroupMenu(groupId, anchor, x, y) {
  const group = state.tagGroups.find((item) => item.id === groupId);
  if (!group) return;
  const summary = groupSummary(groupId);

  const items = [
    { header: summary ? `${summary.representative} · ${group.tags.length} 个成员` : '标签组' },
    { label: '按整组筛选', action: () => summary && addTagToSearch(summary.representative) },
    { label: '编辑成员…', action: () => openGroupEditor(group) },
    { label: '解散组', danger: true, action: () => dissolveGroup(groupId) },
  ];

  const point = menuPoint(anchor, x, y);
  openSideMenuAt(items, point.x, point.y);
}

function openGroupPicker(tag) {
  const current = groupOfTag(tag);
  const groups = state.groupSummaries.filter((group) => group.id !== current?.id);
  const items = [{ header: current ? `移到其它组 · ${tag}` : `添加到组 · ${tag}` }];

  if (groups.length === 0) items.push({ empty: '还没有其它标签组' });
  for (const group of groups) {
    items.push({
      label: group.representative,
      sub: `${group.tags.length} 个`,
      action: () => addTagToGroup(tag, group.id),
    });
  }
  items.push({ label: '新建标签组…', action: () => openGroupEditor({ tags: [tag] }) });

  reopenMenu(items);
}

/** 保存整份组定义；服务端会再做一次归一化与校验。 */
async function saveTagGroups(nextGroups) {
  const data = await api('/api/tag-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groups: nextGroups }),
  });

  state.tagGroups = (data.groups ?? []).map((group) => ({ id: group.id, tags: [...group.tags] }));
  if (data.conflicts?.length) {
    toast(`有 ${data.conflicts.length} 个标签同时出现在两组，已保留在前一组`, 'err');
  }

  await loadSidePanel();
  // 组变了，搜索展开的结果也变了
  reloadAll();
  return data;
}

async function addTagToGroup(tag, groupId) {
  // 面板可能是旧数据（另一个窗口改过组），目标组不见了就先别动手，
  // 否则这个标签会从原组被摘掉却没加到任何地方
  if (!state.tagGroups.some((group) => group.id === groupId)) {
    toast('这个标签组已经不存在，刷新面板后再试', 'err');
    return;
  }

  const key = normTag(tag);
  const next = state.tagGroups
    .map((group) => {
      const tags = group.tags.filter((member) => normTag(member) !== key);
      if (group.id === groupId) tags.push(tag);
      return { id: group.id, tags };
    })
    .filter((group) => group.tags.length >= 2);

  try {
    await saveTagGroups(next);
    const summary = groupSummary(groupId);
    toast(`已把「${tag}」加入${summary ? `「${summary.representative}」` : '标签组'}`);
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
}

async function removeTagFromGroup(tag) {
  const group = groupOfTag(tag);
  if (!group) return;
  const key = normTag(tag);
  const next = state.tagGroups
    .map((item) =>
      item.id === group.id ? { id: item.id, tags: item.tags.filter((t) => normTag(t) !== key) } : item,
    )
    .filter((item) => item.tags.length >= 2);

  try {
    await saveTagGroups(next);
    toast(`已从组中移出「${tag}」`);
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
}

async function dissolveGroup(groupId) {
  try {
    await saveTagGroups(state.tagGroups.filter((group) => group.id !== groupId));
    toast('已解散标签组');
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
}

/* ── 组编辑弹窗 ─────────────────────────────────────────── */

function openGroupEditor(group) {
  state.editingGroup = {
    id: group?.id ?? null,
    tags: Array.isArray(group?.tags) ? [...group.tags] : [],
  };
  els.tgTitle.textContent = group?.id ? '编辑标签组' : '新建标签组';
  els.tgSub.textContent = state.current ? `来源：${state.current}` : '';
  els.tgSearch.value = '';
  els.tgHint.hidden = true;
  els.tgDissolve.hidden = !group?.id;
  els.tgModal.hidden = false;
  document.body.classList.add('bm-open');
  renderGroupEditor();
  els.tgSearch.focus();
}

function closeGroupEditor() {
  els.tgModal.hidden = true;
  state.editingGroup = null;
  document.body.classList.remove('bm-open');
}

function renderGroupEditor() {
  const editing = state.editingGroup;
  if (!editing) return;

  const members = new Set(editing.tags.map(normTag));
  els.tgCount.textContent = `${editing.tags.length} 个`;

  els.tgMembers.innerHTML = editing.tags
    .map(
      (tag, index) =>
        `<span class="bm-chip"><span>${escapeHtml(tag)}</span>` +
        `<button type="button" data-remove="${index}" title="移出">✕</button></span>`,
    )
    .join('');

  // 候选取当前来源的标签；组里已有但当前来源没有的，也补进来，免得看不见
  const candidates = state.tags.slice();
  for (const tag of editing.tags) {
    if (!candidates.some((item) => normTag(item.tag) === normTag(tag))) {
      candidates.push({ tag, count: 0 });
    }
  }

  const filter = els.tgSearch.value.trim().toLowerCase();
  const list = filter ? candidates.filter((item) => item.tag.toLowerCase().includes(filter)) : candidates;

  els.tgCandidates.innerHTML = list
    .slice(0, 300)
    .map(
      (item) =>
        `<button type="button" class="bm-tag${members.has(normTag(item.tag)) ? ' on' : ''}" ` +
        `data-pick="${escapeHtml(item.tag)}">${escapeHtml(item.tag)}` +
        `<i class="bm-tag-count">${item.count}</i></button>`,
    )
    .join('');
}

async function saveGroupEditor() {
  const editing = state.editingGroup;
  if (!editing) return;

  if (editing.tags.length < 2) {
    els.tgHint.hidden = false;
    els.tgHint.textContent = '至少两个标签才能成组';
    return;
  }

  const keys = new Set(editing.tags.map(normTag));
  const next = state.tagGroups.map((group) => ({
    id: group.id,
    tags: group.id === editing.id ? editing.tags : group.tags.filter((tag) => !keys.has(normTag(tag))),
  }));

  if (!editing.id) next.push({ tags: editing.tags });

  // 被摘空的组顺手丢掉；正在编辑的这组已经检查过成员数
  const cleaned = next.filter((group) => group.id === editing.id || group.tags.length >= 2);

  els.tgSave.disabled = true;
  try {
    await saveTagGroups(cleaned);
    closeGroupEditor();
    toast('标签组已保存');
  } catch (err) {
    els.tgHint.hidden = false;
    els.tgHint.textContent = err.message;
  } finally {
    els.tgSave.disabled = false;
  }
}

/* ── 批量迁移 ────────────────────────────────────────────── */

async function openConvertDialog(tag) {
  const group = groupOfTag(tag);
  if (!group) return;

  let total = 0;
  try {
    const data = await api(
      `/api/tag-convert/plan?source=${encodeURIComponent(state.current)}&target=${encodeURIComponent(tag)}`,
    );
    total = data.total ?? 0;
  } catch (err) {
    toast(`统计失败：${err.message}`, 'err');
    return;
  }

  state.pendingConvert = { tag, total };
  els.tcTitle.textContent = `迁移到「${tag}」`;
  els.tcLead.innerHTML = total
    ? `当前来源下有 <b>${total}</b> 个作品的收藏标签包含组内同义标签，会把它们统一迁移成「${escapeHtml(tag)}」；` +
      `只替换组内成员，作品原有的其它收藏标签保留。`
    : '当前来源下没有需要迁移的作品。';
  els.tcStart.disabled = total === 0;
  els.tcModal.hidden = false;
  document.body.classList.add('bm-open');
}

function closeConvertDialog() {
  els.tcModal.hidden = true;
  state.pendingConvert = null;
  document.body.classList.remove('bm-open');
}

function renderConvertBanner(job) {
  const prev = state.lastConvert;
  state.lastConvert = job ?? null;

  if (!job || !job.running) {
    els.convertBanner.hidden = true;
    els.convertFill.style.width = '0%';
    if (prev?.running) finishConvert(prev);
    return;
  }

  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  const label = state.sources.find((item) => item.key === job.source)?.label ?? job.source;

  els.convertBanner.hidden = false;
  els.convertText.innerHTML =
    `<b>正在迁移收藏标签</b> · ${job.done}/${job.total} · 成功 ${job.ok}` +
    `${job.failedCount ? ` · 失败 ${job.failedCount}` : ''}` +
    `<br><span class="muted">目标「${escapeHtml(job.target)}」· ${escapeHtml(label)}` +
    `${job.stopRequested ? ' · 正在停止' : ''}</span>`;
  els.convertFill.style.width = `${pct}%`;
  els.convertStop.disabled = Boolean(job.stopRequested);
  els.convertStop.textContent = job.stopRequested ? '正在停止…' : '停止';
}

function finishConvert(job) {
  if (state.finishedConverts.has(job.id)) return;
  state.finishedConverts.add(job.id);

  const parts = [`迁移结束：成功 ${job.ok} / ${job.total}`];
  if (job.failedCount) parts.push(`失败 ${job.failedCount}`);
  if (job.aborted === 'stopped') parts.push('已手动停止');
  if (job.aborted === 'auth') parts.push('连续鉴权 / 限流错误，已自动中止');
  if (job.aborted === 'error') parts.push('任务异常结束');

  toast(parts.join('，'), job.aborted ? 'err' : '');
  loadSidePanel();
  reloadAll();
}

els.tgMembers.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-remove]');
  if (!btn || !state.editingGroup) return;
  state.editingGroup.tags.splice(Number(btn.dataset.remove), 1);
  renderGroupEditor();
});

els.tgCandidates.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-pick]');
  if (!btn || !state.editingGroup) return;
  const tag = btn.dataset.pick;
  const key = normTag(tag);
  const index = state.editingGroup.tags.findIndex((item) => normTag(item) === key);
  if (index >= 0) state.editingGroup.tags.splice(index, 1);
  else state.editingGroup.tags.push(tag);
  renderGroupEditor();
});

els.tgSearch.addEventListener('input', renderGroupEditor);
els.tgSave.addEventListener('click', saveGroupEditor);
els.tgCancel.addEventListener('click', closeGroupEditor);
els.tgClose.addEventListener('click', closeGroupEditor);
els.tgDissolve.addEventListener('click', () => {
  const id = state.editingGroup?.id;
  closeGroupEditor();
  if (id) dissolveGroup(id);
});

els.tcCancel.addEventListener('click', closeConvertDialog);
els.tcClose.addEventListener('click', closeConvertDialog);
els.tcStart.addEventListener('click', async () => {
  const pending = state.pendingConvert;
  if (!pending) return;

  els.tcStart.disabled = true;
  try {
    const data = await api('/api/tag-convert/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: state.current, target: pending.tag }),
    });
    closeConvertDialog();

    if (!data.started) {
      toast(data.reason ?? '没有需要迁移的作品');
      return;
    }

    toast(`开始迁移：共 ${data.total} 个作品`);
    startPolling();
    await pollQueue();
  } catch (err) {
    toast(`启动失败：${err.message}`, 'err');
    els.tcStart.disabled = false;
  }
});

els.convertStop.addEventListener('click', async () => {
  els.convertStop.disabled = true;
  try {
    await api('/api/tag-convert/stop', { method: 'POST' });
    toast('已请求停止，当前这条完成后收手');
    await pollQueue();
  } catch (err) {
    toast(`停止失败：${err.message}`, 'err');
    els.convertStop.disabled = false;
  }
});

document.addEventListener('mousedown', (event) => {
  if (els.sideMenu.hidden) return;
  if (els.sideMenu.contains(event.target)) return;
  if (event.target.closest('[data-more], [data-more-group]')) return;
  closeSideMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!els.tgModal.hidden) closeGroupEditor();
  else if (!els.tcModal.hidden) closeConvertDialog();
  else closeSideMenu();
});

els.sideList.addEventListener('scroll', closeSideMenu, { passive: true });
window.addEventListener('resize', closeSideMenu);

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

/** 搜索框里以评分词结尾/开头的条件：数字按钮启用时，这些词要被忽略（按钮优先）。 */
function stripRatingTerms(text) {
  const parts = String(text ?? '')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '';
  return parts.filter((part) => ratingValueOfTag(part.replace(/^-/, '')) === 0).join(' ');
}

/** 数字按钮拼出来的评分条件；没选中就是空串。 */
function ratingQueryText() {
  const values = (Array.isArray(settings.ratingFilter) ? settings.ratingFilter : [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 10)
    .sort((a, b) => a - b);

  if (values.length === 0) return '';
  return values.length === 1 ? `${values[0]}/10` : `(${values.map((value) => `${value}/10`).join(' OR ')})`;
}

function buildQuery(offset) {
  const params = new URLSearchParams({
    source: state.current,
    offset: String(offset),
    limit: String(PAGE_SIZE),
    sort: settings.sort,
  });
  // 评分按钮和搜索框里的评分词是同一个筛选维度：按钮有选中时以按钮为准，
  // 否则「7 + 搜索框里写着 9/10」会直接筛成空集。
  const rating = ratingQueryText();
  const queryText = rating ? stripRatingTerms(state.query) : state.query;
  if (queryText) params.set('q', queryText);
  // 默认过滤器和搜索分开传，服务端用 AND 组合 —— 拼成一个字符串的话
  // 用户写的 `a OR b` 会被外层 AND 抢走优先级。评分条件同理，单独走 r。
  const defaultFilter = settings.filterEnabled ? String(settings.defaultFilter ?? '').trim() : '';
  if (defaultFilter) params.set('f', defaultFilter);
  if (rating) params.set('r', rating);
  if (state.tag) params.set('tag', state.tag);
  if (state.authorId) params.set('author_id', state.authorId);
  if (settings.sort === 'random') params.set('seed', String(state.seed));
  return `/api/records?${params}`;
}

// 切类别时可能有旧请求还在飞：用序号作废旧结果，重置也不能被 loading 吞掉
let gridLoadSeq = 0;

async function loadPage(reset) {
  if (state.loading && !reset) return;

  if (reset) {
    gridLoadSeq += 1; // 让在飞的那次作废
    resetGridRender();
    state.offset = 0;
    state.total = 0;
    state.records = [];
    hoveredRecord = null; // 旧卡片已经没了，别让 L / C 指到不存在的作品
    document.querySelector('.grid-wrap').scrollTop = 0;
  }

  const seq = ++gridLoadSeq;
  state.loading = true;

  try {
    const data = await api(buildQuery(state.offset));
    if (seq !== gridLoadSeq) return; // 期间又切了类别，这页已经过期

    state.total = data.total;
    state.records.push(...data.items);
    state.offset += data.items.length;

    updateCounter();
    scheduleGridPaint(true);
  } catch {
    // 加载失败保持现状：滚动到底会自动重试，不必打断已渲染的内容
  } finally {
    if (seq === gridLoadSeq) state.loading = false;
  }
}

function updateCounter() {
  els.counter.textContent = `${state.records.length} / ${state.total}`;
}

function reloadAll() {
  loadPage(true);
}

/* ── 网格虚拟列表 ──────────────────────────────────────────
 * 只渲染视口附近的行，用绝对定位把行摆到算好的位置上；滚动条高度按
 * 「总行数 × 每行高度」一开始就撑满，不会随着滚动一截截变长。
 *
 * 行高先估后测：固定比例时估得基本准，原图比例时用已测行的均值，随着滚动
 * 逐步修正 —— 原图模式下滚动条轻微跳动是预期行为。
 *
 * 卡片按行复用：滚出视口的行先从 DOM 摘下放进池子里，滚回来直接挂上，
 * 避免反复重建 DOM 和重新解码缩略图。
 */

const gridView = {
  rows: new Map(), // 行号 -> 行元素（含已摘下的池）
  heights: new Map(), // 行号 -> 实测高度
  sample: 0, // 已测行高的滑动均值，用来估未加载的行
  layout: null,
  lastRange: '',
  frame: 0,
  // 换布局时记下的滚动百分比；只在新布局的第一次重画里换算成位置
  heldRatio: null,
  ratioApplied: false,
  ratioLastTotal: 0, // 上一次校正时的总高度，用来判断行高是否还在变
  ratioStable: 0,
  heldRatioUntil: 0, // 锁定的最晚时间，避免行高一直不稳定时把用户卡住
  skipAnchor: 0, // 重排后的前几轮不做锚点补偿（由 heldRatio 接管）
};

function gridLayout() {
  const wrap = document.querySelector('.grid-wrap');
  const width = Math.max(0, wrap.clientWidth - 28); // 两侧各 14px
  const gap = 12;
  const cols = Math.max(1, Math.floor((width + gap) / (settings.cardWidth + gap)));
  return { cols, gap, width, pad: 14 };
}

function gridRowEstimate() {
  if (gridView.sample) return gridView.sample;

  const { cols, gap, width } = gridView.layout;
  const colW = (width - gap * (cols - 1)) / cols;
  const ratio =
    settings.ratio === 'auto'
      ? 1.33
      : (() => {
          const [a, b] = settings.ratio.split(':').map(Number);
          return b / a;
        })();

  // 信息区：上下 padding 16 + 标题行 16 + 作者/星星行 15，再留一点余量
  const info = settings.showOwnTags || settings.showTags ? 69 : 49;
  return colW * ratio + 2 + (settings.overlayInfo ? 0 : info);
}

function forgetCard(card) {
  const pid = String(card.dataset.pid);
  if (state.cardMap.get(pid) === card) state.cardMap.delete(pid);
  state.observer?.unobserve(card);
}

/** 清掉所有行元素，但保留记录和布局。 */
function clearGridRows() {
  for (const el of gridView.rows.values()) el.remove();
  gridView.rows.clear();
  for (const card of state.cardMap.values()) state.observer?.unobserve(card);
  state.cardMap.clear();
  els.grid.innerHTML = '';
  gridView.lastRange = '';
}

/**
 * 布局或卡片外观变化：行高缓存也一起作废。
 *
 * 注意这里故意**不把 .grid 的高度清零**。高度一旦变成 0，浏览器的滚动范围跟着消失，
 * 会把 scrollTop 夹到 0 —— 开关侧栏之后网格跳回顶部就是这么来的。
 * 保留旧高度，浏览器就会自己把 scrollTop 原样留住，下一次 paintGrid 再把高度改成新值。
 */
function resetGridRender() {
  clearGridRows();
  gridView.heights.clear();
  gridView.sample = 0;
  gridView.layout = null;
}

function makeGridRow(index) {
  const { cols } = gridView.layout;
  const el = document.createElement('div');
  el.className = 'grid-row';
  el.dataset.row = String(index);
  el.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

  const start = index * cols;
  for (let k = 0; k < cols; k += 1) {
    const record = state.records[start + k];
    if (!record) break;
    el.appendChild(createCard(record, { eager: true }));
  }

  return el;
}

/** 复用的行里，记录对象可能已经因为编辑被替换过，逐张对一下。 */
function syncGridRow(el, index) {
  const { cols } = gridView.layout;
  const cards = [...el.children];

  // 记录是分页追加的，最后一行的卡片数会变多，缺的要补上
  for (let k = 0; k < cols; k += 1) {
    const record = state.records[index * cols + k];
    if (!record) break;
    if (k < cards.length) {
      if (cards[k]._sig !== cardSignature(record)) refreshCard(cards[k], record);
    } else {
      el.appendChild(createCard(record, { eager: true }));
    }
  }
}

function scheduleGridPaint(force = false) {
  if (gridView.frame) return;
  gridView.frame = requestAnimationFrame(() => {
    gridView.frame = 0;
    paintGrid(force);
  });
}

function paintGrid(force = false) {
  const wrap = document.querySelector('.grid-wrap');

  // 先定布局。宽度或列数变了，行高也不再成立
  const layout = gridLayout();
  if (
    !gridView.layout ||
    Math.abs(layout.width - gridView.layout.width) > 0.5 ||
    layout.cols !== gridView.layout.cols
  ) {
    // 布局要变了，先记下「现在滚了百分之几」。清行之前量，高度还在，比值才有效。
    // 虚拟列表没法靠浏览器自己保住位置：列数一变，偏移量对应的内容就全换了。
    const range = wrap.scrollHeight - wrap.clientHeight;
    gridView.heldRatio =
      range > 0 ? Math.min(1, Math.max(0, wrap.scrollTop / range)) : null;
    gridView.ratioApplied = false;
    gridView.ratioLastTotal = 0;
    gridView.ratioStable = 0;
    gridView.heldRatioUntil = Date.now() + 800; // 兜底：行高一直没稳定也别锁太久

    clearGridRows();
    gridView.heights.clear();
    gridView.sample = 0;
    gridView.layout = layout;
    gridView.skipAnchor = 3; // 含视口上方两行的实测轮次，一起跳过
  }

  if (state.total === 0 && state.records.length === 0) {
    els.grid.innerHTML = '<div class="empty">这个筛选条件下没有作品。</div>';
    els.grid.style.height = 'auto';
    return;
  }

  const { cols, gap, pad } = gridView.layout;
  const rowCount = Math.max(1, Math.ceil(Math.max(state.total, state.records.length) / cols));

  // 上一次可能是空结果，占位提示要清掉
  els.grid.querySelector('.empty')?.remove();
  const estimate = gridRowEstimate();

  const prefix = new Array(rowCount + 1);
  prefix[0] = 0;
  // 行与行之间也要留 gap：前缀里把「行高 + 间距」一起累加，
  // 最后再把末尾多算的那一个间距减掉
  for (let i = 0; i < rowCount; i += 1) {
    prefix[i + 1] = prefix[i] + (gridView.heights.get(i) ?? estimate) + gap;
  }

  // 按记下的百分比还原滚动位置：先把新总高度撑起来，否则 scrollTop 会被夹在旧范围里。
  // 这一次用的是估算行高，只是先把位置放个大概，避免画到第一行去。
  if (gridView.heldRatio !== null && !gridView.ratioApplied) {
    const total = pad * 2 + prefix[rowCount] - gap;
    els.grid.style.height = `${total}px`;
    const range = total - wrap.clientHeight;
    wrap.scrollTop = range > 0 ? gridView.heldRatio * range : 0;
    gridView.ratioApplied = true;
  }

  const scrollTop = wrap.scrollTop;
  const viewTop = Math.max(0, scrollTop - pad);
  const viewBottom = scrollTop + wrap.clientHeight;
  const first = findSlot(prefix, viewTop);
  const last = findSlot(prefix, Math.min(viewBottom, prefix[rowCount]));
  const start = Math.max(0, first - 2);
  const end = Math.min(rowCount, last + 3);

  const loadedRows = Math.ceil(state.records.length / cols);
  const sig = `${start}:${end}:${loadedRows}:${rowCount}`;

  if (!force && sig === gridView.lastRange) {
    // 范围没变也要看看要不要继续加载
    if (state.offset < state.total && !state.loading && end >= loadedRows - 1) loadPage(false);
    return;
  }
  gridView.lastRange = sig;

  for (let i = start; i < end && i < loadedRows; i += 1) {
    let el = gridView.rows.get(i);
    if (!el) {
      el = makeGridRow(i);
      gridView.rows.set(i, el);
    } else {
      syncGridRow(el, i);
    }
    el.style.top = `${pad + prefix[i]}px`;
    if (el.parentNode !== els.grid) els.grid.appendChild(el);
  }

  // 视口外的行先摘下；离得太远的直接回收，避免整个列表都留在内存里
  for (const [i, el] of gridView.rows) {
    if (i >= start && i < end) continue;
    el.remove();
    if (i < start - 10 || i >= end + 10) {
      for (const card of el.querySelectorAll('.card')) forgetCard(card);
      gridView.rows.delete(i);
    }
  }

  els.grid.style.height = `${pad * 2 + prefix[rowCount] - gap}px`;
  wrap.dispatchEvent(new Event('scroll'));

  // 新挂上来的行量一下真实高度
  let measured = false;
  for (let i = start; i < end && i < loadedRows; i += 1) {
    if (gridView.heights.has(i)) continue;
    const el = gridView.rows.get(i);
    if (!el) continue;
    const height = el.offsetHeight;
    if (height > 0) {
      gridView.heights.set(i, height);
      gridView.sample = gridView.sample ? gridView.sample * 0.7 + height * 0.3 : height;
      measured = true;
    }
  }

  if (measured) {
    const next = new Array(rowCount + 1);
    next[0] = 0;
    for (let i = 0; i < rowCount; i += 1) {
      next[i + 1] = next[i] + (gridView.heights.get(i) ?? estimate) + gap;
    }
    els.grid.style.height = `${pad * 2 + next[rowCount] - gap}px`;
    wrap.dispatchEvent(new Event('scroll'));

    if (gridView.skipAnchor > 0) {
      // 刚换过布局：行都是新建的，别再按「行高差」去推 scrollTop
      gridView.skipAnchor -= 1;
    } else {
      // 平时滚动时，视口上方行高变准了就把锚点行拉回原来的屏幕位置
      const delta = next[first] - prefix[first];
      if (first > 0 && Math.abs(delta) > 0.5) wrap.scrollTop = scrollTop + delta;
    }

    gridView.lastRange = '';
    scheduleGridPaint();
  }

  if (hoveredRecord) {
    const card = state.cardMap.get(String(hoveredRecord.pid));
    if (!card || !card.isConnected) hoveredRecord = null;
  }

  settleHeldRatio(wrap);

  if (state.offset < state.total && !state.loading && end >= loadedRows - 1) loadPage(false);
}

/**
 * 换布局后，行高要过几轮才会从估算变成实测，总高度跟着变 —— 百分比的分母一直在动。
 * 所以只要总高度还在变，就按同一个百分比把位置再落一次；连续两次算出来一样才算稳定，
 * 之后交还给用户（wheel / 触摸会立刻解除锁定）。
 */
function settleHeldRatio(wrap) {
  if (gridView.heldRatio === null) return;

  if (Date.now() > gridView.heldRatioUntil) {
    gridView.heldRatio = null;
    gridView.ratioApplied = false;
    return;
  }

  const totalH = wrap.scrollHeight;
  if (Math.abs(totalH - gridView.ratioLastTotal) > 1) {
    gridView.ratioLastTotal = totalH;
    gridView.ratioStable = 0;

    const range = totalH - wrap.clientHeight;
    if (range <= 0) return;

    const target = gridView.heldRatio * range;
    if (Math.abs(target - wrap.scrollTop) > 0.5) {
      wrap.scrollTop = target;
      gridView.lastRange = '';
      scheduleGridPaint();
    }
    return;
  }

  gridView.ratioStable += 1;
  if (gridView.ratioStable >= 2) {
    gridView.heldRatio = null;
    gridView.ratioApplied = false;
  }
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

/** 把卡片里的缩略图从 data-src 切到真实 src。虚拟列表里卡片都在视口附近，直接加载。 */
function loadCardImage(card) {
  const img = card.querySelector('img[data-src]');
  if (!img) return;

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

/** 卡片上会变的那些字段，拼成一个签名；行被回收后靠它判断要不要重画。 */
function cardSignature(record) {
  return JSON.stringify([
    record.title,
    record.author,
    record.hasImage,
    record.hasCover,
    record.localNovel,
    record.localUgoira,
    record.downloading,
    record.error ?? '',
    record.removed ?? '',
    record.status ?? '',
    record.pages,
    record.bookmark_tags ?? [],
    (record.tags ?? []).length,
    ratingValueOf(record),
  ]);
}

function createCard(record, { eager = false } = {}) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.pid = record.pid;
  card._record = record;
  card._sig = cardSignature(record);
  renderCardInner(card, record);

  // 用 _record 而不是闭包里的 record：卡片可能被回收复用，记录对象会换新的
  card.addEventListener('click', () => {
    if (card._record) openLightbox(card._record, card);
  });
  card.addEventListener('mouseenter', () => {
    hoveredRecord = card._record;
  });
  card.addEventListener('mouseleave', () => {
    if (hoveredRecord === card._record) hoveredRecord = null;
  });
  state.cardMap.set(String(record.pid), card);

  if (!state.observer) {
    state.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          state.observer.unobserve(entry.target);

          loadCardImage(entry.target);

          const target = entry.target._record;
          if (target) queueForDownload(target);
        }
      },
      { root: document.querySelector('.grid-wrap'), rootMargin: '400px' },
    );
  }
  state.observer.observe(card);

  if (eager) loadCardImage(card);

  return card;
}

/** 叠纸图标：多图作品的页数角标用，跟 pixiv 网页端一个意思 */
const PAGES_ICON =
  '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
  '<rect x="2.5" y="1.5" width="8" height="10" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".8"/>' +
  '<rect x="5.5" y="4.5" width="8" height="10" rx="1.2" fill="#000" fill-opacity=".6" stroke="currentColor" stroke-width="1.3"/>' +
  '</svg>';

// ---------- 评分 ----------

/**
 * 评分就是收藏标签里的 `n/10`（n = 1~10），不是独立字段。
 * 服务端的同一套规则在 src/rating.mjs；这里只做显示和快捷修改，格式必须一致。
 */
const RATING_TAG_RE = /^(\d{1,2})\s*\/\s*10$/;

function ratingValueOfTag(tag) {
  const matched = RATING_TAG_RE.exec(String(tag ?? '').trim());
  if (!matched) return 0;
  const value = Number(matched[1]);
  return Number.isInteger(value) && value >= 1 && value <= 10 ? value : 0;
}

function isRatingTag(tag) {
  return ratingValueOfTag(tag) > 0;
}

/** 从记录里取评分；没有就是 0。 */
function ratingValueOf(record) {
  for (const tag of record?.bookmark_tags ?? []) {
    const value = ratingValueOfTag(tag);
    if (value) return value;
  }
  return 0;
}

/**
 * 十个档位各自一个色相：1 红 → 4 橙 → 5~7 黄（相邻档差别小，本来就都在「黄区」），
 * 8 绿、9 青、10 亮青 —— 高分段是最常用的，色相间隔拉大了好一眼区分。
 *
 * 10 除了颜色，还有额外的高光（`.stars.max` 的辉光和呼吸动画）。
 */
const RATING_COLORS = {
  1: '#ff4d5a',
  2: '#ff6b45',
  3: '#ff8a3d',
  4: '#ffab3d',
  5: '#ffd23f',
  6: '#f0e63a',
  7: '#dbe63d',
  8: '#57d97c',
  9: '#2fd6cf',
  10: '#9ff6ff',
};

function ratingHex(value) {
  const key = Math.round(Number(value) || 0);
  return RATING_COLORS[key] ?? RATING_COLORS[5];
}

/** #rrggbb → rgba(...)，用来给标签做半透明底色。 */
function withAlpha(hex, alpha) {
  const text = String(hex).replace('#', '');
  const full =
    text.length === 3
      ? text
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : text;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function ratingColor(value, kind = 'text') {
  const hex = ratingHex(value);
  return kind === 'bg' ? withAlpha(hex, 0.16) : hex;
}

/** 评分标签的内联样式：卡片、详情面板、阅读器、编辑弹窗统一用它。 */
function ratingTagInline(value) {
  if (!value) return '';
  // 10 分额外加一点光，和 9 分拉开距离
  const glow = Number(value) === 10 ? `;text-shadow:0 0 7px ${withAlpha(ratingHex(10), 0.55)}` : '';
  return `color:${ratingColor(value, 'text')};background:${ratingColor(value, 'bg')}${glow}`;
}

/**
 * 5 颗星 = 10 分，每颗星 2 分。奇数分靠半颗星表示：
 * 7 分 = 三颗满星 + 第四颗半星。
 *
 * 用同一个字符叠两层（底色 + 裁剪后的彩色层）而不是 SVG，是为了两层像素级对齐。
 */
function starsHtml(rating, { pid = '', small = false, clear = true } = {}) {
  const value = Number(rating) || 0;
  const stars = [1, 2, 3, 4, 5]
    .map((index) => {
      const fill = Math.max(0, Math.min(2, value - (index - 1) * 2)) * 50;
      return (
        `<button type="button" class="star" data-star="${index}" style="--fill:${fill}%"` +
        ` aria-label="${index * 2 - 1} 或 ${index * 2} 分"` +
        ` title="左半 ${index * 2 - 1} 分 · 右半 ${index * 2} 分">` +
        '<i class="star-base">★</i><i class="star-fill">★</i></button>'
      );
    })
    .join('');

  const clearButton = clear
    ? `<button type="button" class="star-clear" title="清除评分" aria-label="清除评分"${
        value ? '' : ' hidden'
      }>×</button>`
    : '';

  return (
    `<div class="stars${small ? ' small' : ''}${value ? ' rated' : ''}${
      value === 10 ? ' max' : ''
    }" data-rating="${value}"` +
    ` data-pid="${escapeHtml(pid)}" style="--rc:${value ? ratingColor(value) : 'transparent'}"` +
    ` role="group" aria-label="${value ? `评分 ${value} 分，满分 10 分` : '未评分'}">` +
    `${stars}${clearButton}</div>`
  );
}

/**
 * 让一排星星可点击。点左半边给奇数分、右半边给偶数分，悬停实时预览。
 *
 * 只负责画，不改数据 —— 真正写 pixiv 的是 setRating，成功返回后才重画。
 */
function bindStars(container, getValue, onPick) {
  if (!container) return;

  const paint = (value) => {
    container.dataset.rating = String(value);
    container.classList.toggle('rated', value > 0);
    // 10 分多一层辉光，预览到 10 分时也要能提前看到
    container.classList.toggle('max', Number(value) === 10);
    container.style.setProperty('--rc', value ? ratingColor(value) : 'transparent');
    for (const star of container.querySelectorAll('.star')) {
      const index = Number(star.dataset.star);
      const fill = Math.max(0, Math.min(2, value - (index - 1) * 2)) * 50;
      star.style.setProperty('--fill', `${fill}%`);
    }
    const clear = container.querySelector('.star-clear');
    if (clear) clear.hidden = !value;
  };

  const valueAt = (event, star) => {
    const rect = star.getBoundingClientRect();
    // 点左半边 = 奇数分，右半边 = 偶数分
    const half = event.clientX - rect.left < rect.width / 2 ? 1 : 2;
    return (Number(star.dataset.star) - 1) * 2 + half;
  };

  container.addEventListener('mousemove', (event) => {
    const star = event.target.closest('.star');
    if (!star) {
      paint(getValue());
      return;
    }
    paint(valueAt(event, star));
  });

  // 失败时要把悬停预览抹掉，恢复成记录里真实的分数
  container._paint = paint;

  container.addEventListener('mouseleave', () => paint(getValue()));

  container.addEventListener('click', (event) => {
    event.stopPropagation(); // 卡片上的星星不能顺带打开大图

    if (event.target.closest('.star-clear')) {
      onPick(0);
      return;
    }
    const star = event.target.closest('.star');
    if (!star) return;
    onPick(valueAt(event, star));
  });
}

/** 一次只改一个作品，避免连点星星把请求叠起来。 */
const ratingBusy = new Set();

function ratingRows(pid) {
  return document.querySelectorAll(`.stars[data-pid="${CSS.escape(String(pid))}"]`);
}

function markRatingBusy(pid, busy) {
  for (const row of ratingRows(pid)) {
    row.classList.toggle('busy', busy);
    row.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
}

/** 把同一作品的所有星星重画成真实分数（清掉悬停预览 / 乐观假象）。 */
function repaintRatingRows(pid, value) {
  for (const row of ratingRows(pid)) row._paint?.(value);
}

/** 把接口返回的结果写进内存记录（只有服务端确认成功后才调用）。 */
function applyBookmarkResult(record, data) {
  if (Array.isArray(data.tags)) record.bookmark_tags = data.tags;
  if (data.source) record.source = data.source;
  if (data.id !== undefined) record.id = data.id;
  record.private_bookmark = /Private$/.test(record.source ?? '') ? 'yes' : 'no';
}

async function setRating(record, value) {
  const pid = String(record.pid);
  if (ratingBusy.has(pid)) return;

  const current = ratingValueOf(record);
  if (value === current) return; // 点当前分数不算改动，别白发请求

  ratingBusy.add(pid);
  markRatingBusy(pid, true);
  try {
    const data = await api('/api/bookmark/rating', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: record.pid, source: record.source, rating: value }),
    });

    applyBookmarkResult(record, data);
    if (!data.moved) toast(value ? `评分已设为 ${value}/10` : '已清除评分');
    await afterBookmarkSaved(record, data.moved);
  } catch (err) {
    // 没成功就别让画面停在「已打分」的预览上
    repaintRatingRows(pid, ratingValueOf(record));

    if (err.data?.code === 'TAGS_FULL') {
      // 10 个标签已满，且原来没有评分 —— 让用户挑一个删掉
      openRatingTagPicker(record, value, err.data.tags ?? []);
    } else {
      toast(`评分没改成：${err.message}`, 'warn');
    }
  } finally {
    ratingBusy.delete(pid);
    markRatingBusy(pid, false);
  }
}

/* ── 标签已满：挑一个删，同时写入评分 ──────────────────── */

let pickState = null;
let pickBusy = false;

function setPickStatus(text, tone = 'ok') {
  els.bmPickStatus.textContent = text;
  els.bmPickStatus.className = `bm-status ${tone}`;
  els.bmPickStatus.hidden = !text;
}

function renderPickList(tags) {
  els.bmPickList.innerHTML = tags
    .map((tag) => {
      const style = ratingTagInline(ratingValueOfTag(tag));
      return (
        `<button type="button" class="bm-pick-tag" data-tag="${escapeHtml(tag)}"${
          style ? ` style="${style}"` : ''
        }>${escapeHtml(tag)}<span class="bm-pick-del">删除</span></button>`
      );
    })
    .join('');
}

function openRatingTagPicker(record, rating, tags) {
  pickState = { record, rating, tags: [...tags] };
  pickBusy = false;
  els.bmPickLead.textContent = `收藏标签已经有 10 个了。要给这个作品打 ${rating}/10，先点一个标签删掉：`;
  setPickStatus('');
  renderPickList(tags);
  els.bmPick.hidden = false;
  document.body.classList.add('bm-open');
}

function closeRatingTagPicker() {
  if (pickBusy) return;
  els.bmPick.hidden = true;
  document.body.classList.remove('bm-open');
  pickState = null;
}

async function pickDropTag(tag) {
  const state = pickState;
  if (!state || pickBusy) return;

  pickBusy = true;
  for (const button of els.bmPickList.querySelectorAll('button')) button.disabled = true;
  setPickStatus(`正在写入 pixiv：删掉「${tag}」并打 ${state.rating}/10…`, 'busy');

  try {
    const data = await api('/api/bookmark/rating', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pid: state.record.pid,
        source: state.record.source,
        rating: state.rating,
        drop: tag,
      }),
    });

    els.bmPick.hidden = true;
    document.body.classList.remove('bm-open');
    pickState = null;

    applyBookmarkResult(state.record, data);
    toast(`已评分 ${data.rating}/10，删掉了「${tag}」`);
    await afterBookmarkSaved(state.record, data.moved);
  } catch (err) {
    if (err.data?.code === 'TAGS_FULL') {
      // 期间网站在别处又加了标签，刷新列表再来一次
      state.tags = err.data.tags ?? state.tags;
      renderPickList(state.tags);
      setPickStatus('标签还是满的，再挑一个', 'err');
    } else {
      setPickStatus(`失败：${err.message}`, 'err');
    }
  } finally {
    pickBusy = false;
    if (!els.bmPick.hidden) {
      for (const button of els.bmPickList.querySelectorAll('button')) button.disabled = false;
    }
  }
}

/**
 * 收藏标签的全局使用次数（服务端算好，键是转小写后的标签）。
 *
 * 卡片上只有 4 个标签位，顺序按「这个标签在我的收藏里出现过多少次」排，
 * 让最常用的分类优先露出来；同次数时保持记录里的原始顺序（sort 是稳定的）。
 */
const tagUsage = new Map();

async function loadTagUsage() {
  try {
    const data = await api('/api/tag-usage');
    tagUsage.clear();
    for (const [tag, count] of Object.entries(data.usage ?? {})) tagUsage.set(tag, count);
  } catch {
    /* 拿不到就按原顺序排，不影响浏览 */
  }
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

  // 多图作品在右上角标页数（和 pixiv 网页端一样）。动图的 pages 是帧数，
  // 小说的是 1，都不该显示这个角标。
  const totalPages = Number(record.pages) || 1;
  const pageBadge =
    !isNovel && record.type !== 'ugoira' && totalPages > 1
      ? `<span class="badge pages" title="共 ${totalPages} 页">${PAGES_ICON}<b>${totalPages}</b></span>`
      : '';  let frame;
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

  const rating = ratingValueOf(record);
  // 开了评分指示器就把评分标签让出标签位：星星已经表达了同一件事，
  // 没必要再占卡片上有限的 4 个格子
  const ownAll = settings.showOwnTags
    ? (record.bookmark_tags ?? []).filter((tag) => !(settings.showRating && isRatingTag(tag)))
    : [];
  const worksAll = settings.showTags ? record.tags ?? [] : [];

  // 同一个标签可能既是收藏标签又是作品标签。两处都显示时只保留收藏标签那一份，
  // 否则卡片上会出现两个一模一样的胶囊（颜色还不同，看着像 bug）。
  const key = (tag) => String(tag ?? '').trim().toLowerCase();
  const ownKeys = new Set(ownAll.map(key));
  const worksUnique = worksAll.filter((tag) => !ownKeys.has(key(tag)));

  // 标签位优先给用得最多的收藏标签
  const own = [...ownAll]
    .sort((a, b) => (tagUsage.get(key(b)) ?? 0) - (tagUsage.get(key(a)) ?? 0))
    .slice(0, 4);
  const works = worksUnique.slice(0, 3);
  const tagHtml =
    own.length || works.length
      ? `<div class="card-tags">${own
          .map((t) => {
            const style = ratingTagInline(ratingValueOfTag(t));
            return `<span class="card-tag own"${style ? ` style="${style}"` : ''}>${escapeHtml(t)}</span>`;
          })
          .join('')}${works
          .map((t) => `<span class="card-tag">${escapeHtml(t)}</span>`)
          .join('')}</div>`
      : '';

  // 星星和标题 / 作者同一个容器：没开「信息叠在图上」时它就落在封面外面，
  // 开了之后跟着整块信息区一起压到图底，不会再和文字打架
  const ratingBadge = settings.showRating
    ? `<div class="card-rating${rating ? ' rated' : ''}">${starsHtml(rating, {
        pid: record.pid,
        small: true,
        clear: false, // 卡片上不给 ×，清除去详情面板
      })}</div>`
    : '';

  card.innerHTML = `
    <div class="frame" style="padding-top:${ratioPadding(record).toFixed(2)}%">${frame}${badge}${pageBadge}${spinner}<button class="card-copy" type="button" title="复制作品链接 (L)" aria-label="复制作品链接">${COPY_ICON}</button></div>
    <div class="info">
      <div class="title">${escapeHtml(record.title || '(无题)')}</div>
      <div class="sub"><span class="author-name">${escapeHtml(record.author || '未知')}</span>${ratingBadge}</div>
      ${tagHtml}
    </div>
  `;

  // 星星要单独绑：每次重渲染都会重建 DOM
  bindStars(
    card.querySelector('.card-rating .stars'),
    () => ratingValueOf(record),
    (value) => setRating(record, value),
  );

  const copyBtn = card.querySelector('.card-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', (event) => {
      event.stopPropagation(); // 别顺带打开大图
      copyLink(record);
    });
  }

  const authorEl = card.querySelector('.author-name');
  if (authorEl && record.author_id) {
    authorEl.addEventListener('click', (event) => {
      event.stopPropagation(); // 别顺带打开大图
      state.authorId = record.author_id;
      renderAuthors();
      reloadAll();
    });
  }
}

function refreshCard(card, record) {
  card._record = record;
  card._sig = cardSignature(record);
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
  } catch {
    // 网络抖一下不打断浏览，下次滚动会重新提交这几个 pid
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

    // 休息中也要继续轮询，否则横幅上的倒计时会停在原地不动
    const paused = Boolean(snapshot.queue.pacer?.paused);
    // 批量转换在跑时同样不能停轮询，否则顶部进度条会僵住
    const converting = Boolean(snapshot.convert?.running);
    if (converting) startPolling();

    if (!snapshot.queue.running && inFlightCount(snapshot.queue) === 0 && !paused && !converting) {
      idleTicks += 1;
      if (idleTicks >= 3) stopPolling();
    } else {
      idleTicks = 0;
    }
  } catch {
    stopPolling();
  }
}

/**
 * 在飞任务数：作品任务和单页任务都在同一条队列里，服务端直接给一个数。
 * 顶栏和右栏都用它，口径一致。
 */
function inFlightCount(q) {
  return q.pending + (q.activeCount ?? (q.active ? 1 : 0));
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
  renderGuardBanner(data.guard);
  renderPacerBanner(data.queue?.pacer);
  renderConvertBanner(data.convert);

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
  // 队列里作品任务和单页任务混在一起，计数只有一个 —— 不再区分「补页」
  const inFlight = inFlightCount(q);

  // 进度条按已完成 /（已完成 + 在飞）算
  const base = q.processed + inFlight;
  els.dlBar.style.width = `${base > 0 ? Math.round((q.processed / base) * 100) : 0}%`;

  const bits = [];
  // 休息中先说这件事，否则「没有进度」看着像卡住了
  if (q.pacer?.paused) bits.push(`<span class="now">☾ 休息 ${formatCountdown(q.pacer.remainingMs)}</span>`);
  if (q.active) bits.push(`<span class="now">● ${q.active}</span>`);
  if (q.pending > 0) bits.push(`队列 ${q.pending}`);
  if (q.processed > 0) bits.push(`本次完成 ${q.processed} 项`);
  if (q.failedCount > 0) bits.push(`失败 ${q.failedCount}`);
  els.dlMeta.innerHTML = bits.length ? bits.join(' · ') : '队列空闲';

  els.queueState.classList.toggle('busy', Boolean(inFlight));
  els.queueState.textContent = inFlight ? `队列 ${inFlight}` : '';

  els.dlAll.disabled = inFlight > 0;
  const anyFirstMissing = data.sources.some((s) => (s.firstMissing ?? 0) > 0);
  els.dlFirst.disabled = inFlight > 0 || !anyFirstMissing;
  els.dlFirst.title = anyFirstMissing
    ? '每个作品只下载第一页，已有任意一页的作品跳过'
    : '所有作品都已有首张，暂时不用补';
  els.dlClear.disabled = q.pending === 0 && !q.active;

  els.dlSources.innerHTML = data.sources
    .map((s) => {
      // 按来源也按页显示，鼠标悬停给出作品数
      const missingPages = s.pages?.missing ?? s.missing;
      const title = `${s.label}：${s.pages?.done ?? 0}/${s.pages?.total ?? 0} 页 · ${s.done}/${s.total} 个作品`;
      const empty = missingPages === 0;
      // 首张缺口：一个作品都没有首图时，右边那个「首页」按钮就没必要点亮
      const noFirst = s.firstMissing ?? 0;
      return `
      <div class="dl-source-row">
        <button data-source="${s.key}" ${empty ? 'disabled' : ''} title="${escapeHtml(title)}">
          <span>${escapeHtml(s.label)}</span>
          <span class="n">${empty ? '✓' : missingPages}</span>
        </button>
        <button class="dl-source-first" data-source-first="${s.key}" ${noFirst === 0 ? 'disabled' : ''} title="只下载「${escapeHtml(s.label)}」里每个作品的第一页（${noFirst} 个作品还缺首张）">首页</button>
      </div>`;
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
  try {
    const data = await api('/api/enqueue-all', { method: 'POST' });
    // 被守卫拦下时队列不会动，直接刷新一次状态好把横幅显示出来
    if (data.blocked) { els.dlAll.disabled = false; await pollQueue(); return; }
    startPolling();
  } catch (err) {
    els.dlAll.disabled = false;
  }
});

/**
 * 批量「只下首页」：source 为空表示所有来源。
 *
 * 服务端按 mode=first 只给「一张图都还没有」的作品排队，已经下过首张的直接跳过，
 * 所以重复点也不会白跑。
 */
async function enqueueFirstPages(source, btn) {
  btn?.setAttribute('disabled', '');
  try {
    const qs = new URLSearchParams({ mode: 'first' });
    if (source) qs.set('source', source);
    const data = await api(`/api/enqueue-all?${qs.toString()}`, { method: 'POST' });
    // 被守卫拦下时队列不会动，直接刷新一次状态把横幅显示出来
    if (data.blocked) {
      await pollQueue();
      return;
    }
    startPolling();
  } catch {
    btn?.removeAttribute('disabled');
  }
}

els.dlFirst.addEventListener('click', () => enqueueFirstPages(null, els.dlFirst));

els.dlClear.addEventListener('click', async () => {
  try {
    const data = await api('/api/queue/clear', { method: 'POST' });
    startPolling();
  } catch (err) {
  }
});

els.dlVerify.addEventListener('click', async () => {
  els.dlVerify.disabled = true;
  try {
    await api('/api/verify', { method: 'POST' });
    startPolling();
  } catch (err) {
    els.dlVerify.disabled = false;
  }
});

els.dlSources.addEventListener('click', async (event) => {
  // 每行右边那个「首页」小按钮：只补这个来源的首张
  const firstBtn = event.target.closest('button[data-source-first]');
  if (firstBtn) {
    await enqueueFirstPages(firstBtn.dataset.sourceFirst, firstBtn);
    return;
  }

  const btn = event.target.closest('button[data-source]');
  if (!btn) return;
  btn.disabled = true;
  try {
    const data = await api(`/api/enqueue-all?source=${encodeURIComponent(btn.dataset.source)}`, {
      method: 'POST',
    });
    if (data.blocked) { btn.disabled = false; await pollQueue(); return; }
    startPolling();
  } catch (err) {
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

// 网格里鼠标停在哪张卡片上 —— L / C 在非大图状态下操作这张
let hoveredRecord = null;

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

  // 这些页会进服务端那条统一的下载队列（单页任务插队），开着轮询面板上的
  // 「队列」和「已下载页」才会实时变
  startPolling();

  (async () => {
    for (const page of missing) {
      try {
        const res = await fetch(`/api/full/${record.pid}/${page}`);
        // 只有真的拿到图才算本地有这一页；队列被清空或额度用尽时会返回 5xx
        if (res.ok) record.localPages = [...(record.localPages ?? []), page];
      } catch {
        /* 单页失败不影响其他页 */
      }
    }
    if (lb.record === record) {
      stripPid = null;
      renderPageStrip(record, total, lb.index);
    }
    // 收尾再取一次统计，让「已下载 / 待下载」跟上（轮询可能已经因为空闲停了）
    void pollQueue();
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
  // aiType：0 未标注、1 作者声明非 AI、2 是 AI —— 只有 2 才配这个标签
  if (Number(record.ai_type) === 2) chips.push('<span class="chip-tag ai">AI 生成</span>');
  if (record.type === 'manga') chips.push('<span class="chip-tag type">漫画</span>');
  if (record.type === 'ugoira') chips.push('<span class="chip-tag type">动图</span>');
  if (record.removed === 'yes') chips.push('<span class="chip-tag">已取消收藏</span>');
  else if (record.status === 'unavailable') chips.push('<span class="chip-tag">作品已失效</span>');
  // 公开 / 私密是收藏本身的属性，放在这里比藏在来源标签页里直观
  if (/Private$/.test(record.source ?? '')) chips.push('<span class="chip-tag private">私密收藏</span>');

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

  // 收藏标签是唯一能改的东西，所以标题右边直接挂入口；不能编辑的记录就不给按钮
  const editable = record.removed !== 'yes' && record.status !== 'unavailable';

  // 评分：星星可以直接点着改。左右半边分别对应奇数 / 偶数分
  const rating = ratingValueOf(record);
  const scoreStyle = rating
    ? `color:${ratingColor(rating)}${
        rating === 10 ? `;text-shadow:0 0 8px ${withAlpha(ratingHex(10), 0.6)}` : ''
      }`
    : '';
  html += `<div class="section section-row"><span>评分</span><span class="rating-score"${
    scoreStyle ? ` style="${scoreStyle}"` : ''
  }>${rating ? `${rating}/10` : '未评分'}</span></div>`;
  html += `<div class="panel-rating${editable ? '' : ' readonly'}">${starsHtml(rating, {
    pid: record.pid,
  })}</div>`;

  html += `<div class="section section-row"><span>我的收藏标签</span>${
    editable
      ? `<button type="button" class="section-btn" data-edit-bookmark="${escapeHtml(
          record.pid,
        )}" title="编辑收藏标签与公开状态 (E)">编辑</button>`
      : ''
  }</div>`;

  html += owned.length
    ? `<div class="taglist">${owned
        .map((t) => {
          const style = ratingTagInline(ratingValueOfTag(t));
          return `<span class="tag owned"${style ? ` style="${style}"` : ''}>${escapeHtml(t)}</span>`;
        })
        .join('')}</div>`
    : '<div class="empty-note">还没有打收藏标签</div>';

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

  // 星星在面板里是常驻的；记录不可编辑时才退化成只读展示
  if (editable) {
    bindStars(
      els.lbPanel.querySelector('.panel-rating .stars'),
      () => ratingValueOf(record),
      (value) => setRating(record, value),
    );
  }
}

els.lbPanel.addEventListener('click', (event) => {
  // 「编辑」按钮：改收藏标签 / 公开状态
  if (event.target.closest('[data-edit-bookmark]')) {
    openBookmarkEditor(lb.record);
    return;
  }

  const title = event.target.closest('h3[data-open]');
  if (title && title.dataset.open) {
    openExternal(title.dataset.open);
    return;
  }

  // pid 链接是 <a target="_blank">，默认会在 Edge 里开，这里拦下来交给系统浏览器
  const pidLink = event.target.closest('a.pid-link');
  if (pidLink) {
    event.preventDefault();
    openExternal(pidLink.getAttribute('href'));
    return;
  }

  const author = event.target.closest('[data-author-page]');
  if (author && author.dataset.authorPage) {
    openExternal(author.dataset.authorPage);
  }
});

function showLightboxPage() {
  const record = lb.record;
  if (!record) return;

  const totalPages = Math.max(1, Number(record.pages) || 1);
  const page = lb.index;

  els.lbImage.onload = () => {
    // 解码后才有 naturalWidth/clientWidth，fit 的基准尺寸这时才有效
    if (lb.fitted) resetTransform();
    else applyTransform();
  };
  els.lbImage.onerror = () => {
    // 这一页取不回来（作品失效/网络问题），保持画面不动，翻页仍然可用
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
}

/** 1:1 显示真实像素时的 scale —— 百分比以它为 100%。 */
function oneToOneScale() {
  const img = els.lbImage;
  const fitWidth = img.clientWidth;
  const natural = img.naturalWidth;
  if (!fitWidth || !natural) return 1;
  return natural / fitWidth;
}

/** 同一作品内翻页（↑ ↓ / PgUp / PgDn）。到头就停住，不会跳到别的作品。 */
function stepPage(delta) {
  const record = lb.record;
  if (!record) return;

  const totalPages = Math.max(1, Number(record.pages) || 1);
  const next = lb.index + delta;
  if (next < 0 || next >= totalPages) return;

  lb.index = next;
  showLightboxPage();
}

/** 切换到上/下一个作品（← →），顺手跳过已失效的。 */
function stepRecord(delta) {
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
els.lbCopy.addEventListener('click', () => copyLink(lb.record));
els.lbPrev.addEventListener('click', () => stepRecord(-1));
els.lbNext.addEventListener('click', () => stepRecord(1));

// ---------- 小说阅读器 ----------

let readerRecord = null;

/** 阅读器左侧的收藏标签。编辑完成后要单独重画，所以抽出来。 */
function renderReaderTags(record) {
  els.rdTags.innerHTML = (record.bookmark_tags ?? [])
    .map((t) => {
      const style = ratingTagInline(ratingValueOfTag(t));
      return `<span${style ? ` style="${style}"` : ''}>${escapeHtml(t)}</span>`;
    })
    .join('');
}

async function openReader(record, card) {
  readerRecord = record;
  els.reader.hidden = false;
  document.body.style.overflow = 'hidden';

  els.rdTitle.textContent = record.title || '(无题)';
  els.rdAuthor.textContent = record.author || '未知作者';
  renderReaderTags(record);
  els.rdLink.href = record.url || '#';
  els.rdCoverBox.innerHTML = '<span>加载中…</span>';
  els.rdBody.innerHTML = '<div class="rd-loading">正在读取正文…</div>';


  try {
    const data = await api(`/api/novel/${record.pid}`);
    els.rdCoverBox.innerHTML = data.cover ? `<img src="/api/cover/${record.pid}" alt="">` : '<span>无封面</span>';
    els.rdBody.textContent = data.content || '（正文为空）';
    els.rdBody.scrollTop = 0;
    record.hasCover = Boolean(data.cover);
    record.localNovel = true;
    if (card) refreshCard(card, record);
  } catch (err) {
    els.rdBody.innerHTML = `<div class="rd-loading">读取失败：${escapeHtml(err.message)}</div>`;
  }
}

function closeReader() {
  els.reader.hidden = true;
  els.rdBody.textContent = '';
  document.body.style.overflow = '';
}

els.rdClose.addEventListener('click', closeReader);

// ---------- 编辑收藏 ----------

/**
 * 编辑收藏对话框。
 *
 * 只负责收集输入，真正的顺序保证在服务端：写 pixiv 成功（200）→ 才改本地。
 * 所以这里失败时**不能**先改 record 再等响应 —— 只有 200 才动内存里的对象。
 *
 * 打开时用本地数据填（秒开），想核对网站上此刻的状态就点「从 pixiv 读取」。
 */
const bm = {
  record: null,
  kind: 'illust',
  tags: [],
  isPrivate: false,
  workTags: [],
  myTags: [],
  limit: 10,
  saving: false,
  filter: '',
};

/** 和 pixiv 输入框一致：空格 / 逗号 / 顿号 / 分号都当分隔符。 */
function splitTagText(raw) {
  return String(raw)
    .split(/[,，、;；\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function isVisibleBookmark(record) {
  return record && record.removed !== 'yes' && record.status !== 'unavailable';
}

function setBmStatus(text, tone = 'ok') {
  const el = els.bmStatus;
  if (!el) return;
  el.textContent = text;
  el.className = `bm-status ${tone}`;
  el.hidden = !text;
  clearTimeout(setBmStatus.timer);
  if (text && tone === 'ok') {
    setBmStatus.timer = setTimeout(() => {
      el.hidden = true;
    }, 4000);
  }
}

function showBmHint(text, isError = false) {
  const el = els.bmHint;
  el.textContent = text;
  el.classList.toggle('err', isError);
  el.hidden = !text;
  clearTimeout(showBmHint.timer);
  if (text) {
    showBmHint.timer = setTimeout(() => {
      el.hidden = true;
    }, 2600);
  }
}

function updateBmSaveState() {
  if (!els.bmSave) return;
  els.bmSave.disabled = bm.saving;
  els.bmSave.textContent = bm.saving ? '保存中…' : '保存';
  els.bmFetch.disabled = bm.saving;
}

function renderBmChips() {
  for (const old of els.bmTagInput.querySelectorAll('.bm-chip')) old.remove();

  const frag = document.createDocumentFragment();
  for (const tag of bm.tags) {
    const chip = document.createElement('span');
    const rating = ratingValueOfTag(tag);
    chip.className = `bm-chip${rating ? ' rating' : ''}`;
    if (rating) chip.setAttribute('style', ratingTagInline(rating));
    chip.innerHTML = `<span>${escapeHtml(tag)}</span><button type="button" aria-label="移除 ${escapeHtml(
      tag,
    )}">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      bm.tags = bm.tags.filter((item) => item !== tag);
      renderBmChips();
      syncBmClouds();
    });
    frag.appendChild(chip);
  }
  els.bmTagInput.insertBefore(frag, els.bmTagEntry);

  els.bmCount.textContent = `${bm.tags.length} / ${bm.limit}`;
  els.bmTagEntry.placeholder =
    bm.tags.length >= bm.limit ? '已达上限' : '输入标签后回车';
  syncBmClouds();
  updateBmSaveState();
}

/** 只切换云里标签的选中样式，不重建 DOM（否则点到一半会闪）。 */
function syncBmClouds() {
  const set = new Set(bm.tags);
  for (const cloud of [els.bmWorkTags, els.bmMineTags]) {
    if (!cloud) continue;
    for (const btn of cloud.querySelectorAll('.bm-tag')) {
      btn.classList.toggle('on', set.has(btn.dataset.tag));
    }
  }
}

function renderBmWorkTags() {
  const tags = bm.workTags ?? [];
  els.bmWorkTags.innerHTML = tags
    .map((tag) => {
      const style = ratingTagInline(ratingValueOfTag(tag));
      return `<button type="button" class="bm-tag${style ? ' rating' : ''}" data-tag="${escapeHtml(
        tag,
      )}"${style ? ` style="${style}"` : ''}>${escapeHtml(tag)}</button>`;
    })
    .join('');
  syncBmClouds();
}

function renderBmMine() {
  const keyword = bm.filter.trim().toLowerCase();
  const list = keyword
    ? bm.myTags.filter((item) => item.tag.toLowerCase().includes(keyword))
    : bm.myTags;

  // 标签可能有几百个，先只铺前 300 个；搜索框能把范围缩小
  const shown = list.slice(0, 300);
  els.bmMineTags.innerHTML = shown
    .map((item) => {
      const style = ratingTagInline(ratingValueOfTag(item.tag));
      return `<button type="button" class="bm-tag${style ? ' rating' : ''}" data-tag="${escapeHtml(
        item.tag,
      )}" title="${escapeHtml(item.tag)} · ${item.count} 个作品"${
        style ? ` style="${style}"` : ''
      }>${escapeHtml(item.tag)}<i class="bm-tag-count">${item.count}</i></button>`;
    })
    .join('');

  els.bmMineCount.textContent = keyword
    ? `${list.length} / ${bm.myTags.length}`
    : `共 ${bm.myTags.length} 个${list.length > shown.length ? ` · 显示前 ${shown.length}` : ''}`;
  syncBmClouds();
}

/**
 * 加标签。评分是唯一的：加新的评分会顶掉旧的，而不是并存两个 `n/10`。
 * 标签已满时（且没有评分可顶替）直接拒绝，避免提交 11 个上去。
 */
function addBmTag(tag) {
  const value = String(tag ?? '').trim();
  if (!value || bm.tags.includes(value)) return;

  if (isRatingTag(value)) {
    const rest = bm.tags.filter((item) => !isRatingTag(item));
    if (rest.length >= bm.limit) {
      showBmHint(`收藏标签最多 ${bm.limit} 个`, true);
      return;
    }
    bm.tags = rest;
  } else if (bm.tags.length >= bm.limit) {
    showBmHint(`收藏标签最多 ${bm.limit} 个`, true);
    return;
  }

  bm.tags.push(value);
  renderBmChips();
}

function addBmTags(list) {
  for (const tag of list) addBmTag(tag);
}

function toggleBmTag(tag) {
  if (!tag) return;

  const index = bm.tags.indexOf(tag);
  if (index >= 0) {
    bm.tags.splice(index, 1);
  } else if (isRatingTag(tag)) {
    const rest = bm.tags.filter((item) => !isRatingTag(item));
    if (rest.length >= bm.limit) {
      showBmHint(`收藏标签最多 ${bm.limit} 个`, true);
      return;
    }
    bm.tags = [...rest, tag];
  } else if (bm.tags.length >= bm.limit) {
    showBmHint(`收藏标签最多 ${bm.limit} 个`, true);
    return;
  } else {
    bm.tags.push(tag);
  }

  renderBmChips();
  syncBmClouds();
}

function commitBmEntry() {
  const raw = els.bmTagEntry.value;
  if (!raw.trim()) return false;
  els.bmTagEntry.value = '';
  addBmTags(splitTagText(raw));
  return true;
}

function syncBmRestrict() {
  for (const input of els.bmRestrict.querySelectorAll('input[name="bm-restrict"]')) {
    input.checked = input.value === (bm.isPrivate ? '1' : '0');
  }
}

function thumbForBm(record) {
  if (record.type === 'novel') return record.hasCover ? `/api/cover/${record.pid}` : '';
  if (record.hasImage) return `/api/thumb/${record.pid}/0?w=96`;
  return record.hasCover ? `/api/cover/${record.pid}` : '';
}

async function openBookmarkEditor(record) {
  if (!record) return;
  if (!isVisibleBookmark(record)) {
    toast('这条收藏已取消或作品已失效，不能编辑', 'warn');
    return;
  }

  bm.record = record;
  bm.kind = record.type === 'novel' ? 'novel' : 'illust';
  bm.tags = [...(record.bookmark_tags ?? [])];
  bm.isPrivate = /Private$/.test(record.source ?? '');
  bm.workTags = record.tags ?? [];
  bm.myTags = [];
  bm.limit = 10;
  bm.saving = false;
  bm.filter = '';

  els.bmSub.textContent = `pid ${record.pid}`;
  els.bmWorkTitle.textContent = record.title || '(无题)';
  els.bmWorkAuthor.textContent = record.author ? `by ${record.author}` : '';

  const thumb = thumbForBm(record);
  els.bmThumb.innerHTML = thumb ? `<img src="${thumb}" alt="">` : '<span>无封面</span>';

  els.bmTagEntry.value = '';
  els.bmTagSearch.value = '';
  els.bmHint.hidden = true;
  setBmStatus('');
  els.bmMineCount.textContent = '读取中…';

  renderBmChips();
  renderBmWorkTags();
  els.bmMineTags.innerHTML = '';
  syncBmRestrict();

  els.bmModal.hidden = false;
  document.body.classList.add('bm-open');
  requestAnimationFrame(() => els.bmTagEntry.focus());

  // 「我的标签」来自本地备份，不发请求；公开 + 私密合并计数
  try {
    const data = await api(
      `/api/bookmark/meta?pid=${encodeURIComponent(record.pid)}&source=${encodeURIComponent(record.source ?? '')}`,
    );
    if (bm.record !== record) return; // 期间又打开了别的作品
    bm.myTags = data.myTags ?? [];
    bm.limit = data.limit ?? 10;
    bm.workTags = data.workTags ?? bm.workTags;
    renderBmWorkTags();
    renderBmMine();
    renderBmChips();
  } catch (err) {
    if (bm.record !== record) return;
    els.bmMineCount.textContent = '';
    els.bmMineTags.innerHTML = `<div class="bm-empty">读取本地标签失败：${escapeHtml(err.message)}</div>`;
  }
}

function closeBookmarkEditor() {
  if (bm.saving) {
    toast('正在保存，请稍候…', 'warn');
    return;
  }
  els.bmModal.hidden = true;
  document.body.classList.remove('bm-open');
  bm.record = null;
  bm.tags = [];
  bm.myTags = [];
}

/** 保存成功后的界面收尾：计数、卡片、详情面板、侧栏。 */
async function afterBookmarkSaved(record, moved) {
  // 标签增删会改变使用次数，卡片标签位的排序要跟着变
  await loadTagUsage();

  // 来源数量变了（跨文件搬迁时尤其明显），顺手把标签页上的数字更新掉
  try {
    const data = await api('/api/state');
    state.sources = data.sources;
    renderTabs();
  } catch {
    /* 计数没刷上不影响主流程 */
  }

  if (moved) {
    // 记录已经不在当前来源里了，留在原网格上没有意义
    closeLightbox();
    closeReader();
    await loadSidePanel();
    reloadAll();
    return;
  }

  const card = state.cardMap.get(String(record.pid));
  if (card) refreshCard(card, record);
  if (lb.record === record) renderInfoPanel(record);
  if (!els.reader.hidden && readerRecord === record) renderReaderTags(record);
  await loadSidePanel();
}

async function saveBookmarkEdit() {
  if (bm.saving || !bm.record) return;
  commitBmEntry();

  if (bm.tags.length > bm.limit) {
    showBmHint(`收藏标签最多 ${bm.limit} 个`, true);
    return;
  }

  const record = bm.record;
  bm.saving = true;
  updateBmSaveState();
  setBmStatus('正在写入 pixiv…', 'busy');

  try {
    const data = await api('/api/bookmark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pid: record.pid,
        source: record.source,
        tags: bm.tags,
        private: bm.isPrivate,
      }),
    });

    // 服务端写入成功、本地文件已写好，这时才动内存里的记录
    applyBookmarkResult(record, data);

    els.bmModal.hidden = true;
    document.body.classList.remove('bm-open');
    bm.record = null;
    bm.saving = false;

    toast(`已保存 · ${data.private ? '私密' : '公开'} · ${record.bookmark_tags.length} 个标签`);
    await afterBookmarkSaved(record, data.moved);
  } catch (err) {
    bm.saving = false;
    updateBmSaveState();
    setBmStatus(`保存失败：${err.message}`, 'err');
  }
}

async function fetchBmFromPixiv() {
  if (!bm.record || bm.saving) return;

  els.bmFetch.disabled = true;
  setBmStatus('正在读取 pixiv 上的当前状态…', 'busy');

  try {
    const data = await api(
      `/api/bookmark/state?pid=${encodeURIComponent(bm.record.pid)}&source=${encodeURIComponent(
        bm.record.source ?? '',
      )}`,
    );
    bm.tags = [...(data.tags ?? [])];
    bm.isPrivate = Boolean(data.private);
    syncBmRestrict();
    renderBmChips();
    setBmStatus(`已读取：${data.private ? '私密' : '公开'} · ${bm.tags.length} 个标签`, 'ok');
  } catch (err) {
    setBmStatus(`读取失败：${err.message}`, 'err');
  } finally {
    els.bmFetch.disabled = bm.saving;
  }
}

els.bmTagEntry.addEventListener('keydown', (event) => {
  // 输入法选词时的回车 / 空格不能当分隔符
  if (event.isComposing || event.keyCode === 229) return;

  if (event.key === 'Enter') {
    event.preventDefault();
    commitBmEntry();
    return;
  }
  if (event.key === ' ' || event.key === '，' || event.key === ',') {
    if (els.bmTagEntry.value.trim()) {
      event.preventDefault();
      commitBmEntry();
    }
    return;
  }
  if (event.key === 'Backspace' && !els.bmTagEntry.value && bm.tags.length) {
    event.preventDefault();
    bm.tags.pop();
    renderBmChips();
  }
});

els.bmTagEntry.addEventListener('input', () => {
  // 输入法直接敲出逗号时立即结算
  if (/[,，、;；]$/.test(els.bmTagEntry.value)) {
    els.bmTagEntry.value = els.bmTagEntry.value.replace(/[,，、;；]+$/, '');
    commitBmEntry();
  }
});

els.bmTagEntry.addEventListener('blur', () => commitBmEntry());

els.bmTagInput.addEventListener('mousedown', (event) => {
  if (event.target === els.bmTagInput) {
    event.preventDefault();
    els.bmTagEntry.focus();
  }
});

for (const cloud of [els.bmWorkTags, els.bmMineTags]) {
  cloud.addEventListener('click', (event) => {
    const btn = event.target.closest('.bm-tag');
    if (btn) toggleBmTag(btn.dataset.tag);
  });
}

els.bmTagSearch.addEventListener('input', () => {
  bm.filter = els.bmTagSearch.value;
  renderBmMine();
});

els.bmRestrict.addEventListener('change', (event) => {
  const input = event.target.closest('input[name="bm-restrict"]');
  if (input) bm.isPrivate = input.value === '1';
});

els.bmSave.addEventListener('click', saveBookmarkEdit);
els.bmFetch.addEventListener('click', fetchBmFromPixiv);
els.bmCancel.addEventListener('click', closeBookmarkEditor);
els.bmClose.addEventListener('click', closeBookmarkEditor);

// 点遮罩关闭。大图 / 阅读器都开着的时候，Esc 只该关对话框，所以这里 stopPropagation
els.bmModal.addEventListener('mousedown', (event) => {
  if (event.target === els.bmModal) closeBookmarkEditor();
});

els.bmModal.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  event.preventDefault();
  closeBookmarkEditor();
});

// 阅读器里的入口
els.rdEdit.addEventListener('click', () => {
  if (readerRecord) openBookmarkEditor(readerRecord);
});

// 「在 pixiv 打开」同样交给系统浏览器
els.rdLink.addEventListener('click', (event) => {
  event.preventDefault();
  const href = els.rdLink.getAttribute('href') ?? '';
  if (/^https?:/i.test(href)) openExternal(href);
});

/* ── 「标签已满，挑一个删」弹窗 ───────────────────────── */

els.bmPickList.addEventListener('click', (event) => {
  const button = event.target.closest('.bm-pick-tag');
  if (button) pickDropTag(button.dataset.tag);
});

els.bmPickClose.addEventListener('click', closeRatingTagPicker);

els.bmPick.addEventListener('mousedown', (event) => {
  if (event.target === els.bmPick) closeRatingTagPicker();
});

els.bmPick.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  event.preventDefault();
  closeRatingTagPicker();
});

// ---------- 单张下载 ----------

async function ensureDownloaded(record, card) {
  if (record.hasImage) return true;
  if (record.error) {
    return false;
  }

  record.downloading = true;
  if (card) refreshCard(card, record);
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

// ---------- 防封号横幅 ----------

function renderGuardBanner(guard) {
  if (!els.guardBanner) return;

  if (!guard || (!guard.blocked && !guard.dailyExhausted)) {
    els.guardBanner.hidden = true;
    return;
  }

  els.guardBanner.hidden = false;

  if (guard.blocked) {
    const when = guard.warnedAt ? new Date(guard.warnedAt).toLocaleString('zh-CN') : '未知时间';
    els.guardBanner.classList.remove('warn');
    els.guardText.innerHTML =
      `<b>检测到 pixiv 的「过度访问警告」（${when}）</b>，下载已全部停止。` +
      `<br><span class="muted">继续跑下去可能被冻结关注/收藏，甚至删号。确认已经收手后再恢复，建议先把请求间隔调大。</span>`;
    els.guardResume.hidden = false;
    return;
  }

  const limits = guard.limits ?? {};
  els.guardBanner.classList.add('warn');
  els.guardText.innerHTML =
    `<b>今日下载额度已用完</b>（${guard.daily.files} 个文件${limits.dailyFileLimit ? ` / 上限 ${limits.dailyFileLimit}` : ''}）。` +
    `<br><span class="muted">明天 0 点自动恢复，或调大 config.json 里 guard.dailyFileLimit。</span>`;
  els.guardResume.hidden = true;
}

els.guardResume?.addEventListener('click', async () => {
  els.guardResume.disabled = true;
  try {
    const data = await api('/api/guard/resume', { method: 'POST' });
    renderGuardBanner(data.guard);
    await pollQueue();
  } catch (err) {
    els.guardText.innerHTML = `解除失败：${escapeHtml(err.message)}`;
  } finally {
    els.guardResume.disabled = false;
  }
});

// ---------- 随机休息横幅 ----------

/** 毫秒 → 12:34 / 1 小时 05 分。倒计时别显示成 0.4 小时这种。 */
function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小时 ${String(minutes).padStart(2, '0')} 分`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function renderPacerBanner(pacer) {
  if (!els.pacerBanner) return;

  // 只有真在休息时才占据顶部一条；平时的计数不值得打断视线
  if (!pacer || !pacer.enabled || !pacer.paused) {
    els.pacerBanner.hidden = true;
    els.pacerFill.style.width = '0%';
    return;
  }

  const limits = pacer.limits ?? {};
  const chance = Number(((limits.pauseChance ?? 0) * 100).toFixed(2));
  const perSec = Math.round((limits.perRequestMs ?? 0) / 1000);
  const decaySec = Math.round((limits.decayMs ?? 5000) / 1000);
  const minPause = Math.round((limits.minPauseMs ?? 0) / 60000);
  const maxPause = Math.round((limits.maxPauseMs ?? 0) / 60000);

  els.pacerBanner.hidden = false;
  els.pacerText.innerHTML =
    `<b>随机休息中</b> · 还剩 <span class="left">${formatCountdown(pacer.remainingMs)}</span>` +
    `<br><span class="muted">触发前已连续请求 ${pacer.pauseRequests} 次，本次休息 ${formatCountdown(pacer.pauseMs)}；` +
    `每个请求 ${chance}% 概率触发，每多一个请求期望 +${perSec} 秒（${minPause}–${maxPause} 分钟封顶），` +
    `空闲时每 ${decaySec} 秒回退 1 次，模拟真人的使用节奏。</span>`;

  // 倒计时进度条：剩余比例越小，底部填充越短
  const ratio = pacer.pauseMs > 0 ? (pacer.remainingMs / pacer.pauseMs) * 100 : 0;
  els.pacerFill.style.width = `${Math.max(0, Math.min(100, ratio))}%`;
  els.pacerSkip.disabled = false;
}

els.pacerSkip?.addEventListener('click', async () => {
  els.pacerSkip.disabled = true;
  try {
    const data = await api('/api/pacer/skip', { method: 'POST' });
    renderPacerBanner(data.pacer);
    if (!data.skipped) els.pacerBanner.hidden = true;
    toast('已跳过本次休息');
    await pollQueue();
  } catch (err) {
    toast(`跳过失败：${err.message}`, 'err');
    els.pacerSkip.disabled = false;
  }
});

// ---------- 顶栏交互 ----------

// 搜索框和默认过滤器共用一套建议 / 插入逻辑，靠 activeEditor 记住当前是哪个框
const SEARCH_EDITOR = { input: els.search, panel: els.searchSuggest };
const FILTER_EDITOR = { input: els.defaultFilter, panel: els.filterSuggest };
const EDITORS = [SEARCH_EDITOR, FILTER_EDITOR];

let activeEditor = null;

let searchTimer = null;
els.search.addEventListener('input', () => {
  state.query = els.search.value.trim();
  showSuggest(SEARCH_EDITOR);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reloadAll, 280);
});

let filterTimer = null;
els.defaultFilter.addEventListener('input', () => {
  settings.defaultFilter = els.defaultFilter.value.trim();
  // 动手写条件了，就默认是想让它生效
  if (settings.defaultFilter && !settings.filterEnabled) settings.filterEnabled = true;
  saveSettings();
  // 这里不调 syncFilterUI：它会把输入框内容回写成 trim 后的值，正在敲的尾随空格会被吃掉
  syncFilterActive();
  showSuggest(FILTER_EDITOR);
  clearTimeout(filterTimer);
  filterTimer = setTimeout(reloadAll, 280);
});

// 胶囊里的开关：关掉后条件保留，但不参与查询
els.filterEnabled.addEventListener('change', () => {
  settings.filterEnabled = els.filterEnabled.checked;
  saveSettings();

  // 打开时如果还没写条件，顺手把输入框展开
  if (settings.filterEnabled && !String(settings.defaultFilter ?? '').trim()) {
    settings.filterOpen = true;
    saveSettings();
    syncFilterUI();
    els.defaultFilter.focus();
    return;
  }

  syncFilterUI();
  reloadAll();
});

els.btnFilter.addEventListener('click', () => {
  settings.filterOpen = !settings.filterOpen;
  saveSettings();
  syncFilterUI();
  if (settings.filterOpen) {
    els.defaultFilter.focus();
    els.defaultFilter.select();
  } else {
    hideSuggest();
  }
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
      ['is:ai', 'AI 生成（aiType=2）'],
      ['NOT is:ai', '非 AI（含未标注）'],
      ['ai:1', '作者声明不是 AI'],
      ['ai:0', 'AI 未标注'],
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
function editorTail(input) {
  const match = /(\S*)$/.exec(input.value);
  return match ? match[1] : '';
}

function showSuggest(editor) {
  activeEditor = editor;
  const tail = editorTail(editor.input);
  // 支持 `-ra` 这种写法：前缀减号只影响插入结果，过滤建议时忽略它
  const keyword = (tail.startsWith('-') ? tail.slice(1) : tail).toLowerCase();
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

  editor.panel.innerHTML = count
    ? parts.join('')
    : '<div class="sg-empty">没有匹配的属性，可直接写全文关键词</div>';
  editor.panel.hidden = false;
}

function hideSuggest() {
  for (const editor of EDITORS) editor.panel.hidden = true;
  activeEditor = null;
}

/** 把条件插到当前输入框里，替换掉光标前那段半截输入。 */
function insertSearchTerm(term) {
  const editor = activeEditor;
  if (!editor) return;

  const tail = editorTail(editor.input);
  const negated = tail.startsWith('-');
  const value = editor.input.value;
  const head = value.slice(0, value.length - tail.length);
  // 用户先打了减号：插入时保留，变成排除条件
  const next = `${head}${negated ? '-' : ''}${term}`;

  editor.input.value = next;
  if (editor === FILTER_EDITOR) {
    settings.defaultFilter = next.trim();
    saveSettings();
    els.btnFilter.classList.toggle('on', settings.defaultFilter !== '');
  } else {
    state.query = next.trim();
  }
  hideSuggest();
  reloadAll();
  editor.input.focus();
}

for (const editor of EDITORS) {
  editor.input.addEventListener('focus', () => {
    // 两个框各有一块建议面板，切过去时先把另一块收掉，否则会同时挂两个
    hideSuggest();
    showSuggest(editor);
  });

  editor.input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideSuggest();
  });

  // 用 mousedown 而不是 click：click 之前会先触发 blur，建议面板可能已被隐藏
  editor.panel.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const item = event.target.closest('.sg-item');
    if (item) insertSearchTerm(item.dataset.term);
  });
}

document.addEventListener('click', (event) => {
  if (!activeEditor) return;
  if (EDITORS.some((editor) => editor.input === event.target || editor.panel.contains(event.target))) return;
  hideSuggest();
});

els.sortMode.addEventListener('change', () => {
  settings.sort = els.sortMode.value;
  if (settings.sort === 'random') state.seed = freshSeed();
  els.btnReshuffle.hidden = settings.sort !== 'random';
  saveSettings();
  reloadAll();
});

els.btnReshuffle.addEventListener('click', () => {
  state.seed = freshSeed();
  reloadAll();
  toast('已换一批');
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

els.optOverlayInfo.addEventListener('change', () => {
  settings.overlayInfo = els.optOverlayInfo.checked;
  saveSettings();
  // 纯 CSS 切换，不用重建卡片（重建会让所有缩略图闪一下）
  applySettings({ rerender: false });
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

els.optShowRating.addEventListener('change', () => {
  settings.showRating = els.optShowRating.checked;
  saveSettings();
  // 星星和「标签位里藏不藏评分标签」一起变，只能重建卡片
  applySettings();
});

els.optAutoDownload.addEventListener('change', () => {
  settings.autoDownload = els.optAutoDownload.checked;
  saveSettings();
});

els.optReset.addEventListener('click', () => {
  settings = {
    ...DEFAULT_SETTINGS,
    leftOpen: settings.leftOpen,
    rightOpen: settings.rightOpen,
    // 视图设置里的「恢复默认」只管外观，不动过滤条件
    defaultFilter: settings.defaultFilter,
    filterOpen: settings.filterOpen,
  };
  saveSettings();
  applySettings();
});

els.btnLeft.addEventListener('click', () => {
  settings.leftOpen = !settings.leftOpen;
  saveSettings();
  // 侧栏只是改变了网格宽度，列数和行位置交给 ResizeObserver 里的 paintGrid 处理；
  // 这里不要整块重置，否则会先清空行、滚动范围短暂消失，滚动位置就回顶部了。
  applySettings({ rerender: false });
  // 栏刚打开且还没加载过，才去拉作者/标签（连带头像）
  if (settings.leftOpen && state.authors.length === 0 && state.tags.length === 0) loadSidePanel();
});

els.btnRight.addEventListener('click', () => {
  settings.rightOpen = !settings.rightOpen;
  saveSettings();
  applySettings({ rerender: false });
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

  // 编辑对话框 / 挑标签弹窗开着时，按键归它们自己管（Esc 在各自的监听里处理）
  if (!els.bmModal.hidden || !els.bmPick.hidden) return;

  // 输入框里打字、或者按着 Ctrl/Alt 的组合键（Ctrl+C 等）都不要抢
  const tag = event.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const inLightbox = !els.lightbox.hidden;
  // 大图里操作当前作品，网格里操作鼠标停着的那张卡片
  const target = inLightbox ? lb.record : hoveredRecord;

  // L 复制作品链接；C 复制当前图片（失败退回复制链接）
  switch (event.key.toLowerCase()) {
    case 'l':
      if (target) {
        event.preventDefault();
        copyLink(target);
        return;
      }
      break;
    case 'c':
      if (target) {
        event.preventDefault();
        copyImage(target, inLightbox ? lb.index : 0);
        return;
      }
      break;
    case 'e':
      // 只在大图里给快捷键：网格卡片上编辑收藏容易误触
      if (inLightbox && lb.record) {
        event.preventDefault();
        openBookmarkEditor(lb.record);
        return;
      }
      break;
    default:
      break;
  }

  if (!inLightbox) return;

  // ← → 换作品；↑ ↓ / PageUp / PageDown 在作品内翻页
  switch (event.key) {
    case 'Escape':
      closeLightbox();
      break;
    case 'ArrowLeft':
      stepRecord(-1);
      break;
    case 'ArrowRight':
      stepRecord(1);
      break;
    case 'ArrowUp':
    case 'PageUp':
      event.preventDefault();
      stepPage(-1);
      break;
    case 'ArrowDown':
    case 'PageDown':
      event.preventDefault();
      stepPage(1);
      break;
    case '0':
      resetTransform();
      break;
    default:
      break;
  }
});

// 滚动 = 重画可见行；加载下一页的判断在 paintGrid 里（靠近已加载末尾时触发）
const gridWrap = document.querySelector('.grid-wrap');
gridWrap.addEventListener('scroll', () => scheduleGridPaint(), { passive: true });

// 用户在重排后马上自己滚动的话，别再用记下的百分比把他拉回去
for (const type of ['wheel', 'pointerdown', 'touchstart']) {
  gridWrap.addEventListener(
    type,
    () => {
      gridView.heldRatio = null;
      gridView.ratioApplied = false;
    },
    { passive: true },
  );
}

// 窗口 / 侧栏尺寸变化会改变列数和卡片宽度，行高缓存要重建
new ResizeObserver(() => scheduleGridPaint(true)).observe(gridWrap);

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
    // 卡片标签位要按使用次数排序，先把这个表拿到再渲染第一屏
    await loadTagUsage();
    if (settings.leftOpen) await loadSidePanel();
    await loadPage(true);
    await pollQueue();
  } catch (err) {
  }
})();

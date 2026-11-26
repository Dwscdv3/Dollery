/*
 * 自绘滚动条
 *
 * 原生滚动条只能贴在滚动容器自己的滚动方向末端，样式也跟着系统走，和这个界面对不上。
 * 这里把所有会滚动的容器的原生条藏掉（见 style.css 末尾），统一画成同一套皮肤：
 *   - 左侧通栏（作者/标签、大图缩略图、阅读器左栏）→ 贴视口左缘
 *   - 右侧通栏（下载管理、大图信息面板）→ 贴视口右缘
 *   - 其余（网格、正文、弹窗、下拉）→ 留在各自容器右缘
 * 平时只露一条 3~4px 的细滑块，指针靠近才展开成宽条并显出槽。
 *
 * 用 position:fixed + getBoundingClientRect 同步，不改动原有 DOM 结构——
 * 这些容器各自的布局差别很大（flex 子项、绝对定位浮层、弹窗内滚动区），套 wrapper 容易弄坏布局。
 */
(function () {
  'use strict';

  const MIN_THUMB = 36;    // 滑块最小高度，再短就抓不住了
  const WHEEL_LINE = 18;   // deltaMode === 1（按行滚动）时，一行折算多少像素
  const BAR_W = 12;        // 宽条宽度，窄条是 8，都要和 style.css 里的 --bar-w 对上
  const BAR_W_NARROW = 8;

  /*
   * side：'left' 贴视口左缘；'right' 贴在容器右缘（右侧通栏的容器本身就贴着视口右缘）
   * narrow：弹窗、下拉里的小列表用窄条，免得挡住标签
   * pad：滑块上下内缩。压在圆角边框里的小容器要留大一点，否则滑块会骑在边框上
   * z：按所在层给，保证不被该层的祖先遮住、也不会盖住更高一层的弹窗
   *    页面 41 < 大图 52 < 阅读器 62 < 弹窗 71 < toast 80
   */
  const TARGETS = [
    // —— 主界面 ——
    { sel: '#sideList', side: 'left', z: 41 },
    { sel: '#sideRight', side: 'right', z: 41 },
    { sel: '.grid-wrap', side: 'right', z: 41 },
    { sel: '.dl-fails', side: 'right', z: 42, narrow: true },
    { sel: '.search-suggest', side: 'right', z: 46, narrow: true },

    // —— 作品大图 ——
    { sel: '#lbPages', side: 'left', z: 52 },
    { sel: '.lb-panel', side: 'right', z: 52 },

    // —— 小说阅读器 ——
    { sel: '#reader .rd-side', side: 'left', z: 62 },
    { sel: '#reader .rd-body', side: 'right', z: 62 },

    // —— 弹窗 ——
    { sel: '.bm-body', side: 'right', z: 71 },
    { sel: '.bm-tag-input', side: 'right', z: 71, narrow: true, pad: 8 },
    { sel: '.bm-cloud', side: 'right', z: 71, narrow: true, pad: 8 },
    { sel: '.bm-pick-body', side: 'right', z: 71 },
    { sel: '.bm-pick-list', side: 'right', z: 71, narrow: true },
    { sel: '.tg-members', side: 'right', z: 71, narrow: true, pad: 8 },
  ];

  const items = [];
  let scheduled = false;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function sync(item) {
    const el = item.el;
    const rect = el.getBoundingClientRect();
    const maxScroll = el.scrollHeight - el.clientHeight;

    // 容器被折叠、弹窗没打开、内容不够一屏时 rect 为 0 或没得滚，条收起来
    if (rect.width <= 0 || rect.height <= 0 || maxScroll <= 1) {
      item.visible = false;
      item.bar.classList.remove('es-on');
      return;
    }

    item.visible = true;
    item.bar.classList.add('es-on');

    const left = item.side === 'left' ? rect.left : rect.right - item.width;
    item.bar.style.left = Math.round(left) + 'px';
    item.bar.style.top = Math.round(rect.top) + 'px';
    item.bar.style.height = Math.round(rect.height) + 'px';

    const trackH = Math.max(0, rect.height - item.pad * 2);
    const thumbH = Math.min(
      trackH,
      Math.max(MIN_THUMB, Math.round((trackH * el.clientHeight) / el.scrollHeight)),
    );
    const maxTop = Math.max(0, trackH - thumbH);
    const top = maxScroll > 0 ? (el.scrollTop / maxScroll) * maxTop : 0;

    item.trackH = trackH;
    item.thumbH = thumbH;
    item.maxTop = maxTop;
    item.maxScroll = maxScroll;
    item.thumbTop = item.pad + top;

    item.thumb.style.height = thumbH + 'px';
    item.thumb.style.top = item.thumbTop + 'px';
  }

  function syncAll() {
    scheduled = false;
    for (const item of items) sync(item);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(syncAll);
  }

  function scrollToThumbTop(item, thumbTop) {
    if (item.maxTop <= 0) return;
    const ratio = clamp((thumbTop - item.pad) / item.maxTop, 0, 1);
    item.el.scrollTop = ratio * item.maxScroll;
  }

  function buildItem(el, cfg) {
    const item = {
      el,
      side: cfg.side || 'right',
      z: cfg.z || 41,
      narrow: !!cfg.narrow,
      pad: cfg.pad || 4,
      width: cfg.narrow ? BAR_W_NARROW : BAR_W,
      dragging: false,
      visible: false,
      thumbTop: 0,
      thumbH: 0,
      maxTop: 0,
      maxScroll: 0,
      trackH: 0,
    };

    const bar = document.createElement('div');
    bar.className = 'edge-scroll';
    // 状态类统一带 es- 前缀：页面里已经有 .side-right / .narrow 这类类名，
    // 撞上会把右栏的 padding、border-left 一起套到条上，条会被撑宽 25px。
    if (item.narrow) bar.classList.add('es-narrow');
    if (item.side === 'right') bar.classList.add('es-right');
    bar.style.zIndex = String(item.z);
    bar.style.setProperty('--pad', item.pad + 'px');

    const thumb = document.createElement('div');
    thumb.className = 'edge-scroll-thumb';
    bar.appendChild(thumb);
    document.body.appendChild(bar);

    item.bar = bar;
    item.thumb = thumb;

    // ---- 拖动 / 点空白翻页 ----
    bar.addEventListener('pointerdown', (e) => {
      if (!item.visible || e.button !== 0) return;
      e.preventDefault();

      const y = e.clientY - bar.getBoundingClientRect().top;
      // 按在滑块外：先把滑块中心挪到指针处再接着拖，手感贴近原生
      if (y < item.thumbTop || y > item.thumbTop + item.thumbH) {
        scrollToThumbTop(item, y - item.thumbH / 2);
        sync(item);
      }

      item.dragging = true;
      item.dragY = e.clientY;
      item.dragTop = item.el.scrollTop;
      bar.classList.add('es-drag');
      try {
        bar.setPointerCapture(e.pointerId);
      } catch (_) {
        // 捕获失败只是拖到条外会断，滚轮和点击仍然可用
      }
    });

    bar.addEventListener('pointermove', (e) => {
      if (!item.dragging || item.maxTop <= 0) return;
      const dy = e.clientY - item.dragY;
      item.el.scrollTop = item.dragTop + (dy / item.maxTop) * item.maxScroll;
    });

    function endDrag(e) {
      if (!item.dragging) return;
      item.dragging = false;
      bar.classList.remove('es-drag');
      try {
        bar.releasePointerCapture(e.pointerId);
      } catch (_) {
        // 同上
      }
    }
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);

    // 指针靠近边缘时展开成宽条并点亮槽
    bar.addEventListener('pointerenter', () => bar.classList.add('es-hot'));
    bar.addEventListener('pointerleave', () => bar.classList.remove('es-hot'));

    // 指针停在条上滚轮：body 是 overflow:hidden，默认不滚任何容器，这里手动转过去
    bar.addEventListener('wheel', (e) => {
      if (!item.visible) return;
      const step = e.deltaMode === 1 ? e.deltaY * WHEEL_LINE : e.deltaY;
      item.el.scrollTop += step;
      e.preventDefault();
    }, { passive: false });

    item.el.addEventListener('scroll', schedule, { passive: true });

    // 容器尺寸变化：侧栏折叠、弹窗开关、窗口缩放都会走到这里
    new ResizeObserver(schedule).observe(el);

    // 内容是分页追加或每次重画的，容器尺寸不一定变，得盯着子节点
    new MutationObserver(schedule).observe(el, { childList: true, subtree: true });

    items.push(item);
    return item;
  }

  for (const cfg of TARGETS) {
    for (const el of document.querySelectorAll(cfg.sel)) buildItem(el, cfg);
  }

  // 顶部横幅出现/消失会把整个 app-body 往下推，容器尺寸可能不变但位置变了
  const appBody = document.querySelector('.app-body');
  if (appBody) new ResizeObserver(schedule).observe(appBody);

  // 弹窗打开时有一段 translateY + scale 的入场动画，动画期间 rect 在动，
  // 而 ResizeObserver 只认布局尺寸、不认 transform，所以等动画结束再对一次位置
  document.addEventListener('animationend', schedule, true);

  window.addEventListener('resize', schedule);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);

  schedule();
})();

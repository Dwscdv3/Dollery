/* 按作者浏览：聚合列表 + 跳转筛选。 */

const els = {
  q: document.getElementById('q'),
  source: document.getElementById('source'),
  list: document.getElementById('list'),
  count: document.getElementById('count'),
  hint: document.getElementById('hint'),
};

let authors = [];
let searchTimer = null;

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

async function loadSources() {
  try {
    const data = await api('/api/state');
    const options = ['<option value="">全部来源</option>'];
    for (const source of data.sources) {
      options.push(`<option value="${source.key}">${escapeHtml(source.label)}</option>`);
    }
    els.source.innerHTML = options.join('');
  } catch {
    /* 忽略 */
  }
}

async function loadAuthors() {
  const params = new URLSearchParams();
  if (els.q.value.trim()) params.set('q', els.q.value.trim());
  if (els.source.value) params.set('source', els.source.value);

  els.list.innerHTML = '<div class="au-empty">加载中…</div>';

  try {
    const data = await api(`/api/authors?${params}`);
    authors = data.authors;
    els.count.textContent = `${data.total} 位作者`;
    render();
  } catch (err) {
    els.list.innerHTML = `<div class="au-empty">加载失败：${escapeHtml(err.message)}</div>`;
  }
}

function render() {
  if (authors.length === 0) {
    els.list.innerHTML = '<div class="au-empty">没有匹配的作者。</div>';
    return;
  }

  const max = authors[0].count || 1;

  els.list.innerHTML = authors
    .map((author, index) => {
      const ratio = Math.round((author.done / author.count) * 100);
      const barWidth = Math.max(2, Math.round((author.count / max) * 100));

      return `
        <a class="au-row" href="/?author_id=${encodeURIComponent(author.author_id)}&source=${
          author.sources[0] ?? 'illustPublic'
        }" target="_blank" rel="noopener">
          <span class="au-rank">${index + 1}</span>
          <span class="au-main">
            <span class="au-name">${escapeHtml(author.name)}</span>
            <span class="au-bar"><i style="width:${barWidth}%"></i></span>
          </span>
          <span class="au-count">${author.count}</span>
          <span class="au-done" title="已下载 ${author.done} / ${author.count}">${ratio}%</span>
        </a>`;
    })
    .join('');
}

els.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadAuthors, 260);
});

els.source.addEventListener('change', loadAuthors);

els.list.addEventListener('click', (event) => {
  const row = event.target.closest('.au-row');
  if (!row) return;
  // 允许直接在本页打开（按住 Ctrl/中键走浏览器默认行为）
  if (event.ctrlKey || event.metaKey || event.button === 1) return;
  event.preventDefault();
  window.open(row.href, '_blank', 'noopener');
});

loadSources().then(loadAuthors);
loadAuthors();

/**
 * Pixiv 网页版 AJAX 接口封装。
 *
 * 走的是 www.pixiv.net/ajax/* 这套「非官方但稳定多年」的接口，认证只需要浏览器的
 * PHPSESSID。相比 OAuth 私有 API，好处是不用注册客户端；代价是字段结构说变就变，
 * 所以下面所有解析都做了多路兜底，而不是硬编码单一形状。
 *
 * 一个关键事实：收藏列表接口**不返回收藏时间**。bookmarkData 只有 { id, private }。
 * 因此无法用时间戳做增量断点，改用「整页 id 是否都已在本地」来判断是否追平
 * （列表按收藏时间倒序，所以一旦出现整页已知，后面只会更旧）。
 */
import { httpsGetWithRetry } from './http.mjs';

const ORIGIN = 'https://www.pixiv.net';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 把 `a=1&b=2` 拼成查询串，空值也保留（Pixiv 对参数齐全度比较敏感）。 */
function buildQuery(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    usp.set(key, value === undefined || value === null ? '' : String(value));
  }
  return usp.toString();
}

/**
 * 用户可能直接粘贴整串 cookie，也可能只贴 PHPSESSID 的值。两种都接住。
 */
export function normalizeCookie(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (text.includes('=')) {
    // 去掉换行，避免从浏览器复制时带进来的折行破坏请求头。
    return text.replace(/\s*\r?\n\s*/g, '; ').replace(/;\s*;/g, ';').trim();
  }
  return `PHPSESSID=${text}`;
}

export class PixivError extends Error {
  constructor(message, { status, hint } = {}) {
    super(message);
    this.name = 'PixivError';
    this.status = status;
    this.hint = hint;
  }
}

export class PixivClient {
  constructor({ cookie, proxy, limiter, userId = '', userAgent = DEFAULT_UA, verbose = false }) {
    this.cookie = normalizeCookie(cookie);
    this.proxy = proxy;
    this.limiter = limiter;
    this.userId = String(userId || '');
    this.userAgent = userAgent;
    this.verbose = verbose;
  }

  /** 统一的 ajax 请求入口：限速由 limiter 统一管，这里不自己 sleep。 */
  async ajax(pathname, params = {}, { allowRetry = true } = {}) {
    const url = `${ORIGIN}${pathname}?${buildQuery(params)}`;
    const headers = {
      Cookie: this.cookie,
      Referer: `${ORIGIN}/`,
      Origin: ORIGIN,
      Accept: 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': this.userAgent,
    };
    // 收藏接口对 x-user-id 敏感，拿到就带上。
    if (this.userId) headers['x-user-id'] = this.userId;

    const request = () =>
      allowRetry
        ? httpsGetWithRetry(
            url,
            { headers, proxy: this.proxy, timeoutMs: 30000 },
            {
              retries: 3,
              onRetry: (n, delay, err) => {
                if (this.verbose) {
                  process.stderr.write(
                    `  ! 第 ${n} 次重试（${Math.round(delay / 1000)}s 后）：${err?.message ?? ''}\n`,
                  );
                }
              },
            },
          )
        : httpsGetWithRetry(url, { headers, proxy: this.proxy, timeoutMs: 30000 }, { retries: 0 });

    const res = await this.limiter.run(request);
    return this.parseAjax(res, url);
  }

  parseAjax(res, url) {
    let payload;
    try {
      payload = JSON.parse(res.body);
    } catch {
      throw new PixivError(
        `接口返回的不是 JSON（HTTP ${res.status}）。通常是代理返回了错误页，或 Pixiv 改了接口。`,
        { status: res.status, hint: `URL: ${url}` },
      );
    }

    if (payload.error) {
      const message = payload.message || '未知错误';
      const hint =
        res.status === 403 || /登录|login/i.test(message)
          ? 'cookie 可能已失效，请重新登录 pixiv 并复制新的 PHPSESSID。'
          : res.status === 400
            ? 'Pixiv 拒绝了请求，常见原因是 cookie 缺失/失效，或缺少必要的请求头。'
            : '';
      throw new PixivError(`Pixiv 返回错误：${message}`, { status: res.status, hint });
    }

    return payload.body;
  }

  /**
   * 探测当前登录账号的 userId。
   * 优先用配置值；否则依次尝试轻量接口和首页 HTML 正则 —— 这两个路径历史上
   * 至少有一个能用，比依赖单一方案稳。
   */
  async resolveUserId() {
    if (this.userId) return this.userId;

    // 路径一：ajax 接口
    try {
      const body = await this.ajax('/ajax/user/extra', { lang: 'zh' });
      const candidate =
        body?.user_id ?? body?.userId ?? body?.id ?? body?.user?.id ?? body?.user?.userId;
      if (candidate) {
        this.userId = String(candidate);
        return this.userId;
      }
    } catch {
      // 落到下一种方式
    }

    // 路径二：首页 HTML 里的内联 JSON
    const res = await this.limiter.run(() =>
      httpsGetWithRetry(
        `${ORIGIN}/`,
        {
          headers: {
            Cookie: this.cookie,
            'User-Agent': this.userAgent,
            Accept: 'text/html',
          },
          proxy: this.proxy,
          timeoutMs: 30000,
        },
        { retries: 1 },
      ),
    );

    const matched = res.body.match(/"userId"\s*:\s*"(\d+)"/);
    if (matched) {
      this.userId = matched[1];
      return this.userId;
    }

    throw new PixivError('无法自动识别 userId，请在 config.json 里手工填写 userId 字段。', {
      status: res.status,
    });
  }

  /**
   * 拉一页收藏。kind = 'illust' | 'novel'。
   */
  async fetchBookmarkPage(kind, offset, { limit, includePrivate = true } = {}) {
    const segment = kind === 'novel' ? 'novels' : 'illusts';
    const uid = await this.resolveUserId();
    // rest=show 返回全部（含非公开），rest=hide 只返回公开收藏。
    const rest = includePrivate ? 'show' : 'hide';
    const body = await this.ajax(`/ajax/user/${uid}/${segment}/bookmarks`, {
      tag: '',
      offset,
      limit,
      rest,
      lang: 'zh',
    });

    return { total: Number(body?.total ?? 0), items: extractItems(body) };
  }
}

/**
 * 不同接口把列表放在 works / novels / items 里，元素还可能被 { novel: {...} } 包一层。
 * 这里统一拆平。
 */
function extractItems(body) {
  if (!body) return [];
  const rawList = body.works ?? body.novels ?? body.items ?? [];
  if (!Array.isArray(rawList)) return [];

  return rawList.map((entry) => {
    if (entry && typeof entry === 'object' && entry.novel) {
      return { item: entry.novel, bookmark: entry.bookmarkData ?? null };
    }
    return { item: entry, bookmark: entry?.bookmarkData ?? null };
  });
}

const ILLUST_TYPE_LABEL = { 0: 'illust', 1: 'manga', 2: 'ugoira' };

/**
 * 标签在不同接口里形状不一致：收藏列表给字符串数组，作品详情给 { tag, translatedName }
 * 对象数组。两种都要能接住，否则遇到第二种就会把 "[object Object]" 写进备份。
 */
function extractTags(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((tag) => {
      if (typeof tag === 'string') return tag;
      if (tag && typeof tag === 'object') return tag.tag ?? tag.name ?? '';
      return String(tag ?? '');
    })
    .filter((tag) => tag !== '');
}

/**
 * 把接口原始对象归一化成内部记录。字段缺失时宁可为空，也不要编造。
 */
export function normalizeIllust(raw, bookmark, firstSeen) {
  const id = String(raw.illustId ?? raw.id ?? bookmark?.id ?? '');
  if (!id) return null;

  return {
    id,
    type: ILLUST_TYPE_LABEL[raw.illustType] ?? 'illust',
    title: raw.illustTitle ?? raw.title ?? '',
    author: raw.userName ?? '',
    author_id: String(raw.userId ?? ''),
    account: raw.userAccount ?? '',
    published: raw.uploadDate ?? raw.createDate ?? '',
    pages: raw.pageCount ?? '',
    tags: extractTags(raw.tags),
    x_restrict: raw.xRestrict ?? 0,
    ai_type: raw.aiType ?? '',
    private_bookmark: bookmark?.private === true ? 'yes' : 'no',
    first_seen: firstSeen,
    url: `${ORIGIN}/artworks/${id}`,
  };
}

export function normalizeNovel(raw, bookmark, firstSeen) {
  const id = String(raw.id ?? bookmark?.id ?? '');
  if (!id) return null;

  return {
    id,
    type: 'novel',
    title: raw.title ?? '',
    author: raw.userName ?? '',
    author_id: String(raw.userId ?? ''),
    account: raw.userAccount ?? '',
    published: raw.uploadDate ?? raw.createDate ?? '',
    pages: raw.pageCount ?? '',
    // 小说字数在不同接口里叫 textCount / textLength / characterCount，都试一遍。
    text_length: raw.textCount ?? raw.textLength ?? raw.characterCount ?? '',
    tags: extractTags(raw.tags),
    x_restrict: raw.xRestrict ?? 0,
    ai_type: raw.aiType ?? '',
    private_bookmark: bookmark?.private === true ? 'yes' : 'no',
    first_seen: firstSeen,
    url: `${ORIGIN}/novel/show.php?id=${id}`,
  };
}

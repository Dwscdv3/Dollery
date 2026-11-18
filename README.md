# pixiv-export

把 Pixiv 账号里的收藏（插画/漫画 + 小说，公开 + 私密）备份成本地 JSON，用 Git 记录每一次变化。
需要时可以把作品本身下载下来，压缩成 AVIF 存放以节省空间。

## 为什么是 JSON

早期版本用的是「每条多行 key: value」的纯文本，后来改成了 JSON。原因是标签：
作品标签和收藏标签都是数组，纯文本里只能折成逗号分隔的字符串，遇到含逗号的标签就得
自己发明转义规则。JSON 用数组原样表达，读写都不用绕。

代价是 diff 不如纯文本精细，所以序列化是手写的而不是 `JSON.stringify(obj, null, 2)`：

- 每条记录独立成块，一个字段一行 —— 改个标题就只变那一行
- 标签数组内联成 `["a", "b"]` —— 不会因为标签多就把文件撑成几百行

## 快速开始

```bash
cd pixiv-export
cp config.example.json config.json

# 1. 填 cookie
mkdir -p .secrets
# 把 PHPSESSID 的值写进 .secrets/cookies.txt（只写值也行，程序会自动补键名）

# 2. 体检
node src/cli.mjs check

# 3. 首次同步
node src/cli.mjs sync --full
```

### 怎么拿到 cookie

1. 浏览器登录 [pixiv.net](https://www.pixiv.net)
2. F12 打开开发者工具 → Application（应用）→ Cookies → `https://www.pixiv.net`
3. 复制 `PHPSESSID` 的值

cookie 会过期（通常几个月）。同步时报 `cookie 可能已失效`，重新复制一次即可。

`.secrets/`、`config.json`、`.cache/` 都在 `.gitignore` 里，不会误提交。

## 双击即用的入口（Windows）

| 文件 | 作用 | 耗时 |
| --- | --- | --- |
| `sync.bat` | 增量同步，只抓新增收藏 | 10~20 秒* |
| `sync-full.bat` | 全量同步，能发现取消收藏 | 6 分钟起 |
| `download.bat` | 按序号下载作品，运行时提示输入范围 | 看数量 |
| `viewer.bat` | 打开收藏查看器（网格浏览 + 按需下载） | 常驻窗口 |
| `status.bat` | 查看本地备份概况 | 瞬间 |

\* 首次建立收藏标签映射时会久得多，见下文「收藏标签」。

`sync-full.bat` 内部拆成「公开」和「私密」两段串行执行，Ctrl+C 不会白跑 ——
已完成的通道已经写入文件，重跑时会自动接着来。

> 脚本里的提示文字是英文，这是刻意的：cmd.exe 按系统 ANSI 代码页解析 `.bat` 文件，
> 里面写 UTF-8 中文会被解析成乱码甚至被当成命令报错。程序自身的中文输出由 Node
> 打印，配合脚本开头的 `chcp 65001` 显示正常。

## 公开与私密是两份独立的收藏

Pixiv 的公开收藏和非公开收藏是**两个互斥的列表**，各有自己的总数和分页，接口无法一次拿全。

`ajax/user/{uid}/{illusts,novels}/bookmarks` 的 `rest` 参数语义是「是否对他人可见」：

| 参数 | 返回 | 实测（某账号） |
| --- | --- | --- |
| `rest=show` | 公开收藏 | 插画 4859 / 小说 3 |
| `rest=hide` | 私密收藏 | 插画 10394 / 小说 230 |

所以同步分四条通道，分别落盘：

| 通道 | 文件 |
| --- | --- |
| 插画/漫画·公开 | `data/bookmarks-illust.json` |
| 插画/漫画·私密 | `data/bookmarks-illust-private.json` |
| 小说·公开 | `data/bookmarks-novel.json` |
| 小说·私密 | `data/bookmarks-novel-private.json` |

## 两个 id，别搞混

| 字段 | 含义 |
| --- | --- |
| `id` | 收藏序号，1 = 最早收藏。由本程序分配，用于排序和 `--id` 批量选择 |
| `pid` | 作品在 Pixiv 上的编号，如 `151677913`。用于拼 URL 和文件名 |

`id` 一经分配就不再重排 —— 哪怕你取消了中间某一条，后面的记录也不会往前挪，只在原位
留一个空洞。否则取消一条就会导致几千行一起位移，diff 直接废掉。

新收藏的 `id` 接在最大值之后；取消后又重新收藏会拿到新的 `id`（因为这在 Pixiv 上
就是一次新的收藏行为）。

因为服务端列表不含收藏时间戳，`id` 只能通过翻页顺序推断，所以**必须完整翻完一次**
才能建立准确编号 —— 这就是首次同步要 `--full` 的原因。本地无 `id` 的旧数据会被
增量同步拒绝，要求先跑全量完成迁移。

## 两个 tags，来源完全不同

这是本程序最容易误解的地方，单独说清楚：

| 字段 | 来源 | 谁能看到 |
| --- | --- | --- |
| `tags` | 作者给作品打的标签 | 所有人 |
| `bookmark_tags` | **你自己收藏时打的分类标签** | 只有你 |

## 收藏标签是怎么拿到的（以及为什么慢）

Pixiv 没有接口能直接告诉你"某作品有哪些收藏标签"。实测确认：

- 收藏列表接口的 `bookmarkData` 只有 `{ id, private }`，没有 tags
- `/ajax/illust/{pid}/bookmarkData` 同样不带 tags，即使该作品确实有收藏标签

唯一可行的路径是**反向查**：

1. 调 `/ajax/user/{uid}/illusts/bookmark/tags` 拿到你所有收藏标签及各自的作品数
2. 对每个标签翻一遍收藏列表（`?tag=xxx`），反推出 `pid → 标签` 映射
3. 把映射写进每条记录的 `bookmark_tags`

代价是**每个标签至少一次请求**。实测一个账号公开 242 个 + 私密 626 个标签，
首次要 868 次请求、约 30 分钟（2 秒间隔）。所以做了三层优化：

- **缓存**：缓存文件在 `.cache/`，用「标签名 + 作品数」的签名判断标签集合有没有变
- **增量**：只有作品数变化的标签才重扫。日常同步通常只多 1 次请求
- **续跑**：每扫完 10 个标签就落盘，中断（包括跑到一半按 Ctrl+C）后重跑会接着来

想跳过标签更新用 `--skip-tags`；想强制重建用 `--rebuild-tags`。

### 「未分類」被过滤掉了

Pixiv 会把**没打收藏标签**的作品自动归到「未分類」这个默认分类下。实测某账号 4859 条
收藏里 3823 条挂在这个标签下，而真正打过标签的作品不会同时拥有它。它不是你的标签，
写进备份只会给大半记录加一行噪声，所以代码里直接过滤掉。

## 增量是怎么判断的

**Pixiv 的收藏列表接口不返回收藏时间。** 所以增量断点不靠时间戳，而是靠位置：
列表按收藏时间倒序排列，从第一页往后翻，当**连续两页**的作品 id 全都已经在本地时，
说明追平了 —— 再往后只会更旧。连续两页（而不是一页）是为了排除分页位移造成的错觉。

另外还要求本地记录数达到服务端总数的 90%，否则继续翻。这是为了防止上次同步被
`--max-pages` 截断后，前几页恰好全已知就误判追平、导致剩下的记录永远补不齐。

| 模式 | 行为 | 用途 |
| --- | --- | --- |
| `sync` | 只追加新记录，追平即停 | 每天/每周跑 |
| `sync --full` | 翻完所有页，标记取消收藏、刷新字段 | 定期跑（比如每月） |

## 取消收藏只做标记

全量同步发现某条收藏已不在服务端时**不会删除记录**，而是加一个字段：

```json
"removed": "yes"
```

原始内容全部保留。这样 `git diff` 只是一行新增而不是整块删除，历史也还能查。
如果之后又重新收藏了它，标记会自动清除并重新编号。

## 已失效的作品

收藏夹里有一部分作品后来被作者删除或转为不可见，Pixiv 仍会为它们占位，但返回的是
编造的数据：标题和作者都成了 `-----`、`author_id: 0`、发布日期 `1970-01-01`、
尺寸固定 100×100。实测某账号公开侧 4859 条里有 297 条属于这种。

程序给这类记录加 `status: "unavailable"`，其余字段保持接口原样（不编造）。

注意这和 `removed` 是两个不同的概念：`status` 说的是**作品本身没了**，
`removed` 说的是**你不再收藏它**。

## 命令

```bash
node src/cli.mjs sync              # 增量同步（日常用这个）
node src/cli.mjs sync --full       # 全量同步：标记取消收藏、刷新字段
node src/cli.mjs sync --dry-run    # 只看差异，不写文件
node src/cli.mjs sync --skip-tags  # 这次不更新收藏标签
node src/cli.mjs sync --rebuild-tags  # 强制重建收藏标签映射
node src/cli.mjs status            # 本地备份概况
node src/cli.mjs check             # 检查代理和 cookie

node src/cli.mjs sync --public-only    # 只同步公开收藏
node src/cli.mjs sync --private-only   # 只同步私密收藏
node src/cli.mjs sync --illust-only
node src/cli.mjs sync --novel-only
node src/cli.mjs sync --max-pages 5
node src/cli.mjs sync --interval 3000

node src/cli.mjs download --id 1-5     # 下载作品（见下文）
```

## 请求节奏

相邻两次请求的发起间隔强制 >= `intervalMs`（默认 2000ms，可调高，但程序拒绝低于 500ms）。
所有请求串行排队，不做并发 —— 这里刻意用吞吐换可预测的行为。

分页上限实测是 **100**（超过会返回 400），所以默认每页取 100 条。四条通道全量一次：

| 通道 | 页数 | 约耗时 |
| --- | --- | --- |
| 插画·公开 | 49 | 2 分钟 |
| 插画·私密 | 104 | 4 分钟 |
| 小说·公开 | 1 | 2 秒 |
| 小说·私密 | 3 | 7 秒 |

增量同步通常只花 2~6 个请求。

## 安全阀

`--full` 模式下，如果**超过一半**的记录都没在服务端出现（且本地超过 10 条），程序会中止
并且**不写入文件**。这基本只会发生在一种情况：cookie 失效，接口返回空列表。
没有这层保护，一次失效就会把几千条收藏全部误标成"已移除"。

## 文件格式

```json
{
  "_meta": {
    "format": "pixiv-export/2",
    "kind": "插画/漫画（公开）",
    "count": 2,
    "lastSync": "2026-11-18 00:12:00",
    "sourceTotal": 4859
  },
  "records": [
    {
      "id": 1,
      "pid": "33621717",
      "type": "illust",
      "title": "無題",
      "author": "カレー飯",
      "author_id": "4301078",
      "published": "2013-02-16T18:20:25+09:00",
      "pages": 1,
      "width": 819,
      "height": 537,
      "tags": ["オリジナル", "女の子"],
      "bookmark_tags": ["風景", "10/10"],
      "x_restrict": 0,
      "ai_type": 0,
      "private_bookmark": "no",
      "first_seen": "2026-11-17",
      "url": "https://www.pixiv.net/artworks/33621717"
    },
    {
      "id": 2,
      "pid": "139007867",
      "type": "illust",
      "title": "-----",
      "author": "-----",
      "author_id": "0",
      "published": "1970-01-01T00:00:00+09:00",
      "status": "unavailable",
      "removed": "yes",
      "url": "https://www.pixiv.net/artworks/139007867"
    }
  ]
}
```

第二条同时展示了两种情况：作品已被删除（`status`），且你已取消收藏（`removed`）。

字段说明：

| 字段 | 含义 |
| --- | --- |
| `id` | 收藏序号，1 = 最早收藏 |
| `pid` | 作品在 Pixiv 上的编号 |
| `type` | `illust` / `manga` / `ugoira` / `novel` |
| `pages` | 插画页数（仅插画；收藏接口不返回小说章节数） |
| `width` / `height` | 原图尺寸（仅插画） |
| `text_length` | 小说字数（仅小说） |
| `language` | 小说语言，如 `zh-cn` / `ja`（仅小说） |
| `tags` | **作者**打的标签 |
| `bookmark_tags` | **你自己**打的收藏标签 |
| `x_restrict` | 0 全年龄 / 1 R-18 / 2 R-18G |
| `private_bookmark` | 是否为非公开收藏（与所在文件一致） |
| `status` | 只在作品已失效时出现，值为 `unavailable` |
| `removed` | 只在已取消收藏时出现，值为 `yes` |
| `first_seen` | 本程序首次发现这条收藏的本地日期 |

用 jq 或 node 都能直接查：

```bash
# 按收藏标签筛
jq '[.records[] | select(.bookmark_tags // [] | index("風景"))] | length' data/bookmarks-illust.json

# 找出所有已取消的收藏链接
jq -r '.records[] | select(.removed) | .url' data/bookmarks-illust*.json

# 按作者统计（排除已失效的占位记录）
jq -r '.records[] | select(.author != "-----") | .author' data/bookmarks-illust.json | sort | uniq -c | sort -rn | head
```

### 关于收藏数、点赞数、浏览数

**不记录**，这是有意的，而且有两个理由：

1. 插画侧的收藏接口根本不返回这些数字（小说侧只有 `bookmarkCount`，形状还不一致）。
2. 就算拿得到，这些数每天都在变，记进来会让每次全量同步产生几千行噪声 diff。

备份的意义是记录"我收藏了什么"，不是"它现在多少赞"。

## 下载作品

```bash
node src/cli.mjs download --id 1-5            # 下载第 1~5 条
node src/cli.mjs download --id 1,3,7          # 只下这三条
node src/cli.mjs download --id 1-10,20        # 组合写法
node src/cli.mjs download --id 1-5 --private-only   # 只下私密侧
node src/cli.mjs download --id 1-3 --dry-run  # 先看看会下什么
node src/cli.mjs download --id 1 --novel      # 下小说正文
```

`--id` 用的是 `id` 字段（收藏序号）。**公开和私密各自独立编号**，所以 `--id 1-3`
默认会命中两边（公开的 1~3 和私密的 1~3），要单边就用 `--public-only` / `--private-only`。

### 产出

| 类型 | 文件名 | 说明 |
| --- | --- | --- |
| 插画/漫画 | `{pid}_p0.avif`、`{pid}_p1.avif`… | 每页一个文件，页码从 0 起 |
| 动图 ugoira | `{pid}_ugoira.zip` | 官方原始 zip，不转码 |
| 小说 | `{pid}.txt` | 正文 + 标题/作者/字数抬头 |

文件平铺在 `images/` 下，用 `pid` 命名，所以公开和私密的产物不会撞名。

### AVIF 压缩

下载的是**原图**（`urls.original`，不是网页显示用的 1200px 缩略图），然后用 ImageMagick
转 AVIF（`-quality 50`），再删掉原图。实测一张 657.9 KB 的 PNG 压到 44.9 KB（6.8%），
单张耗时约 0.6 秒。

想要无损或不删原图：

```bash
node src/cli.mjs download --id 1-5 --keep-original   # 原图和 AVIF 都留下
node src/cli.mjs download --id 1-5 --quality 85      # 提质量，仍删原图
```

动图 zip 不做压缩，所以批次里混了动图时整体节省比例会被拉低，这是预期的。

需要 `magick` 命令在 PATH 里，找不到时程序会明确报错。

### 断点续传

目标文件已存在就跳过。已取消收藏（`removed`）和作品已失效（`status: unavailable`）的
记录会被跳过并计数 —— 这两类作品的图基本也取不到了。

图片走 `i.pximg.net`，请求必须带 `Referer: https://www.pixiv.net/`，否则 403（程序已处理）。
图片限速与接口分开，默认 1 秒（`--image-interval` 可调）。

## 收藏查看器

```bash
node viewer/server.mjs      # 或者双击 viewer.bat
```

会在 `127.0.0.1:7788` 起一个本地服务，并用 Edge 的 `--app` 模式打开一个无地址栏窗口
（没有标签页和地址栏，看着就是个独立程序）。

### 为什么是本地 Web 而不是原生 GUI

试过几条路，最后卡在一个硬约束上：**图片全是 AVIF**。

| 方案 | 体积 | 内存 | AVIF 解码 |
| --- | --- | --- | --- |
| 本地 Web + Edge app | 0 | ~120MB（Edge 进程） | 浏览器原生 |
| Tauri | 3~8MB | ~150MB（WebView2 多进程） | 原生 |
| Rust + egui | ~5MB | ~50MB | 需自己集成 libavif |
| .NET WPF | ~70MB | ~80MB | 依赖系统扩展 |

Rust/egui 内存最省，但 `image` crate 不支持 AVIF，得编译 libavif 或用 ImageMagick
转码后再显示。而浏览器内核原生支持 AVIF，且这里的代码已经全是 Node ——
选定本地 Web 后新增体积为 0，还不用重复实现下载逻辑。

用 Edge 的 `--app=http://...` 打开时没有地址栏、没有标签页，观感与原生窗口一致。

### 功能

- 四种来源切换（插画/小说 × 公开/私密），带数量；支持 `?source=illustPrivate` 直达
- 按标题、作者、pid 搜索；按收藏标签筛选；只看未下载
- 网格自适应窗口宽度，滚动到底自动加载下一页
- **可见即下载**：滚到哪，视口内未下载的作品就自动进下载队列（见下节）
- **点击即下载**：本地没有的作品，点开时优先插到队首下载，完成后直接显示大图
- 大图支持滚轮缩放（以鼠标为中心）、拖动、双击切换 1:1/2.2×、方向键翻页、Esc 关闭

### 可见即下载

原理很简单：卡片进入视口时，如果本地没有就扔进服务端的下载队列。难的是别把事搞坏。

**队列是串行的。** 下载本身已经带着 2 秒接口限速和 1 秒图片限速，并发只会让两边互抢配额。
一个作品下完才轮到下一个。

**三层去重**，同一个作品绝不会被下两次：

| 层 | 位置 | 作用 |
| --- | --- | --- |
| `state.submitted` | 前端 | 提交过的 pid 不再提交 |
| 卡片状态 | 前端 | 已有图、已下载、下载失败的不提交 |
| `queued` / `done` / `failed` | 服务端 | 排队中、已完成、已失败的全部拦截 |

实测重复提交同一个 pid、以及一次提交三个相同的 pid，服务端返回的 `added` 都是 0。

**超大作品不自动下。** 你的收藏里有 62 页、92 页的合集，一个就要两三分钟——进了自动队列
会把后面全堵住。所以自动队列跳过页数超过 30 的作品（卡片保持"点击下载"，点开时不受限制，
并且插到队首优先处理）。队列还会按页数升序排，让短作品先出结果。

工具栏有个开关可以随时关掉自动下载，已在队列里的会继续跑完。

### 缩略图是必须的

网格里的缩略图由服务端用 ImageMagick 现场转成 320px JPEG，落盘到 `viewer/.thumbs/`。
这不是优化而是必需：AVIF 解码比 JPEG 慢 3~5 倍，直接把原图铺进网格会让滚动卡住。

配套的两个细节：

- 浏览器只请求**进入视口**的缩略图（IntersectionObserver，提前 400px 预取）
- 服务端把 ImageMagick 并发限制在 2 个。浏览器会开 6 个并发连接，不限制的话
  会堆起一串 magick 进程互相抢 CPU，反而更慢

实测单张缩略图首次生成约 260ms，命中缓存后 90ms。

## 配置项

`config.json`（从 `config.example.json` 复制）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `proxy` | `http://127.0.0.1:7897` | 本地代理，Pixiv 直连不可用 |
| `intervalMs` | `2000` | 请求最小间隔 |
| `cookie` | `""` | 也可用 `.secrets/cookies.txt` 或环境变量 `PIXIV_COOKIE` |
| `userId` | `""` | 留空自动探测 |
| `includeNovels` | `true` | 是否同步小说收藏 |
| `pageSize` | `{illust:100, novel:100}` | 每页条数，接口上限 100 |
| `maxPagesPerRun` | `0` | 每条通道每次最多抓几页，0 为不限 |
| `output.*` | 见上文四条通道 | 四个输出文件路径 |
| `download.dir` | `images` | 下载输出目录 |
| `download.avifQuality` | `50` | AVIF 质量，1~100 |
| `download.imageIntervalMs` | `1000` | 图片下载间隔 |
| `download.keepOriginal` | `false` | 是否保留原始图片 |
| `bookmarkTags.enabled` | `true` | 是否同步收藏标签 |
| `bookmarkTags.cacheDir` | `.cache` | 标签映射缓存目录 |

## 自测

```bash
npm run selftest
```

覆盖纯数据逻辑：JSON 序列化往返幂等、标签数组内联格式、`_meta` 读写、排序、
差分的空值归一化、收藏标签变化的检出、id 分配、取消标记与重新收藏、安全阀、
旧数据迁移保护。网络和真实接口不在这里测。

## 已知限制

- 依赖网页端 `www.pixiv.net/ajax/*` 接口，属非官方接口，Pixiv 改动时可能失效。
- 拿不到收藏时间戳，`id` 由翻页顺序推断，只有完整全量同步才能保证编号准确。
- 只能读到"当前仍在收藏夹里"的作品；一旦取消收藏且没及时同步，就无法追回。
- 公开与私密是两个独立序列，各自的 `id=1` 不是同一个时间点，无法跨文件比较先后。
- 收藏标签只能逐标签反查，首次建立映射约 30 分钟；标签数特别多时 Pixiv 会返回
  `tooManyBookmarkTags`，可能有标签抓不全，程序会提示。
- 动图只保存官方 zip，不转码，体积不会缩小。
- 已取消收藏、作品已失效的记录会跳过下载 —— 这两类作品的图通常也取不到了。

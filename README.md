# pixiv-export

把 Pixiv 账号里的收藏（插画/漫画 + 小说，公开 + 私密）备份成本地纯文本，用 Git 记录每一次变化。

只做元数据备份，不下载图片。

## 为什么是纯文本

收藏备份的核心价值不是"存下来"，而是"看得见变化"。所以存储格式选了每条记录一块
`key: value` 的纯文本，而不是 JSON 或 SQLite：

- 收藏一件新作品 → `git diff` 里就是新增的一个记录块，一眼看完
- 某个作品改了标题/标签 → 只有那一两行变色
- 取消收藏 → 整块内容不动，只多出一行 `removed: yes`

JSON 数组插一条会让后面所有行错位，SQLite 是二进制根本没法 diff，所以都没选。

## 快速开始

```bash
cd pixiv-export
cp config.example.json config.json

# 1. 填 cookie
mkdir -p .secrets
# 把 PHPSESSID 的值写进 .secrets/cookies.txt（只写值也行，程序会自动补键名）

# 2. 体检
node src/cli.mjs check

# 3. 首次同步（必须先 --full，见下文「收藏顺序号」）
node src/cli.mjs sync --full
```

### 怎么拿到 cookie

1. 浏览器登录 [pixiv.net](https://www.pixiv.net)
2. F12 打开开发者工具 → Application（应用）→ Cookies → `https://www.pixiv.net`
3. 复制 `PHPSESSID` 的值

cookie 会过期（通常几个月）。同步时报 `cookie 可能已失效`，重新复制一次即可。

`.secrets/` 和 `config.json` 都在 `.gitignore` 里，不会误提交。

## 双击即用的入口（Windows）

不想敲命令的话，项目根目录有三个 `.bat`，双击就能跑：

| 文件 | 作用 | 耗时 |
| --- | --- | --- |
| `sync.bat` | 增量同步，只抓新增收藏 | 10~20 秒 |
| `sync-full.bat` | 全量同步，能发现取消收藏 | 约 12 分钟 |
| `status.bat` | 查看本地备份概况 | 瞬间 |

`sync-full.bat` 内部拆成「公开」和「私密」两段串行执行，中途 Ctrl+C 不会白跑 ——
已完成的通道已经写入文件，重跑时会自动接着来。

三个脚本跑完都会停住等按键，不会窗口一闪而过看不到结果。

> 脚本里的提示文字是英文，这是刻意的：cmd.exe 按系统 ANSI 代码页解析 `.bat` 文件，
> 里面写 UTF-8 中文会被解析成乱码甚至被当成命令报错。程序自身的中文输出由 Node
> 打印，配合脚本开头的 `chcp 65001` 显示正常。

## 公开与私密是两份独立的收藏

这一点容易搞错，必须说清楚：Pixiv 的公开收藏和非公开收藏是**两个互斥的列表**，
各有自己的总数和分页，接口无法一次性拿全。

`ajax/user/{uid}/{illusts,novels}/bookmarks` 的 `rest` 参数语义是「是否对他人可见」：

| 参数 | 返回 | 实测（某账号） |
| --- | --- | --- |
| `rest=show` | 公开收藏，`bookmarkData.private` 全为 false | 插画 4859 / 小说 3 |
| `rest=hide` | 私密收藏，`bookmarkData.private` 全为 true | 插画 10394 / 小说 230 |

所以同步分四条通道，分别落盘：

| 通道 | 文件 |
| --- | --- |
| 插画/漫画·公开 | `data/bookmarks-illust.txt` |
| 插画/漫画·私密 | `data/bookmarks-illust-private.txt` |
| 小说·公开 | `data/bookmarks-novel.txt` |
| 小说·私密 | `data/bookmarks-novel-private.txt` |

私密侧通常比公开侧大得多，首次同步耗时也更长（见「请求节奏」）。

## 收藏顺序号 seq

每条记录带一个 `seq`，**=1 表示最早收藏的作品**，往后依次递增。文件按 `seq` 升序排列，
所以打开文件第一屏就是最早收藏的那些。

这里的机制值得说明，因为它决定了 diff 能不能看：

- **seq 一经分配就不再重排。** 哪怕你取消了中间某一条，后面的记录也不会往前挪，
  只在原来的位置留一个空洞。否则取消一条就会导致几千行一起位移，`git diff` 直接废掉。
- **新收藏的 seq 接在最大值之后。** 因为新收藏在服务端列表的最前头，这等价于"最新的排最后"。
- **取消后又重新收藏，会拿到新的 seq**（排到最后），因为这在 Pixiv 上就是一次新的收藏行为。
- 因为服务端列表不含收藏时间戳，seq 只能通过翻页顺序推断，所以**必须完整翻完一次**
  才能建立准确的编号 —— 这就是首次同步要 `--full` 的原因。

如果本地是无 seq 的旧数据，增量同步会直接拒绝并提示先跑 `--full`，避免写出乱序文件。

## 增量是怎么判断的

**Pixiv 的收藏列表接口不返回收藏时间。** `bookmarkData` 里只有 `{ id, private }`。

所以增量断点不靠时间戳，而是靠位置：收藏列表按收藏时间倒序排列，从第一页往后翻，
当**连续两页**的作品 id 全都已经存在于本地时，就说明追平了 —— 再往后只会更旧。
连续两页（而不是一页）是为了排除分页位移造成的错觉。

另外还要求本地记录数达到服务端总数的 90%，否则继续翻。这是为了防止上次同步被
`--max-pages` 截断后，前几页恰好全已知就误判追平、导致剩下的记录永远补不齐。

两种模式：

| 模式 | 行为 | 用途 |
| --- | --- | --- |
| `sync` | 只追加新记录，追平即停 | 每天/每周跑，成本极低 |
| `sync --full` | 翻完所有页，标记取消收藏、刷新字段 | 定期跑（比如每月） |

## 取消收藏只做标记

全量同步发现某条收藏已不在服务端时，**不会删除记录**，而是加一行：

```
removed: yes
```

原始内容（标题、作者、标签、seq）全部保留。这样：

- `git diff` 只是一行新增，不是整块删除
- 历史记录仍然可查，`grep -B12 '^removed: yes$'` 就能翻出所有取消过的收藏
- 如果之后又重新收藏了它，标记会自动清除

## 已失效的作品会被标记出来

收藏夹里有一部分作品后来被作者删除或转为不可见，Pixiv 仍会为它们占位，但返回的
是编造的数据：标题和作者都成了 `-----`、`author_id: 0`、发布日期 `1970-01-01`、
尺寸固定 100×100。实测一个 4859 条的公开收藏夹里有 297 条属于这种。

程序会给这类记录加上 `status: unavailable`，其余字段保持接口原样（不编造）。
注意这和 `removed` 是两个不同的概念：`status` 说的是作品本身没了，
`removed` 说的是你不再收藏它。

```bash
grep -B10 '^status: unavailable$' data/bookmarks-illust.txt | grep '^url:'
```

## 命令

```bash
node src/cli.mjs sync              # 增量同步（日常用这个）
node src/cli.mjs sync --full       # 全量同步：标记取消收藏、刷新字段
node src/cli.mjs sync --dry-run    # 只看差异，不写文件
node src/cli.mjs status            # 本地备份概况
node src/cli.mjs check             # 检查代理和 cookie

node src/cli.mjs sync --public-only    # 只同步公开收藏
node src/cli.mjs sync --private-only   # 只同步私密收藏
node src/cli.mjs sync --illust-only
node src/cli.mjs sync --novel-only
node src/cli.mjs sync --max-pages 5
node src/cli.mjs sync --interval 3000
```

也可以 `npm run sync` / `npm run sync:full` / `npm run status`。

## 请求节奏

相邻两次请求的发起间隔强制 >= `intervalMs`（默认 2000ms，可调高，但程序拒绝低于 500ms）。
所有请求串行排队，不做并发 —— 这里刻意用吞吐换可预测的行为。

按 2000ms 估，四条通道全量一次：

| 通道 | 页数 | 约耗时 |
| --- | --- | --- |
| 插画·公开 | 102 | 4 分钟 |
| 插画·私密 | 217 | 8 分钟 |
| 小说·公开 | 1 | 2 秒 |
| 小说·私密 | 10 | 25 秒 |

增量同步通常只花 2~6 个请求。终端会实时打印页码和预估剩余时间。

私密侧页数多，单次全量可能超过 10 分钟。想分段跑就用 `--public-only` / `--private-only`。

## 安全阀

`--full` 模式下，如果**超过一半**的记录都没在服务端出现（且本地超过 10 条），程序会中止
并且**不写入文件**。这基本只会发生在一种情况：cookie 失效，接口返回空列表。
没有这层保护，一次失效就会把几千条收藏全部误标成"已移除"。

## 文件格式

```
# pixiv-export 收藏元数据备份
# 格式：每条记录为多行 key: value，记录之间用空行分隔
# 按 seq 升序排列，seq=1 是最早收藏的作品
# 记录数: 2

seq: 1
id: 151677913
type: illust
title: ヒフミ(レーシング)
author: 遥風ぎあ
author_id: 25432432
published: 2026-11-04T19:20:00+09:00
pages: 1
width: 2584
height: 4170
tags: BlueArchive, ブルーアーカイブ, ブルアカ
x_restrict: 0
ai_type: 0
private_bookmark: no
first_seen: 2026-11-17
url: https://www.pixiv.net/artworks/151677913

seq: 2
id: 139007867
type: illust
title: -----
author: -----
author_id: 0
published: 1970-01-01T00:00:00+09:00
pages: 1
width: 100
height: 100
x_restrict: 0
ai_type: 0
private_bookmark: no
status: unavailable
removed: yes
first_seen: 2026-11-17
url: https://www.pixiv.net/artworks/139007867
```

第二条同时展示了两种情况：作品已被删除（`status`），且你已取消收藏（`removed`）。

字段说明：

| 字段 | 含义 |
| --- | --- |
| `seq` | 收藏顺序号，1 = 最早收藏 |
| `type` | `illust` / `manga` / `ugoira` / `novel` |
| `pages` | 插画页数（仅插画；收藏接口不返回小说章节数） |
| `width` / `height` | 原图尺寸（仅插画，可用于筛竖图/横图） |
| `text_length` | 小说字数（仅小说） |
| `language` | 小说语言，如 `zh-cn` / `ja`（仅小说） |
| `x_restrict` | 0 全年龄 / 1 R-18 / 2 R-18G |
| `private_bookmark` | 是否为非公开收藏（与所在文件一致） |
| `status` | 只在作品已失效时出现，值为 `unavailable` |
| `removed` | 只在已取消收藏时出现，值为 `yes` |
| `first_seen` | 本程序首次发现这条收藏的本地日期，不会随同步更新 |

想按标签、作者、日期筛选，直接用 Unix 工具就行：

```bash
# 按标签找
grep -B4 'tags:.*原创' data/bookmarks-illust.txt

# 找出所有已取消的收藏链接
grep -B12 '^removed: yes$' data/bookmarks-illust*.txt | grep '^url:'

# 统计各作者的作品数（排除已失效的占位记录）
awk -F': ' '/^author: /{if($2!="-----") print $2}' data/bookmarks-illust.txt | sort | uniq -c | sort -rn | head
```

### 关于收藏数、点赞数、浏览数

**不记录**，这是有意的，而且有两个理由：

1. 插画侧的收藏接口根本不返回这些数字（小说侧只有 `bookmarkCount`，形状还不一致）。
2. 就算拿得到，这些数每天都在变，记进来会让每次全量同步产生几千行噪声 diff，
   把真正有价值的变更（新收藏、标题改动、作品失效）彻底淹掉。

备份的意义是记录"我收藏了什么"，不是"它现在多少赞"。

## 配置项

`config.json`（从 `config.example.json` 复制）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `proxy` | `http://127.0.0.1:7897` | 本地代理，Pixiv 直连不可用 |
| `intervalMs` | `2000` | 请求最小间隔 |
| `cookie` | `""` | 也可用 `.secrets/cookies.txt` 或环境变量 `PIXIV_COOKIE` |
| `userId` | `""` | 留空自动探测 |
| `includeNovels` | `true` | 是否同步小说收藏 |
| `pageSize` | `{illust:48, novel:24}` | 每页条数 |
| `maxPagesPerRun` | `0` | 每条通道每次最多抓几页，0 为不限 |
| `output.*` | 见上文四条通道 | 四个输出文件路径 |
| `downloadImages` | `false` | 预留开关 |

## 关于图片下载

按约定这轮只做元数据，`--download` 和 `downloadImages` 都是占位，运行时会明确提示
"尚未实现"。图片目录 `images/` 已经写进 `.gitignore` 预留位置。

## 自测

```bash
npm run selftest
```

覆盖纯数据逻辑：序列化往返幂等、转义（换行/引号/反斜杠/全角空格）、标签 CSV 规则、
差分的空值归一化、seq 分配与排序、取消标记与重新收藏、安全阀、旧数据迁移保护。
网络和真实接口不在这里测。

## 已知限制

- 依赖网页端 `www.pixiv.net/ajax/*` 接口，属非官方接口，Pixiv 改动时可能失效。
- 拿不到收藏时间戳，`seq` 由翻页顺序推断，只有完整全量同步才能保证编号准确。
- 只能读到"当前仍在收藏夹里"的作品；一旦取消收藏且没及时同步，就无法追回。
- 公开与私密是两个独立序列，各自的 `seq=1` 不是同一个时间点，无法跨文件比较先后。

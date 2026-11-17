# pixiv-export

把 Pixiv 账号里的收藏（插画/漫画 + 小说）备份成本地纯文本，用 Git 记录每一次变化。

只做元数据备份，不下载图片。

## 为什么是纯文本

收藏备份的核心价值不是"存下来"，而是"看得见变化"。所以存储格式选了每条记录一块
`key: value` 的纯文本，而不是 JSON 或 SQLite：

- 收藏一件新作品 → `git diff` 里就是新增的一个记录块，一眼看完
- 某个作品改了标题/标签 → 只有那一两行变色
- 取消收藏 → 整块删除，`git log -p` 随时能翻回来

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

# 3. 同步
node src/cli.mjs sync
```

### 怎么拿到 cookie

1. 浏览器登录 [pixiv.net](https://www.pixiv.net)
2. F12 打开开发者工具 → Application（应用）→ Cookies → `https://www.pixiv.net`
3. 复制 `PHPSESSID` 的值

cookie 会过期（通常几个月）。同步时报 `cookie 可能已失效`，重新复制一次即可。

`.secrets/` 和 `config.json` 都在 `.gitignore` 里，不会误提交。

## 命令

```bash
node src/cli.mjs sync              # 增量同步（日常用这个）
node src/cli.mjs sync --full       # 全量同步，能发现取消收藏和字段变更
node src/cli.mjs sync --dry-run    # 只看差异，不写文件
node src/cli.mjs status            # 本地备份概况
node src/cli.mjs check             # 检查代理和 cookie

node src/cli.mjs sync --illust-only
node src/cli.mjs sync --novel-only
node src/cli.mjs sync --max-pages 5
node src/cli.mjs sync --interval 3000
```

也可以 `npm run sync` / `npm run sync:full` / `npm run status`。

## 增量是怎么判断的

有一点必须先说清楚：**Pixiv 的收藏列表接口不返回收藏时间**，`bookmarkData` 里只有
`{ id, private }`。所以没法用时间戳做断点。

改用「整页是否都已知」判断：收藏列表按收藏时间倒序，从第一页往后翻，当连续两页的
作品 id 全都已经存在于本地文件时，就说明已经追平了 —— 再往后只会更旧。这样日常同步
通常只花 2~6 个请求。

所以两种模式的语义不同：

| 模式 | 行为 | 用途 |
| --- | --- | --- |
| `sync` | 只增不删，追平即停 | 每天/每周跑，成本极低 |
| `sync --full` | 翻完所有页，以服务端为准镜像 | 定期跑（比如每月），能发现取消收藏 |

取消收藏的记录会从文件里移除，但历史留在 `git log` 里，不会真正丢失。

## 请求节奏

相邻两次请求的发起间隔强制 >= `intervalMs`（默认 2000ms，配置里可以调高，但程序
拒绝低于 500ms）。所有请求串行排队，不做并发 —— 这里刻意用吞吐换可预测的行为。

按 2000ms 估：1000 条收藏约 21 页 ≈ 45 秒；5000 条 ≈ 3~4 分钟。全量同步更久，
终端会实时打印页码和预估剩余时间。

## 安全阀

`--full` 模式下如果拿到的条数不到本地的一半（且本地超过 10 条），程序会中止并且
**不写入文件**。这基本只会发生在一种情况：cookie 失效，接口返回空列表。没有这层
保护，一次失效就会把备份清空，然后被 git 记录下来。

## 文件格式

`data/bookmarks-illust.txt` 和 `data/bookmarks-novel.txt`：

```
# pixiv-export 收藏元数据备份
# 格式：每条记录为多行 key: value，记录之间用空行分隔
# 按作品 id 降序排列；first_seen 表示本程序首次发现该收藏的日期
# 记录数: 2

id: 120000003
type: manga
title: 标题
author: 作者名
author_id: 100
account: account_name
published: 2024-05-01T12:00:00+09:00
pages: 3
tags: 原创, 风景
x_restrict: 1
ai_type: 0
private_bookmark: no
first_seen: 2026-11-17
url: https://www.pixiv.net/artworks/120000003

id: 120000001
...
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `type` | `illust` / `manga` / `ugoira` / `novel` |
| `pages` | 插画的页数，小说的章节数 |
| `text_length` | 小说字数（仅小说） |
| `x_restrict` | 0 全年龄 / 1 R-18 / 2 R-18G |
| `private_bookmark` | 是否为非公开收藏 |
| `first_seen` | 本程序首次发现这条收藏的本地日期，不会随同步更新 |

想按标签、作者、日期筛选，直接用 Unix 工具就行：

```bash
grep -B4 'tags:.*原创' data/bookmarks-illust.txt
awk -F': ' '/^first_seen: 2026-11-17$/{print prev} {prev=$0}' data/bookmarks-illust.txt
```

### 关于收藏数/点赞数

`bookmark_count`、`like_count`、`view_count` 默认**不记录**。这些数字每天都在变，
记进来会让每次全量同步产生几千行噪声 diff，把真正有价值的变更（新收藏、标题改动）
淹没掉。真需要时加 `--stats`，或者配置 `includeVolatileStats: true`。

## 配置项

`config.json`（从 `config.example.json` 复制）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `proxy` | `http://127.0.0.1:7897` | 本地代理，Pixiv 直连不可用 |
| `intervalMs` | `2000` | 请求最小间隔 |
| `cookie` | `""` | 也可用 `.secrets/cookies.txt` 或环境变量 `PIXIV_COOKIE` |
| `userId` | `""` | 留空自动探测 |
| `includeNovels` | `true` | 是否同步小说收藏 |
| `includePrivateBookmarks` | `true` | 是否包含非公开收藏 |
| `pageSize` | `{illust:48, novel:24}` | 每页条数 |
| `maxPagesPerRun` | `0` | 每次最多抓几页，0 为不限 |
| `downloadImages` | `false` | 预留开关 |

## 关于图片下载

按约定这轮只做元数据，`--download` 和 `downloadImages` 都是占位，运行时会明确提示
"尚未实现"。图片目录 `images/` 已经写进 `.gitignore` 预留位置。

## 自测

```bash
npm run selftest
```

只覆盖纯数据逻辑：序列化往返幂等性、转义（标题含换行/反引号/冒号）、标签 CSV 规则、
差分正确性。网络和真实接口不在这里测。

## 已知限制

- 依赖网页端 `www.pixiv.net/ajax/*` 接口，属非官方接口，Pixiv 改动时可能失效。
- 拿不到收藏时间，`first_seen` 是本程序首次发现的日期，不等于你实际收藏的日期。
- 只能读到"当前仍在收藏夹里"的作品；一旦取消收藏且没及时同步，就没有追回的办法。
- 每个作品都要翻页获取，无法只拉"新增部分"的接口，所以增量也至少要 2~4 个请求。

# PLAN — 待实现清单

记录于 2026-11-27。这是 backlog，不是承诺；开工前先核对代码现状
（下面提到的行号会随改动漂移，按函数名/选择器找更靠谱）。

---

## 1. 随机顺序可以重新摇一次

**需求**：排序选「随机」时，给一个「换一批」入口，点一下换新的随机种子，整个列表重新洗牌。

**现状**
- `viewer/app.js:61` 在页面初始化时生成一次 `state.seed`；`:3817` 只在把排序切到 `random` 时重摇。
- 种子通过 `/api/records?seed=` 传给 `viewer/server.mjs:1358`，用 `mulberry32` 做 `seededShuffle`（`server.mjs:1007-1033`），所以同一 seed 翻页不会重复。

**要点**
- 按钮放在视图设置里排序分段旁边（`#optSort` 一带），仅 `settings.sort === 'random'` 时可用；点击 = 重摇 seed + `loadPage(true)` + 回到顶部。
- 服务端解析是 `Number(params.get('seed') ?? 1) || 1`，`0` 会被当成 1，新种子取 `1..1e9` 即可避开。
- 暂不做「把这次随机顺序记下来/分享」——项目没有路由层，塞 hash 成本不小，等真需要再说。

---

## 2. 快速通道不被限流暂停挡住

**需求**：处于 pacer 随机长休息（或普通队列排队）时，用户手动发起的非批量请求应当立刻完成。
**口径**：任何用户发起的非批量请求都算快速通道。

**现状**
- `src/http.mjs:54` 的 `run()` 把所有任务串在单条 `this.tail` 链上；`fast` 只是把「自己的」闸门缩短（`fastAllowedAt`），**但排队位置不变**。
- 前一个任务若正卡在 `pacer.gate() → waitOutPause()`（`src/pacer.mjs:176`），后进来的 fast 请求照样得等它睡完 —— 这就是现在「点了没反应」的根因。
- `bypassPacer` 只决定「它自己要不要等」，不影响它排在哪。

**要点**
- 方向 A（倾向）：fast 任务不挂 `tail`，直接执行。代价是可能出现两个请求同时在飞，
  `nextAllowedAt` / `fastAllowedAt` 的写入顺序要重新整理（单线程，注意「先算后写」即可，别读旧值算新值）。
  现有「快速通道也接力普通队列的间隔」这条设计描述要跟着改写。
- 方向 B：给 `waitOutPause()` 加中断信号，fast 请求一来就掐断当前 sleep。
  问题是一次掐断会把排在后面的普通请求一起放行，语义更脏，不推荐。
- 「用户请求默认快速」：在 `server.mjs` 建一个 `userRequest()` 包装（默认 `fast:true, bypassPacer:true`），
  让读接口（`/api/records`、`/api/tags`）、大图/阅读器翻页、`/api/bookmark/*` 统一走它，
  而不是每个端点各写一遍。
- 批量路径必须保持 `fast:false`：`startConversion()`（`server.mjs:363` 附近）、`src/download.mjs`、
  `src/sync.mjs`、`cli.mjs` 的批量命令。改的时候别顺手把 `imageLimiter` 也一起放宽了 —— 图片下载是后台负载。

---

## 3. 标签设置项可折叠

**需求**：标签面板的筛选框右边加一个按钮，点击显示/隐藏设置项（现在是「含作品标签」「只看标签组」两个开关）。

**现状**：`viewer/index.html:81-89`，`#sideQuery` 后面紧跟 `#tagIncludeWrap`、`#onlyGroupsWrap` 两个 `.side-toggle`；筛选框是作者/标签两个面板共用的。

**要点**
- `#sideQuery` 外面包一层 flex 行，按钮靠右（图标用齿轮或 ⋯），点击切 `settings.tagSettingsOpen`。
- 设置项存 `localStorage`（`DEFAULT_SETTINGS` 在 `app.js:11`，新键记得给默认值，否则老用户读到 `undefined`）。
- 默认收起还是展开要定一下；倾向默认收起 —— 但原先「含作品标签」是可见的，收起后别让人以为功能没了，按钮上加 `title`。
- 只对「标签」面板显示按钮；切到「作者」时藏起来（那两个开关本来就用 `hidden` 控制）。
- 折叠用 `hidden` 即可；切换后侧栏虚拟列表靠 `getBoundingClientRect()` 实测高度，会自行重算，不需要额外处理。

---

## 4. 可选隐藏「流行度标签」

**需求**：设置项里加一个开关，控制是否显示 `[标签名][数量]users入り` 这类 conventional 流行度标签（如 `100users入り`、`1000users入り`）。

**要点**
- 认法先取最保守的 `/^\d+\s*users入り$/i`（带数字版）。要不要连带认 `users入り`（无数字）和英文 `100users` 变体，实现时看自己库里实际有啥再定。
- 过滤放前端 `renderTags()` 之前，不动 `/api/tags` 的聚合 —— 面板数字仍是真实计数，只是少一行。
  若希望数字也跟着变，就得在 `server.mjs` 聚合阶段过滤，代价是搜索命中数、组计数口径都要一起改，慎重。
- 开关和其它设置项一起放进第 3 条的折叠区。

---

## 5. 评分标签改成数字按钮行

**需求**：把 `n/10` 从标签列表里移除；在标签面板上方（筛选框下方）放一排 1~10 数字按钮，可多选，多选视为逻辑或；这排按钮固定，不随标签列表滚动。

**现状**
- `n/10` 本质是收藏标签（`src/rating.mjs` 的 `parseRatingTag`），所以会混在 `/api/tags` 列表里；前端 `app.js:1721` 有一份同规则实现（格式必须两边一致）。
- 搜索语法里已经能直接写 `9/10`，编译逻辑在 `viewer/query.mjs`。

**要点**
- 列表过滤：`renderTags()` 里丢掉 `parseRatingTag(tag) !== null` 的行。计数口径（是否从 `/api/tags` 总数里扣掉）跟第 4 条同一个问题，两条一起定。
- 按钮行 DOM 放在筛选框（和折叠按钮）之下、`.side-list` 之上 —— 位置天然固定，不需要 `position: sticky`。
- 多选状态进 `settings`（数组序列化），参与 `buildQuery()`：单选 → `9/10`，多选 → `(7/10 OR 9/10)`，清空 → 不加条件。
- 与搜索框手写评分词同时存在时按 AND 叠加（现有编译逻辑天然如此），要不要去重/给提示，实现时再定。
- 按钮配色沿用 `ratingColor(value)`，选中态实心，10 分保留现在的发光效果。

---

## 6. 后端配置项全部暴露到前端（专用设置面板）

**需求**：后端所有可配置项都能在界面里改，专门加一个设置面板。
将来可能接 AI 翻译这类功能，需要在这里填 API Key、模型名称等。

**现状**
- 配置集中在 `config.json`（被 `.gitignore` 忽略），模板是 `config.example.json`。
  两份已经漂移：`config.json` 缺 `decayMs`、整个 `bookmarkTags` 段（代码里有默认值，能跑，但面板回显会看不出「默认值从哪来」）。
- `viewer/server.mjs:115` 的 `loadConfig()` **只在启动时读一次**，进程内没有任何写回路径。
- 另一套「配置」是前端 `localStorage` 里的 `settings`（排序、封面比例、卡片宽度、标签显示等，`app.js:11` 的 `DEFAULT_SETTINGS`）。
  这两套要分清：面板里建议分「服务端 / 界面偏好」两栏，别混成一个列表。

**要点**
- 接口：`GET /api/config` 回显，`POST /api/config` 落盘。
- **必须脱敏**：`cookie`、未来的 AI `apiKey` 只回「已设置 / 未设置」+ 末 4 位，不回明文；
  写回时如果前端提交的还是占位符，就保留原值，不能把密钥覆盖成 `••••`。
- **原子写**：临时文件 + `rename`，别写一半断电留个半截 JSON（`tag-groups.mjs` 里有现成的原子写写法可抄）。
- 字段白名单 + 校验：`pauseChance` 0~1、`avifQuality` 0~100、路径必须是项目内相对路径等；
  **未知字段原样保留** —— `_说明`、`_pacer说明` 这类手写注释不能被面板吞掉。
- 热生效范围要老实标，不能骗人：`pacer.*` 部分能即时改，`intervalMs` / `proxy` / `userId` 改了要**重建 client** 才生效。
  第一版建议就做「保存 + 提示重启查看器生效」，别搞半吊子热更新。
- 默认值收敛：现在服务端是散着 `??` 兜底（`intervalMs ?? 2000`、`download?.avifQuality ?? 50`…），
  面板要显示「未填时的实际值」就得自己再抄一遍 —— 顺手抽一份 `DEFAULT_CONFIG` 出来，和 `DEFAULT_PACER` 放一起。
- AI 翻译先占位：`ai: { provider, baseUrl, apiKey, model, targetLang }` 写进 `config.example.json` 当说明。
  Key 落 `config.json` 还是单独放 `.secrets/`（cookie 就在那儿），实现时定。
- 安全边界：服务只监听 `127.0.0.1`（`server.mjs:2171`），风险有限；但浏览器里任何页面都能打这个接口，
  写接口至少校验 `Origin` / `Sec-Fetch-Site` 同源，别让别处的网页偷偷改配置。

---

## 7. 收藏同步搬进前端

**需求**：把 `node src/cli.mjs sync` 能干的事做进查看器，界面上点一下就能同步收藏。

**现状**
- 完整流程在 `src/cli.mjs:457 commandSync`：
  `loadConfig → buildClient → makeGuard → assertAllowed → resolveUserId → buildChannels → syncKind(...) → syncTagsForChannel(...) → printSummary`。
- `buildChannels(config, flags)`（`cli.mjs:262`）和 `syncTagsForChannel`（`cli.mjs:377`）**没导出**，写死在 CLI 里。
  要么抽到 `src/channels.mjs` 共用，要么复制一份 —— 别复制，两份口径迟早分叉。
- 查看器已有长任务模板可抄：`startConversion()`（`server.mjs:319`）—— 串行跑、`state.convert` 快照、
  `stopRequested`、连续 3 次鉴权/限流错自动中止，前端轮询 `/api/stats` + 横幅进度条（`.banner-fill`）。

**要点**
- 接口：`POST /api/sync/start`（body `{ full, kinds[], skipTags }`）、`POST /api/sync/stop`、`/api/stats` 加 `sync` 快照。
- 同步结束必须**重载内存记录**：`state.records` 是启动时 `loadRecords()`（`server.mjs:194`）一次性读进来的，
  同步只改磁盘 JSON，不 reload 就会出现「同步了 300 条，界面还是旧的」。完事 `await loadRecords(); await refreshIndex();`，再让前端 `loadPage(true)`。
- 走**普通通道**：`fast:false`，每翻一页 `guard.bump({ requests: 1 })`（照 `commandSync` 的 `onProgress`）。
  这条和第 2 条正好相反，别被「用户点了个按钮」误导成快速通道 —— 同步是批量。
- 开跑前 `await guard.assertAllowed()`，命中禁令直接拒绝并提示（和现有「恢复运行」文案接上）。
- 进度要结构化：`printProgress` 是往 stdout 打的，前端需要事件（当前通道 / 已翻页 / 总页数 / 已写入条数），
  建议 `syncKind` 的 `onProgress` 事件带上 `kind/visibility/page/totalPages`，别去解析日志。
- 先做 dry-run：`syncKind` 已支持 `dryRun`，只算「将新增/移除/变更多少」不落盘，让人敢点第一次。
- 互斥：同步、下载、批量迁移抢同一份额度，`state.sync?.running` 时至少别让迁移同时开跑。
- 界面：入口按钮（右侧栏「下载管理」旁边或顶栏）+ 确认框（增量/全量，全量会重扫所有页，可能十几分钟）+ 结果汇总（各通道新增/移除/变更）。

---

## 8. 全量改名（pixiv-export → dollery / 色廊）

**需求**：把项目里所有还叫 `pixiv-export` 的地方统一改掉，含目录名。

**清单**（2026-11-27 实测，除 README 外每处各 1 次命中）

可以改（纯显示 / 元数据）：
- `package.json` 的 `bin` 键 `pixiv-export` → `dollery`。代价：`npm link` 过的旧命令失效，需重新 link 或留个别名。
- `src/cli.mjs:165` 的命令行横幅。
- 四个 `.bat` 第 9 行的 echo 抬头：`download` / `sync` / `sync-full` / `viewer`。
  **好消息**：5 个 bat 都是 `cd /d "%~dp0"` 起手，不依赖目录名，改目录不会崩。
- `src/selftest.mjs:105` 的临时目录前缀 `pixiv-export-test-`（纯内部，随意）。

**不能改**（数据格式签名，改了等于一次数据迁移）：
- `src/store.mjs:54` → `pixiv-export/2`
- `src/bookmark-tags.mjs:23` → `pixiv-export/tags/1`
- `src/guard.mjs:26` → `pixiv-export/guard/1`
- `viewer/_guard.mjs:12` → 同上 guard 签名（这是测试/探针文件，先确认用途再决定删不删）

真要统一口径，做法是「读的时候新旧都认、写的时候写新值」，跑一段时间再删旧分支 ——
**不要在改名这一轮顺手做**，单独立项。

**目录改名**：`pixiv-export/` → `dollery/`
- git 仓库跟着目录走，历史不用改；这是文件系统操作，不产生 commit。
- 我的记忆文件（`.workbuddy/memory/*.md`）里记的全是这个路径，改名后一起更新，免得下次自己找不到。
- 已确认工作区里没有别的东西依赖绝对路径（bat 用 `%~dp0`；`config.json` 里是相对路径）。
- Windows 上先关掉查看器和编辑器，目录被占用会改不动。

**不建议动**：`README.md` 里的 3 处（用户自己维护）、`data/` 里的内容（真实数据带签名）、git 历史。

**顺序建议**
1. 显示文案 + `bin` 一次改完（一个 commit，立刻能看到效果）。
2. 目录改名单独做（纯文件系统操作，不留 diff）。
3. 数据格式签名另开一轮：加双读 → 写新值 → 观察一段时间 → 删兼容。

---

## 9. 给源文件加 GPL 版权声明头

**为什么值得做**：不是「不写就没授权」，而是防止**单个文件被摘出去后失去许可语境**。
有人把 `viewer/server.mjs` 单独拷进自己项目，那文件自身没有任何许可信息，事后主张「我不知道是 GPL」就有空间。
顺带把 `GPL-3.0-or-later` 的「or later」写清楚 —— 这条目前只体现在 `package.json` 字段里。

**范围**（2026-11-27 实测）：`src/` 13 个 + `viewer/` 3 个 `.mjs`，共 16 个。
`viewer/_guard.mjs` 虽然在 `.gitignore` 里（调试探针，不在仓库），跳过；`.bat` 不必加。

**模板**（GPL 原文 `LICENSE` 末尾 "How to Apply These Terms" 给的写法）
```js
// Copyright (C) 2026 <作者名>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

**坑**
- `src/cli.mjs` 第 1 行是 `#!/usr/bin/env node`，声明必须插在 shebang **之后**，否则命令直接跑不起来。全仓唯一一个带 shebang 的文件。
- 现有文件顶部都有 `/** ... */` 模块说明，声明放最前面、空一行，别把说明挤掉或合并进去。
- 一次改 16 个文件会让 `git blame` 大面积指向这次提交；可把该提交写进 `.git-blame-ignore-revs`，GitHub 也认这个文件。
- 待定：版权行写 `Dwscdv3` 还是真名。

---

## 10. README 加免责声明 + 封号风险告知

**背景**：仓库已公开。抓取类工具公开后可能招来站点 ToS 层面的投诉；而「封号」是这个项目最真实的风险，
应该在显眼处讲清楚，而不是藏在配置说明里。等 README 定稿后再动笔。

**要写的内容**（草稿，措辞由用户定）
- **非官方**：与 pixiv / ピクシブ株式会社 无任何关联，未获其授权或认可。
- **自动化访问可能违反服务条款**，后果由使用者自行承担。
- **封号风险**（重点）：本项目会用自动化方式访问 pixiv。已内置的防护 —— 站内信巡检 + 「过度访问警告」检测 +
  每日下载额度、概率触发的随机长休息（pacer，默认平均每个请求多等约 5 秒）—— 只是**降低**触发概率，
  **不保证**不触发。账号风险永远是概率问题，不是「开了防护就安全」。
- **边界**：不做验证码 / 风控 / 付费内容的绕过；只处理**自己账号有权访问**的收藏；
  不要用于批量抓取他人内容或再分发作品。
- **免责**：作者与贡献者对账号受限、数据丢失、法律后果不承担责任。
  （与 `LICENSE` 里的 GPL 无担保条款一致，README 只是写人话版。）

**位置**：放在「这是什么」之后单独一节（`## 免责声明`），太靠后等于没写。

**顺带**：README 里还有 3 处 `pixiv-export`，改名那轮按约定没动，重写时一并处理。

---

## 命名（已定的记录，不是待办）

- **中文名：色廊**。取「画廊」之形，换「画」为「色」：读音结构保留，一秒说明这是看画的地方；
  「色」在中文指颜色、在日文兼「色气」，对 pixiv 这个语境是双重贴合。
- **Logo：直接用汉字「廊」**，不做图形化。
- **英文名：Dollery**。`doll`（人偶）+ `-llery`（场所后缀，同 gallery / jewellery），
  读作 DAH-ler-ee，同时带着「玩偶陈列室」和「画廊」两层意思。
- **查证（2026-11-27）**：
  - npm 精确包名 `dollery` → 404，未发布；搜索命中 0。
  - GitHub 仓库名/描述含 dollery → 0 个。
  - `dollery.com` 属于 The Dollery（美国马萨诸塞州 Whitman 的一家高端人偶店，44 年历史）。
    撞的是实体商号，不是软件项目；本地使用无影响，`Dollery` 本身是英语姓氏，对方不独占该词。
  - 预留后路：真要发布到「人偶/玩具」领域才算擦边；需要独立拼写时用 `Dollerie`（法语 -erie）。
- **中英分工**：界面标题「色廊」/ 副标题 `Dollery` / 目录名与包名 `dollery`。不做音译。
- **已落地（2026-11-27）**：`package.json` 的 `name` 改为 `dollery`；`index.html` 的 `<title>` 改为「色廊 · Dollery」。
- **未动**：仓库目录名（仍是 `pixiv-export/`）、`package.json` 的 `bin` 键（仍是 `pixiv-export`，
  怕影响已 link 到全局的命令）、三个 `.bat`、查看器顶栏文案。
- **开源范围**：已开源 —— <https://github.com/Dwscdv3/Dollery>，许可证 `GPL-3.0-or-later`（全文见 `LICENSE`）。
  名称冲突已知情接受：`Dollery` 与那家人偶店重名，真收到异议再改名（见第 8 条）。
- **注意**：`package.json` 的 `private: true` 保留，它只用来挡住误 `npm publish`，不表示「不公开」。

---

## 通用注意

- 改前端记得同步 `index.html` 里的 `app.js?v=` / `style.css?v=`。
- 改 `viewer/server.mjs` 或 `src/*` 要重启查看器。
- 第 6、7 条都会动 `config.json` 的结构，`config.example.json` 要跟着更新（那是给人抄的模板）。
- README 由用户自己维护，这几条落地后要不要写进去，先问。

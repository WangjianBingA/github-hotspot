# GitHub 好玩榜 — 设计文档

- 日期：2026-10-10
- 状态：待评审（评审通过后进入实现计划）
- 项目目录：`F:\deep seek的实验室\github-hotspot\`

---

## 1. 背景与目标

### 1.1 为什么要做这个项目

真实目的有主次两层，实现时的取舍都以此为准：

1. **主目的**：完成一个能拿得出手的作品集项目，用来证明"能驱动 AI Agent 完整交付一个项目"。
   因此除功能外，代码结构、测试、文档、截图、一键演示都算交付物。
2. **次目的**：做一个自己每天真的会打开看的工具。

### 1.2 目标用户（这条决定了后面所有文案和取舍）

**纯新手**：非计算机专业的学生、想玩玩 GitHub 项目的年轻人、连 star 是什么都不知道但愿意尝试的人。

现有所有同类工具都假设用户"已经会玩 GitHub"。本项目面向的是**还没入门的人**。

### 1.3 一句话定位

> 别人告诉你"今天 GitHub 上什么火"；
> 我们告诉你"**今天什么火、口碑好、而且你现在就能在你这台电脑上跑起来，还有中文说明**"。

### 1.4 成功标准（可验证，不是形容词）

- [ ] 一条命令 `npm start` 能在本机打开网页界面，看到三个榜单
- [ ] 每个上榜项目都带"🟢🟡🔴 难度徽章"和"是否有中文说明"
- [ ] 每个上榜项目都能给出一条**已核实存在**的安装命令或下载链接
- [ ] 断网状态下 `npm run demo` 仍能完整演示界面（内置离线数据）
- [ ] `npm test` 全绿，且评分逻辑有逐项断言的单测
- [ ] 中文使用手册能让一个没接触过命令行的人跑起来

---

## 2. 调研结论：为什么这么做

### 2.1 赛道现状（实测数据）

| 类别 | 代表项目 | 规模 | 做了什么 | 没做什么 |
|---|---|---|---|---|
| 搬运工 | bonfy/github-trending、SnailDev/github-hot-hub、antonkomarev/github-trending-archive、isboyjc/github-trending-api、git-trends.github.io、vitalets/github-trending-repos | 数十至 3000+ 星 | 抓 trending 页，按天归档为 Markdown/JSON/RSS | **没有一家自己计算涨星速度**；无口碑维度；无 Windows 运行指导；无中文说明 |
| 星史分析 | star-history(9570★)、daily-stars-explorer、SimRepo、StarTrack-js | 数百至近万星 | 画 star 历史曲线 | 都要用户自己填仓库名，不做"发现"；多依赖自有后端或 token |
| 中文策展 | HelloGitHub(18.1万★)、GitHubDaily(4.8万★)、阮一峰周刊(10.6万★) | 十万级 | 人工编辑，月刊/日更，质量高 | **完全不写安装方式**；不标有无中文文档；不标难度与依赖；纯人工，不可自动 |
| 重型平台 | pingcap/ossinsight(2508★) | 2508★ | TiDB + GH Archive 百亿事件做趋势分析 | 需 TiDB 集群 + ETL，普通 Windows 跑不起来；且其当日星标榜已停摆（见 2.2） |

### 2.2 两条决定性情报

1. **"涨星速度"是行业公认的难点。** ossinsight 源码 `apps/web/lib/data-quality.ts` 自己承认：GitHub 自 2026-03 起全局事件流分页塌陷，WatchEvent 从约 222 万/月跌到 6.9 万/月（约 baseline 的 0.3%），**他们已主动暂停所有按星标事件排序的榜单**。
   → 结论：谁能自持一份历史数据，谁才站得住。
2. **"能不能在用户电脑上跑起来"是明确真空。** 18 万星的 HelloGitHub 和 4.8 万星的 GitHubDaily 都不写安装步骤，四个 trending 搬运工都不标可运行性，ossinsight 完全不考虑。
   → 结论：这就是本项目的差异位，也是护城河。

### 2.3 因此我们做什么、不做什么

**做**：三轴筛选（热度 / 口碑 / **可落地性**）+ 新手语言 + 本地应用商店式界面 + 保姆级中文安装向导。

**不做**：第 N 个 trending 搬运工。README 第一段必须讲清与上述项目的区别 —— 这是作品集最被看重的一点。

---

## 3. 已实测的技术事实（设计约束，全部亲自验证过）

| # | 事实 | 对设计的影响 |
|---|---|---|
| 1 | PowerShell `Invoke-WebRequest` 访问 GitHub 失败；Node 内置 `fetch` 正常（api.github.com / github.com / raw.githubusercontent.com 均 200） | **后端用 Node** |
| 2 | Node v24.21.0 内置 `node:sqlite` 的 `DatabaseSync` 可用 | 存储**零依赖** |
| 3 | `schtasks` 可用 | 可注册每日自动采集 |
| 4 | 未认证额度：core **60/小时**、search **10/分钟**；额度耗尽返回 403 且带 `x-ratelimit-reset` | 候选池必须小 + 缓存 + 预算上限 + reset 感知 |
| 5 | **`winget` 在本机实际不可用**（exit -1978335231，`winget source list` 也失败） | **放弃 winget 探测**，改用 registry 直查 |
| 6 | `github.com/trending` HTML 自带 "N stars today" / "stars this week" | 这是免 token 的**可信热度锚点**（GitHub 自己渲染的） |
| 7 | search API 一次请求即可拿总榜：`stars:>100000&sort=stars&order=desc&per_page=30` → 实测 30 条齐全，`incomplete_results: false` | 经典榜成本极低，1 次请求 |
| 8 | search `created:>7天前 stars:>200` → 实测 99 个新项目候选（榜首一周 13119 星） | 新项目飙升**精确可算**（star 总数即 7 日增量） |
| 9 | search **查不出**"老项目突然爆火"（按 stars 排序只会返回常青树） | 老项目爆火只能靠 trending 页 + Events 发现 |
| 10 | `/repos/{r}/events` 的 WatchEvent 目前可用（实测 markitdown 12.6 小时内 86 次） | 可作为**辅助**信号，但因其上游正在退化，不可作为唯一支柱 |
| 11 | npm registry packument 直接含 `bin` 与 `os` 字段（实测 `opencode-ai`: `bin` 存在、`os` 含 `win32`） | 一个请求即可证明"能 npx 跑且支持 Windows" |
| 12 | PyPI JSON API 含 `requires_python`（实测 markitdown: `>=3.10`） | 可与本机 Python 3.10 直接比对兼容性 |
| 13 | npm 上存在**同名不同作者**的包（搜 `markitdown` 命中 `dead8309/markitdown-ts`） | **必须核对 `repository.url`**，否则会引导用户装错包 |
| 14 | 仓库分支名不可假设：`microsoft/markitdown` 的 `main`/`master` 对 `pyproject.toml` 均 404 | 一律先读 API 的 `default_branch` |
| 15 | 4 个并发抓取任务直接把 `github.com` 打到连接超时 | 采集器**严格串行** + 指数退避 |
| 16 | 本机已有：winget(不可用)、npm、pip(Python 3.10)、git、VS Code；**没有** Docker / scoop / choco / pnpm | 可落地性判定只认 npm / pip / release 资产三类 |

### 3.1 待验证的开放项（带决策规则）

**开放项 O1**：据调研，GitHub 于 2026-09-04 上线新端点
`GET /repos/{owner}/{repo}/stargazers/history`（需请求头 `X-GitHub-Api-Version: 2026-03-10`），
按周分桶返回每日星标增量，未认证可用，单仓库成本与仓库年龄成正比（约每 30 周 1 次请求）。

- **验证方式**：额度恢复后实测（后台任务 `pwsh-129`），检查状态码与响应结构。
- **若成立（决策 A）**：作为"飙升分"的**主路径**，可得精确的 7 日新增收藏数；新项目通常只需 1 次请求，成本极低。
- **若不成立（决策 B）**：走 §7.2 的备选阶梯（新项目 star 总数 → trending `recent_stars` → 自建快照差值 → Events 外推）。
- **两种决策下代码结构不变**：数据获取统一走 `sources/star-velocity.mjs` 的接口，内部按可用性逐级降级，并输出 `confidence` 字段。

> 这条设计成"能力探测 + 自动降级"而非硬编码，正是为了留出改进空间。

---

## 4. 产品设计

### 4.1 三个榜单

| # | 榜单 | 更新频率 | 条数 | 排序依据 | 对用户的意义 |
|---|---|---|---|---|---|
| 1 | **🔥 本周飙升** | 每天 | 15 | 三轴总分（热度 45 + 口碑 30 + 可落地 25） | "最近大家在玩什么" |
| 2 | **🌟 新手能玩** | 每天 | 15 | 可落地分优先（门槛过滤后） | "**哪些我真能装上**" ← 差异化核心 |
| 3 | **🏆 经典必玩** | 每周/每月 | 30 | 全站收藏总数 Top 30（不参与三轴评分） | 给新人补课：GitHub 上早就有这些好东西 |

**经典榜的"补课"设计**（因它每天不变，所以价值在内容组织而非新鲜度）：
- 按用途分组：学习路线 / 免费电子书 / 实用工具 / 资源清单
- 每条加一句"它解决了什么问题"
- 诚实标注"最后更新时间"，停更的要说明

### 4.2 难度分级（卡片上最重要的徽章）

按优先级取第一条命中的规则，结果确定且可单测：

| 等级 | 判定条件 | 界面文案 |
|---|---|---|
| 🟢 一键就能玩 | release 资产含 Windows `.exe/.msi`；或 npm `bin` 存在且 `os` 含 `win32` | "下载就能用" |
| 🟡 要几步 | PyPI 有包且 `requires_python` 兼容本机 Python 3.10；或需先装 Node/Python | "跟着 3 步走就行" |
| 🔴 要懂点技术 | 需编译 / 需 API Key / 需显卡 / 仅有 Docker | "需要一点技术基础" |

**电脑预检**：打开安装向导时先检查本机 Node / Python 是否存在及版本，直接告诉用户"你缺什么"。对小白是杀手级功能，实现成本低。

### 4.3 术语翻译表（界面上不出现行话）

| 行话 | 界面显示 |
|---|---|
| star / 收藏数 | "有多少人收藏" |
| fork | "有多少人拿去改造" |
| issue 关闭率 | "作者管不管事"（只给结论，不露数字） |
| 7 日涨星速度 | "本周新增收藏 1,234" |
| 可落地性评分 | "🟢 一键就能玩" |
| archived | "作者已停止维护" |

### 4.4 卡片与详情页

**卡片**：项目名（原名 + 可选中文说明）、大白话一句话"它能帮你做什么"、难度徽章、中文徽章、**本周新增收藏**、**近 3 日新增（有日线数据时才显示）**、总收藏、两个按钮（`看看怎么装` / `打开项目主页`）。

> 3 日与 7 日两个窗口都保留：7 日用于排序，3 日用于卡片上体现"最近三天突然加速"。

**详情页（抽屉或独立页）**：
- "它是什么 / 能帮你做什么"（由 repo description + topics 生成，不做 LLM 生成）
- **为什么上榜**：三个分轴的得分条 + 中文理由（可解释性是本项目刻意保留的工程点）
- 安装向导（见 4.5）
- 项目基本事实：语言、总收藏、最后更新、许可证、主页
- 数据置信度标注：涨星数据是"实测"还是"估算"

### 4.5 安装向导（核心体验，三步走）

```
第 1 步 · 检查你的电脑     ✅ 已装 Node v24    ❌ 没装 Python
第 2 步 · 复制这一行，粘到黑框里回车
        ┌──────────────────────────┐ [一键复制]
        │ npx markitdown-cli       │
        └──────────────────────────┘
第 3 步 · 怎么用：把 PDF 拖进去就行 …   [常见问题]
──────────────────────────────────────────────
⚙️ 实验功能：让我帮你装（默认关闭，需手动开启）
```

第 3 步的使用说明来自确定性的模板（按安装方式分类），不依赖大模型。

### 4.6 界面结构

- 顶部三个榜签 + 筛选条：`🟢 一键就能玩` / `🈶 有中文说明` / 语言 / 最低热度
- 中部卡片列表（虚拟滚动不必做；**条数固定：本周飙升 15 条、新手能玩 15 条、经典必玩 30 条**）
- 右侧抽屉：详情与安装向导
- 底部：历史日期选择器（回看过去某天的榜）
- 设置页：实验开关、"关于评分口径"（把公式摊开给用户看）

---

## 5. 系统架构

### 5.1 技术栈：零运行时依赖

| 用途 | 选择 | 理由 |
|---|---|---|
| 网络 | 内置 `fetch` | 实测只有它通 |
| 存储 | 内置 `node:sqlite` | 实测可用，免装库 |
| 后端 | 内置 `node:http` | 本地单人使用 |
| 前端 | 原生 HTML/CSS/JS | 无构建步骤，改完刷新即生效 |
| 测试 | 内置 `node:test` | 零依赖 |
| 定时 | `schtasks` | 实测可用（可选启用） |

代价：HTTP 路由需手写（约 150 行）。收益：无依赖树、无供应链风险、无 `node_modules`，也是个可讲的技术点。

### 5.2 目录结构

```
github-hotspot/
  package.json                 # 无 dependencies，只有 scripts
  src/
    cli.mjs                    # collect | serve | export | schedule | demo
    config/
      weights.mjs              # 评分权重（可覆盖）★扩展点
      boards.mjs               # 榜单定义（可增删）★扩展点
    sources/                   # 统一接口：discover() / enrich(repo) ★扩展点
      trending.mjs             # 抓 github.com/trending HTML（0 API 成本）
      search.mjs               # search API：总榜 / 新项目 / 活跃老项目
      star-velocity.mjs        # 涨星速度：多级降级 + confidence
      events.mjs               # WatchEvent 外推（辅助）
      releases.mjs             # release 资产（找 Windows 包）
      registry.mjs             # npm / PyPI registry 直查（0 API 成本）
      hn.mjs                   # HN Algolia 口碑提及（0 API 成本）
    enrich/
      readme.mjs               # 中文文档检测
      runnability.mjs          # 难度分级 + 安装命令生成
      health.mjs               # 口碑分计算
    score/
      score.mjs                # 纯函数，无 IO ★核心可测单元
      reasons.mjs              # 生成"为什么上榜"的中文理由
    store/
      db.mjs                   # node:sqlite 连接与迁移
      snapshot.mjs             # 每日快照写入与查询
      cache.mjs                # 带 TTL 的响应缓存
    net/
      client.mjs               # 串行队列 + 超时 + 重试退避 + 额度感知
    http/
      server.mjs  routes.mjs
    exec/
      runner.mjs               # 实验执行器（默认关闭）
      whitelist.mjs
    exporters/
      markdown.mjs  json.mjs  rss.mjs   # ★扩展点
  public/                      # index.html app.js style.css
  data/hotspot.db              # SQLite（gitignore）
  daily/YYYY-MM-DD.md|.json    # 日报
  fixtures/                    # 离线演示数据 + 测试样本
  test/*.test.mjs
  docs/使用手册.md
  README.md
```

### 5.3 数据流

```
采集（每天 1 次，或手动 npm run collect）
 ① 发现候选
     ├─ search: created:>7d stars:>200        新项目（飙升精确）
     ├─ search: pushed:>7d stars:>500         活跃老项目（热度待算）
     ├─ trending HTML (daily/weekly)          可信锚点（0 API 成本）
     └─ 昨日榜中仍在涨的                        连续性
 ② 硬性门槛过滤（§6.2）→ 得到 S 级 / A 级候选
 ③ 富化（严格串行，受额度预算约束）
     repo 详情 / release 资产 / README 中文检测 / npm·PyPI 直查 / HN 提及
 ④ 涨星速度（sources/star-velocity.mjs 多级降级）→ 带 confidence
 ⑤ 评分（纯函数）→ 三轴得分 + 中文理由
 ⑥ 落库：repos / snapshots / star_history / scores / rankings / runnability
 ⑦ 导出：daily/YYYY-MM-DD.md + .json（+ 可选 RSS）
 ⑧ 记录 runs 表：本轮消耗了多少次 API

经典榜：单独低频任务（1 次 search + 少量富化），结果缓存
服务：npm start → 读 SQLite → 渲染
```

### 5.4 数据模型（SQLite）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `repos` | `owner_repo PK, license, stars, forks, open_issues, closed_issues, created_at, pushed_at, archived, default_branch, language, updated_at` | 仓库事实，带 24h 缓存 |
| `snapshots` | `owner_repo, date, stars, forks` (PK: 前两者) | **自持历史，是护城河** |
| `star_history` | `owner_repo, date, cumulative` | 来自 history 端点（若可用） |
| `scores` | `owner_repo, date, hot, reputation, runnable, total, grade, confidence, reasons_json` | 每一分可追溯 |
| `rankings` | `date, board, rank, owner_repo, score` | board ∈ weekly / newbie / classic |
| `runnability` | `owner_repo, kind, command, download_url, evidence, verified, difficulty, chinese_doc, notes` | **安装引导的唯一来源** |
| `cache` | `key PK, body, etag, expires_at` | 额度保护 |
| `runs` | `id, started_at, finished_at, api_calls, status, notes` | 可观测性 |

### 5.5 额度预算（未认证 60/小时的硬约束）

- 每轮采集**预算上限 45 次 core 请求**，超出即停止富化，剩余候选顺延到下一轮（写入 runs 记录）
- 24h 缓存：已富化过的仓库不重复请求，稳态下每轮只需为**新出现的**候选付费
- 经典榜每周/每月才刷新 1 次
- 遇到 403：读 `x-ratelimit-reset`，若等待时间可接受则休眠重试，否则降级为"只用缓存出榜"并在界面标注"本期数据不完整"
- 可选增强：若环境变量存在 `GITHUB_TOKEN`，额度升至 5000/小时，自动放宽候选池（**不配置也完全可用**）
- 省额度技巧（留作改进）：release 资产可从 API 降级为抓 `/releases/latest` HTML，省下每候选 1 次请求（解析更脆弱，默认不用）

---

## 6. 评分体系（周榜，满分 100）

### 6.1 三轴权重

| 轴 | 分值 | 子项 |
|---|---|---|
| **热度** | 45 | 7 日新增收藏数，`log10` 归一化（避免超大仓库碾压小项目）：`45 × min(1, log10(1+v) / log10(1+3000))` |
| **口碑** | 30 | fork/star 比 6 + issue 处理率 8 + 近期提交活跃 6 + 近 90 天有发版 4 + 许可证齐全 3 + 快照期收藏持续增长 3 |

**口碑子项的确定性口径**（全部只用已获取字段，无需额外请求，可单测）：

| 子项 | 计算方式 | 满分条件 |
|---|---|---|
| fork/star 比 | `forks / stars` | ≥ 0.15 |
| issue 处理率 | `closed_issues / (closed_issues + open_issues)` | ≥ 0.8 |
| 近期提交活跃 | `pushed_at` 距今天数 | ≤ 2 天满分，≤ 7 天得 4 分 |
| 近 90 天有发版 | `pushed_at` 与最新 release 时间 | 有发版满分 |
| 许可证齐全 | `license.spdx_id` 存在且非 `NOASSERTION` | 存在满分 |
| 收藏持续增长 | `snapshots` 表相邻两期差值 > 0 | 有增长满分（数据不足时按中性分计，不惩罚新项目） |
| **可落地** | 25 | 安装路径 0-18 + 中文文档 0-7 |

**安装路径分档**：release 有 Windows 资产 18 / npm `bin`+`win32` 16 / PyPI 且版本兼容 14 / npm 无 `bin` 8 / 需自行编译 6 / 仅 Docker 4。

**中文文档分**：README 中日韩字符占比 ≥ 3% → 4 分；另存在 `README.zh-CN.md` / `README_CN.md` / `docs/*.zh*` → 再 +3 分。
（实测校准：HelloGitHub 5.35% 命中；markitdown 0% 正确排除；opencode 0.26% 但靠 `README.ja.md` 正确识别为"有本地化文档"。）

### 6.2 硬性门槛（挡住刷榜与不可用项目）

进入"本周飙升"与"新手能玩"必须同时满足：

- 未 archived
- 有 LICENSE
- 近 7 天有提交
- 总收藏 ≥ 200
- **至少一条已核实的安装路径**（registry / release 资产双重证据）
- 非纯资源清单类（`awesome-*` 这类 Markdown 清单无可安装软件，只进经典榜）

### 6.3 "为什么上榜"的可解释输出

每个分数都落库并在界面展示，例如：
> 本周新增 1,234 人收藏（实测）· 作者近 7 天仍在更新 · 有 Windows 安装包 · 有中文说明

**这是刻意的设计选择**：评分可复现、可单测、可追溯，不引入大模型（用户明确选择"纯确定性规则引擎、零密钥"）。

### 6.4 纯资源清单的识别

语言为空或为 Markdown、且无任何安装路径证据 → 判定为清单类，排除出"新手能玩"榜。

---

## 7. 涨星速度的获取策略（技术命门）

### 7.1 为什么这是命门

GitHub 不提供 star 历史，`/stargazers` 列表端点自 2026-06-30 起对非管理员关闭，全局事件流自 2026-03 起退化到 baseline 的 0.3%。行业里能做好这件事的都在自持数据。

### 7.2 多级降级阶梯（统一接口，输出 `confidence`）

| 级别 | 方法 | confidence | 成本 | 适用 |
|---|---|---|---|---|
| 0 | `stargazers/history` 端点（**待验证 O1**） | `measured` | 新仓库 1 次 / 老仓库 每 30 周 1 次 | 若可用则优先 |
| 1 | 新项目：总收藏数即 7 日增量（`created ≤ 7d`） | `measured` | 已在候选发现时拿到，0 额外成本 | 所有 7 天内新建项目 |
| 2 | trending HTML 的 `recent_stars` | `reported` | **0 API 成本** | 恰在 trending 页上的项目 |
| 3 | 自建快照差值（`snapshots` 表，需 ≥ 2 天数据） | `measured` | 0 | 连续追踪的项目，第 3 天起 |
| 4 | `/repos/{r}/events` 的 WatchEvent 速率外推 | `estimated` | 1 次 | 兜底 |

**关键机制**：`snapshots` 表每天累积，**第 8 天起级别 3 可用**，历史外推值自动被真实差值替换，`confidence` 随之升级。这既是准确性保障，也是"越用越准"的产品故事。

### 7.3 界面必须诚实

估算值在界面上明确标注（"约 +1,234（估算）"），实测值标"实测"。**不把估算当事实展示** —— 这是本项目对可信度的底线。

---

## 8. 错误处理与容错

| 场景 | 处理 |
|---|---|
| 网络超时（实测发生过） | 20s 超时，最多 3 次重试，指数退避 1s/2s/4s |
| 403 且额度耗尽 | 读 `x-ratelimit-reset`；可接受则休眠重试，否则降级为纯缓存出榜并标注"数据不完整" |
| 并发导致自限流（实测发生过） | **全局串行队列**，同一域名同一时刻只允许 1 个在途请求 |
| HTML 解析失败（trending 改版） | 解析器独立成模块，用固定 fixture 做回归测试；失败时该数据源降级，不致命 |
| 单个候选富化失败 | 跳过该候选并记入 runs，不中断整轮 |
| 幂等 | 同一日期重复运行不产生重复记录（`INSERT OR REPLACE`），沿用同类项目 antonkomarev 的"每天只落一次盘"经验 |
| 抓取失败存档 | 保留最后成功响应到 `fixtures/last-good/`，便于排查（借鉴同类项目失败截图存档的做法） |

---

## 9. 实验执行器（安全边界）

**默认关闭**，必须在设置页手动开启。开启后仍受四重限制：

1. **白名单命令**：只允许 `npm install -g` / `npx` / `pip install --user` 三类，参数经过校验
2. **隔离目录**：装在 `sandbox/<owner>__<repo>/`，不污染全局环境
3. **实时日志 + 一键中止**
4. **留下卸载记录**：明确告诉用户怎么删干净

未开启时，界面上只显示"复制命令"，**不做任何执行**。

---

## 10. 测试策略（`node:test`，零依赖）

| 层次 | 测什么 |
|---|---|
| 单元 | 评分纯函数（固定输入 → 逐项断言各分轴）、难度分级规则、中文检测、清单类识别 |
| 单元 | **包名校验**：`repository.url` 与目标仓库不符时必须拒绝（防装错包） |
| 单元 | trending HTML 解析（固定 fixture）、release 资产中 Windows 文件的识别 |
| 单元 | 额度退避：模拟 403 + reset 头，断言等待或降级行为 |
| 单元 | 执行器白名单：非白名单命令必须被拒绝 |
| 集成 | **离线端到端**：用 fixture 跑完整采集 → 断言榜单条数、门槛生效、日报与 JSON 生成正确 |
| 手工 | 打开界面，点完整流程（含安装向导） |

---

## 11. 交付物

1. 代码：零运行时依赖、有测试、关键处有注释
2. `docs/使用手册.md`：保姆级中文说明 —— 怎么跑起来、三个榜的口径、评分公式全文、难度分级含义、常见问题（网络不通 / 额度用完 / 没有 Windows 包怎么办 / 怎么卸载）
3. `README.md`：一张截图 + 30 秒跑起来 + **第一段就讲清与 §2.1 那批项目的区别**
4. `npm run demo`：内置离线数据，断网也能完整演示（面试现场不怕没网）
5. 本设计文档 + 后续实现计划

---

## 12. 明确不做（YAGNI）

- 不做用户账号、登录、云部署（纯本地）
- 不做 Docker 沙箱（本机没有 Docker）
- 不接入大模型（用户明确选择纯确定性规则引擎）
- 不做消息推送 / 邮件 / 微信通知
- 不做应用市场式的细分类目（**只三个榜**）
- 不做多语言界面（先只有中文）
- 不自建 RSS 服务端（只生成静态文件）
- 不做移动端适配（桌面浏览器优先）

---

## 13. 留出的可改进空间（用户明确要求）

设计上刻意的松耦合点，后续扩展不需改核心：

| 扩展点 | 具体做法 |
|---|---|
| 榜单可增删 | `config/boards.mjs` 定义榜单，加榜不改核心逻辑 |
| 权重可调 | `config/weights.mjs`，用户可覆盖而不改代码 |
| 数据源可插拔 | `sources/*` 统一 `discover()` / `enrich()` 接口 |
| 涨星能力自动升级 | `star-velocity.mjs` 按可用性逐级降级，O1 端点一旦可用自动启用 |
| 额度可提升 | 检测到 `GITHUB_TOKEN` 自动放宽候选池 |
| 导出格式可扩展 | `exporters/` 加文件即可（已含 md/json，RSS 可选） |
| 执行器可升级 | 沙箱后端可替换（未来装了 Docker 可切 Docker 隔离） |
| 界面可加功能 | 本地"我收藏的 / 我装过的"记录（纯本地，无账号） |
| 类目可细分 | 等"新手能玩"榜跑通积累数据后，再考虑细分品类 |
| 定时可开关 | `schtasks` 注册为可选命令，不强制 |

---

## 14. 里程碑拆分

| 里程碑 | 内容 | 完成标志 |
|---|---|---|
| M1 | 骨架 + SQLite 存储 + 评分纯函数 + 单测 | `npm test` 通过，能对 fixture 算出榜单 JSON |
| M2 | 采集器（trending / search / 富化 / 缓存 / 额度控制 / 降级） | 能生成真实日报 `daily/*.md` |
| M3 | Web 界面（三榜 + 卡片 + 筛选 + 详情抽屉） | 浏览器里能看榜、能筛选 |
| M4 | 难度分级 + 电脑预检 + 中文检测 + 安装向导 | 每个项目都有已核实的安装引导 |
| M5 | 实验执行器（默认关闭） | 白名单与中止行为有测试覆盖 |
| M6 | 文档 + 离线 demo + 截图 | 断网可演示，说明书可让新手跑起来 |

---

## 15. 开放问题清单

| 编号 | 问题 | 处理 |
|---|---|---|
| O1 | `stargazers/history` 端点是否真的未认证可用 | 后台任务 `pwsh-129` 实测中；结果决定 §7.2 走级别 0 还是级别 1 起步（代码结构不变） |
| O2 | 经典榜的分组标签是否需要人工维护 | 先用 topics 自动归类，不足再手工补充 |
| O3 | 是否注册 Windows 计划任务 | M6 后由用户决定 |

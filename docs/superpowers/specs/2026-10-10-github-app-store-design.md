# GitHub 好玩榜 — 设计文档（v2 · 静态网站版）

- 日期：2026-10-10
- 版本：**v2**（v1 为"本地程序 + 浏览器界面"，v2 按用户决定改为"可发布到网上的静态网站"）
- 状态：待评审（评审通过后按实现计划施工）
- 项目目录：`F:\deep seek的实验室\github-hotspot\`

## 修订记录

| 版本 | 变更 | 原因 |
|---|---|---|
| v1 | 本地程序 + 浏览器界面，含 SQLite 存储与本地安装执行器 | 初始设计 |
| **v2** | ① 产出物改为**静态网站**（采集程序输出 JSON，网站读 JSON）；② **移除 SQLite**，历史数据改为仓库里的 JSON 文件；③ **移除本地安装执行器**（浏览器无法在用户机器上执行操作）；④ 难度分级口径从"你的电脑能不能跑"改为"**这个项目对新手友不友好**"；⑤ 部署方案预留但不阻塞施工 | 用户明确要求"能发布到网上的网站" |

---

## 1. 背景与目标

### 1.1 为什么要做这个项目

1. **主目的**：完成一个能拿得出手的作品集项目，用来证明"能驱动 AI Agent 完整交付一个项目"。因此代码结构、测试、文档、可分享的线上地址都算交付物。
2. **次目的**：做一个自己真的会看的工具。

### 1.2 目标用户

**纯新手**：非计算机专业的学生、想玩玩 GitHub 项目的年轻人、连 star 是什么都不知道但愿意尝试的人。
现有同类工具都假设用户"已经会玩 GitHub"，本项目服务的是**还没入门的人**。

### 1.3 一句话定位

> 别人告诉你"今天 GitHub 上什么火"；
> 我们告诉你"**今天什么火、口碑好、而且有保姆级中文教程能让你真的玩起来**"。

### 1.4 成功标准（可验证）

- [ ] `npm run collect` 能在本机生成当天的榜单 JSON，无网络时降级不崩
- [ ] `npm start` 能在本机浏览器打开网站，看到三个榜单
- [ ] 每个上榜项目都带"🟢🟡🔴 新手友好度"徽章与"是否有中文说明"标记
- [ ] 每个上榜项目都能给出一条**已核实存在**的安装命令或下载链接
- [ ] `npm test` 全绿，评分逻辑有逐项断言的单测
- [ ] 网站是纯静态的：把 `public/` 目录丢到任何静态托管上都能跑（**这是"能发布到网上"的技术前提**）
- [ ] 中文使用手册能让一个没接触过命令行的人跑起来
- [ ] 每天的榜单以 JSON 文件提交进仓库，形成**公开可查的历史**

---

## 2. 调研结论：为什么这么做

### 2.1 赛道现状（实测数据）

| 类别 | 代表项目 | 规模 | 做了什么 | 没做什么 |
|---|---|---|---|---|
| 搬运工 | bonfy/github-trending、SnailDev/github-hot-hub、antonkomarev/github-trending-archive、isboyjc/github-trending-api、git-trends.github.io、vitalets/github-trending-repos | 数十至 3000+ 星 | 抓 trending 页，按天归档为 Markdown/JSON/RSS | **没有一家自己计算涨星速度**；无口碑维度；无新手友好度；无中文教程 |
| 星史分析 | star-history(9570★)、daily-stars-explorer、SimRepo、StarTrack-js | 数百至近万星 | 画 star 历史曲线 | 都要用户自己填仓库名，不做"发现"；多依赖自有后端或 token |
| 中文策展 | HelloGitHub(18.1万★)、GitHubDaily(4.8万★)、阮一峰周刊(10.6万★) | 十万级 | 人工编辑，月刊/日更，质量高 | **完全不写安装方式**；不标有无中文文档；不标难度；纯人工 |
| 重型平台 | pingcap/ossinsight(2508★) | 2508★ | TiDB + GH Archive 百亿事件 | 需 TiDB 集群 + ETL；且其当日星标榜已停摆（见 2.2） |

### 2.2 两条决定性情报

1. **"涨星速度"是公认难点。** ossinsight 源码 `apps/web/lib/data-quality.ts` 承认：GitHub 自 2026-03 起全局事件流分页塌陷，WatchEvent 从约 222 万/月跌到 6.9 万/月（约 baseline 的 0.3%），**他们已暂停所有按星标事件排序的榜单**。→ 谁能自持历史，谁才站得住。
2. **"新手能不能跑起来"是明确真空。** 18 万星的 HelloGitHub 与 4.8 万星的 GitHubDaily 都不写安装步骤，四个搬运工都不标友好度，ossinsight 完全不考虑。→ 这是本项目的差异位。

### 2.3 做什么、不做什么

**做**：三轴筛选（热度 / 口碑 / **新手友好度**）+ 小白语言 + 保姆级中文教程 + 纯静态可发布网站 + 公开可查的每日历史。

**不做**：第 N 个 trending 搬运工。README 第一段必须讲清与 §2.1 那批项目的区别。

---

## 3. 已实测的技术事实（设计约束）

| # | 事实 | 对设计的影响 |
|---|---|---|
| 1 | PowerShell `Invoke-WebRequest` 访问 GitHub 失败；Node 内置 `fetch` 正常（api.github.com / github.com / raw.githubusercontent.com 均 200） | 采集程序用 Node |
| 2 | Node v24.21.0；内置 `node:sqlite`、`node:test` 可用 | 零依赖可行（v2 已不需要 sqlite，见 §5） |
| 3 | 未认证额度 core **60/小时**、search **10/分钟**；403 带 `x-ratelimit-reset` | 本地开发要缓存 + 预算控制 |
| 4 | GitHub Actions 的 `GITHUB_TOKEN` 额度约 **1000 次/小时/仓库**（是未认证的 16 倍） | 未来上 Actions 后额度不再是瓶颈 |
| 5 | `winget` 在本机**实际不可用**（exit -1978335231，源列表也失败） | 放弃 winget 探测，改用 registry 直查 |
| 6 | `github.com/trending` HTML 自带 "N stars today" / "stars this week" | 免 token 的可信热度锚点（GitHub 自己渲染的） |
| 7 | search 一次请求即可拿总榜：`stars:>100000&sort=stars&order=desc&per_page=30` → 实测 30 条齐全、`incomplete_results: false` | 经典榜成本极低 |
| 8 | search `created:>7天前 stars:>200` → 实测 99 个新项目候选（榜首一周 13119 星） | 新项目飙升**精确可算** |
| 9 | search **查不出**"老项目突然爆火" | 老项目爆火只能靠 trending 页 + Events |
| 10 | `/repos/{r}/events` 的 WatchEvent 目前可用（实测 12.6 小时 86 次） | 可作辅助信号，但上游正在退化，不可当唯一支柱 |
| 11 | npm registry packument 含 `bin` 与 `os`（实测 `opencode-ai`：`bin` 存在、`os` 含 `win32`） | 一个请求即可证明"能 npx 跑且支持 Windows" |
| 12 | PyPI JSON API 含 `requires_python`（实测 markitdown：`>=3.10`） | 可判断版本要求 |
| 13 | npm 存在**同名不同作者**的包（搜 `markitdown` 命中 `dead8309/markitdown-ts`） | **必须核对 `repository.url`**，否则引导用户装错软件 |
| 14 | 分支名不可假设：`microsoft/markitdown` 的 `main`/`master` 对 `pyproject.toml` 均 404 | 一律先读 `default_branch` |
| 15 | 4 个并发抓取直接把 `github.com` 打到连接超时 | 采集**严格串行** + 指数退避 |
| 16 | `trending?since=weekly` 页面存在（含 "stars this week"） | 7 日窗口有官方锚点 |

### 3.1 待验证的开放项（带决策规则）

**开放项 O1 —— 已于 2026-10-10 实测结案（决策 A：端点可用）**：
`GET /repos/{owner}/{repo}/stargazers/history?per_page=30` 返回 `[{ week: <unix秒>, total: <累计>, days: [7 个日增量] }]`，
**未认证即可用**（实测 200），`X-GitHub-Api-Version: 2026-03-10` 请求头**非必需**（不带也 200），老仓库带 `Link rel="last"` 可翻页。
证据校验：`days` 七天之和与 `total` 完全一致（13150 = 5004+5546+1897+703）→ 是精确日线而非估算。
- **影响**：§7.2 的**级别 0 成为首选来源**，级别 1–4 降为兜底。
- **成本**：新仓库 1 次请求；老仓库约每 30 周 1 次请求（HelloGitHub 这类 9 年老库用 `per_page=30` 约 9 次）。

---

## 4. 产品设计

### 4.1 三个榜单

| # | 榜单 | 更新 | 条数 | 排序依据 | 对用户的意义 |
|---|---|---|---|---|---|
| 1 | **🔥 本周飙升** | 每天 | 15 | 三轴总分（热度 45 + 口碑 30 + 新手友好 25） | "最近大家在玩什么" |
| 2 | **🌟 新手能玩** | 每天 | 15 | 新手友好分优先（门槛过滤后） | "**哪些我真能装上**" ← 差异化核心 |
| 3 | **🏆 经典必玩** | 每周/每月 | 30 | 全站收藏 Top 30（不参与三轴评分） | 给新人补课：GitHub 上早就有这些好东西 |

**经典榜的"补课"设计**（它每天不变，价值在内容组织）：按用途分组（学习路线 / 免费电子书 / 实用工具 / 资源清单）、每条一句"它解决了什么问题"、诚实标注"最后更新时间"。

### 4.2 新手友好度分级（卡片上最重要的徽章）

按优先级取第一条命中的规则，结果确定且可单测：

| 等级 | 判定条件 | 界面文案 |
|---|---|---|
| 🟢 一键就能玩 | release 资产含 Windows `.exe/.msi`；或 npm `bin` 存在且 `os` 含 `win32` | "下载就能用" |
| 🟡 要几步 | PyPI 有包（版本要求已标注）；或需要先装 Node/Python | "跟着 3 步走就行" |
| 🔴 要懂点技术 | 需自行编译 / 需 API Key / 需显卡 / 仅有 Docker | "需要一点技术基础" |

> v2 说明：网站无法探测访客电脑，所以此分级完全基于**项目自身的客观事实**，对所有人一致、可复现。网站改为提供"**新手准备页**"：教你怎么打开命令行、怎么装 Node/Python、命令粘到哪里。

### 4.3 术语翻译表（界面上不出现行话）

| 行话 | 界面显示 |
|---|---|
| star / 收藏数 | "有多少人收藏" |
| fork | "有多少人拿去改造" |
| issue 关闭率 | "作者管不管事"（只给结论，不露数字） |
| 7 日涨星速度 | "本周新增收藏 1,234" |
| 新手友好分 | "🟢 一键就能玩" |
| archived | "作者已停止维护" |

### 4.4 卡片与详情

**卡片**：项目名、大白话一句话"它能帮你做什么"、难度徽章、中文徽章、**本周新增收藏**、**近 3 日新增（有日线数据时才显示）**、总收藏、"看看怎么装 / 打开项目主页"。

**详情**：它是什么 / 能帮你做什么 · **为什么上榜**（三轴得分条 + 中文理由）· 三步安装向导 · 项目基本事实（语言、总收藏、最后更新、许可证、主页）· 数据置信度（实测 / 估算）。

### 4.5 安装向导（三步走，纯引导）

```
第 1 步 · 你需要先准备什么     （按项目要求列出：需要 Node 18+ / 什么都不用装）
第 2 步 · 复制这一行，粘到命令行里回车
        ┌──────────────────────────┐ [一键复制]
        │ npx markitdown-cli       │
        └──────────────────────────┘
第 3 步 · 怎么用：把 PDF 拖进去就行 …   [常见问题]
```

第 1 步链接到"新手准备页"。使用说明来自确定性模板（按安装方式分类），不依赖大模型。
**v2 说明**：不再有任何"帮你安装"的能力（浏览器沙箱限制），也不再有实验开关。

### 4.6 界面结构

- 顶部三个榜签 + 筛选条（`🟢 一键就能玩` / `🈶 有中文说明` / 语言 / 最低热度）
- 卡片列表（条数固定：15 / 15 / 30，无需虚拟滚动）
- 点击卡片打开详情抽屉
- 底部日期选择器（回看历史上任意一天）
- "关于评分口径"页面（把公式摊开）

---

## 5. 系统架构

### 5.1 技术栈：零运行时依赖 + 纯静态前端

| 用途 | 选择 | 理由 |
|---|---|---|
| 网络 | Node 内置 `fetch` | 实测只有它通 |
| 数据存储 | **仓库里的 JSON 文件** | 免数据库；公开可查；Actions 里天然可持久化（v2 变更） |
| 采集程序 | Node ESM | 本地与 GitHub Actions 上都能跑 |
| 本地预览 | 内置 `node:http` 的极简静态服务器（约 40 行） | `file://` 打开会导致 fetch JSON 被浏览器拦，必须走 http |
| 前端 | 原生 HTML/CSS/JS，无构建 | 纯静态、可直接托管 |
| 测试 | 内置 `node:test` | 零依赖 |

**v2 关键简化**：不再使用 SQLite。历史数据就是仓库里每天的 JSON 文件，这既满足"公开可查"，又让 Actions 每次全新容器也能读到过去的数据。

### 5.2 目录结构

```
github-hotspot/
  package.json                  # 无 dependencies
  src/
    cli.mjs                     # collect | serve | export
    config/  weights.mjs  boards.mjs        # ★扩展点
    sources/                    # 统一 discover()/enrich() 接口 ★扩展点
      trending.mjs  search.mjs  star-velocity.mjs
      events.mjs  releases.mjs  registry.mjs  hn.mjs
    enrich/  readme.mjs  runnability.mjs  health.mjs
    score/   score.mjs  reasons.mjs         # 纯函数
    store/   datastore.mjs                  # 读写 public/data/*.json
    net/     client.mjs                     # 串行 + 重试 + 额度 + 缓存
    exporters/  markdown.mjs  json.mjs  rss.mjs   # ★扩展点
  public/                       # ← 这一整个目录部署出去就是网站
    index.html  app.js  style.css
    prepare.html                # 新手准备页（怎么开命令行、装 Node）
    data/
      index.json                # 有数据的日期列表
      2026-10-10.json           # 当天榜单（含每个仓库的收藏数快照）
      history/2026-10.json      # 按月归档的历史快照（护城河）
  fixtures/                     # 离线演示 + 测试样本
  test/*.test.mjs
  docs/使用手册.md
  .github/workflows/daily.yml   # 预留（v2 不阻塞施工）
  README.md
```

### 5.3 数据流

```
采集（npm run collect；未来由 GitHub Actions 每天自动跑）
 ① 发现候选
     ├─ search: created:>7d stars:>200      新项目（飙升精确）
     ├─ search: pushed:>7d stars:>500       活跃老项目
     ├─ trending HTML (daily/weekly)        可信锚点（0 API 成本）
     └─ 昨日榜单里仍在涨的                    连续性
 ② 硬性门槛过滤（§6.2）
 ③ 富化（严格串行、受预算约束）：repo 详情 / release 资产 / README 中文检测 / npm·PyPI 直查 / HN 提及
 ④ 涨星速度（五级降级）→ 带 confidence
 ⑤ 评分（纯函数）→ 三轴得分 + 中文理由
 ⑥ 写 public/data/YYYY-MM-DD.json + 更新 public/data/index.json + 追加 history/YYYY-MM.json
 ⑦ 导出 daily/YYYY-MM-DD.md（给人看的日报）
 ⑧ 输出本轮 API 消耗统计

网站：npm start 起本地静态服务；public/ 整个目录可原样部署到任何静态托管
```

### 5.4 数据模型（JSON 文件即数据库）

**`public/data/YYYY-MM-DD.json`**
```jsonc
{
  "date": "2026-10-10",
  "generatedAt": "2026-10-10T02:00:00Z",
  "degraded": false,              // 数据不完整时为 true，界面要提示
  "boards": [
    { "id": "weekly", "title": "本周飙升",
      "items": [
        { "rank": 1, "ownerRepo": "microsoft/markitdown", "name": "markitdown",
          "description": "把 PDF、Word、Excel 变成 AI 能读的文字",
          "language": "Python", "license": "MIT", "stars": 89000, "forks": 5200,
          "starsGained7d": 1234, "starsGained3d": null,
          "confidence": "measured",           // measured | reported | estimated
          "velocityLevel": 1,
          "scores": { "hot": 38.2, "reputation": 24.1, "runnable": 25, "total": 87.3 },
          "grade": "green", "hasChinese": true,
          "install": { "kind": "releaseWindows", "command": null,
                       "downloadUrl": "https://.../app-setup.exe",
                       "evidence": "release asset: app-setup.exe", "verified": true },
          "reasons": ["本周新增收藏 1,234（实测）", "有 Windows 安装包", "有中文说明"],
          "pushedAt": "2026-10-09T12:00:00Z", "archived": false }
      ] }
  ]
}
```

**`public/data/index.json`**：`{ "dates": ["2026-10-10", "2026-10-09"], "updatedAt": "..." }`

**`public/data/history/YYYY-MM.json`**：`{ "2026-10-10": { "owner/repo": { "stars": 89000, "forks": 5200 } } }` —— 这是自持历史，用于计算真实差值。

### 5.5 额度预算

- 本地未认证：core **60/小时** → 每轮采集**上限 45 次**，超出停止富化并标注 `degraded`
- 未来上线 Actions：`GITHUB_TOKEN` 约 **1000/小时**，瓶颈消失（§3 事实 4）
- 本地开发用 `data/cache.json`（gitignored）做 24h 响应缓存，减少重复请求
- 遇到 403：读 `x-ratelimit-reset`；可接受则休眠重试，否则降级为"用既有数据出榜"并在界面标注"本期数据不完整"
- 省额度技巧（留作改进）：release 资产可从 API 降级为抓 `/releases/latest` HTML，省每候选 1 次请求

---

## 6. 评分体系（周榜，满分 100）

### 6.1 三轴权重

| 轴 | 分值 | 子项 |
|---|---|---|
| **热度** | 45 | 7 日新增收藏，`log10` 归一化：`45 × min(1, log10(1+v) / log10(1+3000))` |
| **口碑** | 30 | fork/star 比 8 + 近期提交活跃 8 + 近 90 天有发版 6 + 许可证齐全 4 + 收藏持续增长 4 |
| **新手友好** | 25 | 安装路径 0-18 + 中文说明 0-7（R143 起按"真有中文"算，见下面的修订说明） |

**口碑子项的确定性口径**（全部只用已获取字段，无需额外请求，可单测；五项之和 = 30 = `WEIGHTS.reputation`）

| 子项 | 计算方式 | 满分条件 |
|---|---|---|
| fork/star 比 | `forks / stars` | ≥ 0.15（线性：`8 × min(1, ratio / 0.15)`）|
| 近期提交活跃 | `pushed_at` 距今天数 | ≤ 2 天满分；≤ 7 天得 `8 × 2 / 3` |
| 近 90 天有发版 | 最新 release 时间 | 有发版满分 |
| 许可证齐全 | `license.spdx_id` 存在且非 `NOASSERTION` | 存在满分 |
| 收藏持续增长 | 历史 JSON 相邻两期差值 > 0 | 有增长满分（数据不足给**中性半分 2**，不惩罚新项目）|

> **为什么没有"issue 处理率"（2026-10-10 修订）**：原设计含 `closed_issues / (closed_issues + open_issues)`，占 8 分。控制者用真实 API 实测确认 **`closed_issues` 字段在仓库详情与 search 结果里都不存在**（含 issue 的字段只有 `issue_events_url` / `issue_comment_url` / `issues_url` / `has_issues` / `open_issues_count` / `open_issues`）。该子项在真实数据下恒为 0，会让界面对**每一个**项目显示"作者管不管事 = 0 分"（一句假话），并把口碑轴满分压到 22、破坏 45/30/25 的平衡。故移除，8 分重新分配给**可测量**的信号。
>
> **留作可改进空间**：若要恢复"作者管不管事"，可行的正确做法是每候选追加一次 `GET /search/issues?q=repo:{owner}/{repo}+type:issue+state:closed&per_page=1` 读 `total_count`——但它走 **search 额度（10 次/分钟）**，需为全部过门槛候选付费并有节奏地限速。当前判断：收益不抵成本，故不做。

**新手友好子项**（v1 的"可落地分"更名，口径不变；安装路径 0-18 + 中文说明 0-7 = 25 = `WEIGHTS.runnable`）

**安装路径分档（0-18）**：release 有 Windows 资产 18 / npm `bin`+`win32` 16 / PyPI 有包 14 / npm 无 `bin` 8 / 需自行编译 6 / 仅 Docker 4。

**中文说明分（0-7，R143 修订）**：**要么 7 分、要么 0 分**。判据是 `hasChinese`：
README 里**汉字**占比 ≥ 3%（且假名占比低于阈值），或存在**中文**文件名的本地化文件
（`README.zh-CN.md` / `README_CN.md` / `README.zh.md` / `docs/*.zh*`），满足任一即给满 7 分；
**非中文的本地化说明不给这一项的分**（只有 `README.ja.md` 这类文档时，这一项是 0 分）。
代码里的构成是"正文 4 分 + 本地化文件 3 分"（`CHINESE_POINTS`），但两者是同一件事的两种证据，
所以对外只有 7 或 0 两档，不存在按比例加分。

> **R143（2026-10-11）：这一项从 `hasCjk` 改成 `hasChinese` 计分。**
> 旧口径是"README 中日韩字符占比 ≥3% → 4 分；另存在任意本地化文件 → 再 +3"，
> 即**有意奖励"任何本地化"**（R59 原文）。它带来两个问题：
> ① 只有 `README.ja.md` 的项目会拿到"中文说明"这 7 分，而这条轴、口径页、README、手册都把它叫「中文说明」；
> ② `reasons.mjs` 用 `chineseDoc`(=`hasCjk`) 推出"有中文说明"，与同一条目的抽屉 FAQ（读 `hasChinese`）
> 直接矛盾——已提交的演示数据里 174 个渲染位有 129 个同时命中。
> 现在：计分、徽章、文案**统一**按 `hasChinese`；`hasCjk` 只用于如实说「有本地化文档（非中文）」。
> 字段层面见 R153（删掉与 `hasChinese` 恒等的历史名 `chineseDoc`）。

**（实测校准）**：HelloGitHub 汉字占比 5.35% 命中；markitdown 0% 正确排除；
`sst/opencode` 正文 CJK 占比 0.26%（低于阈值）但仓库有 `README.ja.md` —— R143 之后它是
`hasChinese: false`（**不给这 7 分、不给中文徽章**）、`hasCjk: true`（"有本地化文档"这条事实成立，
界面照实说"有本地化文档（非中文）"）。

> **R59（2026-10-10 补充）："有中文"与"有本地化"是两个不同的断言，徽章不得混用。**
> 界面上的徽章写的是「🈶 有中文说明」。若一个项目只有 `README.ja.md`（日文），却对中文新手宣称"有中文说明"，
> 那就是一句**假话**，正是本项目反复修正的那类缺陷。因此检测必须同时产出两个布尔值：
> - `hasChinese` —— **计分与徽章共用**（R143 起）：确实有中文。判定为 `README.zh-CN.md` / `README_CN.md` /
>   `README.zh.md` / `docs/*.zh*` 之一存在，**或** Han 字符占比达标且**假名（U+3040–U+30FF）占比低于一个小阈值**
>   （日文会混用假名与汉字，故假名占比偏高即判为日文）。
> - `hasCjk` —— **只用于如实说明**（R143 起不参与计分）：CJK 占比达标，或存在任意本地化文件。
> 徽章与计分都用 `hasChinese`；仅有非中文本地化时，界面必须**如实**表述（例如「有本地化文档（非中文）」），
> 不得显示"有中文说明"，也不给这一项的分。

### 6.2 硬性门槛

进入"本周飙升"与"新手能玩"必须同时满足：未归档 · 有 LICENSE · 近 7 天有提交 · 总收藏 ≥ 200 · **至少一条已核实的安装路径**（判定式：`verified === true` 且 `RUNNABLE_POINTS[kind] > 0`，故 `'none'` 与未知 kind 一律挡下，而 `dockerOnly`(4) 放行）· 非纯资源清单类（见 §6.4，只进经典榜）。

### 6.3 "为什么上榜"的可解释输出

每个分数都落进 JSON 并在界面展示，例如：
> 本周新增 1,234 人收藏（实测）· 作者近 7 天仍在更新 · 有 Windows 安装包 · 有中文说明

刻意不引入大模型：评分可复现、可单测、可追溯。

### 6.4 纯资源清单类的识别

对应 §6.2 的门槛 6，判定规则（确定性、可单测）：

> **`(language 为空或为 'Markdown') 且 无已核实的安装路径`** → 判为资料清单类，排除出「本周飙升」与「新手能玩」，只进「经典必玩」。理由文案：「这是资料清单，不是能装的软件」。

- **刻意不用仓库名启发式**（例如 `awesome-*`）：名字匹配会静默误伤 `owner/awesome-tool` 这类真实工具，且不是本规范的口径。
- 该规则与门槛 5 存在重叠，这是**有意的纵深防御**：清单类仓库由此获得更准确的中文理由，而不是笼统的"没有安装方式"。

---

## 7. 涨星速度的获取策略（技术命门）

### 7.1 为什么是命门

GitHub 不提供 star 历史；`/stargazers` 列表端点自 2026-06-30 起对非管理员关闭；全局事件流自 2026-03 起退化到 baseline 的 0.3%。

### 7.2 五级降级阶梯（统一接口，输出 `confidence`）

| 级别 | 方法 | confidence | 成本 | 适用 |
|---|---|---|---|---|
| 0 | `stargazers/history` 端点（**O1 已验证可用**） | `measured` | 新仓库 1 次；老仓库每 30 周 1 次 | **首选来源** |
| 1 | 新项目：总收藏数即 7 日增量（`created ≤ 7d`） | `measured` | 0（发现候选时已有） | 7 天内新建项目 |
| 2 | trending HTML 的 `starsThisWeek` | `reported` | **0 API 成本** | 恰在 trending 页上的项目 |
| 3 | **当天快照与 7 天前那一天快照的差值**（`public/data/YYYY-MM-DD.json`，读的是 7 天前那一天的当天文件） | `measured` | 0 | 连续追踪的项目，从第 8 天起 |
| 4 | `/repos/{r}/events` 的 WatchEvent 速率外推 | `estimated` | 1 次 | 兜底 |

**v2 变化**：级别 3 从"SQLite 快照差值"改为"读仓库里已经落盘的那些当天 JSON 的差值"——**读的是 7 天前那一天的那份当天文件**（`public/data/YYYY-MM-DD.json`，间隔正好 7 天）。因为数据文件会随采集提交进仓库，**在 GitHub Actions 的全新容器里也能读到**，这让它成为最稳的支柱，也让"越用越准"的故事公开可验证。

**R132 更正（2026-10-11）**：本表原先写的是"历史 JSON 差值（`public/data/history/*.json`）"，那是**错的**。`history/YYYY-MM.json` 这个按月归档的文件只在采集时被 `appendHistory` 写入，**读它的 `readHistory` 没有任何生产调用者**（只有测试在用）——所以它不是级别 3 的来源，级别 3 读的是 7 天前那一天的那份当天文件。

### 7.3 界面必须诚实

估算值标注"约 +1,234（估算）"，实测值标"（实测）"。**不把估算当事实展示。**

---

## 8. 错误处理与容错

| 场景 | 处理 |
|---|---|
| 网络超时（实测发生过） | 20s 超时，最多 3 次重试，指数退避 1s/2s/4s |
| 403 额度耗尽 | 读 `x-ratelimit-reset`；可接受则休眠重试，否则用既有数据出榜并标 `degraded: true` |
| 并发自限流（实测发生过） | **全局串行队列**，同域名同时只允许 1 个在途请求 |
| trending 改版 | 解析器独立模块 + 固定 fixture 回归测试；失败返回空数组并降级，不致命 |
| 单个候选富化失败 | 跳过该候选并计数，不中断整轮 |
| 幂等 | 同一天重复运行只覆盖同一个 JSON 文件，不产生重复条目 |
| 历史文件损坏 | 读取时 try/catch，当作缺数据（给中性分），不得让整轮采集失败 |

---

## 9. 部署方案（v2 预留，不阻塞施工）

用户决定"先把东西做出来，发布的事后面再定"。设计上已为此准备好：

1. `public/` 是纯静态目录 → 可直接部署到 **GitHub Pages / Cloudflare Pages / Vercel**，无需任何服务端
2. `.github/workflows/daily.yml` 已预留：每天定时 `npm run collect` 后把 `public/data/` 提交回仓库
3. 数据用 JSON 而非数据库 → Actions 全新容器无状态也能工作
4. 因为静态，**不需要任何密钥出现在前端**；采集用的 `GITHUB_TOKEN` 只在 Action 里使用

---

## 10. 测试策略（`node:test`，零依赖）

| 层次 | 测什么 |
|---|---|
| 单元 | 评分纯函数（固定输入 → 逐项断言各分轴）、新手友好度分级、中文检测、清单类识别 |
| 单元 | **包名归属校验**：`repository.url` 与目标仓库不符必须拒绝（防装错包） |
| 单元 | trending HTML 解析（固定 fixture）、release 资产中 Windows 文件识别 |
| 单元 | 额度退避：模拟 403 + reset 头，断言等待或降级 |
| 单元 | JSON 数据层：写入后能读回、同日重复写幂等、损坏文件不影响整体 |
| 集成 | **离线端到端**：用 fixture 跑完整采集 → 断言三榜条数、门槛生效、JSON 与日报生成正确 |
| 手工 | `npm start` 打开网站，点完整流程 |

---

## 11. 交付物

1. 代码：零运行时依赖、有测试、关键处有注释
2. `docs/使用手册.md`：保姆级中文说明 —— 怎么跑起来、三个榜口径、评分公式全文、徽章含义、**怎么发布到网上（可选）**、常见问题
3. `README.md`：一张截图 + 30 秒跑起来 + **第一段就讲清与 §2.1 那批项目的区别**
4. `npm run demo`：内置离线数据，断网也能完整演示
5. 每日公开历史 JSON（随采集累积）
6. 本设计文档 + 实现计划

---

## 12. 明确不做（YAGNI）

- 不做后端服务、不做数据库服务、不做用户账号与登录
- **不做本地安装执行器**（v2 移除）
- 不接入大模型（用户明确选择纯确定性规则引擎）
- 不做消息推送 / 邮件 / 微信通知
- 不做应用市场式细分类目（**只三个榜**）
- 不做多语言界面（先只有中文）
- 不做移动端专门适配（桌面优先，但布局要能在手机上看得下去）
- 不做评论、点赞、收藏等社交功能（静态站无后端）

---

## 13. 留出的可改进空间

| 扩展点 | 做法 |
|---|---|
| 榜单可增删 | `config/boards.mjs` |
| 权重可调 | `config/weights.mjs`，可覆盖不改代码 |
| 数据源可插拔 | `sources/*` 统一 `discover()` / `enrich()` 接口 |
| 涨星能力自动升级 | `star-velocity.mjs` 逐级降级，O1 端点可用即自动启用 |
| 额度可提升 | 检测到 `GITHUB_TOKEN` 自动放宽候选池 |
| 导出格式可扩展 | `exporters/` 加文件即可（已含 json/markdown，RSS 可选） |
| 部署目标可换 | 纯静态，托管方随便换 |
| 界面可加功能 | 本地"我收藏的"（localStorage，无需后端） |
| 类目可细分 | 等"新手能玩"榜跑通后再说 |
| 定时可开关 | `daily.yml` 预留，启用即自动更新 |

---

## 14. 里程碑拆分

| 里程碑 | 内容 | 完成标志 |
|---|---|---|
| M1 | 骨架 + JSON 数据层 + 评分纯函数 + 单测 | `npm test` 通过，能对 fixture 算出榜单 JSON |
| M2 | 采集器（trending / search / 富化 / 缓存 / 额度 / 降级） | `npm run collect` 生成真实榜单 JSON |
| M3 | 静态网站（三榜 + 卡片 + 筛选 + 详情抽屉） | 浏览器里能看榜、能筛选 |
| M4 | 新手友好度分级 + 中文检测 + 三步安装向导 + 新手准备页 | 每个项目都有已核实的安装引导 |
| M5 | 离线 demo + 历史日期回看 + 评分口径页 | 断网可演示，能回看历史 |
| M6 | 中文手册 + README + 发布准备（workflow 预留） | 文档可让新手跑起来；`public/` 可直接部署 |

---

## 15. 开放问题清单

| 编号 | 问题 | 处理 |
|---|---|---|
| O1 | `stargazers/history` 端点是否真的未认证可用 | ✅ **已结案（2026-10-10 实测）**：未认证可用、版本头非必需、可翻页。级别 0 成为首选来源（详见 §3.1） |
| O2 | 经典榜的分组标签是否需人工维护 | 先用 topics 自动归类，不足再手工补充 |
| O3 | 何时真正发布上线 | 用户决定"先做出来再说"；M6 后可直接部署 |
| O4 | 是否启用 Actions 定时采集 | `daily.yml` 已预留，用户决定 |

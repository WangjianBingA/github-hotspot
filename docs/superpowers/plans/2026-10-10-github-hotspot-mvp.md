# GitHub 好玩榜 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个纯本地、零依赖的"GitHub 版新手应用商店"：每天自动采集热门项目，用「热度 / 口碑 / 可落地」三轴评分，在网页上以三个榜单呈现，并给每个项目生成经过核实的保姆级中文安装引导。

**Architecture:** 单进程 Node 应用，分为四层：`sources/`（拿数据，统一 `discover`/`enrich` 接口）→ `enrich/`+`score/`（确定性纯函数计算）→ `store/`（node:sqlite 落库）→ `http/`（内置 http 服务 + 静态前端）。采集严格串行并受额度预算约束，网络失败逐级降级并标注置信度。评分不引入任何大模型，每一分都可追溯到具体字段。

**Tech Stack:** Node.js v24（实测可用）、内置 `fetch` / `node:sqlite` / `node:http` / `node:test`；前端原生 HTML/CSS/JS；**运行时零第三方依赖**。

**Spec:** `docs/superpowers/specs/2026-10-10-github-app-store-design.md`

## Global Constraints

- **零运行时依赖**：`package.json` 不得出现 `dependencies` 字段；也不引入任何 devDependency。测试用内置 `node:test`。
- **Node ≥ 22**（实测环境 v24.21.0），必须使用内置 `node:sqlite`、`fetch`、`node:test`。
- **额度**：未认证 GitHub API 为 core 60/小时、search 10/分钟。每轮采集 core 请求**硬上限 45 次**，超出即停止富化并把剩余候选顺延（写入 `runs` 表）。
- **严格串行**：同一域名同一时刻只允许 1 个在途请求（实测并发会把 github.com 打到超时）。
- **不假设分支名**：任何 raw 文件请求必须使用 API 返回的 `default_branch`。
- **包名校验**：任何 npm/PyPI 包必须确认其 `repository.url`（npm）或项目地址（PyPI）指向目标仓库，否则**不产出安装命令**（宁可无引导，不可错引导）。
- **界面文案**：不得出现 star / fork / issue / archived 等行话，必须使用 spec §4.3 翻译表（"有多少人收藏"/"有多少人拿去改造"/"作者管不管事"/"作者已停止维护"）。
- **置信度必须标注**：涨星数据来自估算时，界面显示"约 +N（估算）"；实测时显示"N（实测）"。
- **实验执行器默认关闭**：白名单仅 `npm` / `npx` / `pip` 三类命令，安装到 `sandbox/<owner>__<repo>/`。
- **界面只有中文。**
- **三个榜单 id 固定为** `weekly` / `newbie` / `classic`；条数分别 15 / 15 / 30。
- **落库路径** `data/hotspot.db`（加入 .gitignore）；日报路径 `daily/YYYY-MM-DD.md` 与 `.json`。
- **幂等**：同一天重复运行不得产生重复记录（`INSERT OR REPLACE`）。
- 时间统一用 UTC 计算日期键，日期格式 `YYYY-MM-DD`。

## Review Focus

以下是 spec 隐含、但没有哪个任务天然会测到、且最可能真正坑到使用者的行为。每条都在对应任务的测试里钉住：

1. **同名包导致装错软件**：npm 上搜 `markitdown` 会命中**另一个作者**的包。一个仓库名与某个热门包同名、但 `repository.url` 指向别处时，程序必须**不给安装命令**，而不是给一条会装错东西的命令。（Task 10）
2. **断网或额度耗尽时页面不能崩或空白**：额度耗尽（403 + `x-ratelimit-reset` 还很远）或完全断网时，采集应降级为"只用既有缓存出榜"并在界面标注"本期数据不完整"；服务仍能打开并显示上一次的榜单。（Task 7、Task 15、Task 18）
3. **trending 页面改版**：`github.com/trending` 的 HTML 结构一旦变化，"stars today" 抓不到时，解析器必须返回空数组并降级，不得抛出未捕获异常导致整轮采集失败。（Task 8）
4. **大项目与小项目混榜的数值边界**：55 万星的老项目与 200 星的新项目同场计算时，热度分必须做 log 归一化且落在 0–45；新增收藏为 0 时必须是 0 分，**不得出现 NaN / Infinity**。（Task 3）
5. **估算值被当成事实展示**：当涨星速度来自 Events 外推（`confidence: estimated`）时，界面与日报都必须显示"约/估算"，禁止展示为精确值。（Task 3、Task 5、Task 15）

---

## Phase 0：骨架与存储

### Task 1: 项目骨架与测试跑通

**Files:**
- Create: `package.json`, `.gitignore`, `src/cli.mjs`, `test/smoke.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `npm test`、`npm run collect`、`npm start`、`npm run demo` 四个脚本入口；`src/cli.mjs` 导出 `main(argv: string[]): Promise<number>`

- [ ] **Step 1: 写失败测试** `test/smoke.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.mjs';

test('未知命令返回非零并打印用法', async () => {
  const code = await main(['nope']);
  assert.equal(code, 2);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/smoke.test.mjs`
Expected: FAIL（`Cannot find module '../src/cli.mjs'`）

- [ ] **Step 3: 实现骨架**

`package.json`：`{"name":"github-hotspot","private":true,"type":"module","engines":{"node":">=22"},"scripts":{"test":"node --test test/","collect":"node src/cli.mjs collect","start":"node src/cli.mjs serve","demo":"node src/cli.mjs serve --demo"}}` —— **不得含 `dependencies`**。

`.gitignore`：`node_modules/`、`data/`、`sandbox/`、`fixtures/last-good/`。

`src/cli.mjs`：导出 `main(argv)`，`switch(argv[0])` 分发 `collect|serve|export|schedule|demo`（本任务先全部返回 0 占位），未知命令向 stderr 打印用法并返回 2。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/smoke.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add package.json .gitignore src/cli.mjs test/smoke.test.mjs
git commit -m "chore: 项目骨架与零依赖测试入口"
```

### Task 2: SQLite 存储层

**Files:**
- Create: `src/store/db.mjs`, `test/store-db.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `openDb(path: string): Database`（返回已执行迁移的连接；`:memory:` 可用于测试）
  - `SCHEMA_VERSION = 1`
  - 表：`repos / snapshots / star_history / scores / rankings / runnability / cache / runs`（字段见 spec §5.4）
  - 方法签名（后续任务都按这个调用）：
    - `upsertRepo(repo) / getRepo(ownerRepo)`
    - `upsertSnapshot({ ownerRepo, date, stars, forks }) / getSnapshot(ownerRepo, date) / countSnapshots(ownerRepo)`
    - `upsertStarHistory(ownerRepo, date, cumulative) / getStarHistory(ownerRepo)`
    - `saveScores(ownerRepo, date, { hot, reputation, runnable, total, confidence, reasons })`
    - `saveRunnability(ownerRepo, runnability) / getRunnability(ownerRepo)`
    - `saveRankings(date, board, rows: { rank, ownerRepo, score }[])` / `getRankings(date, board): { rank, ownerRepo, score }[]`
    - `listDates(): string[]`
    - `startRun(meta) / finishRun(id, meta) / close()`

- [ ] **Step 1: 写失败测试** `test/store-db.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.mjs';

test('建表幂等且可重复打开', () => {
  const db = openDb(':memory:');
  db.close();
  assert.ok(true);
});

test('snapshots 同一仓库同一天重复写入只保留一行', () => {
  const db = openDb(':memory:');
  db.upsertSnapshot({ ownerRepo: 'a/b', date: '2026-10-10', stars: 100, forks: 5 });
  db.upsertSnapshot({ ownerRepo: 'a/b', date: '2026-10-10', stars: 120, forks: 6 });
  assert.equal(db.getSnapshot('a/b', '2026-10-10').stars, 120);
  assert.equal(db.countSnapshots('a/b'), 1);
  db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/store-db.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/store/db.mjs`**

用 `import { DatabaseSync } from 'node:sqlite'`。导出 `openDb(path)`，内部执行 `CREATE TABLE IF NOT EXISTS ...` 与 `PRAGMA user_version` 版本写入；返回对象除原生连接外附带方法：`upsertRepo`、`getRepo`、`upsertSnapshot`、`getSnapshot`、`countSnapshots`、`upsertStarHistory`、`getStarHistory`、`saveScores`、`saveRankings`、`getRankings(date, board)`、`saveRunnability`、`getRunnability`、`startRun`、`finishRun`、`close`。所有写入用 `INSERT OR REPLACE` 保证幂等。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/store-db.test.mjs`
Expected: PASS（2 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/store/db.mjs test/store-db.test.mjs
git commit -m "feat(store): node:sqlite 存储层与幂等写入"
```

---

## Phase 1：评分核心（M1）

### Task 3: 热度分（含数值边界）

**Files:**
- Create: `src/config/weights.mjs`, `src/score/score.mjs`, `test/score-hot.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `src/config/weights.mjs` 导出 `WEIGHTS={hot:45,reputation:30,runnable:25}`、`HOT_REFERENCE_STARS_PER_WEEK=3000`、`BOARD_SIZES={weekly:15,newbie:15,classic:30}`、`DETAIL_WEIGHTS`、`RUNNABLE_POINTS`、`CHINESE_POINTS`（数值见 spec §6.1）
  - `scoreHot({ starsGained7d: number }): number` —— 返回 0–45

- [ ] **Step 1: 写失败测试** `test/score-hot.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreHot } from '../src/score/score.mjs';
import { WEIGHTS, HOT_REFERENCE_STARS_PER_WEEK } from '../src/config/weights.mjs';

test('新增收藏为 0 时得 0 分，不得为 NaN', () => {
  assert.equal(scoreHot({ starsGained7d: 0 }), 0);
});

test('达到参考值时拿满分且不超过满分', () => {
  assert.equal(scoreHot({ starsGained7d: HOT_REFERENCE_STARS_PER_WEEK }), WEIGHTS.hot);
});

test('55 万星级项目的新增 20 万也封顶在满分，不溢出', () => {
  const s = scoreHot({ starsGained7d: 200000 });
  assert.ok(s <= WEIGHTS.hot && s >= 0 && Number.isFinite(s));
  assert.equal(s, WEIGHTS.hot);
});

test('小项目不因数值小而得负分或 NaN', () => {
  assert.ok(scoreHot({ starsGained7d: 1 }) > 0);
});

test('缺失或非法输入按 0 处理而不是抛错', () => {
  assert.equal(scoreHot({ starsGained7d: undefined }), 0);
  assert.equal(scoreHot({ starsGained7d: -5 }), 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/score-hot.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`weights.mjs` 按 spec §6.1 填写常量。`scoreHot` 实现：`v = Number.isFinite(starsGained7d) && starsGained7d > 0 ? starsGained7d : 0`，返回 `WEIGHTS.hot * Math.min(1, Math.log10(1+v) / Math.log10(1+HOT_REFERENCE_STARS_PER_WEEK))`，并对结果 `Math.min(WEIGHTS.hot, ...)` 封顶。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/score-hot.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/config/weights.mjs src/score/score.mjs test/score-hot.test.mjs
git commit -m "feat(score): 热度分与 log 归一化边界"
```

### Task 4: 口碑分、可落地分、总分与等级

**Files:**
- Modify: `src/score/score.mjs`
- Create: `test/score-reputation.test.mjs`, `test/score-runnable.test.mjs`

**Interfaces:**
- Consumes: `WEIGHTS`、`DETAIL_WEIGHTS`、`RUNNABLE_POINTS`、`CHINESE_POINTS`
- Produces:
  - `scoreReputation(repo, extra): { total: number, parts: Record<string, number> }`
  - `scoreRunnable(runnability): { total: number, parts: Record<string, number> }`
  - `scoreRepo(input): { hot, reputation, runnable, total, grade, confidence, parts }`
  - `calculateGrade(runnableScore): 'green' | 'yellow' | 'red'`
  - `passesGates(repo, runnability): { ok: boolean, reasons: string[] }`
  - `repo` 形状：`{ ownerRepo, stars, forks, openIssues, closedIssues, pushedAt, license, archived, language, hasRelease90d }`
  - `runnability` 形状：`{ kind, verified, difficulty, chineseDoc, chineseRatio }`，`kind ∈ releaseWindows|npmBinWin|pypiCompatible|npmNoBin|buildFromSource|dockerOnly|none`

- [ ] **Step 1: 写失败测试**（口碑口径逐项，spec §6.1 表）

```js
// test/score-reputation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreReputation, passesGates } from '../src/score/score.mjs';

const base = { ownerRepo:'a/b', stars:1000, forks:150, openIssues:20, closedIssues:80,
  pushedAt: new Date().toISOString(), license:'MIT', archived:false, language:'Go', hasRelease90d:true };

test('各子项满分时口碑分等于 30', () => {
  const r = scoreReputation(base, { growing: true });
  assert.equal(r.total, 30);
});

test('issue 处理率按 closed/(closed+open) 计算', () => {
  const r = scoreReputation({ ...base, openIssues: 80, closedIssues: 20 }, { growing: false });
  assert.equal(r.parts.issueClosure, 2); // 0.2 / 0.8 * 8
});

test('archived 仓库被门槛挡下且给出原因', () => {
  const g = passesGates({ ...base, archived: true }, { kind:'npmBinWin', verified:true });
  assert.equal(g.ok, false);
  assert.match(g.reasons.join(','), /归档|维护/);
});

test('无许可证、收藏不足、无已核实安装路径分别被挡下', () => {
  assert.equal(passesGates({ ...base, license:null }, { kind:'npmBinWin', verified:true }).ok, false);
  assert.equal(passesGates({ ...base, stars: 50 }, { kind:'npmBinWin', verified:true }).ok, false);
  assert.equal(passesGates(base, { kind:'npmBinWin', verified:false }).ok, false);
});
```

```js
// test/score-runnable.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRunnable, calculateGrade } from '../src/score/score.mjs';

test('Windows 安装包得 18 分，加中文文档共 25', () => {
  const r = scoreRunnable({ kind:'releaseWindows', chineseDoc:true });
  assert.equal(r.parts.installPath, 18);
  assert.equal(r.total, 25);
});

test('无中文文档时不给中文分', () => {
  assert.equal(scoreRunnable({ kind:'releaseWindows', chineseDoc:false }).parts.chinese, 0);
});

test('中文分封顶 7 分（README 达标 4 + 本地化文件 3）', () => {
  assert.equal(scoreRunnable({ kind:'pypiCompatible', chineseDoc:true }).parts.chinese, 7);
});

test('难度分级：18/16 为绿，14/8 为黄，6/4/none 为红', () => {
  assert.equal(calculateGrade(18), 'green');
  assert.equal(calculateGrade(16), 'green');
  assert.equal(calculateGrade(14), 'yellow');
  assert.equal(calculateGrade(8),  'yellow');
  assert.equal(calculateGrade(6),  'red');
  assert.equal(calculateGrade(0),  'red');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/score-reputation.test.mjs test/score-runnable.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`scoreReputation` 按 spec §6.1 口径表逐项计算并返回 `parts`；`growing` 缺失时该项给中性分（满分的一半）。`scoreRunnable` 按 `RUNNABLE_POINTS[kind]` 取分（未知 kind 得 0）+ 中文分（`chineseDoc === true` 时 `CHINESE_POINTS.readmeRatio + CHINESE_POINTS.localizedFile`）。`scoreRepo` 汇总三轴、`total = hot + reputation + runnable`、`grade = calculateGrade(parts.installPath)`、`confidence` 透传自传入的 velocity。`passesGates` 依次检查 spec §6.2 六条门槛，返回全部未通过原因（中文）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/score-reputation.test.mjs test/score-runnable.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/score/score.mjs test/score-reputation.test.mjs test/score-runnable.test.mjs
git commit -m "feat(score): 口碑分、可落地分、总分与门槛"
```

### Task 5: 上榜理由与置信度文案

**Files:**
- Create: `src/score/reasons.mjs`, `test/reasons.test.mjs`

**Interfaces:**
- Consumes: `scoreRepo` 的输出、`velocity`、`runnability`
- Produces: `buildReasons({ score, repo, velocity, runnability }): string[]`；`formatVelocityText(velocity): string`

- [ ] **Step 1: 写失败测试** `test/reasons.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReasons, formatVelocityText } from '../src/score/reasons.mjs';

test('实测数据不带"约"字，估算数据必须带"约"与"估算"', () => {
  assert.equal(formatVelocityText({ gained7d: 1234, confidence: 'measured' }), '本周新增收藏 1,234（实测）');
  assert.equal(formatVelocityText({ gained7d: 1234, confidence: 'estimated' }), '本周新增收藏约 1,234（估算）');
});

test('理由里必须出现可落地信息与中文信息', () => {
  const rs = buildReasons({
    score: { parts: { installPath: 18, chinese: 7 } },
    repo: { pushedAt: new Date().toISOString() },
    velocity: { gained7d: 500, confidence: 'measured' },
    runnability: { kind: 'releaseWindows', chineseDoc: true }
  });
  assert.ok(rs.some(r => r.includes('Windows')));
  assert.ok(rs.some(r => r.includes('中文')));
  assert.ok(rs.every(r => !/[a-z]+_\w+/.test(r)));  // 不得泄露字段名
});

test('理由中不得出现 star/fork/issue 行话', () => {
  const rs = buildReasons({ score:{parts:{installPath:18,chinese:0}}, repo:{ pushedAt:new Date().toISOString() },
    velocity:{ gained7d:10, confidence:'measured' }, runnability:{ kind:'releaseWindows', chineseDoc:false } });
  assert.ok(rs.every(r => !/\b(star|fork|issue)s?\b/i.test(r)));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/reasons.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`formatVelocityText` 按 spec §4.3/§8 生成"（实测）/（估算）"文案，千分位分隔。`buildReasons` 从 `runnability.kind`、`chineseDoc`、`pushedAt` 距今天数、`velocity` 生成 3–5 条中文短句，全部走翻译表。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/reasons.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/score/reasons.mjs test/reasons.test.mjs
git commit -m "feat(score): 中文上榜理由与置信度文案"
```

### Task 6: 榜单组装（离线端到端）

**Files:**
- Create: `src/config/boards.mjs`, `src/boards/build.mjs`, `test/boards.test.mjs`, `fixtures/candidates.json`

**Interfaces:**
- Consumes: `scoreRepo`、`passesGates`、`BOARD_SIZES`
- Produces:
  - `src/config/boards.mjs` 导出 `BOARDS = [{ id:'weekly', title:'本周飙升', size:15, sortBy:'total' }, { id:'newbie', title:'新手能玩', size:15, sortBy:'runnable' }, { id:'classic', title:'经典必玩', size:30, sortBy:'stars' }]`
  - `buildBoard(boardId, items): RankedItem[]`，`items` 为 `{ repo, runnability, velocity, extra }[]`

- [ ] **Step 1: 写失败测试** `test/boards.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard } from '../src/boards/build.mjs';
import { BOARDS } from '../src/config/boards.mjs';
import candidates from '../fixtures/candidates.json' with { type: 'json' };

test('周榜遵守 15 条上限且按总分降序', () => {
  const b = buildBoard('weekly', candidates);
  assert.equal(b.length, 15);
  for (let i = 1; i < b.length; i++) assert.ok(b[i-1].score.total >= b[i].score.total);
});

test('被门槛挡下的项目不出现在周榜与新手榜', () => {
  const ids = buildBoard('weekly', candidates).map(x => x.repo.ownerRepo);
  assert.ok(!ids.includes('bad/archived'));
  assert.ok(!ids.includes('bad/nolicense'));
  assert.ok(!ids.includes('bad/unverified'));
});

test('纯清单类项目不进新手榜但可进经典榜', () => {
  const newbie = buildBoard('newbie', candidates).map(x => x.repo.ownerRepo);
  const classic = buildBoard('classic', candidates).map(x => x.repo.ownerRepo);
  assert.ok(!newbie.includes('awesome/list-only'));
  assert.ok(classic.includes('awesome/list-only'));
});

test('新手榜按可落地分降序', () => {
  const b = buildBoard('newbie', candidates);
  for (let i = 1; i < b.length; i++) assert.ok(b[i-1].score.runnable >= b[i].score.runnable);
});

test('同一个仓库同时进两个榜时各自独立排名，互不覆盖', () => {
  const w = buildBoard('weekly', candidates), n = buildBoard('newbie', candidates);
  const both = w.map(x=>x.repo.ownerRepo).filter(id => n.map(y=>y.repo.ownerRepo).includes(id));
  assert.ok(both.length >= 1);
  assert.ok(w.every(x => typeof x.rank === 'number') && n.every(x => typeof x.rank === 'number'));
});
```

`fixtures/candidates.json` 必须包含：≥18 个正常候选、`bad/archived`（archived）、`bad/nolicense`（license 为 null）、`bad/unverified`（runnability.verified=false）、`awesome/list-only`（language 为空、kind 为 `none`）；其中至少 1 个仓库在两个榜都够格。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/boards.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`build` 对每个候选调用 `scoreRepo` 与 `passesGates`；`weekly`/`newbie` 只用通过门槛者（`newbie` 额外排除 `language` 为空或 kind 为 `none` 的清单类）；`classic` 不过门槛只按 `stars` 排序；输出附加 `rank`（从 1 开始）并截断到 `BOARD_SIZES[boardId]`。排序必须稳定：同分时按 `ownerRepo` 字典序。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/boards.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/config/boards.mjs src/boards/build.mjs test/boards.test.mjs fixtures/candidates.json
git commit -m "feat(boards): 三榜单组装、门槛与清单类排除"
```

---

## Phase 2：网络层与数据源（M2）

### Task 7: 串行网络客户端、额度预算与缓存

**Files:**
- Create: `src/net/client.mjs`, `src/store/cache.mjs`, `test/net-client.test.mjs`

**Interfaces:**
- Consumes: `openDb` 的连接（缓存表）
- Produces:
  - `createCache(db): { get(key), set(key, body, ttlSeconds), }`
  - `createClient({ fetchImpl, token, budget, cache, now, sleep, logger }): { getJson(url, { api, ttlSeconds }), stats() }`
  - `class RateLimitError extends Error { resetAt: number }`
  - `stats()` 返回 `{ coreCalls, searchCalls, cacheHits, degraded }`

- [ ] **Step 1: 写失败测试** `test/net-client.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, RateLimitError } from '../src/net/client.mjs';

const okJson = (body, headers = {}) => async () => ({
  ok: true, status: 200, headers: new Map(Object.entries(headers)),
  json: async () => body, text: async () => JSON.stringify(body)
});

test('同一时刻只允许 1 个在途请求（严格串行）', async () => {
  let inFlight = 0, maxInFlight = 0;
  const fetchImpl = async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return { ok:true, status:200, headers:new Map(), json:async()=>({}), text:async()=>'{}' };
  };
  const c = createClient({ fetchImpl, budget: 10, sleep: async()=>{} });
  await Promise.all([c.getJson('https://api.github.com/a'), c.getJson('https://api.github.com/b'), c.getJson('https://api.github.com/c')]);
  assert.equal(maxInFlight, 1);
});

test('超过预算上限时不发请求而是降级', async () => {
  let calls = 0;
  const c = createClient({ fetchImpl: async () => { calls++; return { ok:true,status:200,headers:new Map(),json:async()=>({}),text:async()=>'{}' }; }, budget: 1, sleep: async()=>{} });
  await c.getJson('https://api.github.com/a');
  await c.getJson('https://api.github.com/b');
  assert.equal(calls, 1);
  assert.equal(c.stats().degraded, true);
});

test('403 且 reset 很远时抛 RateLimitError 并带上 resetAt', async () => {
  const reset = Math.floor(Date.now()/1000) + 3600;
  const c = createClient({ fetchImpl: async () => ({ ok:false, status:403, headers:new Map([['x-ratelimit-remaining','0'],['x-ratelimit-reset',String(reset)]]), json:async()=>({message:'rate limit'}), text:async()=>'rate limit' }), budget: 10, sleep: async()=>{} });
  await assert.rejects(() => c.getJson('https://api.github.com/a'), (e) => e instanceof RateLimitError && e.resetAt === reset);
});

test('命中缓存不再发请求', async () => {
  let calls = 0;
  const c = createClient({ fetchImpl: okJson({v:1}), budget: 10, sleep: async()=>{} });
  const real = createClient({ fetchImpl: async (u) => { calls++; return (await okJson({v:1})()); }, budget: 10, sleep: async()=>{} });
  await real.getJson('https://api.github.com/a', { ttlSeconds: 60 });
  await real.getJson('https://api.github.com/a', { ttlSeconds: 60 });
  assert.equal(calls, 1);
});

test('5xx 重试后成功则返回结果', async () => {
  let n = 0;
  const c = createClient({ fetchImpl: async () => { n++; if (n < 3) return { ok:false, status:500, headers:new Map(), json:async()=>({}), text:async()=>'err' }; return { ok:true,status:200,headers:new Map(),json:async()=>({ok:true}),text:async()=>'{}' }; }, budget: 10, sleep: async()=>{} });
  const r = await c.getJson('https://api.github.com/a');
  assert.equal(r.ok, true);
  assert.equal(n, 3);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/net-client.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`client.mjs`：内部维护 Promise 链实现全局串行队列；每次请求前检查 `budget`（core 与 search 分开计数），用尽则置 `degraded=true` 并返回 `null`；先查缓存；20s 超时（`AbortController`）；5xx/网络错误重试 3 次，退避 1s/2s/4s（`sleep` 可注入以便测试）；403 且 `x-ratelimit-reset` 距今 > 300 秒时抛 `RateLimitError`，否则休眠至 reset 后重试一次；有 token 时请求头带 `Authorization`。`cache.mjs` 用 `cache` 表的 `key/body/expires_at` 实现 TTL 读写。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/net-client.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/net/client.mjs src/store/cache.mjs test/net-client.test.mjs
git commit -m "feat(net): 串行队列、额度预算、TTL 缓存与退避重试"
```

### Task 8: trending HTML 解析与降级

**Files:**
- Create: `src/sources/trending.mjs`, `fixtures/trending-daily.html`, `fixtures/trending-changed.html`, `test/trending.test.mjs`

**Interfaces:**
- Consumes: `client.getJson` 不可用（HTML 请求走 `fetchText`，本任务在模块内实现并接受注入的 `fetchImpl`）
- Produces:
  - `parseTrendingHtml(html: string): TrendingItem[]`
  - `TrendingItem = { fullName, url, description, language, stars, forks, starsToday, starsThisWeek }`
  - `fetchTrending(fetchImpl, since: 'daily'|'weekly'|'monthly'): Promise<TrendingItem[]>`

- [ ] **Step 1: 写失败测试** `test/trending.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTrendingHtml } from '../src/sources/trending.mjs';

const daily = readFileSync(new URL('../fixtures/trending-daily.html', import.meta.url), 'utf8');
const changed = readFileSync(new URL('../fixtures/trending-changed.html', import.meta.url), 'utf8');

test('从真实结构里解析出仓库与当日涨星', () => {
  const items = parseTrendingHtml(daily);
  assert.ok(items.length >= 5);
  const first = items[0];
  assert.match(first.fullName, /^[\w.-]+\/[\w.-]+$/);
  assert.equal(typeof first.starsToday, 'number');
  assert.ok(first.starsToday > 0);
});

test('页面改版导致结构变化时返回空数组而不抛异常', () => {
  assert.deepEqual(parseTrendingHtml(changed), []);
  assert.deepEqual(parseTrendingHtml(''), []);
  assert.deepEqual(parseTrendingHtml('<html><body>oops'), []);
});

test('缺少 stars today 的条目仍可用，starsToday 为 0', () => {
  const html = daily.replace(/stars today/g, 'stars');
  const items = parseTrendingHtml(html);
  assert.ok(items.every(i => i.starsToday === 0));
});
```

`fixtures/trending-daily.html` 用真实抓取的页面片段（含 `article.Box-row`、仓库链接、"N stars today"）；`fixtures/trending-changed.html` 用一份结构完全不同的 HTML（如只有 `<div>`）。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/trending.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

用正则切分 `article.Box-row` 块；从块内提取仓库相对链接、描述、语言、总星数、fork 数、"stars today/this week"。任一必需字段缺失的块跳过；整体解析包在 try/catch 中，异常时返回 `[]`。**不引入 HTML 解析库**（零依赖）。`fetchTrending` 请求 `https://github.com/trending?since=<since>`，超时/非 200 时返回 `[]`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/trending.test.mjs`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/sources/trending.mjs fixtures/trending-daily.html fixtures/trending-changed.html test/trending.test.mjs
git commit -m "feat(sources): trending 页面解析与改版降级"
```

### Task 9: search API 三个发现器

**Files:**
- Create: `src/sources/search.mjs`, `test/search.test.mjs`

**Interfaces:**
- Consumes: `client.getJson(url, { api: 'search' })`
- Produces:
  - `discoverNewRepos(client, { days = 7, minStars = 200 }): Promise<RepoRef[]>`
  - `discoverActiveRepos(client, { days = 7, minStars = 500 }): Promise<RepoRef[]>`
  - `fetchClassicTop(client, { minStars = 100000, perPage = 30 }): Promise<RepoRef[]>`
  - `RepoRef = { ownerRepo, fullName, description, language, stars, forks, openIssues, closedIssues, createdAt, pushedAt, license, archived, defaultBranch }`

- [ ] **Step 1: 写失败测试** `test/search.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverNewRepos, fetchClassicTop } from '../src/sources/search.mjs';

const fake = (items) => ({ getJson: async (url, opts) => {
  assert.equal(opts.api, 'search');
  return { total_count: items.length, incomplete_results: false, items };
} });

const item = (o = {}) => ({ full_name:'a/b', description:'d', language:'Go', stargazers_count:100, forks_count:1,
  open_issues_count:2, created_at:'2026-10-05T00:00:00Z', pushed_at:'2026-10-09T00:00:00Z',
  license:{ spdx_id:'MIT' }, archived:false, default_branch:'main', ...o });

test('新项目查询带上 created 与 stars 条件并按 stars 降序', async () => {
  let seen = '';
  const c = { getJson: async (url) => { seen = url; return { items: [item()] }; } };
  await discoverNewRepos(c, { days: 7, minStars: 200 });
  assert.match(decodeURIComponent(seen), /created:>/);
  assert.match(decodeURIComponent(seen), /stars:>200/);
  assert.match(seen, /sort=stars/);
});

test('总榜用 stars 阈值与 per_page=30，且断言 incomplete_results', async () => {
  const r = await fetchClassicTop(fake([item({ stargazers_count: 500000 })]), { minStars: 100000, perPage: 30 });
  assert.equal(r.length, 1);
  assert.equal(r[0].stars, 500000);
  assert.equal(r[0].defaultBranch, 'main');
});

test('接口失败或字段缺失时不抛错，返回空数组', async () => {
  const c = { getJson: async () => { throw new Error('boom'); } };
  assert.deepEqual(await discoverNewRepos(c), []);
  const c2 = { getJson: async () => null };
  assert.deepEqual(await fetchClassicTop(c2), []);
});

test('license 为 null 的条目映射为 license: null 而不是崩溃', async () => {
  const r = await fetchClassicTop(fake([item({ license: null })]));
  assert.equal(r[0].license, null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/search.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

三个函数构造 `https://api.github.com/search/repositories?q=...&sort=...&order=desc&per_page=...`，用 `encodeURIComponent` 组装；`created:>{ISO 日期}` 由"今天 UTC - days"计算。统一 `mapItem(raw)` 做字段映射（缺失字段给安全默认值）。任一异常捕获后返回 `[]`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/search.test.mjs`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/sources/search.mjs test/search.test.mjs
git commit -m "feat(sources): 新项目/活跃老项目/总榜三个发现器"
```

### Task 10: registry 直查与包名校验（防装错包）

**Files:**
- Create: `src/sources/registry.mjs`, `test/registry.test.mjs`

**Interfaces:**
- Consumes: 注入的 `fetchImpl`（不打 GitHub 额度）
- Produces:
  - `lookupNpm(fetchImpl, packageName, repoFullName): Promise<NpmInfo|null>`，`NpmInfo = { packageName, version, hasBin, osIncludesWin, repoMatches }`
  - `searchNpmByRepo(fetchImpl, repoFullName, term): Promise<NpmInfo|null>`
  - `lookupPyPI(fetchImpl, packageName): Promise<PyPIInfo|null>`，`PyPIInfo = { packageName, version, requiresPython, projectUrls }`
  - `isPythonCompatible(requiresPython: string|null, localPython: string): boolean`
  - `normalizeRepoUrl(url: string): string`

- [ ] **Step 1: 写失败测试** `test/registry.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupNpm, isPythonCompatible, normalizeRepoUrl } from '../src/sources/registry.mjs';

const npmFetch = (packument) => async () => ({
  ok: true, status: 200, headers: new Map([['content-type','application/json']]),
  json: async () => packument, text: async () => JSON.stringify(packument)
});

test('同名但 repository 指向别的仓库时必须判定为不匹配', async () => {
  const packument = { name:'markitdown', 'dist-tags':{latest:'1.0.0'}, versions:{ '1.0.0':{ bin:{ markitdown:'cli.js' }, repository:{ url:'git+https://github.com/dead8309/markitdown-ts.git' } } } };
  const r = await lookupNpm(npmFetch(packument), 'markitdown', 'microsoft/markitdown');
  assert.equal(r.repoMatches, false);   // ← 绝不能给安装命令
});

test('repository 指向目标仓库时判定匹配，并读出 bin 与 os', async () => {
  const packument = { name:'opencode-ai', 'dist-tags':{latest:'1.18.35'}, versions:{ '1.18.35':{ bin:{ opencode:'bin/opencode.exe' }, os:['darwin','linux','win32'], repository:{ url:'git+https://github.com/sst/opencode.git' } } } };
  const r = await lookupNpm(npmFetch(packument), 'opencode-ai', 'sst/opencode');
  assert.equal(r.repoMatches, true);
  assert.equal(r.hasBin, true);
  assert.equal(r.osIncludesWin, true);
});

test('normalizeRepoUrl 抹平 git+ / .git / 大小写 / 末尾斜杠差异', () => {
  const a = normalizeRepoUrl('git+https://github.com/SST/OpenCode.git');
  const b = normalizeRepoUrl('https://github.com/sst/opencode/');
  assert.equal(a, b);
});

test('requires_python 与本机 Python 比对', () => {
  assert.equal(isPythonCompatible('>=3.10', '3.10.11'), true);
  assert.equal(isPythonCompatible('>=3.12', '3.10.11'), false);
  assert.equal(isPythonCompatible('<3.15,>=3.10', '3.10.11'), true);
  assert.equal(isPythonCompatible(null, '3.10.11'), true);   // 未声明视为兼容
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/registry.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`lookupNpm` 请求 `https://registry.npmjs.org/<name>`，取 `dist-tags.latest` 对应版本，读 `bin`/`os`/`repository`；`repoMatches` 用 `normalizeRepoUrl` 比较后得出。`lookupPyPI` 请求 `https://pypi.org/pypi/<name>/json`。`isPythonCompatible` 解析 `>=`/`<=`/`<`/`>`/`==` 与逗号分隔的多条件，做语义化版本比较（只比较 major.minor，忽略 patch 与后缀）。所有请求 15s 超时，失败返回 `null`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/registry.test.mjs`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/sources/registry.mjs test/registry.test.mjs
git commit -m "feat(sources): npm/PyPI 直查与包名归属校验"
```

### Task 11: release 资产中的 Windows 包识别

**Files:**
- Create: `src/sources/releases.mjs`, `test/releases.test.mjs`

**Interfaces:**
- Consumes: `client.getJson`
- Produces:
  - `pickWindowsAsset(assets: {name:string, browser_download_url:string, size:number}[]): { name, url, size } | null`
  - `fetchLatestRelease(client, ownerRepo): Promise<{ tagName, publishedAt, assets, windowsAsset } | null>`

- [ ] **Step 1: 写失败测试** `test/releases.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWindowsAsset } from '../src/sources/releases.mjs';

test('识别 .exe / .msi / windows / win64 命名', () => {
  const a = n => ({ name:n, browser_download_url:'u', size:1 });
  assert.equal(pickWindowsAsset([a('app-setup.exe')]).name, 'app-setup.exe');
  assert.equal(pickWindowsAsset([a('App_x64.msi')]).name, 'App_x64.msi');
  assert.equal(pickWindowsAsset([a('tool-windows-amd64.zip')]).name, 'tool-windows-amd64.zip');
  assert.equal(pickWindowsAsset([a('tool-win64.zip')]).name, 'tool-win64.zip');
});

test('只有 mac/linux 资产时返回 null（不得误报支持 Windows）', () => {
  const a = n => ({ name:n, browser_download_url:'u', size:1 });
  assert.equal(pickWindowsAsset([a('app-darwin-arm64.zip'), a('app-linux-x86_64.tar.gz')]), null);
});

test('优先选择安装包而不是压缩包', () => {
  const a = n => ({ name:n, browser_download_url:'u', size:1 });
  assert.equal(pickWindowsAsset([a('app-windows.zip'), a('app-setup.exe')]).name, 'app-setup.exe');
});

test('空数组与非法输入返回 null 而不抛错', () => {
  assert.equal(pickWindowsAsset([]), null);
  assert.equal(pickWindowsAsset(null), null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/releases.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

按优先级匹配：`.exe` > `.msi` > 含 `windows`/`win64`/`win32` 的压缩包；显式排除含 `darwin`/`macos`/`linux` 的名字。`fetchLatestRelease` 请求 `/repos/{ownerRepo}/releases/latest`，404 时返回 `null`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/releases.test.mjs`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/sources/releases.mjs test/releases.test.mjs
git commit -m "feat(sources): Windows 安装包识别"
```

### Task 12: 涨星速度五级降级

**Files:**
- Create: `src/sources/star-velocity.mjs`, `src/sources/events.mjs`, `test/star-velocity.test.mjs`

**Interfaces:**
- Consumes: `client`、`db`（snapshots / star_history）、`trendingItems`
- Produces:
  - `resolveVelocity(repo, ctx): Promise<{ gained7d, gained3d, level, confidence, source }>`
  - `confidence ∈ 'measured' | 'reported' | 'estimated'`
  - `level ∈ 0|1|2|3|4`（对应 spec §7.2 表）
  - `estimateFromEvents(watchEvents: {created_at:string}[], now: Date): { perHour: number, gained7d: number } | null`
  - `ctx = { client, db, trendingByRepo: Map<string, TrendingItem>, now: Date }`

- [ ] **Step 1: 写失败测试** `test/star-velocity.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVelocity, estimateFromEvents } from '../src/sources/star-velocity.mjs';

const repo = { ownerRepo:'a/b', createdAt:'2026-10-05T00:00:00Z', stars: 500 };
const now = new Date('2026-10-10T00:00:00Z');

test('7 天内新建的仓库用总收藏数作为 7 日增量（measured）', async () => {
  const v = await resolveVelocity(repo, { client:{}, db:null, trendingByRepo:new Map(), now });
  assert.equal(v.level, 1);
  assert.equal(v.gained7d, 500);
  assert.equal(v.confidence, 'measured');
});

test('trending 页报告的涨星优先于估算（reported）', async () => {
  const t = new Map([['a/b', { starsThisWeek: 800, starsToday: 100 }]]);
  const v = await resolveVelocity({ ...repo, createdAt:'2020-01-01T00:00:00Z' }, { client:{}, db:null, trendingByRepo:t, now });
  assert.equal(v.level, 2);
  assert.equal(v.confidence, 'reported');
  assert.equal(v.gained7d, 800);
});

test('有快照差值时用实测差值（measured）', async () => {
  const db = { getSnapshot: (id, date) => date === '2026-10-03' ? { stars: 300 } : null };
  const v = await resolveVelocity({ ...repo, createdAt:'2020-01-01T00:00:00Z' }, { client:{}, db, trendingByRepo:new Map(), now });
  assert.equal(v.level, 3);
  assert.equal(v.gained7d, 200);
  assert.equal(v.confidence, 'measured');
});

test('全部不可用时兜底为估算且必须标记 estimated', async () => {
  const client = { getJson: async () => [{ created_at:'2026-10-09T12:00:00Z' }, { created_at:'2026-10-10T00:00:00Z' }] };
  const v = await resolveVelocity({ ...repo, createdAt:'2020-01-01T00:00:00Z' }, { client, db:{ getSnapshot:()=>null }, trendingByRepo:new Map(), now });
  assert.equal(v.level, 4);
  assert.equal(v.confidence, 'estimated');
  assert.ok(Number.isFinite(v.gained7d) && v.gained7d >= 0);
});

test('没有任何数据来源时返回 0 且不抛错', async () => {
  const v = await resolveVelocity({ ...repo, createdAt:'2020-01-01T00:00:00Z' },
    { client:{ getJson: async () => null }, db:null, trendingByRepo:new Map(), now });
  assert.equal(v.gained7d, 0);
  assert.equal(v.confidence, 'estimated');
});

test('estimateFromEvents 在窗口为 0 时返回 null 而不是除零', () => {
  assert.equal(estimateFromEvents([{ created_at:'2026-10-10T00:00:00Z' }], now), null);
  assert.equal(estimateFromEvents([], now), null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/star-velocity.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`resolveVelocity` 依次尝试 5 级，命中即返回并带对应 `level`/`confidence`：

- 级别 0：若 `repo.ageWeeks <= 30` 且 `client` 支持时调用 `/repos/{id}/stargazers/history?per_page=30`（请求头 `X-GitHub-Api-Version: 2026-03-10`），按周桶展开日线累加最近 7 天与 3 天。**该级必须能优雅失败**：404/403/结构不符即视为不可用并继续下降（开放项 O1）。
- 级别 1：`createdAt` 距今 ≤ 7 天 → `gained7d = repo.stars`，`confidence='measured'`。
- 级别 2：`trendingByRepo` 有该仓库且 `starsThisWeek > 0` → `confidence='reported'`。
- 级别 3：`db.getSnapshot(id, 今天-7天)` 存在 → 差值，`confidence='measured'`。
- 级别 4：`events.mjs` 拉 `/repos/{id}/events?per_page=100`，`estimateFromEvents` 用 `watchCount / windowHours * 168` 外推 → `confidence='estimated'`。

`gained3d` 仅在级别 0/3 有日线数据时提供，否则为 `null`。所有对外部返回值的读取都要做防御性检查。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/star-velocity.test.mjs`
Expected: PASS（6 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/sources/star-velocity.mjs src/sources/events.mjs test/star-velocity.test.mjs
git commit -m "feat(sources): 涨星速度五级降级与置信度"
```

### Task 13: 中文文档检测与口碑输入

**Files:**
- Create: `src/enrich/readme.mjs`, `src/enrich/health.mjs`, `test/readme.test.mjs`

**Interfaces:**
- Consumes: 注入的 `fetchText`（raw.githubusercontent，0 API 额度）、`repo.defaultBranch`
- Produces:
  - `detectChinese({ readmeText, extraFiles }): { hasChinese: boolean, ratio: number, localizedFiles: string[] }`
  - `fetchChineseEvidence(fetchText, ownerRepo, defaultBranch): Promise<{ readmeText, extraFiles: Record<string,string> }>`
  - `buildReputationInput(repo, { growing }): ReputationInput`

- [ ] **Step 1: 写失败测试** `test/readme.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChinese } from '../src/enrich/readme.mjs';

test('中文占比达到 3% 判定为有中文', () => {
  const zh = '这是一个很好用的工具，可以帮你处理文件。'.repeat(20);
  assert.equal(detectChinese({ readmeText: zh, extraFiles: {} }).hasChinese, true);
});

test('纯英文 README 判定为无中文', () => {
  const en = 'A very useful tool that helps you process files. '.repeat(20);
  const r = detectChinese({ readmeText: en, extraFiles: {} });
  assert.equal(r.hasChinese, false);
  assert.equal(r.ratio, 0);
});

test('只有零星中文字符（如作者名）不误判为有中文', () => {
  const mostlyEn = ('This is a tool. '.repeat(200)) + '张三';
  assert.equal(detectChinese({ readmeText: mostlyEn, extraFiles: {} }).hasChinese, false);
});

test('存在 README.zh-CN.md 等本地化文件时判定有中文并记录文件名', () => {
  const en = 'English only. '.repeat(100);
  const r = detectChinese({ readmeText: en, extraFiles: { 'README.zh-CN.md': '中文内容' } });
  assert.equal(r.hasChinese, true);
  assert.deepEqual(r.localizedFiles, ['README.zh-CN.md']);
});

test('空输入不抛错', () => {
  assert.equal(detectChinese({ readmeText: '', extraFiles: {} }).hasChinese, false);
  assert.equal(detectChinese({ readmeText: null, extraFiles: null }).hasChinese, false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/readme.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

CJK 字符集 `[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]`，`ratio = 命中数 / 文本长度`，阈值 `0.03`（spec §6.1）。`extraFiles` 的键名匹配 `/(^|\/)(README|readme)[._-]?(zh|cn|zh-CN|zh_CN)/` 或 `/\.zh(-|_)?(CN|TW|HK)?\.md$/`。`fetchChineseEvidence` 请求 `https://raw.githubusercontent.com/{ownerRepo}/{defaultBranch}/README.md` 与若干候选本地化文件名（大写/小写、zh-CN/CN/zh 变体，最多 4 次）。`buildReputationInput` 把 repo 字段映射为 `scoreReputation` 所需形状。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/readme.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/enrich/readme.mjs src/enrich/health.mjs test/readme.test.mjs
git commit -m "feat(enrich): 中文文档检测与口碑输入"
```

### Task 14: 可落地性分级与安装向导生成

**Files:**
- Create: `src/enrich/runnability.mjs`, `test/runnability.test.mjs`

**Interfaces:**
- Consumes: `lookupNpm`/`lookupPyPI`（Task 10）、`pickWindowsAsset`（Task 11）、`detectChinese`（Task 13）
- Produces:
  - `classifyRunnability({ releases, npm, pypi, manifests, chinese, localEnv }): Runnability`
  - `Runnability = { kind, command, downloadUrl, evidence, verified, difficulty, chineseDoc, notes }`
  - `checkLocalEnv(): { node: {present, version}, npm: {present}, python: {present, version}, hints: string[] }`
  - `buildInstallGuide(runnability, localEnv): { steps: {title, body, command?}[], faq: {q, a}[] }`

- [ ] **Step 1: 写失败测试** `test/runnability.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunnability, buildInstallGuide } from '../src/enrich/runnability.mjs';

const local = { node:{ present:true, version:'24.21.0' }, npm:{ present:true }, python:{ present:true, version:'3.10.11' }, hints:[] };

test('未通过归属校验的 npm 包绝不产出安装命令', () => {
  const r = classifyRunnability({
    releases:null, pypi:null, manifests:{},
    npm:{ packageName:'markitdown', repoMatches:false, hasBin:true, osIncludesWin:true },
    chinese:{ hasChinese:false, localizedFiles:[] }, localEnv: local
  });
  assert.equal(r.verified, false);
  assert.equal(r.kind, 'none');
  assert.equal(r.command, null);
});

test('npm 有 bin 且支持 win32 → 绿色，命令为 npx', () => {
  const r = classifyRunnability({ releases:null, pypi:null, manifests:{},
    npm:{ packageName:'opencode-ai', repoMatches:true, hasBin:true, osIncludesWin:true },
    chinese:{ hasChinese:true, localizedFiles:['README.zh-CN.md'] }, localEnv: local });
  assert.equal(r.kind, 'npmBinWin');
  assert.equal(r.difficulty, 'green');
  assert.match(r.command, /^npx /);
  assert.equal(r.verified, true);
});

test('有 Windows 安装包时优先于 npm', () => {
  const r = classifyRunnability({ releases:{ windowsAsset:{ name:'app-setup.exe', url:'https://x/app-setup.exe' } },
    npm:{ packageName:'x', repoMatches:true, hasBin:true, osIncludesWin:true }, pypi:null, manifests:{},
    chinese:{ hasChinese:false, localizedFiles:[] }, localEnv: local });
  assert.equal(r.kind, 'releaseWindows');
  assert.equal(r.downloadUrl, 'https://x/app-setup.exe');
});

test('PyPI 版本与本机不兼容时降级而不是给出会失败的命令', () => {
  const r = classifyRunnability({ releases:null, npm:null, manifests:{},
    pypi:{ packageName:'x', version:'9.0.0', requiresPython:'>=3.12', compatible:false },
    chinese:{ hasChinese:false, localizedFiles:[] }, localEnv: local });
  assert.notEqual(r.kind, 'pypiCompatible');
  assert.ok(r.notes.some(n => n.includes('3.12')));
});

test('安装向导必有 3 步且第 2 步带命令', () => {
  const r = classifyRunnability({ releases:null, pypi:null, manifests:{},
    npm:{ packageName:'opencode-ai', repoMatches:true, hasBin:true, osIncludesWin:true },
    chinese:{ hasChinese:false, localizedFiles:[] }, localEnv: local });
  const g = buildInstallGuide(r, local);
  assert.equal(g.steps.length, 3);
  assert.ok(g.steps[1].command);
  assert.ok(g.faq.length >= 3);
});

test('本机缺 Node 时向导第 1 步要明确提示缺什么', () => {
  const g = buildInstallGuide({ kind:'npmBinWin', verified:true, difficulty:'green', command:'npx x' },
    { node:{ present:false, version:null }, npm:{ present:false }, python:{ present:true, version:'3.10.11' }, hints:[] });
  assert.match(g.steps[0].body, /Node/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/runnability.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`classifyRunnability` 按 spec §6.1 的 `RUNNABLE_POINTS` 优先级判定（releaseWindows > npmBinWin > pypiCompatible > npmNoBin > buildFromSource > dockerOnly > none）；**任何 `repoMatches !== true` 的包一律忽略**；`compatible === false` 的 PyPI 结果降级为 `npmNoBin` 级别以下并把原因写入 `notes`。`difficulty` 用 `calculateGrade(installPath 分值)`。`checkLocalEnv` 用 `node:child_process` 的 `execFileSync(..., { stdio: 'pipe' })` 探测 `node -v` / `npm -v` / `python --version`，失败即视为缺失（**注意：本机沙箱下子进程管道受限，若抛 EPERM 则视为"未知"，不得让整体失败**）。`buildInstallGuide` 生成固定三步与按 kind 分类的 FAQ。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/runnability.test.mjs`
Expected: PASS（6 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/enrich/runnability.mjs test/runnability.test.mjs
git commit -m "feat(enrich): 可落地性分级与三步安装向导"
```

### Task 15: collect 全流程、导出与 runs 记录

**Files:**
- Create: `src/collect.mjs`, `src/exporters/markdown.mjs`, `src/exporters/json.mjs`, `test/collect-offline.test.mjs`
- Modify: `src/cli.mjs`

**Interfaces:**
- Consumes: Task 7–14 全部
- Produces:
  - `runCollect({ db, client, sources, now, offline }): Promise<{ date, boards: BoardResult[], apiCalls, degraded, markdown, json }>`
  - `BoardResult = { id: 'weekly'|'newbie'|'classic', title: string, items: RankedItem[] }`（由 `buildBoard` 的数组结果包装而成，页面与导出都消费这个形状）
  - `renderDailyMarkdown(boards: BoardResult[], date): string`、`renderDailyJson(boards: BoardResult[], date): string`
  - `writeDailyFiles(dir, date, md, json)`

- [ ] **Step 1: 写失败测试** `test/collect-offline.test.mjs`（**离线端到端**）

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCollect } from '../src/collect.mjs';
import { openDb } from '../src/store/db.mjs';
import candidates from '../fixtures/candidates.json' with { type: 'json' };

test('离线跑完整流程：三个榜都有内容、条数正确、日报可生成', async () => {
  const db = openDb(':memory:');
  const r = await runCollect({
    db, offline: true, now: new Date('2026-10-10T00:00:00Z'),
    sources: { discover: async () => candidates, enrich: async (c) => c }
  });
  assert.equal(r.date, '2026-10-10');
  assert.ok(r.boards.find(b => b.id === 'weekly').items.length > 0);
  assert.ok(r.boards.find(b => b.id === 'classic').items.length <= 30);
  assert.ok(r.boards.every(b => b.items.every(i => typeof i.rank === 'number')));
  assert.equal(db.getRankings('2026-10-10', 'weekly').length, r.boards.find(b=>b.id==='weekly').items.length);
  db.close();
});

test('断网（offline）时不得抛错，且标记 degraded', async () => {
  const db = openDb(':memory:');
  const r = await runCollect({ db, offline:true, now:new Date('2026-10-10T00:00:00Z'),
    sources: { discover: async () => { throw new Error('ENETUNREACH'); }, enrich: async (c) => c } });
  assert.equal(r.degraded, true);
  assert.ok(Array.isArray(r.boards));
  db.close();
});

test('同一天重复运行不产生重复排名', async () => {
  const db = openDb(':memory:');
  const args = { db, offline:true, now:new Date('2026-10-10T00:00:00Z'), sources:{ discover: async()=>candidates, enrich: async(c)=>c } };
  await runCollect(args); const n1 = db.getRankings('2026-10-10','weekly').length;
  await runCollect(args); const n2 = db.getRankings('2026-10-10','weekly').length;
  assert.equal(n1, n2);
  db.close();
});

test('日报 Markdown 里估算值必须带"约"与"估算"', async () => {
  const db = openDb(':memory:');
  const est = candidates.map(c => ({ ...c, velocity: { gained7d: 100, gained3d: null, level: 4, confidence: 'estimated', source:'events' } }));
  const r = await runCollect({ db, offline:true, now:new Date('2026-10-10T00:00:00Z'), sources:{ discover: async()=>est, enrich: async(c)=>c } });
  assert.match(r.markdown, /约|估算/);
  db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/collect-offline.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`runCollect` 顺序：`discover`（异常则捕获 → 尝试从 `repos` 表用昨日数据重建，`degraded=true`）→ 逐候选 `enrich`（单个失败跳过并计数）→ `resolveVelocity` → `saveScores`/`saveRunnability`/`upsertSnapshot` → `buildBoard` × 3 → `saveRankings` → 生成 `markdown`/`json` 字符串（返回在结果里，便于测试）→ `startRun`/`finishRun` 记录 `api_calls` 与 `status`。`cli.mjs` 的 `collect` 分支调用它并把文件写到 `daily/`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/collect-offline.test.mjs`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/collect.mjs src/exporters src/cli.mjs test/collect-offline.test.mjs
git commit -m "feat(collect): 采集主流程、导出与降级"
```

---

## Phase 3：界面（M3–M4）

### Task 16: HTTP 服务与三个榜单页

**Files:**
- Create: `src/http/server.mjs`, `src/http/routes.mjs`, `public/index.html`, `public/app.js`, `public/style.css`, `test/http.test.mjs`
- Modify: `src/cli.mjs`

**Interfaces:**
- Consumes: `db.getRankings`、`db.getRunnability`、`db.getRepo`
- Produces:
  - `createServer({ db, demo }): http.Server`
  - `handleRequest(req, res, ctx): Promise<void>`
  - `GET /api/boards?date=YYYY-MM-DD&board=weekly|newbie|classic` → `{ board, date, items: [...] }`
  - `GET /api/repo/:owner/:repo` → 详情（含 `reasons`、`installGuide`、`confidence`）
  - `GET /api/dates` → 有数据的日期列表

- [ ] **Step 1: 写失败测试** `test/http.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http/server.mjs';
import { openDb } from '../src/store/db.mjs';

const start = (db) => new Promise(res => { const s = createServer({ db }).listen(0, () => res({ s, port: s.address().port })); });

test('三个榜单接口都返回 200 与 items 数组', async () => {
  const db = openDb(':memory:');
  db.saveRankings('2026-10-10', 'weekly', [{ rank:1, ownerRepo:'a/b', score: 80 }]);
  const { s, port } = await start(db);
  for (const b of ['weekly','newbie','classic']) {
    const r = await fetch(`http://127.0.0.1:${port}/api/boards?date=2026-10-10&board=${b}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray((await r.json()).items));
  }
  s.close(); db.close();
});

test('非法 board 名称返回 400 而不是崩溃', async () => {
  const db = openDb(':memory:'); const { s, port } = await start(db);
  const r = await fetch(`http://127.0.0.1:${port}/api/boards?board=evil`);
  assert.equal(r.status, 400);
  s.close(); db.close();
});

test('数据库为空时接口返回空 items，页面不报错', async () => {
  const db = openDb(':memory:'); const { s, port } = await start(db);
  const r = await fetch(`http://127.0.0.1:${port}/api/boards?board=weekly`);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).items, []);
  s.close(); db.close();
});

test('不存在的仓库详情返回 404', async () => {
  const db = openDb(':memory:'); const { s, port } = await start(db);
  const r = await fetch(`http://127.0.0.1:${port}/api/repo/nope/nope`);
  assert.equal(r.status, 404);
  s.close(); db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/http.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`node:http` 手写路由（精确匹配 + 一个路径参数解析），静态文件从 `public/` 读取并按扩展名设置 `Content-Type`。`index.html` + `app.js` 渲染三个榜签、卡片列表、筛选条（🟢 一键就能玩 / 🈶 有中文说明 / 语言）、点击卡片打开详情抽屉。**所有文案走 spec §4.3 翻译表，不得出现 star/fork/issue。** `--demo` 时若数据库为空则加载 `fixtures/`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/http.test.mjs`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/http public src/cli.mjs test/http.test.mjs
git commit -m "feat(web): 三榜单接口与静态界面"
```

### Task 17: 安装向导界面与本机预检

**Files:**
- Modify: `public/app.js`, `public/index.html`, `public/style.css`, `src/http/routes.mjs`
- Create: `test/install-guide-api.test.mjs`

**Interfaces:**
- Consumes: `checkLocalEnv`（Task 14）、`buildInstallGuide`（Task 14）
- Produces: `GET /api/local-env` → `checkLocalEnv()` 的结果；详情接口的 `installGuide.steps` 必须包含三步与可复制命令

- [ ] **Step 1: 写失败测试** `test/install-guide-api.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http/server.mjs';
import { openDb } from '../src/store/db.mjs';

test('详情接口返回三步安装向导与置信度标注', async () => {
  const db = openDb(':memory:');
  db.upsertRepo({ ownerRepo:'a/b', stars:1000, language:'Go', defaultBranch:'main', archived:false, license:'MIT', pushedAt:'2026-10-09T00:00:00Z' });
  db.saveRunnability('a/b', { kind:'npmBinWin', command:'npx x', verified:true, difficulty:'green', chineseDoc:true, notes:[] });
  db.saveScores('a/b', '2026-10-10', { hot:20, reputation:20, runnable:25, total:65, confidence:'estimated', reasons:['本周新增收藏约 100（估算）'] });
  const s = createServer({ db }).listen(0); await new Promise(r => s.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${s.address().port}/api/repo/a/b`);
  const j = await res.json();
  assert.equal(j.installGuide.steps.length, 3);
  assert.equal(j.installGuide.steps[1].command, 'npx x');
  assert.match(j.reasons.join(' '), /估算/);
  s.close(); db.close();
});

test('/api/local-env 返回探测结果且失败时不 500', async () => {
  const db = openDb(':memory:'); const s = createServer({ db }).listen(0);
  await new Promise(r => s.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${s.address().port}/api/local-env`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok('node' in j && 'python' in j);
  s.close(); db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/install-guide-api.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

详情接口组装 `installGuide`（用存库的 runnability + 实时 `checkLocalEnv()`）；新增 `/api/local-env`。前端抽屉渲染三步、命令框 + 一键复制（`navigator.clipboard`，失败时回退到 `document.execCommand`）、FAQ 折叠、以及"⚙️ 实验功能"区块（Task 18 之前只显示"该功能默认关闭"的说明与禁用按钮）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/install-guide-api.test.mjs`
Expected: PASS（2 个测试）

- [ ] **Step 5: 提交**

```bash
git add public src/http/routes.mjs test/install-guide-api.test.mjs
git commit -m "feat(web): 三步安装向导与本机预检"
```

### Task 18: 离线 demo 与历史日期回看

**Files:**
- Create: `fixtures/demo/seed.mjs`, `test/demo.test.mjs`
- Modify: `src/cli.mjs`, `public/app.js`

**Interfaces:**
- Consumes: `openDb`、`runCollect`
- Produces:
  - `seedDemoData(db): void`（把 fixture 榜单写入指定日期的三个榜）
  - `cli serve --demo` 在数据库为空时自动 seeding；`--offline` 时只读本地不联网

- [ ] **Step 1: 写失败测试** `test/demo.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.mjs';
import { seedDemoData } from '../fixtures/demo/seed.mjs';

test('demo 数据能填满三个榜单且不联网', () => {
  const db = openDb(':memory:');
  seedDemoData(db);
  assert.ok(db.getRankings('2026-10-10', 'weekly').length > 0);
  assert.ok(db.getRankings('2026-10-10', 'newbie').length > 0);
  assert.ok(db.getRankings('2026-10-10', 'classic').length > 0);
  db.close();
});

test('seed 幂等：重复调用不产生重复', () => {
  const db = openDb(':memory:');
  seedDemoData(db); const a = db.getRankings('2026-10-10','weekly').length;
  seedDemoData(db); const b = db.getRankings('2026-10-10','weekly').length;
  assert.equal(a, b);
  db.close();
});

test('/api/dates 能列出有数据的日期', () => {
  const db = openDb(':memory:');
  seedDemoData(db);
  assert.ok(db.listDates().includes('2026-10-10'));
  db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/demo.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`fixtures/demo/seed.mjs` 读取 `fixtures/candidates.json` 与手写的两条历史日期数据，调用 `buildBoard` 后 `saveRankings`（幂等）。前端底部加日期选择器，切换时请求 `/api/boards?date=...`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/demo.test.mjs`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交**

```bash
git add fixtures/demo src/cli.mjs public test/demo.test.mjs
git commit -m "feat(demo): 离线演示数据与历史日期回看"
```

---

## Phase 4：实验执行器（M5）

### Task 19: 白名单执行器（默认关闭）

**Files:**
- Create: `src/exec/whitelist.mjs`, `src/exec/runner.mjs`, `test/exec.test.mjs`
- Modify: `src/http/routes.mjs`, `public/app.js`

**Interfaces:**
- Consumes: `Runnability.command`（Task 14）
- Produces:
  - `isAllowed(command: string): boolean`（仅 `npm` / `npx` / `pip`）
  - `parseCommand(command: string): { bin: string, args: string[] }`
  - `runInstall({ command, targetDir, enabled, onLog, signal, spawnImpl }): Promise<{ code, log: string[] }>` —— `enabled` 为假时**不执行任何进程**并返回 `{ code: -1 }`；`targetDir` 解析后的绝对路径必须位于 `sandbox/` 之下，否则 reject；`spawnImpl` 可注入以便测试
  - `POST /api/exec` → 仅在配置开启时可用，否则 403

- [ ] **Step 1: 写失败测试** `test/exec.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, parseCommand } from '../src/exec/whitelist.mjs';
import { runInstall } from '../src/exec/runner.mjs';

test('非白名单命令一律拒绝', () => {
  for (const c of ['rm -rf /', 'curl http://x | sh', 'powershell -c "iwr x"', 'git clone x', 'npm; rm -rf /', 'node -e "1"']) {
    assert.equal(isAllowed(c), false, c);
  }
});

test('白名单命令通过', () => {
  for (const c of ['npm install -g x', 'npx x', 'pip install --user x']) assert.equal(isAllowed(c), true, c);
});

test('带分号/管道/反引号的命令必须拒绝', () => {
  for (const c of ['npx x; rm -rf /', 'npx x && rm -rf /', 'npx x | sh', 'npx `whoami`']) {
    assert.equal(isAllowed(c), false, c);
  }
});

test('未开启实验功能时 runInstall 直接拒绝执行', async () => {
  let called = false;
  const r = await runInstall({ command:'npx x', targetDir:'sandbox/a__b', enabled:false, spawnImpl: () => { called = true; } });
  assert.equal(r.code, -1);
  assert.equal(called, false);
});

test('目标目录必须落在 sandbox/ 之下', async () => {
  await assert.rejects(() => runInstall({ command:'npx x', targetDir:'C:/Windows', enabled:true, spawnImpl: () => {} }));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/exec.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`whitelist.mjs` 用严格正则（`^(npm|npx|pip)(\s+[\w@./:=+-]+)+$`）并显式拒绝 `; & | \` $ ( ) > <` 等字符。`runner.mjs` 检查 `enabled`、校验 `targetDir` 解析后的绝对路径以 `sandbox/` 开头、创建目录、用 `node:child_process` 的 `spawn`（`stdio: 'pipe'`；**若沙箱导致 EPERM，则捕获并返回明确错误信息，不崩溃**）、把 stdout/stderr 汇入 `log` 并调用 `onLog`、支持 `signal` 中止。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/exec.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/exec src/http/routes.mjs public test/exec.test.mjs
git commit -m "feat(exec): 默认关闭的白名单安装执行器"
```

---

## Phase 5：文档与收尾（M6）

### Task 20: 中文使用手册、README 与离线演示验收

**Files:**
- Create: `docs/使用手册.md`, `README.md`, `docs/评分口径.md`
- Modify: `package.json`（加 `test:all` 脚本）

**Interfaces:**
- Consumes: 全部
- Produces: 面向纯新手的文档；README 首段必须说明与 spec §2.1 那批同类项目的区别

- [ ] **Step 1: 跑全量测试确认基线**

Run: `node --test test/`
Expected: 全部 PASS，且 `package.json` 中确认**没有 `dependencies` 字段**（用 `node -e "const p=require('./package.json');if(p.dependencies)process.exit(1)"` 验证）

- [ ] **Step 2: 写 `docs/使用手册.md`**

必含章节：这是什么（用小白语言）· 怎么第一次跑起来（含装 Node 的步骤）· 三个榜分别什么意思 · 评分公式全文 · 🟢🟡🔴 是什么意思 · 怎么让程序每天自动采集 · **常见问题：网络不通 / GitHub 额度用完 / 项目没有 Windows 版怎么办 / 装错了怎么卸载 / 实验功能有什么风险**。

- [ ] **Step 3: 写 `README.md` 与 `docs/评分口径.md`**

README 首段对比同类项目（引用 spec §2.1/§2.2 的事实），然后是截图位、30 秒跑起来的三条命令、`npm run demo` 说明。`docs/评分口径.md` 放出完整权重表与降级阶梯。

- [ ] **Step 4: 手工验收离线演示**

Run: `npm run demo`，浏览器打开输出的地址
Expected: 三个榜都有内容、卡片显示难度徽章与中文徽章、点开抽屉看到三步向导与"为什么上榜"、断网状态下依然可用。

- [ ] **Step 5: 提交**

```bash
git add docs README.md package.json
git commit -m "docs: 中文使用手册、README 与评分口径"
```

---

## 计划自审记录

- **Spec 覆盖**：§1（成功标准 → Task 20 验收）、§3（约束 → Global Constraints + Task 7）、§4（产品 → Task 16/17）、§5（架构/表 → Task 1/2）、§6（评分 → Task 3/4/5/6）、§7（涨星阶梯 → Task 12）、§8（容错 → Task 7/8/12/15）、§9（执行器 → Task 19）、§10（测试 → 每个任务的测试步骤）、§11（交付物 → Task 20）、§12（不做 → Global Constraints）、§13（扩展点 → 配置与接口分离，Task 3/6/7/12/16）、§14（里程碑 → 六个 Phase）、§15 的 O1 → Task 12 级别 0 的优雅失败。
- **类型一致性**：`Runnability.kind` 的取值在 Task 4（分值表）、Task 6（清单类判定）、Task 14（分级）三处保持一致；`confidence` 三值在 Task 3/5/12/15/17 一致；榜单 id `weekly|newbie|classic` 全程一致。
- **Review Focus 落点**：第 1 条 → Task 10；第 2 条 → Task 7/15/18；第 3 条 → Task 8；第 4 条 → Task 3；第 5 条 → Task 3/5/15/17。

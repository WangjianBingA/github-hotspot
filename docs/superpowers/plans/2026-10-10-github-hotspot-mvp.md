# GitHub 好玩榜 实现计划（v2 · 静态网站版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个零依赖、纯静态的"GitHub 版新手应用商店"网站：采集程序输出 JSON 榜单，网站读 JSON 展示三个榜单，并给每个项目生成经过核实的中文安装引导。

**Architecture:** `sources/`（拿数据，统一 `discover`/`enrich` 接口）→ `enrich/` + `score/`（确定性纯函数）→ `store/datastore.mjs`（读写 `public/data/*.json`，**文件即数据库**）→ `public/`（纯静态前端，可直接部署）。采集严格串行并受额度预算约束，网络失败逐级降级并标注置信度。评分不引入任何大模型。

**Tech Stack:** Node.js v24（实测）、内置 `fetch` / `node:http` / `node:test`；前端原生 HTML/CSS/JS；**运行时零第三方依赖**，**不使用数据库**。

**Spec:** `docs/superpowers/specs/2026-10-10-github-app-store-design.md`（v2）

## Global Constraints

- **零运行时依赖**：`package.json` 不得出现 `dependencies` 或 `devDependencies`。测试用内置 `node:test`。
- **不使用数据库**：数据一律是 `public/data/` 下的 JSON 文件（v2 决定，SQLite 已移除）。
- **Node ≥ 22**（实测 v24.21.0），使用内置 `fetch`、`node:test`、`node:http`。
- **纯静态**：`public/` 目录原样部署到任何静态托管都必须能工作；前端只能 `fetch` 同目录下的 JSON 文件，**不得依赖任何服务端接口**。
- **额度**：未认证 core 60/小时、search 10/分钟；每轮采集 core 请求**硬上限 45 次**，超出即停止富化并把 `degraded` 置为 `true`。检测到 `GITHUB_TOKEN` 时自动放宽。
- **严格串行**：同一域名同一时刻只允许 1 个在途请求（实测并发会把 github.com 打到超时）。
- **不假设分支名**：任何 raw 文件请求必须使用 API 返回的 `defaultBranch`。
- **包名归属校验**：npm/PyPI 包必须确认其 `repository.url` 指向目标仓库，否则**不产出安装命令**（宁可无引导，不可错引导）。
- **界面文案**：不得出现 star / fork / issue / archived 等行话，必须用 spec §4.3 翻译表。
- **置信度必须标注**：估算值显示"约 N（估算）"，实测值显示"N（实测）"。
- **无执行能力**：网站不得试图在用户机器上执行任何操作（v2 已移除执行器）。
- **界面只有中文。**
- **榜单 id 固定** `weekly` / `newbie` / `classic`；条数 **15 / 15 / 30**。
- **路径**：数据 `public/data/`，日报 `daily/YYYY-MM-DD.md`，本地缓存 `data/cache.json`（gitignored）。
- **幂等**：同一天重复采集只覆盖同一个 `YYYY-MM-DD.json`，不产生重复条目。
- 日期键统一 UTC，格式 `YYYY-MM-DD`。

## Review Focus

以下行为 spec 隐含、但没哪个任务天然会测到、且最可能真正坑到使用者。每条都钉在对应任务的测试里：

1. **同名包导致装错软件**：npm 上搜 `markitdown` 会命中**另一个作者**的包。程序必须核对 `repository.url`，不匹配时**不给安装命令**，而不是给一条会装错东西的命令。（Task 10）
2. **断网或额度耗尽时页面不能崩成白屏**：采集应降级（`degraded: true`）并用既有数据出榜；网站仍能打开并明确提示"本期数据不完整"。（Task 7、Task 15、Task 16）
3. **trending 页面改版**：HTML 结构一变、"stars today" 抓不到时，解析器必须返回空数组并降级，不得抛未捕获异常导致整轮采集失败。（Task 8）
4. **历史 JSON 损坏或缺失**：读历史文件失败时当作缺数据（给中性分），**不得让整轮采集失败**；新项目没有历史也不该被惩罚。（Task 12、Task 13）
5. **估算值被当成事实展示**：涨星来自 Events 外推（`confidence: estimated`）时，界面与日报都必须显示"约/估算"。（Task 3、Task 5、Task 15、Task 17）

---

## Phase 0：骨架与数据层

### Task 1: 项目骨架与测试跑通

**Files:**
- Create: `package.json`, `.gitignore`, `src/cli.mjs`, `test/smoke.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `npm test` / `npm run collect` / `npm start` / `npm run demo` 四个脚本；`src/cli.mjs` 导出 `main(argv: string[]): Promise<number>`

- [ ] **Step 1: 写失败测试** `test/smoke.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.mjs';

test('未知命令返回非零并打印用法', async () => {
  const code = await main(['nope']);
  assert.equal(code, 2);
});

test('package.json 不得含任何依赖', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/smoke.test.mjs`
Expected: FAIL（`Cannot find module '../src/cli.mjs'`）

- [ ] **Step 3: 实现骨架**

`package.json`：`{"name":"github-hotspot","private":true,"type":"module","engines":{"node":">=22"},"scripts":{"test":"node --test test/","collect":"node src/cli.mjs collect","start":"node src/cli.mjs serve","demo":"node src/cli.mjs serve --demo"}}`。

`.gitignore`：`node_modules/`、`data/`、`fixtures/last-good/`。

`src/cli.mjs`：导出 `main(argv)`，`switch(argv[0])` 分发 `collect|serve|export`（本任务先返回 0 占位），未知命令向 stderr 打印用法并返回 2。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/smoke.test.mjs`
Expected: PASS（2 个测试）

- [ ] **Step 5: 提交**

```bash
git add package.json .gitignore src/cli.mjs test/smoke.test.mjs
git commit -m "chore: 项目骨架与零依赖测试入口"
```

### Task 2: JSON 数据层

**Files:**
- Create: `src/store/datastore.mjs`, `test/datastore.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces（后续任务都按这些签名调用）：
  - `readDaily(dataDir, date): DailyFile | null`
  - `writeDaily(dataDir, date, payload): void`（原子写：先写临时文件再 rename）
  - `updateIndex(dataDir): string[]`（扫描 `*.json` 生成 `index.json`，返回日期列表降序）
  - `listDates(dataDir): string[]`
  - `readSnapshotStars(dataDir, date): Map<string, number>`（读某天榜单里所有仓库的收藏数）
  - `appendHistory(dataDir, date, snapshotMap): void` / `readHistory(dataDir, month): object`
  - `readJsonSafe(filePath, fallback)`（损坏/缺失时返回 fallback，绝不抛错）

- [ ] **Step 1: 写失败测试** `test/datastore.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDaily, writeDaily, listDates, updateIndex, readSnapshotStars, appendHistory, readHistory, readJsonSafe
} from '../src/store/datastore.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'hs-'));
const payload = (date, stars) => ({
  date, generatedAt: `${date}T00:00:00Z`, degraded: false,
  boards: [
    { id:'weekly', title:'本周飙升', items:[{ rank:1, ownerRepo:'a/b', stars, scores:{ total: 80 } }] },
    { id:'newbie', title:'新手能玩', items:[] },
    { id:'classic', title:'经典必玩', items:[] }
  ]
});

test('写入后能读回，同一天重复写只保留最新', () => {
  const d = dir();
  writeDaily(d, '2026-10-10', payload('2026-10-10', 100));
  writeDaily(d, '2026-10-10', payload('2026-10-10', 120));
  assert.equal(readDaily(d, '2026-10-10').boards[0].items[0].stars, 120);
});

test('listDates 返回降序日期且忽略 index.json', () => {
  const d = dir();
  writeDaily(d, '2026-10-08', payload('2026-10-08', 1));
  writeDaily(d, '2026-10-10', payload('2026-10-10', 1));
  updateIndex(d);
  assert.deepEqual(listDates(d), ['2026-10-10', '2026-10-08']);
});

test('readSnapshotStars 汇总所有榜单里的收藏数', () => {
  const d = dir();
  writeDaily(d, '2026-10-10', payload('2026-10-10', 777));
  assert.equal(readSnapshotStars(d, '2026-10-10').get('a/b'), 777);
  assert.equal(readSnapshotStars(d, '2026-01-01').size, 0);   // 不存在 → 空 Map
});

test('历史可追加且同一天重复追加幂等', () => {
  const d = dir();
  appendHistory(d, '2026-10-10', new Map([['a/b', { stars: 100, forks: 5 }]]));
  appendHistory(d, '2026-10-10', new Map([['a/b', { stars: 150, forks: 6 }]]));
  assert.equal(readHistory(d, '2026-10')[ '2026-10-10']['a/b'].stars, 150);
});

test('损坏的 JSON 文件不会让读取抛错', () => {
  const d = dir();
  writeFileSync(join(d, '2026-10-09.json'), '{ 这不是合法 JSON');
  assert.equal(readDaily(d, '2026-10-09'), null);
  assert.deepEqual(readJsonSafe(join(d, '2026-10-09.json'), { ok: true }), { ok: true });
  assert.deepEqual(listDates(d), []);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/datastore.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现 `src/store/datastore.mjs`**

用 `node:fs`。`writeDaily` 写 `join(dataDir, date + '.json')`，先写 `.tmp` 再 `renameSync` 保证原子性。`listDates` 用 `readdirSync` 过滤 `/^\d{4}-\d{2}-\d{2}\.json$/` 并降序。`readSnapshotStars` 遍历 `boards[].items[]` 收集 `ownerRepo → stars`。`appendHistory` 写 `history/YYYY-MM.json`，以日期为键、`ownerRepo` 为二级键做覆盖（幂等）。`readJsonSafe` 用 try/catch。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/datastore.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/store/datastore.mjs test/datastore.test.mjs
git commit -m "feat(store): JSON 数据层（文件即数据库）"
```

---

## Phase 1：评分核心（M1）

### Task 3: 热度分（含数值边界）

**Files:**
- Create: `src/config/weights.mjs`, `src/score/score.mjs`, `test/score-hot.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `src/config/weights.mjs` 导出 `WEIGHTS={hot:45,reputation:30,runnable:25}`、`HOT_REFERENCE_STARS_PER_WEEK=3000`、`BOARD_SIZES={weekly:15,newbie:15,classic:30}`、`DETAIL_WEIGHTS={forkRatio:8,pushRecency:8,release90d:6,license:4,growth:4}`（2026-10-10 起；五项之和必须 = 30 = `WEIGHTS.reputation`）、`RUNNABLE_POINTS={releaseWindows:18,npmBinWin:16,pypiCompatible:14,npmNoBin:8,buildFromSource:6,dockerOnly:4,none:0}`、`CHINESE_POINTS={readmeRatio:4,localizedFile:3}`、`CHINESE_RATIO_THRESHOLD=0.03`
  - `scoreHot({ starsGained7d }): number` —— 返回 0–45

- [ ] **Step 1: 写失败测试** `test/score-hot.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreHot } from '../src/score/score.mjs';
import { WEIGHTS, HOT_REFERENCE_STARS_PER_WEEK } from '../src/config/weights.mjs';

test('新增收藏为 0 时得 0 分，不得为 NaN', () => {
  assert.equal(scoreHot({ starsGained7d: 0 }), 0);
});

test('达到参考值时拿满分', () => {
  assert.equal(scoreHot({ starsGained7d: HOT_REFERENCE_STARS_PER_WEEK }), WEIGHTS.hot);
});

test('55 万星级项目的巨量新增也封顶在满分，不溢出', () => {
  const s = scoreHot({ starsGained7d: 200000 });
  assert.equal(s, WEIGHTS.hot);
  assert.ok(Number.isFinite(s));
});

test('小项目不因数值小而得负分或 NaN', () => {
  assert.ok(scoreHot({ starsGained7d: 1 }) > 0);
});

test('缺失或非法输入按 0 处理而不是抛错', () => {
  assert.equal(scoreHot({ starsGained7d: undefined }), 0);
  assert.equal(scoreHot({ starsGained7d: -5 }), 0);
  assert.equal(scoreHot({ starsGained7d: NaN }), 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/score-hot.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`weights.mjs` 按 spec §6.1 填常量。`scoreHot`：`v = Number.isFinite(x) && x > 0 ? x : 0`，返回 `Math.min(WEIGHTS.hot, WEIGHTS.hot * Math.log10(1+v) / Math.log10(1+HOT_REFERENCE_STARS_PER_WEEK))`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/score-hot.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/config/weights.mjs src/score/score.mjs test/score-hot.test.mjs
git commit -m "feat(score): 热度分与 log 归一化边界"
```

### Task 4: 口碑分、新手友好分、总分、等级与门槛

**Files:**
- Modify: `src/score/score.mjs`
- Create: `test/score-reputation.test.mjs`, `test/score-runnable.test.mjs`

**Interfaces:**
- Consumes: `WEIGHTS`、`DETAIL_WEIGHTS`、`RUNNABLE_POINTS`、`CHINESE_POINTS`
- Produces:
  - `scoreReputation(repo, extra): { total: number, parts: Record<string, number> }`
  - `scoreRunnable(runnability): { total: number, parts: { installPath: number, chinese: number } }`（名字沿用 v1，含义为"新手友好度"）
  - `scoreRepo(input): { hot, reputation, runnable, total, grade, confidence, parts }`
  - `calculateGrade(installPathScore): 'green' | 'yellow' | 'red'`
  - `passesGates(repo, runnability): { ok: boolean, reasons: string[] }`
  - `repo` 形状：`{ ownerRepo, stars, forks, openIssues, closedIssues, pushedAt, license, archived, language, hasRelease90d }`
  - `runnability` 形状：`{ kind, verified, chineseDoc }`，`kind` 取自 `RUNNABLE_POINTS` 的键

- [ ] **Step 1: 写失败测试**

```js
// test/score-reputation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreReputation, passesGates } from '../src/score/score.mjs';
import { DETAIL_WEIGHTS, WEIGHTS } from '../src/config/weights.mjs';

const base = { ownerRepo:'a/b', stars:1000, forks:150, openIssues:20, closedIssues:80,
  pushedAt: new Date().toISOString(), license:'MIT', archived:false, language:'Go', hasRelease90d:true };

test('各子项满分时口碑分等于 30', () => {
  assert.equal(scoreReputation(base, { growing: true }).total, 30);
});

test('口碑五项之和恰为 30，防止日后改单项却忘了总和', () => {
  assert.equal(Object.values(DETAIL_WEIGHTS).reduce((a, b) => a + b, 0), WEIGHTS.reputation);
  assert.equal(WEIGHTS.reputation, 30);
});

test('新项目没有历史增长数据时不惩罚，给中性分', () => {
  const r = scoreReputation(base, { growing: null });
  assert.equal(r.parts.growth, 2);         // 4 分的一半
});

test('archived 仓库被门槛挡下并给出原因', () => {
  const g = passesGates({ ...base, archived: true }, { kind:'npmBinWin', verified:true });
  assert.equal(g.ok, false);
  assert.match(g.reasons.join(','), /停止维护/);
});

test('无许可证 / 收藏不足 / 无已核实安装路径分别被挡下', () => {
  assert.equal(passesGates({ ...base, license:null }, { kind:'npmBinWin', verified:true }).ok, false);
  assert.equal(passesGates({ ...base, stars:50 }, { kind:'npmBinWin', verified:true }).ok, false);
  assert.equal(passesGates(base, { kind:'npmBinWin', verified:false }).ok, false);
});

test('超过 7 天没提交被门槛挡下', () => {
  const old = { ...base, pushedAt: '2026-09-01T00:00:00Z' };
  assert.equal(passesGates(old, { kind:'npmBinWin', verified:true }, new Date('2026-10-10T00:00:00Z')).ok, false);
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

test('中文分封顶 7 分', () => {
  assert.equal(scoreRunnable({ kind:'pypiCompatible', chineseDoc:true }).parts.chinese, 7);
});

test('未知 kind 得 0 分而不是 NaN', () => {
  assert.equal(scoreRunnable({ kind:'奇怪的kind', chineseDoc:false }).parts.installPath, 0);
});

test('难度分级：18/16 绿，14/8 黄，6/4/0 红', () => {
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

`scoreReputation` 按 spec §6.1 表逐项算并返回 `parts`；`extra.growing` 为 `null`/`undefined` 时 `growth` 给 `DETAIL_WEIGHTS.growth / 2`。`scoreRunnable` 用 `RUNNABLE_POINTS[kind] ?? 0`，中文分在 `chineseDoc === true` 时给 `CHINESE_POINTS.readmeRatio + CHINESE_POINTS.localizedFile`。`scoreRepo` 汇总并算 `total`、`grade = calculateGrade(parts.installPath)`、透传 `confidence`。`passesGates(repo, runnability, now = new Date())` 检查 spec §6.2 六条门槛，返回**全部**未通过的中文原因（"已停止维护" / "没有开源许可证" / "超过 7 天没有更新" / "收藏人数不足 200" / "没有已核实的安装方式" / "这是资料清单，不是能装的软件"）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/score-reputation.test.mjs test/score-runnable.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/score/score.mjs test/score-reputation.test.mjs test/score-runnable.test.mjs
git commit -m "feat(score): 口碑分、新手友好分、总分与门槛"
```

### Task 5: 上榜理由与置信度文案

**Files:**
- Create: `src/score/reasons.mjs`, `test/reasons.test.mjs`

**Interfaces:**
- Consumes: `scoreRepo` 输出、`velocity`、`runnability`
- Produces: `buildReasons({ score, repo, velocity, runnability }): string[]`；`formatVelocityText(velocity): string`

- [ ] **Step 1: 写失败测试** `test/reasons.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReasons, formatVelocityText } from '../src/score/reasons.mjs';

test('实测不带"约"，估算必须带"约"与"估算"', () => {
  assert.equal(formatVelocityText({ gained7d: 1234, confidence: 'measured' }), '本周新增收藏 1,234（实测）');
  assert.equal(formatVelocityText({ gained7d: 1234, confidence: 'estimated' }), '本周新增收藏约 1,234（估算）');
  assert.equal(formatVelocityText({ gained7d: 1234, confidence: 'reported' }), '本周新增收藏 1,234（GitHub 官方数据）');
});

test('理由里必须出现安装方式与中文信息', () => {
  const rs = buildReasons({
    score: { parts: { installPath: 18, chinese: 7 } },
    repo: { pushedAt: new Date().toISOString() },
    velocity: { gained7d: 500, confidence: 'measured' },
    runnability: { kind: 'releaseWindows', chineseDoc: true }
  });
  assert.ok(rs.some(r => r.includes('Windows')));
  assert.ok(rs.some(r => r.includes('中文')));
});

test('理由中不得出现行话或字段名', () => {
  const rs = buildReasons({ score:{ parts:{ installPath:18, chinese:0 } },
    repo:{ pushedAt: new Date().toISOString() },
    velocity:{ gained7d:10, confidence:'measured' },
    runnability:{ kind:'releaseWindows', chineseDoc:false } });
  assert.ok(rs.every(r => !/\b(star|fork|issue)s?\b/i.test(r)));
  assert.ok(rs.every(r => !/[a-z]+_[a-z]+/.test(r)));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/reasons.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`formatVelocityText` 三种 confidence 三种文案，千分位用 `toLocaleString('zh-CN')`。`buildReasons` 从 `runnability.kind`、`chineseDoc`、`pushedAt` 距今天数、`velocity` 生成 3–5 条中文短句，全部走 spec §4.3 翻译表。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/reasons.test.mjs`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/score/reasons.mjs test/reasons.test.mjs
git commit -m "feat(score): 中文上榜理由与置信度文案"
```

### Task 6: 榜单组装（离线可测）

**Files:**
- Create: `src/config/boards.mjs`, `src/boards/build.mjs`, `test/boards.test.mjs`, `fixtures/candidates.json`

**Interfaces:**
- Consumes: `scoreRepo`、`passesGates`、`BOARD_SIZES`
- Produces:
  - `src/config/boards.mjs` 导出 `BOARDS = [{ id:'weekly', title:'本周飙升', size:15, sortBy:'total' }, { id:'newbie', title:'新手能玩', size:15, sortBy:'runnable' }, { id:'classic', title:'经典必玩', size:30, sortBy:'stars' }]`
  - `buildBoard(boardId, items, now?): RankedItem[]`，`items` 为 `{ repo, runnability, velocity, extra }[]`，`RankedItem = { rank, repo, runnability, velocity, score, grade, chineseDoc, reasons }`

- [ ] **Step 1: 写失败测试** `test/boards.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard } from '../src/boards/build.mjs';
import candidates from '../fixtures/candidates.json' with { type: 'json' };

const NOW = new Date('2026-10-10T00:00:00Z');

test('周榜遵守 15 条上限且按总分降序', () => {
  const b = buildBoard('weekly', candidates, NOW);
  assert.equal(b.length, 15);
  for (let i = 1; i < b.length; i++) assert.ok(b[i-1].score.total >= b[i].score.total);
});

test('门槛挡下的项目不出现在周榜与新手榜', () => {
  const ids = buildBoard('weekly', candidates, NOW).map(x => x.repo.ownerRepo);
  assert.ok(!ids.includes('bad/archived'));
  assert.ok(!ids.includes('bad/nolicense'));
  assert.ok(!ids.includes('bad/unverified'));
  assert.ok(!ids.includes('bad/stale'));
});

test('纯清单类不进新手榜但进经典榜', () => {
  const newbie = buildBoard('newbie', candidates, NOW).map(x => x.repo.ownerRepo);
  const classic = buildBoard('classic', candidates, NOW).map(x => x.repo.ownerRepo);
  assert.ok(!newbie.includes('awesome/list-only'));
  assert.ok(classic.includes('awesome/list-only'));
});

test('新手榜按新手友好分降序', () => {
  const b = buildBoard('newbie', candidates, NOW);
  for (let i = 1; i < b.length; i++) assert.ok(b[i-1].score.runnable >= b[i].score.runnable);
});

test('经典榜按收藏数降序且不受门槛限制', () => {
  const b = buildBoard('classic', candidates, NOW);
  for (let i = 1; i < b.length; i++) assert.ok(b[i-1].repo.stars >= b[i].repo.stars);
  assert.ok(b.length <= 30);
});

test('同分时按名称字典序稳定排序，且同一仓库进两个榜各自独立排名', () => {
  const w = buildBoard('weekly', candidates, NOW), n = buildBoard('newbie', candidates, NOW);
  assert.ok(w.every(x => Number.isInteger(x.rank) && x.rank >= 1));
  assert.ok(n.every(x => Number.isInteger(x.rank) && x.rank >= 1));
  const both = w.map(x=>x.repo.ownerRepo).filter(id => n.map(y=>y.repo.ownerRepo).includes(id));
  assert.ok(both.length >= 1);
});
```

`fixtures/candidates.json` 必须包含：≥18 个合格候选、`bad/archived`（archived=true）、`bad/nolicense`（license=null）、`bad/unverified`（runnability.verified=false）、`bad/stale`（pushedAt 早于 2026-09-01）、`awesome/list-only`（language 为空、kind='none'）；且至少 1 个仓库两榜都够格。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/boards.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`build` 对每个候选调用 `scoreRepo` 与 `passesGates`；`weekly`/`newbie` 只保留通过门槛者（`newbie` 额外排除 `language` 为空或 `kind === 'none'`）；`classic` 只按 `repo.stars` 排序；排序稳定（同分按 `ownerRepo` 字典序）；附加 `rank` 并从 1 开始；截断到 `BOARD_SIZES[boardId]`；同时带上 `reasons`（调用 `buildReasons`）与 `grade`、`chineseDoc`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/boards.test.mjs`
Expected: PASS（6 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/config/boards.mjs src/boards/build.mjs test/boards.test.mjs fixtures/candidates.json
git commit -m "feat(boards): 三榜单组装、门槛与清单类排除"
```

---

## Phase 2：网络层与数据源（M2）

### Task 7: 串行网络客户端、额度预算与文件缓存

**Files:**
- Create: `src/net/client.mjs`, `src/net/file-cache.mjs`, `test/net-client.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `createFileCache(cachePath): { get(key), set(key, body, ttlSeconds) }`（读写单个 JSON 文件，损坏时视为空）
  - `createClient({ fetchImpl, token, budget, cache, now, sleep, logger }): { getJson(url, { api, ttlSeconds }), fetchText(url), stats() }`
  - `class RateLimitError extends Error { resetAt: number }`
  - `stats()` 返回 `{ coreCalls, searchCalls, cacheHits, degraded }`
  - `api` 取值 `'core' | 'search' | 'none'`（`none` 不计额度，用于 raw.githubusercontent / registry / HN）

- [ ] **Step 1: 写失败测试** `test/net-client.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, RateLimitError } from '../src/net/client.mjs';
import { createFileCache } from '../src/net/file-cache.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const resp = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: new Map(Object.entries(headers)),
  json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

test('同一时刻只允许 1 个在途请求（严格串行）', async () => {
  let inFlight = 0, maxInFlight = 0;
  const fetchImpl = async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return resp({});
  };
  const c = createClient({ fetchImpl, budget: 10, sleep: async()=>{} });
  await Promise.all([c.getJson('https://api.github.com/a'), c.getJson('https://api.github.com/b'), c.getJson('https://api.github.com/c')]);
  assert.equal(maxInFlight, 1);
});

test('超过预算上限时不发请求而是降级', async () => {
  let calls = 0;
  const c = createClient({ fetchImpl: async () => { calls++; return resp({}); }, budget: 1, sleep: async()=>{} });
  await c.getJson('https://api.github.com/a');
  await c.getJson('https://api.github.com/b');
  assert.equal(calls, 1);
  assert.equal(c.stats().degraded, true);
});

test('registry 与 raw 请求不计入额度预算', async () => {
  let calls = 0;
  const c = createClient({ fetchImpl: async () => { calls++; return resp({}); }, budget: 1, sleep: async()=>{} });
  await c.getJson('https://registry.npmjs.org/x', { api: 'none' });
  await c.getJson('https://registry.npmjs.org/y', { api: 'none' });
  assert.equal(calls, 2);
  assert.equal(c.stats().degraded, false);
});

test('403 且 reset 很远时抛 RateLimitError 并带上 resetAt', async () => {
  const reset = Math.floor(Date.now()/1000) + 3600;
  const c = createClient({ fetchImpl: async () => resp({ message:'rate limit' }, 403, { 'x-ratelimit-remaining':'0', 'x-ratelimit-reset': String(reset) }),
    budget: 10, sleep: async()=>{} });
  await assert.rejects(() => c.getJson('https://api.github.com/a'), (e) => e instanceof RateLimitError && e.resetAt === reset);
});

test('命中缓存不再发请求', async () => {
  let calls = 0;
  const cache = createFileCache(join(mkdtempSync(join(tmpdir(),'c-')), 'cache.json'));
  const c = createClient({ fetchImpl: async () => { calls++; return resp({ v: 1 }); }, budget: 10, cache, sleep: async()=>{} });
  await c.getJson('https://api.github.com/a', { ttlSeconds: 60 });
  await c.getJson('https://api.github.com/a', { ttlSeconds: 60 });
  assert.equal(calls, 1);
  assert.equal(c.stats().cacheHits, 1);
});

test('5xx 重试后成功则返回结果', async () => {
  let n = 0;
  const c = createClient({ fetchImpl: async () => { n++; return n < 3 ? resp('err', 500) : resp({ ok: true }); }, budget: 10, sleep: async()=>{} });
  assert.deepEqual(await c.getJson('https://api.github.com/a'), { ok: true });
  assert.equal(n, 3);
});

test('缓存文件损坏时当作空缓存，不抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(),'c-')); const p = join(dir,'cache.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(p, '{坏掉的');
  const cache = createFileCache(p);
  assert.equal(cache.get('anything'), undefined);
  cache.set('k', { a: 1 }, 60);
  assert.deepEqual(cache.get('k'), { a: 1 });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/net-client.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`client.mjs`：promise 链实现全局串行；每次请求前查缓存、检查预算（core 与 search 分开计，`api:'none'` 不计），用尽则置 `degraded=true` 并返回 `null`；20s 超时（`AbortController`）；5xx/网络错误重试 3 次、退避 1s/2s/4s（`sleep` 可注入）；403 且 reset 距今 > 300s 抛 `RateLimitError`，否则休眠至 reset 后重试一次；有 token 时带 `Authorization: Bearer`。`fetchText` 用于 HTML/纯文本。`file-cache.mjs` 用单 JSON 文件存 `{ key: { body, expiresAt } }`，读取失败返回空对象。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/net-client.test.mjs`
Expected: PASS（7 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/net test/net-client.test.mjs
git commit -m "feat(net): 串行队列、额度预算、文件缓存与退避重试"
```

### Task 8: trending HTML 解析与改版降级

**Files:**
- Create: `src/sources/trending.mjs`, `fixtures/trending-daily.html`, `fixtures/trending-changed.html`, `test/trending.test.mjs`

**Interfaces:**
- Consumes: `client.fetchText`
- Produces: `parseTrendingHtml(html): TrendingItem[]`；`fetchTrending(client, since): Promise<TrendingItem[]>`
  - `TrendingItem = { fullName, url, description, language, stars, forks, starsToday, starsThisWeek }`

- [ ] **Step 1: 写失败测试** `test/trending.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTrendingHtml } from '../src/sources/trending.mjs';

const daily = readFileSync(new URL('../fixtures/trending-daily.html', import.meta.url), 'utf8');
const changed = readFileSync(new URL('../fixtures/trending-changed.html', import.meta.url), 'utf8');

test('从真实结构解析出仓库与当日涨星', () => {
  const items = parseTrendingHtml(daily);
  assert.ok(items.length >= 5);
  assert.match(items[0].fullName, /^[\w.-]+\/[\w.-]+$/);
  assert.ok(items[0].starsToday > 0);
});

test('页面改版时返回空数组而不抛异常', () => {
  assert.deepEqual(parseTrendingHtml(changed), []);
  assert.deepEqual(parseTrendingHtml(''), []);
  assert.deepEqual(parseTrendingHtml('<html><body>oops'), []);
});

test('缺少 stars today 时条目仍可用，值为 0', () => {
  const html = daily.replace(/stars today/g, 'stars');
  assert.ok(parseTrendingHtml(html).every(i => i.starsToday === 0));
});

test('weekly 页面解析出本周涨星', () => {
  const html = daily.replace(/stars today/g, 'stars this week');
  assert.ok(parseTrendingHtml(html).some(i => i.starsThisWeek > 0));
});
```

`fixtures/trending-daily.html`：真实抓取的页面片段（含 `article.Box-row`、仓库链接、"N stars today"）；`fixtures/trending-changed.html`：结构完全不同的 HTML。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/trending.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

正则切分 `article.Box-row` 块，块内提取仓库相对链接、描述、语言、总星数、fork 数、"stars today / this week"。必需字段缺失的块跳过；整体包 try/catch，异常返回 `[]`。**不引入 HTML 解析库。** `fetchTrending` 请求 `https://github.com/trending?since=<since>`（`api:'none'`），超时或非 200 返回 `[]`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/trending.test.mjs`
Expected: PASS（4 个测试）

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
- Produces: `discoverNewRepos(client, { days = 7, minStars = 200 })` / `discoverActiveRepos(client, { days = 7, minStars = 500 })` / `fetchClassicTop(client, { minStars = 100000, perPage = 30 })`，均返回 `RepoRef[]`
  - `RepoRef = { ownerRepo, name, description, language, stars, forks, openIssues, closedIssues, createdAt, pushedAt, license, archived, defaultBranch, topics }`

- [ ] **Step 1: 写失败测试** `test/search.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverNewRepos, fetchClassicTop } from '../src/sources/search.mjs';

const fake = (items) => ({ getJson: async (url, opts) => { assert.equal(opts.api, 'search'); return { items }; } });
const item = (o = {}) => ({ full_name:'a/b', name:'b', description:'d', language:'Go', stargazers_count:100, forks_count:1,
  open_issues_count:2, created_at:'2026-10-05T00:00:00Z', pushed_at:'2026-10-09T00:00:00Z',
  license:{ spdx_id:'MIT' }, archived:false, default_branch:'main', topics:['cli'], ...o });

test('新项目查询带 created 与 stars 条件并按 stars 降序', async () => {
  let seen = '';
  await discoverNewRepos({ getJson: async (url) => { seen = url; return { items: [item()] }; } }, { days: 7, minStars: 200 });
  const q = decodeURIComponent(seen);
  assert.match(q, /created:>/);
  assert.match(q, /stars:>200/);
  assert.match(seen, /sort=stars/);
});

test('字段正确映射，license 为 null 不崩溃', async () => {
  const r = await fetchClassicTop(fake([item({ license: null, stargazers_count: 500000 })]));
  assert.equal(r[0].stars, 500000);
  assert.equal(r[0].license, null);
  assert.equal(r[0].defaultBranch, 'main');
});

test('接口抛错或返回 null 时返回空数组', async () => {
  assert.deepEqual(await discoverNewRepos({ getJson: async () => { throw new Error('boom'); } }), []);
  assert.deepEqual(await fetchClassicTop({ getJson: async () => null }), []);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/search.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

构造 `https://api.github.com/search/repositories?q=...&sort=<stars|updated>&order=desc&per_page=<n>`；`created:>{今天UTC - days 的 ISO 日期}`。统一 `mapItem(raw)` 做防御性映射（缺失给安全默认值）。任何异常返回 `[]`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/search.test.mjs`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/sources/search.mjs test/search.test.mjs
git commit -m "feat(sources): 新项目/活跃老项目/总榜三个发现器"
```

### Task 10: registry 直查与包名归属校验（防装错包）

**Files:**
- Create: `src/sources/registry.mjs`, `test/registry.test.mjs`

**Interfaces:**
- Consumes: `client.getJson(url, { api: 'none' })`
- Produces:
  - `lookupNpm(client, packageName, repoFullName): Promise<NpmInfo|null>`，`NpmInfo = { packageName, version, hasBin, osIncludesWin, repoMatches }`
  - `lookupPyPI(client, packageName): Promise<PyPIInfo|null>`，`PyPIInfo = { packageName, version, requiresPython }`
  - `normalizeRepoUrl(url): string`
  - `isPythonCompatible(requiresPython, localPython): boolean`

- [ ] **Step 1: 写失败测试** `test/registry.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupNpm, isPythonCompatible, normalizeRepoUrl } from '../src/sources/registry.mjs';

const client = (body) => ({ getJson: async () => body });

test('同名但 repository 指向别的仓库时必须判定不匹配', async () => {
  const packument = { name:'markitdown', 'dist-tags':{latest:'1.0.0'},
    versions:{ '1.0.0':{ bin:{ markitdown:'cli.js' }, repository:{ url:'git+https://github.com/dead8309/markitdown-ts.git' } } } };
  assert.equal((await lookupNpm(client(packument), 'markitdown', 'microsoft/markitdown')).repoMatches, false);
});

test('repository 指向目标仓库时匹配并读出 bin 与 os', async () => {
  const packument = { name:'opencode-ai', 'dist-tags':{latest:'1.18.35'},
    versions:{ '1.18.35':{ bin:{ opencode:'bin/opencode.exe' }, os:['darwin','linux','win32'],
      repository:{ url:'git+https://github.com/sst/opencode.git' } } } };
  const r = await lookupNpm(client(packument), 'opencode-ai', 'sst/opencode');
  assert.equal(r.repoMatches, true);
  assert.equal(r.hasBin, true);
  assert.equal(r.osIncludesWin, true);
});

test('normalizeRepoUrl 抹平 git+ / .git / 大小写 / 末尾斜杠', () => {
  assert.equal(normalizeRepoUrl('git+https://github.com/SST/OpenCode.git'), normalizeRepoUrl('https://github.com/sst/opencode/'));
});

test('requires_python 与本机 Python 比对', () => {
  assert.equal(isPythonCompatible('>=3.10', '3.10.11'), true);
  assert.equal(isPythonCompatible('>=3.12', '3.10.11'), false);
  assert.equal(isPythonCompatible('<3.15,>=3.10', '3.10.11'), true);
  assert.equal(isPythonCompatible(null, '3.10.11'), true);
});

test('请求失败返回 null 而不是抛错', async () => {
  assert.equal(await lookupNpm({ getJson: async () => null }, 'x', 'a/b'), null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/registry.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`lookupNpm` 请求 `https://registry.npmjs.org/<name>`，取 `dist-tags.latest` 对应版本读 `bin`/`os`/`repository`，`repoMatches` 由 `normalizeRepoUrl` 比较得出（**R42**：归属证据扩为 版本级 repository → 包级 repository → 版本级 `bugs.url` → 版本级 homepage → 包级 homepage，归一化后仍须严格相等；并输出 `evidence` 字段；**包名任何情况下不参与判定**）。`lookupPyPI` 请求 `https://pypi.org/pypi/<name>/json`。`isPythonCompatible` 解析 `>=`/`<=`/`<`/`>`/`==`/`!=` 与逗号多条件；**R47（推翻原先"只比 major.minor"）**：约束写了 patch 段就按 (major,minor,patch) 比较，`==X.Y.*` 保持 major.minor，本地版本缺 patch 按 `(major,minor,0)`，读不懂一律判不兼容（失败关闭）。全部走 `api:'none'`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/registry.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/sources/registry.mjs test/registry.test.mjs
git commit -m "feat(sources): npm/PyPI 直查与包名归属校验"
```

### Task 11: release 资产中的 Windows 包识别

**Files:**
- Create: `src/sources/releases.mjs`, `test/releases.test.mjs`
- Modify（仅 R40 所必需）: `src/score/score.mjs`、`test/score-reputation.test.mjs`

**Interfaces:**
- Consumes: `client.getJson(url, { api: 'core' })`
- Produces: `pickWindowsAsset(assets): { name, url, size } | null`；`fetchLatestRelease(client, ownerRepo): Promise<Release | null>`；`hasRecentRelease(release, now, days = 90): boolean | null`
  - `Release = { kind: 'release', tagName, publishedAt, assets, windowsAsset } | { kind: 'no-release' }`
  - **R40（控制者插入，必做）**：`release90d` 是口碑分里 6 分的一项，但在本任务之前**没有任何生产端**给它提供数据（全仓库只有读取处，没有写入处），导致口碑轴在生产环境实际只能拿 24/30。本任务必须补上生产者，且必须是**三态**，不得把"没问到"当成"确认没有"：
    - 用 `GET /repos/{ownerRepo}/releases?per_page=1`（**列表**端点）而不是 `/releases/latest`：列表端点在没有发布时返回 `200 []`，而 `latest` 返回 404，二者与"请求失败"在客户端都以 `null` 出现，无法区分。
    - `200 []` → `{ kind: 'no-release' }`（**确认**没有任何发布）
    - `200 [r]` → `{ kind: 'release', tagName, publishedAt, assets, windowsAsset }`
    - `null`（请求失败/额度耗尽）→ `null`（**未知**）
    - `hasRecentRelease(...)` 返回 `true`（release 且 publishedAt 在 days 天内）/ `false`（`no-release`，或 release 但超出窗口）/ `null`（未知）
  - 同时**窄范围**修改 `src/score/score.mjs`：`hasRelease90d === null`（未知）时必须给**中性半分**（`DETAIL_WEIGHTS.release90d / 2` = 3），与 `growth` 的既有口径一致；`false` 才给 0。理由：把"没问到"记 0 会让界面显示"近 90 天有发版：0 分"——一句我们并无证据的话，正是本项目刚修掉两次的同类缺陷。此改动只许涉及 `release90d` 一项，别的不许动。

- [ ] **Step 1: 写失败测试** `test/releases.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWindowsAsset } from '../src/sources/releases.mjs';

const a = n => ({ name:n, browser_download_url:'u', size:1 });

test('识别 .exe / .msi / windows / win64 命名', () => {
  assert.equal(pickWindowsAsset([a('app-setup.exe')]).name, 'app-setup.exe');
  assert.equal(pickWindowsAsset([a('App_x64.msi')]).name, 'App_x64.msi');
  assert.equal(pickWindowsAsset([a('tool-windows-amd64.zip')]).name, 'tool-windows-amd64.zip');
  assert.equal(pickWindowsAsset([a('tool-win64.zip')]).name, 'tool-win64.zip');
});

test('只有 mac/linux 资产时返回 null，不得误报支持 Windows', () => {
  assert.equal(pickWindowsAsset([a('app-darwin-arm64.zip'), a('app-linux-x86_64.tar.gz')]), null);
});

test('优先安装包而不是压缩包', () => {
  assert.equal(pickWindowsAsset([a('app-windows.zip'), a('app-setup.exe')]).name, 'app-setup.exe');
});

test('空数组与非法输入返回 null', () => {
  assert.equal(pickWindowsAsset([]), null);
  assert.equal(pickWindowsAsset(null), null);
});

test('三态：确认没有发布 / 有发布但超窗 / 未知，三者必须互不混淆（R40）', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  assert.equal(hasRecentRelease({ kind: 'no-release' }, now), false);
  assert.equal(hasRecentRelease({ kind: 'release', publishedAt: '2026-09-01T00:00:00Z' }, now), true);
  assert.equal(hasRecentRelease({ kind: 'release', publishedAt: '2026-01-01T00:00:00Z' }, now), false);
  assert.equal(hasRecentRelease(null, now), null);          // 没问到 ≠ 没有
});

test('列表端点返回空数组时判为"确认没有发布"，请求失败时判为"未知"', async () => {
  const ok = { getJson: async () => [] };
  assert.deepEqual(await fetchLatestRelease(ok, 'a/b'), { kind: 'no-release' });
  const fail = { getJson: async () => null };
  assert.equal(await fetchLatestRelease(fail, 'a/b'), null);
});

test('未知的发版信息按中性半分计，不当作"确认没有"（R40）', () => {
  const unknown = scoreReputation({ ...base, hasRelease90d: null }, { growing: true });
  assert.equal(unknown.parts.release90d, DETAIL_WEIGHTS.release90d / 2);
  const none = scoreReputation({ ...base, hasRelease90d: false }, { growing: true });
  assert.equal(none.parts.release90d, 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/releases.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

优先级：`.exe` > `.msi` > 含 `windows|win64|win32` 的压缩包；显式排除含 `darwin|macos|linux|android|ios` 的名字。`fetchLatestRelease` 按 R40 请求 **`/repos/{ownerRepo}/releases?per_page=1`**（列表端点），`200 []` → `{ kind: 'no-release' }`，`200 [r]` → `{ kind: 'release', … }`，`null` → `null`。`hasRecentRelease` 实现三态判定。另按 R40 在 `src/score/score.mjs` 的 `scoreReputation` 里把 `hasRelease90d === null` 记为中性半分（`DETAIL_WEIGHTS.release90d / 2`），并在 `test/score-reputation.test.mjs` 里补一条对应断言。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/releases.test.mjs`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/sources/releases.mjs test/releases.test.mjs
git commit -m "feat(sources): Windows 安装包识别"
```

### Task 12: 涨星速度五级降级（历史 JSON 为支柱）

**Files:**
- Create: `src/sources/star-velocity.mjs`, `src/sources/events.mjs`, `test/star-velocity.test.mjs`

**Interfaces:**
- Consumes: `client`、`readSnapshotStars`（Task 2）
- Produces:
  - `resolveVelocity(repo, ctx): Promise<{ gained7d, gained3d, level, confidence, source }>`
  - `confidence ∈ 'measured' | 'reported' | 'estimated'`；`level ∈ 0..4`
  - `estimateFromEvents(events, now): { perHour, gained7d } | null`
  - `ctx = { client, dataDir, trendingByRepo: Map<string, TrendingItem>, now: Date }`

- [ ] **Step 1: 写失败测试** `test/star-velocity.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVelocity, estimateFromEvents } from '../src/sources/star-velocity.mjs';
import { writeDaily } from '../src/store/datastore.mjs';

const NOW = new Date('2026-10-10T00:00:00Z');
const newRepo = { ownerRepo:'a/b', createdAt:'2026-10-05T00:00:00Z', stars: 500 };
const oldRepo = { ownerRepo:'a/b', createdAt:'2020-01-01T00:00:00Z', stars: 90000 };

test('7 天内新建的仓库用总收藏数作为 7 日增量（measured）', async () => {
  const v = await resolveVelocity(newRepo, { client:{}, dataDir:null, trendingByRepo:new Map(), now: NOW });
  assert.equal(v.level, 1);
  assert.equal(v.gained7d, 500);
  assert.equal(v.confidence, 'measured');
});

test('trending 官方数据优先于估算（reported）', async () => {
  const t = new Map([['a/b', { starsThisWeek: 800, starsToday: 100 }]]);
  const v = await resolveVelocity(oldRepo, { client:{}, dataDir:null, trendingByRepo:t, now: NOW });
  assert.equal(v.level, 2);
  assert.equal(v.confidence, 'reported');
  assert.equal(v.gained7d, 800);
});

test('有历史 JSON 差值时用实测差值（measured），并提供 3 日数据', async () => {
  const d = mkdtempSync(join(tmpdir(),'hs-'));
  const mk = (date, stars) => ({ date, generatedAt:date, degraded:false,
    boards:[{ id:'weekly', title:'x', items:[{ rank:1, ownerRepo:'a/b', stars }] }] });
  writeDaily(d, '2026-10-03', mk('2026-10-03', 89800));
  writeDaily(d, '2026-10-07', mk('2026-10-07', 89950));
  const v = await resolveVelocity(oldRepo, { client:{}, dataDir:d, trendingByRepo:new Map(), now: NOW });
  assert.equal(v.level, 3);
  assert.equal(v.gained7d, 200);
  assert.equal(v.gained3d, 50);
  assert.equal(v.confidence, 'measured');
});

test('历史文件损坏时降级到下一级而不是失败', async () => {
  const d = mkdtempSync(join(tmpdir(),'hs-'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(d, '2026-10-03.json'), '{坏掉');
  const client = { getJson: async () => [{ created_at:'2026-10-09T12:00:00Z' }, { created_at:'2026-10-10T00:00:00Z' }] };
  const v = await resolveVelocity(oldRepo, { client, dataDir:d, trendingByRepo:new Map(), now: NOW });
  assert.equal(v.level, 4);
  assert.equal(v.confidence, 'estimated');
});

test('全部不可用时兜底为估算且不抛错', async () => {
  const v = await resolveVelocity(oldRepo, { client:{ getJson: async () => null }, dataDir:null, trendingByRepo:new Map(), now: NOW });
  assert.equal(v.gained7d, 0);
  assert.equal(v.confidence, 'estimated');
});

test('estimateFromEvents 在窗口为 0 时返回 null 而不是除零', () => {
  assert.equal(estimateFromEvents([{ created_at:'2026-10-10T00:00:00Z' }], NOW), null);
  assert.equal(estimateFromEvents([], NOW), null);
  assert.equal(estimateFromEvents(null, NOW), null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/star-velocity.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

依次尝试五级，命中即返回：

- 级别 0：如 `client` 支持且仓库年龄 ≤ 30 周，调用 `/repos/{id}/stargazers/history?per_page=30`（头 `X-GitHub-Api-Version: 2026-03-10`），按周桶展开日线累加最近 7 天与 3 天。**必须能优雅失败**：404/403/结构不符即继续下降（开放项 O1）。
- 级别 1：`createdAt` 距今 ≤ 7 天 → `gained7d = repo.stars`，`measured`。
- 级别 2：`trendingByRepo` 有 `starsThisWeek > 0` → `reported`。
- 级别 3：`readSnapshotStars(dataDir, 今天-7天)` 有该仓库 → 差值；若 `今天-3天` 也有则填 `gained3d`。`measured`。
- 级别 4：`events.mjs` 拉 `/repos/{id}/events?per_page=100`，`estimateFromEvents` 用 `watchCount / windowHours * 168` 外推 → `estimated`。

全部失败返回 `{ gained7d: 0, gained3d: null, level: 4, confidence: 'estimated', source: 'none' }`。

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
- Consumes: `client.fetchText`（`api:'none'`）、`repo.defaultBranch`
- Produces:
  - `detectChinese({ readmeText, extraFiles }): { hasChinese, ratio, localizedFiles }`
  - `fetchChineseEvidence(client, ownerRepo, defaultBranch): Promise<{ readmeText, extraFiles }>`
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

test('纯英文判定为无中文', () => {
  const en = 'A very useful tool that helps you process files. '.repeat(20);
  assert.equal(detectChinese({ readmeText: en, extraFiles: {} }).ratio, 0);
});

test('只有零星中文字符不误判', () => {
  assert.equal(detectChinese({ readmeText: 'This is a tool. '.repeat(200) + '张三', extraFiles: {} }).hasChinese, false);
});

test('存在 README.zh-CN.md 时判定有中文并记录文件名', () => {
  const r = detectChinese({ readmeText: 'English only. '.repeat(100), extraFiles: { 'README.zh-CN.md': '中文内容' } });
  assert.equal(r.hasChinese, true);
  assert.deepEqual(r.localizedFiles, ['README.zh-CN.md']);
});

test('空输入不抛错', () => {
  assert.equal(detectChinese({ readmeText:'', extraFiles:{} }).hasChinese, false);
  assert.equal(detectChinese({ readmeText:null, extraFiles:null }).hasChinese, false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/readme.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

CJK 集合 `[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]`，`ratio = 命中数 / 文本长度`，阈值取 `CHINESE_RATIO_THRESHOLD`。本地化文件名匹配 `/(^|\/)(README|readme)[._-]?(zh|cn)([._-](CN|TW|HK))?\.(md|markdown)$/`。`fetchChineseEvidence` 请求 `https://raw.githubusercontent.com/{ownerRepo}/{defaultBranch}/README.md` 及**最多 4 个**候选本地化文件名（实测实现探测 `README.zh-CN.md` / `README_CN.md` / `README.zh.md` / `README.ja.md`，共 ≤5 次 `api:'none'` 请求，不消耗 GitHub 额度）。**R59（后续补充）**：检测须同时产出 `hasCjk`（喂计分：CJK 占比达标或存在任意本地化文件）与 `hasChinese`（只管徽章：中文文件名存在，或汉字占比达标且假名占比 < 0.01），两者刻意不同——只有日文文档时不得对中文用户宣称"有中文说明"。**R63（后续修正）**：`docs/*.zh*` 的中文判定必须拿**完整路径**去匹配（该正则含字面量 `docs/`），拿剥掉目录前缀的文件名去匹配会变成死代码。`buildReputationInput` 映射为 `scoreReputation` 所需形状。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/readme.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/enrich/readme.mjs src/enrich/health.mjs test/readme.test.mjs
git commit -m "feat(enrich): 中文文档检测与口碑输入"
```

### Task 14: 新手友好度分级与三步安装向导生成

**Files:**
- Create: `src/enrich/runnability.mjs`, `test/runnability.test.mjs`

**Interfaces:**
- Consumes: `lookupNpm`/`lookupPyPI`（Task 10）、`pickWindowsAsset`（Task 11）、`detectChinese`（Task 13）、`calculateGrade`（Task 4）
- Produces:
  - `classifyRunnability({ releases, npm, pypi, chinese }): Runnability`，`Runnability = { kind, command, downloadUrl, evidence, verified, difficulty, chineseDoc, notes }`
  - `buildInstallGuide(runnability): { steps: { title, body, command? }[], faq: { q, a }[] }`

- [ ] **Step 1: 写失败测试** `test/runnability.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunnability, buildInstallGuide } from '../src/enrich/runnability.mjs';

test('未通过归属校验的 npm 包绝不产出安装命令', () => {
  const r = classifyRunnability({ releases:null, pypi:null,
    npm:{ packageName:'markitdown', repoMatches:false, hasBin:true, osIncludesWin:true },
    chinese:{ hasChinese:false, localizedFiles:[] } });
  assert.equal(r.verified, false);
  assert.equal(r.kind, 'none');
  assert.equal(r.command, null);
});

test('npm 有 bin 且支持 win32 → 绿色，命令为 npx', () => {
  const r = classifyRunnability({ releases:null, pypi:null,
    npm:{ packageName:'opencode-ai', repoMatches:true, hasBin:true, osIncludesWin:true },
    chinese:{ hasChinese:true, localizedFiles:['README.zh-CN.md'] } });
  assert.equal(r.kind, 'npmBinWin');
  assert.equal(r.difficulty, 'green');
  assert.match(r.command, /^npx /);
  assert.equal(r.verified, true);
});

test('有 Windows 安装包时优先于 npm', () => {
  const r = classifyRunnability({ releases:{ windowsAsset:{ name:'app-setup.exe', url:'https://x/app-setup.exe' } },
    npm:{ packageName:'x', repoMatches:true, hasBin:true, osIncludesWin:true }, pypi:null,
    chinese:{ hasChinese:false, localizedFiles:[] } });
  assert.equal(r.kind, 'releaseWindows');
  assert.equal(r.downloadUrl, 'https://x/app-setup.exe');
});

test('npm 无 bin 时降级为 npmNoBin（黄色）', () => {
  const r = classifyRunnability({ releases:null, pypi:null,
    npm:{ packageName:'x', repoMatches:true, hasBin:false, osIncludesWin:false },
    chinese:{ hasChinese:false, localizedFiles:[] } });
  assert.equal(r.kind, 'npmNoBin');
  assert.equal(r.difficulty, 'yellow');
});

test('PyPI 包给出 pip 命令；版本要求写进说明', () => {
  const r = classifyRunnability({ releases:null, npm:null,
    pypi:{ packageName:'markitdown', version:'0.1.8', requiresPython:'>=3.10' },
    chinese:{ hasChinese:false, localizedFiles:[] } });
  assert.equal(r.kind, 'pypiCompatible');
  assert.match(r.command, /^pip install /);
  assert.ok(r.notes.some(n => n.includes('3.10')));
});

test('什么都没有时 kind 为 none 且 verified 为 false', () => {
  const r = classifyRunnability({ releases:null, npm:null, pypi:null, chinese:{ hasChinese:false, localizedFiles:[] } });
  assert.equal(r.kind, 'none');
  assert.equal(r.verified, false);
  assert.equal(r.difficulty, 'red');
});

test('安装向导固定 3 步，步骤含命令与常见问题', () => {
  const r = classifyRunnability({ releases:null, pypi:null,
    npm:{ packageName:'opencode-ai', repoMatches:true, hasBin:true, osIncludesWin:true },
    chinese:{ hasChinese:false, localizedFiles:[] } });
  const g = buildInstallGuide(r);
  assert.equal(g.steps.length, 3);
  assert.ok(g.steps[1].command);
  assert.ok(g.faq.length >= 3);
});

test('Windows 安装包的第 2 步给下载链接而不是命令', () => {
  const g = buildInstallGuide({ kind:'releaseWindows', verified:true, difficulty:'green',
    downloadUrl:'https://x/a.exe', command:null, chineseDoc:false, notes:[] });
  assert.match(g.steps[1].body + (g.steps[1].downloadUrl || ''), /https:\/\/x\/a\.exe/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/runnability.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

按优先级判定 `releaseWindows > npmBinWin > pypiCompatible > npmNoBin > buildFromSource > dockerOnly > none`；**任何 `repoMatches !== true` 的 npm 结果一律忽略**；`difficulty = calculateGrade(RUNNABLE_POINTS[kind])`。`buildInstallGuide` 生成固定三步（第 1 步"你需要先准备什么"按 kind 给结论；第 2 步按 kind 给命令或下载链接；第 3 步"怎么用"）与按 kind 的 FAQ（≥3 条，含"装错了怎么卸载"）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/runnability.test.mjs`
Expected: PASS（8 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/enrich/runnability.mjs test/runnability.test.mjs
git commit -m "feat(enrich): 新手友好度分级与三步安装向导"
```

### Task 15: collect 主流程、JSON 落盘与日报导出

**Files:**
- Create: `src/collect.mjs`, `src/exporters/markdown.mjs`, `src/exporters/json.mjs`, `test/collect-offline.test.mjs`
- Modify: `src/cli.mjs`

**Interfaces:**
- Consumes: Task 2–14 全部
- **R41（控制者插入，必做）—— 两个"没有生产者"的评分子项必须在这里接线**。Task 4B 评审确认：`hasRelease90d` 与 `extra.growing` 在全仓库**只有读取处、没有写入处**，导致生产环境 `release90d` 恒 0、`growth` 恒为中性 2，口碑轴实际只能拿 24–28/30（fixture 手写了合理值，所以测试全绿而生产必错）。本任务必须：
  - 对每个候选执行 **`repo.hasRelease90d = hasRecentRelease(release, now)`**（Task 11 的 R40 三态；`release === null` 时该字段为 `null`）。
  - 用**与 Task 12 同一份历史 JSON** 计算 `extra.growing`：历史上有正增长 → `true`；有历史但无增长 → `false`；**尚无历史数据 → `null`**（走中性半分，不惩罚新项目）。
  - 任一为 `null` 时（"没问到"而非"确认没有"）必须把本轮标记为 `degraded`，与 R33（RateLimitError 中止本轮）、R35（trending 返回空）同一类要求：**静默未知必须可见**。
  - 并补一条**集成测试**证明这两个字段在本轮结果里被真正写入（不能只靠 fixture 里手写的值蒙过）。
- Produces:
  - `runCollect({ dataDir, client, sources, now, offline }): Promise<{ date, boards: BoardResult[], apiCalls, degraded, markdown, json }>`
  - `BoardResult = { id, title, items: RankedItem[] }`
  - `renderDailyMarkdown(boards, date): string` / `renderDailyJson(boards, date): string`
  - `writeDailyFiles(dir, date, md, json)`
  - 副作用：写 `public/data/YYYY-MM-DD.json`、更新 `public/data/index.json`、追加 `public/data/history/YYYY-MM.json`

- [ ] **Step 1: 写失败测试** `test/collect-offline.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollect } from '../src/collect.mjs';
import { readDaily, listDates, readHistory } from '../src/store/datastore.mjs';
import candidates from '../fixtures/candidates.json' with { type: 'json' };

const dir = () => mkdtempSync(join(tmpdir(), 'hs-'));
const NOW = new Date('2026-10-10T00:00:00Z');
const okSources = { discover: async () => candidates, enrich: async (c) => c };

test('离线跑完整流程：三榜有内容、JSON 落盘、日报可生成', async () => {
  const d = dir();
  const r = await runCollect({ dataDir:d, offline:true, now:NOW, sources: okSources });
  assert.equal(r.date, '2026-10-10');
  assert.equal(r.boards.length, 3);
  assert.ok(r.boards.find(b => b.id === 'weekly').items.length > 0);
  assert.ok(r.boards.find(b => b.id === 'classic').items.length <= 30);
  assert.deepEqual(listDates(d), ['2026-10-10']);
  assert.equal(readDaily(d, '2026-10-10').boards.length, 3);
  assert.ok(readHistory(d, '2026-10')['2026-10-10']);
});

test('断网时不得抛错且标记 degraded', async () => {
  const d = dir();
  const r = await runCollect({ dataDir:d, offline:true, now:NOW,
    sources: { discover: async () => { throw new Error('ENETUNREACH'); }, enrich: async (c) => c } });
  assert.equal(r.degraded, true);
  assert.equal(r.boards.length, 3);
});

test('同一天重复运行不产生重复条目', async () => {
  const d = dir();
  await runCollect({ dataDir:d, offline:true, now:NOW, sources: okSources });
  const n1 = readDaily(d, '2026-10-10').boards.find(b=>b.id==='weekly').items.length;
  await runCollect({ dataDir:d, offline:true, now:NOW, sources: okSources });
  const n2 = readDaily(d, '2026-10-10').boards.find(b=>b.id==='weekly').items.length;
  assert.equal(n1, n2);
});

test('某个候选富化失败不影响整轮，其余仍在榜', async () => {
  const d = dir();
  const r = await runCollect({ dataDir:d, offline:true, now:NOW,
    sources: { discover: async () => candidates,
      enrich: async (c) => { if (c.repo.ownerRepo === 'a/b0') throw new Error('boom'); return c; } } });
  assert.ok(r.boards.find(b=>b.id==='weekly').items.length > 0);
});

test('日报 Markdown 里估算值必须带"约"与"估算"', async () => {
  const d = dir();
  const est = candidates.map(c => ({ ...c, velocity: { gained7d: 100, gained3d: null, level: 4, confidence: 'estimated', source: 'events' } }));
  const r = await runCollect({ dataDir:d, offline:true, now:NOW, sources: { discover: async () => est, enrich: async (c) => c } });
  assert.match(r.markdown, /约|估算/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/collect-offline.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`runCollect` 顺序：`discover`（异常则捕获、尝试复用昨日榜单数据、`degraded=true`）→ 逐候选 `enrich`（单个失败跳过并计数）→ `resolveVelocity` → `buildBoard` × 3 → `writeDaily` + `updateIndex` + `appendHistory` → 生成 `markdown`/`json` 字符串并在返回值里给出（便于测试）→ 返回 `apiCalls`。`cli.mjs` 的 `collect` 分支：真实网络路径组装 `client`（读 `GITHUB_TOKEN`）与真实 `sources`，并把日报写到 `daily/`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/collect-offline.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/collect.mjs src/exporters src/cli.mjs test/collect-offline.test.mjs
git commit -m "feat(collect): 采集主流程、JSON 落盘与降级"
```

---

## Phase 3：静态网站（M3–M4）

### Task 16: 静态服务器与三榜单页面

**Files:**
- Create: `src/http/static-server.mjs`, `public/index.html`, `public/app.js`, `public/style.css`, `test/static-server.test.mjs`
- Modify: `src/cli.mjs`

**Interfaces:**
- Consumes: `public/data/index.json` 与 `public/data/<date>.json`（前端直接 fetch，**不经过任何接口**）
- Produces: `createStaticServer({ root }): http.Server`（把 `public/` 原样提供，设置正确 `Content-Type`，路径穿越必须被拒绝）

- [ ] **Step 1: 写失败测试** `test/static-server.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaticServer } from '../src/http/static-server.mjs';

const start = () => new Promise(res => { const s = createStaticServer({ root: 'public' }).listen(0, () => res({ s, port: s.address().port })); });

test('能取到首页与数据文件，Content-Type 正确', async () => {
  const { s, port } = await start();
  const html = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  const js = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  s.close();
});

test('不存在的文件返回 404 而不是崩溃', async () => {
  const { s, port } = await start();
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope.txt`)).status, 404);
  s.close();
});

test('路径穿越攻击必须被拒绝', async () => {
  const { s, port } = await start();
  const r = await fetch(`http://127.0.0.1:${port}/../package.json`);
  assert.ok(r.status === 404 || r.status === 403);
  s.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/static-server.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`node:http` 极简静态服务：URL 解码 → `path.normalize` → `path.resolve(root, rel)` → 断言结果以 root 绝对路径开头（否则 403）→ 目录则补 `index.html` → 读取失败 404。`index.html` + `app.js` 渲染三个榜签、卡片列表、筛选条（🟢 一键就能玩 / 🈶 有中文说明 / 语言）、空数据提示。**文案走 spec §4.3 翻译表，不得出现 star/fork/issue。**

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/static-server.test.mjs`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/http/static-server.mjs public src/cli.mjs test/static-server.test.mjs
git commit -m "feat(web): 静态服务器与三榜单页面"
```

### Task 17: 详情抽屉、三步安装向导与新手准备页

**Files:**
- Create: `public/prepare.html`, `test/page-content.test.mjs`
- Modify: `public/app.js`, `public/index.html`, `public/style.css`

**Interfaces:**
- Consumes: `public/data/<date>.json` 里每条的 `install`、`reasons`、`scores`、`grade`、`chineseDoc`、`confidence`
- Produces: 详情抽屉（三步向导 + 为什么上榜 + 复制按钮）与 `prepare.html` 新手准备页

- [ ] **Step 1: 写失败测试** `test/page-content.test.mjs`（静态页面内容断言，保证不出现行话、必备元素存在）

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');

test('首页不得出现 star / fork / issue 行话', () => {
  const html = read('index.html').toLowerCase();
  assert.ok(!/\bstar\b|\bfork\b|\bissue\b/.test(html));
});

test('首页含三个榜签与筛选条文案', () => {
  const html = read('index.html');
  assert.match(html, /本周飙升/);
  assert.match(html, /新手能玩/);
  assert.match(html, /经典必玩/);
  assert.match(html, /一键就能玩/);
  assert.match(html, /有中文说明/);
});

test('app.js 渲染置信度文案与三步向导，且引用新手准备页', () => {
  const js = read('app.js');
  assert.match(js, /估算/);
  assert.match(js, /实测/);
  assert.match(js, /prepare\.html/);
});

test('新手准备页包含"怎么打开命令行"', () => {
  assert.match(read('prepare.html'), /命令行|终端|PowerShell/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/page-content.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

抽屉渲染：三步向导（第 2 步命令框 + 一键复制，`navigator.clipboard` 失败回退 `document.execCommand`）、"为什么上榜"三条理由 + 分数条、项目事实、置信度标注、Windows 包给下载按钮。`prepare.html`：怎么打开 PowerShell/终端（图文步骤）、怎么装 Node（给官网链接与安装包类型）、命令复制到哪、怎么看结果。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/page-content.test.mjs`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add public test/page-content.test.mjs
git commit -m "feat(web): 详情抽屉、三步向导与新手准备页"
```

### Task 18: 离线 demo、历史日期回看与评分口径页

**Files:**
- Create: `fixtures/demo/seed.mjs`, `public/about.html`, `test/demo.test.mjs`
- Modify: `src/cli.mjs`, `public/app.js`

**Interfaces:**
- Consumes: `writeDaily`、`updateIndex`、`appendHistory`
- Produces: `seedDemoData(dataDir): void`（生成 3 个日期的演示 JSON）；`cli serve --demo` 在数据为空时自动 seed；`/about.html` 评分口径页

- [ ] **Step 1: 写失败测试** `test/demo.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDemoData } from '../fixtures/demo/seed.mjs';
import { readDaily, listDates, readHistory } from '../src/store/datastore.mjs';

test('demo 数据填满三个榜并覆盖多天', () => {
  const d = mkdtempSync(join(tmpdir(), 'hs-'));
  seedDemoData(d);
  const dates = listDates(d);
  assert.ok(dates.length >= 3);
  assert.equal(readDaily(d, dates[0]).boards.length, 3);
  assert.ok(readHistory(d, dates[0].slice(0, 7)));
});

test('seed 幂等：重复调用不产生重复日期', () => {
  const d = mkdtempSync(join(tmpdir(), 'hs-'));
  seedDemoData(d); const a = listDates(d).length;
  seedDemoData(d); assert.equal(listDates(d).length, a);
});

test('demo 数据里至少有估算与实测两种置信度，便于演示标注', () => {
  const d = mkdtempSync(join(tmpdir(), 'hs-'));
  seedDemoData(d);
  const items = listDates(d).flatMap(dt => readDaily(d, dt).boards.flatMap(b => b.items));
  const conf = new Set(items.map(i => i.confidence));
  assert.ok(conf.has('estimated') && conf.has('measured'));
});

test('评分口径页存在且列出三轴分值', () => {
  const html = readFileSync(new URL('../public/about.html', import.meta.url), 'utf8');
  assert.match(html, /45/); assert.match(html, /30/); assert.match(html, /25/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/demo.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`seedDemoData` 基于 `fixtures/candidates.json` 生成 3 个连续日期（最近一天为 `2026-10-10`），人为制造一条 `estimated` 与递增的历史收藏数（让第 3 天能演示"实测差值"）。前端底部加日期选择器，切换时重新 fetch 对应 `data/<date>.json`。`about.html` 摊开评分公式与降级阶梯。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/demo.test.mjs`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add fixtures/demo public/about.html src/cli.mjs public/app.js test/demo.test.mjs
git commit -m "feat(demo): 离线演示数据、历史回看与评分口径页"
```

---

## Phase 4：文档与发布准备（M6）

### Task 19: 中文使用手册、README 与发布准备

**Files:**
- Create: `docs/使用手册.md`, `README.md`, `docs/评分口径.md`, `.github/workflows/daily.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: 全部
- Produces: 面向纯新手的文档；预留的每日采集 workflow（**默认不启用**，需用户到 Actions 页面手动开启）

- [ ] **Step 1: 跑全量测试确认基线**

Run: `npm test`
Expected: 全部 PASS；并确认 `package.json` 无 `dependencies` / `devDependencies`（Task 1 的第二个测试已覆盖）

- [ ] **Step 2: 写 `docs/使用手册.md`**

必含章节：这是什么（小白语言）· 第一次怎么跑起来（含装 Node 的步骤）· 三个榜分别什么意思 · 评分公式全文 · 🟢🟡🔴 什么意思 · 怎么每天自动更新（本地计划任务）· **怎么发布到网上（GitHub Pages 步骤）** · 常见问题：网络不通 / GitHub 额度用完 / 项目没有 Windows 版怎么办 / 装错了怎么卸载。

- [ ] **Step 3: 写 `README.md` 与 `docs/评分口径.md`**

README 首段对比同类项目（引用 spec §2.1/§2.2 事实），然后截图位、30 秒跑起来的三条命令、`npm run demo` 说明、部署一句话。`docs/评分口径.md` 放出完整权重表与五级降级阶梯。

- [ ] **Step 4: 加 `.github/workflows/daily.yml`（预留，不启用）**

`on: { schedule: [{ cron: '0 22 * * *' }], workflow_dispatch: {} }`；步骤：checkout → setup-node 22 → `npm run collect`（`env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`）→ 用 `git-auto-commit` 风格的原生命令把 `public/data/` 与 `daily/` 提交回来。**文档中明确写"这是可选的，不启用也不影响网站"。**

- [ ] **Step 5: 手工验收离线演示并提交**

Run: `npm run demo`，浏览器打开输出的地址
Expected: 三个榜都有内容、卡片有难度与中文徽章、点开抽屉看到三步向导与"为什么上榜"、能切换历史日期、断网仍可用。

```bash
git add docs README.md .github package.json
git commit -m "docs: 中文使用手册、README、评分口径与发布准备"
```

---

## 计划自审记录

- **Spec 覆盖**：§1（成功标准 → Task 19 验收）· §3（约束 → Global Constraints + Task 7）· §4（产品 → Task 16/17/18）· §5.2 目录（→ 各任务路径）· §5.3 数据流（→ Task 15）· §5.4 数据模型（→ Task 2）· §5.5 额度（→ Task 7）· §6 评分（→ Task 3/4/5/6）· §7 涨星阶梯（→ Task 12）· §8 容错（→ Task 7/8/12/15）· §9 部署预留（→ Task 19 Step 4）· §10 测试（→ 每任务测试步骤）· §11 交付物（→ Task 18/19）· §12 不做（→ Global Constraints："无执行能力"）· §13 扩展点（→ 配置与接口分离）· §14 里程碑（→ 四个 Phase）· §15 的 O1（→ Task 12 级别 0 优雅失败）。
- **v2 变更落实**：SQLite 与执行器已从计划中移除；所有数据路径改为 `public/data/*.json`；Task 16 由"API 服务"改为"静态服务器"；Task 12 级别 3 改为读历史 JSON；`checkLocalEnv` 已删除。
- **类型一致性**：`confidence` 三值（Task 3/5/12/15/17/18）· `kind` 取值（Task 4/6/14）与 `RUNNABLE_POINTS` 键一致 · 榜单 id `weekly|newbie|classic` 全程一致 · `BoardResult` 形状（Task 15/16/17）· `RankedItem` 字段（Task 6/15）一致。
- **Review Focus 落点**：①同名包 → Task 10；②断网/额度 → Task 7/15/16；③trending 改版 → Task 8；④历史 JSON 损坏 → Task 12/13；⑤估算被当事实 → Task 3/5/15/17。

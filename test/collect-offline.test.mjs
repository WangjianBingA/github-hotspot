// GitHub 好玩榜 —— collect 主流程的离线集成测试。
//
// 这些用例**一律不发网络请求**：要么注入假的 sources（简报的接口契约），
// 要么注入假 client + 真实 sources（证明生产接线真的把字段写进了 JSON）。
// 全部读写在 mkdtempSync 给的临时目录里，绝不碰仓库里的 public/data/。
//
// 覆盖：简报的 5 条用例 + 控制者裁定 R26/R33/R35/R41/R53/R78。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollect } from '../src/collect.mjs';
import { createOfflineSources, createRealSources } from '../src/sources/pipeline.mjs';
import { readDaily, listDates, readHistory, writeDaily, appendHistory } from '../src/store/datastore.mjs';
import { RateLimitError } from '../src/net/client.mjs';
import candidates from '../fixtures/candidates.json' with { type: 'json' };

const dir = () => mkdtempSync(join(tmpdir(), 'hs-'));
const NOW = new Date('2026-10-10T00:00:00Z');
const okSources = { discover: async () => candidates, enrich: async (c) => c };

// 注入用的候选池必须是**副本**：runCollect 会就地补写 repo.hasRelease90d 与 extra.growing，
// 直接改共享的 fixture 会让同进程里的其它测试文件拿到被改写过的数据。
const cloneCandidates = () => structuredClone(candidates);

/** 某个榜单里有名次的项目（有序的 ownerRepo 列表）。 */
const boardIds = (r, id) => r.boards.find((b) => b.id === id).items.map((x) => x.repo.ownerRepo);
const jsonItems = (r, id) => JSON.parse(r.json).boards.find((b) => b.id === id).items;

// ---------- 简报 Step 1 的五条用例（原文，不改弱） ----------

test('离线跑完整流程：三榜有内容、JSON 落盘、日报可生成', async () => {
  const d = dir();
  const r = await runCollect({ dataDir: d, offline: true, now: NOW, sources: okSources });
  assert.equal(r.date, '2026-10-10');
  assert.equal(r.boards.length, 3);
  assert.ok(r.boards.find((b) => b.id === 'weekly').items.length > 0);
  assert.ok(r.boards.find((b) => b.id === 'classic').items.length <= 30);
  assert.deepEqual(listDates(d), ['2026-10-10']);
  assert.equal(readDaily(d, '2026-10-10').boards.length, 3);
  assert.ok(readHistory(d, '2026-10')['2026-10-10']);
});

test('断网时不得抛错且标记 degraded', async () => {
  const d = dir();
  const r = await runCollect({
    dataDir: d,
    offline: true,
    now: NOW,
    sources: { discover: async () => { throw new Error('ENETUNREACH'); }, enrich: async (c) => c },
  });
  assert.equal(r.degraded, true);
  assert.equal(r.boards.length, 3);
});

test('同一天重复运行不产生重复条目', async () => {
  const d = dir();
  await runCollect({ dataDir: d, offline: true, now: NOW, sources: okSources });
  const n1 = readDaily(d, '2026-10-10').boards.find((b) => b.id === 'weekly').items.length;
  await runCollect({ dataDir: d, offline: true, now: NOW, sources: okSources });
  const n2 = readDaily(d, '2026-10-10').boards.find((b) => b.id === 'weekly').items.length;
  assert.equal(n1, n2);
});

test('某个候选富化失败不影响整轮，其余仍在榜', async () => {
  const d = dir();
  const r = await runCollect({
    dataDir: d,
    offline: true,
    now: NOW,
    sources: {
      discover: async () => candidates,
      enrich: async (c) => { if (c.repo.ownerRepo === 'a/b0') throw new Error('boom'); return c; },
    },
  });
  assert.ok(r.boards.find((b) => b.id === 'weekly').items.length > 0);
});

test('日报 Markdown 里估算值必须带"约"与"估算"', async () => {
  const d = dir();
  const est = candidates.map((c) => ({
    ...c,
    velocity: { gained7d: 100, gained3d: null, level: 4, confidence: 'estimated', source: 'events' },
  }));
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: { discover: async () => est, enrich: async (c) => c },
  });
  assert.match(r.markdown, /约|估算/);
});

// ---------- Task 19：离线采集写进真实数据目录时，那一天必须自己带着"这是样本"这一位 ----------

test('R128：离线采集写进数据目录的每一天都带 demo 标记，清单也跟着标；真实采集不带', async () => {
  // 手册里对 `npm run collect:offline` 的承诺正是这一条：产物写进你自己的数据目录（public/data），
  // 而页面上照样会标注"这是演示数据"。这个标记**必须由采集时写进当天数据本身**才对得住那句话——
  // 页面只读当天数据与清单，它不会（也不该）去猜这份数据是从哪来的。
  const d = dir();
  await runCollect({ dataDir: d, offline: true, now: NOW, sources: okSources });
  assert.equal(readDaily(d, '2026-10-10').demo, true, '离线采集写下的当天数据必须自带 demo 位');
  const index = JSON.parse(readFileSync(join(d, 'index.json'), 'utf8'));
  assert.equal(index.demo, true, '清单里的 demo 位由当天数据派生，否则归档页标不出来');

  // 反向对照：同一条流程、只把 offline 换成 false（仍然注入假 sources，绝不联网），这一位必须消失。
  const d2 = dir();
  await runCollect({ dataDir: d2, offline: false, now: NOW, sources: okSources });
  assert.equal(readDaily(d2, '2026-10-10').demo, undefined, '真实采集不许被标成演示数据');
  const index2 = JSON.parse(readFileSync(join(d2, 'index.json'), 'utf8'));
  assert.equal(index2.demo, undefined, '真实数据的清单也不许带这一位');
});

// ---------- R26：经典榜必须吃自己的池子，不是周榜候选的投影 ----------

test('R26 经典榜只排 discover 单独给出的经典池，不混入周榜候选', async () => {
  const d = dir();
  const classic = [
    { repo: { ownerRepo: 'classic/one', name: 'one', stars: 300000, forks: 100, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false }, runnability: { kind: 'none', verified: false, chineseDoc: false } },
    { repo: { ownerRepo: 'classic/two', name: 'two', stars: 250000, forks: 90, language: 'Rust', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false }, runnability: { kind: 'none', verified: false, chineseDoc: false } },
  ];
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: { discover: async () => ({ candidates, classic: async () => classic }), enrich: async (c) => c },
  });
  const ids = boardIds(r, 'classic');
  // 经典池里只有这两个；周榜的 fixture 候选一个都不许串进来。
  assert.deepEqual(ids, ['classic/one', 'classic/two']);
  assert.ok(!ids.includes('gamma/pdfsmith'));
  // 反过来，周榜也不该被经典池污染。
  assert.ok(!boardIds(r, 'weekly').includes('classic/one'));
});

test('R26 经典池拿不到时退化为候选池，但必须标 degraded', async () => {
  const d = dir();
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: {
      discover: async () => ({ candidates, classic: async () => { throw new Error('search 挂了'); } }),
      enrich: async (c) => c,
    },
  });
  assert.equal(r.degraded, true);
  assert.ok(boardIds(r, 'classic').length > 0, '仍然要用候选池出一份经典榜，不能空着');
});

// ---------- R33：RateLimitError 立刻中止本轮，不再逐个候选重试 ----------

test('R33 额度耗尽时立刻停止富化并标记 degraded', async () => {
  const d = dir();
  const pool = [
    { repo: { ownerRepo: 'e/one', stars: 1000, forks: 10, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false }, runnability: { kind: 'none', verified: true, chineseDoc: false }, extra: { growing: false } },
    { repo: { ownerRepo: 'e/two', stars: 900, forks: 9, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false }, runnability: { kind: 'none', verified: true, chineseDoc: false }, extra: { growing: false } },
    { repo: { ownerRepo: 'e/three', stars: 800, forks: 8, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false }, runnability: { kind: 'none', verified: true, chineseDoc: false }, extra: { growing: false } },
    { repo: { ownerRepo: 'e/four', stars: 700, forks: 7, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false }, runnability: { kind: 'none', verified: true, chineseDoc: false }, extra: { growing: false } },
  ];
  let enriched = 0;
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: {
      discover: async () => pool,
      enrich: async (c) => {
        enriched++;
        if (c.repo.ownerRepo === 'e/two') throw new RateLimitError('额度耗尽', 1790000000);
        return c;
      },
    },
  });
  assert.equal(r.degraded, true);
  // e/one 成功、e/two 抛额度错 → 立刻收工，e/three 与 e/four 一次都不该被富化。
  assert.equal(enriched, 2, 'RateLimitError 之后不得继续逐个候选重试');
  assert.equal(r.boards.length, 3);
});

// ---------- R35：trending 返回空必须是"我们没查到"，不能静默 ----------

test('R35 trending 空结果必须记警告并标 degraded', async () => {
  const d = dir();
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: {
      discover: async () => ({ candidates: [], classic: async () => [], trending: async () => [] }),
      enrich: async (c) => c,
    },
  });
  assert.equal(r.degraded, true);
  assert.ok(r.warnings.some((w) => w.includes('trending')), `警告里要提到 trending：${r.warnings.join(' | ')}`);
  assert.equal(JSON.parse(r.json).degraded, true, 'degraded 必须落进网站读的那份 JSON');
});

test('R35 trending 拿到了内容就不该只因为这一项标 degraded', async () => {
  const d = dir();
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: {
      discover: async () => ({ candidates: candidates.slice(0, 4), classic: async () => [], trending: async () => ([{ ownerRepo: 'a/b' }]) }),
      enrich: async (c) => c,
    },
  });
  assert.ok(!r.warnings.some((w) => w.includes('trending')));
});

// ---------- R53：先跑免费级，再对争夺名次的候选开付费级 ----------

test('R53 免费级先跑完且一分额度都不花，预算留给争榜候选', async () => {
  const d = dir();
  const requested = [];
  const fake = {
    getJson: async (url) => { requested.push(url); return null; },
    fetchText: async (url) => { requested.push(url); return null; },
    stats: () => ({ coreCalls: 0, searchCalls: 0, cacheHits: 0, degraded: false }),
  };
  const mk = (ownerRepo, stars) => ({
    repo: {
      ownerRepo, name: ownerRepo.split('/')[1], stars, forks: 100, language: 'Go',
      license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false, defaultBranch: 'main',
    },
    // npmBinWin(16) 是"已核实的安装路径"，两个候选都能过门槛、都在争名次。
    runnability: { kind: 'npmBinWin', verified: true, chineseDoc: false },
    extra: { growing: false },
  });
  const pool = [mk('free/first', 9000), mk('free/second', 8000)];

  const r = await runCollect({
    // 这里刻意**不传 offline**：这一条要证明"付费级只花在该花的候选身上"，
    // 所以必须让注入的 client 真的被调用到（offline 会把所有请求掐掉，就什么都验证不了）。
    dataDir: d, client: fake, now: NOW,
    sources: {
      discover: async () => ({ candidates: pool, classic: async () => [], trending: async () => ([{ ownerRepo: 'free/first', starsThisWeek: 4321 }]) }),
      enrich: async (c) => c,
      // 真实的 resolveVelocity 语义：级别 0/4 要发请求，级别 1/2/3 免费。
      resolveVelocity: async (c, { client, freeOnly }) => {
        const week = 4321;
        if (c.repo.ownerRepo === 'free/first') {
          // 级别 2（trending 官方口径，免费）——免费级必须命中，于是付费级对它不再开。
          return { gained7d: week, gained3d: null, level: 2, confidence: 'reported', source: 'trending' };
        }
        // free/second 免费级全部落空：只有付费级才可能给它答案。
        if (freeOnly) return { gained7d: 0, gained3d: null, level: 4, confidence: 'estimated', source: 'none' };
        await client.getJson('https://api.github.com/repos/free/second/events?per_page=100', { api: 'core' });
        return { gained7d: 777, gained3d: null, level: 4, confidence: 'estimated', source: 'events' };
      },
    },
  });

  // 免费级全程不该发出一分请求；付费级只为争榜候选开，且这里恰好只有 free/second。
  assert.deepEqual(requested, ['https://api.github.com/repos/free/second/events?per_page=100']);
  const weekly = jsonItems(r, 'weekly');
  assert.equal(weekly.find((x) => x.ownerRepo === 'free/first').starsGained7d, 4321);
  assert.equal(weekly.find((x) => x.ownerRepo === 'free/second').starsGained7d, 777);
});

// ---------- R41：两个"没有生产者"的评分子项，必须在真实接线下被写进 JSON ----------

test('R41 真实 sources 跑一轮：hasRelease90d 与 growing 被真正写入结果', async () => {
  const d = dir();
  // 先用与 Task 12 同一份历史 JSON 埋下 7 天前的快照：只有 alpha/one 的星数低于今天 → growing true。
  writeDaily(d, '2026-10-03', {
    date: '2026-10-03',
    boards: [{ id: 'weekly', title: '本周飙升', items: [{ ownerRepo: 'alpha/one', stars: 100 }] }],
  });
  appendHistory(d, '2026-10-03', new Map([['alpha/one', { stars: 100, forks: 10 }]]));

  const client = makeFakeClient();
  const sources = createRealSources({ client, dataDir: d, now: NOW });
  const pool = [
    realCandidate('alpha/one', {
      description: '把 PDF 变成文字', language: 'Python', stars: 9000, forks: 500,
      license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', npmPackage: 'pkg-alpha-one',
    }),
    realCandidate('beta/two', {
      description: '在浏览器里画流程图的工具', language: 'TypeScript', stars: 8000, forks: 400,
      license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', pypiPackage: 'pypi-beta-two',
    }),
  ];
  const r = await runCollect({
    // 真实管线 + 假 client：**不传 offline**（offline 会把所有请求掐掉，那样就什么都没验证到）。
    // 假 client 按响应形状作答，绝不会真的打网络。
    dataDir: d, client, now: NOW,
    sources: {
      discover: async () => ({ candidates: pool, classic: async () => [], trending: async () => ([{ ownerRepo: 'alpha/one', starsThisWeek: 500 }]) }),
      enrich: sources.enrich,
      resolveVelocity: sources.resolveVelocity,
    },
  });

  const weekly = jsonItems(r, 'weekly');
  assert.ok(weekly.length >= 2, '两个候选都该过门槛进周榜');
  // ① hasRelease90d 由 hasRecentRelease(最新 release, now) 写成，不再靠 fixture 手写。
  for (const item of weekly) assert.equal(item.hasRelease90d, true, `${item.ownerRepo} 的 hasRelease90d 应由 release 现算`);
  // ② growing 由同一份历史 JSON 算出：有正增长 → true；没有历史 → null（中性半分，不惩罚新项目）。
  assert.equal(weekly.find((x) => x.ownerRepo === 'alpha/one').growing, true);
  assert.equal(weekly.find((x) => x.ownerRepo === 'beta/two').growing, null);
  // ③ hasRelease90d=true → 口碑轴的 release90d 拿满 6 分（生产环境曾经恒 0）。
  assert.equal(weekly.find((x) => x.ownerRepo === 'alpha/one').scores.release90d, 6);
  assert.equal(weekly.find((x) => x.ownerRepo === 'alpha/one').scores.growth, 4);
  assert.equal(weekly.find((x) => x.ownerRepo === 'beta/two').scores.growth, 2);
  // ④ 同一份数据也要落盘：网站读的是文件，不是返回值。
  const onDisk = readDaily(d, '2026-10-10').boards.find((b) => b.id === 'weekly').items;
  assert.equal(onDisk.find((x) => x.ownerRepo === 'alpha/one').hasRelease90d, true);
  assert.equal(onDisk.find((x) => x.ownerRepo === 'alpha/one').growing, true);
  assert.equal(onDisk.find((x) => x.ownerRepo === 'beta/two').growing, null);
});

test('R41 "没问到"必须标 degraded，而不是静默当成"没有"', async () => {
  const d = dir();
  // enrich 什么都不知道（没问 release、没有历史）→ 两个字段都是"未知"。
  // 控制者裁定 R79：这个候选必须有一条**真正能过的安装路径**（npmBinWin + verified），
  // 否则门槛 5（verified===true && RUNNABLE_POINTS[kind] > 0）会把它挡在周榜外，
  // 于是"周榜里第一条的 hasRelease90d 是 null"这个断言根本无从谈起（前提不可达的测试）。
  // 这里只改了 fixture 的前提（kind: 'none' → 'npmBinWin'），断言与意图一字未动。
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: {
      discover: async () => ([{
        repo: { ownerRepo: 'x/y', stars: 1000, forks: 10, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false },
        runnability: { kind: 'npmBinWin', verified: true, chineseDoc: false },
      }]),
      enrich: async (c) => c,
    },
  });
  assert.equal(r.degraded, true);
  assert.ok(r.warnings.some((w) => w.includes('hasRelease90d')), r.warnings.join(' | '));
  assert.ok(r.warnings.some((w) => w.includes('growing')), r.warnings.join(' | '));
  const item = jsonItems(r, 'weekly')[0];
  assert.equal(item.hasRelease90d, null, '"没问到"必须是 null，不能退化成 false');
  assert.equal(item.growing, null);
});

test('R41 明确 false 不等于"没问到"：确认没有发版时不得标 degraded', async () => {
  const d = dir();
  // 两个字段都带着**明确的 false**（"问过了，答案是 7 天前到今天的星数没涨"），
  // 所以两条降级警告都不该出现。历史快照用 Map 写（appendHistory 的契约），
  // 与同文件其它用例保持同一形状，不用一个会被 Object.fromEntries 摊平的空对象蒙过去。
  writeDaily(d, '2026-10-03', {
    date: '2026-10-03',
    boards: [{ id: 'weekly', title: '本周飙升', items: [{ ownerRepo: 'x/y', stars: 1000 }] }],
  });
  appendHistory(d, '2026-10-03', new Map([['x/y', { stars: 1000, forks: 10 }]]));
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: {
      discover: async () => ({
        candidates: [{
          repo: { ownerRepo: 'x/y', stars: 1000, forks: 10, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false, hasRelease90d: false },
          runnability: { kind: 'none', verified: true, chineseDoc: false },
          extra: { growing: false },
        }],
        // 给一份**合法的**经典池：R87 之后空池会（正确地）记一条"经典榜只能用候选池"的警告，
        // 而这条用例要断言"整轮一条警告都没有"，不能让它被一条空池噪声带走。
        classic: async () => [{
          repo: { ownerRepo: 'classic/one', name: 'one', stars: 300000, forks: 100, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false },
          runnability: { kind: 'none', verified: false, chineseDoc: false },
        }],
      }),
      enrich: async (c) => c,
    },
  });
  assert.equal(r.degraded, false);
  assert.deepEqual(r.warnings, []);
});

// ---------- R78：安装向导必须嵌进 JSON，网站不许自己再实现一遍 ----------

test('R78 每条 item 的 install 里都带着生成好的 steps 与 faq', async () => {
  const d = dir();
  const r = await runCollect({ dataDir: d, offline: true, now: NOW, sources: okSources });
  const onDisk = readDaily(d, '2026-10-10');
  for (const board of onDisk.boards) {
    for (const item of board.items) {
      assert.equal(item.install.steps.length, 3, `${item.ownerRepo} 的三步向导`);
      assert.ok(item.install.steps[1].command || item.install.steps[1].downloadUrl || item.install.steps[1].body);
      assert.ok(item.install.faq.length >= 3, `${item.ownerRepo} 的常见问题`);
      assert.equal(item.install.chineseDoc, item.chineseDoc);
      assert.equal(item.install.hasChinese, item.hasChinese);
    }
  }
});

// ---------- R65/R66/R67（+R82 的探针上限）：build/docker 证据只能来自真实读到的文件 ----------

test('R65/R66/R67 证据旗标来自真实探到的文件：Dockerfile → dockerOnly，Cargo.toml → buildFromSource', async () => {
  const d = dir();
  const client = makeFakeClient();
  // 三个候选一个包名都不给（npm/PyPI 直查因此不会发生），安装路径只能靠证据探针：
  //   code/docker-repo 有 Dockerfile   → dockerOnly（4 分，门槛放行）
  //   code/make-repo   有 Cargo.toml   → buildFromSource（6 分，门槛放行）
  //   code/plain-repo  探针一个都读不到 → 没有已核实的安装方式 → 被门槛 5 挡下（正确结果）
  // 探针列表按 R82 收敛为 Dockerfile / docker-compose.yml / Cargo.toml / go.mod 这 4 个。
  const pool = [
    realCandidate('code/docker-repo', { description: '只有 Docker 能跑的服务', stars: 5000 }),
    realCandidate('code/make-repo', { description: '要从源码编译的命令行工具', stars: 4000 }),
    realCandidate('code/plain-repo', { description: '什么安装证据都没有的项目', stars: 3000 }),
  ];
  const r = await runRealPipeline({ dataDir: d, client, candidates: pool });

  const weekly = jsonItems(r, 'weekly');
  const ids = weekly.map((x) => x.ownerRepo);
  // 只有真的探到证据的两条能进周榜（顺序由评分决定，这里只断言集合）。
  assert.deepEqual([...ids].sort(), ['code/docker-repo', 'code/make-repo'], `只有有证据的两条能进周榜：${ids.join(',')}`);
  assert.equal(weekly.find((x) => x.ownerRepo === 'code/docker-repo').install.kind, 'dockerOnly');
  assert.equal(weekly.find((x) => x.ownerRepo === 'code/make-repo').install.kind, 'buildFromSource');
  // 两个旗标本身也是"已核实的安装路径"，否则门槛 5 会把它们挡掉。
  assert.equal(weekly.find((x) => x.ownerRepo === 'code/docker-repo').install.verified, true);
  assert.equal(weekly.find((x) => x.ownerRepo === 'code/make-repo').install.verified, true);
  assert.ok(!ids.includes('code/plain-repo'), '没有任何安装证据的候选必须被门槛挡在榜外，不许编一条路');
});

test('R82 探针最多 4 个文件、命中即停（不会为了第二个证据域再探一轮）', async () => {
  const d = dir();
  const requested = [];
  const client = makeFakeClient({ record: requested });
  const pool = [
    realCandidate('code/docker-repo', { description: '有 Dockerfile', stars: 5000 }),
    realCandidate('code/make-repo', { description: '有 Cargo.toml', stars: 4000 }),
    realCandidate('code/plain-repo', { description: '什么都没有', stars: 3000 }),
  ];
  await runRealPipeline({ dataDir: d, client, candidates: pool });

  // 只看证据探针：README 的抓取也走 raw，但它不属于探针（别把它数进来）。
  const probes = requested.filter((url) => url.startsWith('https://raw.githubusercontent.com/') && !url.includes('/README'));
  const perRepo = (ownerRepo) => probes.filter((url) => url.includes(`/${ownerRepo}/`));
  // 命中即停：docker-repo 第 1 个就命中；make-repo 探到第 3 个（Cargo.toml）才命中。
  assert.equal(perRepo('code/docker-repo').length, 1, 'Dockerfile 命中后不许再探');
  assert.equal(perRepo('code/make-repo').length, 3, 'Dockerfile / docker-compose.yml 都没有，才轮到 Cargo.toml');
  // 一个都没有的候选：恰好 4 次（上限），不是旧实现的 10 次。
  assert.equal(perRepo('code/plain-repo').length, 4, 'R82：探针列表上限就是 4 个');
  assert.ok(probes.every((url) => /(Dockerfile|docker-compose\.yml|Cargo\.toml|go\.mod)$/.test(url)),
    `探针只许打这 4 个文件名：${probes.join(' | ')}`);
});

test('R66 npx 有 bin 但只声明 Linux/macOS 时，绝不降级成 npmNoBin（先读 Dockerfile 证据）', async () => {
  const d = dir();
  const client = makeFakeClient({ npmLinuxOnly: true });
  const pool = [
    realCandidate('code/linux-cli', {
      description: '只有 Linux 版的命令行工具', stars: 6000, npmPackage: 'pkg-linux-only',
      defaultBranch: 'develop',
    }),
  ];
  const r = await runRealPipeline({ dataDir: d, client, candidates: pool });

  const item = jsonItems(r, 'weekly').find((x) => x.ownerRepo === 'code/linux-cli');
  assert.ok(item, 'Dockerfile 是一条真实路径，这个项目必须还在周榜上');
  assert.equal(item.install.kind, 'dockerOnly', 'npm 那条路走不通时该落到 Docker，而不是被错误地标成 npmNoBin');
  assert.notEqual(item.install.kind, 'npmNoBin');
  assert.equal(item.install.command, null, '既不能给 npx（Windows 装不上），也不能给 npm install（那是另一件事）');
});

// ---------- R80：R41 的降级审计范围只到"会被展示分数的候选" ----------

test('R80 只有经典池候选"没问到"时不得降级（该榜不展示三轴分数，这两个字段没有消费者）', async () => {
  const d = dir();
  const classic = [
    // 经典榜候选走轻富化：没人问过它 release，也没有历史 → 两个三态字段都是"没问到"。
    { repo: { ownerRepo: 'classic/one', name: 'one', stars: 300000, forks: 100, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false }, runnability: { kind: 'none', verified: false, chineseDoc: false } },
  ];
  const pool = [
    // 周榜候选把两个字段都**明确问到**了，好让这条断言只针对"经典池未问到"这一个原因。
    { repo: { ownerRepo: 'fine/one', stars: 2000, forks: 50, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false, hasRelease90d: false }, runnability: { kind: 'npmBinWin', verified: true, chineseDoc: false }, extra: { growing: false } },
  ];
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: { discover: async () => ({ candidates: pool, classic: async () => classic }), enrich: async (c) => c },
  });

  // 前提检查：经典池候选确实被展出、而且它的两个字段确实是"没问到"——
  // 否则这条用例会因为"根本没发生这件事"而变成空断言。
  assert.deepEqual(boardIds(r, 'classic'), ['classic/one']);
  const classicItem = jsonItems(r, 'classic')[0];
  assert.equal(classicItem.hasRelease90d, null);
  assert.equal(classicItem.growing, null);
  // R80：经典榜不参与三轴评分，这两个字段在那里没有消费者，所以不算"数据不可用"。
  assert.equal(r.degraded, false, `只有经典池没问到时不该降级：${r.warnings.join(' | ')}`);
  assert.deepEqual(r.warnings, []);
  assert.equal(JSON.parse(r.json).degraded, false, '网站读的那份 JSON 也不该说"本期数据不完整"');
});

test('R80 weekly/newbie 的候选"没问到"时仍然必须降级（收窄审计范围不等于放宽它）', async () => {
  const d = dir();
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: {
      discover: async () => ({ candidates: [
        // 有已核实安装路径，因此真能进周榜/新手榜；但两个三态字段都没问到。
        { repo: { ownerRepo: 'hot/one', stars: 2000, forks: 50, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false }, runnability: { kind: 'npmBinWin', verified: true, chineseDoc: false } },
      ], classic: async () => [] }),
      enrich: async (c) => c,
    },
  });

  assert.ok(boardIds(r, 'weekly').includes('hot/one'), '前提：这个候选确实上了周榜');
  assert.equal(r.degraded, true);
  assert.ok(r.warnings.some((w) => w.includes('hasRelease90d')), r.warnings.join(' | '));
  assert.ok(r.warnings.some((w) => w.includes('growing')), r.warnings.join(' | '));
});

// ---------- R83：只有"额度真的用尽"或 RateLimitError 才允许中止富化 ----------

test('R83 客户端的一般 degraded 不得中止富化：单候选失败只跳过并计数、归因准确', async () => {
  const d = dir();
  // 假 client 声称 degraded（真实场景：一次 5xx/超时，连 api:'none' 的请求也会置这个粘性标志）。
  const fake = {
    getJson: async () => null,
    fetchText: async () => null,
    stats: () => ({ coreCalls: 1, searchCalls: 0, cacheHits: 0, degraded: true }),
  };
  const pool = [
    { repo: { ownerRepo: 'r/one', stars: 3000, forks: 100, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false } },
    { repo: { ownerRepo: 'r/two', stars: 2000, forks: 50, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false } },
  ];
  let tried = 0;
  const r = await runCollect({
    dataDir: d, client: fake, now: NOW,
    sources: {
      discover: async () => pool,
      enrich: async (c) => {
        tried++;
        if (c.repo.ownerRepo === 'r/one') throw new Error('ETIMEDOUT 一次超时');
        return c;
      },
    },
  });

  // 旧实现：看到 degraded 就在第一个候选之前 break → tried === 0 → 两个榜全空。
  assert.equal(tried, 2, '一个瞬时失败不得让整轮停止富化');
  assert.ok(r.warnings.some((w) => w.includes('ETIMEDOUT')), `警告里要有失败原因：${r.warnings.join(' | ')}`);
  assert.ok(!r.warnings.some((w) => w.includes('额度耗尽')), `不得把一次超时归因成额度耗尽：${r.warnings.join(' | ')}`);
});

// ---------- R84：审计直接读榜上条目；拿不到新数据时复用旧榜单 ----------

test('R84a 同一仓库在两池各有一份、只有经典那份"没问到" → 不得 degraded', async () => {
  const d = dir();
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: {
      discover: async () => ({
        // 经典池里这个仓库**没有**被富化（两个字段都缺）——旧实现按 ownerRepo 反查，
        // 会拿这一份去审计周榜，于是点名一个所有被展示条目其实都产出了的字段。
        candidates: [{
          repo: { ownerRepo: 'dup/repo', stars: 5000, forks: 200, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false, hasRelease90d: false },
          runnability: { kind: 'npmBinWin', verified: true, chineseDoc: false },
          extra: { growing: false },
        }],
        classic: async () => [{
          repo: { ownerRepo: 'dup/repo', name: 'repo', stars: 300000, forks: 100, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false },
          runnability: { kind: 'none', verified: false, chineseDoc: false },
        }],
      }),
      enrich: async (c) => c,
    },
  });

  // 前提：两份副本确实各自在榜上、且经典那一份的两个字段确实是"没问到"。
  assert.deepEqual(boardIds(r, 'weekly'), ['dup/repo']);
  assert.deepEqual(boardIds(r, 'classic'), ['dup/repo']);
  const classicItem = jsonItems(r, 'classic')[0];
  assert.equal(classicItem.hasRelease90d, null);
  assert.equal(classicItem.growing, null);
  assert.equal(r.degraded, false, `被展示的那份两个字段都问到了，不该降级：${r.warnings.join(' | ')}`);
  assert.deepEqual(r.warnings, []);
});

test('R84b 拿不到新候选时复用最近一天的榜单，并把 note 写成事实', async () => {
  const d = dir();
  // 先埋一份"昨天"的榜单。
  const yesterday = await runCollect({ dataDir: d, offline: true, now: new Date('2026-10-09T00:00:00Z'), sources: okSources });
  assert.ok(yesterday.boards.find((b) => b.id === 'weekly').items.length > 0, '前提：昨天那份榜单非空');

  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: { discover: async () => { throw new Error('ENETUNREACH'); }, enrich: async (c) => c },
  });

  assert.equal(r.date, '2026-10-10');
  assert.ok(r.boards.find((b) => b.id === 'weekly').items.length > 0, '必须真的拿旧榜单出一份榜，不能空着');
  assert.ok(r.warnings.some((w) => w.includes('2026-10-09')), `note 要说出用的是哪一天：${r.warnings.join(' | ')}`);
  assert.equal(r.degraded, true);
});

test('R92 复用的候选不重新富化：昨日那份三态值必须原样保留，不得被覆写成 null', async () => {
  const d = dir();
  // 昨日那份榜单里，两个三态字段都带着**明确的结论**（不是 null）。如果这一轮又去富化，
  // 它们会被"这一轮查不到"覆写成 null —— 那正是"复用等于白做"。
  writeDaily(d, '2026-10-09', {
    date: '2026-10-09',
    generatedAt: '2026-10-09T00:00:00Z',
    degraded: false,
    notes: [],
    boards: [{ id: 'weekly', title: '本周飙升', items: [{
      rank: 1, ownerRepo: 'keep/one', stars: 4321, forks: 100, language: 'Go', license: 'MIT',
      hasRelease90d: true, growing: false,
      repo: { ownerRepo: 'keep/one', name: 'one', stars: 4321, forks: 100, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false },
      runnability: { kind: 'npmBinWin', verified: true, chineseDoc: false },
      velocity: { gained7d: 777, gained3d: null, level: 2, confidence: 'reported', source: 'trending' },
      scores: { hot: 30, reputation: 20, runnable: 16, total: 66 },
      reasons: ['这一条来自昨日榜单'],
    }] }],
  });
  let enriched = 0;
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: {
      discover: async () => { throw new Error('ENETUNREACH'); },
      // 真实富化会把两个字段写成"这一轮的结果"（这里刻意写成与昨日相反的值，以便一旦被调用就能看出来）。
      enrich: async (c) => { enriched++; c.repo.hasRelease90d = false; c.extra = { ...c.extra, growing: true }; return c; },
      resolveVelocity: async () => ({ gained7d: 0, gained3d: null, level: 4, confidence: 'estimated', source: 'none' }),
    },
  });

  assert.ok(r.warnings.some((w) => w.includes('2026-10-09')), '前提：这一轮走的是复用路径');
  const item = jsonItems(r, 'weekly')[0];
  assert.equal(item.ownerRepo, 'keep/one');
  assert.equal(item.hasRelease90d, true, '复用来的 hasRelease90d 必须还是昨日那份的值');
  assert.equal(item.growing, false, '复用来的 growing 必须还是昨日那份的值');
  assert.equal(item.starsGained7d, 777, '复用来的涨星速度同样不该被这一轮覆写');
  assert.equal(enriched, 0, 'R92：复用的候选一个都不该被重新富化');
});

test('R84b 无新数据也无旧榜可复用时，不得把今天已有的文件覆盖成空榜', async () => {
  const d = dir();
  // 今天已经有一份好数据；这个目录里**没有**更早的日期，所以没有东西可复用。
  const seeded = { date: '2026-10-10', generatedAt: '2026-10-10T00:00:00Z', degraded: false, notes: [], boards: [{ id: 'weekly', title: '本周飙升', items: [{ ownerRepo: 'keep/me', stars: 999 }] }] };
  writeDaily(d, '2026-10-10', seeded);

  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: {
      discover: async () => ({ candidates: [], classic: async () => [], trending: async () => ([{ ownerRepo: 'a/b' }]) }),
      enrich: async (c) => c,
    },
  });

  assert.deepEqual(readDaily(d, '2026-10-10'), seeded, '今天已有的榜单文件必须原样保留');
  assert.equal(r.wroteDaily, false);
  assert.ok(r.warnings.some((w) => w.includes('没有覆盖')), `要如实说明跳过了写入：${r.warnings.join(' | ')}`);
  // R91：这条 note 必须在 payload **之前**记，否则它只进 warnings 与 Markdown，
  // 却不进网站真正读的那份 JSON —— 三个输出不一致。
  const skipped = r.warnings.find((w) => w.includes('没有覆盖'));
  assert.ok(JSON.parse(r.json).notes.includes(skipped), 'r.json 的 notes 里必须有这条说明');
  assert.ok(r.payload.notes.includes(skipped), 'payload.notes 也必须一致');
  assert.ok(r.markdown.includes('没有覆盖') || r.markdown.includes('没有拿到任何内容'), 'Markdown 里也要有');
});

// ---------- R85：日报 Markdown 与 JSON 同源，必须真的给出安装方式 ----------

test('R85 日报 Markdown 里确实出现安装命令或下载链接（与 JSON 同一份数据）', async () => {
  const d = dir();
  // 给一个**真的带命令**的安装路径：简报道具里的 runnability 只写了 kind/verified，
  // 没有 command，而 R85 要验证的正是"命令/下载链接能走到日报里"。
  const pool = [{
    repo: { ownerRepo: 'cmd/one', name: 'one', description: '带命令的示例项目', language: 'Go', stars: 3000, forks: 100, license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false },
    runnability: { kind: 'npmBinWin', command: 'npx cmd-one', verified: true, chineseDoc: false },
    extra: { growing: false },
  }];
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: { discover: async () => ({ candidates: pool, classic: async () => [] }), enrich: async (c) => c },
  });

  // 旧实现把 RankedItem 交给 markdown 渲染器，install 分支永远执行不到 → 日报里从来没有安装方式。
  assert.match(r.markdown, /装法：`npx cmd-one`/, '日报里必须给出可复制的安装命令');
  assert.match(r.markdown, /总分 \*\*\d+\.\d\*\*/, '总分也应来自同一份 payload');

  // 同源：日报里那条命令必须与 JSON 里第 2 步的命令逐字一致。
  const first = jsonItems(r, 'weekly')[0];
  assert.equal(first.install.steps[1].command, 'npx cmd-one');
  assert.ok(r.markdown.includes(first.install.steps[1].command), '日报里的命令要与 JSON 里的一致');
});

// ---------- R86：付费速度阶梯在生产里必须真的跑得到 ----------

test('R86 经典池不花计费请求、额度留给付费速度：能跑出非零的实测涨星', async () => {
  const d = dir();
  const requested = [];
  const client = makeFakeClient({ record: requested });
  // 20 个候选：如果每个都去查 release，45 次预算在付费阶梯之前就用光了（旧行为）。
  const pool = structuredClone(candidates).slice(0, 20).map((c) => ({
    repo: {
      ownerRepo: c.repo.ownerRepo, name: c.repo.name, description: c.repo.description,
      language: c.repo.language, stars: c.repo.stars, forks: c.repo.forks,
      license: c.repo.license, pushedAt: '2026-10-09T00:00:00Z', archived: false, defaultBranch: 'main',
    },
    extra: {},
  }));
  const classic = [{
    repo: { ownerRepo: 'classic/big', name: 'big', stars: 300000, forks: 100, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false },
    runnability: { kind: 'none', verified: false, chineseDoc: false },
  }];
  const firstRepo = pool[0].repo.ownerRepo;

  const r = await runRealPipeline({
    dataDir: d, client, candidates: pool, classic,
    // trending 是**真页面**的形状：假 client 的 fetchText 会答一份 weekly 页面的最小 HTML，
    // 于是第一个候选走**免费**的级别 2（trending 官方口径，0 次请求）。
    trendingHtml: weeklyTrendingHtml(firstRepo, 4321),
  });

  const weekly = jsonItems(r, 'weekly');
  const scored = weekly.find((x) => x.velocitySource !== 'none' && x.starsGained7d > 0);
  assert.ok(scored, `至少要有一个条目拿到非零速度：${weekly.map((x) => `${x.ownerRepo}:${x.velocitySource}/${x.starsGained7d}`).join(', ')}`);
  assert.equal(scored.ownerRepo, firstRepo);
  assert.equal(scored.starsGained7d, 4321);

  // 经典池的两个仓库不该有计费请求：release 与涨星端点都不许为它发出。
  const classicCalls = requested.filter((url) => url.includes('/classic/'));
  assert.deepEqual(classicCalls.filter((url) => /\/releases\?/.test(url)), [], '经典池不得做计费的 release 查询');
  assert.deepEqual(classicCalls, [], '经典池一次请求都不该发（它的两个字段在经典榜没有消费者）');
  // R86 的正题：**付费阶梯真的跑到了**（旧实现里额度早被 release 吃光，这里恒为空），
  // 而且花得有上限：每人最多 1 次，最多 16 人。
  const paidCalls = requested.filter((url) => /\/events\?\w*|\/stargazers\/history/.test(url));
  assert.ok(paidCalls.length > 0, '付费涨星阶段必须真的被跑到（这正是 R86 要修的那件事）');
  assert.ok(paidCalls.length <= 16, `付费请求不得超过预留的 16 次：${paidCalls.length}`);
  // 免费级已经给出 trending 口径的那个候选不该再被付费问一遍。
  assert.ok(!paidCalls.some((url) => url.includes(`/${firstRepo}/`)), '免费级已命中的候选不许再花付费请求');
  // R89：预算是**真的**被消耗的（假 client 如实累加），所以这条上限断言是有意义的。
  assert.equal(r.apiCalls.coreCalls, client.stats().coreCalls, 'apiCalls 必须就是客户端真实的计数');
  assert.ok(r.apiCalls.coreCalls + r.apiCalls.searchCalls <= 45, `整轮仍要在 45 次预算之内：${r.apiCalls.coreCalls + r.apiCalls.searchCalls}`);
  assert.ok(r.apiCalls.coreCalls > 0, '这一轮确实花掉了额度（否则上面的上限断言是在自证）');
});

test('R89 预留额度必须花得出去：富化吃满预留线后，付费级仍然真的发得出请求', async () => {
  const d = dir();
  const requested = [];
  const client = makeFakeClient({ record: requested });
  // 40 个候选，"富化吃满预留线"（29 = 45 - 16）是必然的：每个候选 1 次 release。
  // 跑真实管线（enrich + 阶梯），于是"富化确实被停止线拦住"与"付费确实花掉了预留"都能被观察到。
  const pool = [];
  for (let i = 1; i <= 40; i++) {
    pool.push({
      repo: {
        ownerRepo: `bulk/p${i}`, name: `p${i}`, description: `第 ${i} 个候选`, language: 'Go',
        stars: 3000 + i, forks: 100, license: 'MIT',
        // 创建于 28 天前：级别 0 的成本闸门（R52）因此跳过它，付费级直接走级别 4 的 /events。
        createdAt: '2026-09-12T00:00:00Z', pushedAt: '2026-10-09T00:00:00Z',
        archived: false, defaultBranch: 'main',
      },
      extra: {},
    });
  }
  let enriched = 0;
  const sources = createRealSources({ client, dataDir: d, now: NOW });
  const r = await runCollect({
    dataDir: d, client, now: NOW,
    sources: {
      discover: async () => ({ candidates: pool, classic: async () => [], trending: async () => [] }),
      enrich: (candidate, options) => { enriched++; return sources.enrich(candidate, options); },
      resolveVelocity: sources.resolveVelocity,
    },
  });

  // 付费请求真的发出去了：旧实现里 quotaExhausted()（29）同时当付费阶段的终止条件，
  // 富化吃满时可用量恰好为 0 → 这里会是 0 次，而告警还宣称"额度留给了涨星速度"（假话）。
  const paidCalls = requested.filter((url) => /\/events\?\w*|\/stargazers\/history/.test(url));
  assert.ok(paidCalls.length > 0, '富化吃满后，预留给付费涨星的额度必须真的能花出去');
  assert.ok(paidCalls.length <= 16, `付费请求不得超过 MAX_PAID_VELOCITY：${paidCalls.length}`);
  // 富化没有因为预留而停得过早：预留线是 29，即富化应当拿到其中大部分（search 阶段这里不花，故 29 次左右）。
  assert.ok(enriched >= 25, `富化不该在预留线之前就停：只富化了 ${enriched} 个`);
  // 整轮硬上限仍是 45（R89 的 29 + 16 = 45 闭合）。
  const used = r.apiCalls.coreCalls + r.apiCalls.searchCalls;
  assert.ok(used <= 45, `整轮不得超过 45 次预算：${used}`);
  assert.ok(used > 29, `用掉预留才会超过 29，实际 ${used} 次`);
});

// ---------- R87：经典池不得并入周榜候选池 ----------

test('R87 能过门槛的经典池候选不得出现在 weekly/newbie，也不得在同一榜出现两次', async () => {
  const d = dir();
  const classic = [{
    // 这个经典候选**完全够格**上周榜（已核实安装路径 + 200+ 收藏 + 近期提交）。
    repo: { ownerRepo: 'classic/strong', name: 'strong', stars: 300000, forks: 5000, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false },
    runnability: { kind: 'npmBinWin', verified: true, chineseDoc: false },
    extra: { growing: false },
  }];
  const weeklyPool = [{
    repo: { ownerRepo: 'fresh/one', name: 'one', stars: 3000, forks: 100, language: 'Go', license: 'MIT', pushedAt: '2026-10-09T00:00:00Z', archived: false },
    runnability: { kind: 'npmBinWin', verified: true, chineseDoc: false },
    extra: { growing: false },
  }];
  const r = await runCollect({
    dataDir: d, offline: true, now: NOW,
    sources: { discover: async () => ({ candidates: weeklyPool, classic: async () => classic }), enrich: async (c) => c },
  });

  assert.deepEqual(boardIds(r, 'weekly'), ['fresh/one'], '经典池候选不得占用周榜名额');
  assert.deepEqual(boardIds(r, 'newbie'), ['fresh/one'], '经典池候选也不得进新手榜');
  assert.deepEqual(boardIds(r, 'classic'), ['classic/strong']);
  for (const id of ['weekly', 'newbie', 'classic']) {
    const ids = boardIds(r, id);
    assert.equal(new Set(ids).size, ids.length, `${id} 榜里同一仓库不得出现两次`);
  }
});

// ---------- R88：离线/demo 不该永远挂着"数据不完整" ----------

test('R88 离线源不提供 trending：collect --offline 一轮下来 degraded 必须为 false', async () => {
  const d = dir();
  const r = await runCollect({ dataDir: d, offline: true, now: NOW, sources: createOfflineSources() });

  assert.ok(r.boards.find((b) => b.id === 'weekly').items.length > 0);
  assert.equal(r.degraded, false, `离线演示的数据是完整的，不该挂降级横幅：${r.warnings.join(' | ')}`);
  assert.deepEqual(r.warnings, []);
  assert.ok(!r.markdown.includes('本期数据不完整'));
  assert.equal(JSON.parse(r.json).degraded, false);
});

// ---------- 幂等与日报文件 ----------

test('同一天重跑：三榜条目与 JSON 文件内容逐字节一致', async () => {
  const d = dir();
  await runCollect({ dataDir: d, offline: true, now: NOW, sources: okSources });
  const first = readFileSync(join(d, '2026-10-10.json'), 'utf8');
  await runCollect({ dataDir: d, offline: true, now: NOW, sources: okSources });
  const second = readFileSync(join(d, '2026-10-10.json'), 'utf8');
  assert.equal(second, first);
  assert.deepEqual(listDates(d), ['2026-10-10']);
});

test('日报同时给出 Markdown 与 JSON 字符串，且都写进 daily/ 目录', async () => {
  const d = dir();
  const out = dir();
  const r = await runCollect({ dataDir: d, offline: true, now: NOW, sources: okSources, dailyDir: out });
  assert.match(r.markdown, /# GitHub 好玩榜/);
  assert.equal(JSON.parse(r.json).date, '2026-10-10');
  assert.ok(existsSync(join(out, '2026-10-10.md')));
  assert.ok(existsSync(join(out, '2026-10-10.json')));
  assert.match(readFileSync(join(out, '2026-10-10.md'), 'utf8'), /2026-10-10/);
});

test('落盘的 JSON 与返回值里的 JSON 是同一份（网站读到什么，测试就断言什么）', async () => {
  const d = dir();
  const r = await runCollect({ dataDir: d, offline: true, now: NOW, sources: okSources });
  assert.deepEqual(readDaily(d, '2026-10-10'), JSON.parse(r.json));
});

// ---------- 假 client / 候选构造（只在需要"真实 sources"的用例里用） ----------

/**
 * 用**真实采集管线**（pipeline.mjs 的 discover/enrich/resolveVelocity）+ 假 client 跑一轮。
 * 假 client 按响应形状作答，绝不真的打网络；这样离线测试跑的就是生产那条路，
 * 而不是另写一份"测试专用实现"（那样会把生产缺陷掩盖过去）。
 *
 * 注意 `discover.trending` 与真实管线的 trending 是**两条路**：真实管线的
 * `resolveVelocity` 自己会去抓 github.com/trending（经 client.fetchText），
 * 所以要让它跑出级别 2，必须给假 client 一份 HTML（见 `trendingHtml`）。
 * @param {{ dataDir: string, client: object, candidates: object[], classic?: object[],
 *   trending?: object[], trendingHtml?: string|null }} options
 * @returns {Promise<object>} runCollect 的返回值
 */
function runRealPipeline({ dataDir, client, candidates: pool, classic = [], trending = [], trendingHtml = null }) {
  // 把 trending 页面塞进假 client 的 fetchText 通道（这是真实管线实际去读的地方）。
  const baseFetchText = client.fetchText.bind(client);
  const wired = Object.assign(Object.create(null), client, {
    fetchText: (url) => (url.startsWith('https://github.com/trending') && typeof trendingHtml === 'string' ? trendingHtml : baseFetchText(url)),
  });
  const sources = createRealSources({ client: wired, dataDir, now: NOW });
  return runCollect({
    // 刻意**不传 offline**：offline 会把所有请求掐掉，真实管线就什么都查不到，也就什么都验证不了。
    // 隔离性由假 client 保证（它只答形状，不发请求），而不是由 offline 开关保证。
    dataDir, client: wired, now: NOW,
    sources: {
      discover: async () => ({ candidates: pool, classic: async () => classic, trending: async () => trending }),
      enrich: sources.enrich,
      resolveVelocity: sources.resolveVelocity,
    },
  });
}

/**
 * 一份最小的 trending **weekly** 页面 HTML（结构照 fixtures/trending-daily.html 的真实标记，
 * 只把 "N stars this week" 那一行写进去）——解析器只认 article.Box-row + h2 链接 + 涨星文案。
 * @param {string} ownerRepo 形如 owner/repo
 * @param {number} starsThisWeek 页面自己写的本周涨星
 * @returns {string}
 */
function weeklyTrendingHtml(ownerRepo, starsThisWeek) {
  return [
    '<div>',
    '  <article class="Box-row">',
    `    <h2 class="h3 lh-condensed"><a href="/${ownerRepo}" class="Link"><span class="text-normal">owner /</span> repo</a></h2>`,
    `    <span class="d-inline-block ml-0 mr-3"><span class="text-bold">${starsThisWeek.toLocaleString('en-US')}</span> stars this week</span>`,
    '  </article>',
    '</div>',
  ].join('\n');
}

/**
 * 造一个候选：repo 字段用 GitHub search 会给出的那一套，另加 defaultBranch（富化读 README 与证据探针要用）。
 */
function realCandidate(ownerRepo, over = {}) {
  return {
    repo: {
      ownerRepo,
      name: ownerRepo.split('/')[1],
      description: over.description ?? '测试项目',
      language: over.language ?? 'Go',
      stars: over.stars ?? 1000,
      forks: over.forks ?? 50,
      openIssues: 1,
      createdAt: over.createdAt ?? '2024-01-01T00:00:00Z',
      pushedAt: over.pushedAt ?? '2026-10-09T00:00:00Z',
      license: over.license ?? 'MIT',
      archived: false,
      defaultBranch: over.defaultBranch ?? 'main',
      topics: [],
      ...(over.npmPackage ? { npmPackage: over.npmPackage } : {}),
      ...(over.pypiPackage ? { pypiPackage: over.pypiPackage } : {}),
    },
    extra: {},
  };
}

/**
 * 假 client：把真实 sources 会打的三类地址都答上。
 * 它不是"实现"的复述——它答的是 GitHub / npm / PyPI / raw 的**响应形状**，
 * 让真实富化代码（releases / registry / readme / 证据探针）原样跑一遍。
 * @param {{ npmLinuxOnly?: boolean, record?: string[] }} [options]
 *   npmLinuxOnly：npm 包声明只支持 Linux/macOS（R66 用）；
 *   record：把每个请求的 URL 记进这个数组（R82 用它数探针到底打了几次）
 */
function makeFakeClient({ npmLinuxOnly = false, record = null } = {}) {
  const note = (url) => { if (Array.isArray(record)) record.push(url); };
  const releaseBody = [{
    tag_name: 'v1.2.3',
    published_at: '2026-10-01T00:00:00Z',
    draft: false,
    assets: [{ name: 'app-setup.exe', browser_download_url: 'https://example.com/app-setup.exe', size: 10 }],
  }];
  // 这些样例项目"确认没有发过 release"（200 []，R40 的 false 一侧），否则 releaseWindows(18 分)
  // 会盖过我们要验证的 Docker / 编译路径。注意：null（没问到）与 []（确认没有）是两个不同的答案，
  // 假 client 刻意分开作答，与 R40/R41 的三态口径一致。
  const NO_RELEASE = new Set(['code/docker-repo', 'code/make-repo', 'code/plain-repo', 'code/linux-cli']);
  // R89（控制者裁定）：假 client 的 stats **必须如实累加**，否则所有"预算被消耗"的断言都在自证
  // （计数恒 0 → `apiCalls <= 45` 恒真，付费阶段到底跑没跑也看不出来）。
  // 计费口径与 net/client 对齐：`api:'search'` 记 search，其余（含默认 core）记 core，
  // `api:'none'` 与 fetchText 不吃额度。
  let coreCalls = 0;
  let searchCalls = 0;
  return {
    async getJson(url, options = {}) {
      note(url);
      const api = options?.api === 'search' ? 'search' : options?.api === 'none' ? 'none' : 'core';
      if (api === 'search') searchCalls++; else if (api === 'core') coreCalls++;
      const releaseMatch = /\/repos\/([^/]+\/[^/]+)\/releases\?per_page=1$/.exec(url);
      if (releaseMatch) return NO_RELEASE.has(releaseMatch[1]) ? [] : releaseBody;
      if (url.startsWith('https://registry.npmjs.org/')) {
        const name = url.slice('https://registry.npmjs.org/'.length);
        return {
          name,
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              bin: { [name]: 'cli.js' },
              os: npmLinuxOnly ? ['linux', 'darwin'] : ['win32'],
              repository: { url: `https://github.com/${name === 'pkg-alpha-one' ? 'alpha/one' : name === 'pkg-linux-only' ? 'code/linux-cli' : 'nobody/else'}` },
            },
          },
        };
      }
      if (url.startsWith('https://pypi.org/pypi/')) {
        const name = url.slice('https://pypi.org/pypi/'.length).replace(/\/json$/, '');
        return {
          info: {
            name,
            version: '2.0.0',
            requires_python: '>=3.10',
            project_urls: { Source: `https://github.com/${name === 'pypi-beta-two' ? 'beta/two' : 'nobody/else'}` },
          },
        };
      }
      if (/\/events\?per_page=100$/.test(url)) return [];  // 没有涨星事件 → 该级不可用，继续下降
      return null;
    },
    async fetchText(url) {
      note(url);
      if (url.endsWith('/README.md')) return '# 标题\n\n这是个示例项目。\n';
      // 证据探针（R65/R66/R67）：只有 code/ 这几个样例项目"真的存在"这些文件。
      // make-repo 刻意**没有** Dockerfile（于是它要探到第 3 个 Cargo.toml 才命中，R82 的"命中即停"靠它验证）。
      // 其余一律返回 null（= 这个文件不存在），于是它们不会拿到任何证据旗标。
      if (url.startsWith('https://raw.githubusercontent.com/code/docker-repo/') && /\/Dockerfile$/.test(url)) return 'FROM node:22\n';
      if (url.startsWith('https://raw.githubusercontent.com/code/make-repo/') && /\/Cargo\.toml$/.test(url)) return '[package]\nname = "make-repo"\n';
      if (url.startsWith('https://raw.githubusercontent.com/code/linux-cli/') && /\/Dockerfile$/.test(url)) return 'FROM python:3.12\n';
      return null;
    },
    stats: () => ({ coreCalls, searchCalls, cacheHits: 0, degraded: false }),
  };
}

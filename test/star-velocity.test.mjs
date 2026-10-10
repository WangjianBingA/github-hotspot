// GitHub 好玩榜 —— 涨星速度五级降级的测试。
// 纪律：只注入假 client、只写临时目录，绝不发真实网络请求；时间一律用固定的 NOW，
// 让"最近 7 天 / 3 天"的日期算术可以被人手核对。
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

/** 造一份某天的榜单快照（level 3 读它的 items[].stars）。 */
const mkDaily = (date, stars) => ({ date, generatedAt:date, degraded:false,
  boards:[{ id:'weekly', title:'x', items:[{ rank:1, ownerRepo:'a/b', stars }] }] });

/** 建一个只用来放快照的临时数据目录，并把 (日期, stars) 逐天写进去。 */
const snapshotDir = (...pairs) => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-'));
  for (const [date, stars] of pairs) writeDaily(dir, date, mkDaily(date, stars));
  return dir;
};

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

// ——————————————— 以下为本次新增：级别 0 的结构与成本、降级路径、外推算术 ———————————————

/** stargazers/history 的 week 是"周起始的 UTC 秒"。 */
const weekOf = (iso) => Math.floor(Date.parse(iso) / 1000);

/**
 * 控制者实测的响应结构：[{ week, total, days:[7 笔当日增量] }]，按周从旧到新。
 * 两周覆盖 9/28–10/11；后三天（10/10、10/11）属于"部分周"，GitHub 给 0。
 * 窗口口径：今天（10/10）的日序号为 N，最近 7 天 = 日序号 N-7..N-1 = 10/3..10/9。
 */
const HISTORY_BODY = [
  { week: weekOf('2026-09-28T00:00:00Z'), total: 28, days: [1, 2, 3, 4, 5, 6, 7] },
  { week: weekOf('2026-10-05T00:00:00Z'), total: 150, days: [10, 20, 30, 40, 50, 0, 0] }
];
// 只在 9/1 建的仓库：年龄 39 天 ≤ 30 周，级别 0 便宜，允许花那一次请求。
const cheapAgeRepo = { ownerRepo:'a/b', createdAt:'2026-09-01T00:00:00Z', stars: 5000 };

test('级别 0：按 UTC 日线累加最近 7 天与 3 天，且只花 1 次请求', async () => {
  const urls = [];
  const client = { getJson: async (url) => { urls.push(url); return HISTORY_BODY; } };
  const v = await resolveVelocity(cheapAgeRepo, { client, dataDir:null, trendingByRepo:new Map(), now: NOW });

  assert.equal(v.level, 0);
  assert.equal(v.confidence, 'measured');
  assert.equal(v.source, 'stargazers-history');
  assert.equal(v.gained7d, 163); // 10/3..10/9：6+7+10+20+30+40+50
  assert.equal(v.gained3d, 120); // 10/7..10/9：30+40+50
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/repos\/a\/b\/stargazers\/history\?per_page=30$/);
});

test('级别 0 的部分周（尾部为 0）不算"涨星崩塌"，窗口只取已过完的 7 天', async () => {
  const client = { getJson: async () => HISTORY_BODY };
  const v = await resolveVelocity(cheapAgeRepo, { client, dataDir:null, trendingByRepo:new Map(), now: NOW });
  // 若把 10/10、10/11 两笔 0 也算进来，或者把部分周当成"没数据"，结果都会变。
  assert.equal(v.gained7d, 163);
  assert.equal(v.gained3d, 120);
});

test('成本闸门（R52）：老仓库需要翻页才够得着最新周，一次 history 请求都不发', async () => {
  const urls = [];
  const client = { getJson: async (url) => { urls.push(url); return url.includes('stargazers/history') ? HISTORY_BODY : null; } };
  const v = await resolveVelocity(oldRepo, { client, dataDir:null, trendingByRepo:new Map(), now: NOW });

  assert.equal(urls.some((u) => u.includes('stargazers/history')), false);
  assert.equal(urls.length, 1);                 // 只剩级别 4 的那一次 events 请求
  assert.equal(v.level, 4);
  assert.equal(v.confidence, 'estimated');
  assert.equal(v.source, 'none');
});

test('createdAt 读不出来时不猜年龄：级别 0 不发请求，直接落到免费级别', async () => {
  const urls = [];
  const client = { getJson: async (url) => { urls.push(url); return HISTORY_BODY; } };
  const t = new Map([['a/b', { starsThisWeek: 800, starsToday: 100 }]]);
  const v = await resolveVelocity({ ownerRepo:'a/b', stars: 5000 },
    { client, dataDir:null, trendingByRepo:t, now: NOW });

  assert.equal(urls.length, 0);
  assert.equal(v.level, 2);
  assert.equal(v.gained7d, 800);
});

test('级别 0：日线覆盖不到完整 7 天时不冒充 measured，继续下降', async () => {
  const urls = [];
  const onlyCurrentWeek = [HISTORY_BODY[1]]; // 只有 10/5 起那一周，10/3、10/4 缺失
  const client = { getJson: async (url) => { urls.push(url); return onlyCurrentWeek; } };
  const v = await resolveVelocity(cheapAgeRepo, { client, dataDir:null, trendingByRepo:new Map(), now: NOW });

  assert.notEqual(v.level, 0);
  assert.equal(v.gained7d, 0);
  assert.equal(v.source, 'none');
  assert.equal(urls.length, 2);                 // history 一次 + events 一次
});

test('级别 0：响应结构不符（错误体/非数组）时优雅失败，不抛错', async () => {
  const client = { getJson: async () => ({ message: 'Not Found' }) };
  const v = await resolveVelocity(cheapAgeRepo, { client, dataDir:null, trendingByRepo:new Map(), now: NOW });
  assert.notEqual(v.level, 0);
  assert.equal(v.source, 'none');
});

test('budget 用尽（client 一律返回 null）时逐级下降到历史 JSON，而不是抛错', async () => {
  const d = snapshotDir(['2026-10-03', 89800], ['2026-10-07', 89950]);
  let calls = 0;
  const client = { getJson: async () => { calls++; return null; } };
  const repo = { ownerRepo:'a/b', createdAt:'2026-09-01T00:00:00Z', stars: 90000 };
  const v = await resolveVelocity(repo, { client, dataDir:d, trendingByRepo:new Map(), now: NOW });

  assert.equal(v.level, 3);
  assert.equal(v.confidence, 'measured');
  assert.equal(v.gained7d, 200);
  assert.equal(v.gained3d, 50);
  assert.equal(calls, 1);                       // history 问了一次就被额度拦下（null），级别 3 命中后不再问 events
});

test('级别 4：只有事件流时按 WatchEvent 时间窗外推，标 estimated', async () => {
  const urls = [];
  const client = { getJson: async (url) => { urls.push(url);
    return [
      { type:'WatchEvent', created_at:'2026-10-09T12:00:00Z' },
      { type:'PushEvent', created_at:'2026-10-09T23:00:00Z' },
      { type:'WatchEvent', created_at:'2026-10-10T00:00:00Z' }
    ]; } };
  const v = await resolveVelocity(oldRepo, { client, dataDir:null, trendingByRepo:new Map(), now: NOW });

  assert.equal(v.level, 4);
  assert.equal(v.confidence, 'estimated');
  assert.equal(v.source, 'events');
  assert.equal(v.gained7d, 28);   // 2 起星标 / 12 小时 × 168 小时
  assert.equal(v.gained3d, null); // 事件流给不出 3 日实测值
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/repos\/a\/b\/events\?per_page=100$/);
});

test('gained3d 只在真有 3 日数据时给出，否则保持 null', async () => {
  const d = snapshotDir(['2026-10-03', 89800]);   // 只有 7 天前的快照
  const v = await resolveVelocity(oldRepo, { client:{ getJson: async () => null }, dataDir:d,
    trendingByRepo:new Map(), now: NOW });
  assert.equal(v.level, 3);
  assert.equal(v.gained7d, 200);
  assert.equal(v.gained3d, null);
});

test('级别 1 的边界：正好 7 天算新建，超过 7 天不算', async () => {
  const ctx = { client:{}, dataDir:null, trendingByRepo:new Map(), now: NOW };
  const exact = await resolveVelocity({ ownerRepo:'a/b', createdAt:'2026-10-03T00:00:00Z', stars: 42 }, ctx);
  assert.equal(exact.level, 1);
  assert.equal(exact.gained7d, 42);

  const over = await resolveVelocity({ ownerRepo:'a/b', createdAt:'2026-10-02T23:59:59Z', stars: 42 }, ctx);
  assert.notEqual(over.level, 1);
  assert.equal(over.source, 'none');
});

test('trending 的 starsThisWeek 为 0 时不当作 reported（页面没说 ≠ 涨了 0）', async () => {
  const t = new Map([['a/b', { starsThisWeek: 0, starsToday: 0 }]]);
  const v = await resolveVelocity(oldRepo, { client:{}, dataDir:null, trendingByRepo:t, now: NOW });
  assert.notEqual(v.level, 2);
  assert.equal(v.confidence, 'estimated');
  assert.equal(v.source, 'none');
});

test('全部不可用时的兜底对象与简报逐字一致', async () => {
  const v = await resolveVelocity(oldRepo,
    { client:{ getJson: async () => null }, dataDir:null, trendingByRepo:new Map(), now: NOW });
  assert.deepEqual(v, { gained7d: 0, gained3d: null, level: 4, confidence: 'estimated', source: 'none' });
});

test('repo 或 now 不合法时返回兜底而不是抛错', async () => {
  const ctx = { client:{ getJson: async () => null }, dataDir:null, trendingByRepo:new Map() };
  const noRepo = await resolveVelocity(null, { ...ctx, now: NOW });
  assert.equal(noRepo.source, 'none');
  const badNow = await resolveVelocity(oldRepo, { ...ctx, now: new Date('坏时间') });
  assert.equal(badNow.source, 'none');
  const noCtx = await resolveVelocity(newRepo);
  assert.equal(noCtx.confidence, 'estimated');
});

test('estimateFromEvents 用 7 天内的涨星事件外推，剔除其它类型与过期事件', () => {
  const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  const est = estimateFromEvents([
    { type:'PushEvent', created_at: at(1) },
    { type:'WatchEvent', created_at: at(200) },  // 超过 7 天：不参与外推
    { type:'WatchEvent', created_at: at(2) }
  ], NOW);
  assert.equal(est.gained7d, 84);                // 1 起星标 / 2 小时 × 168 小时
  assert.ok(Math.abs(est.perHour - 0.5) < 1e-9);
});

test('estimateFromEvents 忽略未来时间戳与读不出的时间，无有效事件时返回 null', () => {
  const future = new Date(NOW.getTime() + 3_600_000).toISOString();
  // 明写 type 的那一起也必须是零宽度 → null，证明守卫不是靠"没认出事件"侥幸通过的。
  assert.equal(estimateFromEvents([{ type:'WatchEvent', created_at: NOW.toISOString() }], NOW), null);
  assert.equal(estimateFromEvents([{ type:'WatchEvent', created_at: future }], NOW), null);
  assert.equal(estimateFromEvents([{ type:'WatchEvent', created_at: '不是时间' }], NOW), null);
  assert.equal(estimateFromEvents([{ type:'WatchEvent' }], NOW), null);
  assert.equal(estimateFromEvents(undefined, NOW), null);
});

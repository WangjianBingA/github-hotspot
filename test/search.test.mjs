// search API 三个发现器的测试。
// 全部注入假 client：本文件绝不联网，也绝不消耗真实额度（search 桶未认证只有 10 次/分钟）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverNewRepos, discoverActiveRepos, fetchClassicTop } from '../src/sources/search.mjs';

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

// —— R38：日期算术必须可测。固定 now，断言查询里的确切日期串。 ——

test('R38 固定 now 时 created 是 now 减 days 的 UTC 日期串', async () => {
  let seen = '';
  const client = { getJson: async (url) => { seen = url; return { items: [] }; } };

  await discoverNewRepos(client, { days: 7, now: new Date('2026-10-09T03:00:00Z') });
  assert.match(seen, /created%3A%3E2026-10-02/);
  // 传输层上 `:` 必须是 %3A、`>` 必须是 %3E，不能被压成别的形式或整个丢掉。
  assert.equal(seen,
    'https://api.github.com/search/repositories?q=created%3A%3E2026-10-02%20stars%3A%3E200&sort=stars&order=desc&per_page=50');
  assert.equal(decodeURIComponent(seen),
    'https://api.github.com/search/repositories?q=created:>2026-10-02 stars:>200&sort=stars&order=desc&per_page=50');

  await discoverNewRepos(client, { days: 1, now: new Date('2026-03-01T00:00:00Z') });
  assert.match(decodeURIComponent(seen), /created:>2026-02-28/);

  // 跨月：8 月 31 日往前 1 天必须落到 8 月 30 日，而不是被本地时区推成 8 月 29 日。
  await discoverNewRepos(client, { days: 1, now: new Date('2026-08-31T23:30:00Z') });
  assert.match(decodeURIComponent(seen), /created:>2026-08-30/);

  // 不传 now 时必须走默认值而不是抛出 undefined 相关错误。
  const out = await discoverNewRepos(client, { days: 7 });
  assert.ok(Array.isArray(out));
});

test('R38 活跃老项目只按 pushed 过滤，日期取 UTC', async () => {
  let seen = '';
  await discoverActiveRepos({ getJson: async (url) => { seen = url; return { items: [] }; } },
    { days: 7, minStars: 500, now: new Date('2026-10-09T03:00:00Z') });

  const q = decodeURIComponent(seen);
  assert.match(q, /pushed:>2026-10-02/);
  assert.match(q, /stars:>500/);
  assert.match(seen, /sort=updated/);
  assert.match(seen, /order=desc/);
  assert.equal(q, 'https://api.github.com/search/repositories?q=pushed:>2026-10-02 stars:>500&sort=updated&order=desc&per_page=50');
});

test('R39a 活跃老项目查询绝不叠加 created 限定符（限定符是 AND，会把老仓库全部剔除）', async () => {
  const seen = [];
  await discoverActiveRepos({ getJson: async (url) => { seen.push(url); return { items: [] }; } },
    { days: 7, now: new Date('2026-10-09T03:00:00Z') });
  // 默认参数也走一遍，防止只在显式传参的分支上修好。
  await discoverActiveRepos({ getJson: async (url) => { seen.push(url); return { items: [] }; } },
    { now: new Date('2026-10-09T03:00:00Z') });

  for (const url of seen) {
    assert.ok(!url.includes('created'), `活跃老项目查询里不该出现 created 限定符：${url}`);
    assert.ok(!decodeURIComponent(url).includes('created:>'), `活跃老项目查询里不该出现 created 限定符：${url}`);
    assert.match(decodeURIComponent(url), /pushed:>2026-10-02 stars:>500/);
  }
});

// —— R36：per_page 的取值。 ——

test('R36 两个发现器 per_page=50，总榜默认 30 且可覆盖', async () => {
  const seen = [];
  const client = { getJson: async (url) => { seen.push(url); return { items: [] }; } };

  await discoverNewRepos(client);
  await discoverActiveRepos(client);
  await fetchClassicTop(client);
  await fetchClassicTop(client, { perPage: 80 });

  assert.match(seen[0], /per_page=50/);
  assert.match(seen[1], /per_page=50/);
  assert.match(seen[2], /per_page=30/);
  assert.match(seen[3], /per_page=80/);
});

// —— R37：三个来源的 sort 各不相同，且都不吃 core 桶以外的类别。 ——

test('R37 三个来源的 sort 与额度类别正确', async () => {
  const seen = [];
  const client = { getJson: async (url, opts) => { seen.push([url, opts]); return { items: [] }; } };

  await discoverNewRepos(client);
  await discoverActiveRepos(client);
  await fetchClassicTop(client);

  assert.match(seen[0][0], /sort=stars&order=desc/);
  assert.match(seen[1][0], /sort=updated&order=desc/);
  assert.match(seen[2][0], /sort=stars&order=desc/);
  assert.match(seen[0][0], /stars%3A%3E200/);
  assert.match(seen[1][0], /stars%3A%3E500/);
  assert.match(seen[2][0], /stars%3A%3E100000/);
  for (const [, opts] of seen) assert.equal(opts.api, 'search');
});

// —— 防御性映射：缺字段、null、怪类型都不能让这一层抛错。 ——

test('缺失字段时给出安全默认值，不抛错', async () => {
  const bare = { full_name: 'x/y' };
  const r = await fetchClassicTop(fake([bare, null, undefined, 42, 'oops']));

  // 完全没有仓库标识的脏条目被丢弃，只有 x/y 留下。
  assert.equal(r.length, 1);
  const mapped = r[0];
  assert.equal(mapped.ownerRepo, 'x/y');
  assert.equal(mapped.name, 'y');
  assert.equal(mapped.description, null);
  assert.equal(mapped.language, null);
  assert.equal(mapped.license, null);
  assert.equal(mapped.stars, 0);
  assert.equal(mapped.forks, 0);
  assert.equal(mapped.openIssues, 0);
  // R150/M3：`closedIssues` 这个字段已经删掉（search 结果里本来就没有它，
  // 以前那个恒为 0 的值只是在下游被当成"一个 issue 都没关过"）。这里改成断言它不存在，
  // 免得以后有人"顺手补回一个默认值"——那正是 Task 4B 拆掉过的同形缺陷。
  assert.ok(!('closedIssues' in mapped), 'search 的映射结果里不该再有 closedIssues');
  assert.equal(mapped.createdAt, null);
  assert.equal(mapped.pushedAt, null);
  assert.equal(mapped.archived, false);
  assert.equal(mapped.defaultBranch, null);
  assert.deepEqual(mapped.topics, []);
});

test('license 归一化：只取 spdx_id，NOASSERTION 与 null 都变 null，字符串原样保留', async () => {
  const r = await fetchClassicTop(fake([
    item({ full_name: 'a/mit', license: { spdx_id: 'MIT' } }),
    item({ full_name: 'a/no', license: { spdx_id: 'NOASSERTION' } }),
    item({ full_name: 'a/str', license: 'Apache-2.0' }),
    item({ full_name: 'a/null', license: null })
  ]));

  assert.deepEqual(r.map(x => x.license), ['MIT', null, 'Apache-2.0', null]);
});

test('full_name 缺失时用 owner.login + name 兜底，name 单独暴露', async () => {
  const r = await fetchClassicTop(fake([
    item({ full_name: null, name: 'repo', owner: { login: 'someone' } }),
    item({ full_name: 'o/r', name: 'r' })
  ]));

  assert.equal(r.length, 2);
  assert.equal(r[0].ownerRepo, 'someone/repo');
  assert.equal(r[0].name, 'repo');
  assert.equal(r[1].ownerRepo, 'o/r');
  assert.equal(r[1].name, 'r');
});

test('topics 缺失或不是数组时归一化为空数组', async () => {
  const r = await fetchClassicTop(fake([
    item({ topics: undefined }),
    item({ topics: null }),
    item({ topics: 'cli' }),
    item({ topics: ['cli', 'ai'] })
  ]));

  assert.deepEqual(r.map(x => x.topics), [[], [], [], ['cli', 'ai']]);
});

test('items 不是数组或响应体畸形时返回空数组', async () => {
  assert.deepEqual(await discoverNewRepos({ getJson: async () => ({ message: 'Not Found' }) }), []);
  assert.deepEqual(await discoverNewRepos({ getJson: async () => ({ items: 'nope' }) }), []);
  assert.deepEqual(await discoverActiveRepos({ getJson: async () => null }), []);
  assert.deepEqual(await fetchClassicTop({ getJson: async () => { throw new Error('boom'); } }), []);
});

test('没有可用 client 时返回空数组而不是抛错', async () => {
  assert.deepEqual(await discoverNewRepos(undefined), []);
  assert.deepEqual(await discoverActiveRepos(null), []);
  assert.deepEqual(await fetchClassicTop({}), []);
});

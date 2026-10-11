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

// ——— 以下为补充用例：覆盖任务说明中单列、但上面 7 个用例未触及的行为 ———

test('预算按实际发出的请求计：重试也各吃一次预算', async () => {
  let calls = 0;
  const c = createClient({
    fetchImpl: async () => { calls++; return resp('err', 500); },
    budget: 3, sleep: async()=>{}
  });
  assert.equal(await c.getJson('https://api.github.com/a'), null);   // 3 次尝试正好吃光预算
  assert.equal(calls, 3);
  assert.equal(c.stats().coreCalls, 3);
  assert.equal(await c.getJson('https://api.github.com/b'), null);   // 预算已耗尽：一个请求都不许再发
  assert.equal(calls, 3);
  assert.equal(c.stats().coreCalls, 3);
  assert.equal(c.stats().degraded, true);
});

test('fetchText 返回纯文本响应', async () => {
  const c = createClient({ fetchImpl: async () => resp('<html>hi</html>'), budget: 10, sleep: async()=>{} });
  assert.equal(await c.fetchText('https://github.com/trending'), '<html>hi</html>');
});

test('fetchText 属于 api:none，不消耗核心预算', async () => {
  let calls = 0;
  const c = createClient({ fetchImpl: async () => { calls++; return resp({ ok: true }); }, budget: 1, sleep: async()=>{} });
  await c.getJson('https://api.github.com/repos/a/b');          // 用掉唯一的预算
  await c.fetchText('https://github.com/trending');             // HTML 页不该被预算拦住
  await c.fetchText('https://raw.githubusercontent.com/a/b/main/README.md');
  assert.equal(calls, 3);
  assert.deepEqual(c.stats(), { coreCalls: 1, searchCalls: 0, cacheHits: 0, degraded: false });
});

test('getJson 与 fetchText 共用同一条串行队列', async () => {
  let inFlight = 0, maxInFlight = 0;
  const c = createClient({
    fetchImpl: async (url) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return url.includes('api.github.com') ? resp({ ok: true }) : resp('<html>hi</html>');
    },
    budget: 10, sleep: async()=>{}
  });
  const [json, text] = await Promise.all([
    c.getJson('https://api.github.com/a'),
    c.fetchText('https://github.com/trending')
  ]);
  assert.deepEqual(json, { ok: true });
  assert.equal(text, '<html>hi</html>');
  assert.equal(maxInFlight, 1);
});

test('403 且 reset 很近时先休眠到 reset 再重试一次', async () => {
  const nowMs = 1_700_000_000_000;              // 整秒，等待时长可精确断言
  const reset = nowMs / 1000 + 60;
  const sleeps = [];
  let calls = 0;
  const c = createClient({
    fetchImpl: async () => { calls++; return calls === 1 ? resp({ message:'rate limit' }, 403, { 'x-ratelimit-reset': String(reset) }) : resp({ ok: true }); },
    budget: 10, now: () => nowMs, sleep: async (ms) => { sleeps.push(ms); }
  });
  assert.deepEqual(await c.getJson('https://api.github.com/a'), { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [60_000]);            // 等到 reset 的那一刻，而不是退避 1s
});

test('404 是服务器明确的"不存在"回答：不重试、也不全局降级（R43）', async () => {
  let calls = 0;
  const sleeps = [];
  const c = createClient({
    fetchImpl: async () => { calls++; return resp({ message:'Not Found' }, 404); },
    budget: 10, sleep: async (ms) => { sleeps.push(ms); }
  });
  assert.equal(await c.getJson('https://api.github.com/a'), null);
  assert.equal(calls, 1);                        // 不是 5xx，不该退避重试
  assert.deepEqual(sleeps, []);
  // R43：404 的语义是"问到答案了，答案是'没有'"（例如这个仓库没发过 npm 包），
  // 不是"我们没拿到答案"——绝不能因为一条 404 就把整轮标成数据不完整。
  assert.equal(c.stats().degraded, false);
});

test('R43：其他明确的 4xx（400/401/422）同样是"问到了答案"，不重试、不降级', async () => {
  for (const status of [400, 401, 422]) {
    let calls = 0;
    const c = createClient({
      fetchImpl: async () => { calls++; return resp({ message:'nope' }, status); },
      budget: 10, sleep: async () => {}
    });
    assert.equal(await c.getJson('https://api.github.com/a'), null, `HTTP ${status}`);
    assert.equal(calls, 1, `HTTP ${status}`);
    assert.equal(c.stats().degraded, false, `HTTP ${status}`);
  }
});

test('R43：403 但额度还有余额（权限类）→ 明确回答，不重试、不降级', async () => {
  let calls = 0;
  const c = createClient({
    fetchImpl: async () => {
      calls++;
      return resp({ message:'Resource not accessible by integration' }, 403, {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',                                    // 余额还在 → 不是限流
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800)   // 正常响应也会带 reset 头
      });
    },
    budget: 10, sleep: async () => {}
  });
  assert.equal(await c.getJson('https://api.github.com/repos/a/b'), null);
  assert.equal(calls, 1);
  assert.equal(c.stats().degraded, false);
});

test('R43：429 本身就是限流，仍按限流处理（不当成"明确的回答"）', async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const c = createClient({
    fetchImpl: async () => resp({ message:'too many requests' }, 429, { 'x-ratelimit-remaining':'0', 'x-ratelimit-reset': String(reset) }),
    budget: 10, sleep: async () => {}
  });
  await assert.rejects(() => c.getJson('https://api.github.com/a'), (e) => e instanceof RateLimitError && e.resetAt === reset);
  assert.equal(c.stats().degraded, true);
});

test('R43：403 且只带 retry-after（二级限流）仍算限流，并按 retry-after 等待', async () => {
  const nowMs = 1_700_000_000_000;
  const sleeps = [];
  let calls = 0;
  const c = createClient({
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? resp({ message:'secondary rate limit' }, 403, { 'retry-after': '30' })
        : resp({ ok: true });
    },
    budget: 10, now: () => nowMs, sleep: async (ms) => { sleeps.push(ms); }
  });
  assert.deepEqual(await c.getJson('https://api.github.com/a'), { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [30_000]);
});

test('R43：5xx 重试耗尽仍然全局降级（保住原有语义）', async () => {
  let calls = 0;
  const c = createClient({
    fetchImpl: async () => { calls++; return resp('err', 500); },
    budget: 10, sleep: async () => {}
  });
  assert.equal(await c.getJson('https://api.github.com/a'), null);
  assert.equal(calls, 3);
  assert.equal(c.stats().degraded, true);        // 这才是"我们没拿到答案"
});

test('R43：额度耗尽被拦下仍然全局降级（保住原有语义）', async () => {
  let calls = 0;
  const c = createClient({
    fetchImpl: async () => { calls++; return resp({ ok: true }); },
    budget: 1, sleep: async () => {}
  });
  await c.getJson('https://api.github.com/a');
  assert.equal(await c.getJson('https://api.github.com/b'), null);
  assert.equal(calls, 1);                        // 预算不够时连请求都不发
  assert.equal(c.stats().degraded, true);
});

test('R43：一条 404 之后成功请求仍不至于把整轮标成降级', async () => {
  const c = createClient({
    fetchImpl: async (url) => (url.endsWith('/missing') ? resp({ message:'Not Found' }, 404) : resp({ ok: true })),
    budget: 10, sleep: async () => {}
  });
  assert.equal(await c.getJson('https://registry.npmjs.org/missing', { api: 'none' }), null);
  assert.deepEqual(await c.getJson('https://api.github.com/repos/a/b'), { ok: true });
  assert.deepEqual(c.stats(), { coreCalls: 1, searchCalls: 0, cacheHits: 0, degraded: false });
});

test('core 与 search 分开计数，但共用同一个总预算', async () => {
  let calls = 0;
  const c = createClient({ fetchImpl: async () => { calls++; return resp({}); }, budget: 1, sleep: async()=>{} });
  await c.getJson('https://api.github.com/search/repositories', { api: 'search' });
  const second = await c.getJson('https://api.github.com/repos/a/b');
  assert.equal(second, null);                    // 总预算已用尽 → 不发请求、返回 null
  assert.equal(calls, 1);
  assert.deepEqual(c.stats(), { coreCalls: 0, searchCalls: 1, cacheHits: 0, degraded: true });
});

test('缓存键区分不同 URL 与不同 api 类别', async () => {
  const urls = [];
  const cache = createFileCache(join(mkdtempSync(join(tmpdir(),'c-')), 'cache.json'));
  const c = createClient({ fetchImpl: async (url) => { urls.push(url); return resp({ u: url }); }, budget: 10, cache, sleep: async()=>{} });
  await c.getJson('https://api.github.com/a', { ttlSeconds: 60 });
  await c.getJson('https://api.github.com/b', { ttlSeconds: 60 });                  // 不同 URL 不命中
  await c.getJson('https://api.github.com/a', { api: 'search', ttlSeconds: 60 });   // 不同 api 类别不命中
  await c.getJson('https://api.github.com/a', { ttlSeconds: 60 });                  // 同键命中
  assert.equal(urls.length, 3);
  assert.equal(c.stats().cacheHits, 1);
});

test('请求超时会被 AbortController 中止并按退避重试', async () => {
  let attempts = 0, aborts = 0;
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => {
    attempts++;
    signal.addEventListener('abort', () => { aborts++; reject(new Error('已中止')); });
  });
  const c = createClient({ fetchImpl, budget: 10, timeoutMs: 20, sleep: async()=>{} });
  assert.equal(await c.getJson('https://api.github.com/a'), null);   // 3 次都超时 → 放弃并降级
  assert.equal(attempts, 3);
  assert.equal(aborts, 3);
  assert.equal(c.stats().degraded, true);
});

test('有 token 时带 Authorization 头，且日志不泄露 token', async () => {
  const seen = [], logs = [];
  const c = createClient({
    fetchImpl: async (url, init) => { seen.push(init.headers); return resp({}); },
    budget: 1, token: 'ghp-秘密-xyz', sleep: async()=>{},
    logger: { warn: (m) => logs.push(String(m)), info: (m) => logs.push(String(m)) }
  });
  await c.getJson('https://api.github.com/a');
  await c.getJson('https://api.github.com/b');       // 触发一条降级告警
  assert.equal(seen[0].authorization, 'Bearer ghp-秘密-xyz');
  assert.equal(seen[0]['user-agent'], 'github-hotspot');
  assert.ok(logs.length > 0);
  assert.ok(!logs.join('\n').includes('ghp-秘密-xyz'));
});

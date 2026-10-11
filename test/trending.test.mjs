// trending 页面解析测试。
// 夹具全部来自磁盘（真实抓取的页面片段 + 合成改版片段），本文件绝不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTrendingHtml, fetchTrending } from '../src/sources/trending.mjs';

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

test('改版夹具本身不含 Box-row 与当日涨星文案，降级测试才有意义', () => {
  assert.ok(!changed.includes('Box-row'));
  assert.ok(!changed.includes('stars today'));
  assert.ok(!/<article\b/i.test(changed));
});

test('真实夹具的条目解析出链接、描述、语言、总星数与 fork 数', () => {
  const items = parseTrendingHtml(daily);
  assert.equal(items.length, 6);

  const first = items[0];
  assert.equal(first.fullName, 'morluto/rea');
  assert.equal(first.url, 'https://github.com/morluto/rea');
  assert.match(first.description, /^Reverse engineer anything/);
  assert.equal(first.language, 'TypeScript');
  assert.ok(first.stars > 0);
  assert.ok(first.forks > 0);
  assert.equal(first.starsThisWeek, 0);

  for (const item of items) {
    assert.match(item.url, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    assert.ok(Number.isInteger(item.stars) && item.stars > 0);
    assert.ok(Number.isInteger(item.forks) && item.forks > 0);
    assert.ok(Number.isInteger(item.starsToday) && item.starsToday > 0);
  }
});

test('缺少描述或语言时对应字段为 null，条目仍然可用', () => {
  const html = daily
    .replace('<span itemprop="programmingLanguage">Shell</span>', '')
    .replace(/<p class="col-9[^>]*>[\s\S]*?<\/p>/, '');
  const items = parseTrendingHtml(html);

  assert.equal(items.length, 6);
  assert.ok(items.some(i => i.language === null));
  assert.ok(items.some(i => i.description === null));
  assert.equal(items[0].description, null);
});

test('fetchTrending 通过注入的 client 取页面并解析', async () => {
  const seen = [];
  const client = {
    fetchText: async (url) => {
      seen.push(url);
      return daily;
    }
  };

  const items = await fetchTrending(client);
  assert.equal(items.length, 6);
  assert.deepEqual(seen, ['https://github.com/trending?since=daily']);

  await fetchTrending(client, 'weekly');
  assert.equal(seen[1], 'https://github.com/trending?since=weekly');
});

test('fetchTrending 在 client 返回 null 或抛错时给出空数组', async () => {
  const failed = { fetchText: async () => null };
  assert.deepEqual(await fetchTrending(failed), []);

  const broken = {
    fetchText: async () => {
      throw new Error('网络超时');
    }
  };
  assert.deepEqual(await fetchTrending(broken), []);
});

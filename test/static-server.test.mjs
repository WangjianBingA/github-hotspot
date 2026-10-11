// 本地静态服务器的单元测试（spec §5.1：本地预览必须走 http，file:// 打开会被浏览器拦 fetch JSON）。
// 服务对象是仓库里的 public/ 目录，测试自己起一个只监听回环地址的服务器（端口用 0 让系统分配），
// 测完整关掉——绝不占用固定端口，也不碰任何外部地址。
//
// R7（控制者裁定）：简报给的路径穿越用例写的是 fetch(`${base}/../package.json`)，
// 但 fetch 会**先按 URL 规范规范化路径**：`/../package.json` 在请求发出前就变成了 `/package.json`，
// 服务器收到的请求里根本没有穿越。于是那条断言测的只是"这个路径下没有文件"，
// 就算服务器一行防护都不写也照样通过——形同虚设。
// 现在改成 `%2e%2e%2f`（编码过的 `../`）：`%2f` 不是路径分隔符，URL 规范化阶段**不会**折叠它，
// 穿越只能到了服务器上、解码之后才现形，这才是真的打到了防护逻辑。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStaticServer } from '../src/http/static-server.mjs';

/**
 * 起一个只服务 public/ 的服务器，返回端口与关闭函数。
 * @param {object} [options] 额外传给 createStaticServer 的选项（例如 dataRoot）
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
async function start(options = {}) {
  const server = createStaticServer({ root: 'public', ...options });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    port: server.address().port,
    close: () => new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    }),
  };
}

test('能取到首页与数据文件，Content-Type 正确', async () => {
  const { port, close } = await start();
  try {
    const html = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);

    const js = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.match(js.headers.get('content-type'), /javascript/);
  } finally {
    await close();
  }
});

test('不存在的文件返回 404 而不是崩溃', async () => {
  const { port, close } = await start();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope.txt`)).status, 404);
  } finally {
    await close();
  }
});

test('路径穿越攻击必须被拒绝', async () => {
  const { port, close } = await start();
  const base = `http://127.0.0.1:${port}`;
  // package.json 就在服务的根目录的上一级：只要有一条路径能把它读出来，防护就是破的。
  const pkg = resolve(import.meta.dirname, '../package.json').replace(/\\/g, '/');

  try {
    // ① 编码过的 `../`：真正会带着穿越到达服务器的那一种（R7）。
    const encoded = await fetch(`${base}/%2e%2e%2fpackage.json`);
    assert.ok([403, 404].includes(encoded.status), `编码穿越应被拒绝，实际 ${encoded.status}`);
    assert.ok(!(await encoded.text()).includes('"name": "github-hotspot"'), '编码穿越不得读到上一级的 package.json');

    // ② 编码的路径分隔符绕开 URL 规范化：GET 到的是 /..%5cpackage.json（解码后是 ..\package.json）。
    const backslash = await fetch(`${base}/..%2fpackage.json`);
    assert.ok([403, 404].includes(backslash.status), `编码分隔符穿越应被拒绝，实际 ${backslash.status}`);

    // ③ 简报了那种写法：fetch 会先规范化成 /package.json。它不该返回 200，更不该把内容吐出来
    //    ——这条是**兜底**断言（它本身证明不了有防护，真正的证明在上面两条）。
    const plain = await fetch(`${base}/../package.json`);
    assert.notEqual(plain.status, 200);

    // ④ 绝对路径式的目录穿越同样必须被挡住。
    const absolute = await fetch(`${base}/%2e%2e%2f${encodeURI(pkg)}`);
    assert.ok([403, 404].includes(absolute.status), `编码绝对路径穿越应被拒绝，实际 ${absolute.status}`);
  } finally {
    await close();
  }
});

test('同一份文件能用带查询串的地址取到（前端缓存破坏用）', async () => {
  const { port, close } = await start();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/app.js?v=1`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
  } finally {
    await close();
  }
});

test('只放行读取请求，别的请求方式一律拒绝', async () => {
  const { port, close } = await start();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'DELETE' });
    assert.equal(r.status, 405);
  } finally {
    await close();
  }
});

// R127（Task 18）：`serve --demo` 靠 dataRoot 把 /data/ 指向演示数据目录。
// 这里量的是"服务器的行为"，不是某个调用方：① 映射真的生效；② 站点其余部分照旧来自 public/；
// ③ 演示目录里没有的文件就是 404（不会偷偷回落到真实数据目录）；④ 穿越防护对新的根同样成立。

test('dataRoot：/data/ 下的文件来自另一个目录，站点其余部分照旧来自 public/', async () => {
  const demoDir = mkdtempSync(join(tmpdir(), 'hs-dataroot-'));
  writeFileSync(join(demoDir, 'index.json'), '{"demo":true,"dates":["2026-10-10"]}\n');
  const { port, close } = await start({ dataRoot: demoDir });
  const base = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${base}/data/index.json`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).demo, true);

    // 站点自己的文件照旧从根目录出（只有 /data/ 这一段被换掉）。
    assert.match(await (await fetch(`${base}/`)).text(), /本周飙升/);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);

    // 演示目录里没有的日期就是 404：绝不偷偷回落到 public/data（那会把真实数据混进演示站点）。
    assert.equal((await fetch(`${base}/data/1999-01-01.json`)).status, 404);
  } finally {
    await close();
  }
});

test('dataRoot：演示数据的路径穿越同样被挡住', async () => {
  const demoDir = mkdtempSync(join(tmpdir(), 'hs-dataroot-'));
  writeFileSync(join(demoDir, 'index.json'), '{}\n');
  const { port, close } = await start({ dataRoot: demoDir });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const url of [`${base}/data/%2e%2e%2fpackage.json`, `${base}/data/%2e%2e%2fapp.js`, `${base}/data/..%2f..%2fpackage.json`]) {
      const response = await fetch(url);
      assert.ok([403, 404].includes(response.status), `${url} 应被拒绝，实际 ${response.status}`);
      assert.ok(!(await response.text()).includes('"name": "github-hotspot"'), `${url} 读到了仓库文件`);
    }
  } finally {
    await close();
  }
});

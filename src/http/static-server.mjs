// GitHub 好玩榜 —— 本地预览用的极简静态服务器（spec §5.1）。
//
// 为什么需要它：直接双击 public/index.html 用 file:// 打开时，浏览器会因为跨源策略拦掉
// 页面发出的 fetch，数据永远加载不出来。本地预览**必须**走 http。
//
// 它只做四件事，一行服务端业务逻辑都没有：
//   ① 把请求的路径解析成一个文件路径；
//   ② 确认这个文件确实在服务的根目录**里面**（路径穿越一律 403）；
//   ③ 目录补 index.html，其余原样读出来；
//   ④ 按扩展名给 Content-Type。
// 没有接口、没有模板、没有数据加工 —— public/ 整个目录照样能丢到任何静态托管上（spec §9）。
//
// R7（控制者裁定）：路径穿越的防护必须是**真实的、按解析后路径做的包含判定**，不能靠"浏览器会
// 先规范化 URL"。请求路径经 decodeURIComponent 解码后可能出现 `..`（`%2e%2e%2f` 里的 `%2f`
// 不是路径分隔符，URL 规范化阶段不会折叠它），也可能出现 Windows 的反斜杠，所以：
//   · 先解码，再交给 path.resolve 做真正的解析；
//   · 解析结果必须落在根目录之内，否则 403 —— 判定比较的是**解析后的绝对路径**，
//     不是字符串里有没有 `..`（后者既漏 `..\`，又误伤名字里带点的正常文件）。
//
// 只用 node: 内置模块，没有依赖（spec §5.1）。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

/** 扩展名 → Content-Type。表里没有的一律 application/octet-stream（浏览器会当下载处理）。 */
const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.woff2', 'font/woff2'],
  ['.map', 'application/json; charset=utf-8'],
]);

/** 只放行读取类请求：这是一个看页面的服务器，不该接受任何会改动东西的请求方式。 */
const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * 请求路径 → 服务根目录里的绝对文件路径。
 * @param {string} root 服务根目录（绝对路径）
 * @param {string} pathname URL 的路径部分
 * @param {string|null} [dataRoot] 演示模式：`/data/` 这一段换成这个目录（Task 18 / R127）
 * @returns {{ filePath: string } | { error: number }} 越界返回 error: 403，路径解不开返回 400
 */
function resolveTarget(root, pathname, dataRoot = null) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // 坏掉的百分号编码（例如 /%zz）：读不懂就不猜，直接说这是个坏请求。
    return { error: 400 };
  }
  // 反斜杠在 Windows 上同样是路径分隔符，而 URL 里它是合法字符：先归一化成 `/`，
  // 免得 `/..%5cpackage.json`（解码成 `..\package.json`）绕过包含判定。
  const relative = decoded.replace(/\\/g, '/').replace(/^\/+/, '');

  // 演示模式（R127）：只把 `/data/` 这一段换成另一个静态根，文件照样原样送出。
  // 注意包含判定的基准也跟着换：换根之后 `/data/..%2fapp.js` 会落到 dataRoot 之外，
  // 必须按 dataRoot 判越界（按原来的 root 判会把它当成"站点目录里的正常文件"放出去）。
  const underData = dataRoot !== null && (relative === 'data' || relative.startsWith('data/'));
  const base = underData ? dataRoot : root;
  const rest = underData ? relative.slice('data'.length).replace(/^\/+/, '') : relative;

  // 关键的一步：真正解析成绝对路径，再和根目录比对。`..` 在这里才现形。
  const target = resolve(base, rest);
  if (target !== base && !target.startsWith(base + sep)) return { error: 403 };
  return { filePath: target };
}

/**
 * 创建静态服务器（**没有**调用 listen，端口由调用方决定）。
 * @param {{ root?: string, dataRoot?: string }} [options]
 *   root：要原样提供的目录，默认 public/（相对进程工作目录）；
 *   dataRoot：可选，把 `/data/` 这一段指向另一个目录 —— `serve --demo` 用它提供演示数据
 *   （R127）。这**不是**服务端逻辑：服务器照旧只做读文件、判越界、目录补 index.html、按扩展名给
 *   Content-Type，没有接口、没有模板、不加工任何数据。
 * @returns {import('node:http').Server} http.Server 实例
 */
export function createStaticServer(options = {}) {
  const root = resolve(options.root ?? 'public');
  const dataRoot = typeof options.dataRoot === 'string' && options.dataRoot !== '' ? resolve(options.dataRoot) : null;

  return createServer(async (req, res) => {
    const send = (status, headers = {}, body) => {
      res.writeHead(status, headers);
      res.end(body);
    };

    if (!READ_METHODS.has(req.method)) {
      send(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, '这个地址只能用来查看页面。');
      return;
    }

    let pathname;
    try {
      // 基址是假的：这里只要路径部分，域名与查询串都不参与解析。
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      send(400, { 'content-type': 'text/plain; charset=utf-8' }, '看不懂这个地址。');
      return;
    }

    const target = resolveTarget(root, pathname, dataRoot);
    if (target.error) {
      send(target.error, { 'content-type': 'text/plain; charset=utf-8' }, target.error === 403 ? '这个地址不在网站目录里。' : '看不懂这个地址。');
      return;
    }

    let filePath = target.filePath;
    try {
      if ((await stat(filePath)).isDirectory()) filePath = resolve(filePath, 'index.html');
      const body = await readFile(filePath);
      send(200, {
        'content-type': MIME_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
        'content-length': body.byteLength,
        // 本地预览时改完文件刷新就能看到新的；数据文件本身带日期，不怕缓存。
        'cache-control': 'no-cache',
      }, body);
    } catch {
      // 不存在、没有读权限、路径其实是个目录 —— 对访客都是同一件事：这里没有这个文件。
      send(404, { 'content-type': 'text/plain; charset=utf-8' }, '没有这个文件。');
    }
  });
}

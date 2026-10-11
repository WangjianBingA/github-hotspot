// GitHub 好玩榜 —— 历史归档页的取数与写 DOM（原生 JS，无框架、无构建、无 CDN 依赖）。
//
// 这个文件只做两件事：取同目录下的数据清单、把 render.mjs 算好的 HTML 贴进页面。
// 显示决策一行都不在这里——"几天""怎么说""列哪几条""读不出来怎么说"全在 render.mjs 的
// historyView 里，那样才能在沙箱里（起不了浏览器）被 node:test 直接断言（R93 / R102）。
//
// 直接双击 history.html 用 file:// 打开时，浏览器会拦掉同目录的 fetch（跨源策略），
// 页面会走"读不出来"那条话——所以本地预览要走 http（在项目目录里用 npm 起的那一个）。

import { historyView } from './render.mjs';

// 数据文件放在页面旁边（同源同目录），所以用相对地址就够了。
const DATA_BASE = 'data/';

/** 取 JSON；任何失败（404、坏 JSON、断网）都返回 null，由 historyView 决定该说什么。 */
async function getJson(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** 把归档内容写进页面。元素不在就当没这回事，不抛错。 */
function draw(html) {
  const container = document.getElementById('history');
  if (container !== null) container.innerHTML = html;
}

async function boot() {
  const index = await getJson(`${DATA_BASE}index.json`);
  // loaded 区分"清单没读到"和"清单里一天都没有"——两件事的说法不一样（R101 的老毛病就是混为一谈）。
  // demo 是数据清单里的显式声明（R127）：页面据此标注这是演示数据，绝不从数据内容里猜。
  draw(historyView({
    loaded: index !== null,
    dates: index?.dates,
    demo: index?.demo === true,
  }));
}

await boot();

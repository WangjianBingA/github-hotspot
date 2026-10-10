// GitHub 好玩榜 —— 页面主逻辑（原生 JS，无框架、无构建、无 CDN 依赖）。
//
// 它是**纯前端**：只从同源的 data/ 目录 fetch JSON 文件，没有接口、没有模板引擎、
// 服务端也不做任何加工（spec §5.1、§5.3）。页面能跑起来的前提只是"这些文件在同一个网站目录下"，
// 所以整个 public/ 目录可以原样丢到任何静态托管上。
//
// 分工：本文件只管"取数据 + 把算好的结果显示出来 + 收事件"，**所有判断"该显示什么"的逻辑
// 都在 render.mjs 的 buildBoardView 里**（无 DOM 的纯函数，能被 node:test 直接断言）。
// 这样"切榜单 / 改筛选 / 换日期之后 degraded 提示还在不在""经典榜受不受难度筛选影响"
// 都是可测的事实，而不是只能靠浏览器点一遍（R93）。
//
// 本文件只做 DOM 操作，所以它自己不被 node:test 执行（Node 里没有 document）；
// test/page-content.test.mjs 对它做的是文本层面的断言（关键函数真的被调用、没有行话、插值都转义了）。
//
// Task 17 会在这个文件上继续加详情抽屉：卡片外层是 <article class="card" data-board data-full>，
// 把点击接到抽屉上即可，不必重写取数与渲染流程。

import {
  buildBoardView,
  degradedNotice,
  escapeAttr,
  escapeHtml,
  itemCard,
  missingDateNotice,
  noDataNotice,
} from './render.mjs';

// 数据文件放在页面旁边（同源同目录），所以用相对地址就够了。
const DATA_BASE = 'data/';

/** 语言筛选里代表"没有标注语言"的那一项（真实语言名不会长这样）。 */
const UNKNOWN_LANGUAGE = '__unknown__';

/** 三个榜单的中文说明（榜签上的短句在 index.html 里，这里给列表上方那句长一点的）。 */
const BOARD_NOTES = new Map([
  ['weekly', '过线之后按热度、口碑、新手友好三项算出来的总分排序：最近大家都在玩什么。'],
  ['newbie', '同一批项目，换成按"新手友好"排序：哪些你今晚真的能装上。'],
  ['classic', '按总收藏人数排的老牌好东西，不参与评分——给刚来的人补课用的。这一榜不是"最热"，是"最值得先看"。'],
]);

/**
 * 页面状态。它只存**原始事实**（哪一天、哪个榜、勾了什么、数据是什么），
 * 不存"该显示哪些卡片"——那由 buildBoardView 每次现算，避免状态与界面各说各话。
 */
const state = {
  dates: [],
  date: '',
  boardId: 'weekly',
  filters: { easy: false, chinese: false, language: '' },
  daily: null,
};

const el = (id) => document.getElementById(id);

/** 从地址栏取要看的日期（`?date=2026-10-10`），没有就让调用方给默认值。 */
function dateFromUrl() {
  try {
    const value = new URLSearchParams(window.location.search).get('date');
    return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
  } catch {
    return '';
  }
}

/** 从地址栏的 # 里取榜单名；认不出来的当没写。 */
function boardFromUrl() {
  const id = String(window.location.hash ?? '').replace(/^#/, '');
  return BOARD_NOTES.has(id) ? id : '';
}

/** 取 JSON；任何失败（404、坏 JSON、断网）都返回 null，由调用方给出人话提示。 */
async function getJson(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * 这一期的数据对象；形状不对（不是对象、`boards` 不是数组）一律当"读不出来"。
 * 这样坏文件只会走到一句中文提示，而不会把整页崩在"正在读取榜单数据……"上（R101）。
 * @returns {object|null}
 */
function currentDaily() {
  const daily = state.daily;
  if (daily === null || typeof daily !== 'object') return null;
  return Array.isArray(daily.boards) ? daily : null;
}

/** 当前榜单的条目数组（"没有这个榜""boards 不是数组"都收敛成空数组）。 */
function currentItems(boardId) {
  const daily = currentDaily();
  if (daily === null) return [];
  const board = daily.boards.find((b) => b?.id === boardId);
  return Array.isArray(board?.items) ? board.items : [];
}

/** 数据文件自带的榜单名（拿不到就让 buildBoardView 用内置的中文名兜底）。 */
function currentBoardTitle(boardId) {
  const daily = currentDaily();
  const board = daily === null ? null : daily.boards.find((b) => b?.id === boardId);
  return typeof board?.title === 'string' && board.title !== '' ? board.title : '';
}

/**
 * 把"这一屏该显示什么"算出来（R93）。
 * 通知也一起算：degraded / 空榜 / 读不出来 都在同一次计算里，
 * 所以任何一次重渲染都会重新带上它们（R94）。
 * @returns {object} buildBoardView 的结果
 */
function computeView() {
  return buildBoardView({
    boardId: state.boardId,
    boardTitle: currentBoardTitle(state.boardId),
    items: currentItems(state.boardId),
    filters: state.filters,
    daily: currentDaily(),
    date: state.date,
    dates: state.dates,
  });
}

/** 语言下拉：把这一榜当期真实出现过的语言填进去（R95：这个函数必须真的被调用）。 */
function renderLanguageOptions(view) {
  const select = el('filter-language');
  if (select === null) return;
  const current = state.filters.language;
  const known = current === UNKNOWN_LANGUAGE || view.languages.includes(current);
  // 选中的语言在这一榜里不存在了就清掉状态，否则列表会空着而用户不知道为什么。
  if (!known) state.filters.language = '';

  const options = ['<option value="">全部语言</option>'];
  for (const language of view.languages) {
    options.push(`<option value="${escapeAttr(language)}">${escapeHtml(language)}</option>`);
  }
  // 认不出语言的项目也要能被筛出来，否则它们在任何选项下都混在里面说不清。
  if (view.unknownLanguageCount > 0) {
    options.push(`<option value="${UNKNOWN_LANGUAGE}">没有标注语言（${view.unknownLanguageCount} 个）</option>`);
  }
  select.innerHTML = options.join('');
  select.value = state.filters.language;
}

/** 统计文案（R100：说的是当前看得见的条数，同时把总数写在括号里）。 */
function renderStats(view) {
  const stats = el('board-stats');
  if (stats !== null) stats.textContent = view.countText;
}

/** 日期选择器（spec §4.6：底部能回看历史上任意一天）。只有一天数据时不占地方。 */
function renderDatePicker() {
  const footer = document.querySelector('.site-foot');
  if (footer === null) return;
  const existing = el('date-picker-wrap');
  if (existing !== null) existing.remove();
  if (state.dates.length < 2) return;

  const wrap = document.createElement('p');
  wrap.className = 'date-picker';
  wrap.id = 'date-picker-wrap';
  const label = document.createElement('label');
  label.htmlFor = 'date-picker';
  label.textContent = '看哪一天：';
  const select = document.createElement('select');
  select.id = 'date-picker';
  // 日期串来自 index.json（外部输入），进属性与正文前都转义。
  select.innerHTML = state.dates
    .map((date) => `<option value="${escapeAttr(date)}"${date === state.date ? ' selected' : ''}>${escapeHtml(date)}</option>`)
    .join('');
  select.addEventListener('change', () => {
    state.date = select.value;
    const url = new URL(window.location.href);
    url.searchParams.set('date', state.date);
    window.history.replaceState(null, '', url);
    loadDaily();
  });
  wrap.append(label, select);
  footer.prepend(wrap);
}

/** 榜签与筛选条的选中态。 */
function renderControls() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', tab.dataset.board === state.boardId ? 'true' : 'false');
  }
  const easy = el('filter-easy');
  const cn = el('filter-cn');
  if (easy !== null) easy.checked = state.filters.easy;
  if (cn !== null) cn.checked = state.filters.chinese;

  // R96：经典榜按总收藏排序、不参与评分，所以"🟢 一键就能玩"这个按难度筛的开关对它没有意义。
  // 复选框**保持可用**（禁用它会让用户勾着却取消不掉），只是经典榜不拿它过滤
  // （真正的分支在 buildBoardView / boardAcceptsDifficultyFilter 里，做法与说法一致）。
  const label = easy === null ? null : easy.closest('label');
  if (label !== null) {
    label.title = state.boardId === 'classic'
      ? '经典榜按总收藏人数排序、不参与评分，所以这个筛选对它不生效——切回上面两个榜就生效了。'
      : '';
  }
}

/**
 * 渲染整块榜单区域。**通知与卡片在同一次输出里**（R94）：
 * 以前把 degraded 提示单独 insertAdjacentHTML 进去，结果任何一次重渲染（切榜单、改筛选、换日期）
 * 都会用 innerHTML 把它整个盖掉。现在它由 computeView 每次现算，跟着卡片一起写出去。
 */
function renderBoard() {
  const container = el('board');
  if (container === null) return;
  const view = computeView();

  // 这一天在日期清单里，但文件没读到：单独给一句提示，而不是空白页（R101）。
  const notices = [...view.notices];
  if (currentDaily() === null && state.dates.includes(state.date)) {
    notices.push({ key: 'date-missing', html: missingDateNotice(state.date, state.dates.length) });
  }

  const note = BOARD_NOTES.get(state.boardId) ?? '';
  const hint = '<p class="board-sub">点开卡片目前只会看到一句提示：详细说明与三步安装说明还在做（下一个版本上线）。'
    + '如果你从没打开过命令行，先看<a href="prepare.html">新手准备页</a>，从头照着做一遍就行。'
    + '另外，有中文说明的项目会带「有中文说明」徽章；只有外文文档的会如实标成「有本地化文档（非中文）」。</p>';

  const cards = view.items.map((item) => {
    // 项目全名要进 HTML 属性，所以先把引号之类转义掉：数据文件是外部输入，不能假设它一定干净。
    const full = escapeAttr(typeof item?.ownerRepo === 'string' ? item.ownerRepo : '');
    return `<article class="card" data-board="${escapeAttr(state.boardId)}" data-full="${full}" tabindex="0">`
      + itemCard({ boardId: state.boardId, item })
      + '</article>';
  }).join('');

  // 榜单名来自数据文件（外部输入），同样要转义。
  container.innerHTML = `<h2 class="board-head">${escapeHtml(view.boardTitle)}</h2>`
    + `<p class="board-sub">${note}</p>`
    + hint
    + notices.map((notice) => notice.html).join('')
    + cards;

  renderStats(view);
  renderLanguageOptions(view);
  bindCardHints(container);
}

/**
 * 当前还只是"能点开"的占位交互：真正的详情抽屉由 Task 17 接上。
 * 这里给一句提示，避免用户点了没反应而以为网站坏了。
 */
function bindCardHints(container) {
  for (const card of container.querySelectorAll('.card')) {
    card.addEventListener('click', (event) => {
      // 卡片里的"打开项目主页"是链接，点它该按链接走，不要被这里的提示抢掉。
      if (event.target instanceof Element && event.target.closest('a') !== null) return;
      window.alert('项目详情（怎么装、为什么上榜）会在下一个版本里点开就能看。现在可以先点「打开项目主页」。');
    });
  }
}

/** 整页只用一句提示时走这里（数据整个读不到、启动就崩了）。 */
function renderMessage(html) {
  const container = el('board');
  if (container !== null) container.innerHTML = html;
  const stats = el('board-stats');
  if (stats !== null) stats.textContent = '';
}

/** 读某一天的榜单数据；成功或失败都交给 renderBoard 决定说哪句话。 */
async function loadDaily() {
  const payload = await getJson(`${DATA_BASE}${state.date}.json`);
  // 形状不对的也当读不到：让它走"读不出来"的提示，而不是抛错停在"正在读取…"（R101）。
  state.daily = payload !== null && typeof payload === 'object' && Array.isArray(payload.boards) ? payload : null;
  renderControls();
  renderBoard();
  renderDatePicker();
}

/** 启动：读日期清单 → 定下要看的日期 → 渲染。任何意外都要给人话提示，不能停在转圈上。 */
async function boot() {
  const index = await getJson(`${DATA_BASE}index.json`);
  const dates = Array.isArray(index?.dates) ? index.dates.filter((d) => typeof d === 'string' && d !== '') : [];
  if (dates.length === 0) {
    renderMessage(noDataNotice());
    return;
  }
  state.dates = dates;
  const wanted = dateFromUrl();
  state.date = dates.includes(wanted) ? wanted : dates[0];
  state.boardId = boardFromUrl() || 'weekly';
  await loadDaily();
}

// ---------- 交互接线 ----------

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    const id = tab.dataset.board;
    if (!BOARD_NOTES.has(id) || id === state.boardId) return;
    state.boardId = id;
    window.location.hash = id;
    renderControls();
    renderBoard();
  });
}

el('filter-easy')?.addEventListener('change', (event) => {
  state.filters.easy = event.target.checked;
  renderBoard();
});
el('filter-cn')?.addEventListener('change', (event) => {
  state.filters.chinese = event.target.checked;
  renderBoard();
});
el('filter-language')?.addEventListener('change', (event) => {
  state.filters.language = event.target.value;
  renderBoard();
});

// 直接改地址栏的 # 也要跟上（例如从别处点进来一个带榜名的链接）。
window.addEventListener('hashchange', () => {
  const id = boardFromUrl();
  if (id === '' || id === state.boardId) return;
  state.boardId = id;
  renderControls();
  renderBoard();
});

// 启动失败（例如数据文件把某个函数喂崩了）也要有话说，而不是永远停在"正在读取榜单数据……"。
try {
  await boot();
} catch (error) {
  renderMessage('<div class="notice notice-empty"><strong>页面没能把这一期的数据读出来。</strong>'
    + '数据文件可能坏了或者形状不对。可以刷新重试；如果一直这样，就重跑一次采集。'
    + `<span class="hint">（技术细节：${escapeHtml(error?.message ?? error)}）</span></div>`);
}

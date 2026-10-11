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
  COPY_DONE_TEXT,
  COPY_FAIL_TEXT,
  buildBoardView,
  dateList,
  detailDrawer,
  escapeAttr,
  escapeHtml,
  itemCard,
  languageFacts,
  languageSelectionIsValid,
} from './render.mjs';

// 数据文件放在页面旁边（同源同目录），所以用相对地址就够了。
const DATA_BASE = 'data/';

/** 语言筛选里代表"没有标注语言"的那一项（真实语言名不会长这样）。 */
const UNKNOWN_LANGUAGE = '__unknown__';

/**
 * 认得出的榜单名（用来校验地址栏的 # 与榜签）。
 * 注意这里**只有 id，没有任何文案**：榜单叫什么、列表上方那句话说什么，全在 render.mjs 里
 * （R102：app.js 不做显示决策，也不持有用户可见的文字）。
 */
const BOARD_IDS = new Set(['weekly', 'newbie', 'classic']);

/**
 * 页面状态。它只存**原始事实**（哪一天、哪个榜、勾了什么、数据是什么、是不是还在读），
 * 不存"该显示哪些卡片"——那由 buildBoardView 每次现算，避免状态与界面各说各话。
 * view 是上一轮算出来的结果，只用于 renderControls 贴那句筛选说明，不参与任何判断。
 * demo 是**数据清单自己写的**一位（R127）：演示数据在 index.json 里显式声明自己是演示数据，
 * 页面把它原样交给渲染层，既不猜也不推断（猜错的代价是把演示数据当成真实榜单展示）。
 */
const state = {
  dates: [],
  date: '',
  boardId: 'weekly',
  filters: { easy: false, chinese: false, language: '' },
  daily: null,
  dailyLoading: false,
  demo: false,
  view: null,
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
  return BOARD_IDS.has(id) ? id : '';
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
 * 语言筛选的回退（R103 / R108）：**必须在算视图之前**做。
 * 中文下拉里那个"没有标注语言"的选项（以及某种语言本身）在不同日期可能不存在，
 * 那时 `select.value` 会停在一个已经不在选项里的值上——控件看着空白、筛选却还在生效。
 * 顺序错了就会先画一份过期列表（用户看到"控件已重置 + 空列表"，要再点一下才恢复）；
 * 所以这里先问纯函数、把无效的选择改回"全部语言"，之后才算视图、才画。
 * 事实清单（languageFacts）与判断（languageSelectionIsValid）都来自 render.mjs：
 * 本文件不自己算清单，也就不会与 buildBoardView 各说各话。
 * @param {object[]} items 当前这一榜的条目
 */
function dropInvalidLanguageSelection(items) {
  if (languageSelectionIsValid(state.filters.language, languageFacts(items))) return;
  state.filters.language = '';
}

/**
 * 把"这一屏该显示什么"算出来（R93 / R102）。
 * 这里是**唯一**把状态交给渲染层的地方：通知、语言清单、提示语全在 buildBoardView 里决定，
 * 本文件不做任何"根据数据挑一条文案"的判断（R102）。
 * R108：进门第一件事是回退无效的语言筛选——顺序在这里，不在渲染之后。
 * @returns {object} buildBoardView 的结果
 */
function computeView() {
  const items = currentItems(state.boardId);
  dropInvalidLanguageSelection(items);
  return buildBoardView({
    boardId: state.boardId,
    boardTitle: currentBoardTitle(state.boardId),
    items,
    filters: state.filters,
    daily: currentDaily(),
    date: state.date,
    dates: state.dates,
    loading: state.dailyLoading,
    // R127：这一位直接来自数据清单里的显式声明（见 boot），不在这里做任何推断。
    demo: state.demo,
  });
}

/**
 * 语言下拉：选项来自 view，是否有效也由 view 判定（R95 / R103）。
 * 曾经的缺陷：这里把"没有标注语言"当成永远有效，于是从有未标注语言的那天切到没有的另一天时，
 * 选项没了、`select.value` 却停在那个值上——控件显示空白、筛选仍在生效，用户看不到任何生效中的筛选。
 * 现在无效的选择在 computeView 里**画之前**就已经回退成"全部语言"；这里再守一道，
 * 免得将来有人加了新的入口、绕过那次回退（守住的是同一件事，不是第二套判断）。
 */
function renderLanguageOptions(view) {
  const select = el('filter-language');
  if (select === null) return;
  if (view.languageSelectionValid !== true) state.filters.language = '';

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
  // R102：这句解释的**内容**由纯函数给（view.hints 里 key 为 difficulty-filter 的那条），
  // 本文件不再自己写文案、也不做"哪个榜该说什么"的判断；这里是把它贴到 DOM 上而已。
  const hint = (state.view?.hints ?? []).find((h) => h.key === 'difficulty-filter');
  const label = easy === null ? null : easy.closest('label');
  if (label !== null) {
    // 挂在 title 上，同时也是可被测试断言的载体（不靠"悬停才会看到"的 Tooltip）。
    label.title = hint === undefined ? '' : '这条筛选对当前这个榜不生效。';
  }
}

/**
 * 渲染整块榜单区域。**通知与卡片在同一次输出里**（R94）：
 * 以前把 degraded 提示单独 insertAdjacentHTML 进去，结果任何一次重渲染（切榜单、改筛选、换日期）
 * 都会用 innerHTML 把它整个盖掉。现在它由 computeView 每次现算，跟着卡片一起写出去。
 *
 * R102：这里没有任何"根据数据挑一条文案"的分支——通知列表与说明语都来自 view。
 */
function drawBoard() {
  const container = el('board');
  if (container === null) return;
  const view = computeView();
  state.view = view;

  const cards = view.items.map((item, index) => {
    // 项目全名要进 HTML 属性，所以先把引号之类转义掉：数据文件是外部输入，不能假设它一定干净。
    const full = escapeAttr(typeof item?.ownerRepo === 'string' ? item.ownerRepo : '');
    // data-index 是"点开时回到哪一条"的钥匙：用序号而不是项目名，省掉在名字上做转义/反转义的来回。
    return `<article class="card" data-board="${escapeAttr(state.boardId)}" data-index="${index}" data-full="${full}" tabindex="0">`
      + itemCard({ boardId: state.boardId, item })
      + '</article>';
  }).join('');

  // 榜单名与列表上下的说明全部来自 view。榜单名可能来自数据文件（外部输入）所以转义；
  // 说明文案是内部文案，本身可以带一个链接标签（新手准备页），所以按 HTML 片段贴上去。
  container.innerHTML = `<h2 class="board-head">${escapeHtml(view.boardTitle)}</h2>`
    + view.hints.filter((hint) => hint.html !== '').map((hint) => `<p class="board-sub">${hint.html}</p>`).join('')
    + view.notices.map((notice) => notice.html).join('')
    + cards;

  renderStats(view);
  renderLanguageOptions(view);
  renderControls();
  bindCards(container);
}

// ---------- 详情抽屉（Task 17） ----------
//
// 本文件在这里只做三件事：**开关**、**把 render.mjs 算好的内容贴到 DOM 上**、**复制命令**。
// 抽屉里显示什么（三步向导、为什么上榜、经典榜那一节、置信度标注）全部由 detailDrawer 决定，
// 所以那些判断都能在没有浏览器的环境里被断言（R93 / R102）。
// 注意命令文本是从页面上那个 `<code>` 里读的（`data-copy-source` 指过去），
// 所以 app.js 连数据字段名都不用知道。

/** 上一次把焦点放在哪（关抽屉时还回去，键盘用户不会被丢在页面顶部）。 */
let lastFocused = null;

/** 抽屉壳（index.html 里那个 hidden 的 section）。 */
const drawerEl = () => el('drawer');

/**
 * 打开抽屉：把 detailDrawer 给的 HTML 贴进内容区，然后显示它。
 * `hidden` 与 `aria-hidden` 一起改：只改一个的话，读屏软件仍会念一段看不见的内容。
 * @param {{ boardId: string, item: object }} input 当前榜与那一条数据
 */
function openDrawer({ boardId, item }) {
  const drawer = drawerEl();
  const body = el('drawer-body');
  if (drawer === null || body === null) return;
  body.innerHTML = detailDrawer({ boardId, item });
  lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  drawer.hidden = false;
  drawer.setAttribute('aria-hidden', 'false');
  // 关掉按钮里没有文字（只有一个乘号），所以给它一个能读出来的名字。
  const close = drawer.querySelector('[data-drawer-close]');
  if (close instanceof HTMLElement) close.focus();
}

/**
 * 关掉抽屉。**不销毁内容**：下次打开会整段重写，所以留着没有风险，
 * 而且焦点能干净地还回原来那张卡片（不然键盘用户会被丢回页面顶部）。
 */
function closeDrawer() {
  const drawer = drawerEl();
  if (drawer === null) return;
  drawer.hidden = true;
  drawer.setAttribute('aria-hidden', 'true');
  if (lastFocused !== null && document.contains(lastFocused)) lastFocused.focus();
  lastFocused = null;
}

/** 抽屉是不是开着（`hidden` 是唯一事实，不另开一个布尔状态，免得两边走岔）。 */
function drawerOpen() {
  const drawer = drawerEl();
  return drawer !== null && drawer.hidden === false;
}

/**
 * 卡片：点一下打开详情；键盘上回车或空格同样能打开。
 * 卡片里的「打开项目主页」是链接，点它该按链接走——这里不抢链接的点击。
 * @param {HTMLElement} container 榜单容器
 */
function bindCards(container) {
  for (const card of container.querySelectorAll('.card')) {
    card.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a') !== null) return;
      openCardDrawer(card);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target instanceof Element && event.target.closest('a') !== null) return;
      event.preventDefault();
      openCardDrawer(card);
    });
  }
}

/** 从卡片上带着的榜单名与序号，回到当前数据里找出那一条，再交给 openDrawer。 */
function openCardDrawer(card) {
  const boardId = typeof card.dataset.board === 'string' && card.dataset.board !== '' ? card.dataset.board : state.boardId;
  const index = Number.parseInt(card.dataset.index ?? '', 10);
  const items = currentItems(boardId);
  // 用序号取那一条（序号是渲染这张卡片时写下的，所以正常情况下一定命中）。
  // 命不中（例如数据刚好换了、卡片还是旧的）就退回"按项目全名找"，再不行给一个只有名字的条目：
  // 抽屉照样会给出可用的内容，不会把整页搞崩——数据文件是外部输入，界面必须扛得住形状不对。
  const byIndex = Number.isInteger(index) && index >= 0 && index < items.length ? items[index] : null;
  const full = typeof card.dataset.full === 'string' ? card.dataset.full : '';
  const item = byIndex ?? items.find((candidate) => candidate?.ownerRepo === full) ?? { ownerRepo: full };
  openDrawer({ boardId, item });
}

/**
 * 复制命令到剪贴板。
 * 优先用浏览器给的剪贴板接口（它只在安全上下文里可用），不行就退回老办法。
 * 两条路都失败时也要说一句人话，而不是让用户以为按钮坏了。
 * @param {HTMLElement} button 复制按钮
 */
async function copyCommand(button) {
  const source = button.dataset.copySource ?? '';
  const targetId = (button.dataset.copyTarget ?? '').replace(/^#/, '');
  const sourceEl = source === '' ? null : document.querySelector(source);
  const target = targetId === '' ? null : el(targetId);
  const text = sourceEl === null ? '' : (sourceEl.textContent ?? '');
  const done = (message) => {
    if (target !== null) target.textContent = message;
  };
  if (text === '') {
    done(COPY_FAIL_TEXT);
    return;
  }
  // 剪贴板接口要求安全上下文（https 或 localhost）；预览站点用 http 打开时它根本不存在，
  // 所以这里不靠 try/catch 兜，而是显式判断，免得在开发者工具里留下一堆没意义的报错。
  const canUseClipboard = navigator.clipboard !== undefined
    && typeof navigator.clipboard.writeText === 'function'
    && window.isSecureContext !== false;
  if (canUseClipboard) {
    try {
      await navigator.clipboard.writeText(text);
      done(COPY_DONE_TEXT);
      return;
    } catch {
      // 用户拒绝了权限、或者浏览器就是不给：继续走下面那条老路。
    }
  }
  if (copyWithSelection(text)) {
    done(COPY_DONE_TEXT);
    return;
  }
  done(COPY_FAIL_TEXT);
}

/**
 * 老浏览器的复制办法：临时造一个文本框、选中它、让浏览器执行复制、再删掉。
 * 复制失败（返回 false）时调用方会说一句"请自己选中那一行按 Ctrl 加 C"。
 * @param {string} text 要复制的文本
 * @returns {boolean} 是否成功
 */
function copyWithSelection(text) {
  const area = document.createElement('textarea');
  // 不能放在视口外（有的浏览器会拒绝复制看不见的内容），所以贴住左上角、尺寸为零地看着不像。
  area.value = text;
  area.setAttribute('readonly', 'readonly');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

// 抽屉上的事件：关掉按钮、点空白处、按 Esc，三条路都能关掉它。
// 用事件委托挂在 document 上：抽屉内容是每次打开重写的，挂在内容里的监听会跟着内容一起被换掉。
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest('[data-drawer-close]') !== null) {
    closeDrawer();
    return;
  }
  const copy = event.target.closest('[data-copy-source]');
  if (copy instanceof HTMLElement) {
    copyCommand(copy);
    return;
  }
  // 点抽屉外面那层遮罩（不是抽屉内容里）也关掉：手机上这是最顺手的关法。
  if (drawerOpen() && event.target === drawerEl()) closeDrawer();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !drawerOpen()) return;
  closeDrawer();
});

/** 整页只用一句提示时走这里（数据整个读不到、启动就崩了）。 */
function renderMessage(html) {
  const container = el('board');
  if (container !== null) container.innerHTML = html;
  const stats = el('board-stats');
  if (stats !== null) stats.textContent = '';
}

/** 读某一天的榜单数据；成功或失败都交给 drawBoard 决定说哪句话（R101/R104）。 */
async function loadDaily() {
  // 读的过程中给"正在读取"（由视图函数决定），读完再交给"读不出来"那条提示——
  // 两者是不同的事，不能混成一句（R104）。
  state.dailyLoading = true;
  drawBoard();
  const payload = await getJson(`${DATA_BASE}${state.date}.json`);
  // 形状不对的也当读不到：让它走"读不出来"的提示，而不是抛错停在"正在读取…"（R101）。
  state.daily = payload !== null && typeof payload === 'object' && Array.isArray(payload.boards) ? payload : null;
  state.dailyLoading = false;
  drawBoard();
  renderDatePicker();
}

/**
 * 启动：读日期清单 → 定下要看的日期 → 渲染。
 * 日期清单为空**不在这里挑提示**（R102）：让 loadDaily 走同一条渲染路径，
 * 由 buildBoardView 在 `dates` 为空时说"还没有任何榜单数据"。
 * 日期清单与"这是不是演示数据"都来自同一份清单（index.json）：
 * 日期怎么认（形状、去重、最新在前）由 render.mjs 的 dateList 给，这里不另立一套口径。
 */
async function boot() {
  const index = await getJson(`${DATA_BASE}index.json`);
  state.dates = dateList(index);
  // R127：演示数据在清单里显式声明自己是演示数据（`demo: true`），页面据此标注。
  // 真实采集不会写这一位，所以真实的清单永远不会被标成演示数据。
  state.demo = index?.demo === true;
  const wanted = dateFromUrl();
  state.date = state.dates.includes(wanted) ? wanted : (state.dates[0] ?? '');
  state.boardId = boardFromUrl() || 'weekly';
  await loadDaily();
}

// ---------- 交互接线 ----------

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    const id = tab.dataset.board;
    if (!BOARD_IDS.has(id) || id === state.boardId) return;
    state.boardId = id;
    window.location.hash = id;
    drawBoard();
  });
}

el('filter-easy')?.addEventListener('change', (event) => {
  state.filters.easy = event.target.checked;
  drawBoard();
});
el('filter-cn')?.addEventListener('change', (event) => {
  state.filters.chinese = event.target.checked;
  drawBoard();
});
el('filter-language')?.addEventListener('change', (event) => {
  state.filters.language = event.target.value;
  drawBoard();
});

// 直接改地址栏的 # 也要跟上（例如从别处点进来一个带榜名的链接）。
window.addEventListener('hashchange', () => {
  const id = boardFromUrl();
  if (id === '' || id === state.boardId) return;
  state.boardId = id;
  drawBoard();
});

// 启动失败（例如数据文件把某个函数喂崩了）也要有话说，而不是永远停在"正在读取榜单数据……"。
// 这是**兜底**，不是显示决策：正常路径上"该说什么"全部由 buildBoardView 决定。
try {
  await boot();
} catch (error) {
  renderMessage('<div class="notice notice-empty"><strong>页面没能把这一期的数据读出来。</strong>'
    + '数据文件可能坏了或者形状不对。可以刷新重试；如果一直这样，就重跑一次采集。'
    + `<span class="hint">（技术细节：${escapeHtml(error?.message ?? error)}）</span></div>`);
}

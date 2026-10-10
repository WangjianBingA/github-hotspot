// GitHub 好玩榜 —— 页面主逻辑（原生 JS，无框架、无构建、无 CDN 依赖）。
//
// 它是**纯前端**：只从同源的 data/ 目录 fetch JSON 文件，没有接口、没有模板引擎、
// 服务端也不做任何加工（spec §5.1、§5.3）。页面能跑起来的前提只是"这些文件在同一个网站目录下"，
// 所以整个 public/ 目录可以原样丢到任何静态托管上。
//
// 分工：本文件只管"取数据 + 拼页面 + 筛选"，所有会写进用户眼睛里的字都住在 render.mjs 里
// （那一层是纯函数，能被 node:test 直接断言"有没有说谎"）。
// 其中"这个新增收藏数字有多可信"由 render.mjs 统一成三种说法：约 N（估算）/ N（实测）/
// N（GitHub 官方数据）；本文件只负责把它排进卡片，不自己拼这些字。
//
// Task 17 会在这个文件上继续加详情抽屉：卡片外层是 <article class="card" data-full="owner/repo">，
// 它现在是"可点开"的入口（点一下给一句提示），Task 17 把点击接到抽屉上即可，不必重写这里。

import {
  boardNotice,
  degradedNotice,
  itemCard,
  itemMeta,
  missingDateNotice,
  noDataNotice,
} from './render.mjs';

// 数据文件放在页面旁边（同源同目录），所以用相对地址就够了。
const DATA_BASE = 'data/';

/** 三个榜单的中文说明（榜签上的短句在 index.html 里，这里给列表上方那句长一点的）。 */
const BOARD_NOTES = new Map([
  ['weekly', '过线之后按热度、口碑、新手友好三项算出来的总分排序：最近大家都在玩什么。'],
  ['newbie', '同一批项目，换成按"新手友好"排序：哪些你今晚真的能装上。'],
  ['classic', '按总收藏人数排的老牌好东西，不参与评分——给刚来的人补课用的。这一榜不是"最热"，是"最值得先看"。'],
]);

/** 页面状态。 */
const state = {
  dates: [],
  date: '',
  boardId: 'weekly',
  filters: { easy: false, chinese: false, language: '' },
  daily: null,
  // 卡片下方那句"点开能看什么"：详情抽屉由 Task 17 接上，所以这里只说"介绍与安装说明"，
  // 不承诺现在还没有的东西。安装说明是三步走的（spec §4.5），准备页教怎么开命令行。
  hintText: '<p class="board-sub">点开任意一张卡片可以看到它的详细介绍与三步安装说明；'
    + '如果你从没打开过命令行，先看<a href="prepare.html">新手准备页</a>，从头照着做一遍就行。'
    + '另外，有中文说明的项目会带「有中文说明」徽章；只有外文文档的会如实标成「有本地化文档（非中文）」。</p>',
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
 * 一条数据够不够格留在列表里（筛选条：🟢 一键就能玩 / 🈶 有中文说明 / 语言）。
 * 注意 R25：经典必玩榜不参与评分，所以那两个筛选对它不生效（不生效就不显示，见 renderFilters 的说明）。
 * @param {object} item 条目
 * @returns {boolean}
 */
function passesFilters(item) {
  if (state.filters.easy && item?.grade !== 'green') return false;
  // 「有中文说明」只认 hasChinese（R64）：有日文文档不等于有中文说明。
  if (state.filters.chinese && item?.hasChinese !== true) return false;
  if (state.filters.language !== '' && item?.language !== state.filters.language) return false;
  return true;
}

/**
 * 语言下拉：把这一期真的出现过的语言填进去。
 * 不预设一份语言清单——没出现过的语言给了也没意义，反而让人以为筛掉了东西。
 */
function renderLanguageOptions(board) {
  const select = el('filter-language');
  if (select === null) return;
  const current = state.filters.language;
  const languages = [...new Set((board?.items ?? [])
    .map((item) => item?.language)
    .filter((language) => typeof language === 'string' && language !== ''))]
    .sort();
  select.innerHTML = '<option value="">全部语言</option>'
    + languages.map((language) => `<option value="${language}">${language}</option>`).join('');
  select.value = languages.includes(current) ? current : '';
  // 选中的语言在这一榜里不存在了就清掉状态，否则列表会空着而用户不知道为什么。
  if (!languages.includes(current)) state.filters.language = '';
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
  select.innerHTML = state.dates
    .map((date) => `<option value="${date}"${date === state.date ? ' selected' : ''}>${date}</option>`)
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

/** 页面底部那句"这一期数据是什么时候采的"，以及筛选条上的条数。 */
function renderMeta() {
  const count = el('filter-count');
  const board = state.daily?.boards?.find((b) => b.id === state.boardId);
  const all = Array.isArray(board?.items) ? board.items : [];
  if (count !== null) {
    count.textContent = all.length === 0 ? '' : `这一榜共 ${all.length} 个项目`;
  }
  const generated = typeof state.daily?.generatedAt === 'string' ? state.daily.generatedAt : '';
  const picker = el('date-picker-wrap');
  if (picker !== null) {
    const stamp = generated === '' ? '' : `（采集于 ${generated.slice(0, 16).replace('T', ' ')} UTC）`;
    picker.title = stamp;
  }
}

/** 渲染当前榜单（含筛选结果）。 */
function renderBoard() {
  const container = el('board');
  if (container === null) return;
  const board = state.daily?.boards?.find((b) => b.id === state.boardId);
  const all = Array.isArray(board?.items) ? board.items : [];
  const items = all.filter(passesFilters);

  // 榜单名以数据里的 title 为准（数据文件自带标题），拿不到时用榜签上那句短句。
  const title = typeof board?.title === 'string' && board.title !== ''
    ? board.title
    : (state.boardId === 'weekly' ? '本周飙升' : state.boardId === 'newbie' ? '新手能玩' : '经典必玩');
  const note = BOARD_NOTES.get(state.boardId) ?? '';

  // 空榜有两种：这一期本来就没有条目，或者筛选把条目都滤掉了。说法不能混（否则用户会以为采集坏了）。
  const notice = all.length > 0 && items.length === 0
    ? `<p class="empty">「${title}」这一期有 ${all.length} 个项目，但你现在的筛选条件下一个都不剩了。把筛选放宽一点就能看到。</p>`
    : boardNotice({ boardTitle: title, itemCount: all.length });

  const cards = items.map((item) => {
    const full = typeof item?.ownerRepo === 'string' ? item.ownerRepo : '';
    return `<article class="card" data-board="${state.boardId}" data-full="${full}" tabindex="0">`
      + itemCard({ boardId: state.boardId, item })
      + '</article>';
  }).join('');

  // 卡片上方那句说明（内容见 state.hintText 的注释）。
  const hint = state.hintText;

  container.innerHTML = `<h2 class="board-head">${title}</h2><p class="board-sub">${note}</p>`
    + hint
    + notice
    + cards;

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

/** 榜签与筛选条的选中态。 */
function renderControls() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', tab.dataset.board === state.boardId ? 'true' : 'false');
  }
  const easy = el('filter-easy');
  const cn = el('filter-cn');
  if (easy !== null) easy.checked = state.filters.easy;
  if (cn !== null) cn.checked = state.filters.chinese;

  // R25：经典必玩榜按总收藏排序、不参与评分，所以"一键就能玩"这个按难度筛的开关对它没有意义。
  // 禁用并说明原因，比"能点但点了没用"诚实。
  const classic = state.boardId === 'classic';
  if (easy !== null) {
    easy.disabled = classic;
    const label = easy.closest('label');
    if (label !== null) label.title = classic ? '经典榜按总收藏人数排序，不参与评分，所以这里的分级筛选对它不生效。' : '';
  }
}

/** 数据整个读不到时（index.json 缺失或为空）的整页提示。 */
function renderNoData() {
  const container = el('board');
  if (container !== null) container.innerHTML = noDataNotice();
  const count = el('filter-count');
  if (count !== null) count.textContent = '';
}

/** 读某一天的榜单数据并渲染。 */
async function loadDaily() {
  const container = el('board');
  if (state.daily === null && container !== null) container.innerHTML = '<p class="loading">正在读取榜单数据……</p>';
  const payload = await getJson(`${DATA_BASE}${state.date}.json`);
  if (payload === null) {
    if (container !== null) container.innerHTML = missingDateNotice(state.date, state.dates.length);
    return;
  }
  state.daily = payload;
  renderControls();
  renderMeta();
  renderBoard();
  renderDatePicker();
}

/** 启动：读日期清单 → 定下要看的日期 → 渲染。 */
async function boot() {
  const index = await getJson(`${DATA_BASE}index.json`);
  const dates = Array.isArray(index?.dates) ? index.dates.filter((d) => typeof d === 'string' && d !== '') : [];
  if (dates.length === 0) {
    renderNoData();
    return;
  }
  state.dates = dates;
  const wanted = dateFromUrl();
  state.date = dates.includes(wanted) ? wanted : dates[0];
  state.boardId = boardFromUrl() || 'weekly';

  // 把降级提示与榜单一起放进去：先清空占位，再交给 loadDaily。
  const container = el('board');
  if (container !== null) container.innerHTML = '';
  await loadDaily();

  if (container !== null) {
    container.insertAdjacentHTML('afterbegin', degradedNotice(state.daily?.degraded, state.daily?.notes));
  }
}

// ---------- 交互接线 ----------

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    const id = tab.dataset.board;
    if (!BOARD_NOTES.has(id) || id === state.boardId) return;
    state.boardId = id;
    window.location.hash = id;
    renderControls();
    renderMeta();
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
  renderMeta();
  renderBoard();
});

await boot();

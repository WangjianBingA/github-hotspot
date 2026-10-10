// GitHub 好玩榜 —— 页面渲染层（纯函数，不碰 DOM、不读时钟、不发请求）。
//
// 为什么单独一层：这些函数决定"用户看到哪几个字"与"哪些条目真的显示出来"，
// 而"不许说谎"是本项目的产品约束（spec §4.3 术语翻译表、§7.3 界面必须诚实），
// 所以它们必须能被 node:test 直接断言，而不是埋在事件回调里只能靠肉眼看。
// 输入是 JSON 里的数据与当前界面状态，输出是 HTML 字符串 / 该渲染的通知。
//
// 这个文件**没有 import、没有时钟、没有网络、也没有 DOM**：正因如此，
// "切榜单 / 改筛选 / 换日期之后该显示什么"才能在没有浏览器的环境里被测试
// （R93：只能在浏览器里验的东西，就是验不了的东西）。
//
// 六条硬规矩（每一条都对应一次真实缺陷）：
//   · 行话禁令（spec §4.3）：界面上不出现外文行话原词，也不泄露内部字段名。
//     翻译表：用"收藏"这类说法代替那个以 S 开头的词；"拿去改造"代替那个以 F 开头的词；
//     "作者管不管事"代替那个以 I 开头的词；"作者已停止维护"代替那个表示停更的英文词；
//     "项目"代替那个表示代码仓库的词。本文件自身也不写这些原词：一旦出现在注释里，
//     下一个人复制粘贴时就可能顺手带进界面文案。行话清单由 test/page-content.test.mjs 钉住。
//   · R25：经典必玩榜按总收藏排序、**不参与三轴评分**，所以那个榜不渲染分数，
//     也不接受"按难度筛"（见 buildBoardView）；改说总收藏人数 + 最后更新时间。
//   · R64：徽章「🈶 有中文说明」只认 hasChinese === true。只有非中文本地化文档时如实说
//     「有本地化文档（非中文）」—— 绝不能拿它冒充中文。
//   · 置信度（spec §7.3）：估算值写"约 N（估算）"、转述写"N（GitHub 官方数据）"、
//     实测写"N（实测）"；velocitySource 是 'none' 表示**我们根本没问到**，
//     那时不许渲染成"涨 0"（那是在陈述一件我们并不知道的事实），整行省略。
//   · 取证来源（install.evidence）不许原样出现：那是内部用的英文键名，
//     翻译成一句中文说法，认不出来就不说。
//   · 所有来自 JSON 的字符串都是**外部输入**，进 HTML 之前一律转义（escapeHtml / escapeAttr）。
//
// 本文件自身被当作纯文本扫过（test/page-content.test.mjs）：注释与字符串里都不许出现行话原词。

/** 中文徽章：真的查到中文文档才给。 */
export const CHINESE_BADGE = '🈶 有中文说明';
/** 只有非中文本地化文档时的徽章（R64）：照实说，不冒充中文。 */
export const LOCALIZED_ONLY_BADGE = '有本地化文档（非中文）';

/** 三个榜单的中文名：数据文件里的 title 缺失时用它兜底。 */
const BOARD_TITLES = new Map([
  ['weekly', '本周飙升'],
  ['newbie', '新手能玩'],
  ['classic', '经典必玩'],
]);

/**
 * 每个榜单列表上方那句"这个榜是什么"的说明（R102：这也是显示文案，住在纯函数层）。
 * 说清排序依据，并点明经典榜"不是最热、是最值得先看"——它的排序依据与其他两榜不同。
 */
const BOARD_NOTES = new Map([
  ['weekly', '过线之后按热度、口碑、新手友好三项算出来的总分排序：最近大家都在玩什么。'],
  ['newbie', '同一批项目，换成按"新手友好"排序：哪些你今晚真的能装上。'],
  ['classic', '按总收藏人数排的老牌好东西，不参与评分——给刚来的人补课用的。这一榜不是"最热"，是"最值得先看"。'],
]);

/** 难度徽章文案（spec §4.2），也是筛选条上那句话的来源。 */
const GRADE_BADGES = new Map([
  ['green', '🟢 一键就能玩'],
  ['yellow', '🟡 要几步'],
  ['red', '🔴 要懂点技术'],
]);

/** 涨星速度的三种置信度 → 前缀与括号说明（与 src/score/reasons.mjs 同一口径，spec §7.3）。 */
const CONFIDENCE_WORDS = new Map([
  ['measured', { lead: '', tail: '（实测）' }],
  ['estimated', { lead: '约', tail: '（估算）' }],
  ['reported', { lead: '', tail: '（GitHub 官方数据）' }],
]);

/**
 * 内部取证字段（install.evidence）的中文说法。
 * 这些值是"我们凭什么敢让你装这个包"的证据来源，不是给用户看的键名：原文是
 * 'repository' / 'bugs.url' / 'homepage' / 'project_urls' / 'home_page' / 'none'，
 * 直接显示等于把内部字段名甩到用户脸上。认不出来时统一说"我们查到了官方出处"，绝不回显原文。
 */
const EVIDENCE_TEXTS = new Map([
  ['repository', '这个包自己在页面上写着它来自这个项目。'],
  ['bugs.url', '这个包把问题反馈地址指向了这个项目。'],
  ['homepage', '这个包的主页地址填的就是这个项目。'],
  ['project_urls', '这个包的官方页面里列着这个项目。'],
  ['home_page', '这个包的官方页面填的就是这个项目。'],
  // 'none' 表示归属不成立：那种情况下根本不该有安装命令，所以这里给的是一句
  // "我们没敢让你照着装"的说明，而不是回显这个内部取值。
  ['none', '我们没能确认这个包属于这个项目，所以没有给你安装命令。'],
]);

/** 三轴的中文名（详情与分数摘要共用，界面上不出现 hot / reputation 这类英文键名）。 */
const AXES = [
  { key: 'hot', label: '热度' },
  { key: 'reputation', label: '口碑' },
  { key: 'runnable', label: '新手友好' },
];

/** 三轴的满分（spec §6.1）；详情页画分数条时用来折算宽度。 */
const FULL_MARKS = { hot: 45, reputation: 30, runnable: 25 };

/** 没问到新增收藏时那句诚实话（**不是**"涨 0"：那是在陈述我们并不知道的事实）。 */
const GROWTH_UNKNOWN_TEXT = '这一周的新增收藏，我们没有查到';

/** 经典榜的 id：唯一一个不参与三轴评分、也不接受难度筛选的榜（R25）。 */
const CLASSIC_ID = 'classic';

/** 语言筛选里代表"这些条目没有标注语言"的那一项（与 public/app.js 的常量同名同值）。 */
const UNKNOWN_LANGUAGE = '__unknown__';

/** 这一条有没有标注语言（空串与缺失都算"没有标注"）。 */
const hasLanguage = (item) => typeof item?.language === 'string' && item.language !== '';

/** 本地还没跑过采集时，给新手的那条命令（R99：只写今天真能用的一条）。 */
const COLLECT_COMMAND = '<code>npm run collect --offline</code>';

// ---------- 转义（外部输入进 HTML 的唯一通道） ----------

/**
 * 把值转成 HTML 安全文本。所有来自 JSON 的字符串都要过一次。
 * 这是本模块唯一的转义出口：内部一律用它，不自己拼 replace 链。
 * @param {*} value 任意值（null / undefined 变成空串）
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 放进 HTML **属性**里的值（引号必须转义，否则可以提前闭合属性）。
 * @param {*} value 任意值
 * @returns {string}
 */
export function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

/** 有限数字判定（拿不到就是拿不到，绝不用 0 顶替）。 */
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

/** 千分位；拿不到数字时返回空串。 */
const num = (value) => (isNum(value) ? value.toLocaleString('zh-CN') : '');

/** 一定是数组（数据文件是外部输入，`boards` 可能不是数组）。 */
const asArray = (value) => (Array.isArray(value) ? value : []);

// ---------- 文案与徽章 ----------

/**
 * 本周新增收藏。三态照实标注（spec §7.3），不知道时**整行不显示**（见文件头第四条）。
 * @param {{ gained7d?: number, confidence?: string, source?: string, velocitySource?: string }} [velocity]
 * @returns {{ known: boolean, text: string, tone: 'estimated'|'measured'|'reported'|'unknown' }}
 */
export function growthNotice(velocity) {
  const gained = velocity?.gained7d;
  const source = velocity?.velocitySource ?? velocity?.source ?? null;
  // 'none' = 五级阶梯一级都没命中：不是"涨了 0"，是我们没问到。数值缺失同理。
  if (source === 'none' || !isNum(gained)) {
    return { known: false, text: '', tone: 'unknown' };
  }
  const words = CONFIDENCE_WORDS.get(velocity?.confidence);
  // 置信度认不出来时不带括号：宁可少说一句，也不假装它是实测（与 reasons.mjs 同一口径）。
  if (!words) {
    return { known: true, text: `本周新增收藏 ${num(gained)}`, tone: 'unknown' };
  }
  // 前缀与数字之间固定留一个空格：界面上读起来是"约 900（估算）"，而不是挤在一起的"约900"。
  const lead = typeof words.lead === 'string' && words.lead !== '' ? `${words.lead} ` : '';
  return { known: true, text: `本周新增收藏 ${lead}${num(gained)}${words.tail}`, tone: velocity.confidence };
}

/**
 * 近 3 日新增：只有真有 3 日数据（gained3d 是数字）时才出现，同时带上置信度标注。
 * @param {{ gained3d?: number, confidence?: string, source?: string, velocitySource?: string }} [velocity]
 * @returns {string} 一句话；没有数据时返回空串
 */
export function confidenceNotice(velocity) {
  const source = velocity?.velocitySource ?? velocity?.source ?? null;
  if (source === 'none' || !isNum(velocity?.gained3d)) return '';
  const words = CONFIDENCE_WORDS.get(velocity?.confidence);
  return `近 3 日新增 ${num(velocity.gained3d)}${words ? words.tail : ''}`;
}

/**
 * 取证来源的中文说法（**绝不回显英文原始值**）。
 * @param {string} [evidence] install.evidence 的原始值
 * @returns {string} 一句中文；没有证据时返回空串
 */
export function evidenceNotice(evidence) {
  if (typeof evidence !== 'string' || evidence === '') return '';
  return EVIDENCE_TEXTS.get(evidence) ?? '我们查到了官方出处，确认这个包属于这个项目。';
}

/**
 * 难度徽章（spec §4.2）。等级认不出来时不显示徽章——猜一个难度比不显示更糟。
 * @param {string} [grade] 'green' | 'yellow' | 'red'
 * @returns {string} 徽章 HTML；认不出来时空串
 */
export function difficultyBadge(grade) {
  const text = GRADE_BADGES.get(grade);
  return text === undefined ? '' : `<span class="badge badge-${escapeAttr(grade)}">${text}</span>`;
}

/**
 * 中文徽章。R64 的三分支，一条都不能合并：
 *   · hasChinese === true      → 「🈶 有中文说明」
 *   · 否则有本地化文件          → 「有本地化文档（非中文）」（有本地化文档 ≠ 有中文）
 *   · 都没有                    → 不给徽章（我们没查到，就不说）
 * @param {{ hasChinese?: boolean, localizedFiles?: string[] }} [item]
 * @returns {string} 徽章 HTML；不该给时是空串
 */
export function chineseBadge(item) {
  if (item?.hasChinese === true) return `<span class="badge badge-cn">${CHINESE_BADGE}</span>`;
  const files = asArray(item?.localizedFiles).filter((f) => typeof f === 'string' && f !== '');
  if (files.length === 0) return '';
  return `<span class="badge badge-cn-alt" title="${escapeAttr(files.join('、'))}">${LOCALIZED_ONLY_BADGE}</span>`;
}

// ---------- 分数（周榜与新手榜专用；经典榜一律空串，R25） ----------

/**
 * 三轴分数摘要。
 * R25：经典榜**不参与三轴评分**，所以 boardId 是 classic 时直接返回空串——
 * 那个榜按总收藏排序，给它画分数等于告诉用户"它是按分数排上来的"。
 * @param {string} boardId 榜单 id
 * @param {{ scores?: object }} item 条目
 * @returns {string} 一行分数摘要；经典榜或没有分数时是空串
 */
export function boardScore(boardId, item) {
  if (boardId === CLASSIC_ID) return '';
  const scores = item?.scores;
  if (!scores || !isNum(scores.total)) return '';
  const axes = AXES
    .filter((axis) => isNum(scores[axis.key]))
    .map((axis) => `<span class="axis"><span class="axis-name">${axis.label}</span>${num(scores[axis.key])}</span>`)
    .join('');
  return `<div class="score-summary"><span class="score-total">综合 ${num(scores.total)} 分</span>${axes}</div>`;
}

/**
 * 三轴分数条（详情里"为什么上榜"摊开公式时用，spec §4.4）。经典榜同样不渲染（R25）。
 * @param {string} boardId 榜单 id
 * @param {{ scores?: object }} item 条目
 * @returns {string} 分数条 HTML；经典榜或没有分数时是空串
 */
export function scoreBars(boardId, item) {
  if (boardId === CLASSIC_ID) return '';
  const scores = item?.scores;
  if (!scores) return '';
  const rows = AXES.filter((axis) => isNum(scores[axis.key])).map((axis) => {
    const value = scores[axis.key];
    // 宽度按该轴满分折算；满分读不出来时退回按 100 折算，绝不编一个"满格"的进度条。
    const full = FULL_MARKS[axis.key] ?? 100;
    const width = Math.max(0, Math.min(100, Math.round((value / full) * 100)));
    return `<div class="bar-row"><span class="bar-label">${axis.label}</span>`
      + `<span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span>`
      + `<span class="bar-value">${num(value)}</span></div>`;
  });
  if (rows.length === 0) return '';
  return `<div class="score-bars">${rows.join('')}</div>`;
}

// ---------- 事实 ----------

/**
 * 项目基本事实（详情用）。拿不到的事实整条不列，绝不用一个占位符假装成"没有"。
 * @param {object} item 条目
 * @returns {{ label: string, value: string }[]}
 */
export function factList(item) {
  const facts = [];
  if (typeof item?.language === 'string' && item.language !== '') facts.push({ label: '写它的语言', value: item.language });
  if (isNum(item?.stars)) facts.push({ label: '有多少人收藏', value: num(item.stars) });
  if (isNum(item?.forks)) facts.push({ label: '有多少人拿去改造', value: num(item.forks) });
  const pushed = formatTime(item?.pushedAt);
  if (pushed !== '') facts.push({ label: '最后更新时间', value: pushed });
  if (typeof item?.license === 'string' && item.license !== '') facts.push({ label: '许可证', value: item.license });
  // 数据里那个表示"作者主动停更"的布尔字段（上游契约用的英文键名）翻译成一句诚实的中文。
  // 字段名本身绝不渲染出去：界面上只说结论。
  if (item?.archived === true) facts.push({ label: '维护状态', value: '作者已停止维护' });
  return facts;
}

/**
 * 按榜单给"这张卡片该说的话"（R25 的分支点）。
 * 经典必玩榜是"补课"用的：给总收藏人数与最后更新时间，**不给三轴分数**；
 * 另外两个榜按三轴评分排，就给分数摘要。
 * @param {string} boardId 榜单 id
 * @param {object} item 条目
 * @returns {{ label: string, value: string }[]}
 */
export function factsForBoard(boardId, item) {
  if (boardId === CLASSIC_ID) {
    const facts = [];
    if (isNum(item?.stars)) facts.push({ label: '总收藏人数', value: num(item.stars) });
    const pushed = formatTime(item?.pushedAt);
    if (pushed !== '') facts.push({ label: '最后更新时间', value: pushed });
    return facts;
  }
  const facts = [];
  if (isNum(item?.scores?.total)) facts.push({ label: '综合得分', value: `${num(item.scores.total)} 分` });
  if (isNum(item?.stars)) facts.push({ label: '总收藏人数', value: num(item.stars) });
  return facts;
}

/**
 * ISO 时间 → 中文日期（只到天）。读不出来返回空串：不猜、不显示"Invalid Date"。
 * @param {string} [iso]
 * @returns {string}
 */
export function formatTime(iso) {
  if (typeof iso !== 'string' || iso === '') return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()} 年 ${pad(date.getUTCMonth() + 1)} 月 ${pad(date.getUTCDate())} 日`;
}

// ---------- 卡片 ----------

/** 项目名：没有 name 时退回项目全名的后半段；两者都没有就说"这个项目"。 */
function projectName(item) {
  if (typeof item?.name === 'string' && item.name !== '') return item.name;
  const full = typeof item?.ownerRepo === 'string' ? item.ownerRepo : '';
  const tail = full.split('/').pop();
  return tail === undefined || tail === '' ? '这个项目' : tail;
}

/**
 * 卡片上的元信息：难度徽章 + 中文徽章 + 新增收藏（含近 3 日，有数据才显示）+ 事实。
 * 卡片上**不放三轴明细**（那是点开详情才看的东西），所以这里不调 boardScore。
 * @param {{ boardId: string, item: object }} input
 * @returns {string} HTML
 */
export function itemMeta({ boardId, item }) {
  const badges = [difficultyBadge(item?.grade), chineseBadge(item)].filter((html) => html !== '').join('');
  // 数据文件里的速度字段有两套写法：collector 既写扁平的顶层字段（starsGained7d / confidence /
  // velocitySource），也把原始 velocity 对象整个带下来。这里先把两套合成一份再判定 ——
  // 只看 item.velocity 会漏掉扁平字段，而漏掉的后果是把"我们没问到"渲染成"新增 0"（正是要防的谎话）。
  const velocity = {
    gained7d: item?.velocity?.gained7d ?? item?.starsGained7d,
    gained3d: item?.velocity?.gained3d ?? item?.starsGained3d,
    confidence: item?.velocity?.confidence ?? item?.confidence,
    // 源头优先信扁平字段：collector 用的是它，raw 对象里可能根本没有这个键。
    source: item?.velocitySource ?? item?.velocity?.source,
  };
  const growth = growthNotice(velocity);
  const growthHtml = growth.known
    ? `<span class="growth growth-${escapeAttr(growth.tone)}">${escapeHtml(growth.text)}</span>`
    : `<span class="growth growth-unknown">${GROWTH_UNKNOWN_TEXT}</span>`;
  // 近 3 日新增：日线数据确实覆盖了 3 天时才有这个值，没有就整条不显示（绝不当成"3 天涨 0"）。
  const threeDay = confidenceNotice(velocity);
  const threeDayHtml = threeDay === '' ? '' : `<span class="growth growth-3d">${escapeHtml(threeDay)}</span>`;
  const facts = factsForBoard(boardId, item)
    .map((fact) => `<span class="fact"><span class="fact-label">${escapeHtml(fact.label)}</span>${escapeHtml(fact.value)}</span>`)
    .join('');
  return `<div class="badges">${badges}</div><div class="meta-line">${growthHtml}${threeDayHtml}${facts}</div>`;
}

/**
 * 一条项目卡片的内部内容。外层的 `<article class="card">` 由 app.js 包上
 * （Task 17 的详情抽屉挂在它上面）。
 * @param {{ boardId: string, item: object }} input
 * @returns {string} HTML
 */
export function itemCard({ boardId, item }) {
  const rank = isNum(item?.rank) ? `<span class="rank">${item.rank}</span>` : '';
  const description = typeof item?.description === 'string' && item.description !== ''
    ? escapeHtml(item.description)
    : '这个项目没有写一句话介绍。';
  const reasons = asArray(item?.reasons).filter((r) => typeof r === 'string' && r !== '');
  const reasonHtml = reasons.length === 0
    ? ''
    : `<ul class="reasons">${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`;
  const full = typeof item?.ownerRepo === 'string' ? item.ownerRepo : '';
  const link = full === '' ? '' : `<a class="project-link" href="https://github.com/${escapeAttr(full)}" target="_blank" rel="noreferrer noopener">打开项目主页</a>`;

  return `${rank}<div class="card-body">`
    + `<h3 class="card-title">${escapeHtml(projectName(item))}</h3>`
    + `<p class="card-desc">${description}</p>`
    + itemMeta({ boardId, item })
    + boardScore(boardId, item)
    + reasonHtml
    // R105：这里**不能**承诺"点开就能看怎么装"。抽屉要到 Task 17 才有，现在点开只会看到
    // 一句"下个版本"的提示，所以卡片上只说当下成立的话。整节说明在 buildBoardView 的 hints 里。
    + `<div class="card-actions">${link}<span class="hint">详情入口（还在做）。</span></div>`
    + '</div>';
}

/**
 * 榜单列表上方那段说明（R102：文案选择属于显示决策，住在纯函数层）。
 *
 * R97 / R105：**不能**承诺"点开卡片就能看到详细介绍 / 三步安装说明"——那两样要 Task 17 才有，
 * 现在点开只会看到一句"下个版本"的提示。所以这里如实说"还在做"，并把新手准备页的链接给出来。
 * 返回的是**纯文本**（可以有链接这种行内标签），外层由调用方包成段落。
 * @returns {string} HTML 片段（纯文本 + 一个链接）
 */
export function cardDetailHint() {
  return '点开卡片目前只会看到一句提示：详细说明与三步安装说明还在做（下一个版本上线）。'
    + '想看项目本身，点卡片里的「打开项目主页」；如果你从没打开过命令行，'
    + '先看<a href="prepare.html">新手准备页</a>，从头照着做一遍就行。';
}

// ---------- 状态：该显示哪些条目、该给哪些提示（R93 / R102） ----------

/**
 * 这个榜收不收"按难度筛"（R25 / R96）。
 * 经典必玩榜按总收藏排序、不参与三轴评分，难度分级对它没有意义，所以它**忽略**这个筛选。
 * 注意是"忽略"，不是在界面上把开关禁用：禁用会制造"勾着却取消不掉"的死路，
 * 而且会让提示语与实现各说各话（曾经就是那样，见 R96）。
 * @param {string} boardId 榜单 id
 * @returns {boolean}
 */
export function boardAcceptsDifficultyFilter(boardId) {
  return boardId !== CLASSIC_ID;
}

/**
 * 榜单列表上方那句说明（R102：文案选择属于显示决策，住在纯函数层）。
 * 认不出的榜给空串（那时 buildBoardView 的 boardTitle 已经是"这个榜"，不必再解释）。
 * @param {string} boardId 榜单 id
 * @returns {string} 一句中文；认不出的榜返回空串
 */
export function boardNote(boardId) {
  return BOARD_NOTES.get(boardId) ?? '';
}

/**
 * 难度筛选在某个榜上不适用时，给用户的那句说明（R102：文案选择也是显示决策，住在纯函数层）。
 * 不适用时返回一句解释，适用时返回空串（界面就不用挂提示）。
 * @param {string} boardId 榜单 id
 * @returns {string}
 */
export function difficultyFilterHint(boardId) {
  if (boardAcceptsDifficultyFilter(boardId)) return '';
  return '经典榜按总收藏人数排序、不参与评分，所以「🟢 一键就能玩」这个筛选对它不生效——切回上面两个榜就生效了。';
}

/**
 * 这一期该显示哪些条目、该给哪些提示（R93 / R102）。所有与 DOM 无关的显示决策都在这里：
 * 通知列表、通过筛选的条目、统计文案、语言清单、卡片上下的提示语。
 *
 * 通知**每次调用都重新算一遍**（R94）：degraded 不是"进入页面时插一次"，
 * 所以切榜单 / 改筛选 / 换日期之后它照样在；换到数据完整的那一天它就消失。
 *
 * 通知之间**不重复、不互相矛盾**（R104），优先级：数据不完整 → 这一天读不出来 →
 * 这一期没有条目 → 被筛没了。也就是说 items 为空时只会出现其中一条。
 *
 * @param {{
 *   boardId?: string, boardTitle?: string, items?: object[],
 *   filters?: { easy?: boolean, chinese?: boolean, language?: string },
 *   daily?: object|null,   // 这一天的日报对象；null 表示没读到（尚未加载完也算）
 *   date?: string,         // 想看的日期（用来把"缺哪一天"说清楚）
 *   dates?: string[],      // 有数据的日期清单（长度决定"换一天"这句建议是否成立）
 *   loading?: boolean,     // 正在读数据（此时给"正在读取"，而不是"读不出来"）
 * }} input
 * @returns {{
 *   items: object[], notices: { key: string, html: string }[],
 *   totalCount: number, visibleCount: number, countText: string,
 *   boardTitle: string, languages: string[], unknownLanguageCount: number,
 *   languageSelectionValid: boolean, hints: { key: string, html: string }[],
 * }}
 */
export function buildBoardView(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const boardId = typeof source.boardId === 'string' ? source.boardId : '';
  const daily = source.daily && typeof source.daily === 'object' ? source.daily : null;
  const items = asArray(source.items);
  const dates = asArray(source.dates).filter((d) => typeof d === 'string' && d !== '');
  const date = typeof source.date === 'string' ? source.date : '';
  const filters = source.filters && typeof source.filters === 'object' ? source.filters : {};
  const title = typeof source.boardTitle === 'string' && source.boardTitle !== ''
    ? source.boardTitle
    : (BOARD_TITLES.get(boardId) ?? '这个榜');

  // 筛选：R96 经典榜忽略难度筛选；R64 中文筛选只认 hasChinese；语言筛选按相等比较。
  const wantEasy = filters.easy === true && boardAcceptsDifficultyFilter(boardId);
  const language = typeof filters.language === 'string' ? filters.language : '';
  const visible = items.filter((item) => {
    if (wantEasy && item?.grade !== 'green') return false;
    if (filters.chinese === true && item?.hasChinese !== true) return false;
    if (language === UNKNOWN_LANGUAGE) return !hasLanguage(item);
    if (language !== '') return item?.language === language;
    return true;
  });

  // 语言清单（R95）：来自这一榜当期的真实数据，稳定排序；认不出语言的单独计数。
  const languages = [...new Set(items
    .map((item) => item?.language)
    .filter((item) => hasLanguage({ language: item })))]
    .sort();
  const unknownLanguageCount = items.filter((item) => !hasLanguage(item)).length;
  // R103：选中的语言在当前这一期必须真的存在（"没有标注语言"那一项也一样）。
  // 这条判断从 DOM 层搬到这里，就是为了让"跨期切换后筛选状态与选项是否一致"可以被断言；
  // app.js 据此把无效的选择回退成"全部语言"，不再出现"空列表 + 空白下拉"。
  const languageSelectionValid = language === ''
    || (language === UNKNOWN_LANGUAGE ? unknownLanguageCount > 0 : languages.includes(language));

  const notices = [];
  // 顺序即重要性：数据不完整排最前（它影响整页读数），然后才是"这块为什么是空的"。
  if (daily?.degraded === true) {
    notices.push({ key: 'degraded', html: degradedNotice(true, daily.notes) });
  }
  if (daily === null) {
    // R104：这一天读不出来时只说这一句——绝不再叠一条"本期没有条目"（同一次事件、两条提示，
    // 用户会以为采集坏了），而且"换一天看看"这句建议只在真有多天可换时才给。
    if (source.loading === true) {
      notices.push({ key: 'loading', html: loadingNotice() });
    } else if (dates.length > 0) {
      notices.push({ key: 'date-missing', html: missingDateNotice(date, dates.length) });
    } else {
      notices.push({ key: 'no-data', html: noDataNotice() });
    }
  } else if (!Array.isArray(daily.boards)) {
    // R101：JSON 合法但形状不对（boards 不是数组）。以前这里会抛错，页面永远停在"正在读取…"。
    notices.push({ key: 'broken', html: dataErrorNotice() });
  } else if (items.length === 0) {
    notices.push({ key: 'empty', html: boardNotice({ boardTitle: title, itemCount: 0 }) });
  } else if (visible.length === 0) {
    // 有条目但被筛没了：与"这一期没有条目"分开说，否则用户会以为采集坏了。
    notices.push({ key: 'filtered-out', html: filteredOutNotice(title, items.length) });
  }

  // 卡片上下的说明语也在这里定（R102）：app.js 只管把它们贴到页面上，自己不写一个字。
  const hints = [
    { key: 'board-note', html: boardNote(boardId) },
    { key: 'card-detail', html: cardDetailHint() },
    { key: 'difficulty-filter', html: difficultyFilterHint(boardId) },
  ].filter((hint) => hint.html !== '');

  return {
    items: visible,
    notices,
    totalCount: items.length,
    visibleCount: visible.length,
    // R100：统计文案说的是**当前看得见的**条数，同时把总数写在括号里，两个数字都不会误导。
    countText: items.length === 0 ? '' : `当前显示 ${visible.length} 个项目（这一榜共 ${items.length} 个）`,
    boardTitle: title,
    languages,
    unknownLanguageCount,
    languageSelectionValid,
    hints,
  };
}

// ---------- 提示（第一等状态，spec §8） ----------

/**
 * 榜单为空时的提示（这一期确实没有条目）。
 * 与被筛选滤空的那句**分开**：原因不同，不能混成一句。
 * @param {{ boardTitle?: string, itemCount?: number }} [input]
 * @returns {string} HTML；有条目时是空串
 */
export function boardNotice(input = {}) {
  const count = input?.itemCount;
  if (isNum(count) && count > 0) return '';
  const title = typeof input?.boardTitle === 'string' && input.boardTitle !== '' ? input.boardTitle : '这个榜';
  return `<p class="empty">「${escapeHtml(title)}」暂时没有可以展示的项目。`
    + '可能是这一期还没采集到合适的项目，换一天或者换一个榜再看看。</p>';
}

/**
 * 有条目、但当前筛选条件把它们全滤掉了。
 * @param {string} boardTitle 榜单名
 * @param {number} total 这一期的条目数
 * @returns {string} HTML
 */
export function filteredOutNotice(boardTitle, total) {
  const title = typeof boardTitle === 'string' && boardTitle !== '' ? boardTitle : '这个榜';
  const count = isNum(total) ? ` ${total} ` : ' ';
  return `<p class="empty">「${escapeHtml(title)}」这一期有${count}个项目，`
    + '但你现在的筛选条件下一个都不剩了。把筛选放宽一点就能看到。</p>';
}

/**
 * 这一期数据不完整时的提示（degraded，spec §8）。notes 缺失或为空都要能正常工作。
 * @param {boolean} degraded 本轮是否有东西没拿到
 * @param {string[]} [notes] 降级原因（给维护者看的），有就一起显示
 * @returns {string} HTML；没有问题就是空串
 */
export function degradedNotice(degraded, notes) {
  if (degraded !== true) return '';
  const lines = asArray(notes)
    .filter((note) => typeof note === 'string' && note !== '')
    .map((note) => `<li>${escapeHtml(note)}</li>`)
    .join('');
  return '<div class="notice notice-degraded"><strong>本期数据不完整。</strong>'
    + '有些项目的信息这一期没采集到（通常是网络或额度问题），所以下面的内容可能不全，'
    + '看到空缺不代表这个项目不好。'
    + (lines === '' ? '' : `<ul class="notice-notes">${lines}</ul>`)
    + '</div>';
}

/**
 * 数据还在读的时候的占位提示（R104：它与"读不出来"是两件事，不能混）。
 * @returns {string} HTML
 */
export function loadingNotice() {
  return '<p class="loading">正在读取榜单数据……</p>';
}

/**
 * 完全没有榜单数据时的提示（index.json 缺失或为空：还没跑过采集）。
 * R99：只给**今天真能用**的命令。`npm run demo` 眼下就是 `serve --demo`，而 `serve` 还不认识
 * `--demo`（Task 18 才实现），写进提示等于指一条走不通的路——所以写的是这条已经跑得通的命令。
 * @returns {string} HTML
 */
export function noDataNotice() {
  return '<div class="notice notice-empty"><strong>还没有任何榜单数据。</strong>'
    + '这个网站读的是数据文件，需要先跑一次采集才会有内容。'
    + `第一次用、又不想联网的话，在项目目录里运行 ${COLLECT_COMMAND}（它用内置样本出一份完整数据），`
    + '然后刷新这个页面。</div>';
}

/**
 * 数据文件在、但形状不对（例如 `boards` 不是数组）时的提示（R101）。
 * 一句"读不出来"远比一个永远转圈的空白页诚实。
 * @returns {string} HTML
 */
export function dataErrorNotice() {
  return '<div class="notice notice-empty"><strong>这一期的数据文件读不出来。</strong>'
    + '文件在，但里面的内容和这个页面期待的形状不一样（可能是采集写到一半、或者文件被改坏了）。'
    + `重跑一次采集就会覆盖掉它：在项目目录里运行 ${COLLECT_COMMAND}。也可以用页面底部的日期选择器换一天看看。</div>`;
}

/**
 * 某一天的数据文件没读到时的提示（文件缺了、或者地址写错了）。
 * R104：建议必须与当下能力一致——日期选择器只在**有两天以上**数据时才出现，
 * 所以只有一天数据时不能说"换一天看看"（那是个做不到的建议）。
 * @param {string} [date] 想看的那一天
 * @param {number} [dateCount] 一共有几天可看（≥2 才建议换一天）
 * @returns {string} HTML
 */
export function missingDateNotice(date, dateCount) {
  const day = typeof date === 'string' && date !== '' ? date : '这一天';
  const more = isNum(dateCount) && dateCount >= 2
    ? '你可以在页面底部换一天再看，或者稍后刷新重试。'
    : `在项目目录里运行 ${COLLECT_COMMAND} 就会有一份数据。`;
  return `<div class="notice notice-empty"><strong>没有读到 ${escapeHtml(day)} 的榜单数据。</strong>${more}</div>`;
}

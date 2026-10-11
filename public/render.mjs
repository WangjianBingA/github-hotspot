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

// ---------- 详情抽屉的文案（Task 17；每一句都是"显示决策"，所以住在这一层） ----------

/** 抽屉里各节的标题。 */
const DRAWER_TITLES = {
  guide: '怎么装（三步）',
  why: '为什么上榜',
  facts: '项目基本事实',
  classic: '它凭什么在这个榜里',
  faq: '常见问题',
};

/**
 * 一条 install 数据里**真的会被渲染出来**的步骤与常见问题（R78 的判据本体）。
 * 两处都用它，所以"卡片承诺了什么"与"抽屉渲染了什么"不可能再分家（R111 / R118）：
 * 这里只把对象留下，`{ steps: [null] }` 这种坏形状不算"有向导"。
 * @param {object} [install] 条目里的 install 字段
 * @returns {{ steps: object[], faq: object[] }}
 */
function guideParts(install) {
  const guide = install && typeof install === 'object' ? install : {};
  return {
    steps: asArray(guide.steps).filter((step) => step && typeof step === 'object'),
    faq: asArray(guide.faq).filter((entry) => entry && typeof entry === 'object'),
  };
}

/**
 * 这一条到底会不会渲染出安装向导（与 installGuideHtml 的第一道判断完全同源）。
 * @param {object} [install] 条目里的 install 字段
 * @returns {boolean}
 */
function hasInstallGuide(install) {
  const { steps, faq } = guideParts(install);
  return steps.length > 0 || faq.length > 0;
}

/**
 * 这一条到底会不会渲染出「项目基本事实」那一节（与 detailDrawer 里那道判断同源）。
 * @param {object} item 条目
 * @returns {boolean}
 */
function hasFactList(item) {
  return factList(item).length > 0;
}

/**
 * 这一条到底会不会渲染出"为什么上榜"那一节（与 whySection 的最后一道判断同源）。
 * @param {string} boardId 榜单 id
 * @param {object} item 条目
 * @returns {boolean}
 */
function hasWhySection(boardId, item) {
  // 经典榜那一节叫「它凭什么在这个榜里」，而它不是按分数排的，所以**永远**会渲染（R25）。
  if (boardId === CLASSIC_ID) return true;
  const hasReasons = asArray(item?.reasons).some((reason) => typeof reason === 'string' && reason !== '');
  const scores = item?.scores;
  const hasScore = scores !== undefined && scores !== null
    && (isNum(scores.total) || AXES.some((axis) => isNum(scores[axis.key])));
  return hasScore || hasReasons;
}

/**
 * 卡片上那句"这里可以点开"的入口说明。
 *
 * R105 / R111 / R118：这句话**必须与抽屉里真有的东西一致**。它曾经是一句固定文案，
 * 无条件承诺「怎么装、为什么上榜、项目基本事实」，可是经典榜的抽屉里根本没有"为什么上榜"
 * （它不参与三轴评分，R25）、没有向导的项目渲染的是"去项目主页看"那句指路、数据稀疏的条目
 * 连事实表都是空的。所以这里逐节问上面那几个函数，只说抽屉真的会渲染的小节。
 * @param {string} boardId 榜单 id
 * @param {object} item 条目
 * @returns {string}
 */
const cardDetailEntry = (boardId, item) => {
  const parts = [];
  if (boardId === CLASSIC_ID) {
    if (hasWhySection(boardId, item)) parts.push(DRAWER_TITLES.classic);
  } else {
    if (hasInstallGuide(item?.install)) parts.push('怎么装');
    if (hasWhySection(boardId, item)) parts.push(DRAWER_TITLES.why);
  }
  if (hasFactList(item)) parts.push(DRAWER_TITLES.facts);
  // 一节都承诺不了（数据太稀疏）时，不硬编一个清单，只说"点开看看"。
  return parts.length === 0 ? '点开看这一条的详情' : `点开看详情（${parts.join('、')}）`;
};

/**
 * 列表上方那句说明。
 *
 * R111 / R118 / R120 / **R123**：榜级那句话**不枚举具体小节**。理由：榜是"一批条目"，只要榜里
 * 有任何一条缺某个小节，"这一榜会给你 X"就等于替那条打包票——实测已经撞到两次（稀疏条目的
 * 「为什么上榜/一句话介绍」、混合榜的「项目基本事实」）。改成不承诺具体内容的通用说法以后，
 * 这一类缺陷不会再出现。**逐卡**那句仍然按 `hasWhySection` / `hasFactList` 逐条判断（本来就准确）。
 * @returns {string} HTML 片段（纯文本 + 一个链接）
 */
const cardDetailHintText = () => '点开任意一张卡片，都能看到这一条的详情：它是干什么的、'
  + '我们为什么把它放进这个榜、以及它到底装不装得上。'
  + '看不懂的地方，先看<a href="prepare.html">新手准备页</a>，从头照着做一遍。';

/** 命令框下面那句提示（真实缺陷：以前没说"失败了怎么办"，用户会以为按钮坏了）。 */
const COPY_HINT = '按钮会把这一行复制到剪贴板；要是没反应，就自己选中这一行，按 Ctrl 加 C。';

/** 复制成功/失败后给用户的一句话（由 app.js 贴到 aria-live 的那一格上）。 */
export const COPY_DONE_TEXT = '已经复制好了，去命令行窗口里粘贴吧（右键粘贴，或者按 Ctrl 加 V）。';
export const COPY_FAIL_TEXT = '没能自动复制。请自己选中那一行命令，按 Ctrl 加 C 复制。';

/**
 * 没有预生成向导时的指路话（不假装有步骤）。
 * R112：这句话让读者用下方的「打开项目主页」，所以**只有在那个链接真的会渲染时**才这么指；
 * `ownerRepo` 缺失时链接是空的（项目名都拼不出来），那时改成"在项目自己的页面上找"。
 * @param {boolean} hasHomeLink 下方是否真的会给「打开项目主页」
 * @returns {string}
 */
const noGuideText = (hasHomeLink) => (hasHomeLink
  ? '这个项目没有现成的安装步骤，我们只能让你去它自己的主页看：'
    + '打开下面的「打开项目主页」，里面一般有「安装 / Installation」那一段。看不懂就把那一段整段复制给 AI 助手，让它讲成大白话。'
  : '这个项目没有现成的安装步骤；我们连它的主页地址都没拿到，所以只能让你自己去搜索它的名字，'
    + '在它的官方页面上找「安装 / Installation」那一段。看不懂就把那一段整段复制给 AI 助手，让它讲成大白话。');

/** 经典榜不参与三轴评分（R25），所以它这一节说的是"它凭什么在这个榜里"。 */
const CLASSIC_NOTE = '这个榜按总收藏人数排，不参与热度、口碑、新手友好这三项的评分——'
  + '所以这里没有分数，只看它是多少人的老朋友、最近还动不动。';

/** 抽屉底部那句"这条详情是从哪来的"（与页面页脚同一口径，缺少的数据整行不写）。 */
const DRAWER_FOOT_NOTE = '上面的数字：带「实测」的是我们前后两次记录相减量出来的，'
  + '带「GitHub 官方数据」的是官方页面自己写的，带「约」和「估算」的是我们推算的。';

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

// ---------- 外部链接（R115：只放行 http/https） ----------

/** 允许出现在页面链接里的协议（数据文件是外部输入，不能拿它当"一定是网址"来信任）。 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 把 JSON 里的一个地址变成**可以安全放进 href** 的地址（R115）。
 *
 * 数据文件是外部输入：如果里面写的是 `javascript:…`，直接转义后塞进 `href` 会生成一个"能点的活链接"。
 * 项目主页那个链接有固定的 github.com 前缀锚定，所以它安全；下载地址是原样的 URL，必须自己校验。
 * 判据是解析出来的协议白名单，不是"字符串里有没有 javascript"这种能被绕过的写法。
 * （这段注释里刻意不写完整的网址，免得把带反引号的 URL 混进注释——见 test/page-content.test.mjs
 * 里"去注释助手"那段说明：注释里的反引号同样会影响那台扫描器。）
 * @param {*} value 原始地址
 * @returns {string} 能用的地址；协议不在白名单里（或根本不是合法 URL）时返回空串
 */
export function safeHref(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    // 相对地址、拼错的地址一律不放行：这里的地址来自采集结果，一定是绝对地址。
    return '';
  }
  return SAFE_PROTOCOLS.has(url.protocol) ? value.trim() : '';
}

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
 * 一条条目的增长速度事实（卡片与详情共用）。
 * 数据文件里的速度字段有两套写法：collector 既写扁平的顶层字段（得分速度三项），也把原始对象整个带下来。
 * 这里先把两套合成一份再判定 —— 只看嵌套对象会漏掉扁平字段，而漏掉的后果是把"我们没问到"渲染成"新增 0"
 * （正是要防的谎话）。源头优先信扁平字段：collector 用的是它，raw 对象里可能根本没有那个键。
 * @param {object} item 条目
 * @returns {{ gained7d: number|undefined, gained3d: number|undefined, confidence: string|undefined, source: string|undefined }}
 */
function itemVelocity(item) {
  return {
    gained7d: item?.velocity?.gained7d ?? item?.starsGained7d,
    gained3d: item?.velocity?.gained3d ?? item?.starsGained3d,
    confidence: item?.velocity?.confidence ?? item?.confidence,
    source: item?.velocitySource ?? item?.velocity?.source,
  };
}

/**
 * 卡片上的元信息：难度徽章 + 中文徽章 + 新增收藏（含近 3 日，有数据才显示）+ 事实。
 * 卡片上**不放三轴明细**（那是点开详情才看的东西），所以这里不调 boardScore。
 * @param {{ boardId: string, item: object }} input
 * @returns {string} HTML
 */
export function itemMeta({ boardId, item }) {
  const badges = [difficultyBadge(item?.grade), chineseBadge(item)].filter((html) => html !== '').join('');
  const velocity = itemVelocity(item);
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
    // Task 17 起抽屉真的存在了：这里如实说"点开有详情"，不再写"还在做"（写了就是对用户说谎）。
    // R111 / R118：承诺的小节要与这一条**实际**会给的东西一致——经典榜没有"为什么上榜"、
    // 没有向导的那种坏形状（例如 steps 里全是 null）不算有向导、事实表为空也不许承诺它。
    + `<div class="card-actions">${link}<span class="hint">${escapeHtml(cardDetailEntry(boardId, item))}</span></div>`
    + '</div>';
}

// ---------- 详情抽屉（Task 17；R25 / R64 / R78 / 置信度 / 转义都在这里定） ----------

/**
 * 第 2 步那条命令的"可复制"那一行：一个只读的方块 + 一个复制按钮。
 * `data-copy-source` 指向放命令文本的元素，`data-copy-target` 指向贴结果的那一格——
 * app.js 靠这两个属性取文本、贴回执，它自己**不认识**任何字段名（R102）。
 * @param {string} command 命令原文（外部输入，进属性前转义）
 * @param {string} copyId 这一格回执的 id
 * @returns {string} HTML
 */
function commandBlock(command, copyId) {
  return `<div class="install-command" data-copy-command><code class="install-command-text">${escapeHtml(command)}</code>`
    + `<button type="button" class="copy-button" data-copy-source=".install-command-text" data-copy-target="#${escapeAttr(copyId)}">复制这一行</button></div>`
    + `<p class="copy-hint" id="${escapeAttr(copyId)}" role="status" aria-live="polite">${escapeHtml(COPY_HINT)}</p>`;
}

/**
 * 这一步的正文。
 * 第 2 步的正文里**带着命令本身**（collector 就这么写的，纯文本消费者只读正文也不会丢东西），
 * 所以渲染时把那一行换成"可复制的方块"（而不是让同一行命令既出现在正文段落里、又出现在方块里）——
 * 同一行命令在界面上出现两遍，用户会以为是两条不同的命令。
 * @param {string} body 正文
 * @param {string} command 命令（空串表示这一步没有命令）
 * @param {string} copyId 复制回执的 id
 * @param {boolean} withCommand 正文里没写命令时，要不要在这一步补一个方块（只在该给命令的那一步为真）
 * @returns {string} HTML
 */
function stepBody(body, command, copyId, withCommand) {
  const lines = String(body ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  let blockDone = false;
  const parts = lines.map((line) => {
    if (command !== '' && line === command && !blockDone) {
      blockDone = true;
      return commandBlock(command, copyId);
    }
    return `<p class="step-line">${escapeHtml(line)}</p>`;
  });
  // 正文里没有那行命令（形状变了）时，只在"该给命令的那一步"补一个复制方块，而且**只补一次**：
  // 以前这里不看 step，于是每一段提到命令的正文（例如第 3 步"装好后敲 npx …"）后面都会再挂一个
  // 同样的方块——同一行命令在抽屉里出现三遍，用户会以为是三条不同的命令。
  if (command !== '' && !blockDone && withCommand === true) parts.push(commandBlock(command, copyId));
  return parts.join('');
}

/**
 * 三步安装向导 + 常见问题，**全部照搬 JSON 里预生成好的 `install.steps` / `install.faq`**（R78）。
 * 渲染层一个字都不重新生成：向导的生成逻辑在采集端（src/enrich/runnability.mjs），
 * 在这里再写一份就等于有了第二个真相源，两处早晚会不一致。
 * @param {{ steps?: object[], faq?: object[], command?: string, downloadUrl?: string }} [guide]
 * @returns {string} HTML；没有向导时是空串
 */
export function installGuideHtml(guide) {
  // 判据走 hasInstallGuide 用的那个 guideParts（R118）：坏形状（例如 `{steps:[null]}`）不算有向导，
  // 否则卡片会承诺"怎么装"而抽屉里只有一句指路话。
  const { steps, faq } = guideParts(guide);
  // 命令：优先认 collector 明确标出来的那一条，没有就从第 2 步正文里找（形状变了也不至于不给命令）。
  let command = typeof guide?.command === 'string' ? guide.command.trim() : '';
  if (command === '') {
    const searched = steps.map((step) => (typeof step.body === 'string' ? step.body : ''))
      .flatMap((body) => body.split('\n'))
      .map((line) => line.trim())
      .find((line) => /^(?:npx|npm|pip|docker|git|yarn|pnpm|curl|python|python3|go|brew|cargo)\s+\S/.test(line));
    command = searched ?? '';
  }
  const downloadUrl = typeof guide?.downloadUrl === 'string' && guide.downloadUrl !== '' ? guide.downloadUrl : '';

  // 步骤与常见问题都没有时，不编步骤、也不留一个空壳标题，改为指路。
  if (steps.length === 0 && faq.length === 0) return '';

  const stepHtml = steps.map((step, index) => {
    const title = typeof step.title === 'string' && step.title !== '' ? escapeHtml(step.title) : `第 ${index + 1} 步`;
    // 正文里带着命令的那一步才给复制方块；命令放哪由 stepBody 定，不在这里重复贴。
    // withCommand：万一某个来源的正文里没写命令（形状变了），也只在**承载命令的那一步**补一个方块
    // （标题里写着"复制"的那一步，或者第二步），不会在每一步后面都挂一个。
    const copyId = `copy-status-${index + 1}`;
    const withCommand = command !== '' && (String(step.title ?? '').includes('复制') || index === 1);
    const bodyHtml = typeof step.body === 'string' && step.body !== ''
      ? stepBody(step.body, command, copyId, withCommand)
      : (withCommand ? commandBlock(command, copyId) : '');
    // 下载按钮只在这一步真的有下载地址时给；没有就不给（给一个死链接比不给更糟）。
    // R115：地址来自 JSON（外部输入），进 href 前要过协议白名单——`javascript:` 那种绝不能变成活链接。
    const safeDownload = safeHref(step.downloadUrl);
    const downloadHtml = safeDownload === ''
      ? ''
      : `<a class="download-button" data-download href="${escapeAttr(safeDownload)}" target="_blank" rel="noreferrer noopener">下载安装包</a>`;
    return `<li class="install-step"><h4 class="step-title">${title}</h4>${bodyHtml}${downloadHtml}</li>`;
  }).join('');

  // 没有命令、但有下载地址时（Windows 安装包那种），在第 2 步的下载按钮之外再给一次明显入口。
  const safeTopDownload = safeHref(downloadUrl);
  const topDownload = steps.some((step) => safeHref(step.downloadUrl) !== '')
    ? ''
    : (safeTopDownload === '' ? '' : `<p class="step-line"><a class="download-button" data-download href="${escapeAttr(safeTopDownload)}" target="_blank" rel="noreferrer noopener">下载安装包</a></p>`);

  const faqHtml = faq.length === 0 ? '' : `<details class="faq"><summary>${escapeHtml(DRAWER_TITLES.faq)}（${faq.length} 条）</summary>`
    + `<dl class="faq-list">${faq.map((entry) => {
      const question = typeof entry.q === 'string' ? entry.q : '';
      const answer = typeof entry.a === 'string' ? entry.a : '';
      return `<dt>${escapeHtml(question)}</dt><dd>${escapeHtml(answer)}</dd>`;
    }).join('')}</dl></details>`;

  return `<section class="drawer-section" data-section="guide"><h3 class="section-title">${escapeHtml(DRAWER_TITLES.guide)}</h3>`
    + `<ol class="install-steps">${stepHtml}</ol>${topDownload}${faqHtml}</section>`;
}

/**
 * "为什么上榜"这一节。R25：经典必玩榜不参与三轴评分，所以**那个榜不渲染分数条**，
 * 改成说清它真正依据的两件事（总收藏人数 + 最后更新时间）。
 * @param {string} boardId 榜单 id
 * @param {object} item 条目
 * @returns {string} HTML
 */
export function whySection(boardId, item) {
  const reasons = asArray(item?.reasons).filter((reason) => typeof reason === 'string' && reason !== '');
  const reasonHtml = reasons.length === 0
    ? ''
    : `<ul class="reasons drawer-reasons">${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`;

  if (boardId === CLASSIC_ID) {
    // 不画分数条、不写"为什么上榜"：那个榜不是按三轴分数排上来的（R25）。
    const facts = factsForBoard(boardId, item)
      .map((fact) => `<span class="fact"><span class="fact-label">${escapeHtml(fact.label)}</span>${escapeHtml(fact.value)}</span>`)
      .join('');
    return `<section class="drawer-section" data-section="classic"><h3 class="section-title">${escapeHtml(DRAWER_TITLES.classic)}</h3>`
      + `<p class="section-note">${escapeHtml(CLASSIC_NOTE)}</p><div class="meta-line">${facts}</div>${reasonHtml}</section>`;
  }

  const bars = scoreBars(boardId, item);
  const summary = boardScore(boardId, item);
  if (bars === '' && summary === '' && reasonHtml === '') return '';
  return `<section class="drawer-section" data-section="why"><h3 class="section-title">${escapeHtml(DRAWER_TITLES.why)}</h3>`
    + `${summary}${bars}${reasonHtml}</section>`;
}

/**
 * 详情抽屉的完整内容（标题 / 三步向导 / 为什么上榜 / 基本事实 / 走不走得通 / 打开主页）。
 *
 * 三条硬规矩落在这里：
 *   · R78：向导来自 JSON 里预生成的 `install.steps` / `install.faq`，本层只渲染、不生成；
 *   · R25：经典榜不画三轴分数条、不说"为什么上榜"，改说总收藏与最后更新；
 *   · 置信度与"没问到"的口径与卡片一致（`growthNotice` / `confidenceNotice`），绝不把不知道写成 0。
 * 返回的是**抽屉内容**（不是整个抽屉壳）：外层 `<section id="drawer">` 与关闭按钮在 index.html 里，
 * 所以 app.js 只需把这段内容贴进 `#drawer-body`。
 * @param {{ boardId?: string, item?: object }} [input]
 * @returns {string} HTML；形参缺失时也返回一段可用的内容（绝不为空串）
 */
export function detailDrawer(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const boardId = typeof source.boardId === 'string' ? source.boardId : '';
  const item = source.item && typeof source.item === 'object' ? source.item : {};
  const install = item.install && typeof item.install === 'object' ? item.install : {};
  const full = typeof item.ownerRepo === 'string' ? item.ownerRepo : '';
  const name = projectName(item);

  // 中文徽章照卡片口径（R64），再加难度徽章：抽屉里看到的两个徽章与卡片上一模一样。
  const badges = [difficultyBadge(item.grade), chineseBadge(item)].filter((html) => html !== '').join('');
  const description = typeof item.description === 'string' && item.description !== ''
    ? escapeHtml(item.description)
    : '';

  // R112：没有向导时那句指路话要看**链接到底有没有**——`ownerRepo` 缺失时下方不会有「打开项目主页」，
  // 这时还让人"打开下面的链接"就是在指一个不存在的东西。
  const hasHomeLink = full !== '';
  const guideHtml = installGuideHtml(install);
  const guideSection = guideHtml === ''
    ? `<section class="drawer-section" data-section="guide"><p class="section-note">${escapeHtml(noGuideText(hasHomeLink))}</p></section>`
    : guideHtml;

  // 事实表（语言、总收藏、拿去改造、最后更新、许可证、维护状态）：拿不到的整条不列。
  const facts = factList(item);
  const factHtml = facts.length === 0
    ? ''
    : `<section class="drawer-section" data-section="facts"><h3 class="section-title">${escapeHtml(DRAWER_TITLES.facts)}</h3>`
      + `<dl class="fact-list">${facts.map((fact) => `<dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd>`).join('')}</dl></section>`;

  // 增长速度：与卡片同一套判定（source 为 'none' 时 growthNotice 整行省略，只留"没查到"那句）。
  const velocity = itemVelocity(item);
  const growth = growthNotice(velocity);
  const threeDay = confidenceNotice(velocity);
  const velocityHtml = `<p class="drawer-growth">`
    + (growth.known ? escapeHtml(growth.text) : GROWTH_UNKNOWN_TEXT)
    + (threeDay === '' ? '' : ` · ${escapeHtml(threeDay)}`)
    + '</p>';

  // 取证来源的中文说法（绝不回显英文原始值）；同时把"我们是怎么确认的"一并说清。
  const evidence = evidenceNotice(install.evidence);
  const evidenceHtml = evidence === '' ? '' : `<p class="drawer-evidence">${escapeHtml(evidence)}</p>`;

  const homeLink = full === ''
    ? ''
    : `<a class="project-link" href="https://github.com/${escapeAttr(full)}" target="_blank" rel="noreferrer noopener">打开项目主页</a>`;
  const prepareLink = '<a class="prepare-link" href="prepare.html">打开新手准备页</a>';

  return `<h3 class="drawer-title">${escapeHtml(name)}</h3>`
    + `<p class="drawer-path">${escapeHtml(full)}</p>`
    + (badges === '' ? '' : `<div class="badges">${badges}</div>`)
    + (description === '' ? '' : `<p class="drawer-desc">${description}</p>`)
    + guideSection
    + whySection(boardId, item)
    + factHtml
    + velocityHtml
    + evidenceHtml
    + `<div class="drawer-actions">${homeLink}${prepareLink}</div>`
    + `<p class="drawer-foot">${escapeHtml(DRAWER_FOOT_NOTE)}</p>`;
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
 * 某一期里，语言清单与"没标注语言"的条数（R95 的事实本体，R108 让它能被提前单独调用）。
 * 语言清单来自这一期真实的条目、稳定排序；认不出语言的单独计数，好让它们也能被筛出来。
 * @param {object[]} [items] 这一榜的条目
 * @returns {{ languages: string[], unknownLanguageCount: number }}
 */
export function languageFacts(items) {
  const list = asArray(items);
  const languages = [...new Set(list
    .map((item) => item?.language)
    .filter((language) => hasLanguage({ language })))]
    .sort();
  const unknownLanguageCount = list.filter((item) => !hasLanguage(item)).length;
  return { languages, unknownLanguageCount };
}

/**
 * 某一期里，当前选中的语言筛选还成不成立（R103 的判断本体）。
 *
 * R108：这个判断必须能被**单独调用**。以前 app.js 是在算完视图、画完列表之后才从视图里读到
 * "选择失效"，于是那一次渲染画出来的是"已经重置的控件 + 空列表"，要等用户再点一下才恢复。
 * 现在它自己就是一个纯函数：app.js 可以先问它、把无效的选择回退掉，**然后再**算视图。
 * @param {string} value 选中的语言（UNKNOWN_LANGUAGE 表示"没有标注语言"那一项）
 * @param {{ languages?: string[], unknownLanguageCount?: number }} [facts] languageFacts 的结果
 * @returns {boolean} true 表示这个选择在这一期成立
 */
export function languageSelectionIsValid(value, facts = {}) {
  if (typeof value !== 'string' || value === '') return true;
  if (value === UNKNOWN_LANGUAGE) return isNum(facts.unknownLanguageCount) && facts.unknownLanguageCount > 0;
  return asArray(facts.languages).includes(value);
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

  // 语言清单（R95）：来自这一榜当期的真实数据，稳定排序；认不出语言的单独计数。
  // R108：清单与"选择是否成立"都在**过滤条目之前**算出来，这样 app.js 能先回退无效选择再算视图，
  // 不会出现"控件已重置、列表却是空的"那一次过期渲染。这段事实的算法住在 languageFacts 里，
  // app.js 提前问的也是它 —— 两边不会各说各话。
  const facts = languageFacts(items);
  const { languages } = facts;
  const unknownLanguageCount = facts.unknownLanguageCount;
  // R103：选中的语言在当前这一期必须真的存在（"没有标注语言"那一项也一样）。
  // 这条判断从 DOM 层搬到这里，就是为了让"跨期切换后筛选状态与选项是否一致"可以被断言；
  // app.js 据此把无效的选择回退成"全部语言"，不再出现"空列表 + 空白下拉"。
  const languageSelectionValid = languageSelectionIsValid(language, facts);

  const visible = items.filter((item) => {
    if (wantEasy && item?.grade !== 'green') return false;
    if (filters.chinese === true && item?.hasChinese !== true) return false;
    if (language === UNKNOWN_LANGUAGE) return !hasLanguage(item);
    if (language !== '') return item?.language === language;
    return true;
  });

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
    // R107：把"有几天可换"传进去，提示才不会建议一件用户做不到的事。
    notices.push({ key: 'broken', html: dataErrorNotice(dates.length) });
  } else if (items.length === 0) {
    notices.push({ key: 'empty', html: boardNotice({ boardTitle: title, itemCount: 0 }) });
  } else if (visible.length === 0) {
    // 有条目但被筛没了：与"这一期没有条目"分开说，否则用户会以为采集坏了。
    notices.push({ key: 'filtered-out', html: filteredOutNotice(title, items.length) });
  }

  // 卡片上下的说明语也在这里定（R102）：app.js 只管把它们贴到页面上，自己不写一个字。
  // R123：榜级那句**不按内容分口径**（它不枚举小节，也就不可能替某一条打包票）——逐卡那句才按条判断。
  const hints = [
    { key: 'board-note', html: boardNote(boardId) },
    { key: 'card-detail', html: cardDetailHintText() },
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
 * R107：建议必须与用户**当下真能做的事**一致——日期选择器只在有两天以上数据时才出现，
 * 所以只有一份数据时不能说"用页面底部的日期选择器换一天看看"（那是个做不到的建议，
 * 与 R104 对 `missingDateNotice` 的要求同一条道理）。
 * @param {number} [dateCount] 一共有几天可看（≥2 才提日期选择器）
 * @returns {string} HTML
 */
export function dataErrorNotice(dateCount) {
  // R114：**没拿到天数时不许替数据断言**「现在只有这一份数据」——那是在说一件我们并不知道的事。
  // 只有明确知道"就这一天"时才说没有别的日期可换；其余情况（≥2 天，或压根不知道）给中性的说法。
  const known = isNum(dateCount);
  const more = known && dateCount >= 2
    ? '你也可以用页面底部的日期选择器换一天看看（那一天的文件可能没坏）。'
    : (known
      ? '现在只有这一份数据，所以没有别的日期可换。'
      : '如果还有别的日期可看，可以用页面底部的日期选择器换一天试试。');
  return '<div class="notice notice-empty"><strong>这一期的数据文件读不出来。</strong>'
    + '文件在，但里面的内容和这个页面期待的形状不一样（可能是采集写到一半、或者文件被改坏了）。'
    + `重跑一次采集就会覆盖掉它：在项目目录里运行 ${COLLECT_COMMAND}。${more}</div>`;
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

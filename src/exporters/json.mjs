// GitHub 好玩榜 —— 日报 JSON 导出（spec §5.4 的数据模型）。
//
// 这个模块产出的对象**就是网站会 fetch 的那份 JSON**：public/data/YYYY-MM-DD.json 与
// daily/YYYY-MM-DD.json 都由它序列化而来，两者永远一致（同一次调用的结果）。所以：
//   · 纯函数：不读文件、不发网络请求、不看时钟（generatedAt 由调用方给），同样的输入永远同样的输出；
//   · 顶层形状固定为 { date, generatedAt, degraded, notes, boards }；
//   · 每条 item 都把界面要用的字段**摊平**放在顶层（rank / ownerRepo / stars / scores / install …），
//     同时保留 repo / runnability / velocity 三个原始对象——顶层是界面契约，嵌套是溯源证据。
//
// 两条来自上游模块的硬约束：
//   · R78：install 里必须带着**已经生成好的** { steps, faq }。网站是纯静态 + 原生 JS，
//     不许再实现一遍向导生成逻辑；生成一次、嵌进 JSON、前端只负责渲染。
//   · R41：hasRelease90d 与 growing 也照实带出去（三态：true / false / null）。
//     null 表示"我们没问到"，与 false（确认没有）是两件不同的事，前端据此显示不同文案。

import { buildInstallGuide } from '../enrich/runnability.mjs';

/** 数值保留一位小数，避免 38.20000000000001 这类浮点噪声进 JSON。 */
const round1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

/** 只保留有限的数字；拿不到就给 null（JSON 里绝不出现 undefined）。 */
const num = (value) => (Number.isFinite(value) ? value : null);

/**
 * 把一条 RankedItem（src/boards/build.mjs 的产物）展开成 JSON 里的 item。
 * @param {{ rank: number, repo: object, runnability: object, velocity: object, score: object,
 *   grade: string, reasons: string[] }} ranked
 * @returns {object} 摊平后的 item（含 install.steps / install.faq）
 */
function toItem(ranked) {
  const { repo = {}, runnability = {}, velocity = {}, score = {} } = ranked;
  const parts = score.parts ?? {};
  const guide = buildInstallGuide(runnability);
  const install = {
    kind: runnability.kind ?? null,
    command: runnability.command ?? null,
    downloadUrl: runnability.downloadUrl ?? null,
    evidence: runnability.evidence ?? null,
    verified: runnability.verified === true,
    difficulty: runnability.difficulty ?? null,
    // R48：这里只有**要求原文**，没有、也永远不会有"兼容性结论"——
    // 静态网站看不到访客电脑上装的是哪个版本，编一个 compatible: true 就是假话。
    requiresPython: runnability.requiresPython ?? null,
    // R143 + R153：中文只有**一个**结论字段 `hasChinese`（真有中文文档）。
    // 计分、徽章、文案读的都是它；历史名 `chineseDoc` 已删除（同一事实两个名字 = 两份真相源）。
    hasChinese: runnability.hasChinese === true,
    notes: Array.isArray(runnability.notes) ? runnability.notes : [],
    steps: guide.steps,
    faq: guide.faq,
  };

  return {
    rank: ranked.rank ?? null,
    ownerRepo: typeof repo.ownerRepo === 'string' ? repo.ownerRepo : '',
    name: repo.name ?? (typeof repo.ownerRepo === 'string' ? repo.ownerRepo.split('/').pop() : null),
    description: repo.description ?? null,
    language: repo.language ?? null,
    license: typeof repo.license === 'string' ? repo.license : repo.license?.spdx_id ?? null,
    stars: num(repo.stars),
    forks: num(repo.forks),
    starsGained7d: num(velocity.gained7d),
    starsGained3d: num(velocity.gained3d),
    confidence: velocity.confidence ?? null,
    velocityLevel: Number.isInteger(velocity.level) ? velocity.level : null,
    velocitySource: velocity.source ?? null,
    scores: {
      hot: round1(score.hot),
      reputation: round1(score.reputation),
      runnable: round1(score.runnable),
      total: round1(score.total),
      // 口碑与新手友好的子项明细：详情页把公式摊开时要逐项显示（spec §4.4）。
      ...Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, round1(value)])),
    },
    grade: ranked.grade ?? null,
    // R153：顶层这一个是界面的契约字段（卡片徽章、筛选、日报都读它）。历史名 chineseDoc 已删除。
    hasChinese: runnability.hasChinese === true,
    // R144：本地化文件名清单**只在这一处（顶层）出现**，是它唯一的事实来源。
    // 以前它同时写在 install 里，而界面读的是顶层那一份 → 徽章「有本地化文档（非中文）」
    // 在生产上永远渲染不出来（测试之所以绿，是因为用例喂的是手写形状）。
    localizedFiles: Array.isArray(runnability.localizedFiles) ? runnability.localizedFiles : [],
    install,
    reasons: Array.isArray(ranked.reasons) ? ranked.reasons : [],
    pushedAt: repo.pushedAt ?? null,
    archived: repo.archived === true,
    // R41 的两个三态事实照实带出去。**它们目前没有任何界面消费者**（R150/M2 核实过：
    // public/ 全量 grep 为 0），带出去是为了让"我们问到了什么"可追溯、以及让数据层与
    // 后续的分析/脚本能直接读——不是给页面显示用的，别照着一句旧注释去找界面上的用法。
    hasRelease90d: repo.hasRelease90d === true || repo.hasRelease90d === false ? repo.hasRelease90d : null,
    growing: ranked.extra?.growing === true || ranked.extra?.growing === false ? ranked.extra.growing : null,
    // 溯源证据：顶层字段是界面契约，这三个对象是"这个结论是怎么来的"。
    repo,
    runnability,
    velocity,
  };
}

/**
 * 组装日报对象（网站读的那份 JSON 的内容）。
 * @param {{ id: string, title: string, items: object[] }[]} boards 三个榜单
 * @param {string} date UTC 日期（YYYY-MM-DD）
 * @param {{ generatedAt?: string, degraded?: boolean, notes?: string[], demo?: boolean }} [options]
 *   degraded 表示"这一轮有东西没拿到"（R33/R35/R41），界面据此提示"本期数据不完整"；
 *   notes 是给维护者看的降级原因清单，也落进 JSON，便于事后追查是哪一路出了问题；
 *   demo（R128）：这一天的数据来自**内置样本**（离线采集），不是真的从网上采来的。
 *   只有为 true 时才写这一位（真实采集的日报里根本没有这个字段）。页面据此在**当天**打上
 *   「这是演示数据（示例）」——只靠"演示模式"一个开关堵不住这条路：`collect --offline`
 *   会把样本写进真实数据目录，那时候它同样不能被当成今天的热门项目展示。
 * @returns {object} 可直接 JSON.stringify 的日报对象
 */
export function buildDailyPayload(boards, date, options = {}) {
  const list = Array.isArray(boards) ? boards : [];
  const payload = {
    date,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    degraded: options.degraded === true,
    notes: Array.isArray(options.notes) ? [...options.notes] : [],
    boards: list.map((board) => ({
      id: board.id,
      title: board.title,
      items: (Array.isArray(board.items) ? board.items : []).map(toItem),
    })),
  };
  // 只在是样本数据时才加这一位：真实采集的日报形状保持原样（连键的顺序都不动）。
  if (options.demo === true) payload.demo = true;
  return payload;
}
/**
 * 把三个榜单渲染成日报 JSON 字符串（缩进 2 空格，与数据层写文件的口径一致）。
 *
 * 注意（R85）：日报的**权威写法**是"先 buildDailyPayload，再 JSON.stringify 同一份对象"
 * （collect.mjs 现在这么做，Markdown 也用同一份 payload 渲染）。这个函数保留是因为简报把
 * `renderDailyJson(boards, date)` 列为交付接口；但**不要**在同一个流程里先调它、再另调
 * `renderDailyMarkdown` —— 那会从 boards 各构造一份 payload，正是"两者可能不一致"的来源。
 * @param {{ id: string, title: string, items: object[] }[]} boards
 * @param {string} date UTC 日期（YYYY-MM-DD）
 * @param {{ generatedAt?: string, degraded?: boolean, notes?: string[] }} [options]
 * @returns {string}
 */
export function renderDailyJson(boards, date, options = {}) {
  return `${JSON.stringify(buildDailyPayload(boards, date, options), null, 2)}\n`;
}

// GitHub 好玩榜 —— 评分纯函数层。
// 这里只做确定性计算：不读文件、不发网络请求，同样的输入永远得到同样的输出。
// 需要"现在几点"的地方一律走显式参数 now（默认 new Date() 只是方便调用，不在计算深处偷看时钟），
// 这样单测能固定时间，评分结果可复现。
// 本文件按任务推进逐步扩充：Task 3 热度分；Task 4 口碑分、新手友好分、总分、等级与门槛。

import {
  WEIGHTS,
  HOT_REFERENCE_STARS_PER_WEEK,
  DETAIL_WEIGHTS,
  RUNNABLE_POINTS,
  CHINESE_POINTS,
} from '../config/weights.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

// 口碑子项的满分口径（spec §6.1）。这些是判定阈值，不是分值，分值只从 weights.mjs 取。
const FORK_RATIO_FULL = 0.15;
const PUSH_FULL_DAYS = 2;     // ≤2 天拿满 pushRecency
const PUSH_PARTIAL_DAYS = 7;  // ≤7 天拿满分的 2/3（约 5.33 分），更久为 0

// 硬性门槛口径（spec §6.2）。
const GATE_MIN_STARS = 200;
const GATE_MAX_PUSH_DAYS = 7;

/**
 * 热度分：7 日新增收藏做 log10 归一化，达标即满分，超出封顶。
 * 缺失、负数、NaN 等非法输入一律当 0 新增处理，返回 0 而不是抛错。
 * @param {{ starsGained7d?: number }} repo 候选项目（只用到 starsGained7d）
 * @returns {number} 0 到 WEIGHTS.hot 之间的分数
 */
export function scoreHot({ starsGained7d }) {
  const v = Number.isFinite(starsGained7d) && starsGained7d > 0 ? starsGained7d : 0;
  return Math.min(
    WEIGHTS.hot,
    (WEIGHTS.hot * Math.log10(1 + v)) / Math.log10(1 + HOT_REFERENCE_STARS_PER_WEEK),
  );
}

/**
 * 口碑分（五项子分合计 WEIGHTS.reputation = 30）：fork/star 比、近期提交活跃、
 * 近 90 天有发版、许可证齐全、收藏持续增长，口径见 spec §6.1。
 * 比值类子项按"达到满分条件即满分"线性折算并封顶；缺字段或非法数值一律记 0，不抛错。
 * 刻意不算"issue 处理率"：GitHub 根本不返回 closed_issues，算了也只会得到一个假结论。
 * @param {{ forks?: number, stars?: number,
 *   pushedAt?: string, license?: string|{spdx_id?: string}|null,
 *   hasRelease90d?: boolean|null }} repo 候选项目；hasRelease90d 是三态：true/false/null（null=没问到，
 *   按中性半分计，见下方 R40 说明）
 * @param {{ growing?: boolean|null }} [extra] 需要历史数据才能算的部分：growing 为相邻两期收藏是否增长，
 *   null/undefined 代表数据不足，给中性半分（4 / 2 = 2）而不是惩罚新项目
 * @param {Date} [now] 显式传入"现在"，用于算 pushedAt 距今天数；默认 new Date()
 * @returns {{ total: number, parts: Record<string, number> }}
 */
export function scoreReputation(repo, extra = {}, now = new Date()) {
  const stars = Number.isFinite(repo.stars) && repo.stars > 0 ? repo.stars : 0;
  const forks = Number.isFinite(repo.forks) && repo.forks > 0 ? repo.forks : 0;
  const forkRatio = stars > 0 ? forks / stars : 0;

  const pushedTs = Date.parse(repo.pushedAt);
  const ageDays = Number.isFinite(pushedTs) ? (now.getTime() - pushedTs) / DAY_MS : Infinity;
  const pushRecency = ageDays <= PUSH_FULL_DAYS
    ? DETAIL_WEIGHTS.pushRecency
    : ageDays <= PUSH_PARTIAL_DAYS
      ? (DETAIL_WEIGHTS.pushRecency * 2) / 3
      : 0;

  // 许可证可能是字符串，也可能是 GitHub API 原样的 { spdx_id } 对象；NOASSERTION 视为没有许可证。
  const spdx = typeof repo.license === 'string' ? repo.license : repo.license?.spdx_id;
  const license = spdx && spdx !== 'NOASSERTION' ? DETAIL_WEIGHTS.license : 0;

  // 没有历史数据（null/undefined）给中性半分（DETAIL_WEIGHTS.growth / 2 = 2），不惩罚新项目；
  // 明确没增长才记 0。
  const noHistory = extra.growing === null || extra.growing === undefined;
  const growth = noHistory ? DETAIL_WEIGHTS.growth / 2 : extra.growing ? DETAIL_WEIGHTS.growth : 0;

  // releases.mjs 产出的是三态（R40）：true 有近 90 天的发版、false 确认没有、null 没问到。
  // "没问到"给中性半分（DETAIL_WEIGHTS.release90d / 2 = 3），与上面 growth 的口径一致：
  // 记 0 会让界面显示"近 90 天有发版：0 分"，那是一句我们没有证据的断言；只有明确 false 才记 0。
  // 缺字段（undefined）同样按"没问到"处理：调用方没写这个字段就说明它没有证据，不能当作"确认没有"。
  const releaseUnknown = repo.hasRelease90d !== true && repo.hasRelease90d !== false;

  const parts = {
    forkRatio: DETAIL_WEIGHTS.forkRatio * Math.min(1, forkRatio / FORK_RATIO_FULL),
    pushRecency,
    release90d: releaseUnknown ? DETAIL_WEIGHTS.release90d / 2 : repo.hasRelease90d ? DETAIL_WEIGHTS.release90d : 0,
    license,
    growth,
  };
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}

/**
 * 新手友好分（WEIGHTS.runnable = 25）= 安装路径 0-18 + 中文说明 0-7。
 * R143：中文那一项按 hasChinese（真有中文）算，**满给或 0**，不按比例；
 * 只有日文/韩文文档的项目拿不到这 7 分（它至多在界面上看到"有本地化文档（非中文）"）。
 * 名字沿用 v1 的 runnable，界面上叫"新手友好"，不要改名。
 * R153：判据字段只有 `hasChinese` —— 历史名 `chineseDoc` 已删除（两个名字指同一件事，
 * 却由评分与文案各自读一个，那就是"同一事实两份真相源"）。
 * @param {{ kind?: string, hasChinese?: boolean }} runnability kind 取自 RUNNABLE_POINTS 的键
 * @returns {{ total: number, parts: { installPath: number, chinese: number } }}
 */
export function scoreRunnable(runnability = {}) {
  const points = RUNNABLE_POINTS[runnability.kind];
  // 未知 kind（含原型链上的同名键）一律 0 分，绝不出 NaN。
  const installPath = Number.isFinite(points) ? points : 0;
  const chinese = runnability.hasChinese === true
    ? CHINESE_POINTS.readmeRatio + CHINESE_POINTS.localizedFile
    : 0;
  return { total: installPath + chinese, parts: { installPath, chinese } };
}

/**
 * 难度分级（spec §4.2）：分档边界就是 RUNNABLE_POINTS 里的 16 分与 8 分，
 * 18/16 绿、14/8 黄、6/4/0 红；未知或非法分值时落在红档，不会返回 undefined。
 * @param {number} installPathScore 安装路径分（0-18）
 * @returns {'green'|'yellow'|'red'}
 */
export function calculateGrade(installPathScore) {
  if (installPathScore >= RUNNABLE_POINTS.npmBinWin) return 'green';
  if (installPathScore >= RUNNABLE_POINTS.npmNoBin) return 'yellow';
  return 'red';
}

/**
 * 把一条候选汇总成榜单里要落的评分对象（三段分数 + 总分 + 等级 + 置信度 + 子项明细）。
 * total = 热度 + 口碑 + 新手友好，三轴满分合计 100；grade 只看安装路径分；confidence 由涨星来源透传。
 * parts 里带上口碑五项与 installPath、chinese，详情页与"为什么上榜"都从这里取。
 * @param {{ repo: object, runnability?: object, velocity?: object, extra?: object }} input
 *   velocity 形如 { gained7d, confidence }；extra 透传给 scoreReputation（如 growing）
 * @param {Date} [now] 显式传入"现在"，用于口碑里的近期提交活跃；默认 new Date()
 * @returns {{ hot: number, reputation: number, runnable: number, total: number,
 *   grade: 'green'|'yellow'|'red', confidence: string|null, parts: Record<string, number> }}
 */
export function scoreRepo({ repo, runnability, velocity, extra }, now = new Date()) {
  const hot = scoreHot({ starsGained7d: velocity?.gained7d });
  const reputation = scoreReputation(repo, extra, now);
  const runnable = scoreRunnable(runnability);
  return {
    hot,
    reputation: reputation.total,
    runnable: runnable.total,
    total: hot + reputation.total + runnable.total,
    grade: calculateGrade(runnable.parts.installPath),
    confidence: velocity?.confidence ?? null,
    parts: { ...reputation.parts, ...runnable.parts },
  };
}

/**
 * 硬性门槛（spec §6.2）：未归档、有许可证、近 7 天有提交、总收藏 ≥200、至少一条已核实的安装路径
 * （kind 必须是 RUNNABLE_POINTS 里分值大于 0 的一档，none 与未知 kind 都算没有）。
 * **独立门槛是这五条**；下面那句"不是纯资源清单类"**不是第六条**——它的判定式本身就要求
 * "没有任何已核实的安装路径"，而那已经被第五条挡掉了，所以它不会让多一个项目落榜
 * （R142；boards/build.mjs 的 keep() 也据此不另加过滤器）。它存在的意义是给同一批被挡下的项目
 * 一个更准确的中文说明（"这是资料清单，不是能装的软件"）。
 * 未通过的原因**全部**按顺序返回（不短路），中文、给用户看。
 * @param {{ ownerRepo?: string, stars?: number, pushedAt?: string, language?: string|null,
 *   license?: string|{spdx_id?: string}|null, archived?: boolean }} repo
 * @param {{ kind?: string, verified?: boolean }} runnability
 * @param {Date} [now] 显式传入"现在"，用于判断"近 7 天有提交"；默认 new Date()
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function passesGates(repo, runnability, now = new Date()) {
  const reasons = [];

  if (repo.archived === true) reasons.push('已停止维护');

  const spdx = typeof repo.license === 'string' ? repo.license : repo.license?.spdx_id;
  if (!spdx || spdx === 'NOASSERTION') reasons.push('没有开源许可证');

  const pushedTs = Date.parse(repo.pushedAt);
  const stale = !Number.isFinite(pushedTs) || now.getTime() - pushedTs > GATE_MAX_PUSH_DAYS * DAY_MS;
  if (stale) reasons.push(`超过 ${GATE_MAX_PUSH_DAYS} 天没有更新`);

  if (!(Number.isFinite(repo.stars) && repo.stars >= GATE_MIN_STARS)) {
    reasons.push(`收藏人数不足 ${GATE_MIN_STARS}`);
  }

  const installPathPoints = RUNNABLE_POINTS[runnability?.kind];
  // 门槛要的是"真实存在、给得出安装命令或下载链接"的安装路径：kind 必须是已知且分值大于 0 的一档。
  // none 与未知 kind 在用户视角上是同一件事——点开只有空白引导，所以一并挡下；
  // dockerOnly（4 分）是真路径，只是要先用 Docker，照旧放行。
  const hasVerifiedInstallPath = runnability?.verified === true
    && Number.isFinite(installPathPoints)
    && installPathPoints > 0;
  if (!hasVerifiedInstallPath) reasons.push('没有已核实的安装方式');

  // 纯资源清单类（spec §6.2）：语言为空或只有 Markdown，且没有任何安装路径证据。
  // 这里不看仓库名字，避免把 awesome-tool 这类真工具误挡在榜外。
  const listOnlyLanguage = !repo.language || repo.language === 'Markdown';
  if (listOnlyLanguage && !hasVerifiedInstallPath) reasons.push('这是资料清单，不是能装的软件');

  return { ok: reasons.length === 0, reasons };
}

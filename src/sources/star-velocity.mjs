// GitHub 好玩榜 —— 涨星速度五级降级（本项目的技术命门）。
// GitHub 从不公布星标历史；/stargazers 名单端点早已对非管理员关闭；全局事件流（firehose）的体量
// 也退化到当年的约 0.3%。**谁自己攒着历史，谁才有资格诚实地谈"暴涨"。** 所以这里按
// 精确度与成本排成五级，逐级尝试、命中即返回，并且**永远如实标注这个数是怎么来的**：
//
//   级别 0  stargazers/history —— 周桶里有逐日增量，能同时给出精确的 7 日与 3 日增量。
//                               confidence:'measured'，源码 source:'stargazers-history'
//   级别 1  仓库建于 7 天内 —— 它的总收藏数**就是** 7 日增量（没有更早的历史可言）。
//                               confidence:'measured'，source:'new-repo'
//   级别 2  trending 页面自己写的 starsThisWeek —— 官方口径的转述。
//                               confidence:'reported'，source:'trending'
//   级别 3  我们自己的历史 JSON（readSnapshotStars）—— 与 7 天前快照的实测差值；
//                               3 天前也有快照时补上 gained3d。confidence:'measured'，source:'history-json'
//   级别 4  /repos/{id}/events 的 WatchEvent 时间戳按窗口速率外推 ×168 小时，
//                               但**只在观测窗口 ≥ 6 小时且星标事件 ≥ 3 起时**才可用（R54，见下）。
//                               **这是估算**：confidence:'estimated'，source:'events'
//   全都拿不到 → { gained7d: 0, gained3d: null, level: 4, confidence: 'estimated', source: 'none' }
//
// 诚实规则（本项目已被同一类缺陷咬过四次，故写死在注释里）：
//   · 只有真正"量"出来的才是 'measured'：级别 0（逐日增量）、级别 1（总星数即全史）、
//     级别 3（两次快照的实测差）。外推出来的永远是 'estimated'；页面转述的是 'reported'。
//   · `gained3d` 只有在**日线数据确实覆盖 3 天**（级别 0）或有 3 天前快照（级别 3）时才给值，
//     否则保持 null —— 绝不能把"我们不知道"渲染成"3 天涨 0"。下游把 'estimated' 渲染为"约 N（估算）"。
//   · 任何一级"不适用 / 拿不到"都只是**降级**，绝不抛错：一次端点 404 不能带崩整轮采集。
//
// 成本数学（R52 裁定，45 次/轮的匿名额度是硬约束）：
//   · 级别 0 对**仓库年龄 ≤ 30 周**的仓库只需 **1** 次请求：端点按周从旧到新返回，
//     30 周以内一页（per_page=30）就含最新周，最新那几周就是我们要的 7 日窗口。
//   · 老仓库**不**走级别 0：最新周在**最后一页**，而客户端不暴露 Link 头，无法知道总页数。
//     控制者实测：9 年前的仓库在 per_page=1 下 rel="last" 是 page=100 —— 也就是说
//     一次 page walk 要上百次请求，远超整轮 45 次的额度。R52 允许"客户端报告剩余额度充足时才翻页"，
//     但注入的 client 没有任何剩余额度探针，它唯一的额度信号是"用尽后返回 null"，
//     而这个信号出现在**错误的时机**（等它出现时请求已经发出去了）。所以本项目对老仓库
//     直接跳过级别 0，把成本让给**免费且实测**的级别 1/3 —— 每仓库最多 2 次请求（级别 0 + 级别 4），
//     绝不静默超支。
//   · 级别 0 还要求 `createdAt` 可读：年龄读不出来就**无法证明**它便宜，于是不发请求（失败关闭方向）。
//   · client.getJson 返回 null（额度耗尽被拦 / 请求失败）一律按"这一级不可用"处理并继续下降，
//     不当作错误、不重试（重试与退避是 client 的职责）。
//   · 简报要求级别 0 带 `X-GitHub-Api-Version: 2026-03-10`；控制者实测该头**不是必需的**
//     （不带也返回 200），而本项目的 getJson 不提供逐请求自定义头，故沿用 client 统一固定的
//     `2022-11-28`。端点两种都不介意，这里不为一个无害的头去改动已评审的 net 层。
//
// R54 —— 级别 4 的最小观测窗口（外推最容易造假的地方）：
//   /events 只给最近 100 条事件，而**越热的仓库这 100 条覆盖得越短**：控制者实测
//   `anthropics/claude-code` 的 100 条只覆盖 1.9 小时、`sst/opencode` 2.2 小时。窗口越短外推倍率越大：
//     1 起 / 1 分钟  → 10080          5 起 / 1 小时    → 840
//     100 起 / 1 小时 → **16800**      100 起 / 12.6 小时 → 1333（合理，正是实测 markitdown 的形状）
//   误差**专门集中在最热的那批仓库**上，而它们正是榜单前排：一个 16800 的"估算值"会把 45 分热度轴
//   直接打满。标了 estimated 不等于没事——那是拿噪声冒充数据。所以级别 4 只在
//   **观测窗口 ≥ 6 小时 且 WatchEvent ≥ 3 起**时才成立（窗口越短倍率越大：1 小时窗口就已是 168×，
//   而 100 条事件在最热仓库里恰恰只覆盖 1–2 小时；两三起事件也给不出速率信号）；
//   不满足即**该级不可用**，继续降到 source:'none'（gained7d: 0）。
//   代价（明知并接受）：少数极热仓库会落到"未知"——但那是诚实答案，我们确实无法从几分钟的样本
//   测出周速率；而且这类仓库通常已被更早的**级别 2（trending 官方 starsThisWeek，0 请求）**覆盖，
//   损失有界。
//
// 时间口径：全部按 **UTC**。日序号 = floor(unix 毫秒 / 86400000)；
// "最近 7 天" = 日序号 [N-7, N-1]（N = 今天的日序号，即已过完的 7 个 UTC 整日），
// "最近 3 天" = [N-3, N-1] —— 与"7 天前 / 3 天前的快照差值"（级别 3）口径一致。
// 当天（部分周）的增量落在日序号 N，天然在窗口之外，不会被当成"涨星崩塌"。
//
// 周桶与日线的对齐（R55，控制者用真实响应**证实**，不再是假设）：
//   · 周起点是 **UTC 的星期天**（`getUTCDay() === 0`）；
//   · `days[0]` 属于 `week` 那一天，`days[i]` 依次对应 `week + i` 个 UTC 日（1 日 = 1 个 UTC 日）；
//   · **最后一个 `days` 元素是"当天"，可能为 0**（部分周）——它是"这一天还没过完"，
//     绝不是"涨星崩塌"，故窗口只取已过完的整日。
//   实证：`openai/math`（创建于 2026-10-06T21:47:02Z）的真实响应里
//   `week = 1791072000` → 2026-10-04T00:00:00Z（UTC 星期天），
//   `days = [0, 0, 5004, 5546, 1897, 703, 0]`，七笔之和 13150 正好等于同一对象的 `total`；
//   其中 `days[2]` → 2026-10-06 = 5004，正是该仓库创建当天（当天即 5004 星，完全吻合），
//   `days[6]` → 2026-10-10 = 0（当天尚未结束）。对齐关系由此有据可依。
//
// 本模块没有评分、没有榜单逻辑、没有 HTML 解析，也不缓存任何东西（缓存属于 client）。

import { readSnapshotStars } from '../store/datastore.mjs';
import { fetchWatchEvents } from './events.mjs';

const GITHUB_API = 'https://api.github.com';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEK_DAYS = 7;
// R52 成本闸门：30 周以内才可能"一页拿到最新周"。
const HISTORY_MAX_AGE_DAYS = 30 * WEEK_DAYS;
// 外推窗口：7 天。
const EXTRAPOLATE_HOURS = 168;
// R54：级别 4 的最小观测窗口与最少事件数。窗口太短 → 外推倍率失真；样本太少 → 没有速率信号。
const MIN_OBSERVATION_HOURS = 6;
const MIN_WATCH_EVENTS = 3;

/** UTC 日序号：把毫秒时间戳落到"第几天"，用来把周桶的日增量对到日历上。 */
const utcDayIndex = (ms) => Math.floor(ms / DAY_MS);

/** UTC 日期串（YYYY-MM-DD），与 datastore 的文件名口径一致。 */
const utcDate = (date) => date.toISOString().slice(0, 10);

/** 按 UTC 整天平移（UTC 没有夏令时，直接加减毫秒是安全的）。 */
const shiftDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

/** 解析时间字符串；读不出来返回 null（绝不退化成 0 或当前时间）。 */
const parseTime = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** 是不是一个可用的星标计数（非负的有限数）。 */
const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** 兜底：什么都没问到。level 仍是 4（阶梯的最后一级），但 source 明说 'none'。 */
const unavailable = () => ({ gained7d: 0, gained3d: null, level: 4, confidence: 'estimated', source: 'none' });

/**
 * 把 stargazers/history 的周桶摊平成"UTC 日序号 → 当日增量"。
 * 响应结构（控制者实测）：`[{ week: <周起始的 unix 秒>, total: <该周结束时的累计星数>, days: [7 笔当日增量] }]`，
 * 周按从旧到新排列；新仓库的七笔 days 之和正好等于 total（5004+5546+1897+703 = 13150）。
 * 因此 days[i] 落在 `floor(week*1000/86400000) + i` 这一天，1 日 = 1 个 UTC 日。
 * 对齐关系已由真实响应证实（R55，见文件头：周起点是 UTC 星期天，`days[0]` 就是 `week` 当天，
 * 末位元素是"当天"、部分周里为 0）。
 * 结构不符 / 数值非法的那些天**不写入** Map：覆盖不到就是覆盖不到，绝不补 0。
 * @param {*} body 响应体
 * @returns {Map<number, number>} 日序号 → 当日涨星
 */
function flattenDailyDeltas(body) {
  const byDay = new Map();
  if (!Array.isArray(body)) return byDay;

  for (const bucket of body) {
    if (!bucket || typeof bucket !== 'object') continue;
    if (typeof bucket.week !== 'number' || !Number.isFinite(bucket.week)) continue;
    if (!Array.isArray(bucket.days)) continue;

    const weekStartDay = utcDayIndex(bucket.week * 1000);
    for (let i = 0; i < Math.min(bucket.days.length, WEEK_DAYS); i++) {
      const delta = bucket.days[i];
      if (!isCount(delta)) continue; // 读不懂的那天算"没覆盖"
      byDay.set(weekStartDay + i, delta);
    }
  }
  return byDay;
}

/**
 * 累加"最近 days 天"（日序号 [today-days, today-1]）。
 * 只要有一天没覆盖就返回 null：这是"我们不知道"，不是"这天的增量是 0"。
 * @param {Map<number, number>} byDay 日序号 → 当日增量
 * @param {number} today 今天的日序号
 * @param {number} days 窗口天数
 * @returns {number|null}
 */
function sumWindow(byDay, today, days) {
  let total = 0;
  for (let offset = days; offset >= 1; offset--) {
    const day = today - offset;
    if (!byDay.has(day)) return null;
    total += byDay.get(day);
  }
  return total;
}

/**
 * 级别 0：/repos/{id}/stargazers/history（最精确，也最贵，故有 R52 成本闸门）。
 * 只有"年龄已知且 ≤ 30 周"才发这一次请求；7 天铺不满就整级放弃，不拿半截数据冒充 measured。
 * 404 / 403 / 结构不符 / 额度耗尽（client 返回 null）一律返回 null，由调用方继续下降。
 * @returns {Promise<object|null>}
 */
async function levelFromHistory(client, ownerRepo, now, createdAtMs) {
  if (typeof client?.getJson !== 'function') return null;      // 没能力就别花请求
  if (createdAtMs === null) return null;                       // 年龄未知 → 无法证明便宜
  const ageDays = (now.getTime() - createdAtMs) / DAY_MS;
  if (ageDays < 0 || ageDays > HISTORY_MAX_AGE_DAYS) return null; // 未来的 createdAt 留给级别 1（免费）

  const body = await client.getJson(
    `${GITHUB_API}/repos/${ownerRepo}/stargazers/history?per_page=30`,
    { api: 'core' }
  );
  const byDay = flattenDailyDeltas(body);
  const today = utcDayIndex(now.getTime());

  const gained7d = sumWindow(byDay, today, WEEK_DAYS);
  if (gained7d === null) return null;                          // 日线没铺满 7 天：不知道
  return {
    gained7d,
    gained3d: sumWindow(byDay, today, 3),                      // 7 天铺满 ⇒ 3 天必然也铺满
    level: 0,
    confidence: 'measured',
    source: 'stargazers-history'
  };
}

/**
 * 级别 1：仓库建于 7 天内 → 它的总收藏数就是 7 日增量（0 次请求，且是真测量）。
 * createdAt 落在未来（时钟偏差 / 数据损坏）时也算"新建"：它确实不可能有 7 天以上的历史。
 * 但 gained3d 仍是 null —— 总星数只说得出"全部"，说不出"最近 3 天"。
 * @returns {object|null}
 */
function levelFromNewRepo(repo, now, createdAtMs) {
  if (createdAtMs === null) return null;
  if ((now.getTime() - createdAtMs) / DAY_MS > WEEK_DAYS) return null;
  if (!isCount(repo?.stars)) return null;
  return { gained7d: repo.stars, gained3d: null, level: 1, confidence: 'measured', source: 'new-repo' };
}

/**
 * 级别 2：trending 页面自己写的 starsThisWeek（0 次 API 请求，官方口径的转述）。
 * `starsThisWeek > 0` 才算数：页面没写（解析出来是 0）时那是"页面没说"，不是"涨了 0"。
 * @returns {object|null}
 */
function levelFromTrending(ownerRepo, trendingByRepo) {
  if (typeof trendingByRepo?.get !== 'function') return null;
  const week = trendingByRepo.get(ownerRepo)?.starsThisWeek;
  if (!isCount(week) || week <= 0) return null;
  return { gained7d: week, gained3d: null, level: 2, confidence: 'reported', source: 'trending' };
}

/**
 * 取某天快照里该仓库的星数；该天没有这个仓库（或值不是数）时返回 null。
 * @returns {number|null}
 */
function snapshotStarsOf(dataDir, date, ownerRepo) {
  const stars = readSnapshotStars(dataDir, date).get(ownerRepo);
  return isCount(stars) ? stars : null;
}

/**
 * 级别 3：我们自己的历史 JSON（0 次请求，实测差值）—— 整条阶梯的支柱。
 * 必须有"7 天前的快照"才成立（7 日增量靠它）；"3 天前的快照"有则补 gained3d，没有就保持 null。
 * 差值可能是负数（取消星标是真实存在的行为），照实返回，绝不夹逼成 0 —— 夹逼就是编数据。
 * @returns {object|null}
 */
function levelFromHistoryJson(repo, ownerRepo, dataDir, now) {
  if (typeof dataDir !== 'string' || dataDir === '') return null;
  if (!isCount(repo?.stars)) return null;

  const past7 = snapshotStarsOf(dataDir, utcDate(shiftDays(now, -7)), ownerRepo);
  if (past7 === null) return null;
  const past3 = snapshotStarsOf(dataDir, utcDate(shiftDays(now, -3)), ownerRepo);

  return {
    gained7d: repo.stars - past7,
    gained3d: past3 === null ? null : repo.stars - past3,
    level: 3,
    confidence: 'measured',
    source: 'history-json'
  };
}

/**
 * 级别 4：事件流外推（1 次请求，估算）。
 * 拿不到事件（fetchWatchEvents 返回 null / 空）或算不出速率时返回 null，由调用方兜底；
 * R54 的"最小观测窗口 / 最少事件数"也在 estimateFromEvents 里把关，不满足即整级不可用。
 * @returns {Promise<object|null>}
 */
async function levelFromEvents(client, ownerRepo, now) {
  const events = await fetchWatchEvents(client, ownerRepo);
  const estimate = estimateFromEvents(events, now);
  if (!estimate) return null;
  return {
    gained7d: estimate.gained7d,
    gained3d: null, // 事件流只看得到"最近这一段"，给不出 3 日实测值
    level: 4,
    confidence: 'estimated',
    source: 'events'
  };
}

/**
 * 用最近 7 天内的涨星事件外推 7 日增量：`watchCount / windowHours * 168`。
 * 传入的应是**星标事件**列表（fetchWatchEvents 已经过滤过），所以这里对 `type` 缺失宽容
 * （视为调用方已过滤）；但只要 `type` 写了且不是 `WatchEvent`，就剔除 —— 防止误把推送/议题当涨星。
 * 窗口 = "现在"减去**最早一起**被计入事件的时间；超过 7 天的事件不参与（它们属于更早的行情）。
 *
 * 两条"证据不足"的硬性门槛（R54，宁可答"未知"，也不拿噪声冒充数据）：
 *   · 观测窗口必须 **≥ 6 小时**：不足 1 小时时外推倍率就超过 168×（100 起 / 1 小时 → 16800 星，
 *     而最热的仓库 100 条事件往往只覆盖 1–2 小时），误差专门砸在榜单前排；
 *   · 被计入的星标事件必须 **≥ 3 起**：两三起给不出速率信号。
 * 不满足任一条即返回 null（该级不可用）；零宽度窗口（最早一起正好发生在"现在"）同样返回 null：
 * **绝不除零**，也不编一个无穷大的速度。
 * @param {Array<{type?: string, created_at?: string}>|null} events 星标事件列表
 * @param {Date} now "现在"（显式传入，便于测试固定时间）
 * @returns {{ perHour: number, gained7d: number }|null} 证据不足、速率为 0 或无法计算时返回 null
 */
export function estimateFromEvents(events, now) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) return null;

  const cutoff = nowMs - WEEK_DAYS * DAY_MS;
  let earliest = Infinity;
  let watchCount = 0;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (typeof event.type === 'string' && event.type !== 'WatchEvent') continue; // 不是涨星
    const at = parseTime(event.created_at);
    // 未来时间戳（时钟偏差/脏数据）与 7 天以外的事件都不参与外推。
    if (at === null || at > nowMs || at < cutoff) continue;
    watchCount++;
    if (at < earliest) earliest = at;
  }
  if (watchCount === 0) return null;

  const windowHours = (nowMs - earliest) / HOUR_MS;
  if (!(windowHours > 0)) return null;                            // 零宽度窗口：不除零
  if (!(windowHours >= MIN_OBSERVATION_HOURS)) return null;       // R54：窗口太短，外推倍率失真
  if (watchCount < MIN_WATCH_EVENTS) return null;                 // R54：样本太少，给不出速率

  const perHour = watchCount / windowHours;
  return { perHour, gained7d: Math.round(perHour * EXTRAPOLATE_HOURS) };
}

/**
 * 解析一个仓库的涨星速度：按 0→1→2→3→4 逐级尝试，命中即返回。
 * 每级都自带"不适用就返回 null"的判断，且整个降级链**永不抛错**——最坏情况是
 * `{ gained7d: 0, gained3d: null, level: 4, confidence: 'estimated', source: 'none' }`。
 * @param {{ ownerRepo: string, createdAt?: string, stars?: number }} repo 仓库（至少要有 ownerRepo）
 * @param {{ client?: object, dataDir?: string|null, trendingByRepo?: Map<string, object>, now?: Date }} [ctx] 注入依赖
 * @returns {Promise<{ gained7d: number, gained3d: number|null, level: 0|1|2|3|4,
 *   confidence: 'measured'|'reported'|'estimated', source: string }>}
 */
export async function resolveVelocity(repo, ctx = {}) {
  const now = ctx?.now instanceof Date ? ctx.now : new Date(NaN);
  const ownerRepo = typeof repo?.ownerRepo === 'string' ? repo.ownerRepo.trim() : '';
  if (!Number.isFinite(now.getTime()) || ownerRepo === '') return unavailable();

  const createdAtMs = parseTime(repo?.createdAt);

  // 阶梯顺序即"精确度 vs 成本"的取舍顺序，保持不变（R52 只让不适用/买不起的级别**廉价地跳过**）。
  const ladder = [
    () => levelFromHistory(ctx?.client, ownerRepo, now, createdAtMs),
    () => levelFromNewRepo(repo, now, createdAtMs),
    () => levelFromTrending(ownerRepo, ctx?.trendingByRepo),
    () => levelFromHistoryJson(repo, ownerRepo, ctx?.dataDir, now),
    () => levelFromEvents(ctx?.client, ownerRepo, now)
  ];

  for (const level of ladder) {
    let hit = null;
    try {
      hit = await level();
    } catch {
      hit = null; // 任何一级的意外都只是"这一级不可用"，继续下降
    }
    if (hit) return hit;
  }
  return unavailable();
}

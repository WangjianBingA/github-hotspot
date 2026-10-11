// GitHub 好玩榜 —— collect 主流程（整条流水线的编排者）。
//
// 这个模块是"一天一轮采集"的全部骨架，它把前面十三个任务做出来的零件按固定顺序串起来：
//
//   ① discover    发现候选池（周榜候选 + 经典榜自己的池子）……sources/search、trending
//   ② enrich      逐候选富化：release 资产、注册表归属、README 中文证据、两个三态事实
//                 （src/sources/pipeline.mjs、enrich/*、sources/registry、sources/releases）
//   ③ 免费涨星    先跑零成本级别 1/2/3（sources/star-velocity，freeOnly）
//   ④ 付费涨星    只对争夺名次的候选开级别 0/4（同样走 star-velocity 的五级阶梯）
//   ⑤ 组装榜单    buildBoard × 3（boards/build + score/*）
//   ⑥ 落盘        writeDaily + updateIndex + appendHistory（store/datastore）
//   ⑦ 导出        日报 Markdown 与日报 JSON（exporters/*）
//
// 编排者只认三个注入接口：`sources.discover` / `sources.enrich` / `sources.resolveVelocity`。
// 离线测试注入假实现，cli.mjs 注入真实网络那一份——**同一份编排代码**同时是生产与测试的路径，
// 不存在"测试绿、生产走另一条路"的第二个实现。
//
// 控制者裁定下来的纪律（每条都对应一个实测出来的缺陷，实现细节写在对应代码旁边）：
//   R26 经典榜吃自己的池子，绝不拿周榜候选顶替；
//   R33 RateLimitError 立刻中止本轮，不再逐个候选硬试；
//   R35 trending 返回空是"我们没查到"，必须记警告并标 degraded，不能静默少一个交叉验证；
//   R41 hasRelease90d 与 extra.growing 必须真的被写，"没问到"必须让整轮可见地降级；
//   R80 那个降级**只针对会被展示分数的条目**（周榜/新手榜）：经典榜不参与三轴评分，
//       它的候选没这两个字段的消费者，拿它标降级就是"狼来了"；
//   R83 中止富化只允许两件事——额度**真的**用尽、或 RateLimitError；单个候选失败只跳过并计数，
//       绝不因为一个瞬时 5xx（client 的粘性 degraded）就把整轮变成零候选；
//   R84 审计直接读榜上条目对象本身（不按仓库名反查），且"没拿到新数据"要真的去复用旧榜单，
//       并在无内容时**不覆盖**今天已有的文件；
//   R86 为付费涨星预留额度，经典池不做计费的 release 查询；
//   R87 经典池只喂经典榜，绝不并进周榜候选池。
//
// 另有一条贯穿全篇的原则：**静默未知必须可见**。凡是"我们没问到"（null），
// 一律进 warnings 并置 degraded: true；凡是"确认没有"（false），照实记，不降级。
// 唯一的例外是 R80 划定的审计范围：经典榜不展示三轴分数，那两个字段在它身上没有消费者，
// 所以它只管照实写 null（界面仍能看到"没问到"），但不把整轮判成"数据不可用"。

import { BOARDS } from './config/boards.mjs';
import { buildBoard } from './boards/build.mjs';
import { passesGates, scoreRepo } from './score/score.mjs';
import { appendHistory, listDates, readDaily, updateIndex, writeDaily } from './store/datastore.mjs';
import { buildDailyPayload } from './exporters/json.mjs';
import { renderDailyMarkdown } from './exporters/markdown.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 86_400_000;

// R53：付费涨星最多开给多少个候选。级别 0/4 各要 1 次 core 请求，而付费阶段的额度由
// RESERVED_FOR_PAID_VELOCITY 专门留着（见下），所以这个上限与预留额度是配套的：
// 16 个候选最多花 16–32 次，预留给的就是它。
const MAX_PAID_VELOCITY = 16;

// 本轮额度上限（spec §5.5：未认证 core 60/小时，一轮总预算取 45）。cli.mjs 会把同一个数字
// 传给网络客户端与本编排者：客户端按它拦请求，编排者按它决定"什么时候该停下来把额度留给涨星"。
const ROUND_BUDGET = 45;
// R86（控制者裁定）：为付费涨星阶段**预留**的额度。
// 不预留的后果已被实测确认：每个候选取 release 就要 1 次计费请求，45 次在付费阶梯开始前就用光了，
// 于是 `freeOnly:false` 那一趟永远跑不到，榜单只能显示"本周新增收藏 0 / source:'none'"。
const RESERVED_FOR_PAID_VELOCITY = MAX_PAID_VELOCITY;

// 预判用的"热度上限"：只用来把候选排个序（谁更可能争到名次），不参与任何真实评分。
const HOT_POTENTIAL = 45;

/** UTC 日期串（YYYY-MM-DD），与数据层的文件名口径一致。 */
const utcDate = (date) => date.toISOString().slice(0, 10);

/** 按 UTC 整天平移（UTC 没有夏令时，直接加减毫秒是安全的）。 */
const shiftDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

/**
 * 三态布尔值的归一化：只有明确的 true / false 才算"问到了"，其余（undefined、null、乱写的值）
 * 一律是"没问到"。R41 的两个字段都走这个函数，绝不让"没问到"混成"确认没有"。
 * @param {*} value
 * @returns {boolean|null}
 */
const triState = (value) => (value === true || value === false ? value : null);

/** 降级记账（原因既进 warnings，也进 JSON 的 notes）。 */
const note = (ctx, reason) => { ctx.degraded = true; ctx.warnings.push(reason); };

/** 候选有没有可能过门槛：门槛里唯一"富化后才知道"的那条（已核实的安装路径）先不参与。 */
const couldPassGates = (candidate, now) =>
  passesGates(candidate.repo, null, now)
    .reasons.every((r) => r !== '没有已核实的安装方式' && r !== '这是资料清单，不是能装的软件');

/** 取候选现在的涨星速度对象（可能还没有）。 */
const velocityOf = (candidate) => (candidate.velocity && typeof candidate.velocity === 'object' ? candidate.velocity : {});

/** 把候选数组去重（按 ownerRepo，先出现的留着），并丢掉没有仓库标识的条目。 */
function asCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const candidate of Array.isArray(list) ? list : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const ownerRepo = typeof candidate.repo?.ownerRepo === 'string' ? candidate.repo.ownerRepo : '';
    if (ownerRepo === '' || seen.has(ownerRepo)) continue;
    seen.add(ownerRepo);
    out.push(candidate);
  }
  return out;
}

/**
 * 把候选补成 board 认的形状：repo 一定有、extra 一定是对象、
 * **repo.hasRelease90d 一定存在**（缺失时显式设为 null＝"没问到"，而不是留个 undefined 让下游去猜）。
 * null 与"字段缺失"在 JSON 里是一回事，但在代码里不是：显式的 null 会让"我们没问到"这件事
 * 在 auditBoardItems 那里无处可藏（R41：静默未知必须可见）。
 * @param {object} candidate
 * @returns {object} 同一个对象（就地规范化）
 */
function normalizeCandidate(candidate) {
  if (!candidate.repo || typeof candidate.repo !== 'object') candidate.repo = {};
  if (!candidate.extra || typeof candidate.extra !== 'object') candidate.extra = {};
  candidate.repo.hasRelease90d = triState(candidate.repo.hasRelease90d);
  return candidate;
}

/**
 * R41 / R80 / R84a 的校验闸门：只审**周榜与新手榜真正产出的条目对象本身**。
 *
 * 为什么直接读条目而不是按 ownerRepo 反查候选池：同一个仓库可能在两个池里各有一个对象，
 * 反查会把"没被富化的那一份"当成被展示的候选，从而点名一个所有被展示条目其实都产出了的字段
 * （R84a 实测到的 R80 绕过路径）。条目对象自带 `repo.hasRelease90d` 与 `extra.growing`，
 * 直接读它就没有错配的余地。经典榜的条目**不在**审计范围内：它不参与三轴评分，
 * 这两个字段在那里没有消费者（spec §4.1）。
 *
 * 注意 undefined 也算"没问到"——没有写入处就等于我们没问过，绝不能当成"确认没有"。
 * 同一引用可能同时进周榜与新手榜，用 Set 去重，免得把同一个候选数两次。
 * @param {{ id: string, items: object[] }[]} boards 三个榜单
 * @returns {{ unknownRelease: number, unknownGrowth: number }}
 */
function auditBoardItems(boards) {
  const items = new Set(
    (Array.isArray(boards) ? boards : [])
      .filter((board) => board.id !== 'classic')
      .flatMap((board) => (Array.isArray(board?.items) ? board.items : []))
  );
  let unknownRelease = 0;
  let unknownGrowth = 0;
  for (const item of items) {
    if (triState(item?.repo?.hasRelease90d) === null) unknownRelease++;
    if (triState(item?.extra?.growing) === null) unknownGrowth++;
  }
  return { unknownRelease, unknownGrowth };
}

/**
 * 一个候选"争榜潜力"的排序键：门槛都过不了的不必开付费额度。
 * 用**热度上限**（HOT_POTENTIAL）而不是当前速度：付费级的意义正是"当前速度还不知道"，
 * 所以排序要按"口碑 + 新手友好"这两项已经确定的分数来排——谁的确定性分高，谁更可能挤进前几名。
 */
function contentionRank(candidate, now) {
  const score = scoreRepo({ repo: candidate.repo, runnability: candidate.runnability, velocity: { gained7d: 3000 }, extra: candidate.extra }, now);
  return score.reputation + score.runnable + HOT_POTENTIAL;
}

/**
 * 把注入的 client 包一层：一趟请求**一旦超过当前硬上限**就直接返回 null，并给编排者两个
 * 可计算的额度信号。这样富化循环不必在每个候选里都去查一次额度，也能保证"额度没了就别再试"。
 *
 * R83（控制者裁定）：判定依据是 `stats()` 里的**实际请求计数**，不再是 client 的粘性 `degraded`。
 * 原因：`degraded` 会被**任何一种** 5xx/超时置真（连 api:'none' 的 trending/raw 请求也算），
 * 拿它当中止信号会让"一次瞬时失败"升级成"整轮零候选被富化"——那正是本项目反复修的那类
 * "把局部问题放大成整体不可用"。额度是否用尽是一件**可以被算出来**的事，就自己算。
 *
 * R89（控制者裁定，修的是 R86 没修透的地方）：**两个信号是两件事，绝不能用同一个数**。
 *   · `quotaExhausted()` —— 富化的停止线：`used >= budget - reserve`。
 *     到这里富化就该停手，把预留留给付费涨星；
 *   · `budgetExhausted()` —— 硬上限：`used >= budget`（整轮 45 次，任何人都不许越过）；
 *   · `setHardLimit()` —— 付费阶段开始时把硬上限从"预算 - 预留"抬到"预算"。
 * 旧实现把"富化停止线"（29）同时当作**付费阶段的终止条件与请求闸门**，于是付费阶段可用量
 * 恰好变成 `29 - 富化用量`：富化一旦吃满（而"富化吃满"正是预留存在的理由），可用量就是 0 ——
 * 预留永远花不出去，还会打出一条声称"额度留给涨星速度"的假告警。29 + 16 = 45 才闭合。
 *
 * @param {object} client
 * @param {boolean} offline 离线模式：一次网络请求都不发
 * @param {{ budget?: number, reserve?: number }} [limits] 本轮总预算与为付费涨星预留的额度
 * @returns {object} 形状与 client 相同（getJson / fetchText / stats），另加
 *   quotaExhausted() / budgetExhausted() / setHardLimit()
 */
function guardClient(client, offline, { budget = ROUND_BUDGET, reserve = RESERVED_FOR_PAID_VELOCITY } = {}) {
  const stats = () => (typeof client?.stats === 'function' ? client.stats() : { coreCalls: 0, searchCalls: 0, cacheHits: 0, degraded: false });
  /** 已用额度（读不出来时按 0：永远不要因为一个读不到的数字而停止采集）。 */
  const usedQuota = () => {
    const current = stats();
    return (Number.isFinite(current.coreCalls) ? current.coreCalls : 0)
      + (Number.isFinite(current.searchCalls) ? current.searchCalls : 0);
  };
  // 当前允许花到的上限。起初是"预算 - 预留"，付费阶段开始时抬到"预算"。
  let hardLimit = budget - reserve;
  const stopped = () => offline || usedQuota() >= hardLimit;
  /** 富化的停止线（R83）：到这里就该停手，把预留让给付费涨星。 */
  const quotaExhausted = () => Number.isFinite(hardLimit) && usedQuota() >= budget - reserve;
  /** 整轮的硬上限（R89）：任何阶段都不许越过它。 */
  const budgetExhausted = () => Number.isFinite(hardLimit) && usedQuota() >= budget;
  return {
    async getJson(url, options) {
      if (stopped() || typeof client?.getJson !== 'function') return null;
      return client.getJson(url, options);
    },
    async fetchText(url) {
      if (stopped() || typeof client?.fetchText !== 'function') return null;
      return client.fetchText(url);
    },
    stats,
    // 给编排者两个**可计算的**额度信号（R83/R89）。它们与 client 那个含义很杂的 `degraded` 分开，
    // 避免再被粘性标志牵着走；也彼此分开，避免"富化停止线"被误当成"整轮没有额度了"。
    quotaExhausted,
    budgetExhausted,
    /**
     * 抬高档位：付费涨星阶段开始时调用，把上限从"预算 - 预留"抬到"预算"。
     * 这是**唯一**能让预留被花掉的动作；不调用它就等于把那份额度扔掉。
     */
    setHardLimit(value) {
      if (Number.isFinite(value)) hardLimit = value;
      return hardLimit;
    },
    /** 当前硬上限（给测试与日志用）。 */
    hardLimit: () => hardLimit,
  };
}

/**
 * 一个只会回答"我们没发请求"的 client：免费涨星那一段拿它兜底，
 * 让"免费级零成本"（R53）由编排者保证，而不是靠实现方自觉。
 */
function blockedClient() {
  const stats = () => ({ coreCalls: 0, searchCalls: 0, cacheHits: 0, degraded: false });
  return { getJson: async () => null, fetchText: async () => null, stats };
}

/**
 * 解析 discover() 的返回值。两种形状都认：
 *   · 数组 —— 候选池（离线的老契约）；
 *   · { candidates, classic, trending } —— 真实管线的形状（R26：经典榜有自己的池子）。
 * @returns {{ candidates: object[], classic: Function|null, trending: Function|null }}
 */
function readDiscoverResult(result) {
  if (Array.isArray(result)) return { candidates: result.filter(Boolean), classic: null, trending: null };
  const source = result && typeof result === 'object' ? result : {};
  return {
    candidates: Array.isArray(source.candidates) ? source.candidates.filter(Boolean) : [],
    classic: typeof source.classic === 'function' ? source.classic : null,
    trending: typeof source.trending === 'function' ? source.trending : null,
  };
}

/**
 * 富化候选池。**只有两件事**能中止整轮（R83）：
 *   ① 额度真的用尽（`guardClient.quotaExhausted()`，按实际请求计数算出来的）；
 *   ② 捕获到 `RateLimitError`（R33：client 已经确认额度耗尽，继续逐个试只会各等一次 403）。
 * 其余错误（超时、解析失败、单个仓库 5xx）一律**跳过并计数**，然后继续下一个——
 * 这正是简报第 3 步"某个候选富化失败不影响整轮"的要求。client 的一般 `degraded` 不再参与中止判断。
 * @param {object} ctx 运行上下文（client / sources / candidates）
 * @param {object[]} list 待富化的候选
 * @param {{ heavy?: boolean }} [options] 透传给 `sources.enrich`
 * @returns {Promise<{ done: number, failed: number, aborted: boolean, reason: 'quota'|'ratelimit'|null }>}
 */
async function enrichAll(ctx, list, options = {}) {
  const heavy = options.heavy !== false;
  let done = 0;
  let failed = 0;
  let reason = null;
  // 失败要**并计数、并带上原因**（R83）：只报一个数字，等于让人猜是哪一路出了问题。
  const failureReasons = [];

  for (const candidate of list) {
    if (ctx.client.quotaExhausted()) { reason = 'quota'; break; }
    try {
      const enriched = await ctx.sources.enrich(candidate, { heavy });
      ctx.candidates.push(enriched && typeof enriched === 'object' ? enriched : candidate);
      done++;
    } catch (error) {
      // R33：额度耗尽不是"这个候选运气不好"，是整轮到此为止——继续逐个试只会白等。
      if (error?.name === 'RateLimitError') { reason = 'ratelimit'; break; }
      // 其它错误只跳过一个候选，其余照旧成榜（spec §8）。
      failed++;
      const ownerRepo = candidate?.repo?.ownerRepo ?? '未知项目';
      const message = error?.message ?? '未知错误';
      // 只留前三条原因，警告不该变成一份逐候选的流水账。
      if (failureReasons.length < 3) failureReasons.push(`${ownerRepo}（${message}）`);
    }
  }
  return { done, failed, aborted: reason !== null, reason, failureReasons };
}

/**
 * 把某个**已落盘**的日报条目还原成候选形状，供"复用最近一天榜单"这条降级路径使用（R84b）。
 * JSON 里的 item 是摊平的（`ownerRepo` / `install` / `scores` 都在顶层），这里把它重新组装成
 * `{ repo, runnability, velocity, extra }` —— 也就是 R9 定下的 discover 输出契约。
 * 刻意不重新富化这批候选：它们的数据来自上一轮，我们不该假装刚刚查过（那会是编数据）。
 * @param {object} item 日报 JSON 里的条目
 * @returns {object|null} 还原后的候选；认不出仓库标识时返回 null
 */
function candidateFromItem(item) {
  const ownerRepo = typeof item?.ownerRepo === 'string' ? item.ownerRepo : '';
  if (ownerRepo === '') return null;
  const repo = item.repo && typeof item.repo === 'object' ? { ...item.repo } : { ownerRepo };
  if (typeof repo.ownerRepo !== 'string' || repo.ownerRepo === '') repo.ownerRepo = ownerRepo;
  // 顶层的 `hasRelease90d` 是**界面契约**（`toItem` 明确写出来的那个），所以它优先；
  // `repo.hasRelease90d` 只在顶层没有时作退路（真实日报里两个位置通常都有值，手工/旧版文件可能只写顶层）。
  if (triState(item.hasRelease90d) !== null) repo.hasRelease90d = item.hasRelease90d;
  return {
    repo,
    runnability: item.runnability && typeof item.runnability === 'object' ? { ...item.runnability } : {},
    velocity: item.velocity && typeof item.velocity === 'object' ? { ...item.velocity } : {},
    // 三态事实跟着走：上一轮"问到过"的结论仍然是结论，不必（也不该）在这一轮被抹成 null。
    // 顶层字段优先（那是**界面契约**，也是 `toItem` 明确写出来的）：`repo.hasRelease90d` 只在
    // 顶层没有时才作退路。为什么不能只看 `repo`：真实日报里两个位置通常都有值，但手工/旧版文件
    // 可能只写顶层——那时从 `repo` 读会读成 undefined，于是把昨日那份"确认有发版"降级成"没问到"，
    // 复用就白做了（R92 的实测就是这个形状）。
    extra: {
      growing: triState(item.growing) ?? triState(item.extra?.growing),
    },
  };
}

/**
 * 复用最近一天已落盘的榜单（简报第 3 步的"尝试复用昨日榜单数据"）。
 * 只认**今天之前**的文件：今天的文件是这一轮即将覆盖的目标，拿它当"旧数据"没有意义。
 * @param {string} dataDir 数据目录
 * @param {string} today UTC 日期（YYYY-MM-DD）
 * @returns {{ date: string, candidates: object[], classicPool: object[] }|null} 没有可复用的数据时返回 null
 */
function reuseLatestBoard(dataDir, today) {
  const previous = listDates(dataDir).filter((date) => date < today);
  for (const date of previous) {
    const daily = readDaily(dataDir, date);
    const items = (Array.isArray(daily?.boards) ? daily.boards : []).flatMap((board) => Array.isArray(board?.items) ? board.items : []);
    const candidates = items.map(candidateFromItem).filter(Boolean);
    if (candidates.length === 0) continue;
    // 经典榜与周榜共用同一批条目（历史文件里没保存"哪些来自经典池"），所以两边都给一份：
    // 这是降级路径，宁可让经典榜有内容，也不要空着。
    return { date, candidates, classicPool: candidates.map((candidate) => ({ ...candidate, repo: { ...candidate.repo } })) };
  }
  return null;
}

/**
 * 跑完一轮采集：发现 → 富化 → 免费/付费涨星 → 三榜 → 落盘 → 导出。
 *
 * @param {object} options
 * @param {string} options.dataDir 数据目录（生产是 public/data）
 * @param {object} [options.client] 注入的网络客户端（离线测试给假实现）
 * @param {{ discover: Function, enrich: Function, resolveVelocity?: Function }} [options.sources]
 *   注入的数据源；缺省时只用 client 自带的降级路径。**离线测试靠它，绝不打网络。**
 * @param {Date} [options.now] 显式的"现在"（默认 new Date()）
 * @param {boolean} [options.offline] 离线模式：一次网络请求都不发
 * @param {number} [options.budget] 本轮额度上限（生产由 cli.mjs 传 45）；用于 R83/R86 的额度判断
 * @param {string} [options.dailyDir] 日报输出目录；给了才写 daily/YYYY-MM-DD.{md,json}
 * @param {object} [options.logger] 形如 console 的日志对象（默认静默）
 * @returns {Promise<{ date: string, boards: object[], apiCalls: object, degraded: boolean,
 *   warnings: string[], markdown: string, json: string, payload: object, wroteDaily: boolean }>}
 */
export async function runCollect({ dataDir, client, sources, now = new Date(), offline = false, budget = ROUND_BUDGET, dailyDir = null, logger } = {}) {
  const ctx = {
    now: now instanceof Date ? now : new Date(),
    date: utcDate(now instanceof Date ? now : new Date()),
    dataDir,
    sources: sources && typeof sources === 'object' ? sources : {},
    client: guardClient(client, offline, { budget, reserve: RESERVED_FOR_PAID_VELOCITY }),
    degraded: false,
    warnings: [],
    candidates: [],
    stats: null,
  };

  // ---- ① 发现候选池 ----
  let discover = { candidates: [], classic: null, trending: null };
  try {
    if (typeof ctx.sources.discover === 'function') discover = readDiscoverResult(await ctx.sources.discover());
  } catch (error) {
    if (error?.name === 'RateLimitError') note(ctx, '拉候选时就遇到额度耗尽（RateLimitError）');
    else note(ctx, `拉候选失败（${error?.message ?? '未知错误'}）`);
  }

  let weekly = asCandidates(discover.candidates).map(normalizeCandidate);
  // 复用旧榜单时，同一批条目也给经典榜当兜底池（见 reuseLatestBoard 的说明）。
  let classicFallback = [];
  // R92（控制者裁定）：复用的候选**不重新富化**。它们的字段就是昨日那份榜单里的值；
  // 再跑一遍富化只会在故障期间（正是复用被触发的时候）把刚救回来的 `hasRelease90d` / `growing`
  // 覆写成这一轮查不到得出的 null —— 复用等于白做。所以这条路径单独剥出"待富化"的列表。
  let reusePath = false;
  if (weekly.length === 0) {
    // R84b（简报第 3 步）：拿不到新候选时，**真的**去复用最近一天已有的榜单，
    // 并把 note 写成事实（哪一天的）。旧实现的告警宣称"本轮只能用已有的数据出榜"，
    // 却从没读过任何已有数据——那本身就是一句假话（本项目修过的同类问题第 10 次）。
    const reused = reuseLatestBoard(dataDir, ctx.date);
    if (reused) {
      weekly = reused.candidates.map(normalizeCandidate);
      classicFallback = reused.classicPool;
      reusePath = true;
      note(ctx, `这一轮没有拿到新的候选，改用 ${reused.date} 已有的榜单（共 ${weekly.length} 条）`);
    } else {
      note(ctx, '这一轮一个候选都没有拿到（搜索可能被额度或网络挡下了），也没有可以复用的旧榜单');
    }
  }

  // ---- R35：trending 空结果是"我们没查到"，不是"今天没有热门项目" ----
  if (typeof discover.trending === 'function') {
    let trending = null;
    try {
      trending = await discover.trending();
    } catch {
      trending = null;
    }
    if (!Array.isArray(trending) || trending.length === 0) {
      note(ctx, 'trending 页面没有解析出任何条目（改版或抓取失败），少了一路免费的涨星交叉验证');
    }
  }

  // ---- ② 富化：先给最可能进榜的候选花额度 ----
  // 排序理由：候选池里"有机会过门槛"的排最前（它们才是这一轮榜单的主角），
  // 其次按收藏数降序。额度不够时，先被牺牲的是最不可能进榜的那些——而不是随机的那些。
  //
  // R92（控制者裁定）：走复用路径时**一个都不富化**（`priority` 为空），候选直接进候选池成榜。
  // 富化是就地的，所以"不改这些对象"就是"保住昨日那份结论"。
  const priority = reusePath ? [] : [...weekly].sort((a, b) =>
    (couldPassGates(b, ctx.now) ? 1 : 0) - (couldPassGates(a, ctx.now) ? 1 : 0)
    || (b.repo?.stars ?? 0) - (a.repo?.stars ?? 0));
  if (reusePath) {
    for (const candidate of weekly) ctx.candidates.push(candidate);
  }

  const weeklyResult = await enrichAll(ctx, priority, { heavy: true });
  // 归因必须准确（R83）：中止只可能来自这两件事，别再把"某个候选超时"报成"额度耗尽"。
  if (weeklyResult.reason === 'quota') note(ctx, `富化到这里额度就留给了涨星速度：已富化 ${weeklyResult.done} 个候选，剩下的留到下一轮`);
  else if (weeklyResult.reason === 'ratelimit') note(ctx, `富化中途遇到额度耗尽（RateLimitError）：已富化 ${weeklyResult.done} 个候选，剩下的留到下一轮`);
  if (weeklyResult.failed > 0) {
    const detail = weeklyResult.failureReasons.length > 0 ? `：${weeklyResult.failureReasons.join('、')}` : '';
    note(ctx, `有 ${weeklyResult.failed} 个候选富化失败（已跳过，其余照常成榜）${detail}`);
  }
  // client 的一般 degraded（某次 5xx/超时）只作为一条 note 反映，**不再**用来中止采集。
  if (ctx.client.stats().degraded === true) note(ctx, '网络客户端报告本轮有请求失败（额度或网络），部分候选的数据可能不完整');

  // ---- R26 / R87：经典榜的池子**只**为经典榜准备，绝不并进周榜候选池 ----
  // R87（控制者裁定）：旧实现把经典池候选推进 ctx.candidates，而 weekly/newbie 就是从那里建的，
  // 于是 ① 能过门槛的经典项目会占掉周榜名额；② 同一仓库可能在同一张榜上出现两次；
  // ③ 那份"字段未知"的副本会拿中性半分，可能盖过真正被评分过的候选。
  // 不并池也不会漏掉谁：一个真该上周榜的项目会被那两路发现查询**独立**发现。
  // R86（控制者裁定）：经典池候选连计费的 release 查询都不做 —— R80 已认定
  // `hasRelease90d` / `growing` 在经典榜没有消费者（它按收藏总数排、不展示三轴分数），
  // 而每个候选一次 release 请求会把整轮 45 次额度吃掉大半，付费涨星阶段就再也跑不到了。
  let classicPool = [];
  if (discover.classic === null) {
    // 注入方没有提供经典池（离线的简易契约）：只能用候选池顶一下，这里如实说明。
    classicPool = asCandidates(ctx.candidates).map(normalizeCandidate);
    note(ctx, '这一轮的采集契约没有提供独立的经典榜候选池，本轮经典榜用的是候选池里的项目');
  } else {
    try {
      classicPool = asCandidates(await discover.classic()).map(normalizeCandidate);
    } catch (error) {
      classicPool = [];
      note(ctx, `经典榜的候选池没拿到（${error?.message ?? '未知错误'}）`);
    }
    if (classicPool.length === 0) {
      classicPool = classicFallback.length > 0 ? classicFallback.map(normalizeCandidate) : asCandidates(ctx.candidates).map(normalizeCandidate);
      note(ctx, `经典榜这一轮一条候选都没有（搜索失败或额度不足），本轮经典榜用的是${classicFallback.length > 0 ? '复用的旧榜单' : '候选池'}里的项目`);
    }
  }

  // ---- ③④ R53：免费级先跑完，再对争榜候选开付费级 ----
  // R92：复用路径下**整段涨星都不跑** —— 阶梯会把昨日那份"实测"结论覆写成这一轮查不到的
  // `source:'none' / gained7d:0`（免费级一样会覆写），那种"复用"等于白做。
  if (typeof ctx.sources.resolveVelocity === 'function' && !reusePath) {
    // ③ 免费级（级别 1/2/3，零请求）：逐个候选先跑一遍，一分额度都不花。
    // 这里递给注入方一个 blockedClient：即使某个假实现（或将来某个真实实现）在免费模式下
    // 仍然想去发请求，也发不出去——"免费级零成本"这条纪律由编排者自己兜住，不靠实现方自觉。
    const freeClient = blockedClient();
    for (const candidate of ctx.candidates) {
      try {
        candidate.velocity = await ctx.sources.resolveVelocity(candidate, { freeOnly: true, client: freeClient, now: ctx.now });
      } catch (error) {
        if (error?.name === 'RateLimitError') { note(ctx, '免费涨星阶段遇到额度耗尽（RateLimitError），本轮到此为止'); break; }
        note(ctx, `${candidate.repo?.ownerRepo ?? '未知项目'} 的涨星速度没解析出来（${error?.message ?? '未知错误'}）`);
      }
    }

    // ④ 付费级只开给"门槛都过、而且真的在争名次"的候选：
    // 免费级已经给出实测/官方转述/历史差值（级别 0-3）的不必再花钱问一遍。
    const contenders = ctx.candidates
      .filter((candidate) => passesGates(candidate.repo, candidate.runnability, ctx.now).ok)
      .filter((candidate) => {
        const source = velocityOf(candidate).source;
        return !(typeof source === 'string' && source !== 'none' && source !== 'events');
      })
      .sort((a, b) => contentionRank(b, ctx.now) - contentionRank(a, ctx.now)
        || (String(a.repo?.ownerRepo ?? '') < String(b.repo?.ownerRepo ?? '') ? -1 : 1))
      .slice(0, MAX_PAID_VELOCITY);

    // R89：付费阶段开始时把硬上限从"预算 - 预留"抬到"预算"。
    // 这是**唯一**能让那 16 次预留真正花出去的动作；不抬就等于把它们扔掉（旧的死代码）。
    ctx.client.setHardLimit(budget);
    let paidRequests = 0;
    for (const candidate of contenders) {
      // 免费级没命中（source:'none'）→ 让阶梯按 0 → 4 的顺序补问一次。
      // 终止条件（R89）：整轮预算用尽、或付费请求已经开到 MAX_PAID_VELOCITY 个。
      // 注意这里用的是 budgetExhausted()（45），**不是** quotaExhausted()（29）——后者是富化的停止线，
      // 拿它当付费阶段的终止条件会让可用量恒为 0。
      if (ctx.client.budgetExhausted()) { note(ctx, '整轮额度用完，涨星速度的付费级没有全部问完，部分项目这一轮只有免费级的结果'); break; }
      if (paidRequests >= MAX_PAID_VELOCITY) break;
      try {
        candidate.velocity = await ctx.sources.resolveVelocity(candidate, { freeOnly: false, client: ctx.client, now: ctx.now });
        paidRequests++;
      } catch (error) {
        if (error?.name === 'RateLimitError') { note(ctx, '付费涨星阶段遇到额度耗尽（RateLimitError），已有数据照常出榜'); break; }
        note(ctx, `${candidate.repo?.ownerRepo ?? '未知项目'} 的涨星速度没解析出来（${error?.message ?? '未知错误'}）`);
      }
    }
  }

  // ---- ⑤ 组装三个榜单 ----
  const boards = BOARDS.map((board) => {
    // R26：经典榜喂**经典池**，周榜与新手榜喂候选池。两个池子的来源、排序键、捞法都不同。
    const pool = board.id === 'classic' ? classicPool : ctx.candidates;
    return { id: board.id, title: board.title, items: buildBoard(board.id, pool, ctx.now) };
  });

  // ---- R41 / R80 / R84：两个三态字段的校验闸门，**只看会被展示分数的那些条目对象本身** ----
  // R80（控制者裁定）：审计范围必须收窄到"周榜与新手榜里真的在争名次的候选"。
  // 原因：经典榜**不参与三轴评分**（spec §4.1，它只按收藏总数排），所以经典池候选的
  // `hasRelease90d` / `extra.growing` **没有任何消费者** —— 为它们记降级，等于把"没人看的字段缺失"
  // 当成"整轮数据不可用"。后果是"狼来了"：一个恒为真的告警等于没有告警，界面会对用户说
  // "本期数据不完整"（而数据其实是完整的），真正出事时反而没人能分辨。
  //
  // R84a（控制者裁定，推翻我上一版按 ownerRepo 反查的写法）：审计**直接读 weekly/newbie
  // 真正产出的那些条目对象**上的三态值。为什么不能按 ownerRepo 反查：同一个仓库可以在两个池里
  // **各有一个对象**（经典池那份没被富化），反查会把"经典池那个副本"当成被展示的候选，
  // 于是点名一个**所有被展示条目其实都产出了**的字段——R80 就被这样绕过去了。
  // 现在每个对象只代表它自己，"榜上条目"与"被审计对象"是同一个引用，没有错配的余地。
  // 两个榜的条目需要去重：同一个候选可能同时进周榜与新手榜（同一引用），不该被数两次。
  const { unknownRelease, unknownGrowth } = auditBoardItems(boards);
  if (unknownRelease > 0) note(ctx, `有 ${unknownRelease} 个候选的 hasRelease90d 是"没问到"（既不是 true 也不是 false），口碑轴的这一项只能给中性半分`);
  if (unknownGrowth > 0) note(ctx, `有 ${unknownGrowth} 个候选的 growing 是"没问到"（还没有 7 天前的历史快照），这一项只能给中性半分`);
  if (ctx.client.stats().degraded === true && !ctx.degraded) note(ctx, '网络客户端报告本轮有请求失败（额度或网络），数据可能不完整');

  // ---- ⑥ 落盘 ----
  // R84b：`writeDaily` 是**整份替换**。今天已经有榜单文件、而这一轮什么内容都没有时，
  // 覆盖过去就等于把已有的数据擦掉换成空榜——宁可跳过写入并如实告警。
  //
  // 注意顺序（R91）：这条 note 必须在 `buildDailyPayload` **之前**记。
  // 否则它只进 warnings 与 Markdown，却不进网站真正读的那份 JSON——"两个输出不一致"，
  // 正是 R85 刚修过的那类隐患。
  const hasContent = boards.some((board) => (Array.isArray(board.items) ? board.items.length : 0) > 0);
  const todayFileExists = readDaily(dataDir, ctx.date) !== null;
  const wroteDaily = hasContent || !todayFileExists;
  if (!wroteDaily) {
    note(ctx, `${ctx.date} 已经有榜单文件，而这一轮没有拿到任何内容，所以没有覆盖它（避免把已有数据擦成空榜）`);
  }

  // generatedAt 用 now 而不是 Date.now()：同一轮输入必须产出逐字节相同的文件（spec §8 的幂等要求，
  // 也让"今天重跑一次"不会在 git diff 里留下一个只有时间戳不同的噪声提交）。
  const generatedAt = ctx.now.toISOString();
  // R128：离线采集用的就是内置样本，所以**采集时**就知道这一天不是真的从网上采来的，把这一位写进
  // 当天数据（真实联网采集不写）。页面按当天数据标注，于是"样本数据被当成今天的热门项目展示"
  // 这条路被堵住——不管它是被 serve --demo 服务、还是被 collect --offline 写进真实数据目录。
  const payload = buildDailyPayload(boards, ctx.date, {
    generatedAt, degraded: ctx.degraded, notes: ctx.warnings, demo: offline === true,
  });
  if (wroteDaily) {
    writeDaily(dataDir, ctx.date, payload);
    updateIndex(dataDir);
    appendHistory(dataDir, ctx.date, snapshotMapOf(boards));
  }

  // ---- ⑦ 导出 ----
  // R85（控制者裁定）：Markdown 与 JSON **同源**。旧实现把 RankedItem 直接交给 markdown 渲染器，
  // 而渲染器读的是 JSON 条目上的 `install` / `scores`，于是"装法/下载链接"那两个分支永远不可执行
  // ——日报里从来没有出现过安装方式。现在先构造 payload，再据**同一份 payload** 渲染两边，
  // 两者不可能不一致（同一个对象，又是在同一处序列化）。
  const markdown = renderDailyMarkdown(payload, { degraded: ctx.degraded, notes: ctx.warnings });
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  if (typeof dailyDir === 'string' && dailyDir !== '') writeDailyFiles(dailyDir, ctx.date, markdown, json);

  const apiCalls = ctx.client.stats();
  logger?.log?.(`本轮用了 ${apiCalls.coreCalls} 次 core 请求、${apiCalls.searchCalls} 次 search 请求，降级：${ctx.degraded}`);
  for (const warning of ctx.warnings) logger?.warn?.(warning);

  return { date: ctx.date, boards, apiCalls, degraded: ctx.degraded, warnings: [...ctx.warnings], markdown, json, payload, wroteDaily };
}

/**
 * 把三个榜单里出现过的仓库汇成历史快照（[日期][ownerRepo] 二级键，见 datastore.appendHistory）。
 * @param {{ items: object[] }[]} boards
 * @returns {Map<string, { stars: number, forks: number }>}
 */
function snapshotMapOf(boards) {
  const snapshot = new Map();
  for (const board of Array.isArray(boards) ? boards : []) {
    for (const item of Array.isArray(board?.items) ? board.items : []) {
      const repo = item?.repo ?? {};
      if (typeof repo.ownerRepo !== 'string' || repo.ownerRepo === '') continue;
      snapshot.set(repo.ownerRepo, { stars: repo.stars ?? 0, forks: repo.forks ?? 0 });
    }
  }
  return snapshot;
}

/**
 * 把日报的 Markdown 与 JSON 写进 daily/ 目录（spec §5.3 第 ⑦ 步）。
 * @param {string} dir 输出目录（生产是 daily/）
 * @param {string} date UTC 日期（YYYY-MM-DD）
 * @param {string} md Markdown 文本
 * @param {string} json JSON 文本
 */
export function writeDailyFiles(dir, date, md, json) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${date}.md`), md, 'utf8');
  writeFileSync(join(dir, `${date}.json`), json, 'utf8');
}

// 日报的导出与渲染函数也在这里透出：Task 16/17 的导出与测试都能从同一处取，不必再记住导出层的路径。
// 注意 markdown 与 json 现在都**由同一份 payload 渲染**（R85），renderDailyJson 因此不再需要：
// 它是"从 boards 重新构造一份 payload"的入口，而那条路正是两者可能不一致的来源。
export { buildDailyPayload, renderDailyMarkdown };

// GitHub 好玩榜 —— "为什么上榜"的中文理由与置信度文案。
// 这里只做确定性的字符串拼装：不读文件、不发网络请求、不调大模型，
// 同一个输入永远得到同样的句子，可以单测、可以追溯（spec §6.3）。
// 所有用户可见的句子都必须走 spec §4.3 的术语翻译表——界面上不出现 star / fork / issue 这类行话。
// 时间相关的判断走显式参数 now（默认 new Date() 只是方便调用），和 score.mjs 的约定一致。

const DAY_MS = 24 * 60 * 60 * 1000;

// 最多给 5 条理由：详情页一屏看得完，宁缺毋滥。
const MAX_REASONS = 5;

// "作者近 7 天仍在更新"的判定阈值，与 spec §6.1 近期提交活跃的 ≤7 天口径一致。
const RECENT_PUSH_DAYS = 7;

// 涨星速度的三种置信度 → 前缀与括号说明（spec §7.3：界面必须诚实，估算就写"约"）。
const CONFIDENCE_TEXT = new Map([
  ['measured', { lead: '', tail: '（实测）' }],
  ['estimated', { lead: '约', tail: '（估算）' }],
  ['reported', { lead: '', tail: '（GitHub 官方数据）' }],
]);

// 安装方式（RUNNABLE_POINTS 的键）→ 新手看得懂的一句话，spec §6.1 的安装路径分档。
const INSTALL_TEXTS = new Map([
  ['releaseWindows', '有现成的 Windows 安装包，下载就能用'],
  ['npmBinWin', '在 Windows 上敲一行命令就装好了'],
  ['pypiCompatible', '有现成的安装包，跟着三步走就行'],
  ['npmNoBin', '要先装好 Node，再照说明敲命令'],
  ['buildFromSource', '要自己动手编译，适合愿意折腾的人'],
  ['dockerOnly', '要先用 Docker 装好才行，适合愿意折腾的人'],
  // R73：这一句曾经是"暂时没有现成的安装方式，得自己动手"，但那是在断言**项目的事实**，
  // 而这一档恰恰是我们不知道的状态——classifyRunnability 走到 'none' 的常见成因正是证据缺失
  // （没查到包、查到的包无法确认属于该项目、命令行工具不支持 Windows），
  // 所以在 none 档只能报告**我们自己查找的结果**，并给一条能走的下一步（与 runnability.mjs
  // 的「我们没有找到可以放心推荐给你的安装方式」同一口径）。
  ['none', '我们没有找到可以放心推荐给你的安装方式，可以打开项目主页自己看一眼'],
]);

// kind 认不出来（缺失或未知）但分数说有安装路径时用这句：知道有路可走，只是不知道是哪一种。
const INSTALL_GENERIC_TEXT = '有现成的安装方式，跟着说明就能装好';

/**
 * 安装方式的一句话。必须区分"我们有话说"和"没人告诉我们有没有"：
 * - kind 认识（含 'none'）→ 照表说话；注意 'none' 那一句说的是**我们的查找动作**，不是项目的事实：
 *   走到 'none' 的常见成因是证据缺失（没查到包、包无法确认属于该项目、命令行工具不支持 Windows），
 *   此时我们并不知道这个项目有没有安装方式，不能替它下否定结论（R70/R73 同一口径）；
 * - kind 缺失或未知 → 仅在 installPath > 0 时给泛化句；连分数都没有就什么都不说（返回 ''），
 *   因为 score.mjs 把未知 kind 也记 0 分，0 分不等于"确定没有安装方式"。
 * @param {string} [kind] RUNNABLE_POINTS 的键
 * @param {number} [installPath] 安装路径分（0-18）
 * @returns {string} 没有证据时为 ''
 */
function installText(kind, installPath) {
  const known = INSTALL_TEXTS.get(kind);
  if (known) return known;
  return installPath > 0 ? INSTALL_GENERIC_TEXT : '';
}

/**
 * 把涨星速度包装成一句给用户看的话，括号里如实标注数据置信度。
 * 没有可用的新增数（缺失、0、负数、非数字）时返回空字符串，让调用方跳过这一条，
 * 而不是编一个"本周新增收藏 0"。置信度不认识时退化成不带括号的说法，不假装实测。
 * @param {{ gained7d?: number, confidence?: string }} [velocity]
 * @returns {string} 例如 '本周新增收藏 1,234（实测）'；无数据时为 ''
 */
export function formatVelocityText(velocity) {
  const gained = velocity?.gained7d;
  if (!Number.isFinite(gained) || gained <= 0) return '';
  const { lead = '', tail = '' } = CONFIDENCE_TEXT.get(velocity?.confidence) ?? {};
  return `本周新增收藏${lead} ${gained.toLocaleString('zh-CN')}${tail}`;
}

/**
 * 生成中文上榜理由（最多 5 条），按"最想知道的排最前"排序：
 * 本周新增收藏 → 怎么装 → 有没有中文说明 → 作者还管不管这个项目。
 * 缺字段、空对象、null 都不抛错；拿不到的事实就不写，绝不瞎猜——完全没有证据时返回空数组，
 * 不为了让理由看起来多几条而编造断言（'none' 档同样只能说我们自己的查找动作，绝不替项目下结论，R73）。
 * @param {{ score?: { parts?: object }, repo?: object, velocity?: object, runnability?: object }} [input]
 *   score 来自 scoreRepo（用到 parts 里的 installPath、chinese、pushRecency、license），
 *   runnability 形如 { kind, chineseDoc, verified }，
 *   repo 形如 { archived, pushedAt, hasRelease90d }——其中 hasRelease90d 是 R40 的三态事实
 *   （true 确认近 90 天发过版 / false 确认没有 / null 没问到），只有 true 才产出"发过新版本"这句（R50）
 * @param {Date} [now] 显式传入"现在"，用于判断 pushedAt 是不是近 7 天；非 Date 则不看时间
 * @returns {string[]} 0 到 5 条中文短句
 */
export function buildReasons(input = {}, now = new Date()) {
  const { score, repo, velocity, runnability } = input ?? {};
  const parts = score?.parts ?? {};
  const info = repo ?? {};
  const run = runnability ?? {};
  const nowTs = now instanceof Date ? now.getTime() : NaN;

  const reasons = [];

  // 1. 本周新增收藏：热度是"为什么上榜"里用户最先想看的。
  const growth = formatVelocityText(velocity);
  if (growth) reasons.push(growth);

  // 2. 怎么装：新手最关心"我到底装不装得上"。没有证据时不写这一条。
  const install = installText(run.kind, parts.installPath);
  if (install) reasons.push(install);

  // 3. 有没有中文说明：分数里有中文分就说明有，不必重复传 chineseDoc。
  if (run.chineseDoc === true || parts.chinese > 0) {
    reasons.push('有中文说明，照着做不容易卡住');
  }

  // 4. 作者还管不管这个项目。已归档的项目只给一句诚实结论："仍在更新""最近发过新版本"都与
  //    "已停止维护"自相矛盾（spec §4.3），所以不给；许可证那条则是归档也不影响的事实，放到分支外。
  if (info.archived === true) {
    reasons.push('作者已停止维护');
  } else {
    if (isRecentlyPushed(info.pushedAt, nowTs) || parts.pushRecency > 0) {
      reasons.push('作者近 7 天仍在更新');
    }
    // 近 90 天有发版是拿得到的事实（releases.mjs 的列表端点；R40 三态），**读事实，不读分数**：
    // 只有 repo.hasRelease90d === true（确认近期发过版）才说这句；false（确认没有）与
    // null/undefined（没问到）都不说。为什么不能读 parts.release90d > 0：R40 给"未知"记的是
    // 中性半分 3 分，3 > 0 会让"没问到"也出这句话——把"没问到"说成"确认如此"，
    // 正是本项目修过三次的同类缺陷，方向更糟（它直接进界面文案）。
    // 读事实还有两个好处：不必依赖 DETAIL_WEIGHTS.release90d 的具体数值（日后调分不会静默改变
    // 文案行为），且与 score.mjs 用的是同一份事实，两层不可能再分叉。
    if (info.hasRelease90d === true) {
      reasons.push('作者最近还发过新版本');
    }
  }
  if (parts.license > 0) {
    reasons.push('有明确的开源许可证，能放心用');
  }

  return reasons.slice(0, MAX_REASONS);
}

/**
 * pushedAt 是否在近 RECENT_PUSH_DAYS 天内。pushedAt 解析不出来或没有可用的"现在"时返回 false，
 * 由调用方退回看 score.parts.pushRecency（那个分本身就是按 ≤7 天给的）。
 * @param {string} [pushedAt] ISO 时间串
 * @param {number} nowTs "现在"的时间戳，非数字表示无法判断
 * @returns {boolean}
 */
function isRecentlyPushed(pushedAt, nowTs) {
  const ts = Date.parse(pushedAt);
  if (!Number.isFinite(ts) || !Number.isFinite(nowTs)) return false;
  return nowTs - ts <= RECENT_PUSH_DAYS * DAY_MS;
}

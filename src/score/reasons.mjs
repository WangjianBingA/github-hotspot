// GitHub 好玩榜 —— "为什么上榜"的中文理由与置信度文案。
// 这里只做确定性的字符串拼装：不读文件、不发网络请求、不调大模型，
// 同一个输入永远得到同样的句子，可以单测、可以追溯（spec §6.3）。
// 所有用户可见的句子都必须走 spec §4.3 的术语翻译表——界面上不出现 star / fork / issue 这类行话。
// 时间相关的判断走显式参数 now（默认 new Date() 只是方便调用），和 score.mjs 的约定一致。

import { DETAIL_WEIGHTS } from '../config/weights.mjs';

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
  ['none', '暂时没有现成的安装方式，得自己动手'],
]);

// kind 认不出来但分数说有安装路径时用这句，不要凭空说"没有现成的安装方式"。
const INSTALL_GENERIC_TEXT = '有现成的安装方式，跟着说明就能装好';

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
 * 生成 3-5 条中文上榜理由，按"最想知道的排最前"排序：
 * 本周新增收藏 → 怎么装 → 有没有中文说明 → 作者还管不管这个项目。
 * 缺字段、空对象、null 都不抛错：拿不到的事实就不写，绝不瞎猜。
 * @param {{ score?: { parts?: object }, repo?: object, velocity?: object, runnability?: object }} [input]
 *   score 来自 scoreRepo（用到 parts 里的 installPath、chinese、pushRecency、issueClosure、license），
 *   runnability 形如 { kind, chineseDoc, verified }
 * @param {Date} [now] 显式传入"现在"，用于判断 pushedAt 是不是近 7 天；非 Date 则不看时间
 * @returns {string[]} 1 到 5 条中文短句
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

  // 2. 怎么装：新手最关心"我到底装不装得上"。
  reasons.push(INSTALL_TEXTS.get(run.kind) ?? (parts.installPath > 0 ? INSTALL_GENERIC_TEXT : INSTALL_TEXTS.get('none')));

  // 3. 有没有中文说明：分数里有中文分就说明有，不必重复传 chineseDoc。
  if (run.chineseDoc === true || parts.chinese > 0) {
    reasons.push('有中文说明，照着做不容易卡住');
  }

  // 4. 作者还管不管这个项目。已归档的项目只给一句诚实结论：
  //    不得再说"仍在更新"，也不该同时说"作者很管事"（自相矛盾，spec §4.3）。
  if (info.archived === true) {
    reasons.push('作者已停止维护');
  } else {
    if (isRecentlyPushed(info.pushedAt, nowTs) || parts.pushRecency > 0) {
      reasons.push('作者近 7 天仍在更新');
    }
    if (parts.issueClosure >= DETAIL_WEIGHTS.issueClosure) {
      reasons.push('作者很管事，大家的提问大多有人回应');
    }
    if (parts.license > 0) {
      reasons.push('有明确的开源许可证，能放心用');
    }
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

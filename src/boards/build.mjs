// GitHub 好玩榜 —— 榜单组装层（spec §4.1、§6.2、§6.4）。
// 只把"候选 + 分数 + 门槛"拼成榜单：不读文件、不发网络请求、不调大模型，
// 时间一律走显式参数 now（默认 new Date() 只是为了调用方便），同一输入永远得到同一榜单。
// 排序必须确定：先按本榜的排序键降序，同分再按 ownerRepo 字典序升序，重复跑不会漂。

import { BOARDS } from '../config/boards.mjs';
import { scoreRepo, passesGates } from '../score/score.mjs';
import { buildReasons } from '../score/reasons.mjs';

// 经典榜的口径：全站收藏 Top N，不参与三轴评分、也不看门槛（spec §4.1）。
const CLASSIC_ID = 'classic';

/**
 * 每个榜单按哪个字段排序。
 * - total / runnable：三轴评分里的分（scoreRepo 的结果）；
 * - stars：仓库原始收藏数（经典榜专用，它不是评分）。
 */
const SORT_VALUES = {
  total: (scored) => scored.score.total,
  runnable: (scored) => scored.score.runnable,
  stars: (scored) => scored.repo.stars,
};

/**
 * 候选能不能进"新手能玩"（spec §6.4）：过了硬门槛之后，还要排除纯资源清单类——
 * 语言为空或只有 Markdown、且没有已核实的安装方式。这类项目只在经典榜里补课。
 * 注意门槛已经把"没有已核实安装方式"挡下了，这里的 kind === 'none' 是第二道保险。
 * @param {object} candidate
 * @returns {boolean}
 */
function isNewbieFriendly(candidate) {
  const { repo, runnability } = candidate;
  if (!repo?.language) return false;
  if (repo.language === 'Markdown') return false;
  return runnability?.kind !== 'none';
}

/**
 * 榜单排序：先按排序键降序，同分按 ownerRepo 字典序升序。
 * ownerRepo 认不出来时退化成空串参与比较，保证顺序永远确定，不会因为 undefined 变成 NaN 比较。
 * @param {(scored: object) => number} sortValue
 * @returns {(a: object, b: object) => number}
 */
function comparator(sortValue) {
  return (a, b) => {
    const av = sortValue(a);
    const bv = sortValue(b);
    const diff = (Number.isFinite(bv) ? bv : 0) - (Number.isFinite(av) ? av : 0);
    if (diff !== 0) return diff;
    return String(a.repo?.ownerRepo ?? '').localeCompare(String(b.repo?.ownerRepo ?? ''));
  };
}

/**
 * 把一个候选算成榜单条目：分数、等级、中文标记、中文理由都算好，rank 留到最后统一编。
 * @param {{ repo: object, runnability?: object, velocity?: object, extra?: object }} candidate
 * @param {Date} now
 * @returns {object} 不含 rank 的中间结果
 */
function toScored(candidate, now) {
  const { repo, runnability, velocity, extra } = candidate;
  const score = scoreRepo({ repo, runnability, velocity, extra }, now);
  return {
    repo,
    runnability,
    velocity,
    score,
    grade: score.grade,
    chineseDoc: runnability?.chineseDoc === true,
    reasons: buildReasons({ score, repo, velocity, runnability }, now),
  };
}

/**
 * 组装一个榜单（spec §4.1）。
 * - weekly：过门槛的候选按三轴总分降序；
 * - newbie：过门槛、且不是纯资源清单类的候选按新手友好分降序；
 * - classic：不看门槛、不看评分，所有候选按收藏数降序。
 * 三个榜都截断到 BOARD_SIZES 规定的条数，rank 从 1 开始连续编号；
 * 同一个仓库进两个榜时各自独立排名。
 * @param {'weekly'|'newbie'|'classic'} boardId
 * @param {{ repo: object, runnability?: object, velocity?: object, extra?: object }[]} items 候选列表
 * @param {Date} [now] 显式传入"现在"，用于门槛的"近 7 天有提交"；默认 new Date()
 * @returns {{ rank: number, repo: object, runnability: object, velocity: object,
 *   score: object, grade: string, chineseDoc: boolean, reasons: string[] }[]}
 *   认不出的 boardId 返回空榜，不抛错（榜单清单以 config/boards.mjs 为准）。
 */
export function buildBoard(boardId, items, now = new Date()) {
  const board = BOARDS.find((b) => b.id === boardId);
  const list = Array.isArray(items) ? items : [];
  if (!board) return [];

  const keep = (candidate) => {
    // 经典榜只按收藏数排，不参与三轴评分、也不看门槛（spec §4.1）。
    if (boardId === CLASSIC_ID) return true;
    if (!passesGates(candidate.repo, candidate.runnability, now).ok) return false;
    // 新手榜再过一道：纯资源清单类不进来（spec §6.4），它们只在经典榜里补课。
    return boardId === 'newbie' ? isNewbieFriendly(candidate) : true;
  };

  const sortValue = SORT_VALUES[board.sortBy];
  return list
    .filter((candidate) => candidate?.repo)
    .filter(keep)
    .map((candidate) => toScored(candidate, now))
    .sort(comparator(sortValue))
    .slice(0, board.size)
    .map((scored, i) => ({ rank: i + 1, ...scored }));
}

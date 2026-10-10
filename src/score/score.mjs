// GitHub 好玩榜 —— 评分纯函数层。
// 这里只做确定性计算：不读文件、不发网络请求、不读时钟，同样的输入永远得到同样的输出。
// 本文件按任务推进逐步扩充，Task 3 只实现热度分。

import { WEIGHTS, HOT_REFERENCE_STARS_PER_WEEK } from '../config/weights.mjs';

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

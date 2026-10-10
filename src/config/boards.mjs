// GitHub 好玩榜 —— 三个榜单的定义（spec §4.1）。
// 条数只从 weights.mjs 的 BOARD_SIZES 取，这里绝不重复写数字：
// 榜单条数若有两处出处，早晚会对不上。
// sortBy 是"按哪个数排序"的键名，对应的取值口径写在 src/boards/build.mjs 里。

import { BOARD_SIZES } from './weights.mjs';

export const BOARDS = [
  { id: 'weekly', title: '本周飙升', size: BOARD_SIZES.weekly, sortBy: 'total' },
  { id: 'newbie', title: '新手能玩', size: BOARD_SIZES.newbie, sortBy: 'runnable' },
  { id: 'classic', title: '经典必玩', size: BOARD_SIZES.classic, sortBy: 'stars' },
];

// GitHub 好玩榜 —— 评分权重与分档常量的唯一出处。
// 所有分值都只在这里定义，评分函数与后续任务一律 import 本文件，不得就地写死数字。
// 依据：docs/superpowers/specs/2026-10-10-github-app-store-design.md §6.1。

// 三条评分轴的满分，合计 100。
// 注意：runnable 这个键名虽然界面上叫"新手友好"，但 JSON 结构与后续任务都用 runnable，不要改名。
export const WEIGHTS = { hot: 45, reputation: 30, runnable: 25 };

// 热度分的归一化参考值：7 日新增收藏达到这个数即拿满分。
export const HOT_REFERENCE_STARS_PER_WEEK = 3000;

// 三个榜单各取多少条。榜单条数只认这里，其他地方不得重复写数字。
export const BOARD_SIZES = { weekly: 15, newbie: 15, classic: 30 };

// 口碑轴的子项分值（合计 30）。
export const DETAIL_WEIGHTS = {
  forkRatio: 6,
  issueClosure: 8,
  pushRecency: 6,
  release90d: 4,
  license: 3,
  growth: 3,
};

// 新手友好轴的"安装路径"分档分值（满分 18）：按从易到难优先匹配一档。
export const RUNNABLE_POINTS = {
  releaseWindows: 18,
  npmBinWin: 16,
  pypiCompatible: 14,
  npmNoBin: 8,
  buildFromSource: 6,
  dockerOnly: 4,
  none: 0,
};

// 新手友好轴的"中文文档"分值（合计 7）：README 中文占比达阈值给 4 分，
// 另有 README.zh-CN.md 一类的本地化文件再给 3 分。
export const CHINESE_POINTS = { readmeRatio: 4, localizedFile: 3 };

// 判定 README 含中文的字符占比阈值（实测校准：HelloGitHub 5.35% 命中，markitdown 0% 排除）。
export const CHINESE_RATIO_THRESHOLD = 0.03;

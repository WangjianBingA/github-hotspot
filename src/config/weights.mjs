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

// 口碑轴的子项分值（合计 30）。五项都只用真实拿得到的字段，没有数据的子项一律给中性分而不是判死。
// 刻意不含"issue 处理率"：GitHub 的仓库详情与 search 结果里都没有 closed_issues，那个子项在生产
// 环境恒为 0，会凭空断言"作者不管事"，详见 spec §6.1 的修订说明。
export const DETAIL_WEIGHTS = {
  forkRatio: 8,
  pushRecency: 8,
  release90d: 6,
  license: 4,
  growth: 4,
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

// 新手友好轴的"中文说明"分值（满分 7）：**要么 7 分、要么 0 分**，不按比例。
// R143：判据是"真有中文"（detectChinese 的 hasChinese：中文文件名的本地化文件，或正文汉字占比达标
// 且不是假名主导）。**不是** hasCjk —— 那个更宽的信号含着假名与谚文，只有 README.ja.md 的项目
// 会因此白拿这 7 分，而这条轴、口径页、README、手册都把它叫「中文说明」。
// readmeRatio / localizedFile 是**同一件事的两种证据**（满足其一就给满，见 scoreRunnable 的
// `hasChinese === true ? 两者之和 : 0`），留在这里是为了让"7 分怎么来的"可查。
export const CHINESE_POINTS = { readmeRatio: 4, localizedFile: 3 };

// 判定"有本地化文档/有中文"的字符占比阈值（实测校准：HelloGitHub 5.35% 命中，markitdown 0% 排除）。
// 注意两条判定用的是同一个阈值、不同的分子：hasCjk 数完整 CJK 类（含假名谚文），
// hasChinese 只数汉字 —— 见 enrich/readme.mjs 的 detectChinese。
export const CHINESE_RATIO_THRESHOLD = 0.03;

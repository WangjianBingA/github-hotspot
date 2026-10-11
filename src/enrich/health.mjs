// GitHub 好玩榜 —— 口碑轴（reputation）输入映射。
//
// 口碑分的算术**全部**在 src/score/score.mjs 的 scoreReputation 里（纯函数，口径写在它的 JSDoc）。
// 本模块只负责一件事：把仓库对象（可能来自 GitHub search/详情、字段可能缺失或类型不对）
// 映射成那个函数认的输入形状，把"没问到"如实保留成 null，绝不在映射层替它下结论、更不算分。
//
// 为什么单独放 health.mjs：口碑轴的输入装配属于富化层（enrich），与 README 证据（readme.mjs）职责不同。
// 实现只有一份，readme.mjs 导出同一函数供 Task 13 的汇报接口使用，两个入口指向同一个函数对象。
//
// 三态约定（与 releases.mjs 的 R40 一致）：hasRelease90d 的 null 表示"没问到"，
// score.mjs 会给中性半分；把 null 写成 false 就是"确认近 90 天没有发版"这句没有证据的断言。

export { buildReputationInput } from './readme.mjs';

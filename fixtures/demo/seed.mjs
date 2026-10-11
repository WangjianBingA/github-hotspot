// GitHub 好玩榜 —— 离线演示数据的生成器与投放器（Task 18）。
//
// 为什么要有它：网站读的是 public/data/ 里的采集产物，而那个目录被 .gitignore 排除（它是产物，
// 不该进版本库）。结果是**刚克隆下来的人打开首页只会看到"还没有任何榜单数据"**。
// `npm run demo`（也就是 serve --demo）会用这里的一份自带数据起本地预览，页面上明确标着
// 「演示数据（示例）」并说清它代表哪一天（R127：绝不让演示数据冒充"刚采集到的真实数据"）。
//
// 两个动作分工清楚：
//   · generateDemoData(dir)：**生成**。真跑离线管线——sources/pipeline 的离线源 → collect.mjs 的
//     编排 → exporters/json.mjs 的日报对象 → store/datastore.mjs 落盘。分数、排序、上榜理由、
//     安装向导全部来自正式代码，这里一个字都不手写（测试会把生成结果与已提交的数据逐字节比对）。
//   · seedDemoData(dir)：把**已生成好、并且已经提交进版本库**的 dataset/ 原样复制到目标目录。
//     serve --demo 走这一条，于是"浏览器里看到的那份数据"与"仓库里那一份"是同一批字节。
//
// 重新生成的办法（改了评分规则、或想换演示日期时）：
//   node fixtures/demo/seed.mjs --write
// 生成完记得把 fixtures/demo/dataset/ 的变化一起提交 —— test/demo.test.mjs 会盯住两者一致。
//
// 为什么目录叫 dataset 而不是 data：.gitignore 里的 `data/` 会忽略**任何**叫 data 的目录
// （采集产物 public/data 与缓存 data/ 都靠它），而演示数据是"新克隆也必须看得见"的交付物。

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCollect } from '../../src/collect.mjs';
import { createOfflineSources } from '../../src/sources/pipeline.mjs';
import { updateIndex } from '../../src/store/datastore.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 演示数据覆盖的三天（升序）。
 * 最后一天固定为 2026-10-10：演示日期写死，页面上的"它代表哪一天"才是确定的、可被断言的。
 */
export const DEMO_DATES = ['2026-10-08', '2026-10-09', '2026-10-10'];

/** 已提交的演示数据集目录（seedDemoData 从这里复制）。 */
export const DEMO_DATA_DIR = fileURLToPath(new URL('./dataset/', import.meta.url));

// 三天之间的差别：从最新一天往回数，每早一天，收藏人数少 2%、这一周的新增少 6%，
// 最后一次更新时间也往前挪一天。为什么要有差别：三天一模一样的话，"回看历史"这件事在演示里
// 根本看不出来（日期选择器与归档页都成了摆设）。折算规则只写在这一处，看得见、可复算。
const STARS_BACKSTEP = 0.02;
const FORKS_BACKSTEP = 0.02;
const GAINED_BACKSTEP = 0.06;

/** 只折算有限的数字，其余原样带过（缺字段不等于 0）。 */
const scaleCount = (value, step, daysBack) => (Number.isFinite(value) ? Math.round(value * (1 - step * daysBack)) : value);

/**
 * 把一条候选折算成"更早那一天"的样子。
 * 只改**能观测到的数字事实**（收藏、拿去改造的人数、最后一次更新时间、本周新增），
 * 不动结论与文案：等级、中文标记、安装方式、取证结果都保持原样，由正式管线重新算分、重新排序。
 * @param {object} candidate 离线 fixture 里的一条候选
 * @param {number} daysBack 距离最新一天几天（0 表示最新那天）
 * @returns {object} 折算后的候选
 */
function scaleCandidate(candidate, daysBack) {
  if (daysBack <= 0 || candidate === null || typeof candidate !== 'object') return candidate;
  const repo = { ...candidate.repo };
  repo.stars = scaleCount(repo.stars, STARS_BACKSTEP, daysBack);
  repo.forks = scaleCount(repo.forks, FORKS_BACKSTEP, daysBack);
  if (typeof repo.pushedAt === 'string') {
    const pushedAt = Date.parse(repo.pushedAt);
    // 更早那一天里"最后一次更新"必须在过去：不然会出现"这个项目明天更新过"这种读着就不对的数据。
    if (Number.isFinite(pushedAt)) repo.pushedAt = new Date(pushedAt - daysBack * DAY_MS).toISOString();
  }
  const velocity = candidate.velocity && typeof candidate.velocity === 'object'
    ? {
      ...candidate.velocity,
      gained7d: scaleCount(candidate.velocity.gained7d, GAINED_BACKSTEP, daysBack),
      gained3d: scaleCount(candidate.velocity.gained3d, GAINED_BACKSTEP, daysBack),
    }
    : candidate.velocity;
  return { ...candidate, repo, velocity };
}

/**
 * 离线源 + 这一天的折算。discover 的两条路（候选池与经典池）都要折算，
 * 否则经典榜会拿到没折算过的那份，三天的差别就只出现一半。
 * @param {number} daysBack 距离最新一天几天
 * @returns {{ discover: Function, enrich: Function }} 与 createOfflineSources 同形状
 */
function scaledSources(daysBack) {
  const base = createOfflineSources();
  const scale = (candidate) => scaleCandidate(candidate, daysBack);
  return {
    async discover() {
      const found = await base.discover();
      return {
        candidates: (Array.isArray(found?.candidates) ? found.candidates : []).map(scale),
        classic: async () => {
          const pool = await found.classic();
          return (Array.isArray(pool) ? pool : []).map(scale);
        },
      };
    },
    async enrich(candidate) {
      return candidate; // 离线 fixture 本来就是"富化后"的形状（与 createOfflineSources 一致）
    },
  };
}

/**
 * 生成演示数据集并写进 dataDir（覆盖同名文件，幂等）。
 * 走的是正式代码路径：一轮运行 = 一次真正的离线采集，只是"现在"被固定在演示日期上。
 * @param {string} dataDir 目标数据目录
 * @returns {Promise<string>} 写好的数据目录
 */
export async function generateDemoData(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('generateDemoData 需要一个数据目录');
  for (const [index, date] of DEMO_DATES.entries()) {
    const daysBack = DEMO_DATES.length - 1 - index;
    const result = await runCollect({
      dataDir,
      sources: scaledSources(daysBack),
      now: new Date(`${date}T00:00:00.000Z`),
      offline: true,
    });
    // 演示数据必须是"完整的一份"：少了内容却照样标注成演示数据，等于把一份残缺的榜单端给用户。
    if (result.wroteDaily !== true || result.degraded === true) {
      throw new Error(`演示数据没生成完整：${date}（degraded=${result.degraded}）${result.warnings.join('；')}`);
    }
  }
  // 最后落清单，并显式写下"这是演示数据"（R127：页面据此标注，不靠猜）。
  updateIndex(dataDir, { demo: true });
  return dataDir;
}

/**
 * 把已提交的演示数据原样复制进 dataDir（同一批文件覆盖同一批文件，重复调用幂等）。
 * serve --demo 用它：起服务之前先把数据放好，源目录缺失时能在这里就报清楚，
 * 而不是让页面上一片空白、用户以为是网站坏了。
 * @param {string} dataDir 目标数据目录
 */
export function seedDemoData(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('seedDemoData 需要一个数据目录');
  if (!existsSync(join(DEMO_DATA_DIR, 'index.json'))) {
    throw new Error(`演示数据不在（${DEMO_DATA_DIR}）。运行 node fixtures/demo/seed.mjs --write 重新生成一份`);
  }
  mkdirSync(join(dataDir, 'history'), { recursive: true });
  for (const entry of readdirSync(DEMO_DATA_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) continue; // 子目录（history）单独处理一层
    copyFileSync(join(DEMO_DATA_DIR, entry.name), join(dataDir, entry.name));
  }
  for (const entry of readdirSync(join(DEMO_DATA_DIR, 'history'), { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    copyFileSync(join(DEMO_DATA_DIR, 'history', entry.name), join(dataDir, 'history', entry.name));
  }
}

// 重新生成已提交的那份演示数据：node fixtures/demo/seed.mjs --write [目标目录]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--write');
  const target = at === -1 ? null : (args[at + 1] ?? DEMO_DATA_DIR);
  if (target === null) {
    process.stderr.write('用法：node fixtures/demo/seed.mjs --write [数据目录]（默认写回 fixtures/demo/dataset/）\n');
    process.exitCode = 2;
  } else {
    await generateDemoData(target);
    process.stdout.write(`演示数据已重新生成：${target}\n`);
  }
}

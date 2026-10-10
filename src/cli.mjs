// GitHub 好玩榜 —— 命令行入口。
//
//   collect          采集 GitHub 热门项目，写入 JSON 数据（日报另写 daily/）
//   collect --offline  不发任何网络请求，用 fixtures/candidates.json 出一份完整榜单
//   serve / serve --demo  本地静态站点（Task 16 实现）
//   export           导出榜单数据（后续任务实现）
//
// 分工：本文件只负责"装配"——读环境变量、建网络客户端与缓存、选真实或离线管线，
// 然后交给 src/collect.mjs 的 runCollect 去编排。**编排逻辑一行都不在这里**，
// 否则离线测试跑的就成了另一条路径。

import { pathToFileURL } from 'node:url';
import { RateLimitError, createClient } from './net/client.mjs';
import { createFileCache } from './net/file-cache.mjs';
import { runCollect } from './collect.mjs';
import { createOfflineSources, createRealSources } from './sources/pipeline.mjs';

const USAGE = `用法：node src/cli.mjs <命令>

可用命令：
  collect            采集 GitHub 热门项目，写入 JSON 数据
  collect --offline  断网也能跑：用内置样本出一份完整榜单
  serve              启动本地静态站点服务
  serve --demo       使用演示数据启动本地静态站点服务
  export             导出榜单数据

对应的 npm 脚本：
  npm run collect
  npm start
  npm run demo
`;

// spec §5.5：本地未认证额度是 core 60/小时，一轮采集的**总预算上限**取 45 次。
// 这是"整轮"的预算（core + search 一起算）：net/client 按实际发出的请求扣减，用尽即返回 null，
// runCollect 看到 stats().degraded 就立刻收工并把整轮标成 degraded——绝不静默超支。
const ROUND_BUDGET = 45;
const DEFAULT_DATA_DIR = 'public/data';
const DEFAULT_DAILY_DIR = 'daily';
const DEFAULT_CACHE_PATH = 'data/cache.json';

/**
 * 命令行主函数。
 * @param {string[]} argv 命令行参数（不含 node 可执行文件与脚本路径）
 * @param {{ env?: object, logger?: object }} [options] 注入的环境与日志（测试用；默认读 process.env / console）
 * @returns {Promise<number>} 进程退出码
 */
export async function main(argv, options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;

  switch (argv[0]) {
    case 'collect':
      return collect(argv.slice(1), env, logger);
    case 'serve':
      // 占位：静态站点服务由 Task 16 实现。
      return 0;
    case 'export':
      // 占位：导出逻辑由后续任务实现。
      return 0;
    default:
      // 未知命令（含不带参数）：向 stderr 打印用法并返回 2。
      process.stderr.write(USAGE);
      return 2;
  }
}

/**
 * collect 分支：装配依赖 → 跑一轮 → 报告结果。
 * @param {string[]} args 子命令之后的参数
 * @param {object} env 环境变量
 * @param {object} logger 日志对象
 * @returns {Promise<number>} 退出码：0 成功（含降级成功），1 整轮失败
 */
async function collect(args, env, logger) {
  const offline = args.includes('--offline');
  const now = new Date();
  const cwd = process.cwd();

  // token 只在这里读一次，之后只存在于网络客户端的请求头里，绝不写日志。
  const token = typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.trim() !== '' ? env.GITHUB_TOKEN.trim() : undefined;

  const client = createClient({
    token,
    budget: ROUND_BUDGET,
    // 缓存文件 gitignored（spec §5.5）：有它就不会每小时把同一批仓库重问一遍。
    cache: createFileCache(`${cwd}/${DEFAULT_CACHE_PATH}`),
    logger,
  });

  const context = {
    dataDir: `${cwd}/${DEFAULT_DATA_DIR}`,
    client,
    now,
    offline,
    // 同一个预算数字也交给编排者（R83/R86）：客户端按它拦请求，编排者按它决定
    // "什么时候该停下来，把剩下的额度留给付费涨星"。两处用同一个常量，不会各写各的。
    budget: ROUND_BUDGET,
    dailyDir: `${cwd}/${DEFAULT_DAILY_DIR}`,
    logger,
  };

  try {
    if (offline) {
      // fixture 自己就是"富化后"的形状，所以只要 discover + enrich 两个方法，不接 resolveVelocity。
      const sources = createOfflineSources();
      const result = await runCollect({ ...context, sources });
      return report(result, logger);
    }

    const sources = createRealSources({ client, dataDir: context.dataDir, now });
    const result = await runCollect({ ...context, sources });
    return report(result, logger);
  } catch (error) {
    // runCollect 内部已经把能降级的都降级了，走到这里说明是**整轮失败**（例如数据目录不可写）。
    if (error instanceof RateLimitError) {
      logger.error(`本轮采集因额度耗尽中止：${error.message}。已有数据未被破坏，可以稍后重跑。`);
      return 1;
    }
    logger.error(`本轮采集失败：${error?.message ?? error}`);
    return 1;
  }
}

/**
 * 打印一轮的结果摘要。
 * @param {object} result runCollect 的返回值
 * @param {object} logger 日志对象
 * @returns {number} 0
 */
function report(result, logger) {
  const { coreCalls, searchCalls, cacheHits } = result.apiCalls;
  logger.log(`已写入 ${result.date} 的榜单：共 ${result.boards.length} 个榜`);
  for (const board of result.boards) logger.log(`  ${board.title}：${board.items.length} 条`);
  logger.log(`本轮 API 消耗：core ${coreCalls} 次、search ${searchCalls} 次，缓存命中 ${cacheHits} 次`);
  if (result.degraded) {
    logger.warn('注意：这一轮数据不完整（degraded），网站会显示"本期数据不完整"的提示。原因：');
    for (const warning of result.warnings) logger.warn(`  · ${warning}`);
  }
  return 0;
}

// 仅在被直接执行时运行，被测试 import 时不自动执行。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}

// GitHub 好玩榜 —— 命令行入口。
//
//   collect          采集 GitHub 热门项目，写入 JSON 数据（日报另写 daily/）
//   collect --offline  不发任何网络请求，用 fixtures/candidates.json 出一份完整榜单
//   serve             本地静态站点：服务 public/（数据就是你 public/data/ 里的真实采集产物）
//   serve --demo      本地静态站点 + 一份自带的演示数据（页面上会写明"这是演示数据"）
//   export           导出榜单数据（后续任务实现）
//
// 分工：本文件只负责"装配"——读环境变量、建网络客户端与缓存、选真实或离线管线，
// 然后交给 src/collect.mjs 的 runCollect 去编排。**编排逻辑一行都不在这里**，
// 否则离线测试跑的就成了另一条路径。
// serve 分支同理：它只负责把演示数据摆好、起一个静态服务器、把地址打出来，不读也不改任何数据文件
// （spec §5.1）；服务器本身没有任何接口与模板，页面需要的 JSON 由浏览器自己取。

import { fileURLToPath, pathToFileURL } from 'node:url';
import { RateLimitError, createClient } from './net/client.mjs';
import { createFileCache } from './net/file-cache.mjs';
import { runCollect } from './collect.mjs';
import { createOfflineSources, createRealSources } from './sources/pipeline.mjs';
import { createStaticServer } from './http/static-server.mjs';
import { seedDemoData } from '../fixtures/demo/seed.mjs';

const USAGE = `用法：node src/cli.mjs <命令>

可用命令：
  collect            采集 GitHub 热门项目，写入 JSON 数据
  collect --offline  断网也能跑：用内置样本出一份完整榜单
  serve              启动本地静态站点服务
  serve --demo       使用演示数据启动本地静态站点服务
  export             导出榜单数据

对应的 npm 脚本：
  npm run collect
  npm run collect:offline
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
// 本地预览的默认端口。选它是因为不常被别的程序占用；被占了就用 PORT 换一个（见 serve）。
const DEFAULT_PORT = 8765;

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
      return serve(argv.slice(1), env, logger);
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
 * 起一个本地预览服务，起好就返回（**不在这里等进程退出**）。
 *
 * 为什么抽成一个单独的函数：`serve --demo` 与 `serve` 的差别只有"数据从哪来"这一件事，
 * 而那件事必须能被端到端验证（起服务、真的取一次 /data/index.json 看是不是演示数据）。
 * 测试用 `PORT=0` 调它、自己关掉，就能在没有浏览器的环境里验证两种模式。
 *
 * 它**不是**一个服务端应用：没有接口、没有模板、不读也不改任何数据文件（spec §5.1、§5.3）。
 * @param {string[]} args 子命令之后的参数（`--demo` 表示用演示数据）
 * @param {object} env 环境变量（只用到 PORT）
 * @param {object} logger 日志对象
 * @returns {Promise<{ server: import('node:http').Server, url: string, dataRoot: string|null }>}
 *   dataRoot 是这一次选用的演示数据目录；真实模式是 null（照常服务 public/data）
 */
export async function startPreview(args, env, logger) {
  const raw = env.PORT ?? '';
  const parsed = typeof raw === 'string' && raw.trim() !== '' ? Number.parseInt(raw, 10) : DEFAULT_PORT;
  const port = Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_PORT;
  // 用 import.meta.url 定位 public/，而不是 cwd：从别的目录敲 `node 路径/src/cli.mjs serve` 时
  // cwd 是那个目录，用 cwd 会服务错文件夹（甚至服务不了任何东西）。
  // URL.pathname 是百分号编码的（本项目的目录名里有空格和中文），必须用 fileURLToPath 转回真实路径。
  const root = fileURLToPath(new URL('../public/', import.meta.url));

  // R127：演示模式**只**把 /data/ 指向演示数据目录，绝不写进 public/data ——
  // 否则一次 `npm run demo` 就会在真实数据目录里留下三天演示数据，之后一次 `npm start`
  // 会把它们当成真实榜单展示（页面上没有任何标注，那就是在说谎）。
  let dataRoot = null;
  if (args.includes('--demo')) {
    // 演示数据落在仓库自己的 data/ 临时区里（data/ 被 gitignore，本来就是放产物的地盘）。
    dataRoot = fileURLToPath(new URL('../data/demo/', import.meta.url));
    seedDemoData(dataRoot);
    logger.log('这一次用的是内置的演示数据（示例），不是刚采集到的真实数据；页面上也会写明这一点。');
  }

  const server = createStaticServer({ root, dataRoot });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/`, dataRoot };
}

/**
 * serve 分支：起一个只提供 public/（演示模式再加一份演示数据）的静态服务器，
 * 把地址打出来，然后一直跑到 Ctrl+C。
 * @param {string[]} args 子命令之后的参数（`--demo`；端口用 PORT 环境变量）
 * @param {object} env 环境变量
 * @param {object} logger 日志对象
 * @returns {Promise<number>} 退出码：0 正常关掉，1 端口被占之类起不来
 */
async function serve(args, env, logger) {
  let preview;
  try {
    preview = await startPreview(args, env, logger);
  } catch (error) {
    // 端口被占、演示数据文件不在（被人删了）……都收敛成一句人话。
    // 下一步只给与当下这一种情况对得上的那一个（R99 的同一条道理：建议必须做得到）。
    // R131：新手准备页把 PowerShell 与 cmd 都教成可行的路子，所以两种窗口的写法都要给
    // （`PORT=8766 npm start` 那种写法两个都不是；cmd 里还要用 set "NAME=VALUE" 才不带多余空格）。
    const command = args.includes('--demo') ? 'npm run demo' : 'npm start';
    const busy = error?.code === 'EADDRINUSE' || error?.code === 'EACCES';
    const retry = `换个端口再试：PowerShell 里 $env:PORT="8766"; ${command}`
      + `（cmd 里 set "PORT=8766" && ${command}）`;
    logger.error(`起不来本地预览服务：${error?.message ?? error}${busy ? `。${retry}` : ''}`);
    return 1;
  }
  const { server, url, dataRoot } = preview;

  logger.log(`本地预览已启动：${url}`);
  logger.log(dataRoot === null
    ? '按 Ctrl+C 停掉它。（这个服务只提供 public/ 目录里的文件，没有任何接口。）'
    : '按 Ctrl+C 停掉它。（这个服务只提供 public/ 目录与那份演示数据的文件，没有任何接口。）');

  // 等它被关掉为止：进程活着，用户才能一直刷页面。
  await new Promise((resolve) => {
    const stop = () => {
      server.close(() => resolve());
      // 已经建立的连接（浏览器开着页面）不会自己断，close 会一直等，所以主动断掉它们。
      server.closeAllConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
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

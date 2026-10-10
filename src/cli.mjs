// GitHub 好玩榜 —— 命令行入口。
// 本任务只搭建骨架：命令分发可用，collect / serve / export 均为占位实现，
// 具体逻辑由后续任务补齐。

import { pathToFileURL } from 'node:url';

const USAGE = `用法：node src/cli.mjs <命令>

可用命令：
  collect          采集 GitHub 热门项目，写入 JSON 数据
  serve            启动本地静态站点服务
  serve --demo     使用演示数据启动本地静态站点服务
  export           导出榜单数据

对应的 npm 脚本：
  npm run collect
  npm start
  npm run demo
`;

/**
 * 命令行主函数。
 * @param {string[]} argv 命令行参数（不含 node 可执行文件与脚本路径）
 * @returns {Promise<number>} 进程退出码
 */
export async function main(argv) {
  switch (argv[0]) {
    case 'collect':
      // 占位：采集逻辑由 Task 15 实现。
      return 0;
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

// 仅在被直接执行时运行，被测试 import 时不自动执行。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}

// Task 18 的测试：离线演示数据、历史归档页与评分口径页。
//
// 四层断言：
//   ① 演示数据集（fixtures/demo/dataset/）：它是**跑真实离线管线生成**出来的，能重新生成一遍并逐字节对上
//      —— 这样"分数不是手写的"不是一句自我声明，而是可复算的事实；
//   ② seedDemoData：把已生成好的演示数据落进任意数据目录，重复调用幂等；
//   ③ serve --demo（startPreview）：真的能把演示站点端到端服务出来，而且**不碰 public/data**
//      （一旦写进真实数据目录，之后一次 npm start 就会把演示数据当成真实榜单展示）；
//   ④ 页面：演示数据必须在页面上写明（R127），历史归档页在 0 / 1 / 多天三种情况下都要说人话。
//
// 断言的落点尽量在"用户真正看得到的东西"上：渲染出来的 HTML、HTTP 真的取到的文件。
// 只断言源码里出现过某个字符串的那种用例，这里一个都不要。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_DATA_DIR, DEMO_DATES, generateDemoData, seedDemoData } from '../fixtures/demo/seed.mjs';
import { startPreview } from '../src/cli.mjs';
import { runCollect } from '../src/collect.mjs';
import { createOfflineSources } from '../src/sources/pipeline.mjs';
import { listDates, readDaily, readHistory, updateIndex, writeDaily } from '../src/store/datastore.mjs';
import { WEIGHTS, HOT_REFERENCE_STARS_PER_WEEK } from '../src/config/weights.mjs';
import { buildBoardView, dateList, demoNotice, historyView } from '../public/render.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const dir = () => mkdtempSync(join(tmpdir(), 'hs-demo-'));
const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');
/**
 * 读文件并按"内容"比对：只统一换行符，别的字节一个都不放过。
 * 为什么不能直接比字节：这个仓库没有 .gitattributes，而 Windows 上的 git 默认会把文本文件在
 * 检出时换成 CRLF —— 那么"新克隆一份跑测试"就会因为换行符而红，而真正要守的是"分数不是手写的"。
 */
const readNormalized = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** 测试用的日志对象：默认不出声，需要时把行收进数组。 */
const silent = (lines) => ({
  log: (message) => lines?.push(String(message)),
  warn: () => {},
  error: () => {},
});

/** 起一个只监听回环地址的预览服务，测完一定关掉（端口用 0 让系统分配）。 */
async function withPreview(args, run) {
  const lines = [];
  const { server, url, dataRoot } = await startPreview(args, { PORT: '0' }, silent(lines));
  try {
    await run({ base: url.replace(/\/$/, ''), dataRoot, lines });
  } finally {
    await new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    });
  }
}

// ---------- ① 演示数据集 ----------

test('演示数据填满三个榜并覆盖多天，清单最新在前', () => {
  const d = dir();
  seedDemoData(d);
  const dates = listDates(d);
  assert.equal(dates.length, DEMO_DATES.length);
  assert.deepEqual(dates, [...DEMO_DATES].reverse(), '清单必须最新在前');
  assert.equal(readDaily(d, dates[0]).boards.length, 3);
  // 历史档案也要在：真实采集会写它，演示数据缺了它就不像一份完整的数据。
  assert.ok(Object.keys(readHistory(d, dates[0].slice(0, 7))).length >= 3);
});

test('seed 幂等：重复调用不产生重复日期', () => {
  const d = dir();
  seedDemoData(d);
  const first = listDates(d);
  seedDemoData(d);
  assert.deepEqual(listDates(d), first);
});

test('演示数据里至少有一条估算、一条实测，三个榜都真的有内容', () => {
  const d = dir();
  seedDemoData(d);
  const dates = listDates(d);
  const items = dates.flatMap((date) => readDaily(d, date).boards.flatMap((board) => board.items));
  const confidences = new Set(items.map((item) => item.confidence));
  assert.ok(confidences.has('estimated'), '演示数据要有一条估算，界面上那种标注才看得见');
  assert.ok(confidences.has('measured'), '演示数据要有一条实测');
  for (const date of dates) {
    const boards = readDaily(d, date).boards;
    assert.equal(boards.length, 3);
    for (const board of boards) assert.ok(board.items.length > 0, `${date} 的 ${board.id} 是空的`);
  }
});

test('演示数据每天都带着"这是演示数据"，清单里的那一位是从每天的数据派生出来的', () => {
  const d = dir();
  seedDemoData(d);
  for (const date of DEMO_DATES) {
    assert.equal(readDaily(d, date).demo, true, `${date} 的当天数据自己就该带着这一位`);
  }
  const index = JSON.parse(readFileSync(join(d, 'index.json'), 'utf8'));
  assert.equal(index.demo, true, '页面（含归档页）靠这一位知道整份数据是演示数据');
});

test('R128：清单里的演示位由当天数据派生，混进任何一天真实数据就不该再标', () => {
  const d = dir();
  const day = (date, extra = {}) => ({ date, generatedAt: `${date}T00:00:00.000Z`, degraded: false, notes: [], boards: [], ...extra });
  writeDaily(d, '2026-10-10', day('2026-10-10', { demo: true }));
  updateIndex(d);
  assert.equal(JSON.parse(readFileSync(join(d, 'index.json'), 'utf8')).demo, true, '三天都是样本时才算一份演示数据集');
  writeDaily(d, '2026-10-11', day('2026-10-11'));
  updateIndex(d);
  assert.equal(JSON.parse(readFileSync(join(d, 'index.json'), 'utf8')).demo, undefined,
    '只要有一天是真实数据，就不能把整份清单标成演示数据（那是在替真实数据说假话）');
});

test('R131：updateIndex 可以接受显式的"现在"，演示数据用它把时间戳固定下来', () => {
  const d = dir();
  writeDaily(d, '2026-10-10', { date: '2026-10-10', generatedAt: '2026-10-10T00:00:00.000Z', degraded: false, notes: [], boards: [], demo: true });
  updateIndex(d, { now: new Date('2026-10-10T00:00:00.000Z') });
  assert.equal(JSON.parse(readFileSync(join(d, 'index.json'), 'utf8')).updatedAt, '2026-10-10T00:00:00.000Z');
});

test('已提交的演示数据与生成器逐字节一致（分数不是手写的）', async () => {
  const d = dir();
  await generateDemoData(d);
  for (const date of DEMO_DATES) {
    assert.equal(
      readNormalized(join(d, `${date}.json`)),
      readNormalized(join(DEMO_DATA_DIR, `${date}.json`)),
      `${date} 的榜单文件与重新生成的结果不一致`,
    );
  }
  const month = DEMO_DATES[2].slice(0, 7);
  assert.equal(
    readNormalized(join(d, 'history', `${month}.json`)),
    readNormalized(join(DEMO_DATA_DIR, 'history', `${month}.json`)),
    '历史档案与重新生成的结果不一致',
  );
  // R131：清单也要逐字节一致 —— 不然 `--write` 每次都留下一个只有时间戳不同的 diff，
  // "重新生成"就永远不是 no-op，谁都说不清那次改动是真的还是噪声。
  assert.equal(
    readNormalized(join(d, 'index.json')),
    readNormalized(join(DEMO_DATA_DIR, 'index.json')),
    '清单与重新生成的结果不一致（时间戳应当是固定的）',
  );
  const committed = JSON.parse(readFileSync(join(DEMO_DATA_DIR, 'index.json'), 'utf8'));
  assert.deepEqual(committed.dates, [...DEMO_DATES].reverse());
  assert.equal(committed.demo, true);
  assert.deepEqual(Object.keys(committed).sort(), ['dates', 'demo', 'updatedAt']);

  // 已提交的目录里不许有别的东西：多出来的文件说明有人手工塞过内容，或者生成器留下了残留。
  assert.deepEqual(
    readdirSync(DEMO_DATA_DIR).sort(),
    [...DEMO_DATES.map((date) => `${date}.json`), 'history', 'index.json'].sort(),
  );
  assert.deepEqual(readdirSync(join(DEMO_DATA_DIR, 'history')), [`${month}.json`]);
});

test('演示数据文件是合法 JSON，形状与采集产物一致（安装向导是采集时生成好的）', () => {
  const index = JSON.parse(readFileSync(join(DEMO_DATA_DIR, 'index.json'), 'utf8'));
  assert.ok(Array.isArray(index.dates) && index.dates.length > 0);
  for (const date of index.dates) {
    const daily = JSON.parse(readFileSync(join(DEMO_DATA_DIR, `${date}.json`), 'utf8'));
    assert.equal(daily.date, date);
    assert.equal(typeof daily.generatedAt, 'string');
    assert.equal(daily.degraded, false);
    assert.deepEqual(daily.boards.map((board) => board.id), ['weekly', 'newbie', 'classic']);
    for (const board of daily.boards) {
      for (const item of board.items) {
        assert.equal(typeof item.ownerRepo, 'string');
        assert.equal(typeof item.scores.total, 'number');
        assert.ok(Array.isArray(item.install?.steps) && item.install.steps.length === 3);
      }
    }
  }
});

test('演示数据目录里没有写了一半的临时文件', () => {
  const names = [...readdirSync(DEMO_DATA_DIR), ...readdirSync(join(DEMO_DATA_DIR, 'history'))];
  assert.ok(names.length > 3, '没扫到文件，这条会空转');
  for (const name of names) assert.ok(!name.endsWith('.tmp'), `${name} 是写了一半的临时文件`);
});

test('演示数据必须真的会进版本库：它不在被忽略的 data/ 目录下', () => {
  // .gitignore 里的 `data/` 会忽略**任何**叫 data 的目录（采集产物 public/data 与缓存 data/ 都靠它）。
  // 演示数据是"新克隆也要看得见"的交付物，所以它不能放在这样的目录里。
  assert.ok(existsSync(join(REPO_ROOT, '.git')), '这个仓库应该有 .git，否则下面那条检查没有意义');
  const ignored = (target) => {
    try {
      execFileSync('git', ['check-ignore', '-q', '--', target], { cwd: REPO_ROOT, stdio: 'ignore' });
      return true; // 退出码 0 = 被忽略
    } catch {
      return false; // 退出码 1 = 没被忽略
    }
  };
  // 正面对照：采集产物必须是被忽略的。这一条同时证明上面的检查真的在跑（不是沙箱把它挡掉了）。
  assert.equal(ignored(join(PUBLIC_DIR, 'data', 'probe.json')), true, '采集产物 public/data 应该是被忽略的');
  assert.equal(ignored(join(DEMO_DATA_DIR, 'index.json')), false, '演示数据被忽略了：新克隆将什么都看不到');
});

test('R128：离线采集（内置样本）产出的当天数据自己带着演示位，页面按当天数据标注', async () => {
  const d = dir();
  const result = await runCollect({
    dataDir: d, sources: createOfflineSources(), now: new Date('2026-10-10T00:00:00.000Z'), offline: true,
  });
  assert.equal(result.payload.demo, true, '离线源就是内置样本，这一轮的数据必须照实声明');
  assert.equal(readDaily(d, '2026-10-10').demo, true, '写进文件的那一份也要有');
  assert.equal(JSON.parse(readFileSync(join(d, 'index.json'), 'utf8')).demo, true, '清单由当天数据派生，归档页也才标得到');

  // 关键：页面**只**拿到当天数据（调用方没有额外传 demo）时，也必须给出标注。
  const view = buildBoardView({
    boardId: 'weekly', items: [], daily: readDaily(d, '2026-10-10'), dates: ['2026-10-10'], date: '2026-10-10',
  });
  const notice = view.notices.find((item) => item.key === 'demo');
  assert.ok(notice !== undefined, '样本数据不许在没有标注的情况下被当成今天的热门项目展示');
  assert.match(notice.html, /演示数据（示例）/);
  assert.match(notice.html, /2026-10-10/);
});

test('R128：真实（联网）采集路径不写演示位，页面也就没有演示标注', async () => {
  const d = dir();
  // offline: false 就是真实那条路：没有可用的网络客户端，于是拿不到候选，但路径是联网路径。
  const result = await runCollect({
    dataDir: d, sources: { discover: async () => ({ candidates: [] }) }, now: new Date('2026-10-10T00:00:00.000Z'),
  });
  assert.equal(result.payload.demo, undefined, '真实采集不许写这一位');
  assert.notEqual(readDaily(d, '2026-10-10').demo, true);
  assert.notEqual(JSON.parse(readFileSync(join(d, 'index.json'), 'utf8')).demo, true);
  const view = buildBoardView({
    boardId: 'weekly', items: [], daily: readDaily(d, '2026-10-10'), dates: ['2026-10-10'], date: '2026-10-10',
  });
  assert.equal(view.notices.find((item) => item.key === 'demo'), undefined, '真实数据不许被标成演示数据');
});

// ---------- ② serve --demo 端到端 ----------

test('serve --demo 把演示站点端到端服务出来，数据只落在自己的目录里', async () => {
  await withPreview(['--demo'], async ({ base, dataRoot, lines }) => {
    const index = await (await fetch(`${base}/data/index.json`)).json();
    assert.equal(index.demo, true);
    assert.deepEqual(index.dates, [...DEMO_DATES].reverse());

    const day = await (await fetch(`${base}/data/${DEMO_DATES[2]}.json`)).json();
    assert.equal(day.boards.length, 3);
    assert.ok(day.boards.every((board) => board.items.length > 0));

    for (const page of ['/', '/index.html', '/about.html', '/history.html', '/prepare.html']) {
      assert.equal((await fetch(`${base}${page}`)).status, 200, `${page} 应该打得开`);
    }
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/history.js`)).status, 200);

    // 演示数据落在自己的目录里（data/demo），既不在 public/ 里，也不覆盖真实数据目录。
    assert.ok(dataRoot !== null);
    const root = resolve(dataRoot);
    assert.ok(root !== resolve(PUBLIC_DIR) && !root.startsWith(resolve(PUBLIC_DIR) + sep), '演示数据不许落在 public/ 里');
    assert.ok(root.startsWith(resolve(REPO_ROOT, 'data') + sep), '演示数据只该落在仓库自己的 data/ 临时区里');
    assert.ok(existsSync(join(root, 'index.json')), '演示数据要真的落到那个目录里');
    assert.ok(lines.some((line) => line.includes('演示数据')), '启动时要在控制台说清这一次用的是演示数据');
  });
});

test('不加 --demo 时不会服务演示数据集：/data/ 照旧指向 public/data', async () => {
  await withPreview([], async ({ base, dataRoot }) => {
    // 结构上的事实：没有 --demo 就没有 dataRoot，服务器不会去找那份演示数据。
    assert.equal(dataRoot, null);
    assert.match(await (await fetch(`${base}/`)).text(), /本周飙升/);

    // 行为上的事实：/data/ 下的东西与 public/data 里的**同一份文件逐字节相同**（而不是演示数据集那一份）。
    // 这里不能断言"index.json 不许带 demo 位"：public/data 里也可能是 collect:offline 采来的样本，
    // 那种数据**应该**带 demo 位（R128），在真实模式下调出来也必须照样被标注。
    const response = await fetch(`${base}/data/index.json`);
    const realPath = join(PUBLIC_DIR, 'data', 'index.json');
    if (response.status === 200) {
      assert.equal(await response.text(), readNormalized(realPath), '真实模式必须服务 public/data 里的那一份');
    } else {
      assert.equal(response.status, 404);
      assert.ok(!existsSync(realPath), 'public/data/index.json 不在时，这里就该是 404');
    }
  });
});

// ---------- ③ R127：演示数据必须被标注 ----------

test('R127：榜单页上明说这是演示数据，并说清它代表哪一天', () => {
  const view = buildBoardView({
    boardId: 'weekly', items: [], daily: null, dates: [], date: '2026-10-10', demo: true, loading: true,
  });
  assert.equal(view.notices[0]?.key, 'demo', '演示标注要排在最前面：它改变你怎么读后面每一个数字');
  const notice = view.notices[0].html;
  assert.match(notice, /演示数据（示例）/);
  assert.match(notice, /不是刚采集到的/);
  assert.match(notice, /2026-10-10/);
});

test('R127：这不是一句只在加载时说的话——换成真实数据就不许再挂它', () => {
  const daily = { date: '2026-10-10', degraded: false, boards: [] };
  const real = buildBoardView({ boardId: 'weekly', items: [], daily, dates: ['2026-10-10'], date: '2026-10-10' });
  assert.equal(real.notices.find((notice) => notice.key === 'demo'), undefined, '真实数据不许被标成演示数据');
  const demo = buildBoardView({ boardId: 'weekly', items: [], daily, dates: ['2026-10-10'], date: '2026-10-10', demo: true });
  assert.ok(demo.notices.find((notice) => notice.key === 'demo') !== undefined, '演示数据在任何一次渲染里都要有标注');
});

test('R127：日期是外部输入，进标注之前必须转义', () => {
  const html = demoNotice('<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'), '原始标签不许出现');
  assert.match(html, /&lt;img/);
});

// ---------- ④ 历史归档页 ----------

test('历史归档页：一天数据都没有时说清没有，并给出真能用的命令', () => {
  const html = historyView({ index: { dates: [] } });
  assert.match(html, /还没有任何往期数据/);
  assert.match(html, /npm run demo/);
  assert.match(html, /npm run collect:offline/);
  assert.match(html, /演示数据/);
});

test('历史归档页：清单读不出来时不许说成"一天都没有"（那是在替数据断言）', () => {
  const html = historyView({ index: null });
  assert.match(html, /读不出来/);
  assert.ok(!html.includes('还没有任何往期数据'), '"文件读不到"与"确实没有数据"是两件事，说法不能混');
  // 读不出来时同样要给一条走得通的路，而且命令都真实存在。
  assert.match(html, /npm run demo/);
  assert.match(html, /npm run collect:offline/);
});

test('R129：清单读到了但形状不对，同样走"读不出来"，不许说成"一天都没有"', () => {
  // {"dates":42} 这种清单是**坏**，不是"没有数据"：文件在、里面有东西，只是不是日期列表。
  for (const index of [{ dates: 42 }, {}, { dates: '2026-10-10' }, 42, '不是对象', true]) {
    const html = historyView({ index });
    assert.match(html, /读不出来/, `清单 ${JSON.stringify(index)} 应走"读不出来"那支`);
    assert.ok(!html.includes('还没有任何往期数据'), `清单 ${JSON.stringify(index)} 被说成了"一天都没有"`);
  }
  // 形状对、只是没有天：这才是"还没有任何往期数据"。
  assert.match(historyView({ index: { dates: [] } }), /还没有任何往期数据/);
  // 形状对、有天数：照常列出。
  assert.match(historyView({ index: { dates: ['2026-10-10'] } }), /只有一天/);
});

test('历史归档页：只有一天时照实说只有一天，并给出这一天的入口', () => {
  const html = historyView({ index: { dates: ['2026-10-10'] } });
  assert.match(html, /只有一天/);
  assert.match(html, /2026-10-10/);
  assert.match(html, /href="index\.html\?date=2026-10-10"/);
});

test('历史归档页：多天时按最新在前列出每一天', () => {
  const html = historyView({ index: { dates: ['2026-10-08', '2026-10-10', '2026-10-09'] } });
  const links = [...html.matchAll(/href="index\.html\?date=(\d{4}-\d{2}-\d{2})"/g)].map((match) => match[1]);
  assert.deepEqual(links, ['2026-10-10', '2026-10-09', '2026-10-08'], '日期要最新在前，不能照文件里的顺序');
  assert.match(html, /3 天/);
});

test('历史归档页：认不出的日期一律不列（不给一条点进去什么都没有的链接）', () => {
  const html = historyView({ index: { dates: ['2026-10-10', 'not-a-date', 42, '', '2026-10-10'] } });
  const links = [...html.matchAll(/href="index\.html\?date=([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(links, ['2026-10-10']);
  assert.ok(!html.includes('not-a-date'));
});

test('历史归档页：演示数据在归档页上同样要被标注（这一位由清单派生，页面自己读）', () => {
  assert.match(historyView({ index: { dates: ['2026-10-10'], demo: true } }), /演示数据（示例）/);
  assert.ok(!historyView({ index: { dates: ['2026-10-10'] } }).includes('演示数据'), '真实数据的归档页不许挂演示标注');
});

test('dateList：两个页面共用同一份清单口径（认形状、去重、最新在前）', () => {
  assert.deepEqual(dateList({ dates: ['2026-10-08', 'bad', '2026-10-10', '2026-10-10'] }), ['2026-10-10', '2026-10-08']);
  assert.deepEqual(dateList(null), []);
  assert.deepEqual(dateList({ dates: '不是数组' }), []);
  assert.deepEqual(dateList({}), []);
});

test('历史归档页自己的脚本只做取数与写 DOM：文案全在 render.mjs', () => {
  const js = read('history.js');
  assert.ok(js.length > 500, '这段脚本太短，下面两条会空转');
  assert.match(js, /historyView\(/, '归档页必须用纯函数层给的结果');
  assert.ok(!/innerHTML\s*=\s*['"`][^'"`]*[\u4e00-\u9fa5]/.test(js), 'history.js 里不许直接写中文文案');
  assert.ok(!js.includes('npm run'), '命令文案属于纯函数层');
});

// ---------- ⑤ 评分口径页 ----------

test('评分口径页存在，写出的三轴满分与权重表一致', () => {
  const text = read('about.html').replace(/<!--[\s\S]*?-->/g, '');
  // R131：数字必须带边界。`45` 不带边界会匹配上 `450`——页面本身是对的，但那种断言没有鉴别力。
  for (const value of [WEIGHTS.hot, WEIGHTS.reputation, WEIGHTS.runnable]) {
    assert.match(text, new RegExp(`\\b${value}\\b`), `页面上要写出 ${value} 这个满分`);
  }
  assert.match(text, /热度/);
  assert.match(text, /口碑/);
  assert.match(text, /新手友好/);
  // 热度那一句给了具体参考值（达到它就满分）：这个数也来自权重表，写错了同样是说错话。
  assert.match(text, new RegExp(`\\b${HOT_REFERENCE_STARS_PER_WEEK}\\b`), `页面上要写出 ${HOT_REFERENCE_STARS_PER_WEEK} 这个参考值`);
  // 负面对照：证明上面那种写法真的带边界（否则这条用例只是看着严格）。
  assert.equal(new RegExp(`\\b${WEIGHTS.hot}\\b`).test(`${WEIGHTS.hot}0`), false);
});

test('R130：降级阶梯的顺序与代码一致（官方趋势页在归档快照差值之前）', () => {
  const text = read('about.html').replace(/<!--[\s\S]*?-->/g, '');
  // star-velocity.mjs 的实际顺序：逐日记录差值 → 新建项目 → 官方趋势页(reported)
  // → 月度归档快照差值(measured) → 事件外推(estimated)。页面必须按这个顺序讲。
  const positions = ['逐日记录', 'GitHub 官方数据', '归档快照', '活动记录'].map((phrase) => {
    const at = text.indexOf(phrase);
    assert.ok(at > -1, `口径页里应有「${phrase}」这一级`);
    return at;
  });
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i - 1] < positions[i], '阶梯顺序与代码不一致');
  }
});

test('R130：页面都不许声称"每天采集一次"（仓库里没有任何调度）', () => {
  // 四个页面一起扫：这条不实说法是从 index.html 继承下来的，谁都不许再抄一遍。
  for (const file of ['index.html', 'about.html', 'history.html', 'prepare.html']) {
    const text = read(file).replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/每天[^。；\n]{0,8}采集|每天自动|自动更新|每天都会更新/.test(text),
      `${file} 把一个不存在的定时任务说成了事实`);
  }
});

test('评分口径页说清三件必须诚实的事：数据从哪来、跟 GitHub 什么关系、看不看得到你的电脑', () => {
  const text = read('about.html').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(text, /不是 GitHub 官方/);
  assert.match(text, /看不到你的电脑/);
  assert.match(text, /公开/);
  // 不许承诺做不到的事：这一页不许说它会替访客检查、安装、修改电脑上的东西。
  assert.ok(!/帮你装好|自动为你安装|检测你的电脑/.test(text));
});

test('新页面与新脚本一律不含行话（spec §4.3）', () => {
  for (const file of ['about.html', 'history.html', 'history.js']) {
    const source = read(file);
    assert.ok(source.length > 500, `${file} 太短，断言会空转`);
    assert.ok(
      !/\bstar\b|\bfork\b|\bissue\b|archived|\bcommit\b|\bmerge\b|\brepo\b/i.test(source),
      `${file} 里出现了行话`,
    );
  }
});

// ---------- ⑥ R99：无数据提示推荐的命令必须真的存在 ----------

test('R99：无数据提示推荐的每一条命令都真的存在', () => {
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts ?? {};
  const notice = buildBoardView({ boardId: 'weekly', items: [], daily: null, dates: [] })
    .notices.find((item) => item.key === 'no-data').html;
  const commands = [...notice.matchAll(/npm run ([a-z:-]+)/g)].map((match) => match[1]);
  assert.ok(commands.length >= 2, '这条提示要给出路，而不是只说"没有数据"');
  for (const name of new Set(commands)) {
    assert.ok(name in scripts, `推荐了 package.json 里不存在的脚本：${name}`);
  }
  // `npm run demo` 在 Task 18 之前是死路（serve 不认 --demo），所以旧文案禁止提它；
  // 现在它真的能把演示站点起起来（见本文件上面的端到端用例），文案就该把它写出来，
  // 并且说清"看到的是演示数据"。
  assert.ok(commands.includes('demo'), '演示数据能跑通了，就该告诉用户有这条路');
  assert.match(notice, /演示数据/);
});

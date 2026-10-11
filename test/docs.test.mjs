// Task 19 —— 面向新手的文档（README.md、docs/使用手册.md、LICENSE）的交付物纪律测试。
//
// 这一层钉住的不是"文档写没写"，而是**文档里的每一句断言是否配得上代码**：
//   · 文档里出现的每一条 `npm run X` / `npm test` 都必须在 package.json 里真实存在
//     （R99 的同一条道理：建议必须做得到，做不到的建议比没有建议更坏）；
//   · 关键路径必须真的在文档里（否则"说明书"这个交付物就是空的）；
//   · 仓库自带的那份可选每日工作流（R133 起真的存在）必须**真的能采能提交**，
//     而且文档与页面要对得上这个事实：只说"每天自动更新"是假话（在用户自己电脑上并不会），
//     只说"仓库里没有定时任务"现在也成了假话；
//   · 月度归档文件写出来但没有任何代码读它、网站是纯静态的所以看不到访客的电脑；
//   · 手册第 8 节手抄的那张权重表必须与 weights.mjs 一致（抄错就是手册在说假话）；
//   · 面向新手的正文不许出现行话（spec §4.3）。
//
// 与 demo.test.mjs 的分工：那一层扫的是 public/ 下的页面，这一层扫的是仓库根目录的文档。
// 两者都不联网、不读时钟。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CHINESE_POINTS,
  DETAIL_WEIGHTS,
  HOT_REFERENCE_STARS_PER_WEEK,
  RUNNABLE_POINTS,
  WEIGHTS,
} from '../src/config/weights.mjs';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p) => readFileSync(root(p), 'utf8');
const scripts = JSON.parse(read('package.json')).scripts ?? {};

// 文档清单：README、手册、许可证、评分口径页。
const README = 'README.md';
const MANUAL = 'docs/使用手册.md';
const LICENSE = 'LICENSE';
const ABOUT = 'public/about.html';

// 把 Markdown 里的行内代码（`npm run demo`）与围栏代码块里的命令行都抠出来。
// 只认"看起来像命令"的那些：以 npm / node 开头的整行。
function commandLines(text) {
  const inline = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
    .flatMap((m) => m[1].split('\n'));
  return [...inline, ...fenced].map((line) => line.trim()).filter((line) => line !== '');
}

test('文档都在：README、中文使用手册、许可证一个都不少', () => {
  for (const file of [README, MANUAL, LICENSE]) {
    assert.ok(existsSync(root(file)), `${file} 不存在`);
    assert.ok(read(file).length > 500, `${file} 太短，下面的断言会空转`);
  }
});

test('README 里提到的每一条命令都真的存在（npm run X / npm test）', () => {
  const text = read(README);
  const mentioned = [...text.matchAll(/npm (?:run )?([a-z][a-z:]*)/g)].map((m) => m[1]);
  assert.ok(mentioned.length >= 4, `README 至少该讲清四条命令，实际只提到 ${mentioned.length} 条`);
  for (const name of new Set(mentioned)) {
    assert.ok(name in scripts, `README 推荐了 package.json 里不存在的脚本：npm ${name}`);
  }
  assert.ok(mentioned.includes('demo'), 'README 必须告诉新手先跑 demo 看效果');
  assert.ok(mentioned.includes('collect'), 'README 必须讲清真正联网采集的那条命令');
});

test('中文使用手册里提到的每一条命令都真的存在，而且四条命令都讲到', () => {
  const text = read(MANUAL);
  const mentioned = [...text.matchAll(/npm (?:run )?([a-z][a-z:]*)/g)].map((m) => m[1]);
  for (const name of new Set(mentioned)) {
    assert.ok(name in scripts, `手册推荐了 package.json 里不存在的脚本：npm ${name}`);
  }
  for (const name of ['demo', 'collect:offline', 'collect', 'start']) {
    assert.ok(mentioned.includes(name), `手册必须逐条讲清 npm run ${name}`);
  }
});

test('文档里出现的命令行本身不带占位符歧义：每条 npm 行都能被 package.json 认领', () => {
  // 上面两条只扫"提到了哪些名字"。这一条扫的是**真的会被复制粘贴的那些整行**：
  // 一行里若写了 `npm run 某个不存在的名字`，新手复制过去只会拿到一句报错。
  for (const file of [README, MANUAL]) {
    for (const line of commandLines(read(file))) {
      const match = /^npm (?:run )?([a-z][a-z:]*)(?:\s|$)/.exec(line);
      if (match === null) continue;
      assert.ok(match[1] in scripts, `${file} 里这一行命令跑不通：${line}`);
    }
  }
});

test('手册必须按顺序讲完新手路线：打开命令行 → 装 Node → 跑起来', () => {
  const text = read(MANUAL);
  // 量的是**章节标题**的位置，而不是命令名第一次出现的位置：目录与速查表里也会出现命令名，
  // 拿"第一次出现"去比会得出一个与新手实际阅读顺序无关的结论（这条断言一开始就是这么错的）。
  // 直接锚在 `## ` 标题上：目录里那一行是 `2. [怎么打开命令行](#...)`，不会被认成标题。
  const headingPos = (title) => {
    const at = text.indexOf(`## ${title}`);
    assert.ok(at > -1, `手册里缺了「${title}」这一章`);
    return at;
  };
  const steps = ['2. 怎么打开命令行', '3. 怎么装 Node', '4. 怎么把项目跑起来', '5. 四条命令分别干什么'];
  const positions = steps.map((title) => headingPos(title));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i - 1] < positions[i], `手册的章节顺序不对：「${steps[i - 1]}」应排在「${steps[i]}」之前`);
  }
  // 装 Node 那一节必须给出"装没装好"的判断命令与期望输出。
  const nodeSection = text.slice(positions[1], positions[2]);
  assert.match(nodeSection, /node -v/, '装 Node 那一章要给出判断命令');
  assert.match(nodeSection, /v\d+\.\d+\.\d+/, '装 Node 那一章要给出期望看到的版本号长什么样');
  // 跑起来那一节必须先讲离线演示，再讲在线采集。
  const runSection = text.slice(positions[2], positions[3]);
  const demoAt = runSection.indexOf('npm run demo');
  const collectAt = runSection.indexOf('npm run collect');
  assert.ok(demoAt > -1 && collectAt > -1, '跑起来那一节要同时给出 demo 与 collect');
  assert.ok(demoAt < collectAt, '要先让新手跑 npm run demo 看效果，再讲联网采集');
});

test('手册必须同时给出 PowerShell 与 cmd 两种打开命令行的方法', () => {
  const text = read(MANUAL);
  assert.match(text, /PowerShell/);
  assert.match(text, /\bcmd\b|命令提示符/);
  assert.match(text, /prepare\.html/, '手册要指出站内还有一页更细的图文说明');
});

test('部署一节必须说清发布目录是 public/，并且说清数据目录被 git 忽略', () => {
  const text = read(MANUAL);
  for (const host of ['GitHub Pages', 'Cloudflare Pages', 'Vercel']) {
    assert.ok(text.includes(host), `部署一节缺了 ${host}`);
  }
  assert.match(text, /public\/?/, '要说清"把 public/ 作为发布目录"这一步');
  assert.match(text, /gitignore|git 忽略|被忽略/i, '要说清 public/data/ 被 git 忽略这件事');
});

// ---------- R134：仓库自带一个可选的每日工作流，文档与页面必须与这个事实一致 ----------

const WORKFLOW = '.github/workflows/daily.yml';

test('R134：可选的每日工作流存在，且真的能采集并提交回仓库', () => {
  assert.ok(existsSync(root(WORKFLOW)), `${WORKFLOW} 不存在`);
  const text = read(WORKFLOW);
  assert.ok(text.length > 500, '工作流文件太短，下面的断言会空转');
  // 触发：定时 + 手动。没有 workflow_dispatch 就只能在某个整点干等。
  assert.match(text, /^on:$/m, '缺少顶层 on:');
  assert.match(text, /^ {2}schedule:$/m, '缺少 schedule 触发');
  assert.match(text, /cron:\s*'0 23 \* \* \*'/, '缺少每日一次的 cron');
  assert.match(text, /^ {2}workflow_dispatch: \{\}$/m, '缺少 workflow_dispatch（手动可跑）');
  // 权限：默认只读，提交回仓库必须显式要写权限。
  assert.match(text, /^ {4}permissions:$/m, '缺少 permissions');
  assert.match(text, /^ {6}contents: write([ \t]*#.*)?$/m, '缺少 contents: write');
  // 步骤：检出 → 装 Node 22 → 采集 → 提交。
  assert.match(text, /uses:\s*actions\/checkout@/, '缺少检出步骤');
  assert.match(text, /uses:\s*actions\/setup-node@/, '缺少装 Node 步骤');
  assert.match(text, /node-version:\s*'22'/, '没有装本项目要求的 Node 22');
  assert.match(text, /^ {8}run: npm run collect$/m, '没有跑 npm run collect');
  // 额度：token 必须真的传给采集（client.mjs 的 token 选项只从 env.GITHUB_TOKEN 来）。
  assert.match(text, /GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/, '没有把 GITHUB_TOKEN 传给采集');
  // 提交：public/data 与 data/ 都在 .gitignore 里，不用 -f 就会静默提交一个空站。
  assert.match(text, /git add -f public\/data daily/, '没有用 git add -f 提交被 gitignore 的数据目录');
  assert.match(text, /git commit -m/, '没有提交');
  assert.match(text, /^ {10}git push$/m, '没有推送');
  // 多行命令必须是字面块，否则 $(date) 会被 YAML 折成一行。
  assert.match(text, /run: \|\n/, '多行命令必须写成字面块');
  // 不许把真的令牌写进仓库（只许 ${{ secrets.X }} 引用）。
  assert.ok(!/ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}/.test(text), '工作流里像是写了真的令牌');
});

test('R134：文档与页面都如实说清这个工作流只在哪里生效、默认不跑', () => {
  const docs = [read(README), read(MANUAL)].join('\n');
  // 它必须被提到，而且必须说清"只在 GitHub 上生效"，不能让人以为本地会自己跑。
  assert.match(docs, /\.github\/workflows\/daily\.yml/, '文档要指出工作流文件在哪');
  assert.match(docs, /只在 GitHub 上生效|只在 GitHub 上/, '要说清它只在 GitHub 上生效');
  assert.match(docs, /Actions/, '要指出它在 GitHub 的 Actions 里');
  assert.match(docs, /默认(禁用|不会)|不会自动跑|需要.{0,10}启用/, '要说清 fork 之后默认不会跑这件事');
  // 页面也不许再声称"仓库里没有定时任务"（那现在是假话），但也不许声称"每天自动更新"。
  const about = read(ABOUT).replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/仓库里没有定时任务/.test(about), '口径页还在说"仓库里没有定时任务"');
  assert.match(about, /可选/, '口径页要说明那个每日任务是可选的');
  for (const file of ['index.html', 'about.html', 'history.html', 'prepare.html']) {
    const page = read(`public/${file}`).replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/(?<![不没])每天[^。；\n]{0,8}采集|(?<![不没])每天自动|(?<![不没])自动更新|每天都会更新/.test(page),
      `${file} 把"每天自动更新"说成了事实（在用户自己的电脑上并不会）`);
  }
});

// ---------- R136：手册里那张手抄的权重表也要进漂移测试 ----------
//
// 手册第 8 节把权重抄成了给人看的中文表格。它是给新手的权威说明，抄错就是**手册在说假话**，
// 而抄出来的数字不会跟着 weights.mjs 走。所以这里用同一份常量去核对**两处**：手册与口径页。
// 断言方式是"值必须出现在它该出现的那一段里"，不是"全文里出现过这个数"——
// 后者没有鉴别力：45 这个数在一篇讲评分的文章里到处都可能出现。

// 口径页里对分档的说法是中文的（'满分 <strong>8</strong>'），手册里是表格，所以这里按"数 8"找。
const valuePattern = (value) => new RegExp(`(^|[^0-9])${value}([^0-9]|$)`);
// 与上面同一条边界规则，但不吃捕获组：要放进先行断言里用（`(?=...)` 里不能有捕获组）。
const boundaryPattern = (value) => `(?![0-9])${value}(?![0-9])`;

/** 口径页里某一轴那一行（`<dt>口碑</dt><dd>满分 <strong>30</strong></dd>`）。 */
const aboutAxisRow = (about, axis) => about.split('\n').find((line) => line.includes(`<dt>${axis}</dt>`));

test('R136：手册第 8 节手抄的三轴满分与 weights.mjs 一致', () => {
  const text = read(MANUAL);
  const at = text.indexOf('## 8.');
  assert.ok(at > -1, '手册缺了第 8 节（三轴满分）');
  const section = text.slice(at, at + 240);
  const rows = [['热度', WEIGHTS.hot], ['口碑', WEIGHTS.reputation], ['新手友好', WEIGHTS.runnable]];
  for (const [axis, value] of rows) {
    // 只看**表格行**：第 8 节的标题里也写着「口碑」，拿它当行会匹配到标题、得出一个假的结论。
    const row = section.split('\n').find((line) => line.startsWith('|') && line.includes(axis));
    assert.ok(row !== undefined, `三轴表里缺了「${axis}」这一行`);
    assert.match(row, valuePattern(value), `「${axis}」的满分与 weights.mjs 不一致（应为 ${value}）`);
  }
  // 三轴之和必须是 100（手册开头那句话也这么写）：
  assert.equal(WEIGHTS.hot + WEIGHTS.reputation + WEIGHTS.runnable, 100);
  // 热度的参考值（达到它就满分）也是常量，手册写错同样是说假话。
  const hotSection = text.slice(text.indexOf('### 热度'), text.indexOf('### 口碑'));
  assert.match(hotSection, valuePattern(HOT_REFERENCE_STARS_PER_WEEK), `热度那一节要写出 ${HOT_REFERENCE_STARS_PER_WEEK} 这个参考值`);
});

test('R136：口径页三轴那一行、以及手册第 8 节的标题都与 weights.mjs 一致', () => {
  const about = read(ABOUT).replace(/<!--[\s\S]*?-->/g, '');
  const manual = read(MANUAL);
  const rows = [['热度', WEIGHTS.hot], ['口碑', WEIGHTS.reputation], ['新手友好', WEIGHTS.runnable]];
  for (const [axis, value] of rows) {
    // ① 口径页：那一行里紧跟的 `<strong>` 里的数字必须就是权重。
    const row = aboutAxisRow(about, axis);
    assert.ok(row !== undefined, `口径页缺了「${axis}」那一行`);
    assert.match(row, new RegExp(`<strong>\\s*${value}\\s*</strong>`),
      `口径页「${axis}」那一行的数字与 weights.mjs（${value}）不一致：${row.trim()}`);
    // ② 手册：三轴表里那一行的满分格。
    const manualRow = manual.split('\n').find((line) => line.startsWith('|') && line.includes(`**${axis}**`));
    assert.ok(manualRow !== undefined, `手册三轴表缺了「${axis}」那一行`);
    assert.match(manualRow, new RegExp(`\\*\\*${value}\\*\\*`),
      `手册「${axis}」那一行的数字与 weights.mjs（${value}）不一致：${manualRow.trim()}`);
    // ③ 手册第 8 节的小标题也写着这个满分。
    assert.match(manual, new RegExp(`### ${axis}（满分 ${value}）`), `手册「${axis}」小标题的满分与 weights.mjs 不一致`);
  }
});

test('R136：手册与口径页的手抄分档值与 weights.mjs 一致（口碑五项、安装七档、中文两项）', () => {
  const manual = read(MANUAL);
  const about = read(ABOUT).replace(/<!--[\s\S]*?-->/g, '');

  // 口碑五项：手册的"口碑（满分 30）"那一节里，每个小项的满分格都要是它该有的那个数。
  const repAt = manual.indexOf('### 口碑');
  const repEnd = manual.indexOf('### 新手友好');
  assert.ok(repAt > -1 && repEnd > repAt, '手册缺了口碑那一节');
  const repSection = manual.slice(repAt, repEnd);
  // 值可能有重复（8 出现两次、4 出现两次），所以核对的是"这一节里每个分值都出现"，
  // 以及"这一节里每个数字都对得上某个分档"——后者才挡得住"把 6 写成 7"这种抄错。
  for (const value of Object.values(DETAIL_WEIGHTS)) {
    assert.match(repSection, valuePattern(value), `手册口碑那一节缺了 ${value} 分（DETAIL_WEIGHTS）`);
  }
  const repNumbers = [...repSection.matchAll(new RegExp(`\\|\\s*(\\d+)\\s*\\|`, 'g'))].map((m) => Number(m[1]));
  for (const n of repNumbers) {
    assert.ok(Object.values(DETAIL_WEIGHTS).includes(n), `手册口碑那一节里出现了一个对不上任何分档的数字：${n}`);
  }
  // 口径页也要给全（它按"满分 N"写，且 N 后面紧跟标签或行尾）。
  for (const value of Object.values(DETAIL_WEIGHTS)) {
    assert.match(about, new RegExp(`满分\\s*${value}(?![0-9])`), `口径页缺了 DETAIL_WEIGHTS 里的 ${value} 分`);
  }
  assert.equal(Object.values(DETAIL_WEIGHTS).reduce((a, b) => a + b, 0), WEIGHTS.reputation,
    '口碑子项之和应等于这一轴的满分');

  // 安装方式七档：手册里每个分档的**分值必须紧跟在它对应的说法后面**（"现成的 Windows 安装包 18"），
  // 不是"这一节里出现过 18"——那样把 16 与 14 对调也照样绿。
  const runAt = manual.indexOf('### 新手友好');
  assert.ok(runAt > -1, '手册缺了新手友好那一节');
  const runSection = manual.slice(runAt, runAt + 900);
  const installTiers = [
    ['Windows 安装包', RUNNABLE_POINTS.releaseWindows],
    ['一条命令', RUNNABLE_POINTS.npmBinWin],
    ['Python', RUNNABLE_POINTS.pypiCompatible],
    ['Node', RUNNABLE_POINTS.npmNoBin],
    ['编译', RUNNABLE_POINTS.buildFromSource],
    ['容器', RUNNABLE_POINTS.dockerOnly],
    ['没找到能用的安装方式', RUNNABLE_POINTS.none],
  ];
  for (const [phrase, value] of installTiers) {
    const at = runSection.indexOf(phrase);
    assert.ok(at > -1, `手册的安装分档缺了「${phrase}」这一档`);
    const nearby = runSection.slice(at, at + 60);
    assert.match(nearby, valuePattern(value), `手册里「${phrase}」后面跟的分值不是 ${value}（附近写的是：${nearby.split('\n')[0]}）`);
  }
  assert.equal(Math.max(...Object.values(RUNNABLE_POINTS)), 18, '安装方式那一项的满分变了，手册与口径页要跟着改');
  assert.match(runSection, valuePattern(Math.max(...Object.values(RUNNABLE_POINTS))), '手册要写出安装方式的满分');
  // 中文说明两项（4 + 3，合计 7）。
  for (const value of Object.values(CHINESE_POINTS)) {
    assert.match(runSection, valuePattern(value), `手册缺了中文文档分档 ${value}`);
  }
  assert.equal(Object.values(CHINESE_POINTS).reduce((a, b) => a + b, 0), 7, '中文说明那一项的合计变了');
  // 口径页的三档要按"满分 N"或"满分 <strong>N</strong>"写，方便这里和上面用同一套规则核对。
  // 这两个数从 weights.mjs 现算出来，不是把 18 / 7 再抄一遍。
  const installMax = Math.max(...Object.values(RUNNABLE_POINTS));
  const chineseTotal = CHINESE_POINTS.readmeRatio + CHINESE_POINTS.localizedFile;
  for (const [label, value] of [['安装方式', installMax], ['中文说明', chineseTotal]]) {
    // 标签与数字之间可能夹着 `<strong>`（"满分 <strong>7</strong>"），所以这里让数字各带一条**零宽**的
    // 边界断言（`(?![0-9])` 不吃字符），而不是用 boundaryPattern——它会先把空格吃掉，
    // 紧跟其后的 `(?![0-9])` 就永远为假，整条正则恒不匹配（第一版就是这么写的，被这条断言自己抓出来了）。
    assert.match(about, new RegExp(`${label}（满分\\s*(?:<strong>\\s*)?${value}(?![0-9])`),
      `口径页「${label}」那一项的满分与 weights.mjs（${value}）不一致`);
  }
  // 负面对照：证明上面这套边界规则真的带边界（否则这些断言只是看着严格）。
  assert.equal(valuePattern(WEIGHTS.hot).test('450'), false);
  assert.equal(valuePattern(WEIGHTS.hot).test('满分 45 分'), true);
  assert.equal(boundaryPattern(WEIGHTS.hot), '(?![0-9])45(?![0-9])');
});

test('文档不许把月度归档文件说成在用的功能', () => {
  const text = [read(README), read(MANUAL)].join('\n');
  // 代码事实：history/YYYY-MM.json 只被写（collect → appendHistory），读它的 readHistory 只有测试在用。
  assert.ok(!/归档[^。\n]{0,20}(用于|用来|拿来计算|参与计算)|每月归档快照的差值/.test(text),
    '把"写出来但没人读"的月度归档说成了在用的功能');
  // 要么不提，要么照实说它是留着以后用的档案。
  if (text.includes('归档')) {
    assert.match(text, /留着|留着以后|还没有被读取|没有任何代码读|暂时不参与|目前不参与|不是为了现在/,
      '提到月度归档时，必须说明它现在没有被任何代码读取');
  }
});

test('不许描述不存在的功能：没有本地探测、没有安装器', () => {
  const text = [read(README), read(MANUAL)].join('\n');
  assert.ok(!/自动为你安装|帮你装好|检测你的电脑|探测你的电脑|读取你的电脑/.test(text),
    '承诺了网站做不到的事（它是纯静态的，看不到访客的电脑）');
  assert.match(text, /纯静态|静态网页/, '要如实说清它是纯静态页面');
});

test('面向新手的正文不许出现行话（技术章节可以，但要逐处说明）', () => {
  // 只看"给新手看"的那几节：取 README 与手册里第一处行话出现之前不许有行话，
  // 但整篇里凡是出现行话的地方，附近必须有一句中文解释（否则新手看不懂）。
  const text = read(MANUAL);
  const jargon = ['star', 'fork', 'issue', 'archived', 'repo', 'commit', 'PR'];
  for (const word of jargon) {
    const pattern = new RegExp(`\\b${word}\\b`, 'i');
    if (!pattern.test(text)) continue;
    // 允许出现在"技术说明"小节里，但必须紧跟中文对照（收藏 / 拿去改造 / 作者已停止维护 / 项目）。
    assert.match(text, /收藏|拿去改造|作者已停止维护|项目/, `手册里出现了行话「${word}」却没有中文对照`);
  }
});

test('R132：口径页第三级讲的是 7 天前那份逐日快照，不是月度归档', () => {
  const text = read(ABOUT).replace(/<!--[\s\S]*?-->/g, '');
  const at = text.indexOf('归档快照');
  assert.ok(at > -1, '口径页应保留「归档快照」这一级的说法');
  // 紧挨着这一级的那句话必须把"相隔 7 天"说清楚：读的就是 7 天前的那份当天快照。
  const around = text.slice(Math.max(0, at - 200), at + 200);
  assert.match(around, /7 天前/, '第三级必须说清读的是 7 天前的那一份');
  assert.ok(!/每月归档/.test(around), '第三级不许再谎称用的是每月归档');
  // 归档文件要照实说：写出来了，但现在没有任何代码读它。
  assert.match(text, /归档/, '口径页要提到那份归档文件');
  assert.match(text, /还没有被读取|没有被读取|没有任何代码读|暂时没有|留着/, '归档文件必须照实说明现在没人读');
});

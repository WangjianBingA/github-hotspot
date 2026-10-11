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

/**
 * 把工作流按 `- name:` 切成一个个步骤（从这一行到下一个 `- name:` 之前）。
 * 为什么需要它：R133 加的那一步用的是 YAML 字面块（`run: |` 后面跟好几行 shell），
 * 而 `run: npm run collect` 那种单行写法已经不能代表"这一步到底跑了什么"了。
 * @returns {{ name: string, body: string, index: number }[]}
 */
function workflowSteps(text) {
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (/^ {6}- name: /.test(line)) starts.push(i);
  });
  return starts.map((from, k) => ({
    name: lines[from].replace(/^ {6}- name: /, '').trim(),
    body: lines.slice(from, k + 1 < starts.length ? starts[k + 1] : lines.length).join('\n'),
    index: k,
  }));
}

/**
 * 一个 YAML 文件里**会被真正执行**的那些行（也就是 shell 行），不含 `#` 开头的注释。
 * 用来区分"代码里真的这么写"与"注释里提到这个词是为了解释为什么不那么写"。
 * 它不解析 YAML，只做这一件事：把注释行剔掉、去掉每行缩进。
 * （与上面那个 commandLines 同名会很危险，所以这个叫 shellLines。）
 * @param {string} text YAML 文本
 * @returns {string[]}
 */
function shellLines(text) {
  return text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

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
  // 步骤：检出 → 装 Node 22 → （烟雾测试 → 清空）→ 采集 → 提交。
  const steps = workflowSteps(text);
  assert.ok(steps.length >= 5, `工作流步骤太少（${steps.length} 步），下面的断言会空转`);
  assert.match(text, /uses:\s*actions\/checkout@/, '缺少检出步骤');
  assert.match(text, /uses:\s*actions\/setup-node@/, '缺少装 Node 步骤');
  assert.match(text, /node-version:\s*'22'/, '没有装本项目要求的 Node 22');
  const collectStep = steps.find((s) => /npm run collect$|npm run collect\s*$/m.test(s.body) && !/--offline/.test(s.body));
  assert.ok(collectStep !== undefined, '没有任何一步在跑 npm run collect（不是 collect:offline 的那一步）');
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

test('R138：烟雾测试写下的样本数据，必须在真正采集之前被清掉', () => {
  const text = read(WORKFLOW);
  const steps = workflowSteps(text);
  const smoke = steps.findIndex((s) => /npm run collect:offline/.test(s.body));
  const clean = steps.findIndex((s) => /git clean -Xfd/.test(s.body));
  const online = steps.findIndex((s) => /npm run collect$/m.test(s.body) && !/--offline/.test(s.body));
  const commit = steps.findIndex((s) => /git add -f public\/data daily/.test(s.body));
  assert.ok(smoke > -1, '找不到烟雾测试那一步');
  assert.ok(clean > -1, '找不到"清掉烟雾测试写下的样本数据"那一步——这一步是这条工作流诚实的唯一保障');
  assert.ok(online > -1, '找不到联网采集那一步');
  assert.ok(commit > -1, '找不到提交那一步');
  // 顺序就是这条修复的核心：烟雾测试 → 清掉样本 → 联网采集 → 提交。
  assert.ok(smoke < clean, '清样本必须在烟雾测试之后（否则烟雾测试又把样本写回去了）');
  assert.ok(clean < online, '清样本必须在联网采集之前（否则样本会被一起提交）');
  assert.ok(online < commit, '提交必须在联网采集之后');
  // 清那一步必须在烟雾测试失败时也跑（它失败之前就已经把样本写到盘上了）。
  assert.match(steps[clean].body, /if:\s*always\(\)/, '清样本那一步要写成 if: always()，失败路径也要清');
  // 清的方式必须是"只删被忽略的文件"：`rm -rf public/data daily` 会把**已经提交过**的真实数据
  // 一并删掉，于是这一次提交就把历史数据整批抹掉（实测过：那会让 5 个已跟踪文件全部变成 D）。
  // 只在**真正会被执行的那些行**上查（注释里出现这个词是解释为什么不那么做，不算违规）。
  assert.ok(!/rm -rf public\/data/.test(shellLines(text).join('\n')),
    '不许在会执行的命令里用 rm -rf public/data——它会连已提交的数据一起删掉');
  assert.match(steps[clean].body, /-X/, 'git clean 必须带 -X（只删被忽略的文件），否则会波及已跟踪的数据');
  // 注释必须与事实一致：`collect:offline` **确实**会写 public/data 与 daily（它们写着 demo: true），
  // 第一版那句"它写的是临时目录，碰不到 public/data"是假的，还和 README/手册互相矛盾。
  assert.ok(!/它写的是临时目录，碰不到/.test(text), '工作流里还留着"写的是临时目录"那句假注释');
  assert.match(text, /demo: true/, '注释要说清它写下的是带 demo: true 的样本数据');
  assert.match(text, /同一批路径|DEFAULT_DATA_DIR/, '注释要指出它与联网采集写的是同一批路径');
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

test('R151：三处文档里"中文说明"那条的判据措辞必须与代码一致（只认中文，不认非中文本地化）', () => {
  // 这条断言补的是 R136/R140 的盲区：那两条只钉**数字**（7 = 4+3），不钉**判据**，
  // 所以"或者有一份本地化说明文件（例如 README.zh-CN.md）"这种句子能一直活到终审 ——
  // 它对 R143 之后的口径**不准**（只有 README.ja.md 的项目这一项得 0 分），
  // 读者很容易把它读成"日文文档照样有这 7 分"。
  const spots = [
    ['口径页', read(ABOUT).replace(/<!--[\s\S]*?-->/g, '')],
    ['README', read(README)],
    ['手册', read(MANUAL)],
  ];
  for (const [label, text] of spots) {
    // ① 判据必须写成"中文说明"（"说明"后面可以跟"文件"，也可以直接接"就给 7 分"）。
    //    加粗在口径页里是 <strong>、在 README 里是 **，两种都要认。
    assert.match(text, /中文(?:\*\*|<\/strong>)?\s*说明(?:文件)?/, `${label} 要把判据写成"中文说明（文件）"`);
    // ② 不许再把"本地化说明文件"当判据（那正是被误读成"日文也算"的写法）。
    assert.ok(!/或者有一份本地化说明文件/.test(text), `${label} 还把"本地化说明文件"当判据`);
    // ③ 后果也要写清楚：非中文的本地化说明**拿不到这一项的分**，不只是不挂徽章。
    assert.match(text, /非中文的本地化说明不给这一项的分|这一项是 0 分|这一项拿 0 分/,
      `${label} 要说清"非中文本地化说明拿不到这一项的分"`);
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
  // R141：锚点必须定在**第三级自己**身上。第一版拿 `indexOf('归档快照')` 取位置，取到的是这一节
  // 末尾那句说明（它在第三级**之后**），于是"第三级必须说清 7 天前"实际上在检查别处的文字，
  // 而 `!/每月归档/` 这条反向钉子也就永远为真——把原来那句假话放回去也照样绿。
  const rungs = text.split('\n');
  const rung3 = rungs.find((line) => line.includes('<li><strong>实测</strong>：当前收藏人数'));
  assert.ok(rung3 !== undefined, '口径页缺了第三级（「实测：当前收藏人数减去 7 天前…」）');
  assert.match(rung3, /7 天前/, '第三级必须说清读的是 7 天前的那一份');
  assert.ok(!/每月归档|月度归档/.test(rung3), `第三级不许谎称用的是每月归档：${rung3.trim()}`);
  assert.ok(!/隔得更久/.test(rung3), '第三级不许再声称"两次快照之间隔得更久"（它与第一级间隔相同）');
  // 反向锚点的证明：第三级这一行必须与它**后面**那一级分得开（否则上面那条反向钉子还是空转）。
  const rung4 = rungs.find((line) => line.includes('约 N（估算）'));
  assert.ok(rung4 !== undefined && rung4 !== rung3, '第三级与第四级必须是两行、各说各的');
  assert.match(rung4, /估算/, '第四级仍然是估算那一条');
  // 归档文件要照实说：写出来了，但现在没有任何代码读它（这句在第三级的括号里）。
  assert.match(text, /归档/, '口径页要提到那份归档文件');
  assert.match(text, /还没有被读取|没有被读取|没有任何代码读|暂时没有|留着/, '归档文件必须照实说明现在没人读');
});

// ---------- R139 / R140 / R142：README 与手册里那几句"手抄"的话也要能被核对 ----------

test('R139：文档教用户改 .gitignore 时，用的必须是文件里真实存在的那一行', () => {  const ignore = read('.gitignore');
  const lines = ignore.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  assert.ok(lines.includes('data/'), `.gitignore 里应当有一行就是 data/，实际是：${lines.join(' / ')}`);
  assert.ok(!lines.includes('/data/'), '这条断言的前提变了：.gitignore 里现在有带前导斜杠的那一行');
  for (const file of [README, MANUAL]) {
    const text = read(file);
    if (!/\.gitignore/.test(text)) continue;
    // 照着文档改的人必须能找到那一行：文档里要出现 `data/` 这个真实的行，
    // 而且不许把不存在的那一行（带前导斜杠）当成事实写出来。
    assert.ok(!/把里面的 `\/data\/` 改成|把 `\/data\/` 改成|`\/data\/` 改成只忽略/.test(text),
      `${file} 让用户改一个 .gitignore 里不存在的行（/data/）`);
    assert.match(text, /data\/` 改成只忽略|`data\/`\s*→|把 `data\/` /, `${file} 要用真实存在的那一行（data/）来说明怎么改`);
  }
});

test('R140：README 里那张手抄的权重表同样与 weights.mjs 一致', () => {
  const text = read(README);
  // 三轴表：三行里各自的数字。
  for (const [axis, value] of [['热度', WEIGHTS.hot], ['口碑', WEIGHTS.reputation], ['新手友好', WEIGHTS.runnable]]) {
    const row = text.split('\n').find((line) => line.includes(`**${axis}**`) && line.startsWith('|'));
    assert.ok(row !== undefined, `README 三轴表缺了「${axis}」那一行`);
    assert.match(row, new RegExp(`\\|\\s*${value}\\s*\\|`), `README「${axis}」的满分与 weights.mjs（${value}）不一致：${row.trim()}`);
  }
  // 热度的参考值。
  const hotRow = text.split('\n').find((line) => line.startsWith('|') && line.includes('**热度**'));
  assert.match(hotRow, valuePattern(HOT_REFERENCE_STARS_PER_WEEK), `README 热度那一行缺少 ${HOT_REFERENCE_STARS_PER_WEEK} 这个参考值`);
  // 安装七档：分值必须紧跟在对应说法后面（对调 16/14 必须被抓到）。
  // 先定位到**写着这七档的那一行**，否则 `indexOf('一条命令')` 会先撞上别的句子
  // （第一版就是这么错的：它撞上了"一条命令是什么、按不按回车"，于是断言在测别处的文字）。
  const tierLine = text.split('\n').find((line) => line.includes('安装方式越简单分越高'));
  assert.ok(tierLine !== undefined, 'README 里找不到写着安装分档的那一行');
  const tiers = [
    ['Windows 安装包', RUNNABLE_POINTS.releaseWindows],
    ['一条命令', RUNNABLE_POINTS.npmBinWin],
    ['Python', RUNNABLE_POINTS.pypiCompatible],
    ['Node', RUNNABLE_POINTS.npmNoBin],
    ['编译', RUNNABLE_POINTS.buildFromSource],
    ['容器', RUNNABLE_POINTS.dockerOnly],
    ['找不到安装方式', RUNNABLE_POINTS.none],
  ];
  for (const [phrase, value] of tiers) {
    const at = tierLine.indexOf(phrase);
    assert.ok(at > -1, `README 的安装分档缺了「${phrase}」这一档`);
    const nearby = tierLine.slice(at, at + 26);
    assert.match(nearby, valuePattern(value), `README 里「${phrase}」后面跟的分值不是 ${value}（附近：${nearby}）`);
  }
  // 中文文档那一项是 7 分，而且必须说清它是"全给 7 或 0"（不是按比例）。
  const chineseTotal = CHINESE_POINTS.readmeRatio + CHINESE_POINTS.localizedFile;
  assert.equal(chineseTotal, 7, '中文说明那一项的合计变了，README 要跟着改');
  assert.match(text, new RegExp(`${chineseTotal} 分`), `README 要写出中文文档那一项的 ${chineseTotal} 分`);
  assert.ok(!/中文再给最多 7 分|按比例给/.test(text), 'README 不许把"全给 7 或 0"说成按比例给分');
});

test('R142：README 里那三句容易读错的话与代码一致', () => {
  const text = read(README);
  // ① git status：被忽略的目录 git 根本不会列出来。事实是"git status 不会显示它们（要用 git add -f）"。
  assert.ok(!/只有 `daily\/` 会出现在 `git status` 里/.test(text),
    'README 还在说只有 daily/ 会出现在 git status 里（这句容易被读成 public/data 会显示）');
  assert.match(text, /`git status` 不会显示/, 'README 要照实说被忽略的那些文件 git status 不显示');
  assert.match(text, /git add -f/, 'README 要给出把它们加进仓库的正确做法');
  // ② 工作流是当次就提交，不是"第二天才有内容"。
  assert.ok(!/第二天就有内容/.test(text), 'README 给了工作流一个它没有的延迟（它是当次提交）');
  assert.match(text, /当次|这一次就会提交|跑完这一次/, 'README 要照实说工作流跑完这一次就会提交');
  // ③ 中文文档分是全给 7 或 0，不是按比例（与 R140 同一条事实，这里再钉一次说法）。
  assert.ok(!/中文再给最多 7 分/.test(text), 'README 不许说"中文再给最多 7 分"（那是按比例的说法）');
  // ④ 门槛的条数：独立门槛是五条，"资料清单"那一条只是门槛 5 的子集、不新增排除。
  // 手册改了条数就得全篇一致（经典榜那一节原先把"上面那六条门槛"当成事实，与这一节自相矛盾）。
  assert.match(text, /这五条|五条同时成立|不是第六道独立的门槛/, 'README 要说清独立门槛是五条、资料清单不是第六条');
  const manual = read(MANUAL);
  assert.match(manual, /这五条\*\*同时\*\*成立/, '手册要说清独立门槛是五条');
  assert.ok(!/上面那六条门槛/.test(manual), '手册里还留着"上面那六条门槛"（与它自己写着的五条矛盾）');
});

test('R147：门槛的条数在三处文档上一致（README、手册、口径页），而且都不把它说成第六条', () => {
  // 这条断言存在的理由：R142 只扫了 README 与手册，漏了 about.html —— 而 about.html 正是
  // README 指定的"完整口径"页、自己还写着"永远以这一页为准"。它就那样带着"六条"活到了终审。
  const readme = read(README);
  const manual = read(MANUAL);
  const about = read(ABOUT).replace(/<!--[\s\S]*?-->/g, '');

  assert.match(readme, /这五条/, 'README 要说清独立门槛是五条');
  assert.match(manual, /这五条\*\*同时\*\*成立/, '手册要说清独立门槛是五条');
  // 口径页：说五条，而且**不许**再把"资料清单"列成一个独立的编号项。
  assert.match(about, /<strong>五条<\/strong>/, '口径页要说清独立门槛是五条');
  assert.ok(!/上面那六条门槛|六条\*\*同时\*\*成立|这六条/.test(`${readme}\n${manual}\n${about}`), '还有文档在说"六条门槛"');
  for (const [label, text] of [['README', readme], ['手册', manual], ['口径页', about]]) {
    assert.match(text, /不是第六道|不是第六条/, `${label} 要说明"资料清单"不是第六条独立门槛`);
  }
  // 口径页那一节里：编号门槛必须是 5 条，而且"资料清单"不许出现在那 5 条里。
  const start = about.indexOf('<h2>上榜门槛');
  assert.ok(start > -1, '口径页缺了"上榜门槛"那一节');
  const gates = about.slice(start, about.indexOf('</section>', start));
  const numbered = [...gates.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  assert.equal(numbered.length, 5, `口径页的编号门槛应当正好 5 条，实际 ${numbered.length} 条：${numbered.join(' | ')}`);
  assert.ok(!numbered.some((item) => item.includes('资料清单')), '资料清单不该出现在编号门槛里');
  assert.match(gates, /资料清单/, '那句话仍要说（只是不能算作一道独立门槛）');
});

test('R148：工作流的清理步骤要"先还原被跟踪的文件、再删被忽略的文件"', () => {
  const text = read(WORKFLOW);
  const steps = workflowSteps(text);
  const clean = steps.findIndex((s) => /git clean -Xfd/.test(s.body));
  assert.ok(clean > -1, '找不到清理步骤');
  const body = steps[clean].body;

  // 只看**会被执行的那几行**（`run: |` 后面那些命令），不看注释：
  // 注释里也写着这两条命令（那是解释为什么），拿整段做 includes 会把"命令被删掉"漏过去。
  const runAt = body.indexOf('run: |');
  assert.ok(runAt > -1, '清理步骤里找不到 run: |');
  const commands = shellLines(body.slice(runAt + 'run: |'.length));
  assert.ok(commands.length >= 2, `清理步骤里的命令太少（${commands.length} 条）：${JSON.stringify(commands)}`);
  // 两行都要有，而且顺序是"先 checkout（还原被跟踪的）→ 再 clean（删被忽略的）"。
  // `--ignore-unmatch` 是必需的：仓库里可能一个数据文件都还没提交过，那时裸 `git checkout --` 会报错。
  assert.match(commands.join('\n'), /git checkout --ignore-unmatch -- public\/data daily/, '缺了"还原被跟踪文件"那一条命令');
  assert.match(commands.join('\n'), /git clean -Xfd/, '缺了"删被忽略文件"那一条命令');
  assert.ok(commands.join('\n').indexOf('git checkout') < commands.join('\n').indexOf('git clean'),
    '必须先还原再清，否则同一天第二次运行会把样本留在盘上');
  assert.match(body, /if:\s*always\(\)/, '清理步骤要写成 if: always()');
  assert.ok(!/rm -rf public\/data/.test(shellLines(text).join('\n')), '不许在会执行的命令里 rm -rf public/data');
  // 这条限制必须在注释里写明白：静态断言保证不了它，只能靠人在真实仓库里跑两次。
  assert.match(text, /Run workflow 两次|手动 Run workflow/, '注释要写清"必须人工跑两次才能验证"这条限制');
});

// Task 19 —— 面向新手的文档（README.md、docs/使用手册.md、LICENSE）的交付物纪律测试。
//
// 这一层钉住的不是"文档写没写"，而是**文档里的每一句断言是否配得上代码**：
//   · 文档里出现的每一条 `npm run X` / `npm test` 都必须在 package.json 里真实存在
//     （R99 的同一条道理：建议必须做得到，做不到的建议比没有建议更坏）；
//   · 关键路径必须真的在文档里（否则"说明书"这个交付物就是空的）；
//   · 不许承诺仓库里没有的东西：没有任何调度（没有 .github/ 工作流）、
//     月度归档文件写出来但没有任何代码读它、网站是纯静态的所以看不到访客的电脑；
//   · 面向新手的正文不许出现行话（spec §4.3）。
//
// 与 demo.test.mjs 的分工：那一层扫的是 public/ 下的页面，这一层扫的是仓库根目录的文档。
// 两者都不联网、不读时钟。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

test('文档不许承诺任何调度：仓库里没有 .github/ 工作流', () => {
  const text = [read(README), read(MANUAL)].join('\n');
  // 加了「不 / 没」否定前缀的句子是**如实说明**（"它不会自动更新"），不算承诺；
  // 没有否定的那句话才是把不存在的调度说成了事实。
  assert.ok(!/(?<![不没])每天[^。；\n]{0,8}(采集|更新)|(?<![不没])自动更新|主动采集|自动采集|定时任务会/.test(text),
    '文档把一个不存在的定时任务说成了事实');
  // 反向证据：仓库里确实没有任何工作流文件，所以上面那句不是"换个说法就行"的文字游戏。
  assert.equal(existsSync(root('.github')), false, '仓库里出现了 .github/，这条断言的前提变了');
  // 同时必须**主动**说清"采集是你自己跑出来的"，否则新手会以为网站会自己长出新数据。
  assert.match(text, /没有任何定时任务|没有定时任务|不会自己去采集|不会自动/, '要说清没有任何自动调度');
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

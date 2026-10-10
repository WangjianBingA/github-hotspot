// 新手友好度分级与三步安装向导的单元测试。
// 本文件不联网、不读文件、不执行任何命令：被测模块是纯函数，所有输入都在用例里直接构造。
//
// 除了简报钉住的 8 条，本文件把四类真实缺陷做成回归：
//   R51 —— 下载地址为空/缺失的 release 资产**不是**安装路径（不给"有东西能下载"的假徽章）；
//   R48 —— 纯静态网站不知道访客的 Python 版本，绝不编造"兼容"结论，只带要求原文；
//   R64 —— hasCjk（喂评分）与 hasChinese（徽章）是两个不同的断言，不能互相顶替；
//   归属（R42）—— repoMatches !== true 的 npm 结果一律忽略，连命令都不产出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as module from '../src/enrich/runnability.mjs';
import { classifyRunnability, buildInstallGuide } from '../src/enrich/runnability.mjs';
import { RUNNABLE_POINTS } from '../src/config/weights.mjs';

// ---------- 以下是简报钉住的 8 个用例，原样保留、不做任何削弱 ----------

test('未通过归属校验的 npm 包绝不产出安装命令', () => {
  const r = classifyRunnability({ releases:null, pypi:null,
    npm:{ packageName:'markitdown', repoMatches:false, hasBin:true, osIncludesWin:true },
    chinese:{ hasChinese:false, localizedFiles:[] } });
  assert.equal(r.verified, false);
  assert.equal(r.kind, 'none');
  assert.equal(r.command, null);
});

test('npm 有 bin 且支持 win32 → 绿色，命令为 npx', () => {
  const r = classifyRunnability({ releases:null, pypi:null,
    npm:{ packageName:'opencode-ai', repoMatches:true, hasBin:true, osIncludesWin:true },
    chinese:{ hasChinese:true, localizedFiles:['README.zh-CN.md'] } });
  assert.equal(r.kind, 'npmBinWin');
  assert.equal(r.difficulty, 'green');
  assert.match(r.command, /^npx /);
  assert.equal(r.verified, true);
});

test('有 Windows 安装包时优先于 npm', () => {
  const r = classifyRunnability({ releases:{ windowsAsset:{ name:'app-setup.exe', url:'https://x/app-setup.exe' } },
    npm:{ packageName:'x', repoMatches:true, hasBin:true, osIncludesWin:true }, pypi:null,
    chinese:{ hasChinese:false, localizedFiles:[] } });
  assert.equal(r.kind, 'releaseWindows');
  assert.equal(r.downloadUrl, 'https://x/app-setup.exe');
});

test('npm 无 bin 时降级为 npmNoBin（黄色）', () => {
  const r = classifyRunnability({ releases:null, pypi:null,
    npm:{ packageName:'x', repoMatches:true, hasBin:false, osIncludesWin:false },
    chinese:{ hasChinese:false, localizedFiles:[] } });
  assert.equal(r.kind, 'npmNoBin');
  assert.equal(r.difficulty, 'yellow');
});

test('PyPI 包给出 pip 命令；版本要求写进说明', () => {
  // R68：PyPI 与 npm 一样要先过归属校验（repoMatches === true）才下发命令，
  // 所以这条简报用例的输入补上了 repoMatches 字段；断言一字未改（见报告 §10）。
  const r = classifyRunnability({ releases:null, npm:null,
    pypi:{ packageName:'markitdown', version:'0.1.8', requiresPython:'>=3.10', repoMatches:true },
    chinese:{ hasChinese:false, localizedFiles:[] } });
  assert.equal(r.kind, 'pypiCompatible');
  assert.match(r.command, /^pip install /);
  assert.ok(r.notes.some(n => n.includes('3.10')));
});

test('什么都没有时 kind 为 none 且 verified 为 false', () => {
  const r = classifyRunnability({ releases:null, npm:null, pypi:null, chinese:{ hasChinese:false, localizedFiles:[] } });
  assert.equal(r.kind, 'none');
  assert.equal(r.verified, false);
  assert.equal(r.difficulty, 'red');
});

test('安装向导固定 3 步，步骤含命令与常见问题', () => {
  const r = classifyRunnability({ releases:null, pypi:null,
    npm:{ packageName:'opencode-ai', repoMatches:true, hasBin:true, osIncludesWin:true },
    chinese:{ hasChinese:false, localizedFiles:[] } });
  const g = buildInstallGuide(r);
  assert.equal(g.steps.length, 3);
  assert.ok(g.steps[1].command);
  assert.ok(g.faq.length >= 3);
});

test('Windows 安装包的第 2 步给下载链接而不是命令', () => {
  const g = buildInstallGuide({ kind:'releaseWindows', verified:true, difficulty:'green',
    downloadUrl:'https://x/a.exe', command:null, chineseDoc:false, notes:[] });
  assert.match(g.steps[1].body + (g.steps[1].downloadUrl || ''), /https:\/\/x\/a\.exe/);
});

// ---------- 以下是本任务新增的覆盖 ----------

// 七档的样例输入：既能钉住"每档都能出向导"，也用来把每一档的文案整体过一遍大白话检查。
const SAMPLES = {
  releaseWindows: { releases:{ windowsAsset:{ name:'app-setup.exe', url:'https://example.com/app-setup.exe' } } },
  npmBinWin: { npm:{ packageName:'opencode-ai', repoMatches:true, hasBin:true, osIncludesWin:true, evidence:'repository' } },
  pypiCompatible: { pypi:{ packageName:'markitdown', version:'0.1.8', requiresPython:'>=3.10', repoMatches:true, evidence:'project_urls' } },
  npmNoBin: { npm:{ packageName:'some-lib', repoMatches:true, hasBin:false } },
  buildFromSource: { buildFromSource:true },
  dockerOnly: { docker:true },
  none: {},
};

// 递归收集一个结构里所有字符串（向导与 notes 的文案检查共用）。
const stringsOf = (value) => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsOf);
  return [];
};

test('优先级表：releaseWindows > npmBinWin > pypiCompatible > npmNoBin > buildFromSource > dockerOnly > none', () => {
  const all = {
    releases:{ windowsAsset:{ name:'a.exe', url:'https://x/a.exe' } },
    npm:{ packageName:'p', repoMatches:true, hasBin:true, osIncludesWin:true, evidence:'repository' },
    pypi:{ packageName:'pp', version:'1.0.0', requiresPython:null, repoMatches:true },
    buildFromSource:true,
    docker:true,
  };
  assert.equal(classifyRunnability(all).kind, 'releaseWindows');
  assert.equal(classifyRunnability({ ...all, releases:null }).kind, 'npmBinWin');
  assert.equal(classifyRunnability({ ...all, releases:null, npm:null }).kind, 'pypiCompatible');
  assert.equal(classifyRunnability({ ...all, releases:null, pypi:null, npm:{ ...all.npm, hasBin:false } }).kind, 'npmNoBin');
  assert.equal(classifyRunnability({ releases:null, npm:null, pypi:null, buildFromSource:true, docker:true }).kind, 'buildFromSource');
  assert.equal(classifyRunnability({ releases:null, npm:null, pypi:null, docker:true }).kind, 'dockerOnly');
  assert.equal(classifyRunnability({ releases:null, npm:null, pypi:null }).kind, 'none');
});

test('七档的 difficulty 就是分值决定的绿/黄/红', () => {
  const expected = {
    releaseWindows:'green', npmBinWin:'green', pypiCompatible:'yellow',
    npmNoBin:'yellow', buildFromSource:'red', dockerOnly:'red', none:'red',
  };
  for (const [kind, input] of Object.entries(SAMPLES)) {
    assert.equal(classifyRunnability(input).difficulty, expected[kind], `${kind} 的难度不对`);
  }
});

test('永远只产出 RUNNABLE_POINTS 里认识的 kind（绝不产出未知档）', () => {
  const known = Object.keys(RUNNABLE_POINTS);
  for (const [kind, input] of Object.entries(SAMPLES)) {
    assert.ok(known.includes(classifyRunnability(input).kind), `${kind} 落到了未知档`);
  }
});

test('R51：下载地址是空串的安装包不算安装路径，往下落到 npm', () => {
  const r = classifyRunnability({ releases:{ windowsAsset:{ name:'app-setup.exe', url:'' } },
    npm:{ packageName:'opencode-ai', repoMatches:true, hasBin:true, osIncludesWin:true, evidence:'repository' } });
  assert.equal(r.kind, 'npmBinWin');
  assert.equal(r.downloadUrl, null);
  assert.ok(r.notes.some(n => n.includes('app-setup.exe') && n.includes('下载地址是空的')));
});

test('R51：只有空链接（或纯空白链接）的安装包时，kind 为 none、verified 为 false', () => {
  for (const url of ['', '   ', undefined]) {
    const r = classifyRunnability({ releases:{ windowsAsset:{ name:'app-setup.exe', url } } });
    assert.equal(r.kind, 'none');
    assert.equal(r.verified, false);
    assert.equal(r.downloadUrl, null);
    assert.equal(r.difficulty, 'red');
    assert.ok(r.notes.some(n => n.includes('点不开的链接')));
  }
});

test('R48：不编造"兼容"结论——要求高到不可能也照给 PyPI 路径，只带要求原文', () => {
  const r = classifyRunnability({ releases:null, npm:null,
    pypi:{ packageName:'needs-future-python', version:'9.9.9', requiresPython:'>=99.0', repoMatches:true } });
  assert.equal(r.kind, 'pypiCompatible');
  assert.equal(r.difficulty, 'yellow');
  assert.equal(r.verified, true);
  assert.equal(r.requiresPython, '>=99.0');
  assert.ok(r.notes.some(n => n.includes('99.0')));
  assert.equal('compatible' in r, false);
  assert.doesNotMatch(stringsOf(r).join('\n'), /兼容/);
});

test('R48：拿不到 Python 版本要求时同样不猜，只说实话', () => {
  const r = classifyRunnability({ releases:null, npm:null,
    pypi:{ packageName:'x', version:'1.0.0', requiresPython:null, repoMatches:true } });
  assert.equal(r.kind, 'pypiCompatible');
  assert.equal(r.requiresPython, null);
  assert.ok(r.notes.some(n => n.includes('看不到')));
  assert.doesNotMatch(stringsOf(r).join('\n'), /兼容/);
});

test('R64：只有非中文本地化文档时，chineseDoc 为 true（喂评分）、hasChinese 为 false（徽章）', () => {
  const r = classifyRunnability({ chinese:{ hasCjk:true, hasChinese:false, localizedFiles:['README.ja.md'] } });
  assert.equal(r.chineseDoc, true);
  assert.equal(r.hasChinese, false);
  assert.deepEqual(r.localizedFiles, ['README.ja.md']);
  assert.ok(r.notes.some(n => n.includes('非中文')));
});

test('R64：向导说的是「有本地化文档（非中文）」，一个字都不提"有中文说明"', () => {
  const r = classifyRunnability({ chinese:{ hasCjk:true, hasChinese:false, localizedFiles:['README.ja.md'] } });
  const text = stringsOf(buildInstallGuide(r)).join('\n');
  assert.match(text, /有本地化文档（非中文）/);
  assert.doesNotMatch(text, /有中文说明/);
});

test('R64：真有中文时，评分输入与徽章结论都给肯定，也不说"非中文"', () => {
  const r = classifyRunnability({ chinese:{ hasCjk:true, hasChinese:true, localizedFiles:['README.zh-CN.md'] } });
  assert.equal(r.chineseDoc, true);
  assert.equal(r.hasChinese, true);
  const text = stringsOf(buildInstallGuide(r)).join('\n');
  assert.match(text, /有中文说明/);
  assert.doesNotMatch(text, /非中文/);
});

// R71：上游区分不了"读过且只有英文"与"README 根本没拿到"（detectChinese 对两者都返回
// hasCjk/hasChinese 全 false），所以句子只能说我们自己的查找动作，不能替项目下"只有英文"的结论。
test('R71：没有中文时只说"我们没有查到中文说明"，不宣称项目"只有英文"（缺失与 false 两种输入都跑）', () => {
  const inputs = [
    { label:'chinese 字段缺失', chinese: undefined },
    { label:'chinese 为 null', chinese: null },
    { label:'chinese 明确全 false', chinese:{ hasCjk:false, hasChinese:false, localizedFiles:[] } },
  ];
  for (const { label, chinese } of inputs) {
    const r = classifyRunnability({ releases:null, npm:null, pypi:null, chinese });
    assert.equal(r.chineseDoc, false, label);
    assert.equal(r.hasChinese, false, label);
    const g = buildInstallGuide(r);
    const text = stringsOf(g).join('\n');
    assert.match(text, /我们没有查到中文说明/, label);
    assert.doesNotMatch(text, /只有英文/, label);
    assert.doesNotMatch(text, /有中文说明|非中文/, label);
    const item = g.faq.find(f => f.q.includes('中文'));
    assert.ok(item, label);
    assert.match(item.a, /我们没有查到中文说明/, label);
  }
});

// R70：none 恰恰是"证据缺失"时到达的档，不能在这里替项目断言"没有现成的安装方式"。
test('R70：none 档只说"我们没有找到"，不宣称项目"没有现成的安装方式"', () => {
  const inputs = [
    { label:'什么都没查到', input:{ releases:null, npm:null, pypi:null } },
    { label:'有同名 npm 包但归属不成立', input:{ npm:{ packageName:'x', repoMatches:false, hasBin:true, osIncludesWin:true } } },
    { label:'归属成立但查不到支不支持 Windows', input:{ npm:{ packageName:'x', repoMatches:true, hasBin:true } } },
    { label:'PyPI 归属没确认', input:{ pypi:{ packageName:'x', version:'1.0.0', requiresPython:null } } },
    { label:'只有空下载链接', input:{ releases:{ windowsAsset:{ name:'a.exe', url:'' } } } },
  ];
  for (const { label, input } of inputs) {
    const r = classifyRunnability(input);
    assert.equal(r.kind, 'none', label);
    const text = stringsOf(buildInstallGuide(r)).join('\n');
    assert.match(text, /我们没有找到/, label);
    assert.doesNotMatch(text, /没有现成的安装方式/, label);
    assert.doesNotMatch(text, /这个项目没有/, label);
  }
});

// R72：none 档的卸载说明也不能断言用户的机器状态 —— 我们知道的事实只是"这份向导没让你装东西"。
test('R72：none 档的卸载说明只说"这份向导没让你装"，不断言用户机器上什么都没有', () => {
  const inputs = [
    { label:'什么都没查到', input:{ releases:null, npm:null, pypi:null } },
    { label:'有同名 npm 包但归属不成立', input:{ npm:{ packageName:'x', repoMatches:false, hasBin:true, osIncludesWin:true } } },
    { label:'PyPI 归属没确认', input:{ pypi:{ packageName:'x', version:'1.0.0', requiresPython:null } } },
  ];
  for (const { label, input } of inputs) {
    const r = classifyRunnability(input);
    assert.equal(r.kind, 'none', label);
    const item = buildInstallGuide(r).faq.find(f => f.q.includes('卸载'));
    assert.ok(item, label);
    assert.match(item.a, /这份向导/, label);
    assert.match(item.a, /项目主页/, label);            // 自己装过的人要有出路
    assert.doesNotMatch(item.a, /你还没有装/, label);   // 不断言用户机器状态
    assert.doesNotMatch(item.a, /没有装任何东西/, label);
  }
});

// R68：上游 lookupPyPI 没有归属字段，所以在拿到 repoMatches === true 之前，一条 pip install 都不下发。
test('R68：PyPI 归属没确认（字段缺失或 false）时不下发 pip 命令，该档不成立', () => {
  const missing = { packageName:'markitdown', version:'0.1.8', requiresPython:'>=3.10' };
  const denied = { packageName:'markitdown', version:'0.1.8', requiresPython:'>=3.10', repoMatches:false };
  for (const pypi of [missing, denied]) {
    const r = classifyRunnability({ releases:null, npm:null, pypi });
    assert.equal(r.kind, 'none');
    assert.equal(r.command, null);
    assert.equal(r.verified, false);
    assert.equal(r.requiresPython, null);
    assert.ok(r.notes.some(n => n.includes('没能确认它确实属于这个项目')));
    const g = buildInstallGuide(r);
    assert.equal(g.steps[1].command, undefined);
    assert.doesNotMatch(stringsOf(g).join('\n'), /pip install/);
  }
});

test('R68：PyPI 归属确认（repoMatches === true）时照常给 pip 命令', () => {
  const r = classifyRunnability({ pypi:{ packageName:'markitdown', version:'0.1.8', requiresPython:'>=3.10', repoMatches:true } });
  assert.equal(r.kind, 'pypiCompatible');
  assert.equal(r.command, 'pip install markitdown');
  assert.equal(r.verified, true);
  assert.ok(r.notes.every(n => !n.includes('没能确认它确实属于这个项目')));
});

test('R68：PyPI 归属不成立不影响优先级更高的路径（有安装包照样给下载链接）', () => {
  const r = classifyRunnability({ releases:{ windowsAsset:{ name:'a.exe', url:'https://x/a.exe' } },
    pypi:{ packageName:'markitdown', repoMatches:false } });
  assert.equal(r.kind, 'releaseWindows');
  assert.equal(r.downloadUrl, 'https://x/a.exe');
  assert.ok(r.notes.some(n => n.includes('没能确认它确实属于这个项目')));
});

test('chinese 整个缺失时两个中文结论都为 false，localizedFiles 为空数组', () => {
  const r = classifyRunnability({ pypi:{ packageName:'x', version:'1.0.0', requiresPython:null, repoMatches:true } });
  assert.equal(r.chineseDoc, false);
  assert.equal(r.hasChinese, false);
  assert.deepEqual(r.localizedFiles, []);
});

test('归属校验失败：不产出命令，但有一条"为什么不敢给你装"的说明', () => {
  const r = classifyRunnability({ npm:{ packageName:'markitdown', repoMatches:false, hasBin:true, osIncludesWin:true, evidence:'none' } });
  assert.equal(r.kind, 'none');
  assert.equal(r.command, null);
  assert.equal(r.verified, false);
  assert.ok(r.notes.some(n => n.includes('markitdown') && n.includes('没有声明自己来自这个项目')));
});

test('归属是 npm 与 PyPI 各自的前提：npm 归属失败不影响归属已确认的 PyPI 路径', () => {
  const r = classifyRunnability({ npm:{ packageName:'markitdown', repoMatches:false, hasBin:true, osIncludesWin:true },
    pypi:{ packageName:'markitdown', version:'0.1.8', requiresPython:'>=3.10', repoMatches:true } });
  assert.equal(r.kind, 'pypiCompatible');
  assert.equal(r.command, 'pip install markitdown');
  assert.ok(r.notes.some(n => n.includes('没有声明自己来自这个项目')));
});

test('npm 有 bin 但声明不支持 Windows：不给命令，有 PyPI 时落到 PyPI', () => {
  const r = classifyRunnability({ npm:{ packageName:'mac-only', repoMatches:true, hasBin:true, osIncludesWin:false, evidence:'repository' },
    pypi:{ packageName:'mac-only', version:'1.0.0', requiresPython:null, repoMatches:true } });
  assert.equal(r.kind, 'pypiCompatible');
  assert.ok(r.notes.some(n => n.includes('不支持 Windows')));
});

test('npm 有 bin 但声明不支持 Windows、又没有别的路径时：none 且不产出命令', () => {
  const r = classifyRunnability({ npm:{ packageName:'mac-only', repoMatches:true, hasBin:true, osIncludesWin:false, evidence:'repository' } });
  assert.equal(r.kind, 'none');
  assert.equal(r.command, null);
  assert.equal(r.verified, false);
});

test('npm 有 bin 但查不到支不支持 Windows 时也不猜（不给可能装不上的命令）', () => {
  const r = classifyRunnability({ npm:{ packageName:'unknown-os', repoMatches:true, hasBin:true, evidence:'repository' } });
  assert.equal(r.kind, 'none');
  assert.equal(r.command, null);
  assert.ok(r.notes.some(n => n.includes('支不支持 Windows')));
});

test('buildFromSource 与 dockerOnly 只认调用方明确给出的证据，且都算"已核实的路径"', () => {
  const build = classifyRunnability({ releases:null, npm:null, pypi:null, buildFromSource:true, docker:true });
  assert.equal(build.kind, 'buildFromSource');
  assert.equal(build.difficulty, 'red');
  assert.equal(build.verified, true);
  assert.ok(build.notes.some(n => n.includes('编译')));

  const docker = classifyRunnability({ releases:null, npm:null, pypi:null, docker:true });
  assert.equal(docker.kind, 'dockerOnly');
  assert.equal(docker.difficulty, 'red');
  assert.equal(docker.verified, true);
  assert.ok(docker.notes.some(n => n.includes('Docker')));
});

test('没有证据时绝不猜"要自己编译"或"只有 Docker"', () => {
  const r = classifyRunnability({ releases:null, npm:null, pypi:null });
  assert.equal(r.kind, 'none');
  assert.ok(r.notes.every(n => !n.includes('编译') && !n.includes('Docker')));
});

test('evidence 照实透传：npm 说明凭什么认定归属，安装包带资产名，PyPI 带包名', () => {
  assert.equal(classifyRunnability({ npm:{ packageName:'a', repoMatches:true, hasBin:true, osIncludesWin:true, evidence:'bugs.url' } }).evidence, 'bugs.url');
  assert.equal(classifyRunnability({ npm:{ packageName:'a', repoMatches:true, hasBin:true, osIncludesWin:true, evidence:'homepage' } }).evidence, 'homepage');
  assert.equal(classifyRunnability({ releases:{ windowsAsset:{ name:'app-setup.exe', url:'https://x/a.exe' } } }).evidence, 'release asset: app-setup.exe');
  assert.equal(classifyRunnability({ pypi:{ packageName:'markitdown', version:'0.1.8', requiresPython:null, repoMatches:true } }).evidence, 'pypi package: markitdown');
  // Task 10B 给 lookupPyPI 补上取证字段后，与 npm 一样原样透传（界面据此解释"凭什么认定归属"）。
  assert.equal(classifyRunnability({ pypi:{ packageName:'markitdown', version:'0.1.8', requiresPython:null, repoMatches:true, evidence:'project_urls' } }).evidence, 'project_urls');
  assert.equal(classifyRunnability({}).evidence, null);
});

test('非法或空输入一律落到 none，不抛错', () => {
  for (const input of [undefined, null, {}, 'x', 42, []]) {
    const r = classifyRunnability(input);
    assert.equal(r.kind, 'none');
    assert.equal(r.verified, false);
    assert.equal(r.command, null);
    assert.equal(r.downloadUrl, null);
    assert.equal(r.evidence, null);
    assert.equal(r.difficulty, 'red');
    assert.equal(r.chineseDoc, false);
    assert.equal(r.hasChinese, false);
    assert.deepEqual(r.localizedFiles, []);
    assert.ok(Array.isArray(r.notes));
  }
});

test('第 2 步要么给命令、要么给下载链接，而且正文里也带着它', () => {
  const npm = buildInstallGuide(classifyRunnability(SAMPLES.npmBinWin));
  assert.equal(npm.steps[1].command, 'npx opencode-ai');
  assert.ok(npm.steps[1].body.includes('npx opencode-ai'));

  const py = buildInstallGuide(classifyRunnability(SAMPLES.pypiCompatible));
  assert.equal(py.steps[1].command, 'pip install markitdown');
  assert.ok(py.steps[1].body.includes('pip install markitdown'));

  const noBin = buildInstallGuide(classifyRunnability(SAMPLES.npmNoBin));
  assert.equal(noBin.steps[1].command, 'npm install some-lib');

  const rel = buildInstallGuide(classifyRunnability(SAMPLES.releaseWindows));
  assert.equal(rel.steps[1].downloadUrl, 'https://example.com/app-setup.exe');
  assert.equal(rel.steps[1].command, undefined);
  assert.ok(rel.steps[1].body.includes('https://example.com/app-setup.exe'));
});

test('三步的标题说的是：先准备什么 / 怎么装 / 怎么用', () => {
  const g = buildInstallGuide(classifyRunnability(SAMPLES.releaseWindows));
  assert.match(g.steps[0].title, /第 1 步/);
  assert.match(g.steps[0].title, /准备/);
  assert.match(g.steps[1].title, /第 2 步/);
  assert.match(g.steps[2].title, /第 3 步/);
  assert.match(g.steps[2].title, /怎么用/);
});

test('每一档的向导都是完整三步 + 至少 3 条常见问题，且每一句都非空、不含 undefined', () => {
  for (const [kind, input] of Object.entries(SAMPLES)) {
    const run = classifyRunnability(input);
    const g = buildInstallGuide(run);
    assert.equal(g.steps.length, 3, `${kind} 的步数不对`);
    assert.ok(g.faq.length >= 3, `${kind} 的常见问题太少`);
    for (const step of g.steps) {
      assert.ok(typeof step.title === 'string' && step.title.trim() !== '', `${kind} 有空的步骤标题`);
      assert.ok(typeof step.body === 'string' && step.body.trim() !== '', `${kind} 有空的步骤正文`);
    }
    for (const item of g.faq) {
      assert.ok(typeof item.q === 'string' && item.q.trim() !== '', `${kind} 有空的常见问题`);
      assert.ok(typeof item.a === 'string' && item.a.trim() !== '', `${kind} 有空的常见问题答案`);
    }
    for (const text of stringsOf(g)) assert.doesNotMatch(text, /undefined/);
  }
});

test('每一档的常见问题里都有"装错了怎么卸载"，答案不为空', () => {
  for (const [kind, input] of Object.entries(SAMPLES)) {
    const g = buildInstallGuide(classifyRunnability(input));
    const item = g.faq.find(f => f.q.includes('卸载'));
    assert.ok(item, `${kind} 缺少卸载说明`);
    assert.ok(item.a.trim() !== '');
  }
});

test('常见问题的问题不重复', () => {
  for (const [kind, input] of Object.entries(SAMPLES)) {
    const g = buildInstallGuide(classifyRunnability(input));
    const questions = g.faq.map(f => f.q);
    assert.equal(new Set(questions).size, questions.length, `${kind} 的常见问题有重复`);
  }
});

// 大白话检查：不许出现行话，也不许漏出任何字段名。
const JARGON = [/\bstar\b/i, /\bfork\b/i, /\bissue\b/i, /\barchiv/i];
const LEAKED_FIELDS = ['repoMatches', 'hasBin', 'osIncludesWin', 'windowsAsset', 'requires_python',
  'browser_download_url', 'hasCjk', 'hasChinese', 'downloadUrl', 'localizedFiles', 'packageName',
  'requiresPython', 'verified', 'difficulty', 'evidence'];

test('全部文案都是大白话：不出现 star/fork/issue/archived，也不漏字段名', () => {
  for (const [kind, input] of Object.entries(SAMPLES)) {
    const run = classifyRunnability(input);
    const texts = [...stringsOf(buildInstallGuide(run)), ...run.notes];
    for (const text of texts) {
      for (const re of JARGON) assert.doesNotMatch(text, re, `${kind} 的文案里有行话：${text}`);
      for (const field of LEAKED_FIELDS) {
        assert.ok(!text.includes(field), `${kind} 的文案漏出了字段名 ${field}：${text}`);
      }
    }
  }
});

test('未知 kind 也能生成完整向导，且不编造"没有安装方式"这种结论', () => {
  const g = buildInstallGuide({ kind:'未来才会有的新方式', verified:false, difficulty:'red', notes:[] });
  assert.equal(g.steps.length, 3);
  assert.ok(g.faq.length >= 3);
  const text = stringsOf(g).join('\n');
  assert.doesNotMatch(text, /没有现成的安装方式/);
});

test('向导对 null / 非对象 / 空对象都不抛错，三步与常见问题照给', () => {
  for (const input of [undefined, null, {}, 'x', 42, [], { command:null, downloadUrl:null }]) {
    const g = buildInstallGuide(input);
    assert.equal(g.steps.length, 3);
    assert.ok(g.faq.length >= 3);
    for (const text of stringsOf(g)) assert.doesNotMatch(text, /undefined/);
  }
});

test('runnability.mjs 只导出简报约定的两个接口', () => {
  assert.deepEqual(Object.keys(module).sort(), ['buildInstallGuide', 'classifyRunnability']);
});

// registry 直查与包名归属校验测试。
// 全部由注入的假 client 驱动，本文件绝不联网。
// 夹具是手写的 packument / PyPI 响应对象，字段形状照抄真实响应：
//   · opencode-ai 的版本对象确实长这样（bin + os，实测 registry.npmjs.org/opencode-ai/latest）；
//   · repository 的真实写法多为对象（git+https / git+ssh / git 协议，部分带 directory）；
//     但 npm 也允许字符串短式（"github:owner/repo"、"owner/repo"），两种都必须支持。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../src/sources/registry.mjs';
import { lookupNpm, lookupPyPI, normalizeRepoUrl, isPythonCompatible } from '../src/sources/registry.mjs';

// 只回固定响应体的假 client。
const client = (body) => ({ getJson: async () => body });

// 会记录"请求了什么"的假 client：用来钉住请求地址与 api:'none'。
const spying = (body) => {
  const calls = [];
  return {
    calls,
    getJson: async (url, options) => {
      calls.push({ url, options });
      return body;
    }
  };
};

// ---------- 以下是简报钉住的 5 个用例，原样保留、不做任何削弱 ----------

test('同名但 repository 指向别的仓库时必须判定不匹配', async () => {
  const packument = { name:'markitdown', 'dist-tags':{latest:'1.0.0'},
    versions:{ '1.0.0':{ bin:{ markitdown:'cli.js' }, repository:{ url:'git+https://github.com/dead8309/markitdown-ts.git' } } } };
  assert.equal((await lookupNpm(client(packument), 'markitdown', 'microsoft/markitdown')).repoMatches, false);
});

test('repository 指向目标仓库时匹配并读出 bin 与 os', async () => {
  const packument = { name:'opencode-ai', 'dist-tags':{latest:'1.18.35'},
    versions:{ '1.18.35':{ bin:{ opencode:'bin/opencode.exe' }, os:['darwin','linux','win32'],
      repository:{ url:'git+https://github.com/sst/opencode.git' } } } };
  const r = await lookupNpm(client(packument), 'opencode-ai', 'sst/opencode');
  assert.equal(r.repoMatches, true);
  assert.equal(r.hasBin, true);
  assert.equal(r.osIncludesWin, true);
});

test('normalizeRepoUrl 抹平 git+ / .git / 大小写 / 末尾斜杠', () => {
  assert.equal(normalizeRepoUrl('git+https://github.com/SST/OpenCode.git'), normalizeRepoUrl('https://github.com/sst/opencode/'));
});

test('requires_python 与本机 Python 比对', () => {
  assert.equal(isPythonCompatible('>=3.10', '3.10.11'), true);
  assert.equal(isPythonCompatible('>=3.12', '3.10.11'), false);
  assert.equal(isPythonCompatible('<3.15,>=3.10', '3.10.11'), true);
  assert.equal(isPythonCompatible(null, '3.10.11'), true);
});

test('请求失败返回 null 而不是抛错', async () => {
  assert.equal(await lookupNpm({ getJson: async () => null }, 'x', 'a/b'), null);
});

// ---------- 归属校验：名字永远不是证据 ----------

test('没有 repository 字段时绝不判定匹配（包名相同不算证据）', async () => {
  // 实测：registry.npmjs.org/markitdown 真实包（0.0.4，作者 Ben Taber）就没有 repository 字段。
  const packument = { name:'markitdown', 'dist-tags':{latest:'0.0.4'},
    versions:{ '0.0.4':{ bin:{ markitdown:'./bin/markitdown' } } } };
  const r = await lookupNpm(client(packument), 'markitdown', 'microsoft/markitdown');
  assert.equal(r.repoMatches, false);
  assert.equal(r.hasBin, true);
});

test('repository 写成字符串短式时同样能判定归属', async () => {
  const mk = (repository) => ({ name:'x', 'dist-tags':{latest:'1.0.0'}, versions:{ '1.0.0':{ repository } } });
  assert.equal((await lookupNpm(client(mk('github:sst/opencode')), 'x', 'sst/opencode')).repoMatches, true);
  assert.equal((await lookupNpm(client(mk('sst/opencode')), 'x', 'sst/opencode')).repoMatches, true);
  // 指向别人的字符串短式同样必须判不匹配。
  assert.equal((await lookupNpm(client(mk('github:dead8309/markitdown-ts')), 'x', 'microsoft/markitdown')).repoMatches, false);
});

test('monorepo 子目录、git+ssh / git 协议、.git 后缀与大小写都不影响归属判定', async () => {
  const mk = (url) => ({ name:'x', 'dist-tags':{latest:'1.0.0'}, versions:{ '1.0.0':{ repository:{ type:'git', url, directory:'packages/x' } } } });
  const cases = [
    'https://github.com/sst/opencode/tree/main/packages/x',
    'git+ssh://git@github.com/sst/opencode.git',
    'git://github.com/SST/OpenCode.git',
    'https://github.com/sst/opencode/'
  ];
  for (const url of cases) {
    assert.equal((await lookupNpm(client(mk(url)), 'x', 'sst/opencode')).repoMatches, true, `仓库地址：${url}`);
  }
  // 目标仓库名的大小写同样不影响判定。
  assert.equal((await lookupNpm(client(mk('https://github.com/sst/opencode.git')), 'x', 'SST/OpenCode')).repoMatches, true);
});

test('normalizeRepoUrl 的输入→输出表：真实写法全部收敛到 owner/repo', () => {
  const cases = [
    ['git+https://github.com/sst/opencode.git', 'sst/opencode'],
    ['https://github.com/SST/OpenCode/', 'sst/opencode'],
    ['https://github.com/sst/opencode.git/', 'sst/opencode'],
    ['https://github.com/owner/repo/tree/main/packages/x', 'owner/repo'],
    ['https://github.com/owner/repo#readme', 'owner/repo'],
    ['git://github.com/debug-js/debug.git', 'debug-js/debug'],
    ['git+ssh://git@github.com/isaacs/rimraf.git', 'isaacs/rimraf'],
    ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['github:sst/opencode', 'sst/opencode'],
    ['owner/repo', 'owner/repo'],
    ['tj/commander.js', 'tj/commander.js'],                          // 仓库名里的点必须保留
    ['https://www.github.com/owner/repo', 'owner/repo'],
    ['https://gitlab.com/sst/opencode', 'gitlab.com/sst/opencode']   // 非 GitHub 主机保留主机名
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeRepoUrl(input), expected, `输入：${input}`);
  }

  // repository 的对象形式：url 之外还有 type / directory（monorepo 子目录）也照样只看 url。
  assert.equal(normalizeRepoUrl({ url:'git+https://github.com/owner/repo.git', type:'git', directory:'packages/x' }), 'owner/repo');

  // 无法确定是哪个仓库的输入一律返回空串：绝不让"猜出来"的东西进入比较。
  for (const bad of ['', '   ', null, undefined, 42, {}, { url:42 }, 'https://github.com/sst', 'markitdown', 'https://gitlab.com/sst']) {
    assert.equal(normalizeRepoUrl(bad), '', `输入：${String(bad)}`);
  }
});

test('repository 解析不出 owner/repo（空对象、数字、只有 owner）时判定不匹配', async () => {
  const mk = (repository) => ({ name:'x', 'dist-tags':{latest:'1.0.0'}, versions:{ '1.0.0':{ repository } } });
  assert.equal((await lookupNpm(client(mk({})), 'x', 'sst/opencode')).repoMatches, false);
  assert.equal((await lookupNpm(client(mk(42)), 'x', 'sst/opencode')).repoMatches, false);
  assert.equal((await lookupNpm(client(mk('https://github.com/sst')), 'x', 'sst/opencode')).repoMatches, false);
  assert.equal((await lookupNpm(client(mk('https://github.com/sst/opencode')), 'x', '')).repoMatches, false);
});

test('repository 指向非 GitHub 主机的同名仓库时不算匹配', async () => {
  // 归一化只在 GitHub 主机上丢掉主机名；别的平台上"同名同作者名"不能算同一个仓库。
  const mk = (url) => ({ name:'x', 'dist-tags':{latest:'1.0.0'}, versions:{ '1.0.0':{ repository:{ url } } } });
  assert.equal((await lookupNpm(client(mk('https://gitlab.com/sst/opencode')), 'x', 'sst/opencode')).repoMatches, false);
});

// ---------- 请求地址与额度类别 ----------

test('未加 scope 的包名请求 registry 的裸路径，且不吃 GitHub 额度', async () => {
  const spy = spying({ name:'markitdown', 'dist-tags':{latest:'0.1.8'}, versions:{ '0.1.8':{ repository:{ url:'https://github.com/microsoft/markitdown' } } } });
  const r = await lookupNpm(spy, 'markitdown', 'microsoft/markitdown');
  assert.deepEqual(spy.calls, [{ url: 'https://registry.npmjs.org/markitdown', options: { api: 'none' } }]);
  assert.deepEqual(r, { packageName:'markitdown', version:'0.1.8', hasBin:false, osIncludesWin:true, repoMatches:true });
});

test('scoped 包名（@scope/name）按未编码斜杠请求 registry', async () => {
  // registry 接受未编码的斜杠：https://registry.npmjs.org/@scope/name（实测 @types/node 返回 200）。
  const spy = spying({ name:'@sst/opencode', 'dist-tags':{latest:'1.0.0'},
    versions:{ '1.0.0':{ bin:{ opencode:'bin/opencode.exe' }, repository:{ url:'git+https://github.com/sst/opencode.git' } } } });
  const r = await lookupNpm(spy, '@sst/opencode', 'sst/opencode');
  assert.equal(spy.calls[0].url, 'https://registry.npmjs.org/@sst/opencode');
  assert.equal(spy.calls[0].options.api, 'none');
  assert.deepEqual(r, { packageName:'@sst/opencode', version:'1.0.0', hasBin:true, osIncludesWin:true, repoMatches:true });
});

// ---------- hasBin / osIncludesWin 的判定边界 ----------

test('hasBin 只认非空字符串或非空对象', async () => {
  const mk = (bin) => ({ name:'x', 'dist-tags':{latest:'1.0.0'}, versions:{ '1.0.0':{ bin, repository:{ url:'https://github.com/a/b' } } } });
  assert.equal((await lookupNpm(client(mk('cli.js')), 'x', 'a/b')).hasBin, true);
  assert.equal((await lookupNpm(client(mk({ x:'cli.js' })), 'x', 'a/b')).hasBin, true);
  assert.equal((await lookupNpm(client(mk({})), 'x', 'a/b')).hasBin, false);
  assert.equal((await lookupNpm(client(mk('')), 'x', 'a/b')).hasBin, false);
  assert.equal((await lookupNpm(client(mk([ 'cli.js' ])), 'x', 'a/b')).hasBin, false);
  const noBin = { name:'x', 'dist-tags':{latest:'1.0.0'}, versions:{ '1.0.0':{ repository:{ url:'https://github.com/a/b' } } } };
  assert.equal((await lookupNpm(client(noBin), 'x', 'a/b')).hasBin, false);
});

test('没写 os 视为不限制平台（支持 Windows），写了就以它为准', async () => {
  const mk = (os) => ({ name:'x', 'dist-tags':{latest:'1.0.0'}, versions:{ '1.0.0':{ os, repository:{ url:'https://github.com/a/b' } } } });
  // npm 的语义：没有 os 字段 = 哪里都能跑。
  assert.equal((await lookupNpm(client(mk(undefined)), 'x', 'a/b')).osIncludesWin, true);
  assert.equal((await lookupNpm(client(mk('win32')), 'x', 'a/b')).osIncludesWin, true);
  assert.equal((await lookupNpm(client(mk([ 'darwin', 'linux', 'win32' ])), 'x', 'a/b')).osIncludesWin, true);
  // 写了平台列表但只列非 Windows：必须判 false，否则会给初学者一条在 Windows 上跑不通的命令。
  assert.equal((await lookupNpm(client(mk([ 'darwin', 'linux' ])), 'x', 'a/b')).osIncludesWin, false);
  assert.equal((await lookupNpm(client(mk('linux')), 'x', 'a/b')).osIncludesWin, false);
  // 明确排除 win32 时保守判 false；空列表同样不能声称支持 Windows。
  assert.equal((await lookupNpm(client(mk([ 'darwin', '!win32' ])), 'x', 'a/b')).osIncludesWin, false);
  assert.equal((await lookupNpm(client(mk([])), 'x', 'a/b')).osIncludesWin, false);
});

// ---------- 结构不对一律返回 null ----------

test('packument 结构不对、响应体为 null 或抛错时返回 null，绝不抛错', async () => {
  assert.equal(await lookupNpm(client({}), 'x', 'a/b'), null);
  assert.equal(await lookupNpm(client({ 'dist-tags':{ latest:'1.0.0' } }), 'x', 'a/b'), null);
  assert.equal(await lookupNpm(client({ 'dist-tags':{ latest:'2.0.0' }, versions:{ '1.0.0':{} } }), 'x', 'a/b'), null);
  assert.equal(await lookupNpm(client('不是对象'), 'x', 'a/b'), null);
  assert.equal(await lookupNpm(client({ name:'x', 'dist-tags':{ latest:'1.0.0' }, versions:{ '1.0.0':{} } }), '  ', 'a/b'), null);
  assert.equal(await lookupNpm({ getJson: async () => { throw new Error('网络超时'); } }, 'x', 'a/b'), null);
  assert.equal(await lookupNpm(undefined, 'x', 'a/b'), null);
  assert.equal(await lookupNpm({}, 'x', 'a/b'), null);
});

// ---------- PyPI ----------

test('lookupPyPI 读出最新版本与 requires_python，并按 PEP 503 归一化包名', async () => {
  const spy = spying({ info:{ name:'MarkItDown', version:'0.1.8', requires_python:'<3.15,>=3.10' } });
  const r = await lookupPyPI(spy, 'MarkItDown');
  assert.deepEqual(spy.calls, [{ url:'https://pypi.org/pypi/markitdown/json', options:{ api:'none' } }]);
  assert.deepEqual(r, { packageName:'MarkItDown', version:'0.1.8', requiresPython:'<3.15,>=3.10' });
});

test('PyPI 包名的下划线、点、大小写都被归一化成连字符', async () => {
  // PEP 503：-/_/. 可互换。不同写法必须请求到同一个包，不能因为写法不同就查不到。
  for (const [input, expected] of [['my_package', 'my-package'], ['My.Package', 'my-package'], ['MY__PACKAGE', 'my-package'], ['my-package', 'my-package']]) {
    const spy = spying({ info:{ name:'my-package', version:'1.0.0' } });
    await lookupPyPI(spy, input);
    assert.equal(spy.calls[0].url, `https://pypi.org/pypi/${expected}/json`, `输入：${input}`);
  }
});

test('缺少 requires_python 时 requiresPython 为 null，并视为兼容', async () => {
  const spy = spying({ info:{ name:'markitdown', version:'0.1.8' } });
  const r = await lookupPyPI(spy, 'markitdown');
  assert.equal(r.requiresPython, null);
  assert.equal(isPythonCompatible(r.requiresPython, '3.10.11'), true);
});

test('PyPI 请求失败、结构不对或包名为空时返回 null，绝不抛错', async () => {
  assert.equal(await lookupPyPI({ getJson: async () => null }, 'x'), null);
  assert.equal(await lookupPyPI({ getJson: async () => { throw new Error('网络超时'); } }, 'x'), null);
  assert.equal(await lookupPyPI(client({}), 'x'), null);
  assert.equal(await lookupPyPI(client({ info:{} }), 'x'), null);
  assert.equal(await lookupPyPI(client({ info:{ name:'x', version:'' } }), 'x'), null);
  assert.equal(await lookupPyPI(client({ info:{ name:'x', version:'1.0.0' } }), ''), null);
  assert.equal(await lookupPyPI(undefined, 'x'), null);
});

// ---------- isPythonCompatible 的边界 ----------

test('isPythonCompatible 只比 major.minor，忽略补丁号与预发布后缀', () => {
  assert.equal(isPythonCompatible('>=3.10.2', '3.10.0'), true);   // 只比 3.10，不看补丁
  assert.equal(isPythonCompatible('==3.10.*', '3.10.11'), true);
  assert.equal(isPythonCompatible('!=3.10', '3.10.11'), false);
  assert.equal(isPythonCompatible('>3.10', '3.10.11'), false);
  assert.equal(isPythonCompatible('>=3.13', '3.13.0rc1'), true);  // 预发布后缀被忽略
  assert.equal(isPythonCompatible('<=3.12', '3.13.0a1'), false);
  assert.equal(isPythonCompatible('', '3.10.11'), true);
  assert.equal(isPythonCompatible(undefined, '3.10.11'), true);
});

test('isPythonCompatible 解析真实的多条件约束，读不懂的约束一律判不兼容', () => {
  // PyPI 上 markitdown 的真实值就是 <3.15,>=3.10；下面这条是很多包在用的老写法。
  assert.equal(isPythonCompatible('>=2.7, !=3.0.*, !=3.1.*, !=3.2.*, !=3.3.*', '3.10.11'), true);
  assert.equal(isPythonCompatible('>=2.7, !=3.0.*, !=3.1.*, !=3.2.*, !=3.3.*', '3.1.5'), false);
  // ~= 之类看不懂的写法不能当成"兼容"：宁可少给一条安装命令，也不给错。
  assert.equal(isPythonCompatible('~=3.10', '3.10.11'), false);
  assert.equal(isPythonCompatible('abc', '3.10.11'), false);
  // 本机版本读不出来时不允许给出"兼容"结论。
  assert.equal(isPythonCompatible('>=3.10', '不知道'), false);
});

// ---------- 交付物纪律 ----------

test('模块只导出简报约定的四个接口，不产出任何安装命令', () => {
  assert.deepEqual(Object.keys(registry).sort(),
    ['isPythonCompatible', 'lookupNpm', 'lookupPyPI', 'normalizeRepoUrl']);
});

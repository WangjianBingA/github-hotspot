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
  assert.deepEqual(r, { packageName:'markitdown', version:'0.1.8', hasBin:false, osIncludesWin:true, repoMatches:true, evidence:'repository' });
});

test('scoped 包名（@scope/name）按未编码斜杠请求 registry', async () => {
  // registry 接受未编码的斜杠：https://registry.npmjs.org/@scope/name（实测 @types/node 返回 200）。
  const spy = spying({ name:'@sst/opencode', 'dist-tags':{latest:'1.0.0'},
    versions:{ '1.0.0':{ bin:{ opencode:'bin/opencode.exe' }, repository:{ url:'git+https://github.com/sst/opencode.git' } } } });
  const r = await lookupNpm(spy, '@sst/opencode', 'sst/opencode');
  assert.equal(spy.calls[0].url, 'https://registry.npmjs.org/@sst/opencode');
  assert.equal(spy.calls[0].options.api, 'none');
  assert.deepEqual(r, { packageName:'@sst/opencode', version:'1.0.0', hasBin:true, osIncludesWin:true, repoMatches:true, evidence:'repository' });
});

// ---------- R42：多来源取证（扩大归属证据，但绝不退化成信包名） ----------

test('R42：包级 repository（版本级没写）同样算归属证据', async () => {
  const packument = { name:'opencode-ai', 'dist-tags':{latest:'1.18.35'},
    repository:{ type:'git', url:'git+https://github.com/sst/opencode.git' },
    versions:{ '1.18.35':{ bin:{ opencode:'bin/opencode.exe' } } } };
  const r = await lookupNpm(client(packument), 'opencode-ai', 'sst/opencode');
  assert.equal(r.repoMatches, true);
  assert.equal(r.evidence, 'repository');
});

test('R42：repository 缺失时 bugs.url 命中即算归属成立', async () => {
  const mk = (bugs) => ({ name:'x', 'dist-tags':{latest:'1.0.0'}, versions:{ '1.0.0':{ bugs } } });
  // 对象形式（真实包里绝大多数是这种）与字符串形式都要认。
  const asObject = await lookupNpm(client(mk({ url:'https://github.com/sst/opencode/issues' })), 'x', 'sst/opencode');
  assert.equal(asObject.repoMatches, true);
  assert.equal(asObject.evidence, 'bugs.url');
  assert.equal((await lookupNpm(client(mk('https://github.com/sst/opencode/issues')), 'x', 'sst/opencode')).evidence, 'bugs.url');
  // 指向别人的 issue 区不是证据。
  assert.equal((await lookupNpm(client(mk({ url:'https://github.com/dead8309/markitdown-ts/issues' })), 'x', 'sst/opencode')).evidence, 'none');
  assert.equal((await lookupNpm(client(mk({ email:'dev@example.com' })), 'x', 'sst/opencode')).evidence, 'none');
});

test('R42：homepage 只在指向目标仓库路径内时才算证据，纯文档站不算', async () => {
  // at = 'version' 表示写在版本对象里，'package' 表示写在 packument 顶层。
  const mk = (homepage, at) => ({
    name:'x', 'dist-tags':{latest:'1.0.0'},
    ...(at === 'package' ? { homepage } : {}),
    versions:{ '1.0.0': at === 'version' ? { homepage } : {} }
  });

  for (const at of ['version', 'package']) {
    for (const hp of ['https://github.com/sst/opencode', 'https://github.com/sst/opencode#readme',
      'https://github.com/sst/opencode/tree/main/docs', 'https://github.com/SST/OpenCode/']) {
      const r = await lookupNpm(client(mk(hp, at)), 'x', 'sst/opencode');
      assert.equal(r.repoMatches, true, `${at}：${hp}`);
      assert.equal(r.evidence, 'homepage', `${at}：${hp}`);
    }
    // 纯文档站（真实例：opencode.ai / vitest.dev）、无关域名、别人的仓库、只有 owner —— 一律不是证据。
    for (const hp of ['https://opencode.ai', 'https://www.opencode.ai/docs', 'https://vitest.dev',
      'https://github.com/dead8309/markitdown-ts', 'https://github.com/sst', 'https://gitlab.com/sst/opencode']) {
      const r = await lookupNpm(client(mk(hp, at)), 'x', 'sst/opencode');
      assert.equal(r.repoMatches, false, `${at}：${hp}`);
      assert.equal(r.evidence, 'none', `${at}：${hp}`);
    }
  }
});

test('R42：贴近真实 opencode-ai 的合成 packument（有 bin/os、repository 缺失、bugs.url 命中）', async () => {
  // 真实 opencode-ai@1.18.35 的 bin/os 就长这样；真实包连 repository/homepage/bugs 都没写
  // （所以真实查询仍是 repoMatches:false，见报告）。这里用"只写了 bugs.url"的合成夹具钉住行为。
  const packument = { name:'opencode-ai', 'dist-tags':{latest:'1.18.35'},
    versions:{ '1.18.35':{ bin:{ opencode:'bin/opencode.exe' }, os:['darwin','linux','win32'],
      bugs:{ url:'https://github.com/sst/opencode/issues' } } } };
  const r = await lookupNpm(client(packument), 'opencode-ai', 'sst/opencode');
  assert.deepEqual(r, { packageName:'opencode-ai', version:'1.18.35', hasBin:true, osIncludesWin:true,
    repoMatches:true, evidence:'bugs.url' });
});

test('R42：一个证据字段都没有时 evidence 为 none，绝不靠包名判定', async () => {
  // 真实 opencode-ai 就是这种：包名与目标仓库"看起来很像"，但没有任何字段能证明归属。
  const packument = { name:'opencode-ai', 'dist-tags':{latest:'1.18.35'},
    versions:{ '1.18.35':{ bin:{ opencode:'bin/opencode.exe' }, os:['darwin','linux','win32'] } } };
  const r = await lookupNpm(client(packument), 'opencode-ai', 'sst/opencode');
  assert.equal(r.repoMatches, false);
  assert.equal(r.evidence, 'none');
});

test('R42：多个来源冲突时任一命中即成立，evidence 报告第一个命中的来源', async () => {
  // 版本级 repository 指向 fork、bugs.url 指向目标仓库 → 成立，且说清凭的是哪一条。
  const packument = { name:'x', 'dist-tags':{latest:'1.0.0'},
    homepage:'https://github.com/sst/opencode',
    versions:{ '1.0.0':{ repository:{ url:'https://github.com/someone/fork' },
      bugs:{ url:'https://github.com/sst/opencode/issues' } } } };
  const r = await lookupNpm(client(packument), 'x', 'sst/opencode');
  assert.equal(r.repoMatches, true);
  assert.equal(r.evidence, 'bugs.url');

  // 版本级 repository 命中时优先级最高（真实包绝大多数走这条）。
  const both = { name:'x', 'dist-tags':{latest:'1.0.0'},
    homepage:'https://github.com/sst/opencode',
    versions:{ '1.0.0':{ repository:{ url:'git+https://github.com/sst/opencode.git' },
      bugs:{ url:'https://github.com/sst/opencode/issues' } } } };
  assert.equal((await lookupNpm(client(both), 'x', 'sst/opencode')).evidence, 'repository');

  // 目标仓库为空时永远不成立，也不给任何 evidence。
  assert.equal((await lookupNpm(client(packument), 'x', '')).evidence, 'none');
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

test('isPythonCompatible 感知 patch：下界得不到满足就不判兼容（R47 推翻"只比 major.minor"）', () => {
  // R47：这是安全网里唯一曾经失败开放的地方。声明 >=3.10.2 而本机是 3.10.0 时给"兼容"，
  // 等于建议一条 pip 自己会拒绝的命令 —— 代价更大的那类错误，必须失败关闭。
  assert.equal(isPythonCompatible('>=3.10.2', '3.10.0'), false);
  assert.equal(isPythonCompatible('==3.10.2', '3.10.0'), false);
  // 三条 R47 指定用例
  assert.equal(isPythonCompatible('>=3.11.4', '3.11.2'), false);   // ① 同 major.minor，但本机补丁更低
  assert.equal(isPythonCompatible('>=3.10.2', '3.10.5'), true);    // ② 补丁够高
  assert.equal(isPythonCompatible('==3.10.*', '3.10.9'), true);    // ③ 通配仍按 major.minor 比较
  // 通配形式无论本机补丁是多少都只看 major.minor
  assert.equal(isPythonCompatible('==3.10.*', '3.10.11'), true);
  assert.equal(isPythonCompatible('!=3.10.*', '3.10.11'), false);
  // 通配段写在更后面就是更细的前缀匹配：==3.10.2.* 要连补丁号一起对上
  assert.equal(isPythonCompatible('==3.10.2.*', '3.10.2'), true);
  assert.equal(isPythonCompatible('==3.10.2.*', '3.10.9'), false);
  // 通配按 PEP 440 只能配合 == / !=，别的组合读不懂 → 不兼容（不许失败开放）
  assert.equal(isPythonCompatible('>=3.10.*', '3.10.0'), false);
  assert.equal(isPythonCompatible('==3.*.2', '3.10.2'), false);
  assert.equal(isPythonCompatible('==3.10.2.1', '3.10.2'), false);
  // 只写 major.minor 的约束仍然只比 major.minor（简报钉住的 >=3.10 / <3.15,>=3.10 语义不变）
  assert.equal(isPythonCompatible('>=3.10', '3.10.0'), true);
  assert.equal(isPythonCompatible('==3.10', '3.10.99'), true);
  assert.equal(isPythonCompatible('!=3.10', '3.10.11'), false);
  assert.equal(isPythonCompatible('>3.10', '3.10.11'), false);
  // 上界带 patch 时同样按三元组比较
  assert.equal(isPythonCompatible('<=3.10.2', '3.10.5'), false);
  assert.equal(isPythonCompatible('<3.10.2', '3.10.1'), true);
  // 真实数据：pypi.org/pypi/cryptography/json 的 requires_python 就带补丁号（实测）
  const crypto = '!=3.9.0,!=3.9.1,>=3.9';
  assert.equal(isPythonCompatible(crypto, '3.9.0'), false);   // 被 != 精确排除到补丁号
  assert.equal(isPythonCompatible(crypto, '3.9.1'), false);
  assert.equal(isPythonCompatible(crypto, '3.9.2'), true);
  assert.equal(isPythonCompatible(crypto, '3.8.20'), false);  // 下界不满足
  // 预发布后缀被忽略（3.13.0rc1 → 3.13.0）
  assert.equal(isPythonCompatible('>=3.13', '3.13.0rc1'), true);
  assert.equal(isPythonCompatible('<=3.12', '3.13.0a1'), false);
  assert.equal(isPythonCompatible('', '3.10.11'), true);
  assert.equal(isPythonCompatible(undefined, '3.10.11'), true);
});

test('isPythonCompatible：本机版本缺 patch 段时按 (major, minor, 0) 保守处理（R47）', () => {
  // 只有 '3.10' 时不敢假定补丁号是几：按 0 算，于是"要求至少 3.10.2"判不兼容（失败关闭）。
  assert.equal(isPythonCompatible('>=3.10.2', '3.10'), false);
  assert.equal(isPythonCompatible('==3.10.2', '3.10'), false);
  assert.equal(isPythonCompatible('>=3.10.0', '3.10'), true);
  assert.equal(isPythonCompatible('>=3.10.2', '3.10.0'), false);
  // 连 minor 都没有的更粗版本同理按 0 补齐
  assert.equal(isPythonCompatible('>=3.1', '3'), false);
  assert.equal(isPythonCompatible('>=3.0', '3'), true);
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

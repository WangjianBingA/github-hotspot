// 中文文档检测与口碑输入的单元测试。
// 全部由注入的假 client 驱动：本文件绝不联网。
//
// 本文件钉住两条互相独立的结论（R59）：
//   · hasCjk   —— 喂给评分轴（scoreRunnable 的中文文档分）：CJK 占比达标，或存在任意语言的本地化文件；
//   · hasChinese —— 徽章「🈶 有中文说明」的声明：必须真的是中文（中文文件名的本地化文件，
//     或正文以汉字为主且不是假名主导）。只放一份 README.ja.md 的仓库绝不能拿到中文徽章。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChinese, fetchChineseEvidence, buildReputationInput } from '../src/enrich/readme.mjs';
import { scoreReputation } from '../src/score/score.mjs';

// 只回固定文本的假 client（fetchText 不吃 GitHub 额度）。
const client = (body) => ({ fetchText: async () => body });

// 会记录"请求了哪些地址"的假 client：用来钉住 defaultBranch 与请求上限。
const spying = (body) => {
  const calls = [];
  return {
    calls,
    fetchText: async (url) => {
      calls.push(url);
      return typeof body === 'function' ? body(url) : body;
    }
  };
};

// ---------- 以下是简报钉住的 5 个用例，原样保留、不做任何削弱 ----------

test('中文占比达到 3% 判定为有中文', () => {
  const zh = '这是一个很好用的工具，可以帮你处理文件。'.repeat(20);
  assert.equal(detectChinese({ readmeText: zh, extraFiles: {} }).hasChinese, true);
});

test('纯英文判定为无中文', () => {
  const en = 'A very useful tool that helps you process files. '.repeat(20);
  assert.equal(detectChinese({ readmeText: en, extraFiles: {} }).ratio, 0);
});

test('只有零星中文字符不误判', () => {
  assert.equal(detectChinese({ readmeText: 'This is a tool. '.repeat(200) + '张三', extraFiles: {} }).hasChinese, false);
});

test('存在 README.zh-CN.md 时判定有中文并记录文件名', () => {
  const r = detectChinese({ readmeText: 'English only. '.repeat(100), extraFiles: { 'README.zh-CN.md': '中文内容' } });
  assert.equal(r.hasChinese, true);
  assert.deepEqual(r.localizedFiles, ['README.zh-CN.md']);
});

test('空输入不抛错', () => {
  assert.equal(detectChinese({ readmeText:'', extraFiles:{} }).hasChinese, false);
  assert.equal(detectChinese({ readmeText:null, extraFiles:null }).hasChinese, false);
});

// ---------- R59：hasCjk（评分用）与 hasChinese（徽章用）必须分开 ----------

test('R59：只有 README.ja.md 时 hasCjk 为 true、hasChinese 为 false，且记下这个 .ja 文件', () => {
  // 真例：sst/opencode 的 README 里 CJK 占比 0.26%（低于 3% 阈值），但仓库里有 README.ja.md。
  const r = detectChinese({ readmeText: 'OpenCode is an AI coding agent. '.repeat(50), extraFiles: { 'README.ja.md': '# OpenCode 日本語' } });
  assert.equal(r.hasCjk, true);        // 评分轴认"有本地化文档"
  assert.equal(r.hasChinese, false);   // 徽章不能替日语 README 冒充中文
  assert.deepEqual(r.localizedFiles, ['README.ja.md']);
});

test('R59：韩文正文让 hasCjk 为 true（确有本地化文档），但不给中文徽章', () => {
  // 谚文也在 CJK 字符类里，所以 ratio 会达标；hasChinese 只数汉字，因此必须仍为 false。
  const ko = '이것은 매우 유용한 도구입니다. 파일을 처리할 수 있습니다. '.repeat(20);
  const r = detectChinese({ readmeText: ko, extraFiles: {} });
  assert.equal(r.hasCjk, true);
  assert.equal(r.hasChinese, false);
  assert.ok(r.ratio >= 0.03, `CJK 占比应达标，实际 ${r.ratio}`);
  assert.equal(r.kanaRatio, 0);
  assert.deepEqual(r.localizedFiles, []);
});

test('R59：只有 README.zh-CN.md、正文一个汉字都没有时 hasChinese 仍为 true', () => {
  // 本地化文件名本身就是中文存在的直接证据，与正文占比无关（正文可能是英文摘要）。
  const r = detectChinese({ readmeText: 'English only. '.repeat(50), extraFiles: { 'README.zh-CN.md': 'zh' } });
  assert.equal(r.hasChinese, true);
  assert.equal(r.hasCjk, true);
  assert.equal(r.ratio, 0);
  assert.equal(r.kanaRatio, 0);
  assert.deepEqual(r.localizedFiles, ['README.zh-CN.md']);
});

test('R59：日语正文（假名占比高）不给中文徽章，但 CJK 占比达标仍算有本地化文档', () => {
  const ja = 'これはとても便利なツールです。ファイルを処理できます。'.repeat(20);
  const r = detectChinese({ readmeText: ja, extraFiles: {} });
  assert.equal(r.hasCjk, true);       // 平假名/片假名也在 CJK 集合里，评分轴照给
  assert.equal(r.hasChinese, false);  // 但这是日语，不是中文
  assert.ok(r.kanaRatio > 0.1, `假名占比应显著，实际 ${r.kanaRatio}`);
  assert.deepEqual(r.localizedFiles, []);
});

test('R59：中英夹杂的正文里汉字占多数时给中文徽章，假名占比接近 0', () => {
  const mixed = '这是一个很好用的工具，可以帮助你处理各种文件。Install it with npx.\n'.repeat(20);
  const r = detectChinese({ readmeText: mixed, extraFiles: {} });
  assert.equal(r.hasChinese, true);
  assert.equal(r.hasCjk, true);
  assert.ok(r.ratio >= 0.03, `CJK 占比应达标，实际 ${r.ratio}`);
  assert.ok(r.kanaRatio < 0.01, `假名占比应接近 0，实际 ${r.kanaRatio}`);
});

test('两种结论都给出可审计的比率，且 ratio 的分母就是全文码元长度', () => {
  const text = '这是一个很好用的工具。'.repeat(10) + 'abcde'.repeat(10);
  const r = detectChinese({ readmeText: text, extraFiles: {} });
  // 汉字 100 个（每句 10 个 × 10 句），全文 160 个码元；这些汉字全在 CJK 集合里，故 ratio 与汉字占比相同。
  assert.equal(r.ratio, 100 / text.length);
  assert.equal(r.kanaRatio, 0);
  assert.deepEqual(Object.keys(r).sort(), ['hasChinese', 'hasCjk', 'kanaRatio', 'localizedFiles', 'ratio']);
});

// ---------- 本地化文件族（R16）：不止中文 ----------

test('R16：中文文件名、docs/*.zh*、以及其他语言的本地化文件都被记为证据，且按文件名排序去重', () => {
  const extraFiles = {
    'README.zh-CN.md': '中文',
    'README_CN.md': '中文',
    'README.ja.md': '日本語',
    'docs/guide.zh-TW.md': '繁體中文',
    'docs/setup.ko.md': '한국어',
    'CHANGELOG.md': '不是本地化文件',
    'docs/zh/README.md': '目录名是中文、文件名不是本地化约定'
  };
  const r = detectChinese({ readmeText: 'English only. '.repeat(20), extraFiles });
  assert.deepEqual(r.localizedFiles, ['README.ja.md', 'README.zh-CN.md', 'README_CN.md', 'docs/guide.zh-TW.md', 'docs/setup.ko.md']);
  assert.equal(r.hasChinese, true);
  assert.equal(r.hasCjk, true);
});

test('本地化文件值为空串或 null 时不算证据（"探到了但没内容"不是文档）', () => {
  const r = detectChinese({ readmeText: 'English only. '.repeat(20), extraFiles: { 'README.zh-CN.md': null, 'README.ja.md': '', 'README.md': '正文' } });
  // 裸 README.md 是主文档本身，不是"又一份本地化文档"；键存在但值为空的也一律不算证据。
  assert.deepEqual(r.localizedFiles, []);
  assert.equal(r.hasChinese, false);
  assert.equal(r.hasCjk, false);
});

test('extraFiles 为 undefined / 非对象 / 数组时都不抛错', () => {
  for (const extraFiles of [undefined, null, 'README.zh-CN.md', 42, ['README.zh-CN.md']]) {
    const r = detectChinese({ readmeText: 'English only.', extraFiles });
    assert.equal(r.hasChinese, false, `extraFiles=${String(extraFiles)}`);
    assert.deepEqual(r.localizedFiles, [], `extraFiles=${String(extraFiles)}`);
  }
});

// ---------- 防御性：50KB 正文、非字符串、空文本 ----------

test('50KB 正文不炸：占比落在 [0,1] 内，且按全文而不是截断后的前缀计算', () => {
  const body = 'A very useful tool that helps you process files. '.repeat(1100); // 约 50KB
  const zhTail = '这是一个很好用的工具。'.repeat(20);
  const text = body + zhTail;
  assert.ok(text.length > 50_000, `正文长度 ${text.length} 应超过 50KB`);
  const r = detectChinese({ readmeText: text, extraFiles: {} });
  // 分母是全文码元长度：中文只出现在结尾也必须量得到（截断前缀会把这部分丢掉）。
  const hanCount = (zhTail.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  assert.equal(r.ratio, hanCount / text.length);
  assert.ok(r.ratio > 0 && r.ratio < 0.03, `实际 ${r.ratio}`);
  assert.equal(r.hasChinese, false);
  assert.equal(r.hasCjk, false);
});
test('readmeText 不是字符串（数字/对象/数组/undefined）时一律当空文本，ratio 为 0 而不是 NaN', () => {
  for (const readmeText of [undefined, null, 42, {}, ['中文'], true]) {
    const r = detectChinese({ readmeText, extraFiles: {} });
    assert.equal(r.ratio, 0, `readmeText=${String(readmeText)}`);
    assert.equal(r.kanaRatio, 0, `readmeText=${String(readmeText)}`);
    assert.equal(r.hasChinese, false, `readmeText=${String(readmeText)}`);
    assert.equal(r.hasCjk, false, `readmeText=${String(readmeText)}`);
  }
});

test('完全不传参数、传 null、传非对象时不抛错', () => {
  for (const input of [undefined, null, {}, 42, 'README.zh-CN.md']) {
    const r = detectChinese(input);
    assert.equal(r.hasChinese, false, `输入=${String(input)}`);
    assert.equal(r.ratio, 0, `输入=${String(input)}`);
  }
});

// ---------- fetchChineseEvidence：只认 HTTP 事实，绝不猜分支 ----------

test('fetchChineseEvidence 用传入的 defaultBranch 拼地址，不猜 main', async () => {
  const spy = spying('English only.');
  await fetchChineseEvidence(spy, 'microsoft/markitdown', 'refs/heads/trunk');
  assert.deepEqual(spy.calls, [
    'https://raw.githubusercontent.com/microsoft/markitdown/refs/heads/trunk/README.md',
    'https://raw.githubusercontent.com/microsoft/markitdown/refs/heads/trunk/README.zh-CN.md',
    'https://raw.githubusercontent.com/microsoft/markitdown/refs/heads/trunk/README_CN.md',
    'https://raw.githubusercontent.com/microsoft/markitdown/refs/heads/trunk/README.zh.md',
    'https://raw.githubusercontent.com/microsoft/markitdown/refs/heads/trunk/README.ja.md'
  ]);
});

test('fetchChineseEvidence 的请求地址里出现的永远是 defaultBranch，一次都不出现 main', async () => {
  const spy = spying('English only.');
  await fetchChineseEvidence(spy, 'owner/repo', 'develop');
  assert.ok(spy.calls.every((u) => u.includes('/develop/')), spy.calls.join('\n'));
  assert.ok(spy.calls.every((u) => !u.includes('/main/')), spy.calls.join('\n'));
});

test('fetchChineseEvidence：README.md 拿到正文，404 的候选文件只记 null；请求数固定 5（额度为 0）', async () => {
  const spy = spying((url) => (url.endsWith('/README.md') ? '# 中文说明\n这是一个工具。' : null));
  const r = await fetchChineseEvidence(spy, 'owner/repo', 'main');
  assert.equal(r.readmeText, '# 中文说明\n这是一个工具。');
  assert.equal(r.extraFiles['README.zh-CN.md'], null);
  assert.equal(spy.calls.length, 5);
  // 下游能据此判定"有中文"。
  assert.equal(detectChinese(r).hasChinese, true);
});

test('fetchChineseEvidence：命中的本地化文件被放进 extraFiles，能被 detectChinese 认出', async () => {
  const files = { 'README.md': 'English only.', 'README.ja.md': '# 日本語' };
  const spy = spying((url) => files[url.split('/').pop()] ?? null);
  const r = await fetchChineseEvidence(spy, 'sst/opencode', 'dev');
  assert.equal(r.extraFiles['README.ja.md'], '# 日本語');
  const verdict = detectChinese(r);
  assert.equal(verdict.hasCjk, true);
  assert.equal(verdict.hasChinese, false);
});

test('fetchChineseEvidence：单个请求抛错不冒泡，那一项记 null（绝不编造内容）', async () => {
  const spy = {
    calls: [],
    fetchText: async (url) => {
      if (url.endsWith('/README.md')) throw new Error('网络超时');
      spy.calls.push(url);
      return null;
    }
  };
  const r = await fetchChineseEvidence(spy, 'owner/repo', 'main');
  assert.equal(r.readmeText, null);
  assert.equal(r.extraFiles['README.zh-CN.md'], null);
  assert.equal(detectChinese(r).hasChinese, false);
});

test('fetchChineseEvidence：defaultBranch 缺失/为空/非字符串时一次请求都不发（不猜分支）', async () => {
  for (const branch of [undefined, null, '', '   ', 42, {}]) {
    const spy = spying('中文');
    const r = await fetchChineseEvidence(spy, 'owner/repo', branch);
    assert.equal(r.readmeText, null, `分支=${String(branch)}`);
    assert.deepEqual(r.extraFiles, {}, `分支=${String(branch)}`);
    assert.deepEqual(spy.calls, [], `分支=${String(branch)} 不应该发请求`);
  }
});

test('fetchChineseEvidence：ownerRepo / client 非法时一次请求都不发，返回空证据（extraFiles 里没有任何键）', async () => {
  const spy = spying('中文');
  assert.deepEqual(await fetchChineseEvidence(spy, '', 'main'), { readmeText: null, extraFiles: {} });
  assert.deepEqual(await fetchChineseEvidence(spy, '   ', 'main'), { readmeText: null, extraFiles: {} });
  assert.deepEqual(await fetchChineseEvidence(spy, undefined, 'main'), { readmeText: null, extraFiles: {} });
  assert.deepEqual(await fetchChineseEvidence(undefined, 'owner/repo', 'main'), { readmeText: null, extraFiles: {} });
  assert.deepEqual(await fetchChineseEvidence({}, 'owner/repo', 'main'), { readmeText: null, extraFiles: {} });
  assert.deepEqual(spy.calls, [], '一次请求都不该发');
});

test('fetchChineseEvidence：响应不是字符串（对象/数字）时当"没拿到"，键保留但值为 null，绝不塞进正文', async () => {
  for (const body of [{ message: 'Not Found' }, 42, undefined]) {
    const r = await fetchChineseEvidence({ fetchText: async () => body }, 'owner/repo', 'main');
    assert.equal(r.readmeText, null, `响应=${String(body)}`);
    assert.deepEqual(r.extraFiles, { 'README.zh-CN.md': null, 'README_CN.md': null, 'README.zh.md': null, 'README.ja.md': null });
    // null 不是证据：下游绝不因为"探测过"就给中文徽章。
    assert.equal(detectChinese(r).hasChinese, false);
  }
});

// ---------- buildReputationInput：只映射字段，不做算术 ----------

test('buildReputationInput 把仓库字段映射成 scoreReputation 认的形状，并与直接传 repo 同分', () => {
  const repo = {
    ownerRepo: 'owner/repo',
    stars: 1000,
    forks: 150,
    pushedAt: '2026-10-09T00:00:00Z',
    license: { spdx_id: 'MIT' },
    hasRelease90d: true,
    language: 'JavaScript',
    description: '无关字段不该被带进去'
  };
  const input = buildReputationInput(repo, { growing: true });
  assert.deepEqual(input, {
    stars: 1000,
    forks: 150,
    pushedAt: '2026-10-09T00:00:00Z',
    license: 'MIT',
    hasRelease90d: true,
    growing: true
  });

  const now = new Date('2026-10-10T00:00:00Z');
  const mapped = scoreReputation(input, input, now);
  const direct = scoreReputation({ ...repo, license: 'MIT' }, { growing: true }, now);
  assert.deepEqual(mapped, direct);
  assert.ok(mapped.total > 0);
});

test('buildReputationInput 缺字段时不下结论：hasRelease90d 保持 null（"没问到"），growing 缺省为 null（中性半分）', () => {
  const input = buildReputationInput({ ownerRepo: 'owner/repo' }, {});
  assert.equal(input.hasRelease90d, null);
  assert.equal(input.growing, null);
  assert.equal(input.license, null);
  assert.equal(input.stars, undefined);
  assert.equal(input.forks, undefined);
  assert.equal(input.pushedAt, undefined);

  // 中性半分的口径由 score.mjs 决定，这里只证明"没问到"确实走到了那条分支。
  const now = new Date('2026-10-10T00:00:00Z');
  assert.equal(scoreReputation(input, input, now).parts.release90d, 3);
  assert.equal(scoreReputation(input, input, now).parts.growth, 2);
});

test('buildReputationInput：明确 false / 明确的 false 增长照实传递，不被当成"没问到"', () => {
  const input = buildReputationInput({ stars: 10, hasRelease90d: false }, { growing: false });
  assert.equal(input.hasRelease90d, false);
  assert.equal(input.growing, false);
  const now = new Date('2026-10-10T00:00:00Z');
  assert.equal(scoreReputation(input, input, now).parts.release90d, 0);
  assert.equal(scoreReputation(input, input, now).parts.growth, 0);
});

test('buildReputationInput：license 是字符串、对象、null、NOASSERTION 时都能映射', () => {
  assert.equal(buildReputationInput({ license: 'Apache-2.0' }, {}).license, 'Apache-2.0');
  assert.equal(buildReputationInput({ license: { spdx_id: 'MIT' } }, {}).license, 'MIT');
  assert.equal(buildReputationInput({ license: null }, {}).license, null);
  assert.equal(buildReputationInput({ license: { spdx_id: 'NOASSERTION' } }, {}).license, 'NOASSERTION');
});

test('buildReputationInput：repo 为空、传 null、传非对象时不抛错', () => {
  for (const repo of [undefined, null, 42, 'owner/repo']) {
    const input = buildReputationInput(repo, { growing: true });
    assert.equal(input.stars, undefined, `repo=${String(repo)}`);
    assert.equal(input.growing, true, `repo=${String(repo)}`);
  }
});

// ---------- 交付物纪律 ----------

test('readme.mjs 只导出简报约定的三个接口', async () => {
  const mod = await import('../src/enrich/readme.mjs');
  assert.deepEqual(Object.keys(mod).sort(), ['buildReputationInput', 'detectChinese', 'fetchChineseEvidence']);
});

test('health.mjs 只导出 buildReputationInput（口碑输入的归属地）', async () => {
  const mod = await import('../src/enrich/health.mjs');
  assert.deepEqual(Object.keys(mod).sort(), ['buildReputationInput']);
  assert.equal(mod.buildReputationInput, buildReputationInput);
});
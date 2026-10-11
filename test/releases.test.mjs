import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWindowsAsset, fetchLatestRelease, hasRecentRelease } from '../src/sources/releases.mjs';
import { scoreReputation } from '../src/score/score.mjs';
import { DETAIL_WEIGHTS } from '../src/config/weights.mjs';

const a = n => ({ name:n, browser_download_url:'u', size:1 });

test('识别 .exe / .msi / windows / win64 命名', () => {
  assert.equal(pickWindowsAsset([a('app-setup.exe')]).name, 'app-setup.exe');
  assert.equal(pickWindowsAsset([a('App_x64.msi')]).name, 'App_x64.msi');
  assert.equal(pickWindowsAsset([a('tool-windows-amd64.zip')]).name, 'tool-windows-amd64.zip');
  assert.equal(pickWindowsAsset([a('tool-win64.zip')]).name, 'tool-win64.zip');
});

test('只有 mac/linux 资产时返回 null，不得误报支持 Windows', () => {
  assert.equal(pickWindowsAsset([a('app-darwin-arm64.zip'), a('app-linux-x86_64.tar.gz')]), null);
});

test('优先安装包而不是压缩包', () => {
  assert.equal(pickWindowsAsset([a('app-windows.zip'), a('app-setup.exe')]).name, 'app-setup.exe');
});

test('空数组与非法输入返回 null', () => {
  assert.equal(pickWindowsAsset([]), null);
  assert.equal(pickWindowsAsset(null), null);
});

test('三态：确认没有发布 / 有发布但超窗 / 未知，三者必须互不混淆（R40）', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  assert.equal(hasRecentRelease({ kind: 'no-release' }, now), false);
  assert.equal(hasRecentRelease({ kind: 'release', publishedAt: '2026-09-01T00:00:00Z' }, now), true);
  assert.equal(hasRecentRelease({ kind: 'release', publishedAt: '2026-01-01T00:00:00Z' }, now), false);
  assert.equal(hasRecentRelease(null, now), null);
});

test('列表端点返回空数组时判为"确认没有发布"，请求失败时判为"未知"', async () => {
  const ok = { getJson: async () => [] };
  assert.deepEqual(await fetchLatestRelease(ok, 'a/b'), { kind: 'no-release' });
  const fail = { getJson: async () => null };
  assert.equal(await fetchLatestRelease(fail, 'a/b'), null);
});

test('未知的发版信息按中性半分计，不当作"确认没有"（R40）', () => {
  const base = { ownerRepo:'a/b', stars:1000, forks:150,
    pushedAt: new Date().toISOString(), license:'MIT', hasRelease90d:true };
  const unknown = scoreReputation({ ...base, hasRelease90d: null }, { growing: true });
  assert.equal(unknown.parts.release90d, DETAIL_WEIGHTS.release90d / 2);
  const none = scoreReputation({ ...base, hasRelease90d: false }, { growing: true });
  assert.equal(none.parts.release90d, 0);
});

// —— 以下为补充用例：简报的骨架之外，还有两处"三态 + 诚实"的边界必须钉住 ——
// ① 草稿（draft）不算发布：只有草稿时必须是"确认没有发布"，而不是"有发布"；
// ② 预发布（prerelease）算发布：用户确实能下载，只有没发过任何东西才算没有；
// ③ 响应结构不对 / 请求抛错时失败关闭到"未知"，绝不猜成"确认没有"。

test('只有草稿时判为"确认没有发布"，预发布算发布', async () => {
  const draftOnly = { getJson: async () => [{ tag_name: 'v1.0.0', draft: true, published_at: '2026-10-01T00:00:00Z', assets: [] }] };
  assert.deepEqual(await fetchLatestRelease(draftOnly, 'a/b'), { kind: 'no-release' });

  const pre = { getJson: async () => [{ tag_name: 'v2.0.0-rc.1', prerelease: true, draft: false, published_at: '2026-10-05T00:00:00Z', assets: [] }] };
  const got = await fetchLatestRelease(pre, 'a/b');
  assert.equal(got.kind, 'release');
  assert.equal(got.tagName, 'v2.0.0-rc.1');
});

test('响应结构不对或请求抛错时一律"未知"，不得猜成"确认没有发布"', async () => {
  assert.equal(await fetchLatestRelease({ getJson: async () => ({ message: 'Not Found' }) }, 'a/b'), null);
  assert.equal(await fetchLatestRelease({ getJson: async () => { throw new Error('网络炸了'); } }, 'a/b'), null);
  assert.equal(await fetchLatestRelease(null, 'a/b'), null);
  assert.equal(await fetchLatestRelease({ getJson: async () => [] }, ''), null);
  // 有发布但 publishedAt 读不出来时，发版窗口未知（null），绝不记成"确认没有"。
  assert.equal(hasRecentRelease({ kind: 'release', publishedAt: '不是时间' }, new Date()), null);
  assert.equal(hasRecentRelease({ kind: 'release', publishedAt: null }, new Date()), null);
});

test('只请求一次列表端点（per_page=1），不吃 search 额度，且不传 api 以外的选项', async () => {
  const calls = [];
  const spy = { getJson: async (url, options) => { calls.push([url, options]); return []; } };
  await fetchLatestRelease(spy, 'microsoft/markitdown');
  assert.deepEqual(calls, [['https://api.github.com/repos/microsoft/markitdown/releases?per_page=1', { api: 'core' }]]);
});

test('带 Windows 资产时 windowsAsset 一并给出，没有 Windows 资产时为 null', async () => {
  const withWin = { getJson: async () => [{
    tag_name: 'v1.2.3',
    published_at: '2026-10-01T00:00:00Z',
    assets: [{ name: 'app-darwin-arm64.zip', browser_download_url: 'https://x/mac', size: 10 },
      { name: 'app-setup.exe', browser_download_url: 'https://x/win', size: 20 }]
  }] };
  const got = await fetchLatestRelease(withWin, 'a/b');
  assert.equal(got.kind, 'release');
  assert.equal(got.tagName, 'v1.2.3');
  assert.equal(got.publishedAt, '2026-10-01T00:00:00Z');
  assert.equal(got.assets.length, 2);
  assert.deepEqual(got.windowsAsset, { name: 'app-setup.exe', url: 'https://x/win', size: 20 });

  const noWin = { getJson: async () => [{ tag_name: 'v1', published_at: '2026-10-01T00:00:00Z',
    assets: [{ name: 'app-linux-x86_64.tar.gz', browser_download_url: 'https://x/linux', size: 5 }] }] };
  assert.equal((await fetchLatestRelease(noWin, 'a/b')).windowsAsset, null);
  // assets 字段不是数组时按"没有 Windows 资产"处理，不抛错。
  const noAssets = { getJson: async () => [{ tag_name: 'v1', published_at: '2026-10-01T00:00:00Z' }] };
  const plain = await fetchLatestRelease(noAssets, 'a/b');
  assert.deepEqual(plain.assets, []);
  assert.equal(plain.windowsAsset, null);
});

test('msi 优先于 windows 压缩包，显式排除的平台名绝不当成 Windows 包', () => {
  assert.equal(pickWindowsAsset([a('tool-windows-amd64.zip'), a('App_x64.msi')]).name, 'App_x64.msi');
  // 安装包后缀优先：哪怕压缩包名字里带 windows，.exe 仍然胜出。
  assert.equal(pickWindowsAsset([a('Tool-windows.zip'), a('Tool.exe')]).name, 'Tool.exe');
  // 名字里同时出现排除项与 windows 字样时，排除优先（宁可不给徽章，也不误报"一键就能玩"）。
  assert.equal(pickWindowsAsset([a('tool-win64-linux-cross.zip')]), null);
  assert.equal(pickWindowsAsset([a('app-macos-win64.zip')]), null);
  // 只认 .exe / .msi 后缀：.exe.sha256、.msix 这类校验文件与未知后缀不算安装包。
  assert.equal(pickWindowsAsset([a('app-setup.exe.sha256')]), null);
  // 没有 name 的条目直接跳过。
  assert.equal(pickWindowsAsset([{ browser_download_url:'u', size:1 }]), null);
});
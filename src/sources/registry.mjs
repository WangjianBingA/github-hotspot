// GitHub 好玩榜 —— npm / PyPI registry 直查与包名归属校验（整个项目的安全网）。
// 这一层只回答一个问题：“能不能告诉初学者去装这个包？”，它只报告事实，
// **绝不生成任何安装命令**（命令由后面的 classifyRunnability 决定，且只认 repoMatches === true）。
//
// 为什么不能相信包名：npm 上存在与知名项目同名、作者却完全不同的包。
// 实测：markitdown 是微软的项目，而 registry.npmjs.org/markitdown 是个 2013 年的
// 第三方包（作者 Ben Taber，且它连 repository 字段都没有）；搜 npm 的 markitdown
// 还会撞上 dead8309/markitdown-ts。所以：
//   · repoMatches 只能由 packument 的 repository 归一化后与目标仓库 owner/repo 比较得出；
//     包名相同**不是**证据，缺 repository / 解析不出 owner/repo 一律 false；
//   · 一次请求就够：版本对象同时带 bin（能不能 npx 直接跑）与 os（支不支持 Windows）；
//   · requires_python 缺失（null）表示"不挑版本"，视为兼容；
//   · 任何异常、null 响应体、结构不对的响应一律返回 null，永不抛错——
//     一次查询失败不能带崩整轮采集，更不能因为"没查到"被误当成"可以装"。
//
// 网络 I/O 全部经由注入的 client，且一律 api:'none'（registry 与 PyPI 都不吃 GitHub 额度）。

const NPM_REGISTRY = 'https://registry.npmjs.org';
const PYPI_REGISTRY = 'https://pypi.org/pypi';

// 归一化后认为是"本仓库所在主机"的唯一主机名；别的主机一律连主机名一起保留。
const GITHUB_HOST = 'github.com';

// npm 允许的托管平台短式（hosted-git-info 的写法）：github:owner/repo 等。
// 先换成主机名，后面按主机的规则处理；不在表里的写法保持原样，绝不瞎猜。
const SHORTHAND_HOSTS = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
  gist: 'gist.github.com'
};

/**
 * 把各种真实写法的仓库地址归一化成可比较的字符串。
 * 支持的写法（都被抹平成 owner/repo，小写、无协议、无 .git、无末尾斜杠、无子目录）：
 *   git+https://github.com/sst/opencode.git
 *   https://github.com/SST/OpenCode/
 *   https://github.com/sst/opencode/tree/main/packages/x   ← monorepo 子目录
 *   git+ssh://git@github.com/owner/repo.git / git://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   github:owner/repo、owner/repo                          ← npm 的字符串短式
 *   { url: '…' }                                           ← repository 写成对象时
 * **非 GitHub 主机连主机名一起保留**（如 gitlab.com/owner/repo）：别的平台上"同名同作者名"
 * 的仓库不是同一个仓库，丢掉主机名会让它被误判成本仓库。
 * @param {string|{url?: string}|null|undefined} url 仓库地址（repository 字段的值，字符串或对象）
 * @returns {string} 归一化后的 `owner/repo`；无法确定是哪个仓库时返回空串
 */
export function normalizeRepoUrl(url) {
  const raw = typeof url === 'string'
    ? url
    : (url && typeof url === 'object' && typeof url.url === 'string' ? url.url : '');
  let text = raw.trim().toLowerCase();
  if (text === '') return '';

  text = text.split('#')[0].split('?')[0];              // 去掉 #readme、?query 尾巴
  text = text.replace(/^git\+/, '');                     // git+https:// → https://
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');    // 去掉 https:// ssh:// git://
  // github:owner/repo → github.com/owner/repo（注意不能让它变成 github/owner/repo 这种假路径）
  text = text.replace(/^([a-z]+):/, (whole, word) => (SHORTHAND_HOSTS[word] ? `${SHORTHAND_HOSTS[word]}/` : whole));
  text = text.replace(/^[^/@]*@/, '');                   // 去掉 git@ / user@ 前缀
  text = text.replace(/^([^/]+):/, '$1/');               // git@github.com:owner/repo 的冒号

  const parts = text.split('/').filter((part) => part !== '');
  if (parts.length === 0) return '';

  // 第一段带点才当主机名；不带点的是 npm 短式（owner/repo、github:owner/repo）。
  let host = '';
  if (parts[0].includes('.')) host = parts.shift().replace(/^www\./, '');

  const owner = parts[0] ?? '';
  const repo = (parts[1] ?? '').replace(/\.git$/, '');
  if (owner === '' || repo === '') return '';

  return host !== '' && host !== GITHUB_HOST ? `${host}/${owner}/${repo}` : `${owner}/${repo}`;
}

/**
 * packument 的版本对象里 bin 是不是"能直接跑"。
 * npm 的 bin 可以是非空字符串，也可以是 { 命令名: 脚本路径 }；空串、空对象、数组都不算。
 * @param {*} bin 版本对象的 bin 字段
 * @returns {boolean}
 */
const hasBin = (bin) => {
  if (typeof bin === 'string') return bin.trim() !== '';
  if (bin && typeof bin === 'object' && !Array.isArray(bin)) return Object.keys(bin).length > 0;
  return false;
};

/**
 * packument 的 os 字段是否覆盖 Windows。
 * npm 的语义：**没写 os 就是不限制平台**，哪里都能跑 → true；
 * 写了就以它为准，只有明确列出 win32 才算支持 Windows；
 * 明确写了排除项 !win32 时保守判 false（空列表同样不能声称支持 Windows）。
 * @param {*} os 版本对象的 os 字段（字符串或数组）
 * @returns {boolean}
 */
const osIncludesWin = (os) => {
  if (os === undefined || os === null) return true;
  const list = Array.isArray(os) ? os : [os];
  const values = list
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase());
  if (values.includes('!win32')) return false;
  return values.includes('win32');
};

/**
 * 从 packument 里取 dist-tags.latest 与它对应的版本对象。
 * 结构不对（没有 latest、latest 没有对应版本）返回 null：拿不到归属证据就不产出任何结论。
 * @param {object} packument npm packument
 * @returns {{version: string, manifest: object}|null}
 */
const latestManifest = (packument) => {
  const latest = packument?.['dist-tags']?.latest;
  if (typeof latest !== 'string' || latest === '') return null;
  const manifest = packument?.versions?.[latest];
  if (!manifest || typeof manifest !== 'object') return null;
  return { version: latest, manifest };
};

/**
 * 直查 npm registry，给出"这个包是不是目标仓库发布的、能不能 npx 跑、支不支持 Windows"。
 * @param {object} client 注入的网络客户端（形如 createClient 的返回值）
 * @param {string} packageName npm 包名，如 'opencode-ai' 或 '@scope/name'
 * @param {string} repoFullName 目标仓库的 owner/repo（来自 GitHub，不是来自包名）
 * @returns {Promise<{packageName: string, version: string, hasBin: boolean, osIncludesWin: boolean, repoMatches: boolean}|null>}
 *          查询失败或响应结构不对时为 null
 */
export async function lookupNpm(client, packageName, repoFullName) {
  try {
    if (!client || typeof client.getJson !== 'function') return null;
    const name = typeof packageName === 'string' ? packageName.trim() : '';
    if (name === '') return null;

    // registry 接受未编码的斜杠：https://registry.npmjs.org/@scope/name（实测返回 200）。
    const body = await client.getJson(`${NPM_REGISTRY}/${name}`, { api: 'none' });
    if (!body || typeof body !== 'object') return null;

    const found = latestManifest(body);
    if (found === null) return null;

    const target = normalizeRepoUrl(repoFullName);
    const actual = normalizeRepoUrl(found.manifest.repository);

    return {
      // 以 registry 自己报的包名为准（拿不到就回落到请求时用的名字）。
      packageName: typeof body.name === 'string' && body.name !== '' ? body.name : name,
      version: found.version,
      hasBin: hasBin(found.manifest.bin),
      osIncludesWin: osIncludesWin(found.manifest.os),
      // 名字相同不算证据，只有归一化后的仓库地址相等才算。
      repoMatches: target !== '' && actual !== '' && target === actual
    };
  } catch {
    return null;
  }
}

/**
 * PEP 503 包名归一化：小写，并把连续的 -/_/. 都压成单个 -。
 * 这样 markitdown、MarkItDown、my_package 与 my-package 都会请求到同一个包。
 * @param {string} name 原始包名
 * @returns {string} 归一化后的包名
 */
const normalizePyPIName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

/**
 * 直查 PyPI JSON API，读出最新版本与 requires_python（交给调用方做版本兼容判断）。
 * @param {object} client 注入的网络客户端
 * @param {string} packageName PyPI 包名（大小写与 -/_/. 的差异会被归一化）
 * @returns {Promise<{packageName: string, version: string, requiresPython: string|null}|null>}
 *          查询失败或响应结构不对时为 null
 */
export async function lookupPyPI(client, packageName) {
  try {
    if (!client || typeof client.getJson !== 'function') return null;
    const name = typeof packageName === 'string' ? packageName.trim() : '';
    if (name === '') return null;

    const body = await client.getJson(`${PYPI_REGISTRY}/${normalizePyPIName(name)}/json`, { api: 'none' });
    if (!body || typeof body !== 'object') return null;

    const info = body.info;
    if (!info || typeof info !== 'object') return null;

    const version = typeof info.version === 'string' && info.version !== '' ? info.version : null;
    if (version === null) return null;

    const requiresPython = typeof info.requires_python === 'string' && info.requires_python.trim() !== ''
      ? info.requires_python.trim()
      : null;

    return {
      packageName: typeof info.name === 'string' && info.name !== '' ? info.name : name,
      version,
      requiresPython
    };
  } catch {
    return null;
  }
}

/**
 * 从版本串里取 [major, minor]；取不到返回 null。
 * 补丁号与预发布/预览后缀一律忽略（3.13.0rc1 → 3.13）。
 * @param {*} value 版本串，如 '3.10.11'、'v3.10'、3
 * @returns {[number, number]|null}
 */
const toMajorMinor = (value) => {
  if (typeof value !== 'string') return null;
  const matched = /^\s*v?(\d+)(?:\.(\d+))?/.exec(value);
  if (!matched) return null;
  return [Number(matched[1]), Number(matched[2] ?? 0)];
};

/**
 * 解析一条 PEP 440 版本约束（>=、<=、<、>、==、!=）。
 * 只允许后面跟数字（可带 .minor 与补丁/通配尾巴，如 >=3.10.2、==3.10.*）；
 * 其它写法（~=、^…、乱写的字符串）一律返回 null，表示"读不懂"。
 * @param {string} text 单条约束，如 '>=3.10'
 * @returns {{op: string, major: number, minor: number|null}|null}
 */
const parseClause = (text) => {
  const matched = /^(<=|>=|==|!=|<|>)\s*v?(\d+)(?:\.(\d+))?/.exec(text);
  if (!matched) return null;
  const rest = text.slice(matched[0].length).trim();
  if (rest !== '' && !/^(?:\.(?:\d+|\*))+$/.test(rest)) return null;
  return {
    op: matched[1],
    major: Number(matched[2]),
    minor: matched[3] === undefined ? null : Number(matched[3])
  };
};

/**
 * 本机版本是否满足一条约束。只比 major.minor（字典序），== / != 在只写了 major 时只比 major。
 * @param {[number, number]} local 本机版本 [major, minor]
 * @param {{op: string, major: number, minor: number|null}} clause 解析后的约束
 * @returns {boolean}
 */
const satisfies = (local, { op, major, minor }) => {
  const req = [major, minor ?? 0];
  const cmp = (local[0] - req[0]) || (local[1] - req[1]);
  switch (op) {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    case '==': return minor === null ? local[0] === major : cmp === 0;
    case '!=': return minor === null ? local[0] !== major : cmp !== 0;
    default: return false;
  }
};

/**
 * 判断本机 Python 是否满足包声明的 requires_python。
 * 逗号分隔的多条件是 AND 关系，必须全部满足。
 * 拿不准时一律判**不兼容**：读不懂的约束（~= 等）或读不懂的本机版本都不放行——
 * 宁可少给初学者一条安装命令，也不能给出一条装不上、或者装出问题的命令。
 * @param {string|null|undefined} requiresPython PyPI 的 requires_python 原文
 * @param {string} localPython 本机 Python 版本，如 '3.10.11'
 * @returns {boolean} 兼容为 true；null / 空串表示"不挑版本"，同样为 true
 */
export function isPythonCompatible(requiresPython, localPython) {
  if (requiresPython === null || requiresPython === undefined) return true;
  if (typeof requiresPython !== 'string') return false;
  if (requiresPython.trim() === '') return true;

  const local = toMajorMinor(localPython);
  if (local === null) return false;

  for (const raw of requiresPython.split(',')) {
    const text = raw.trim();
    if (text === '') continue;
    const clause = parseClause(text);
    if (clause === null || !satisfies(local, clause)) return false;
  }
  return true;
}

// GitHub 好玩榜 —— npm / PyPI registry 直查与包名归属校验（整个项目的安全网）。
// 这一层只回答一个问题：“能不能告诉初学者去装这个包？”，它只报告事实，
// **绝不生成任何安装命令**（命令由后面的 classifyRunnability 决定，且只认 repoMatches === true）。
//
// 为什么不能相信包名：npm 上存在与知名项目同名、作者却完全不同的包。
// 实测：markitdown 是微软的项目，而 registry.npmjs.org/markitdown 是个 2013 年的
// 第三方包（作者 Ben Taber，且它连 repository 字段都没有）；搜 npm 的 markitdown
// 还会撞上 dead8309/markitdown-ts。所以：
//   · repoMatches 只能由包自己声明的仓库字段归一化后与目标 owner/repo **严格相等**得出，
//     包名相同**不是**证据；一个字段都取不到证据时一律 false；
//   · R42 多来源取证：真实包经常只在某一处写仓库地址（有的只在包级写 repository，
//     有的只写 bugs.url = https://github.com/owner/repo/issues）。所以只要
//     版本级 repository、包级 repository、版本级 bugs.url、版本级 homepage、包级 homepage
//     中**任一**条能归一化到目标 owner/repo，就认定归属成立，并用 `evidence` 说明凭的是哪一条；
//     homepage 只有在指向目标仓库路径内时才算证据（纯文档站如 https://opencode.ai
//     归一化后是空串，自然不算）。这套机制的强度边界要说清楚：这些字段都是发布者自己写在
//     package.json 里的**声明**，它证明的是"这个包明确宣称自己来自该仓库"，
//     不是密码学意义上的作者身份证明——所以判定必须严格相等，绝不允许"看起来像"。
//   · 一次请求就够：版本对象同时带 bin（能不能 npx 直接跑）与 os（支不支持 Windows）；
//   · PyPI 侧同理（Task 10B / R68）：归属只认 PyPI 自己声明的 project_urls（优先，按键名排序遍历）
//     与 home_page，归一化后仍须与目标 owner/repo 严格相等；两者都拿不到就 repoMatches:false，
//     下游也就不下发 pip install——PyPI 上同样有同名/抢注/仿冒包，"信包名"的错误换个生态一样错；
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
 * bugs 字段可以写成字符串，也可以写成 { url, email }：统一取 URL，取不到返回空串。
 * @param {*} bugs 版本对象的 bugs 字段
 * @returns {string}
 */
const bugsUrl = (bugs) => {
  if (typeof bugs === 'string') return bugs;
  if (bugs && typeof bugs === 'object' && typeof bugs.url === 'string') return bugs.url;
  return '';
};

/**
 * R42 多来源取证：按优先级找出**第一条**能归一化到目标仓库的证据，返回它的来源名。
 * 顺序：版本级 repository → 包级 repository → 版本级 bugs.url → 版本级 homepage → 包级 homepage。
 * 判定仍然是严格相等（归一化后必须一模一样），包名在任何情况下都不参与。
 * homepage 不需要额外特判：它只有指向目标仓库路径内时才会归一化成目标，
 * 纯文档站（https://opencode.ai）归一化后是空串，永远不可能相等。
 * 一条证据都没有时返回 'none'——宁可不给安装命令，也不靠"看起来像"。
 * @param {object} packument npm packument（顶层也可能带 repository / homepage）
 * @param {object} manifest dist-tags.latest 对应的版本对象
 * @param {string} target 归一化后的目标仓库 owner/repo
 * @returns {'repository'|'bugs.url'|'homepage'|'none'} 命中的来源名，或 none
 */
const findOwnershipEvidence = (packument, manifest, target) => {
  if (target === '') return 'none';
  const candidates = [
    ['repository', manifest?.repository],
    ['repository', packument?.repository],
    ['bugs.url', bugsUrl(manifest?.bugs)],
    ['homepage', manifest?.homepage],
    ['homepage', packument?.homepage]
  ];
  for (const [source, value] of candidates) {
    if (normalizeRepoUrl(value) === target) return source;
  }
  return 'none';
};

/**
 * 直查 npm registry，给出"这个包是不是目标仓库发布的、能不能 npx 跑、支不支持 Windows"。
 * @param {object} client 注入的网络客户端（形如 createClient 的返回值）
 * @param {string} packageName npm 包名，如 'opencode-ai' 或 '@scope/name'
 * @param {string} repoFullName 目标仓库的 owner/repo（来自 GitHub，不是来自包名）
 * @returns {Promise<{packageName: string, version: string, hasBin: boolean, osIncludesWin: boolean, repoMatches: boolean, evidence: string}|null>}
 *          查询失败或响应结构不对时为 null；evidence 说明 repoMatches 凭什么成立（R42）
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
    const evidence = findOwnershipEvidence(body, found.manifest, target);

    return {
      // 以 registry 自己报的包名为准（拿不到就回落到请求时用的名字）。
      packageName: typeof body.name === 'string' && body.name !== '' ? body.name : name,
      version: found.version,
      hasBin: hasBin(found.manifest.bin),
      osIncludesWin: osIncludesWin(found.manifest.os),
      // 名字相同不算证据：只有某条声明字段归一化后与目标仓库严格相等才算（R42 多来源）。
      repoMatches: evidence !== 'none',
      evidence
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
 * Task 10B（R68）：从 PyPI 自己声明的元数据里找归属证据——**包名在任何情况下都不参与判定**。
 * 顺序：`project_urls`（按键名排序后遍历，保证同一份响应每次都得到同一个结论）→ `home_page`。
 * 判定与 npm 侧同源：都用 `normalizeRepoUrl` 归一化后与目标 owner/repo **严格相等**；
 * 纯文档站（https://opencode.ai、https://example.com/docs）归一化后要么是空串、要么带上主机名，
 * 永远不可能与 owner/repo 相等。
 * 一条证据都没有（字段缺失、为 null、结构不对、目标为空）时返回 'none'——
 * 宁可不给 pip install 命令，也不靠"看起来像"。这些字段是发布者自己写的**声明**，
 * 证明的是"这个包明确宣称自己来自该仓库"，不是密码学意义上的作者身份证明。
 * @param {object} info PyPI JSON API 响应里的 info 对象
 * @param {string} target 归一化后的目标仓库 owner/repo
 * @returns {'project_urls'|'home_page'|'none'} 命中的来源名，或 none
 */
const findPyPiOwnershipEvidence = (info, target) => {
  if (target === '') return 'none';

  const projectUrls = info?.project_urls;
  if (projectUrls && typeof projectUrls === 'object' && !Array.isArray(projectUrls)) {
    for (const key of Object.keys(projectUrls).sort()) {
      if (normalizeRepoUrl(projectUrls[key]) === target) return 'project_urls';
    }
  }

  if (normalizeRepoUrl(info?.home_page) === target) return 'home_page';
  return 'none';
};

/**
 * 直查 PyPI JSON API，读出最新版本、requires_python 与**归属证据**。
 * 归属（Task 10B / R68）：PyPI 上也有同名/抢注/仿冒包，所以 repoMatches 只能来自 PyPI 自己
 * 声明的 project_urls / home_page（归一化后严格相等），包名不是证据；两者都拿不到证据时
 * 一律 false + evidence 'none'（失败关闭），下游 classifyRunnability 也就不下发 pip install。
 * @param {object} client 注入的网络客户端
 * @param {string} packageName PyPI 包名（大小写与 -/_/. 的差异会被归一化）
 * @param {string} repoFullName 目标仓库的 owner/repo（来自 GitHub，不是来自包名）
 * @returns {Promise<{packageName: string, version: string, requiresPython: string|null, repoMatches: boolean,
 *   evidence: 'project_urls'|'home_page'|'none'}|null>}
 *          查询失败或响应结构不对时为 null；evidence 说明 repoMatches 凭什么成立（'none' 表示归属不成立）
 */
export async function lookupPyPI(client, packageName, repoFullName) {
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

    const evidence = findPyPiOwnershipEvidence(info, normalizeRepoUrl(repoFullName));

    return {
      packageName: typeof info.name === 'string' && info.name !== '' ? info.name : name,
      version,
      requiresPython,
      // 包名相同不算证据：只有 project_urls / home_page 归一化后与目标仓库严格相等才算（Task 10B）。
      repoMatches: evidence !== 'none',
      evidence
    };
  } catch {
    return null;
  }
}

/**
 * 从版本串里取 [major, minor, patch] 三元组；取不到返回 null。
 * 预发布/预览后缀被忽略（3.13.0rc1 → [3,13,0]）；
 * **缺的段按 0 补齐**（'3.10' → [3,10,0]、'3' → [3,0,0]）——这是保守假设：
 * 我们不知道补丁号就不敢假定它更高，于是"要求至少 X.Y.Z"会判不满足（失败关闭）。
 * 注意这个假设对 `<=` / `<` 这类上界约束会偏宽松，但真实 requires_python 几乎只用下界，
 * 而且比起"凭空补一个补丁号"，按 0 处理更诚实。
 * @param {*} value 版本串，如 '3.10.11'、'v3.10'
 * @returns {[number, number, number]|null}
 */
const toVersion = (value) => {
  if (typeof value !== 'string') return null;
  const matched = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value);
  if (!matched) return null;
  return [Number(matched[1]), Number(matched[2] ?? 0), Number(matched[3] ?? 0)];
};

/**
 * 解析一条 PEP 440 版本约束（>=、<=、<、>、==、!=）。
 * 允许 `major`、`major.minor`、`major.minor.patch`，以及末尾一个通配段（`==3.10.*`、`!=3.0.*`）；
 * 其它写法（`~=`、`^…`、`3.10.2.1`、乱写的字符串）一律返回 null，表示"读不懂"（调用方按不兼容处理）。
 * @param {string} text 单条约束，如 '>=3.10'
 * @returns {{op: string, major: number, minor: number|null, patch: number|null, wildcard: boolean}|null}
 */
const parseClause = (text) => {
  const matched = /^(<=|>=|==|!=|<|>)\s*v?(\d+)((?:\.(?:\d+|\*))*)$/.exec(text.trim());
  if (!matched) return null;
  const parts = matched[3] === '' ? [] : matched[3].slice(1).split('.');
  const stars = parts.filter((part) => part === '*').length;
  // 通配只允许一个、只能在末尾，且按 PEP 440 只能配合 `==` / `!=`（前缀匹配）；
  // 其余组合（'==3.*.2'、'>=3.10.*'）读不懂，按不兼容处理——宁可少给一条命令，也不失败开放。
  if (stars > 1 || (stars === 1 && parts[parts.length - 1] !== '*')) return null;
  if (stars === 1 && matched[1] !== '==' && matched[1] !== '!=') return null;
  const numbers = parts.filter((part) => part !== '*').map(Number);
  if (numbers.length > 2) return null;                    // 最多 major.minor.patch
  return {
    op: matched[1],
    major: Number(matched[2]),
    minor: numbers.length >= 1 ? numbers[0] : null,
    patch: numbers.length >= 2 ? numbers[1] : null
  };
};

/**
 * 本机版本是否满足一条约束，按 (major, minor, patch) 三元组做字典序比较（R47）。
 * 比较深度 = 约束里**写出来的数字段数**：写了 patch 就比三段；`==3.10.*` 的通配段不是数字，
 * 所以只比两段（这是它"前缀匹配"的本意）；只写 major 就只比 major。约束里缺的段按 0 补齐。
 * @param {[number, number, number]} local 本机版本三元组
 * @param {{op: string, major: number, minor: number|null, patch: number|null}} clause 解析后的约束
 * @returns {boolean}
 */
const satisfies = (local, { op, major, minor, patch }) => {
  const req = [major, minor ?? 0, patch ?? 0];
  const depth = minor === null ? 1 : (patch === null ? 2 : 3);
  let cmp = 0;
  for (let i = 0; i < depth && cmp === 0; i++) cmp = local[i] - req[i];
  switch (op) {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    case '==': return cmp === 0;
    case '!=': return cmp !== 0;
    default: return false;
  }
};

/**
 * 判断本机 Python 是否满足包声明的 requires_python。
 * 逗号分隔的多条件是 AND 关系，必须全部满足；比较按 (major, minor, patch) 三元组，
 * 但约束写到哪一层就比到哪一层（`>=3.10` 只比 3.10，`>=3.11.4` 会比补丁号；`==3.10.*` 只比 major.minor）。
 *
 * **这是有意的失败关闭（fail-closed，R44 已批准；R47 把唯一的失败开放处补掉了）**：
 * 读不懂的约束（`~=3.10` 这类简报未列出的运算符）或读不懂的本机版本一律判**不兼容**；
 * 声明 `>=3.11.4` 而本机 `3.11.2` 也必须判不兼容——给出一条 pip 自己会拒绝的命令，
 * 比少给一条安装路径代价大得多。两类错误的代价不对称：
 * 误判"兼容"会让初学者照着一条装不上、或装出问题的命令折腾半天（还可能是我们唯一给出的路径）；
 * 误判"不兼容"只是让他少看到一条安装路径（其余路径与"未知"状态照旧）。
 * 代价说清楚：**不认识的约束会偏保守**——将来若支持更多运算（`~=`、`===`），
 * 要连同它的语义一起补测试，而不是把"读不懂"改成"放行"。
 *
 * 注意（配合 R48）：v2 是静态网站，**不知道访客的 Python 版本**，所以生产链路里并没有真实的
 * `localPython`；本函数只是纯工具，下游不得用它伪造一个 `compatible: true`。
 * @param {string|null|undefined} requiresPython PyPI 的 requires_python 原文
 * @param {string} localPython 本机 Python 版本，如 '3.10.11'
 * @returns {boolean} 兼容为 true；null / 空串表示"不挑版本"，同样为 true
 */
export function isPythonCompatible(requiresPython, localPython) {
  if (requiresPython === null || requiresPython === undefined) return true;
  if (typeof requiresPython !== 'string') return false;
  if (requiresPython.trim() === '') return true;

  const local = toVersion(localPython);
  if (local === null) return false;

  for (const raw of requiresPython.split(',')) {
    const text = raw.trim();
    if (text === '') continue;
    const clause = parseClause(text);
    if (clause === null || !satisfies(local, clause)) return false;
  }
  return true;
}

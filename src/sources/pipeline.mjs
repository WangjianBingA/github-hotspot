// GitHub 好玩榜 —— 真实采集管线（discover / enrich / resolveVelocity）。
//
// src/collect.mjs 是**编排者**：它只认 { discover, enrich, resolveVelocity } 这三个注入接口，
// 不关心数据是从网络来的还是从 fixture 来的。本模块提供"真实网络那一份实现"：
//   · discover()       → { candidates, classic, trending }：候选池、经典榜自己的池子、trending 锚点
//   · enrich(c, opts)  → 就地补齐 release / 注册表 / README 证据，并算出两个三态事实
//   · resolveVelocity  → 直接转给 sources/star-velocity.mjs 的五级阶梯（含 freeOnly 开关）
//
// 三条必须守住的纪律：
//   · R26：经典榜的池子来自**单独的 fetchClassicTop**，绝不拿周榜候选去顶。
//     候选池是按 created / pushed 搜出来的（这周刚冒头或最近有提交），拿它按收藏数排出来的
//     "经典必玩"只是"本周候选里收藏最高的 30 个"——那不是经典，是这个星期的小圈子。
//   · R41：`repo.hasRelease90d` 与 `extra.growing` 两个字段**在这里被写**。
//     Task 4B 评审确认过：这两个评分子项在全仓库只有读取处、没有写入处，
//     生产环境里 release90d 恒 0、growth 恒中性 2，而 fixture 手写了合理值所以测试全绿。
//     所以本模块对每个候选都真的去写这两个字段，并把"没问到"如实留成 null（不是 false）。
//   · R53：涨星速度**在富化之后**解析，且先跑免费级（调用方 freeOnly 传下来时，级别 0/4 一次请求都不发）。
//
// 关于包名（R68 的硬前置）：本模块**绝不从仓库名推导包名**。npm / PyPI 的直查只在上游明确给了
// 包名（repo.npmPackage / repo.pypiPackage）时才发生，并且照样必须 repoMatches === true 才采用；
// 从名字猜包名正是 R68 要堵的那个口子（npm 上的 markitdown 属于一个 2013 年的第三方作者）。
//
// 网络 I/O 全部经由注入的 client；本模块不读时钟（now 显式传入）、不抛错。

import { readFileSync } from 'node:fs';

import { fetchClassicTop, discoverActiveRepos, discoverNewRepos } from './search.mjs';
import { fetchTrending } from './trending.mjs';
import { fetchLatestRelease, hasRecentRelease } from './releases.mjs';
import { lookupNpm, lookupPyPI } from './registry.mjs';
import { resolveVelocity as resolveVelocityLadder } from './star-velocity.mjs';
import { detectChinese, fetchChineseEvidence } from '../enrich/readme.mjs';
import { classifyRunnability } from '../enrich/runnability.mjs';
import { readSnapshotStars } from '../store/datastore.mjs';

const DAY_MS = 86_400_000;

// 经典榜的发现预过滤：收藏 10 万以上的仓库才叫"大名鼎鼎"（与 search.mjs 的默认口径一致）。
const CLASSIC_MIN_STARS = 100000;
// 经典榜最多取 30 条（= BOARD_SIZES.classic）；多捞无用，只会白花额度。
const CLASSIC_PER_PAGE = 30;

// R65/R66/R67 的证据探针：这些是**放在仓库根目录的、真实存在的文件名**，不含任何猜测。
// 走 raw.githubusercontent.com 直读（`fetchText` 是 api:'none'，不吃 GitHub 额度），
// 所以"看到 Dockerfile 才知道这个项目能用 Docker"这条代价极低；而一旦漏掉它，
// 一个只有 Docker 路径的真项目会因为"没有已核实的安装路径"被门槛 5 整条挡在榜外。
//
// R82（控制者裁定）：探针列表**收敛到最多 4 个、按信息量从高到低排**。
// 为什么是这 4 个：
//   · `Dockerfile` —— docker 证据里覆盖面最广的一个（compose 文件远比它少见，而 dockerOnly 只要求
//     "能用 Docker"，一个 Dockerfile 就足以说明这件事）；
//   · `docker-compose.yml` —— 补上"只有 compose、没有 Dockerfile"的那一小撮；
//   · `Cargo.toml` / `go.mod` —— 编译型项目里最主流的两种清单，各自同时暴露"要从源码构建"。
// 砍掉的（`.yaml` 变体、Makefile、CMakeLists.txt、build.gradle、meson.build）不是没有价值，
// 而是**边际信息量最低**：它们与留下的 4 个高度相关（有 Makefile 的项目常常也有 Dockerfile 或 Cargo.toml），
// 而每多探一个文件就多一次**串行**真实 HTTP 往返（25 个候选 × 10 个文件 = 250 次），
// 侦察阶段已实测到 github.com 在负载下会连接超时 —— 列表越长，一轮采集越慢、越容易被限流。
// 两个证据域因此合成**一个有序列表**：只探一次、命中即停，天然不会"docker 已命中还去探编译清单"。
// 为什么不加缓存：`fetchText` 的 TTL 为 0 是 Task 7 已评审的既定契约（它服务 HTML 与 raw 文本），
// 不为这一处去改动 net 层；省请求的正确做法是**少探几个文件**，而不是给 raw 加缓存。
const PROBE_EVIDENCE_FILES = ['Dockerfile', 'docker-compose.yml', 'Cargo.toml', 'go.mod'];
// Docker 证据的判定面：与探针列表里的 docker 文件名一致（只认这两个）。
const DOCKER_EVIDENCE_NAMES = new Set(['dockerfile', 'docker-compose.yml']);
// 探针只认这四种状态，其余（数组、数字、空串）一律按"没问到"：绝不让坏数据变成"确认有文件"。
const RAW_FOUND = 'found';
const RAW_MISSING = 'missing';
const RAW_UNKNOWN = 'unknown';

/** UTC 日期串（YYYY-MM-DD），与数据层的历史文件名口径一致。 */
const utcDate = (date) => date.toISOString().slice(0, 10);

/** 是不是一个可用的星标计数。 */
const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * 收集按目录里的本地化文件名（R65/R66/R67 的证据旗标用）。
 * 这些名字来自 GitHub API 的仓库文件列表，是**文件名证据**，不是我们从仓库名猜的结论。
 * @param {object} repo 候选仓库
 * @returns {Set<string>} 小写文件名集合
 */
function evidenceFileNames(repo) {
  const names = new Set();
  for (const file of Array.isArray(repo?.evidencedFiles) ? repo.evidencedFiles : []) {
    if (typeof file === 'string' && file !== '') names.add(file.toLowerCase());
  }
  return names;
}

/**
 * R65/R66/R67：证据旗标只能来自**真实存在的文件**，绝不猜。
 * 两个证据来源，且都只朝"有证据"方向给结论：
 *   · `repo.evidencedFiles` —— 上游若已经把文件清单（例如仓库接口的 contents 结果）放进候选，直接采用；
 *   · 直接在 `defaultBranch` 上探那几个根目录文件名（下面的 probeEvidenceFiles）—— 这是真实取到的证据。
 * 只有确实看到 Dockerfile / docker-compose.yml 时才给 docker: true；
 * 只有确实看到编译清单（Cargo.toml / go.mod / Makefile / CMakeLists.txt …）时才给 buildFromSource: true。
 * **拿不到就说拿不到**：没有证据时两个旗标都不给（下游因此照实地在门槛 5 上失败，那是正确结果）；
 * 一次读不到某个文件绝不记成 false —— "没问到"与"确认没有"在 R40/R41 里是两个不同的东西。
 * @param {object} repo 候选仓库
 * @returns {{ docker: boolean, buildFromSource: boolean }}
 */
function evidenceFlags(repo) {
  const files = evidenceFileNames(repo);
  // 与探针列表同一判定面（R82）：只认 Dockerfile / docker-compose.yml 为 docker 证据。
  // 上游若给了更全的清单（.yaml 变体、compose.yaml、Makefile…），照旧认得出来 —— 这里不设上限，
  // 上限只针对"我们自己要发几次请求"。
  const docker = [...DOCKER_EVIDENCE_NAMES].some((name) => files.has(name));
  const buildFromSource = files.has('cargo.toml') || files.has('go.mod') || files.has('makefile')
    || files.has('cmakelists.txt') || files.has('build.gradle') || files.has('meson.build');
  return { docker, buildFromSource };
}

/**
 * 在仓库的默认分支上读一个根目录文件（raw 直读，不吃 GitHub 额度），把结果归成三态：
 *   'found'   读到了非空内容 → 这个文件确实存在；
 *   'missing' 读不到内容（fetchText 返回 null：404 之类的"这个文件不存在"）或文件是空的
 *             （空文件的证据价值与没有一样）→ 不构成证据；
 *   'unknown' client 没有 fetchText 能力 / 抛错 / 仓库名或分支名不合法 → 我们没问到。
 * 无论哪一态，"没有读到非空内容"都只会让旗标缺席，绝不会变成"确认这个项目不能装"：
 * 证据不够时下游宁可说"没有已核实的安装路径"（门槛 5 挡下），也不编一条路出来。
 * @param {object} client 网络客户端
 * @param {string} ownerRepo owner/repo
 * @param {string} branch 默认分支（只用仓库自己给的，绝不猜 main）
 * @param {string} fileName 根目录文件名
 * @returns {Promise<'found'|'missing'|'unknown'>}
 */
async function probeEvidenceFile(client, ownerRepo, branch, fileName) {
  if (typeof client?.fetchText !== 'function') return RAW_UNKNOWN;
  if (typeof ownerRepo !== 'string' || ownerRepo === '' || typeof branch !== 'string' || branch === '') return RAW_UNKNOWN;
  try {
    const body = await client.fetchText(`https://raw.githubusercontent.com/${ownerRepo}/${branch}/${fileName}`);
    if (typeof body !== 'string') return RAW_MISSING;
    return body.trim() === '' ? RAW_MISSING : RAW_FOUND;
  } catch {
    // 探测本身失败（网络/超时）只是"没问到"，绝不当成"没有这个文件"。
    return RAW_UNKNOWN;
  }
}

/**
 * 在候选文件里找出**第一个确实存在**的文件名（命中即停，一个证据成立就不必再往下探）。
 * 串行探测（与 net/client 的全局串行队列保持同一形状，注入的假实现也不必考虑并发）；
 * 某个文件抛错只会让它自己算'unknown'，不会打断整组。
 * @param {object} client 网络客户端
 * @param {string} ownerRepo owner/repo
 * @param {string} branch 默认分支
 * @param {string[]} fileNames 有序的候选文件名（信息量从高到低，R82 保证最多 4 个）
 * @returns {Promise<string|null>} 读到的文件名；一个都没有则 null
 */
async function probeEvidenceFiles(client, ownerRepo, branch, fileNames) {
  for (const fileName of fileNames) {
    if (await probeEvidenceFile(client, ownerRepo, branch, fileName) === RAW_FOUND) return fileName;
  }
  return null;
}

/**
 * 从同一份历史 JSON 里算"收藏有没有在增长"（R41 的生产端）。
 *
 * 口径与 star-velocity.mjs 的级别 3 完全一致：都读 public/data/<7 天前>.json 的快照星数。
 * 为什么必须同一份数据：两处若各自记一套历史，"涨星速度"与"收藏持续增长"会对同一件事给出不同结论。
 *
 * 三态（与 releases.mjs 的 R40 同一套纪律）：
 *   · true  —— 历史上有，而且今天比 7 天前多
 *   · false —— 历史上有，但没涨（含持平与掉星：取消收藏是真实存在的行为，照实算"没涨"）
 *   · null  —— **还没有历史**（新项目、或第一轮采集）。这不是"确认没涨"，
 *              所以 score.mjs 给它中性半分，调用方据此把本轮标成 degraded（R41：静默未知必须可见）。
 * @param {string} dataDir 数据目录
 * @param {Date} now 显式的"现在"
 * @param {object} repo 候选仓库（用到 ownerRepo 与今天的 stars）
 * @returns {boolean|null}
 */
export function growingFromHistory(dataDir, now, repo) {
  const ownerRepo = typeof repo?.ownerRepo === 'string' ? repo.ownerRepo : '';
  if (ownerRepo === '' || !isCount(repo?.stars)) return null;
  if (typeof dataDir !== 'string' || dataDir === '') return null;

  const pastDate = utcDate(new Date(now.getTime() - 7 * DAY_MS));
  const past = readSnapshotStars(dataDir, pastDate).get(ownerRepo);
  // 7 天前那份快照里没有这个仓库 = 我们还没有它的历史 → 不知道，不是"没涨"。
  if (!isCount(past)) return null;
  return repo.stars > past;
}

/**
 * 富化单个候选：把"我们查到了什么"全部写回 candidate。
 *
 * 写回的东西（顺序即成本顺序）：
 *   1. releases  —— 1 次 core 请求：Windows 安装包证据 + **repo.hasRelease90d**（R41 三态）
 *   2. npm/PyPI  —— 0 次（api:'none'）：只在明确给了包名时查，且归属不成立就整条丢弃（R68）
 *   3. README    —— 最多 5 次 api:'none'：中文证据（R64 的两个结论分开产出）
 *   4. 证据探针  —— 最多 4 次 api:'none'：Dockerfile / 编译清单是否**真实存在**（R65/R66/R67、R82）
 *   5. growing   —— 0 次请求：读本地历史 JSON（R41 的另一个生产端）
 *
 * @param {object} candidate { repo, runnability?, velocity?, extra? }
 * @param {{ client: object, dataDir: string, now: Date, heavy?: boolean }} ctx
 *   heavy 为 false 时跳过 registry 与 README 直查（经典榜的候选只要能被排出来就够了，
 *   而门槛本来就不适用于经典榜）——省下的额度留给能进周榜的候选。
 * @returns {Promise<object>} 同一个 candidate 对象（就地补写）
 */
export async function enrichCandidate(candidate, ctx) {
  const { client, dataDir, now } = ctx;
  const heavy = ctx.heavy !== false;
  const repo = candidate.repo ?? {};
  const ownerRepo = typeof repo.ownerRepo === 'string' ? repo.ownerRepo : '';
  const extra = candidate.extra && typeof candidate.extra === 'object' ? candidate.extra : (candidate.extra = {});

  // ---- ① release：既喂安装路径（Windows 资产），又喂口碑轴的 release90d ----
  let releases = null;
  if (ownerRepo !== '') {
    try {
      releases = await fetchLatestRelease(client, ownerRepo);
    } catch {
      releases = null; // 一次查询失败只是"没问到"，不中断整轮
    }
  }
  // R41 的生产端之一：**在这里写**（不是读）。null 代表"没问到"，绝不在下游被当成"确认没有"。
  repo.hasRelease90d = hasRecentRelease(releases, now);

  // ---- ② npm / PyPI：只认上游明确给的包名（R68：绝不从仓库名推导包名） ----
  let npm = null;
  let pypi = null;
  if (heavy && ownerRepo !== '') {
    if (typeof repo.npmPackage === 'string' && repo.npmPackage.trim() !== '') {
      try {
        npm = await lookupNpm(client, repo.npmPackage, ownerRepo);
      } catch {
        npm = null;
      }
    }
    if (typeof repo.pypiPackage === 'string' && repo.pypiPackage.trim() !== '') {
      try {
        pypi = await lookupPyPI(client, repo.pypiPackage, ownerRepo);
      } catch {
        pypi = null;
      }
    }
  }

  // ---- ③ README 中文证据（api:'none'，不吃 GitHub 额度；分支名只用 defaultBranch，绝不猜） ----
  let chinese = null;
  if (heavy && ownerRepo !== '' && typeof repo.defaultBranch === 'string' && repo.defaultBranch !== '') {
    try {
      chinese = detectChinese(await fetchChineseEvidence(client, ownerRepo, repo.defaultBranch));
    } catch {
      chinese = null;
    }
  }

  // ---- ④ 安装路径判定：只把**有证据**的旗标传进去（R65/R66/R67） ----
  // 证据来自两处：上游直接给的 evidencedFiles（零成本）与在默认分支上真读到的根目录文件。
  // 探针只在"确实可能改变结论"时才跑：如果 release 安装包、已核实的 npm 包或已核实的 PyPI 包
  // 已经给出一条更高优先级的路径，Docker/编译这两档永远轮不到，那几次读取就是白花。
  // 反过来说，走到探针这一步的候选都还没有任何安装路径 —— 探完仍然没有，才轮到门槛 5 如实挡下它。
  // 这是"我们尽力查过"与"我们编一条路"之间的区别。
  const cheapFlags = evidenceFlags(repo);
  // "已经有了能用的一条路吗"：口径与 classifyRunnability 的优先级链逐档对齐，**不能只看"查到了"**。
  // 反例（R66）：npm 包有 bin 却只声明 Linux/macOS 时不构成安装路径，此时探针仍然必须跑
  // ——否则这个项目会连 Docker 那条真路都拿不到，白掉一条 spec 允许的路径。
  const windowsAssetUrl = typeof releases?.windowsAsset?.url === 'string' ? releases.windowsAsset.url.trim() : '';
  const npmUsable = npm !== null && npm.repoMatches === true
    && (npm.hasBin === false || (npm.hasBin === true && npm.osIncludesWin === true));
  const pypiUsable = pypi !== null && pypi.repoMatches === true;
  const hasInstallEvidence = windowsAssetUrl !== '' || npmUsable || pypiUsable;
  const canProbe = heavy && ownerRepo !== '' && typeof repo.defaultBranch === 'string' && repo.defaultBranch !== '';
  // R82：一次探一个**有序列表**（≤4 个文件），命中即停。探到哪个文件名决定了旗标属于哪个域，
  // 所以不必分两轮各探一遍 —— 两轮会把这个预算翻倍。
  const probedFile = canProbe && !hasInstallEvidence && !cheapFlags.docker && !cheapFlags.buildFromSource
    ? await probeEvidenceFiles(client, ownerRepo, repo.defaultBranch, PROBE_EVIDENCE_FILES)
    : null;
  const probedDocker = probedFile !== null && DOCKER_EVIDENCE_NAMES.has(probedFile.toLowerCase());
  const probedBuild = probedFile !== null && !probedDocker;
  candidate.runnability = classifyRunnability({
    releases,
    npm,
    pypi,
    chinese,
    ...(cheapFlags.buildFromSource || probedBuild ? { buildFromSource: true } : {}),
    ...(cheapFlags.docker || probedDocker ? { docker: true } : {}),
  });

  // ---- ⑤ R41 的另一个生产端：extra.growing ----
  extra.growing = growingFromHistory(dataDir, now, repo);

  return candidate;
}

// ---------- 离线演示用的那一路管线（fixtures/candidates.json，一次网络请求都不发） ----------

/**
 * 离线 sources：数据全部来自 fixtures/candidates.json。
 * 它存在的意义是"断网也能完整演示"（spec §11 交付物 4：npm run demo）与本地调试；
 * **不是**测试替身——测试自己注入自己的假实现，这样两者不会互相掩盖问题。
 *
 * 经典池：fixture 是"三榜共用的一份样本"，所以这里把整份候选交给经典榜。
 * 真实管线**必须**用单独的 fetchClassicTop（R26），这条注释就是提醒别照抄这里的做法。
 *
 * R88（控制者裁定）：这里**不提供 `trending`**。离线模式本来就没去抓 trending 页面，
 * 而 R35 把"trending 返回空"正确地判成"我们没查到"（真实网络下的页面改版就是这种形状）——
 * 于是 `collect --offline` 与 `npm run demo`（我们的作品集演示路径）会**每一轮**都挂着
 * "本期数据不完整"的横幅，而离线演示的数据其实是完整的。不提供这个方法 = 不声称做过一件
 * 我们没做的事：R35 只在真的调用了 trending 之后才判断，没调用就没有"失败"可言。
 * @returns {{ discover: Function, enrich: Function }}
 */
export function createOfflineSources() {
  const fixture = readFileSync(new URL('../../fixtures/candidates.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(fixture);
  const pool = Array.isArray(parsed) ? parsed : [];
  return {
    async discover() {
      // 深拷贝：runCollect 会就地补写 repo.hasRelease90d 与 extra.growing，
      // 直接改模块级的 fixture 对象会让同进程里的下一次运行拿到被改写过的数据。
      const candidates = structuredClone(pool);
      return { candidates, classic: async () => structuredClone(pool) };
    },
    async enrich(candidate) {
      return candidate; // fixture 已经是"富化后"的形状
    },
  };
}

/**
 * 组装真实采集管线。
 * @param {{ client: object, dataDir: string, now: Date }} ctx
 * @returns {{ discover: Function, enrich: Function, resolveVelocity: Function }}
 */
export function createRealSources({ client, dataDir, now }) {
  // trending 一次抓两个窗口：daily 给新的锚点，weekly 自己就写着 starsThisWeek（级别 2 的原料，0 成本）。
  let trendingByRepo = new Map();
  let trendingItems = [];
  let trendingLoaded = false;

  const loadTrending = async () => {
    if (trendingLoaded) return trendingItems;
    trendingLoaded = true;
    // fetchTrending 自己就把失败降级成 []，这里再兜一层：任何意外都不该把 discover() 带崩。
    let daily = [];
    let weekly = [];
    try {
      [daily, weekly] = await Promise.all([
        fetchTrending(client, 'daily'),
        fetchTrending(client, 'weekly'),
      ]);
    } catch {
      daily = [];
      weekly = [];
    }
    trendingItems = [...daily, ...weekly];
    trendingByRepo = new Map();
    for (const item of trendingItems) {
      if (typeof item?.fullName === 'string') trendingByRepo.set(item.fullName, item);
    }
    return trendingItems;
  };

  return {
    /**
     * 发现候选：两个 search 查询（新项目 / 活跃老项目）+ 经典榜自己的池子 + trending 锚点。
     * @returns {Promise<{ candidates: object[], classic: Function, trending: Function }>}
     */
    async discover() {
      const [fresh, active] = await Promise.all([
        discoverNewRepos(client, { now }),
        discoverActiveRepos(client, { now }),
      ]);
      // 去重（同一仓库可能既新又活跃），保持"新项目在前"的顺序：新项目更容易是本周飙升的主角。
      const seen = new Set();
      const candidates = [];
      for (const repo of [...fresh, ...active]) {
        if (!repo || typeof repo.ownerRepo !== 'string' || seen.has(repo.ownerRepo)) continue;
        seen.add(repo.ownerRepo);
        candidates.push({ repo });
      }

      // R26：经典榜的池子**必须**是单独的一次搜索。它与候选池的排序键不同（stars vs created/pushed），
      // 捞回来的也是完全不同的那批仓库。
      const classic = async () => {
        const top = await fetchClassicTop(client, { minStars: CLASSIC_MIN_STARS, perPage: CLASSIC_PER_PAGE });
        return top.map((repo) => ({ repo }));
      };

      await loadTrending();
      return { candidates, classic, trending: async () => trendingItems };
    },

    /**
     * 富化单个候选。
     * @param {object} candidate
     * @param {{ heavy?: boolean }} [options]
     * @returns {Promise<object>}
     */
    async enrich(candidate, options = {}) {
      return enrichCandidate(candidate, { client, dataDir, now, heavy: options.heavy !== false });
    },

    /**
     * R53：涨星速度在富化**之后**解析；freeOnly 为 true 时只跑免费级（级别 1/2/3，零请求）。
     * `dataDir` 必须一起传下去：阶梯的级别 3（实测的历史差值）读的正是**与 R41 的 growing 同一份**
     * 历史 JSON —— `public/data/<7 天前>.json`。少了它，级别 3 会静默不可用，而它恰恰是整条阶梯
     * 唯一的免费实测来源（口径与 growing 也会随之分叉）。
     * @param {object} candidate
     * @param {{ freeOnly?: boolean }} [options]
     * @returns {Promise<object>}
     */
    async resolveVelocity(candidate, options = {}) {
      await loadTrending();
      return resolveVelocityLadder(candidate.repo, {
        client,
        dataDir,
        trendingByRepo,
        now,
        freeOnly: options.freeOnly === true,
      });
    },
  };
}

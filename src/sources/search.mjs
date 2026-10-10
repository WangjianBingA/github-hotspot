// GitHub 好玩榜 —— search API 三个发现器：新项目、活跃老项目、经典总榜。
// 这一层只负责“把候选池捞回来”：拼查询串、发一次请求、把 GitHub 的仓库对象映射成 RepoRef。
//   · 网络 I/O 全部经由注入的 client（getJson(url, { api: 'search' }) 吃 search 桶额度，
//     未认证时只有 10 次/分钟，所以这里三个函数各自只发一次请求，没有分页循环）；
//   · 任何异常、null 响应体、非数组 items 一律降级成 []——一次搜索失败不能带崩整轮采集；
//   · 不做评分、不判门槛、不解析 HTML（评分看 score 层，门槛是 score 层的 GATE_MIN_STARS）。
//
// 已知局限（项目 spec 记录）：search 无法发现“老仓库突然爆涨”。按 stars 排序只能捞出常青巨物，
// 按 updated 排序只能捞出“最近有提交”的仓库——两者都看不见涨星速度。
// 所以 discoverActiveRepos 是**候选池提供者**，不是爆涨探测器；
// 真正的爆涨信号来自 trending 页面（网页自己渲染的 N stars today）与 star-history 端点。
//
// 关于限定符（实测结论，务必记住）：GitHub 搜索里**多个限定符之间是 AND 关系，不是 OR**。
// 所以绝不能在 discoverActiveRepos 的 `pushed:>` 旁边再叠加 `created:>`：
// 那等于要求"近期有提交 **且** 近期才创建"，会把所有老仓库全部剔除，本函数也就失去了唯一的意义
// （实测：`pushed:>2026-10-02 stars:>500` 命中 23,684 个仓库，叠加 `created:>2026-10-02` 后只剩 40 个，
// 且全是一周内新建的）。"发现新项目"这条路由 discoverNewRepos 专门负责，不要在这里重复。
//
// 关于 minStars：每个函数自己的默认值（200 / 500 / 100000）是**发现用的预过滤**——
// 它只用来把搜索查询写窄一点、少捞回一些必被门槛挡掉的仓库。
// 它**不是**评分门槛：门槛是 score.mjs 里独立的 GATE_MIN_STARS = 200 常量。
// 两处语义不同、取值不同（这里可以是 500 或 100000），任何“统一成一份常量”的改动都是错的。

const SEARCH_ENDPOINT = 'https://api.github.com/search/repositories';

// R36：search API 的 per_page 硬上限是 100。两个发现器统一取 50，
// 既能一次捞够候选池，又不会让单次响应过大；fetchClassicTop 按需自定（默认 30）。
const DISCOVERY_PER_PAGE = 50;
const MAX_PER_PAGE = 100;

// 各发现器的默认发现预过滤星数（不是门槛，见文件头注释）。
const NEW_MIN_STARS = 200;
const ACTIVE_MIN_STARS = 500;
const CLASSIC_MIN_STARS = 100000;

// 各发现器的默认时间窗口（天）与总榜默认条数。
const DEFAULT_DAYS = 7;
const DEFAULT_PER_PAGE = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 正数才认，否则回落到默认值（NaN、负号、字符串一律当没给）。 */
const toPositive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

/**
 * 把 now 往前推 days 天，取 UTC 日期串（YYYY-MM-DD）。
 * 统一走 toISOString 的 UTC 口径：本地时区偏移不会让窗口悄悄少一天或多一天。
 * @param {Date} now 显式的“现在”
 * @param {number} days 往前推的天数
 * @returns {string} YYYY-MM-DD
 */
const utcDateBefore = (now, days) => new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);

/** 拼搜索地址；q 必须整串 encodeURIComponent，这样 `:` 与 `>` 能原样活过传输层。 */
const buildUrl = (query, sort) =>
  `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&sort=${sort}&order=desc&per_page=`;

/**
 * 单条原始仓库对象 → RepoRef 的防御性映射。
 * 缺字段、null、类型不对都给安全默认值；连仓库标识都拿不到的条目返回 null（调用方丢弃）。
 * @param {*} raw GitHub search 返回的单条 item
 * @returns {object|null} RepoRef，或 null（无法确定是哪个仓库）
 */
const mapItem = (raw) => {
  if (!raw || typeof raw !== 'object') return null;

  // 仓库标识优先用 full_name；缺了就按 owner.login + '/' + name 拼回来。
  const fullName = typeof raw.full_name === 'string' && raw.full_name !== ''
    ? raw.full_name
    : [raw.owner?.login, raw.name].filter((part) => typeof part === 'string' && part !== '').join('/');
  if (fullName === '') return null;

  // name 单独暴露：优先用接口给的 name，没有就从 ownerRepo 里切。
  const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : fullName.split('/').pop();

  // 没有许可证、或 GitHub 说“无法认定”（NOASSERTION）都归一化成 null；
  // 字符串形式（有些来源直接给 SPDX 串）也认。
  const spdx = typeof raw.license === 'string' ? raw.license : raw.license?.spdx_id;
  const license = typeof spdx === 'string' && spdx !== '' && spdx !== 'NOASSERTION' ? spdx : null;

  return {
    ownerRepo: fullName,
    name,
    description: typeof raw.description === 'string' ? raw.description : null,
    language: typeof raw.language === 'string' ? raw.language : null,
    stars: Number.isFinite(raw.stargazers_count) ? raw.stargazers_count : 0,
    forks: Number.isFinite(raw.forks_count) ? raw.forks_count : 0,
    openIssues: Number.isFinite(raw.open_issues_count) ? raw.open_issues_count : 0,
    // search API 不返回已关闭 issue 数（要另开一次 core 请求才拿得到），一律 0 表示“不知道”，
    // 不去猜：score 层的 issue 处理率会把 0 当成还没处理过，这是保守方向。
    closedIssues: 0,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : null,
    pushedAt: typeof raw.pushed_at === 'string' ? raw.pushed_at : null,
    license,
    archived: raw.archived === true,
    defaultBranch: typeof raw.default_branch === 'string' ? raw.default_branch : null,
    topics: Array.isArray(raw.topics) ? raw.topics.filter((t) => typeof t === 'string') : []
  };
};

/**
 * 发一次搜索并映射结果。所有失败路径都降级成空数组。
 * @param {object} client 注入的网络客户端
 * @param {string} url 完整搜索地址
 * @returns {Promise<Array<object>>} RepoRef 列表
 */
const searchOnce = async (client, url) => {
  try {
    if (!client || typeof client.getJson !== 'function') return [];
    const body = await client.getJson(url, { api: 'search' });
    if (!body || !Array.isArray(body.items)) return [];
    return body.items.map(mapItem).filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * 发现新项目：近 days 天创建、收藏数达预过滤线。
 * @param {object} client 注入的网络客户端
 * @param {{ days?: number, minStars?: number, now?: Date }} [options]
 * @returns {Promise<Array<object>>} RepoRef 列表
 */
export async function discoverNewRepos(client, { days = DEFAULT_DAYS, minStars = NEW_MIN_STARS, now = new Date() } = {}) {
  const window = toPositive(days, DEFAULT_DAYS);
  const stars = toPositive(minStars, NEW_MIN_STARS);
  const since = utcDateBefore(now, window);
  // R37：新项目按 stars 降序——刚创建就攒到星星的，才是真的有人在用。
  return searchOnce(client, `${buildUrl(`created:>${since} stars:>${stars}`, 'stars')}${DISCOVERY_PER_PAGE}`);
}

/**
 * 发现活跃老项目：近 days 天有提交（pushed）且收藏数达预过滤线。
 * 这是候选池提供者而非爆涨探测器，见文件头注释。
 * 查询里**只有** pushed 与 stars 两个限定符：不能再叠加 created，见文件头"关于限定符"。
 * @param {object} client 注入的网络客户端
 * @param {{ days?: number, minStars?: number, now?: Date }} [options]
 * @returns {Promise<Array<object>>} RepoRef 列表
 */
export async function discoverActiveRepos(client, { days = DEFAULT_DAYS, minStars = ACTIVE_MIN_STARS, now = new Date() } = {}) {
  const window = toPositive(days, DEFAULT_DAYS);
  const stars = toPositive(minStars, ACTIVE_MIN_STARS);
  const since = utcDateBefore(now, window);
  // R37：活跃度只能靠 updated 排序近似——它说明"最近有提交"，不说明"涨得快"。
  return searchOnce(client, `${buildUrl(`pushed:>${since} stars:>${stars}`, 'updated')}${DISCOVERY_PER_PAGE}`);
}

/**
 * 经典总榜：收藏数达到极高线的仓库（“大名鼎鼎”的那批）。
 * @param {object} client 注入的网络客户端
 * @param {{ minStars?: number, perPage?: number }} [options]
 * @returns {Promise<Array<object>>} RepoRef 列表
 */
export async function fetchClassicTop(client, { minStars = CLASSIC_MIN_STARS, perPage = DEFAULT_PER_PAGE } = {}) {
  const stars = toPositive(minStars, CLASSIC_MIN_STARS);
  const limit = Math.min(toPositive(perPage, DEFAULT_PER_PAGE), MAX_PER_PAGE);
  // R37：总榜按 stars 降序，捞的就是收藏数最高的那批。
  return searchOnce(client, `${buildUrl(`stars:>${stars}`, 'stars')}${limit}`);
}
// GitHub 好玩榜 —— 仓库事件流（级别 4 涨星估算的原料）。
// 这一层只回答一个问题：这个仓库最近的事件里，哪些是"涨星"（WatchEvent）？
//   API：GET /repos/{owner}/{repo}/events?per_page=100 —— 只取第一页、不分页。
//   为什么够用：级别 4 本来就是外推（用最近这一段观测窗口的速率×168 小时），
//   而 100 条事件对活跃仓库只覆盖几小时、对安静仓库覆盖几天，都是"最近这一段"；
//   翻页只会拿到更旧的事件，反而把速率摊平。真正要精确的 7 日增量是级别 0/3 的职责，
//   级别 4 的价值在于"连历史 JSON 都没有时还能给一个带 estimated 标签的数"。
//
// 三态（与 releases.mjs 同一套纪律，绝不把"没问到"当成"没有"）：
//   · 数组（可能为空）→ 问到了：这是该仓库最近事件里的**涨星事件**列表
//   · null            → 没问到（请求失败 / 额度耗尽 / 响应不是数组）—— 未知，不是"没有涨星"
//
// 过滤纪律（失败关闭 R44/R47 方向一致）：只认 `type === 'WatchEvent'` 且 `created_at` 可解析的条目。
// `type` 缺失时**不当作涨星**：事件流里混着 PushEvent / IssuesEvent / ForkEvent……，
// 少算几起星标只是估算偏小（下游会标"约 N（估算）"），把推送事件算成涨星则是凭空放大一个事实。
//
// 网络 I/O 全部经由注入的 client，一律 api:'core'（这是 GitHub API，吃额度）。

const GITHUB_API = 'https://api.github.com';

/**
 * 一条事件是不是"涨星"。要求 `type` 明写为 WatchEvent，且 `created_at` 能解析成时间。
 * @param {*} event 事件对象
 * @returns {boolean}
 */
function isStarEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.type !== 'WatchEvent') return false;
  return Number.isFinite(Date.parse(event.created_at));
}

/**
 * 拉仓库最近的涨星事件（一次请求，不分页）。
 * @param {{ getJson: (url: string, options?: object) => Promise<*> }} client 注入的网络客户端
 * @param {string} ownerRepo 形如 'microsoft/markitdown'
 * @returns {Promise<object[]|null>} 涨星事件列表（可能为空数组）；没问到答案时为 null
 */
export async function fetchWatchEvents(client, ownerRepo) {
  try {
    if (!client || typeof client.getJson !== 'function') return null;
    const repo = typeof ownerRepo === 'string' ? ownerRepo.trim() : '';
    if (repo === '') return null;

    const body = await client.getJson(`${GITHUB_API}/repos/${encodeURI(repo)}/events?per_page=100`, { api: 'core' });
    // 非数组 = 我们没拿到能读的答案（null / 错误体对象 / 字符串）：未知，不是"没有涨星"。
    if (!Array.isArray(body)) return null;
    return body.filter(isStarEvent);
  } catch {
    return null;
  }
}

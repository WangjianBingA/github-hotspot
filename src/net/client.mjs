// GitHub 好玩榜 —— 串行网络客户端。
// 这是整个项目唯一的网络出入口，只负责"怎么把请求发出去"：
//   1. 全局严格串行：同一时刻最多 1 个在途请求（并发打 github.com 会被它自己限速到超时）；
//   2. 额度预算：预算按"实际发出的请求"计（重试也各算一次）；用尽时连请求都不发，
//      返回 null 并标记 degraded（调用方按"本轮没数据"处理）；
//   3. 缓存优先：命中缓存直接返回，不发请求也不吃额度；
//   4. 超时与重试：20s 超时中断，5xx / 网络错误最多尝试 3 次，退避 1s / 2s / 4s；
//   5. 403 / 429 限流：带限流特征（x-ratelimit-remaining: 0、retry-after，或没有 remaining 头时的
//      reset 头）的按限流处理：reset 很远抛 RateLimitError（调用方收工），很近就睡到 reset 再试一次；
//      额度还有余额的 403 是权限问题，按"服务器的明确回答"处理（见下一条）；
//   6. degraded 的语义（R43）：**只表示"我们没拿到需要的答案"**——额度耗尽被拦、RateLimitError
//      中止、5xx / 超时重试耗尽才算；而 404 之类**明确的 4xx** 是服务器给出的确定回答
//      （答案叫"没有"：这个仓库没发过 npm 包、这个文件不存在），绝不能置 degraded，
//      否则一条 404 就会让整张榜对用户显示"数据不完整"——把"某一路没有答案"误当成"整体不可用"。
// 这里没有评分、没有 HTML 解析、没有任何 GitHub 业务规则；时间与等待都可注入，便于测试。

const TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;                 // 一次逻辑请求最多尝试 3 次（含首次）
const BACKOFF_MS = [1000, 2000, 4000];  // 第 n 次失败后的退避时长
const RATE_LIMIT_NEAR_MS = 300_000;     // reset 距今不超过 5 分钟：值得等
const USER_AGENT = 'github-hotspot';

const GITHUB_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
// 非 GitHub 主机（npm registry / raw / HN 等）不吃 GitHub 的 Accept 头。
const PLAIN_HEADERS = { accept: '*/*' };

/**
 * 额度已耗尽且短时间内不会恢复：调用方应当结束本轮采集。
 */
export class RateLimitError extends Error {
  /**
   * @param {string} message 中文说明
   * @param {number} resetAt 额度重置时间（UTC 秒，即 x-ratelimit-reset 的原值）
   */
  constructor(message, resetAt) {
    super(message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

/** 默认等待实现；测试通过注入 sleep 避免真的等待。 */
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 创建网络客户端。
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl] 注入的 fetch，默认全局 fetch（测试永不发真实请求）
 * @param {string} [options.token] GitHub token；有则带 Authorization 头，绝不写日志
 * @param {number} [options.budget] 吃额度的请求总预算；按实际发出的请求数计（含重试），默认不限
 * @param {object} [options.cache] 形如 createFileCache 的缓存对象
 * @param {() => number} [options.now] 返回当前毫秒时间戳，默认 Date.now
 * @param {(ms: number) => Promise<void>} [options.sleep] 等待实现，默认 setTimeout
 * @param {object} [options.logger] 形如 console 的日志对象；默认静默（不污染测试输出）
 * @param {number} [options.timeoutMs] 单次请求超时毫秒数，默认 20000
 * @returns {{ getJson: Function, fetchText: Function, stats: Function }}
 */
export function createClient({
  fetchImpl = globalThis.fetch,
  token,
  budget = Infinity,
  cache,
  now = Date.now,
  sleep = defaultSleep,
  logger,
  timeoutMs = TIMEOUT_MS
} = {}) {
  let coreCalls = 0;
  let searchCalls = 0;
  let cacheHits = 0;
  let degraded = false;

  // 串行队列：后一个任务挂在前一个任务的结果上，且前一个失败也不阻断队列。
  let tail = Promise.resolve();
  const enqueue = (task) => {
    const result = tail.then(task);
    tail = result.then(() => {}, () => {});
    return result;
  };

  /** 组装请求头：token 只出现在这里，永远不进日志。 */
  const buildHeaders = (api) => {
    const base = api === 'none' ? PLAIN_HEADERS : GITHUB_HEADERS;
    const headers = { ...base, 'user-agent': USER_AGENT };
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  };

  /** 读一个响应头；头不存在或为空串时返回 null（注意 res.headers 可能是 Map，也可能是 Headers）。 */
  const headerOf = (res, name) => {
    const value = res.headers?.get?.(name);
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };

  /**
   * 判断 403 / 429 是不是"限流 / 额度"性质（R43）。
   * - retry-after 头：GitHub 的二级限流用它告诉你等多久 → 限流；
   * - x-ratelimit-remaining: 0 → 主额度用尽 → 限流；
   * - remaining 头存在但大于 0 → **不是**限流，是权限问题（例如私有仓库没授权）→ 明确回答；
   * - remaining 头缺失时才退回 reset 头（x-ratelimit-* 在正常响应里也会出现，不能单凭它判断）。
   * @param {*} res fetch 响应
   * @returns {boolean}
   */
  const isRateLimited = (res) => {
    if (headerOf(res, 'retry-after') !== null) return true;
    const remaining = headerOf(res, 'x-ratelimit-remaining');
    if (remaining !== null) return remaining === '0';
    return headerOf(res, 'x-ratelimit-reset') !== null;
  };

  /**
   * 限流之后什么时候可以再试：优先 x-ratelimit-reset（UTC 秒），
   * 没有就用 retry-after（秒，GitHub 二级限流用），换算成"现在 + N 秒"。
   * 都读不到返回 null，由调用方按"立刻重试一次"处理。
   * @param {*} res fetch 响应
   * @returns {number|null} UTC 秒
   */
  const rateLimitResetAt = (res) => {
    const reset = headerOf(res, 'x-ratelimit-reset');
    if (reset !== null && Number.isFinite(Number(reset))) return Number(reset);
    const retryAfter = headerOf(res, 'retry-after');
    if (retryAfter !== null && Number.isFinite(Number(retryAfter)) && Number(retryAfter) > 0) {
      return Math.floor(now() / 1000) + Number(retryAfter);
    }
    return null;
  };

  /**
   * 发一次请求，把结果翻译成"继续 / 重试 / 放弃 / 抛错"四态，本身不抛错。
   * 只有 5xx 与网络错误可重试；4xx 是**确定性的回答**（404 = 不存在、401 = 没授权），重试没有意义，
   * 但它是"问到了答案"，所以带 definitive: true，调用方据此不置 degraded（R43）。
   * @returns {Promise<{type:'ok', value:*}|{type:'ratelimit', resetAt:number|null}|{type:'error', retryable:boolean, definitive:boolean, error:Error}>}
   */
  const attemptOnce = async (url, api, mode) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: buildHeaders(api), signal: controller.signal });
      if (res.status === 403 || res.status === 429) {
        // 429 本身就是"请求太多"；403 只有带限流特征时才算限流，否则是权限问题（明确回答）。
        if (res.status === 429 || isRateLimited(res)) {
          return { type: 'ratelimit', resetAt: rateLimitResetAt(res) };
        }
        return { type: 'error', retryable: false, definitive: true, error: new Error(`HTTP ${res.status}`) };
      }
      if (!res.ok) {
        return {
          type: 'error',
          retryable: res.status >= 500,
          // 4xx 是服务器明确的回答（答案是"没有"），5xx 才是"我们没拿到答案"。
          definitive: res.status < 500,
          error: new Error(`HTTP ${res.status}`)
        };
      }
      return { type: 'ok', value: mode === 'text' ? await res.text() : await res.json() };
    } catch (error) {
      return { type: 'error', retryable: true, definitive: false, error };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * 一次逻辑请求：缓存 → 预算 → 串行发送 → 重试/403 处理 → 回写缓存。
   * getJson 与 fetchText 都走这一条路径。
   * @param {string} url 请求地址
   * @param {'core'|'search'|'none'} api 额度类别；none 不吃额度（raw / registry / HN）
   * @param {'json'|'text'} mode 响应解析方式
   * @param {number} ttlSeconds 缓存存活秒数；非正数表示不缓存
   * @returns {Promise<*>} 解析后的响应体，或 null（本轮没数据）
   */
  const request = async (url, api, mode, ttlSeconds) => {
    const chargeQuota = api !== 'none';
    const cacheKey = `${api}:${url}`;
    const cacheable = Boolean(cache) && ttlSeconds > 0;

    if (cacheable) {
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        cacheHits++;
        return cached;
      }
    }

    let attempts = 0;
    let waitedForReset = false;
    for (;;) {
      // 预算按"实际发出的请求"逐次扣减：重试也是真发给 GitHub 的请求，同样要吃额度。
      // 检查放在每次 fetchImpl 调用之前——额度不够时连这一次都不发。
      if (chargeQuota && coreCalls + searchCalls >= budget) {
        degraded = true;
        logger?.warn?.(`额度预算已用尽（${coreCalls + searchCalls}/${budget}），跳过请求：${url}`);
        return null;
      }
      if (chargeQuota) {
        if (api === 'search') searchCalls++; else coreCalls++;
      }

      const outcome = await attemptOnce(url, api, mode);

      if (outcome.type === 'ok') {
        if (cacheable) cache.set(cacheKey, outcome.value, ttlSeconds);
        return outcome.value;
      }

      if (outcome.type === 'ratelimit') {
        const resetAt = Number.isFinite(outcome.resetAt) ? outcome.resetAt : Math.floor(now() / 1000);
        const waitMs = resetAt * 1000 - now();
        // reset 很近就等它过去再试一次（这一等不算重试次数）；否则本轮到此为止。
        if (!waitedForReset && waitMs <= RATE_LIMIT_NEAR_MS) {
          waitedForReset = true;
          logger?.warn?.(`额度已用尽，休眠 ${Math.max(0, waitMs)}ms 后重试一次：${url}`);
          await sleep(Math.max(0, waitMs));
          continue;
        }
        degraded = true;
        throw new RateLimitError(
          `GitHub 额度已用尽，需等到 ${new Date(resetAt * 1000).toISOString()}（resetAt=${resetAt}）`,
          resetAt
        );
      }

      attempts++;
      if (!outcome.retryable || attempts >= MAX_ATTEMPTS) {
        // R43：只有"我们没拿到答案"才算降级。明确的 4xx（404 等）是服务器给出的确定回答
        // （答案叫"没有"：这个仓库没发过 npm 包、这个文件不存在），不能置 degraded，
        // 否则一条 404 就会让整张榜对用户显示"数据不完整"。
        if (!outcome.definitive) degraded = true;
        logger?.warn?.(`请求失败，本轮放弃：${url}（${outcome.error?.message ?? '未知错误'}）`);
        return null;
      }
      logger?.warn?.(`请求失败（第 ${attempts} 次），${BACKOFF_MS[attempts - 1]}ms 后重试：${url}`);
      await sleep(BACKOFF_MS[attempts - 1]);
    }
  };

  /** 额度类别的归一化：只认 search / none，其它一律按 core 处理。 */
  const normalizeApi = (api) => (api === 'search' || api === 'none' ? api : 'core');

  return {
    /**
     * 取 JSON 响应。
     * @param {string} url 请求地址
     * @param {{ api?: string, ttlSeconds?: number }} [options] 额度类别与缓存存活秒数
     * @returns {Promise<*>} 解析后的 JSON；本轮没数据时为 null
     */
    getJson(url, { api = 'core', ttlSeconds = 0 } = {}) {
      return enqueue(() => request(url, normalizeApi(api), 'json', ttlSeconds));
    },

    /**
     * 取纯文本响应（HTML、raw 文件等）。
     * 与 getJson 共用同一条串行队列与预算机制，但按 api:'none' 处理：
     * github.com 的 HTML 页与 raw.githubusercontent.com 都不消耗 GitHub API 额度。
     * @param {string} url 请求地址
     * @returns {Promise<string|null>} 响应文本；本轮没数据时为 null
     */
    fetchText(url) {
      return enqueue(() => request(url, 'none', 'text', 0));
    },

    /**
     * 本轮运行统计。coreCalls / searchCalls 数的是实际发出的请求数（重试各计一次）。
     * @returns {{ coreCalls: number, searchCalls: number, cacheHits: number, degraded: boolean }}
     */
    stats() {
      return { coreCalls, searchCalls, cacheHits, degraded };
    }
  };
}

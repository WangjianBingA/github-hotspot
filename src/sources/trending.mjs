// GitHub 好玩榜 —— github.com/trending 页面解析。
// 这一层只做一件事：把 trending 页面的 HTML 变成结构化条目。
//   · 零依赖：不引入任何 HTML 解析库，只用正则与字符串切分（页面结构简单且固定）；
//   · 改版必降级：任何不认识的标记、空输入、被截断的 HTML 一律返回 []，绝不抛异常，
//     因为一次 trending 改版不能把整轮采集带崩；
//   · 只如实转述页面上的数字：页面自己渲染的 "N stars today / this week" 是最可信的免费
//     涨星信号，这里不做任何估计、不做评分（评分属于 score 层）；
//   · 网络 I/O 全部经由注入的 client：fetchTrending 走 client.fetchText（api:'none'，不吃额度）。

const TRENDING_BASE = 'https://github.com/trending';
const DEFAULT_SINCE = 'daily';

// 块级切分：<article ...>...</article>。属性一律用 [^>]* 容忍顺序变化与新增属性。
const ARTICLE_RE = /<article\b([^>]*)>([\s\S]*?)<\/article>/gi;
// 只认 class 里含 Box-row 的块（允许 Box-row 前后挂其它类名，如 Box-row--focus）。
const BOX_ROW_RE = /class\s*=\s*"[^"]*\bBox-row\b[^"]*"/i;

// 仓库标识只信 h2 标题里第一个相对链接的 href：标题文本把 "owner /" 拆进了
// <span class="text-normal">，拼文本不可靠，href 才是唯一的稳定来源。
const HEADING_RE = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i;
const REPO_HREF_RE = /href\s*=\s*"\/([^"?#]+)"/i;
const FULL_NAME_RE = /^([\w.-]+)\/([\w.-]+)$/;

const DESCRIPTION_RE = /<p\b[^>]*>([\s\S]*?)<\/p>/i;
const LANGUAGE_RE = /itemprop\s*=\s*"programmingLanguage"[^>]*>([\s\S]*?)<\/span>/i;
const STARS_RE = /<a\b[^>]*href\s*=\s*"[^"]*\/stargazers"[^>]*>([\s\S]*?)<\/a>/i;
const FORKS_RE = /<a\b[^>]*href\s*=\s*"[^"]*\/forks"[^>]*>([\s\S]*?)<\/a>/i;

// 涨星文案：daily 页是 "14,927 stars today"，weekly 页是 "N stars this week"。
// 两处都要求字面量完整出现——页面少了哪个词，对应字段就是 0（不知道，不猜）。
const STARS_TODAY_RE = /([\d,]+)\s*stars\s+today/i;
const STARS_WEEK_RE = /([\d,]+)\s*stars\s+this\s+week/i;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** 去掉标签，把连续空白压成单个空格。 */
const stripTags = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** 还原描述里最常见的几种实体，避免把 &amp; 这类原文交给下游。 */
const decodeEntities = (text) =>
  String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      // 越界的码点会让 String.fromCodePoint 抛错，进而拖垮整页解析：原样保留最安全。
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });

/** 文本里的第一个数字（容忍千分位逗号）；拿不到数字时给 0。 */
const toNumber = (raw) => {
  const found = String(raw ?? '').match(/\d[\d,]*/);
  return found ? Number(found[0].replace(/,/g, '')) : 0;
};

/**
 * 解析单个 article.Box-row 块。
 * 仓库标识（h2 里的 owner/repo 链接）是唯一必需字段：缺失就跳过该块。
 * @param {string} block 一个完整的 article 块的内层 HTML
 * @returns {object|null} 条目，或 null（必需字段缺失）
 */
const parseBoxRow = (block) => {
  const heading = block.match(HEADING_RE);
  const href = heading ? heading[1].match(REPO_HREF_RE) : null;
  const fullName = href ? href[1] : '';
  if (!FULL_NAME_RE.test(fullName)) return null;

  // 涨星文案可能被标签切开，所以在"去标签后的文本"上匹配，而不是在原始 HTML 上。
  const text = stripTags(block);
  const today = text.match(STARS_TODAY_RE);
  const week = text.match(STARS_WEEK_RE);

  const description = block.match(DESCRIPTION_RE);
  const language = block.match(LANGUAGE_RE);
  const stars = block.match(STARS_RE);
  const forks = block.match(FORKS_RE);

  return {
    fullName,
    url: `https://github.com/${fullName}`,
    description: description ? decodeEntities(stripTags(description[1])) || null : null,
    language: language ? decodeEntities(stripTags(language[1])) || null : null,
    stars: stars ? toNumber(stripTags(stars[1])) : 0,
    forks: forks ? toNumber(stripTags(forks[1])) : 0,
    starsToday: today ? toNumber(today[1]) : 0,
    starsThisWeek: week ? toNumber(week[1]) : 0
  };
};

/**
 * 解析 trending 页面 HTML。
 * 找不到任何 article.Box-row（改版、空输入、被截断的 HTML）时返回空数组；
 * 任何意外异常都被吞掉并退化成空数组——这一层不抛错。
 * @param {string} html 页面 HTML
 * @returns {Array<{fullName: string, url: string, description: string|null, language: string|null,
 *   stars: number, forks: number, starsToday: number, starsThisWeek: number}>} 条目列表
 */
export function parseTrendingHtml(html) {
  try {
    if (typeof html !== 'string' || html === '') return [];
    const items = [];
    for (const match of html.matchAll(ARTICLE_RE)) {
      if (!BOX_ROW_RE.test(match[1])) continue;
      const item = parseBoxRow(match[2]);
      if (item) items.push(item);
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * 抓取并解析 trending 页面（不吃 GitHub API 额度：client.fetchText 是 api:'none'）。
 * 超时、非 200、额度问题都由 client 翻译成 null，这里再统一降级为空数组。
 * @param {{ fetchText: (url: string) => Promise<string|null> }} client 串行网络客户端
 * @param {'daily'|'weekly'|'monthly'} [since] 时间范围，默认 daily
 * @returns {Promise<Array<object>>} 条目列表；本轮没数据时为空数组
 */
export async function fetchTrending(client, since = DEFAULT_SINCE) {
  try {
    if (!client || typeof client.fetchText !== 'function') return [];
    const range = typeof since === 'string' && since !== '' ? since : DEFAULT_SINCE;
    const html = await client.fetchText(`${TRENDING_BASE}?since=${encodeURIComponent(range)}`);
    if (typeof html !== 'string') return [];
    return parseTrendingHtml(html);
  } catch {
    return [];
  }
}

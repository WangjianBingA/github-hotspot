// GitHub 好玩榜 —— release 资产中的 Windows 包识别。
// 这一层只回答两个事实问题，绝不替用户写安装命令、更不做任何评分（评分属于 score 层）：
//   1. 这个仓库最近一次发布里，有没有能让初学者"双击就装上"的 Windows 包？（🟢 一键就能玩徽章靠它）
//   2. 这次发布在不在近 90 天内？（口碑轴的 release90d 分项靠它，见 R40）
//
// R40：release90d 是口碑分里 6 分的一项，本任务之前**没有任何生产端**写它，
// 生产环境恒为 0（口碑轴实际只能拿 24/30），而 fixture 手写了 true 让测试全绿——
// 又一个"测试绿、生产错"的陷阱。所以本模块必须产出**三态**，绝不把"没问到"当成"确认没有"：
//   · { kind: 'release', … }  → 问到了：有发布（是否在 90 天内交给 hasRecentRelease 判）
//   · { kind: 'no-release' }  → 问到了：确认一次都没发过（200 []）
//   · null                    → 没问到（请求失败/额度耗尽/响应结构不对），**未知**
// 为什么必须用**列表**端点 /releases?per_page=1 而不是 /releases/latest：
// 实测 /releases/latest 在"没有发布"时返回 404，而客户端把 404 与网络失败都收敛成 null，
// 于是"确认没有"与"没问到"在下游长得一模一样；列表端点则明确返回 200 [] 与 200 [r]，
// 这才让三态可分辨。
//
// 网络 I/O 全部经由注入的 client，且一律 api:'core'（这是 GitHub API，吃额度）。

const GITHUB_API = 'https://api.github.com';

// 能"双击安装"的后缀，优先级最高。注意必须落在整个文件名的末尾：
// app-setup.exe.sha256、app.exe.sig 这类校验文件/签名不是安装包，故意不认。
const INSTALLER_EXT_RE = /\.(exe|msi)$/i;
// 压缩包类：名字里出现 Windows 平台标记才算 Windows 包。
const WINDOWS_TOKEN_RE = /(windows|win64|win32)/i;
// 显式排除的平台标记：宁可不给徽章，也不误报"一键就能玩"。
const OTHER_PLATFORM_RE = /(darwin|macos|linux|android|ios)/i;

/**
 * 从一条 release 的 assets 里挑出最适合初学者下载的 Windows 资产。
 * 优先级严格按简报：`.exe` > `.msi` > 名字含 `windows|win64|win32` 的压缩包。
 * 名字里带 `darwin|macos|linux|android|ios` 的一律先排除（哪怕同时带 win 字样：
 * 交叉编译包、macOS 上的 win64 工具链都会同时出现两种标记，如实说不确定比误报好）。
 * 拿不到合适的资产时返回 null —— 调用方据此判"没有 Windows 包"，绝不编一个链接出来。
 * @param {Array<{name?: string, browser_download_url?: string, size?: number}>|null} assets GitHub 的 assets 数组
 * @returns {{ name: string, url: string, size: number }|null} 选中的资产；没有则 null
 */
export function pickWindowsAsset(assets) {
  try {
    if (!Array.isArray(assets)) return null;
    let best = null;
    let bestRank = Infinity;

    for (const asset of assets) {
      const name = typeof asset?.name === 'string' ? asset.name : '';
      if (name === '' || OTHER_PLATFORM_RE.test(name)) continue;

      let rank;
      if (INSTALLER_EXT_RE.test(name)) {
        rank = /\.exe$/i.test(name) ? 0 : 1;
      } else if (WINDOWS_TOKEN_RE.test(name)) {
        rank = 2;
      } else {
        continue; // 既不是安装包，名字里也没有 Windows 标记：与 Windows 无关。
      }
      if (rank >= bestRank) continue; // 同级取先出现的那个（GitHub 自己的顺序）

      bestRank = rank;
      best = {
        name,
        url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
        size: Number.isFinite(asset.size) ? asset.size : 0
      };
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * 取仓库最近一次发布（列表端点 per_page=1，一条请求）。
 * 返回三态之一，语义见文件头注释：
 *   · 200 [r]       → { kind: 'release', tagName, publishedAt, assets, windowsAsset }
 *   · 200 []        → { kind: 'no-release' }
 *   · null / 非数组  → null（未知：没问到，不是"没有"）
 * 草稿（draft）不算发布：草稿只有作者自己看得见，用户下载不到，所以**只发过草稿**要判成
 * `{ kind: 'no-release' }`——"确认没有面向用户的发布"；草稿混在正式发布里时直接跳过它。
 * 预发布（prerelease）算发布：它已公开、用户确实能下载，只有"一次都没发过"才是没有。
 * 若第一页只有草稿、第二页才有正式发布，这里仍会返回 no-release：per_page=1 只看最近一条，
 * 多翻一页不值得（GitHub 的列表按发布时间倒序，最近的草稿跟在正式发布后面时本来就轮不到它）。
 * @param {{ getJson: (url: string, options?: object) => Promise<*> }} client 注入的网络客户端
 * @param {string} ownerRepo 形如 'microsoft/markitdown'
 * @returns {Promise<{kind: 'release', tagName: string|null, publishedAt: string|null,
 *   assets: object[], windowsAsset: object|null}|{kind: 'no-release'}|null>}
 */
export async function fetchLatestRelease(client, ownerRepo) {
  try {
    if (!client || typeof client.getJson !== 'function') return null;
    const repo = typeof ownerRepo === 'string' ? ownerRepo.trim() : '';
    if (repo === '') return null;

    const body = await client.getJson(`${GITHUB_API}/repos/${repo}/releases?per_page=1`, { api: 'core' });
    // 非数组 = 我们没拿到能读的答案（对象形式的错误体、null、字符串）：未知，不是"没有"。
    if (!Array.isArray(body)) return null;
    if (body.length === 0) return { kind: 'no-release' };

    const latest = body.find((item) => item && typeof item === 'object' && item.draft !== true);
    if (!latest) return { kind: 'no-release' }; // 只有草稿 = 没有面向用户的发布

    const assets = Array.isArray(latest.assets) ? latest.assets : [];
    return {
      kind: 'release',
      tagName: typeof latest.tag_name === 'string' ? latest.tag_name : null,
      // 结构不对时给 null，让 hasRecentRelease 判成"未知"，绝不猜一个时间出来。
      publishedAt: typeof latest.published_at === 'string' ? latest.published_at : null,
      assets,
      windowsAsset: pickWindowsAsset(assets)
    };
  } catch {
    return null;
  }
}

/**
 * 这次发布在不在 `days` 天内（默认 90）。三态、互不混淆：
 *   true  → 确认在窗口内
 *   false → 确认不在窗口内（含 kind:'no-release' 的"确认没有发布"）
 *   null  → 未知：release 为 null（没问到），或 publishedAt 读不出来（有发布但不知道什么时候）
 * null 绝不能退化成 false：那会把"没问到"渲染成"近 90 天有发版：0 分"，
 * 是一句我们没有证据的话（与 score.mjs 里 growth 的中性口径一致）。
 * @param {{kind?: string, publishedAt?: string|null}|null} release fetchLatestRelease 的结果
 * @param {Date} now 显式传入"现在"，便于测试固定时间
 * @param {number} [days] 窗口天数，默认 90
 * @returns {boolean|null}
 */
export function hasRecentRelease(release, now, days = 90) {
  if (!release || typeof release !== 'object') return null;      // 没问到
  if (release.kind === 'no-release') return false;               // 确认没有发布
  if (release.kind !== 'release') return null;                   // 不认识的结构：未知

  const published = Date.parse(release.publishedAt);
  const nowTs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(published) || !Number.isFinite(nowTs)) return null; // 有发布但时间未知
  return nowTs - published <= days * 24 * 60 * 60 * 1000;
}

// GitHub 好玩榜 —— README 中文证据采集与判定。
//
// 这一层只回答两个事实问题，绝不替调用方打分（分值只从 config/weights.mjs 取，算术在 score.mjs）：
//   1. 这个仓库有没有"本地化文档"？—— 评分轴要的（scoreRunnable 的中文文档分）。
//   2. 这个仓库有没有"中文说明"？—— 徽章「🈶 有中文说明」要的（给中文初学者看的承诺）。
//
// R59：这两个问题的答案**故意不同**，本模块因此产出两个字段，别把它们混用：
//   · hasCjk  —— **评分的输入**。只要"有本地化文档"就为 true：CJK 占比 ≥ CHINESE_RATIO_THRESHOLD（0.03），
//     或探测到任意语言的本地化文件（README.ja.md、docs/setup.ko.md 都算，见 R16）。
//     spec §6.1 的加分规则本来就是奖励"有本地化文档"（任意本地化 +3、CJK 占比达标 +4），不限于中文。
//   · hasChinese —— **徽章的声明**。必须真的是中文，否则「有中文说明」这句就是对用户的假话：
//       ① 存在**中文文件名**的本地化文件（README.zh-CN.md / README_CN.md / docs/*.zh* 一类）；
//       ② 或 README 正文由汉字主导：汉字占比达标 **且** 假名占比 < KANA_RATIO_BOUND（0.01）。
//     日语正文混用汉字与假名，假名占比通常远高于 1%，所以只会命中 ② 的中文不会被误判成日语；
//     反过来纯日语（假名占比高）拿不到中文徽章，但 hasCjk 仍为 true —— 这正是两者必须分开的原因。
//     实测校准：sst/opencode 正文 CJK 占比 0.26%（低于阈值）但仓库有 README.ja.md
//     → hasCjk: true、hasChinese: false，localizedFiles 如实记下那个 .ja 文件。
//
// ratio / kanaRatio 是实测比率，写进返回值供复核：分母一律是**全文的 UTF-16 码元长度**（与 text.length 同口径），
// 不是"码点数"、也不做任何清洗（不剥 Markdown 标记、不跳代码块）——清洗会引入主观规则并可能把证据洗掉。
// ratio 的分子是**完整 CJK 字符类**（汉字 U+4E00-9FFF/U+3400-4DBF + 假名 U+3040-30FF + 谚文 U+AC00-D7AF），
// 判定 hasChinese 时另外只数汉字（内部 hanRatio，同一分母）：
// 于是"纯韩文正文"会因 ratio 达标而拿到 hasCjk（确有本地化文档），却拿不到中文徽章——两个结论再次分开。
// 一律按**全文**测量而不是"前缀"：中文可能只写在 README 末尾，截断前缀会把真证据丢掉。
// 正文长度上限 50KB 级别：只在全文上跑两次正则、O(n)、不递归，实测不会炸（有用例钉住 >50KB 的正文）。
//
// 网络 I/O 只经由注入的 client，且只用 fetchText（raw.githubusercontent.com，api:'none'，不吃 GitHub 额度）。
// 任何缺失/失败都返回 null 或空对象，绝不抛错、绝不编造文本。
//
// 本模块与 health.mjs 的分工：这里是"证据"（以及给评分用的输入映射），health.mjs 是口碑输入的归属地；
// 两者都只做映射，不做任何算术。

import { CHINESE_RATIO_THRESHOLD } from '../config/weights.mjs';

// CJK 字符集合（含扩展 A、平假名/片假名、谚文）。定义字符类时只写一次，供各计数器共用。
const CJK_CLASS = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\u3040-\\u30ff\\uac00-\\ud7af';
// 汉字：CJK 统一表意文字（含扩展 A）。谚文/假名/片假名都不计入 —— 中文徽章只认汉字。
const HAN_CLASS = '\\u4e00-\\u9fff\\u3400-\\u4dbf';
// 假名：平假名 + 片假名（U+3040-U+30FF）。日语正文里假名占比很高，中文里几乎为 0。
const KANA_CLASS = '\\u3040-\\u30ff';

// 统计命中字符类的码元数。matchAll 的 g 标志只作用在本次调用上（每次新建正则），没有 lastIndex 状态残留。
const countMatches = (text, charClass) =>
  [...text.matchAll(new RegExp(`[${charClass}]`, 'g'))].length;

// 本地化文件名族（R16）。**故意不限于中文**：日语/韩语的本地化文件同样是"有本地化文档"的证据（喂 hasCjk）。
// 两种惯例都认：
//   ① README 本身带语言代号：readme.zh-CN.md、README_CN.md、README.zh.md、README.ja.md
//      （语言代号可带多个子标签：zh-Hans-CN、pt-BR…）；
//   ② docs/ 一类子目录里的文档带语言代号：docs/guide.zh-TW.md、docs/*.zh*（spec §6.1 明写的族）。
// **裸 README.md 不算本地化文件**：它就是主文档本身，"又有一份本地化文档"才值得加分，
// 否则每个仓库都会白拿那 3 分（占比那 4 分才是从主文档里量出来的）。
const README_LOCALIZED_RE = /(^|\/)readme[._-][a-z]{2}([._-][a-z0-9]+)*\.(md|markdown)$/i;
const DOC_LOCALIZED_RE = /(^|\/)docs\/[^/]+[._-][a-z]{2}([._-][a-z0-9]+)*\.(md|markdown)$/i;
// 中文文件名 / 中文文档：语言代号以 zh 或 cn 开头，其余规则同上。
const README_CHINESE_RE = /(^|\/)readme[._-](zh|cn)([._-][a-z0-9]+)*\.(md|markdown)$/i;
const DOC_CHINESE_RE = /(^|\/)docs\/[^/]+[._-](zh|cn)([._-][a-z0-9]+)*\.(md|markdown)$/i;
// 子目录形式只按"文件名"判中文：docs/zh/README.md 这种"目录名是中文、文件名没有语言代号"的写法
// 证明不了这份 README 是中文的，宁可不给徽章，也不给一句没有证据的中文承诺。
const BARE_README_RE = /^readme\.(md|markdown)$/i;

/**
 * 判定"假名占比超过多少就不算中文"。取 1%：
 * 纯中文正文里的假名只可能是零星外来语拼写（如"ソフト"），远低于 1%；
 * 而日语正文的假名占比实测在 30% 以上（本模块的日语用例是 44%）。
 * 1% 这条线离两侧各有两个数量级的余量，不会踩到边界上。
 *
 * 为什么它留在本模块而不放进 config/weights.mjs：weights.mjs 是**分值与非此即彼的口径阈值**的唯一出处
 * （分值、榜单条数、打分判定线）。这是一个"这条检测启发式多严"的调参旋钮，不是分值、也不是 spec 定的口径，
 * 换掉它不会改变任何一分怎么算 —— 所以它跟字符类一起留在检测层，改它只需看这一个文件。
 */
const KANA_RATIO_BOUND = 0.01;

// fetchChineseEvidence 只探测这几个固定候选（≤4 个本地化文件 + README.md = 最多 5 次请求，
// 全部走 fetchText，api:'none' 不吃 GitHub 额度）。README.zh.md 与 README.ja.md 分别对应
// "中文文件名"与"非中文的本地化文件"，用来把 hasChinese 与 hasCjk 分开。
const LOCALIZED_CANDIDATES = ['README.zh-CN.md', 'README_CN.md', 'README.zh.md', 'README.ja.md'];

// 取文件名前面的目录前缀（没有斜杠则为空串）。
const dirPrefix = (name) => {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? '' : name.slice(0, slash + 1);
};

/** 是不是"本地化文档"：带语言代号的 README，或子目录 docs/ 下带语言代号的文档。 */
const isLocalizedFile = (name) => README_LOCALIZED_RE.test(name) || DOC_LOCALIZED_RE.test(name);

/** 是不是**中文**本地化文档：语言代号以 zh/cn 开头（含 docs/guide.zh-TW.md 这类子目录写法）。 */
const isChineseFile = (name) => {
  const prefix = dirPrefix(name);
  const base = prefix === '' ? name : name.slice(prefix.length);
  // 子目录里的裸 README.md 不算中文证据（目录名是中文也不行），中文文档必须由文件名里的语言代号证明。
  if (prefix !== '' && BARE_README_RE.test(base)) return false;
  // R63：两个正则各自匹配它真正要匹配的对象 —— README 分支匹配**文件名**，docs 分支必须匹配**完整路径**。
  // DOC_CHINESE_RE 里的 `docs/` 是字面量，喂给它剥掉前缀的 base 永远匹配不上（那是一段死代码）。
  return README_CHINESE_RE.test(base) || DOC_CHINESE_RE.test(name);
};

/**
 * 从 readmeText / extraFiles 里判定中文与本地化事实。纯函数，不读文件、不发请求。
 * @param {{ readmeText?: unknown, extraFiles?: unknown }} [evidence] 正文文本与候选文件内容映射；
 *   两者都可能缺失、为 null、类型不对
 * @returns {{ ratio: number, kanaRatio: number, hasCjk: boolean, hasChinese: boolean, localizedFiles: string[] }}
 *   ratio / kanaRatio：实测比率（分母为全文码元长度，空文本为 0，绝不返回 NaN）；
 *   localizedFiles：**已排序**的本地化文件名单（含非中文的本地化文件，供界面据实描述徽章）
 */
export function detectChinese(evidence) {
  const readmeText = typeof evidence?.readmeText === 'string' ? evidence.readmeText : '';
  const extraFiles = evidence?.extraFiles;

  const length = readmeText.length;
  const cjkCount = length === 0 ? 0 : countMatches(readmeText, CJK_CLASS);
  const hanCount = length === 0 ? 0 : countMatches(readmeText, HAN_CLASS);
  const kanaCount = length === 0 ? 0 : countMatches(readmeText, KANA_CLASS);

  // ratio 就是简报定义的"CJK 占比"：分子取完整 CJK 字符类（汉字 + 假名 + 谚文），阈值直接用
  // CHINESE_RATIO_THRESHOLD；hasChinese 另外用只数汉字的 hanRatio 判定，见下。
  const ratio = length === 0 ? 0 : cjkCount / length;
  const hanRatio = length === 0 ? 0 : hanCount / length;
  const kanaRatio = length === 0 ? 0 : kanaCount / length;

  // 只有"确实拿到了正文"的文件才算证据：键存在但值为 null/空串说明没探测到内容，那不是文档。
  const localizedFiles = [];
  if (extraFiles && typeof extraFiles === 'object' && !Array.isArray(extraFiles)) {
    for (const name of Object.keys(extraFiles)) {
      const content = extraFiles[name];
      if (typeof content !== 'string' || content === '') continue;
      if (isLocalizedFile(name)) localizedFiles.push(name);
    }
  }
  // 排序而不是沿用它给的键顺序：Object.keys 的顺序会随调用方构造方式变化，排序后结果稳定、可断言。
  localizedFiles.sort();

  const hasChineseFile = localizedFiles.some((name) => isChineseFile(name));
  // hasCjk（评分）：有中文文件名的本地化文件、有任意语言的本地化文件、或 CJK 占比（ratio）达标。
  const hasCjk = hasChineseFile || localizedFiles.length > 0 || ratio >= CHINESE_RATIO_THRESHOLD;
  // hasChinese（徽章）：中文文件名，或"汉字占比达标且不是假名主导"的正文。
  // 这里只数汉字（hanRatio），不用 ratio：纯谚文/纯假名的正文不该拿到中文徽章。
  const hasChinese = hasChineseFile || (hanRatio >= CHINESE_RATIO_THRESHOLD && kanaRatio < KANA_RATIO_BOUND);

  return { ratio, kanaRatio, hasCjk, hasChinese, localizedFiles };
}

/**
 * 采集中文证据：取 README.md 与最多 4 个候选本地化文件（共 ≤5 次 fetchText，api:'none' 不吃额度）。
 * 分支名**只用传入的 defaultBranch**，绝不猜 main/master —— 猜错会静默丢掉真证据
 * （实测 microsoft/markitdown 的 pyproject.toml 在 main 与 master 上都是 404）；
 * defaultBranch 缺失/为空时一次请求都不发，返回空证据。
 * 任何一项失败只记 null，不抛错、不编造内容；键仍然存在，调用方据此可知"探测过但没有"。
 * @param {{ fetchText?: Function }} client 注入的网络客户端（必须有 fetchText）
 * @param {string} ownerRepo 形如 owner/repo
 * @param {string} defaultBranch 仓库默认分支（来自 repo.defaultBranch）
 * @returns {Promise<{ readmeText: string|null, extraFiles: Record<string, string|null> }>}
 */
export async function fetchChineseEvidence(client, ownerRepo, defaultBranch) {
  const empty = { readmeText: null, extraFiles: {} };
  if (typeof ownerRepo !== 'string' || ownerRepo.trim() === '') return empty;
  if (typeof defaultBranch !== 'string' || defaultBranch.trim() === '') return empty;
  if (typeof client?.fetchText !== 'function') return empty;

  const base = `https://raw.githubusercontent.com/${ownerRepo.trim()}/${defaultBranch.trim()}`;
  // 读文本：非字符串（404 得到 null、错误体对象、数字）一律当"没拿到"，绝不把响应对象当正文。
  const readText = async (url) => {
    try {
      const text = await client.fetchText(url);
      return typeof text === 'string' ? text : null;
    } catch {
      return null;
    }
  };

  const readmeText = await readText(`${base}/README.md`);

  const extraFiles = {};
  for (const name of LOCALIZED_CANDIDATES) {
    extraFiles[name] = await readText(`${base}/${name}`);
  }

  return { readmeText, extraFiles };
}

/**
 * 把仓库对象映射成 scoreReputation 认的输入形状（见该函数 JSDoc 里逐项列出的字段）。
 * 这里**只搬字段、不做算术、不下结论**：评分口径全部留在 score.mjs。
 * 三态字段照实透传：hasRelease90d 可能是 true/false/null，null 表示"没问到"（score.mjs 给中性半分），
 * 绝不能在这里把 null 写成 false —— 那就成了"确认没有发版"这句没有证据的断言。
 * license 统一成 SPDX 字符串（GitHub API 原样给的是 { spdx_id } 对象）；读不出来时为 null。
 * @param {object} repo 候选项目（由调用方给出；读不到的字段保持 undefined，交给 score.mjs 兜底）
 * @param {{ growing?: boolean|null }} [options] 需要历史数据才能算的项，透传给 scoreReputation
 * @returns {{ stars: number|undefined, forks: number|undefined, pushedAt: string|undefined,
 *   license: string|null, hasRelease90d: boolean|null, growing: boolean|null }}
 */
export function buildReputationInput(repo, { growing } = {}) {
  const license = typeof repo?.license === 'string' ? repo.license : repo?.license?.spdx_id ?? null;
  return {
    stars: repo?.stars,
    forks: repo?.forks,
    pushedAt: repo?.pushedAt,
    license,
    // 只要不是明确的 true/false 就记为 null（"没问到"），与 score.mjs 的三态口径一致。
    hasRelease90d: repo?.hasRelease90d === true || repo?.hasRelease90d === false ? repo.hasRelease90d : null,
    growing: growing ?? null,
  };
}

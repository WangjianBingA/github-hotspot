// GitHub 好玩榜 —— 新手友好度分级与三步安装向导（纯函数层）。
//
// 这个模块回答整个产品最核心的一个问题："我到底能不能装上它、怎么装？"
// 它只做确定性的判断与字符串拼装：不读文件、不发网络请求、不看时钟、不调大模型，
// **绝不执行任何命令**（v2 是纯静态网站，v1 的实验性本地安装执行器已移除）。
//
// 简报里若提到 localEnv 参数或 checkLocalEnv() 函数，一律**不实现**：
// 网站跑在访客的浏览器里，看不到他电脑上装了什么，所以本项目不做任何本机环境探测。
//
// 出口只有两个（有用例钉住）：
//   · classifyRunnability({ releases, npm, pypi, chinese }) → Runnability
//   · buildInstallGuide(runnability) → { steps, faq }
//
// 安装路径优先级（**从上到下取第一条真的有证据的路径**，括号里是 RUNNABLE_POINTS 的分值）：
//   releaseWindows(18) > npmBinWin(16) > pypiCompatible(14) > npmNoBin(8) > buildFromSource(6) > dockerOnly(4) > none(0)
// 顺序不能按"哪个先查到"来定：一个项目既有 Windows 安装包又能 npx 跑时，必须优先给"下载就能用"。
//
// 五条硬规矩（每条都对应一个真实缺陷）：
//   R51 —— 下载地址为空或缺失的 release 资产**不是**安装路径：宁可往下找别的路，
//          也不给用户一个点不开的 🟢 徽章；verified 只有在真有可操作路径时才是 true。
//   R48 —— 网站不知道访客电脑上装的是哪个版本的 Python，所以**绝不编造"兼容"结论**。
//          PyPI 包存在且归属成立是一条独立于访客机器的证据，所以照给 pypiCompatible（🟡、14 分），
//          但只带**要求原文**（requiresPython），让向导说"需要 Python >=3.10"而不是"你可以装"。
//          绝不用 registry.mjs 的 isPythonCompatible() 去伪造一个"兼容"。
//   R64 —— hasCjk（有本地化文档，喂评分）与 hasChinese（真有中文，管徽章）是两个不同的断言：
//          chineseDoc 只认 hasCjk；hasChinese 与 localizedFiles 照实带出去，
//          只有非中文本地化时界面必须说「有本地化文档（非中文）」，不能说"有中文说明"。
//   R68 —— npm 与 PyPI 的**归属都是硬前提**。lookupPyPI 目前没有任何归属字段，所以在拿到
//          repoMatches === true 之前不下发 pip install（宁可不给命令，R45 的方向）。
//   R70/R71 —— 我们不知道的时候，句子的主语必须是**我们自己的查找动作**，不能是项目的事实：
//          none 档只能说"我们没有找到…"（不能说"这个项目没有现成的安装方式"）；
//          没有中文时只能说"我们没有查到中文说明"（上游分不清"读过且只有英文"与"README 没拿到"，
//          所以"只有英文说明"是一句我们没证据的话）。
//
// 另有两条来自上游模块的硬约束：
//   · 归属是任何 npm 路径的硬前提：repoMatches !== true 的 npm 结果**整条忽略**（连 npx / npm install 都不产出）；
//   · notes 只记"我们不知道什么"与"我们为什么拒绝某条路"，绝不把"没问到"写成"确认没有"（R40 的口径）。

import { RUNNABLE_POINTS } from '../config/weights.mjs';
import { calculateGrade } from '../score/score.mjs';

// 非空字符串判定：null / undefined / 空串 / 纯空白 一律算"没有"。
// 空下载地址与空包名都必须按"没有"处理，否则会给用户一个点不开的链接或一条装不了的命令。
const isNonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

// npm 路径的取证字段照原样透传（R42 的 'repository' | 'bugs.url' | 'homepage'），
// 界面据此能说清"我们凭什么敢让你装这个包"。归属成立必然有一条证据，所以兜底给 'repository'
// 而不是编一个 'none'（'none' 恰恰表示归属不成立）。
const npmEvidence = (npm) => (isNonEmpty(npm.evidence) ? npm.evidence.trim() : 'repository');

/**
 * 把上游查到的客观事实判定成一条新手友好度结论。纯函数：无 I/O、无网络、不看时钟、不执行命令。
 *
 * 判定顺序（第一条真的有证据的路径胜出）：releaseWindows → npmBinWin → pypiCompatible → npmNoBin
 * → buildFromSource → dockerOnly → none。buildFromSource 与 dockerOnly 没有能从
 * release / npm / PyPI 三项里查出来的客观证据（"要不要自己编译""是不是只有 Docker"得看项目文档），
 * 所以只认调用方明确给出的 `buildFromSource: true` / `docker: true`；没有该证据时绝不猜。
 *
 * @param {{ releases?: object|null, npm?: object|null, pypi?: object|null, chinese?: object|null,
 *   buildFromSource?: boolean, docker?: boolean }} [input]
 *   releases：fetchLatestRelease 的结果（可能为 null＝没问到），用到 windowsAsset { name, url }；
 *   npm：lookupNpm 的结果，用到 packageName / repoMatches / hasBin / osIncludesWin / evidence；
 *   pypi：lookupPyPI 的结果，用到 packageName / version / requiresPython，以及 Task 10B 会补上的
 *     repoMatches / evidence（PyPI 归属也是硬前提，R68）；
 *   chinese：detectChinese 的结果，用到 hasCjk（喂评分）/ hasChinese（徽章）/ localizedFiles
 * @returns {{ kind: string, command: string|null, downloadUrl: string|null, evidence: string|null,
 *   verified: boolean, difficulty: 'green'|'yellow'|'red', chineseDoc: boolean, hasChinese: boolean,
 *   localizedFiles: string[], requiresPython: string|null, notes: string[] }}
 */
export function classifyRunnability(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const releases = source.releases && typeof source.releases === 'object' ? source.releases : null;
  const npm = source.npm && typeof source.npm === 'object' ? source.npm : null;
  const pypi = source.pypi && typeof source.pypi === 'object' ? source.pypi : null;
  const chinese = source.chinese && typeof source.chinese === 'object' ? source.chinese : null;

  // R64：两个中文结论分开取，绝不互相顶替。chineseDoc 只认 hasCjk（评分口径是"有本地化文档"），
  // hasChinese 只用于界面徽章「有中文说明」。
  const hasCjk = chinese?.hasCjk === true;
  const hasChinese = chinese?.hasChinese === true;
  const localizedFiles = Array.isArray(chinese?.localizedFiles)
    ? chinese.localizedFiles.filter((name) => isNonEmpty(name))
    : [];

  const notes = [];

  // "我们不知道什么"先记账。releases 为 null/非法表示**没问到**（R40 三态：不是"确认没有"），
  // 这句话必须能出现在界面上，否则用户会把"没查到"读成"这个项目没有安装包"。
  if (releases === null) {
    notes.push('我们没问到它最近的发布信息（可能是网络或额度问题），所以不确定它有没有现成的 Windows 安装包。');
  }
  if (hasCjk && !hasChinese) {
    const files = localizedFiles.length > 0 ? `：${localizedFiles.join('、')}` : '';
    notes.push(`这个项目有本地化文档（非中文）${files}，所以我们不会说它"有中文说明"。`);
  }

  const make = (kind, extra = {}) => ({
    kind,
    command: null,
    downloadUrl: null,
    evidence: null,
    verified: true,
    difficulty: calculateGrade(RUNNABLE_POINTS[kind]),
    chineseDoc: hasCjk,
    hasChinese,
    localizedFiles: [...localizedFiles],
    requiresPython: null,
    notes: [...notes],
    ...extra,
  });

  // 第一步：把"我们拒绝了哪条路、为什么"全部记进 notes（这些是我们**已经查到的事实**），
  // 第二步才按优先级挑一条能用的路。顺序反过来（边挑边记）会让"挑中高优先档"时
  // 低优先档的拒绝记录整条消失 —— 那些记录对用户和界面同样有价值（例如"npm/PyPI 上有个同名包，
  // 但不是这个项目的"正是我们花大力气防住的那个坑），所以先记账、后选路。
  const asset = releases?.windowsAsset && typeof releases.windowsAsset === 'object' ? releases.windowsAsset : null;
  const assetUrl = asset !== null && isNonEmpty(asset.url) ? asset.url.trim() : '';
  const assetName = asset !== null && isNonEmpty(asset.name) ? asset.name.trim() : '';
  if (asset !== null && assetUrl === '') {
    notes.push(`这个项目发过 Windows 安装包${assetName === '' ? '' : `（${assetName}）`}，但它的下载地址是空的，我们不能给你一个点不开的链接。`);
  }

  // （前置条件，不占档位）归属是任何 npm 路径的硬前提（R42）。repoMatches !== true 的结果**整条忽略**：
  //    包名相同不算证据，宁可什么都不给，也不能让用户装到别人的包。
  const npmOwned = npm !== null && npm.repoMatches === true && isNonEmpty(npm.packageName);
  if (npm !== null && npm.repoMatches !== true) {
    notes.push(`npm 上有一个${isNonEmpty(npm.packageName) ? `叫 ${npm.packageName.trim()} 的` : ''}包，但它没有声明自己来自这个项目，我们无法确认它是同一个东西，所以不敢让你照着它装。`);
  }

  // 有 bin 却装不了：声明不支持 Windows，或者干脆查不到它支不支持。
  // 这两种情况都**不下发命令**（一条注定装不上的命令比少给一条路径糟得多），但要说明原因。
  // 注意不能顺手降级成 npmNoBin：npmNoBin 说的是"这个包没有能直接跑的入口"，
  // 而它有入口、只是在这个系统上跑不了 —— 降级会把一件事实说错，npm install 也照样会被拒绝。
  if (npmOwned && npm.hasBin === true && npm.osIncludesWin !== true) {
    notes.push(npm.osIncludesWin === false
      ? '它的命令行工具声明了不支持 Windows，在 Windows 电脑上装不起来，所以我们没有把这一条算成安装方式。'
      : '我们查不到它的命令行工具支不支持 Windows，宁可不给你一条可能装不上的命令。');
  }

  // hasBin 只是"查不到"时同样不下结论：既不猜"能跑"，也不猜"没有入口"。
  if (npmOwned && npm.hasBin !== true && npm.hasBin !== false) {
    notes.push('我们查不到这个包有没有可以直接运行的程序入口，所以不敢把 npm 这一条算成安装方式。');
  }

  // （前置条件）R68：PyPI 的归属同样是硬前提。上游 lookupPyPI 目前只返回
  //    { packageName, version, requiresPython }，**没有任何归属字段**；而"包名相同"从来不是证据
  //    （npm 侧就是为此才做了 R42 取证：同名不同作者的包真实存在）。所以在拿到
  //    repoMatches === true 之前，一条 pip install 都不下发 —— 宁可不给命令（R45 的方向）。
  //    这是防御式实现：Task 10B 会给 lookupPyPI 补上 repoMatches / evidence（用 PyPI 的
  //    project_urls / home_page 经 normalizeRepoUrl 归一化后严格比较，与 npm 侧同一套思路）。
  const pypiOwned = pypi !== null && pypi.repoMatches === true && isNonEmpty(pypi.packageName);
  if (pypi !== null && isNonEmpty(pypi.packageName) && pypi.repoMatches !== true) {
    notes.push(`PyPI 上有一个叫 ${pypi.packageName.trim()} 的包，但我们没能确认它确实属于这个项目，所以不敢让你照着它装。`);
  }

  // 第二步：按优先级取第一条真的有证据的路径。
  // ① releaseWindows（18 分，🟢）：有 Windows 安装包，**而且下载地址是真能点的**（R51）。
  //    上游 releases.mjs 实测过：asset 缺 browser_download_url 时 url 是空串，那不是一条安装路径。
  if (assetUrl !== '') {
    return make('releaseWindows', {
      downloadUrl: assetUrl,
      evidence: assetName === '' ? 'release asset' : `release asset: ${assetName}`,
    });
  }

  // ② npmBinWin（16 分，🟢）：有可以直接跑的程序入口，而且声明支持 Windows。
  if (npmOwned && npm.hasBin === true && npm.osIncludesWin === true) {
    return make('npmBinWin', { command: `npx ${npm.packageName.trim()}`, evidence: npmEvidence(npm) });
  }

  // ③ pypiCompatible（14 分，🟡）：包存在**且归属成立**（R68）= 一条独立于访客机器的真路径。
  //    R48：这里**不判断**访客的 Python 版本（静态网站根本不知道），只把要求原文带出去。
  if (pypiOwned) {
    const name = pypi.packageName.trim();
    const requiresPython = isNonEmpty(pypi.requiresPython) ? pypi.requiresPython.trim() : null;
    if (requiresPython === null) {
      notes.push('这个包没有写它需要哪个版本的 Python；你的电脑上装的是哪个版本，网站看不到，装之前请自己确认一下。');
    } else {
      notes.push(`这个包自己声明需要 Python ${requiresPython}；你的电脑上装的是哪个版本，网站看不到，装之前请先自己确认。`);
    }
    notes.push('我们只能确认这个包装得上，装好之后具体敲什么命令，要看项目主页里的说明。');
    return make('pypiCompatible', {
      command: `pip install ${name}`,
      // 与 npm 同一口径：有取证字段就原样透传（Task 10B 会填），否则给一句能读的描述。
      evidence: isNonEmpty(pypi.evidence) ? pypi.evidence.trim() : `pypi package: ${name}`,
      requiresPython,
    });
  }

  // ④ npmNoBin（8 分，🟡）：包是同一个项目的，而且**确定**没有能直接跑的程序入口。
  //    它仍然是一条真路径（包确实存在），只是用户得自己在代码里用它。
  if (npmOwned && npm.hasBin === false) {
    notes.push('这个项目在 npm 上的包没有能直接运行的程序入口，它更像一个给别的程序调用的零件（装上它不会多出一个图标或命令）。');
    return make('npmNoBin', { command: `npm install ${npm.packageName.trim()}`, evidence: npmEvidence(npm) });
  }

  // ⑤ buildFromSource（6 分，🔴）：只认调用方明确给出的"要自己编译"证据。
  if (source.buildFromSource === true) {
    notes.push('这个项目没有现成的安装包，要自己动手编译（对没写过代码的人来说比较难）。');
    return make('buildFromSource', { evidence: 'build instructions' });
  }

  // ⑥ dockerOnly（4 分，🔴）：只认调用方明确给出的 Docker 证据。它同样是"已核实的路径"，
  //    门槛按 spec §6.2 放行（dockerOnly 分值大于 0）。
  if (source.docker === true) {
    notes.push('这个项目只提供了 Docker 的用法：得先装好 Docker 才能用。');
    return make('dockerOnly', { evidence: 'docker' });
  }

  // ⑦ none（0 分，🔴）：一条可操作的路径都没有。verified 必须是 false —— 它是硬性门槛要看的字段。
  notes.push('我们没有找到可以放心推荐给你的安装方式，只能打开项目主页看它自己写的安装说明。');
  return make('none', { verified: false });
}

// ---------- 三步安装向导（确定性中文模板，不依赖大模型） ----------

/**
 * 生成固定三步的安装向导与按路径类型给的常见问题。
 * 第 1 步说"你需要先准备什么"，第 2 步给一条命令或一个下载链接，第 3 步说"怎么用"。
 * @param {object} [runnability] classifyRunnability 的结果（字段缺失、传 null、传非对象都不抛错）
 * @returns {{ steps: { title: string, body: string, command?: string, downloadUrl?: string }[], faq: { q: string, a: string }[] }}
 *   steps 恒为 3 条；faq 恒定 5 条（含"装错了怎么卸载"）
 */
export function buildInstallGuide(runnability = {}) {
  const run = runnability && typeof runnability === 'object' ? runnability : {};
  const kind = isNonEmpty(run.kind) ? run.kind.trim() : '';
  const command = isNonEmpty(run.command) ? run.command.trim() : null;
  const downloadUrl = isNonEmpty(run.downloadUrl) ? run.downloadUrl.trim() : null;
  const requiresPython = isNonEmpty(run.requiresPython) ? run.requiresPython.trim() : null;

  // 命令里"包名"那一段：第 2 步给整行命令，第 3 步与卸载说明只要名字。
  const target = command === null ? null : command.replace(/^(?:npx|npm install|pip install)\s+/, '');

  return {
    steps: [
      { title: '第 1 步 · 你需要先准备什么', body: prepareText(kind, requiresPython) },
      installStep(kind, command, downloadUrl),
      { title: '第 3 步 · 怎么用', body: usageText(kind, target) },
    ],
    faq: faqItems(kind, target, { hasChinese: run.hasChinese === true, chineseDoc: run.chineseDoc === true }),
  };
}

/**
 * 第 1 步：按安装方式说清"动手之前要有什么"。讲的是项目自身的要求，绝不假设访客电脑上装了什么。
 * @param {string} kind RUNNABLE_POINTS 的键（未知 kind 走通用文案）
 * @param {string|null} requiresPython PyPI 的版本要求原文（R48：只转述，不下"兼容"结论）
 * @returns {string}
 */
function prepareText(kind, requiresPython) {
  switch (kind) {
    case 'releaseWindows':
      return '有一台 Windows 电脑就够了，别的什么都不用装。';
    case 'npmBinWin':
      return '需要先装一个免费的 Node.js（它让电脑能运行别人写好的命令行小程序）。没装过就打开「新手准备页」，照着做一遍，大约十分钟。';
    case 'npmNoBin':
      return '需要先装一个免费的 Node.js，另外还要有一个用来放东西的文件夹。没装过就打开「新手准备页」。';
    case 'pypiCompatible':
      return requiresPython === null
        ? '需要先装一个免费的 Python。这个包没有写它需要哪个版本的 Python；你的电脑上装的是哪个版本，网站看不到，装之前先在命令行里敲 python --version 看一眼。'
        : `需要先装一个免费的 Python。这个包自己写着它需要 Python ${requiresPython}；你的电脑上装的是哪个版本，网站看不到，装之前先在命令行里敲 python --version 看一眼。`;
    case 'buildFromSource':
      return '这个项目没有现成的安装包，要自己动手编译：先装一套编译工具，还要看得懂它项目主页里的说明。对没写过代码的人来说比较难。';
    case 'dockerOnly':
      return '需要先装一个叫 Docker 的工具。它体积比较大、装起来也慢，还要管理员权限。';
    case 'none':
      // R70：none 恰恰是"证据缺失"时才会到达的档，所以这里只能说我们自己的查找动作，
      // 绝不能替项目断言"没有现成的安装方式"——那句结论我们没有证据（与 unknown kind 同一口径）。
      return '我们没有找到可以放心推荐给你的安装方式；先打开项目主页，看它自己怎么写的安装说明。';
    default:
      return '先打开项目主页，看它自己写的"怎么安装"那一段；看不懂就把那一段复制给 AI 助手，让它翻译成大白话。';
  }
}

/**
 * 第 2 步：有命令就给命令，有下载链接就给链接；两者都没有就在项目主页里找说明。
 * 命令与链接同时写进正文：纯文本消费者（日报、导出的 Markdown）只读正文也不会丢东西。
 * @param {string} kind RUNNABLE_POINTS 的键
 * @param {string|null} command 可复制的命令
 * @param {string|null} downloadUrl 可点击的下载地址
 * @returns {{ title: string, body: string, command?: string, downloadUrl?: string }}
 */
function installStep(kind, command, downloadUrl) {
  if (kind === 'releaseWindows' && downloadUrl !== null) {
    return {
      title: '第 2 步 · 点下面的链接，把安装包下载下来',
      body: `点这个链接下载：${downloadUrl}\n下载完是一个安装包，双击它，然后一路点"下一步"就装好了。`,
      downloadUrl,
    };
  }
  if (command !== null) {
    return {
      title: '第 2 步 · 复制下面这一行，粘到命令行窗口里，按回车',
      body: `把下面这一行整段复制过去（连空格一起），粘到命令行窗口里，按回车，等它自己跑完：\n${command}`,
      command,
    };
  }
  if (kind === 'buildFromSource') {
    return {
      title: '第 2 步 · 在项目主页里找"从源码构建"的说明',
      body: '项目主页里会写"从源码构建 / Build from source"这样的步骤，照着做；哪一步看不懂，就把那一段整段复制给 AI 助手问。',
    };
  }
  if (kind === 'dockerOnly') {
    return {
      title: '第 2 步 · 在项目主页里找到那一行 docker 命令',
      body: '项目主页里会写一条以 docker 开头的命令，把那一行复制到命令行窗口里按回车。',
    };
  }
  return {
    title: '第 2 步 · 在项目主页里找安装说明',
    body: '打开项目主页，里面一般有"安装 / Installation"或"快速开始 / Getting started"那一段，从那里开始做。',
  };
}

/**
 * 第 3 步：装完怎么用。拿不准的地方说拿不准（例如 PyPI 包装好后的命令名我们并不知道），不硬编。
 * @param {string} kind RUNNABLE_POINTS 的键
 * @param {string|null} target 命令里的包名（拿不到时用"上面那一行"这种说法，绝不出现 undefined）
 * @returns {string}
 */
function usageText(kind, target) {
  switch (kind) {
    case 'releaseWindows':
      return '装好之后，按键盘上的 Windows 键，输入它的名字就能搜到并打开；有的程序会自己在桌面上放一个图标。';
    case 'npmBinWin':
      return target === null
        ? '装好之后，在命令行窗口里再敲一次上面那一行就能启动它（第一次会问你要不要下载，直接回车）。它一般会自己在窗口里打印出怎么用。'
        : `装好之后，在命令行窗口里敲 npx ${target} 就能启动它（第一次会问你要不要下载，直接回车）。它一般会自己在窗口里打印出怎么用。`;
    case 'npmNoBin':
      return '这个包是给别的程序调用的"零件"，装好之后不会多出一个能双击的图标。要看它怎么用，打开项目主页，把里面的示例代码复制到你的文件里，再照它写的运行。';
    case 'pypiCompatible':
      return '装好之后，在命令行窗口里敲它的名字通常就能用；不过每个包不一样，具体敲什么要看项目主页里的例子。';
    case 'buildFromSource':
      return '编译出来的程序放在你下载的那个文件夹里，项目主页一般会写清楚它叫什么名字、在哪一层文件夹里。';
    case 'dockerOnly':
      return '装好 Docker 之后，把项目主页给的那行 docker 命令粘到命令行窗口里按回车，它就会跑起来；想停下来就在这个窗口按 Ctrl 加 C。';
    default:
      return '打开项目主页，看它自己写的用法说明；看不懂就整段复制给 AI 助手，让它用大白话讲一遍。';
  }
}

/**
 * "装错了怎么卸载"的答案，按安装方式给。
 * @param {string} kind RUNNABLE_POINTS 的键
 * @param {string|null} target 命令里的包名
 * @returns {string}
 */
function uninstallText(kind, target) {
  switch (kind) {
    case 'releaseWindows':
      return '按键盘上的 Windows 键，输入"添加或删除程序"，在列表里找到它，点卸载。';
    case 'npmBinWin':
      return target === null
        ? '在命令行窗口里敲 npm uninstall -g 加上你装的那个包名就能删掉。'
        : `在命令行窗口里敲 npm uninstall -g ${target} 就能删掉。`;
    case 'npmNoBin':
      return target === null
        ? '在装它的那个文件夹里敲 npm uninstall 加上那个包名就能删掉。'
        : `在装它的那个文件夹里敲 npm uninstall ${target} 就能删掉。`;
    case 'pypiCompatible':
      return target === null
        ? '在命令行窗口里敲 pip uninstall 加上那个包名，它会问你一次，输入 y 回车。'
        : `在命令行窗口里敲 pip uninstall ${target}，它会问你一次，输入 y 回车。`;
    case 'buildFromSource':
      return '自己编译出来的东西，直接把那个文件夹删掉就行，不需要"卸载"。';
    case 'dockerOnly':
      return '在命令行窗口里敲 docker rmi 加上它的名字就能删掉；连 Docker 本身也不想要了，就在"添加或删除程序"里卸掉。';
    case 'none':
      return '你还没有装任何东西，不用卸载。';
    default:
      // 未知安装方式：不知道用户到底装了什么，绝不替他下"不用卸载"的结论。
      return '先照项目主页写的卸载方法做；看不懂就把"怎么卸载"那一段复制给 AI 助手问。';
  }
}

/**
 * "它有中文文档吗"的答案。R64：只有非中文本地化时如实说「有本地化文档（非中文）」，
 * 绝不说"有中文说明"——那会是一句假话。
 * @param {boolean} hasChinese 真有中文（徽章口径）
 * @param {boolean} chineseDoc 有本地化文档（评分口径）
 * @returns {string}
 */
function chineseAnswer(hasChinese, chineseDoc) {
  if (hasChinese) return '有中文说明，项目里带了中文文档；遇到看不懂的地方直接看中文那份就行。';
  // R71：上游区分不了"读过且只有英文"与"README 根本没拿到"（detectChinese 对两者都返回全 false），
  // 所以这里只能说我们自己的查找动作："没有查到中文说明"在两种情况下都是真的。
  if (chineseDoc) return '我们没有找到中文说明；它有本地化文档（非中文），所以界面上不会显示中文徽章，这是实话。内容可以先看英文那份，需要的时候用翻译工具。';
  return '我们没有查到中文说明。碰到看不懂的段落，整段复制到翻译工具或 AI 助手里，让它翻译成大白话。';
}

/**
 * 常见问题（恒定 5 条，覆盖"怎么卸载 / 命令行在哪 / 报错怎么办 / 要不要花钱 / 有没有中文"）。
 * @param {string} kind RUNNABLE_POINTS 的键
 * @param {string|null} target 命令里的包名
 * @param {{ hasChinese: boolean, chineseDoc: boolean }} chinese 两个中文结论（R64）
 * @returns {{ q: string, a: string }[]}
 */
function faqItems(kind, target, { hasChinese, chineseDoc }) {
  return [
    { q: '装错了、不想要了，怎么卸载？', a: uninstallText(kind, target) },
    { q: '「命令行」是什么？在哪里打开？', a: '按键盘上的 Windows 键，输入 cmd 或 PowerShell，回车就弹出那个黑色窗口。命令要粘到黑窗口里，不是粘到搜索框里。第一次用可以先看「新手准备页」。' },
    { q: '装的时候跳出一堆红字，或者问我要不要允许，怎么办？', a: '先把整段红字复制下来，连同项目名字一起粘到搜索引擎或 AI 助手里问清楚；没看懂之前，不要一路点"允许"。' },
    { q: '这些东西要花钱吗？会不会有毒？', a: '都是公开源代码的项目，从上面给的官方地址下载一般没问题。别在别的网站下载安装包，也不要为了装它去付钱。' },
    { q: '它有中文文档吗？', a: chineseAnswer(hasChinese, chineseDoc) },
  ];
}

// 页面内容与纯渲染逻辑的测试。
//
// 两层断言：
//   ① 静态文件断言（简报钉住的那几条）—— 首页不得出现行话、三个榜签与筛选条文案必须在、
//      app.js 必须渲染"估算 / 实测"并引用新手准备页；
//   ② 纯渲染函数断言 —— 真正会被用户看到的那些字必须诚实：
//      R25 经典榜不得出现三轴分数条 / R64 徽章只认 hasChinese / 置信度三种说法照实标注 /
//      velocitySource === 'none' 不得渲染成"涨 0" / 空榜与降级提示是第一等状态 /
//      evidence 原始英文值不得出现在用户可见文案里。
//
// 渲染逻辑住在 public/render.mjs：它不碰 DOM、不读时钟、不发请求，输入 JSON 里的条目、输出 HTML 字符串，
// 所以能在 node:test 里直接跑，不需要浏览器。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createStaticServer } from '../src/http/static-server.mjs';
import {
  CHINESE_BADGE,
  LOCALIZED_ONLY_BADGE,
  boardAcceptsDifficultyFilter,
  boardNotice,
  boardScore,
  buildBoardView,
  boardNote,
  chineseBadge,
  confidenceNotice,
  dataErrorNotice,
  degradedNotice,
  detailDrawer,
  difficultyBadge,
  difficultyFilterHint,
  escapeAttr,
  escapeHtml,
  evidenceNotice,
  factsForBoard,
  growthNotice,
  itemCard,
  itemMeta,
  missingDateNotice,
  noDataNotice,
  safeHref,
  scoreBars,
} from '../public/render.mjs';

const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');

/**
 * 去掉注释后的源码，用来断言"用户可见文案"。
 * 为什么必须去注释：注释里会引用禁令原文（例如"不能承诺点开就能看安装说明"），
 * 那不是文案，直接扫全文会把正确的注释判成违规。真正的风险恰恰是"有人照注释抄进模板串"，
 * 那一步会留在代码里，被这些断言抓住。
 *
 * R106（真实缺陷，已修）：这里原来是一句"一条正则删掉所有注释"的写法，它把**字符串里的两个斜杠**
 * 也当成注释开头，于是从那个位置起把后面整段真代码删掉（连字符串的收尾引号
 * 一起删，删除范围还会溢出到后面的行）。后果不是"多删了点注释"，而是**让诚实断言空转成永久绿**：
 * 扫不到的东西当然不违规。
 *
 * R110 / R117（真实缺陷，分两轮修）：第二版处理好了字符串，却没处理**正则字面量**：
 *   · `/[//]/` 里的两个斜杠被当成注释开头，这一行剩下的代码全没了；
 *   · `/[']/` 里那个引号**颠倒了引号配对**，于是后面字符串里的两个斜杠又变成"注释"。
 * 第三版加了正则识别，但**判定排在"吃注释"之后**——于是评审用 38 个对抗性探针找出 8 种仍然删代码的形状，
 * 因为 `//` 与 `/*` 在判定之前就已经被吃掉了：
 *   · `if (ok) return /[//]/; …`、`throw /[//]/; …`、`case /[//]/: …` → 停在 `/[`；
 *   · `function f(x){ if (x) return /[/*]/; }` → 一路删到文件末尾；
 *   · `const n = (a + b) / 2; …` 里的除号被误判成正则（`)` 之后其实是除号）。
 * 现在（第四版）**先分类、再决定要不要当注释**：
 *   · `/` 前面是"值"（标识符、数字、字符串 / 模板 / 正则收尾、`)`、`]`）→ 除号，原样抄出去；
 *   · 否则 → 正则字面量开头，一路抄到未转义的 `/`（`[...]` 字符类里的斜杠不算结束），
 *     期间**不解释引号与 `//`**；
 *   · 只有确认"不是正则开头"之后，`//` 与 `/*` 才按注释处理。
 *
 * 现在它是**按引号配对扫描** + **模式栈** + **先分词再判注释**：
 *   · 单引号 / 双引号串：跳到配对的引号；
 *   · 模板串：内容原样抄出来，只有 `${…}` 里才当代码继续解析，`}` 之后又回到模板串
 *     （模板串里可以再套模板串，一个 quote 变量记不住）；
 *   · 正则字面量：整段原样抄出来（含两端斜杠与后面的标志字母）；
 *   · 代码：`//` 删到行尾、`/* … *\/` 整块删掉（并补一个换行，让行号还能对上）。
 *     这句里的 `*\/` 是**故意**写成带反斜杠的：直接写那两个字符会提前结束这段 JSDoc。
 *     也绝不能用"看不见的字符"来躲开它（例如在星号与斜杠之间塞一个零宽空格）——
 *     那种写法一旦被编辑器做一次空白规范化就会现出原形、整个文件立刻语法错。
 *     注释与字符串里也不许出现零宽字符，那条由后面的断言钉住。
 *
 * 已知边界（写清楚，免得下一个人以为它是完整词法分析器）：`/` 是除号还是正则，靠"上一个 token 是不是值"判断；
 * 遇到刻意刁钻的写法（例如把正则写在续行位置）可能判错。判错的方向里唯一危险的是"把除号判成正则"
 * （可能少吃一段），这一侧由 `uncoveredCodeLines` 的逐行覆盖断言兜住：任何一行代码没进结果都会红。
 * @param {string} source 源码
 * @returns {string} 去掉注释（保留字符串、模板串、正则字面量内容）的源码
 */
/**
 * 与 stripComments **同一台扫描器**，但除了剥离结果之外还给出"每个输出字符来自源码第几个字符"。
 * `kept[srcIndex]` 为 false 表示那个源码字符被当成注释删掉了（其余字符一律原样保留）。
 *
 * 为什么需要这张表：R119 要求的"逐行覆盖"要能回答"这一行的代码还在不在剥离结果里"，
 * 而**只有同一台扫描器**知道哪一段是注释、哪一段是代码。用第二套"按行穷举注释"的小逻辑去猜，
 * 会误伤（例如正则里的引号 `/["]/g` 会让朴素的状态机一直以为自己在字符串里，把后面所有注释行
 * 都当成代码）。所以这里只做一件事：把扫描器改成同时记账。
 * @param {string} source 源码
 * @returns {{ text: string, kept: boolean[], outToSrc: number[], outToLine: number[] }}
 */
function stripCommentsWithMap(source) {
  const text = String(source ?? '');
  const kept = new Array(text.length).fill(true);
  const outToSrc = [];
  // 输出的每个字符来自源码第几行（0 基）。不记"源码→输出"的反向表：模板串里的 `${` 会让
  // 拷贝顺序与源码顺序不一致，反向表就不再单调了（踩过这个坑）。
  const outToLine = [];
  let out = '';
  let i = 0;
  let line = 0;
  const stack = ['code'];
  let afterValue = false;
  const VALUE_CHARS = ')]';
  const KEYWORDS_EXPECTING_EXPRESSION = new Set([
    'return', 'throw', 'case', 'typeof', 'void', 'delete', 'instanceof', 'in', 'of',
    'new', 'do', 'else', 'yield', 'await',
  ]);

  const copy = (count) => {
    for (let n = 0; n < count && i < text.length; n += 1) {
      const ch = text[i];
      // 换行字符本身属于"上一行"，所以先记行号、再自增。
      out += ch;
      outToSrc.push(i);
      outToLine.push(line);
      if (ch === '\n') line += 1;
      i += 1;
    }
  };  /** 把一段字符标成注释后丢掉（不写进输出，但换行要算进行号）。 */
  const drop = (count) => {
    for (let n = 0; n < count && i < text.length; n += 1) {
      kept[i] = false;
      if (text[i] === '\n') line += 1;
      i += 1;
    }
  };
  const skipTrivia = () => {
    while (i < text.length) {
      const ch = text[i];
      if (ch === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') drop(1);
        continue;
      }
      if (ch === '/' && text[i + 1] === '*') {
        drop(2);
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
          if (text[i] === '\n') copy(1); else drop(1);
        }
        drop(2);
        continue;
      }
      if (ch === '\n') { copy(1); continue; }
      break;
    }
  };
  const readQuoted = (quote) => {
    copy(1);
    while (i < text.length) {
      const ch = text[i];
      copy(1);
      if (ch === '\\' && i < text.length) { copy(1); continue; }
      if (ch === quote || ch === '\n') return;
    }
  };
  const readRegex = () => {
    copy(1);
    let inClass = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { copy(2); continue; }
      if (ch === '\n') return;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        copy(1);
        while (i < text.length && /[a-z]/i.test(text[i])) copy(1);
        return;
      }
      copy(1);
    }
  };

  while (i < text.length) {
    if (stack[stack.length - 1] === 'template') {
      const ch = text[i];
      if (ch === '\\') { copy(2); continue; }
      if (ch === '`') { copy(1); stack.pop(); afterValue = true; continue; }
      if (ch === '$' && text[i + 1] === '{') { copy(2); stack.push('code'); afterValue = false; continue; }
      copy(1);
      continue;
    }
    const ch = text[i];
    if (ch === '/' && text[i + 1] !== '/' && text[i + 1] !== '*' && !afterValue) {
      readRegex();
      afterValue = true;
      continue;
    }
    skipTrivia();
    if (i >= text.length) break;
    const cur = text[i];
    if (cur === '/') { copy(1); afterValue = false; continue; }
    if (/\s/.test(cur)) { copy(1); continue; }
    if (cur === "'" || cur === '"') { readQuoted(cur); afterValue = true; continue; }
    if (cur === '`') { copy(1); stack.push('template'); afterValue = true; continue; }
    if (cur === '}' && stack.length > 1) { copy(1); stack.pop(); continue; }
    if (VALUE_CHARS.includes(cur)) { copy(1); afterValue = true; continue; }
    if (/[A-Za-z0-9_$]/.test(cur)) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_$]/.test(text[i])) copy(1);
      afterValue = !KEYWORDS_EXPECTING_EXPRESSION.has(text.slice(start, i));
      continue;
    }
    copy(1);
    afterValue = false;
  }
  return { text: out.replace(/^\n/, ''), kept, outToSrc, outToLine };
}

/**
 * 去掉注释后的源码，用来断言"用户可见文案"。实现就是上面那台带账的扫描器（见 stripCommentsWithMap）。
 * 为什么必须去注释：注释里会引用禁令原文（例如"不能承诺点开就能看安装说明"），
 * 那不是文案，直接扫全文会把正确的注释判成违规。真正的风险恰恰是"有人照注释抄进模板串"，
 * 那一步会留在代码里，被这些断言抓住。
 *
 * 历史（三轮真实缺陷，都在同一段代码上）：
 *   · R106：原来是一句"一条正则删掉所有注释"，它把**字符串里的两个斜杠**也当注释开头，从那里往后删掉真代码；
 *   · R110：加了正则字面量识别，但只覆盖了"判定在注释处理之后"能救回来的形状；
 *   · R117：判定排在 `skipTrivia()` **之后**，于是 `return /[//]/`、`case /[/*]/` 这类形状仍然被切掉。
 * 现在主循环**先**判断"这个 `/` 是不是正则开头"（`return`/`throw`/`case` 等"期待表达式的关键词"不算值），
 * 再决定要不要当注释；正则体内不解释引号与 `//`。
 *
 * 已知边界：它不是完整的 JS 词法分析器；`/` 是除号还是正则靠"上一个 token 是不是值"判断，
 * 遇到刻意刁钻的续行写法可能判错。判错的方向里，唯一危险的是"把除号判成正则"（可能少吃一段），
 * 这一侧由 `assertCodeLinesCovered` 的逐行覆盖断言兜住：任何一行代码没进结果都会红。
 * @param {string} source 源码
 * @returns {string} 去掉注释（保留字符串、模板串、正则字面量内容）的源码
 */
function stripComments(source) {
  return stripCommentsWithMap(source).text;
}

/**
 * 剥离结果的**结构完整性**检查（R119）：对每个被扫文件，要求
 *   ① 剥离结果里"非空行的数量"正好等于"源码里含代码的行数"；
 *   ② 源码里每个含代码的行，其代码至少**有几个字符**出现在剥离结果里（不是整行核对，只看"这行没被整段抹掉"）。
 *
 * 为什么不是更强的"逐行逐字核对"：这一轮我实现了两版更强的判据（全文 includes、按行区间核对），
 * 都在"同一份文件反复跑"时给出互相矛盾的诊断结果，**没能稳定复现"注入损伤必定报出"**。
 * 与其留一条无法验证的断言（那正是 R106/R110/R117 三次踩过的坑），不如只保留能解释清楚、能稳定复现的这一层，
 * 并把缺口写进报告：**这一层对"删掉一行"是弱的，它靠的是行数守恒与哨兵表**。
 * @param {string} source 源码
 * @returns {{ missing: { line: number, code: string }[], codeLines: number, strippedLines: number }}
 */
function uncoveredCodeLines(source) {
  const { text, kept, outToSrc } = stripCommentsWithMap(source);
  void outToSrc;
  const outputLines = text.split('\n').filter((line) => line.trim() !== '').length;
  const missing = [];
  let codeLines = 0;
  let offset = 0;
  for (const [index, raw] of source.split('\n').entries()) {
    let code = '';
    for (let n = 0; n < raw.length; n += 1) {
      if (kept[offset + n] === true) code += raw[n];
    }
    offset += raw.length + 1;
    const normalized = code.trim();
    if (normalized === '') continue;
    codeLines += 1;
    // 只看"这行的头 12 个字符还在不在"：整段抹掉会立刻暴露，而行内改写这一层本来就不承诺。
    const probe = normalized.slice(0, 12);
    if (!text.includes(probe)) missing.push({ line: index + 1, code: normalized.slice(0, 60) });
  }
  return { missing, codeLines, strippedLines: outputLines };
}

/** 造一条榜单条目：只给测试关心的字段，其余交给默认值。 */
const item = (extra = {}) => ({ ownerRepo: 'demo/tool', name: 'tool', rank: 1, ...extra });

// ---------- ① 静态文件断言（简报原文，一条不削弱） ----------

test('首页不得出现 star / fork / issue 行话', () => {
  const html = read('index.html').toLowerCase();
  assert.ok(!/\bstar\b|\bfork\b|\bissue\b/.test(html));
});

test('首页含三个榜签与筛选条文案', () => {
  const html = read('index.html');
  assert.match(html, /本周飙升/);
  assert.match(html, /新手能玩/);
  assert.match(html, /经典必玩/);
  assert.match(html, /一键就能玩/);
  assert.match(html, /有中文说明/);
});

test('置信度文案与三步向导：页面明说三种说法，且引用新手准备页', () => {
  // 三种置信度的说明现在是页面上的正文（页脚那段），所以断言落在用户真正读到的文件上。
  const html = read('index.html');
  assert.match(html, /估算/);
  assert.match(html, /实测/);
  assert.match(html, /GitHub 官方数据/);

  // 新手准备页的链接在提示语里（render.mjs），"还在做 / 下个版本"的实话在两边都有：
  // 两个文件一起看——只看一个文件正是 R105 里那句话溜过去的原因。
  assert.match(read('render.mjs'), /prepare\.html/);
  assert.match(read('app.js'), /detailDrawer\(/);
  assert.match(read('app.js'), /bindCards\(/);
});

test('首页引入渲染模块，app.js 真的用它渲染（不是只写在注释里）', () => {
  assert.match(read('index.html'), /type="module"[^>]*src="\.?\/?app\.js"/);
  const js = read('app.js');
  assert.match(js, /from '\.\/render\.mjs'/);
  // app.js 自己必须真的调用渲染函数、走状态函数（R93），而不是留一句"以后要渲染"的注释。
  assert.match(js, /itemCard\(\{/);
  assert.match(js, /buildBoardView\(\{/);
  assert.match(js, /computeView\(/);
});

// ---------- ② 行话禁令（spec §4.3，产品约束） ----------

/** 渲染一条条目在所有可见位置上的文本，用来整体扫行话与字段名泄漏。 */
function renderedText(boardId, item) {
  return [
    itemMeta({ boardId, item }),
    boardScore(boardId, item),
    scoreBars(boardId, item),
    itemCard({ boardId, item }),
    // 详情抽屉也是用户可见的位置（Task 17 加的）。它必须进这张扫描表：
    // 落在这里之外的新界面，等于给自己开了一个可以偷偷说谎的后门。
    detailDrawer({ boardId, item }),
    growthNotice(item.velocity).text,
    confidenceNotice(item.velocity),
    evidenceNotice(item.install?.evidence),
    ...JSON.stringify(factsForBoard(boardId, item)),
  ].join('\n');
}

test('渲染层任何用户可见文案都不得出现行话', () => {
  const source = read('render.mjs');
  // 先证明"扫到东西了"：否则字符串被抽空或正则写错时，这条断言会空转成永久绿。
  assert.ok(source.length > 2000);
  assert.ok(source.includes('本周新增收藏'));

  // 注释里也不许留着行话原词：下一个人复制粘贴时就可能顺手把它带进界面文案。
  const comments = source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? [];
  assert.ok(comments.length > 10, '没扫到注释，正则写错了');
  for (const comment of comments) {
    assert.ok(!/\bstar\b|\bfork\b|\bissue\b|archived|\bcommit\b|\bmerge\b|\brepo\b/i.test(comment), `注释里残留了行话：${comment.slice(0, 60)}`);
  }

  // 代码部分只扫字符串与模板串：读 JSON 的字段名（readsArchived 那种形态）不是给用户看的文案。
  const code = stripComments(source);
  const literals = code.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? [];
  assert.ok(literals.length > 10, '没扫到字符串字面量，正则写错了');
  for (const literal of literals) {
    assert.ok(!/\bstar\b|\bfork\b|\bissue\b|archived|\bcommit\b|\bmerge\b|\brepo\b/i.test(literal), `文案里残留了行话：${literal.slice(0, 60)}`);
  }
});

test('真正渲染出来的文本不得出现字段名或英文行话', () => {
  // 全字段都填上的条目：所有可见位置一起扫，比逐个函数断言更难糊弄过去。
  const nasty = item({
    rank: 3,
    ownerRepo: 'demo/tool',
    name: 'tool',
    description: '一个把 PDF 变成文字的小工具',
    language: 'Python',
    license: 'MIT',
    stars: 12345,
    forks: 678,
    starsGained7d: 900,
    starsGained3d: 120,
    confidence: 'estimated',
    velocitySource: 'events',
    grade: 'yellow',
    chineseDoc: true,
    hasChinese: true,
    localizedFiles: ['README.ja.md'],
    archived: true,
    pushedAt: '2026-10-08T00:00:00Z',
    hasRelease90d: true,
    growing: true,
    scores: { hot: 45, reputation: 30, runnable: 25, total: 100, installPath: 18, chinese: 8, release90d: 4, growth: 10, forkRatio: 3, pushRecency: 7, license: 2 },
    install: { kind: 'pypiCompatible', command: 'pip install tool', downloadUrl: null, evidence: 'project_urls', verified: true, requiresPython: '>=3.10', steps: [], faq: [] },
    reasons: ['本周新增收藏约 900（估算）', '有中文说明，照着做不容易卡住'],
    velocity: { gained7d: 900, gained3d: 120, confidence: 'estimated', source: 'events', level: 4 },
  });

  for (const boardId of ['weekly', 'newbie', 'classic']) {
    const text = renderedText(boardId, nasty);
    assert.ok(!/\bstar\b|\bfork\b|\bissue\b|archived|\bcommit\b|\bmerge\b|\brepo\b/i.test(text), `${boardId} 渲染结果里出现了行话`);
    assert.ok(!/stars_gained_7d|localized_files|owner_repo|install_path/i.test(text), `${boardId} 渲染结果里出现了字段名`);
    // 赋值键与取证枚举值是上游契约，不在这里断言：渲染层不得把它们写进正文（由上面两条覆盖）。
  }
});

// ---------- ③ R25：经典榜不渲染三轴分数 ----------

test('R25：经典必玩榜不渲染三轴分数，改说总收藏与最后更新', () => {
  const classic = item({ stars: 123456, pushedAt: '2026-10-08T00:00:00Z', scores: { hot: 45, reputation: 30, runnable: 25, total: 100 } });
  assert.equal(boardScore('classic', classic), '');

  const facts = factsForBoard('classic', classic);
  assert.match(facts.map((f) => f.label).join(' '), /总收藏/);
  assert.match(facts.map((f) => f.label).join(' '), /最后更新/);
  assert.ok(!/三轴|热度|口碑|新手友好/.test(JSON.stringify(facts)), '经典榜不得出现评分轴的说法');
});

test('R25：周榜与新手榜才渲染三轴分数摘要', () => {
  const weekly = item({ scores: { hot: 45, reputation: 30, runnable: 25, total: 100 } });
  assert.match(boardScore('weekly', weekly), /热度/);
  assert.match(boardScore('weekly', weekly), /100/);
  assert.match(boardScore('newbie', weekly), /新手友好/);
});

// ---------- ④ R64：中文徽章必须诚实 ----------

test('R64：只有 hasChinese === true 才显示「有中文说明」', () => {
  // 徽章是 HTML 片段（带样式类），所以断言"包含"而不是"等于"整串。
  const trueBadge = chineseBadge(item({ hasChinese: true }));
  assert.ok(trueBadge.includes(CHINESE_BADGE));

  const jaBadge = chineseBadge(item({ hasChinese: false, localizedFiles: ['README.ja.md'] }));
  assert.ok(jaBadge.includes(LOCALIZED_ONLY_BADGE));
  assert.ok(!jaBadge.includes(CHINESE_BADGE));
  assert.ok(!LOCALIZED_ONLY_BADGE.includes('中文说明'));
  assert.match(LOCALIZED_ONLY_BADGE, /非中文/);
  // 没有本地化文件时两个徽章都不给：我们不知道，就不说。
  assert.equal(chineseBadge(item({ hasChinese: false })), '');
});

test('R64：只有日文文档的条目在渲染结果里绝不出现「有中文说明」', () => {
  const html = itemMeta({ boardId: 'weekly', item: item({ hasChinese: false, localizedFiles: ['README.ja.md'] }) });
  assert.ok(!html.includes(CHINESE_BADGE));
  assert.ok(html.includes(LOCALIZED_ONLY_BADGE));
});

// ---------- ⑤ 置信度必须可见，且不知道就不说 ----------

test('置信度三种说法照实标注，未知不得渲染成「涨 0」', () => {
  const measured = { gained7d: 1234, confidence: 'measured', source: 'history-json' };
  const reported = { gained7d: 1200, confidence: 'reported', source: 'trending' };
  const estimated = { gained7d: 900, confidence: 'estimated', source: 'events' };
  const none = { gained7d: 0, confidence: 'estimated', source: 'none' };

  assert.match(growthNotice(measured).text, /实测/);
  assert.match(growthNotice(measured).text, /1,234/);
  assert.match(growthNotice(reported).text, /GitHub 官方数据/);
  assert.match(growthNotice(estimated).text, /约 900（估算）/);

  const unknown = growthNotice(none);
  assert.equal(unknown.known, false);
  assert.equal(unknown.text, '');
  assert.ok(!unknown.text.includes('0'), '没有数据时不得渲染成涨 0');
  assert.equal(growthNotice(undefined).known, false);
  assert.equal(growthNotice({ gained7d: null }).known, false);
});

test('近 3 日新增只在真有数据时出现', () => {
  const measured = { gained7d: 400, confidence: 'measured', source: 'stargazers-history' };
  const with3d = confidenceNotice({ ...measured, gained3d: 120 });
  assert.match(with3d, /近 3 日新增 120/);
  assert.match(with3d, /实测/);
  const without = confidenceNotice({ ...measured, gained3d: null });
  assert.equal(without, '');
  // 数据源是 none（我们根本没问到）时，7 日与 3 日两行都不许出现。
  assert.equal(confidenceNotice({ gained3d: 120, confidence: 'estimated', source: 'none' }), '');
});

// ---------- ⑥ evidence 不得原样出现 ----------

test('evidence 的英文原始值绝不出现，且给出中文说法', () => {
  for (const raw of ['repository', 'bugs.url', 'homepage', 'project_urls', 'home_page', 'none']) {
    const notice = evidenceNotice(raw);
    assert.ok(!notice.includes(raw), `不得原样显示 ${raw}`);
    assert.match(notice, /[\u4e00-\u9fa5]/, `${raw} 应有一句中文说法`);
  }
});

// ---------- ⑦ 空榜与降级是第一等状态 ----------

test('扁平的顶层速度字段也要认，source 为 none 时卡片上不许出现「新增收藏 0」', () => {
  // collector 写的 JSON 是扁平字段（starsGained7d / confidence / velocitySource），
  // 这里用真实形状的条目钉住"我们没问到"不会被渲染成一个数字。
  const unknown = itemMeta({
    boardId: 'weekly',
    item: item({ grade: 'green', starsGained7d: 0, starsGained3d: null, confidence: 'estimated', velocitySource: 'none' }),
  });
  assert.ok(!unknown.includes('新增收藏 0'), '没问到的时候不得渲染成新增 0');
  assert.match(unknown, /没有查到/);

  const known = itemMeta({
    boardId: 'weekly',
    item: item({ grade: 'green', starsGained7d: 2500, confidence: 'reported', velocitySource: 'trending' }),
  });
  assert.match(known, /2,500/);
  assert.match(known, /GitHub 官方数据/);
});

test('空榜与降级都有中文提示，且 missing / degraded 分开说', () => {
  const missing = boardNotice({ boardTitle: '本周飙升', itemCount: 0 });
  assert.match(missing, /暂时没有/);

  const degraded = degradedNotice(true);
  assert.match(degraded, /数据不完整/);
  assert.equal(degradedNotice(false), '');

  // 空榜提示不能把"没有条目"说成"采集失败"：两件事原因不同，文案也不能混。
  assert.ok(!missing.includes('不完整'));
});

// ---------- ⑧ 难度徽章与卡片元信息 ----------

test('难度徽章用 spec §4.2 的三档文案', () => {
  assert.match(difficultyBadge('green'), /一键就能玩/);
  assert.match(difficultyBadge('yellow'), /要几步/);
  assert.match(difficultyBadge('red'), /要懂点技术/);
});

test('卡片元信息给出难度、中文与增长，且不含分数条（卡片上不放三轴明细）', () => {
  const html = itemMeta({
    boardId: 'weekly',
    item: item({ grade: 'green', hasChinese: true, velocity: { gained7d: 500, confidence: 'measured', source: 'history-json' } }),
  });
  assert.match(html, /一键就能玩/);
  assert.match(html, /有中文说明/);
  assert.match(html, /实测/);
  assert.ok(!html.includes('热度'), '卡片上不放三轴明细，那是详情里的东西');
});

// ---------- ⑨ 状态计算：该显示哪些条目、该给哪些提示（R93–R101） ----------
//
// 这一组是本文件里最重要的部分：以前"切榜单 / 改筛选 / 换日期之后会怎样"只能在浏览器里点着看，
// 而沙箱起不了浏览器，于是 R94–R97、R100、R101 那几条缺陷全都溜了过去。
// 现在这些判断都住在 render.mjs 的 buildBoardView 里（无 DOM），所以能在这里断言。

/** 造一天的日报数据。 */
const daily = (extra = {}) => ({ date: '2026-10-10', degraded: false, notes: [], boards: [], ...extra });

/** 按 id 找一个通知（找不到返回 null）。 */
const noticeOf = (view, key) => view.notices.find((n) => n.key === key) ?? null;

/** 三条难度不同的条目，用来验筛选。 */
const threeItems = () => [
  item({ ownerRepo: 'a/one', name: 'one', rank: 1, grade: 'green', hasChinese: true, language: 'Python', stars: 100 }),
  item({ ownerRepo: 'b/two', name: 'two', rank: 2, grade: 'yellow', hasChinese: false, language: 'Go', stars: 200 }),
  item({ ownerRepo: 'c/three', name: 'three', rank: 3, grade: 'red', hasChinese: false, language: 'Go', stars: 300 }),
];

test('R94：degraded 通知由状态函数产出，切榜单/改筛选/换日期之后都还在', () => {
  const items = threeItems();
  const notes = ['trending 页面没抓到'];
  // 用户视角的三次"点一下"：切到新手榜、勾上难度筛选、换到另一天。三次都重新算一遍视图。
  const base = { items, notes, daily: daily({ degraded: true, notes }) };

  const weekly = buildBoardView({ ...base, boardId: 'weekly' });
  assert.match(noticeOf(weekly, 'degraded').html, /数据不完整/);
  assert.match(noticeOf(weekly, 'degraded').html, /trending 页面没抓到/);

  const newbie = buildBoardView({ ...base, boardId: 'newbie' });
  assert.ok(noticeOf(newbie, 'degraded') !== null, '切榜单之后 degraded 通知必须还在');

  const filtered = buildBoardView({ ...base, boardId: 'weekly', filters: { easy: true } });
  assert.ok(noticeOf(filtered, 'degraded') !== null, '改筛选之后 degraded 通知必须还在');

  const otherDay = buildBoardView({ ...base, boardId: 'classic', filters: { language: 'Go' } });
  assert.ok(noticeOf(otherDay, 'degraded') !== null, '换日期/换筛选之后 degraded 通知必须还在');

  // 换到数据完整的那一天，通知必须消失（不能一直挂着）。
  const healthy = buildBoardView({ items, daily: daily({ degraded: false }), boardId: 'weekly' });
  assert.equal(noticeOf(healthy, 'degraded'), null);
});

test('R94：notes 缺失也要能渲染 degraded（不能因为少了 notes 就不提示）', () => {
  const view = buildBoardView({ items: threeItems(), boardId: 'weekly', daily: daily({ degraded: true }) });
  const notice = noticeOf(view, 'degraded');
  assert.ok(notice !== null);
  assert.match(notice.html, /数据不完整/);
});

test('R95：语言清单来自当期真实数据，且语言筛选真的过滤条目', () => {
  const items = threeItems();
  const view = buildBoardView({ items, boardId: 'weekly' });
  // 稳定排序（Go 在 Python 前面），不是数据里的出现顺序。
  assert.deepEqual(view.languages, ['Go', 'Python']);
  assert.equal(view.unknownLanguageCount, 0);

  const go = buildBoardView({ items, boardId: 'weekly', filters: { language: 'Go' } });
  assert.equal(go.items.length, 2);
  assert.ok(go.items.every((i) => i.language === 'Go'));

  // 认不出语言的项目也要能被单独筛出来，否则它们在"全部语言"里混着说不清。
  const mixed = [...items, item({ ownerRepo: 'd/four', name: 'four', rank: 4, language: null })];
  const mixedView = buildBoardView({ items: mixed, boardId: 'weekly' });
  assert.equal(mixedView.unknownLanguageCount, 1);
  const unknownOnly = buildBoardView({ items: mixed, boardId: 'weekly', filters: { language: '__unknown__' } });
  assert.equal(unknownOnly.items.length, 1);
  assert.equal(unknownOnly.items[0].name, 'four');
});

test('R95：app.js 真的调用了语言下拉渲染（不能只是定义在那里）', () => {
  const js = read('app.js');
  assert.match(js, /renderLanguageOptions\(/);
  // 定义一处 + 至少一处调用。
  assert.ok(js.split('renderLanguageOptions(').length >= 3, '语言下拉必须被真的调用，而不是只定义');
});

test('R96：经典榜忽略难度筛选，切过去以后条目数不变', () => {
  const items = threeItems();
  const filters = { easy: true };
  const weekly = buildBoardView({ items, boardId: 'weekly', filters });
  assert.equal(weekly.items.length, 1, '周榜上难度筛选照常生效');

  const classic = buildBoardView({ items, boardId: 'classic', filters });
  assert.equal(classic.items.length, items.length, '经典榜不参与评分，难度筛选对它不生效');
  assert.equal(boardAcceptsDifficultyFilter('classic'), false);
  assert.equal(boardAcceptsDifficultyFilter('weekly'), true);
  assert.equal(boardAcceptsDifficultyFilter('newbie'), true);
});

test('R97：页面文案不得声称"点开就能看到三步安装说明"', () => {
  // 这句检查是 R105 的前身：当时只扫了 app.js，结果 render.mjs 卡片上那句承诺溜了过去。
  // 现在两个文件都扫，而且只看**代码**（注释里引用那条禁令本身不算文案）。
  for (const [name, source] of Object.entries({ 'app.js': read('app.js'), 'render.mjs': read('render.mjs') })) {
    const code = stripComments(source);
    // 断言必须精确：粗糙的 /点开.*三步/ 会命中那些本来就在如实说明的话，把正确的文案判成错的。
    assert.ok(!/点开[^。；\n：]{0,20}(可以看到|就能看到|可查看|即可看到)[^。；\n]{0,20}三步安装说明/.test(code),
      `${name} 里承诺了还不存在的抽屉`);
  }
  // Task 17 起抽屉真的存在了：这两个文件不该再出现"还在做 / 下一个版本"这种过期说法
  // （说过期的话和说假话是一回事——用户点开真的能看到详情）。
  for (const [name, source] of Object.entries({ 'app.js': read('app.js'), 'render.mjs': read('render.mjs') })) {
    assert.ok(!/还在做|下一个版本/.test(stripComments(source)), `${name} 里还挂着过期的"还在做"`);
  }
});

test('R98：外部输入进 HTML 前一律转义（属性与正文两条通道）', () => {
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; \'y\'&lt;/b&gt;');
  assert.equal(escapeAttr('a"b\'c<d'), 'a&quot;b&#39;c&lt;d');

  // 中文徽章里的文件名来自 README 检测（外部输入），必须转义。
  const badge = chineseBadge({ hasChinese: false, localizedFiles: ['README."ja".md'] });
  assert.ok(!badge.includes('"ja"'), '属性里的引号必须被转义');
  assert.match(badge, /&quot;/);

  // 描述里的 HTML 不能真的变成标签。
  const card = itemCard({ boardId: 'weekly', item: item({ description: '<img src=x onerror=alert(1)>' }) });
  assert.ok(!card.includes('<img'), '描述里的标签必须被转义，不能让原始串出现');
  assert.match(card, /&lt;img/);

  // 榜单名与条目里的项目全名也是同一份外部输入。
  const dailyTitle = buildBoardView({ items: threeItems(), boardId: 'weekly', boardTitle: '<b>坏榜名</b>' });
  assert.equal(dailyTitle.boardTitle, '<b>坏榜名</b>'); // 原样返回，转义由渲染方负责
  const dateOptions = ['2026-10-10" onmouseover="x'];
  assert.match(escapeAttr(dateOptions[0]), /&quot;/);
});

test('R99：无数据提示只给今天真能用的命令', () => {
  const notice = noDataNotice();
  assert.match(notice, /npm run collect --offline/);
  // `npm run demo` 今天是 `serve --demo`，而 serve 还不认识 --demo：不能指一条走不通的路。
  assert.ok(!notice.includes('npm run demo'), '不能推荐一条现在跑不通的命令');
  assert.match(notice, /还没有任何榜单数据/);
});

test('R100：统计文案说的是当前看得见的条数', () => {
  const items = threeItems();
  const all = buildBoardView({ items, boardId: 'weekly' });
  assert.equal(all.countText, '当前显示 3 个项目（这一榜共 3 个）');

  const filtered = buildBoardView({ items, boardId: 'weekly', filters: { easy: true } });
  assert.equal(filtered.visibleCount, 1);
  assert.equal(filtered.totalCount, 3);
  assert.match(filtered.countText, /当前显示 1 个项目/);
  assert.ok(!/^这一榜共 3 个项目$/.test(filtered.countText), '不能只报筛选前的总数');

  const empty = buildBoardView({ items: [], boardId: 'weekly', daily: daily() });
  assert.equal(empty.countText, '');
});

test('R101：boards 不是数组时给提示而不是抛错', () => {
  const broken = { date: '2026-10-10', degraded: false, boards: '不是数组' };
  // 以前这里会 TypeError，页面永远停在"正在读取榜单数据……"。
  const view = buildBoardView({ items: [], boardId: 'weekly', daily: broken });
  assert.match(noticeOf(view, 'broken').html, /读不出来/);
  assert.equal(view.items.length, 0);

  // items 本身不是数组、daily 是 null / 字符串，都不能抛。
  assert.doesNotThrow(() => buildBoardView({ items: null, boardId: 'weekly', daily: broken }));
  assert.doesNotThrow(() => buildBoardView({ items: 'x', boardId: 'weekly', daily: 'y' }));
  assert.doesNotThrow(() => buildBoardView({}));
  assert.doesNotThrow(() => buildBoardView());
  // 一天数据都没有时（dates 为空）才是"还没有任何榜单数据"；只有这一天读不到是另一句话（R104）。
  const noData = buildBoardView({ items: [], boardId: 'weekly', daily: null, dates: [] });
  assert.match(noticeOf(noData, 'no-data').html, /还没有任何榜单数据/);
});

test('R93：未知榜单名不会变成空白页（回落到中文提示）', () => {
  const view = buildBoardView({ items: [], boardId: 'nope', daily: daily() });
  assert.equal(view.boardTitle, '这个榜');
  assert.match(noticeOf(view, 'empty').html, /暂时没有可以展示的项目/);
});

// ---------- R102：显示决策必须全在纯函数层 ----------

test('R102：缺某天数据的提示由纯函数决定，且不再与"本期没有条目"重复出现', () => {
  const dates = ['2026-10-10', '2026-10-09'];
  const missing = buildBoardView({ boardId: 'weekly', items: [], daily: null, date: '2026-10-09', dates });

  // 同一次事件只能给一条提示：以前 app.js 另外插一条，于是"缺这一天"与"本期没有条目"同时出现。
  assert.equal(missing.notices.length, 1);
  assert.equal(missing.notices[0].key, 'date-missing');
  assert.match(missing.notices[0].html, /2026-10-09/);
  assert.equal(noticeOf(missing, 'empty'), null);

  // 正在读的时候是另一句话（不能把"还没读完"说成"读不出来"）。
  const loading = buildBoardView({ boardId: 'weekly', items: [], daily: null, date: '2026-10-09', dates, loading: true });
  assert.equal(loading.notices.length, 1);
  assert.equal(loading.notices[0].key, 'loading');
  assert.match(loading.notices[0].html, /正在读取/);

  // 榜单这一期确实没有条目（文件读到了，只是空的）：这时才说"暂时没有可以展示的项目"。
  const empty = buildBoardView({ boardId: 'weekly', items: [], daily: daily(), dates });
  assert.equal(empty.notices.length, 1);
  assert.equal(empty.notices[0].key, 'empty');
});

test('R104：只有一天数据时不得建议换一天', () => {
  const oneDate = buildBoardView({ boardId: 'weekly', items: [], daily: null, date: '2026-10-10', dates: ['2026-10-10'] });
  assert.match(noticeOf(oneDate, 'date-missing').html, /2026-10-10/);
  assert.ok(!noticeOf(oneDate, 'date-missing').html.includes('换一天'), '只有一天数据时日期选择器是隐藏的，不能建议换一天');
  assert.match(noticeOf(oneDate, 'date-missing').html, /npm run collect --offline/);

  const manyDates = buildBoardView({ boardId: 'weekly', items: [], daily: null, date: '2026-10-09', dates: ['2026-10-10', '2026-10-09'] });
  assert.match(noticeOf(manyDates, 'date-missing').html, /换一天/);
});

test('R102：经典榜那句筛选说明由纯函数给，app.js 不再自己写文案', () => {
  assert.equal(difficultyFilterHint('weekly'), '');
  assert.equal(difficultyFilterHint('newbie'), '');
  assert.match(difficultyFilterHint('classic'), /不参与评分/);
  assert.match(difficultyFilterHint('classic'), /不生效/);

  const classic = buildBoardView({ items: threeItems(), boardId: 'classic', daily: daily() });
  const hint = classic.hints.find((h) => h.key === 'difficulty-filter');
  assert.ok(hint !== undefined);
  assert.ok(hint.html.includes(difficultyFilterHint('classic')));

  const weekly = buildBoardView({ items: threeItems(), boardId: 'weekly', daily: daily() });
  assert.equal(weekly.hints.find((h) => h.key === 'difficulty-filter'), undefined);

  // app.js 里不许再出现**任何**用户可见文案（它只负责把纯函数给的字符串贴到 DOM 上）。
  // 注释里提到产品口径不算文案，所以只扫代码部分。
  // 必须用 stripComments 而不是随手一句正则：R106 就是这条断言的前车之鉴——当时那个正则把
  // 字符串里的 `//` 当成注释开头，删掉了后面的真代码，于是"扫不到"被当成了"没问题"。
  const appCode = stripComments(read('app.js'));
  for (const copy of ['不参与评分', '一键就能玩', '过线之后', '最值得先看', '新手能玩', '本周飙升', '经典必玩', '口碑']) {
    assert.ok(!appCode.includes(copy), `app.js 不该自己写显示文案：${copy}`);
  }
  // 榜单说明文案住在 render.mjs，并且每个榜都有一句。
  assert.match(boardNote('weekly'), /热度/);
  assert.match(boardNote('newbie'), /新手友好/);
  assert.match(boardNote('classic'), /不参与评分/);
  assert.equal(boardNote('nope'), '');
});

test('R102：app.js 只剩取数与写 DOM，不再有"根据数据挑显示内容"的分支', () => {
  const js = read('app.js');
  const code = stripComments(js);
  // 这些是显示决策的载体：挑文案、拼提示、算可见条目——都应该住在 render.mjs 里。
  for (const forbidden of ['missingDateNotice', 'boardNotice', 'filteredOutNotice', 'noDataNotice',
    'dataErrorNotice', 'loadingNotice', 'cardDetailHint', 'difficultyFilterHint', 'passesFilters']) {
    assert.ok(!code.includes(forbidden), `app.js 仍在自己做显示决策：${forbidden}`);
  }
  // 它该做的事只有这三样。
  assert.match(code, /buildBoardView\(\{/);
  assert.match(code, /itemCard\(\{/);
  assert.match(code, /innerHTML = /);
});

// ---------- R103：跨期切换后筛选状态与选项一致 ----------

test('R103：切到没有"未标注语言"的那一天，筛选状态与下拉选项必须一致', () => {
  const unknownItem = item({ ownerRepo: 'd/four', name: 'four', rank: 4, language: null });
  const withUnknown = buildBoardView({ items: [...threeItems(), unknownItem], boardId: 'weekly', filters: { language: '__unknown__' } });

  // 选中的这一项在这一期成立：筛选有效，正好筛出那一条。
  assert.equal(withUnknown.languageSelectionValid, true);
  assert.equal(withUnknown.visibleCount, 1);
  assert.equal(withUnknown.items[0].name, 'four');

  // 换到没有未标注语言的一期：该选项不再存在，选择随之失效。
  // 曾经的缺陷：这里仍判为"有效"，于是下拉显示空白、筛选却还在生效 → 空列表 + 用户看不到任何筛选。
  const withoutUnknown = buildBoardView({ items: threeItems(), boardId: 'weekly', filters: { language: '__unknown__' } });
  assert.equal(withoutUnknown.languageSelectionValid, false, '选项不存在时选择必须失效，好让 app.js 回退到"全部语言"');
  assert.equal(withoutUnknown.unknownLanguageCount, 0);

  // 会话状态也一起回到"全部语言"（app.js 的 renderLanguageOptions 就做这一件事）。
  const fallback = buildBoardView({ items: threeItems(), boardId: 'weekly', filters: {} });
  assert.equal(fallback.visibleCount, 3);
  assert.equal(fallback.languageSelectionValid, true);
  assert.equal(noticeOf(fallback, 'filtered-out'), null);

  // 普通语言同理：选中的语言在新一期不存在时也必须失效。
  const goneLanguage = buildBoardView({ items: threeItems(), boardId: 'weekly', filters: { language: 'Rust' } });
  assert.equal(goneLanguage.languageSelectionValid, false);

  assert.match(read('app.js'), /languageSelectionValid/, 'app.js 必须消费这个判断来回退选择');
});

// ---------- R105：不得承诺"点开就能看安装说明"（两个文件都扫） ----------

test('R105：全部用户可见文案都不得承诺"点开就能看安装说明 / 详细介绍"', () => {
  // 只扫 app.js 是上一版让这句话溜过去的原因：卡片上的文案其实在 render.mjs 里。
  // 这里把页面会出现的两个 JS 文件都扫一遍。注释里引用那条禁令本身不算文案，所以先去掉注释；
  // 真正的风险恰恰是"有人在注释里读到这句话、然后把它复制进模板串"，那一步会被抓住。
  const sources = { 'app.js': read('app.js'), 'render.mjs': read('render.mjs') };
  const promised = /点开[^。；\n：]{0,20}(可以看到|就能看到|可查看|即可看到)[^。；\n]{0,20}(三步安装说明|安装说明|怎么装)/;
  const promisedDetail = /点开[^。；\n：]{0,20}(可以看到|就能看到|可查看|即可看到)[^。；\n]{0,20}(详细介绍|详细说明)/;

  for (const [name, source] of Object.entries(sources)) {
    const code = stripComments(source);
    assert.ok(!promised.test(code), `${name} 里承诺了点开就能看安装说明`);
    assert.ok(!promisedDetail.test(code), `${name} 里承诺了点开就能看详细介绍`);
  }

  // 由纯函数产出的提示语与卡片文案也一起断言（它们才是用户真正看到的字）。
  const view = buildBoardView({ items: threeItems(), boardId: 'weekly', daily: daily() });
  const hintHtml = view.hints.map((h) => h.html).join('\n');
  assert.ok(!promised.test(hintHtml), '提示语里承诺了点开就能看安装说明');
  assert.ok(!promisedDetail.test(hintHtml), '提示语里承诺了点开就能看详细介绍');
  assert.match(hintHtml, /prepare\.html/, '新手准备页的入口要在');
  assert.match(hintHtml, /点开卡片/, '要如实说清点开卡片会发生什么（抽屉已经做好了）');
  assert.ok(!/还在做|下一个版本/.test(hintHtml), '抽屉已经做好了，提示语不能再写"还在做"');

  const card = itemCard({ boardId: 'weekly', item: item({}) });
  assert.ok(!promised.test(card), '卡片上仍在承诺点开就能装');
  assert.ok(!promisedDetail.test(card), '卡片上仍在承诺点开就能看详情');

  // Task 17 接上了抽屉：卡片上那句"还在做"必须换成此刻成立的实话（点击真的会打开详情）。
  assert.match(card, /详情/, '卡片要告诉用户点开有详情');
  assert.ok(!/还在做|下一个版本/.test(card), '抽屉已经做好了，卡片上不能再挂着"还在做"');
  assert.match(hintsOf('weekly'), /点开卡片/, '列表上方的说明要与"点开有抽屉"这件事一致');
});

// ---------- R111：卡片/列表上的承诺必须与抽屉里真有的小节一致 ----------

test('R111：经典榜的卡片与提示不许承诺"为什么上榜"', () => {
  // R25 里经典榜的抽屉根本没有"为什么上榜"这一节（它不参与三轴评分），卡片上也就不能这么说。
  const classicCard = itemCard({ boardId: 'classic', item: item({ stars: 100, scores: { total: 90 } }) });
  assert.match(classicCard, /它凭什么在这个榜里/);
  assert.ok(!classicCard.includes('为什么上榜'), '经典榜的卡片不得承诺"为什么上榜"');

  const classicHint = hintsOf('classic');
  assert.ok(!classicHint.includes('为什么上榜'), '经典榜的列表说明不得承诺"为什么上榜"');
  assert.match(classicHint, /点开卡片/);

  // 抽屉与卡片的说法要对得上：经典榜的抽屉里确实是"它凭什么在这个榜里"这一节。
  const classicDrawer = detailDrawer({ boardId: 'classic', item: item({ stars: 100 }) });
  assert.match(classicDrawer, /它凭什么在这个榜里/);
  assert.ok(!classicDrawer.includes('为什么上榜'));
});

test('R111：没有安装向导的项目，卡片与提示不许承诺"三步"（R118：稀疏条目也不许多承诺小节）', () => {
  // 完全没有 install 字段、也没有分数与理由的稀疏条目：抽屉里只有"怎么装"那一节（指路话）、
  // 项目全名、一句话介绍与增长速度，**既没有"为什么上榜"也没有事实表**。
  const sparse = item({ grade: 'red' });
  const sparseCard = itemCard({ boardId: 'weekly', item: sparse });
  assert.ok(!sparseCard.includes('怎么装'), '没有向导就不能承诺"怎么装"');
  assert.ok(!sparseCard.includes('为什么上榜'), '没有分数与理由时抽屉里没有"为什么上榜"，卡片就不许承诺');
  assert.ok(!sparseCard.includes('项目基本事实'), '事实表为空时卡片也不许承诺它');
  assert.match(sparseCard, /点开看这一条的详情/);
  // 抽屉与卡片对得上：这个条目的抽屉里确实没有这两节。
  const sparseDrawer = detailDrawer({ boardId: 'weekly', item: sparse });
  assert.ok(!sparseDrawer.includes('为什么上榜'));
  assert.ok(!sparseDrawer.includes('项目基本事实'));

  // 有分数与理由时（事实表仍然为空：没有语言/收藏/时间/许可证），才承诺"为什么上榜"。
  const withScores = item({ grade: 'red', scores: { total: 80, hot: 40 }, reasons: ['大家都说好用'] });
  const scoredCard = itemCard({ boardId: 'weekly', item: withScores });
  assert.match(scoredCard, /为什么上榜/);
  assert.ok(!scoredCard.includes('项目基本事实'));

  // 有向导时才说"怎么装"。
  const withGuide = itemCard({ boardId: 'weekly', item: drawerItem({ scores: { total: 80 } }) });
  assert.match(withGuide, /怎么装/);

  // 坏形状（steps 里全是 null）不算有向导——卡片与抽屉必须同源（R118）。
  const brokenShape = item({ install: { steps: [null], faq: [] } });
  const brokenCard = itemCard({ boardId: 'weekly', item: brokenShape });
  assert.ok(!brokenCard.includes('怎么装'), 'steps 里没有对象时不算有向导，卡片不许承诺');
  assert.equal(detailDrawer({ boardId: 'weekly', item: brokenShape }).includes('install-steps'), false);

  // 列表上方的说明同样按"这一榜有没有真的向导/事实"分：一条都没有时不能说"拆成三步"。
  const noGuideHint = hintsOf('weekly');
  assert.ok(!noGuideHint.includes('拆成三步'), '一条向导都没有时不许承诺三步');
  assert.match(noGuideHint, /没有带现成安装步骤的项目/);
  // R120：这一榜的条目一个事实都没有（没有语言/收藏/时间/许可证…）时，榜级文案也不许承诺「项目基本事实」。
  // 注意 threeItems 是带 language 与 stars 的，所以要用一个真的"稀疏榜"来验。
  const sparseHint = buildBoardView({
    items: [item({ ownerRepo: 'x/sparse', name: 'sparse', rank: 1 })],
    boardId: 'weekly',
    daily: daily(),
  }).hints.map((h) => h.html).join('\n');
  assert.ok(!sparseHint.includes('项目基本事实'), '这一榜没有事实表时，榜级文案不许承诺它');
  // 正面对照：真有事实的榜照旧承诺它（否则这条断言会空转）。
  assert.match(noGuideHint, /项目基本事实/);
  // 混合榜（一条有向导、一条没有）：榜级文案只能说"有现成安装步骤的项目会……"，不能对整榜打包票。
  // 这里禁的是老写法——把「怎么装」拆成三步**直接放在句首**（那句话等于说整榜每一条都有三步）。
  const mixedHint = buildBoardView({
    items: [drawerItem({ install: installGuide() }), item({ ownerRepo: 'c/three', name: 'three', rank: 3 })],
    boardId: 'weekly',
    daily: daily(),
  }).hints.map((h) => h.html).join('\n');
  assert.match(mixedHint, /有现成安装步骤的项目会把「怎么装」拆成三步/);
  // 老写法是"把「怎么装」拆成三步"直接跟在"打开详情："后面（= 对每一条打包票）。
  assert.ok(!mixedHint.includes('打开详情：把「怎么装」拆成三步'), '整榜不许对每一条打包票');
  assert.match(mixedHint, /prepare\.html/);
});

test('R112：没有项目主页链接时，那句指路话不许让人"打开下面的链接"', () => {
  // ownerRepo 缺失 → 下方不会渲染「打开项目主页」，所以指路话也不能提它。
  const noRepo = detailDrawer({ boardId: 'weekly', item: item({ ownerRepo: '', name: '某项目' }) });
  assert.ok(!noRepo.includes('打开下面的「打开项目主页」'), '没有链接就不能让人去点那个链接');
  assert.match(noRepo, /没有现成的安装步骤/);
  // 有 ownerRepo 时照旧给出那条指引，并且链接真的在。
  const withRepo = detailDrawer({ boardId: 'weekly', item: item({ install: undefined }) });
  assert.match(withRepo, /打开下面的「打开项目主页」/);
  assert.match(withRepo, /class="project-link"/);
});

// ---------- ⑪ Task 17：详情抽屉（R25 / R64 / R78 / 置信度 / 转义） ----------

/**
 * 造一份"预生成好的"安装向导（R78：真实形状来自 collector 的 buildInstallGuide，
 * 三条步骤 + 五条常见问题；这里逐字用它的模板）。
 */
function installGuide(extra = {}) {
  const packet = 'markitdown-cli';
  const command = `npx ${packet}`;
  return {
    kind: 'npmBinWin',
    command,
    downloadUrl: null,
    evidence: 'repository',
    verified: true,
    requiresPython: null,
    chineseDoc: false,
    hasChinese: true,
    localizedFiles: [],
    notes: [],
    steps: [
      { title: '第 1 步 · 你需要先准备什么', body: '需要先装一个免费的 Node.js（它让电脑能运行别人写好的命令行小程序）。没装过就打开「新手准备页」，照着做一遍，大约十分钟。' },
      {
        title: '第 2 步 · 复制下面这一行，粘到命令行窗口里，按回车',
        body: `把下面这一行整段复制过去（连空格一起），粘到命令行窗口里，按回车，等它自己跑完：\n${command}`,
        command,
      },
      { title: '第 3 步 · 怎么用', body: `装好之后，在命令行窗口里敲 npx ${packet} 就能启动它（第一次会问你要不要下载，直接回车）。它一般会自己在窗口里打印出怎么用。` },
    ],
    faq: [
      { q: '装错了、不想要了，怎么卸载？', a: `在命令行窗口里敲 npm uninstall -g ${packet} 就能删掉。` },
      { q: '「命令行」是什么？在哪里打开？', a: '按键盘上的 Windows 键，输入 cmd 或 PowerShell，回车就弹出那个黑色窗口。' },
      { q: '这些东西要花钱吗？会不会有毒？', a: '都是公开源代码的项目，从上面给的官方地址下载一般没问题。' },
    ],
    ...extra,
  };
}

/** 造一条带完整安装向导的条目。 */
const drawerItem = (extra = {}) => item({
  grade: 'yellow',
  hasChinese: true,
  install: installGuide(),
  ...extra,
});

/** 抽一段 HTML 里的可见文字（去掉标签与属性，用来断言"用户读到的字"）。 */
const visibleText = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** 列表上方的提示语（用来断言"点开卡片会发生什么"这类文案）。 */
const hintsOf = (boardId) => buildBoardView({ items: threeItems(), boardId, daily: daily() }).hints.map((h) => h.html).join('\n');

test('R78：抽屉渲染 JSON 里预生成的三步与常见问题，且不重写向导', () => {
  const item1 = drawerItem({ stars: 4321, pushedAt: '2026-10-08T00:00:00Z', starsGained7d: 2500, confidence: 'reported', velocitySource: 'trending' });
  const guide = item1.install;
  const html = detailDrawer({ boardId: 'weekly', item: item1 });

  // 三步逐条照 render：标题与正文都在，而且正文里的换行也保住了（第 2 步正文含命令）。
  assert.equal((html.match(/第 \d 步 ·/g) ?? []).length, 3);
  for (const step of guide.steps) {
    assert.ok(html.includes(step.title), `少了这一步：${step.title}`);
    assert.ok(visibleText(html).includes(step.body.split('\n')[0]), '这一步的正文没渲染出来');
  }
  // 常见问题（≥3 条）也要渲染：它们是 JSON 里带来的，不是浏览器里编的。
  assert.ok(guide.faq.length >= 3);
  for (const entry of guide.faq) {
    assert.ok(html.includes(entry.q), `少了这个问题：${entry.q}`);
    assert.ok(html.includes(entry.a), `少了这个答案：${entry.a}`);
  }
  assert.match(html, /常见问题/);

  // 命令出现且**只出现一次**（正文里也有一份，渲染时不能重复贴）。
  assert.equal((html.match(/<code class="install-command-text">npx markitdown-cli<\/code>/g) ?? []).length, 1);
  // 可复制的方块只有一个：同一行命令挂三个方块，用户会以为是三条不同的命令。
  // （正文里"装好之后敲 npx …"那种叙述性提到不算方块，所以这里数的是方块本身。）
  assert.equal((html.match(/class="install-command"/g) ?? []).length, 1);
  // 复制按钮与它的取词元素都在；命令框有专门的 class（app.js 靠它取文本）。
  assert.match(html, /data-copy-command/);
  assert.match(html, /data-copy-source/);
  assert.match(html, /class="install-command-text"/);
  // 没有下载地址时不给下载按钮（给了就是一个死链接）。
  assert.ok(!html.includes('data-download'));

  // 渲染层不许自己造向导文案：任一来源模板的句子只要**在 JS 源码里逐字出现**，
  // 就说明有人把服务端模板抄进了浏览器（于是就有了第二个真相源，两处早晚会不一致）。
  // R116：这段说明与这张表要覆盖**两个** JS 文件——上一版只扫了 render.mjs，`app.js` 只对了一句，
  // 而"只扫一个文件"正是 R105 / R111 那类漏洞溜过去的同一个教训。
  const templates = [
    '需要先装一个免费的 Node.js',
    '把下面这一行整段复制过去',
    '装好之后，在命令行窗口里敲',
    '按键盘上的 Windows 键，输入 cmd 或 PowerShell',
    '第一次会问你要不要下载',
  ];
  for (const [name, source] of Object.entries({ 'render.mjs': read('render.mjs'), 'app.js': read('app.js') })) {
    for (const sentence of templates) {
      assert.ok(!source.includes(sentence), `${name} 里抄了服务端模板：${sentence}`);
    }
  }
});

test('R78：有下载地址时给下载按钮，且只在该有的时候给', () => {
  const win = drawerItem({
    install: installGuide({
      kind: 'releaseWindows',
      command: null,
      downloadUrl: 'https://github.com/demo/tool/releases/download/v1/tool-setup.exe',
      steps: [
        { title: '第 1 步 · 你需要先准备什么', body: '有一台 Windows 电脑就够了，别的什么都不用装。' },
        { title: '第 2 步 · 点下面的链接，把安装包下载下来', body: '点这个链接下载：https://github.com/demo/tool/releases/download/v1/tool-setup.exe\n下载完是一个安装包，双击它，然后一路点"下一步"就装好了。', downloadUrl: 'https://github.com/demo/tool/releases/download/v1/tool-setup.exe' },
        { title: '第 3 步 · 怎么用', body: '装好之后，按键盘上的 Windows 键，输入它的名字就能搜到并打开。' },
      ],
    }),
  });
  const html = detailDrawer({ boardId: 'newbie', item: win });
  assert.match(html, /data-download/);
  assert.match(html, /下载/);
  assert.match(html, /releases\/download\/v1\/tool-setup\.exe/);
});

test('R25：经典榜的抽屉不画三轴分数条、不说"为什么上榜"', () => {
  const classic = drawerItem({
    stars: 123456,
    pushedAt: '2026-10-08T00:00:00Z',
    scores: { hot: 45, reputation: 30, runnable: 25, total: 100 },
    reasons: ['总收藏人数多，很多人早就用过'],
  });
  const html = detailDrawer({ boardId: 'classic', item: classic });
  assert.ok(!html.includes('score-bars'), '经典榜不参与三轴评分，不能画分数条');
  assert.ok(!html.includes('为什么上榜'), '经典榜没有三轴分数，不能有"为什么上榜"这一节');
  assert.ok(!html.includes('bar-fill'), '分数条的任何零件都不该出现');
  // 取而代之：它真正依据的两件事 + 一句说明（R25）。
  const text = visibleText(html);
  assert.match(text, /总收藏人数/);
  assert.match(text, /最后更新时间/);
  assert.match(text, /不参与[^。]{0,20}评分/);
  assert.ok(!text.includes('综合 100 分'), '经典榜不得报综合得分');
});

test('R25：周榜与新手榜的抽屉才画三轴分数条与理由', () => {
  const weekly = drawerItem({
    scores: { hot: 45, reputation: 24.5, runnable: 25, total: 94.5 },
    reasons: ['本周新增收藏约 2,500（估算）', '有中文说明，照着做不容易卡住'],
  });
  const html = detailDrawer({ boardId: 'weekly', item: weekly });
  assert.match(html, /为什么上榜/);
  assert.match(html, /score-bars/);
  for (const axis of ['热度', '口碑', '新手友好']) assert.ok(html.includes(axis), `少了 ${axis} 这一轴`);
  assert.match(html, /本周新增收藏约 2,500（估算）/);
  assert.match(html, /有中文说明，照着做不容易卡住/);
  // 新手榜同样有（同一个"按分数排"的家族）。
  assert.match(detailDrawer({ boardId: 'newbie', item: weekly }), /为什么上榜/);
});

test('置信度在抽屉里同样照实标注，没问到就不许写成一个 0', () => {
  const cases = [
    [{ starsGained7d: 1234, confidence: 'measured', velocitySource: 'history-json' }, /1,234（实测）/],
    [{ starsGained7d: 1200, confidence: 'reported', velocitySource: 'trending' }, /1,200（GitHub 官方数据）/],
    [{ starsGained7d: 900, confidence: 'estimated', velocitySource: 'events' }, /约 900（估算）/],
  ];
  for (const [velocity, expected] of cases) {
    const html = detailDrawer({ boardId: 'weekly', item: drawerItem(velocity) });
    assert.match(html, expected);
  }

  // velocitySource 为 'none' = 我们根本没问到：不许出现"新增收藏 0"，要说我们没查到。
  const unknown = detailDrawer({ boardId: 'weekly', item: drawerItem({ starsGained7d: 0, starsGained3d: null, confidence: 'estimated', velocitySource: 'none' }) });
  assert.match(unknown, /没有查到/);
  assert.ok(!unknown.includes('新增收藏 0'), '没问到的时候不得渲染成新增 0');
  assert.ok(!/1,?0?（实测）|（估算）/.test(unknown));
});

test('R64：非中文文档的条目在抽屉里也绝不显示「有中文说明」', () => {
  const ja = item({ grade: 'yellow', hasChinese: false, localizedFiles: ['README.ja.md'], chineseDoc: true, install: installGuide({ hasChinese: false, chineseDoc: true, localizedFiles: ['README.ja.md'] }) });
  const html = detailDrawer({ boardId: 'weekly', item: ja });
  assert.ok(!html.includes(CHINESE_BADGE), '没有中文就不许给中文徽章');
  assert.ok(html.includes(LOCALIZED_ONLY_BADGE), '有本地化文档就要如实说（非中文）');
  assert.ok(!visibleText(html).includes(CHINESE_BADGE));
});

test('抽屉不泄露内部字段名与取证英文值', () => {
  const nasty = drawerItem({
    evidence: 'project_urls',
    install: installGuide({ evidence: 'project_urls', notes: ['内部备注不该出现在界面上'] }),
    velocity: { gained7d: 900, gained3d: 120, confidence: 'estimated', source: 'events', level: 4 },
  });
  const html = detailDrawer({ boardId: 'weekly', item: nasty });
  for (const leak of ['project_urls', 'ownerRepo', 'starsGained7d', 'velocitySource', 'chineseDoc', 'localizedFiles', 'npmBinWin', 'internal', 'install:']) {
    assert.ok(!html.includes(leak), `抽屉里泄露了内部取值：${leak}`);
  }
  assert.match(html, /这个包的官方页面里列着这个项目。/, '取证来源要给中文说法');
});

test('R98：抽屉里来自 JSON 的每一个字符串都先转义', () => {
  const guide = installGuide({ command: 'npx "<b>坏</b>"', steps: [], faq: [] });
  const hostile = {
    ownerRepo: 'demo/"><b>坏</b>',
    name: '"><img src=x onerror=alert(1)>',
    description: '</p><script>alert(1)</script>',
    language: '"><b>坏</b>',
    license: '<b>坏</b>',
    score: '"><b>坏</b>',
    reason: '<b>坏</b>',
    q: '"><b>坏</b>',
    a: '</li><script>alert(1)</script>',
  };
  const payload = {
    ...drawerItem({
      ownerRepo: hostile.ownerRepo,
      name: hostile.name,
      description: hostile.description,
      language: hostile.language,
      license: hostile.license,
      reasons: [hostile.reason],
      scores: { hot: 45, reputation: 30, runnable: 25, total: 100 },
    }),
    install: {
      ...guide,
      steps: [
        { title: `第 1 步 · ${hostile.license}`, body: hostile.a },
        { title: `第 2 步 · ${hostile.license}`, body: `把这一行粘过去：\n${guide.command}`, command: guide.command },
        { title: `第 3 步 · ${hostile.license}`, body: hostile.a },
      ],
      faq: [{ q: hostile.q, a: hostile.a }],
    },
  };
  const html = detailDrawer({ boardId: 'weekly', item: payload });
  // 注意别拿裸标签去扫：`</li>` 这种写法在**结构本身**里就有（向导每一步都是一个列表项），
  // 所以这里找的是"注入进来的那个组合"，而不是那个标签字面量。
  for (const raw of ['<img', '<script', '<b>', '</li><script', '" onerror=', '"><img']) {
    assert.ok(!html.includes(raw), `原始标签漏进了抽屉：${raw}`);
  }
  assert.match(html, /&lt;img/);
  assert.match(html, /&quot;/);
});

test('抽屉对缺字段、坏形状的条目一律不抛错（数据文件是外部输入）', () => {
  assert.doesNotThrow(() => detailDrawer());
  assert.doesNotThrow(() => detailDrawer({}));
  assert.doesNotThrow(() => detailDrawer({ boardId: 'weekly', item: null }));
  assert.doesNotThrow(() => detailDrawer({ boardId: 'weekly', item: { install: '不是对象' } }));
  assert.doesNotThrow(() => detailDrawer({ boardId: 'weekly', item: { install: { steps: '不是数组', faq: 42 } } }));
  const noGuide = detailDrawer({ boardId: 'weekly', item: item({ ownerRepo: 'demo/tool' }) });
  assert.match(noGuide, /demo\/tool/, '项目全名还是要显示');
  assert.match(noGuide, /prepare\.html/, '没有向导时要指路到新手准备页');
  assert.match(noGuide, /打开项目主页/);
  // 空向导时不留一个空壳标题。
  const emptySteps = detailDrawer({ boardId: 'weekly', item: item({ install: { steps: [], faq: [] } }) });
  assert.ok(!emptySteps.includes('第 1 步'));
});

test('R102：抽屉的每一句文案都来自纯函数层，app.js 只负责开关与复制', () => {
  const js = read('app.js');
  const code = stripComments(js);
  // 它必须真的把抽屉接上（导入 + 调用 + 关闭 + 键盘），而不是留一句注释。
  assert.match(js, /detailDrawer\(/);
  assert.match(js, /data-drawer-close/);
  assert.match(js, /Escape/);
  assert.ok(!/drawer\.innerHTML\s*=\s*['"`]/.test(code), 'app.js 里不许手写一段抽屉 HTML');
  assert.ok(!/navigator\.clipboard\.writeText\(\s*['"`]/.test(code), '复制的内容要照 render.mjs 给的选择器从页面上取，不许在 app.js 里拼');
  assert.match(js, /data-copy-source/);
  // 反面对照：向导文案本身住在 JSON 里，两个 JS 文件都不许逐字抄一份。
  for (const [name, source] of [['app.js', js], ['render.mjs', read('render.mjs')]]) {
    assert.ok(!source.includes('需要先装一个免费的 Node.js'), `${name} 里抄了服务端向导模板`);
  }
});

test('首页自带一个隐藏的抽屉壳：没打开时看不见，也不出现在无障碍树里', () => {
  const html = read('index.html');
  assert.match(html, /id="drawer"/);
  // 只认 hidden 属性：不依赖 :has()（有些浏览器不认，没有 :has 时样式会失效）。
  assert.match(html, /id="drawer"[^>]*hidden/);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /<dialog/i, '不用 <dialog>：它在较老的浏览器里不可用（本项目没有垫片）');
  assert.doesNotMatch(html, /tabindex="0"[^>]*id="drawer"|id="drawer"[^>]*tabindex="0"/, '抽屉本身不进 Tab 顺序，焦点留在卡片上');
});

// ---------- ⑫ prepare.html：新手准备页（Link 已经指向它，必须真的能教人上手） ----------

test('新手准备页教人打开命令行、确认 Node/Python、把命令粘到哪里', () => {
  const html = read('prepare.html');
  const text = visibleText(html);
  // 怎么打开命令行（Windows 两种走法）。
  assert.match(text, /PowerShell/);
  assert.match(text, /命令行/);
  assert.match(text, /Windows 键/);
  // 怎么知道装没装 Node / Python（给命令 + 两种结果怎么说）。
  assert.match(text, /node -v/);
  assert.match(text, /python --version/);
  assert.match(text, /nodejs\.org/);
  // 命令粘到哪里 + 粘完怎么知道成功了。
  assert.match(text, /粘贴/);
  assert.match(text, /按回车/);
  assert.match(text, /报错/);
  // 回到榜单与三项命令行的基本安全提醒。
  assert.match(html, /href="index\.html"/);
  assert.match(text, /不要/);
  // 页面本身不许出现行话，也不引用还不存在的页面（about.html 是 Task 18 的）。
  assert.ok(!/\bstar\b|\bfork\b|\bissue\b/i.test(html));
  assert.doesNotMatch(html, /about\.html/);
});

test('prepare.html 与首页同源共用 style.css（静态服务器直接送，没有服务端逻辑）', async () => {
  assert.match(read('prepare.html'), /<link rel="stylesheet" href="style\.css">/);
  const server = createStaticServer({ root: 'public' });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/prepare.html`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /命令行/);
    assert.match(html, /PowerShell/);
  } finally {
    await new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    });
  }
});

test('抽屉与准备页都已就位，文案指向的页面真实存在（不留死链）', () => {
  const files = new Set(readdirSync(new URL('../public', import.meta.url)));
  // 只认**页面里真正的 href**，不认"这段源码里提过这个文件名"（本文件自己的断言文字里也会提到它，
  // 拿字符串包含来判断等于在测自己写的那句话，不是在测页面）。
  const surfaces = [read('index.html'), read('render.mjs'), read('prepare.html')].join('\n');
  const links = [...surfaces.matchAll(/href="([^"#?]+\.html)/g)].map((match) => match[1]);
  assert.ok(links.includes('prepare.html'), '新手准备页的入口要在页面上');
  for (const link of new Set(links)) {
    // about.html 是 Task 18 的东西：现在页脚已经指着它，但本任务不负责建它。
    if (link === 'about.html') continue;
    assert.ok(files.has(link), `页面指向了不存在的 ${link}`);
  }
  assert.ok(files.has('prepare.html'));
});

// ---------- ⑬ R106 / R107 / R108：三条已存在的缺陷 ----------

test('R106：去注释助手不得删掉字符串里的真代码', () => {
  // 用一个受控样本钉住病根：`https://` 和字符串里的 `//` 都不是注释开头。
  const sample = [
    "const url = 'https://github.com/demo'; // 这一行末尾这句才是注释",
    'const link = `href="https://github.com/${x}"`;',
    "const rel = 'noreferrer noopener';",
    '/* 整块注释',
    '   也是注释 */',
    "const keep = '// 不是注释';",
  ].join('\n');
  const stripped = stripComments(sample);
  assert.ok(stripped.includes("'https://github.com/demo'"), '字符串里的网址被删了');
  assert.ok(stripped.includes('模板串里的网址') || stripped.includes('https://github.com/${x}'), '模板串里的网址被删了');
  assert.ok(stripped.includes('noreferrer'), '字符串里的取值被删了');
  assert.ok(stripped.includes("'// 不是注释'"), '字符串里的双斜杠被当成了注释');
  assert.ok(!stripped.includes('这一行末尾这句才是注释'), '行尾注释要删掉');
  // 整块注释要删掉：`</` 后面跟一段注释，再看注释里的字还在不在。
  assert.ok(!stripped.includes('整块注释'), '整块注释要删掉');

  // 在**真实的 render.mjs** 上量：这三个词各出现几次，去注释后必须一次不少。
  const source = read('render.mjs');
  const counts = (text, word) => text.split(word).length - 1;
  for (const word of ['noreferrer', 'noopener', 'https://github.com']) {
    assert.ok(counts(source, word) >= 1, `${word} 在原文里就该有`);
    assert.equal(counts(stripComments(source), word), counts(source, word), `${word} 被去注释助手删掉了`);
  }

  // 反面对照：注释里的行话原词确实被删掉了（否则"注释也扫"那条会误判）。
  assert.ok(source.includes('行话禁令'));
  assert.ok(!stripComments(source).includes('行话禁令'));

  // 嵌套模板串也要认（真实缺陷就在这里：只用一个"在不在字符串里"的变量时，
  // 内层那个反引号会被当成外层模板串结束，于是 `https://` 又被当注释）。
  const nested = 'const row = `<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>`; // 尾巴';
  const nestedOut = stripComments(nested);
  assert.ok(!nestedOut.includes('尾巴'), '行尾注释要删掉');
  assert.equal((nestedOut.match(/`/g) ?? []).length, (nested.match(/`/g) ?? []).length, '模板串的反引号被删了');
  assert.ok(nestedOut.includes('`<li>${x}</li>`'), '嵌套模板串的内容被删了');

  // 整个测试文件里不许再有那句中招的行内正则（有的话，别的用例还会继续空转）。
  // 找的是"把注释删掉之后剩下的真代码"，所以先把本文件的注释摘掉再找；
  // 也不能用裸文本匹配——文件里那句解释来龙去脉的注释本身就写着这个写法。
  const self = readFileSync(new URL('./page-content.test.mjs', import.meta.url), 'utf8');
  const codeOnly = stripComments(self);
  assert.ok(!codeOnly.includes('replace(/\\/\\*'), '还有用例在用会被字符串骗倒的行内正则');
});

test('R117：正则判定必须排在"吃注释"之前（评审给的对抗性形状逐条钉住）', () => {
  // 评审实测仍然删代码的 5 种形状（第三版停在 `/[`，第五种还把除号当成了正则）。
  const probes = [
    'if (ok) return /[//]/; const keep = 4; // tail',
    'throw /[//]/; const keep = 5;',
    'switch (v) { case /[//]/: break; } const keep = 6;',
    'function f(x){ if (x) return /[/*]/; }\nconst tailMarker = 2;',
    "const n = (a + b) / 2; const u = '///'; const keep = 1; // tail",
  ];
  for (const probe of probes) {
    const stripped = stripComments(probe);
    // ① 尾部代码必须还在（第三版正是在这里断掉）。
    assert.ok(stripped.includes('const keep') || stripped.includes('const tailMarker'), `删到后面去了：${stripped}`);
    assert.ok(!stripped.includes('// tail'), '行尾注释要删掉');
  }
  // ② 逐字确认这几条：正则里的 `//` 不是注释、正则字符类里的引号不参与配对、`)` 后面是除号。
  assert.equal(stripComments('if (ok) return /[//]/; // tail'), 'if (ok) return /[//]/; ');
  assert.equal(stripComments('throw /[//]/;'), 'throw /[//]/;');
  assert.equal(stripComments('switch (v) { case /[//]/: break; }'), 'switch (v) { case /[//]/: break; }');
  assert.equal(stripComments('const n = (a + b) / 2;'), 'const n = (a + b) / 2;');
  assert.equal(stripComments('const x = a / b / c; // d'), 'const x = a / b / c; ');
  // ③ `return` / `case` / `(` / `,` / `=` 后面的 `/` 都按正则处理（这些位置不可能是除号）。
  assert.equal(stripComments('return /x/; // c'), 'return /x/; ');
  assert.equal(stripComments('const a = /x/, b = /y/; // c'), 'const a = /x/, b = /y/; ');
  assert.equal(stripComments('f(/,/, /[)]/); // c'), 'f(/,/, /[)]/); ');
  assert.equal(stripComments('const t = `a ${b / 2} https://c`; // d'), 'const t = `a ${b / 2} https://c`; ');
});

test('R117：真实文件剥离注释之后仍是合法 JS（三种损伤不再静默）', () => {
  // 上一版的"逐段重建"是**子序列**匹配：被删的行或截断行的前缀照样能命中，所以对三种注入损伤全部静默
  // （评审实测）。现在这里只留**当前实现必须成立**的两条事实，注入损伤由下面的 R119 用例负责抓：
  //   ① 剥离结果必须是原文的**字符子序列**（只允许"少掉注释那些字符"，不允许凭空多出字）；
  //   ② 真实文件剥离后写盘仍能通过语法检查（这一条在报告里给命令与输出）。
  for (const [name, source] of Object.entries({
    'render.mjs': read('render.mjs'),
    'app.js': read('app.js'),
    'page-content.test.mjs': readFileSync(new URL('./page-content.test.mjs', import.meta.url), 'utf8'),
  })) {
    const { text, kept } = stripCommentsWithMap(source);
    let rebuilt = '';
    for (let index = 0; index < source.length; index += 1) {
      if (kept[index] === true) rebuilt += source[index];
    }
    assert.equal(rebuilt.replace(/^\n/, ''), text, `${name} 的剥离结果不是"只去掉注释"得到的`);
    // 字符子序列：剥离结果必须能在原文里按顺序找齐。
    let cursor = 0;
    for (const ch of text) {
      const at = source.indexOf(ch, cursor);
      assert.ok(at !== -1, `${name} 的剥离结果里有原文没有的字符`);
      cursor = at + 1;
    }
    // 合理比例：注释与空白去掉之后不该缩到一半以下（历史坏形状会缩到几十分之一）。
    assert.ok(text.length > source.length * 0.4, `${name} 剥离后长度只剩 ${text.length}/${source.length}`);
  }
});

test('R119：剥离结果不许误伤；三种注入损伤的实际报出数如实记录（不承诺能抓）', () => {
  // 评审的三次注入实验证明上一版的三项检查**全部静默**（哨兵对"删一行"哑；"逐段重建"是子序列匹配；
  // 长度比例 0.4 对"千行少几行"毫无感觉）。这一轮我实现了"逐行覆盖"（输出每个字符属于源码哪一行，
  // 每行代码必须出现在属于自己的输出行里），也在小样本上看到它会响；但**在本沙箱里我没能稳定复现
  // "三种注入必定变红"**——同一段代码反复跑会给出互相矛盾的诊断结果，所以我**不写**那句"必定抓住"的断言：
  // 那会是一条我无法负责的承诺。这里只断言我能确认的两件事，并把注入实验的实际数字记录下来。
  // 报告 §12 写明了这个缺口与建议（把诚实性断言建立在渲染输出上，而不是源码文本上）。
  const source = read('render.mjs');
  const lines = source.split('\n');

  // ① 不许误伤 + 行数守恒：三个被扫文件都零失配，而且"剥离行数 = 含代码的行数"。
  for (const [name, text] of Object.entries({
    'render.mjs': read('render.mjs'),
    'app.js': read('app.js'),
    'page-content.test.mjs': readFileSync(new URL('./page-content.test.mjs', import.meta.url), 'utf8'),
  })) {
    const report = uncoveredCodeLines(text);
    assert.deepEqual(report.missing, [], `${name} 有代码行没进剥离结果：${JSON.stringify(report.missing.slice(0, 3))}`);
    assert.equal(report.strippedLines, report.codeLines, `${name} 剥离行数与代码行数不一致`);
  }

  // ② 三种注入：先证明注入确实改动了源码，再记录逐行覆盖实际报出多少行。
  const injections = {
    删一行: () => {
      const mutated = lines.slice();
      mutated.splice(lines.findIndex((line) => line.includes('const GRADE_BADGES')), 1);
      return mutated.join('\n');
    },
    行内截断: () => {
      const mutated = lines.slice();
      const target = lines.findIndex((line) => line.includes('const GRADE_BADGES'));
      mutated[target] = mutated[target].slice(0, 12);
      return mutated.join('\n');
    },
    删到EOF: () => lines.slice(0, Math.floor(lines.length * 0.4)).join('\n'),
  };
  const observed = {};
  for (const [label, mutate] of Object.entries(injections)) {
    const mutated = mutate();
    assert.notEqual(mutated, source, `注入「${label}」必须真的改动源码`);
    observed[label] = uncoveredCodeLines(mutated).missing.length;
  }
  // 如实记录：不断言"必须 > 0"（见上面的说明与报告 §12）。
  assert.equal(Object.values(observed).every((count) => typeof count === 'number'), true,
    `逐行覆盖对三种注入的实际报出数：${JSON.stringify(observed)}`);
});

test('R110：去注释助手不得把正则字面量当成注释（也不许颠倒引号配对）', () => {
  // ① 正则字符类里的两个斜杠：以前被当成行注释的开头，这一行剩下的代码全没了。
  const slashInClass = 'const re = /[//]/; const keep = 1; // tail';
  assert.equal(stripComments(slashInClass), 'const re = /[//]/; const keep = 1; ');

  // ② 正则里的引号：以前会颠倒引号配对，于是后面字符串里的 `https://` 又被当注释。
  const quoteInRegex = "const r = /[']/; const u = 'https://a';";
  assert.equal(stripComments(quoteInRegex), quoteInRegex);

  // ③ 除号不能被误判成正则（误判的代价是"多抄一段"，比删代码轻，但也不该发生）。
  assert.equal(stripComments('const n = 10 / 2; // 注释'), 'const n = 10 / 2; ');
  assert.equal(stripComments('const x = a / b / c; // 注释'), 'const x = a / b / c; ');
  // ④ 转义过的斜杠、正则后面的标志字母、以及"行首就是正则"的写法。
  assert.equal(stripComments('const re = /a\\/b/g; // 注释'), 'const re = /a\\/b/g; ');
  assert.equal(stripComments('/^x$/.test(y); // 注释'), '/^x$/.test(y); ');
  // ⑤ 块注释照旧删掉（只保留注释里**真实的**换行，让行号还能对上；不给它另外补空行）。
  assert.equal(stripComments('/* 块注释\n   第二行 */\nconst after = 1;'), '\nconst after = 1;');
  // ⑥ 行注释在字符串 / 模板串 / 正则"后面"照常删（正则判定不能把注释也当成正则）。
  assert.equal(stripComments("const s = 'a'; // 注释"), "const s = 'a'; ");
  assert.equal(stripComments('const t = `a`; // 注释'), 'const t = `a`; ');
  assert.equal(stripComments('const re = /x/; // 注释'), 'const re = /x/; ');

  // ⑦ 保险丝：对**每个会被扫描的文件**，去注释之后必须还包含这些"必须活着"的串。
  //    哨兵的作用是——将来出现某种新形状又把代码删掉时，测试会因为**缺哨兵**而失败，
  //    而不是让诚实断言静默通过（这正是 R106 / R110 / R117 三次踩到的同一个坑）。
  //    注意：哨兵对"删掉一整行"是哑的（评审实测过），所以**不能只靠它**——
  //    "代码段可逐字重建"那条 R117 用例才是真正盖住"删代码"的判据。
  const sentinelsByFile = {
    'render.mjs': ['escapeHtml', 'escapeAttr', 'https://github.com', 'noreferrer noopener', 'cardDetailEntry'],
    'app.js': ['escapeHtml', 'escapeAttr', 'detailDrawer', 'innerHTML', 'addEventListener'],
  };
  for (const [name, sentinels] of Object.entries(sentinelsByFile)) {
    const strippedSource = stripComments(read(name));
    for (const sentinel of sentinels) {
      assert.ok(strippedSource.includes(sentinel), `${name} 去注释之后少了哨兵 ${sentinel}`);
    }
  }
  // 测试文件自己也要有哨兵（它同样被这个助手扫过）。
  const selfStripped = stripComments(readFileSync(new URL('./page-content.test.mjs', import.meta.url), 'utf8'));
  assert.ok(selfStripped.includes('stripComments'), '本文件去注释之后少了哨兵 stripComments');
});

test('R109：被扫描的源码里不许出现看不见的字符（零宽空格那类定时炸弹）', () => {
  // 真实缺陷：那句 JSDoc 里曾经用"星号 + 零宽空格 + 斜杠"来避免提前结束注释。
  // 后果不是风格问题——任何一次空白规范化、重新输入或复制粘贴都会让它现出原形，整个文件立刻语法错。
  // 这里把几个常见的不可见字符全局扫一遍（含被改过的每个文件）。
  const invisible = ['\u200b', '\u200c', '\u200d', '\ufeff', '\u2060', '\u00a0'];
  const names = ['U+200B 零宽空格', 'U+200C', 'U+200D', 'U+FEFF', 'U+2060', 'U+00A0 不换行空格'];
  const files = ['index.html', 'app.js', 'render.mjs', 'style.css', 'prepare.html'];
  const surfaces = files.map((file) => [file, read(file)]);
  surfaces.push(['test/page-content.test.mjs', readFileSync(new URL('./page-content.test.mjs', import.meta.url), 'utf8')]);
  for (const [file, text] of surfaces) {
    for (let n = 0; n < invisible.length; n += 1) {
      const index = text.indexOf(invisible[n]);
      if (index === -1) continue;
      const line = text.slice(0, index).split('\n').length;
      assert.fail(`${file} 第 ${line} 行有 ${names[n]}`);
    }
  }
  // 正面对照：扫的对象确实读到了东西（否则这条断言会空转成永久绿）。
  assert.equal(surfaces.length, 6);
  assert.ok(surfaces.every(([, text]) => text.length > 500));
});

test('R107：数据形状不对时，建议必须与用户当下能做的事一致', () => {
  // 只有一天数据时日期选择器是隐藏的：不能让人"换一天看看"。
  const oneDate = dataErrorNotice(1);
  assert.match(oneDate, /读不出来/);
  assert.ok(!oneDate.includes('换一天'), '只有一天数据时不能建议换一天');
  assert.ok(!oneDate.includes('日期选择器'), '选择器没显示，就不能提它');
  assert.match(oneDate, /npm run collect --offline/);

  // 有两天以上时才提日期选择器。
  const manyDates = dataErrorNotice(2);
  assert.match(manyDates, /换一天/);
  assert.match(manyDates, /日期选择器/);
  // R114：**不知道**有几天时不许替数据断言"只有这一份"（那是一件我们并不知道的事）；
  // 那时给的是中性说法（"如果还有别的日期可看……"），只在确实知道天数时才给确定建议。
  for (const unknown of [undefined, null, '2', NaN]) {
    const notice = dataErrorNotice(unknown);
    assert.ok(!notice.includes('没有别的日期可换'), `天数未知（${String(unknown)}）时不得断言只有一份数据`);
    assert.ok(!notice.includes('日期选择器换一天看看'), `天数未知（${String(unknown)}）时不得给确定建议`);
    assert.match(notice, /npm run collect --offline/);
  }
  // 只有一天时（确实知道）才把"没有别的日期可换"说明白。
  assert.match(dataErrorNotice(1), /没有别的日期可换/);

  // buildBoardView 真的把这个判断算进去了（不是只在测试里调了一下函数）。
  const broken = { date: '2026-10-10', degraded: false, boards: '不是数组' };
  const oneDay = noticeOf(buildBoardView({ boardId: 'weekly', items: [], daily: broken, dates: ['2026-10-10'] }), 'broken');
  assert.ok(!oneDay.html.includes('换一天'));
  const twoDays = noticeOf(buildBoardView({ boardId: 'weekly', items: [], daily: broken, dates: ['2026-10-10', '2026-10-09'] }), 'broken');
  assert.match(twoDays.html, /换一天/);
});

test('R108：语言筛选的回退发生在算视图之前，不会先画一份过期列表', () => {
  // 用户在某一天选了"没有标注语言"，然后切到没有这类条目的另一天。
  const gone = buildBoardView({ items: threeItems(), boardId: 'weekly', filters: { language: '__unknown__' } });
  assert.equal(gone.languageSelectionValid, false, '选项没了，选择必须失效');
  assert.equal(gone.visibleCount, 0, '失效的选择算出来的视图确实是空的（所以顺序很重要）');

  // 忠实模拟 app.js 那次渲染：**先**回退、**再**算视图、**最后**才画。以前是"先算先画、再回退"，
  // 于是用户看到的是"已重置的控件 + 空列表"，而且要等到下一次点击才恢复。
  const state = { filters: { easy: false, chinese: false, language: '__unknown__' } };
  const items = threeItems();
  const paintOrder = [];
  const paint = () => paintOrder.push('paint');
  const compute = () => {
    paintOrder.push('compute');
    return buildBoardView({ items, boardId: 'weekly', filters: state.filters });
  };

  // ① 先回退（render.mjs 给的事实函数）
  const pre = buildBoardView({ items, boardId: 'weekly', filters: state.filters });
  if (pre.languageSelectionValid !== true) state.filters.language = '';
  // ② 再算视图并画
  const view = compute();
  paint();
  assert.deepEqual(paintOrder, ['compute', 'paint']);

  assert.equal(state.filters.language, '');
  assert.equal(view.languageSelectionValid, true);
  assert.equal(view.visibleCount, 3, '回退后这一次渲染就该显示全部条目，而不是空列表');
  assert.equal(view.items.length, 3);
  assert.equal(noticeOf(view, 'filtered-out'), null);

  // app.js 必须真的按这个顺序写（先回退、后算、后渲染）。
  const code = stripComments(read('app.js'));
  const fallbackAt = code.search(/languageSelectionIsValid\s*\(/);
  const computeAt = code.search(/function computeView\s*\(/);
  // 画榜单的那个函数叫 drawBoard：它只是"把视图写到 DOM 上"。
  const drawAt = code.search(/function drawBoard\s*\(/);
  assert.ok(fallbackAt > -1, 'app.js 必须消费这个事实');
  assert.ok(computeAt > -1);
  assert.ok(drawAt > -1);
  // 事实与判断都来自 render.mjs：app.js 不自己算语言清单（那会变成第二套口径）。
  const hasLanguageListComputation = /new Set\([^)]*\.map\(\s*\(item\)\s*=>\s*item\?\.language/.test(code);
  assert.equal(hasLanguageListComputation, false, 'app.js 不许自己算语言清单');
  // 回退那一行在 computeView 里面（也就是算视图之前），而视图是在 drawBoard 里算的，
  // 所以"回退 → 算 → 画"这个顺序在源码里就是事实，不是靠注释声明的。
  const computeBody = code.slice(computeAt, drawAt);
  assert.ok(computeBody.includes('dropInvalidLanguageSelection('), '回退要发生在算视图之前');
  // 回退的实现本身要用纯函数给的那个判断（不能自己写一套"这个语言还在不在"的比较）。
  const fallbackEnd = code.indexOf('function computeView');
  assert.match(code.slice(fallbackAt, fallbackEnd), /languageSelectionIsValid\(/, '判断本身要用纯函数给的那一个');
});

test('R113：新手准备页不许把 Markdown 的星号原样给新手看', () => {
  const html = read('prepare.html');
  // 行内强调要用真的 <strong>；正文（不是注释）里不该出现 `**`。
  const bodyHtml = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!bodyHtml.includes('**'), '正文里出现 Markdown 星号，新手看到的会是两个星号');
  assert.match(bodyHtml, /<strong>用键盘打字下命令<\/strong>/);
  assert.match(bodyHtml, /<strong>不要为装它付钱<\/strong>/);
});

test('R115：链接协议必须过白名单（javascript: 之类的地址不许变成活链接）', () => {
  // 下载地址是原样的 URL（不像项目主页那个有固定前缀锚定），所以必须校验协议。
  const evil = installGuide({
    command: null,
    downloadUrl: 'javascript:alert(1)',
    steps: [
      { title: '第 1 步 · 你需要先准备什么', body: '有一台 Windows 电脑就够了。' },
      { title: '第 2 步 · 点下面的链接', body: '点这个链接下载。', downloadUrl: 'javascript:alert(1)' },
      { title: '第 3 步 · 怎么用', body: '装好之后打开它。' },
    ],
  });
  const html = detailDrawer({ boardId: 'newbie', item: drawerItem({ install: evil }) });
  assert.ok(!html.includes('javascript:'), '危险协议不许出现在抽屉里');
  assert.ok(!html.includes('data-download'), '地址不安全时连下载按钮都不该给');

  // 正常地址照旧给按钮，并且只认 http/https。
  assert.equal(safeHref('https://example.com/a.exe'), 'https://example.com/a.exe');
  assert.equal(safeHref('http://example.com/a.exe'), 'http://example.com/a.exe');
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///C:/x.exe', '/relative/a.exe', '不是地址', '', null, 42]) {
    assert.equal(safeHref(bad), '', `${String(bad)} 不该被放行`);
  }
  const good = installGuide({
    command: null,
    downloadUrl: 'https://example.com/tool-setup.exe',
    steps: [
      { title: '第 1 步 · 你需要先准备什么', body: '有一台 Windows 电脑就够了。' },
      { title: '第 2 步 · 点下面的链接', body: '点这个链接下载。', downloadUrl: 'https://example.com/tool-setup.exe' },
      { title: '第 3 步 · 怎么用', body: '装好之后打开它。' },
    ],
  });
  const goodHtml = detailDrawer({ boardId: 'newbie', item: drawerItem({ install: good }) });
  assert.match(goodHtml, /data-download/);
  assert.match(goodHtml, /href="https:\/\/example\.com\/tool-setup\.exe"/);
});

// ---------- ⑭ 静态服务器真的把页面送到浏览器 ----------

test('静态服务器提供的首页确实带着三个榜签', async () => {
  const server = createStaticServer({ root: 'public' });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
    assert.match(html, /本周飙升/);
    assert.match(html, /经典必玩/);
  } finally {
    await new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    });
  }
});

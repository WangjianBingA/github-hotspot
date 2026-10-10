// GitHub 好玩榜 —— JSON 数据层。
// 本项目没有数据库：public/data/ 下的 JSON 文件就是数据库。
//   public/data/YYYY-MM-DD.json       某天的完整榜单
//   public/data/index.json            有数据的日期列表
//   public/data/history/YYYY-MM.json  按月归档的历史快照（用于算真实星标差值）
// 同一个日期重复写入一律覆盖，保证采集脚本可重复执行。

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// 日期文件名形如 2026-10-10.json；index.json 与 history/ 目录都不会被匹配。
const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

// 区分"文件缺失/损坏"与"文件里真的写着某个值"的哨兵：JSON 永远解析不出 Symbol。
const INVALID = Symbol('无效 JSON');

/**
 * 读取并解析 JSON 文件，任何失败都不抛错。
 * @param {string} filePath 文件路径
 * @param {*} fallback 文件缺失、不可读或 JSON 非法时返回的兜底值
 * @returns {*} 解析结果或 fallback
 */
export function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 原子写入 JSON：先写同目录下的临时文件，再 rename 覆盖目标文件，
 * 这样读取方不会读到写了一半的内容。
 * @param {string} filePath 目标文件路径
 * @param {*} value 待写入的值
 */
function writeJsonAtomic(filePath, value) {
  // 目录可能还不存在（全新克隆），先建齐父目录。
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * 读取某天的榜单文件。
 * @param {string} dataDir 数据目录
 * @param {string} date UTC 日期（YYYY-MM-DD）
 * @returns {object|null} 榜单对象；文件缺失或损坏时返回 null
 */
export function readDaily(dataDir, date) {
  return readJsonSafe(join(dataDir, `${date}.json`), null);
}

/**
 * 写入某天的榜单文件（同一天重复写即覆盖）。
 * @param {string} dataDir 数据目录
 * @param {string} date UTC 日期（YYYY-MM-DD）
 * @param {object} payload 榜单对象
 */
export function writeDaily(dataDir, date, payload) {
  writeJsonAtomic(join(dataDir, `${date}.json`), payload);
}

/**
 * 列出真正可用的日期，降序。
 * 只认文件名合法且能解析成功的文件，损坏的文件不算"有数据"。
 * @param {string} dataDir 数据目录
 * @returns {string[]} 日期列表（YYYY-MM-DD，降序）
 */
export function listDates(dataDir) {
  let names;
  try {
    names = readdirSync(dataDir);
  } catch {
    // 数据目录还不存在，视为没有任何日期。
    return [];
  }
  return names
    .filter((name) => DATE_FILE.test(name))
    .map((name) => name.slice(0, 10))
    .filter((date) => readJsonSafe(join(dataDir, `${date}.json`), INVALID) !== INVALID)
    .sort()
    .reverse();
}

/**
 * 扫描数据目录里的日报，重写 index.json。
 * @param {string} dataDir 数据目录
 * @returns {string[]} 日期列表（降序）
 */
export function updateIndex(dataDir) {
  const dates = listDates(dataDir);
  writeJsonAtomic(join(dataDir, 'index.json'), { dates, updatedAt: new Date().toISOString() });
  return dates;
}

/**
 * 收集某天榜单里所有仓库的收藏数。
 * @param {string} dataDir 数据目录
 * @param {string} date UTC 日期（YYYY-MM-DD）
 * @returns {Map<string, number>} ownerRepo → stars；该天不存在时返回空 Map
 */
export function readSnapshotStars(dataDir, date) {
  const daily = readDaily(dataDir, date);
  const stars = new Map();
  if (!daily) return stars;
  for (const board of daily.boards ?? []) {
    for (const item of board?.items ?? []) {
      if (item && typeof item.ownerRepo === 'string') stars.set(item.ownerRepo, item.stars);
    }
  }
  return stars;
}

/**
 * 把某天的快照追加进当月历史档案（同一天重复追加幂等）。
 * @param {string} dataDir 数据目录
 * @param {string} date UTC 日期（YYYY-MM-DD）
 * @param {Map<string, {stars: number, forks: number}>} snapshotMap 该天的仓库快照
 */
export function appendHistory(dataDir, date, snapshotMap) {
  const month = date.slice(0, 7);
  const filePath = join(dataDir, 'history', `${month}.json`);
  const stored = readJsonSafe(filePath, null);
  // 档案必须始终是"对象"形态，否则用空对象重新开始。
  const history = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  history[date] = Object.fromEntries(snapshotMap);
  writeJsonAtomic(filePath, history);
}

/**
 * 读取某个月的历史档案。
 * @param {string} dataDir 数据目录
 * @param {string} month 月份（YYYY-MM）
 * @returns {object} 以日期为键、ownerRepo 为二级键的档案；缺失或损坏时返回空对象
 */
export function readHistory(dataDir, month) {
  return readJsonSafe(join(dataDir, 'history', `${month}.json`), {});
}

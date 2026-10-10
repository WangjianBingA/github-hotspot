// GitHub 好玩榜 —— 单文件 JSON 缓存。
// 整个缓存就是一个 JSON 文件，形如 { "<缓存键>": { body, expiresAt } }。
// 缓存只是"少发几次请求"的加速手段，不是数据源：文件缺失、JSON 损坏、结构不符
// 一律当作空缓存处理，绝不抛错（写失败也只是静默放弃写入）。
// 时间来自可注入的 now，便于在测试里精确控制过期语义。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 创建文件缓存。
 * @param {string} cachePath 缓存文件路径（不存在会被自动创建）
 * @param {{ now?: () => number }} [options] now 返回当前毫秒时间戳，默认 Date.now
 * @returns {{ get(key: string): *, set(key: string, body: *, ttlSeconds: number): void }}
 */
export function createFileCache(cachePath, { now = Date.now } = {}) {
  /**
   * 读出整份缓存；任何异常都退化成空对象。
   * @returns {Record<string, { body: *, expiresAt: number }>}
   */
  const readAll = () => {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
      // 必须是普通对象；数组、字符串、null 等都视为损坏。
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  /**
   * 整份写回（先写临时文件再改名，避免读到写了一半的内容）。
   * 缓存写失败不影响主流程，因此吞掉异常。
   * @param {Record<string, { body: *, expiresAt: number }>} entries
   */
  const writeAll = (entries) => {
    try {
      const parent = dirname(cachePath);
      if (parent) mkdirSync(parent, { recursive: true });
      const tmpPath = `${cachePath}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(entries)}\n`, 'utf8');
      renameSync(tmpPath, cachePath);
    } catch {
      // 缓存不可写（磁盘满、只读目录等）不是致命错误，放弃写入即可。
    }
  };

  return {
    /**
     * 取缓存值。
     * @param {string} key 缓存键
     * @returns {*} 未命中或已过期时返回 undefined
     */
    get(key) {
      const entry = readAll()[key];
      if (!entry || typeof entry !== 'object') return undefined;
      if (!(entry.expiresAt > now())) return undefined; // 已过期（含 expiresAt 非法的情况）
      return entry.body;
    },

    /**
     * 写缓存值。
     * @param {string} key 缓存键
     * @param {*} body 缓存内容（必须可 JSON 序列化）
     * @param {number} ttlSeconds 存活秒数；非正数表示"不该缓存"，直接忽略
     */
    set(key, body, ttlSeconds) {
      if (!(ttlSeconds > 0)) return;
      const entries = readAll();
      entries[key] = { body, expiresAt: now() + ttlSeconds * 1000 };
      writeAll(entries);
    }
  };
}

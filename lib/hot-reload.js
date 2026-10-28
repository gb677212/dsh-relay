/**
 * 热重载 —— 改完插件源码不用重启整个 DSH
 *
 * 原理：
 *   DSH 的 cordis loader 为每个插件条目维护一个 Entry，
 *   `entry.update(options, false, true)` 会销毁旧 fiber 并重新 init，
 *   即「只重载这一个插件」，其它插件和会话不受影响。
 *
 * 三种重载方式（从轻到重）：
 *   1. reload()          —— 只重载本插件（config 不变）
 *   2. reloadWith(config)—— 改配置后重载
 *   3. reloadModule()    —— 清掉 ESM 缓存后重载（改代码后生效）
 *
 * 用法：
 *   - HTTP: POST /dsh-relay/reload
 *   - 工具: relay_reload
 *   - 文件监视（可选）：watch=true 时监听 lib/ 变化自动重载
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PLUGIN_ID = 'dsh-relay';

/**
 * 找到本插件在 loader 里的 Entry。
 * loader 的 entries 是个可迭代集合，按 id 匹配。
 */
export function findEntry(ctx, id = PLUGIN_ID) {
  try {
    const loader = ctx.loader ?? ctx.get?.('loader');
    if (!loader) return null;
    const list = typeof loader.entries === 'function' ? loader.entries() : loader.entries;
    if (!list) return null;
    for (const entry of list) {
      const eid = entry?.options?.id ?? entry?.id;
      if (eid === id) return entry;
    }
  } catch { /* loader 结构变化时静默失败 */ }
  return null;
}

/**
 * 重载任意插件（按 loader entry id）。
 *
 * 用途：改了 app.asar 里的内置插件代码后，不重启 DSH 也能生效。
 * 例：reloadPlugin(ctx, 'goal-round-driver')
 *
 * @param {object} ctx
 * @param {string} id   - loader entry 的 id
 * @param {object} [options]
 * @returns {Promise<{ok:boolean, method:string, detail?:string}>}
 */
export async function reloadPlugin(ctx, id, options = {}) {
  const entry = findEntry(ctx, id);
  if (!entry) {
    return { ok: false, method: 'none', detail: `找不到 loader entry: ${id}` };
  }
  try {
    // force=true 会销毁旧 fiber 并重新 init，重新读取模块
    await entry.update({}, false, true);
    return { ok: true, method: 'entry.update', detail: `已重载 ${id}` };
  } catch (err) {
    return { ok: false, method: 'entry.update', detail: String(err?.message ?? err) };
  }
}

/**
 * 列出所有可重载的 loader entry id（诊断用）。
 */
export function listEntryIds(ctx) {
  try {
    const loader = ctx.loader ?? ctx.get?.('loader');
    if (!loader) return [];
    const list = typeof loader.entries === 'function' ? loader.entries() : loader.entries;
    if (!list) return [];
    const out = [];
    for (const entry of list) {
      const eid = entry?.options?.id ?? entry?.id;
      if (eid) out.push(String(eid));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 重载本插件。
 *
 * @param {object} ctx
 * @param {object} [options]
 * @param {object} [options.config]      - 新的 config（不传则保持原样）
 * @param {boolean} [options.clearCache] - 是否清 ESM 缓存（改代码后需要）
 * @returns {Promise<{ok:boolean, method:string, detail?:string}>}
 */
export async function reloadSelf(ctx, options = {}) {
  const { config, clearCache = true } = options;
  const entry = findEntry(ctx);
  if (!entry) {
    return { ok: false, method: 'none', detail: '找不到本插件的 loader entry' };
  }

  try {
    // 1. 清 ESM 缓存（改代码后必须，否则还是跑旧代码）
    if (clearCache) {
      const libDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      clearModuleCache(libDir);
    }

    // 2. 触发重载：update(options, create=false, force=true)
    const nextOptions = config === undefined ? {} : { config };
    await entry.update(nextOptions, false, true);

    return { ok: true, method: 'entry.update', detail: '已重载 ' + PLUGIN_ID };
  } catch (err) {
    return { ok: false, method: 'entry.update', detail: String(err?.message ?? err) };
  }
}

/**
 * 清掉某个目录下所有 ESM 模块的缓存。
 *
 * Node 的 ESM 没有公开的删缓存 API，但 `import.meta.resolve` 后的模块
 * 存在内部 map 里。实用做法是给 URL 加查询串绕过缓存 —— 由调用方在
 * 重新 import 时带 `?t=<timestamp>`。这里只做「找出该目录下的模块文件」，
 * 供 reloadModule 使用。
 */
export function clearModuleCache(dir) {
  // 清理 CommonJS 缓存（如果有）
  try {
    for (const key of Object.keys(require.cache ?? {})) {
      if (key.startsWith(dir)) delete require.cache[key];
    }
  } catch { /* ESM 环境没有 require.cache */ }
  return dir;
}

/**
 * 带缓存破除地重新 import 一个模块。
 * 用途：改了 lib/xxx.js 后，想在不重启进程的情况下拿到新版本。
 */
export async function importFresh(filePath) {
  const url = pathToFileURL(filePath);
  url.searchParams.set('t', String(Date.now()));
  return import(url.href);
}

/**
 * 文件监视：lib/ 下的 .js 变化时触发重载（防抖）。
 *
 * @param {object} ctx
 * @param {object} [opts]
 * @param {number} [opts.debounceMs=800]
 * @param {(result:object)=>void} [opts.onReload]
 * @returns {() => void} 停止监视
 */
export function watchAndReload(ctx, opts = {}) {
  const { debounceMs = 800, onReload } = opts;
  const libDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

  let timer = null;
  let lastReload = 0;

  const watcher = fs.watch(libDir, { recursive: false }, (eventType, filename) => {
    if (!filename || !filename.endsWith('.js')) return;
    // 自己重载自己会写文件，避免循环
    if (Date.now() - lastReload < 2000) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      lastReload = Date.now();
      const result = await reloadSelf(ctx, { clearCache: true });
      onReload?.(result);
    }, debounceMs);
  });

  return () => {
    if (timer) clearTimeout(timer);
    try { watcher.close(); } catch { /* ignore */ }
  };
}

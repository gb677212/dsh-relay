/**
 * 真·热重载 —— 劫持 loader 的 import
 *
 * 原理（从 cordis-plugin-loader 源码确认）：
 *   Entry._init() 里调用 `this.parent.tree.import(this.options.name, ...)` 加载模块
 *   → 我们覆盖 tree.import，让本插件名走 fresh-loader（读磁盘 + new Function）
 *   → 之后 entry.update() 就能拿到新代码
 *
 * 这样改完 lib/*.js 只要调一次 reload，就立刻生效，不用重启 DSH。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFresh } from './fresh-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 已劫持的 loader tree（避免重复安装） */
const patched = new WeakSet();

/**
 * 给 loader 的 tree.import 打补丁，让指定包名走 fresh-loader。
 *
 * @param {object} ctx       - cordis 上下文
 * @param {string[]} names   - 需要走 fresh-loader 的模块名（如 ['dsh-relay']）
 * @param {string} [libDir]  - 这些包的 lib 目录
 * @returns {{ok:boolean, detail:string}}
 */
export function installFreshImport(ctx, names = ['dsh-relay'], libDir = __dirname) {
  try {
    const loader = ctx.loader ?? ctx.get?.('loader');
    if (!loader) return { ok: false, detail: '找不到 loader' };

    // 找到 tree（不同版本位置不同，都试一遍）
    const tree =
      loader.tree ??
      loader.root?.tree ??
      loader.entry?.tree ??
      ctx.fiber?.entry?.tree ??
      ctx.fiber?.entry?.parent?.tree;

    if (!tree || typeof tree.import !== 'function') {
      return { ok: false, detail: '找不到 tree.import' };
    }

    if (patched.has(tree)) {
      return { ok: true, detail: '已劫持过，跳过' };
    }

    const originalImport = tree.import.bind(tree);

    tree.import = function patchedImport(name, getOuterStack) {
      // 只拦我们关心的包
      const hit = names.some((n) => name === n || name.startsWith(n + '/'));
      if (hit) {
        try {
          const target = path.join(libDir, 'index.js');
          const fresh = loadFresh(target);
          return Promise.resolve(fresh);
        } catch (err) {
          // 加载失败就退回原逻辑，别把插件搞死
          ctx.logger?.warn?.(`[relay-hmr] fresh load 失败，退回原 import：${err?.message ?? err}`);
          return originalImport(name, getOuterStack);
        }
      }
      return originalImport(name, getOuterStack);
    };

    patched.add(tree);
    return { ok: true, detail: `已劫持 tree.import（${names.join(', ')} → ${libDir}）` };
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) };
  }
}

/**
 * 完整热重载流程：
 *   1. 安装 fresh import 劫持（只需一次）
 *   2. 触发 entry.update()，此时 loader 会走我们的 fresh-loader
 *
 * @param {object} ctx
 * @param {string} entryId
 * @param {string} [libDir]
 * @returns {Promise<{ok:boolean, detail:string, steps:string[]}>}
 */
export async function hotReload(ctx, entryId = 'dsh-relay', libDir = __dirname) {
  const steps = [];

  // 1. 劫持 import
  const inst = installFreshImport(ctx, [entryId], libDir);
  steps.push(`install: ${inst.ok ? 'OK' : 'FAIL'} - ${inst.detail}`);
  if (!inst.ok) return { ok: false, detail: inst.detail, steps };

  // 2. 找 entry
  let entry = null;
  try {
    const loader = ctx.loader ?? ctx.get?.('loader');
    const list = typeof loader.entries === 'function' ? loader.entries() : loader.entries;
    for (const e of list ?? []) {
      const id = e?.options?.id ?? e?.id;
      if (id === entryId) {
        entry = e;
        break;
      }
    }
  } catch (err) {
    steps.push('find entry 失败: ' + String(err?.message ?? err));
  }

  if (!entry) {
    return { ok: false, detail: `找不到 entry: ${entryId}`, steps };
  }
  steps.push(`entry found: ${entryId}`);

  // 3. 触发重载（此时会走 fresh-loader）
  try {
    await entry.update({}, false, true);
    steps.push('entry.update: OK');
    return { ok: true, detail: '热重载完成（源码已从磁盘重新加载）', steps };
  } catch (err) {
    steps.push('entry.update 失败: ' + String(err?.message ?? err));
    return { ok: false, detail: String(err?.message ?? err), steps };
  }
}

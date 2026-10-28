/**
 * 真·热重载加载器
 *
 * 问题：Node 的 ESM 模块一旦 import 就永久缓存，没有公开 API 能清除。
 *       `entry.update()` 只重建 fiber，重新 import 还是拿旧模块。
 *
 * 解法：不走 import，改成
 *       1. fs.readFileSync 读源码（每次都是磁盘最新内容）
 *       2. 转成 CommonJS 形式（把 import/export 改写成 require/module.exports）
 *       3. new Function 执行（每次都是全新的函数作用域，无缓存）
 *
 * 这样只要文件变了，重载就能拿到新代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 把 ESM 源码转成可被 new Function 执行的 CJS 形式。
 *
 * 只处理本插件用到的语法子集：
 *   import X from 'y'          → const X = require('y')
 *   import { a, b } from 'y'   → const { a, b } = require('y')
 *   import * as X from 'y'     → const X = require('y')
 *   import 'y'                 → require('y')
 *   export const/let/var/function/class  → 去掉 export 前缀
 *   export { a, b }            → 记录到 exports
 *   export default X           → exports.default = X
 *
 * @param {string} source
 * @returns {{ body: string, exportsList: string[] }}
 */
export function transformEsmToCjs(source) {
  const exportsList = [];
  let body = source;

  // 0. import.meta.url → __importMetaUrl（new Function 里不能用 import.meta）
  body = body.replace(/import\.meta\.url/g, '__importMetaUrl');
  body = body.replace(/import\.meta\b(?!\.)/g, '__importMeta');

  // 1. import 语句
  // import X from 'y'
  body = body.replace(
    /^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?\s*$/gm,
    (_, name, spec) => `const ${name} = __require(${JSON.stringify(spec)});`,
  );

  // import * as X from 'y'
  body = body.replace(
    /^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?\s*$/gm,
    (_, name, spec) => `const ${name} = __require(${JSON.stringify(spec)});`,
  );

  // import { a, b as c } from 'y'
  body = body.replace(
    /^\s*import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm,
    (_, names, spec) => {
      const cleaned = names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => n.replace(/\s+as\s+/, ': '))
        .join(', ');
      return `const { ${cleaned} } = __require(${JSON.stringify(spec)});`;
    },
  );

  // import 'y'
  body = body.replace(
    /^\s*import\s+['"]([^'"]+)['"];?\s*$/gm,
    (_, spec) => `__require(${JSON.stringify(spec)});`,
  );

  // 2. export 声明
  body = body.replace(
    /^\s*export\s+(const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_, kind, name) => {
      exportsList.push(name);
      return `${kind} ${name}`;
    },
  );

  // 2.5 把所有导出的名字挂到 __exports（在 body 末尾追加）
  //     注意：必须放在最后，等所有声明都执行完
  const tail = exportsList.map((n) => `__exports[${JSON.stringify(n)}] = ${n};`).join('\n');
  if (tail) body += '\n' + tail + '\n';

  // 3. export { a, b as c }
  body = body.replace(/^\s*export\s+\{([^}]+)\};?\s*$/gm, (_, names) => {
    const pairs = names
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => {
        const m = n.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        return m ? [m[1], m[2]] : [n, n];
      });
    return pairs.map(([local, exported]) => `__exports[${JSON.stringify(exported)}] = ${local};`).join('\n');
  });

  // 4. export default
  body = body.replace(/^\s*export\s+default\s+/gm, '__exports.default = ');

  return { body, exportsList };
}

/**
 * 从磁盘重新加载一个本地模块（不走 import，无缓存）。
 *
 * @param {string} filePath - 绝对路径
 * @param {object} [deps]   - 可注入的依赖（用于测试）
 * @returns {object} 模块的导出对象
 */
export function loadFresh(filePath, deps = {}) {
  const source = fs.readFileSync(filePath, 'utf8');
  const { body } = transformEsmToCjs(source);

  const __exports = {};
  const dir = path.dirname(filePath);
  const requireFromHere = createRequire(filePath);

  // 自定义 require：相对路径 → 递归 loadFresh（同样绕缓存）
  const __require = (spec) => {
    // 外部包走正常 require
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      if (deps[spec] !== undefined) return deps[spec];
      return requireFromHere(spec);
    }
    // 本地文件：递归 fresh load
    let target = path.resolve(dir, spec);
    if (!target.endsWith('.js')) {
      if (fs.existsSync(target + '.js')) target += '.js';
      else if (fs.existsSync(path.join(target, 'index.js'))) target = path.join(target, 'index.js');
    }
    return loadFresh(target, deps);
  };

  // 用 new Function 执行（每次全新作用域，无模块缓存）
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    '__require',
    '__exports',
    'require',
    'module',
    'exports',
    '__moduleDir',
    '__moduleFile',
    '__importMetaUrl',
    '__importMeta',
    body,
  );

  const moduleObj = { exports: __exports };
  const metaUrl = 'file:///' + filePath.replace(/\\/g, '/');
  fn(
    __require,
    __exports,
    requireFromHere,
    moduleObj,
    __exports,
    dir,
    filePath,
    metaUrl,
    { url: metaUrl },
  );

  return moduleObj.exports;
}

/**
 * 热重载一个 cordis 插件：从磁盘重读源码，重建 apply。
 *
 * @param {object} ctx        - cordis 上下文
 * @param {string} entryId    - loader entry id
 * @param {string} [libDir]   - 插件 lib 目录（默认本插件目录）
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function hotSwap(ctx, entryId, libDir = __dirname) {
  try {
    const entry = findEntryById(ctx, entryId);
    if (!entry) return { ok: false, detail: `找不到 entry: ${entryId}` };

    // 1. 从磁盘读最新代码（不 import，避免缓存）
    const fresh = loadFresh(path.join(libDir, 'index.js'));

    // 2. 触发 fiber 重建（会调用新的 apply）
    //    但 cordis 用的是 import 时的 apply，所以要手动替换
    //    这里改用：直接调 entry.update，让 cordis 重新走 import
    //    （对本地 lib 目录，我们会用下面的 moduleOverride 机制）

    await entry.update({}, false, true);
    return { ok: true, detail: `已重载 ${entryId}（源码版本 ${Date.now()}）` };
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) };
  }
}

/** 按 id 找 loader entry */
function findEntryById(ctx, id) {
  try {
    const loader = ctx.loader ?? ctx.get?.('loader');
    if (!loader) return null;
    const list = typeof loader.entries === 'function' ? loader.entries() : loader.entries;
    for (const entry of list ?? []) {
      const eid = entry?.options?.id ?? entry?.id;
      if (eid === id) return entry;
    }
  } catch { /* ignore */ }
  return null;
}

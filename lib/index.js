/**
 * dsh-relay — 会话接力（修正版 v0.2.0）
 *
 * 本版修复了 v0.1.0 的 6 个 bug：
 *   1. ctx.agents.prompt 不存在 → 改用 createSession + agent.followup
 *   2. tools.register 的 parameters 必须是完整 JSON Schema
 *   3. tools.register 返回的 unregister 必须用 ctx.effect 清理
 *   4. 硬编码 30s 等待 → 改成轮询文件 mtime
 *   5. cwd 字段名不确定 → 多候选 + 兜底
 *   6. ctx.tools.list 可能不存在 → 包 try/catch
 */
import fs from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { measureContext } from './measure.js';
import { SessionFlags, MODE_ON, MODE_OFF, describeMode } from './session-flags.js';
import { findEntry, reloadSelf, watchAndReload, reloadPlugin, listEntryIds } from './hot-reload.js';
import { loadFresh } from './fresh-loader.js';
import { installFreshImport, hotReload } from './hmr-hijack.js';
import {
  createSession,
  sendToAgent,
  makeUserMessage,
  waitIdle,
  waitForFile,
  resolveCwd,
} from './session-ops.js';

export const name = 'dsh-relay';
// 数组形式声明依赖（与 @goodandready/dsh-goal 一致）。
//
// sessionProjections 必须注入：否则 ctx.sessionProjections 为 undefined，
// 读不到 DSH 的 contextPressure（真实上下文压力），接力永远不会触发。
//
// hmr 必须注入：否则 ctx.hmr 不可访问，无法清 ESM 缓存做真正的热重载。
export const inject = ['webServer', 'tools', 'sessionProjections', 'agents', 'hmr', 'workspaceRegistry'];

const DEFAULT_THRESHOLD = 78;
const DEFAULT_MAX_RELAYS = 50;
const DEFAULT_STATE_FILE = 'STATE.md';

/** 总结指令 */
export function buildSummaryPrompt(stateFile) {
  return `【会话接力 · 上下文即将占满】

请立刻把当前任务的完整状态写入 \`${stateFile}\`（工作区根目录）。

必须包含以下小节，缺一不可：

1. **目标** — 最终要达成什么
2. **已完成** — 逐条列出，每条带证据（文件路径/数字/结论）
3. **未完成** — 按优先级排序的待办
4. **可能还有的优化点** — 想到但还没做的改进
5. **赛事要求 / 必须遵守的规则** — 官方规则要点、评分标准、硬性约束（没有写"无"）
6. **关键文件路径** — 脚本、数据、日志、配置的绝对路径
7. **已试过但失败的方案** — 方案 + 失败原因 + 不要再试（这条最重要）
8. **特殊流程** — 例如某些网站只能在浏览器 Notebook 终端操作

★★★ 写完 STATE.md 之后，【必须立刻调用 \`relay_transfer\` 工具】★★★

- 这一步由你（原会话）决定：确认 STATE.md 内容完整无误后，再调 \`relay_transfer\`
- 只有调了它，新会话才会被创建、你才会被正式交接
- 如果你还没写完，就不要调；写完了再调
- 调用成功后，你的工作就结束了，不要再继续做任务

（系统不会自动转移 —— 转移的时机完全由你决定。）`;
}

/** 新会话的接续指令 */
export function buildResumePrompt(stateFile, goal) {
  return `【会话接力 · 接续上一个会话】

上一个会话因上下文占满而中断。它的完整状态已写入 \`${stateFile}\`。

**第一步：先完整读取 \`${stateFile}\`**，理解目标、已完成、未完成、失败方案、必须遵守的规则。

**第二步：按"未完成"列表继续工作。**

${goal ? `**原始目标**：${goal}\n` : ''}
注意事项：
- 不要重做"已完成"里的东西
- 不要重试"已试过但失败的方案"
- 遇到需要浏览器 Notebook 终端的情况，用浏览器而不是本地 CLI
- 定期更新 STATE.md，方便下次接力`;
}

/** 状态文件读写 */
export function readState(workspaceDir, stateFileName) {
  try {
    return fs.readFileSync(path.join(workspaceDir, stateFileName), 'utf8');
  } catch {
    return null;
  }
}

export function writeState(workspaceDir, stateFileName, content) {
  const p = path.join(workspaceDir, stateFileName);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

/**
 * 从 STATE.md 里提取「目标」小节的内容。
 *
 * STATE.md 是模型写的 markdown，格式不固定，所以要容错处理：
 *   ## 目标             → 取到下一个同级/更高级标题
 *   **目标** — xxx      → 取该行冒号/破折号后的内容
 *   1. **目标**：xxx    → 同上
 *   目标：xxx           → 同上
 *
 * @param {string} raw - STATE.md 原文
 * @returns {string} 目标文本，取不到返回空串
 */
export function extractObjective(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  const text = raw.replace(/\r\n/g, '\n');

  // 1. markdown 标题形式：## 目标 / # 目标 / ### 1. 目标
  const headingRe = /^#{1,6}\s*(?:\d+[.、]\s*)?(?:目标|最终目标|任务目标|Objective)\s*[:：]?\s*$/im;
  const hm = headingRe.exec(text);
  if (hm) {
    const after = text.slice(hm.index + hm[0].length);
    // 取到下一个标题为止
    const nextHeading = after.search(/^#{1,6}\s/m);
    const body = (nextHeading >= 0 ? after.slice(0, nextHeading) : after).trim();
    if (body) return body.split('\n').map((l) => l.trim()).filter(Boolean).join(' ').slice(0, 500);
  }

  // 2. 加粗形式：**目标** — xxx / **目标**：xxx
  const boldRe = /(?:\d+[.、]\s*)?\*\*\s*(?:目标|最终目标|任务目标)\s*\*\*\s*[—\-–:：]?\s*(.+)/i;
  const bm = boldRe.exec(text);
  if (bm?.[1]) {
    const v = bm[1].trim();
    if (v) return v.slice(0, 500);
  }

  // 3. 普通行：目标：xxx
  const lineRe = /^[\s>*\-]*(?:\d+[.、]\s*)?(?:目标|最终目标|任务目标)\s*[:：]\s*(.+)$/im;
  const lm = lineRe.exec(text);
  if (lm?.[1]) {
    const v = lm[1].trim();
    if (v) return v.slice(0, 500);
  }

  return '';
}

/** 接力记账 */
export class RelayLedger {
  constructor(file) {
    this.file = file;
    this.data = { relays: [], updatedAt: 0 };
    this.load();
  }
  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(this.data.relays)) this.data.relays = [];
    } catch {
      this.data = { relays: [], updatedAt: 0 };
    }
  }
  save() {
    this.data.updatedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch { /* ignore */ }
  }
  hasRelayed(sessionId) {
    return this.data.relays.some((r) => r.from === sessionId);
  }
  isRelayChild(sessionId) {
    // ★ 修复（2026-10-25）：除了接力产物，还要认【手动创建的子智能体】
    //   原来只查 relays（r.to === sessionId），导致 spawn-child 建出的子智能体
    //   不被认作 relay child，开关默认 off，无法接力。
    if (this.data.relays.some((r) => r.to === sessionId)) return true;
    if (this.data.childParents?.[sessionId]) return true;
    return false;
  }
  record(from, to, reason) {
    this.data.relays.push({ from, to, reason, at: Date.now() });
    if (this.data.relays.length > 200) this.data.relays = this.data.relays.slice(-200);
    this.save();
  }
  /**
   * 更新某条记录的 to 字段（接力开始时先记 from，成功后再补 to）。
   * @param {string} from
   * @param {string} to
   */
  updateTo(from, to, reason) {
    const r = this.data.relays.find((x) => x.from === from && !x.to);
    if (r) {
      r.to = to;
      r.reason = reason;
      this.save();
    } else {
      this.record(from, to, reason);
    }
  }
  /**
   * 移除某会话的接力标记（仅用于接力失败时允许重试）。
   * @param {string} sessionId
   */
  unmark(sessionId) {
    const before = this.data.relays.length;
    this.data.relays = this.data.relays.filter((r) => !(r.from === sessionId && !r.to));
    if (this.data.relays.length !== before) this.save();
  }
  /** 是否有「已开始但未完成」的接力（用于防连锁接力） */
  hasPending(sessionId) {
    return this.data.relays.some((r) => r.from === sessionId && !r.to);
  }
  /**
   * 记录 relay 创建的子智能体 → 父 agent 的映射。
   *
   * 为什么需要：DSH 的 AgentRegistry 用私有 store（Map<id,{owner,agent}>）存父引用，
   * 插件拿不到。所以 relay 自己创建子智能体时把父子关系记下来，
   * 将来这个子智能体要接力时就能查回它的父（保持「在同一个主会话里」）。
   */
  recordChildParent(childId, parentId) {
    if (!this.data.childParents) this.data.childParents = {};
    this.data.childParents[childId] = parentId;
    this.save();
  }
  /** 查子智能体的父（relay 记录过的） */
  getParentOf(childId) {
    return this.data.childParents?.[childId] ?? null;
  }
  count() {
    return this.data.relays.length;
  }
}

/** 插件主体 */
export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const ledger = new RelayLedger(path.join(home, 'dsh-relay', 'relays.json'));
  const flags = new SessionFlags(path.join(home, 'dsh-relay', 'session-flags.json'));

  // 正在接力中的会话集合 —— turn/end 与巡检共用，防止并发重复触发
  const relayInFlight = new Set();

  // 触发计数（诊断用）：turn/step 各触发了多少次
  const __relayStats = {};
  /** 78% 强制投递记录：sessionId → { at, pct }（防重复） */
  const __noticeDelivered = new Map();

  const thresholdPercent = Number(config.thresholdPercent ?? DEFAULT_THRESHOLD);
  const stateFileName = String(config.stateFileName ?? DEFAULT_STATE_FILE);
  const maxRelays = Number(config.maxRelays ?? DEFAULT_MAX_RELAYS);
  const summaryTimeoutMs = Number(config.summaryTimeoutMs ?? 45_000);
  const enabled = config.enabled !== false;
  // ★ 开发/调试端点开关（默认关闭）：
  //   force / spawn-child / selftest / stopgoals 都会产生副作用（创建会话、改目标），
  //   误调用会污染用户会话（2026-10-24 实测教训：测试时反复 force 造出 8 个垃圾会话）。
  //   要用来调试时在 cordis.patch.yml 里加 devEndpoints: true。
  const devEndpoints = config.devEndpoints === true;

  // ★ 跨 apply 的资源清理（热重载必需）
  //   ctx.effect 在同一个 ctx 上多次调用不会自动清理，所以每次热重载都会
  //   累积一份 turn/end 监听器 + goal guard 定时器。累积后 turn/end 会触发
  //   多次接力、goal guard 会重复 resume 目标 —— 这是 2026-10-24 实测到的隐患。
  //   这里用模块级 globalThis 记录上一轮的所有 disposer，新一轮开头先全部清掉。
  try {
    if (typeof globalThis.__relayCleanup === 'function') {
      globalThis.__relayCleanup();
    }
  } catch { /* 清理失败不阻断 */ }
  globalThis.__relayCleanup = undefined;

  const __relayDisposers = [];
  const __relayAddCleanup = (fn) => {
    if (typeof fn === 'function') __relayDisposers.push(fn);
  };
  globalThis.__relayCleanup = () => {
    for (const fn of __relayDisposers) {
      try { fn(); } catch { /* 单个失败不影响其它 */ }
    }
    __relayDisposers.length = 0;
  };

  if (!enabled) {
    log.info?.('[dsh-relay] disabled by config');
    return;
  }

  // 绕过 inject 限制，直接拿到 workspaceRegistry 服务
  function getWorkspaceRegistry() {
    const tries = [];
    // 1. ctx.get(name)
    try { const r = ctx.get?.('workspaceRegistry'); if (r) return r; } catch (e) { tries.push('get:' + e.message.slice(0, 30)); }
    // 2. ctx.reflect / ctx.registry
    try {
      const reg = ctx.reflect?.get?.('workspaceRegistry') ?? ctx.registry?.get?.('workspaceRegistry');
      if (reg) return reg;
    } catch (e) { tries.push('reflect:' + e.message.slice(0, 30)); }
    // 3. 从 root 上找
    try {
      const root = ctx.root ?? ctx.fiber?.ctx ?? ctx;
      const r = root?.workspaceRegistry ?? root?.get?.('workspaceRegistry');
      if (r) return r;
    } catch (e) { tries.push('root:' + e.message.slice(0, 30)); }
    // 4. 遍历 ctx 的所有属性，找像 registry 的对象
    try {
      for (const k of Object.keys(ctx)) {
        if (/workspace/i.test(k)) {
          const v = ctx[k];
          if (v && typeof v.resolveByPath === 'function') return v;
        }
      }
    } catch (e) { tries.push('scan:' + e.message.slice(0, 30)); }
    // 5. cordis 内部 services 表
    try {
      const svc = ctx.services ?? ctx._services ?? ctx.fiber?.services;
      if (svc) {
        const r = typeof svc.get === 'function' ? svc.get('workspaceRegistry') : svc['workspaceRegistry'];
        if (r) return r;
      }
    } catch (e) { tries.push('services:' + e.message.slice(0, 30)); }
    return null;
  }

  // 绕过 inject 限制，拿到 permissionPresets 服务
  function getPermissionPresets() {
    try { const r = ctx.get?.('permissionPresets'); if (r) return r; } catch { /* */ }
    try {
      const r = ctx.reflect?.get?.('permissionPresets') ?? ctx.registry?.get?.('permissionPresets');
      if (r) return r;
    } catch { /* */ }
    try {
      const root = ctx.root ?? ctx.fiber?.ctx ?? ctx;
      const r = root?.permissionPresets ?? root?.get?.('permissionPresets');
      if (r) return r;
    } catch { /* */ }
    try {
      for (const k of Object.keys(ctx)) {
        if (/permission/i.test(k)) {
          const v = ctx[k];
          if (v && typeof v.current === 'function') return v;
        }
      }
    } catch { /* */ }
    try {
      const svc = ctx.services ?? ctx._services ?? ctx.fiber?.services;
      if (svc) {
        const r = typeof svc.get === 'function' ? svc.get('permissionPresets') : svc['permissionPresets'];
        if (r) return r;
      }
    } catch { /* */ }
    return null;
  }

  // 绕过 inject 限制，拿到 approval 服务（设置审批策略用）
  function getApproval() {
    try { const r = ctx.get?.('approval'); if (r) return r; } catch { /* */ }
    try {
      const r = ctx.reflect?.get?.('approval') ?? ctx.registry?.get?.('approval');
      if (r) return r;
    } catch { /* */ }
    try {
      const root = ctx.root ?? ctx.fiber?.ctx ?? ctx;
      const r = root?.approval ?? root?.get?.('approval');
      if (r) return r;
    } catch { /* */ }
    return null;
  }

  /**
   * 判断 agent 是否为顶层会话（用户开的那种）。
   *
   * DSH 的 agents.roots() 只返回顶层会话（内部按 entry.owner === undefined 过滤）。
   */
  function isTopLevelAgent(agent) {
    const sid = agent?.session?.id ?? agent?.id;
    if (!sid) return false;
    try {
      const roots = ctx.agents?.roots?.();
      if (!Array.isArray(roots)) return true;   // 拿不到就当顶层（保守）
      return roots.some((a) => (a?.session?.id ?? a?.id) === sid);
    } catch {
      return true;
    }
  }

  /**
   * 找 agent 的父 agent（子智能体接力时，新会话要挂在同一个父下面）。
   *
   * 用户要求（2026-10-24）：子智能体也要能接力，但接力产物必须是**子智能体**，
   * 位置和原来一样 —— 在那个主会话里，并且能和主会话交流。
   *
   * DSH 的子智能体由 agents.create({ parentAgent }) 创建，父引用可能挂在
   * 几个不同字段上，这里挨个尝试。
   *
   * @param {object} agent
   * @returns {object|null} 父 agent，顶层会话返回 null
   */
  function findParentAgent(agent) {
    if (!agent) return null;
    const sid = agent?.session?.id ?? agent?.id;

    // 1. ★ relay 自己记录过的父子映射（最可靠 —— DSH 的 store 是私有的拿不到）
    try {
      const pid = ledger.getParentOf(sid);
      if (pid) {
        const all = ctx.agents?.list?.() ?? [];
        const pa = all.find((a) => (a?.session?.id ?? a?.id) === pid);
        if (pa) return pa;
      }
    } catch { /* ignore */ }

    // 2. agent 上的直接字段
    const candidates = [
      agent.parentAgent,
      agent.owner,
      agent.parent,
      agent.entry?.owner,
      agent._parentAgent,
    ];
    for (const c of candidates) {
      if (c && typeof c === 'object') return c;
    }
    // 退一步：从 agents 注册表里按 owner 反查
    try {
      const all = ctx.agents?.list?.() ?? [];
      const sid = agent?.session?.id ?? agent?.id;
      for (const a of all) {
        if (!a || a === agent) continue;
        // 有的实现把子列表挂在父 agent 上
        const kids = a.children ?? a.subagents ?? a.childAgents;
        if (Array.isArray(kids) && kids.some((k) => (k?.session?.id ?? k?.id) === sid)) {
          return a;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  // 绕过 inject 限制，拿到 goals 服务（创建目标用）
  function getGoals() {
    try { const r = ctx.get?.('goals'); if (r) return r; } catch { /* */ }
    try {
      const r = ctx.reflect?.get?.('goals') ?? ctx.registry?.get?.('goals');
      if (r) return r;
    } catch { /* */ }
    try {
      const root = ctx.root ?? ctx.fiber?.ctx ?? ctx;
      const r = root?.goals ?? root?.get?.('goals');
      if (r) return r;
    } catch { /* */ }
    try {
      for (const k of Object.keys(ctx)) {
        if (k === 'goals' || /^goal/i.test(k)) {
          const v = ctx[k];
          if (v && typeof v.create === 'function') return v;
        }
      }
    } catch { /* */ }
    try {
      const svc = ctx.services ?? ctx._services ?? ctx.fiber?.services;
      if (svc) {
        const r = typeof svc.get === 'function' ? svc.get('goals') : svc['goals'];
        if (r) return r;
      }
    } catch { /* */ }
    return null;
  }

  // ---------- HTTP 路由 ----------
  //   支持 __routePrefix 覆盖（热重载时用不同前缀，避开 duplicate 检查）
  //   如果注册冲突，自动降级到带代次的前缀，保证 apply 不整体失败。
  let ROUTE_PREFIX = config.__routePrefix ?? '/dsh-relay';
  // 真实 handler 的持有者（effect 内部赋值，外部读取）
  const realHandlerRef = { current: null };
  ctx.effect?.(() => {
    if (!ctx.webServer?.register) return () => {};
    // ★ handler 只做转发：真正逻辑放在 globalThis.__relayHandler，
    //   每次 apply 都会更新它。这样即使路由无法重新注册，
    //   主路径 /dsh-relay 也能用最新代码。
    const buildRoute = (prefix) => ({
      kind: 'prefix',
      path: prefix,
      handler: async (req, res) => {
        const fn = globalThis.__relayHandler;
        if (typeof fn === 'function') return fn(req, res);
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'relay handler not ready' }));
      },
    });

    // 真实逻辑（挂到外层 ref，供转发器调用）
    realHandlerRef.current = async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        // 归一化路径（支持 /dsh-relay-gN 前缀）
        if (url.pathname.startsWith('/dsh-relay-g')) {
          const m = url.pathname.match(/^\/dsh-relay-g\d+(\/.*)?$/);
          if (m) url.pathname = '/dsh-relay' + (m[1] ?? '');
        }
        const send = (code, obj) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(obj));
        };
        const readBody = async () => {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            return {};
          }
        };
        try {
          if (req.method === 'GET' && url.pathname === '/dsh-relay/mode') {
            const sid = url.searchParams.get('sessionId') ?? '';
            const resolved = flags.resolve(sid, {
              globalEnabled: enabled,
              isRelayChild: ledger.isRelayChild(sid),
            });
            return send(200, {
              sessionId: sid,
              mode: resolved.mode,
              reason: resolved.reason,
              description: describeMode(resolved),
              globalEnabled: enabled,
              thresholdPercent,
              hasRelayed: ledger.hasRelayed(sid),
            });
          }
          if (req.method === 'POST' && url.pathname === '/dsh-relay/mode') {
            const body = await readBody();
            const sid = String(body.sessionId ?? '');
            if (!sid) return send(400, { error: 'sessionId required' });
            if (body.mode === 'clear') flags.clear(sid);
            else if (body.mode === MODE_ON || body.mode === MODE_OFF) {
              flags.set(sid, body.mode, body.reason ?? 'ui');
            } else {
              return send(400, { error: "mode must be 'on' | 'off' | 'clear'" });
            }
            const resolved = flags.resolve(sid, { globalEnabled: enabled });
            return send(200, {
              ok: true,
              sessionId: sid,
              mode: resolved.mode,
              reason: resolved.reason,
              description: describeMode(resolved),
            });
          }
          if (req.method === 'GET' && url.pathname === '/dsh-relay/status') {
            return send(200, {
              enabled,
              thresholdPercent,
              patrolEnabled: config.patrol !== false,
              goalGuardEnabled: config.goalGuard === true,
              goalGuardDelayMs: Number(config.goalGuardDelayMs ?? 180000),
              goalGuardIntervalMs: Number(config.goalGuardIntervalMs ?? 30000),
              stateFileName,
              maxRelays,
              relayCount: ledger.count(),
              toolDisposers: (() => { try { return (globalThis.__relayToolDisposers || []).length; } catch { return -1; } })(),
              relayStats: __relayStats,
              recentRelays: ledger.data.relays.slice(-5),
              sessionFlags: flags.list(),
              hotReload: {
                watchEnabled: config.hotReloadWatch === true,
                available: Boolean(findEntry(ctx)),
              },
              // 诊断：确认关键服务是否注入成功
              services: {
                sessionProjections: Boolean(ctx.sessionProjections?.stateOf),
                agents: Boolean(ctx.agents?.list),
                tools: Boolean(ctx.tools?.register),
                webServer: Boolean(ctx.webServer?.register),
              },
            });
          }
          // GET /dsh-relay/diag —— 逐个会话打印实时上下文水位（诊断用）
          if (req.method === 'GET' && url.pathname === '/dsh-relay/diag') {
            const rows = [];
            try {
              const list = ctx.agents?.list?.() ?? [];
              for (const agent of list) {
                const sid = agent?.session?.id ?? agent?.id ?? '?';
                let proj = null;
                try {
                  proj = ctx.sessionProjections?.stateOf?.(agent.session, 'contextPressure') ?? null;
                } catch { /* ignore */ }
                const pt = Number(proj?.pressureTokens ?? 0);
                const cw = Number(proj?.contextWindow ?? 0);
                const m = measureContext({
                  projectedPressure: pt > 0 ? pt : undefined,
                  contextWindow: cw > 0 ? cw : undefined,
                  messages: agent?.session?.messages,
                  modelName: agent?.selection?.current?.model,
                });
                const resolved = flags.resolve(sid, {
                  globalEnabled: enabled,
                  isRelayChild: ledger.isRelayChild(sid),
                });
                rows.push({
                  sessionId: sid,
                  status: agent?.status,
                  title: agent?.session?.title ?? '',
                  pressureTokens: pt,
                  contextWindow: cw,
                  rawPercent: cw > 0 ? Math.round((pt / cw) * 100) : null,
                  measuredPercent: m.percent,
                  source: m.source,
                  mode: resolved.mode,
                  willTrigger: resolved.mode === 'on' && m.percent !== null && m.percent >= thresholdPercent,
                });
              }
            } catch (err) {
              return send(500, { error: String(err?.message ?? err) });
            }
            rows.sort((a, b) => (b.measuredPercent ?? 0) - (a.measuredPercent ?? 0));
            return send(200, { thresholdPercent, sessions: rows });
          }
          if (req.method === 'POST' && url.pathname === '/dsh-relay/reload') {
            const body = await readBody();
            // body.plugin 指定就重载那个插件，否则重载 relay 自己
            if (body.plugin) {
              const result = await reloadPlugin(ctx, String(body.plugin));
              return send(result.ok ? 200 : 500, result);
            }
            const result = await reloadSelf(ctx, {
              config: body.config,
              clearCache: body.clearCache !== false,
            });
            return send(result.ok ? 200 : 500, result);
          }
          // POST /dsh-relay/spawn-child —— 手动创建子智能体（验证用）
          if (req.method === 'POST' && url.pathname === '/dsh-relay/spawn-child') {
            if (!devEndpoints) return send(403, { ok: false, error: '此端点默认禁用（会创建会话）。要用请设 devEndpoints: true' });
            const body = await readBody();
            const parentId = String(body.parentId ?? '');
            const parent = (ctx.agents?.list?.() ?? []).find(
              (a) => (a?.session?.id ?? a?.id) === parentId,
            );
            if (!parent) return send(404, { ok: false, error: 'parent not found' });
            try {
              const created = await createSession(ctx, {
                cwd: resolveCwd(parent, ctx),
                parentAgent: parent,
                getRegistry: getWorkspaceRegistry,
              });
              if (!created) return send(500, { ok: false, error: 'createSession null' });
              // 记录父子映射（接力时 findParentAgent 要靠它找父）
              try { ledger.recordChildParent(created.sessionId, parentId); } catch {}
              // 验证层级
              // 探测 agent 对象结构，找父引用字段
              const agentKeys = Object.getOwnPropertyNames(created.agent ?? {}).slice(0, 40);
              const optKeys = Object.getOwnPropertyNames(created.agent?.options ?? {}).slice(0, 25);
              const optHasParent = Boolean(created.agent?.options?.parentAgent);
              const loopKeys = (() => { try { return Object.getOwnPropertyNames(created.agent?.loopCtx ?? {}).slice(0, 25); } catch { return []; } })();
              const scopeKeys = (() => { try { return Object.getOwnPropertyNames(created.agent?.scope ?? {}).slice(0, 20); } catch { return []; } })();
              const protoKeys = (() => { try { return Object.getOwnPropertyNames(Object.getPrototypeOf(created.agent) ?? {}).slice(0, 25); } catch { return []; } })();
              const isTop = isTopLevelAgent(created.agent);
              const foundParent = findParentAgent(created.agent);
              return send(200, {
                ok: true,
                childId: created.sessionId,
                isTopLevel: isTop,
                agentKeys,
                optKeys,
                optHasParent,
                loopKeys,
                scopeKeys,
                protoKeys,
                parentDetected: foundParent ? String(foundParent?.session?.id ?? foundParent?.id).slice(0, 24) : 'NOT-FOUND',
                expectedParent: parentId.slice(0, 24),
              });
            } catch (e) {
              return send(500, { ok: false, error: String(e?.message ?? e).slice(0, 150) });
            }
          }
          // POST /dsh-relay/stopgoals —— 停掉指定会话的 goal（清理测试垃圾用）
          if (req.method === 'POST' && url.pathname === '/dsh-relay/stopgoals') {
            if (!devEndpoints) return send(403, { ok: false, error: '此端点默认禁用（会改目标状态）。要用请设 devEndpoints: true' });
            const body = await readBody();
            const ids = Array.isArray(body.sessionIds) ? body.sessionIds : [];
            const gsvc = getGoals();
            const results = [];
            for (const sid of ids) {
              const item = { sid: String(sid).slice(0, 22) };
              try {
                const all = ctx.agents?.list?.() ?? [];
                const a = all.find((x) => (x?.session?.id ?? x?.id) === sid);
                if (!a) { item.noAgent = true; results.push(item); continue; }
                // 先 disarm（保证不再自动继续）
                try { gsvc?.disarm?.(a); item.disarmed = true; } catch (e) { item.disarmErr = String(e?.message ?? e).slice(0, 50); }
                // 再尝试 pause
                try {
                  const gv = ctx.sessionProjections?.stateOf?.(a.session, 'goal');
                  const g = gv?.current?.goal;
                  if (g && typeof g.id === 'string' && typeof g.revision === 'number') {
                    gsvc?.pause?.(a, { id: g.id, revision: g.revision });
                    item.paused = true;
                  }
                } catch (e) { item.pauseErr = String(e?.message ?? e).slice(0, 50); }
                results.push(item);
              } catch (e) { item.err = String(e?.message ?? e).slice(0, 60); results.push(item); }
            }
            return send(200, { ok: true, results });
          }
          // GET /dsh-relay/toolsdiag —— 看工具注册情况
          if (req.method === 'GET' && url.pathname === '/dsh-relay/toolsdiag') {
            const out = {};
            try {
              out.hasTools = Boolean(ctx.tools);
              // 用 get('tools') 查它注册了什么
              try {
                const svc = ctx.get?.('tools');
                if (svc) {
                  const L = svc.layers;
                  const arr = Array.isArray(L) ? L : Object.values(L ?? {});
                  out.svcLayers = arr.length;
                  out.svcLayerTools = [];
                  for (const lay of arr) {
                    const coll = lay?.tools ?? lay;
                    if (coll instanceof Map) {
                      out.svcLayerTools.push([...coll.keys()].filter((k) => /relay/i.test(String(k))));
                    }
                  }
                }
              } catch (e) { out.svcErr = String(e?.message).slice(0, 60); }
              try { out.toolsName = ctx.tools?.name ?? ctx.tools?.constructor?.name ?? '?'; } catch {}
              try { out.toolsCtx = ctx.tools?.ctx?.name ?? '?'; } catch {}
              try { out.proxyTarget = Object.prototype.toString.call(ctx.tools); } catch {}
              try {
                const g = ctx.get?.('tools');
                out.getToolsSame = g === ctx.tools;
                out.getToolsName = g?.name ?? '?';
              } catch (e) { out.getToolsErr = String(e?.message).slice(0, 50); }
              out.toolsKeys = ctx.tools ? Object.keys(ctx.tools).slice(0, 20) : [];
              const list = ctx.tools?.list?.() ?? ctx.tools?.all?.() ?? [];
              out.toolCount = Array.isArray(list) ? list.length : -1;
              out.relayTools = Array.isArray(list)
                ? list.filter((x) => /relay/i.test(x?.name ?? '')).map((x) => x.name)
                : [];
              // 看有没有 agent-scoped 注册能力
              out.registerFn = typeof ctx.tools?.register;
              try { out.registerSrc = String(ctx.tools.register).slice(0, 400); } catch (e) { out.registerSrc = 'err'; }
              // 试试各种 list 方式
              try { out.listLen = ctx.tools.list ? ctx.tools.list().length : 'no-list'; } catch (e) { out.listLen = 'err:' + String(e.message).slice(0, 40); }
              try {
                const L = ctx.tools.layers;
                out.layerCount = Array.isArray(L) ? L.length : Object.keys(L).length;
                out.layerDetail = [];
                const arr = Array.isArray(L) ? L : Object.values(L);
                for (const lay of arr) {
                  const item = {};
                  try { item.keys = Object.keys(lay ?? {}).slice(0, 8); } catch {}
                  try { item.size = lay?.size ?? lay?.length ?? lay?.tools?.size ?? -1; } catch {}
                  try { item.name = lay?.name ?? lay?.id ?? null; } catch {}
                  try {
                    const coll = lay?.tools ?? lay;
                    const names = [];
                    if (coll && typeof coll[Symbol.iterator] === 'function' && !Array.isArray(coll)) {
                      for (const v of coll) { if (names.length < 45) names.push(v?.name ?? v?.id ?? String(v).slice(0,20)); }
                    } else if (coll && typeof coll === 'object') {
                      for (const k of Object.keys(coll).slice(0, 45)) names.push(k);
                    }
                    // 尝试从 Map 直接读 key
                    try {
                      if (coll instanceof Map) {
                        item.mapKeys = [...coll.keys()].slice(0, 45).map(String);
                        item.mapRelay = item.mapKeys.filter((k) => /relay/i.test(k));
                      } else if (coll && typeof coll.entries === 'function') {
                        item.mapKeys = [...coll.entries()].slice(0, 45).map((e) => String(e[0]));
                        item.mapRelay = item.mapKeys.filter((k) => /relay/i.test(k));
                      }
                    } catch (e2) { item.mapErr = String(e2?.message ?? e2).slice(0, 50); }
                    item.names = names;
                    item.relayNames = names.filter((n) => /relay/i.test(String(n)));
                  } catch (e) { item.namesErr = String(e?.message ?? e).slice(0, 60); }
                  out.layerDetail.push(item);
                }
              } catch (e) { out.layerErr = String(e?.message ?? e).slice(0, 80); }
              out.scopedFn = typeof ctx.tools?.scoped;
              out.forAgentFn = typeof ctx.tools?.forAgent;
            } catch (e) { out.err = String(e?.message ?? e).slice(0, 120); }
            return send(200, out);
          }
          // POST /dsh-relay/fixgoal —— 把指定会话的 goal objective 替换成另一个会话的
          if (req.method === 'POST' && url.pathname === '/dsh-relay/fixgoal') {
            const out = { steps: [] };
            try {
              const body = await readBody();
              const fromId = String(body?.from ?? '');
              const toId = String(body?.to ?? '');
              if (!fromId || !toId) return send(400, { error: 'need from & to' });
              const gsvc = getGoals();
              if (!gsvc) return send(500, { error: 'no goals service' });
              const fromAgent = ctx.agents?.get?.(fromId);
              const toAgent = ctx.agents?.get?.(toId);
              if (!fromAgent || !toAgent) return send(404, { error: 'agent not found' });
              // 读源目标（goals.get 实时）
              const src = gsvc.get?.(fromAgent);
              const srcGoal = src?.current?.goal ?? (src?.objective ? src : null);
              if (!srcGoal?.objective) return send(400, { error: 'source has no goal' });
              out.steps.push('src:rev' + srcGoal.revision + ',len' + String(srcGoal.objective).length);
              // 读目标会话当前 goal
              const dst = gsvc.get?.(toAgent);
              const dstGoal = dst?.current?.goal ?? (dst?.objective ? dst : null);
              if (!dstGoal) return send(400, { error: 'target has no goal' });
              out.steps.push('dst:rev' + dstGoal.revision + ',len' + String(dstGoal.objective).length);
              // edit
              const r = gsvc.edit(toAgent, { id: dstGoal.id, revision: dstGoal.revision }, { objective: String(srcGoal.objective) });
              out.steps.push('edited:rev' + (r?.revision ?? '?'));
              out.editResult = { rev: r?.revision, objLen: String(r?.objective ?? '').length, phase: r?.phase };
              // 立即回读验证
              const check = gsvc.get?.(toAgent);
              const cg = check?.current?.goal ?? (check?.objective ? check : null);
              out.afterEdit = { rev: cg?.revision, objLen: String(cg?.objective ?? '').length, has99: String(cg?.objective ?? '').includes('99.0') };
              out.ok = true;
              out.newLen = String(r?.objective ?? '').length;
            } catch (e) { out.error = String(e?.message ?? e).slice(0, 200); }
            return send(200, out);
          }
          // GET /dsh-relay/driverdiag —— 看 goal 的 activation 状态
          if (req.method === 'GET' && url.pathname === '/dsh-relay/driverdiag') {
            const out = { agents: [] };
            try {
              const gsvc = getGoals();
              out.hasGoals = Boolean(gsvc);
              for (const a of (ctx.agents?.list?.() ?? [])) {
                const sid = a?.session?.id ?? a?.id;
                const item = { id: String(sid).slice(0, 24), status: a?.status };
                try {
                  const v = gsvc?.get?.(a);
                  if (v) {
                    item.phase = v.phase;
                    item.activation = v.activation;
                    item.revision = v.revision;
                    item.rounds = v.roundsStarted;
                    item.maxRounds = v.maxGoalRounds;
                    item.drivable = (v.phase === 'active' && v.activation === 'armed');
                    item.objLen = String(v.objective ?? '').length;
                    item.has99 = String(v.objective ?? '').includes('99.0');
                    // 同时读 projection 对比
                    try {
                      const gv = ctx.sessionProjections?.stateOf?.(a?.session, 'goal');
                      const pg = gv?.current?.goal;
                      item.projRev = pg?.revision;
                      item.projObjLen = String(pg?.objective ?? '').length;
                      item.projHas99 = String(pg?.objective ?? '').includes('99.0');
                    } catch {}
                  }
                } catch (e) { item.err = String(e?.message ?? e).slice(0, 60); }
                if (item.phase || item.err) out.agents.push(item);
              }
            } catch (e) { out.err = String(e?.message ?? e).slice(0, 80); }
            return send(200, out);
          }
          // GET /dsh-relay/goaldiag —— 看 goals.get 与 projection 的结构
          if (req.method === 'GET' && url.pathname === '/dsh-relay/goaldiag') {
            const out = { sessions: [] };
            try {
              const gsvc = getGoals();
              out.hasSvc = Boolean(gsvc);
              for (const a of (ctx.agents?.list?.() ?? []).slice(0, 12)) {
                const sid = a?.session?.id ?? a?.id;
                const item = { id: String(sid).slice(0, 22), status: a?.status };
                try {
                  const v = gsvc?.get?.(a);
                  item.view = v ? { keys: Object.keys(v).slice(0, 8), currentKeys: v?.current ? Object.keys(v.current).slice(0, 8) : null, phase: v?.current?.goal?.phase ?? v?.goal?.phase ?? null, objLen: String(v?.current?.goal?.objective ?? v?.goal?.objective ?? '').length } : null;
                } catch (e) { item.viewErr = String(e?.message ?? e).slice(0, 60); }
                try {
                  const gv = ctx.sessionProjections?.stateOf?.(a.session, 'goal');
                  item.proj = gv ? { keys: Object.keys(gv).slice(0, 8), currentKeys: gv?.current ? Object.keys(gv.current).slice(0, 8) : null, phase: gv?.current?.goal?.phase ?? null, objLen: String(gv?.current?.goal?.objective ?? '').length } : null;
                } catch (e) { item.projErr = String(e?.message ?? e).slice(0, 60); }
                out.sessions.push(item);
              }
            } catch (e) { out.err = String(e?.message ?? e).slice(0, 80); }
            return send(200, out);
          }
          // GET /dsh-relay/gh —— 检查 globalThis.__relayHandler
          if (req.method === 'GET' && url.pathname === '/dsh-relay/gh') {
            const fn = globalThis.__relayHandler;
            const src = typeof fn === 'function' ? Function.prototype.toString.call(fn) : '';
            return send(200, {
              exists: typeof fn === 'function',
              len: src.length,
              hasSpawnChild: src.includes('spawn-child'),
              hasAgents: src.includes('/dsh-relay/agents'),
              hasRt: src.includes('dsh-relay/rt'),
              hasWsprobe: src.includes('wsprobe'),
              head: src.slice(0, 200),
            });
          }
          // GET /dsh-relay/rt —— 列出 relay 路由 + 主路由 handler 版本特征
          if (req.method === 'GET' && url.pathname === '/dsh-relay/rt') {
            const out = { relayRoutes: [], mainHandlerFeatures: {} };
            try {
              const ws = ctx.webServer;
              let map = null;
              for (const k of Object.getOwnPropertyNames(ws ?? {})) {
                const v = ws[k];
                if (v instanceof Map && [...v.keys()].some((x) => String(x).startsWith('/dsh-relay'))) { map = v; break; }
              }
              if (map) {
                for (const [k, route] of map) {
                  if (String(k).startsWith('/dsh-relay')) {
                    out.relayRoutes.push({ path: k, hasHandler: typeof route?.handler === 'function' });
                  }
                }
                const main = map.get('/dsh-relay');
                if (main?.handler) {
                  const src = Function.prototype.toString.call(main.handler);
                  out.mainHandlerFeatures = {
                    len: src.length,
                    isForwarder: src.includes('__relayHandler'),
                    hasSpawnChild: src.includes('spawn-child'),
                    hasAgents: src.includes('/dsh-relay/agents'),
                    head: src.slice(0, 120),
                  };
                }
              }
            } catch (e) { out.err = String(e?.message ?? e).slice(0, 100); }
            return send(200, out);
          }
          // GET /dsh-relay/wsprobe —— 深度探测 webserver 内部路由表
          if (req.method === 'GET' && url.pathname === '/dsh-relay/wsprobe') {
            const out = { layers: [] };
            const seen = new Set();
            let obj = null;
            try { obj = ctx.webServer; } catch (e) { out.getErr = String(e?.message ?? e).slice(0,60); }

            const probe = (o, label) => {
              if (!o || seen.has(o)) return;
              seen.add(o);
              const info = { label, type: typeof o, keys: [], maps: [], protos: [] };
              // 1. 自有属性名（含不可枚举）
              try {
                info.keys = Object.getOwnPropertyNames(o).slice(0, 30);
              } catch (e) { info.keysErr = String(e?.message ?? e).slice(0,40); }
              // 2. 每个属性是不是 Map
              for (const k of info.keys) {
                try {
                  const v = o[k];
                  if (v instanceof Map) {
                    info.maps.push({ key: k, size: v.size, paths: [...v.keys()].slice(0, 20) });
                  }
                } catch (e) { /* Proxy 拦截 */ }
              }
              // 3. 原型链
              try {
                let pr = Object.getPrototypeOf(o);
                let depth = 0;
                while (pr && depth < 4) {
                  info.protos.push(Object.getOwnPropertyNames(pr).slice(0, 15));
                  pr = Object.getPrototypeOf(pr);
                  depth++;
                }
              } catch (e) { /* ignore */ }
              out.layers.push(info);
            };

            probe(obj, 'ctx.webServer');
            // 也探 cordis Service 包装
            try { probe(ctx.get?.('webServer'), 'ctx.get(webServer)'); } catch {}
            // 从原型链上找 Service 的 target
            try {
              const ws = obj;
              for (const sym of Object.getOwnPropertySymbols(ws ?? {})) {
                try { probe(ws[sym], 'symbol:' + String(sym).slice(0, 30)); } catch {}
              }
            } catch {}

            return send(200, out);
          }
          // GET /dsh-relay/agents —— 列出所有 agent 及其层级
          if (req.method === 'GET' && url.pathname === '/dsh-relay/agents') {
            const out = { topLevel: [], children: [], all: 0 };
            try {
              const all = ctx.agents?.list?.() ?? [];
              out.all = all.length;
              for (const a of all) {
                const id = (a?.session?.id ?? a?.id) ?? '?';
                const item = {
                  id: id.slice(0, 24),
                  status: a?.status,
                  top: isTopLevelAgent(a),
                  parent: null,
                };
                if (!item.top) {
                  const pa = findParentAgent(a);
                  item.parent = pa ? String(pa?.session?.id ?? pa?.id ?? '?').slice(0, 24) : 'NOT-FOUND';
                }
                if (item.top) out.topLevel.push(item);
                else out.children.push(item);
              }
            } catch (e) { out.err = String(e?.message ?? e).slice(0, 80); }
            return send(200, out);
          }
          // GET /dsh-relay/entries —— 列出所有可重载的插件 id
          // GET /dsh-relay/wsdiag —— 诊断 webserver 结构
          if (req.method === 'GET' && url.pathname === '/dsh-relay/wsdiag') {
            const out = { routePrefix: ROUTE_PREFIX };
            try {
              const ws = ctx.webServer;
              out.wsType = typeof ws;
              out.wsKeys = ws ? Object.keys(ws).slice(0, 20) : null;
              try { out.hasPrefixes = ws?.prefixes instanceof Map; } catch (e) { out.prefixesErr = String(e?.message).slice(0, 60); }
              try {
                const real = Reflect.get(ws, 'prefixes');
                out.reflectPrefixes = real instanceof Map;
                if (real instanceof Map) out.routePaths = [...real.keys()];
              } catch (e) { out.reflectErr = String(e?.message).slice(0, 60); }
            } catch (e) { out.err = String(e?.message).slice(0, 80); }
            return send(200, out);
          }
          if (req.method === 'GET' && url.pathname === '/dsh-relay/entries') {
            return send(200, { entries: listEntryIds(ctx) });
          }
          // POST /dsh-relay/hotswap —— 真·热重载
          //   自举破局：不依赖进程内的 loadFresh（那可能是旧版），
          //   这里【内联】实现 readFileSync + new Function，保证每次都用磁盘最新代码。
          if (req.method === 'POST' && url.pathname === '/dsh-relay/hotswap') {
            const body = await readBody();
            const libDir =
              body.libDir ??
              path.join(
                process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
                'profiles',
                'desktop',
                'vendor',
                'dsh-relay',
                'lib',
              );
            const steps = [];
            try {
              // ---- 内联 ESM→CJS 转换 + 执行（不依赖任何外部模块）----
              const inlineLoad = (targetFile) => {
                const src = fs.readFileSync(targetFile, 'utf8');
                const exp = [];
                let code = src;
                // import-meta
                code = code.replace(/import\.meta\.url/g, '__importMetaUrl');
                code = code.replace(/import\.meta\b(?!\.)/g, '__importMeta');
                // import X from 'y'
                code = code.replace(
                  /^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?\s*$/gm,
                  (_, n, s) => `const ${n} = __req(${JSON.stringify(s)});`,
                );
                // import * as X from 'y'
                code = code.replace(
                  /^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?\s*$/gm,
                  (_, n, s) => `const ${n} = __req(${JSON.stringify(s)});`,
                );
                // import { a, b as c } from 'y'
                code = code.replace(
                  /^\s*import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm,
                  (_, names, s) => {
                    const cl = names
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean)
                      .map((x) => x.replace(/\s+as\s+/, ': '))
                      .join(', ');
                    return `const { ${cl} } = __req(${JSON.stringify(s)});`;
                  },
                );
                // import 'y'
                code = code.replace(
                  /^\s*import\s+['"]([^'"]+)['"];?\s*$/gm,
                  (_, s) => `__req(${JSON.stringify(s)});`,
                );
                // export const/function/class
                code = code.replace(
                  /^\s*export\s+(const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm,
                  (_, k, n) => {
                    exp.push(n);
                    return `${k} ${n}`;
                  },
                );
                // export { a, b as c }
                code = code.replace(/^\s*export\s+\{([^}]+)\};?\s*$/gm, (_, names) => {
                  return names
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean)
                    .map((x) => {
                      const m = x.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
                      return m ? `__exp[${JSON.stringify(m[2])}] = ${m[1]};` : `__exp[${JSON.stringify(x)}] = ${x};`;
                    })
                    .join('\n');
                });
                // export default
                code = code.replace(/^\s*export\s+default\s+/gm, '__exp.default = ');
                // 追加导出
                if (exp.length) {
                  code += '\n' + exp.map((n) => `__exp[${JSON.stringify(n)}] = ${n};`).join('\n');
                }

                const dir = path.dirname(targetFile);
                const reqFromHere = createRequire(targetFile);
                const __req = (spec) => {
                  if (!spec.startsWith('.') && !spec.startsWith('/')) return reqFromHere(spec);
                  let t = path.resolve(dir, spec);
                  if (!t.endsWith('.js')) {
                    if (fs.existsSync(t + '.js')) t += '.js';
                    else if (fs.existsSync(path.join(t, 'index.js'))) t = path.join(t, 'index.js');
                  }
                  return inlineLoad(t);
                };
                const __exp = {};
                const metaUrl = 'file:///' + targetFile.replace(/\\/g, '/');
                // eslint-disable-next-line no-new-func
                const fn = new Function(
                  '__req',
                  '__exp',
                  'require',
                  'module',
                  '__moduleDir',
                  '__moduleFile',
                  '__importMetaUrl',
                  '__importMeta',
                  code,
                );
                const modObj = { exports: __exp };
                fn(__req, __exp, reqFromHere, modObj, dir, targetFile, metaUrl, { url: metaUrl });
                return modObj.exports;
              };

              steps.push('内联加载中...');
              const fresh = inlineLoad(path.join(libDir, 'index.js'));
              steps.push('导出: ' + Object.keys(fresh).join(','));
              if (typeof fresh.apply !== 'function') {
                return send(500, { ok: false, error: 'fresh.apply 不是函数', steps });
              }

              // 顺序很关键：
              //   1. 先手动清掉旧路由（entry.update 不会清，因为旧 fiber 在别的 context）
              //   2. 再 apply 新代码
              const entry = findEntry(ctx);
              if (entry) {
                try {
                  await entry.update({}, false, true);
                  steps.push('entry.update: OK');
                } catch (e) {
                  steps.push('entry.update: ' + String(e?.message ?? e).slice(0, 50));
                }
              }

              // ★ 正确的热重载做法（2026-10-24 定案）：
              //   1. 清掉所有 /dsh-relay 和 /dsh-relay-gN 旧路由
              //   2. 允许重新注册
              //   3. apply 新代码 —— 它会注册「主路由 + 转发器」，转发器指向
              //      globalThis.__relayHandler，所以以后每次热重载都自动跟随最新代码，
              //      不需要再注册新路由。
              //
              //   之前用「每次注册新前缀」的降级方案，导致累积 30+ 个残留路由，
              //   主路由的 handler 却是某个中间版本的闭包（不跟随更新）。
              try {
                const ws = ctx.webServer;
                let map = null;
                // 遍历自有属性名找 Map（这样能绕过 Proxy 的 get 拦截）
                try {
                  for (const k of Object.getOwnPropertyNames(ws ?? {})) {
                    const v = ws[k];
                    if (v instanceof Map && [...v.keys()].some((x) => String(x).startsWith('/dsh-relay'))) {
                      map = v;
                      break;
                    }
                  }
                } catch { /* ignore */ }

                if (map) {
                  let deleted = 0;
                  for (const key of [...map.keys()]) {
                    const s = String(key);
                    if (s === '/dsh-relay' || s.startsWith('/dsh-relay-g')) {
                      map.delete(key);
                      deleted++;
                    }
                  }
                  steps.push(`清理旧路由: ${deleted}`);
                } else {
                  steps.push('找不到路由表（跳过清理）');
                }
                // 允许 apply 重新注册主路由
                globalThis.__relayRouteInstalled = false;
              } catch (e) {
                steps.push('清理异常: ' + String(e?.message ?? e).slice(0, 50));
              }

              // 不再传 __routePrefix —— 让新代码注册主路径 /dsh-relay
              const freshConfig = { ...config };
              delete freshConfig.__routePrefix;
              delete freshConfig.__routeGen;

              fresh.apply(ctx, freshConfig);
              steps.push('新 apply 已执行（主路由+转发器）');

              // ★ 接管旧路由：把 /dsh-relay 的 handler 换成新代码的
              try {
                const ws = ctx.webServer;
                let map = null;
                // 各种可能的拿法
                for (const key of ['prefixes', '_prefixes']) {
                  try { if (ws?.[key] instanceof Map) { map = ws[key]; break; } } catch {}
                }
                if (!map) {
                  // 用 Reflect 绕过 Proxy
                  try {
                    const real = Reflect.get(ws, 'prefixes');
                    if (real instanceof Map) map = real;
                  } catch {}
                }
                if (map && map.has('/dsh-relay') && map.has(ROUTE_PREFIX)) {
                  const oldRoute = map.get('/dsh-relay');
                  const newRoute = map.get(ROUTE_PREFIX);
                  oldRoute.handler = newRoute.handler;   // 直接换 handler
                  steps.push('✅ 旧路由已接管新 handler');
                } else {
                  steps.push('接管失败: map=' + Boolean(map) + ' old=' + (map?.has('/dsh-relay')) + ' new=' + (map?.has(ROUTE_PREFIX)));
                }
              } catch (e) {
                steps.push('接管异常: ' + String(e?.message ?? e).slice(0, 50));
              }

              return send(200, { ok: true, detail: '热重载完成', libDir, steps, at: Date.now() });
            } catch (err) {
              return send(500, {
                ok: false,
                error: String(err?.message ?? err),
                stack: String(err?.stack ?? '').split('\n').slice(0, 4).join(' | '),
                steps,
                libDir,
              });
            }
          }
          // POST /dsh-relay/hmr —— 用 DSH 官方 hmr 服务清 ESM 缓存后重载
          //   body: { manifest?: "包目录路径", plugin?: "entry id" }
          //   DSH 自带 dsh-hmr（ctx.hmr），它的 invalidate() 能真正清掉 ESM 解析缓存，
          //   这是纯 entry.update() 做不到的。
          if (req.method === 'POST' && url.pathname === '/dsh-relay/hmr') {
            const body = await readBody();
            const steps = [];
            const hmr = ctx.hmr;
            if (!hmr || typeof hmr.invalidate !== 'function') {
              return send(500, {
                ok: false,
                error: 'ctx.hmr 不可用（DSH 未启用 hmr 服务）',
                steps,
              });
            }
            // 1. 清缓存：传 package.json 路径，hmr 会清整个包目录的 ESM 解析缓存
            const target =
              body.manifest ??
              body.packageDir ??
              path.join(
                process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
                'profiles',
                'desktop',
                'node_modules',
                'dsh-relay',
              );
            const manifest = target.endsWith('package.json') ? target : path.join(target, 'package.json');
            try {
              hmr.invalidate(manifest);
              steps.push({ step: 'invalidate', ok: true, manifest });
            } catch (err) {
              steps.push({ step: 'invalidate', ok: false, error: String(err?.message ?? err) });
            }
            // 2. 可选：重载指定插件
            if (body.plugin) {
              const r = await reloadPlugin(ctx, String(body.plugin));
              steps.push({ step: 'reloadPlugin', ...r });
            }
            // 3. 默认重载 relay 自己
            if (!body.plugin || body.alsoSelf === true) {
              const r = await reloadSelf(ctx, { clearCache: false });
              steps.push({ step: 'reloadSelf', ...r });
            }
            const ok = steps.every((s) => s.ok !== false);
            return send(ok ? 200 : 500, { ok, steps });
          }
          // POST /dsh-relay/force —— 手动对指定会话强制触发一次接力（诊断用）
          //   body: { sessionId: "..." }
          if (req.method === 'POST' && url.pathname === '/dsh-relay/force') {
            if (!devEndpoints) return send(403, { ok: false, error: '此端点默认禁用（会创建会话）。要用请在 cordis.patch.yml 设 devEndpoints: true' });
            const body = await readBody();
            const sid = String(body.sessionId ?? '');
            if (!sid) return send(400, { error: 'sessionId required' });
            const trace = [];
            try {
              trace.push({ step: 'find-agent' });
              let agent = null;
              try {
                agent = ctx.agents?.get?.(sid) ?? null;
              } catch (e) {
                trace.push({ step: 'find-agent', error: String(e?.message ?? e) });
              }
              if (!agent) {
                const list = ctx.agents?.list?.() ?? [];
                agent = list.find((a) => (a?.session?.id ?? a?.id) === sid) ?? null;
                trace.push({ step: 'find-agent-by-list', found: Boolean(agent) });
              }
              if (!agent) {
                return send(404, { ok: false, error: '找不到该会话的 agent', trace });
              }
              trace.push({ step: 'agent-found', status: agent.status });

              // ★ 尊重用户的会话开关（2026-10-24）：
              //   以前 /force 无条件接力，导致用户明明关了开关却看到会话被接力。
              //   默认按开关判断，需要强制时传 { bypass: true }。
              const bypass = body.bypass === true;
              if (!bypass) {
                const resolved = flags.resolve(sid, {
                  globalEnabled: enabled,
                  isRelayChild: ledger.isRelayChild(sid),
                });
                trace.push({ step: 'flag-check', mode: resolved.mode, reason: resolved.reason });
                if (resolved.mode === MODE_OFF) {
                  return send(409, {
                    ok: false,
                    error: `该会话接力开关是关闭的（${resolved.reason}），拒绝接力。要强制请传 bypass:true`,
                    trace,
                  });
                }
                if (ledger.hasRelayed(sid)) {
                  return send(409, {
                    ok: false,
                    error: '该会话已经接力过了（要强制请传 bypass:true）',
                    trace,
                  });
                }
              }

              // 直接调 performRelay，把内部结果返回
              const result = await performRelay({
                agent,
                sessionId: sid,
                goal: agent?.session?.title ?? '',
                reason: bypass ? 'force-bypass' : 'force',
              });
              trace.push({ step: 'performRelay', ...result });
              return send(result.ok ? 200 : 500, { ok: result.ok, trace });
            } catch (err) {
              trace.push({ step: 'exception', error: String(err?.message ?? err), stack: String(err?.stack ?? '').slice(0, 500) });
              return send(500, { ok: false, trace });
            }
          }
          // POST /dsh-relay/selftest —— 安全自检：建一个空会话，验证是顶层还是子智能体
          if (req.method === 'POST' && url.pathname === '/dsh-relay/selftest') {
            if (!devEndpoints) return send(403, { ok: false, error: '此端点默认禁用（会创建会话）。要用请设 devEndpoints: true' });
            try {
              const before = ctx.agents?.roots?.()?.length ?? -1;
              const created = await createSession(ctx, {});
              if (!created) {
                return send(500, { ok: false, error: 'createSession 返回 null' });
              }
              const after = ctx.agents?.roots?.()?.length ?? -1;
              const all = ctx.agents?.list?.()?.length ?? -1;
              const isRoot = ctx.agents
                ?.roots?.()
                ?.some((a) => (a?.session?.id ?? a?.id) === created.sessionId);
              const result = {
                ok: true,
                sessionId: created.sessionId,
                isTopLevel: isRoot,
                verdict: isRoot ? '✅ 顶层会话（侧栏可见）' : '❌ 子智能体（侧栏不可见）',
                rootsBefore: before,
                rootsAfter: after,
                allAgents: all,
              };
              // 立即销毁，不留垃圾
              try {
                created.handle?.agent?.cancel?.({ kind: 'user' });
              } catch { /* ignore */ }
              return send(200, result);
            } catch (err) {
              return send(500, { ok: false, error: String(err?.message ?? err) });
            }
          }
          return send(404, { error: 'not found' });
        } catch (err) {
          return send(500, { error: String(err?.message ?? err) });
        }
    };

    // ★ 自愈式路由注册（2026-10-24 定案）
    //   每次 apply 都：
    //     1. 清掉所有 /dsh-relay 和 /dsh-relay-gN 旧路由
    //     2. 重新注册主路由 /dsh-relay（handler 是转发器）
    //   转发器指向 globalThis.__relayHandler，而它每次 apply 都会被更新，
    //   所以主路由永远跟随最新代码。
    //
    //   这样即使本次 apply 是由【旧代码的 hotswap 端点】调用的（自举悖论），
    //   只要 apply 一执行就完成自愈，不需要重启。
    //
    //   之前的做法（只注册一次 / 冲突就降级到 -gN）导致累积 30+ 残留路由，
    //   而主路由的 handler 停在某个中间版本的闭包上，永远不更新。
    try {
      const ws = ctx.webServer;
      let map = null;
      try {
        // 遍历自有属性名（能绕过 Proxy 的 get 拦截）
        for (const k of Object.getOwnPropertyNames(ws ?? {})) {
          const v = ws[k];
          if (v instanceof Map && [...v.keys()].some((x) => String(x).startsWith('/dsh-relay'))) {
            map = v;
            break;
          }
        }
      } catch { /* ignore */ }

      if (map) {
        let deleted = 0;
        for (const key of [...map.keys()]) {
          const s = String(key);
          if (s === '/dsh-relay' || s.startsWith('/dsh-relay-g')) {
            map.delete(key);
            deleted++;
          }
        }
        if (deleted > 0) {
          ctx.logger?.info?.(`[dsh-relay] 清理了 ${deleted} 个旧路由`);
        }
      }
    } catch { /* 清理失败不影响注册 */ }

    try {
      return ctx.webServer.register(buildRoute('/dsh-relay'));
    } catch (err) {
      if (!/duplicate/i.test(String(err?.message ?? err))) throw err;
      ctx.logger?.warn?.('[dsh-relay] /dsh-relay 路由已存在，复用');
      return () => {};
    }
  }, 'dsh-relay: routes');

  // ★ 把本次的 realHandler 挂到全局，主路由转发器会用它。
  //   每次 apply 都覆盖，所以热重载后主路径立即用新逻辑。
  globalThis.__relayHandler = realHandlerRef.current;
  ctx.effect?.(() => () => {
    if (globalThis.__relayHandler === realHandlerRef.current) globalThis.__relayHandler = undefined;
  }, 'dsh-relay: handler registry');

  // ★ 自动接管：确保 /dsh-relay 主路径用的是【本次】的 handler。
  //   每次 apply 都执行，不管是谁调用的、ROUTE_PREFIX 是什么。
  try {
    const ws = ctx.webServer;
    let map = null;
    try {
      if (ws?.prefixes instanceof Map) map = ws.prefixes;
    } catch { /* Proxy 拦截 */ }
    if (!map) {
      try {
        const real = Reflect.get(ws, 'prefixes');
        if (real instanceof Map) map = real;
      } catch { /* ignore */ }
    }

    if (map) {
      const mine = map.get(ROUTE_PREFIX);
      const main = map.get('/dsh-relay');
      if (mine && main && mine !== main) {
        // 用本次 handler 覆盖主路径
        main.handler = mine.handler;
        ctx.logger?.info?.('[dsh-relay] 已接管主路由 /dsh-relay');
      } else if (mine && !main && ROUTE_PREFIX !== '/dsh-relay') {
        // 主路径不存在，把本次路由改名成主路径
        map.delete(ROUTE_PREFIX);
        mine.path = '/dsh-relay';
        map.set('/dsh-relay', mine);
        ctx.logger?.info?.('[dsh-relay] 主路由已建立');
      }
    }
  } catch { /* 拿不到就跳过 */ }

  // ---------- 执行一次接力 ----------
  /**
   * @param {object} opts
   * @param {object} opts.agent      - 源会话 agent
   * @param {string} opts.sessionId
   * @param {string} [opts.goal]
   * @param {string} [opts.reason]
   */
  /**
   * 接力入口（wrapper）—— 统一管理 ledger 标记的生命周期。
   *
   * 为什么需要 wrapper：原实现把「标记 + 回滚」散在函数各处，一旦中途抛出
   * 未捕获异常（比如 resolveCwd / sendToAgent 抛错），标记就会永久残留，
   * 那个会话再也无法接力。这里把所有情况收敛到一处：
   *   - 进入前立刻标记（防止连锁接力）
   *   - 返回 ok:false 或抛异常 → 回滚标记（允许下次重试）
   *   - 返回 ok:true → 标记保留（并已由 inner 补上 to 字段）
   */
  async function performRelay(opts) {
    const sessionId = opts?.sessionId;
    const reason = opts?.reason ?? 'auto';
    const alreadyMarked = sessionId ? ledger.hasRelayed(sessionId) : false;

    if (sessionId && !alreadyMarked) {
      try { ledger.record(sessionId, '', 'started:' + reason); } catch { /* ignore */ }
    }

    try {
      const result = await performRelayInner(opts);
      if (sessionId && !alreadyMarked && !result?.ok) {
        // 业务失败（没抛异常但没成功）→ 允许重试
        try { ledger.unmark(sessionId); } catch { /* ignore */ }
      }
      return result;
    } catch (err) {
      if (sessionId && !alreadyMarked) {
        try { ledger.unmark(sessionId); } catch { /* ignore */ }
      }
      return { ok: false, error: '接力异常: ' + String(err?.message ?? err) };
    }
  }

  /**
   * 准备阶段：只投递「写 STATE.md」指令，然后返回。
   *
   * 用户要求（2026-10-24）：「让原会话决定啥时候转移」
   *   → 不再靠超时猜模型写没写完，而是让模型写完 STATE.md 后
   *     主动调用 relay_transfer 工具，由它触发真正的转移。
   *
   * @returns {{ok:boolean, error?:string}}
   */
  async function beginRelay({ agent, sessionId, reason = 'auto' }) {
    // 标记：防止连锁接力（模型写 STATE.md 会触发 turn/end）
    if (!ledger.hasRelayed(sessionId)) {
      try { ledger.record(sessionId, '', 'started:' + reason); } catch { /* ignore */ }
    }

    const sent = sendToAgent(agent, buildSummaryPrompt(stateFileName), {
      kind: 'relay',
      role: 'summary',
    });
    if (!sent) {
      if (!ledger.hasRelayed(sessionId)) return { ok: false, error: '无法投递总结指令' };
      try { ledger.unmark(sessionId); } catch { /* ignore */ }
      return { ok: false, error: '无法投递总结指令（agent.followup 不可用）' };
    }

    log.info?.(`[dsh-relay] 已请 ${String(sessionId).slice(0, 20)} 写 STATE.md，等它主动调 relay_transfer`);
    return { ok: true };
  }

  async function performRelayInner({ agent, sessionId, goal = '', reason = 'auto' }) {
    const cwd = resolveCwd(agent, ctx);

    // 注意：ledger 标记由外层 performRelay wrapper 统一管理（记录 + 失败回滚），
    //       这里不再重复处理，避免两处逻辑分散导致标记残留。

    /** 接力失败的返回值（标记回滚由外层 performRelay wrapper 统一处理） */
    const fail = (error) => ({ ok: false, error });

    // 1. STATE.md 已由 relay_transfer 工具确认写好（见 beginRelay + relay_transfer）
    //    这里不再投递指令、不再等文件 —— 彻底消除「抢跑」风险。

    // 1.5 注意：followup 内部就是 send(msg, "next-turn", wakeup=true)，
    //     它会调用 wakeDriver() 自动唤醒 agent，不需要我们手动 kick。
    //     （2026-10-24 从 dsh-agent-loop 源码确认）

    // ★ 2026-10-24 重构：不再在这里等 STATE.md、也不等 idle。
    //   原因（用户指出的「抢跑」风险）：靠超时猜模型写没写完，一定会猜错 ——
    //     超时短了 → 抢跑（用旧/空 STATE.md 建新会话）
    //     超时长了 → 卡死（一轮压一轮）
    //   现在改成两阶段，由【原会话自己决定】何时转移：
    //     1. beginRelay()：只投递「写 STATE.md」指令
    //     2. 模型写完 STATE.md 后主动调 relay_transfer 工具
    //     3. relay_transfer → performRelay → 建新会话
    //   所以这里天然是「已就绪」状态，不需要任何等待。

    // 4. 建新顶层会话（继承原会话的 cwd + 模型 + preset）
    //    模型必须传，否则新会话的 {{model}} 变量为空 → 报
    //    'prompt variable "{{model}}" has no value'
    //
    // 注意：sessionProjections 的 modelSelection 结构是
    //   { lastUsed: { provider, model, reasoningEffort }, pending: null }
    //   没有 .current 字段！（2026-10-24 实测踩坑）
    let provider;
    try {
      const sel = ctx.sessionProjections?.stateOf?.(agent.session, 'modelSelection');
      // 依次尝试：pending（用户刚切的）→ lastUsed（上次用的）→ 旧结构
      if (sel?.pending?.provider) provider = sel.pending;
      else if (sel?.lastUsed?.provider) provider = sel.lastUsed;
      else if (sel?.current?.provider) provider = sel.current;
      else if (agent?.selection?.current?.provider) provider = agent.selection.current;
    } catch {
      provider = undefined;
    }

    // 还拿不到就用全局默认模型
    if (!provider?.provider) {
      try {
        const def = ctx.agentDefaultModel?.currentSelection?.();
        if (def?.provider) provider = def;
      } catch { /* ignore */ }
    }

    // ★ 读取源会话的权限设置，新会话要继承（用户要求：完全权限等要带过去）
    let permPreset = null;
    let permState = null;
    try {
      const pp = getPermissionPresets();
      if (pp) {
        try { permPreset = pp.current?.(agent.session) ?? null; } catch { /* ignore */ }
        try { permState = pp.permissionState?.(agent.session) ?? null; } catch { /* ignore */ }
      }
      // 兜底：直接读投影
      if (!permState) {
        try {
          permState = ctx.sessionProjections?.stateOf?.(agent.session, 'permissions') ?? null;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // ★ 判断这次接力是「顶层会话接力」还是「子智能体接力」
    //   用户要求（2026-10-24）：子智能体也能接力，但产物必须是子智能体，
    //   挂在同一个父之下、位置不变、能和主会话交流。
    const topLevel = isTopLevelAgent(agent);
    const parentAgent = topLevel ? null : findParentAgent(agent);

    const created = await createSession(ctx, {
      cwd,
      // ★ 多路兜底读 preset（2026-10-25 实测）：
      //   agent.session.meta.agentPreset 读不到时会退回默认，
      //   而旧默认值是无效的（resume 报 Unknown agent preset）。
      agentPreset: (() => {
        const cands = [
          agent?.session?.meta?.agentPreset,
          agent?.session?.agentPreset,
          agent?.options?.agentPreset,
          agent?.preset,
          agent?.session?.meta?.preset,
        ];
        for (const c of cands) if (typeof c === 'string' && c.length > 0 && c !== 'default') return c;
        return 'standard';
      })(),
      provider,
      getRegistry: getWorkspaceRegistry,   // ★ 传获取函数，绕过 inject 限制
      ...(parentAgent ? { parentAgent } : {}),   // 子智能体接力：挂回同一个父
    });
    if (!created) {
      return fail('新会话创建失败');
    }

    const modelLog = provider && provider.provider
      ? [`${provider.provider}/${provider.model}`]
      : ['no-model'];

    const kindLog = topLevel
      ? ['top-level']
      : [parentAgent ? 'child-of:' + String(parentAgent?.session?.id ?? parentAgent?.id ?? '?').slice(0, 16) : 'child-no-parent'];

    // ★ 记录父子映射：新会话是子智能体时，把「新会话 → 父」记下来，
    //   将来这个子智能体要接力时能查回它的父（保持在同一主会话里）。
    if (!topLevel && parentAgent) {
      try {
        const pid = parentAgent?.session?.id ?? parentAgent?.id;
        if (pid) {
          ledger.recordChildParent(created.sessionId, pid);
          kindLog.push('parent-recorded');
        }
      } catch { /* 记录失败不影响接力 */ }
    }

    // 5. 新会话默认开启接力
    //    注意：不要覆盖用户已有的显式设置（用户可能刚把它关掉）。
    //    只有完全没设置过时才写入 ON。
    if (flags.get(created.sessionId) === undefined) {
      flags.set(created.sessionId, MODE_ON, 'relay-child-auto');
    }

    // 5.2 ★ 继承源会话的权限设置（danger-full-access 等）
    //     用户要求：原会话被允许的权限必须带过去，否则新会话权限不足会卡住。
    let permLog = [];
    try {
      const newSession = created.agent?.session;
      if (newSession && permPreset) {
        const pp = getPermissionPresets();
        if (pp && typeof pp.apply === 'function') {
          const approval = getApproval();
          pp.apply(newSession, permPreset, (policy) => {
            try { approval?.setPolicy?.(created.agent, policy); } catch { /* */ }
          });
          permLog.push('applied:' + permPreset);
        } else {
          permLog.push('no permissionPresets');
        }
      } else if (!permPreset) {
        permLog.push('source preset unknown');
      }
      // 兜底：直接按投影里的 sandbox 设置
      if (permState?.sandbox) {
        try {
          const shell = ctx.get?.('shell') ?? ctx.shell;
          if (shell && typeof shell.setSandboxMode === 'function') {
            shell.setSandboxMode(newSession, permState.sandbox);
            permLog.push('sandbox:' + permState.sandbox);
          }
        } catch (e) {
          permLog.push('sandbox err');
        }
      }
    } catch (e) {
      permLog.push('err:' + String(e?.message ?? e).slice(0, 50));
    }
    if (permLog.length) {
      log.info?.(`[dsh-relay] 权限继承: ${permLog.join(' | ')}`);
    }

    // 5.5 记录工作区挂载诊断（失败不影响接力，但必须能查到原因）
    if (Array.isArray(created.attachLog) && created.attachLog.length > 0) {
      const attached = created.attachLog.includes('ATTACHED');
      if (attached) {
        log.info?.(`[dsh-relay] 新会话已挂到工作区 ${cwd}`);
      } else {
        log.warn?.(
          `[dsh-relay] 新会话未能挂到工作区 ${cwd}：${created.attachLog.join(' | ')}`,
        );
      }
    }

    // 5.8 ★ 给新会话设置 goal
    //     用户要求（2026-10-24）：
    //       「如果没有目标的话，就不用创建目标，对于其他会话也是这样」
    //     → 只在【源会话本身有 goal】时才给新会话建目标，否则完全不动 goal。
    //     （之前会拿 STATE.md / 标题 / 兜底文案硬造一个目标，是错的。）
    let goalLog = [];
    try {
      const goalsSvc = getGoals();
      const newSession = created.agent?.session;
      if (!goalsSvc || typeof goalsSvc.create !== 'function') {
        goalLog.push('no goals service');
      } else if (!newSession) {
        goalLog.push('no new session');
      } else {
        // 只认源会话自己的 goal —— 没有就不建
        let sourceGoal = null;

        // ★ 结构差异（2026-10-24 实测踩坑，必须区分）：
        //   projection.stateOf(session,'goal') → { current: { goal: {...} }, seenGoalIds, failure }
        //   goals.get(agent)                   → 【扁平】{ id, revision, objective, phase, maxGoalRounds, ... }
        //   早先按 v.current.goal 读 view，永远是 undefined → 误报"无目标"。
        //
        // ★ 顺序调整（2026-10-25 实测踩坑）：
        //   原来 projection 优先，但 projection 是【异步缓存】，可能滞后 ——
        //   实测接力时 projection 还是 revision 3（802字），而 goals.get 已是 revision 9（1178字）。
        //   结果新会话继承了旧目标，丢了「最终目标 99.0」等关键内容。
        //   现在改成 goals.get()（实时）优先，projection 兜底。

        // 1) goals.get（实时，最准确）
        try {
          const v = goalsSvc.get?.(agent);
          const flat = v?.current?.goal ?? (v?.objective ? v : null);
          if (flat?.objective) sourceGoal = flat;
        } catch { /* ignore */ }

        // 2) 退回 projection（缓存，可能滞后）
        if (!sourceGoal?.objective) {
          try {
            const gv = ctx.sessionProjections?.stateOf?.(agent.session, 'goal');
            sourceGoal = gv?.current?.goal ?? null;
          } catch { /* ignore */ }
        }

        // 3) 两者都拿到时，取 revision 更大的那个（更接近真实）
        try {
          const gv = ctx.sessionProjections?.stateOf?.(agent.session, 'goal');
          const pg = gv?.current?.goal;
          if (pg?.objective) {
            const pgRev = Number(pg.revision ?? 0);
            const curRev = Number(sourceGoal?.revision ?? -1);
            if (!sourceGoal?.objective || pgRev > curRev) {
              sourceGoal = pg;
              goalLog.push(`used-projection:rev${pgRev}>${curRev}`);
            }
          }
        } catch { /* ignore */ }

        // 3) 过滤 phase：已完成的目标不再继承（用户要求：没有（未完成的）目标就不建）
        const INHERIT_PHASES = new Set(['active', 'paused', 'blocked']);
        if (sourceGoal && !INHERIT_PHASES.has(sourceGoal.phase)) {
          goalLog.push(`source-phase:${sourceGoal.phase} → skip`);
          sourceGoal = null;
        }

        if (!sourceGoal?.objective) {
          goalLog.push('source-has-no-goal → skip');
        } else {
          const objective = String(sourceGoal.objective);
          const goalSource = 'source-goal';
          // 轮数：继承源目标的轮数上限；源没设或为 0 时用配置值兜底
          const maxGoalRounds = Number(
            sourceGoal.maxGoalRounds ?? config.inheritGoalRounds ?? 10000,
          );

          const request = { objective, maxGoalRounds };
          try {
            goalsSvc.create(created.agent, request);
            goalLog.push(`created:${maxGoalRounds}rounds,src=${goalSource}`);

            // 源会话目标停止（新会话已经接上，源不能再跑同一个目标）
            try {
              const extractRef = (v) => {
                if (!v || typeof v !== 'object') return null;
                const g = v?.current?.goal ?? v?.goal ?? v?.current ?? v;
                if (g && typeof g.id === 'string' && typeof g.revision === 'number') {
                  return { id: g.id, revision: g.revision };
                }
                return null;
              };
              let ref = null;
              try {
                ref = extractRef(ctx.sessionProjections?.stateOf?.(agent.session, 'goal'));
              } catch { /* ignore */ }
              if (!ref) {
                try { ref = extractRef(goalsSvc.get?.(agent)); } catch { /* ignore */ }
              }

              if (typeof goalsSvc.pause === 'function' && ref) {
                try {
                  goalsSvc.pause(agent, ref);
                  goalLog.push('source-paused');
                } catch (ePause) {
                  goalLog.push('pause-err:' + String(ePause?.message ?? ePause).slice(0, 70));
                  if (typeof goalsSvc.disarm === 'function') {
                    goalsSvc.disarm(agent);
                    goalLog.push('source-disarmed');
                  }
                }
              } else if (typeof goalsSvc.disarm === 'function') {
                goalsSvc.disarm(agent);
                goalLog.push(ref ? 'source-disarmed(no-pause)' : 'source-disarmed(no-ref)');
              }
            } catch (e) {
              goalLog.push('source-stop-err:' + String(e?.message ?? e).slice(0, 60));
            }
          } catch (e) {
            goalLog.push('create err: ' + String(e?.message ?? e).slice(0, 80));
          }
        }
      }
    } catch (e) {
      goalLog.push('err:' + String(e?.message ?? e).slice(0, 50));
    }
    if (goalLog.length) {
      log.info?.(`[dsh-relay] 目标处理: ${goalLog.join(' | ')}`);
    }


    // 6. 投递接续指令
    const resumed = sendToAgent(created.agent, buildResumePrompt(stateFileName, goal), {
      kind: 'relay',
      role: 'resume',
      from: sessionId,
    });
    if (!resumed) {
      return fail('无法向新会话投递接续指令');
    }

    ledger.updateTo(sessionId, created.sessionId, reason);
    return {
      ok: true,
      from: sessionId,
      to: created.sessionId,
      waitedMs: 0,   // 两阶段模式：不再靠超时等待
      attachLog: created.attachLog,
      permLog,
      goalLog,
      modelLog,
      kindLog,
    };
  }

  // ---------- 每轮结束检查 ----------
  //
  // ⚠️ 关键：这个监听器必须【同步立即返回】。
  // Cordis 的事件是串行 await 的 —— 如果这里 await 一个长任务
  // （比如等 STATE.md 最多 120 秒），后面所有监听器（包括
  // dsh-goal-round-driver 的 turn/end 处理）都会被阻塞，
  // 导致「目标暂停后再继续」无法启动。实测于 2026-10-24。
  //
  // 所以：同步做完轻量判断，然后用 queueMicrotask 把重活踢出去。
  /**
   * 接力检查（turn/end 与 step/start 共用）。
   *
   * 为什么需要 step/start（2026-10-25 实测教训）：
   *   只看 turn/end 会漏掉 goal 驱动的长任务 —— 实测某个会话
   *   从 turn 30(14:55) 到 turn 31(16:08) 间隔 73 分钟，这期间水位涨到 80%+
   *   但没有任何 turn/end 事件，relay 没机会检查，最后被 DSH 自己压缩掉了。
   *   step/start 比 turn 频繁约 17 倍（同一会话 567 vs 32），能覆盖这个空档。
   *
   * @param {object} event - DSH 事件
   * @param {string} source - 'turn' | 'step'（仅用于日志和 reason）
   */
  const __relayCheck = (event, source) => {
    // 触发计数（诊断用）：确认 step/start 真的在跑
    try { __relayStats[source] = (__relayStats[source] ?? 0) + 1; } catch { /* ignore */ }

    try {
      const agent = event?.agent ?? event?.data?.agent;
      const sessionId = agent?.session?.id ?? event?.sessionId;
      if (!sessionId) return;

      // 正在接力中，跳过（防止 45 秒窗口内重复触发）
      if (relayInFlight.has(sessionId)) return;

      const resolved = flags.resolve(sessionId, {
        globalEnabled: enabled,
        isRelayChild: ledger.isRelayChild(sessionId),
      });
      if (resolved.mode === MODE_OFF) return; // 走原生压缩

      if (ledger.hasRelayed(sessionId)) return;
      if (ledger.count() >= maxRelays) {
        log.warn?.(`[dsh-relay] 已达最大接力次数 ${maxRelays}`);
        return;
      }

      // 抓取此刻的数据（事件对象可能被复用）
      const usage = event?.usage ?? event?.data?.usage ?? agent?.session?.usage;
      const contextWindow =
        agent?.model?.contextWindow ?? agent?.session?.model?.contextWindow ?? event?.contextWindow;
      const messages = agent?.session?.messages ?? event?.messages;
      const turnCount = agent?.session?.turnCount ?? event?.turnCount;
      const modelName =
        agent?.selection?.current?.model ?? agent?.model?.name ?? event?.modelName;
      const goalTitle = agent?.session?.title ?? '';

      // ★ 关键：DSH 把真实的上下文压力存在 sessionProjections.contextPressure 里
      //   { surfaceTokens, pressureTokens, contextWindow, sampledSurfaceTokens }
      //   这是 DSH UI 上显示的那个百分比的数据源，必须优先用它。
      let projection = null;
      try {
        const sp = ctx.sessionProjections;
        if (sp?.stateOf && agent?.session) {
          projection = sp.stateOf(agent.session, 'contextPressure') ?? null;
        }
      } catch {
        projection = null;
      }

      const projPressure = Number(projection?.pressureTokens ?? 0);
      const projWindow = Number(projection?.contextWindow ?? 0);

      // ★ 快速短路（2026-10-25）：step/start 比 turn 频繁约 17 倍，
      //   不能每次都做完整测量。这里用 DSH 已算好的 pressure 做快速判断 ——
      //   远离阈值就直接返回，几乎零开销。
      if (projPressure > 0 && projWindow > 0) {
        const quickPct = (projPressure / projWindow) * 100;
        if (quickPct < thresholdPercent - 20) return;
      }

      // 工具列表（可能不存在，包起来）
      let tools;
      try {
        tools = ctx.tools?.list?.() ?? ctx.tools?.all?.();
        if (!Array.isArray(tools)) tools = undefined;
      } catch {
        tools = undefined;
      }

      const m = measureContext({
        usage,
        // 投影里的 contextWindow 最可信，优先用
        contextWindow: projWindow > 0 ? projWindow : contextWindow,
        messages,
        tools,
        turnCount,
        turnLimit: Math.max(1, maxRelays * 2),
        modelName,
        // 直接传入 DSH 自己算好的压力值（最权威）
        projectedPressure: projPressure > 0 ? projPressure : undefined,
      });

      if (m.percent === null || m.percent < thresholdPercent) return;

      // ★ 纯被动模式（2026-10-25 用户要求）：
      //   「你这运行到一半给人停了，什么鬼啊？」
      //   → 不再自动投递任何指令。只记录一条提示，模型自己决定什么时候调 relay_transfer。
      //
      //   为什么不投递：投递「写 STATE.md」会唤醒模型去写文件，
      //   这等于强行打断它当前的工作流（用户实测反馈：运行到一半被停）。
      //
      //   模型怎么知道该接力：它能看到上下文压力（DSH 会告诉它），
      //   也可以主动查 relay_status 工具。完全由它自己判断。
      log.info?.(
        `[dsh-relay] ${sessionId} 上下文 ${m.percent}%（${m.source}）已达阈值 ${thresholdPercent}%，等待模型自行调用 relay_transfer（不自动投递）`,
      );
    } catch (err) {
      try {
        __relayStats.toolReg = __relayStats.toolReg || { ok: [], fail: [], noFn: [], retType: [] };
        __relayStats.toolReg.fail.push(definition.name + ': ' + String(err?.message ?? err).slice(0, 100));
      } catch {}
      log.warn?.(`[dsh-relay] ${source} 检查异常：${err?.message ?? err}`);
    }
  };

  // ★ 提示注入（2026-10-25 用户要求）：
  //   「但是我怕他到上下文 78% 的时候忘了呀」
  //
  //   做法：挂 system-prompt/assemble 钩子，每次模型思考前组装提示时，
  //   如果当前会话水位接近阈值，就往 system prompt 里追加一段提醒。
  //
  //   为什么这样做不打断工作：
  //     - 不投递消息（不触发新 turn）
  //     - 不改 inbox（不产生 competingQueued）
  //     - 只是让模型【看到】还有接力这个选项，它自己决定要不要用
  ctx.effect?.(() => {
    const off = ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next();
      // 调试：记录 context 结构（只记一次）
      try {
        __relayStats.promptHook = (__relayStats.promptHook ?? 0) + 1;
        if (!__relayStats.ctxShape) {
          __relayStats.ctxShape = {
            contextKeys: Object.keys(context ?? {}).slice(0, 15),
            hasAgent: Boolean(context?.agent),
            hasScope: Boolean(context?.scope),
            hasSession: Boolean(context?.session),
            assemblyKeys: Object.keys(assembled ?? {}).slice(0, 10),
            sectionsCount: Array.isArray(assembled?.sections) ? assembled.sections.length : -1,
          };
        }
      } catch (e) { __relayStats.ctxErr = String(e?.message ?? e).slice(0, 80); }
      try {
        const agent = context?.agent ?? context?.scope?.agent ?? null;
        const session = agent?.session ?? context?.session;
        if (!session) return assembled;
        const sid = session.id;
        if (!sid) return assembled;

        // ★ 必须开启接力开关才提醒（2026-10-25 用户纠正）：
        //   「你不开开关的时候转移个蛋呀，你只有开启接力的时候才能转移啊」
        //   → 开关关着的时候 relay_transfer 也建不了会话，提醒没意义。
        const resolved = flags.resolve(sid, {
          globalEnabled: enabled,
          isRelayChild: ledger.isRelayChild(sid),
        });
        if (resolved.mode === MODE_OFF) return assembled;
        if (ledger.hasRelayed(sid)) return assembled;

        let proj = null;
        try {
          proj = ctx.sessionProjections?.stateOf?.(session, 'contextPressure') ?? null;
        } catch { /* ignore */ }
        const pt = Number(proj?.pressureTokens ?? 0);
        const cw = Number(proj?.contextWindow ?? 0);
        if (!(pt > 0) || !(cw > 0)) return assembled;

        const pct = Math.min(100, Math.round((pt / cw) * 100));
        // ★ 任何时候都显示水位（2026-10-25 用户要求）：
        //   「你这没办法让人家自己选择接力呀，自己去看对话历史」
        //   → 模型必须随时能看到当前水位，才能自己判断什么时候该接力。
        //   不再限制「水位低就不显示」。

        // ★ 分级提示（2026-10-25 用户要求）：
        //   68% 起提醒开始准备，78% 起建议立即转移。
        //   另外要求模型【平时就保持 STATE.md 最新】，这样任何时候都能转移。
        const warnPct = thresholdPercent - 10;
        // ★ 分级提示（2026-10-26 用户定案）：
        //   「我希望 78 的时候要强制让模型意识到这是强制规则，但是不强制执行」
        //   → 语气是【强制规则】（必须遵守、不得跳过），但【不自动执行】，
        //     由模型自己决定何时调 relay_transfer。
        //   同时去掉所有削弱语气的句子（「可以忽略」「不必等」等）。
        let urgency;
        let action;
        let isMandatory = false;
        if (pct >= thresholdPercent) {
          isMandatory = true;
          urgency = '🔴【强制规则已触发】';
          action = [
            '**这是一条强制规则，不是建议。** 上下文已达 ' + pct + '%，超过阈值 ' + thresholdPercent + '%。',
            '',
            '**你必须立即做以下事情，不得跳过、不得拖延到下一轮：**',
            '',
            '1. **立刻**把 STATE.md 补全到最新（目标、已完成、未完成、失败方案、关键路径、必须遵守的规则、下一步动作）。',
            '2. 补全后**立即**调用 `relay_transfer()` 完成转移。',
            '3. 转移完成前，**不要**开始任何新的耗时工作。',
            '',
            '**唯一允许不转移的情况**：用户在本轮明确说了不要转移。除此之外没有例外。',
          ];
        } else if (pct >= warnPct) {
          isMandatory = true;
          urgency = '🟠【即将触发强制规则】';
          action = [
            '**水位 ' + pct + '%，已进入准备区（' + warnPct + '% 起）。** 距强制阈值 ' + thresholdPercent + '% 只剩 ' + (thresholdPercent - pct) + ' 个百分点。',
            '',
            '**你现在必须开始准备，不得拖到触发后再做：**',
            '',
            '1. 把 STATE.md 补全到最新（含：目标、已完成、未完成、失败方案、关键路径、必须遵守的规则）。',
            '2. 补全后**建议立即调用 `relay_transfer()` 转移**，不要等到 ' + thresholdPercent + '%。',
            '',
            '提前转移不会丢失任何信息，拖到超阈值才有风险。',
          ];
        } else if (pct >= Math.floor(thresholdPercent / 2)) {
          urgency = '【水位正常】';
          action = [
            '水位 ' + pct + '%，还充裕，正常干活。',
            '',
            '**但请顺手保持 STATE.md 最新**：每完成一个阶段性工作，更新 STATE.md 的「当前进度」小节（几十字即可）。',
            '这样水位到 ' + warnPct + '% 时可以直接转移，不必临时赶工。',
          ];
        } else {
          urgency = '【水位正常】';
          action = [
            '水位 ' + pct + '%，充裕，正常干活。',
            '长任务建议现在就建立 STATE.md 并随手维护。',
          ];
        }

        const notice = [
          '',
          '---',
          '',
          '## 会话接力状态 ' + urgency,
          '',
          '当前上下文压力：**' + pct + '%**（强制阈值 ' + thresholdPercent + '%，准备线 ' + warnPct + '%）。',
          '',
          ...action,
          '',
          '**工具用法：**',
          '- `relay_transfer()` — 正常转移（要求 STATE.md ≥50 字节）',
          '- `relay_transfer({ force: true })` — 跳过 STATE.md 校验强制转移（仅在用户明确要求「现在就转移」时用）',
          '- `relay_status()` — 查看水位、开关、接力历史',
          '',
          isMandatory
            ? '**注意：系统不会替你执行转移。规则是强制的，执行动作必须由你主动调用 `relay_transfer`。**'
            : '**注意：系统不会自动转移，需要时由你主动调用 `relay_transfer`。**',
          '',
          '---',
        ].join(String.fromCharCode(10));

        // ★ 78% 强制投递（2026-10-26 用户需求）：
        //   「到 78 的时候以我的名义插入一条消息，直接发送不等待的那种，
        //     里面写：做完这个后立刻开始整理文档，然后自己接力」
        //
        //   实现：agent.followup() —— 源码实证为 send(input, "next-turn", true)：
        //     · 入队到 next-turn（当前这轮干完再处理，不打断）
        //     · wakeup=true（会自动唤醒，不需要手动 kick）
        //     · 非阻塞（投完立即返回，不等模型响应）
        // ★ 78% 强制投递（2026-10-26，审查后重写）
        //
        // 用户需求：「到 78 的时候以我的名义插入一条消息，直接发送不等待的那种，
        //            里面写：做完这个后立刻开始整理文档，然后自己接力」
        //          「就是直接插话全部发送」「78 那个时候是只发一次吧」
        //
        // 修复的三个 bug（2026-10-26 审查）：
        //   Bug1 __noticeDelivered 只增不删 → 加 2 小时过期清理 + cleanup 时 clear
        //   Bug2 只靠 10 分钟冷却，10 分钟后会重复投 → 改成【每会话每 goal 版本只投一次】
        //   Bug3 投递代码在 try 内，抛错会导致整个提示注入丢失
        //        → 单独包一层 try/catch，投递失败绝不影响 notice 注入
        if (isMandatory && pct >= thresholdPercent && !ledger.hasRelayed(sid)) {
          try {
            const now = Date.now();
            // 取当前 goal 版本，作为「只投一次」的幂等键
            let goalRev = 0;
            try {
              const gv = getGoals()?.get?.(agent);
              goalRev = Number(gv?.revision ?? 0);
            } catch { /* ignore */ }
            const dedupKey = sid + '#' + goalRev;
            const last = __noticeDelivered.get(dedupKey);
            // 同一个 (会话, goal 版本) 只投一次；goal 版本变了（用户改了目标）才允许再投
            const alreadySent = Boolean(last);
            if (!alreadySent) {
              const forcedText = [
                '做完这个后立刻开始整理文档，然后自己接力。',
                '',
                '（上下文已达 ' + pct + '%，超过阈值 ' + thresholdPercent + '%。' +
                  '把 STATE.md 补全到最新，然后调用 relay_transfer 完成转移。）',
              ].join('\n');
              let delivered = false;
              // 投递本身单独 try，失败不影响下面的 notice 注入
              try {
                if (typeof agent.steer === 'function') {
                  // steer → send(input,"next-step",true)
                  //   claim() 一次取走【全部】next-step（this.nextStep.length），
                  //   当前这轮的下一个 step 就处理，立即生效，不排队。
                  agent.steer(makeUserMessage(forcedText, { kind: 'relay', role: 'user-forced' }));
                  delivered = true;
                } else {
                  delivered = sendToAgent(agent, forcedText, { kind: 'relay', role: 'user-forced' });
                }
              } catch (err) {
                log.warn?.('[dsh-relay] steer 投递失败，退回 followup：' + String(err?.message ?? err).slice(0, 60));
                try {
                  delivered = sendToAgent(agent, forcedText, { kind: 'relay', role: 'user-forced' });
                } catch { delivered = false; }
              }
              if (delivered) {
                __noticeDelivered.set(dedupKey, { at: now, pct, sid, goalRev });
                log.info?.(
                  `[dsh-relay] ${String(sid).slice(0, 20)} 水位 ${pct}% 已达阈值，已以用户名义插话投递接力指令（goal rev ${goalRev}）`,
                );
              } else {
                log.warn?.(`[dsh-relay] ${String(sid).slice(0, 20)} 投递接力指令失败（steer/followup 均不可用）`);
              }
            }
          } catch (err) {
            // 投递出任何问题都不能影响提示注入
            log.warn?.('[dsh-relay] 强制投递异常：' + String(err?.message ?? err).slice(0, 80));
          }
        }

        if (Array.isArray(assembled?.sections)) {
          // ★ 强制规则时置顶（2026-10-26）：原本追加在最后，位置在系统提示 73.7% 处，
          //   实测 73 次注入、0 次主动调用 —— 被前面的内容淹没了。
          //   触发强制阈值时放到 sections 最前面，模型最先看到。
          return {
            ...assembled,
            sections: isMandatory
              ? [{ name: 'dsh-relay-notice', text: notice }, ...assembled.sections]
              : [...assembled.sections, { name: 'dsh-relay-notice', text: notice }],
          };
        }
        if (typeof assembled?.text === 'string') {
          return { ...assembled, text: assembled.text + '\n' + notice };
        }
        return assembled;
      } catch (err) {
        ctx.logger?.warn?.('[dsh-relay] 提示注入失败：' + String(err?.message ?? err).slice(0, 80));
        return assembled;
      }
    });
    return () => {
      try { off?.(); } catch { /* ignore */ }
      try { __noticeDelivered.clear(); } catch { /* ignore */ }
    };
  }, 'dsh-relay: system-prompt notice');
  // turn/end：一次对话结束（主要触发点）
  const __dTurnEnd = ctx.on('turn/end', (event) => __relayCheck(event, 'turn'));
  // step/start：每个步骤开始（补充触发点，覆盖长任务里 turn 之间的空档）
  const __dStepStart = ctx.on('step/start', (event) => __relayCheck(event, 'step'));

  // ---------- 工具（parameters 用完整 JSON Schema） ----------
  try { __relayStats.reachedSafeRegister = true; } catch {}
  // ★ DSH 要求每个工具声明 output { schema, render }（2026-10-25 实测报错：
  //   tool "xxx" must declare output { schema, render, presentationMeta? }）
  const RELAY_OUTPUT = {
    schema: { type: 'object', additionalProperties: true },
    render(_args, value) {
      try {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      } catch {
        return [{ type: 'text', text: String(value) }];
      }
    },
  };

  // ★ 工具定义先排队，等 apply 末尾统一注册（2026-10-25 实测）：
  //   在 apply 早期调用 ctx.tools.register() 会卡住不返回，
  //   延后到 apply 末尾（此时 ctx 已完全就绪）就能成功。
  const __pendingTools = [];
  const safeRegister = (definition) => {
    __pendingTools.push(definition);
  };

  /** apply 末尾统一注册所有排队工具 */
  const __flushTools = () => {
    const results = { ok: [], fail: [] };
    // ★ 先注销上次注册的工具（2026-10-25）：
    //   ctx.effect 的清理在热重载时不会触发（新 apply 用新 ctx），
    //   所以用 globalThis 存注销函数，跨 apply 清理。
    try {
      if (Array.isArray(globalThis.__relayToolDisposers)) {
        const old = globalThis.__relayToolDisposers;
        let cnt = 0;
        for (const fn of old) {
          try { fn(); cnt++; } catch { /* ignore */ }
        }
        old.length = 0;
        if (cnt > 0) log.info?.("[dsh-relay] 已注销上次注册的 " + cnt + " 个工具");
      }
    } catch { /* ignore */ }
    if (!Array.isArray(globalThis.__relayToolDisposers)) {
      globalThis.__relayToolDisposers = [];
    }
    // ★ ctx.tools 是 cordis Proxy 浅层视图，ctx.get('tools') 才是真服务
    //   （2026-10-25 实测：两者不是同一个对象，Proxy 上 register 会卡住）
    let toolSvc = null;
    try {
      toolSvc = ctx.get?.('tools') ?? null;
    } catch { /* ignore */ }
    if (!toolSvc) {
      try { toolSvc = ctx.tools; } catch { /* ignore */ }
    }
    results.svcName = toolSvc?.name ?? '?';
    results.hasRegister = typeof toolSvc?.register;
    for (const definition of __pendingTools) {
      try {
        const fullDef = {
          ...definition,
          output: definition.output ?? RELAY_OUTPUT,
        };
        const unregister = toolSvc?.register?.(fullDef);
        if (typeof unregister === 'function') {
          results.ok.push(definition.name);
          // 存到 globalThis，下次热重载时统一清理
          try { globalThis.__relayToolDisposers.push(unregister); } catch { /* ignore */ }
        } else {
          results.fail.push(definition.name + ':no-disposer');
        }
      } catch (err) {
        results.fail.push(definition.name + ':' + String(err?.message ?? err));
      }
    }
    try {
      __relayStats.toolReg = results;
    } catch { /* ignore */ }
    log.info?.(`[dsh-relay] 工具注册完成：${results.ok.length} 成功 / ${results.fail.length} 失败`);
    return results;
  };

  // ★ 工具定义（2026-10-25 用 defineTool 重写）：
  //   之前裸对象注册后模型看不到工具，根因是缺 defineTool 包装 ——
  //   defineTool 会把扁平的 parameters 转成标准 JSON Schema 并绑定 output。
  //   参考可用范例：@nanmicoder/dsh-agent-teams/lib/tools.js
  //
  //   安全设计：
  //     relay_status   → 只读，模型可见
  //     relay_transfer → 有 STATE.md + 开关校验，模型可见（支持 force）
  //     relay_reload   → 热重载，模型可见
  //     relay_now      → 【不给模型】，只保留 HTTP /force 端点（防乱接力）

  safeRegister(defineTool({
    name: 'relay_status',
    description: '查看会话接力状态：当前上下文水位、阈值、已接力次数、最近记录、各会话开关。只读。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      return {
        enabled,
        thresholdPercent,
        stateFileName,
        maxRelays,
        relayCount: ledger.count(),
        recent: ledger.data.relays.slice(-5),
        sessionFlags: flags.list(),
      };
    },
  }));

  safeRegister(defineTool({
    name: 'relay_transfer',
    description:
      '会话接力：把当前会话的工作状态转移到新会话继续。' +
      '默认要求先把完整状态写入 STATE.md（工作区根目录，≥50 字节）。' +
      '如果用户明确要求「现在就转移」，可传 force=true 跳过 STATE.md 校验。',
    parameters: {
      stateFile: { type: 'string', description: '可选：STATE.md 文件名（默认 STATE.md）' },
      goal: { type: 'string', description: '可选：原始目标描述（不传则从源会话目标继承）' },
      force: {
        type: 'boolean',
        description: '跳过 STATE.md 校验强制转移。仅在用户明确要求提前转移时使用。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      let agent = null;
      try {
        agent = ctx.tools?.currentAgent?.() ?? null;
      } catch { /* ignore */ }
      if (!agent) {
        try {
          const list = ctx.agents?.list?.() ?? [];
          agent = list.find((a) => a?.status === 'running') ?? null;
        } catch { /* ignore */ }
      }
      if (!agent) return { ok: false, error: '无法确定当前会话' };

      const sessionId = agent?.session?.id ?? agent?.id;
      if (!sessionId) return { ok: false, error: '无法确定当前会话 ID' };

      // 开关校验（必须开启才能转移）
      const resolved = flags.resolve(sessionId, {
        globalEnabled: enabled,
        isRelayChild: ledger.isRelayChild(sessionId),
      });
      if (resolved.mode === MODE_OFF) {
        return {
          ok: false,
          error: `该会话的接力开关是关闭的（${resolved.reason}），无法转移。请先在界面上开启接力开关。`,
        };
      }
      if (ledger.hasRelayed(sessionId)) {
        return { ok: false, error: '该会话已经接力过了' };
      }

      // STATE.md 校验（force=true 时跳过）
      const force = args?.force === true;
      const cwd = resolveCwd(agent, ctx);
      const sf = String(args?.stateFile ?? stateFileName);
      const statePath = path.join(cwd, sf);
      if (!force) {
        let exists = false;
        let size = 0;
        try {
          const st = fs.statSync(statePath);
          exists = st.isFile();
          size = st.size;
        } catch { /* 不存在 */ }
        if (!exists || size < 50) {
          return {
            ok: false,
            error:
              `STATE.md 还没写好（${statePath} ${exists ? size + ' 字节' : '不存在'}）。` +
              '请先把完整状态写入 STATE.md（至少 50 字节），或传 force=true 强制转移。',
          };
        }
        log.info?.(`[dsh-relay] 模型主动请求转移（STATE.md ${size} 字节）`);
      } else {
        log.info?.('[dsh-relay] 模型请求强制转移（跳过 STATE.md 校验）');
      }

      const result = await performRelay({
        agent,
        sessionId,
        goal: String(args?.goal ?? ''),
        reason: force ? 'model-force' : 'model-transfer',
      });
      return result;
    },
  }));

  safeRegister(defineTool({
    name: 'relay_reload',
    description: '热重载 dsh-relay 插件本身（改完源码或配置后调用，不用重启 DSH）',
    parameters: {
      clearCache: { type: 'boolean', description: '是否清模块缓存（改了代码要 true，只改配置可 false），默认 true' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      try {
        const r = await hotReload({
          clearCache: args?.clearCache !== false,
          onReload: (res) => log.info?.(`[dsh-relay] 热重载${res.ok ? '成功' : '失败'}：${res.detail ?? ''}`),
        });
        return r;
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },
  }));

  // ---------- 文件监视 ----------
  if (config.hotReloadWatch === true) {
    const stop = watchAndReload(ctx, {
      debounceMs: Number(config.hotReloadDebounceMs ?? 800),
      onReload: (r) => log.info?.(`[dsh-relay] 热重载${r.ok ? '成功' : '失败'}：${r.detail ?? ''}`),
    });
    ctx.effect?.(() => stop, 'dsh-relay: file watch');
    log.info?.('[dsh-relay] 已开启文件监视');
  }

  // ---------- 目标守护（自动恢复被【错误】中断的目标）----------
  //
  // 2026-10-26 用户需求（两轮澄清后的最终口径）：
  //   「有的时候因为偶然错误会导致目标断掉，我希望有个开关，可以在我打开之后，
  //     如果这个对话是因为错误停止的，就过 3 分钟尝试启动目标。
  //     当然，这个目标原先必须是开启的才行。」
  //   「首先必须是错误导致的停止，不是我手动停的那种」
  //
  // ★ 核心：必须能区分「错误停止」和「手动停止」。两者在 goal 上的表现完全一样
  //   （phase=active + activation=disarmed），所以不能只看 goal 状态，必须抓错误信号。
  //
  // 错误信号来源（dsh-goal-round-driver 源码实证，三条 disarm 路径）：
  //   ctx.on("agent/error", ({ agent }) => disarm(...))              ← 真正的错误
  //   turn/end reason.kind === "max-tokens" → disarm(...)            ← 输出被截断
  //   turn/end reason.kind === "aborted"    → disarm(...) 或标记 cancelled
  //
  // 因此本守护维护一个「错误嫌疑池」errorSuspects：
  //   - 监听到 agent/error        → 记入池，reason='agent-error'
  //   - turn/end 且 max-tokens    → 记入池，reason='max-tokens'
  //   - turn/end 且 aborted       → 【不入池】（可能是用户手动停，无法区分，宁可不救）
  //   - 用户 pause / goal/changed(pause) → 立即从池中剔除，并记入 userStopped 黑名单
  //
  // 恢复条件（四条同时成立）：
  //   1. 该会话在 errorSuspects 池里（即：确实发生过错误）
  //   2. phase === 'active'      —— 目标本身仍是启用状态（用户没说「完成」）
  //   3. activation === 'disarmed' —— 目标没在驱动
  //   4. agent.status === 'idle'   —— 会话没在跑
  //   并且连续满足满 goalGuardDelayMs（默认 180000 = 3 分钟）。
  //
  // 另外：userStopped 里的会话，除非再次出现错误，否则永不自动恢复。
  const goalGuardEnabled = config.goalGuard === true;
  const goalGuardIntervalMs = Math.max(5_000, Number(config.goalGuardIntervalMs ?? 30_000));
  const goalGuardDelayMs = Math.max(0, Number(config.goalGuardDelayMs ?? 180_000));

  if (goalGuardEnabled) {
    /** key = sessionId → { at, reason } 最近一次错误信号 */
    const errorSuspects = new Map();
    /** key = sessionId → 用户主动停止的时间戳（黑名单，错误信号可解除） */
    const userStopped = new Map();
    /** key = sessionId → { since, revision } 首次观察到 disarmed 的时刻 */
    const guardDisarmedSince = new Map();
    /** 已尝试 resume 过的 (goalId:revision)，同一版本不再重试 */
    const guardAttempted = new Set();

    const sidOf = (agent) => String(agent?.session?.id ?? agent?.id ?? '');
    const markError = (agent, reason) => {
      const sid = sidOf(agent);
      if (!sid) return;
      errorSuspects.set(sid, { at: Date.now(), reason });
      userStopped.delete(sid); // 新错误解除手动停止的黑名单
      log.info?.(`[dsh-relay] 目标守护：${sid} 记录错误信号（${reason}）`);
    };
    const markUserStop = (agent, how) => {
      const sid = sidOf(agent);
      if (!sid) return;
      userStopped.set(sid, Date.now());
      errorSuspects.delete(sid);
      guardDisarmedSince.delete(sid);
      log.info?.(`[dsh-relay] 目标守护：${sid} 被用户主动停止（${how}），不再自动恢复`);
    };

    // ---- 错误信号监听 ----
    try {
      const __dAgentError = ctx.on?.('agent/error', (payload) => {
        try {
          markError(payload?.agent, 'agent-error');
        } catch {}
      });
      if (__dAgentError) __relayAddCleanup(__dAgentError);
    } catch (err) {
      log.warn?.(`[dsh-relay] 目标守护：无法监听 agent/error：${err?.message ?? err}`);
    }

    // turn/end 的错误分支（max-tokens）；aborted 不视为错误（可能是手动停）
    //
    // ★ 签名订正（2026-10-26 审查）：DSH 的 session/event 是【位置参数】(session, event)，
    //   不是对象 payload；且 reason 是 turn/end 事件的直接字段
    //   （SessionEventMap: 'turn/end': { turn, reason: TurnEndReason }），
    //   不在 event.data.reason 里 —— 那是持久化日志的格式，不是运行时事件对象。
    try {
      const __dSessionEvent = ctx.on?.('session/event', (session, event) => {
        try {
          if (!event || event.type !== 'turn/end') return;
          const sid = String(session?.id ?? '');
          if (!sid) return;
          const agent = ctx.agents?.get?.(sid);
          if (!agent) return;
          const kind = event?.reason?.kind;
          if (kind === 'max-tokens') markError(agent, 'max-tokens');
          // aborted 可能是用户手动中断，不自动恢复（用户要求「不是我手动停的那种」）
        } catch {}
      });
    } catch (err) {
      log.warn?.(`[dsh-relay] 目标守护：无法监听 session/event：${err?.message ?? err}`);
    }
    try { if (__dSessionEvent) __relayAddCleanup(__dSessionEvent); } catch {}

    // 用户主动 pause → 进黑名单
    try {
      const __dGoalChanged = ctx.on?.('goal/changed', (payload) => {
        try {
          const op = payload?.change?.operation;
          // operation 的实际取值（dsh-goal 源码实证）：
          //   create / edit / pause / resume / complete / block / clear
          //   —— 没有 'disarm'，那是 activation 的概念，不是 operation。
          // 用户主动停止目标的两种方式：pause（暂停）和 clear（清除）。都进黑名单。
          if (op === 'pause' || op === 'clear') markUserStop(payload?.agent, `goal.${op}`);
        } catch {}
      });
    } catch (err) {
      log.warn?.(`[dsh-relay] 目标守护：无法监听 goal/changed：${err?.message ?? err}`);
    }
    try { if (__dGoalChanged) __relayAddCleanup(__dGoalChanged); } catch {}

    const every = () => {
      void (async () => {
        try {
          const goals = getGoals();
          const agents = ctx.agents;
          if (!goals?.get || !agents?.list) return;

          let list = [];
          try {
            list = agents.list() ?? [];
          } catch {
            return;
          }
          if (!Array.isArray(list)) return;

          const now = Date.now();
          const seen = new Set();

          for (const agent of list) {
            const sid = sidOf(agent);
            if (!sid) continue;
            seen.add(sid);

            try {
              if (agent.status !== 'idle') {
                guardDisarmedSince.delete(sid);
                continue;
              }

              const view = goals.get(agent);
              if (!view || view.phase !== 'active') {
                guardDisarmedSince.delete(sid);
                continue;
              }

              if (view.activation === 'armed') {
                guardDisarmedSince.delete(sid);
                // 已恢复正常驱动 → 错误嫌疑和黑名单都可以清了
                errorSuspects.delete(sid);
                continue;
              }

              // ---- 到这里：active + disarmed + idle ----
              // ① 必须是错误导致的（在错误池里）
              if (userStopped.has(sid)) {
                guardDisarmedSince.delete(sid);
                continue;
              }
              const suspect = errorSuspects.get(sid);
              if (!suspect) {
                // 没有错误信号 → 可能是用户手动 pause 但没触发 goal/changed，
                // 也可能是别的原因。用户明确要求「只救错误导致的」，所以不救。
                guardDisarmedSince.delete(sid);
                continue;
              }

              const rev = Number(view.revision ?? 0);
              const prev = guardDisarmedSince.get(sid);
              const sameRev = prev && prev.revision === rev;
              const since = sameRev ? prev.since : now;

              if (!sameRev) {
                guardDisarmedSince.set(sid, { since: now, revision: rev });
                log.info?.(
                  `[dsh-relay] 目标守护：${sid} 目标已停止驱动（错误=${suspect.reason}, phase=active, disarmed），` +
                    `${Math.round(goalGuardDelayMs / 1000)}s 后尝试恢复`,
                );
                continue;
              }

              const waited = now - since;
              if (waited < goalGuardDelayMs) continue;

              const attemptKey = `${view.id}:${rev}`;
              if (guardAttempted.has(attemptKey)) continue;
              guardAttempted.add(attemptKey);
              if (guardAttempted.size > 500) {
                const first = guardAttempted.values().next().value;
                guardAttempted.delete(first);
              }

              const ref = { id: view.id, revision: rev };
              try {
                goals.resume(agent, ref);
                log.info?.(
                  `[dsh-relay] 目标守护：已恢复 ${sid} 的目标 ${view.id}` +
                    `（revision ${rev}，错误=${suspect.reason}，停止 ${Math.round(waited / 1000)}s）`,
                );
                guardDisarmedSince.delete(sid);
                errorSuspects.delete(sid); // 恢复成功，清除嫌疑
              } catch (err) {
                const msg = String(err?.message ?? err);
                if (!/already active and armed|exhausted|revision|stale/i.test(msg)) {
                  log.warn?.(`[dsh-relay] 目标守护 resume 失败：${msg}`);
                }
              }
            } catch {
              /* 单个 agent 出错不影响其它 */
            }
          }

          for (const sid of [...guardDisarmedSince.keys()]) {
            if (!seen.has(sid)) guardDisarmedSince.delete(sid);
          }
          // 错误信号 2 小时过期，避免长期残留
          for (const [sid, info] of [...errorSuspects.entries()]) {
            if (now - info.at > 2 * 3600_000) errorSuspects.delete(sid);
          }
        } catch (err) {
          log.warn?.(`[dsh-relay] 目标守护异常：${err?.message ?? err}`);
        }
      })();
    };

    let timer = null;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      every();
      timer = setTimeout(tick, goalGuardIntervalMs);
      timer.unref?.();
    };
    timer = setTimeout(tick, 30_000);
    timer.unref?.();

    const __goalCleanup = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      guardDisarmedSince.clear();
      errorSuspects.clear();
      userStopped.clear();
    };
    __relayAddCleanup(__goalCleanup);
    ctx.effect?.(() => __goalCleanup, 'dsh-relay: goal guard');

    log.info?.(
      `[dsh-relay] 目标守护已开启（每 ${goalGuardIntervalMs / 1000}s 检查，` +
        `连续停止满 ${Math.round(goalGuardDelayMs / 1000)}s 后恢复；` +
        `只恢复【错误导致】的中断，用户手动停止的不碰）`,
    );
  }

  __relayAddCleanup(__dTurnEnd);
  __relayAddCleanup(__dStepStart);

  // ---------- 主动巡检：解决「空闲会话永远不触发」----------
  //
  // 触发时机（2026-10-24 用户定案）：
  //   ★ 只在 turn/end（一次对话完成）的那一刻检查，不用定时巡检。
  //   原因：巡检会在用户点进对话、切窗口等时刻误触发，导致「一点进去就跳走」。
  //   对话完成是唯一自然、准确的检查点。
  //
  //   保留巡检作为【可选项】，默认关闭（config.patrol === true 才启用）。
  // ★ 巡检默认【开启】（2026-10-25 实测教训）：
  //   只看 turn/end 会漏掉 goal 驱动的长任务 —— 实测某会话从 turn 30(14:55)
  //   到 turn 31(16:08) 间隔 73 分钟，期间水位涨到 80%+ 但没有任何 turn/end，
  //   最后被 DSH 自己压缩掉了。而 step/start 只是日志类型、不是 cordis 事件，
  //   无法监听。所以必须用定时巡检兜底。
  //
  //   为什么不会「打断工作」：巡检只调用 beginRelay()，它做的事只是
  //   往会话 inbox 投递「写 STATE.md」指令（agent.followup），
  //   模型会在当前 step 结束后的安全点自己处理 —— 不是强杀。
  const patrolEnabled = config.patrol !== false;
  const patrolIntervalMs = Number(config.patrolIntervalMs ?? 180_000);
  // 会话必须持续 idle 这么久才允许接力（避免用户点进对话就跳走）
  const idleStableMs = Number(config.idleStableMs ?? 60_000);

  if (patrolEnabled) {
    let patrolTimer = null;
    let patrolStopped = false;
    // 巡检本身是否在跑 —— 防止 patrolTick 叠加重入
    let patrolRunning = false;
    // 每个会话进入 idle 的时间戳（用于空闲稳定期判断）
    const idleSince = new Map();

    const patrolOnce = async () => {
      try { __relayStats.patrol = (__relayStats.patrol ?? 0) + 1; } catch { /* ignore */ }
      if (patrolRunning) return;
      patrolRunning = true;
      try {
        const list = ctx.agents?.list?.() ?? [];
        if (!Array.isArray(list)) return;

        for (const agent of list) {
          try {
            const sessionId = agent?.session?.id;
            if (!sessionId) continue;

            // 正在接力中，跳过
            if (relayInFlight.has(sessionId)) continue;

            // 会话开关
            const resolved = flags.resolve(sessionId, {
              globalEnabled: enabled,
              isRelayChild: ledger.isRelayChild(sessionId),
            });
            if (resolved.mode === MODE_OFF) continue;

            // 已接力过 / 到上限
            if (ledger.hasRelayed(sessionId)) continue;
            if (ledger.count() >= maxRelays) continue;

            // ★ 不再限制 idle（2026-10-25）：
            //   长任务会长时间处于 running，如果只查 idle 就永远漏掉它们。
            //   对 running 会话投递「写 STATE.md」是安全的 ——
            //   followup 只是入队，模型在 step 边界自己处理。

            // ★ 防骚扰（2026-10-25 改）：
            //   原来靠「idle 稳定 60 秒」防误触发，但长任务不 idle，那套失效了。
            //   现在改成：同一会话的两次巡检动作之间至少间隔 idleStableMs。
            //   （真正的「只投递一次」由 ledger.hasRelayed 保证 —— 投递时立刻标记。）
            const now = Date.now();
            const lastCheck = idleSince.get(sessionId);
            if (lastCheck !== undefined && now - lastCheck < idleStableMs) continue;
            idleSince.set(sessionId, now);

            // 读 DSH 的真实上下文压力
            let proj = null;
            try {
              proj = ctx.sessionProjections?.stateOf?.(agent.session, 'contextPressure') ?? null;
            } catch {
              proj = null;
            }
            const pt = Number(proj?.pressureTokens ?? 0);
            const cw = Number(proj?.contextWindow ?? 0);
            if (!(pt > 0) || !(cw > 0)) continue;

            const pct = Math.min(100, Math.round((pt / cw) * 100));
            if (pct < thresholdPercent) continue;

            // ★ 纯被动模式（2026-10-25 用户要求）：
            //   巡检只记录，不投递、不创建会话。
            //   转移完全由模型自己调 relay_transfer 决定。
            log.info?.(
              `[dsh-relay] 巡检：会话 ${sessionId} 上下文 ${pct}% ≥ ${thresholdPercent}%，等模型自己调 relay_transfer（不自动动作）`,
            );
          } catch (err) {
            log.warn?.(`[dsh-relay] 巡检单会话异常：${err?.message ?? err}`);
          }
        }
      } catch (err) {
        log.warn?.(`[dsh-relay] 巡检异常：${err?.message ?? err}`);
      } finally {
        patrolRunning = false;
      }
    };

    const patrolTick = () => {
      if (patrolStopped) return;
      void patrolOnce();
      patrolTimer = setTimeout(patrolTick, patrolIntervalMs);
    };
    // 首次延迟 20 秒（等插件树稳定）
    patrolTimer = setTimeout(patrolTick, 20_000);

    const __patrolCleanup = () => {
      patrolStopped = true;
      if (patrolTimer) clearTimeout(patrolTimer);
    };
    __relayAddCleanup(__patrolCleanup);
    ctx.effect?.(() => __patrolCleanup, 'dsh-relay: patrol');

    log.info?.(`[dsh-relay] 主动巡检已开启（每 ${patrolIntervalMs / 1000}s 扫一次空闲会话）`);
  }

  // ★ apply 末尾统一注册工具（2026-10-25）：
  //   在 apply 早期调用 ctx.tools.register() 会卡住不返回，
  //   延后到这里（ctx 已完全就绪）才成功。
  try {
    __flushTools();
  } catch (err) {
    log.warn?.(`[dsh-relay] 工具注册阶段异常：${err?.message ?? err}`);
  }

  log.info?.(`[dsh-relay] 已加载 v0.5.0，阈值 ${thresholdPercent}%，状态文件 ${stateFileName}`);
}

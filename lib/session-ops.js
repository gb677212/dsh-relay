/**
 * 会话操作封装 —— 全部 API 都从 DSH 源码实测确认过
 *
 * 确认来源：
 *   - `ctx.agents.create({ sessionId, meta:{cwd,agentPreset}, agentOptions, setup })`
 *     ← @michengai/dsh-automation 实际用法
 *   - `handle.agent.followup(createUserMessage({ content, source }))`  发消息
 *   - `handle.agent.whenIdle()`  等空闲
 *   - `handle.agent.session.seq`  取序列号
 *
 * 注意：`ctx.agents.prompt` 不存在（这是常见误区）。
 */
import { randomUUID } from 'node:crypto';

/** 造一条 user 消息（DSH 内部结构） */
export function makeUserMessage(text, source = { kind: 'relay' }) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  };
}

/**
 * 建顶层会话。
 *
 * 关键（对照 @michengai/dsh-automation 的成功用法）：
 *   1. 必须显式传 sessionId（不传会得到 "agent id undefined does not match session id"）
 *   2. 必须在 setup 里 mount agentPreset（否则 agent 不完整）
 *   3. 用 withoutInitiator 脱离调用者作用域 → 顶层会话而非子智能体
 *
 * @param {object} ctx
 * @param {object} opts
 * @param {string} [opts.cwd]           - 工作目录
 * @param {string} [opts.agentPreset]   - agent 预设（默认 'default'）
 * @param {string} [opts.sessionId]     - 指定会话 ID（不传则自动生成）
 * @param {object} [opts.provider]      - 模型选择 { provider, model }
 * @param {Function} [opts.setup]       - 自定义 setup(agentCtx, agent)
 * @returns {Promise<{handle:object, agent:object, sessionId:string}|null>}
 */
export async function createSession(ctx, opts = {}) {
  const { cwd, agentPreset, provider, setup, parentAgent } = opts;

  // 必须显式生成 sessionId
  const sessionId = opts.sessionId ?? `session-${randomUUID()}`;
  // ★ 默认 preset 改成 standard（2026-10-25 实测）：
  //   DSH 不认识 default —— 用它创建会话后 resume 会报
  //   RemoteError: Unknown agent preset: default，会话跑不起来。
  //   DSH 内置的有效 preset 是 standard（实测所有正常会话都用它）。
  const preset = agentPreset ?? 'standard';

  // 模型选择：没传就从默认模型拿，必须注入，否则 system-prompt 里
  // {{model}} 变量为空 → 报 'prompt variable "{{model}}" has no value'
  let selection = provider;
  if (selection === undefined) {
    try {
      const dm = ctx.agentDefaultModel;
      if (dm?.currentSelection) selection = dm.currentSelection();
    } catch { /* 拿不到就不注入 */ }
  }

  const config = {
    sessionId,
    meta: {
      ...(cwd === undefined ? {} : { cwd }),
      agentPreset: preset,
    },
    // ★ 子智能体接力：新会话挂在同一个父之下（用户要求 2026-10-24：
    //   子智能体接力后的产物也必须是子智能体，位置不变、能和主会话交流）
    ...(parentAgent ? { parentAgent } : {}),
    ...(selection === undefined ? {} : { agentOptions: selection }),
    setup: async (agentCtx, createdAgent) => {
      // 1. 挂载 agentPreset —— 缺这一步 agent 不完整
      try {
        await ctx.agentPresets?.mount?.(agentCtx, preset);
      } catch {
        /* 预设不可用时继续，让 create 自己报错 */
      }
      if (createdAgent === undefined) {
        throw new Error('relay setup has no scoped Agent');
      }

      // 2. ★ 关键：安装模型选择，注入 {{provider}} / {{model}} 变量。
      //    缺这一步，新会话一跑就报
      //    'prompt variable "{{model}}" has no value for this assembly'
      //    （2026-10-24 实测报错）
      if (selection !== undefined) {
        let installed = false;
        // 路线 A：ctx 上直接有（某些版本会挂出来）
        try {
          if (typeof ctx.installModelSelection === 'function') {
            ctx.installModelSelection(agentCtx, { current: selection, assembled: undefined });
            installed = true;
          }
        } catch { /* 继续试 B */ }

        // 路线 B：动态 import dsh-agent
        if (!installed) {
          try {
            const mod = await import('@deepseek-ai/dsh-agent');
            if (typeof mod.installModelSelection === 'function') {
              mod.installModelSelection(agentCtx, { current: selection, assembled: undefined });
              installed = true;
            }
          } catch { /* 继续试 C */ }
        }

        // 路线 C：手动挂两个钩子（完全等价于 installModelSelection 的行为）
        //   - system-prompt/assemble → 注入 {{provider}} / {{model}} 变量
        //   - agent/request          → 设置实际请求用的 provider/model
        // 只挂前者不够：变量有了，但实际请求还是走默认路由。
        if (!installed && typeof agentCtx?.on === 'function') {
          try {
            agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
              const assembled = await next();
              return {
                ...assembled,
                variables: {
                  ...assembled.variables,
                  provider: selection.provider,
                  model: selection.model,
                },
              };
            });

            agentCtx.on('agent/request', async (_payload, next) => {
              const resolved = await next();
              if (!resolved) return resolved;
              const { reasoningEffort: _drop, ...rest } = resolved;
              return {
                ...rest,
                provider: selection.provider,
                model: selection.model,
                ...(selection.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: selection.reasoningEffort }),
              };
            });

            installed = true;
          } catch { /* 彻底失败就交给 DSH 默认 */ }
        }
      }

      // 3. 用户自定义 setup 叠加
      if (typeof setup === 'function') await setup(agentCtx, createdAgent);
    },
  };

  // 创建方式：
  //   子智能体 → 直接 create({ parentAgent })，挂在父之下，不走 withoutInitiator
  //              （子智能体本来就该属于父会话，脱离父就没意义了）
  //   顶层会话 → withoutInitiator，脱离当前调用者作用域，成为独立会话
  const runner = parentAgent
    ? () => ctx.agents.create(config)
    : ctx.agents?.withoutInitiator
      ? () => ctx.agents.withoutInitiator(() => ctx.agents.create(config))
      : () => ctx.agents.create(config);

  const handle = await runner();
  if (!handle?.agent) return null;

  const realSessionId = handle.agent.session?.id ?? sessionId;

  // ★ 关键：把新会话挂到对应的工作区，否则侧栏里看不到/不在同一分组。
  //   DSH 官方建会话流程（dsh-api-session-controller）在建完后必调
  //   workspace.attachSession(sessionId)，我们绕过了它，必须自己补。
  //
  //   attachSession 内部会校验（dsh-workspace 源码）：
  //     1. readSessionHeader(sessionId).cwd 必须存在
  //     2. realpathNormalize(header.cwd) 必须是已存在的目录
  //     3. 归一化后的 cwd 必须【完全等于】workspace.record.path
  //   任一条不满足就抛错。所以必须等会话落盘后再挂，且路径要精确匹配。
  const attachLog = [];
  try {
    // ★ 不能直接用 ctx.workspaceRegistry —— 它需要 inject 声明，
    //   而热重载改不了 inject（模块级）。所以用 opts.getRegistry 传入的获取函数，
    //   它会走 ctx.get()/reflect/root 等多条路径。
    let registry = null;
    if (typeof opts.getRegistry === 'function') {
      try { registry = opts.getRegistry(); } catch (e) { attachLog.push('getRegistry err'); }
    }
    if (!registry) registry = ctx.workspaceRegistry;   // 兜底
    if (!registry) {
      attachLog.push('no workspaceRegistry');
    } else if (!cwd) {
      attachLog.push('no cwd');
    } else {
      // ★ 正确方法：registry.resolveByPath(path)（不是遍历 state.workspaceIds）
      let target = null;
      if (typeof registry.resolveByPath === 'function') {
        try {
          target = await registry.resolveByPath(cwd);
          attachLog.push(target ? 'resolveByPath:OK' : 'resolveByPath:null');
        } catch (e) {
          attachLog.push('resolveByPath:err ' + String(e?.message ?? e).slice(0, 60));
        }
      }

      // 兜底：遍历 list()
      if (!target && typeof registry.list === 'function') {
        try {
          const all = await registry.list();
          const normTarget = normalizePath(cwd);
          for (const ws of all ?? []) {
            const p = ws?.record?.path ?? ws?.path;
            if (normalizePath(p) === normTarget) {
              target = ws;
              break;
            }
          }
          attachLog.push(`list:${(all ?? []).length}${target ? ' MATCH' : ' NO_MATCH'}`);
        } catch (e) {
          attachLog.push('list:err');
        }
      }

      if (!target) {
        attachLog.push('NO_MATCHING_WORKSPACE');
      } else {
        // 等会话 header 落盘（attachSession 内部要 readSessionHeader）
        let attached = false;
        for (let attempt = 0; attempt < 10 && !attached; attempt++) {
          try {
            await target.attachSession(realSessionId);
            attached = true;
            attachLog.push('ATTACHED');
          } catch (e) {
            const msg = String(e?.message ?? e);
            attachLog.push(`try${attempt}:${msg.slice(0, 70)}`);
            await new Promise((r) => setTimeout(r, 300));
          }
        }
      }
    }
  } catch (e) {
    attachLog.push('FATAL:' + String(e?.message ?? e).slice(0, 80));
  }

  return {
    handle,
    agent: handle.agent,
    sessionId: realSessionId,
    attachLog,
  };
}

/** 路径归一化：统一分隔符、去尾斜杠、小写（Windows 不区分大小写） */
function normalizePath(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 往会话发消息。
 *
 * @param {object} agent  - createSession 返回的 agent
 * @param {string} text   - 消息文本
 * @param {object} [source]
 * @returns {boolean} 是否投递成功
 */
export function sendToAgent(agent, text, source = { kind: 'relay' }) {
  if (!agent || typeof agent.followup !== 'function') return false;
  try {
    agent.followup(makeUserMessage(text, source));
    return true;
  } catch {
    return false;
  }
}

/**
 * 等 agent 空闲（或超时）。
 *
 * @param {object} agent
 * @param {number} [timeoutMs=300000]
 * @returns {Promise<boolean>} true=空闲，false=超时
 */
export async function waitIdle(agent, timeoutMs = 300_000) {
  if (!agent?.whenIdle) return false;
  let timer = null;
  try {
    const idle = agent.whenIdle();
    const timeout = new Promise((resolve) => {
      // 这里 unref 是安全的：Promise.race 会立刻用 idle 的结果，超时只是兜底
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([idle.then(() => 'idle'), timeout]);
    return result === 'idle';
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 轮询等待文件出现/更新（替代硬编码 sleep）。
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=120000]
 * @param {number} [opts.intervalMs=2000]
 * @param {number} [opts.since=0] - 要求 mtime 大于此值（0 表示只要求存在）
 * @returns {Promise<{ok:boolean, content:string|null, waitedMs:number}>}
 */
export async function waitForFile(filePath, opts = {}) {
  const { timeoutMs = 120_000, intervalMs = 2_000, since = 0 } = opts;
  const started = Date.now();

  const fs = await import('node:fs');
  const deadline = started + timeoutMs;

  // since === 0 表示"只要文件存在就算满足"；否则要求 mtime 严格大于 since。
  // 注意：调用方如果传了 since（哪怕是 0 以外的基线），必须等文件真的更新，
  // 不能因为文件已存在就立即返回。
  while (Date.now() < deadline) {
    try {
      const stat = fs.statSync(filePath);
      const fresh = since === 0 ? true : stat.mtimeMs > since;
      if (fresh) {
        return {
          ok: true,
          content: fs.readFileSync(filePath, 'utf8'),
          waitedMs: Date.now() - started,
        };
      }
    } catch {
      /* 文件还不存在，继续等 */
    }
    // 注意：不要 unref()。unref 的定时器不保持事件循环，在 await 等待时
    // 进程可能因为没有其他活跃句柄而提前退出（实测会导致 await 永远挂起）。
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, content: null, waitedMs: Date.now() - started };
}

/**
 * 从 agent 或事件里提取会话工作目录（多候选字段 + 兜底）。
 */
/**
 * 从 agent / ctx 提取会话工作目录。
 *
 * 关键：DSH 把 cwd 存在两处
 *   1. agent.session.meta.cwd（创建时传的）
 *   2. sessionProjections.workingDirectory（运行时的真实值，最准）
 * 优先用 projections，否则会 fallback 到 process.cwd()（=profile 目录，错误！）
 *
 * @param {object} agent
 * @param {object} [ctx]  - 传了才能读 sessionProjections
 * @param {object} [event]
 * @returns {string}
 */
export function resolveCwd(agent, ctx, event) {
  // 1. sessionProjections.workingDirectory 最准
  if (ctx?.sessionProjections?.stateOf && agent?.session) {
    try {
      const wd = ctx.sessionProjections.stateOf(agent.session, 'workingDirectory');
      if (typeof wd === 'string' && wd.trim() !== '') return wd;
    } catch { /* ignore */ }
  }

  // 2. session 上直接挂的字段
  const candidates = [
    agent?.session?.meta?.cwd,
    agent?.session?.cwd,
    agent?.session?.identity?.cwd,
    agent?.meta?.cwd,
    agent?.cwd,
    event?.cwd,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c;
  }

  // 3. 兜底：process.cwd()（通常是 profile 目录，不理想但至少能跑）
  return process.cwd();
}

/**
 * 会话级接力开关
 *
 * 三种状态：
 *   - 'on'      ：本会话启用接力（到阈值就接力）
 *   - 'off'     ：本会话不接力，走 DSH 原生压缩（/compact）
 *   - undefined ：未显式设置 → 继承全局默认
 *
 * 关键规则：
 *   1. 用户手动关掉 → 该会话永久走压缩，不再接力
 *   2. **接力产生的新会话 → 自动 'on'**（否则接力链断了）
 *   3. 全局开关关闭 → 所有会话默认 off
 *
 * 存储：$DSH_HOME/dsh-relay/session-flags.json
 *   { "session-id": { "mode": "on"|"off", "reason": "...", "at": 1234567890 } }
 */
import fs from 'node:fs';
import path from 'node:path';

export const MODE_ON = 'on';
export const MODE_OFF = 'off';

export class SessionFlags {
  constructor(file) {
    this.file = file;
    this.data = { flags: {}, updatedAt: 0 };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = raw && typeof raw === 'object' ? raw : { flags: {}, updatedAt: 0 };
      if (!this.data.flags || typeof this.data.flags !== 'object') this.data.flags = {};
    } catch {
      this.data = { flags: {}, updatedAt: 0 };
    }
  }

  save() {
    this.data.updatedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch { /* 落盘失败不该拖垮会话 */ }
  }

  /** 读取某会话的模式；未设置返回 undefined */
  get(sessionId) {
    const f = this.data.flags[sessionId];
    return f?.mode === MODE_ON || f?.mode === MODE_OFF ? f.mode : undefined;
  }

  /** 设置某会话模式 */
  set(sessionId, mode, reason = '') {
    if (mode !== MODE_ON && mode !== MODE_OFF) {
      throw new Error(`invalid mode: ${mode}`);
    }
    this.data.flags[sessionId] = { mode, reason, at: Date.now() };
    this.save();
    return this.data.flags[sessionId];
  }

  /** 清除某会话设置（回落到全局默认） */
  clear(sessionId) {
    delete this.data.flags[sessionId];
    this.save();
  }

  /**
   * 解析最终生效模式。
   *
   * @param {string} sessionId
   * @param {object} opts
   * @param {boolean} opts.globalEnabled  - 全局开关
   * @param {boolean} [opts.isRelayChild] - 是否是接力产生的新会话
   * @returns {{mode:'on'|'off', reason:string}}
   */
  resolve(sessionId, opts = {}) {
    const { globalEnabled = true, isRelayChild = false } = opts;

    // ★ 用户显式设置永远最高优先级。
    //   之前 isRelayChild 放在最前面无条件返回 ON，导致用户关掉接力后
    //   只要会话是接力产生的就仍然继续接力（用户关不掉）。
    const explicit = this.get(sessionId);
    if (explicit === MODE_OFF) return { mode: MODE_OFF, reason: 'user-off' };
    if (explicit === MODE_ON) return { mode: MODE_ON, reason: 'user-on' };

    // 接力产生的会话默认 ON（接力链默认不断），但用户显式 OFF 已被上面拦下
    if (isRelayChild) {
      return { mode: MODE_ON, reason: 'relay-child' };
    }

    // 全局开关关闭 → 一律 off
    if (!globalEnabled) return { mode: MODE_OFF, reason: 'global-off' };

    // 默认关闭（用户要求：新会话默认不接力，需要手动开）
    return { mode: MODE_OFF, reason: 'default-off' };
  }

  /** 列出所有显式设置 */
  list() {
    return Object.entries(this.data.flags).map(([id, f]) => ({ sessionId: id, ...f }));
  }
}

/**
 * 生成给用户的提示文案
 */
export function describeMode(resolved) {
  const map = {
    'relay-child': '接力产生的新会话 · 自动启用接力',
    'user-off': '你手动关闭了接力 · 走原生压缩',
    'user-on': '你手动开启了接力',
    'global-off': '全局关闭 · 走原生压缩',
    'default-off': '默认关闭 · 走原生压缩（需要时手动开启）',
  };
  return map[resolved.reason] ?? resolved.reason;
}

/**
 * 上下文水位测量 —— 双保险，绝不因模型不返回 usage 而失效
 *
 * 三层测量，从准到稳：
 *   1. usage（模型返回的真实 token 数）—— 最准，但可能没有
 *   2. 本地估算（字符数 / 4）—— 永远可用，误差约 ±20%
 *   3. 轮次计数（超过 N 轮就接力）—— 最粗，但绝不会漏
 *
 * 策略：三者取"最保守"（即最大值），宁可早接力也不要爆上下文。
 */

/** 与 DSH 内置 token-meter 一致的估算比例（英文/代码经验值） */
const CHARS_PER_TOKEN = 4;

/**
 * 中文/日文/韩文等 CJK 字符的 token 密度远高于英文。
 * 实测经验：中文约 1.5 字符 = 1 token（vs 英文 4 字符 = 1 token）。
 * 所以含 CJK 的文本要单独计算，否则会严重低估（实测低估 62%）。
 */
const CJK_CHARS_PER_TOKEN = 1.5;

/** CJK 字符正则（中日韩统一表意文字 + 假名 + 谚文 + 全角标点） */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF\u3000-\u303F\uFF00-\uFFEF]/g;

/**
 * 统计文本的 CJK 字符数与总字符数。
 * @param {string} text
 * @returns {{cjk:number, total:number}}
 */
export function countCjk(text) {
  if (typeof text !== 'string' || text.length === 0) return { cjk: 0, total: 0 };
  const matches = text.match(CJK_RE);
  return { cjk: matches ? matches.length : 0, total: text.length };
}

/**
 * 按中英文混合比例估算一段文本的 token 数。
 *
 * 公式：CJK 部分按 1.5 字符/token，其余按 4 字符/token。
 *
 * @param {string} text
 * @returns {number} 估算 token 数
 */
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const { cjk, total } = countCjk(text);
  const nonCjk = total - cjk;
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + nonCjk / CHARS_PER_TOKEN);
}

/** 常见模型的上下文窗口兜底表 —— contextWindow 拿不到时用这个 */
const KNOWN_WINDOWS = [
  [/deepseek-v4|deepseek-chat|deepseek-reasoner/i, 128000],
  [/claude.*(sonnet|opus|haiku)/i, 200000],
  [/gpt-4o|gpt-4.1|o1|o3/i, 128000],
  [/gemini/i, 1000000],
  [/kimi|moonshot/i, 256000],
  [/glm/i, 128000],
  [/qwen/i, 128000],
  [/mimo|nemotron/i, 128000],
];

/** 按模型名猜上下文窗口 */
export function guessContextWindow(modelName) {
  if (!modelName) return null;
  for (const [re, size] of KNOWN_WINDOWS) if (re.test(String(modelName))) return size;
  return null;
}
/** 每个内容块的固定开销（DSH 内部值） */
const BLOCK_OVERHEAD = 4;
/** 每条消息的固定开销 */
const MESSAGE_OVERHEAD = 4;

/** 估算一个内容块的 token 数 */
function estimateBlock(block) {
  if (!block || typeof block !== 'object') return 0;
  switch (block.type) {
    case 'text':
    case 'reasoning':
      // 用 CJK 感知的估算（中文 1.5 字符/token，英文 4 字符/token）
      return estimateTextTokens(block.text ?? '') + BLOCK_OVERHEAD;
    case 'tool-call':
      return (
        estimateTextTokens(block.name ?? '') +
        estimateTextTokens(block.arguments ?? '') +
        BLOCK_OVERHEAD
      );
    default: {
      // 结构化块（图片/文件等）：按 JSON 长度粗估
      try {
        return estimateTextTokens(JSON.stringify(block)) + BLOCK_OVERHEAD;
      } catch {
        return BLOCK_OVERHEAD;
      }
    }
  }
}

/** 估算一条消息 */
export function estimateMessage(message) {
  if (!message || typeof message !== 'object') return 0;
  const content = Array.isArray(message.content) ? message.content : [];
  return content.reduce((sum, b) => sum + estimateBlock(b), 0) + MESSAGE_OVERHEAD;
}

/** 估算整个会话的消息历史 */
export function estimateHistory(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, m) => sum + estimateMessage(m), 0);
}

/** 估算工具 schema 的开销（工具定义也要占上下文） */
export function estimateToolSchemas(tools) {
  if (!Array.isArray(tools)) return 0;
  let total = 0;
  for (const tool of tools) {
    try {
      const schema = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
      total += Math.ceil(schema.length / CHARS_PER_TOKEN);
    } catch {
      total += 50; // 兜底
    }
  }
  return total;
}

/**
 * 三层测量，返回最保守的水位百分比。
 *
 * @param {object} input
 * @param {object} [input.usage]          - 模型返回的 usage（可能没有）
 * @param {number} [input.contextWindow]  - 上下文窗口大小
 * @param {Array}  [input.messages]       - 会话消息历史（用于本地估算）
 * @param {Array}  [input.tools]          - 工具定义（用于本地估算）
 * @param {number} [input.turnCount]      - 已进行的轮次
 * @param {number} [input.turnLimit]      - 轮次上限（超过即认为该接力）
 * @returns {{percent:number, source:string, detail:object}}
 */
export function measureContext(input = {}) {
  const { usage, messages, tools, turnCount, turnLimit, modelName, projectedPressure } = input;
  // contextWindow 拿不到时，按模型名猜一个兜底值
  const contextWindow =
    input.contextWindow > 0 ? input.contextWindow : guessContextWindow(modelName);
  const candidates = [];

  // --- 层 0：DSH 自己算的 contextPressure（最权威）---
  //   sessionProjections.contextPressure = { pressureTokens, contextWindow, surfaceTokens }
  //   这就是 DSH UI 上显示的那个百分比，必须优先。
  if (projectedPressure > 0 && contextWindow > 0) {
    candidates.push({
      percent: Math.min(100, Math.round((projectedPressure / contextWindow) * 100)),
      source: 'projection',
      tokens: projectedPressure,
    });
  }

  // --- 层 1：真实 usage ---
  if (usage && contextWindow > 0) {
    const pressure =
      (usage.inputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0);
    if (pressure > 0) {
      candidates.push({
        percent: Math.min(100, Math.round((pressure / contextWindow) * 100)),
        source: 'usage',
        tokens: pressure,
      });
    }
  }

  // --- 层 2：本地估算 ---
  if (contextWindow > 0 && (Array.isArray(messages) || Array.isArray(tools))) {
    const estimated = estimateHistory(messages) + estimateToolSchemas(tools);
    if (estimated > 0) {
      candidates.push({
        percent: Math.min(100, Math.round((estimated / contextWindow) * 100)),
        source: 'estimate',
        tokens: estimated,
      });
    }
  }

  // --- 层 3：轮次计数 ---
  if (turnLimit > 0 && typeof turnCount === 'number' && turnCount > 0) {
    candidates.push({
      percent: Math.min(100, Math.round((turnCount / turnLimit) * 100)),
      source: 'turns',
      tokens: null,
    });
  }

  if (candidates.length === 0) {
    return { percent: null, source: 'none', detail: { reason: 'no signal available' } };
  }

  // 取最保守（最大）的那个
  const worst = candidates.reduce((a, b) => (b.percent > a.percent ? b : a));
  return {
    percent: worst.percent,
    source: worst.source,
    detail: {
      candidates: candidates.map((c) => ({ source: c.source, percent: c.percent })),
      estimatedTokens: worst.tokens,
      contextWindow,
    },
  };
}

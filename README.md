# dsh-relay

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**会话接力**插件：上下文快满时自动把进度总结到 `STATE.md`，创建新顶层会话、继承目标与权限，接着干。

## 解决什么问题

DSH 的会话有上下文窗口上限。跑长任务（几小时的训练、大重构、长研究）时，窗口会满，然后：

- 要么被 DSH 自己压缩，压缩后**丢掉失败方案、关键路径、必须遵守的规则**
- 要么你手动开新会话，重新交代一遍背景

本插件把这件事变成自动的：水位到阈值 → 写 `STATE.md` → 开新会话 → 继承目标、模型、权限、工作区 → 新会话读 `STATE.md` 继续。

## 功能

### 1. 上下文水位提醒（被动）

`system-prompt/assemble` 钩子在每次组装提示时追加一段水位状态：

| 水位 | 提示 |
|---|---|
| ≥78% | 🔴 **【强制规则已触发】** 置顶，明确「这是一条强制规则，不是建议」 |
| 68–77% | 🟠【即将触发强制规则】+ 剩余百分点 |
| <68% | 【水位正常】+ 顺手维护 STATE.md |

**不自动转移**——提示只让模型知道该做什么，动作由模型自己调 `relay_transfer`。

### 2. 78% 强制投递（主动）

到阈值时以**用户名义**插话投递一条消息：

> 做完这个后立刻开始整理文档，然后自己接力。
>
> （上下文已达 82%，超过阈值 78%。把 STATE.md 补全到最新，然后调用 relay_transfer 完成转移。）

用 `agent.steer()`（`send(input, "next-step", true)`）——当前这轮的下一个 step 就处理，不排队、不阻塞。同一 `(会话, goal 版本)` 只投一次。

### 3. 目标守护（错误自动恢复）

会话因**错误**中断导致目标停止驱动时，自动 `goals.resume()` 拉起来。

判定（四条同时成立）：
- `phase === 'active'` —— 目标仍是启用状态（`paused` / `complete` 一律不碰）
- `activation === 'disarmed'` —— 没在驱动
- `agent.status === 'idle'` —— 会话空闲（正在跑的不动）
- **在错误池里** —— 收到过 `agent/error` 或 `turn/end + max-tokens`

连续满足满 3 分钟才动手。用户手动 `pause` / `clear` 进黑名单，除非再次出现错误否则永不恢复。

### 4. 子智能体也能接力

用 `ctx.agents.create({ parentAgent })` 创建的新会话挂在同一父下，`isRelayChild` 同时检查 `relays` 和 `childParents`，接力后仍是子智能体。

### 5. 热重载

`lib/*.js` 变化时自动重载，不重启 DSH。

## 安装

```bash
# 1. 放进 profile 的 vendor 目录
git clone https://github.com/<you>/dsh-relay.git \
  ~/.dsh/profiles/desktop/vendor/dsh-relay

# 2. 在 profile 的 package.json 里声明
#    "dependencies": { "dsh-relay": "file:vendor/dsh-relay" }

# 3. 用 pnpm 安装（会复制到 node_modules）
```

> ⚠️ **重要**：`file:` 依赖会被 pnpm **复制**成 `node_modules/dsh-relay`（实体目录，不是软链）。改完 `vendor/` 里的代码必须同步到 `node_modules/`，否则运行时不生效。本仓库的 `scripts/sync.sh` 做这件事。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-relay
  name: dsh-relay
  config:
    enabled: true
    thresholdPercent: 78        # 强制阈值
    stateFileName: STATE.md
    maxRelays: 50
    autoStart: true
    patrol: true                # 定时巡检兜底
    patrolIntervalMs: 180000
    devEndpoints: false         # force / spawn-child 等副作用端点
    goalGuard: true             # 目标守护
    goalGuardDelayMs: 180000
    goalGuardIntervalMs: 30000
```

## 工具

| 工具 | 作用 |
|---|---|
| `relay_status()` | 查水位、开关、接力历史 |
| `relay_transfer()` | 正常转移（要求 STATE.md ≥50 字节） |
| `relay_transfer({ force: true })` | 跳过 STATE.md 校验强制转移 |
| `relay_reload()` | 手动热重载插件 |

## 触发时机

只用 **`turn/end`**（一次对话完成）+ 定时巡检兜底。

不用 `step/start` 做主要触发点：它在每次工具调用后都触发，会话频繁但水位变化不大，白白消耗检查。

巡检默认开启，因为它能覆盖「goal 驱动的长任务里几十轮都没有 turn/end」这种空档——实测有会话从 turn 30 到 turn 31 隔了 73 分钟，期间水位涨到 80%+ 却没有任何 turn/end。

## 实现要点（踩过的坑）

### `inject` 是模块级声明，热重载改不了

```js
export const inject = ['webServer', 'tools', 'sessionProjections', 'agents', 'hmr', 'workspaceRegistry']
```

`inject` 在模块加载时求值，热重载无法改变。所以服务获取全部写成多路兜底：

```js
function getGoals() {
  ctx.get('goals')                          // 1. 直接取
  ?? ctx.reflect?.get?.('goals')            // 2. reflect / registry
  ?? ctx.root?.goals                        // 3. root
  ?? scanCtxProperties(/^goal/i)            // 4. 遍历 ctx 属性
  ?? ctx.services?.get('goals')             // 5. services
}
```

### DSH 工具注册必须用 `defineTool`

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

const tool = defineTool({
  name: 'relay_status',
  parameters: { /* 扁平格式，不是 JSON Schema */ },
  output: {
    schema: { type: 'object', additionalProperties: true },  // 必须显式声明
    render: (v) => JSON.stringify(v),
  },
})
```

三个坑：
1. 不用 `defineTool` 工具不会出现在模型可见列表里
2. `parameters` 是扁平格式 `{name: {type, required, description}}`
3. `output.schema.additionalProperties` 必须显式写 `true` 或 `false`

### `ctx.tools.register()` 早期调用会挂

必须延后到 `apply` 末尾，并且优先用 `ctx.get('tools')`（真服务）而不是 `ctx.tools`（Proxy 浅视图）。

### 注册表无法用热重载清空

DSH 的全局工具表在 `already registered` 后拒绝重复注册，热重载清不掉，只能重启。

## STATE.md 模板

见 [`STATE.template.md`](STATE.template.md)。关键是**失败方案**那一节——压缩和摘要最容易丢的就是「试过什么没用、为什么」，而这恰恰是最贵的信息。

## License

MIT

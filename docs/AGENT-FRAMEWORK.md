# Agent 框架选型（pi / dsh / 自研薄层）

> 状态：v0.1（2026-11-12）。决定设备侧"管理层 Agent + 子 Agent"用什么底座。
> 结论：**自研薄层，借鉴 pi 的事件流与工具循环；不引入 dsh**。

---

## 1. 候选事实

| 项目 | 形态 | 与设备侧的匹配度 |
|---|---|---|
| **pi-mono**（`@earendil-works/pi-agent-core`） | TypeScript 有状态 Agent：工具执行、事件流（`agent_start/turn_start/message_*/tool_execution_*`）、`convertToLlm` / `transformContext` 分层、`beforeToolCall/afterToolCall` 钩子 | 设计非常贴合；但面向 Node（依赖 `pi-ai`、文件/进程能力），浏览器需打包与裁剪 |
| **dsh**（DeepSeek Harness） | **Node 子进程运行时**，通过 stdio JSON-RPC 驱动（`@deepseek-ai/dsh-sdk-client`） | **不可用于设备浏览器**：设备没有 Node 子进程；SDK 明确是"spawn a runtime subprocess" |
| 自研薄层 | ~400 行：LLM 客户端 + 工具注册表 + 事件流 + schema 校验 + 预算统计 | 与核心机（事件日志、调度器、状态机）无缝；零运行时依赖 |

## 2. 决定

**自研薄层**，理由按权重：

1. **设备只有浏览器**：dsh 需要 Node 子进程，直接出局；pi 需要打包/裁剪，且其 `pi-ai` 会带入我们不需要的 provider 层。
2. **必须与核心机深度耦合**：Agent 的每一步要写事件日志、走调度器、受活动度/present 约束、计入预算——外部框架会多一层适配。
3. **2GB 预算**：多一个运行时依赖就是多一份内存与故障面。
4. **规则可控**：工具白名单、效果枚举、schema 校验必须由我们掌握（见 `INTERACTION-LAYER.md` 的教训）。

## 3. 借鉴 pi 的部分（不引代码）

| pi 的设计 | 我们的落地 |
|---|---|
| 事件流 `agent_start → turn_start → message_start/update/end → tool_execution_* → turn_end → agent_end` | `core/agent/events.js` 用同一套事件名，写事件日志 + 推送 UI |
| `AgentMessage` 与 LLM Message 分离；`convertToLlm` / `transformContext` | 我们的 `ContextComposer`：被动块/近况块在 `convert` 阶段注入，不污染历史 |
| 工具注册表 + `beforeToolCall` / `afterToolCall` 钩子 | `core/agent/tools.js`：白名单、参数校验、证据记录、结果后处理 |
| 流式 `message_update` | 角色层可选流式；工作层一次性 JSON |

## 4. 借鉴 dsh 的部分（只借概念）

- **插件/注册表**：skill、prompt、tool 都以数据注册，不写死在循环里；
- **审批语义**：危险动作（联网、写盘）默认拒绝，需显式授权——对应我们的工具白名单。

## 5. 不做的

- 不引 `@earendil-works/pi-agent-core` / `pi-ai`（依赖与打包成本）；
- 不引 `@deepseek-ai/dsh-sdk-client`（需要 Node 子进程）；
- 不做多 Agent 自主编排（本期只有"管理层 Agent + 固定子 Agent"）。

## 6. 何时重新评估

- 设备侧引入 Node/Go sidecar（那时 dsh 可用）；
- 需要多轮工具循环、流式 UI、复杂上下文压缩（那时 pi 值得打包）；
- Agent 逻辑超过 ~1500 行或出现并发/取消难题。

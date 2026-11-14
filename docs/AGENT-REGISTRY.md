# Agent 注册表与管理层（W12 / W13）

设备端 Agent 的提示词与技能不写在代码里：源文件在 `agent/`，构建期打包成 `www/agent/registry.json`，运行时只读清单。

## 1. 目录与格式

```
agent/
├─ skills/<name>/SKILL.md   # frontmatter + 使用说明
└─ prompts/<name>.md        # 纯文本模板，{{var}} 占位
```

`SKILL.md` frontmatter：

```yaml
---
name: wake-character        # 必须与目录名一致
description: 角色层唤醒：根据生活种子生成 1-2 句口语
class: character            # character | work
prompt: character-wake      # 必须存在于 agent/prompts/
maxTokens: 200              # 1–800
temperature: 0.8            # 0–2
tools: []                   # 子集：web_fetch / artifact_create / place_travel / weather / clock
output: text                # text | json
---
```

正文是给人看的说明（何时用、约束），不进入模型上下文。

## 2. 构建与校验

```bash
node tools/build-agent.mjs          # 生成 www/agent/registry.json
node tools/build-agent.mjs --check  # 只校验，不写文件
```

校验项：name/目录一致、description 非空、class、prompt 存在、maxTokens、temperature、tools 白名单、output、重名。任一失败退出码 1。

## 3. 运行时

`www/js/core/agent/registry.js`：

- `createAgentRegistry()` 默认加载 `www/agent/registry.json`；
- `getSkill(name)` / `getPrompt(name)` / `list()` / `stats()`；
- `render(name, vars)`：替换 `{{var}}`，**缺变量直接抛错**（尽早暴露模板与调用方不一致）。

Worker 命令：

| 命令 | 作用 |
|---|---|
| `agent_skills` | 列出技能与统计 |
| `agent_prompt` | `{name, vars}` → 渲染后的文本 |
| `agent_run` | `{intent, ctx}` → 管理层执行一次 |
| `agent_runs` | 最近 50 次运行记录 |

## 4. 管理层流程

`core/agent/manager.js`：

1. `agent_start` → `turn_start`；
2. 用 `manager-plan` 提示词让模型输出严格 JSON：`{"tasks":[{"skill","input","reason"}]}`；
3. 校验：JSON 可解析、`tasks` 数组、≤3 条、skill 存在、input 为字符串；失败记 `plan_rejected` 并终止；
4. 逐条派发：渲染该技能 prompt（变量：`intent`、`input`、`now`、`place`、`mood` + 调用方 `ctx`），按技能的 `maxTokens/temperature/output` 调 LLM；
5. `output: json` 的技能必须返回可解析 JSON，否则该任务失败；
6. 事件：`tool_execution_start/end`、`turn_end`、`agent_end`；运行记录写入 kv `agent_runs`（环形 50）。

事件名沿用 pi 的 `agent/turn/message/tool_execution` 结构，统一加 `agent:` 前缀写入事件日志。

## 5. 子 Agent（W14 起）

技能可以由子 Agent 实现，而不是直接调模型。管理层构造时传 `subAgents`：

```js
createManagerAgent({ llm, registry, subAgents: { "plot-writer": (args) => plotAgent.run(args) } })
```

命中子 Agent 时不再走通用 LLM 分支；子 Agent 返回 `{ok, text, ...}`，失败原因进入任务错误。

剧情子 Agent 的校验：30–80 字、含时段时间词、无引号台词、与最近 20 条 bigram 相似度 <0.6；不合格带原因重写 ≤3 次。

剧情输出是结构化的，同时驱动三件事：

| 字段 | 去向 |
|---|---|
| `text` | 事件日志 / 显现台词素材 |
| `event` / `mood` | `life.applyMood(..., {source:"plot"})`，影响状态机 |
| `place` | 地点提示（新场景由 PC 产出侧生成） |
| `imageQuery` | 背景图搜索（W15） |

事件从 `EVENT_POOL` 按时段与最近 10 条随机挑选，避免连续重复。

### 事件池扩展

内置 20 条之外，剧情 Agent 可定时生成新事件：

- `event-pool` 技能输出 `{events:[...]}`，字段与内置一致；
- 校验：text 4–24 字、hours 0–23、place 白名单、mood 维度/±0.3、与已有相似度 <0.6；
- 新事件写 kv `event_pool`（上限 60 条），与内置池合并后参与挑选；
- 调度器 `event_pool` 任务在 idle/asleep 执行，超过 6 小时自动补一次；
- 命令：`event_pool_refresh` / `event_pool_list` / `event_pool_clear`。

## 6. 背景子 Agent

`core/agent/subs/bg.js` 走壳的图片代理，无需 API key：

- `GET /__image/search?q=&n=`：Bing 图片（国内可达）→ Openverse（CC）→ Wikimedia Commons；
- `GET /__image/fetch?url=`：仅公网 IP、仅 `image/*`、≤6MiB；
- 设备侧裁成 960×540（cover），JPEG 质量递减到 ≤200KB，单色图直接拒绝；
- 结果字节存 kv `bg_last`，元数据进 `health.bg`。

## 6.5 出门决策（outing prompt）

`agent/prompts/outing.md`：核心机判定需要出门后，把心情、无聊度、最近行为、深层记忆和**全部已有场景池**（排除 home/office）交给 LLM。输出二选一：

- `{"mode":"existing","placeId":"..."}`：直接旅行到已有场景；
- `{"mode":"new","kind":"...","name":"...","description":"...","distance":N}`：写入 `sceneRequests`，由 PC 生成后回 `scene:ready`。

LLM 失败/非法输出时回退 `pickDestination`，不阻塞状态机。

## 7. 地图子 Agent（W16，废案）

**2026-11-14 废案**：ARM 侧地图生成已移除。设备不再生成户型、摆放家具、烘焙地图或打包场景；`core/agent/subs/map.js`、`scene-agent.js`、`scene-detail-agent.js`、`forge/` 地图生成模块与相关 prompt/测试已删除；`forge/grammar.js` 剧情文法保留。

保留的边界：

- ARM 只通过 `sceneRequests` 向 PC 请求场景，PC 生成后回 `scene:ready`；
- ARM 只加载 `assets/scenes/<id>/` 场景包并渲染（`view/scene-loader.js` / `view/overview.js`）；
- `core/grid.js` 负责碰撞，`core/interactions.js` 负责交互执行。

## 8. 唤醒运行时（W26）

`core/wake/runtime.js`：

- 严格 JSON：`outcome ∈ {silent,trace,message}`；message 必须有 share，silent 不得带 share；格式错误判失败，不冒充 silent；
- `world_event` 原子领取 + 15 分钟租约，失败释放；无事件走 `free_window`；
- 线头同时最多 5 根；`residue` 覆盖并 6 小时过期；
- `next_wake` 被宿主 45–90 分钟夹紧；
- `artifact` 只有带真实工具证据才接受；
- 唤醒锁：`navigator.locks` 可用时跨上下文互斥，否则进程内互斥。

命令：`wake_run` / `wake_event_add` / `wake_events` / `wake_threads` / `wake_thread_close` / `wake_runtime_state` / `wake_runtime_clear`。

## 9. 行为留档

每次自主行为执行完，`subs/record.js` 用 `behavior-record` 技能让角色 LLM 产出：

```json
{"summary":"她把面煮好，吃完觉得暖了一点。","mood":"energy +0.08, valence +0.05","evidence":""}
```

- summary 20–60 字，必须包含“做了什么 + 心情变化”；
- 写入 `behavior_log`（含 before/after 心情快照）与 `behavior:recorded` 事件；
- LLM 失败时记 `record.error`，行为本身不回滚。

## 10. AI 浏览目标（W28b）

`core/actions/browse.js`：

- LLM 输出 `{query, reason}` 或 `{topic, url, reason}`，只能给一个目标；
- `query` 走 `/__search`（Bing HTML 解析，无 key），模型可自由决定搜索词；
- 搜索结果逐个尝试，跳过内网/拦截页/过短正文，最多 3 个；
- 直接给 URL 时必须 http(s)、无凭据、非内网、域名在白名单；
- 抓取结果写 `net_log`（含 query/resultTitle/attempts），并进入行为留档。

## 11. 新增技能

工艺约束提炼自：

- https://github.com/howells/fiction
- https://github.com/alt-code-ai/agent (`fiction-writing-story-development`)

## 6. 新增技能

1. 建 `agent/skills/<name>/SKILL.md` 与 `agent/prompts/<prompt>.md`；
2. `node tools/build-agent.mjs`；
3. `node --test tests/agent-registry.test.mjs tests/agent-manager.test.mjs`；
4. 调试页「列出 skills / 跑一次 agent」验证。

# 世界核心机规格（v0.2 草案 · 待评审）

> 依据：`docs/WORLD-CORE-RESEARCH.md`（选型）、`docs/DECISIONS.md`（已定 D1–D6 与 2026-11-12 修订）、`docs/MEMORY-AND-SYNC.md`（双链路记忆）、WakeTrace 2.1.0 手册（`docs/protocol.md` / `docs/lifeworld.md`）、`PROJECT-PLAN.md` §9 / §10。
> 本文只定义**核心机的行为与契约**，不含 UI 与实现细节。

---

## 0. 已定前提（2026-11-12）

| # | 结论 | 影响 |
|---|---|---|
| D1 | 核心机跑在**浏览器 Worker**（`core.worker`） | 单进程、postMessage、崩溃=页面重载 |
| D2 | **设备侧独立运行工作 LLM 与角色 LLM，不依赖 PC**；PC 只在**显现模式**提供页面与它自己的 LLM 链路；调用时机由核心机决定；角色层受**唤醒机**控制 | 设备常开调用 + 统一预算 + 说话权互斥 + 双链路记忆同步 |
| D3 | 状态机需要**统计 + 可视化 + 恢复**，并包含**角色心情状态** | 三层状态机 + 心情模型 + 调试页 |
| D4 | 记忆是生命模拟的**必要能力**；归纳可调 LLM 降低算力，算力允许则本地 | 记忆管线（事件→事实→向量→检索） |
| D5 | **会出现设备与 PC 同时处理** | 需要明确的合并协议（字段所有权 + LWW），CRDT 仅在触发条件下引入 |
| D6 | **优先可运行**，Agent 层先自研 | 自研薄层 + 3 天 spike |

**产品目标（贯穿全篇）**：让用户觉得"她活着"——会自己做事、有连续的心情与记忆、有自主性。所有机制都要服务于这个感知，而不是堆功能。

---

## 1. 核心机职责边界

**做**：状态、事件、记忆、调度、LLM 路由、唤醒、预算、统计、恢复、与 PC 同步。
**不做**：渲染、输入处理、音频、Live2D、TTS。

```
core.worker
├─ machine/   三层状态机（world / character / task）
├─ mood/      心情模型（连续 4 维 + 5 个离散档）
├─ log/       事件日志（append-only + seq）
├─ memory/    记忆管线（抽取 / 归纳 / 向量 / 检索）
├─ wake/      唤醒机（PC 档 / 设备档）
├─ llm/       路由 + 两类调用 + 预算账本
├─ sched/     任务队列（优先级 / 切片 / 让位）
├─ sync/      outbox / inbox / 合并
├─ stats/     统计与快照
└─ governor/  资源治理（内存水位 / 降频 / 息屏）
```

---

## 2. 三层状态机

### 2.1 世界层（world）

| 状态维度 | 取值 | 迁移条件 |
|---|---|---|
| `display` | `overview` / `present` | 显现闸门（主机可达 + TTS + Live2D + 世界已停） |
| `conn` | `up` / `down` | 心跳 5s；丢失 >60s 判 down（WS + HTTP 双证） |
| `tier` | `idle` / `host` / `edge` | 主机可达 + 与门 → host；不可达 → edge |

非法组合 0 次（§10.1 矩阵）；每次迁移写 `state_log`（含原因）。

### 2.2 角色层（character）

```
character
├─ phase      sleep / wake / morning / noon / afternoon / evening / night
├─ activity   active / idle / asleep
├─ mood       low / calm / happy / tired / excited   ← 由连续值分档
├─ place      当前场景 id（home / park / shop / …，来自动态场景注册表）
├─ transit    null | { to, from_door, to_door, started_at, eta_min }
└─ presence   home（在场景中）/ away（出门，仅事件）
```

**place 是动态的**：地图由产出侧（PC/ARM agent）自增加，`place` 的取值集合不是编译期常量。见 §11.4 与 §2.4。

### 2.3 任务层（task）

```
queued → running → committed
                 └→ failed / interrupted
```

每个任务带 `kind / priority / budget / attempts / checkpoint`。`interrupted` 不自动重放。

---

## 3. 心情模型（D3 要求）

### 3.1 连续四维（0–1，持久化）

| 维度 | 含义 | 基线 | 上升 | 下降 |
|---|---|---|---|---|
| `energy` | 精力 | 0.55 | 睡觉、休息、晒太阳 | 劳作、熬夜、连续被叫 |
| `valence` | 心情好坏 | 0.55 | 好事、晴天、被回应 | 坏事、雨、久无人理 |
| `social` | 社交欲 | 0.40 | 长时间无人互动、独处 | 对话、被摸头（交互） |
| `focus` | 专注 | 0.50 | 工作、阅读、安静 | 被打断、频繁切换 |

**更新规则**：每游戏分钟向基线衰减 `k=0.004`；事件按表加减（±0.05–0.2）；上下限 0–1。
**离散档**（供状态机守卫与 UI 使用）：

| 档 | 条件 |
|---|---|
| `tired` | `energy < 0.30` |
| `low` | `valence < 0.35` |
| `happy` | `valence > 0.65` |
| `excited` | `energy > 0.75 且 valence > 0.70` |
| `calm` | 其余 |

### 3.2 心情影响什么（必须真的影响，否则是装饰）

| 影响面 | 规则 |
|---|---|
| 行为选择 | 热点打分见 §3.3；`tired` 偏向床/沙发，`social` 高偏向窗边/门口，`focus` 高偏向书桌 |
| 短句语气 | 每个短句桶带 `mood` 标签，按当前档加权抽取 |
| 唤醒概率 | `social` 高 + `valence` 高 → 主动气泡概率上调（仍受闸门限制） |
| 表情/气泡 | 输出 `mood` 字段给视图，决定表情标签与气泡配色 |
| 作息 | `tired` 提前入睡；`excited` 推迟 30 分钟 |

### 3.3 行为选择（utility，替代随机）

```
score(hotspot) = 1.0
  + 0.8 × moodFit(act, mood)        // 心情-动作匹配表
  + 0.6 × timeFit(act, phase)      // 时段-动作匹配
  - 0.5 × novelty(act)             // 最近 2 小时内做过则扣分
  - 0.3 × distance                 // 距离归一化
  + 0.1 × noise                    // 少量随机，避免机械
```

取 top-3 加权随机。**这是"她做事有理由"的实现**，比纯随机更像活着。

---

### 3.4 外部影响通道（预留，W33）

> 需求方口径：**唤醒机或剧情可能影响、甚至直接引导角色行为**，所以心情维度要打标记，日后需要更深层的状态机管理。

心情不是被动数值，而是**行为引导接口**。四类外部来源都可读/写：

| 来源 | 典型用途 | 权限 |
|---|---|---|
| `wake` | 醒来后的情绪残留（`residue`）、主动气泡的语气 | 可 bias / 小步 set |
| `plot` | 剧情要求"今天低落一点" | 可 bias / setpoint（带 TTL） |
| `interaction` | 用户互动（被摸头、被冷落） | 可小步 set |
| `doctor` | 异常降级（安全模式压低社交欲） | 最高优先级 |
| `system` | 衰减、作息、天气 | 基线 |

**两类影响**（W33 实现）：

- **bias**：不改数值，改打分权重与衰减速率（例如"低落时更想独处"）；
- **set / setpoint**：直接引导，必须带 `{source, reason, ttl}`，进 `moodLog`，可解释、可回滚。

**硬约束**：

- 每次外部写入必须归因（`source` ∈ 上表，`reason` 人话）；
- 优先级：`doctor > user > wake > plot > system`；低优先级不能覆盖高优先级的 TTL 内设定；
- 限频：同一 source 10 分钟内 ≤N 次（防抖），超出只记日志不生效；
- 禁止静默覆盖：`moodLog` 保留最近 50 条，`core:state` 带最近 5 条；
- 数值仍截断 0–1，衰减仍向基线。

**W4 已预留**：`applyMood(deltas, {source, reason})` + `moodLog`（归因记录）；`MOOD_SOURCES` 枚举已导出。
**W33 再做**：优先级/TTL/限频、episode（短时情绪）与 baseline（长期漂移）分离、剧情 setpoint、行为引导的可解释链。

## 4. 唤醒机（设备独立，**完整实现**，协议对齐 WakeTrace 2.1）

> 决策：**要完整的唤醒机**，不裁剪。设备档实现手册全部能力，仅 `MCP` 与 `Web Push` 因依赖服务端而留给 PC。

### 4.1 范围（完整清单）

| 能力 | 设备档 | 说明 |
|---|---|---|
| 严格 JSON 协议 + 不变量 | ✅ | 见 §4.2 |
| `world_event` 队列 + 15 分钟租约 | ✅ | 异常/拦截释放回队列，过期可重领 |
| `free_window`（无事件时） | ✅ | 本地日期 + 时段，禁止把 UTC 交给模型 |
| 线头（threads）≤5、可结束、30min–7 天重浮 | ✅ | 不是待办 |
| 小作品 `artifact_create` | ✅ | 纯文本/Markdown；图片/音频走工具注册表扩展 |
| 工具调用 + **真实执行证据** | ✅ | 证据独立保存，不能从正文推断 |
| `fact` / `content` / `residue` 三通道 | ✅ | 注入只用 `fact`；`residue` 覆盖且过期 |
| `next_wake` 上下限 + 动态窗口 | ✅ | 避免钟表式重复 |
| 静默时段、近似重复拦截、唤醒锁 | ✅ | 跨 Worker 用 `navigator.locks` |
| 失败 ≠ 静默 | ✅ | 空回复/截断/格式错误/请求失败一律记失败 |
| MCP 工具 | ❌（PC 侧） | 设备不跑 MCP 服务端 |
| Web Push | ❌（PC 侧） | 设备用气泡，不用推送 |

### 4.2 协议（照手册，不简化）

```json
{
  "outcome": "trace",
  "fact": "通过可信工具读取了当前天气。",
  "content": "雨很轻，我在这里多待了一会儿。",
  "share": "",
  "residue": "也许下一次还会想起雨落下来的声音。",
  "next_wake": { "min_minutes": 45, "max_minutes": 90, "reason": "暂时没有需要立刻继续的事情。" }
}
```

不变量：`outcome ∈ {silent, trace, message}`；`message` 必须有非空 `share`；`silent` 不得带 `share`；`fact` 简短克制；`residue` 覆盖；`next_wake` 受宿主上下限约束。

### 4.3 生活种子

| 顺序 | 来源 | 规则 |
|---|---|---|
| 1 | `world_event` 队列 | 原子领取最早到期事件；15 分钟租约；失败释放 |
| 2 | `free_window` | 含本地日期与时段（时区必须本地化） |

设备档事件来源：天气、作息节点、心情阈值、用户交互、任务完成、旅行归来、浏览完成。

### 4.4 工具注册表（设备侧，带证据）

| 工具 | 前置 | 证据 | 限制 |
|---|---|---|---|
| `web_fetch` | 网络可用 | `{url, title, status, bytes, excerpt_hash, fetched_at}` | 见 §11.3 |
| `artifact_create` | — | `{artifact_id, title, media_type, created_at}` | 文本/Markdown |
| `place_travel` | 地点图可达 | `{from, to, started_at, arrived_at}` | 见 §11.4 |
| `weather` | 网络或本地种子 | `{source, condition, temp}` | 失败降级本地种子 |
| `clock` | — | — | 本地时间 |

工具执行结果与模型自述**分开存储**；`content` 里写"我查了天气"不算证据。

### 4.5 设备档与 PC 档

| | 设备档 | PC 档（WakeTrace） |
|---|---|---|
| 何时 | 常驻 | 显现模式 / PC 在线 |
| 实现 | 本地 JS 运行时 | Python 服务 :8765 |
| 产出 | 事件 + 独白 + 气泡 + 任务 | timeline |

**互斥**：显现打开期间设备角色层静音（只记 `trace`，不产生 `message`），由 PC 链路说话；关闭后恢复。

### 4.6 设备档表达闸门（沿用 A8 数值）

| # | 条件 | 动作 |
|---|---|---|
| 1 | 23:00–07:30 静默 | 降为 `trace` |
| 2 | 用户 60s 内有交互 | 降为 `trace` |
| 3 | 距上次 `message` <45 min | 降为 `trace` |
| 4 | 本小时 ≥2 / 今日 ≥8 | 降为 `trace` |
| 5 | 首次安装 24h 内 | 降为 `trace` |
| 6 | 连续 3 次 `message` 且 5 分钟无回应 | 降频至 1 次/2h |
| 7 | 显现打开 | 降为 `trace` |

### 4.7 意图映射

| outcome | 设备行为 | 可见 |
|---|---|---|
| `silent` | 仅日志 | 否 |
| `trace` | 事件 + 独白（进被动上下文） | 否 |
| `message` | 文字气泡（≤20 字，离线不发声） | 是 |

## 5. LLM 路由与预算（D2）

### 5.1 路由（设备独立）

| 条件 | 角色层调用 | 工作层调用 |
|---|---|---|
| 设备（始终） | **设备直连云端** | **设备直连云端** |
| 显现打开 | **静音**（PC 链路说话，设备只记 `trace`） | 继续（低优先级，可让位） |
| PC 在线（未进显现） | 设备直连（PC 不参与） | 设备直连 |

> 设备侧只有一个 `LLMClient`；`route` 只由"是否处于显现"决定，与 PC 是否在线无关。

### 5.2 两类调用（参数不同，不能混用）

| 项 | 角色层 | 工作层 |
|---|---|---|
| 触发 | 唤醒机 | 调度器（生产 / 记忆归纳 / 浏览总结） |
| 输出 | 1–2 句口语（≤60 字） | JSON（schema 约束） |
| `max_tokens` | 200 | 800 |
| 温度 | 0.8 | 0.3 |
| 超时 | 8s | 20s |
| 失败 | **瞬时错误重试 ≤2 次**（指数退避）；永久错误不重试；连续失败只记录，不自动停用 | 同左 |

### 5.3 预算策略（**放宽，但规范输出**）

需求方口径：**预算不必卡太死，可以不在意消耗，但要规范输出内容**。因此：

| 机制 | 规则 |
|---|---|
| 单次上限 | 角色层 200 / 工作层 800 output tokens（硬） |
| 输出规范 | 工作层必须 JSON schema；角色层必须 ≤60 字、单段、无 markdown |
| 重试 | **瞬时错误重试 ≤2 次**：网络/超时/429/5xx/坏 JSON；退避 500ms→1s + 抖动；4xx（除 429）不重试 |
| 软告警 | 日 **50k** output 时记 `soft_alert` 并提示，**不改变行为** |
| **不做自动熔断** | 需求方口径：**只统计、不断闸**；是否停用由用户手动决定（GUI/命令） |
| 账本 | 按 `class/kind` 记账（calls/ok/failed/in/out），GUI 可看、可手动重置 |
| 不设 | 不做"每日固定配额"式的硬性节流（避免她"没话可说"） |

> 熔断不是预算，是**防跑飞**：模型异常循环、工具反复失败、URL 抓取风暴都靠它兜底。

### 5.4 服务商配置（PC 可直接修改）

设备侧保存 `{baseUrl, apiKey, model, timeoutMs, maxAttempts, retryBaseMs, reasoningEffort}`：

- **PC 通过 WS `llm:config` 直接改**，设备落库并立即生效（不需要重启）；
- 设备本地命令 `llm_config_set` / `llm_config_get` 同样可用（调试）；
- `apiKey` 只以掩码形式回传（`sk-***abcd`），日志不落明文；
- `baseUrl` 必须是 http(s)，非法配置直接拒绝并回错误；
- 配置持久化在 IndexedDB `kv:llm_provider`，重启保留。

**浏览器 CORS（实测风险）**：设备页面在 `127.0.0.1:8080`，直连外部 LLM 属跨域请求，会先发 `OPTIONS` 预检；多数服务商不返回 `Access-Control-Allow-Origin`，浏览器会直接拦掉（`net::ERR_CONNECTION_REFUSED` 或 CORS 错误）。
**已实现（W11b）**：本地 Go 壳提供 `POST /__llm/chat/completions` 代理（仅 `127.0.0.1` 可达）。页面发 `{baseUrl, apiKey, body}`，壳转发到 `baseUrl + /chat/completions`；不落 key 日志、请求 ≤1MB、响应 ≤4MB、超时 120s；上游不可达返回 502。开发服务 `tools/serve.mjs` 等价实现。

### 5.5 硬约束（沿用 §10.9）

`reasoning_effort=none`、不开 `tools`、JSON schema 约束、失败不重试、日上限封顶。

---

## 6. 事件日志与并发合并（D5）

### 6.1 记录

```js
{ seq, uuid, origin:'device'|'pc', t_local, t_wall, t_corrected,
  kind, payload, caused_by, supersedes, deleted:false }
```

- `seq`：每端单调递增；合并后按 `t_corrected` 排序。
- `uuid`：去重主键（两端都可能重发）。
- `caused_by`：因果链（"昨晚没睡好 → 今天发呆 → 早睡"），用于"不像随机动画"。
- `supersedes`：事实被取代而非删除（借 graphiti 建模）。

### 6.2 字段所有权（解决"同时处理"）

| 数据 | 所有者 | 对方权限 |
|---|---|---|
| 生活事件 / 心情 / 作息 | **设备** | PC 只读（用于上下文） |
| 记忆 L0–L3 事实 | **PC** | 设备只追加候选，不直接改写 |
| 世界资产（场景/背景/剧情） | 产出方（`tier` 标记） | 对方只读、不覆盖 |
| 显示态 / 档位 | 设备 | PC 只发建议（`tier`） |
| 对话历史 | PC | 设备不存 |

### 6.3 合并规则

| 场景 | 规则 |
|---|---|
| 同一 `uuid` 重复到达 | 丢弃（幂等） |
| 两端新增不同记录 | 全部保留，按 `t_corrected` 排序 |
| 同一事实被两端更新 | **LWW**：`updated_at` 大者胜；相同则 `origin` 优先级 `pc > device`（确定性） |
| 删除 | 写 tombstone（`deleted:true`），不物理删除，30 天后清理 |
| 资产同名 | 内容寻址（`id = sha256(内容)`），天然不冲突 |

> **何时才上 CRDT**：当出现"两端同时修改同一条记录的**同一字段**且都需要保留"时。当前所有写入都能归到单一所有者，**不需要 CRDT**。若将来要"两端都能编辑同一份日记/同一张地图"，再评估 Loro（894KB gzip）。

### 6.4 回流

`outbox`：设备未同步事件（≤200/批，`uuid` 去重，成功才删）。
`inbox`：PC 下发事件（同样幂等）。
断连期间只追加；恢复后先回流事件、再回流资产、最后切档。

---

## 7. 记忆管线（D4）

```
事件 ──规则预筛──► 候选 ──LLM 归纳（批量，idle）──► 事实
                                                    │
                                    ┌───────────────┴───────────────┐
                                    ▼                               ▼
                              embedding（本地/API）            文本索引（本地）
                                    │                               │
                                    └────────► 检索（KNN + 字面 + 时间衰减）
```

### 7.1 事实结构

```js
{ id, s: 主体, p: 关系, o: 客体, t: 发生时间, conf: 0..1,
  tier: 'L0'|'L1'|'L2'|'L3', source, supersedes, vec?: Float32Array }
```

### 7.2 归纳（用 LLM 降算力，符合 D4）

- **批量**：每 2 小时或事件 ≥20 条时一次；一次调用归纳 10–20 条 → 5–10 条事实。
- **规则预筛**：过滤 `tick`/`move` 等噪声，只留 `enter/act/say/weather/sleep/wake/forge_ok` 与用户交互。
- **失败**：保留原始事件，下次重试（最多 2 次）；不阻塞生活。

### 7.3 向量来源（**待定，阻塞**）

| 方案 | 成本 | 备注 |
|---|---|---|
| 本地 `bge-small-zh` 量化（~34MB） | 内存 +40–60MB（含 WASM 运行时）；A55 单次 100–300ms `[待测]` | 只能息屏跑；需随包预置（E20：不能运行时下载） |
| 云端 embedding API | 几乎 0 本地成本；按量计费 | **DeepSeek 无 `/v1/embeddings`**（§8.11），需另选供应商 |
| 不做向量，只做字面 + 时间衰减 | 0 | 语义召回缺失，A9 可能不达标 |

> 这是当前唯一"必须由你选供应商或接受本地模型"的技术缺口。

### 7.4 检索

- 本地：≤5000 条事实，暴力 KNN（512 维 × 5000 ≈ 2.5M 次乘加，JS 约几毫秒）+ 字面（bigram）+ 时间衰减。
- PC 可达：转发 `memory:query` 到 PC 的 `memory.db`（语义更准），本地结果兜底。
- 融合：`0.5×KNN + 0.3×字面 + 0.2×0.5^(age/30d)`（沿用 §2.7.4）。
- **遗忘**：`conf` 随时间衰减；低于阈值不删，只降权（"想不起来"比"记错"好）。
- **回忆触发**：事件里的名词命中事实关键词 → 注入一条"想起"上下文（零成本，生命感强）。

---

## 8. 调度与资源治理

| 优先级 | 任务 | 触发 | 预算 |
|---|---|---|---|
| P0 | life tick | 常驻 | ≤8ms/次 |
| P1 | 事件落库 / 回流 | 事件式 | 批量 |
| P2 | 记忆归纳（LLM） | idle/息屏，2h 一次 | 日 ≤1k |
| P3 | 剧情生成（LLM） | 息屏 | 日 ≤8 篇 |
| P4 | 背景合成（Canvas） | 息屏 | 日 ≤4 张 |
| P5 | 场景变体（Canvas） | 息屏 | 日 ≤6 张 |

- 单任务切片 ≤5s，片间检查让位；P0 永不被生成阻塞。
- 内存水位（`measureUserAgentSpecificMemory`）超阈值：P5 → P4 → P3 依次停。

**活动度 × 任务（避免把"息屏慢速"和"生成满速"混为一谈）**

| 活动度 | life tick（P0） | 生成任务（P2–P5） | 说明 |
|---|---|---|---|
| `active`（60s 内有输入） | 1s | **不跑**（排队） | 不抢用户 |
| `idle`（>60s 无输入） | 1s | 跑，切片 ≤5s | 后台慢慢做 |
| `asleep`（>10min 无输入，息屏） | **60s（1/min）** | **满速**（仍切片） | 屏幕不刷新，CPU 空闲 |
| `present`（显现打开） | 1s（继续） | **全部暂停** | 角色层静音，PC 说话 |
| `safe_mode`（Doctor） | 1s | 全停 | 只保留总观 + tick |

> **"息屏慢速"指 life tick 降到 1/min；"生成满速"指 forge 任务在息屏时获得更多时间片**——两者方向相反，不要写成一句。

---

## 9. 统计、可视化、恢复（D3）

### 9.1 统计项（持久化，按天聚合）

| 类别 | 指标 |
|---|---|
| 状态 | 各状态驻留时长、迁移次数、非法组合次数 |
| 心情 | 四维均值/极值、档位分布、每日曲线 |
| 任务 | 按 kind 的成功/失败/中断、平均耗时、队列深度 |
| LLM | 按 class 的调用数、token、失败率、超时率 |
| 唤醒 | 唤醒次数、意图分布、闸门拒绝原因分布 |
| 记忆 | 事实数、索引大小、检索次数、命中率 |
| 事件 | 每日事件数、`dropped` 数、回流延迟 |

### 9.2 可视化（离线可用）

`www/debug.html`（`?debug=1` 或配置开启）：

1. **状态图**：由状态机 JSON 渲染 SVG（当前态高亮、迁移计数标在边上）——不依赖 Stately 云。
2. **时间线**：最近 200 条事件（kind/时间/因果链）。
3. **心情曲线**：四维折线（最近 24h）。
4. **任务队列**：优先级、状态、耗时、预算。
5. **健康**：内存、fps、索引大小、`dropped`、最后同步时间。

### 9.3 恢复

- 快照：每 60s 或状态迁移时写 `{machineSnapshot, mood, lastSeq, pendingJobs}`。
- 启动：载入快照 → 重放 `seq > lastSeq` 的事件（幂等）→ 运行中的任务标 `interrupted`。
- 目标：kill Worker 后 ≤2s 恢复，不重复处理、不丢事件。

---

## 10. 与 PC 的契约增量

| 消息 | 方向 | 说明 |
|---|---|---|
| `life:event` | PC → 设备 | 生活流事件（`cycle_id` 去重） |
| `say` | PC → 设备 | 主动发言文本（设备只显示，不发声） |
| `tier` / `state:overview` | PC → 设备 | 档位与纠偏 |
| `events:batch` | 设备 → PC | 回流事件 |
| `memory:query` / `memory:result` | 设备 ↔ PC | 语义检索代理 |
| `assets:manifest` | 设备 → PC | `tier:edge` 资产清单 |
| `wake:state` | 设备 → PC | 设备档唤醒状态（便于 PC 接手时避免重复开口） |

---

## 11. 自主活动（旅行 / 做饭 / 上网）

> 需求：她能自己决定去做事，理论上由 LLM 随机化，可能无限；至少包含旅行、做饭、看电脑（**真实联网并记录浏览内容**）。

### 11.1 活动注册表（能力白名单）

LLM **不能凭空发明动作**；它只能从注册表里选，并给参数。

```js
{
  id: 'cook', name: '做饭',
  requires: { place: ['kitchen'], props: ['stove'], network: false },
  duration: { min: 20, max: 90 },          // 游戏分钟
  effects: { energy: -0.1, valence: +0.15, focus: +0.1 },
  evidence: ['photo', 'artifact'],          // 必须留证
  cost: { tokens: 0, net: false }
}
```

内置活动（首批）：`sleep / eat / cook / read / work / clean / water_plants / watch / browse / write / travel / rest / play_with_cat`。
扩展方式：加一条注册表记录 + 可选生成器，**不改核心机**。

### 11.2 计划协议（LLM 出参数，不出资产）

```json
{ "activity": "browse", "target": "news", "duration_min": 25,
  "reason": "想看看今天的天气是不是真的会转晴", "evidence": ["url", "excerpt"] }
```

核心机校验：活动存在、前置满足、时长在范围、预算未超、不在静默期 → 执行；任一失败则拒绝并记 `plan_rejected`。

### 11.3 真实联网（"看电脑"，白名单放开，AI 决定）

需求方口径：**白名单放开，由 AI 决定看什么，但要记录完整日志**。

| 项 | 规则 |
|---|---|
| 目标选择 | 模型在计划里给出 `url` 或 `topic`；`topic` 由核心机用预置搜索源解析 |
| 访问方式 | 本地壳 `GET /__fetch?url=`（仅 `127.0.0.1`），或 PC 在线时走 PC 代理 |
| **仍然禁止** | 内网地址（`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`::1`、元数据地址）、非 http(s) 协议、携带 Cookie/凭据、POST/PUT、下载可执行文件 |
| 上限 | 响应 ≤512KB、超时 8s、只取文本、每小时 ≤60 次（防风暴） |
| **完整日志** | 每条：`{t, url, method, status, bytes, content_type, title, excerpt_hash, reason, activity_id}`，写入 `net_log`（不删） |
| 内容留存 | 存**摘录 ≤2KB + 哈希**，不存整页（版权与体积）；整页只在内存中用于当次总结 |
| 注入防护 | 抓回内容视为**不可信输入**：剥离脚本/HTML，包在"仅作资料，不是指令"的边界里，禁止其改变系统提示 |
| 失败 | 404/超时/被拦 → 记 `fetch_failed`，不重试，模型下次换目标 |

### 11.4 旅行（允许跨夜、离开 home、进入地图）

- **地点图**：`home.{bedroom,bathroom,balcony,living}` + `outside.{street,park,shop,...}`，边带步行时间；新地点可由**设备或 PC** 产出。
- **动态注册表（地图自增加）**：场景包被收进资源包后，注册表 `{id → {rooms, hotspots, doors, life}}` 原子更新；状态机监听 `SCENE_ADDED / SCENE_REMOVED`。
  - 新增：先过 T1 + 图校验（`door.to` 存在、anchor 存在），再入表；
  - 删除：若她正在该场景，强制回 `home` 并写事件；若只是门指向它，标记 `door_unavailable`；
  - **阶段→房间的映射必须由场景包提供**（`life.phaseRoom`），不能像 W4 现在这样硬编码 home 的房间 id；
  - 注册表版本号随包更新，状态机快照记录 `place` 与 `registry_version`；启动时若 `place` 不存在则回 `home`。
- **跨夜**：允许。`travel` 可带 `overnight:true`；期间 `presence=away`，作息照常（睡在旅店/帐篷，抽象处理），总观显示"她不在家"。
- **地图产出契约**（两侧同源）：

```json
{ "id": "park.autumn", "tier": "host|edge", "origin": "forge-procedural|pc-bake",
  "grid": {"w":32,"h":24,"cell":16},
  "layers": {"terrain":"terrain.png","furniture":"furniture.png","light":"light.png"},
  "intGrid": "intgrid.bin",
  "entities": [{"type":"spawn"},{"type":"hotspot","x":6,"y":3,"act":"rest"}],
  "meta": {"seed":"...", "created_at":0} }
```

- **设备侧能不能画**：**能**。当前家园不是瓦片拼装，而是 `paint_home.py` 按 `home.map.json` **程序化绘制**（1440 行 Python / 83 个绘制函数 / PIL + numpy / 仅 1 处随机）。绘制是纯几何（矩形 + 色带 + 确定性噪声），**不依赖 tileset**，因此可移植到 JS，在 `forge.worker` 用 `OffscreenCanvas` 烘焙 PNG/WebP。
- **移植范围**：`paint_home.py`（绘制 + 闸门）+ `pick_layout.py`（158 行，户型骨架）→ 约 1200–1500 行 JS，3–5 天。
- **一致性验收**：同一 spec 在 Python 与 JS 下产出的 PNG **逐像素对比**（目标 0 差异；若因浮点/抗锯齿有差异，需 ≤N 像素且人工看图）。
- **真正要实测的不是 tileset，而是**：① 设备侧烘焙耗时（320×240 约 10–50ms + 编码 10–40ms `[待测]`）；② 户型生成器与家具表的双端同步维护。
- **瓦片方案**（MAP-SCENE-DESIGN 的 8 原型 × Wang tiles）才依赖 tileset；与「家园」这条线是两套，互不阻塞。
- 旅行期间：可产 `trace`、可带 `artifact`（"拍了一张照片" = 生成一张背景变体）、可触发 `message`（"我到了"）。

### 11.5 安全边界（写死）

不购买、不登录、不提交表单、不发消息、不下载可执行文件、不访问内网/元数据地址；所有联网行为留证可审计。

## 12. 显现模式与核心机共存（**已定 P1：iframe**）

**问题**：显现是 PC 通过 HTTP 提供的页面；页面导航会销毁当前文档，`core.worker` 随之终止 → 24/7 不成立。

**定稿：P1 iframe**。本地壳页面常驻（核心机在此），显现用**跨域 iframe 全屏覆盖**。

### 12.1 实现要求

| 项 | 要求 |
|---|---|
| 宿主页面 | `127.0.0.1:8080`（secure context），永不导航；核心机、总观、生活 tick 都在这里 |
| iframe | `<iframe src="https://<pc>:8443/" allow="microphone; autoplay; fullscreen" referrerpolicy="no-referrer">` |
| **HTTPS 必须** | PC 页面必须是 HTTPS（自签 + 网关），否则 iframe 内 `getUserMedia` 被拒 |
| 证书信任 | 设备预置 PC 根证书（M3-T1/T4、M4-T4）；过期需可更新 |
| PC 页面适配 | 不能带 `X-Frame-Options: DENY/SAMEORIGIN`；CSP 需允许被内嵌；页面按 1080p 全屏布局 |
| 交互 | 显现期间 iframe 独占输入；关闭时销毁 iframe（释放内存与音频） |
| 失败 | iframe 加载失败/证书错误 → 回总观 + 气泡，不白屏 |

### 12.2 显现期间的职责划分（**全部由 PC 完成**）

| 项 | 设备 | PC |
|---|---|---|
| 页面 / UI / Live2D / TTS / ASR | ❌ | ✅ |
| 对话 LLM | ❌（静音） | ✅ |
| 生活 tick / 事件 / 心情 | ✅（继续） | 只读 |
| 记忆 | 提供（推送） | 消费 + 生产 |
| 显现后记忆回流 | **接收** | 生产并下发 |

设备在显现期间**只做两件事**：继续生活（`trace`）、把记忆推给 PC；显现结束后接收 PC 产生的记忆。

## 13. 开放问题

| # | 问题 | 状态 |
|---|---|---|
| Q1 | 显现共存方式 | **已定 P1 iframe**（§12） |
| Q2 | 唤醒机是否完整实现 | **已定：完整**（§4） |
| Q3 | 浏览白名单 | **已定：放开，AI 决定，全量日志**（§11.3） |
| Q4 | 旅行跨夜 | **已定：允许**（§11.4） |
| Q5 | LLM 预算 | **已定：放宽，规范输出，熔断防跑飞**（§5.3） |
| Q6 | 显现会话的 fact 抽取由谁做 | 待定：建议 PC（有对话原文），设备只接收 |
| Q7 | 设备侧地图产出 | **阻塞**：缺 tileset 烘焙管线；一期由 PC 产出 |
| Q8 | 心情四维是否够用 | 待定（可先四维，真机看曲线再调） |
| Q9 | 跨夜旅行时总观显示什么 | 待定：抽象地点卡片 / 最后画面 + "她不在家"角标 / 黑屏 |
| Q10 | 浏览日志保留多久、是否含摘录 | 待定：建议永久保留元数据，摘录 30 天 |


---

## 14. Doctor（自检与自愈，未来功能）

> 需求：运行周期内自动检测异常；出现异常立刻把日志交给 LLM 诊断修复，然后继续运行。
> 定位：**未来功能**，先记录设计，不进入当前批次；实现时挂在核心机的 governor 上。

### 14.1 两层看门狗

| 层 | 谁 | 能做什么 |
|---|---|---|
| 进程内 | `core/doctor.js` | 检测、打包日志、调 LLM、执行**白名单动作** |
| 进程外 | Go 壳 `/__health` + systemd | 核心机卡死/崩溃时唯一出路：重启服务 |

进程内 doctor 自己挂了不能自救，所以进程外这层必须有。

### 14.2 检测项与周期

| 周期 | 内容 |
|---|---|
| 5 min 轻检 | worker 心跳、tick 间隔、内存水位、事件 `dropped` 增量、LLM 错误率 |
| 30 min 深检 | IndexedDB 读写、资产配额、场景加载、时钟偏移、队列积压、日志体积 |
| 异常即时报 | 任意一次致命错误（worker 崩溃、加载失败、写库失败） |

| 类别 | 异常判据 |
|---|---|
| worker 心跳 | 缺失 >2s |
| tick | 间隔 >3× 正常值 |
| 内存 | `measureUserAgentSpecificMemory` > 阈值（如 1.2GB） |
| 事件 | `dropped` 持续增长 |
| 存储 | IndexedDB 写入失败任意一次 |
| LLM | 5 min 内错误率 >30% |
| 场景 | 加载失败/缺件 |
| 资产 | 淘汰频率 >10 次/小时 |
| 时钟 | 偏移突变 >5 min |
| 显现 | iframe 加载失败 |
| 网络 | 连续失败 >3 次 |

### 14.3 日志包（bundle）

```js
{ ts, version, state, mood, tier, conn, display,
  recentLogs: [...200], recentEvents: [...50],
  stats: {...}, errors: [...], config: {...} }   // 脱敏：API key、URL 参数、用户文本
```

### 14.4 LLM 修复（只能选动作，不能写代码）

输入：症状 + bundle + **允许动作清单** + 约束。
输出：`{ diagnosis, action, args, confidence }`。

| 动作 | 说明 |
|---|---|
| `restart_worker` | 重启 life/forge/core 子 worker |
| `reload_page` | 重载页面（核心机恢复） |
| `clear_cache` | 清 IndexedDB 缓存（保留事件） |
| `rollback_scene` | 回退到上一个可用场景 |
| `disable_forge` | 暂停端侧生成 |
| `reduce_fps` | 降帧/降分辨率 |
| `reset_index` | 重建本地索引 |
| `safe_mode` | 只保留总观 + tick |
| `noop` | 观察，不动作 |

**硬约束**：不执行模型给的代码、不改配置文件、不联网发布；动作必须在白名单内；每次修复后观察 60s，指标未恢复则回滚并进 `safe_mode`；10 分钟最多 1 次；连续 2 次失败 → 安全模式 + 用户可见提示。

### 14.5 验收（实现时）

- 注入 5 类故障（kill worker、内存涨、IDB 失败、LLM 超时、缺件）→ 能检测并修复/降级；
- 修复动作 100% 在白名单内；
- 日志包不含密钥与用户原文；
- 连续失败进入安全模式且可人工恢复。

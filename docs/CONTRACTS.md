# 跨进程契约 v0（A3）

> 状态：v0.1（2026-11-12）。冻结三张消息表：**主线程 ↔ 核心机**、**核心机 ↔ 子 Worker**、**设备 ↔ PC**。
> 规则先定、实现后补；任何字段变更先改本文档并升 `v`。
> 关联：`WORLD-CORE-SPEC.md` §5/§6/§10、`MEMORY-AND-SYNC.md` §7。

---

## 0. 通用信封

所有消息（Worker、WS 都一样）用同一信封：

```json
{ "v": 1, "id": "uuid", "type": "core:init", "ts": 1762905600000, "replyTo": "uuid?", "payload": {} }
```

| 字段 | 规则 |
|---|---|
| `v` | 协议版本；不匹配 → `error` 回复并记录 |
| `id` | 发送方生成，唯一；命令需幂等（同 id 重复到达只处理一次） |
| `type` | `域:动作`，见下表 |
| `ts` | 发送方毫秒时间戳（设备时钟可能漂，仅用于排序参考） |
| `replyTo` | 请求-响应关联；响应必须带 |
| `payload` | 纯 JSON；**不允许二进制**（资产走 blob/URL） |

**错误回复**：`{type:"error", replyTo, payload:{code, msg}}`；未知 `type` 必须回 `error`，不静默丢弃。
**WS 同信封**：设备 ↔ PC 的每条消息也必须带 `payload`（`hello` 的 `t_server`、`say` 的 `text` 都在 `payload` 里），不要放顶层。
**超时**：请求默认 5s（LLM 类 20s），超时由调用方判定，不重发。
**顺序**：同一通道内保序；不同通道不保证。
**心跳**：主线程 ↔ core 5s；core ↔ 子 Worker 5s；设备 ↔ PC 5s。

---

## 1. 主线程 ↔ 核心机（`core.worker`）

### 1.1 主线程 → 核心机

| type | payload | 说明 |
|---|---|---|
| `core:init` | `{scene, config, clock:{day,minute}, mood?}` | 启动/重载；幂等 |
| `core:input` | `{kind:"tap"\|"move"\|"present_open"\|"present_close"\|"menu", data?}` | 用户输入 |
| `core:display` | `{state:"overview"\|"present"}` | 显示态变化 |
| `core:host` | `{conn:"up"\|"down", t_server?, tier?}` | 主机可达变化 |
| `core:pause` / `core:resume` | `{}` | 暂停/恢复（显现、接管） |
| `core:query` | `{text, k}` | 记忆检索 |
| `core:command` | `{name, args}` | 调试/菜单命令（白名单） |
| `core:snapshot` | `{}` | 请求全量状态（响应 `core:state` + `core:health`） |

### 1.2 核心机 → 主线程

| type | payload | 频率 |
|---|---|---|
| `core:state` | `{patch}` | 变更时 + 5s |
| `core:event` | `{ev}` | 事件式 |
| `core:bubble` | `{text, ttl}` | 事件式 |
| `core:asset` | `{meta}` | 产出时 |
| `core:job` | `{id, kind, status, progress}` | 任务状态变化 |
| `core:moveTo` | `{targetGrid, path, speed, t0}` | 主机下发移动（转发给视图） |
| `core:health` | `{ok, uptime, tier, conn, host, log, queue, doctor}` | 5s |
| `core:error` | `{code, msg}` | 异常 |

---

## 2. 核心机 ↔ 子 Worker

### 2.1 life

| 方向 | type | payload |
|---|---|---|
| core → life | `life:init` | `{scene, day, minute, speed}` |
| core → life | `life:suspend` / `life:resume` | `{}` |
| core → life | `life:arrived` | `{room, act}` |
| life → core | `life:tick` | `{day, minute, phase, weather, room}` |
| life → core | `life:intent` | `{x, y, act, room}` |
| life → core | `life:event` | `{ev}` |
| life → core | `life:say` | `{text, ttl}` |
| life → core | `life:error` | `{code, msg}` |

### 2.2 forge

| 方向 | type | payload |
|---|---|---|
| core → forge | `forge:init` | `{scene, homeUrl}` |
| core → forge | `forge:enqueue` | `{kind:"plot"\|"bg"\|"scene", seed, ctx}` |
| core → forge | `forge:suspend` / `forge:resume` | `{}` |
| forge → core | `forge:asset` | `{asset}` |
| forge → core | `forge:fail` | `{kind, reason}` |
| forge → core | `forge:queue` | `{pending, busy}` |

---

## 3. 设备 ↔ PC（WS）

### 3.1 PC → 设备

| type | payload | 说明 |
|---|---|---|
| `hello` | `{host_id, t_server, tts, live2d, world_tier, agent}` | 握手；`t_server` 用于校时 |
| `state:overview` | `{work_tier, conn_state, pos_checksum, clock, agent}` | 5s；**不承载位置轨迹** |
| `moveTo` | `{targetGrid, path, speed, t0, act?, room?}` | 事件式 |
| `switchScene` | `{scene_id, transition, from_door, to_door, t0}` | 切场景 |
| `say` | `{text, ttl}` | 气泡/字幕 |
| `tier` | `{value:"idle"\|"host"\|"edge"}` | 档位 |
| `present:grant` / `present:deny` | `{reason?}` | 显现闸门结果 |
| `present:begin` / `present:end` | `{session_id}` | 显现会话边界（设备据此静音/接收记忆） |
| `life:event` | `{cycle_id, outcome, fact, content, share, residue, next_wake, occurred_at}` | 生活流（WakeTrace 协议） |
| `memory:facts` | `{since, facts, summary}` | 显现后记忆回流 |
| `memory:result` | `{req_id, hits, semantic, l0?}` | 检索结果（`req_id` 原样带回；`l0` 可选返回核心设定事实） |
| `facts:ack` | `{accepted, merged, rejected}` | 候选事实回执 |
| `events:ack` | `{seq}` | **确认已收到该 seq 及之前的事件**；设备据此推进同步游标 |
| `llm:config` | `{baseUrl?, apiKey?, model?, timeoutMs?, maxAttempts?, retryBaseMs?}` | **PC 直接修改设备 LLM 服务商配置**（落库生效） |
| `digest:get` | `{}` | 请求设备重发 `world:digest` |
| `mood:get` | `{}` | 请求当前心情可视化载荷（回 `mood:state`） |
| `state:export` | `{reason?}` | 请求设备上报整份存档；设备回 `state:save` |
| `state:restore` | `{id?, save}` | 下发存档；设备写 IDB + `/__state` 后重载页面 |
| `scene:ready` | `{id}` | PC 已完成某条 `sceneRequests` 的地图生成 |
| `pc:action:ack` | `{id, ok, result?}` | PC 执行完设备下发的 `pc:action` |

### 3.2 设备 → PC

| type | payload | 说明 |
|---|---|---|
| `hello` | `{t, role:"device", proto:1}` | 握手 |
| `heartbeat` | `{t}` | 5s |
| `present:request` | `{t}` | 请求进入显现 |
| `world:stop` / `world:resume` | `{}` | 进/出显现时停/恢复世界 |
| `events:batch` | `{events:[...]}` | 回流，≤200/批 |
| `assets:manifest` | `{assets:[...]}` | `tier:edge` 清单 |
| `memory:push` | `{since, facts, events, mood, phase, weather, place}` | 显现前推记忆 |
| `memory:query` | `{req_id, text, k, mood?, include_l0?}` | 语义检索代理（`req_id` 必填，用于结果关联；可选带 `mood` 与 `include_l0`） |
| `memory:result` | `{req_id, hits, semantic, l0?}` | 检索结果（`req_id` 原样带回；`l0` 可选返回核心设定事实） |
| `facts:candidates` | `{facts, events}` | 设备归纳候选 |
| `wake:state` | `{mode, next_wake_at, last_outcome}` | 设备档唤醒状态 |
| `llm:state` | `{configured, baseUrl, model, maskedKey, stats}` | 设备 LLM 配置与调用统计（不含明文 key） |
| `state:save` | `{save, reason}` | 整份存档（life/agent/places/mood/dailyPlots/writings/plots）；PC 落盘备份 |
| `state:restore:ack` | `{id, ok, day?, minute?, scene?, error?}` | 设备确认存档恢复 |
| `world:digest` | `{digest}` | 统一世界摘要（状态/日程/场景请求/PC 动作） |
| `mood:state` | `{v,ts,minute,band,dims,series,sources}` | 心情 4 维当前值 + 最近序列 + 来源分布（≤5s 节流） |
| `pc:action` | `{id, action, args}` | 设备请求 PC 执行白名单动作 |

### 3.4 世界摘要（world:digest）

设备在状态变化后（≤1s 防抖）与每 30s 生成一份摘要，同时：

- 写 kv `digest`；
- `POST /__digest` → 壳原子写 `data/digest.json`（PC 可 `GET /__digest` 读取）；
- `POST /__state` → 壳原子写 `data/state.json`，保存 `{savedAt, life, agent}`；`GET /__state` 在浏览器会话/IndexedDB 丢失后恢复；
- PC 侧 `state:save` 备份到 `data/saves/*.json`，保留最近 20 份；`GET /dhvw/saves`、`POST /dhvw/saves/backup`、`POST /dhvw/saves/{id}/restore`；
- 主机在线时推 `world:digest`。

```json
{
  "v": 1, "ts": 0, "seq": 0,
  "clock": {"day":"2026-11-13","minute":480,"phase":"morning"},
  "world": {"display":"overview","conn":"up","tier":"idle"},
  "life": {"minute":480,"phase":"morning","band":"calm","mood":{}},
  "agenda": [{"id":"plot-…","kind":"plot","at":0,"status":"done","payload":{}}],
  "sceneRequests": [{"id":"scene-…","reason":"outing","mode":"new","mapSpec":{"kind":"street","name":"集市","distance":7,"description":"有摊位和暖灯的集市","seed":"11-13-1"},"travel":true,"status":"pending"}],
  "pcActions": [{"id":"pc-…","action":"map.generate","args":{},"status":"queued|sent|acked|failed"}],
  "recentEvents": [], "budget": {}, "eventPool": {}, "outing": {}, "lastPlot": {}
}
```

`pc:action` 白名单：`map.generate` / `app.open` / `media.play` / `notify` / `web.open`；不在白名单直接拒绝。

`sceneRequests` 由 ARM 核心机在出门意愿触发时产生：`mode:"existing"` 只旅行到已有场景，不生成；`mode:"new"` 带 `mapSpec.description` 提交 PC 生成。`mapSpec.kind` 只有 `indoor`（室内）与 `street`（街道）两种。PC 回 `scene:ready` 后，ARM 把场景加入地点图；`travel:true` 时再执行旅行。

### 3.3 连接与幂等

- 心跳 5s；丢失 >60s 判不可达（WS + HTTP 双证）；
- 重连退避 2s → 15s；
- 所有事件按 `uuid` 幂等；批次可重发；
- `t_server` 为准，设备算 `clock_offset` 并回填 `t_corrected`。

---

## 4. 错误码

| code | 含义 |
|---|---|
| `bad_version` | 协议版本不匹配 |
| `bad_type` | 未知 type |
| `bad_payload` | 字段缺失/类型错 |
| `not_ready` | 尚未 init |
| `busy` | 当前有互斥操作（显现/接管） |
| `not_routed` | PC 在线时设备侧不调 LLM |
| `timeout` | 调用方判定 |
| `internal` | 未分类异常（必须带 msg） |

---

## 5. 版本与兼容

- `v` 从 1 开始；新增字段不升版本（向后兼容），删除/改语义必须升版本；
- 设备与 PC 各自声明 `proto`；不匹配时 PC 优先降级到旧字段；
- 契约变更流程：改本文档 → 改两端 → 加一条测试。

---

## 6. 可选本地 QQ Bot 桥接（`127.0.0.1:8088/qq/ws`）

> 仅在 `www/config.json: qqBot.enabled === true` 且 `qq-openclaw` 服务启用时生效；沿用 §0 统一信封 `{v:1, id, type, ts, replyTo?, payload}`。

### 6.1 服务进程（`qq-openclaw`） → 浏览器前端

| type | payload | 说明 |
|---|---|---|
| `qq:status` | `{connected, sandbox}` | QQ Bot Gateway 连线状态（连接建立/就绪推送） |
| `qq:memory:query` | `{text, k?, mood?}` | 请求前端检索记忆；前端以 `qq:reply`（`replyTo=id`）返回 `{semantic, l0, hits}`（PC 在线走 `memory:query`，离线降级 `localMemory`） |
| `qq:media:edge` | `{}` | 主动分享画作或日常瞬间时请求端侧最新风景图；前端以 `qq:reply`（`replyTo=id`）返回 `{dataUrl}` |
| `qq:world:feedback` | `{moodDelta?, bubble?, action?, event?, facts?}` | 单聊回复/主动消息/消化完成后向 ARM 世界回灌心情变化、气泡、动作、事件与候选事实（写入 `localMemory` 并在线推送 PC `facts:candidates`） |

### 6.2 浏览器前端 → 服务进程（`qq-openclaw`）

| type | payload | 说明 |
|---|---|---|
| `qq:world:state` | `{day, minute, phase, weather, place, room?, act, mood, band, present, recentNote?}` | 定时或建连时同步的 DHVW 世界/心情快照 |
| `qq:llm:config` | `{baseUrl, apiKey, model, reasoningEffort?}` | 从设备配置下发的 LLM 连接信息（由服务走 `dhvw-shell` `/__llm/chat/completions` 或直连） |
| `qq:world:event` | `{id?, kind, summary, ts?}` | 生活事件流（`writing` / `browse` / `bg_ready` / `travel` / `return`），供主动发起评估 |
| `qq:boost:state` | `{enabled}` | 同步 PC 端 `BOOST` 开关 / 端侧配置激活状态，控制 `qq-openclaw`（`followBoost: true`）实时上线或休眠 |
| `qq:reply` | `{...}` | 对 `qq:memory:query` 或 `qq:media:edge` 的应答信封（必须带原请求 `replyTo`） |

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
| `memory:result` | `{hits, semantic}` | 检索结果 |
| `facts:ack` | `{accepted, merged, rejected}` | 候选事实回执 |

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
| `memory:query` | `{text, k, since}` | 语义检索代理 |
| `facts:candidates` | `{facts, events}` | 设备归纳候选 |
| `wake:state` | `{mode, next_wake_at, last_outcome}` | 设备档唤醒状态 |

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

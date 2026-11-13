# PC 侧开发需求手册（对齐 ARM 核心机）

> 版本：v1.0（2026-11-13）
> 读者：PC 端（OLVT / 主机程序 / 网关 / 地图生成 / 记忆服务）开发者
> 事实来源：`arm/docs/CONTRACTS.md`、`arm/docs/WORLD-CORE-SPEC.md`、`arm/docs/PC-INTEGRATION.md`、`arm/docs/MEMORY-AND-SYNC.md`
> 原则：**ARM 是核心机，PC 是显现与重活**。旧主线里放在 PC 的状态机、生活 tick、唤醒、文本记忆，已经迁到 ARM；PC 侧按本手册改造。

---

## 0. 主线修正：旧 → 新

| 能力 | 旧主线（修正前） | 新主线（当前） |
|---|---|---|
| 世界/生活状态机 | PC 侧运行 | **ARM 核心机**（`world.js` / `life.js`） |
| 心情 4 维 | PC 侧维护 | **ARM**（`mood.js`，`mood:state` 供 PC 可视化） |
| 唤醒机 | PC 侧决定 | **双档**：显现时 OLVT；总观/离线时 ARM；PC 时间线档由 ARM 拉取 |
| 生活 tick / 作息 | PC 驱动 | **ARM**（`life_advance` / 调度器） |
| 事件日志 | PC 为主 | **ARM append-only**，PC 只接收 `events:batch` |
| 文本记忆 | PC 存正文 | **ARM 存文本**；PC 只做 embedding / `memory.db` / 语义检索 |
| 剧情 / 出门 / 行为 | PC 生成 | **ARM**（plot / outing / behavior pool / 行为留档） |
| 地图布局 + intGrid | PC 生成 | **ARM**（`forge/layout.js` + `map.js`）；PC 负责像素绘制/资产（可选） |
| 显现页 / OLVT / TTS / Live2D | PC | **PC**（不变） |
| 统一世界摘要 | 无 | **ARM 生成 `world:digest` + `data/digest.json`** |

### 0.1 所有权表

| 数据/职责 | 所有者 | PC 能做什么 |
|---|---|---|
| 世界/生活/心情/唤醒状态 | ARM | 只读（digest / mood:state）；通过 `tier`、`present:*` 影响 |
| 事件日志 | ARM | 接收、去重、入库、回 `events:ack` |
| 剧情/出门/行为/日程 | ARM | 读 digest，按 `sceneRequests` / `pcActions` 联动 |
| 场景像素资产 | PC（建议） | 按 `mapSpec` 生成，回 `scene:ready` |
| 记忆正文 | ARM | 接收事实、做向量、语义检索 |
| 向量库 `memory.db` | PC | 全权 |
| 显现页 / OLVT 回合 | PC | 全权；显现期间 ARM 唤醒挂起 |
| LLM 服务商配置 | ARM 落库 | 通过 `llm:config` 修改 |

---

## 1. 传输与连接

| 项 | 要求 |
|---|---|
| 通道 | WebSocket：`ws://<pc>:8877/dhvw`；经网关用 `wss://` |
| 信封 | `{v:1, id, type, ts, replyTo?, payload}`，`payload` 必须是对象 |
| 版本 | `v` 不匹配 → 回 `error {code:"bad_version"}` |
| 心跳 | 设备 5s 发 `heartbeat {t}`；PC 丢失 >60s 判设备离线 |
| 重连 | 设备退避 2s → 15s；PC 允许同设备重连，按 `uuid` 幂等 |
| 校时 | `hello.t_server` 毫秒时间戳；设备算 `clock_offset` |
| 顺序 | 同通道保序；不同通道不保证 |
| 超时 | 请求默认 5s；LLM 类 20s；调用方判定，不自动重发 |
| 错误 | `{type:"error", replyTo, payload:{code,msg}}`；未知 type 必须回错误 |

### 1.1 错误码

`bad_version` / `bad_type` / `bad_payload` / `not_ready` / `busy` / `not_routed` / `timeout` / `internal`。

---

## 2. 消息表

> 状态列：**已实现** = ARM 当前代码已处理/发送；**契约保留** = 文档已定、ARM 暂未主动发送，PC 不应依赖。

### 2.1 PC → 设备

| type | payload | 状态 | PC 侧动作 |
|---|---|---|---|
| `hello` | `{host_id, t_server, tts, live2d, world_tier, agent}` | 已实现 | 握手/校时；`t_server` 毫秒 |
| `state:overview` | `{work_tier, conn_state, pos_checksum, clock, agent}` | 已实现 | 5s；不承载位置轨迹 |
| `moveTo` | `{targetGrid, path, speed, t0, act?, room?}` | 已实现 | 事件式移动 |
| `switchScene` | `{scene_id, transition, from_door, to_door, t0}` | 已实现 | 切场景 |
| `say` | `{text, ttl}` | 已实现 | 气泡/字幕 |
| `tier` | `{value:"idle"\|"host"\|"edge"}` | 已实现 | 档位 |
| `present:grant` / `present:deny` | `{reason?}` | 已实现 | 显现闸门结果 |
| `present:begin` / `present:end` | `{session_id}` | 已实现 | 会话边界（设备据此静音/唤醒挂起） |
| `life:event` | `{cycle_id, outcome, fact, content, share, residue, next_wake, occurred_at}` | 已实现 | WakeTrace 生活流 |
| `memory:facts` | `{since, facts[], summary}` | 已实现 | 记忆回流；设备回 `facts:ack` |
| `memory:result` | `{req_id, hits[], semantic:true}` | 已实现 | 必须原样带回 `req_id` |
| `facts:ack` | `{accepted, merged, rejected}` | 已实现 | 候选事实回执 |
| `events:ack` | `{seq}` | 已实现 | **必须回**；设备据此推进游标 |
| `llm:config` | `{baseUrl?, apiKey?, model?, timeoutMs?, maxAttempts?, retryBaseMs?}` | 已实现 | 修改设备 LLM 配置，落库生效 |
| `digest:get` | `{}` | 已实现 | 设备重发 `world:digest` |
| `mood:get` | `{}` | 已实现 | 回 `mood:state` |
| `scene:ready` | `{id}` | 已实现 | 标记 `sceneRequests` 完成 |
| `pc:action:ack` | `{id, ok, result?}` | 已实现 | 设备动作回执 |

### 2.2 设备 → PC

| type | payload | 状态 | PC 侧动作 |
|---|---|---|---|
| `hello` | `{t, role:"device", proto:1}` | 已实现 | 回 `hello` |
| `heartbeat` | `{t}` | 已实现 | 更新在线状态 |
| `present:request` | `{t}` | 已实现 | 判定 → `present:grant/deny` |
| `present:begin` / `present:end` | `{session_id}` | 已实现 | 进入/退出显现 |
| `events:batch` | `{events, from_seq, batch_id}` | 已实现 | 幂等入库 → `events:ack {seq}` |
| `assets:manifest` | `{assets:[...]}` | 已实现 | `tier:edge` 资产登记 |
| `memory:query` | `{req_id, text, k}` | 已实现 | 查向量库 → `memory:result`（≤200ms） |
| `world:digest` | `{digest}` | 已实现 | 状态/日程/场景请求/PC 动作 |
| `mood:state` | `{v,ts,minute,band,dims,series,sources}` | 已实现 | 可视化 |
| `pc:action` | `{id, action, args}` | 已实现 | 执行白名单动作 → `pc:action:ack` |
| `world:stop` / `world:resume` | `{}` | 契约保留 | 进/出显现时停/恢复主机档 |
| `memory:push` | `{since, facts, events, mood, phase, weather, place}` | 契约保留 | 显现前上下文 |
| `facts:candidates` | `{facts, events}` | 契约保留 | 设备归纳候选 |
| `wake:state` | `{mode, next_wake_at, last_outcome}` | 契约保留 | 以 `digest.wake` 为准 |
| `llm:state` | `{configured, baseUrl, model, maskedKey, stats}` | 契约保留 | 以 `digest`/`llm_config_get` 为准 |

---

## 3. 关键流程

### 3.1 事件同步（ACK 驱动）

```
设备 events:batch {events, from_seq, batch_id}
PC 幂等入库（uuid 去重）
PC 回 events:ack {seq}    // seq = 本批最大 seq
设备推进 ackedSeq（持久化）
```

- 设备 8s 未收到 ack → 重发同批；
- 重连后从 `ackedSeq` 继续；
- PC **必须**回 ack，否则设备会重复发送。

### 3.2 世界摘要

设备在状态变化后（≤1s 防抖）生成；PC 也可随时用 `digest:get` 主动拉取：

- 写 kv `digest`；
- `POST /__digest` → 壳原子写 `data/digest.json`；
- 主机在线时推 `world:digest`。

PC 三种读法：

1. WS `world:digest`；
2. `GET http://<device>:8080/__digest`（JSON 文件）；
3. 发 `digest:get` 主动拉。

摘要字段：

```json
{
  "v": 1, "ts": 0, "seq": 0,
  "clock": {"day":"2026-11-13","minute":480,"phase":"morning"},
  "world": {"display":"overview","conn":"up","tier":"idle"},
  "life": {"minute":480,"phase":"morning","band":"calm","mood":{}},
  "agenda": [{"id":"plot-…","kind":"plot","at":0,"status":"done","payload":{}}],
  "sceneRequests": [{"id":"scene-…","reason":"outing","mapSpec":{"kind":"lively","name":"集市","distance":7,"seed":"11-13-1"},"status":"pending"}],
  "pcActions": [{"id":"pc-…","action":"map.generate","args":{},"status":"queued|sent|acked|failed"}],
  "recentEvents": [], "budget": {}, "eventPool": {}, "outing": {},
  "lastPlot": {}, "mood": {}, "wake": {}, "behaviors": [], "net": [], "wakeRuntime": {}
}
```

### 3.3 场景请求（PC 生成地图）

1. 设备出门/剧情产生 `sceneRequests[]`，`status:"pending"`，带 `mapSpec {kind,name,distance,seed}`；
2. PC 取 pending 项，按 `mapSpec` 生成场景包（像素/图集/碰撞）；
3. PC 回 `scene:ready {id}`；
4. 场景包交付方式见 §6.3（当前待定，建议 HTTPS 资产 URL + `assets:manifest`）。

### 3.4 PC 动作

设备通过 `pc:action {id, action, args}` 请求 PC 执行：

| action | args 示例 | 说明 |
|---|---|---|
| `map.generate` | `{kind,name,seed}` | 生成地图 |
| `app.open` | `{app:"browser"}` | 打开应用 |
| `media.play` | `{url}` | 播放媒体 |
| `notify` | `{text}` | 系统通知 |
| `web.open` | `{url}` | 打开网页 |

PC 执行后回 `pc:action:ack {id, ok, result}`；设备更新 `pcActions[].status` 并写入 digest。

### 3.5 心情可视化

设备变化后 ≤5s 推 `mood:state`；PC 也可 `mood:get`：

```json
{
  "v": 1, "ts": 0, "minute": 480, "band": "calm",
  "dims": {"energy":0.55,"valence":0.55,"social":0.4,"focus":0.5},
  "series": [{"t":0,"minute":480,"band":"calm","mood":{}}],
  "sources": {"plot": 2, "tick": 5}
}
```

`series` 最近 120 点（设备环形 480），`sources` 最近 50 次写入来源计数。

### 3.6 记忆

| 流程 | 消息 | 要求 |
|---|---|---|
| 语义检索 | `memory:query` → `memory:result` | `req_id` 原样带回；≤200ms；超时设备降级本地 |
| 事实回流 | `memory:facts` → `facts:ack` | 按 `id` 去重；空 id/文本拒绝 |
| 原始事件 | `events:batch` → `events:ack` | uuid 幂等 |

设备只存文本；PC 负责 embedding（建议 `fastembed` + `bge-small-zh-v1.5`，随包预置，不能运行时下载）。

### 3.7 LLM 配置

```json
{ "type": "llm:config",
  "payload": { "baseUrl": "https://api.example.com/v1", "apiKey": "sk-...",
               "model": "deepseek-v4.1-flash", "timeoutMs": 20000,
               "maxAttempts": 3, "retryBaseMs": 500 } }
```

- `baseUrl` 必填、http(s)；请求路径 `/chat/completions`；
- `apiKey` 只回显 `sk-***abcd`；
- 重试：网络/超时/429/5xx/坏 JSON ≤2 次；4xx（除 429）不重试；
- 预算只统计 + 50k/日软告警，**不自动熔断**。

---

## 4. 显现模式（iframe）

| # | 要求 | 不满足的后果 |
|---|---|---|
| 1 | 页面走 **HTTPS** | iframe 内 `getUserMedia` 被拒，麦克风不可用 |
| 2 | 提供根证书给设备预置 | 证书错误 → 回总观 + 气泡 |
| 3 | 不能 `X-Frame-Options: DENY/SAMEORIGIN` | iframe 空白 |
| 4 | CSP `frame-ancestors` 允许 `http://127.0.0.1:8080` | 同上 |
| 5 | 1080p 全屏布局，不依赖地址栏/新窗口 | 布局错位 |
| 6 | `/health` 探活，且允许设备来源跨域（`Access-Control-Allow-Origin`） | 设备无法预判可用性（跨域 fetch 会被浏览器拦截） |
| 7 | 进入/退出各发一次 `present:begin/end` | 设备无法静音/接收记忆 |

**唤醒归属**：显现期间由 **PC/OLVT** 负责唤醒与回合；ARM 的 `wake` 挂起（不计数、不推进、不产出）。退出显现后 ARM 重新起算。PC 断线时设备先退显现，再恢复设备档。

---

## 5. PC 侧需要改造的点

1. **删除/停用** PC 侧世界/生活状态机、生活 tick、心情维护、唤醒决策——改为消费 digest / `mood:state`；
2. **保留并强化** OLVT 显现页：回合、TTS、Live2D、麦克风、`present:begin/end`；
3. **新增** `events:ack`、`digest:get`、`mood:get`、`scene:ready`、`pc:action:ack` 处理；
4. **新增** `sceneRequests` 消费与地图像素生成；
5. **改造** 记忆服务：只做向量/检索/合并，不再持有正文主副本；
6. **新增** `world:digest` 展示/联动（日程、出门、行为留档、预算）；
7. **保留** `llm:config` 下发能力，GUI 改配置后立即生效。

---

## 6. 数据契约

### 6.1 事件

```json
{ "seq": 12, "uuid": "…", "t_local": 0, "t_corrected": 0,
  "kind": "plot:generated", "payload": {}, "src": "device" }
```

### 6.2 心情

见 §3.5。

### 6.3 场景包（建议）

```json
{
  "name": "集市", "kind": "lively", "seed": "11-13-1",
  "grid": {"w": 24, "h": 16, "cell": 16},
  "rooms": [], "zones": [], "doors": [], "windows": [],
  "intGrid": [0, 1, 2, 3],
  "image": "https://<pc>/assets/scenes/market.png"
}
```

- `intGrid`：0 走 / 1 墙 / 2 门 / 3 窗；
- 交付方式待定：建议 PC 提供 HTTPS 资产 URL，设备通过 `assets:manifest` 登记后拉取；
- 设备侧已有 `validate-scene` 同源不变量，坏包会被拒。

### 6.4 事实

```json
{ "id": "pc-1", "text": "京都的枫叶", "t": 0, "tier": "L2", "meta": {} }
```

---

## 7. 验收清单（PC 侧）

- [ ] 双向 `hello`，`t_server` 校时误差 <1s
- [ ] 心跳 5s；断线 >60s 判离线，恢复 ≤30s 重连
- [ ] `events:batch` 重复发送不重复入库，且每批回 `events:ack`
- [ ] `world:digest` 能收到；`GET /__digest` 内容一致
- [ ] `mood:state` 能画曲线；`mood:get` 有响应
- [ ] `present:request → grant/deny`；`present:begin/end` 成对
- [ ] iframe 可加载、麦克风可用、无 X-Frame-Options 拦截
- [ ] 显现期间 PC 负责唤醒；退出后 ARM 恢复
- [ ] `sceneRequests` 能生成并回 `scene:ready`
- [ ] `pc:action` 白名单动作可执行并回 ack
- [ ] `memory:query` ≤200ms 且 `semantic:true`
- [ ] `memory:facts` 增量下发，`facts:ack` 计数正确
- [ ] `llm:config` 下发后设备立即生效
- [ ] 向量索引可删除重建

---

## 8. 未决问题

1. 场景包交付方式（HTTPS URL / 共享目录 / WS 分片）；
2. 自签 CA 如何下发到设备；
3. embedding 供应商（本地 fastembed / 云端）；
4. `memory.db` 位置与备份；
5. 是否提供 HTTP 备用通道；
6. 主机档与门判定最终裁决（建议 PC，设备只执行 `tier`）；
7. `world:stop/resume`、`memory:push`、`facts:candidates`、`wake:state` 是否补发，或统一由 digest 替代。

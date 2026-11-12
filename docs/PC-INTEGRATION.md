# 设备端对 PC 的请求（PC AI 阅读）

> 状态：v0.1（2026-11-12）。本文列出 **ARM 设备端需要 PC 软件提供**的接口与行为。
> 契约以 `arm/docs/CONTRACTS.md` 为准；记忆分工见 `arm/docs/MEMORY-AND-SYNC.md`；地图/交互见 `docs/MAP-SCENE-DESIGN.md`。
> 读者：负责 PC 软件的 agent。设备端已完成：核心机骨架、世界/生活状态机、事件日志、快照恢复、场景校验器。

---

## 1. 传输与连接

| 项 | 要求 |
|---|---|
| 通道 | WebSocket，`ws://<pc>:8877/dhvw`（或经 HTTPS 网关的 `wss://`） |
| 信封 | `{v:1, id, type, ts, replyTo?, payload}`（与 `CONTRACTS.md` §0 相同） |
| 心跳 | 设备每 5s 发 `heartbeat`；PC 丢失 >60s 视为设备离线 |
| 重连 | 设备退避 2s → 15s；PC 需允许同 `client_uid` 重连 |
| 校时 | `hello.t_server` 用**毫秒时间戳**；设备据此算 `clock_offset` |
| 幂等 | 所有事件按 `uuid` 去重；批次可重发 |

## 2. PC → 设备（设备已按此实现）

| type | payload | 说明 |
|---|---|---|
| `hello` | `{host_id, t_server, tts, live2d, world_tier, agent}` | 握手/校时 |
| `state:overview` | `{work_tier, conn_state, pos_checksum, clock, agent}` | 5s；不承载位置轨迹 |
| `moveTo` | `{targetGrid, path, speed, t0, act?, room?}` | 事件式 |
| `switchScene` | `{scene_id, transition, from_door, to_door, t0}` | 切场景 |
| `say` | `{text, ttl}` | 气泡/字幕 |
| `tier` | `{value:"idle"\|"host"\|"edge"}` | 档位 |
| `present:grant` / `present:deny` | `{reason?}` | 显现闸门结果 |
| `present:begin` / `present:end` | `{session_id}` | 显现会话边界 |
| `life:event` | `{cycle_id, outcome, fact, content, share, residue, next_wake, occurred_at}` | WakeTrace 生活流 |
| `memory:facts` | `{since, facts[], summary}` | 显现后记忆回流 |
| `memory:result` | `{req_id, hits[], semantic:true}` | 语义检索结果（`req_id` 必须原样带回） |
| `facts:ack` | `{accepted[], merged[], rejected[]}` | 候选事实回执 |

## 3. 设备 → PC（PC 需要接收/处理）

| type | payload | PC 侧动作 |
|---|---|---|
| `hello` | `{t, role:"device", proto:1}` | 回 `hello`（含 `t_server`） |
| `heartbeat` | `{t}` | 更新在线状态；超时判离线 |
| `present:request` | `{t}` | 判定是否允许显现（TTS/Live2D/世界已停）→ `present:grant/deny` |
| `world:stop` / `world:resume` | `{}` | 进/出显现时停/恢复主机档生产 |
| `events:batch` | `{events:[...]}` | 按 `uuid` 幂等入库；回 ack（可空） |
| `assets:manifest` | `{assets:[...]}` | `tier:edge` 资产登记 |
| `memory:push` | `{since, facts, events, mood, phase, weather, place}` | 并入上下文（显现前） |
| `memory:query` | `{req_id, text, k}` | 查 `memory.db` → `memory:result`（200ms 内返回，超时设备降级本地） |
| `facts:candidates` | `{facts, events}` | 去重/合并/向量化 → `facts:ack` |
| `wake:state` | `{mode, next_wake_at, last_outcome}` | 避免 PC 与设备同时开口 |

## 4. 显现模式（iframe）的硬要求

设备用 **iframe** 嵌入 PC 页面（P1 已定），因此 PC 侧必须满足：

| # | 要求 | 不满足的后果 |
|---|---|---|
| 1 | 页面走 **HTTPS**（自签 + 网关） | iframe 内 `getUserMedia` 被浏览器拒绝，麦克风不可用 |
| 2 | 提供**根证书**给设备预置（或可下载） | 证书错误 → 设备回总观 + 气泡 |
| 3 | 响应头**不能** `X-Frame-Options: DENY/SAMEORIGIN` | iframe 空白 |
| 4 | CSP `frame-ancestors` 允许设备来源（`http://127.0.0.1:8080`） | 同上 |
| 5 | 页面按 1080p 全屏布局；不依赖地址栏/新窗口 | 布局错位 |
| 6 | 提供 `/health` 或等价探活 | 设备无法在进入前判断可用性 |
| 7 | 进入/退出各发一次 `present:begin` / `present:end` | 设备无法静音/接收记忆 |

## 5. 记忆与向量（PC 侧职责）

设备**只存事件文本与 fact 候选**；**向量化、`memory.db`、语义检索都在 PC**。

### 5.1 输入

- `facts:candidates`：设备归纳的事实候选（可能为空，只有原始事件）；
- `events:batch`：原始事件（`uuid/seq/t_local/t_corrected/kind/payload`）。

### 5.2 处理管线（建议）

```
接收 → 规范化（时间/文本）→ 去重（文本哈希 + 时间窗 + uuid）
     → 合并（LWW：updated_at，pc > device）
     → 抽取/归纳（可选：设备已归纳则跳过）
     → embedding → 写 vec0 + FTS5 + mem_meta
     → 回 facts:ack（accepted/merged/rejected）
```

### 5.3 embedding 来源（需 PC 侧确认）

- DeepSeek **没有** `/v1/embeddings`（见 PROJECT-PLAN §8.11）；
- 可选：本地 `fastembed` + `bge-small-zh-v1.5`（约 90MB，随包预置），或云端 embedding 供应商；
- 模型**不能运行时下载**（E20：HuggingFace 直连/镜像均超时），必须随安装包或离线导入。

### 5.4 查询

- `memory:query` → `memory:result`，目标 **≤200ms**（局域网）；超时设备自动降级本地字面检索；
- 请求带 `req_id`，响应必须原样带回；
- 返回 `{req_id, hits:[{id, body, tier, ts, score}], semantic:true}`；
- 主机不可达时设备降级为本地字面检索，结果标 `semantic:false`。

### 5.5 回流

- 显现会话结束：PC 抽取 fact → 写库 → `memory:facts` 增量下发（`since` 游标）；
- 只下发 **fact + 摘要**，不下发逐句对话（避免回放情绪）。

## 6. 生活流（WakeTrace）

- PC 轮询 `/world/timeline`，按 `cycle_id` 去重，UTC → `Asia/Shanghai`；
- 转成 `life:event` 下发；`content` 只取事实，不原样注入；
- PC 在线时由 PC 的 A8 闸门决定是否开口；设备侧角色 LLM 静音（`present` 期间）；
- PC 离线时设备档唤醒机接管（`wake:state` 告知 PC）。

## 7. 验收清单（PC 侧自测）

- [ ] `hello` 双向握手，`t_server` 校时误差 <1s
- [ ] 心跳 5s；拔网线 >60s 设备判不可达，恢复后 ≤30s 重连
- [ ] `present:request` → `grant/deny` 正确；`present:begin/end` 成对
- [ ] iframe 可加载、麦克风可用、无 `X-Frame-Options` 拦截
- [ ] `events:batch` 重复发送不重复入库
- [ ] `facts:candidates` → `facts:ack`；`memory:facts` 增量下发
- [ ] `memory:query` 返回 `semantic:true` 且 ≤200ms
- [ ] 向量索引可删除重建（`mem_meta` 正文重灌）

## 9. LLM 服务商配置（PC 可直接修改）

设备侧 LLM 走 OpenAI 兼容接口，服务商由 **PC 通过 WS 下发**，设备落库并立即生效：

```json
{ "type": "llm:config",
  "payload": { "baseUrl": "https://api.example.com/v1", "apiKey": "sk-...",
               "model": "deepseek-v4.1-flash", "timeoutMs": 20000,
               "maxAttempts": 3, "retryBaseMs": 500 } }
```

| 字段 | 说明 |
|---|---|
| `baseUrl` | 必填，http(s)，末尾斜杠自动去掉；请求路径为 `/chat/completions` |
| `apiKey` | 可选；只以 `sk-***abcd` 形式回显 |
| `model` | 必填 |
| `timeoutMs` | 1000–120000，默认 20000 |
| `maxAttempts` | 1–5，默认 3（1 次 + 2 次重试） |
| `retryBaseMs` | 100–10000，默认 500（指数退避 + 抖动） |

**重试策略**：网络错误/超时/429/5xx/坏 JSON → 重试；4xx（除 429）不重试。设备侧 `llm:state` 回传 `{configured, baseUrl, model, maskedKey, stats}`。

**预算**：设备侧只做统计与软告警（日 **50k** output 提示），**不做自动熔断**；需要停用时由用户在 GUI 手动暂停。

PC 侧 GUI 改配置后发一次 `llm:config` 即可，无需重启设备。

> **CORS 注意**：设备页面在 `127.0.0.1:8080`，直连外部 LLM 会被浏览器预检拦截（多数服务商不返回 CORS 头）。设备侧**已内置本地代理** `POST /__llm/chat/completions`（W11b）：页面发 `{baseUrl, apiKey, body}`，壳转发到服务商。PC 侧无需为此做额外适配；若希望所有流量走 PC，可把 `baseUrl` 指向 PC 的代理端点。

## 8. 待 PC 侧确认

1. WS 端口/路径（默认 `8877/dhvw`）；
2. 证书与域名（自签 CA 如何给设备）；
3. embedding 供应商（本地 fastembed 还是云端）；
4. `memory.db` 位置与备份策略；
5. 是否提供 HTTP 备用通道（WS 不可用时）；
6. 主机档与门判定由谁最终裁决（建议 PC，设备只执行 `tier`）。

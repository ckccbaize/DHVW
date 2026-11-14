# 世界核心机（WorldCore）调研与设计草案

> 状态：**v0.1 待评审（2026-11-12）**。只做调研与边界，不写实现。
> 触发：设备端要 24/7 跑「生命仓」并与 PC 同步，必须有一个**世界核心机**负责调度：
> 融合**状态机 + 事件日志 + 记忆查询**，并带一个**管理层 Agent（调 LLM）**向**剧情/背景等子 Agent** 派任务，同时融合 **skill 与 prompt**。地图生成已移交 PC 产出侧。
> 约束：RK3566（4×A55 / **2GB** / 32G eMMC）+ Armbian + Chromium，只有浏览器（无 Python / Node 运行时）。

---

## 0. 先对齐：我对需求的理解（请确认）

```
                    ┌──────────────── 世界核心机（设备端，单 Worker） ────────────────┐
                    │                                                                │
  生活 tick ───────►│ ① 状态机（世界/生活/档位）  ──► ② 事件日志（append-only）        │
  用户输入 ────────►│        ▲                        │                              │
  PC 消息 ─────────►│        │                        ▼                              │
                    │ ⑥ 资源治理 ◄── ⑤ 调度器 ◄── ③ 记忆查询（本地索引 + PC 代理）    │
                    │        │              ▲                                         │
                    │        │              │                                         │
                    │        └── ④ 管理层 Agent（LLM）──► 子 Agent：剧情 / 地图 / 背景 │
                    │                    ▲                    ▲                       │
                    │            skill + prompt 注册表 ────────┘                      │
                    └────────────────────────────────────────────────────────────────┘
                                        │ outbox / inbox
                                        ▼
                                  PC：记忆库 L0–L3 / 主机档生产 / 对话
```

要点：
1. **核心机不是 UI**：它只产出状态、事件、任务结果；视图订阅它。
2. **核心机不是"再来一个 LLM 循环"**：LLM 只在"需要新内容"时被调用，其余靠状态机 + 本地文法（延续 §10.9 的 token 降耗口径）。
3. **核心机必须能 24/7**：所有状态可持久化、任务可恢复、崩溃可自愈、预算可封顶。

## 1. 与现有文档的冲突（必须先定，否则实现会反复）

| # | 现有口径 | 新需求 | 冲突点 | 待定 |
|---|---|---|---|---|
| C1 | §10.7.2「端侧不能做任何 LLM 对话」、A16「程序化路径 0 token」 | 设备端核心机要有管理层 Agent 调 LLM 派任务 | 端侧是否允许发 LLM 请求 | **D2** |
| C2 | §2.7.4「设备端不加载向量库、不跑 embedding，只收摘要 JSON」 | 核心机要"记忆查询" | 查询在本地还是代理到 PC | **D4** |
| C3 | §2.4「设备端不跑 Python，只有浏览器」 | 核心机若做成独立进程更省内存/更稳 | 核心机跑在 Worker 还是独立进程 | **D1** |
| C4 | §10.7.6「端侧只追加事件，不改写 L0–L3」 | 核心机要融合状态与记忆 | 是否需要双向合并（CRDT） | **D5** |

> 我的建议：C1 走"默认关、PC 不可达超时才允许受限直连"；C2 一期只做本地倒排 + PC 代理；C3 先 Worker（零新进程），真机内存不够再评估 Go 独立进程；C4 先 append-only，不引 CRDT。

## 2. 约束与预算（RK3566 / 2GB）

| 项 | 值 | 依据 |
|---|---|---|
| CPU | 4×A55 @ ~1.8GHz，无大核 | 硬件 |
| 内存 | 2GB 物理，Chromium 常驻占大头 | 硬件 + 真机待测 |
| 存储 | 32G eMMC，写入寿命敏感（R9） | 文档 |
| 运行时 | 只有浏览器：主线程 + Worker + IndexedDB | §2.1 |
| 网络 | 设备可联网；主机可达与设备有网是两件事 | §1.1 |
| 24/7 | 不允许 suspend；息屏只关显示层 | §10.7.5 |

**分项预算（设计值，真机校准）**

| 组件 | 内存 | CPU | 备注 |
|---|---|---|---|
| Chromium 基线（空白页） | ~350–450MB | — | [INFERENCE] 必须真机测（M0-T4 未做） |
| 总观渲染（Canvas 2D + 图层） | 120–180MB | 静止 8fps ≤15% 单核 | §10.2 |
| **世界核心机 Worker** | **30–40MB** | tick ≤8ms/次，均值 ≤12% | 状态机 + 队列 + 索引 |
| 本地倒排索引（5000 条摘要） | ≤10MB | 查询 ≤20ms | MiniSearch 量级 |
| 生成 Worker（息屏时段） | +30MB | ≤45%，切片让位 | §10.7.3 |
| LLM 调用 | ~2MB | 网络等待，不占 CPU | 流式解析不缓存全文 |
| 峰值余量 | ≥500MB | — | 不足则先砍渲染分辨率 |

> **结论**：核心机本身很便宜；真正的风险是 **Chromium 基线 + 渲染**。所以核心机必须先做，并且**在真机上量出基线**再决定后续功能。

---

## 3. 调研：候选与判定

判定口径（沿用 §2.7.2 的思路，按本项目硬约束卡）：
**P1 能塞进浏览器/2GB**、**P2 无 Node/Python 运行时依赖**、**P3 可持久化/可恢复**、**P4 许可清晰仍在维护**、**P5 与"只追加、可审计"口径相容**。

### 3.1 状态机

| 候选 | 许可 / 体积 | 能力 | 判定 |
|---|---|---|---|
| **XState v5** | MIT；**14.2KB gzip / 45.7KB min**（v5.33.4，Bundlephobia 实测，2026-11） | 状态图、actor 模型（可监督子 actor）、`getPersistedSnapshot()` 可持久化、纯 JS 无依赖 | **推荐**：actor 模型正好对应"生活/生产/Agent 管理"三条并发线；快照可进 IndexedDB |
| robot3 | MIT；约 2KB 级 | 极简 FSM，无 actor 监督/持久化 | 备选：核心机若嫌 XState 复杂，用它只做生活状态 |
| javascript-state-machine | MIT | 老牌 FSM，无并发/持久化 | 不选 |
| yay-machine | MIT | 轻量、TS 友好 | 备选 |
| 自研 reducer + 状态表 | — | 零依赖、可控 | **兜底**：若 XState 在真机/调试上不顺手，退回纯 reducer（现有 `life.worker` 已是这个形态） |

来源：<https://www.pkgpulse.com/packages/xstate>、<https://yay-machine.js.org/articles/vs-xstate/>

### 3.2 事件日志与同步

| 候选 | 许可 / 体积 | 判定 |
|---|---|---|
| **append-only + uuid + `clock_offset`**（自研，IndexedDB） | — | **推荐**：与 §10.7.6「端侧只追加、按 uuid 去重、不改写 L0–L3」完全一致；零依赖、可审计 |
| Yjs | MIT；84KB min / 25KB gzip | 只在需要**双向协同编辑**时才有价值；当前没有 |
| Loro | MIT；**2.92MB min / 894KB gzip**（benchmark 表） | 功能强，但体积/内存对 2GB 不划算 |
| Automerge | MIT；1.70MB min / 591KB gzip | 同上，且解析慢 |
| cr-sqlite | MIT/Apache | 需要 SQLite 扩展，浏览器不可用 |

来源：<https://loro.dev/docs/performance>（同表列出 yjs/automerge 体积）

> **结论：不引 CRDT**。同步模型是"设备追加 → PC 合并"，不是"两端同时改同一份文档"。只有将来出现"两端都能改记忆/场景状态"才重新评估。

### 3.3 记忆查询

| 方案 | 成本 | 判定 |
|---|---|---|
| **本地倒排索引（MiniSearch）** | 无模型、索引 ≤10MB、查询毫秒级；中文需 bigram 自定义分词 | **一期推荐**：只索引"摘要 + 事件标题"，不索引全文 |
| 本地 embedding（transformers.js + bge-small-zh 量化） | 模型约 **34MB**（bge-small 量化在 2–4GB 设备可用），WASM 推理；A55 上单次查询预计 100–300ms [INFERENCE] | **二期可选**：只在息屏时段建索引；必须实测内存与延迟 |
| 只走 PC（`memory.db` 代理查询） | 0 本地成本；主机不可达即无记忆 | **必做兜底**：主机可达时语义召回走 PC |
| 本地小 LLM 做摘要 | SmolLM2-135M 约 70MB，2GB 上"能跑但很慢" | **不做**：摘要交云端或规则模板 |

来源：<https://localmode.dev/blog/compatibility/low-memory-devices>（2–4GB 设备可用模型清单）、<https://github.com/lucaong/minisearch/issues/201>（中文分词需自定义）

> **结论**：一期 = 本地倒排（摘要级）+ PC 语义代理；二期再评估本地 embedding。

### 3.4 Agent 编排 / LLM 调用

| 候选 | 判定 |
|---|---|
| **自研薄层**（LLM 客户端 + 队列 + prompt 注册表 + JSON schema 校验，约 400 行） | **推荐**：无依赖、可单测、预算可控；子 Agent 本质是"带 schema 的一次调用 + 本地确定性生成" |
| Vercel AI SDK | 浏览器可用，但依赖链重（社区有"bloat king"评价），2GB 上不划算 |
| LangGraph.js | 图运行时 + 检查点，面向 Node/服务端；对"每夜几个任务"过重 |
| Mastra / VoltAgent | Node 优先、依赖多，不适合浏览器常驻 |
| ElizaOS 等完整 agent 平台 | 体量与本项目语义不匹配 |

来源：<https://engineered.at/articles/til-vercel-ai-sdk-the-bloat-king>、<https://agentopsguide.com/typescript-ai-agent-frameworks/>

> **结论**：自研薄层。LLM 只作为"出参数/出文本"的一次调用；**不引入 agent 框架的运行时**。

### 3.5 Skill / Prompt 管理

| 方案 | 判定 |
|---|---|
| **文件约定 + 构建期打包**：`skills/<name>/SKILL.md`（frontmatter：name/when/inputs/tools）+ `prompts/<name>.md`，构建时生成 `skills.json` 清单 | **推荐**：可 review、可版本化、零运行时 IO；与"先改文档再改代码"一致 |
| 运行时数据库存 prompt | 不选：改 prompt 要动数据，无法 code review |
| 硬编码在 JS 里 | 不选：不可审计、不可热换 |

### 3.6 持久化与任务队列

| 方案 | 判定 |
|---|---|
| **IndexedDB（Dexie 或手写封装）**：`events` / `jobs` / `assets` / `kv` 四个 store | **推荐**：手写封装已够（现有 `idb` 代码可复用），Dexie 作为可选（体积小、事务/索引更省心） |
| 浏览器内 durable job queue 库 | 生态零散、成熟度不足（多为个人包），**不引** |
| `navigator.locks` + `BroadcastChannel` | 用于多标签/Worker 互斥，可选 |

---

## 4. 推荐组合

| 层 | 选型 | 理由 |
|---|---|---|
| 状态机 | **XState v5**（世界/生活/档位），纯 reducer 作兜底 | 14KB、actor 监督、快照持久化 |
| 事件日志 | **自研 append-only**（IndexedDB + uuid + seq + `clock_offset`） | 与文档口径一致，零依赖 |
| 记忆查询 | **MiniSearch（bigram 分词）本地摘要索引** + PC 语义代理 | 一期零模型；二期再评估 bge-small |
| 调度 | **自研优先级队列**（持久化、切片、让位、日预算） | 2GB 上必须自己掌握时间片 |
| Agent | **自研薄层**：LLMClient + PromptRegistry + SkillRegistry + JobQueue + BudgetLedger | 可控、可测、无重依赖 |
| 子 Agent | 剧情（先）→ 背景 → 地图（依赖 tileset 管线） | 按实现成本排序 |
| 同步 | outbox/inbox 批 + uuid 去重 + 资产清单 | 不做 CRDT |
| 持久化 | IndexedDB 四 store + 定期快照 | 崩溃可恢复 |

**明确不引入**：CRDT（Yjs/Loro/Automerge）、agent 框架运行时（LangGraph/Mastra）、本地 LLM、一期本地 embedding。

---

## 5. 核心机内部结构（待评审）

```
core.worker（单 Worker，主线程只做视图与输入）
├─ bus.js            消息总线（主线程 ↔ core ↔ 子 Worker），带类型与序号
├─ machine/          世界状态机（XState）
│   ├─ world.js      显示态 × 主机可达 × 世界档位（§10.1 矩阵）
│   ├─ life.js       作息/漫游/天气（现 life.worker 迁入）
│   └─ jobs.js       任务生命周期（queued→running→committed/failed）
├─ log/              事件日志（append-only + seq + 环形 + 崩溃恢复）
├─ memory/           查询接口：localIndex（MiniSearch）+ remoteProxy（PC）
├─ sched/            调度器：优先级 + 预算 + 切片 + 让位 + 持久队列
├─ agent/
│   ├─ llm.js        OpenAI 兼容客户端（超时/中止/流式/用量回传）
│   ├─ prompts.js    PromptRegistry（构建期打包的 prompts.json）
│   ├─ skills.js     SkillRegistry（skills.json）
│   ├─ manager.js    管理层 Agent：意图 → 任务分解 → 派发 → 校验 → 落库
│   └─ subs/         子 Agent：plot / bg / map（各自 schema + 本地生成器）
├─ governor.js       资源治理：内存水位、降频、息屏、暂停/恢复
└─ sync.js           outbox/inbox：事件批、资产清单、记忆查询代理
```

**消息契约（草案，需冻结）**

| 方向 | 消息 | 频率 |
|---|---|---|
| 主线程 → core | `init` / `input{kind}` / `display{state}` / `host{conn,t_server}` / `pause` / `resume` / `query{text}` | 事件式 |
| core → 主线程 | `state{patch}` / `event{ev}` / `bubble{text}` / `asset{meta}` / `job{...}` / `health{...}` | state 5s 或变更时 |
| core → PC | `events:batch` / `assets:manifest` / `memory:query` / `present:request` | 批/按需 |
| PC → core | `hello` / `state:overview` / `memory:result` / `job:grant` / `tier` | 心跳 5s |

**调度策略（2GB 关键）**

1. 优先级：`P0 life tick` > `P1 事件落库` > `P2 剧情` > `P3 背景` > `P4 场景/地图`。
2. 时间片：单任务 ≤5s，片间检查让位；`P0` 永远不被生成任务阻塞。
3. 触发条件：生成只在 ①息屏 ②无互动 60s ③tick 空闲 时跑。
4. 预算：日 token 上限（默认 0，开启后按 kind 分账）；超限只停生成，不停生活。
5. 内存水位：`performance.measureUserAgentSpecificMemory()`（Chromium）超阈值 → 先停 P4 → P3 → P2。
6. 崩溃：Worker 看门狗 ≤2s 重建；从最近快照 + 事件 `seq` 续跑；未完成任务标 `interrupted` 不重放。

---

## 6. 调研结论（一句话）

**核心机用自研薄层 + XState 状态机 + append-only 事件日志 + 本地倒排记忆 + 自研调度器**；
不引 CRDT、不引 agent 框架、不做本地 LLM、一期不做本地 embedding。
这样在 2GB 上内存增量可压到 **≤50MB**，且每一层都能单测与真机打点。

---

## 7. 待决策（讨论用）

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| D1 | 核心机形态 | ①浏览器 Worker ②独立进程（Go/Rust + IPC）③PC 侧 | ①，真机内存不够再评估② |
| D2 | 端侧能否调 LLM | ①默认关，PC 不可达超时才受限直连 ②永远只走 PC ③设备常开 | ① |
| D3 | 状态机 | ①XState ②纯 reducer ③robot3 | ①，先做 3 天 spike |
| D4 | 记忆查询 | ①本地倒排 + PC 代理 ②一期就上本地 embedding ③只走 PC | ① |
| D5 | 同步 | ①append-only + uuid ②CRDT | ① |
| D6 | Agent 层 | ①自研薄层 ②AI SDK ③LangGraph.js | ① |
| D7 | Skill/Prompt | ①文件约定 + 构建期打包 ②运行时 DB ③硬编码 | ① |
| D8 | 子 Agent 顺序 | ①剧情→背景→地图 ②地图优先 | ① |
| D9 | 时间流速 | ①1 秒=1 分（演示）②真实 1:1 ③可配 | ③，默认② |
| D10 | 现有 spike 代码 | ①打 tag 后逐步替换 ②直接删 | ① |

# PC 主机端 · 功能实现规划

> 本文件是 PC 端实现范围的唯一依据。状态：**规划中（v0-plan.1）**。代码落地时同步更新本节版本号与状态。
> 与 `docs/DECISIONS.md` 冲突时以 DECISIONS 为准；与外部文档冲突时以本仓库为准，并把差异记入本文档“开放问题”。

## 1. 目标与完成定义

PC 端“完成”= 下列全部成立，缺一不算：

1. 全新 Windows 机器：单安装包 → 双击 → 托盘图标 → 可对话，全程零命令行。
2. 子系统全部由外壳托管：崩溃自动重启，单进程被 kill 后 ≤10 s 恢复服务能力。
3. 对外能力完备：对话、语音、生活流、主动开口、记忆、世界生产、显示态控制、桌面接管各有一条可验证链路。
4. 状态可观测：任一时刻能从 GUI 与日志回答“现在是什么显示态、什么世界档位、服务是否健康、上次失败原因”。
5. 资源可释放：进入世界生产前显存真实回落，退出后 TTS 恢复；切换动作有实测数据。
6. 预算可审计：世界生产的 token 消耗逐日有账本，超限停机。

**明确不在完成定义内**：设备出画面、前端交互、美术观感、端侧生成能力。

## 2. 分层与数据流

> 设备侧（ARM 核心机）的职责、消息表与数据契约见 [`ARM-CORE-INTEGRATION.md`](ARM-CORE-INTEGRATION.md)。PC 不再运行世界/生活状态机与唤醒决策，只消费 `world:digest`、`mood:state` 并负责显现/OLVT/记忆向量/地图绘制。

```
                    ┌──────────── 外壳（Electron 45 / TypeScript）──────────┐
                    │ 托盘 GUI │ Supervisor │ 端口管理 │ 日志 │ 配置库 │
                    │                    网关 8443                   │
                    └───────┬───────────────┬───────────────┬────────┘
                            │ 托管/健康检查  │               │ 反代
                    ┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼──────┐
                    │ orchestrator │ │ olvt-backend │ │  tts-svc   │
                    │    :8877     │ │    :12393    │ │   :9880    │
                    └───┬──────┬───┘ └──────┬───────┘ └────────────┘
           REST 轮询    │      │ 进程内端点  │
                    ┌───▼───┐  │ POST /dhvw/proactive
                    │wake-  │  │
                    │trace  │  │
                    │:8765  │  │
                    └───────┘  │
                               ▼
                    设备侧（本仓库外）经局域网消费
```

**数据流（对话）**：设备 WS → OLVT 后端 → LLM → TTS → 音频 + 口型 payload → 同一 WS 回设备。

**数据流（生活流）**：WakeTrace REST → orchestrator 去重落库 → 注入块 → OLVT 对话消息链（历史之后、本轮输入之前）。

**数据流（主动开口）**：orchestrator 闸门放行 → OLVT 进程内端点 → 复用设备连接合成音频 → 设备；orchestrator 记录回声。

**数据流（世界生产）**：模式机进入主机档 → 停 TTS → 等显存回落 → 模型出种子/prompt → 本地生成 → 原子写盘 + manifest → 回空闲。

## 3. 模块清单

实现语言固定：**外壳模块（SUP / PORT / LOG / CFG / GUI / GW）用 TypeScript 跑在 Electron 主进程**；**服务模块（MODE / LIFE / CTX / GATE / ECHO / MEM / WORLD / LEDGER / BRIDGE / OLVTP / OBS）用 Python 3.12**；`DESK` 为独立可执行进程。跨语言只经本机 HTTP/WS 与落库，不共享内存。

| ID | 模块 | 职责 | 关键约束 | 验收 |
|---|---|---|---|---|
| SUP | Supervisor | 子进程启停、健康检查、崩溃重启、退出清理 | 重启退避；不重复拉起；检查端口而非仅进程存活 | kill 任一子进程 ≤10 s 恢复 |
| PORT | 端口管理 | 自动分配、冲突检测、持久化、上报 GUI | 分配结果落库；重启沿用；冲突顺延并记录 | 占用端口后启动成功且事件可查 |
| LOG | 日志 | 单出口、结构化、轮转、GUI 查看 | 字段固定（ts/level/proc/trace/message）；密钥过滤 | 任一请求可按 trace id 串联 |
| CFG | 配置库 | GUI 读写、schema 校验、迁移、敏感项加密 | 不暴露可手改文件；密钥 DPAPI | 重启后配置一致；明文密钥不落盘 |
| GUI | 托盘与面板 | 状态灯、启停、日志、模型管理、设备配对、世界开关 | 托盘一键启停；状态 1 s 级刷新 | 每个服务可控且状态真实 |
| GW | 网关 | 自签 CA、证书签发、HTTPS/WSS 反代、配对 | 纯字节转发；证书到期前续签；并发上限 | 局域网 HTTPS/WSS 通；证书链校验通过 |
| PKG | 分发 | sidecar 打包、首启解压、安装包、卸载 | onedir 不 onefile；模型分层按需；卸载清数据可选 | 干净 VM 双击可用 |
| MODE | 模式机 | 显示态二态 + 世界档位三值 + 主机可达态；滞回、抢占、持久化 | 状态各自落盘；重启回默认态；非法组合拒绝 | 状态迁移表逐条可测；0 次非法组合 |
| LIFE | 生活流 | 拉取时间线、去重、UTC→本地、落库 | 游标=最大 id；`cycle_id` 唯一；时区固定本地 | 重复拉取 0 重复入库 |
| CTX | 上下文合成 | 被动块 / 主动块、token 预算 | 注入位置固定；块内不给“可以沉默”选项 | 前缀缓存不被打断（未命中量≈块大小） |
| GATE | 打扰闸门 | 决策 speak / inject-only / drop + 决策日志 | 决策在调用 LLM **之前**；规则可配置 | 决策全部落 `gate_log`，可回放 |
| ECHO | 回声 | 主动发言写回下一次被动块；待会面素材 | 不写 OLVT 历史，避免孤儿消息 | 主动后下一轮能自然承接 |
| MEM | 长期记忆 | 写入（会话末批量 + 规则预筛）、检索（三路融合）、摘要下发 | 不每轮调 LLM；索引可重建；正文与索引解耦 | 7 天前事实召回样本达标 |
| WORLD | 世界生产 | 种子→场景、剧情扩写、prompt→背景图；checkpoint | 三步 plan/produce/commit；commit 原子；可中断 | 中断后从 checkpoint 续，不重跑 |
| LEDGER | 预算 | 逐日 token 账本、上限停机 | output 日上限硬顶；超限记事件并停生产 | 超限当次不发起调用 |
| BRIDGE | Agent 桥接 | `list_sessions` / `submit`，适配器注册表 | 本期仅 Stub；未接入时“未知”放行并留痕 | 前端字段稳定，换适配器不改界面 |
| DESK | 桌面接管 | RustDesk 集成与抢占 | 接管强制回总观；主机档必须中止 | 接管期间无生产任务在跑 |
| OLVTP | 上游补丁 | OLVT fork 改动清单与重放 | 仅外围文件；每个补丁有原因与回滚 | 补丁清单可从干净上游一键重放 |
| OBS | 观测 | 状态迁移日志、失败原因、指标打点 | 每次迁移记录 from/to/reason | GUI 可回答“为什么切档” |

## 4. 里程碑与顺序

| ID | 里程碑 | 交付 | 依赖 | 退出门槛 |
|---|---|---|---|---|
| PCM1 | 骨架与托管 | SUP / PORT / LOG / CFG / GUI / OLVTP | — | 托盘能起停 4 个 sidecar，kill 后自愈，日志可查；Electron 45 + electron-builder 26 的空壳安装包在本机装/卸通过 |
| PCM2 | 单包分发 | PKG | PCM1 | 干净 VM 双击可用，卸载干净 |
| PCM3 | 网关与配对 | GW | PCM1 | 局域网 HTTPS/WSS 通，设备免配置连上 |
| PCM4 | 编排骨架 | MODE / LIFE / CTX / GATE / ECHO / OBS | PCM1 | 被动注入可见效果；状态契约冻结 |
| PCM5 | 记忆 | MEM | PCM4 | 召回样本达标；索引可删可重建 |
| PCM6 | 世界主机档 | WORLD / LEDGER | PCM4 | 显存释放达标；预算护栏生效；中断可续 |
| PCM7 | 桥接与接管 | BRIDGE / DESK | PCM4 | Stub 契约稳定；接管零冲突 |
| PCM8 | 硬化 | SUP / OBS 收口 | 全部 | 72 h 长稳、冷启动、断网恢复达标 |

> 进展（2026-11-16，遗忘曲线）：记忆不再是只增不减——`R=exp(-Δ天/S)`，S 按层初值 L0/L1/L2 = 120/14/3 天，召回一次 ×1.6（间隔重复）并刷新最后接触；`R<5%` 判遗忘、退出检索（L0 永不自动遗忘），遗忘行 30 天后物理删除、被取代行 180 天后删除，启动时自动结算一次。`/dhvw/memory/curve` 给出最弱记忆与参数、`/dhvw/memory/forget` 可预览/执行；信息页卡片显示活跃/已遗忘/已取代/平均留存，并可展开最弱记忆。实测（隔离数据目录）：3 天龄 L2 保持率 0.368、200 天龄被判遗忘且检索不再命中、L0 400 天龄被保护、复习后复活、召回后 S 3.0→4.8 且 recalls=1、超期遗忘行删除后 `fts==meta`；真库 113 条时卡片显示活跃 65 / 已取代 48 / 平均留存 0.58；六档布局无溢出；`test:dhvw` 39 项通过。
>
> 进展（2026-11-16，记忆向量）：模块早已接通（`embedder.py` 本地 ONNX 编码器 + `mem_vec` sqlite-vec 虚表，随包 `bge-small-zh-v1.5`），本轮把它变成可见的一等服务：`/dhvw/memory/stats` 增模型/维度/目录/依赖版本/DB 大小，信息页新增「记忆向量」卡片（状态、条数、依赖、打开模型目录、重建索引、安装缺失依赖 + 重启编排器），并声明 `resources/memory-requirements.txt`（onnxruntime/tokenizers/numpy/sqlite-vec）修复新装环境的隐式依赖。实测：卡片显示 89/89/89 与四个依赖版本；重建索引 4 s 返回 `正文 89 · 全文 89 · 向量 89`；停编排器 → 「编排器未运行 · fetch failed」，启动后恢复；`test:dhvw` 36 项在隔离实例全通过（含新增统计断言）。
>
> 进展（2026-11-15，设置页路径选择）：设置里所有路径项加系统选择框（GPT-SoVITS 目录走 `openDirectory`、参考音色走 `openFile` + 音频筛选），Live2D 模型可「打开模型文件夹」（用户库 `%APPDATA%/DigitalHuman/live2d-models`）与「从文件夹导入」（校验 `<模型>/runtime/*.model3.json`、文件夹名转模型 id、同名拒绝、只写数据目录）。实测：选择框弹出标题正确、取消返回 `{ok:false}`；导入逻辑单测覆盖单模型/父目录批量/同名冲突；用户库在启动时自动创建并进入模型库搜索顺序；设置页六档无横向溢出。
>
> 进展（2026-11-15，地图推送）：产出验收新增「提交 ARM 侧」，设置新增「自动推送生成的地图」（默认关）。推送前做资源核验（必需文件 + manifest 的 size/sha256），通过才发 `scene:ready{sceneId,basePath,…}`；投递成功记 `kv.scene_pushes.pushed`，离线记 `pending`，设备 `hello`/每 15 s 重推直到成功。实测：无设备手动推送 → 409 排队；假设备经网关 wss 上线后收到 `scene:ready`，按设备方式（`/orchestrator` 前缀 + token）拉回 manifest 与 8/8 文件且 sha256 全部吻合，状态转 `pushed`；`autoPush` 开关经设置→编排器往返生效；`test:dhvw` 34 项通过；三页六档布局无溢出。未实测：真实固件侧的 Cache Storage 落盘（PC 侧只保证可拉取）。
>
> 进展（2026-11-15，可换 Live2D 模型）：设置新增「Live2D 模型」，模型库 = 随包 `resources/live2d/models`（mao_pro、shizuku，+5.1 MB）∪ OLVT 组件 `live2d-models`；选中后本机舞台按 `/model/<id>/…` 重载，模型文件与 `model_dict.json` 条目同步进 OLVT，`conf.yaml` 的 `live2d_model_name` 改写并重启 OLVT。实测：mao_pro↔shizuku 往返切换，舞台与 OLVT 日志均为 `Initializing Live2D: <id>`；非法 id 保存返回明确错误；六档布局审计全绿。
>
> 进展（2026-11-13，设备场景请求闭环）：`world:digest` 里的 `sceneRequests`（`pending` + `mapSpec`）现在由编排器自动受理成场景作业，账本落 `kv.scene_requests` 做幂等（设备每 5 s 重发不重复生成），通过闸门后发 `scene:ready {id}`，`id` 用设备请求 id；失败不自动重试，`POST /dhvw/scene/retry {id}` 手动重提。`GET /dhvw/scenes` 增 `requests` 账本；`pc:action` 的 `map.generate` 从「未接线」改为转场景作业。实测：缺 `mapSpec` 的请求只受理一次并显式失败；`/dhvw/scene/retry` 能重提被中断的请求；编排器重启时账本与作业一起翻成 failed（不再显示「生成中」）。
>
> 进展（2026-11-13，舞台改自建 Live2D）：首页舞台不再嵌 OLVT 页面，改为自建页面 + 本地静态服务（pixi6 + pixi-live2d-display + cubism4 core + `mao_pro` 模型，随包 9.7 MB），角色常驻显示、idle 循环、鼠标跟随；页面骨架实测加载成功（1020/640 截图确认）。总观/显现改为设备侧二切：新增 `POST /dhvw/display` → `display:set`，以 `digest.world.display` 为唯一确认，6 s 未变化提示「设备未确认」，无设备时报「设备未连接」（假设备回环实测确认路径）。六档布局审计全绿； 扩到 29 项（新增 display:set 投递/载荷/非法态三条），直连与  均通过。
>
> 进展（2026-11-13，三页 + 场景作业）：GUI 重组为「首页 / Agent / 配置」——首页舞台支持 `总观 / 显现` 二切（显现为 OLVT iframe 的 Live2D，未就绪给明确文案）、世界模式增强开关（界面态 + 落 `config.db`，尚无生产行为）、ARM 状态机统计表（`GET /dhvw/stats`：device/digest 计数、档位迁移、近 24 h 事件、记忆、uptime）；配置页保留原全部面板。地图生成接入 **pi CLI + `MAP-SCENE-DESIGN` skill**：`POST /dhvw/scene` / `GET /dhvw/scenes`、`map.generate` 同源，输出 `data/scenes/<id>/` 场景包并以复跑 `validate_scene.py` 为唯一闸门，通过后发 `scene:ready`。实测三张场景包（8×7 书房、20×6 街道、4×4 单间）全部过闸，单任务 3–4 分钟。六档布局审计通过；`test:dhvw` 扩到 26 项（直连与 `--wss` 均通过）。未完成：embedding（`semantic=false`）、`sceneRequests` 队列消费（设备侧触发链路）、场景工具链的发行期分发策略。
>
> 进展（2026-11-13）：编排器以 Python 服务落地（`services/orchestrator/dhvw_orchestrator`），设备 `/dhvw` 通道、事件幂等、摘要/心情落盘、事实与记忆检索、显现闸门、动作白名单、`state:overview` 全部实测（`npm run test:dhvw`，直连与网关 `--wss` 各 18 项通过）；外壳托管 + 端口 8877 + 网关 `/ws/orchestrator` 已通。`memory:facts` 回流已实现（PC 写事实 → 增量下发 → ack 推进游标，未 ack 不重复下发）。GUI 新增只读「世界」卡片（档位 / 世界时刻 / 时段 / 显示 / 日程 / 待生成场景 / 心情条 / 记忆条数，2 s 刷新，六档布局审计通过）。未完成：embedding（`semantic=false`）、`sceneRequests`/`scene:ready`、`map.generate` 管线。
>
> 进展（2026-11-12）：PCM1 已实测通过；PCM2 完成内置 CPython 3.12 运行时与镜像拉取；`config.sidecars` 可用真实进程替换占位 sidecar——`waketrace`（HTTP 探针 1.3 s）与 `tts`（GPT-SoVITS，TCP 探针 9.2 s）均已实测就绪；全局设置（端点/模型/密钥/端口/角色/ASR）在 GUI 落地，密钥 DPAPI 加密；OLVT 改为组件下载（不随包），启动前由主进程按设置生成 `conf.yaml` 并以真实进程拉起——内置 CPython 3.12.10 + 精简依赖（349 MB，无 torch）实测起到 `Uvicorn startup complete`（TCP 14.9 s）；安装包 137.3 MB（内嵌 aria2c 后 139.4 MB），`runtime/site-packages` 不随包。剩余：语音链路端到端（麦克风→ASR→LLM→TTS 首字延迟）、PCM3 网关。；语音链路已端到端跑通：`POST /asr` 识别 TTS 产出的 4.8 s 音频 0.13 s，`text-input` 一回合拿到分句音频（首段 3.2–19.3 s，差值在 LLM 首字），TTS 后端目录进 GUI 设置。；PCM3 网关已落地：自签 CA + SAN 主机证书、6 位一次性配对码换 token、HTTPS/WSS 反代（`/ws/olvt` 走完一回合），证书链与局域网 IP 均实测通过。；组件下载换成随包 `tools/aria2c.exe`（多连接/多镜像/重试，ADR-PC-024），缺 exe 自动回退 `fetch`；实测 OLVT 21.4 MB 经 `ghfast.top` 78 s、38 次进度回调，chunked 镜像（`gh-proxy.com`）无总量时 UI 走不确定进度条；两个镜像均不支持 `Range`，续传仅在支持分段的源上生效。

**顺序理由**

- PCM1 是所有分支前置：没有托管与日志，后续一切问题都只能靠猜。
- PCM4 的**被动注入先于主动**：零打扰风险，且不依赖主动通道的任何未验证环节。
- PCM6 排在有记忆之后：世界生产的剧情需要生活素材，记忆提供上下文；且它依赖 TTS 让显存这条先被 PCM1/PCM4 验证。
- PCM2/PCM3 可在 PCM4 并行，但它们都要求 PCM1 的托管接口已稳定。

**每个里程碑的硬规矩**：先冻结对外契约，再写实现；新增状态字段必须同批更新本文档第 5 节与 GUI。

## 5. 对外契约（草案 v0）

> 状态：**草案**，PCM4 冻结。冻结后任何变更必须同时改本文档与消费方，不允许“先实现后补文档”。
> 绑定策略：能力面（设备可达）绑局域网；管理面（配置、记忆、桥接、世界控制）只绑 `127.0.0.1`。

### 5.1 orchestrator · `:8877`（v1，与设备 `arm/docs/CONTRACTS.md` 对齐）

消息信封与消息表**以设备侧契约为准**（`arm/docs/CONTRACTS.md` §2–§3），本节只记 PC 侧已落地的实现。

| 方法 | 路径 | 绑定 | 说明 |
|---|---|---|---|
| WS | `/dhvw` | 局域网（网关 `/ws/orchestrator`） | 设备通道：信封 `{v,id,type,ts,payload,replyTo?}`，`v!=1` 回 `bad_version`，未知 `type` 回 `bad_type` |
| GET | `/health` | 局域网 | `{ok,service,version,pid,uptime,device:{connected,id,tier},digest_ts,memory}` |
| GET | `/dhvw/digest` | 127.0.0.1 | 最近一次 `world:digest` 原文；`digest_ts` 同时落 `data/digest.json` |
| GET | `/dhvw/mood` | 127.0.0.1 | 最近一次 `mood:state` |
| GET | `/dhvw/memory/stats` | 127.0.0.1 | 记忆向量服务信息：条数、`semantic`、模型/维度/目录、依赖版本、DB 路径与大小 |
| POST | `/dhvw/memory/rebuild` | 127.0.0.1 | 由 `mem_meta` 正文重建 FTS5 与 `vec0` 向量索引 |
| GET | `/dhvw/memory/context` | 127.0.0.1 | 供 OLVT 取相关记忆 + 近况（`q,k`，命中会强化稳定性） |
| GET | `/dhvw/memory/curve` | 127.0.0.1 | 保持率最低的活跃记忆 + 曲线参数（`k`） |
| POST | `/dhvw/memory/forget` | 127.0.0.1 | 遗忘结算：低于阈值的标 `forgotten_at`，超期行连同 FTS/vec 物理删除（`dry_run=true` 只报数） |
| GET | `/dhvw/scenes` | 127.0.0.1 | 场景任务表 + 设备 `sceneRequests` 账本 + 产出表（`outputs[{id,name,push{state,attempts,lastError}}]`）+ `autoPush` |
| POST | `/dhvw/scenes/<id>/push` | 127.0.0.1 | 核验并推送一条产出（`scene:ready`）；核验失败 400，设备离线 409 且排队重试 |
| GET | `/dhvw/scenes/<id>/dist/<path>` | 127.0.0.1 | 产出文件直出（设备缓存场景包用） |
| DELETE | `/dhvw/scenes/<id>` | 127.0.0.1 | 删除产出目录与任务记录（运行中 409） |
| POST | `/dhvw/scene/job-retry` | 127.0.0.1 | 在原工作目录续画失败/超时的任务 |
| POST | `/dhvw/scene` | 127.0.0.1 | 直接提交一个场景作业 `{kind,name,seed,distance,note}` |
| POST | `/dhvw/scene/retry` | 127.0.0.1 | `{id}` 重提一条设备场景请求（按当前摘要的 `mapSpec`） |
| POST | `/dhvw/display` | 127.0.0.1 | 设备显示态二切，广播 `display:set {state,t_server}`，返回 `{delivered}` |
| GET | `/dhvw/events?limit=` | 127.0.0.1 | 最近事件（按插入倒序），验收与 GUI 用 |
| GET | `/dhvw/actions` | 127.0.0.1 | 动作执行记录（`pc:action` 的 ok/reason/耗时） |
| POST | `/dhvw/facts` | 127.0.0.1 | PC 侧写入事实（`src=pc`），随即按增量回流设备；返回 `{ok,accepted,merged,rejected,pushed}` |
| POST | `/dhvw/config` | 127.0.0.1 | 外壳回环下发 `{tts,live2d,llm:{baseUrl,model,apiKey}}`；`llm` 变更即时以 `llm:config` 推给设备 |

设备侧上行（服务端处理）：

- `hello` → 回 `hello`（带 `t_server` 校时）；连上即主动发 `digest:get`、`mood:get`，有 LLM 配置时补 `llm:config`。
- `heartbeat` → 更新在线与 `tier`；>60 s 无心跳判离线并回 `tier: idle`。
- `events:batch` → 按 `uuid` 幂等入库（`life.db` 的 `events`），回 `events:ack{seq,inserted,duplicated}`；重复批次不重复入库。
- `world:digest` → 原子写 `data/digest.json` 并留最近一份内存快照；随后消费 `sceneRequests` 里 `status:"pending"` 的条目（同 id 只受理一次，账本落 `kv.scene_requests`），生成通过闸门后回 `scene:ready {id}`（id 即请求 id）。
- `mood:state` → 落库并留快照。
- `facts:candidates` / `memory:push` → `memory.db`（`mem_meta` + `mem_fts` + `mem_vec`），中文按二元组建全文索引、`bge-small-zh-v1.5`（512 维）建向量，同文本 LWW 合并，回 `facts:ack{accepted,merged,rejected}`；`semantic` 按模型与依赖实际状态给值。
- `memory:query` → `memory:result{req_id,hits,semantic}`（`0.5×向量 + 0.3×全文 + 0.2×时间衰减`），`req_id` 原样带回。
- `pc:action` → 白名单 `web.open` / `media.play` / `app.open` / `map.generate`（后者转场景作业，受理即回 `{job,dir}`）；`notify` 未接线，回 `ok:false` + 中文原因。
- `present:request` → `present:grant` / `present:deny{reason}`（`tts_ready=false` 时拒绝）。
- `present:begin` / `present:end` → 切 `tier` 为 `host` / `idle`。

设备侧下行（服务端主动）：`hello`、`digest:get`、`mood:get`、`llm:config`、`tier`、`memory:facts`（增量，游标存 `kv.facts_since`，设备 `facts:ack` 后才推进）、`state:overview`（每 5 s，含 `clock{day,minute,phase}` 与 `work_tier`）、`display:set`（显示态二切）、`scene:ready`（`{sceneId,job,basePath,manifestUrl,name,kind,distance?,files}`；离线排队，设备上线后重试直到投递成功）。

### 5.2 OLVT 内部端点（本仓库补丁）

| 方法 | 路径 | 绑定 | 说明 |
|---|---|---|---|
| POST | `/dhvw/proactive` | 127.0.0.1 | `{text, client_uid?}`；缺省投递到唯一在线连接；有活跃对话时拒绝 |

### 5.3 与设备侧的边界

- PC 不提供页面、不推 Live2D 资源、不承担渲染。
- 设备不可达时的行为由 PC 决定并**显式返回原因**（`reason` 枚举），设备只负责展示。
- 契约演进：新增字段只增不改；删除字段必须先双写一个版本。

## 6. 数据与存储

全部位于 `%APPDATA%/DigitalHuman/`，路径不含中文与空格。

| 文件 | 表 | 用途 |
|---|---|---|
| `data/config.db` | `kv` / `services` / `ports` / `secrets` | 配置、端口分配、加密后的密钥 |
| `data/life.db` | `events` / `gate_log` / `echo` | 生活事件（`cycle_id` 唯一）、闸门决策、回声 |
| `data/memory.db` | `mem_meta` / `mem_vec` / `mem_fts` | 记忆正文、向量索引、全文索引；索引可删可重建 |
| `data/token.db` | `daily` / `calls` | 逐日预算与逐次调用记录 |
| `scenes/` `plots/` `backgrounds/` | — | 世界产物 + `manifest.json`（种子、prompt、时间、版本） |
| `logs/` | — | 结构化日志，按天轮转 |

**写盘纪律**

- 产物走 `plan → produce → commit`，commit 为原子改名。
- 只写白名单目录：`scenes/`、`backgrounds/`、`plots/`。
- 数据库 WAL 限大小，避免长稳期无限增长。

## 7. 失败与降级（PC 侧）

| 故障 | 表现 | 处理 |
|---|---|---|
| 子进程崩溃 | 端口消失 | Supervisor 指数退避重启，≤10 s 恢复；连续 3 次失败上报 GUI |
| TTS 显存不足 | 502 / 空音频 | 自动拉起 TTS；8 s 未就绪 → 文字模式 + 明确提示，不静默失败 |
| LLM 超时/不可用 | 无回复 | 不重试；返回明确错误码；主动轮当日停用 |
| WakeTrace 掉线 | 无新事件 | fail-open：对话不受影响；>6 h 无事件则不主动 |
| 设备离线 | 无连接 | 不消耗 LLM；事件标记待会面 |
| 显存未回落 | 无法开工 | 轮询到余量达标才开工；5 min 超时放弃本轮，不硬上 |
| 世界生产失败 | 无新产物 | 保留旧产物；不重试；记失败原因 |
| 预算超限 | — | 当次不发起调用，记事件，停生产至次日 |
| 配置损坏 | 启动失败 | 迁移失败即回滚到上个快照并提示；不静默重置 |
| 端口被占 | 启动失败 | 顺延分配并记事件；GUI 显示实际端口 |
| 外壳被杀 | 全部服务残留 | 宿主用 `OpenProcess`+`WaitForSingleObject` 盯外壳 PID，同时把自身与 worker 放进 `KILL_ON_JOB_CLOSE` 作业对象：外壳消失后 ≤1 s 整树由 Windows 回收；下次启动按 pid+创建时间清残留 |

## 8. 验收（PC 侧，可测）

| 编号 | 指标 | 目标 | 测量 |
|---|---|---|---|
| PC-A1 | 单包安装 | 干净 Windows VM，双击完成，零命令行 | 人工 + 录屏 |
| PC-A2 | 冷启动到可对话 | <60 s | 打点：进程起 → 首个健康检查通过 |
| PC-A3 | 首响延迟（PC 侧） | 收到用户输入 → 首帧音频 payload <2.5 s（局域网） | 服务端打点 20 次取 P95 |
| PC-A4 | 自恢复 | kill 任一子进程 ≤10 s 恢复 | 自动化脚本 |
| PC-A5 | 断网恢复 | <30 s 自动重连 | 拔网线再插回 |
| PC-A6 | 显存释放 | 进入主机档前余量 ≥4 GB | `nvidia-smi` 轮询记录 |
| PC-A7 | 预算 | 世界 output ≤8k/日；超限停机；抢占零失败 | 账本 + 状态日志 |
| PC-A8 | 记忆召回 | 10 条“7 天前事实”样本 ≥9 条命中且排序正确 | 人工评审 |
| PC-A9 | 长稳 | 72 h 连续运行无崩溃、无内存单调增长 | 自动化对话 + 进程指标 |
| PC-A10 | 可追溯 | 任一请求可由 trace id 串起全链路日志 | 抽查 10 条 |

## 9. 开放问题

按是否阻塞排。

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| Q1 | LLM 供应商与模型范围 | 影响 PCM4 对话链路 | **已解除**。端点 `https://codex.mintcat.work` 实测可用：`/v1/models` 200（1.05 s），非流式对话 200（2.04 s），流式首字 1.98–4.61 s（2 次采样，`reasoning_effort: none`）。两个坑：① 请求必须带浏览器 UA，否则 403；② 不开 `reasoning_effort: none` 时只吐 `reasoning_content`，正文可能为空。残留风险：首字波动 2–4.6 s 未稳定达标 PC-A3（2.5 s），PCM4 须用固定采样口径复测。**模型只能 DeepSeek 系，禁止 gpt-6 及任何高价模型（ADR-PC-016）** |
| Q2 | sidecar 打包方案：嵌入式 Python vs PyInstaller onedir | PCM2 体积与冷启动 | **方向已定**：嵌入式 CPython 3.12 + 单一 site-packages + 瘦启动器，OLVT 不做 PyInstaller；PCM1 用真实依赖验证体积与启动 |
| Q3 | GUI 前端技术栈 | PCM1 起全部界面 | **已定**：React + Vite + TypeScript（见 ADR-PC-013） |
| Q4 | 密钥存储 | CFG 实现 | **已定**：Electron `safeStorage` 异步 API（Windows 走 DPAPI），不落明文文件 |
| Q5 | 空闲判定与负载采样口径 | PCM6 与门 | **实现已定**：`powerMonitor.getSystemIdleTime()` + `getSystemIdleState()`；采样窗口与阈值待 PCM6 实测校准 |
| Q6 | AgentBridge 真实平台未定 | 只交 Stub，不阻塞 | 后续 |
| Q7 | RustDesk：内嵌二进制 vs 引导安装 | PCM7 | 待定 |
| Q8 | 记忆 embedding 模型分发：随包预置 vs 离线导入 | PCM5 首启可用性 | 待定，**不得依赖运行时联网下载** |
| Q9 | 世界产物是否需要“只看主机资产”开关的 GUI 入口 | 与设备侧资产消费对齐 | 待定 |
| Q10 | 设备侧契约消费方并行开发，冻结时间需协同 | PCM4 冻结节点 | 待确认 |

## 10. 不做（防止范围蔓延）

- 不做设备端任何代码：kiosk、本地壳、资源包、端侧 Worker、地图渲染。
- 不做美术：地图设计、角色精灵、Live2D 模型制作。
- 不做本地 LLM、不做 Docker、不引入常驻外部数据库。
- 不做公网暴露、账号体系、多租户、计费。
- 不为“未来可能商用”做防御式选型（非商用开源定位）。
- 不在上游仓库目录内直接改代码：改动只以补丁清单形式存在并可重放。

## 11. 记忆与向量待办（TODO）

- [x] **显现会话 → 事实抽取回写闭环**：在 `present:end` 或每 8–10 轮对话后，抽取 `L0/L1/L2` 事实调用 `POST /dhvw/facts` 落入 `memory.db`，并经 `memory:facts` 回流到 ARM 设备深层记忆（`localMemory`）。
- [x] **检索相关性阈值与 L0 常驻**：对 `search_hybrid` 低于阈值（如 `score < 0.35`）的结果过滤，避免“你好/嗯嗯”等闲聊硬塞无关记忆；单独保留 `L0` 核心偏好/禁忌常驻摘要（并修复 ARM 侧 `deepMemoryText()` 排序未包含 `L0` 的问题）。
- [x] **短口语指代改写**：OLVT 调用 `/dhvw/memory/context` 时拼接最近 1 轮上下文（≤120 字）作为查询 `q`，提升“那个/上次说的”等指代召回。
- [x] **模型随包分发**：将量化版 `bge-small-zh-v1.5`（约 24.5 MB）同步进 `PC/apps/shell/resources/models/bge-small-zh-v1.5` 并写入 `electron-builder.yml` `extraResources`（含 `fetch-embed-model.mjs` 打包前自动补齐）。
- [ ] **可优化与新增模式探索**：
  - [x] **事实更新/覆盖（`supersedes`）语义化**：新事实与旧事实余弦相似度高且发生偏好变化时（如“喜欢夏天 → 改口喜欢秋天”），标记旧事实为 superseded，检索时降权/过滤，避免新旧记忆打架。
  - [x] **事件流批量离线归纳**：利用主机空闲期对 `life.db` 中未归纳的设备事件批处理抽取事实（`POST /dhvw/memory/consolidate` + `events_consolidated_seq` 游标），减少设备端 LLM 预算消耗。
  - [x] **情绪-记忆共鸣加权（Mood-Congruent Recall）**：检索打分结合当前 `mood:state`（如低能量/低落时优先召回 L0/温暖主题记忆，高社交欲时优先召回共同约定），增强角色临场感。
  - [x] **周期日记/周记与星期观念（周一—周日）**：ARM/PC 双端 `clock` 同步 `weekday`（1–7）与 `weekdayName`（周一–周日）；ARM 保留晚间随机日记/小说触发，新增每周日 20:00–22:00 固定周记总结触发，日记/周记写完自动摘要写入深层记忆 `localMemory` 并同步 PC。

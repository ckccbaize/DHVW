# 设备端开发项清单（v0.2 草案 · 待讨论）

> 状态：**待评审**。v0.2 按「先核心机、后视图」重排：上一版把 UI/渲染放在前面，与"24/7 生命仓 + 与 PC 同步"的实际依赖相反。
> 相关：`docs/WORLD-CORE-RESEARCH.md`（选型调研）、`docs/DEVICE-DESIGN.md`（设备侧总设计）。
> 原则：**一项一验收一提交**；上一项不过不写下一项；跨进程先定契约；先本机后真机。

---

## 0. 现状与处置

| 现有代码 | 判定 |
|---|---|
| `shell/*`、`js/core/*`（grid/pathagent/clock/ringbuffer/assetstore/lifestore/light）、`tools/*`、`deploy/*`、`tests/*` | 保留（纯函数/行为已验） |
| `js/app.js`、`js/view/overview.js`、`js/runtime/local.js`、`workers/life.worker.js`、`workers/forge.worker.js` | **参考实现**：打 tag `spike-v0`，按 W/L 组重写，能搬的搬 |
| `js/view/present.js` `hud.js` `switch.js` | 结构留，等 S 组统一样式 |

**当前阶段目标（唯一）**：把**世界核心机**做对、做小、做可恢复。视图只保留"能看见状态"的最小壳。

---

## 0.2 职责边界（2026-11-12 需求方口径）

**交互设计属于产出侧；ARM 仓库只做设备软件与产出工具，不改美术资源、不设计玩法。** 详见 `docs/CONTENT-CONTRACT.md`。

| 事项 | 产出侧 | 设备侧 |
|---|---|---|
| 户型/家具/碰撞（`intGrid`） | 定义 | 只读 |
| 交互（`interactions.json`） | 定义 | 执行 |
| 角色图集与动作 | 出图 + 帧表 | 播放 |
| 门通向哪 | 定义 | 执行 |
| 场景/资源校验工具 | 使用 | 提供 |
| 端侧生成（剧情/背景/地图变体） | 给规格 | 实现与调度 |

> 因此 W32–W35（碰撞写入、交互设计、精灵绘制、门/场景设计）**不在本仓库**，见 §9.2 产出侧 backlog。
> 唯一需要改的设备侧代码：`core/grid.js` 的 `PROP_ACT` 硬编码 → 改为读 `interactions.json`（缺省兜底并标 deprecated）。

## 1. A 组 · 基线与契约

| ID | 开发项 | 产出 | 验收 | 依赖 |
|---|---|---|---|---|
| A1 | 冻结参考实现 | `spike-v0` tag | tag 存在 | — |
| A2 | **核心机边界与预算冻结** | `docs/WORLD-CORE-SPEC.md`：模块边界、消息表、内存/CPU 预算、失败策略 | 文档评审通过 | 调研 D1–D10 定稿 |
| A3 | 跨进程契约 v0 | `docs/CONTRACTS.md`：主线程↔core、core↔子 Worker、设备↔PC | 三张消息表字段/方向/频率齐全 | A2 | **已有** |
| A4 | 模块职责表 | `DEVICE-DESIGN.md` 补"每个文件一句话职责" | 无重复职责、无空壳模块 | A2 |
| A5 | 验收模板 | `docs/ACCEPTANCE.md`：每项的"可观察结果 + 打点" | 后续提交都带证据段 | — |
| A6 | 资源包与版本规则 | 目录 + `manifest.json` 版本号 | 改资源必须重打包且 verify 通过 | — |

## 2. B 组 · 离线壳（承载，最小可用）

| ID | 开发项 | 产出 | 验收 | 依赖 |
|---|---|---|---|---|
| B1 | 静态服务最小实现 | `shell/main.go`：GET/HEAD + MIME + 无目录列表 | curl 200/404 | — |
| B2 | 缓存与 ETag | 304 + `no-cache`/`immutable` 分流 | curl 304 与响应头 | B1 |
| B3 | 路径安全 | 拒绝越界/编码绕过 | 3 种越界请求 404 | B1 |
| B4 | 资源包校验 + `/__health` | 启动校验 + JSON 健康 | 删文件后 `ok:false` 并列出 | B2 |
| B5 | 回环限制与优雅退出 | 只监听 127.0.0.1；SIGTERM 干净退出 | 非回环报错；kill 后端口释放 | B1 |
| B6 | 交叉编译 | arm64/armv7 产物 + 体积记录 | 产物可执行（真机或 qemu） | B5 |

## 3. W 组 · 世界核心机（本阶段主体）

> 目标：一个能 24/7 跑、状态可持久化、任务可恢复、预算可封顶的调度核心。**不含 UI**。

| ID | 开发项 | 产出 | 验收 | 依赖 |
|---|---|---|---|---|
| W1 | core.worker 骨架与消息总线 | `core/worker.js`、`core/bus.js`、`core/client.js`：init/state/event/health/reply | 主线程发 `input` 能收到 `state` 回包 | A3 | **已有**（8 项测试 + `debug-core.html` 实测） |
| W2 | 状态机 spike（XState vs 纯 reducer） | `spikes/fsm/`：同一状态图两种实现 + 快照恢复 + 报告 | **已定：纯 reducer**（等价 6/6；XState 需 vendor 41.5KB gzip；快照 62B vs 183B） | A2 | **已有** |
| W3 | 世界状态机 | `core/machine/world.js`：显示态 × 主机可达 × 档位（§10.1 矩阵）+ 迁移日志/计数 | 非法组合 0 次；迁移日志逐条可复现 | W2 | **已有**（9 项测试 + 浏览器实测） |
| W4 | 生活状态机 | `core/machine/life.js`：作息 7 段 → 房间/动作 + 心情四维/五档 + 打分选点 | 拨时间可见行为变化 | W3 | **已有**（12 项测试 + 浏览器实测） |
| W5 | 事件日志 | `core/log/`：append-only + `seq` + 环形 2000 + IndexedDB 持久化 + uuid 幂等 | 写 2001 条剩 2000；重启后 `seq` 连续 | W1 | **已有**（9 项测试 + 浏览器重载实测） |
| W6 | 快照与恢复 | `core/snapshot.js`：world/life/lastSeq 落 IndexedDB kv；2s 防抖 + 30s 定期 | kill Worker 后 ≤2s 恢复且不重复处理 | W3, W5 | **已有**（7 项测试 + 浏览器重载实测） |
| W7 | 记忆查询（本地） | `core/memory/`：自研 bigram 倒排 + 时间衰减 + IndexedDB 持久化（不引 MiniSearch） | 5000 条摘要 ≤10MB、查询 ≤20ms | W5 | **已有**（7 项测试 + 浏览器重载实测） |
| W8 | 记忆查询（PC 代理） | `core/memory/remote.js`：`memory:query` 请求 + `req_id` 关联 + 200ms 超时 + 本地降级 | 主机不可达时 200ms 内降级到本地 | W7, W9 | **已有**（5 项测试 + 假 PC 联调） |
| W9 | 主机可达与同步通道 | `core/host.js` + `runtime/remote.js`：心跳 5s、60s 判死、hello 校时、present:begin/end、events:batch | 假主机单测 + `tools/fake-pc.mjs` 联调 | W1 | **已有**（6 项测试 + 真实 WS 联调） |
| W10 | 调度器 | `core/sched/scheduler.js`：优先级、切片 ≤5s、让位、持久队列；只调度生成/归纳任务 | 活跃期生成排队不跑；present 全停；挂起保留队列；重启恢复 queued | W5 | **已有**（8 项测试 + 浏览器实测） |
| W11b | **本地 LLM 代理**（CORS 对策） | `shell` 新增 `POST /__llm/chat/completions`：仅回环、转发 baseUrl、限体积/超时、不落 key | 页面经本地代理可调外部 LLM；无 CORS 错误 | W11, B4 | **已有**（3 项 Go 测试 + 假 LLM 联调） |
| W11 | LLM 客户端与服务商配置 | `core/llm/client.js` + `provider.js`：OpenAI 兼容、超时/中止、瞬时错误重试 ≤2、PC 可下发 `llm:config` | 429/500 重试成功；401 不重试；配置落库即生效 | W10 | **已有**（12 项测试） |
| W12 | Prompt / Skill 注册表 | `agent/skills/<name>/SKILL.md` + `agent/prompts/*.md` → `tools/build-agent.mjs` → `www/agent/registry.json` | 改 prompt 不动代码；清单可校验 | A6 | **已有**（5 项测试 + 浏览器实测） |
| W13 | 管理层 Agent | `core/agent/manager.js`：意图 → 任务分解 → 派发 → schema 校验 → 落库 | 一次意图产出 1–3 个任务，非法输出被丢弃 | W11, W12 | **已有**（8 项测试 + 假 LLM 端到端） |
| W14 | 子 Agent：剧情 | `core/agent/subs/plot.js` + `subs/events.js` | 30–80 字、时间锚点、24h 去重；事件池可定时扩展 | W13 | **已有**（12 项测试 + 端到端实测） |
| W15 | 子 Agent：背景 | `core/agent/subs/bg.js` | 960×540、非单色、体积达标 | W13 | **已有**（搜索/下载/裁切/压缩，实测 60KB） |
| W16 | 子 Agent：地图 | `core/agent/subs/map.js` + `forge/layout.js`（像素绘制待 W31） | 生成合法 intGrid + 可渲染 | W13, W31 | **已有**（布局/intGrid/可达校验；调试页渲染） |
| W17 | 资源治理与 24/7 | `core/governor.js`：内存水位、降频、息屏、看门狗 | 8h 不断档；水位超限按 P4→P3→P2 降级 | W10 | **已有**（分级/闸门/看门狗；8h soak 待设备跑） |
| W18 | 观测 | `core/observe.js`：`state_log` / 任务账本 / `health` / 堆上报 | 一条命令看到状态机+队列+预算+索引 | W17 | **已有**（面板实测；生产页需接 heap_report） |
| W19 | 与 PC 同步 | 事件批、资产清单、记忆结果合并；`world:digest` 统一摘要 | 假 PC 收批、uuid 去重、重复不重复入 | W9, W5 | 摘要已有（`core/digest.js`） |

| W20 | **心情模型**（D3） | `core/mood/`：四维连续值 + 五档 + 更新/衰减规则 | 单测：事件→维度变化；档位切换正确；曲线可导出 | W4 |
| W21 | **唤醒机双档**（D2） | `core/wake/`：PC 档（拉 `/world/timeline`）与设备档（定时+事件+心情阈值）；显现期间 suspend | 假 PC 单测；离线时按闸门产出 thought/bubble/silent | W3, W20 | **已有**（8 项测试 + 面板实测；严格 JSON 待 W26） |
| W22 | **统计与可视化**（D3） | `core/stats/` + `www/debug.html`：状态图 SVG、时间线、心情曲线、队列、预算 | 断网可用；状态迁移 1s 内上图 | W3, W20 |
| W23 | **记忆管线**（D4） | `core/memory/pipeline.js`：预筛→LLM 归纳→事实→向量→索引 | 20 条事件归纳出 5–10 条事实；检索 top1 命中 | W7, W11 |
| W24 | **并发合并协议**（D5） | `core/sync/merge.js`：所有权表 + LWW + tombstone + 幂等 | 双端同改一条：结果确定且可复现 | W5, W9 |
| W25 | **LLM 预算账本（只统计不断闸）** | `core/llm/budget.js`：按 class/kind 记账、软告警、可手动停用 | 统计准确；不自动停止调用 | W11 | **已有**（6 项测试 + 浏览器实测） |

| W26 | **设备档唤醒运行时（完整）** | `core/wake/`：严格 JSON、三结局、`world_event` 租约、`free_window`、线头 ≤5、小作品、工具证据、residue 过期、唤醒锁 | 假模型单测：三结局 + 格式错误判失败；租约过期可重领；线头上限生效 | W21 |
| W27 | **自主活动注册表与计划协议** | `core/actions/registry.js` + `plan.js`：能力白名单、前置校验、时长/预算、留证 | 非法活动被拒；一次计划产出可执行步骤与证据 | W13, W20 |
| W28 | **联网代理 + 全量审计** | `shell` 新增 `GET /__fetch`：AI 决定目标；禁内网/元数据/凭据/POST；≤512KB、8s、≤60 次/时；`net_log` 全量 | 内网地址拒绝；每条抓取有日志；抓回内容按不可信输入处理 | B4, W27 |
| W29 | **地点图与旅行（含跨夜、动态注册表）** | `core/places/`：place graph + 步行时间 + 抽象地点 + 地图产出契约 + `SCENE_ADDED/REMOVED` 原子更新 | 跨夜旅行产生事件与证据；新地图可被消费；删除当前场景时回 home | W27 | 出门意愿已有（`core/life/outing.js`） |
| W32 | **Doctor 自检与自愈**（未来功能） | `core/doctor.js`：周期检测、日志包、LLM 诊断、白名单动作、安全模式 | 注入 5 类故障可检测；动作 100% 在白名单；日志脱敏 | W17, W11 |
| W33 | **心情/行为外部引导与深层管理**（未来） | `core/mood/policy.js`：来源优先级、TTL、限频、episode/baseline、剧情 setpoint | 唤醒/剧情可引导行为且可解释；越权被拒 | W4, W21, W14 |
| W31 | **地图绘制移植**（设备侧自己画） | `forge/painter.js` + `forge/layout.js`：`paint_home.py`/`pick_layout.py` 的 JS 版 + 同源闸门 | 同 spec 与 Python 逐像素一致；设备烘焙 ≤50ms | B4, W27 | `layout.js` 已移植；`painter.js` 待做 |
| W30 | **显现 iframe 宿主**（P1 已定） | `view/present-host.js` + PC 侧 HTTPS/证书要求：iframe 全屏、`allow=microphone;autoplay`、失败回总观 | 显现期间 `health` 连续；麦克风可用；关闭后内存回落 | A2, W9 |

## 3.5 T 组 · 产出工具（"产出工具齐全"清单）

| ID | 工具 | 作用 | 验收 | 状态 |
|---|---|---|---|---|
| T1 | `tools/validate-scene.mjs` | schema + 闸门：尺寸一致、spawn/热点可走、门双向、`act` 有定义、图集引用存在 | 改坏一处 → 退出码 1 并指出文件与格坐标 | **已有**（17 项测试；生产期 Node 工具） |
| — | ~~T1b 浏览器版校验~~ | — | — | **取消**：设备装 Node，校验放构建/部署/启动期；页面只保留生成器 5 条自检 |
| T2 | `tools/intake.mjs` | 产出侧目录 → `www/assets/scenes/<id>/`，生成 manifest，拒绝不合格包 | 不合格包不落盘 | 待做 |
| T3 | `js/view/scene-loader.js` | 加载 + 校验 + 解码，失败回退内置场景 | 缺图不白屏 | 待做 |
| T4 | `js/view/animator.js` | 按 `sheet.json` 播放（方向/动作/帧率） | 4 向 + 5 动作可播 | 待做 |
| T5 | `js/core/interactions.js` | Registry + Resolver + Executor + EffectApplier（见 `INTERACTION-LAYER.md`） | 改 JSON 即改行为；打断/条件不满足有明确结果 | 待做 |
| T6 | `www/debug.html` 场景页 | 碰撞/热点/可达性可视化 | 一眼看出哪格挡路、哪个热点不可达 | 与 W22 合并 |
| T7 | `tools/pack.mjs` / `verify.mjs` | 资源包清单与完整性 | 已通过 | **已有** |

> 工具运行位置与"ARM 侧必须补上什么"见 `docs/AGENT-TOOLKIT.md`：**校验只在产出 agent 中（生成后、打包前）；`install.sh` 只做部署；设备自产地图由生成器自检 5 条**。

## 4. L 组 · 生活引擎（作为 W4 的可视化验收面）

| ID | 开发项 | 产出 | 验收 | 依赖 |
|---|---|---|---|---|
| L1 | 意图 → 移动 | 主线程 `PathAgent` 消费 `intent` | 她自己在屋里走，不重复同一格 | W4 |
| L2 | 短句池 | `life/lines.js`：分桶 + 变量 + 24h 去重 | 连续 100 条无重复、无台词 | W4 |
| L3 | 天气与光照联动 | 日种子 → 天气 → 光罩档位 | 换天时两者同时变 | L2 |
| L4 | 活动度三档 | active/idle/asleep 的 tick 间隔 | 60s 降频、10min 息屏且 tick 不停 | W4 |

## 5. V 组 · 视图层（最小，只表达状态）

| ID | 开发项 | 产出 | 验收 | 依赖 |
|---|---|---|---|---|
| V1 | 场景加载与网格 | `view/scene-loader.js` | 打印 20×15、热点数 | A4 |
| V2 | 地形层合成 + 整数缩放 | `view/renderer.js` | 比例正确、点击落点误差 0 格 | V1 |
| V3 | 角色与行走 | 角色层 + 插值 + 朝向 | 连续走动不瞬移 | V2, L1 |
| V4 | 三种点击分支 | 可行走/不可行走/点角色 | 三种各有可观察结果 | V3 |
| V5 | 光罩层与帧率 | 切档重绘一次；8/30fps | 打点证明只重绘一次 | V2, L3 |
| V6 | HUD 最小版 | 档位/连接/时钟/任务卡 | 状态变化 1s 内可见 | W18 |
| V7 | 显现闸门与拒绝 | 四道闸门 + 气泡 | 20 次点击 20 次拒绝 | W3 |
| V8 | 显现视图最小版 | 背景 + 字幕 + 退出 | 主机可达时进入；90s 退出 | V7 |
| V9 | 滑动开关 | 虚拟两档 + 事件源抽象 | 被拒时回弹 | V7 |

## 6. S 组 · 风格统一（视图稳定后一次落地）

| ID | 开发项 | 产出 | 验收 | 依赖 |
|---|---|---|---|---|
| S1 | 设计令牌 | `css/tokens.css` | 无硬编码色值 | 视觉路线定稿 |
| S2 | 像素缩放规则 | 2× 整数、无亚像素 | 1080p/720p 边缘锐利 | S1 |
| S3 | 字体方案 | 系统 CJK 或打包像素字体 | 中文不糊、体积可接受 | S1 |
| S4 | 气泡规范 | 画布内或 DOM 层 | 三类气泡样式一致 | S1 |
| S5 | HUD 规范 | 角标/连接点/时钟/任务卡 | 不抢画面、状态可辨 | S1 |
| S6 | 开关与菜单 | 触控热区 ≥44px | 状态可辨、无误触 | S1 |
| S7 | 显现层规范 | 背景/立绘/字幕 | 与总观同套字体色板 | S1 |
| S8 | 动效与降帧 | 统一时长/缓动 | 8fps 下无跳变 | S1 |

## 7. D 组 · 部署与硬化

| ID | 开发项 | 验收 |
|---|---|---|
| D1 | systemd（shell/kiosk） | 崩溃重启；`systemctl status` 正常 |
| D2 | kiosk 启动脚本 | 开机进总观，无地址栏 |
| D3 | 禁 suspend + 息屏 | 合盖不休眠；息屏 tick 不停 |
| D4 | 安装与回滚 | 全新镜像一次装好 |
| D5 | 日志与排障 | 一条命令看壳/核心机/Worker |

## 8. J 组 · 验收（真机）

| ID | 开发项 | 验收 |
|---|---|---|
| J1 | **内存基线** | 空白页 / 总观 / 核心机三档 `free -m`，确认 2GB 余量 |
| J2 | A14 总观常显 | 冷启动 ≤8s、24h 无白屏、不建 WebGL |
| J3 | A15 拒绝显现 | 0 次进入、20/20 气泡 |
| J4 | A16 端侧产出 | 24h：剧情≥6/背景≥3/场景≥4、tick P95≤8ms、0 网络（若开 LLM 则按账本核） |
| J5 | 24/7 长稳 | 8h（含 6h 息屏）不断档、无 OOM、事件 0 丢 0 重 |

---

## 9.2 产出侧 backlog（不在本仓库）

| ID | 项 | 说明 |
|---|---|---|
| C1 | 家具写进 `intGrid` | 现家具全为 0，角色可穿床；需产出侧决定哪些挡路，并重跑闸门 |
| C2 | `interactions.json` | 道具 → 动作 → 效果，设备侧只执行 |
| C3 | 角色图集 `sheet.png/json` | 4 向 × N 帧 + 坐/睡/做饭动作 |
| C4 | 多场景与门切换 | `door.to` 目标场景、`anchor` 落点 |
| C5 | 新场景/新户型 | 由产出侧或设备侧 painter（W31）产出 |

## 9. 推荐批次

| 批次 | 内容 | 出口条件 |
|---|---|---|
| 0 | A1–A6（含 D1–D10 决策） | 契约/预算/边界评审通过 |
| 1 | B1–B6 | 壳可独立跑，curl 全绿 |
| 2 | W1–W2 + W30 | 核心机骨架跑通；状态机选型有结论；显现 iframe 宿主可用 |
| 3 | W3–W6 | 状态机 + 事件日志 + 快照恢复 |
| 4 | W7–W9 | 本地记忆 + 主机通道 + 降级 |
| 5 | W10–W13 + W25 | 调度 + LLM 路由/预算 + skill/prompt + 管理层 Agent |
| 6 | W14–W16 | 三个子 Agent（剧情→背景→地图） |
| 7 | W17–W19 + W24 | 24/7 治理 + 并发合并 + 同步 |
| 8 | W20–W23 + L1–L4 | 心情 + 唤醒机 + 统计可视化 + 记忆管线 + 生活可视 |
| 8.5 | W26–W29 + W31 | 设备档唤醒运行时 + 自主活动 + 联网代理 + 地点图 + 地图绘制移植 |
| 8.6 | T1–T6 | 产出工具齐全（校验/收包/加载/动画/交互执行/调试页） |
| 8.7 | W32 | Doctor 自检与自愈（未来功能） |
| 8.8 | W33 | 心情/行为外部引导与深层管理（未来功能） |
| 9 | V1–V9 | 视图最小闭环 + A15 |
| 10 | S1–S8 | 风格统一 |
| 11 | D1–D5 | 设备开机即总观 |
| 12 | J1–J5 | 真机验收 |

---

## 10. 待你拍板（D1–D6 已定，见 `DECISIONS.md` §0.0；以下为剩余）

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| D1 | 核心机形态 | ①浏览器 Worker ②独立进程（Go/Rust+IPC）③PC 侧 | ① |
| D2 | 端侧能否调 LLM | ①默认关，PC 不可达超时才受限直连 ②永远只走 PC ③设备常开 | ① |
| D3 | 状态机 | ①XState ②纯 reducer ③robot3 | ①（W2 做 3 天 spike 定） |
| D4 | 记忆查询 | ①本地倒排 + PC 代理 ②一期本地 embedding ③只走 PC | ① |
| D5 | 同步 | ①append-only + uuid ②CRDT | ① |
| D6 | Agent 层 | ①自研薄层 ②AI SDK ③LangGraph.js | ① |
| D7 | Skill/Prompt | ①文件约定 + 构建期打包 ②运行时 DB ③硬编码 | ① |
| D8 | 子 Agent 顺序 | ①剧情→背景→地图 ②地图优先 | ① |
| D9 | 时间流速 | ①1 秒=1 分 ②真实 1:1 ③可配 | ③ 默认② |
| D10 | spike 代码 | ①打 tag 后逐步替换 ②直接删 | ① |
| D11 | 视觉路线 | ①全像素 UI ②像素场景+克制覆盖层 ③纯现代 UI | ② |
| D12 | 缩放 | ①固定 2× 整数 ②按视口自适应取整 ③拉伸 | ② |
| D13 | 字体 | ①系统 CJK ②打包像素字体 | ① |
| D14 | 气泡 | ①画布内 ②DOM 层 | ② |
| D15 | 验收环境 | ①本机 Chromium ②必须真机 | ①，J 组上真机 |

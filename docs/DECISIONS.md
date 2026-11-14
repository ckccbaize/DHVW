# PC 主机端 · 架构决策记录

> 只记录**影响 PC 端实现**的决策。每条包含：决策、理由、后果。状态为 `已接受` 的条目，改动必须先改本文件再改代码。
> 日期格式 `YYYY-MM-DD`；编号只增不删，废弃标 `已废弃` 并指向替代条目。

---

## ADR-PC-001 单包桌面软件：桌面外壳 + Python sidecar

- **日期**：2026-11-10 · **状态**：**已废弃**（外壳选型被 ADR-PC-013 替代；“单包 + sidecar 托管”的结论保留）
- **决策（历史）**：主进程用 Tauri 2（Rust）承担托盘、进程托管、端口管理、日志、配置与网关；业务能力以 Python sidecar 形式由主进程托管。
- **废弃原因**：2026-11-10 技术栈复评（见 ADR-PC-013）改为 Electron；Rust 工具链、编译回路与 Windows 集成点自写成本不划算。

## ADR-PC-002 上游代码只读引用，改动以补丁清单重放

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：对话后端等上游代码不 fork 成长期分叉，也不在上游目录内直接开发；每处改动记录为“文件 + 原因 + 回滚方式”，可对干净上游一键重放。
- **理由**：上游版本会演进，长期分叉的合并成本不可控；本项目只在对话链路上做少量插桩。
- **后果**：插桩点必须少而稳（注入、主动端点、TTS 请求参数）；升级上游时先跑补丁重放再回归。

## ADR-PC-003 LLM 走云端 OpenAI 兼容 API

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：LLM 统一走云端 API，不在本机部署；请求固定关闭思考（`reasoning_effort=none` 或等价字段），不开 `tools`。
- **理由**：显存需要留给语音合成，本地 LLM 与 TTS 无法稳定并行；思考 token 按输出计费且会显著拉高首字延迟；带工具调用时上游要求回传思考内容，本项目对话链不保存该字段。
- **后果**：断网即失语，PC 侧必须给出明确错误码而非静默失败；供应商切换成本低（改 base_url / model / key 三处）。端点已实测可用；可用模型范围由 ADR-PC-016 限定为 DeepSeek 系。

## ADR-PC-004 上下文注入位置固定：历史之后、本轮输入之前

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：生活流近况块与记忆摘要一律作为独立消息插在对话历史末尾、本轮用户输入之前；**不得**写入 system，也不得插在历史中间。
- **理由**：上游每轮全量重发 system + 历史；前缀缓存对中间插入零容忍，插进 system 中部会让整段历史每轮全量未命中，成本数量级上升。
- **后果**：每轮未命中量约等于“上轮回复 + 注入块 + 本轮输入”，可接受；注入实现必须集中在单一函数内，禁止散落。
- **校验**：接入后对比连续多轮的缓存命中字段，未命中量应与块大小同量级。

## ADR-PC-005 主动开口走进程内端点，不另开 WebSocket

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：主动发言由 orchestrator 调用对话后端的**进程内 HTTP 端点**，复用设备已有的那条连接投递音频；编排器不得自己作为 WS 客户端发起主动轮。
- **理由**：音频只会回到发起该请求的那条连接；编排器另开连接会送给错误的 socket，复用同一标识还会覆盖映射并在断开时误清设备连接。
- **后果**：需要给上游加一个小端点；前端零改动；端点可顺便判断“是否有活跃对话”并降级为文字。

## ADR-PC-006 长期记忆：单文件三索引，正文与索引解耦

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：单个 `memory.db` 承载正文表 + 向量索引 + 全文索引；向量与全文均为可删除、可由正文重建的派生物；融合权重固定为 `0.5×向量 + 0.3×全文 + 0.2×时间衰减`，分层记忆参与加权。
- **理由**：单文件可备份、可审计，无需外部数据库服务；索引重建能力保证换检索实现不丢记忆。
- **后果**：写入必须“先写正文、后写索引”；中文全文检索需专用分词配置，查询前切分；embedding 模型必须随包预置或离线导入，**不得依赖运行时下载**。

## ADR-PC-007 世界生产：模型只出参数，本地确定性生成，预算硬顶

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：场景、背景、剧情一律“模型出种子/prompt → 本地生成产物”；一次受 schema 约束的调用产出多份参数；单次输出上限固定，日 output 总量有账本与硬顶，超限停机至次日。
- **理由**：让模型直接产出完整资产会把 token 消耗放大两个数量级；本地生成可复现、可校验、可中断续跑。
- **后果**：产物必须带 manifest（种子、prompt、时间、版本）以便复现与回滚；失败不重试，避免预算被抖动吃掉；生产按 `plan → produce → commit` 三步，commit 原子。

## ADR-PC-008 配置与密钥落库，密钥不进仓库与日志

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：配置存 SQLite 由 GUI 读写；LLM 等密钥经系统凭据机制加密存储（实现为 Electron `safeStorage` 异步 API）；日志与错误上报做密钥脱敏；上游 yaml 由外壳生成，不纳入版本库。
- **理由**：手改 yaml 与明文密钥是部署期最容易出事的两处；单一配置源也让迁移与回滚可控。
- **后果**：上游启动参数需在启动时注入而非读固定文件；卸载时可选清除密钥；仓库 `.gitignore` 必须覆盖配置文件、证书与密钥。

## ADR-PC-009 端口自动分配并持久化

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：默认端口仅作开发期约定；运行时由外壳分配可用端口并把结果落库，GUI 显示实际端口；网关反代目标随分配结果动态生成。
- **理由**：用户机器上端口冲突不可预测，让用户排查端口违反“零命令行”目标。
- **后果**：所有内部调用必须读分配表，不得写死；设备侧拿到的是“当前主机端口”，因此需要稳定的发现入口（配对时下发）。

## ADR-PC-010 单一日志出口 + trace id

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：所有子进程输出重定向到外壳统一落盘，字段固定（时间、级别、进程、trace id、消息）；关键链路（一轮对话、一次主动、一次生产）携带同一 trace id。
- **理由**：多进程日志散落会让排障退化成猜；状态机类问题只有串联日志才能定位。
- **后果**：子进程必须使用结构化输出而非自由文本；日志轮转与脱敏由外壳统一负责。

## ADR-PC-011 主机档与门、抢占顺序与资源释放

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：进入世界生产需同时满足“输入空闲、负载低、无用户 agent 任务、人工开关允许、显示态非显现”；破坏任一条件立即中止并记原因；抢占优先级为 桌面接管 > 显现 > 世界生产；进入生产前停 TTS 并轮询显存到余量达标才开工，退出时先回 TTS 再交回显存。
- **理由**：生产抢的是同一块 GPU 与用户注意力；“先开工再等显存”必然 OOM，也让抢占失败不可解释。
- **后果**：生产任务必须可中断并写 checkpoint；中止后进入冷却；所有迁移与中止原因写状态日志，GUI 可查。

## ADR-PC-012 文档边界：本仓库自成体系

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：PC 端的一切结论、契约、任务与验收只记在 `PC/docs/`；不跨仓库引用、不依赖外部文档成立。外部材料只作输入，冲突时以本仓库为准并记录差异。
- **理由**：跨仓库依赖会让实现依据随外部文档漂移，且容易把设备端语义误带进 PC 端。
- **后果**：需要时可把外部结论“摘录并改写”入本仓库，但必须给出本条决策编号；不得复制整段跳过核对。

## ADR-PC-013 Electron 45 外壳 + React/Vite/TS（替代 ADR-PC-001 的外壳选型）

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：桌面外壳用 Electron 45.x（锁定当前 45.2.3），主进程与预加载脚本用 TypeScript，界面用 React + Vite + TypeScript；安装包用 electron-builder 26.x 出 NSIS。Python sidecar 形态不变，由外壳托管。
- **理由**：
  1. 五个高风险 Windows 集成点全部内置：`powerMonitor.getSystemIdleTime()/getSystemIdleState()`（空闲判定）、`safeStorage`（Windows 走 DPAPI）、`app.requestSingleInstanceLock()`、`app.setLoginItemSettings()`、`Tray`。
  2. 本机已有 Node 24，不需引入 Rust 工具链；迭代与验证（CDP 截图）链路最短。
  3. 界面是控制面板（状态灯、日志流、配置、配对、模型管理），React 的表格与实时日志实现成本最低。
  4. electron-builder 的 NSIS 路径成熟，安装/卸载/快捷方式/托盘自启一次配好。
- **后果**：
  - 安装包体积增加约 150 MB，空载内存约 150–250 MB（目标机 32 GB，不构成约束）；随包多一套 Chromium。
  - 必须按安全基线配置：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，渲染进程只经预加载暴露的白名单 IPC 访问主进程能力。
  - `safeStorage` 只用异步 API（同步版在 Electron 46 移除）；`isEncryptionAvailable` 失败时必须拒绝落库明文并提示。
  - Electron 45 与 electron-builder 26 的组合在 PCM1 首日做一次空壳安装包验证，通过后才继续写业务。
  - 版本升级策略：只在大版本升级时评估，升级必须重跑安装包与冒烟，不允许自动跟随 latest。

## ADR-PC-014 单 Python 运行时 + 瘦启动器，不用 PyInstaller 打包上游服务

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：安装包内只放**一份** CPython 3.12 + 一份锁定的 site-packages；外壳用 `runtime\python.exe -m <module>` 启动各服务；入口 exe 只做“定位 runtime、拉起外壳”这一件事。
- **理由**：上游对话后端大量动态导入，PyInstaller 隐藏导入与 hook 的长期维护成本高于收益；单一 site-packages 避免“外壳解释器一套、服务解释器另一套”的版本漂移；uv 可按锁文件复现。
- **后果**：
  - 依赖统一锁定：上游服务与 orchestrator 共用一个环境，冲突在锁文件层解决，不允许各服务私装。
  - 升级依赖 = 整包替换 runtime，必须做启动冒烟；卸载需清理 runtime 目录。
  - 模型（ASR、embedding、TTS）不进入 runtime，按模型管理器单独存放与校验。

## ADR-PC-015 父进程存活监视 + 整树清理

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：Python 服务宿主启动后，用 `OpenProcess` + `WaitForSingleObject` 监视**外壳 PID**；外壳正常退出或被强杀，宿主在 ≤2 s 内终止自身拉起的全部子进程。启动时按上次记录的 PID + 进程创建时间清理残留。
- **理由**：Electron 与 Tauri 都没有 Job Object 级联杀；外壳异常退出会留下 TTS 进程占住显存，直接破坏下一次“显存余量 ≥4 GB”的与门。
- **实现（PCM1 实测修正）**：外壳侧没有可靠的级联杀，但**宿主可以自己建 Job Object** 并把自己与全部 worker 放进作业（`KILL_ON_JOB_CLOSE`）。宿主无论正常退出、被 `Stop-Process` 还是随外壳一起被杀，句柄关闭即由 Windows 回收整棵子树——实测强杀外壳后 ≤1 s 清零，无残留监听端口。显式停止单个 worker 用 `taskkill /T /F`（Windows venv 的 `python.exe` 会再起一个真实解释器子进程，只杀直接子进程会留孤儿）。
- **后果**：
  - 启动顺序固定：外壳 → 服务宿主 → 各业务服务；退出顺序相反。
  - 子进程必须 `stdin=DEVNULL` 启动：实测继承宿主的 stdin 管道会让 CPython 子进程卡在启动阶段（不 bind、不输出、CPU 0）。
  - PID 复用必须用“进程名 + 创建时间”双校验，不能只信 PID。
  - 宿主自身崩溃时由外壳的 Supervisor 重启宿主，并复用同一条清理逻辑。

## ADR-PC-016 模型白名单：只允许 DeepSeek 系

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：所有 LLM 调用只允许 DeepSeek 系模型。端点 `/v1/models` 当前返回 6 个 id，其中 DeepSeek 只有 `deepseek-v4.1-flash`（服务端回包 `model` 字段为 `deepseek-flash`），白名单即此一项；配置层校验收口，模型 id 不在白名单时启动即失败。**禁止调用 gpt-6 系列（`gpt-6-astra`、`gpt-6.1-sol`）及任何同类高价模型**，不做“失败自动换模型”兜底。
- **理由**：费用约束是硬约束而非偏好；gpt-6 类单价远高于 DeepSeek，任何一次误落都会让日预算账本失真，且这类误用一旦藏在重试逻辑里极难发现。
- **后果**：
  - 配置 schema 中 model 字段为枚举，非白名单值拒绝保存。
  - LEDGER 每条记录必须带 `model`，可事后按模型对账。
  - 调用失败只重试**同模型**，不跨模型降级；模型侧不可用时直接报错并告知。
  - 换模型属于决策变更，必须新增 ADR，不靠改配置绕过。

## ADR-PC-017 国内网络优先：构建走镜像，运行期不联网

- **日期**：2026-11-10 · **状态**：已接受
- **决策**：
  1. **构建期**固定国内镜像：npm 走 `registry.npmmirror.com`（`apps/shell/.npmrc`）；Electron 二进制与 electron-builder 资源走 npmmirror（`scripts/install.mjs`、`scripts/pack.mjs` 内置默认值）；Python 依赖在 PCM2 的锁文件里固定国内索引。
  2. **运行期**外壳不主动访问公网：关闭 Chromium 后台联网、组件更新、域名可靠性上报、崩溃上报；渲染层 CSP `default-src 'self'`，不使用 CDN、外链字体与遥测；不启用自动更新。
  3. **模型、运行时、资源全部随包预置**，首次运行不下载任何东西（已有 ADR-PC-014、PLAN Q8 同向）。
  4. **唯一允许的外联是对 LLM 端点的调用**，走用户配置的 `base_url`（默认 `https://codex.mintcat.work`），请求带浏览器 UA（该端点会 403 非浏览器 UA），探测超时 8 s；不可达时 GUI 与日志给出明确状态，不静默重试。
- **理由**：目标用户在国内，GitHub、PyPI、CDN 均不稳定；只要启动链路依赖一次下载，首启就会失败，而失败现场用户无法自查。构建期慢可以接受，运行期慢不可接受。
- **后果**：
  - 安装包体积换可用性；升级只能靠重装（无自动更新），版本号与安装包一一对应。
  - 任何新增依赖都要检查是否能离线打包，禁止“首次运行下载模型/字体/词典”。
  - 端点从可用变不可用时，GUI 顶部会显示红色“端点不可达”而非静默卡住；这依赖 `probeLlm`（`/v1/models`，不带密钥）。

## ADR-PC-018 安装包体积预算与组件下载策略

- **日期**：2026-11-11 · **状态**：已接受
- **决策**：
  1. **安装包上限 500 MB**，`scripts/pack.mjs` 在出包后强制校验，超限直接失败（退出码 2），不允许“先发再说”。
  2. **能随包就随包**：CPython 运行时、业务代码、图标、前端产物全部打进安装包；当前体积约 117 MB（内核 110 MB + 运行时 30 MB + 业务 <1 MB）。
  3. **只有大体积且可复用的东西才下载**（OLVT 本体、模型权重、语音资源、字体包）：下载必须满足三条——只走国内镜像、按镜像顺序自动回退、落盘前校验 sha256 与最小体积；下载失败要在界面与日志里显式报错，不静默重试。
  4. 下载实现统一走 `scripts/lib/mirror.mjs`（构建期）与同一套镜像清单（运行期 PCM2 复用），不各自硬编码 URL。
- **理由**：500 MB 是普通用户对“一个托盘小工具”的心理上限，超过就变成“又一个占空间的大软件”；而模型动辄数百 MB，硬塞进安装包会让每次升级都重下全部内容。分界线放在“代码与运行时随包、可变资源按需下载”。
- **后果**：
  - 任何新增随包资源都要先看体积账；模型不随包，安装包才能长期守住 500 MB。
  - 离线机器在下载类功能上不可用，但核心服务（外壳、宿主、健康检查）必须仍能起来。
  - 镜像清单（华为云 / 阿里云 / npmmirror）成为长期维护项，域名失效时要能快速替换。

### 修订（2026-11-11）：OLVT 本体改为下载

- OLVT 不随安装包：它带完整 venv 与前端产物，体积与模型互绑，随包会让每次升级重下全部内容。
- 首次使用从组件面板下载：内置镜像顺序为 `ghfast.top` → `gh-proxy.com` → `ghproxy.net` → GitHub 直连，落盘前校验最小体积（可选 sha256），解压后校验入口文件存在。
- 下载地址可在 `config.shell.componentUrls` 覆盖（企业镜像/离线包），不硬编码在代码里。
- 组件解压到 `<安装根目录>/resources/components/<id>/<version>/`（与 ADR-PC-019 一致，卸载随之清理）。
- 依赖安装由随包 `tools/uv.exe` 自动完成，装进 `resources/runtime/site-packages`（已实测）。
- ASR 模型（SenseVoice 229 MB）同样走组件下载，与既有实验环境保持同一模型，不随包。

## ADR-PC-019 运行环境随程序收纳，不散落在用户目录

- **日期**：2026-11-11 · **状态**：已接受
- **决策**：
  1. **运行环境属于程序**：内置 CPython（`resources/runtime`）、下载的组件（`resources/components`）、后续 sidecar 的 site-packages 与 venv，全部落在安装根目录内，卸载时随安装目录一起删除。
  2. **用户数据属于用户**：`config.db`、`logs/`、聊天记录、模型产物等仍在 `%APPDATA%/DigitalHuman`，卸载保留（`deleteAppDataOnUninstall: false`）。
  3. 安装方式必须是 per-user（`perMachine: false`）：安装目录在 `%LOCALAPPDATA%/Programs/DigitalHuman`，普通用户可写，组件下载无需提权。
  4. 若安装目录不可写（企业环境被重定向/收紧 ACL），才回退到 `%APPDATA%/DigitalHuman/components`，并在日志里显式记录回退，不静默散落。
- **理由**：用户对“一个托盘小工具”的预期是卸载后不留运行环境；把 venv/模型散在 AppData 或临时目录，卸载后就成了无法定位的垃圾，也让“重装即干净”失效。
- **后果**：
  - 卸载会删掉已下载的 OLVT 与依赖，重装后需重新下载；换来的是零残留。
  - 升级安装（同目录覆盖）保留 `resources/components`，只有卸载才清空。
  - 安装目录不可写时行为降级为 AppData，需要用户名下可写；文档必须写明这一点。

## ADR-PC-020 OLVT 后端配置由外壳生成，用户不碰 conf.yaml

- **日期**：2026-11-12 · **状态**：已接受
- **决策**：
  1. 每次启动前由主进程把「全局设置」渲染成 OLVT 的 `conf.yaml`，写在 OLVT 后端目录里（`run_server.py` 只认 cwd 下的 `conf.yaml`），文件头标注“由 DHVW 生成，请勿手改”。
  2. 字段来源：LLM 端点/模型/temperature/密钥 ← 设置；`api_url` ← 分配的 TTS 端口；`port` ← 分配的 OLVT 端口；SenseVoice 的 `sense_voice`/`tokens` ← ASR 组件目录绝对路径。
  3. 字符串一律用 JSON 字符串字面量（合法 YAML 双引号标量），避免中文与 Windows 反斜杠转义出错。
  4. 上游 OLVT 不支持请求头与额外请求体，改为随包带补丁文件覆盖 `openai_compatible_llm.py`（浏览器 UA + `OLVT_LLM_EXTRA_BODY`），启动时覆盖进后端目录；版本号钉在 1.2.1。
  5. `vad_config.vad_model: null`：silero VAD 依赖 torch（约 2.5 GB），运行环境不含 torch，语音分段交给客户端。
  6. ASR 模型缺失时（未启用或未下载）退到 `groq_whisper_asr` 占位配置：pydantic 强制要求 `asr_config` 有具体实现，用不带模型文件的实现保证后端仍能起来，界面提示语音输入不可用。
- **理由**：终端型产品不该让用户编辑后端 YAML；配置项分散在两处必然漂移。密钥只能进加密存储，所以 conf.yaml 每次由主进程解密后重写，文件里是明文但只存在于本机安装目录。
- **后果**：
  - `conf.yaml` 是生成物，手改会在下次启动被覆盖；需要长期保留的调整要加进设置项。
  - 升级 OLVT 版本时必须同步 `olvt-overrides` 里的补丁文件，否则 UA/extra_body 丢失。
  - conf.yaml 含明文 API Key，安装目录（per-user，`%LOCALAPPDATA%`）本身受用户账户保护，但不能再复制到共享目录。

### 修订（2026-11-12）：精简依赖清单与嵌入式 Python 的三处适配

- OLVT 组件安装时不使用上游 `requirements.txt`，改用随包的 `resources/olvt-requirements.txt`（`ComponentSpec.requirementsBundled` 优先）。
- 依据：静态求 `run_server.py` 的模块级导入闭包 + 逐次启动验证；剔除项（torch / azure-speech / elevenlabs / cartesia / edge-tts / pyttsx3 / 各 ASR 后端）都只被各自的后端模块在函数内 import。
- 必须保留但上游标注为“可选”的：`anthropic`、`letta-client`（`basic_memory_agent` 模块级导入）、`pywin32`（mcp 的 Windows 句柄实现）、`groq`（ASR 占位）。
- `runtime/sitecustomize.py` 补齐三件嵌入式 Python 缺失的标准行为：`DHVW_PYTHONPATH`、脚本目录入 `sys.path`、展开 `--target` 目录里的 `.pth` 并注册 DLL 目录。

## ADR-PC-021 模型不设白名单，协议与模型由端点决定

- **日期**：2026-11-12 · **状态**：已接受（取代 ADR-PC-016 中“只允许单一模型”的产品层约束）
- **决策**：
  1. 设置里提供「协议」选择：`openai-compatible` 与 `anthropic`，分别映射到 OLVT 的 `openai_compatible_llm` / `claude_llm` 配置段。
  2. 模型列表从端点拉取：`{baseUrl}/v1/models`（失败再试 `{baseUrl}/models`）；OpenAI 兼容用 `Authorization: Bearer`，Anthropic 用 `x-api-key` + `anthropic-version`；两者都带浏览器 UA（端点会按 UA 过滤）。
  3. 列表里自动过滤 `image/embed/tts/whisper` 等非对话模型；过滤后为空则原样展示。允许手动输入模型名兜底。
  4. 保存时只校验「模型非空、协议在枚举内、端点必须是 http(s)」，不再有模型白名单。
  5. `baseUrl` 归一化在生成 conf 时做：OpenAI 兼容补 `/v1`（客户端会再拼 `/chat/completions`），Anthropic 保留根地址（客户端拼 `/v1/messages`）。
- **理由**：软件是终端，服务商与模型属于用户配置，不是产品定义；“deepseek-v4.1-flash”只是当前个人验证用的选择。
- **后果**：
  - 用户选了端点不支持的模型时错误来自上游，界面只显示原始错误，不做预判。
  - 拉取模型需要已保存或现场输入的 API Key，未配置时列表会因 401 失败，提示里带 HTTP 状态。

## ADR-PC-022 语音链路：TTS 后端目录化、慢启动探测与 LLM 客户端加固

- **日期**：2026-11-12 · **状态**：已接受
- **决策**：
  1. TTS 不再要求用户改 `config.db`：设置里新增「语音合成后端目录」，主进程按 `<dir>/runtime/python.exe api_v2.py -a 127.0.0.1 -p {port}` 注册真实 sidecar，`cwd` 为该目录，探活用 TCP；目录留空则保留占位 worker。`sidecars.tts` 仍可整体覆盖（企业内网自有命令）。
  2. 就绪探测不再“超时即判死”：`ServiceDef.healthTimeout`（秒，默认 30，真实 sidecar 设 180）到期只发一次 `worker.unhealthy` 告警并写日志，探测线程继续以 1 s 间隔重试，直到进程退出或探通；迟到探通仍会发 `worker.healthy`。
  3. OLVT 的 LLM 客户端加 `timeout=20`、`max_retries=0`，建流失败自行重试 2 次（0.5/1.0 s 退避）；彻底失败时下行文本换成中文短句。
- **理由**：GPU 模型加载 12–15 s 是常态，固定 30 s 判定会把正常机器标死；上游 OpenAI 客户端默认 600 s 无超时，跨境链路半死连接会让整轮对话静默卡住；失败文本会被 TTS 直接朗读，必须是给人听的话。
- **后果**：
  - 慢机器上 `worker.unhealthy` 告警可能先出现再被 `worker.healthy` 覆盖，UI 需以最新事件为准。
  - 重试只覆盖“尚未吐字”的阶段；流中途断线仍按失败处理（已出声的内容无法撤回）。
  - GPT-SoVITS 目录形态（`runtime/python.exe` + `api_v2.py`）是硬约定，其他 TTS 后端要用 `sidecars.tts` 显式写命令。

## ADR-PC-023 局域网网关：自签 CA + 一次性配对码 + 字节级反代

- **日期**：2026-11-13 · **状态**：已接受
- **决策**：
  1. 网关跑在 Electron 主进程（TS），监听 `0.0.0.0:8443`，只做 TLS 终结与字节转发，不解析业务报文。
  2. 证书用 `node-forge` 在主机上生成：CA 10 年、主机证书 397 天、SAN 覆盖 `localhost` / `127.0.0.1` / 全部 IPv4；局域网 IP 变化只重签主机证书。
  3. 配对为一次性 6 位码（5 分钟有效），成功即作废并发放 32 字节随机 token；token 以 0600 存 `gateway/devices.json`；连续 5 次错误码封该 IP。
  4. 鉴权只认 `X-DHVW-Token` 头或 `?token=`（设备端 WebSocket 无法自定义头）。`/healthz`、`/ca.crt`、`/pair` 免鉴权。
  5. 路由按 `/<服务名>/` 前缀映射到本机端口，`/ws/<服务名>` 映射到该服务的 WS 路径（OLVT 为 `/client-ws`）；未知服务返回 404，上游不可达返回 502。
- **理由**：设备端只要知道主机 IP 与配对码即可接入，不需要用户导入证书或改配置；自签 CA 避免依赖公网域名与续期；一次性码 + token 把「局域网任何人可连」收敛到「拿到码的人可连」。
- **后果**：
  - 设备首次接入必须信任 `ca.crt`；不信任时浏览器的报错由设备端引导处理，主机端不降级为明文。
  - 网关与会话强相关：主机改端口会被重建，已配对设备 token 仍有效（设备表独立于监听）。
  - 目前不提供吊销单个设备，只有「全部解除」；按设备吊销留给 PCM7 的管理面。

## ADR-PC-024 组件下载改用内嵌 aria2c，镜像与续传由下载引擎负责

- **日期**：2026-11-13 · **状态**：已接受
- **决策**：
  1. 组件下载（OLVT 源包、ASR 模型）不再用 Node `fetch` 单连接，改为随包分发 `tools/aria2c.exe`（aria2 1.37.0 静态 Windows x64 构建，5.4 MB），由主进程 `src/main/download.ts` 拉起。
  2. 多个下载镜像作为 aria2 的多个 URI 参数传入（同一个文件的镜像语义），参数固定为 `--max-connection-per-server=8 --split=8 --min-split-size=1M --max-tries=6 --retry-wait=2 --continue --auto-save-interval=5 --file-allocation=none`。
  3. `aria2c` 缺失（精简安装/CI/非 Windows）时自动回退原有 `fetch` 实现，行为不变；回退分支同样支持 `Range` 续传与 206 追加写。
  4. 进度由我们自己算：先 `HEAD` 探 `content-length`，探不到则退用 aria2 摘要行里的总量；两者都没有（chunked 镜像）时不伪造百分比，UI 进度条走不确定态扫动动画。
  5. `download.ts` 不 import `electron`、不 import 日志模块，日志通过 `opts.log` 注入，因此可在纯 node 下用 `scripts/test-download.mjs` 直接验证。
  6. 校验失败（体积/sha256）抛 `VerifyError`，不触发「换引擎重试」——那是确定性失败，重试没有意义。
- **理由**：弱网下最大的痛点是「断流即从 0 重来」。aria2 原生提供分段多连接、`.aria2` 控制文件续传、多镜像回退与自动重试；静态单 exe 无依赖，正好落在已有的 `build/tools` 打包路径内。自己实现多线程分段（含控制文件、校验、合并）成本远高于内嵌。
- **后果**：
  - 续传能否生效取决于镜像是否支持 `Range`。实测 `gh-proxy.com` / `ghfast.top` 对 `Range` 请求返回 200（不支持），此时 aria2 会整体重下；`.aria2` 控制文件仍会保留，换成支持 `Range` 的源即可接着下。这条限制写进 README，不对外宣称「一定续传」。
  - 分发 GPLv2 二进制，`scripts/fetch-aria2.mjs` 同时抓取 `COPYING` 到 `tools/aria2-COPYING.txt` 随包保留。
  - 组件下载多一个约 5.4 MB 的固定体积；安装包 137.3 MB → 139.4 MB，仍在 500 MB 软阈值内。
  - 构建期下载（`scripts/lib/mirror.mjs`）在 `build/tools/aria2c.exe` 已存在时复用同一引擎，原来「整包读进内存」的单连接实现只在缺 exe 时使用。

## ADR-PC-025 编排器落在 Python 服务，设备通道按信封透传

- **日期**：2026-11-13 · **状态**：已接受
- **决策**：
  1. 编排器不是 Electron 主进程里的模块，而是独立 Python 服务 `services/orchestrator/dhvw_orchestrator`（FastAPI + uvicorn），由既有服务宿主托管，端口 8877，健康检查 `/health`。
  2. 设备通道 `WS /dhvw` 按 `arm/docs/CONTRACTS.md` 的信封原样收发：`v != 1` → `bad_version`，未知 `type` → `bad_type`，错误都带原 `id` 到 `replyTo`。PC 不新增/改名消息类型。
  3. 事件按 `uuid` 幂等入库（`insert or ignore`），`events:ack` 回本批最大 `seq` 与实际写入量；重复批次只回 ack、不重复写。
  4. 记忆用 SQLite FTS5 + **二元组**索引，不用 `tokenize='trigram'`（实测 sqlite 3.49.1 对 2 字中文查询零命中）。`mem_fts` 与 `mem_meta` 行数不符时自动重建索引。
  5. `memory:result.semantic` 恒为 `false`：随包没有 embedding 模型，禁止运行时下载（ADR-PC-017）。不伪造 `true`。
  6. 未接线的设备请求（`notify`、`map.generate`）显式失败：`ok:false` + 中文原因。禁止假成功。
  7. 外壳 → 编排器的配置只走回环 `POST /dhvw/config`（`{tts,live2d,llm}`），编排器再以 `llm:config` 下发设备。API Key 只在外壳内存中出现，Python 服务不碰 `safeStorage`/DPAPI。
  8. 网关转发 WS 时把上游 open 之前的客户端帧排队，连上后补发。
  9. 在线判定以存活连接集合为准（`connected = bool(clients)`），不由单条连接的关闭回调直接置假——旧连接的 `finally` 晚于新连接握手时会把在线误判为离线。
  10. `memory:facts` 回流按 `updated_at` 增量下发，游标存 `life.db` 的 `kv.facts_since`，只有设备 `facts:ack`（`replyTo` 命中本次推送的 id）才推进；已发未 ack 的同一条不重发，但新事实照发。
  11. `mem_meta.updated_at` 一律写**服务端接收时间**，设备传的 `t` 只作事件时间。`t` 来自设备时钟，可能落后甚至超前（实测有脚本写入未来时间戳），拿它当增量游标会把之后写入的事实永久挡在窗口外。
  12. GUI 只读展示世界状态（`dhvw:world` → `/health` + `/dhvw/digest` + `/dhvw/mood`），不缓存、不推断；编排器/设备不在线时如实显示，摘要保留上一次。
- **理由**：运行时已有 fastapi/uvicorn/websockets/SQLite；记忆与 embedding 天然在 Python 生态；独立进程崩溃不影响外壳，符合既有「外壳只托管、不承载业务」的模型。设备端契约已冻结，PC 侧多改一个字段就是双端联调成本。
- **后果**：
  - 设备连上就发 `hello`，网关若直接丢弃未 open 期间的帧，握手会静默丢失——排队逻辑是必需项，不是优化。
  - `present:grant/deny` 的依据是外壳下发的 `tts` 标志：外壳启动、设置保存、密钥保存、worker 健康变化与每 60 s 定时各推一次，避免 TTS 迟到就绪或重启后状态被旧值钉住。
  - 记忆检索的召回质量受限于字面二元组；embedding 随包后改的是 `semantic` 与打分，不改协议。
  - `semantic=false` 与未接线动作必须在文档与错误原因里写明，避免被当成缺陷反复排查。

## ADR-PC-026 界面按「首页 / Agent / 配置」三页重组，地图生成交给嵌入式 pi CLI

- **日期**：2026-11-13 · **状态**：已接受
- **背景**：主界面把服务表、事件、世界、组件、日志全塞在两列里，日常看的总观与虚拟形象反而没有位置；同时「让 PC 生成地图」一直缺执行者——自研 agent 循环（工具调用、重试、上下文裁剪）既不划算也难维护。
- **决策**：
  1. 顶栏三页签：**首页**（舞台 + 世界模式增强 + ARM 状态机统计表）、**Agent**（设计地图 → 场景任务）、**配置**（原服务表/事件/世界/组件/网关/日志）。切页只改 `tab` 状态，不重载窗口。
  2. 首页舞台是 `总观 / 显现` 二切：显现把 OLVT 页面用 iframe 嵌入（CSP 增加 `frame-src http://127.0.0.1:*`），OLVT 未就绪时给明确文案。**显现开关本身不触发 `present:*` 流程**，那仍由设备发起。
  3. boost（世界模式增强）当前只是界面态：写 `config.db` 的 `boost.enabled`，随配置下发到编排器并落 `kv.boost`，**不改变生产行为**，文案与文档都写明。
  4. ARM 状态机统计表只读 `GET /dhvw/stats`（`device`/`digest` 各状态计数、`tier_transitions`、近 24 h 事件按 kind、记忆条数、编排器 uptime），缺数据就显示 `—`，不做推算。
  5. 地图生成嵌入 **pi CLI**（`pi -p --mode json --provider dhvw --model <settings.model> --skill docs/MAP-SCENE-DESIGN.md`），不自研 agent；`HOME`/`USERPROFILE` 指向 `data/agent-home` 隔离，`models.json` 由编排器按外壳下发的 `{baseUrl,apiKey,model}` 生成（`compat.supportsDeveloperRole/supportsReasoningEffort=false`）。
  6. 成败以**收包闸门**为准：产物齐全 + 编排器自己复跑 `validate_scene.py` 退出码 0 → `done`（agent 退出码非 0 记为告警），否则 `failed` + 原因。缺工具链 / pi / 带 PIL 的 Python / 密钥时**提交阶段就拒绝**。
- **理由**：UI 重组的判断标准是「一屏内能看到她、能看到世界、能动手」；agent 的可靠性用成熟 CLI 换来自研成本，模型只出参数、几何由确定性脚本产出（`MAP-SCENE-DESIGN` 的既有前提）。闸门复跑是不信任 agent 自报「已通过」的最低成本做法。
- **后果**：
  - 场景作业要三个额外运行时（地图工具链、pi、带 PIL 的 Python），对外部设备/迷你主机是明显门槛；当前只在开发机验证，发行打包前必须定下随包/引导策略。
  - `--mode json` 的输出行会超过 asyncio 默认 64 KiB 流上限，必须 `limit=8 MiB` 并按块读；否则任务在 agent 已成功后被 `LimitOverrunError` 判失败（已踩）。
  - 首页统计表的「档位迁移」是进程内计数，编排器重启归零；需要跨重启趋势时得另落库。
  - boost 未接线期间，前端状态与后端 `kv.boost` 一致，但没有任何生产效果；接线时改的是编排器侧，协议不用动。

## ADR-PC-027 角色舞台自建 Live2D 渲染，PC 不再嵌入 OLVT 前端

- **日期**：2026-11-13 · **状态**：已接受
- **背景**：首页舞台原先嵌 OLVT 的 Web 页面。实测两处硬伤：① OLVT 组件里 `frontend/` 是 git 子模块（branch `build`），组件安装不解子模块，后端 `/` 直接 404；② 即便补上构建产物，该前端与后端 1.2.1 不匹配，一上手就请求 `/undefined/undefined.model3.json`，角色不出现。舞台只需要「角色常驻显示」，不需要 OLVT 的聊天壳。
- **决策**：
  1. 舞台改成自建页面 `apps/shell/resources/live2d/index.html`：pixi 6 + pixi-live2d-display（cubism4）+ `live2dcubismcore.min.js`，模型用 `live2d-models/mao_pro`，透明背景、按窗口自适应、idle 动作循环、鼠标跟随，状态文案自绘。
  2. 主进程起**只绑 127.0.0.1、随机端口、只读 static** 的服务提供 `resources/live2d`（`file://` 下模型 JSON 会被跨源检查拦掉）。渲染进程通过 `dhvw:live2d` 拿到 URL，舞台常驻 iframe。
  3. 资源随包（`extraResources: resources/live2d → resources/live2d`，约 9.7 MB），不运行时下载（ADR-PC-017）。
  4. 总观/显现改由设备负责：PC 新增下行 `display:set {state}`（`POST /dhvw/display`），确认只看设备回传的 `digest.world.display`，6 s 未变化即提示「设备未确认」。
- **理由**：把「显示角色」从 OLVT 的页面栈里解耦后，舞台不再依赖组件是否完整、前后端版本是否匹配；模型文件本来就在 OLVT 组件里，复制进资源包即可，安装包仍在 500 MB 预算内。
- **后果**：
  - 舞台只有形象，没有历史/输入框/连接状态；对话与执行业务仍在 OLVT 后端（声纹合成、回合），两者通过编排器解耦。
  - `display:set` 是新增消息，设备固件未实现前按钮只有投递没有效果——前端如实提示，不伪造状态。
  - 换角色走「设置 → Live2D 模型」：模型库两处（随包 ∪ OLVT 组件），选中后同步进 OLVT（模型文件 + `model_dict.json` 条目）并重启 OLVT 使 `live2d_model_name` 生效；模型许可随包保留原文。

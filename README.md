# 数字人虚拟仓 · PC 主机端

PC 主机端软件：把对话、语音、生活流、长期记忆、世界内容生产、桌面接管收进**一个安装包**。双击启动，托盘可控，无命令行操作。

设备端（显示与端侧自治）不在本仓库范围内，经局域网调用本机端口。

## 定位

- **能力源，不是显示宿主。** 页面、地图、角色由设备本地提供；PC 关机不影响设备出画面。PC 只提供“思考、说话、生产”的能力。
- **一切能力经本机端口对外**，无云端服务依赖（LLM 走 API，但不是本项目的服务）。
- **单进程树、单日志出口、单数据目录。**

## 范围

**做**

| 能力 | 出口 |
|---|---|
| 对话（LLM + 人格 + 打断 + 口型数据） | OLVT 后端 |
| 语音识别、语音合成（声音克隆） | OLVT 内置模块 + GPT-SoVITS |
| 生活流同步（生活事件 → 对话上下文） | orchestrator |
| 主动开口（闸门决策 + 进程内投递） | orchestrator + OLVT 端点 |
| 长期记忆（向量 + 全文 + 时间衰减） | orchestrator |
| 世界内容生产（场景种子、剧情、背景图 prompt） | orchestrator |
| 显示态与世界档位控制（模式机、主机可达判定） | orchestrator |
| 桌面接管（远程遥控本机） | RustDesk |
| 外壳：托盘、服务托管、端口管理、日志、配置 | Electron 45 / TypeScript |
| 网关：自签证书、HTTPS/WSS 反代、设备配对 | 外壳 |

**不做**

- 设备系统镜像、kiosk、设备本地壳与资源包
- 前端渲染：Live2D、像素地图、总观/显现视图
- 美术素材、地图设计、角色精灵
- 端侧 Worker 运行时与端侧资产生成
- 公网暴露、多用户、账号体系、计费
- 本地 LLM 部署、Docker、外部数据库服务

## 组成与端口

| 进程 | 端口 | 绑定 | 职责 |
|---|---|---|---|
| 外壳（Electron 45 / TypeScript） | — | — | 托盘、Supervisor、端口管理、日志、配置、网关、GUI |
| `olvt-backend`（Python） | 12393 | 局域网 | 对话、ASR、TTS 编排、WebSocket 推流 |
| `tts-service`（Python） | 9880 | 127.0.0.1 | GPT-SoVITS 推理，显存 4–5 GB |
| `waketrace`（Python） | 8765 | 127.0.0.1 | 生活事件源，只被 orchestrator 拉取 |
| `orchestrator`（Python） | 8877 | 局域网（能力面）/ 127.0.0.1（管理面） | 模式机、生活流、闸门、记忆、世界生产 |
| 网关 | 8443 | 局域网 | HTTPS/WSS 反代 → 12393，自签 CA |

端口全部**自动分配并持久化**，冲突时顺延；写死端口仅作开发期默认值。

## 数据目录

`%APPDATA%/DigitalHuman/`

```
models/        模型（按需下载、校验、版本切换）
data/          配置库、生活库、记忆库、token 账本
scenes/        世界产出：场景
backgrounds/   世界产出：背景图
plots/         世界产出：生活剧情
certs/         自签 CA 与服务证书
logs/          统一日志
```

**密钥不入库、不入日志、不入安装包**：LLM API key 由 GUI 写入，经系统凭据机制（Windows DPAPI）加密存储；开发期从仓库外的凭据文件读取，路径由本机环境变量指定，仓库内只保留 base_url / model 这类非敏感配置。

## 仓库结构（规划）

```
PC/
├── apps/shell/        Electron 45 外壳（TypeScript）：托盘 / 托管 / 端口 / 日志 / 配置 / 网关 / GUI
│   ├── src/main/      主进程：托管、端口、日志、配置、托盘、IPC
│   ├── src/preload/   contextBridge 白名单
│   └── src/renderer/  React 控制面板
├── services/host/     服务宿主（Python 3.12）：托管 sidecar、监视外壳、整树清理
├── services/worker/   占位 sidecar（PCM1 用于验证托管与自愈，PCM2 起被真实服务替换）
├── services/orchestrator/  Python sidecar：模式机 / 生活流 / 闸门 / 记忆 / 世界生产（待建）
├── sidecars/          上游 sidecar 的打包入口与补丁清单（OLVT、TTS、WakeTrace）
├── packaging/         sidecar 打包、安装包（NSIS/MSI）、签名
├── scripts/dev/       开发期启动、探活、冒烟脚本
└── docs/              本仓库唯一事实来源
```

目录按里程碑逐步落地，未实现的目录不预建空壳。

## 环境要求

| 项 | 版本 | 说明 |
|---|---|---|
| Windows | 10 / 11 x64 | 唯一目标平台 |
| Node | 24 LTS + pnpm | 外壳与 GUI 构建（Electron 45 内置 Node 24） |
| Electron | 45.2.3（锁定） | 外壳运行时，内置 Chromium 156 |
| Python | 3.12 | 服务侧；上游要求 `<3.13` |
| GPU | NVIDIA，驱动支持 CUDA 12.x | TTS 推理 |

仓库路径必须**全 ASCII、无空格**：中文路径会让部分安装工具“报告成功但零文件落地”，无空格省掉脚本与打包的转义。

## 开发命令

首次安装（走国内镜像，不要直接 `npm install`——Electron 二进制从 GitHub 拉会超时）：

```bash
cd apps/shell
npm run setup     # registry 走 npmmirror，ELECTRON_MIRROR 由脚本注入
```

日常：

```bash
cd apps/shell
npm run build     # 主进程 tsc → dist-electron，渲染层 vite → dist
npm start         # 构建后启动外壳
npm run fetch-runtime   # 从国内镜像拉 CPython 3.12 到 runtime/（pack 时缺省自动执行）
npm run dist      # electron-builder 出 NSIS 安装包 → ../../release（内置 npmmirror 镜像，出包后校验 500 MB 预算）
```

指定 Python（开发期默认取 `DHVW_PYTHON`，否则用 PATH 上的 `python`）：

```bash
DHVW_PYTHON="D:/ai_projects/olvt-venv/Scripts/python.exe" npm start
```

服务宿主可单独启动（自带 JSONL 事件流，`@@DHVW@@ ` 前缀）：

```bash
cd services
PYTHONPATH=host python -m dhvw_host --shell-pid <外壳PID> --log-dir <数据目录>/logs --services <runtime-services.json>
```

注意：

- 启动 Electron 前必须清掉 `ELECTRON_RUN_AS_NODE`，否则 `electron` 会当成 Node 跑。
- 数据目录 `%APPDATA%/DigitalHuman`；日志分别为 `logs/shell.jsonl`、`logs/host.log`、`logs/<service>.log`。
- Windows 上 venv 的 `python.exe` 会再拉起一个真实解释器子进程，所以整树清理用 **Job Object（KILL_ON_JOB_CLOSE）+ `taskkill /T /F`**，只杀直接子进程会留下孤儿。

## 国内网络

目标用户在国内，**构建期允许慢、运行期不允许联网**（ADR-PC-017）：

- 构建：npm 与 electron-builder 资源默认走 `npmmirror`；Python 依赖在 PCM2 锁文件里固定国内索引。
- 运行：外壳关闭 Chromium 后台联网/组件更新/崩溃上报，渲染层 CSP 只允许 `self`，无 CDN、无外链字体、无自动更新。
- 代码与 CPython 运行时就绪后随包内置，首次运行不下载任何东西；只有模型/语音这类大体积资源才按需下载，下载统一走 `scripts/lib/mirror.mjs`（华为云 → 阿里云 → npmmirror 依次回退，校验 sha256 与最小体积）。
- 唯一外联是 LLM 端点（默认 `https://codex.mintcat.work`，模型 `deepseek-v4.1-flash`）：请求必须带浏览器 UA，否则 403；GUI 顶部会显示实时探测结果（应用启动时自动探一次，可手动重测）。

## 真实 sidecar 接入

默认 4 个服务都是占位 `dhvw_worker`（只提供 `/health`）。把某个服务换成真实进程，写 `config.db` 里的 `shell.sidecars`：

```json
{
  "sidecars": {
    "waketrace": {
      "command": ["D:\\path\\to\\python.exe", "-m", "waketrace", "serve", "--host", "127.0.0.1", "--port", "{port}"],
      "cwd": "D:\\path\\to\\Wake-Trace",
      "env": { "WT_SOMETHING": "..." }
    }
  }
}
```

- `{port}` 由外壳分配的端口替换；`env` 同样支持 `{port}`。
- 声明了 `healthPath` 的服务启动后会轮询该路径（默认 `/health`），30 s 内不通则界面显示「无响应」并写 `host.log`。
- 实测：`waketrace` 走 vendor 仓库的 venv，启动到 `/health` 200 用 1.3 s，外壳侧 `worker.healthy` 事件可查。
- 打包真实 sidecar 前必须先解决它的依赖分发（ADR-PC-014 的单一 site-packages），否则干净机器上跑不起来。

## 全局设置

顶栏「设置」打开，改动立即写 `config.db`（端口类改动需重启宿主生效）：

| 项 | 说明 |
|---|---|
| 协议 | `OpenAI 兼容`（默认）或 `Anthropic`；决定 OLVT 用 `openai_compatible_llm` 还是 `claude_llm` 段 |
| 调用端点 / 模型 | 填端点后点「拉取模型」从 `{baseUrl}/v1/models`（Anthropic 用 x-api-key）取列表并选择，也可手动输入；模型只校验非空，不做白名单 |
| temperature | 0–2，越界拒绝 |
| API Key | DPAPI 加密后存 `secrets` 表；IPC 只返回 `hasKey` 布尔值，明文不出主进程，不进日志 |
| OLVT / TTS 端口 | `0` = 自动分配；固定端口被占用时自动回退到动态分配 |
| 启用 ASR | 关闭后不要求下载 SenseVoice 模型；开启但模型未下载时界面会提示 |
| 角色名 / 称呼用户 / 人设 | 直接写进 OLVT 的 `character_config`，重启宿主生效 |
| 语音合成后端目录 | GPT-SoVITS 目录（含 `api_v2.py` 与 `runtime/python.exe`）；留空则保留占位 worker。端口取上面的 TTS 端口 |
| 参考音色（音频路径 + 文本） | GPT-SoVITS 的 `ref_audio_path` / `prompt_text`，留空则用 TTS 服务默认 |

实测：保存 → 读回一致；`secrets` 里是 64 字符 base64 密文（非明文）；日志中检索不到密钥；`70000` 端口被拒绝并返回中文错误；端点 `https://codex.mintcat.work` 拉到 3 个对话模型（自动过滤 image 类），选中后 OLVT 直连流式首字 0.98 s。

## OLVT 首启编排（ADR-PC-020）

后端不需要手改 `conf.yaml`：外壳每次启动按当前设置生成，再以 sidecar 拉起。

| 生成字段 | 来源 |
|---|---|
| `system_config.port` | 设置里的 OLVT 端口（0 = 自动；固定端口被占用自动回退） |
| `llm_configs.openai_compatible_llm.*` | 全局端点 / 模型 / temperature / 解密后的 API Key |
| `tts_config.gpt_sovits_tts.api_url` | `http://127.0.0.1:<tts 端口>/tts` |
| `asr_config.sherpa_onnx_asr.sense_voice/tokens` | 组件目录里 SenseVoice 的绝对路径 |
| `vad_config.vad_model` | `null`（silero 需要 torch，运行环境不含） |

随包补丁（`apps/shell/resources/olvt-overrides/`）在启动时覆盖进后端目录，给上游 `openai_compatible_llm.py` 补两件它没有的能力：浏览器 UA（端点无 UA 直接 403）与 `OLVT_LLM_EXTRA_BODY`（关闭 deepseek 思考，首字更快且不会把思考内容读出来）。

启用 ASR 但模型未下载时，后端退到占位 ASR 启动，界面日志会写明语音输入不可用。

## 局域网网关（PCM3）

服务面板底部的「设备接入」条显示网关地址，点「配对 / 设备」打开弹层。

- **监听**：`0.0.0.0:8443`（端口可在设置里改，默认 8443，改后网关自动重建监听）。
- **证书**：首次启动生成 CA（`%APPDATA%/DigitalHuman/gateway/ca.crt.pem`，10 年）+ 主机证书（397 天，SAN 含 `localhost`、`127.0.0.1` 与本机所有 IPv4）。局域网 IP 变化或证书快过期时只重签主机证书，CA 不变，设备无需重新信任。
- **免鉴权端点**：`GET /healthz`、`GET /ca.crt`（设备先取它信任证书）、`POST /pair`。
- **配对**：弹层点「生成配对码」得到 6 位码（5 分钟有效、一次性），设备 `POST /pair {"code":"123456","name":"客厅屏"}` 换 32 字节 token，token 存 `gateway/devices.json`（0600）。连续 5 次错误码后该 IP 被锁，直到重新生成配对码。
- **鉴权**：其余请求必须带 `X-DHVW-Token` 头或 `?token=`，未配对返回 401。
- **反代**：`/<服务名>/...` 转发到本机对应端口（`olvt`、`orchestrator`、`waketrace`）；`/ws/<服务名>?token=...` 转发 WebSocket（OLVT 走 `/client-ws`，设备通道走 `/ws/orchestrator` → `ws://127.0.0.1:8877/dhvw`）。上游连接尚未建立时的设备帧会排队，连上后一次补发——设备连上就发 `hello`，不排队会丢掉握手。

实测（本机，Node 客户端 + `--cacert` 等价校验）：

| 检查 | 结果 |
|---|---|
| `openssl verify -CAfile ca.crt.pem server.crt.pem` | OK |
| `GET /healthz`（127.0.0.1 / 10.38.94.208 / 26.252.92.45） | 全部 200，主机名与 SAN 匹配 |
| 未带 token 访问 `/olvt/health` | 401 |
| 错误配对码 | 403；正确配对码 | 200 + token |
| 同一配对码重放 | 403（一次性） |
| 带 token 反代 `/olvt/health` | 200，上游 JSON 原样返回 |
| `wss://…/ws/olvt?token=…` 走完一回合 | 收到回复与音频分片 |

## 编排器与设备通道（`/dhvw`）

真实服务在 `services/orchestrator/dhvw_orchestrator`（Python，FastAPI + uvicorn），由服务宿主托管，默认端口 8877，经网关以 `wss://<主机>:8443/ws/orchestrator?token=…` 暴露给设备。设备侧是 WebSocket **客户端**，消息信封与消息表以 `arm/docs/CONTRACTS.md` 为准，PC 侧只实现、不改契约。

- **信封**：`{v,id,type,ts,payload,replyTo?}`；`v != 1` 回 `bad_version`，未知 `type` 回 `bad_type`，都在 `replyTo` 里带原 `id`。
- **连接即推送**：设备连上后服务端主动发 `digest:get`、`mood:get`，配置里有 LLM 时补 `llm:config`。
- **落盘**：事件进 `data/life.db`（`uuid` 幂等，重复批次不重复入库），摘要原子写 `data/digest.json`，心情与记忆进 `data/memory.db`。
- **记忆检索**：SQLite FTS5 + **二元组**索引（`"京 都 的 枫 叶"` 形式），2 字中文查询可命中；`fts5(tokenize='trigram')` 对 2 字中文零命中，不用。索引与正文行数不符时自动重建。
- **显现闸门**：`present:request` 在 TTS 未就绪时回 `present:deny{reason}`；`present:begin/end` 把 `tier` 切到 `host`/`idle`。TTS 就绪状态由外壳随配置一起下发（见下）。
- **动作白名单**：`web.open` / `media.play` / `app.open` 可执行；`map.generate` 交给场景作业（见下节），提交成功即回 `{job,dir}`；`notify` **未接线**，返回 `ok:false` + 中文原因，不假装成功。
- **显示态下行**：`POST /dhvw/display {state:"overview"|"present"}` → 广播 `display:set {state,t_server}`，返回 `{delivered}`；设备未连接时 `ok:false`。这是对设备契约的**新增消息**，固件未实现前只会有投递、没有效果，前端按 6 s 无确认如实提示。
- **配置来源**：外壳持有解密后的 API Key（DPAPI），启动、设置保存、密钥保存、worker 健康变化以及每分钟一次，向 `POST http://127.0.0.1:8877/dhvw/config` 回环下发 `{tts,live2d,llm:{baseUrl,model,apiKey}}`；`llm` 变化即时以 `llm:config` 转给设备。Python 服务不碰 safeStorage。
- **界面**：世界状态在两处出现——首页舞台的「总观」与配置页的「世界」卡片。数据由主进程 `dhvw:world` 汇总 `GET /health` + `/dhvw/digest` + `/dhvw/mood`，`dhvw:stats` 另取 `/dhvw/stats`，均 2 s 刷新；编排器没起来显示「编排器未运行」，设备断开显示「编排器在线 · 无设备」（此时摘要仍是上一次的）。
- **记忆回流**：PC 侧写事实走 `POST /dhvw/facts`（`src=pc`），编排器按 `updated_at` 增量以 `memory:facts{since,facts,summary}` 下发给在线设备；设备回 `facts:ack` 才把游标推进到本批最大 `updated_at`，上一批没 ack 不重复下发。
- **`semantic=false`**：随包没有 embedding 模型（ADR-PC-017 禁止运行时下载），`memory:result.semantic` 恒为 `false`，设备侧按契约降级为本地字面检索。

调测：

```bash
cd apps/shell
npm run test:dhvw          # 直连 8877 的假设备，21 项断言
npm run test:dhvw -- --wss # 同一套断言走网关 wss://127.0.0.1:8443/ws/orchestrator?token=…
```

`--wss` 读 `%APPDATA%/DigitalHuman/gateway/{ca.crt.pem,devices.json}`，需先配对一台设备（`scripts/gateway-smoke.mjs`）。

## 场景作业（Agent 页 / `map.generate`）

用户口径：**一个场景就是一张连续地图**（家、街道都一样），切换靠加载，不拆图。PC 只产出设备可运行的场景包（`docs/MAP-SCENE-DESIGN.md` §13.4 / §15.1），不渲染、不展示。

链路在 `services/orchestrator/dhvw_orchestrator/scene.py`：

1. `POST /dhvw/scene {kind,name,seed,distance,note}` → 建工作目录 `%APPDATA%/DigitalHuman/data/scenes/<id>/`（`GET /dhvw/scenes` 查任务表）。
2. 编排器以 **pi CLI** 拉起 agent：`pi -p --mode json --provider dhvw --model <settings.model> --skill <toolchain>/docs/MAP-SCENE-DESIGN.md`，`HOME`/`USERPROFILE` 指向 `data/agent-home`（隔离，不污染用户自己的 `~/.pi`），`.pi/agent/models.json` 由编排器按当前设置的 `baseUrl/apiKey/model` 生成（`compat.supportsDeveloperRole/supportsReasoningEffort=false`）。
3. agent 写 `<id>.map.json` 并跑 `paint_home.py` → `pack_scene.py` → `validate_scene.py`；编排器随后**自己再跑一次** `validate_scene.py` 作为收包闸门，通过才发 `scene:ready {id,path,name}` 给设备。
4. 判定只看闸门：agent 进程退出码非 0 但产物齐全且校验通过时，任务标「已完成（有告警）」，告警原样显示在 Agent 页。

前置条件（缺任一都在提交时显式失败，不产占位包）：

| 依赖 | 说明 |
|---|---|
| 地图工具链 | 含 `docs/MAP-SCENE-DESIGN.md` 与 `scripts/` 的仓库根；自动向上探测，或设 `DHVW_MAP_TOOLCHAIN`。 |
| pi CLI | `PI_BIN` 或 PATH/常见安装路径，找不到直接拒绝提交。 |
| 带 PIL+numpy 的 Python | 画图脚本需要；`DHVW_MAP_PYTHON` 或 PATH 上的 `python`（内置 CPython 3.12 没有 PIL，跑不了这一步）。 |
| LLM 密钥 | 设置页已保存（DPAPI），编排器拿外壳回环下发的明文副本写进 `models.json`。 |

已实测：`room-smoke1`（8×7 书房）、`street-smoke2`（20×6 街道）、`room-diag4`（4×4 单间）三张都由 pi+skill 产出并通过 `validate_scene.py`，单任务 3–4 分钟、输出 8–9 万 token。踩过的坑：`--mode json` 单行会超过 asyncio 默认 64 KiB 流上限，必须提高 `limit` 并按块读，否则任务在收尾处被 `LimitOverrunError` 判死。

## 语音链路（已跑通）

一回合 = 客户端音频 → SenseVoice → LLM → GPT-SoVITS → 音频分片。各段实测（本机 RTX 50 系）：

| 段 | 实测 | 说明 |
|---|---|---|
| ASR（`POST /asr`，4.8 s 音频） | 0.13 s 解码，加载 1.0 s | SenseVoice int8，CPU 4 线程 |
| LLM 首字 | 1.0–8.4 s | 端点自身抖动，与客户端无关 |
| TTS | 冷 24.9 s（模型加载）/ 热 0.67–0.9 s | 单句，`api_v2.py` + 参考音色 |
| 整回合（`text-input` → 首段音频） | 3.2–19.3 s | 差值几乎全在 LLM 首字 |

验证方法：`ws://127.0.0.1:<olvt端口>/client-ws` 发 `{"type":"text-input","text":"..."}`，收集下行 `audio` 事件（`display_text.text` 是分句文本），`control: conversation-end` 收尾。

两处对上游客户端的加固（`resources/olvt-overrides`）：
- `AsyncOpenAI(timeout=20, max_retries=0)`：上游默认 600 s 且无重试，遇到半死连接会整轮不出声。
- 建流连接失败按 0.5/1.0 s 退避重试 2 次；彻底失败时下行文本改为中文提示（原来会把英文排障段落念出来）。

慢启动 sidecar（OLVT 6–14 s、GPT-SoVITS 12–15 s）的就绪探测超过 `healthTimeout`（默认 30 s，真实 sidecar 设 180 s）只告警一次，之后继续探测直到进程退出——否则 GPU 模型加载慢的机器会被永久标成不健康。

实测（本地 OLVT 1.2.1 源码 + 组件目录结构 + 固定端口 12399）：

```
worker healthy  service=olvt  mode=tcp  ms=4439
http://127.0.0.1:12399/  → 200 <!doctype html>
conf: port 12399 / base_url https://codex.mintcat.work / model deepseek-v4.1-flash
      sense_voice …\components\asr-sensevoice\2024-07-17\model.int8.onnx
      api_url http://127.0.0.1:<tts 端口>/tts / vad_model null
override UA applied: true
```

## OLVT 依赖清单（精简）

上游 `pyproject.toml` 把全部后端 SDK 都列为必装（anthropic / azure-speech / elevenlabs / cartesia / edge-tts / pyttsx3 / letta / torch）。我们只用「openai_compatible + sherpa-onnx + GPT-SoVITS HTTP」，随包改用 `apps/shell/resources/olvt-requirements.txt`（安装时优先于组件自带的 `requirements.txt`）。

- 重型导入都藏在各后端模块内部、由工厂按需 import，所以剔除是安全的；
- 但 `basic_memory_agent` 在模块级就 import 了 `anthropic` 与 `letta_client`，`agent_factory` 会提前拉起 → 必须保留；
- `mcp` 在 Windows 上依赖 `pywin32`，缺了 import 直接失败；
- `groq` 保留，仅作为「ASR 未启用/模型未下载」时的占位后端；
- torch 不装（VAD 已关闭，coqui/funasr 不用）。

实测：334 MB / 依赖安装 7 分钟（阿里云索引），装进共享 `runtime/site-packages` 后，内置 CPython 3.12.10 + 生成的 conf.yaml 能把 OLVT 起到 `Uvicorn running on http://127.0.0.1:12399`，日志确认 `ASR: sherpa_onnx_asr` / `TTS: gpt_sovits_tts` / `VAD is disabled` / `Application startup complete`。

嵌入式 CPython 的三处坑（`runtime/sitecustomize.py` 已处理）：

1. `._pth` 模式下 `PYTHONPATH` 被忽略 → 读 `DHVW_PYTHONPATH`；
2. 脚本所在目录不进 `sys.path` → 手动插入 `os.getcwd()`，否则 `python run_server.py` 找不到同目录包；
3. `uv --target` 装的目录不是 site 目录，`.pth` 不生效（pywin32 就靠它注册 `win32/win32/lib`）→ 手动展开 `.pth` 里的相对路径，并把 `pywin32_system32` 加进 DLL 搜索路径。

## 运行环境放在哪（ADR-PC-019）

| 内容 | 位置 | 卸载 |
|---|---|---|
| 内置 CPython 运行时 | `<安装目录>\resources\runtime` | 删除 |
| 下载的组件（OLVT、依赖） | `<安装目录>\resources\components` | 删除 |
| 配置、日志、用户数据 | `%APPDATA%\DigitalHuman` | 保留 |

安装为 per-user（`perMachine: false`），安装目录在 `%LOCALAPPDATA%\Programs\DigitalHuman`，普通用户可写，所以组件下载不需要提权。只有安装目录不可写（企业收紧 ACL）时才回退到 `%APPDATA%\DigitalHuman\components`，并写日志说明。

实测：安装 → 下载组件到 `resources\components\olvt\1.2.1` → 卸载后安装目录整树消失（含组件），`%APPDATA%` 的 `config.db`/`logs` 保留。

## 组件下载（OLVT / ASR 模型）

OLVT 本体不随安装包，首次使用时从「组件」面板下载：

- 下载地址顺序：`ghfast.top` → `gh-proxy.com` → `ghproxy.net` → GitHub 直连；任一成功即停，全部失败在面板显示最后一个错误。
- 校验：最小体积（可选 sha256），解压后必须找到入口文件 `run_server.py`，否则判为失败。
- 落点：`%APPDATA%/DigitalHuman/components/olvt/<version>/`，与安装目录分离，卸载不删除。
- 覆盖下载源（企业镜像 / 内网离线包）：`config.shell.componentUrls = { "olvt": ["http://.../olvt.zip"] }`，支持 `{version}` 占位。
| 组件 | 内容 | 体积 | 来源 |
|---|---|---|---|
| `olvt` | OLVT 后端源包（含 `requirements.txt`） | ~10 MB | `Open-LLM-VTuber/Open-LLM-VTuber` v1.2.1 归档 |
| `asr-sensevoice` | SenseVoice 多语种 ASR 模型 | 229 MB | `k2-fsa/sherpa-onnx` asr-models 发布包 |

ASR 模型与既有实验环境一致（`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`，`model.int8.onnx` + `tokens.txt`），不随包，首次需要时下载到 `<安装目录>\resources\components\asr-sensevoice\2024-07-17`。

- 构建期下载（`fetch-runtime.mjs` / `fetch-uv.mjs` / `fetch-aria2.mjs` 走的 `scripts/lib/mirror.mjs`）在 `build/tools/aria2c.exe` 已存在时同样用它，去掉原来「整包读进内存」的单连接实现。
- 下载引擎是随包的 `resources/tools/aria2c.exe`（aria2 1.37.0，见 ADR-PC-024）：多连接分段（`-x8 --split=8`）、多镜像当同一文件的多 URI、失败自动重试，`.aria2` 控制文件每 5 s 落盘。找不到 exe 时自动回退 `fetch`（带 `Range` 续传），行为与旧版一致。
- 续传是「尽力」：`gh-proxy.com` / `ghfast.top` 目前对 `Range` 请求回 200（不支持分段），此时中断后只能整体重下；换成支持 `Range` 的源（GitHub 直连、自建镜像）即可接着下。要指定自定义 exe：`DHVW_ARIA2=<路径>`。
- 进度：`HEAD` 探 `content-length`，探不到用 aria2 摘要行里的总量；都没有（chunked 镜像）时进度条走不确定态动画，不伪造百分比。下载日志落在 `shell.jsonl` 的 `scope=download`（引擎、字节、耗时）。
- 本地验证过完整链路（下载 → 解压 → 去一层目录 → 入口校验 → 状态持久化 → 依赖安装），用本地 HTTP 服务喂了 6 MB 测试包；引擎单测 `node scripts/test-download.mjs`（镜像回退、进度回调、sha256 守卫），实测 OLVT 21.4 MB 经 `ghfast.top` 约 78 s。
- 依赖安装：组件带 `requirements.txt` 时，自动用随包的 `tools/uv.exe` 把依赖装进 `resources/runtime/site-packages`（单一 site-packages，ADR-PC-014），索引默认 `https://mirrors.aliyun.com/pypi/simple`，可用 `config.shell.pipIndex` 覆盖。实测 `httpx==0.28.1` 从下载到可 `import` 用时 1.8 s。

## 界面风格

全站按 `docs/design.md` 的**赛璐璐动画风**实现，落在 `apps/shell/src/renderer/styles.css` 的 CSS 变量上：

- 3px 墨线（`#1a1a2e`）包住每个元素，零圆角（徽标除外），平涂填充，杜绝渐变与模糊阴影。
- 阴影只有一层且无模糊：`4px 4px 0`，hover 扩到 `6px 6px 0`；过渡固定 `75ms linear`。
- 按下是挤压物理：`scale(1.1, 0.9)` 下沉，阴影归零，不是位移动画。
- 语义色固定：Red 主行动、Aqua 信息、Grass 成功、Sunset 强调；状态点用平涂方块而非发光点。
- 字体优先 Inter（900/700），本机缺失时回退 Arial Black / 微软雅黑；不引外链字体（ADR-PC-017）。
- `prefers-reduced-motion` 下关闭全部过渡与挤压。

新增界面元素必须复用这些变量，不要引入第二套圆角、渐变或动效时长。

## 页面布局（首页 / Agent / 配置）

顶栏中央是三个页签，切换只改 `App.tsx` 的 `tab` 状态，不重载窗口：

| 页 | 内容 |
|---|---|
| 首页 | 顶部横幅是**设备显示态二切**（总观 / 显现）——它切换的是设备屏幕，PC 只是下发 `display:set`，并以设备回传的 `digest.world.display` 为唯一确认；左侧舞台**常驻角色 Live2D**（本机静态服务 + pixi + Live2D 模型，与 OLVT 后端无关），右列是世界模式增强开关 + 设备状态机统计表（`dhvw:stats`）。 |
| Agent | 填写场景参数（类型/名称/种子/距离/额外要求）提交场景作业，右侧列出任务状态、阶段、告警与日志尾。 |
| 配置 | 改造前的全部内容：服务表（含开机自启/重启宿主/端点检测）、事件流、世界卡片、组件下载、网关配对条、日志面板。 |

约定：

- **PC 舞台不做显示态切换**：总观/显现是设备的状态（`state.display`），本机永远显示角色。按钮下发 `display:set {state}`，设备 6 s 内没把 `digest.world.display` 改成目标值就显示「设备未确认：固件可能尚未实现 display:set」，不假装成功；设备不在线时直接报「设备未连接」。
- 角色舞台资源在 `apps/shell/resources/live2d/`（页面 + pixi + pixi-live2d-display + `live2dcubismcore.min.js` + `models/mao_pro/runtime`），由主进程起一个**只绑 127.0.0.1 的临时 http 服务**提供（`file://` 下模型 JSON 会被跨源检查挡住）。骨架体积约 9.7 MB，打包经 `extraResources` 落在 `resources/live2d`。
- **boost 还不是生产行为**：只做界面态并写入 `config.db`（`boost.enabled`）后随配置下发，世界生产链路尚未消费它。文案里写明，不假装已生效。
- boost 是唯一带持续动效的控件（太阳黄底 + 斜向速度线扫过 + 脉冲指示点），`prefers-reduced-motion` 下停掉动效。
- 统计表只显示真实收到的字段：设备离线时档位/心跳显示 `—`，编排器不可达时整表标「不可达」，不做推算。
- 改界面后必须 `npm run audit:layout`（1020/900/760/640/520/420 六档全绿）并截图确认三个页签。

## 体积预算

安装包 **上限 500 MB**，`npm run pack` 出包后强制校验，超限直接失败（ADR-PC-018）。当前安装包约 117 MB，其中 Electron 内核约 110 MB、内置 Python 约 25 MB。模型权重不进安装包。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | 功能实现规划：模块、里程碑、对外契约、数据模型、验收、开放问题 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | PC 端架构决策记录（ADR-PC） |

**文档边界（硬规则）**：本仓库文档是 PC 端唯一事实来源。凡与 PC 端有关的结论，一律写在 `PC/docs/` 下，不跨仓库引用、不依赖外部文档成立。上层项目文档只作输入，不作依据；发现冲突以本仓库为准并在此记录。

## 工程约定

- **提交**：Conventional Commits，scope 用模块名，例如 `feat(supervisor): 子进程崩溃自动重启`、`docs(plan): 冻结对外状态契约`。
- **分支**：`main` 常绿；功能走短分支，合入前本地跑通冒烟。
- **版本**：语义化版本，PC 端独立打 tag（`pc-v0.1.0`），与设备端解耦。
- **日志**：单一出口，结构化字段（时间、级别、进程、trace id），GUI 可查。
- **配置**：落 SQLite，不外露可手改文件；上游 yaml 由外壳生成、不纳入版本库。
- **依赖**：上游代码只读引用，改动以补丁清单形式记录并可重放；不在上游目录内直接开发。
- **运行时版本**：Electron 固定 45.x（当前 45.2.3），升级必须过安装包与冒烟验证；密钥加解密只用 `safeStorage` 异步 API（同步版在 46 移除）。
- **模型**：只能使用 DeepSeek 系（当前 `deepseek-v4.1-flash`），配置层白名单校验；禁止 gpt-6 及同类高价模型，禁止跨模型自动降级（ADR-PC-016）。

## 许可证

待定（随发布形态定稿后补充）。第三方组件与模型许可随包保留原文。

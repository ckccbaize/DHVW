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
| 调用端点 / 模型 | 全局 LLM 端点，模型白名单只放行 `deepseek-v4.1-flash`（ADR-PC-016），非法值直接拒绝 |
| temperature | 0–2，越界拒绝 |
| API Key | DPAPI 加密后存 `secrets` 表；IPC 只返回 `hasKey` 布尔值，明文不出主进程，不进日志 |
| OLVT / TTS 端口 | `0` = 自动分配；固定端口被占用时自动回退到动态分配 |
| 启用 ASR | 关闭后不要求下载 SenseVoice 模型 |

实测：保存 → 读回一致；`secrets` 里是 64 字符 base64 密文（非明文）；日志中检索不到密钥；`gpt-6-astra` 与 `70000` 端口均被拒绝并返回中文错误。

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

实测（本地 OLVT 1.2.1 源码 + 组件目录结构 + 固定端口 12399）：

```
worker healthy  service=olvt  mode=tcp  ms=4439
http://127.0.0.1:12399/  → 200 <!doctype html>
conf: port 12399 / base_url https://codex.mintcat.work / model deepseek-v4.1-flash
      sense_voice …\components\asr-sensevoice\2024-07-17\model.int8.onnx
      api_url http://127.0.0.1:<tts 端口>/tts / vad_model null
override UA applied: true
```

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

- 本地验证过完整链路（下载 → 解压 → 去一层目录 → 入口校验 → 状态持久化 → 依赖安装），用本地 HTTP 服务喂了 6 MB 测试包。
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

# DHVW 虚拟生命舱 (Digital Human Virtual Warehouse)

[![Architecture](https://img.shields.io/badge/Architecture-PC%20Host%20%2B%20ARM%20Edge-blue.svg)](#系统架构)
[![PC Runtime](https://img.shields.io/badge/PC-Electron%2045%20%7C%20Python%203.12-brightgreen.svg)](#pc-主机端-pc)
[![ARM Runtime](https://img.shields.io/badge/ARM-RK3566%20%7C%20Go%20%7C%20Chromium%20Kiosk-orange.svg)](#arm-设备端-arm)
[![License](https://img.shields.io/badge/License-NonCommercial%20OpenSource-purple.svg)](#开源协议与鸣谢)

> **局域网协同的陪伴式数字人虚拟生命系统**。  
> 核心计算与大模型运行在 PC 端（核心脑），轻量级表现层与生活自治引擎常驻在 ARM 硬件设备（生命舱）。

---

## 📖 核心理念与三条硬约束

1. **总观常显（默认态）**：
   - 设备开机即进入上帝视角像素家园地图与漫游生活流。
   - **完全离线自闭环**：所有地图、角色动作、作息调度由设备本地资源包承载，**PC 关机不影响设备出画面与生活运转**。
2. **显现交互（互斥态）**：
   - 当用户与数字人近距离互动时切换为全屏 Live2D + 语音对话模式。
   - **主机可达是前置条件**：显现形态依赖 PC 端的 ASR/TTS/LLM 推理；若 PC 离线，设备绝不强行进入白屏或残缺态，仅弹出轻量提示气泡并保持总观。
3. **世界双档（主机优先）**：
   - **主机档（Host Tier）**：PC 在线且算力空闲时，由云端/本地大模型产出高阶世界事件、场景扩展种子与背景图 Prompt。
   - **端侧档（Edge Tier）**：PC 离线或不可达时，ARM 设备的 Web Worker 状态机与文法生成器（`AssetForge`）以 **0 Token、0 GPU** 消耗自主演变日常剧情与轻量资产。

---

## 🏗️ 整体架构与代码库划分

仓库采用清晰的协同架构，划分为主机端与设备端两大核心目录：

```
DHVW/
├── PC/                  # PC 主机端一体化软件（大脑与能力源）
│   ├── apps/shell/      # Electron 45 外壳 (TypeScript + React + Vite + Tailwind)
│   ├── services/
│   │   ├── host/        # Python 宿主服务 (dhvw_host，负责生命周期与 Job Object 清理)
│   │   └── orchestrator/# 核心编排服务 (dhvw_orchestrator，记忆/模式机/生活流/网关)
│   ├── local_ai/        # 本地大模型集成 (基于 llama.cpp / llama-server)
│   └── docs/            # PC 侧设计手册与开发规范
│
├── arm/                 # ARM 硬件终端软件（生命体与表现层）
│   ├── shell/           # Go 编写的轻量静态服务器 (127.0.0.1:8080，极低内存常驻)
│   ├── www/             # 前端运行时 (Canvas 2D 像素地图、Live2D 宿主、Web Workers)
│   │   ├── js/          # 核心生活状态机、网络路由与运行时调度
│   │   ├── workers/     # life.worker.js (自主作息调度) & forge.worker.js (端侧生成)
│   │   └── assets/      # 家园地图与角色精灵素材
│   ├── qq-openclaw/     # 可选的 QQ 伴生机器人插件通道
│   ├── deploy/          # Armbian / RK3566 部署脚本与 systemd 服务配置
│   └── docs/            # 设备端规格与协议契约
│
└── docs/                # 项目全景规划、地图场景规格与素材许可台账
```

---

## ⚡ 现有框架实现（相比原 Plan 的重点演进）

项目在持续演进中，结合真实硬件性能与实际体验，对早期规划做出了关键优化与落地增强：

* 🧠 **混合分层记忆引擎（Hybrid Memory）**：
  超越了简单的日志存储，在 PC 端实现了 `sqlite-vec` (bge-small-zh-v1.5 ONNX 模型) 向量检索 + SQLite FTS5 (trigram) 全文检索 + 艾宾浩斯时间遗忘衰减的三路融合排序，结合心情共鸣因子，具备自动事实提炼与语义取代能力。
* 🎭 **双轨大模型与人设工坊（Persona Studio）**：
  除兼容 OpenAI/DeepSeek 格式的云端 API 外，原生集成了 `llama-server` 本地量化大模型运行链路；支持在桌面 GUI 中通过人设工坊自由导入、导出与调整人设卡片、性格维度及语音音色。
* 🎨 **赛璐璐（Cel）视觉与端侧轻量化**：
  总观态采用 Canvas 2D 分层绘制与 BFS 寻路（`PathAgent`），零 WebGL 开销，即使在 RK3566 2GB RAM 极限环境下也能稳定以 60 FPS 流畅漫游；交互 UI 深度适配赛璐璐轻量主题。
* 🔒 **零配置安全局域网网关（LAN Gateway）**：
  PC 端自动签发 CA 证书并提供 HTTPS/WSS 反向代理，支持局域网设备扫描与一键配对，避免了繁琐的手工配置与局域网明文传输。
* 🤖 **QQ 伴生机器人（QQ-OpenClaw）**：
  实现了设备与移动端伴生互通，支持基于角色心情主动发消息、代词联网查百科与防机械化回复。

---

## 🚀 快速开始

### 1. PC 主机端开发与运行

**前置要求**：Windows 10/11 x64、Node.js 22+、Python 3.12、NVIDIA GPU（推荐，用于语音/本地模型）。

```bash
# 进入 PC 外壳工程
cd PC/apps/shell

# 1. 安装前端依赖
npm run setup

# 2. 编译并启动 PC 控制中心（同时调起 Python 编排服务）
npm run build
npm start

# 3. 构建独立 Windows 安装包（NSIS）
npm run dist
```

### 2. ARM 设备端开发与部署

**前置要求**：Linux (ARM64, 推荐 Armbian) 或开发机本地浏览器测试；Go 1.21+（编译壳）。

```bash
# 本地网页调试（模拟设备 8080 端口）
cd arm
npm install
npm run serve
# 访问浏览器: http://127.0.0.1:8080

# 交叉编译 ARM 静态服务壳
cd shell
sh build.sh   # 产物输出至 dist/dhvw-shell-linux-arm64

# 在 RK3566 设备上部署运行
sudo sh deploy/install.sh dist/dhvw-shell-linux-arm64
```

---

## 💻 硬件基线

| 硬件规格 | PC 主机端 | ARM 终端生命舱 |
|---|---|---|
| **推荐平台** | Windows 10/11 (x64) | RK3566 (Quad Cortex-A55, Armbian) |
| **内存限制** | 16 GB+ 推荐 | **2 GB RAM 定型硬约束** |
| **持久存储** | SSD | 32 GB eMMC |
| **显示方案** | 主屏幕显示管理控制台与人设工坊 | 1080p 竖屏 / 倒装显示 (Chromium Kiosk) |
| **网络要求** | 局域网互通 (Wi-Fi / 有线) | 局域网接入即可，不依赖公网端口映射 |

---

## 📜 许可证与致谢

- 本项目定位为非商用开源项目。
- 像素场景与地图体系借鉴并致谢 [ai-town](https://github.com/a16z-infra/ai-town) 及 [pixel-agents](https://github.com/antirez/pixel-agents)。
- 语音与对话能力基于 [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) 框架拓展定制。
- 素材来源与许可明细详见 [docs/ASSETS-LICENSE.md](docs/ASSETS-LICENSE.md)。

# 数字人虚拟仓 · 设备端（ARM）

RK3566（4×A55 / 2GB / 32G eMMC）+ Armbian + Chromium kiosk 上的设备端软件：
**离线只读壳 + 总观 + 端侧自治**。主机不在时照样出画面、照样过日子、照样产轻资产。

设计文档：[`docs/DEVICE-DESIGN.md`](docs/DEVICE-DESIGN.md)。上游唯一事实来源是仓库根的 `docs/PROJECT-PLAN.md`（§2.4 / §2.5 / §10）与 `docs/MAP-SCENE-DESIGN.md`。

## 它是什么

| 层 | 件 | 说明 |
|---|---|---|
| 离线壳 | `shell/`（Go 单文件） | `127.0.0.1:8080` 只读静态服务，ETag/304、无目录列表、SPA 回退、`/__health` |
| 页面 | `www/` | 总观（Canvas 2D 分层 + `PathAgent`）与显现（需主机）两态互斥 |
| 端侧引擎 | `www/workers/life.worker.js` | 作息/漫游/天气/短句/tick，`setInterval` 驱动（息屏不停） |
| 端侧生成 | `www/workers/forge.worker.js` | 剧情文法 / 背景合成 / 光照变体，`tier:edge`，0 token |
| 部署 | `deploy/` | systemd 单元、kiosk、禁 suspend、安装脚本 |

**设备端不跑 Python / Electron / Node**：只有静态壳二进制 + Chromium + 浏览器里的 JS/Worker。

## 快速开始

```bash
npm run serve     # http://127.0.0.1:8080
npm test          # 纯函数与契约测试
npm run verify    # 资源包完整性
npm run validate -- www/assets/scenes/home   # 场景包校验（§15 不变量）
# 核心机骨架自检页：http://127.0.0.1:8080/debug-core.html
```

设备端：

```bash
cd shell && sh build.sh                                  # dist/dhvw-shell-linux-arm64
# 设备先装 X/Chromium（Armbian 精简镜像默认无桌面）
sudo apt-get install -y xserver-xorg xinit x11-xserver-utils xserver-xorg-legacy chromium fonts-noto-cjk
sudo sh deploy/install.sh dist/dhvw-shell-linux-arm64     # 在设备上执行
curl -s http://127.0.0.1:8080/__health
# 屏幕倒装：kiosk.sh 用 xrandr --rotate inverted 输出 180°；X 由 dhvw-x.service 启动
```

## 三条硬约束（设备侧落点）

1. **总观常显**：页面/地图/角色/短句全在本地资源包，kiosk 指向 `127.0.0.1:8080`，**不请求 PC**（A14）。
2. **显现需主机**：主机不可达时点击/拨开关 **0 次进入**，只出气泡（A15）。
3. **世界双档、主机优先**：不可达才切端侧档，端侧档 **0 token / 0 GPU** 产 `tier:edge` 资产（A16）。

## 目录

```
docs/DEVICE-DESIGN.md   设备侧设计（范围/契约/状态机/预算/阻塞项）
docs/PC-DEV-HANDBOOK.md PC 侧开发需求手册（主线修正、通讯、数据契约、验收）
docs/UI-STYLE.md        设备 UI 风格（赛璐璐/像素字体/布局约束）
shell/                  离线只读静态壳（Go，交叉编译 arm64/armv7）
www/                    资源包：页面 + 模块 + Worker + 家园场景
deploy/                 systemd / kiosk / 禁休眠 / 安装
tools/                  serve / pack / verify
tests/                  node --test
```

# 设备端（ARM）开发内容

| 项 | 值 |
|---|---|
| 文档版本 | v0.1（2026-11-12） |
| 适用对象 | `arm/` 仓库：RK3566 / 2GB / Armbian / Chromium kiosk 上的设备端软件 |
| 上游依据 | `docs/PROJECT-PLAN.md` §1.1 / §1.3 / §2.1 / §2.4 / §2.5 / §2.6 / §10、`docs/MAP-SCENE-DESIGN.md` §1 / §2 / §8 / §9 |
| 维护方式 | 先改本文档，再改代码；与上游文档冲突时以上游为准并回来修本文 |

---

## 1. 定位：设备端到底要交什么

一句话：**设备端是一个全屏浏览器 + 一个本地只读壳**，负责"看见、生活、时间流逝"，并在主机不在时继续过日子、继续产轻资产。

| 设备端负责 | 设备端不负责 |
|---|---|
| 总观渲染（像素地图 + 她 + 气泡 + 角标），**不依赖主机** | LLM 对话、TTS 发声（主机） |
| 显示态切换（总观 ⇄ 显现）与 **A15 拒绝闸门** | Live2D 模型训练/转换（主机侧交付资源） |
| 端侧引擎：作息 / 漫游 / 天气 / 短句 / 事件流 | 记忆库 L0–L3（主机 `memory.db`） |
| 端侧轻资产：剧情文法 / 背景合成 / 光照变体（`tier:edge`） | 扩散模型出图、ComfyUI |
| 事件与资产回流（uuid 去重 + `clock_offset` 校时） | 世界·主机档生产（PC sidecar） |
| 离线壳、资源包、看门狗、禁休眠、息屏 | 桌面接管（RustDesk 在 PC 侧） |

**三条硬约束在设备侧的落点**（PROJECT-PLAN §1.1）：

1. **总观常显**（A14）：页面、地图、角色、短句全在本地资源包；kiosk 指向 `127.0.0.1:8080`，**不请求 PC**。断网 + 关主机 + 冷启动 ≤8s 出画面。
2. **显现需主机**（A15）：主机不可达时点击角色 / 拨开关 **0 次进入显现**，只出气泡，显示态不变。
3. **世界双档、主机优先**（A11/A16）：主机可达走主机档；不可达才切端侧档，端侧档 **0 token / 0 GPU** 继续产 `tier:edge` 资产。

**设备端默认不跑 Python、不跑 Electron、不跑 Node**（PROJECT-PLAN §2.1）。设备上只有：静态壳二进制 + Chromium + 浏览器里的 JS/Worker；§15 的可选 QQ Bot 例外，需 Node 22.14+。

---

## 2. 运行环境与进程

| 项 | 定稿 |
|---|---|
| 硬件 | RK3566（4×A55 / Mali-G52 2EE）、2GB LPDDR、32G eMMC、1080p |
| 系统 | Armbian（精简、无桌面环境，仅 X11 + Chromium） |
| 浏览器 | Chromium kiosk，`--app=http://127.0.0.1:8080`，禁用快捷键/光标/捏合缩放 |
| 本地壳 | `dhvw-shell`（Go 单文件静态服务），`127.0.0.1:8080`，只读，无目录列表 |
| 端侧引擎 | 两个 Web Worker：`life.worker`（tick，P0）、`forge.worker`（生成，随时让位） |
| 数据 | IndexedDB（`dhvw` 库：`events` 环形 2000 条 / `assets` 端侧产物 / `kv` 状态） |
| 内存预算 | 总观 120–180MB；端侧档增量 ≤100MB；显现 380–520MB（两态互斥） |
| 端口 | `8080`（本地回环，页面/静态壳）；`8081`（局域网，仅 `/__identity`、`/__pair`、`/__unpair`）。PC 侧 `8877`/`12393` 只在显现与世界·主机档被访问 |

```
systemd
├─ dhvw-shell.service     静态壳 :8080 + 局域网配对口 :8081（Restart=always，看门狗 ≤5s）
├─ dhvw-x.service         Xorg :0（tty1，本地 kiosk 专用；屏幕倒装时输出旋转 180°）
└─ dhvw-kiosk.service     Chromium kiosk（崩溃/白屏自动重启；Requires shell + X）
   ├─ 主线程：总观/显现视图、PathAgent、LifeStore、模式控制
   ├─ life.worker  ：tick 状态机 + 事件环形缓冲（IndexedDB）
   └─ forge.worker ：剧情文法 / 背景合成 / 光照变体（IndexedDB + 配额 LRU）
```

**为什么静态壳用 Go 而不是 Python/busybox**：设备端不允许 Python 运行时（§2.1）；busybox httpd 无法做 ETag/304、无目录列表、SPA 回退与资源包校验。Go 单文件交叉编译（`GOOS=linux GOARCH=arm64`）零依赖、体积 ~2MB、启动 <10ms。

---

## 3. 仓库结构

```
arm/
├─ docs/DEVICE-DESIGN.md        本文档
├─ shell/                       离线只读静态壳（Go）
│   ├─ main.go                  MIME / ETag / 304 / 无目录列表 / SPA 回退 / /__health
│   ├─ main_test.go
│   └─ build.sh                 交叉编译 arm64 / armv7
├─ www/                         资源包（部署到 /opt/dhvw/www）
│   ├─ index.html               总观 + 显现同页（两态互斥渲染）
│   ├─ manifest.json            资源包清单（sha256 + size），部署校验基准
│   ├─ config.json              主机地址/心跳/配额（设备侧唯一配置入口；`?host=` 首次会写入 localStorage `dhvw_host`，kiosk 无 query 时续连）
│   ├─ css/app.css
│   ├─ js/
│   │   ├─ app.js               启动、模式控制、装配
│   │   ├─ core/grid.js         intGrid 解析、BFS、热点推导
│   │   ├─ core/pathagent.js    位置模型（moveTo + 插值 + 纠偏）
│   │   ├─ core/lifestore.js    唯一视图数据源（订阅式）
│   │   ├─ core/clock.js        单调时钟 + clock_offset + 时段划分
│   │   ├─ core/light.js        光照档位映射（端侧与视图共用）
│   │   ├─ core/assetstore.js   资产优先级 + 配额淘汰（纯函数）
│   │   ├─ core/ringbuffer.js   事件环形缓冲（2000 条 + dropped 计数）
│   │   ├─ runtime/remote.js    RemoteRuntime（WS + 心跳 + 双证探测）
│   │   ├─ runtime/local.js     LocalRuntime（Worker + IndexedDB）
│   │   ├─ view/overview.js     总观：分层合成 + 角色 + 光罩
│   │   ├─ view/present.js      显现：四级前置 + 背景 + 字幕
│   │   ├─ view/hud.js          角标 / 连接点 / Agent 卡 / 菜单
│   │   ├─ view/bubble.js       气泡
│   │   ├─ view/switch.js       虚拟滑动开关 + DisplaySwitchSource
│   │   └─ forge/grammar.js     剧情文法（纯函数，可测）
│   ├─ workers/life.worker.js   端侧 tick 引擎
│   ├─ workers/forge.worker.js  端侧生成调度
│   └─ assets/scenes/home/      家园场景：home.png / home@2x.png / sprites.png / home.built.json
├─ deploy/
│   ├─ systemd/dhvw-shell.service
│   ├─ systemd/dhvw-x.service
│   ├─ systemd/dhvw-kiosk.service
│   ├─ chromium/dhvw-policy.json  关闭翻译气泡
│   ├─ logind/99-dhvw-nosleep.conf
│   ├─ sysctl/99-dhvw.conf      zram 友好 / 少写 eMMC
│   ├─ kiosk.sh
│   └─ install.sh               设备端安装（cp + systemctl enable）
├─ tools/
│   ├─ serve.mjs                开发用静态服务（等价于 dhvw-shell 的路径规则）
│   ├─ pack.mjs                 生成 manifest.json
│   └─ verify.mjs               资源包完整性校验
└─ tests/                       node --test（纯函数 + 契约）
```

---

## 4. 模块与任务映射

上游任务 ID 直接沿用，设备侧只实现标 **设备** 的项。

| 上游任务 | 设备侧实现 | 本仓库落点 | 状态 |
|---|---|---|---|
| M4-T2 | kiosk 自启、隐藏光标、禁快捷键 | `deploy/kiosk.sh` + `dhvw-kiosk.service` | 已实现 |
| M4-T3 | 看门狗：壳/浏览器崩溃重启 | systemd `Restart=always` + `/__health` | 已实现 |
| M4-T5 | zram / OOM 优先级 / 日志 tmpfs | `deploy/install.sh`（sysctl + tmpfiles 片段） | 已实现（参数待真机校准） |
| M11-T12 | **离线壳**：本地只读静态服务 + 资源包 + 清单校验 | `shell/`、`tools/pack.mjs`、`tools/verify.mjs` | 已实现 |
| M11-T2 | **总观视图**：场景层 + PathAgent + Agent 卡 + 档位角标 | `view/overview.js`、`view/hud.js` | 已实现 |
| M11-T3 | 显现视图：四级前置 + 背景供给链 | `view/present.js` | 已实现（Live2D 资源缺，走静态立绘降级） |
| M11-T10 | 虚拟滑动开关 + `DisplaySwitchSource` 抽象 | `view/switch.js` | 已实现（GPIO 实现留空） |
| M11-T11 | **端侧引擎**：tick、作息/漫游/天气、模板短句、事件流 | `workers/life.worker.js`、`core/ringbuffer.js` | 已实现 |
| M11-T13 | 事件回流：`clock_offset`、uuid 去重、`dropped` 上报 | `runtime/local.js`、`core/clock.js` | 已实现（合并侧在 PC） |
| M11-T15 | **主机不可达拦截**（A15） | `view/present.js` + `app.js` 闸门 | 已实现 |
| M11-T16 | 总观常显实测（A14） | `tools/serve.mjs` + 浏览器实测脚本 | 已实现（真机待测） |
| M11-T17 | `AssetForge` 抽取（两档共用） | 设备侧只落**端侧实例**：`forge/*`、`workers/forge.worker.js` | 部分（主机侧共用待 PC 侧抽取） |
| M11-T18 | 端侧剧情文法 | `js/forge/grammar.js` | 已实现 |
| M11-T19 | 端侧背景合成（960×540） | `workers/forge.worker.js` | 已实现 |
| M11-T20 | 端侧产出调度与配额（切片让位 / 闸门 / LRU） | `workers/forge.worker.js` | 已实现 |
| M11-T21 | `AssetStore`（host > edge > 模板）+ 显现消费 | `runtime/local.js` 资产索引 + `view/present.js` | 已实现（host 侧待接 PC） |
| M6-T4 | Canvas 2D 合成器 + 降帧（静止 8fps / 行走 30fps） | `view/overview.js` | 已实现 |
| M6-T8 | `PathAgent`：BFS + 插值 + 状态机 | `core/pathagent.js`、`core/grid.js` | 已实现 |
| M5-T2/T3 | 裁剪（无设置面板/历史/模型选择）、触摸适配 | `index.html` + `css/app.css` | 已实现 |
| — | 主机可达判定（心跳 5s / 丢失 >60s） | `runtime/remote.js` | 已实现 |

---

## 5. 数据契约

### 5.1 视图唯一数据源：`LifeStore`

视图**只订阅 `LifeStore`**，不知道数据来自 WS 还是 Worker（PROJECT-PLAN §2.6.4 / §10.7.4 ②）。

```js
state = {
  display: 'overview' | 'present',     // 显示态，二态互斥
  conn:    'up' | 'down',              // 主机可达（与设备有网无关）
  tier:    'idle' | 'host' | 'edge',   // 世界档位
  scene:   { id, grid:{w,h,cell}, layers:{terrain,light}, intGrid:Uint8Array,
             rooms, doors, props, hotspots, tier:'builtin'|'host'|'edge' },
  agent:   { gx, gy, px, py, dir:{x,y}, state:'idle'|'walk'|'act', frame },
  clock:   { day, minute, offsetMs, source:'device'|'host' },
  bubble:  { text, until } | null,
  agentCard: { platform, task, state, progress, elapsed } | null,
  assets:  { scene, plot, bg },        // 端侧产出计数
  stats:   { tickP95, fps, memMB? }
}
```

事件（瞬时，不进状态）：`bubble`、`event`（生活事件）、`asset`（新端侧资产）、`state`（档位/显示态迁移，供 `state_log`）。

### 5.2 主机 → 设备（`RemoteRuntime`，WS）

| 消息 | 载荷 | 前端行为 |
|---|---|---|
| `hello` | `{host_id, t_server, tts, live2d, world_tier}` | 置 `conn=up`、校时、更新 Agent 卡 |
| `state:overview` | `{work_tier, conn_state, pos_checksum, clock}` | 5s 一次，**不承载位置轨迹**；`pos_checksum` 偏差 >1 格才吸附 |
| `moveTo` | `{targetGrid, path[], speed, t0}` | 事件式；`PathAgent` 本地插值 |
| `switchScene` | `{scene_id, transition, from_door, to_door, t0}` | 预取 → 淡出 200ms → 换图 → 淡入 200ms |
| `say` | `{text, ttl}` | 气泡 |
| `tier` | `{value}` | 角标「世界·主机 / 世界·本地」 |
| `present:grant` / `present:deny` | `{reason}` | 显现闸门结果 |

设备 → 主机：`hello`、`heartbeat`（5s）、`events:batch`（回流，≤200 条/批）、`assets:manifest`（`tier:edge` 清单）、`present:request`、`world:stop`。

> **PC 侧 orchestrator 尚未实现该契约**（M11-T1/T13）。设备端按此契约编码，主机不可达是**默认路径**，因此契约未落地不阻塞设备侧开发与验收（A14/A15/A16 全部在"主机不可达"下验收）。

### 5.3 端侧事件（`life.worker` → 主线程 → IndexedDB）

```js
{ uuid, src:'device', t_local, t_corrected, kind, payload }
// kind ∈ {tick, enter, move, act, say, weather, sleep, wake, forge_ok, forge_fail, dropped}
```

- 环形缓冲 **2000 条**，满则覆盖最旧并 `dropped++`（恢复时上报）。
- **绝不信任设备绝对时间**：`t_corrected = t_local + clock_offset`，`clock_offset` 由 `hello.t_server` 计算并在每次重连刷新。
- 端侧**只追加**，不改写任何已存在记忆（L0–L3 在主机）。

### 5.4 端侧资产（`tier:edge`）

```js
{ id, kind:'scene'|'plot'|'bg', tier:'edge', origin:'forge-procedural'|'forge-grammar',
  seed, created_at, consumed_at, size, blob|text, meta }
```

- 配额 **≤500MB**，超限按 LRU 淘汰**最久未消费的 edge 资产**；**永不淘汰 host**（设备侧根本没有 host 文件，天然满足）。
- 消费优先级：背景 `host > edge > 场景截图 > 纯色`；场景 `host > edge > 内置模板`。

---

## 6. 状态机（设备侧实现口径）

```
显示态：  总观 ⇄ 显现           （两态互斥渲染，不共存）
主机可达：up ⇄ down             （心跳 5s；丢失 >60s 判 down；WS + HTTP 双证）
世界档位：idle / host / edge    （设备侧只在 down 时把档位置 edge）
```

| 迁移 | 触发 | 守卫 | 设备侧动作 |
|---|---|---|---|
| 总观 → 显现 | 点角色 / 开关 / 语音 | **`conn==='up'`** + TTS 探活 ≤300ms + Live2D 资源 | 停世界（`world:stop` + 挂起 worker）→ 加载背景 → 显现 |
| 总观 → 显现（`conn==='down'`） | 同上 | 不满足 | **拒绝**：气泡「主机不在，我听不见」（≤3s），显示态不变（A15） |
| 显现 → 总观 | 开关拨回 / 90s 无互动 / **主机丢失 >10s** | — | 卸载显现层、恢复 worker、重建总观（≤400ms） |
| 空闲 → 端侧档 | 心跳丢失 >60s（双证） | 本地资源包完整 | 挂 LocalRuntime、启动 `forge` 队列、角标「世界·本地」 |
| 端侧档 → 空闲 | 主机恢复后回流完成 / 手动省电 | — | 回流事件与资产 → 停 forge → 角标回「世界·主机」或空 |

**工程约束**（PROJECT-PLAN §10.3）：

- 显示态切换后 **20s 滞回**；世界最短驻留 10min。
- **抢占优先**：桌面接管 > 显现 > 世界。设备侧只感知"显现"与"世界"，接管由主机下发 `world:stop` + 挂件态。
- 状态**分别持久化**（`localStorage` 的 `display/conn/tier`），重启一律 = 总观 + 空闲；端侧事件缓冲保留不丢。

---

## 7. 端侧引擎（`life.worker`）

| 项 | 定稿 |
|---|---|
| tick 周期 | 有人互动 8–30fps 渲染；无互动 60s → 1fps；无互动 10min → 息屏，**1 tick/min** |
| 时钟 | **`setInterval` 驱动，不依赖 `rAF`**（息屏即停），tick 内用单调时钟推进 `day/minute` |
| 作息 | `sleep 23:00–07:00 / wake 07–08 / morning 08–11 / noon 11–13 / afternoon 13–18 / evening 18–22 / night 22–23` |
| 行为 | 每个 phase 映射到「房间 + 动作 + 目标道具」，从 `home.built.json` 的 props 推导热点（道具相邻可走格），BFS 走过去，到达后 `act` 并出短句 |
| 天气 | 本地种子（`day` → 晴/阴/雨/雪/雾/暴风雨，一天一种），只影响光罩与短句，不发请求 |
| 短句 | 预置池（按 phase/天气/房间分桶，≥60 条）+ 变量填充；**24h 去重** |
| 预算 | 单 tick ≤8ms（P95），内存增量 ≤100MB（含 forge） |
| 崩溃 | 主线程看门狗 ≤2s 重建，事件缓冲不丢，从 `last_tick` 续 |

**短句是本地素材，不是"假对话"**：它只用于气泡与端侧剧情文法的输入；端侧**永不产出对话台词**（§10.7.2「端侧不能做任何 LLM 对话」）。

---

## 8. 端侧轻资产（`forge.worker`）

| 产物 | 做法 | 闸门 | 日上限 |
|---|---|---|---|
| **剧情** | 文法：`时间锚点 + 状态 + 动作序列 + 因果收尾`，30–80 字，模板 × 变量 × 规则，24h 去重 | 非空 / 含时间锚点 / 30–80 字 / 24h 不重复 | 8 篇 |
| **背景** | Canvas 分层合成 960×540（天空渐变 + 远景剪影 + 地面 + 天气层 + 时间色调）→ WebP | 尺寸 ≥960×540 / 非单色（像素方差）/ 体积上限 | 4 张 |

**调度（不许抢生活 tick）**：`forge` 只在 ①息屏 ②无互动 60s 后的 1fps 时段 ③life tick 空闲 时跑；单任务切片 ≤5s，片间检查让位标志；收到「进显现 / 出端侧档 / 用户触摸」立即挂起，**队列保留不丢**。

**明确不做**：LLM 对话、TTS、扩散模型出图、操作主机 agent、写记忆库 L0–L3、产 `tier:host` 资产。

> **地图生成已移除（2026-11-14 废案）**：ARM 不再生成户型、摆放家具或烘焙地图；地图统一由 PC 产出侧生成，设备只加载 `assets/scenes/<id>/` 场景包。`forge` 只保留剧情文法（`forge/grammar.js`）。

---

## 9. 离线壳与资源包

| 项 | 定稿 |
|---|---|
| 服务 | `dhvw-shell -addr 127.0.0.1:8080 -pair-addr 0.0.0.0:8081 -root /opt/dhvw/www`；静态只读，配对口只写 `data/host.json` |
| 开发对照 | `tools/serve.mjs` 路径规则与壳一致，但**一律 `no-cache`**；壳才对 `/js/`、`/assets/` 发 `immutable`（否则改完模块刷新仍拿旧文件） |
| 路径规则 | 拒绝 `..`/绝对路径/符号链接逃逸；**无目录列表**；无扩展名路径回退 `index.html`（SPA） |
| 缓存 | `index.html` / `manifest.json` / `config.json`：`no-cache` + ETag；`/assets/` 与 `/js/`：`max-age=31536000, immutable`（资源包随版本整体替换） |
| 校验 | 启动时读 `manifest.json`，校验缺失/尺寸不符并记日志；`/__health` 返回 `{ok, files, missing[], uptime, version}` |
| 冷启动 | 壳 <10ms 启动；页面首帧 ≤8s（A14），资源包 ≤300MB |
| 安全 | 仅监听回环；`http://127.0.0.1` 属 secure context，`getUserMedia` 可用，**设备端不必装根证书**（§10.7.4 ①） |

---

## 10. 部署与运维

| 件 | 内容 |
|---|---|
| `deploy/install.sh` | 复制 `www/` → `/opt/dhvw/www`、二进制 → `/usr/local/bin/`、units → `/etc/systemd/system/`、`systemctl enable --now` |
| `dhvw-shell.service` | `Restart=always`、`RestartSec=2`、`MemoryMax=64M`、`ProtectSystem=strict`、`ReadOnlyPaths=/opt/dhvw/www` |
| `dhvw-x.service` | `Xorg :0 -ac -nolisten tcp -keeptty vt1`，`PAMName=login` 建立 logind 会话；`TTYPath=/dev/tty1`；`Restart=always`；`ExecStartPost` 写 `fb0/blank=0` 并 `xset -dpms` / `xset dpms 0 0 0`，避免面板黑屏 |
| `dhvw-kiosk.service` | `Requires=`/`After=` shell 与 X；`ExecStartPre` 检查 `/__health`；`Restart=always`；`LANG=zh_CN.UTF-8` |
| `dhvw-display.service` | 常亮：每 5s `xset s off / noblank / s 0 0 / -dpms / dpms 0 0 0`，并写 `fb0/blank=0`；加触摸屏后停用即可恢复息屏 |
| `kiosk.sh` | 等 connected 输出后 `xrandr --output <connected> --rotate inverted`（设备屏倒装，180°），再 `xset s off / s noblank / s 0 0 / dpms force on / -dpms / dpms 0 0 0`；延迟用 `xdotool mousemove` 触发一次输入事件唤醒面板；最后 `--kiosk --start-fullscreen --window-size=1920,1080 --app=http://127.0.0.1:8080 --noerrdialogs --disable-infobars --disable-pinch --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required --lang=zh-CN --disable-translate --disable-features=Translate,TranslateUI,MediaRouter` |
| `chromium/dhvw-policy.json` | `TranslateEnabled=false`，安装到 `/etc/chromium/policies/managed/`，避免 kiosk 弹出翻译条 |
| `99-dhvw-nosleep.conf` | `HandleLidSwitch=ignore`、`IdleAction=ignore`（**只关显示层，不进 suspend**，否则 JS tick 停摆） |
| 息屏 | 页面 `#dim` 遮罩；**不要**用 DPMS 关屏（`fb0/blank=4` 会导致整块面板黑屏且唤醒不稳定） |

### 10.1 网关配对与 CA 信任

设备端不再需要输入配对码或改 URL。PC 侧「配对设备」对话框：

1. **本机浏览器测试**：点「一键配对」生成 token，点「在浏览器打开」即可用任意浏览器打开 PC 内置的 ARM 页面（`arm-preview` 服务根路径已改为 `index.html`）。
2. **ARM 设备**：点「扫描设备」，PC 扫描本机所在 `/24` 私网的 `8081` 端口，列出 `dhvw-arm` 设备；点「配对这台」后 PC 直接签发 token 并 POST 到设备 `http://<arm>:8081/__pair`。
3. 设备端 `dhvw-shell` 把地址写入 `/opt/dhvw/data/host.json`；页面轮询 `/__host`，3 秒内自动刷新并连接，无需在 ARM 上做任何设置。

设备端配对接口（只允许私网来源）：

```text
GET  http://<arm>:8081/__identity   → {ok, app:"dhvw-arm", name, version, paired}
POST http://<arm>:8081/__pair       → {wsUrl, name} 写 host.json
POST http://<arm>:8081/__unpair     → 删除 host.json
GET  http://127.0.0.1:8080/__host   → 页面读取当前配对地址
```

CA 信任仍需一次性导入（设备端）：

```bash
sudo apt-get install -y libnss3-tools
sudo install -d -o dhvw -g dhvw /home/dhvw/.pki/nssdb
sudo certutil -d sql:/home/dhvw/.pki/nssdb -A -t "C,," -n dhvw-gateway -i /path/to/ca.crt.pem
```

验证：PC 侧 `GET /orchestrator/health?token=<token>` 返回 `device.connected=true`。

---

## 11. 性能预算与验收映射

| 编号 | 指标 | 设备侧实现口径 | 测法 |
|---|---|---|---|
| A4 | 常驻内存 <1.6GB | 总观 120–180MB；端侧档 +≤100MB | 真机 `free -m` |
| A10 | 显现 ≤1.5s 热 / ≤2.5s 冷；回总观 ≤400ms；开关 ≤200ms | 总观层常驻、显现层按需加载/卸载 | 端侧打点 20 次 P95 |
| A13 | 主机消失 60s 内接管不白屏；8h 不断档 | `conn` 判定 + LocalRuntime 接管 + `setInterval` tick | 断电实验 + 事件计数 |
| A14 | 冷启动 ≤8s；24h 无白屏；**不建 WebGL** | 静态壳 + 预烘焙 PNG + Canvas 2D | 冷启动打点 + 24h 录屏 + `about:gpu` |
| A15 | 不可达时 20/20 拒绝并出气泡 | `present.js` 第一道闸门 | 自动化点击 + `state_log` |
| A16 | 24h 产出 场景≥4 / 剧情≥6 / 背景≥3；tick P95 ≤8ms；0 网络请求 | `forge.worker` 闸门 + 配额 | `outbox` 清单 + 帧率打点 + 抓包 |
| A16b | 只有 edge 资产时显现可出背景 ≤800ms；host 优先 | `AssetStore` 优先级 | 场景脚本 |

**设备侧自检**：`npm test`（纯函数与契约）、`npm run verify`（资源包完整性）、浏览器实测（总观渲染 / 断主机 / 拒绝显现 / forge 产出）。

---

## 12. 未决与阻塞

| # | 项 | 影响 | 现状 |
|---|---|---|---|
| D1 | **Live2D 模型资源**（人设统一） | 显现只能走"静态立绘 + 字幕"降级（A10 允许） | 阻塞在资源交付；代码已按降级路径实现 |
| D2 | **tileset 烘焙管线（M6-T3/T11）** | 端侧无法生成"新地图"，只能做光照变体 | 阻塞在美术管线；`MAP-SCENE-DESIGN.md` §5 生成器需 tileset 输入 |
| D3 | **PC orchestrator 契约未实现（M11-T1/T13）** | `RemoteRuntime` 无对端；默认走 `conn=down` | 不阻塞设备侧验收（A14/A15/A16 都在不可达下验收） |
| D4 | 滑动开关硬件形态（GPIO / 霍尔） | 只有虚拟开关 | `DisplaySwitchSource` 已抽象，`gpio` 实现留空 |
| D5 | 真机功耗/内存校准 | 预算数字为设计值 | 需 RK3566 实测（M11-T14/T16） |
| D6 | 息屏实现依赖 X11（`xset`） | Wayland 下需换 `wlr-randr`/DPMS 方案 | 当前按 Armbian + X11 定稿 |

---

## 13. 开发与验证

```bash
# 本地开发（Windows/任意平台，Node 20+）
npm run serve            # http://127.0.0.1:8080（开发服务，no-cache）
npm test                 # node --test tests/*.test.mjs（31 项）
npm run pack             # 重建 www/manifest.json
npm run verify           # 校验资源包

# 离线壳
cd shell && go test ./... && sh build.sh     # 产出 dist/dhvw-shell-linux-arm64 / -armv7

# 设备端安装（在设备上；先装 X/Chromium）
sudo apt-get install -y xserver-xorg xinit x11-xserver-utils xserver-xorg-legacy chromium fonts-noto-cjk xdotool
sudo sh deploy/install.sh /path/to/dist/dhvw-shell-linux-arm64
systemctl status dhvw-shell dhvw-x dhvw-kiosk
curl -s http://127.0.0.1:8080/__health
```

---

## 14. 实测记录（v0.1，2026-11-12）

环境：Windows 11 / Node 24.19 / Go 1.26.5 / Chromium（headless，1280×720）。真机（RK3566）尚未测，标注为待测。

| 项 | 方法 | 结果 |
|---|---|---|
| 总观出画面 | Go 壳（`:8082`）加载 `www/`，无主机 | 通过：地图 + 角色 + HUD 渲染，`conn=down`、角标「世界·本地」、8fps（静止） |
| **A15 拒绝显现** | 点击角色 20 次 + 拨开关 | 通过：`refused=20`，`display` 始终 `overview`，`#present` 始终隐藏；开关 `.bounce` 回弹 |
| 显现进入（模拟主机可达） | `forceConn('up')` → `requestPresent()` | 通过：显示态切 `present`，背景取 `tier:edge` 的 WebP，提示「Live2D 资源未就绪 · 静态立绘模式」；退出回总观 |
| 点击寻路 | 点起居室地板 | 通过：`moveTo` 目标 (5,12)，BFS 13 格，插值连续行走 |
| **端侧轻资产** | `forge.worker` 入队 plot/bg/scene | 通过：剧情 30–80 字带时间锚点、背景 960×540 WebP（方差 357）、场景 640×480 WebP（dusk 光照变体），全部 `tier:edge` + `origin` |
| 端侧自动调度 | 活跃度转 idle 后 tick | 通过：非活跃期自动入队，活跃期不入队（`forge` 不抢生活） |
| 事件流 | life tick → IndexedDB | 通过：`wake/enter/act/say` 事件带 `uuid` + `t_corrected`（`t_local + clock_offset`） |
| **A14 不建 WebGL** | 注入 `getContext` 探针后加载 | 通过：仅 `2d`（2 次调用 / 1 个 canvas），无 webgl/webgl2 |
| 壳行为 | curl | 通过：`/__health` 报资源包 24 文件 0 缺失；`/js/*` `immutable`；`index.html` `no-cache`；ETag→304；`../` 越界 404；目录 404；缺失 `.js` 404；SPA 回退 200；POST 405 |
| 单测 | `npm test`（31 项）+ `go test` | 通过：grid/pathagent/clock/ringbuffer/assetstore/grammar/remote/local 全绿 |
| 交叉编译 | `sh shell/build.sh` | 通过：`dhvw-shell-linux-arm64` 5.7MB、`-armv7` 6.0MB（CGO 关闭） |

**未验证（真机待测）**：A4 内存、A10 切换耗时、A13 8h 长稳与息屏功耗、A16 真机 tick P95 与烘焙耗时、1080p 实际观感（当前 20×15 场景在 16:9 屏上左右留黑边，属资源比例而非渲染问题）。

---

## 15. 可选扩展：4–8GB 设备的 QQ 官方 Bot 互动融合（v0.2）

> 适用对象：4–8GB 内存版设备；**默认关闭（`config.json: qqBot.enabled=false` 且 `/etc/dhvw/qqbot.json: enabled=false`）**，关闭时完全退回轻量基线、0 额外进程与内存开销。

### 15.1 基于 `openclaw-snowluma` 直接魔改与合规入口（Node.js 22.14+/24 ESM）

* **复用成功架构而非闭门造车**：在 `arm/qq-openclaw/` 直接基于 `openclaw-snowluma@0.9.0` 源码魔改，保留其经过验证的双计时器消息聚合防抖（`aggregator.js`：800ms debounce + 3000ms maxWindow + 历史缓冲与消化）、Magic-Byte 图像嗅探与 SSRF 校验（`image.js`）、Markdown 拍平（`markdown-text.js`）、多段发送调度（`dispatch.js` / `outbound.js`）与自发消息追踪（`gateway.js`），零第三方 npm 运行时依赖（直接使用 Node 24 原生 `fetch` 与 `WebSocket`）。
* **合规取代**：删除 `@snowluma/sdk`（NTQQ 个人号注入协议），在 `src/qq-official-client.js` 中替换为 **QQ 开放平台官方 Bot APIv2**（`AppID + ClientSecret` 换取 `access_token`，WebSocket Gateway `intents = 1 << 25`）。
* **一期范围**：仅开放 **单聊（`C2C_MESSAGE_CREATE`）+ 多模态（入站图片经魔数校验与视觉输入 / 附件元信息；出站纯文本 `msg_type=0` + `/v2/users/{openid}/files` 上传拿 `file_info` 发 `msg_type=7`）**；支持 `ownerOpenId` / `allowOpenIds` 白名单与 `MsgDedupRing(500)` 去重。
* **进程与凭证边界**：以可选 systemd 单元 `dhvw-qqbot.service` 运行 `node /opt/dhvw/qq-openclaw/dist/dhvw-server.js -config /etc/dhvw/qqbot.json`（`MemoryMax=512M`），仅监听回环桥接 `ws://127.0.0.1:8088/qq/ws` 与 `GET /__qq/health`；`appId`/`clientSecret` 存放在 `/etc/dhvw/qqbot.json`（`0640 root:dhvw`），不写进前端静态 `www/config.json`。`dhvw-shell` 保持只读静态壳定位，仅将 `/__llm/chat/completions` 请求体上限由 1MB 放宽至 8MB 以容纳多模态图片。

### 15.2 “活人味”与世界融合机制

1. **真实对话流水线**：复用 `dispatch.js` + `aggregator.js`，按 `user_openid` 合并碎消息、维护跨轮历史摘要，由 `dhvw-runtime.js` 注入实时 `clock/phase`、`weather`、`place/room`、`agent.act`、心情四维与 `band`、PC/本地回忆与黑话笔记。
2. **自然决策与拟真节奏**：支持 `reply_mode: "reply" | "short" | "skip"`（适时少打扰或简短回应）、Markdown 拍平（`markdownToText()`）、1–3 段拆句间隔发送（同一 `msg_id` 递增 `msg_seq`），以及遇到陌生网络热词时经 `dhvw-shell` `/__search` 自动检索习得。
3. **图片表情包库（偷图 + 情绪挑图发送，`sticker-store.js`）**：支持从入站图片结合同轮视觉理解自动去重“偷图”并打上情绪/含义标签（或直放图包目录 `<stateDir>/stickers/` 扫描建库）；在对话与主动发起时按情绪与语境筛出候选表情包供模型选择 `sticker_id`（支持文+图混发或 `sticker_only` 纯表情斗图，受 `eagerness` 积极度门控防刷屏），经 `QQOfficialClient.uploadC2CImage` 读取本地文件转 base64 上传并以 `msg_type=7` 发送。
3. **心情指数与生活事件驱动的多样化主动发起（`dhvw-proactive.js`）**：
   * 触发器涵盖 `mood_lonely`（社交欲高）、`mood_low`（低愉悦求安慰）、`mood_excited`（兴奋分享）、`weather_shift`（雨/雪/雷暴）、`world_event`（写完日记周记 / 上网浏览 / 出门或回家 / `bg_ready` 新画作可附图）、`thread_resurface`（隔段时间重提未完线头）。
   * 优先复用 60 分钟被动单聊窗口（`msg_id` + 递增 `msg_seq <= 4`）；超窗时仅在 `proactive` 允许且未达冷却/日上限时发合规主动消息，被平台拒绝则通过 `qq:world:feedback` 降级为屏显总观气泡。
4. **互动反哺**：每次单聊/消化会回推 `qq:world:feedback`，在前端更新心情四维、弹总观气泡、触发角色微动作、写入 `eventLog` 并在有新事实时回流记忆库。

### 15.3 PC 向量记忆库（`memory.db`）整合

* **在线优先语义 + 离线降级**：QQ 对话与主动发起前统一经 `qq:memory:query` 向前端 `qq-adapter` 查询记忆；PC 在线时发 `memory:query`（携带 `mood` 与 `include_l0: true`）走 `vec0 + FTS5 + Ebbinghaus + _mood_boost` 混合检索并附带 L0 核心事实；主机离线或超时（350ms）自动降级为设备 `localMemory` bigram 检索与本地 L0 缓存。
* **对话事实回流**：单聊消化器（digest）与对话即时抽取的 L0/L1/L2 候选事实通过 `qq:world:feedback` 写入设备 `localMemory`，主机在线时再经 `facts:candidates` 推回 PC 向量化落库，实现“显现 / 总观 / QQ”三端共享同一人格与记忆。

### 15.2.1 显现渲染位置（D 方案）

- **ARM 本机**：只显示静态立绘 + 字幕，不加载 OLVT/Live2D，避免 2GB 设备 OOM。
- **手机/电脑**：同一局域网打开 PC 的「设备配对 → 本机浏览器测试 → 复制链接」，链接形如
  `http://<PC-LAN-IP>:<port>/?host=wss://...&remote=1`。页面在手机/电脑上运行，`remote=1`
  让 `app.js` 加载 OLVT iframe，Live2D、聊天、语音都用手机/电脑算力，ARM 不参与渲染。
- **安全边界**：链接里带网关 token；只在可信局域网分享。ARM 静态页不请求 OLVT。

### 15.3 部署与排障（真机）

QQ Bot 默认关闭；确认 `/etc/dhvw/qqbot.json` 存在且 `enabled=true` 后，`dhvw-shell` 的 `/__qq/config` 会拉起服务。

```bash
# Node 22.14+（Debian trixie 自带 nodejs 20 太旧，用官方 arm64 包）
curl -L -o /tmp/node22.tar.xz https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-arm64.tar.xz
mkdir -p /opt/node22 && tar -xJf /tmp/node22.tar.xz -C /opt/node22 --strip-components=1
ln -sf /opt/node22/bin/node /usr/local/bin/node

# 组件与配置
tar -xzf qq-openclaw.tar.gz -C /opt/dhvw/qq-openclaw --strip-components=1
install -m 0640 -o root -g dhvw qqbot.json /etc/dhvw/qqbot.json
systemctl enable --now dhvw-qqbot
curl -s http://127.0.0.1:8088/__qq/health
```

常见故障：

| 现象 | 原因 | 处理 |
|---|---|---|
| `dhvw-qqbot` inactive / `No entries` | 组件未部署或 `/etc/dhvw/qqbot.json` 不存在 | 部署 `qq-openclaw` 与配置，`systemctl enable --now` |
| 每分钟重启，日志 `LLM 未配置 (baseUrl/model)` | ARM 页面收到 `llm:config` 后没同步给本地 QQ 桥 | 已修 `app.js`：`llm:config` 更新 `cfg.llm` 并调用 `pushQqLlmConfig()` |
| `connected=false` 但进程 active | 页面未启动本地 QQ 桥 | 确认 `boost:config` 或 `qqbot:config` 已到达，`/__qq/health` 应返回 `connected=true` |
| `QQ API ... 40034122 召回消息已达区间上限` | QQ 平台主动消息配额/召回限制，不是内存 | 降低主动频率或等待配额恢复；入站对话不受影响 |
| 内存不足 | 实测 QQ 服务约 30MB RSS，`MemoryMax=512M` 足够 | 不是内存问题；先看 `journalctl -u dhvw-qqbot` |
| `[OpenClaw] Error: TypeError: fetch failed` | LLM 端点瞬时断连/超时 | 已加 3 次重试与 `cause` 日志；主动消息 tick 异常只跳过本轮，不再退出进程 |
| 切显现后 Chromium 被 OOM killer 杀 | OLVT Live2D 纹理 4096/8192（单张 8192² RGBA 约 256MB），叠加 onnxruntime VAD worker 1GB+ | 模型纹理降到 1024/2048；ARM iframe 禁用音频 `getUserMedia`，不创建 MicVAD/ORT；`model3.json` no-store |
| 2GB 设备显现直接静态立绘 | 设备本机（`127.0.0.1`/`localhost`）一律不加载 OLVT iframe，避免整机 OOM | 静态立绘 + 字幕仍可退出回总观 |
| 手机/电脑要完整 Live2D | 远程打开时 `?remote=1` 或主机名非回环，`app.js` 才加载 OLVT iframe | 手机/电脑用自己的算力渲染；ARM 屏幕仍是静态立绘 |
| `GL_OUT_OF_MEMORY` / `DRM_IOCTL_PANFROST_CREATE_BO failed` | RK3566 CMA 紧张，Xorg 在多次 Chromium 崩溃后 RSS 可涨到 500MB+ | 纹理降到 1024；必要时重启 `dhvw-x` 释放 Xorg 泄漏；不要反复切显现压测 |

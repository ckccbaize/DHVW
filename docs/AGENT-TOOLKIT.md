# Agent 工具包（产出侧）

> 状态：v0.1（2026-11-12）。回答两个问题：**这些工具是给谁用的**、**未来写 ARM 侧时必须补上什么**。
> 关联：`docs/CONTENT-CONTRACT.md`、`docs/MAP-SCENE-DESIGN.md` §15、`docs/DEV-PLAN.md` T 组。

---

## 1. 定位

**是 agent 的工具包，不是设备运行时。**

- 使用者：**产出 agent**（PC agent 与 ARM agent）在"生成/打包/提交"阶段调用；
- 运行位置：**产出 agent 自己的工作流里**（Node 20+），生成后、打包前；
- **安装与运行阶段不做内容校验**：`install.sh` 只负责把包装到设备，页面只消费已校验的包。

一句话：**T1 是"产出 agent 交付前的自检闸门"，不是安装步骤，也不是页面功能。**

> 2026-11-12 修订（需求方口径）：**检测放在产出 agent 中**。
> 因此取消浏览器版校验器（T1b），也**不把校验放进 `install.sh`**；安装只做部署。

### 1.1 三个阶段

| 阶段 | 谁做 | 做什么 | 是否校验内容 |
|---|---|---|---|
| 产出 | PC agent / ARM agent | 生成 → **T1 自检** → `pack` + `verify` → 交付 | ✅ 唯一校验点 |
| 安装 | `deploy/install.sh` | 复制 `www/` → `/opt/dhvw/www`、装二进制与 systemd、enable 服务 | ❌ 不校验 |
| 运行 | 设备（Chromium + Go 壳） | 加载包；`/__health` 只报文件缺失/尺寸（完整性，不是规则校验） | ❌ 不校验规则 |

## 2. 工具清单与运行位置

| ID | 工具 | 运行位置 | 使用者 | 状态 |
|---|---|---|---|---|
| T1 | `tools/validate-scene.mjs` | **产出 agent 工作流**（Node） | PC agent、ARM agent | ✅ 已有（17 项测试） |
| — | ~~T1b 浏览器版~~ | — | — | **取消**（设备装 Node，构建/启动期跑 T1 即可） |
| T2 | `tools/intake.mjs` | 开发机/构建机（Node） | 收包方 | ❌ 待做 |
| T3 | `www/js/view/scene-loader.js` | 设备浏览器 | 设备运行时 | ❌ 待做 |
| T4 | `www/js/view/animator.js` | 设备浏览器 | 设备运行时 | ❌ 待做 |
| T5 | `www/js/core/interactions.js` | 设备浏览器 | 设备运行时 | ❌ 待做 |
| T7 | `tools/pack.mjs` / `tools/verify.mjs` | 开发机/构建机（Node） | 打包/部署 | ✅ 已有 |

## 3. 使用约定（agent 必须遵守）

1. **产出地图后**：`node tools/validate-scene.mjs <scene-dir> --strict`，退出码必须为 0；
2. **收包时**：`intake` 内部调用 T1，不合格包**不落盘**；
3. **提交前**：`npm run pack && npm run verify`；
4. **错误处理**：T1 的 `code`（`intgrid/spawn/door/act/animation/effect/require/duration/layer/manifest/coverage/schema`）直接对应修法，不要绕过。

## 4. 未来写 ARM 侧时必须加上（记录，勿漏）

- [ ] **把 T1 纳入 ARM agent 的默认工作流**：任何地图/场景产出后必跑 `--strict`，退出码 0 才允许提交。
- [ ] **产出 agent 内自检**：`npm run validate` 在 `pack` 之前跑；不合格不打包、不交付。
- [ ] **`intake` 复用 T1**：收包与自检用同一份规则，禁止两套。
- [ ] **`install.sh` 保持纯部署**：不跑校验、不判断内容质量（需求方口径）。
- [x] ~~设备自产地图的生成器自检~~：**废案（2026-11-14）**。ARM 不再生成地图，地图统一由 PC 产出侧生成并校验。
- [ ] **文档与技能同步**：`MAP-SCENE-DESIGN.md` §15.5、`dhvw-home-map-authoring` 技能里写明命令与退出码。

> 为什么页面里不能直接跑 T1：浏览器没有 `fs`/`crypto` 模块；而校验按需求方口径只发生在产出 agent 中。
> 设备启动时 Go 壳按 `manifest.json` 检查缺失/尺寸，这是**完整性**，不是内容校验。

## 5. 为什么值得单独记一份

- T1 是**两个 agent 的共同自检入口**，规则一旦分叉，就会出现"PC 产的能跑、ARM 产的跑不了"；
- 设备装了 Node 后，**校验只有一份实现**（T1），不再需要浏览器版；
- 设备侧不再生成地图，因此不需要第二套生成器自检。

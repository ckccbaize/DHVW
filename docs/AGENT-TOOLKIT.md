# Agent 工具包（产出侧）

> 状态：v0.1（2026-11-12）。回答两个问题：**这些工具是给谁用的**、**未来写 ARM 侧时必须补上什么**。
> 关联：`docs/CONTENT-CONTRACT.md`、`docs/MAP-SCENE-DESIGN.md` §15、`docs/DEV-PLAN.md` T 组。

---

## 1. 定位

**是 agent 的工具包，不是设备运行时。**

- 使用者：**产出 agent**（PC agent 与 ARM agent）在"生成/收包/提交"阶段调用；
- 运行位置：**构建/部署期**（Node 20+）。设备如果装了 Node，也可以在**启动前**跑一次作为安全网；
- **页面里不跑 Node**（浏览器没有 `fs`/`crypto` 模块），页面只加载"已经校验过的包"。

一句话：**T1 是"提交/部署前的自检闸门"，不是"页面里的功能"。**

> 2026-11-12 修订：设备会装基础开发环境（含 Node），因此**不再需要单独的浏览器版校验器（T1b）**。
> 校验放在构建期（`npm run validate`）与部署/启动前（可选）；页面侧只保留生成器对自己产物的几条自检。

## 2. 工具清单与运行位置

| ID | 工具 | 运行位置 | 使用者 | 状态 |
|---|---|---|---|---|
| T1 | `tools/validate-scene.mjs` | 开发机/构建机（Node） | PC agent、ARM agent | ✅ 已有（17 项测试） |
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
- [ ] **构建期校验**：`npm run validate` 在 `pack` 之前跑；不合格不打包。
- [ ] **部署/启动前校验（可选）**：设备装了 Node 时，`install.sh` 或 systemd `ExecStartPre` 对 `/opt/dhvw/www` 跑一次 T1；失败不启动 kiosk。
- [ ] **`intake` 复用 T1**：收包与自检用同一份规则，禁止两套。
- [ ] **设备自产地图的生成器自检**（Node 覆盖不到的唯一路径）：`forge.worker` 提交前检查 5 条——`intGrid` 长度、`spawn`/热点可走、门格=2、引用的图层文件存在、`act`/动画引用存在；不合格丢弃并记 `forge_fail`。
- [ ] **文档与技能同步**：`MAP-SCENE-DESIGN.md` §15.5、`dhvw-home-map-authoring` 技能里写明命令与退出码。

> 为什么页面里不能直接跑 T1：浏览器没有 `fs`/`crypto` 模块。但**设备 OS 可以装 Node**，所以校验放在构建/部署/启动期，页面只消费已校验的包。
> 唯一例外是"设备自己在浏览器里生成的地图"——它由生成器在提交前自检，不需要完整校验器。

## 5. 为什么值得单独记一份

- T1 是**两个 agent 的共同自检入口**，规则一旦分叉，就会出现"PC 产的能跑、ARM 产的跑不了"；
- 设备装了 Node 后，**校验只有一份实现**（T1），不再需要浏览器版；
- 页面侧只保留生成器的 5 条自检，避免"两套校验器"漂移。

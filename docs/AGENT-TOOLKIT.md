# Agent 工具包（产出侧）

> 状态：v0.1（2026-11-12）。回答两个问题：**这些工具是给谁用的**、**未来写 ARM 侧时必须补上什么**。
> 关联：`docs/CONTENT-CONTRACT.md`、`docs/MAP-SCENE-DESIGN.md` §15、`docs/DEV-PLAN.md` T 组。

---

## 1. 定位

**是 agent 的工具包，不是设备运行时。**

- 使用者：**产出 agent**（PC agent 与 ARM agent）在"生成/收包/提交"阶段调用；
- 运行位置：开发机 / 构建机（Node 20+），**不随设备发布**；
- 设备侧只保留**浏览器版同源校验**（加载时执行），不跑 Node 工具。

一句话：**T1 是"提交前的自检闸门"，不是"设备里的功能"。**

## 2. 工具清单与运行位置

| ID | 工具 | 运行位置 | 使用者 | 状态 |
|---|---|---|---|---|
| T1 | `tools/validate-scene.mjs` | 开发机/构建机（Node） | PC agent、ARM agent | ✅ 已有（17 项测试） |
| T1b | `www/js/core/scene-validate.js` | **设备浏览器**（加载时） | 设备运行时 | ❌ 待做（从 T1 抽纯函数） |
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
- [ ] **抽出浏览器版同源校验 `T1b`**：把 `validateScene`、枚举、`parseIntGrid`、PNG 尺寸解析从 `tools/validate-scene.mjs` 抽到 `www/js/core/scene-validate.js`（去掉 `fs/path/crypto` 依赖，PNG 用 `DataView`，哈希用 `crypto.subtle` 或由构建期提供）。
- [ ] **设备加载器调用 T1b**：`scene-loader.js` 加载时执行同一套规则；不合格 → 拒绝加载 + 回内置场景（§15.4）。
- [ ] **`intake` 复用 T1**：收包与自检用同一份规则，禁止两套。
- [ ] **测试同源**：T1 与 T1b 用同一组 fixtures（合法/各类坏包），断言错误码一致。
- [ ] **文档与技能同步**：`MAP-SCENE-DESIGN.md` §15.5、`dhvw-home-map-authoring` 技能里写明命令与退出码。

> 为什么不能直接把 T1 放进设备：设备只有 Chromium，没有 Node；T1 依赖 `fs/path/crypto`。所以必须"生产期跑 T1、运行时跑 T1b"，两者规则同源。

## 5. 为什么值得单独记一份

- T1 是**两个 agent 的共同自检入口**，规则一旦分叉，就会出现"PC 产的能跑、ARM 产的跑不了"；
- 设备侧加载器如果另写一套校验，等于把 §15.2 的不变量实现两遍，必然漂移；
- 所以：**规则只写一份，T1 与 T1b 共用**（T1 负责文件系统与哈希，T1b 负责内存数据）。

# 内容契约：产出侧 ↔ 设备侧

> 状态：v0.1（2026-11-12）。需求方口径：**交互设计属于产出侧**；ARM 仓库只做设备软件与**产出工具**，不设计玩法、不改美术资源。
> 目的：把"谁定义内容、谁执行内容"写死，避免设备侧替产出侧做设计决策。

---

## 1. 职责边界

| 事项 | 产出侧（PC / 美术 / 设计） | 设备侧（本仓库） |
|---|---|---|
| 地图户型、家具摆放、房间尺寸 | ✅ 定义 | ❌ 只消费 |
| **碰撞**（哪些格挡路） | ✅ 写进 `intGrid` | ❌ 只按 `intGrid` 寻路 |
| **交互**（点家具做什么、效果） | ✅ 写 `interactions.json` | ❌ 只执行 |
| **角色图集与动作** | ✅ 出图 + 帧表 | ❌ 只播放 |
| 场景切换目标（门通向哪） | ✅ 写 `door.to` | ❌ 只执行切换 |
| 场景/资源包校验工具 | 使用 | ✅ 提供 |
| 端侧生成（剧情/背景/地图变体） | 提供规格与素材 | ✅ 实现与调度 |
| 状态机、事件、记忆、唤醒、LLM | — | ✅ |

> 一句话：**设备侧不发明内容，只保证"给定内容一定能被正确加载、校验、播放、执行、产出"。**

## 2. 产出侧交付物（每个场景一个目录）

```
<scene>/
├─ scene.json          # 网格 / intGrid / 实体 / meta
├─ terrain.png         # 16px 烘焙，静态
├─ furniture.png       # 16px 烘焙，静态
├─ light.png           # 光照/天气叠加（可多张，按 light key）
├─ interactions.json   # 道具 → 动作 → 效果（产出侧定义）
└─ character/          # 可选：该场景专用角色图集
   ├─ sheet.png
   └─ sheet.json
```

### 2.1 `scene.json`

```jsonc
{
  "id": "home",
  "title": "温馨的小家",
  "grid": { "w": 20, "h": 15, "cell": 16 },
  "intGrid": "intgrid.bin",          // w*h 字节：0 可走 / 1 阻挡 / 2 门 / 3 窗
  "layers": { "terrain": "terrain.png", "furniture": "furniture.png",
              "light": { "day": "light_day.png", "night": "light_night.png" } },
  "entities": [
    { "type": "spawn", "x": 8, "y": 10 },
    { "type": "door", "x": 8, "y": 14, "to": "outside", "anchor": "south" },
    { "type": "hotspot", "x": 3, "y": 2, "prop": "bed", "act": "sleep", "face": "S" }
  ],
  "meta": { "tier": "builtin", "origin": "authored", "seed": null }
}
```

**硬要求**：
- `intGrid` 与图层 PNG 尺寸必须一致（`w*cell × h*cell`）；
- `spawn` 必须在可走格；
- 每个 `door` 的 `to` 必须存在于场景图，且目标场景有对应 `anchor`；
- 每个 `hotspot` 必须在可走格，且 `act` 在 `interactions.json` 里有定义；
- `intGrid` 里门格必须是 2（不是 0），否则设备无法区分"门"与"空地"。

### 2.2 `interactions.json`（产出侧定义，设备执行）

> 完整设计（效果枚举、条件枚举、执行状态机、打分与打断）见 `docs/INTERACTION-LAYER.md`。

```jsonc
{
  "sleep":  { "prop": ["bed"], "requires": [], "duration_min": 480,
              "animation": "sleep", "effect": { "energy": 1.0 }, "bubble": "睡一会儿。" },
  "watch":  { "prop": ["tv"], "requires": ["power"], "duration_min": 30,
              "animation": "sit", "effect": { "valence": 0.1 }, "bubble": null },
  "cook":   { "prop": ["stove", "counter"], "requires": ["place:kitchen"],
              "duration_min": 40, "animation": "cook",
              "effect": { "energy": -0.1, "valence": 0.15 }, "bubble": "锅开了。" }
}
```

- `prop`：哪些道具触发；
- `requires`：前置（地点、道具状态、时间、网络）；
- `effect`：对心情/世界状态的增量（设备侧只应用，不解释）；
- `animation`：角色动作名（必须在图集里存在）；
- `bubble`：可选提示。

### 2.3 角色图集 `sheet.json`

```jsonc
{
  "frame": { "w": 16, "h": 24 },
  "anchor": { "x": 8, "y": 22 },        // 脚底中心
  "directions": ["S", "N", "E", "W"],
  "animations": {
    "walk": { "fps": 8, "frames": { "S": [0,1,2], "N": [3,4,5], "E": [6,7,8], "W": [9,10,11] } },
    "idle": { "fps": 2, "frames": { "S": [12], "N": [13], "E": [14], "W": [15] } },
    "sit":  { "fps": 2, "frames": { "S": [16], "N": [17], "E": [18], "W": [19] } },
    "sleep":{ "fps": 1, "frames": { "S": [20] } },
    "cook": { "fps": 6, "frames": { "S": [21,22] } }
  }
}
```

## 3. 设备侧必须提供的工具（"产出工具齐全"的清单）

| 工具 | 作用 | 验收 |
|---|---|---|
| `tools/validate-scene.mjs` | schema + 闸门：尺寸一致、spawn 可走、热点可走、门双向、`act` 有定义、图集引用存在 | 故意改坏一处 → 退出码 1 并指出文件与格坐标 |
| `tools/intake.mjs` | 把产出侧目录收进 `www/assets/scenes/<id>/`，生成 manifest，拒绝不合格包 | 不合格包不落盘 |
| `tools/pack.mjs` / `verify.mjs` | 资源包清单与完整性（已有） | 已通过 |
| `js/view/scene-loader.js` | 加载 + 校验 + 解码（失败回退到内置场景） | 缺图不白屏 |
| `js/view/animator.js` | 按 `sheet.json` 播放（方向/动作/帧率） | 4 向 + 5 动作可播 |
| `js/core/interactions.js` | 执行 `interactions.json`（数据驱动，无硬编码设计） | 改 JSON 即改行为，不改代码 |
| `js/core/collision.js` | 只读 `intGrid`（0/1/2/3），不做设计判断 | 家具挡不挡由 `intGrid` 决定 |
| `www/debug.html` | 场景/碰撞/热点/可达性可视化 | 一眼看出"哪格挡路、哪个热点不可达" |
| `forge/*` | 端侧产出（剧情/背景/地图变体） | 产物过闸门 + 带 `tier:edge` |

> **当前代码里 `core/grid.js` 的 `PROP_ACT` 是硬编码的**（`bed→sleep`、`tv→watch`…），这等于设备侧替产出侧做了设计决策。按本契约应改为：**从 `interactions.json` 读取**，`PROP_ACT` 只作为缺省兜底并标注 `deprecated`。

## 4. 设备侧不做的（明确排除）

- 不定义家具碰撞规则（只读 `intGrid`）；
- 不定义交互效果（只应用 `effect`）；
- 不画角色帧（只播放图集）；
- 不改 `assets/` 下的美术与地图源文件；
- 不决定"门通向哪"（只执行 `door.to`）。

## 5. 与主线的顺序

1. **主线**：世界核心机（W1–W29）——状态机、事件、记忆、唤醒、调度、LLM、同步。
2. **工具**：`validate-scene` / `intake` / `animator` / `interactions` / `debug` 随主线需要补齐（V 组与 W22）。
3. **产出侧**：地图、碰撞、交互表、角色图集由产出侧交付；设备侧只保证能接住。

> 现在不动的：`assets/`、`paint_home.py`、`home.map.json`、任何美术资源。

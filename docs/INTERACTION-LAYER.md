# 互动层设计（v0.1 讨论稿）

> 先澄清上一轮说的"设备层越界"，再给互动层的做法。
> 关联：`docs/CONTENT-CONTRACT.md`（产出侧 ↔ 设备侧边界）。

---

## 1. 先解释"越界"是什么

现在 `www/js/core/grid.js` 里有这么一张表：

```js
export const PROP_ACT = {
  bed: "sleep", wardrobe: "dress", desk: "work", tv: "watch",
  counter: "cook", stove: "cook", sofa: "rest", ...
};
```

它的作用是：扫描场景里的家具，凡是表里有的，就在它旁边找一个可走格当"热点"，并记下"这个家具对应什么动作"。

**问题不在"能不能寻路"，而在"谁决定这张表"**：

- 产出侧明天加一件 `piano`（钢琴）。设备代码不认识它 → 不会生成热点 → 她永远不会弹琴。要修就得改设备代码。
- 产出侧把 `tv` 从"看电视"改成"看新闻"（动作不同、时长不同、效果不同）。设备代码里的 `tv: "watch"` 是写死的，改不了。
- 产出侧想让 `sofa` 既能坐又能睡。设备代码只能给一个动作。

也就是说：**设备代码里藏了一份"内容设计"**。产出侧改内容要改设备代码，这就是越界。正确的位置是：这张表由产出侧以数据形式给出（`interactions.json`），设备只负责"读表、找位置、走过去、播动作、应用效果"。

---

## 2. 互动层的四条原则

1. **内容声明式**：产出侧只写数据（什么家具、什么条件、什么动作、什么效果），不写代码。
2. **执行通用化**：设备只有一个通用执行器（靠近 → 表演 → 结算），不为每个动作写一段代码。
3. **效果原子化**：效果是有限枚举（心情增减、置标记、推进时间、产出作品、切换地点…），设备只应用，不解释。
4. **触发统一**：**用户点击**和**她自己想做**走同一条解析与执行路径——否则会出现"AI 能做的事用户点不了"或反过来。

---

## 3. 数据契约：`interactions.json`

```jsonc
{
  "schema_version": 1,
  "acts": {
    "sleep": {
      "label": "睡觉",
      "trigger": { "props": ["bed"], "zones": [] },
      "requires": [
        { "kind": "place", "in": ["bedroom"] },
        { "kind": "time", "between": ["22:00", "07:00"] }
      ],
      "approach": { "face": "S" },
      "perform": { "animation": "sleep", "duration_min": 480, "interruptible": true },
      "effects": [
        { "kind": "mood", "target": "energy", "delta": 1.0, "apply": "on_complete" },
        { "kind": "advance_time", "minutes": 480 },
        { "kind": "event", "name": "sleep" }
      ],
      "cooldown_min": 0,
      "priority": 10,
      "bubble": null
    },
    "watch": {
      "label": "看电视",
      "trigger": { "props": ["tv"] },
      "requires": [{ "kind": "place", "in": ["living"] }],
      "perform": { "animation": "sit", "duration_min": 30, "interruptible": true },
      "effects": [
        { "kind": "mood", "target": "valence", "delta": 0.1, "apply": "on_complete" },
        { "kind": "event", "name": "watch" }
      ],
      "priority": 5,
      "bubble": null
    }
  }
}
```

### 3.1 效果枚举（设备只认这些）

| `kind` | 参数 | 说明 |
|---|---|---|
| `mood` | `target` / `delta` / `apply` | 心情四维增减；`apply: on_complete \| per_minute \| on_interrupt` |
| `set_flag` / `clear_flag` | `name` | 世界标记（如 `lamp_on`） |
| `advance_time` | `minutes` | 推进游戏时间（睡觉、旅行） |
| `event` | `name` / `payload` | 写事件日志（供记忆与统计） |
| `produce_artifact` | `kind` / `template` | 产出作品（文本/图），进资产库 |
| `travel` | `to` / `minutes` | 切地点（含跨夜） |
| `say` | `text` / `ttl` | 气泡 |
| `door` | `open` / `close` | 门状态（影响碰撞层） |

> 产出侧只能组合这些原子；**不允许写 JS、不允许 eval**。

### 3.2 条件枚举（设备只认这些）

`place` / `time` / `weather` / `mood`（范围）/ `flag` / `prop_state` / `network` / `budget` / `cooldown`。

### 3.3 触发方式

| 方式 | 谁来 | 说明 |
|---|---|---|
| `prop` | 用户点家具 | 设备找到该家具的相邻可走格 → 解析 → 执行 |
| `hotspot` | 用户点热点 | 场景里显式声明的热点（产出侧可选） |
| `self` | 她自己 | 定时/事件驱动，用同一份 `acts` 打分选择 |

**同一份定义、两种发起者**——这是"她做的事用户也能参与"的基础。

---

## 4. 运行时四件套（设备侧）

```
InteractionRegistry   读 interactions.json → 校验 → 按 prop/act 建索引
InteractionResolver   输入：点击目标 / 当前状态 / 自主扫描
                      → 候选（trigger 命中）→ 过滤（requires）→ 打分 → 选一个
InteractionExecutor   approach → perform → settle → idle（可打断）
EffectApplier         按枚举应用效果 → 改心情/标记/时间 → 写事件
```

### 4.1 当前落地

- `life.worker` 初始化时用 `createInteractionRegistry(scene.interactions)` 建表；
- 自主漫游前先 `pickInteraction()`：按热点、`requires`、`priority` 打分，命中则走 `planIntent`，否则回退普通漫游；
- 到达热点后记录 `activeInteraction`，`endsAt = 当前分钟 + duration_min`；
- 完成时 `applyEffects` 应用心情/标记/事件/气泡，写 `interaction_start` / `interaction_end` 事件；
- 心情变化通过 `{type:"mood"}` 回传主线程，写入 IDB `mood` 并刷新 UI；
- 调试页「去阅读 / 去做饭 / 去写作 / 去洗澡」与自主行为共用同一套交互定义。

### 4.1 执行状态机

```
idle ──resolve──► approaching ──到达──► performing ──完成──► settling ──► idle
                        │                    │
                        └── 不可达 ──────────┴── 打断（用户/显现/条件失效）──► interrupted ──► idle
```

- **效果应用时机**由 `apply` 决定：`on_complete`（默认）、`per_minute`（做饭的精力消耗）、`on_interrupt`（睡觉被打断只恢复一半）。
- **打断**：用户点击其他位置、进入显现、`requires` 失效。打断时按 `on_interrupt` 结算，不"白做"也不"全给"。
- **并发**：同一时刻只有一个交互；新交互请求排队或替换（按 `priority`）。

### 4.2 打分（自主与点击共用）

```
score = priority
      + moodFit(act, mood)      // 数据里可选 weight
      + timeFit(act, phase)
      - novelty(act)            // 最近 2 小时做过
      - distance
```

点击时用户意图优先（直接选该家具的 act，不看分数）；自主时才打分。

### 4.3 校验（在收包时做，不在运行时做）

`validate-scene` 必须检查：
- 每个 `hotspot.prop` 在 `trigger.props` 里出现过；
- 每个 `perform.animation` 在 `sheet.json` 里存在；
- 每个 `effects[].kind` / `requires[].kind` 是已知枚举；
- `duration_min` 在合理区间（1–1440）；
- 未知字段直接报错（严格模式，避免拼写错误静默失效）。

---

## 5. 和现在代码的差距（3 处）

| 现状 | 改成 |
|---|---|
| `grid.js` 的 `PROP_ACT` 硬编码 | 删除；改为 `buildHotspots(scene, registry)`，只认 `interactions.json` 里声明过的 `prop` |
| 点击只处理"可走格 / 角色" | 增加"点中家具 → 解析交互 → 靠近 → 执行"分支 |
| 没有执行器 | 新增 `core/interactions.js`（Registry + Resolver + Executor + Effects），约 200–250 行 |

> 这三处都属于 T5（`js/core/interactions.js`），不涉及资源、不涉及美术。

---

## 6. 待定（需要你定）

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| I1 | 动作词汇表（`sleep/cook/watch…`）由谁维护 | ①产出侧维护 `acts` 目录 ②设备内置 ③两边各一份 | ①，设备只校验 |
| I2 | 热点显式声明还是设备派生 | ①场景显式写 `hotspot` ②设备按家具相邻格派生 ③两者都支持 | ③，显式优先、派生兜底 |
| I3 | 效果应用时机 | ①只在完成时 ②支持每分钟 ③支持打断结算 | ③（睡觉/做饭需要） |
| I4 | 组合交互（做饭 = 取食材→灶台→餐桌） | ①一期单步 ②支持 `sequence` | ①，二期再上 |
| I5 | 交互期间能否被"她自己"打断 | ①不能 ②高优先级可 | ②，但需 `interruptible` 声明 |
| I6 | 点击家具但条件不满足时 | ①气泡说明 ②静默忽略 | ①（"现在不想做饭"） |

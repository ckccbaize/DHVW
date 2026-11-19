# 地图与场景生成设计（MapForge / SceneKit）

> 状态：**v0.2 草案（2026-11-12）**，待评审后并入 `PROJECT-PLAN.md` §2.6.9 与 §10.7.8。
> v0.2 新增：**§13 自动化生产（设备侧 AI 驱动）**、**§14 互动层（interactions.json）与角色精灵**。
> 上游依据：§2.6（LDtk + Canvas 2D 烘焙 + `PathAgent`）、§10.6（主机档生产）、§10.7.3（`AssetForge` 两档共用）、§10.9（token 降耗）、ADR-014 / ADR-016、M6-T1/T2/T6/T7/T11、M11-T5/T17/T19。
> 本文只解决两件事：**① 预设自带场景怎么设计；② 剧情驱动的场景生成怎么做，且能在 Armbian（RK3566 / 2GB）上跑、token 尽量少。**
> 实测见附录 A（`scripts/spike_mapforge.mjs`）。

---

## 0. 结论摘要

1. **场景 = 模板(结构) × 调色板 × 光照 × 道具组合 × 尺寸**，五个轴。预设固定前四个、只留尺寸；生成只动**道具组合 + 参数**。视觉空间被这条公式锁死，所以「她生成的图」和「自带的图」必然是一个家族（R20 / R31 的结构性解法，不靠事后调色）。
2. **模型永远不出几何**。模型只出 6 个枚举字段，压成一行 DSL（约 18–22 output tokens）；坐标、瓦片、碰撞全部由本地文法确定性生成。这是 token 降耗的全部来源（§10.9「模型只出参数，不出资产」的落地形态）。
3. **零 token 是默认路径，不是降级路径**：剧情文本本来就要付费（WakeTrace `content` 或同一次批处理调用），场景参数由**本地词表 + 一致性闸门**从剧情里派生。只有「本周期没有新剧情素材」时才让模型出 DSL。
4. **两档同一份代码**：`MapForge` 是纯函数 `seed → scene`，主机档与端侧档只换种子来源（模型 / 状态机）。主机档多做的只有「把烘焙好的 PNG 直接下发」，端侧档在 `forge.worker` 里用同一个烘焙函数自己烘。
5. **实测**：32×24 网格、8 个原型、3200 个种子，**合格率 100%**（连通 + 热点可达 + 空白率 ≤15%），生成 **0.095 ms/次**，**3200/3200 布局互不相同**。RK3566 按 10× 折算约 1 ms，烘焙与落盘才是真正的时间大头（<20 ms 量级）。
6. **第一套自带场景已落地**：「温馨的小家」20×15 一张连续图 / 5 间房（尺寸各不相同，**只有 2 间封闭**，其余靠 `zones` 换地面做无墙功能分区）/ 34 件家具 / 7 件墙面装饰 / 6 件地面小物；办公室 26×18 / 3 间房（**只 1 间封闭**）/ 61 件家具。两景**不设房间锁**、户型互不相同（§3.5）。
7. **网格尺寸定为 32×24**（16px 源瓦片 → 512×384 烘焙 → 2× 最近邻 = 1024×768 上屏），**单屏不滚动、不做相机**。原型里的 26×15 只作机制验证，不进入产物。
8. **产出侧 = PC agent 与 ARM agent**，两边都必须具备生成地图的能力，且产出**同一份包**；给定种子/剧情意图，八步管线产出一个可直接运行的场景包（图 + 碰撞 + 交互 + 图集引用）（§13、§15）。
9. **交互是内容，不是代码**：`interactions.json` 声明"什么道具、什么条件、什么动作、什么效果"，设备只执行；同一份定义同时服务"用户点击"与"她自己想做"，角色精灵按 `perform.animation` 播放（§14）。

---

## 1. 约束（写死，不再讨论）

| 约束 | 来源 | 对设计的硬性影响 |
|---|---|---|
| 设备 RK3566 / 2GB / ARMbian / kiosk 浏览器 | §2.4、ADR-006 | 只有 Canvas 2D，**总观不建 WebGL**；单场景常驻内存 ≤ 3 MB 图层；无 Python |
| 总观冷启动 ≤8s、24h 不白屏 | A14 | 场景必须**预烘焙成 PNG**，运行时只 `drawImage`；生成不得在启动路径上 |
| 端侧程序化路径 **0 token / 0 GPU** | A16、§10.7.3 | 生成器必须是纯 JS 纯函数，无网络、无 WASM、无模型 |
| 主机档日 output ≤8k tokens | A11、§10.9 | 场景控制字段必须压到 **≤25 tokens/周期** |
| 地图格式 LDtk JSON 子集 | §2.6.2、R27 | 只依赖 `levels/layers/IntGrid/tiles/entities`；产物过校验器 |
| 素材成套、不硬拼 | ADR-016、§2.6.8、R31 | 道具必须来自**同一套 tileset + 同一调色板**，禁止运行时通用瓦片平铺 |
| 首帧不等待生成 | §10.4 | 首次启动用**预设场景**；生成场景只做「下一张」预取 |

---

## 2. 场景数据模型

### 2.1 三层结构

```
SceneTemplate（手工设计，8 个）        ← LDtk 工程，人画
   └─ 结构：地板/墙/开口槽位/道具槽位/光照区
SceneVariant（预设变体，模板 × 调色板 × 光照）  ← 构建期烘焙成 PNG，随资源包
SceneInstance（生成实例，seed 决定）   ← 运行时/构建期由 MapForge 产出，含烘焙 PNG
```

**关键**：三者共用**同一份 schema、同一份原语库、同一份烘焙函数**。预设不是"另一种格式"，只是"种子被人工钉死"的实例。

### 2.2 运行时 schema（LDtk 稳定子集 + 我们的扩展）

```jsonc
{
  "id": "study.warm_wood.rain_dusk.s7f3a1",
  "tier": "host",              // host | edge | builtin
  "origin": "forge-procedural",
  "seed": "study/warm_wood/rain_dusk/old_books+window_seat/desk#7f3a1",
  "grid": { "w": 28, "h": 18, "cell": 16 },   // 当前家园；cell=源像素，上屏 2x
  "layers": {
    "terrain":   "terrain.png",     // 地板 + 墙 + 踢脚线，烘焙，静态
    "furniture": "furniture.png",   // 道具，烘焙，静态
    "light":     "light.png"        // 光照/天气叠加，烘焙，可换（见 4.4）
  },
  "intGrid": "intgrid.bin",         // 32*24 字节，0=可走 1=阻挡 2=门 3=水域
  "interactions": "interactions.json",   // 交互定义（§14），缺省用场景内联
  "character": "character/sheet.json",   // 角色图集与动作，缺省用全局图集
  "entities": [
    { "type": "spawn",   "x": 16, "y": 21 },
    { "type": "door",    "x": 16, "y": 23, "to": "entry", "anchor": "south" },
    { "type": "hotspot", "x": 6,  "y": 3,  "prop": "desk",  "act": "work", "face": "S" },
    { "type": "hotspot", "x": 12, "y": 3,  "prop": "bookshelf", "act": "read", "face": "S" }
  ],
  "meta": { "arch": "study", "palette": "warm_wood", "light": "rain_dusk",
            "features": ["old_books", "window_seat"], "focus": "desk",
            "created_at": 1762905600, "consumed_at": null, "size": 41234 }
}
```

- `intGrid` 用**独立二进制**而不是 JSON 数组：768 字节 vs 约 3 KB 文本，且端侧解析零成本（`Uint8Array` 直接 `fetch`/IndexedDB 取）。
- `entities` 只保留**寻路与交互**需要的四类：`spawn / door / hotspot / light`。不放装饰物（装饰已在图层里）。
- `hotspot.act` **必须**在 `interactions.json` 中存在；`hotspot` 所在格必须可走。缺省不写 `hotspot` 时，设备可按"可交互道具的相邻可走格"派生（§14.6）。
- `tier/origin/seed/consumed_at` 是 §10.7.6 回流与 LRU 的字段，不重复设计。

### 2.3 与 LDtk 的关系

| LDtk 概念 | 我们的用法 | 是否进产物 |
|---|---|---|
| `IntGrid` 层 | 可行走/阻挡/门/水，**唯一碰撞真相** | 导出为 `intgrid.bin` |
| `Tiles` 层 | 地形 / 道具两层，烘焙后丢弃 | 只留 PNG |
| `Entities` 层 | 出生点、门、热点、光照区 | 导出 JSON |
| `AutoLayer` 规则 | 构建期拼 Wang tiles（墙脚、地板边缘） | 否 |
| `.ldtk` 工程文件 | 8 个模板的**源文件**，入版本库 | 否 |

`MapForge` 产出的是**同一份 schema 的 JSON**，不是 `.ldtk`；两者用同一个校验器（§10.1）。

---

## 3. 预设自带场景（8 个）

### 3.1 设计原则

1. **一个场景 = 一个屏幕 = 一个房间**。32×24、无相机、无滚动。理由：省掉相机/裁剪/视口代码与内存，2GB 上这是真金白银；也避免"生成器要会做镜头"这种没人验证过的需求。
2. **覆盖她的作息**，而不是覆盖"好看的房间"：睡觉、工作、吃饭、休息、出门、晒太阳、买东西、散步。8 个原型正好一人一天。
3. **拓扑是「玄关 + 街道」双枢纽**：室内 5 间都连玄关；室外 2 处连街道；玄关 ↔ 街道。任意两场景可达，且路径 ≤3 跳（生成场景必须能"走过去"，不能瞬移，见 §6.4）。
4. **每个原型声明 `minHot`（可达热点下限）与 `req`（必备道具）**：这是质量闸门的输入，不是美术偏好。

### 3.2 原型表

| # | arch | 名称 | 生活行为 | 必备道具（`req`） | 可选（`opt`） | 热点 | 出口 | 光照基线 | `minHot` |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `bedroom` | 卧室 | 睡、醒、换衣 | `bed` `wardrobe` `lamp` | `plant` `rug` `shelf` `chair` | 床/衣柜 | 玄关 | 晨光、夜灯 | 2 |
| 2 | `study` | 书房 | 读、写、发呆 | `desk` `bookshelf` `chair` `lamp` | `plant` `rug` `shelf` `sofa` | 书桌/书架 | 玄关 | 台灯、雨窗 | 3 |
| 3 | `kitchen` | 厨房 | 做饭、泡茶 | `counter` `fridge` `stove` `table` | `plant` `chair` | 灶台/餐桌 | 玄关 | 顶灯、晨光 | 3 |
| 4 | `living` | 客厅 | 休息、看电视 | `sofa` `tv` `table` | `plant` `rug` `lamp` `shelf` | 沙发/电视 | 玄关 | 顶灯、黄昏 | 3 |
| 5 | `entry` | 玄关 | 出门、回家 | `shelf` `plant` `lamp` | `rug` `door_mat` `chair` | 鞋柜/门 | 全部室内 + 街道 | 顶灯 | 2 |
| 6 | `balcony` | 阳台 | 晒太阳、吹风 | `chair` `plant` `table` | `plant` `lamp` `bench` | 椅子/栏杆 | 玄关 | **天气可见**（雨/雪直接画） | 2 |
| 7 | `shop` | 街角小店 | 买东西 | `counter` `shelf` `shelf` `sign` | `plant` `rug` `lamp` | 柜台/货架 | 街道 | 暖光 | 3 |
| 8 | `park` | 公园 | 散步、坐着 | `bench` `tree` `tree` `sign` | `plant` `lamp` `bench` | 长椅/树 | 街道 | 日光、黄昏 | 2 |

### 3.3 预设变体数（不增加美术量）

| 轴 | 取值数 | 说明 |
|---|---|---|
| 模板 | 8 | 手工 LDtk |
| 调色板 | 3 / 模板 | 同一图集换 `palette.png` 索引表，**不重画** |
| 光照 | 6（`dawn/day/dusk/night/rain/snow`） | 一张 `light.png` 叠加层，构建期烘 |
| 尺寸 | 3（`s` 24×18 / `m` 28×21 / `l` 32×24） | 生成用；预设固定 `l` |

→ 预设可见组合 **8 × 3 × 6 = 144**，美术成本 = 8 张 LDtk 图 + 3 张调色板 + 6 张光照层。**这是"预设够不够丰富"的答案：靠组合，不靠画。**

### 3.4 布局骨架（以 `study` 为例，`l` 尺寸）

```
y=0  ████████████████████████████████
y=1  █ [书架2x1]      [窗]      [书架]█
y=2  █                                █
y=3  █ [书桌2x1]  [椅]        [落地灯]█
y=4  █                                █
y=5  █        [地毯3x2]              █
...
y=21 █          [植物]               █
y=22 █                                █
y=23 ████████████[门]████████████████
     x=0                            x=31
```

- 门固定在底墙 `x∈[6,25]` 随机（生成时），预设可钉死；门后强制 2 格净空（spike 已实现，避免出生点被堵）。
- 贴墙道具（`rule: wall`）沿四壁；角落道具（`corner`）只进四角；中部道具（`center`）不贴墙；`near` 是**偏好**不是硬约束（目标不存在时退化为普通空地——这是 spike 里唯一一次修正，见附录 A）。
- 热点 = 可交互道具的**相邻空格**，不是道具本身（寻路落点在空地，`PathAgent` 走到邻格再转向道具）。

---

### 3.5 初始家园：一张连续地图 + 程序化绘制（v0.4）

> **v0.2 复盘**：第三方室内图集拼装被判定「乱用素材、不美观」——图集家具是别人的构图，尺寸/朝向/留白都不受控。**v0.3 起改为纯程序化绘制**；**v0.4 起房间尺寸各不相同、取消房间锁**（真实性优先于游戏性）。

| 文件 | 作用 |
|---|---|
| `assets/scenes/home/home.map.json` | **人工可编辑的源**：房间矩形 / 门 / 窗 / 家具 / 墙面装饰 / 地面小物 |
| `scripts/paint_home.py` | 程序化绘制（拆三层）+ **构建期闸门**（`--layout-only` 只验户型） |
| `scripts/pick_layout.py` | 随机布局骨架生成器（封闭房位置来自种子） |
| `scripts/audit_scene_variety.py` | 跨场景重复性审核 |
| `scripts/pack_scene.py` | **打设备侧可运行包**（§15.1）：scene.json / intgrid.bin / interactions / 图集 / manifest |
| `scripts/validate_scene.py` | **收包闸门**（§15.2 不变量 + §14.8 交互 + §15.3 预算 + 确定性） |
| `assets/scenes/_shared/acts.json` | 已注册 act 词表（模型只能在这里选，不得新增 id） |
| `dist/terrain.png`·`furniture.png`·`light_day.png` | 三层烘焙（16px，静态色调烘进前两层，光照层纯加法） |
| `dist/home.png` / `@2x.png` | 三层合成的整图（预览 / 兼容用） |
| `dist/scene.json` | 运行时 schema：grid / layers / 实体（spawn·door·hotspot·light）/ rooms / props / meta |
| `dist/intgrid.bin` | **唯一碰撞真相**，`w*h` 字节（0 走 / 1 挡 / 2 门 / 3 窗；家具按 w×h 写 1，地毯/门垫不挡） |
| `dist/interactions.json` | 本场景 act 子集（按词表裁剪到现有道具与分区） |
| `dist/character/sheet.png` + `sheet.json` | 角色图集：帧 16×24、4 方向、每动作 4 帧、锚点脚底中心 |
| `dist/manifest.json` | 包清单（path / size / sha256），同规格重跑哈希不变 |
| `assets/scenes/home/dist/home.built.json` | 绘制期中间数据（房间 / 门 / 窗 / 家具 / intGrid） |
| `scripts/export_ldtk.py` | 导出 LDtk 工程并用官方 schema 校验 |
| `assets/scenes/home/dist/home.ldtk` | **LDtk 1.5.3 工程**：Collision（IntGrid）+ Markers（Room/Door/Window/Prop/Decor 实体） |
| `prototypes/home-runtime.js` | 状态机（清理逻辑保留，当前未启用） |
| `prototypes/home-preview.html` | 预览（`?scene=home`；`&layers=1` 走三层 + 热点） |

**平面图（当前产物，20×15；由房间矩形 + 门/窗几何生成，家具不参与画墙）**

图例：`L` 起居、`H` 走廊、`B` 卧室、`T` 浴室、`N` 阳台；`#` 墙、`D` 门、`W` 窗。

```
y00 ##W#W####W#W####W###
y01 #LLLLLHHHHHHH#TTTTT#
y02 #LLLLLHHHHHHH#TTTTT#
y03 #LLLLLHHHHHHH#TTTTT#
y04 #LLLLLHHHHHHH#TTTTT#
y05 #LLLLLHHHHHHHDTTTTT#
y06 #LLLLLHHHHHHH#######
y07 ######HHHHHHHNNNNN##
y08 ######HHHHHHHNNNNN##
y09 #BBBB#HHHHHHHNNNNN##
y10 #BBBB#HHHHHHHNNNNN##
y11 #BBBBDHHHHHHHNNNNN##
y12 #BBBB#HHHHHHHNNNNN##
y13 #BBBB#HHHHHHHNNNNN##
y14 ###W####DW##########
```

| 房间 | 矩形 x,y,w,h | 地板 | 说明 |
|---|---|---|---|
| 起居室 `living` | 1,1,**5×6** | 木 | 开放，西/北外墙；绿植、沙发、电视 |
| 走廊 `hall` | 6,1,**7×13** | 木 | 开放，与起居室/卧室/浴室/阳台**格子直接相接**（无墙） |
| 卧室 `bedroom` | 1,9,**4×5** | 木 | **封闭**（左下角），一扇门通走廊 |
| 浴室 `bath` | 14,1,**5×5** | 瓷砖 | **封闭**（右上角），一扇门通走廊 |
| 阳台 `balcony` | 13,7,**5×7** | 石 | 开放，底边栏杆 |
| 区域-厨房 | 7,1,**6×3** | 瓷砖 | `zones` 换地面，不砌墙 |
| 区域-玄关 | 10,11,**3×2** | 瓷砖 | `zones` 换地面，不砌墙 |

门：`bed_hall (5,11)`、`bath_hall (13,5)`、`front (8,14)`。

> **无墙 = 房间格子直接相邻**。painter 只在"非房间格且相邻房间"处砌墙，所以两个房间矩形贴在一起就自动没有墙；功能区差异靠 `zones` 换地面表达，不用墙。
>
> **两间封闭房必须对角错开**（卧室左下、浴室右上）。同高并列或同宽叠列会被布局闸门直接判失败。

**构建期闸门（不通过直接退出）**

闸门按顺序执行，**布局闸门前置**：先判户型，再判家具细节。

| 闸门 | 规则 | 目的 |
|---|---|---|
| **布局：封闭房间 ≤2** | 四面都不与其它房间相接的房间最多 2 间；其余功能区去掉隔墙，只用 `zones` 换地面 | 杜绝"三间同高盒子排一排"的户型 |
| **布局：封闭房间错开** | 两间封闭房不得同高并列（纵向重叠 ≥60% 且横向间距 ≤3 格），也不得同宽叠列 | 别把墙房排成一条墙带 |
| **布局：无墙面积 ≥50%** | 开放面积 / 总面积 ≥ 0.5 | 功能区必须"适量无墙" |
| **布局：开放分区 ≥2** | `zones` 至少 2 个、每个 ≥6 格 | 用地面而不是墙分区 |
| **3×3 空白** | 房间内任何 3×3 区块至少 1 格家具/地毯/小物（门净空区除外） | 杜绝空房间；房间可以小，但不能空 |
| **大件唯一** | `bed / wardrobe / dresser / desk / bookshelf / sofa / tv / armchair / counter / stove / fridge / table / bench / cat_tree / coffee_table` 各至多 1 件 | 靠布局和组合，不靠重复堆量 |
| **门净空 3×3** | 门内侧 3×3 内不得有家具，也不得是功能分区（厨房不能堵在卧室门口） | 进门不撞家具、不串味 |
| **房间连通** | 从本房间连通分量内的任一门出发可达 ≥90% 可走格；开放房间贴边即视为连通 | 不出现走不到的死角 |
| **家具可达** | 每件家具至少一格相邻可走格 | 家具不是墙里的摆设 |
| **命名唯一** | 每个家具/墙面/小物/分区必须有 `name` 且全局唯一 | 报错能定位到具体组件 |
| **靠墙** | 床/柜/书架/台面/灶/冰箱/浴缸/马桶/洗手盆/洗衣机/电视/桌/立架/猫爬架必须有一边贴墙 | 马桶悬空、柜子漂在房间中间 |
| **电视对齐** | 电视与沙发同轴（x 或 y 有重叠）且间距 ≤5 格 | 电视歪在角落、离沙发太远 |
| **朝向** | 有 `facing` 的家具：正面不得朝墙；床尾不得正对门；沙发背必须靠墙；电视必须朝沙发 | 床尾顶门、沙发背对房间、电视背对沙发 |
| **不出房间** | 家具/小物必须完整落在所属房间内且互不重叠 | 布局合法 |
| **墙面不压门窗** | 墙面装饰不得落在窗、门或房间格上 | 视觉不穿帮 |

### 3.6 独立主题创作与多风格适配（PC 场景生成核心规范）

当生成的不是预设 `home`/`office` 时，**禁止直接复用居家/办公家具（如 `bed / stove / cat_tree / toilet / rug / door_mat` 等）凑数**：

1. **尺寸由你自主决定**：`grid.w × grid.h` 不必拘泥于 24×18 或 32×24（建议范围 `14..40 × 10..28`，`cell: 16`），根据场景体量、空间节奏与动线自由设定（如精品花店 18×14、现代咖啡厅 26×18、商业长街 36×14）。
2. **地面统一、克制分区**：
   - 可用 `terrazzo`（现代水磨石）、`concrete`（微水泥）、`parquet`（浅橡木拼花）、`marble`（大理石）、`tatami`（榻榻米）、`wood`、`tile`、`stone`、`carpet`；室外用 `asphalt`、`sidewalk`、`cobble`、`grass`、`dirt`。
   - **不要为了凑数把主空间切成田字格或乱条纹**：现代店面/厅堂应保持主地面材质统一，只在真正需要区分操作区（如吧台内侧、玄关小块）时使用克制的 `zones`。
3. **优先用 `custom_painter.py`（或升级版 `furnitureDefs`）从 0 创作**：
   - 在工作目录同级写 `custom_painter.py`，可导出 `PROP_SIZES`、`FURNITURE`（`fn(draw, gx, gy, w, h)`，像素坐标起点为 `gx*16, gy*16`）、`DECOR`、`WALLPROPS`、`FLOORS`，用完整 Python PIL（`rounded_rectangle`、`ellipse`、`polygon`、渐变、高光/阴影、3/4 俯视立体感、1px 暗色描边）绘制高精度主题物件。
   - 也可用 `spec["furnitureDefs"]`（支持 `rect / round_rect / ellipse / circle / arc / polygon / gradient / line / outline / shadow / pixel`）。
   - 在 `spec["customActs"]` 中为专属物件绑定对应的交互动作与气泡台词。
4. **交付标准不变**：仍须通过 `paint_home.py` → `pack_scene.py` → `validate_scene.py`，确保 `dist/` 产物完整且 100% 可由 ARM 端加载寻路。

**跨场景重复性审核（`scripts/audit_scene_variety.py`）**

只把"户型"当成可比较对象，避免两个场景其实是同一套盒子换个皮：

| 规则 | 阈值 |
|---|---|
| 房间尺寸集合 | 不得完全相同 |
| 家具 id 集合 Jaccard | ≤ 0.70 |
| 封闭房间数 + 封闭房纵向区间 | 不得两场景都相同 |
| 地板类型集合 | 不得完全相同（警告级） |

**随机布局骨架（`scripts/pick_layout.py`）**

```bash
python scripts/pick_layout.py --w 24 --h 16 --seed 7        # 出 rooms / zones / doors 骨架
python scripts/paint_home.py <scene>.map.json --layout-only # 只验户型，不画图、不查家具
```

骨架生成器把 1–2 间封闭房**随机放到对角线两角**（NW+SE 或 NE+SW），剩余面积贪心切成互相贴边的开间，并给每间封闭房自动找一格可开门的墙位、让分区避开 3×3 门净空。种子换一换就是另一套房子——**位置来自种子，不是模板**；16 个种子实测 16/16 通过布局闸门。

**LDtk 导出（v0.5 已实现）**：`python scripts/export_ldtk.py` 把 `home.built.json` 导成 `.ldtk`，用 LDtk 1.5.3 官方 JSON schema 校验通过。映射关系：

| LDtk | 我们的数据 |
|---|---|
| IntGrid 层 `Collision` | `intGrid`：0 空 / 1 墙 / 2 门 / 3 窗（直接是寻路网格） |
| Entities 层 `Markers` | `Room`（带 name，尺寸=房间像素）、`Door`（to）、`Window`、`Prop`（id/w/h）、`Decor`（id） |

这样人工可以用 LDtk 打开同一张图调整，`MapForge` 以后也只需产出同一份 schema。

**取消房间锁（v0.4）**：所有房间 `unlock = {type:"start"}`，始终可达。理由是**真实性优先**——一扇推不开的门是游戏机制，不是家。`home-runtime.js` 里的解锁代码保留但不使用。

**设备侧包（§15.1 落地，v0.7）**

```bash
python scripts/paint_home.py assets/scenes/home/home.map.json   # 三层 + intGrid（家具挡路）
python scripts/pack_scene.py  assets/scenes/home/home.map.json  # scene.json / intgrid.bin / interactions / 图集 / manifest
python scripts/validate_scene.py assets/scenes/home             # §15.2 + §14.8 + §15.3
python scripts/validate_scene.py assets/scenes/home --determinism   # 同规格重跑，manifest 哈希必须一致
```

| 项 | home | office |
|---|---|---|
| 包（8 个文件） | 73.2KB | 89.5KB |
| 三层 PNG 合计 | 39.0KB（上限 300KB） | 50.9KB |
| 门 / 热点 | 3 / 27 | 2 / 56 |
| act / 动画 | 19 / 18 | 14 / 14 |
| 交互覆盖 | 100%（可交互道具全有热点） | 100% |
| 动画绑定率 | 100% | 100% |
| 热点从 spawn 可达 | 27/27 | 56/56 |

- **碰撞以 `intgrid.bin` 为准**：家具按 `w×h` 写 1，`rug / door_mat / bath_mat` 不挡；门格写 2（可走）。
- **热点**由 `trigger.props` 反查：优先取道具正面那格，取不到再沿四周找；`face` 由热点相对道具的位置推出，供 `approach` 转身用。
- **包不含时间戳**：`meta.created_at` 固定 0，同一 spec 重跑 → 8 个文件 sha256 全部相同。
- **门分两类**：跨场景出入口 `type:"door"`（`to`=场景 id 或 `"outside"`，`anchor`=目标落点方位）；场景内房间之间的门洞 `type:"interior_door"`（`to_room`=房间 id，不参与场景图校验，通行靠 `intGrid=2`）。
- **光照层写成映射**：`layers.light = {"day":"light_day.png"}`，后续 `dawn/night/...` 直接加键。
- **图集帧表按方向给帧号**（`CONTENT-CONTRACT` §2.3）：`{"fps":6,"loop":true,"frameCount":4,"frames":{"N":[0,1,2,3],"S":[4,5,6,7],...}}`。
- **设备侧权威校验器在 ARM 仓库**：`node arm/tools/validate-scene.mjs assets/scenes/home/dist --strict [--graph <dir>]`，退出码 0 才算可提交；本仓库的 `validate_scene.py` 是 PC 侧同口径实现（多查预算与确定性）。
- 预览加 `&layers=1` 走设备侧同一套合成（terrain → furniture → light 以 `lighter` 叠加）并画出热点/出生点。

**实测（`python scripts/paint_home.py`）**

| 场景 | 网格 / 像素 | 房间 | 封闭房 | 墙占 | 家具 | 墙面 | 小物 |
|---|---|---|---|---|---|---|---|
| home | 20×15 / 320×240 | 5 | 2（bedroom、bath，对角） | 30% | 34 | 7 | 6 |
| office | 26×18 / 416×288 | 3 | 1（meeting，玻璃隔断） | 18% | 61 | 7 | 5 |

`python scripts/audit_scene_variety.py` → `home vs office: 家具 Jaccard 0.29 | 封闭 2 vs 1` → 重复性审核通过。

### 3.6 杂物（clutter）

> **v0.4 起暂停**：当前 `clutterZones` 为空、杂物 0 件。本节规则保留，恢复时按此实现。

**为什么杂物是实体而不是贴图**：它要能被**清掉**（状态）、被**计数**（进度）、**挡路**（寻路）、被**剧情引用**（"今天把窗边的箱子挪开了"）。贴图做不到其中任何一条。

| 项 | 规则 |
|---|---|
| 铺设 | `clutterZones`（矩形 + 密度）→ 确定性 PRNG（seed = `home:<room>`）→ 逐格放 1×1 箱/袋 |
| 保护格 | 出生点 3×3、每扇门内侧 2 格走廊，永不铺 |
| 挖通 | 铺完若门不可达，按"箱子可通行"求最短路，把路上的箱子搬开（实测 0 次触发，留作兜底） |
| 闸门 | ① 出生点→每扇门必达 ② ≥1 热点初始可达 ③ 清空后所有热点可达 ④ 占比 ≤20% |
| 挡路 | 箱子写进 `intGrid=1`；清掉即变 0。**清理会真的开路**（热点被箱子挡住是设计意图） |
| 清理节奏 | 每 `min_interval_min`（45）分钟 1 件，日上限 `per_day`（6），当前房间优先，清完自动巡到杂物最多的已解锁房间 |
| 事件 | `clean / enter / unlock / newday`，带 `day/minute/room/clutter/at`，进 `life.worker` 账本 |
| 零 token 叙述 | `narrate(state)` 直接产出「第 N 天 HH:MM，在卧室；这间房还剩 11 件杂物（已清 25/36）」——剧情生成的本地素材，不发请求 |

**清理是"随时间"的，不是"点一下清空"**：节奏由 `manifest.cleanup` 决定，端侧档与主机档共用同一份状态机；主机不可达时 `life.worker` 继续按同一节奏推进，回流后事件合并（§10.7.6）。

### 3.7 解锁规则引擎（v0.4 起停用）

> **v0.4 起取消房间锁**：所有房间 `unlock = {type:"start"}`，始终可达。本节保留为历史设计，不再使用。

规则是数据，五种原子 + 一种组合：

| 类型 | 字段 | 含义 |
|---|---|---|
| `start` | — | 起始房间 |
| `day` | `gte` | 第 N 天之后 |
| `flag` | `name` | 剧情标记（由剧情/事件置位） |
| `room_open` | `room` | 依赖另一间房已开 |
| `clutter_ratio` | `room` `gte` | 某房间清理进度达标 |
| `all` | `of[]` | 全部满足 |

- **剧情推进只改 spec，不改代码**：加一间房 = 加一条 room 记录 + 一条门 + 一条解锁规则。
- `room.story` 是**本地剧情素材**（"把卧室的箱子清到门口，那扇门终于推得开了"），锁门提示气泡直接用它，0 token。
- 解锁图在构建期校验：依赖存在、门双向对称、从起始房出发全部可达（否则构建失败）。

## 4. SceneKit 原语库

### 4.1 道具（`PROPS`）

```js
desk      { w:2, h:1, rule:'wall',   interact:'work'  }
bookshelf { w:2, h:1, rule:'wall',   interact:'read'  }
bed       { w:2, h:3, rule:'wall',   interact:'sleep' }
wardrobe  { w:2, h:1, rule:'wall',   interact:'dress' }
counter   { w:3, h:1, rule:'wall',   interact:'cook'  }
fridge    { w:1, h:1, rule:'corner', interact:'cook'  }
stove     { w:2, h:1, rule:'wall',   interact:'cook'  }
table     { w:2, h:2, rule:'center', interact:'eat'   }
sofa      { w:3, h:1, rule:'wall',   interact:'rest'  }
tv        { w:2, h:1, rule:'wall',   interact:'watch' }
chair     { w:1, h:1, rule:'free',   interact:'sit',  near:'desk' }
bench     { w:2, h:1, rule:'free',   interact:'rest'  }
shelf     { w:1, h:2, rule:'wall',   interact:'read'  }
sign      { w:1, h:1, rule:'wall',   interact:'read'  }
plant     { w:1, h:1, rule:'corner'  }
lamp      { w:1, h:1, rule:'corner'  }
tree      { w:2, h:2, rule:'free'    }
rug       { w:3, h:2, rule:'center', deco:true }   // 不挡路
door_mat  { w:2, h:1, rule:'free',   deco:true }
```

- **`deco:true` 不写进 `intGrid`**（地毯可走），这是"地毯铺在门口不堵路"的实现。
- 道具表是**唯一**允许新增美术的入口：加一件道具 = 图集加一格 + 表里加一行，不动生成器。

### 4.2 外壳（`SHELL`）

| 项 | 取值 | 说明 |
|---|---|---|
| `floor` | `wood / tile / stone / carpet / grass / sand` | 按原型定，**同调色板** |
| `wall` | `plaster / wood_panel / railing / none` | `none` = 室外（公园） |
| 墙脚 | 构建期 auto-layer 拼 Wang tiles | 不自研 autotile（§2.6.2） |
| 开口 | `door`（内门）/ `window`（透光）/ `arch`（无门洞） | 槽位固定，生成器只选不画 |

### 4.3 光照与天气

一张 `light.png`（RGBA，同尺寸），构建期由 `light` 参数烘焙：

| light | 合成 | 备注 |
|---|---|---|
| `dawn` / `day` / `dusk` / `night` | 径向/线性渐变 + 色温 + 窗光矩形 | 4 张，模板级 |
| `rain` / `snow` | 在对应时段上叠雨丝/雪点 + 冷色偏 | 2 张，**只对 `balcony`/`park` 生效**（室内用窗光表现） |

运行时**只 `drawImage` 一次**，不做逐像素混合（2GB 上逐像素是自杀）。

### 4.4 烘焙

```
LDtk/MapForge → tile 索引数组（terrain / furniture）
              → 离屏 canvas 512×384，逐格 drawImage(16px 源瓦片)
              → 3 张 PNG（terrain / furniture / light）+ 1 张 256×192 缩略图
```

- **按 16px 烘焙、上屏 2× 最近邻**：512×384 RGBA = 786 KB/层，3 层 ≈ 2.36 MB；若按 32px 烘焙则 9.4 MB。视觉等价（最近邻），内存 1/4。§2.6.7 的 C 块已是这个做法。
- 主机档：**PC 上烘**，下发的就是 PNG，设备零生成成本。
- 端侧档：`forge.worker` 里用**同一个函数**烘，切片执行（§8.4）。

---

## 5. 生成管线

```
seed ──► ① 选原型/尺寸/调色板/光照/特征
     ──► ② 外壳铺设（地板/墙/开口槽位）
     ──► ③ 必备道具落位（顺序固定 = 确定性）
     ──► ④ 可选道具落位（2–4 件，加权不重叠）
     ──► ⑤ IntGrid 合成 + BFS 连通 + 热点可达 + 空白率
     ──► ⑥ 烘焙 3 层 PNG + 缩略图
     ──► ⑦ 原子 commit（json + png + manifest）
```

### 5.1 确定性

- `seed = fnv1a(arch/size/palette/light/features/focus + salt)`，PRNG 用 `mulberry32`。
- **同一 seed 必然同一张图**：可缓存（命中即 0 成本）、可复现（用户报"这张图好丑"时能原样重放）、可离线核对（CI 里跑 1000 seed 比对哈希）。
- 落盘前**不重试超过 2 次**（`seed+1`），三次不过就丢弃并记 `forge_fail`（§10.7.3 闸门口径）。

### 5.2 闸门（生成后自检）

| 检查 | 阈值 | 依据 |
|---|---|---|
| 出生点连通 | 可走格 ≥120（32×24 下约 660 格可走） | spike |
| 热点可达 | ≥ `minHot`（2–3） | spike |
| 空白率 | ≤15% | §10.7.3 |
| 道具不重叠 | 构造保证（`fits()`） | spike |
| 门后净空 | 门格 ±1 列、底 2 行不放道具 | spike |
| 调色板一致 | 与基线 ΔE 在区间内 | §10.7.3 |
| 焦点道具存在 | `focus` 必须在实例里 | 新增（剧情一致性） |

### 5.3 复杂度与预算

| 项 | 实测/推算 | 说明 |
|---|---|---|
| 生成（纯算法） | **0.095 ms/次**（桌面）→ RK3566 约 **1 ms** | 3200 次实测，含重试 51 次 |
| 烘焙（3 层 × 768 格） | 约 2300 次 `drawImage` → 设备 **5–20 ms** | [INFERENCE] 待真机测 |
| 落盘 | 场景 ~40 KB（3 PNG + json + 缩略图） | 6 张/日 ≈ 240 KB/日 |
| 单任务切片 | ≤5 s/片，片间检查让位 | §10.7.3 |

---

## 6. 剧情 → 场景

### 6.1 三层，按 token 成本从低到高

| 层 | 谁决定场景 | token | 何时用 |
|---|---|---|---|
| **L0 预设** | 无 | 0 | 首次启动、无新剧情、生成失败兜底 |
| **L1 本地派生** | 词表 + 规则（剧情文本 → 6 个枚举） | **0** | **默认路径**：WakeTrace 已有 `content`，或本周期没有新素材 |
| **L2 模型直出** | LLM 输出一行 DSL | **≈18–22** | 本周期**必须**有新剧情（P1 生产），且 L1 置信度低 |

### 6.2 种子 DSL（L2 的唯一输出格式）

```
scene := arch "/" size "/" palette "/" light "/" features "/" focus
   arch     ∈ {bedroom, study, kitchen, living, entry, balcony, shop, park}
   size     ∈ {s, m, l}
   palette  ∈ {warm_wood, cool_plaster, green_outdoor}
   light    ∈ {dawn, day, dusk, night, rain, snow}
   features ∈ 0–3 个，'+' 连接，取自 12 个标签
              {old_books, window_seat, dust_motes, fresh_flowers, laundry,
               rain_sound, warm_lamp, clutter, open_window, street_noise,
               morning_light, cat_corner}
   focus    ∈ 该原型道具表里的 id（必须可交互）
```

示例（**整行 ≈ 20 tokens**）：

```
study/l/warm_wood/rain_dusk/old_books+window_seat/desk
```

**为什么是 DSL 而不是嵌套 JSON**：同一信息用 `{"archetype":"study","size":"l",...}` 要约 55–70 tokens；DSL 约 18–22。按日 6 周期算，一年省下的不是钱，是**预算余量**（8k/日硬顶下，余量决定能不能多产一张背景图）。DSL 用 `JSON schema` 的 `pattern` 约束即可，不需要 `oneOf` 嵌套（`response_format` 更省、更不容易被截断）。

**表达空间**：8 × 3 × 3 × 6 × (C(12,0)+C(12,1)+C(12,2)+C(12,3)=299) × ≈6 ≈ **77 万**种参数组合，几何再乘以文法排列。20 tokens 买到这个空间，是这套方案的核心性价比。

### 6.3 L1 本地派生（默认路径）

```
plot ──► 关键词表（8 原型 × 每原型 4–6 个词）──► arch
     ──► 天气/时段表（雨/雪/夜/黄昏/晨）    ──► light
     ──► 情绪/道具表（书/茶/沙发/花…）      ──► focus + features
     ──► 置信度 = 命中类别数 / 3
```

- 置信度 ≥0.33 直接用；=0（一条都没命中）→ 用**当前所在场景**（不换场景，只换光照/道具），比瞎猜一个更安全。
- 词表是**数据文件**（`assets/lexicon/scene.json`），可增量扩充，不改代码；扩充时用离线回归集（200 条真实剧情）测命中率。

### 6.4 一致性闸门（防止"模型说书房，剧情在睡觉"）

| 检查 | 不通过时 |
|---|---|
| `arch` 与剧情词表至少一类重合 | 丢弃模型输出，走 L1 |
| `focus` ∈ 该原型道具表 | 丢弃该字段，用原型默认焦点 |
| `light` 与剧情时段词不冲突（"深夜"不能是 `day`） | 以剧情为准 |
| 目标场景在场景图里可达（≤3 跳） | 插入迁移路径（见下） |

**迁移路径**：剧情说"去公园"，她当前在卧室 → 生成的不是"瞬移到公园"，而是 `bedroom → entry → street → park` 的 waypoint 序列，`PathAgent` 依次走门锚点，每跳一次淡入淡出（≤300 ms），总时长按距离折算（可"时间跳跃"，但位置连续）。这是"场景是她的生活空间"与"场景是贴图"的分界线。

### 6.5 与主机档批处理调用的关系

§10.9 已定：**1 次调用出 3 份产物**。加入场景后仍是 1 次：

```jsonc
{
  "plot":  "……80–200 字……",
  "scene": "study/l/warm_wood/rain_dusk/old_books+window_seat/desk",
  "bg":    "……60–120 token 画面 prompt……"
}
```

| 产物 | 输出 token | 占比 |
|---|---|---|
| `plot` | 150–300 | ~70% |
| `scene` | **18–22** | **~5%** |
| `bg` | 60–120 | ~25% |
| 合计 | 230–440 | 单周期 ≈ ¥0.004 |

**场景控制的边际成本 ≈ 5%**，且 6 个周期里通常只有 1–2 个需要走 L2（其余走 L1 的 0 token 路径）。

---

## 7. Token 预算总账

| 场景来源 | 触发 | token/次 | 频次 | 日 token |
|---|---|---|---|---|
| 预设（L0） | 启动/兜底 | 0 | — | 0 |
| 本地派生（L1） | WakeTrace 有新 `content` | **0** | 多数周期 | **0** |
| 模型直出（L2） | 无新素材且需新场景 | 18–22 | ≤2/日 | ≤44 |
| 端侧档 | 状态机种子 | **0** | 24h | **0** |

对照"朴素做法"（让模型输出完整 tile 数组）：32×24 = 768 格 × 约 8 tokens/格 ≈ **6000+ tokens/张**。本方案 **20 tokens/张**，**≈99.7% 节省**，与 §10.9 的"≈99%"一致。

**硬约束（沿用 §10.9，一条不放松）**：`reasoning_effort=none`、`max_tokens=800`、JSON schema 约束、不开 `tools`、失败不重试、日 8k 封顶。

---

## 8. Armbian（RK3566 / 2GB）可行性

### 8.1 内存

| 项 | 预算 | 说明 |
|---|---|---|
| 当前场景 3 层 | 2.36 MB | 512×384 RGBA ×3 |
| 预取下一张 | 2.36 MB | 只留 1 张，切场景后释放旧图 |
| 缩略图缓存（≤20 张） | ~0.6 MB | 256×192 |
| 生成中间态（tile 索引 + IntGrid） | <50 KB | `Uint8Array`/`Uint16Array` |
| 烘焙离屏 canvas（瞬时） | 2.36 MB | 烘完即释放，**不常驻** |
| **合计增量** | **< 8 MB** | 远低于 §10.7.4 的 100 MB 端侧预算 |

### 8.2 CPU

| 阶段 | 设备估算 | 手段 |
|---|---|---|
| 生成 | ~1 ms | 纯数组操作，无分配热点（复用 `Uint8Array`） |
| 烘焙 | 5–20 ms | 逐格 `drawImage`；可分 3 片（每层一片） |
| PNG 编码 | 10–40 ms | `canvas.toBlob('image/png')`，在 Worker 内，不阻塞主线程 |
| 落盘 | 批量 | IndexedDB 先写，≥8 MB 或 ≥30 min 批量提交（R25） |

`forge.worker` 单任务切片 ≤5 s、片间检查让位标志；life tick P95 ≤8 ms 不受影响（A16）。

### 8.3 存储

| 项 | 大小 | 配额 |
|---|---|---|
| 单场景（3 PNG + json + 缩略图） | ~40 KB | — |
| 端侧 6 张/日 | ~240 KB/日 | ≤500 MB 配额 → 约 5.7 年 |
| 预设 144 变体（若全烘） | ~5.8 MB | 资源包 ≤300 MB 内可忽略 |

> 实际上预设只烘「8 模板 × 当前调色板 × 6 光照 = 48 张」，其余按需在设备上烘（同一函数），资源包只带模板与瓦片。

### 8.4 为什么不在设备上跑 WASM / 不用 WFC

- **WFC（波函数坍缩）**：表达力强但**非确定性收敛**、最坏情况回溯不可控，2GB 设备上"偶发 300 ms 卡顿"就是 A16 的失败项。当前槽位文法已实测 100% 合格、3200/3200 唯一，**没有引入 WFC 的理由**（§2.7.1「不为不造轮子而硬找」）。列为长期备选，仅在"重复感"成为实测问题时评估。
- **WASM**：生成器是纯数组 + 少量 `drawImage`，JS 足够；引入 WASM 只增加包体与构建复杂度。

---

## 9. 场景切换与移动连续性

| 事件 | 载荷 | 前端行为 |
|---|---|---|
| `switchScene` | `{scene_id, transition:'fade'|'door', from_door, to_door, t0}` | 预取 PNG → 淡出 200 ms → 换图 → 淡入 200 ms |
| `moveTo` | `{targetGrid, path[], speed, t0}` | `PathAgent` 本地插值（§2.6.4，不用 5s 快照） |
| `posChecksum` | `{x, y}` | 偏差 >1 格才吸附 |

- **门锚点续接**：`from_door`/`to_door` 是实体里的 `door`，切场景后 `PathAgent` 位置 = 目标场景的 `to_door` 邻格，**朝向保留**。位置连续，不重置。
- **预取**：`PathAgent` 走向门时（距门 ≤4 格）触发下一场景烘焙/下载；门在 2 格内仍未就绪 → 原地停 1 拍（不闪白）。
- **失败**：目标场景 3 次生成不过 → 停在当前场景，气泡「那边还没收拾好」（不换图、不黑屏）。

---

## 10. 指标与验收（建议并入 §10.12 / A16）

| 指标 | 目标 | 测法 |
|---|---|---|
| 生成合格率 | ≥99%（含 ≤2 次重试） | 1000 seed 批量跑闸门 |
| 布局唯一性 | ≥95% | 布局签名去重 |
| 生成耗时（设备） | P95 ≤5 ms | `forge.worker` 打点 |
| 烘焙耗时（设备） | P95 ≤30 ms | 同上 |
| 单场景内存增量 | ≤3 MB | 真机 `performance.memory` / `ps` |
| 场景控制 token | ≤25/次 | 账本 `usage.completion_tokens` |
| 场景控制调用占比 | ≤1/3 周期 | 账本按 `kind` 分组 |
| 风格一致性 | 调色板 ΔE ≤阈值；道具词表重合 ≥80% | 离线统计 + 人工看图 |
| 场景切换 | 淡入淡出 ≤400 ms，无白屏 | 录屏打点 |
| 交互覆盖率 | 可交互道具 100% 有 act；热点 100% 可达 | 生成器报告 + 校验器 |
| 动画绑定率 | 100%（`perform.animation` 在图集存在） | 校验器 |
| 自动化产包合格率 | ≥99%（含 ≤2 次重试） | 1000 seed CI |
| 同 seed 一致性 | 包哈希 100% 相同 | CI 哈希比对 |
| 端侧 24h | 场景 ≥4、0 token、tick P95 ≤8 ms | A16 口径 |

---

## 11. 分阶段研究计划（长期）

| 阶段 | 内容 | 产出 | 周期 |
|---|---|---|---|
| **P0 原语与预设** | `SceneKit` 表 + 2 个 LDtk 模板（study/bedroom）+ 烘焙脚本 + 校验器 | 可渲染的 2 个预设 | 2 周 |
| **P1 文法复现** | `MapForge` 用同一份原语生成 study/bedroom，与手绘对比；1000 seed 跑闸门 | 合格率/唯一性报告 | 2 周 |
| **P2 零 token 映射** | 词表 + 一致性闸门 + 200 条剧情离线回归 | 命中率报告 | 1 周 |
| **P3 主机档单次调用** | DSL schema + 预算护栏 + 账本 | 实测 token/周期 | 1 周 |
| **P4 端侧落地** | `forge.worker` 切片 + 真机测时 + 配额/LRU | A16 实测 | 2 周 |
| **P5 长期研究** | 见下 | — | 持续 |

### 研究问题（RQ）

| # | 问题 | 度量 | 决策影响 |
|---|---|---|---|
| RQ1 | 槽位文法的"重复感"何时出现？ | 布局唯一性、道具 Jaccard、人工 5 分制 | 是否引入 WFC / 更多原型 |
| RQ2 | 场景控制的最小 token 是多少？ | 0 / 20 / 55 / 200 token 四档消融，测"剧情-场景匹配度" | 定死 DSL 形态 |
| RQ3 | 设备烘焙的真实成本？ | RK3566 真机 P95 | 决定 16px 烘焙还是主机预烘 |
| RQ4 | 预设与生成是否"看起来一家"？ | 调色板 ΔE、道具词表重合、盲评 | 决定调色板是否锁死 |
| RQ5 | 场景记忆能否提升连续感？ | 她重复去同一场景的比例、用户主观 | 是否引入"场景偏好"状态 |

---

## 12. 风险（建议新增 R35–R40）

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R35 | **场景重复感**：8 原型 × 有限道具，看久了像"同一间房换了块地毯" | 中 | 组合轴（调色板/光照/尺寸/特征）+ 布局唯一性指标；RQ1 定期盲评 |
| R36 | **生成场景与碰撞不一致**（图能看，走不过去） | 高 | `intGrid` 与烘焙**同源导出**；闸门强制 BFS；校验器进 CI |
| R37 | **运行时烘焙卡顿**打断 life tick | 中 | 16px 烘焙 + 分层切片 + 预取；实测 P95 ≤30 ms |
| R38 | **模型输出越界**（非法 arch / focus） | 中 | DSL 正则 + 枚举表校验；不合法即走 L1，不重试、不报错 |
| R39 | **端侧风格漂移**（设备生成的和主机生成的不像） | 中 | 同一 SceneKit + 同一调色板 + ΔE 闸门；`tier` 标记可一键只看 host |
| R40 | **场景切换打断移动** | 低 | 门锚点续接 + 预取 + 失败原地停 |
| R41 | **交互死角**：道具没有绑定 act，角色走到旁边什么也做不了 | 中 | 交互覆盖率闸门（100%）；生成器必须为每个可交互道具绑定 act |
| R42 | **动画缺失**：`perform.animation` 在图集里不存在，角色"站着做饭" | 中 | 收包时校验；运行时降级 idle + 气泡，不静默 |
| R43 | **AI 产出不可用交互**：模型编造 act/效果 | 高 | act 词表 + 效果/条件枚举 + 严格校验；越界即拒绝，不重试 |

---

## 13. 自动化生产（设备侧 AI 驱动，v0.2 新增）

> **产出侧 = PC agent 与 ARM agent**：两边都要能生成地图，产出同一份包（§15.6）。
> 目标：**给定种子/剧情意图，自动产出一个"能直接跑"的场景包**（图 + 碰撞 + 交互 + 图集引用）；PC agent 可用 Python/GPU，ARM agent 只用 JS/OffscreenCanvas。

### 13.1 两种产出形态（同一份 schema）

| 形态 | 适用 | 绘制 | 碰撞 |
|---|---|---|---|
| A 程序化整图 | 家园/住宅（连续图，20×15 或 28×18） | `paint_home.py` 的 JS 移植（OffscreenCanvas） | 家具按 `w×h` 写入 `intGrid`；地毯/门垫不挡 |
| B 瓦片模板 | 8 原型（单房间，32×24） | `MapForge` → 图集烘焙 | IntGrid 层直接导出 |

两者输出 §13.4 的同一包结构，设备侧用同一个加载器消费。

### 13.2 八步管线

```
① 参数      L0 预设 / L1 本地派生 / L2 模型 DSL（arch/size/palette/light/features/focus）
② 户型      pick_layout（随机对角封闭房 + 贪心开放区）或模板槽位
③ 家具落位  必备 + 可选 + 不重叠 + 靠墙/朝向/成对关系
④ 碰撞导出  墙/门/窗/家具 → intGrid（0/1/2/3）；地毯、门垫不写
⑤ 交互绑定  prop → act（从词表选）；生成 hotspot（§14）
⑥ 烘焙      terrain / furniture / light 三层 PNG（16px，2× 上屏）
⑦ 校验      场景闸门 + 交互闸门 + 图集引用（§13.7）
⑧ 打包      scene.json + intgrid.bin + PNG + interactions.json + sheet.json + manifest
```

**顺序不可换**：碰撞必须在交互之前导出，否则热点可能落在不可走格；交互必须在烘焙之前绑定，否则无法校验动画引用。

### 13.3 确定性

- `seed = fnv1a(全部参数 + salt)`，PRNG 用 `mulberry32`；
- **同 seed 必然同包**（含 PNG 哈希），可缓存、可复现、可 CI 比对；
- 闸门失败重试 ≤2（`seed+1`），三次不过丢弃并记 `forge_fail`；
- CI：1000 seed 跑闸门 + 包哈希去重。

### 13.4 包结构（设备可直接消费）

```
<scene>/
├─ scene.json            # grid / intGrid / entities / meta / interactions / character
├─ intgrid.bin           # w*h 字节
├─ terrain.png           # 16px 烘焙
├─ furniture.png
├─ light_<key>.png       # dawn/day/dusk/night/rain/snow
├─ interactions.json     # 交互定义（§14）
└─ character/            # 可选，缺省用全局图集
   ├─ sheet.png
   └─ sheet.json
```

### 13.5 AI 接口（设备侧）

```
produceScene({ seed, dsl, intent? }) -> { ok:true, package, report }
                                     | { ok:false, reason }
```

- AI **只出参数**：`dsl`（6 个枚举字段）+ 可选 `intent`（如"想弹琴"）；
- **不允许**出坐标、瓦片、碰撞、代码；
- `intent` 转成"必须存在的 act 集合"（弹琴 → `piano` 道具 + `play_piano` 动作），由一致性闸门校验；
- 失败返回**具体原因**（哪条闸门不过），不抛异常、不无限重试；
- **模型不产出可执行 Python/JS 绘制代码**：只出 DSL/参数或 `map.json` 数据；新绘制原语由开发者双端实现。

### 13.6 设备约束

JS only；`OffscreenCanvas`；单任务切片 ≤5s；峰值内存 ≤50MB；0 网络；产物 ≤500MB（LRU）。

### 13.7 验收

| 指标 | 目标 |
|---|---|
| 产包合格率 | ≥99%（含 ≤2 次重试） |
| 布局唯一性 | ≥95% |
| **交互覆盖率** | 可交互道具 100% 有 act；热点 100% 可达 |
| **动画绑定率** | 100%（`perform.animation` 在图集存在） |
| 烘焙耗时（设备） | P95 ≤30ms |
| 同 seed 一致性 | 包哈希 100% 相同 |

### 13.8 执行模型（D16，2026-11-13）

**`*.map.json`（scene spec）是唯一输入；Python 与 JS 是两套固定 painter。**

| 端 | 实现 | 说明 |
|---|---|---|
| PC | `scripts/paint_home.py` | 参考实现，用于黄金图与日常产出 |
| ARM | `arm/www/js/forge/painter.js`（W31） | `OffscreenCanvas` 离线烘焙；生产环境不装 Python |

- LLM/skill 只产出/修改 spec，或选择已注册原语；**不生成任意绘制代码**；
- 新增家具/装饰必须同时进 Python 与 JS 两套 painter，并过黄金图逐像素对比；只改一端视为未完成；
- 现有 `home.map.json` 与已烘焙 PNG 是数据，不因移植重做；
- 不在 ARM 上“临时装 Python 烘焙再清除”：进程可杀但依赖与安全面仍在，且两端版本差异会破坏一致性。

**模型后加家具**：`map.json` 可带 `furnitureDefs`（`rect/line/outline/shadow/pixel` 形状 DSL），模型只写 JSON；Python 与 JS 各有一个解释器，同一份定义逐像素一致。验证命令 `npm run golden:custom`。

---

## 14. 互动层（`interactions.json`）与角色精灵

> 交互是**内容**，由产出侧定义；设备只执行。同一份定义同时服务"用户点击"与"她自己想做"。
> 设备侧实现（Registry / Resolver / Executor / EffectApplier）见 `arm/docs/INTERACTION-LAYER.md`；交付清单见 `arm/docs/CONTENT-CONTRACT.md`。

### 14.1 文件与版本

- 场景目录：`interactions.json`（`schema_version` 必填）；
- 角色图集：`character/sheet.png` + `character/sheet.json`；
- 缺省：场景不写 `character` 时用全局图集；不写 `interactions` 时用场景内联 `acts`。

### 14.2 act 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `label` | ✅ | 显示名（气泡/调试用） |
| `trigger` | ✅ | `{ props: [id], zones: [name] }`，命中任一即可 |
| `requires` | — | 条件数组（§14.4），全部满足才可执行 |
| `approach` | — | `{ face: "N/S/E/W" }`，到达后朝向 |
| `perform` | ✅ | `{ animation, duration_min, interruptible }` |
| `effects` | ✅ | 效果数组（§14.3），可为空 |
| `cooldown_min` | — | 冷却（游戏分钟） |
| `priority` | — | 自主选择时的基础分（默认 5） |
| `bubble` | — | 执行时气泡（≤20 字） |
| `tags` | — | 供心情/时段匹配（如 `quiet`、`social`） |

### 14.3 效果枚举（设备只认这些）

| `kind` | 参数 | 说明 |
|---|---|---|
| `mood` | `target` / `delta` / `apply` | 心情四维；`apply: on_complete \| per_minute \| on_interrupt` |
| `set_flag` / `clear_flag` | `name` | 世界标记（`lamp_on`、`door_open`） |
| `advance_time` | `minutes` | 推进游戏时间（睡觉/旅行） |
| `event` | `name` / `payload` | 写事件日志（供记忆与统计） |
| `produce_artifact` | `kind` / `template` | 产出作品（文本/图），进资产库 |
| `travel` | `to` / `minutes` | 切地点（含跨夜） |
| `say` | `text` / `ttl` | 气泡 |
| `door` | `open` / `close` | 门状态（影响碰撞层） |

**禁止**：任意 JS、`eval`、网络请求、文件写入。

### 14.4 条件枚举

`place`（在哪些房间/地点）/ `time`（时段区间）/ `weather` / `mood`（范围）/ `flag` / `prop_state`（如 `door_open`）/ `network` / `budget` / `cooldown`。

### 14.5 执行状态机

```
idle ──resolve──► approaching ──到达──► performing ──完成──► settling ──► idle
                        │                    │
                        └── 不可达 ──────────┴── 打断（用户/显现/条件失效）──► interrupted ──► idle
```

- 效果时机由 `apply` 决定；打断按 `on_interrupt` 结算（睡觉被打断只恢复一半）；
- 同一时刻只有一个交互；`interruptible:false` 时用户点击排队而非打断。

### 14.6 角色精灵怎么用（关键）

1. **热点**：可交互道具的相邻可走格。场景显式写 `hotspot` 优先；不写则设备按 `trigger.props` 派生（§2.2）。
2. **点击/自主** → Resolver 选中 act → BFS 到热点 → 按 `approach.face` 转向道具 → 播放 `perform.animation`（方向取 face）→ 持续 `duration_min` → 应用 `effects` → 写 `event`。
3. **动画缺失**：降级为 `idle` + 气泡说明，**不静默**；收包时校验应提前拦住。
4. **打断**：用户移动 / 进入显现 / `requires` 失效 → `interrupted` 结算。
5. **图集约定**：帧 16×24、锚点脚底中心、方向 `S/N/E/W`、帧率按动作；动作名必须与 `perform.animation` 一致。
6. **碰撞**：角色只走 `intGrid` 的 0/2 格；道具挡不挡由 `intGrid` 决定，交互层不另设碰撞。

### 14.7 自动生成 `interactions.json`（AI）

- 从道具表推导候选 act（**数据表**，不是代码）；
- 模型只能在**已注册 act 词表**内选，**不得新增 act id**；
- 每个可交互道具必须绑定 ≥1 act，否则交互覆盖闸门失败；
- 新 act 必须先注册到词表（含动画名、效果、条件），再被生成器使用；
- 生成结果与场景一起过校验，不通过则整包拒绝（不"部分可用"）。

### 14.8 校验（收包时，不在运行时）

| 检查 | 不通过 |
|---|---|
| `schema_version` 已知 | 拒绝 |
| `trigger.props` 在场景道具里存在 | 拒绝 |
| `perform.animation` 在 `sheet.json` 存在 | 拒绝 |
| `effects[].kind` / `requires[].kind` 是已知枚举 | 拒绝 |
| `duration_min` 在 1–1440 | 拒绝 |
| `hotspot` 格可走、`act` 有定义 | 拒绝 |
| 未知字段 | 拒绝（严格模式，避免拼写错误静默失效） |

### 14.9 示例（家园）

```jsonc
{
  "schema_version": 1,
  "acts": {
    "sleep": {
      "label": "睡觉",
      "trigger": { "props": ["bed"] },
      "requires": [{ "kind": "time", "between": ["22:00", "07:00"] }],
      "approach": { "face": "S" },
      "perform": { "animation": "sleep", "duration_min": 480, "interruptible": true },
      "effects": [
        { "kind": "mood", "target": "energy", "delta": 1.0, "apply": "on_complete" },
        { "kind": "mood", "target": "energy", "delta": 0.5, "apply": "on_interrupt" },
        { "kind": "advance_time", "minutes": 480 },
        { "kind": "event", "name": "sleep" }
      ],
      "priority": 10
    },
    "cook": {
      "label": "做饭",
      "trigger": { "props": ["stove", "counter"] },
      "requires": [{ "kind": "place", "in": ["kitchen"] }],
      "perform": { "animation": "cook", "duration_min": 40, "interruptible": true },
      "effects": [
        { "kind": "mood", "target": "valence", "delta": 0.15, "apply": "on_complete" },
        { "kind": "mood", "target": "energy", "delta": -0.05, "apply": "per_minute" },
        { "kind": "event", "name": "cook" }
      ],
      "priority": 5,
      "bubble": "锅开了。"
    }
  }
}
```

### 14.10 与设备实现的关系

| 文档 | 内容 |
|---|---|
| 本文 §14 | 产出侧怎么写（数据契约） |
| `arm/docs/INTERACTION-LAYER.md` | 设备侧怎么执行（四件套、打分、打断） |
| `arm/docs/CONTENT-CONTRACT.md` | 交付清单与校验工具 |

---

## 15. 设备侧运行地图需要什么（产出 agent 的交付标准）

> 本节是**给产出 agent 的硬性前提**，不是美术建议。任何 map-producing agent（PC 或 ARM）在提交场景前，必须满足 §15.1–§15.5；设备侧按 §15.2 的不变量直接运行，不额外兜底。

### 15.1 最小可运行包（缺一不可）

| 文件 | 要求 | 运行时用途 |
|---|---|---|
| `scene.json` | §2.2 schema；`grid` / `intGrid` / `layers` / `entities` / `meta` 齐全 | 加载、寻路、实体 |
| `intgrid.bin` | `w*h` 字节，值 0/1/2/3 | **唯一碰撞真相** |
| `terrain.png` | 尺寸 = `w*cell × h*cell`，16px 烘焙 | 底图 |
| `furniture.png` | 同上 | 家具层 |
| `light_<key>.png` | 同上，至少 1 张 | 光照/天气 |
| `interactions.json` | `schema_version` + `acts` | 交互执行 |
| `character/sheet.png` + `sheet.json` | 帧尺寸 / 锚点 / 方向 / 动作 | 角色动画 |
| `manifest` 条目 | `path` / `size` / `sha256` | 包校验 |

### 15.2 不变量（设备侧直接假设，不满足就拒绝加载）

1. `intGrid` 长度 = `w*h`；图层像素尺寸 = `w*cell × h*cell`；
2. `spawn` 可走；每个 `hotspot` 可走；
3. 门格必须是 `2`，`door.to` 在场景图里存在，目标场景有对应 `anchor`；
4. 每个 `hotspot.act` 在 `interactions.json` 里存在；
5. 每个 `perform.animation` 在 `sheet.json` 里存在；
6. 每个可交互道具至少绑定 1 个 act（否则热点为空）；
7. 图层按 16px 烘焙，运行时 2× 最近邻，不做非整数缩放；
8. 所有文件在 `manifest` 里登记（sha256）。

### 15.3 性能预算（RK3566 / 2GB）

| 项 | 上限 |
|---|---|
| 单场景三层 PNG 合计 | ≤300KB |
| 解码后常驻内存 | ≤3MB |
| 设备侧烘焙（ARM agent 生成时） | P95 ≤30ms |
| 单包（含 json） | ≤500KB |
| 场景切换 | ≤400ms（预取 + 淡入淡出） |

### 15.4 缺件时的降级（产出方必须知道）

| 缺件 | 设备行为 |
|---|---|
| `scene.json` 或 `intgrid.bin` | **拒绝加载**，回内置场景 |
| `terrain.png` | 纯色底 + 角标"资源待同步" |
| `interactions.json` | 只可移动，点家具无反应（记 `missing_interactions`） |
| `sheet.json` | 程序化占位角色（16×24 色块） |
| `manifest` 条目缺失 | **拒绝加载**（安全） |

### 15.5 产出 agent 自检清单（提交前必须全过）

**自检命令**：`node tools/validate-scene.mjs <scene-dir> --strict`（退出码 0 才允许提交）。
校验**只在产出 agent 中**（生成后、打包前）；安装与运行阶段不做内容校验，页面只消费已校验的包。
设备自己在浏览器里生成的地图，由生成器在提交前自检 5 条（`intGrid` 长度、spawn/热点可走、门格=2、图层存在、act/动画引用）。

- [ ] `validate-scene` 通过（schema + 尺寸 + 可走 + 门双向 + act/动画引用）
- [ ] 每个可交互道具都有 act；每个 act 的动画在 `sheet.json` 里
- [ ] `intGrid` 与 PNG 尺寸一致
- [ ] 同 seed 重跑，包哈希一致
- [ ] 三层 PNG 合计 ≤300KB
- [ ] `manifest` 已生成且 `verify` 通过
- [ ] 至少 1 张 light 层；`spawn` 可走
- [ ] 若声明 `intent`（如"弹琴"），对应 act 存在且可达

### 15.6 两种产出 agent 的工具链差异（产出必须一致）

| 项 | PC agent | ARM agent |
|---|---|---|
| 绘制 | Python/PIL（`paint_home.py`）或 GPU/ComfyUI | JS painter 移植 + `OffscreenCanvas` |
| 户型 | `pick_layout.py` | JS 移植 |
| 烘焙 | 构建期 | `forge.worker` 切片 |
| 输出 | 同一包结构 | 同一包结构 |
| 一致性 | 基准 | **逐像素对比**（同 spec 同 PNG 哈希） |

> 两边可以各写各的实现，但**包结构、闸门、枚举、哈希规则必须同一份**；否则会出现"PC 产的能跑、ARM 产的跑不了"。

### 15.7 版本与兼容

- `scene.json.schema_version` / `interactions.schema_version` / `sheet.schema_version` 各自独立；
- 设备侧只接受已知版本；**未知字段拒绝**（严格模式）；
- 新字段先升版本，再改两端；旧包在新设备上必须仍可加载（向后兼容至少 1 个版本）。

---

## 附录 A：spike 实测（`node scripts/spike_mapforge.mjs`）

```
网格 32x24，每原型 400 个种子，共 3200 次生成
总耗时 304.9 ms → 单次 0.095 ms（含重试 51 次）
合格率 100.0%
每原型: bedroom 100% / 空白 1.8% / 道具 6.0   study 100% / 空白 1.6% / 道具 7.0
        kitchen 100% / 空白 1.8% / 道具 6.0   living 100% / 空白 1.8% / 道具 6.0
        entry   100% / 空白 0.8% / 道具 5.7   balcony 100% / 空白 1.4% / 道具 5.7
        shop    100% / 空白 1.5% / 道具 6.7   park    100% / 空白 2.2% / 道具 6.7
布局唯一性 3200 / 3200（重复 0）
```

**过程中被实测纠正的两个设计假设**（留证，勿重复）：

1. `near`（椅子挨着书桌）不能是**硬约束**——`balcony` 没有书桌，椅子永远放不下，该原型合格率 0%。改为**偏好**（有目标就优先，没有就退化为空地）后合格率 100%。
2. 质量闸门失败必须**触发重试**，不能只判 `ok` 不重试。修正前 75%，修正后 100%（51 次重试）。
3. `minHot` 必须**按原型声明**，不能全局写 3：`entry`/`balcony`/`park` 的可交互道具本来就少，全局 3 会让它们恒不合格。

---

## 附录 B：与现有文档的差异（需一并修订）

| 项 | 现有文档 | 本文建议 | 理由 |
|---|---|---|---|
| 网格 | 原型 26×15；M6-T1 写 32px 逻辑格；端侧写 32×24 | **统一 32×24，16px 源瓦片，烘焙 16px，上屏 2×** | 单屏不滚动；内存 1/4；与端侧口径一致 |
| 场景控制 | §10.9「种子 JSON ≈120 tokens」 | **DSL ≈20 tokens** | 同一信息，嵌套 JSON 贵 3 倍 |
| 场景来源 | §10.7.3 只说"状态机种子 / 模型种子" | 补 **L0/L1/L2 三层**，L1 为默认 | 零 token 应是默认而非兜底 |
| 预设数 | M6-T11「6–8 个基础场景」 | **8 个原型 × 3 调色板 × 6 光照 = 144 变体** | 用组合换丰富度，不加美术 |
| 场景图 | 未定义 | **玄关 + 街道双枢纽，≤3 跳可达** | 生成场景必须"走得到"，不能瞬移 |
| 交互层 | 未定义 | **本文 §14 `interactions.json`** | 角色精灵需要可执行的动作与效果，且不能由设备代码硬编码 |
| 自动化产包 | 只有生成器 | **本文 §13 八步管线 + 包结构 + AI 接口** | 设备侧 AI 要能直接产包，不依赖 Python/PC |
| 碰撞来源 | 只说"intGrid 是唯一真相" | **明确 props 写入 intGrid、地毯不挡** | 当前实现家具全为 0，角色可穿床 |

# 素材许可台账

> **唯一事实来源**：`docs/PROJECT-PLAN.md`（§2.6.5 / §2.6.8 / R28 / R31 / ADR-015）。本文件只登记「进了产物包或原型目录的第三方美术素材」，不代替主文档决策。
> **建立**：v0.22，2026-11-10；**修订**：v0.23，2026-11-10（第三版对照页换用 ai-town 官方地图，Kenney 第一版标为反面教材留证）。

## 项目许可口径（v0.22 需求方明确，v0.23 沿用）

**本项目不涉及商用，目标是开源发布；不需要为「商业发行被追责」做防御式素材筛选。**

因此选型口径从「许可一票否决」改为「登记 + 致谢」：

- AGPL-3.0 / Commons Clause / CC-BY-SA / PolyForm Noncommercial **不再自动排除**；只要与开源发布相容，就按观感、体积、集成成本来选。
- **CC0 无署名义务**，MIT 要求保留版权与许可声明；我们仍登记来源、保留许可原文并致谢上游——这是尊重上游，不是避险。
- 唯一需要留意的工程约束：若将来**复制 AGPL 代码**（而非只借鉴设计），项目许可证必须同步兼容；若采用 CC-BY-SA 素材，衍生美术需同等开放并署名。这两条是许可证本身的要求，不是风险焦虑。
- 本项目自身代码/文档计划以开源许可证发布（具体 MIT / Apache-2.0 待 M2 定稿），不影响上表结论。
- **v0.23 补充**：许可宽松 ≠ 观感合格。第一版 C 用了最宽松的 CC0 却明显不如自绘（§2.6.8），所以素材选择仍以「是否成套、是否与地图设计配套」为第一判据。

## 台账

| 文件（相对仓库根） | 来源 | 版本 / 日期 | 许可 | 署名要求 | 用途 | 大小 | SHA-256 |
|---|---|---|---|---|---|---|---|
| `prototypes/assets/aitown_rpg-tileset.png` | [a16z-infra/ai-town](https://github.com/a16z-infra/ai-town) `public/assets/rpg-tileset.png` | 仓库快照 / 2026-11-10 取回 | **MIT**（仓库）；上游美术见下方致谢 | 保留 MIT 许可声明；自愿致谢上游作者 | 上游原始图集：1600×1600 / 100×100 格 16×16 瓦片。离线留档，供 `scripts/bake_aitown_map.py` 复现 | 196,214 B | `5a13fdcc235660070e4c7b9185ed2cb7a854d5d9bd1837c2720e2ffd6c1dd99b` |
| `prototypes/assets/aitown_tilemap.json` | 同上 `public/assets/tilemap.json` | 仓库快照 / 2026-11-10 取回 | **MIT**（仓库） | 保留 MIT 许可声明 | Tiled 地图数据：40×40 格 / terrain、bridge、deco 三层。官方已经设计好的地图，是第三版 C 的真正来源 | 120,109 B | `b3099f9b2ab49487f33125ac9a2680902c2e429b5ce0030a82c440fb245a779a` |
| `prototypes/assets/aitown_32x32folk.png` | 同上 `public/assets/32x32folk.png` | 仓库快照 / 2026-11-10 取回 | **MIT**（仓库）；上游美术见下方致谢 | 保留 MIT 许可声明；自愿致谢上游作者 | 角色精灵图：384×256 = 96 帧 32×32，含 **4 方向 × 3 帧**行走动画。补齐了第一版 C 缺的多帧角色 | 179,178 B | `4f82a3bf6f037698ad94ae4b7309a43bd68e2397a04891de9717edc56e7630d5` |
| `prototypes/assets/aitown_map_crop.png` | 由上述图集 + 地图数据烘焙的**衍生品**，`scripts/bake_aitown_map.py` | 2026-11-10 生成 | **MIT**（沿用上游仓库许可） | 保留 MIT 许可声明与上游美术致谢 | 第三版 C 的场景底图：416×240 / 48 色 / 99,840 像素。裁自官方 40×40 地图的 (12,4) 起点，26×15 格 | 10,075 B | `323f5261f2a9c688ed54644aa9a48bde0bb6244c8781d0eef6b4eff1110ec125` |
| `prototypes/assets/LICENSE-ai-town.txt` | ai-town 仓库 `LICENSE` + 本项目的文件对应/致谢说明 | MIT 原文 / 2026-11-10 取回 | **MIT** | — | 随素材分发的许可原文与致谢（非美术文件） | 2,187 B | `7bb45d0dedd138eda8ae0a8cd134b646d61c043b143bb4a05d7fd50eed181b8e` |
| `prototypes/assets/kenney_tiny_dungeon_tilemap.png` | [Kenney · Tiny Dungeon](https://kenney.nl/assets/tiny-dungeon) | 1.0 / 2022-07-05，2026-11-10 下载 | **CC0 1.0** | 无（自愿致谢） | **v0.22 第一版 C 的反面教材留证**；v0.23 起页面与产物包均不再引用 | 5,294 B | `d24e60a41e4ac7a745c0304dfde121143688557f40215f23221c29cfe683825f` |
| `prototypes/assets/kenney_tiny_town_tilemap.png` | [Kenney · Tiny Town](https://kenney.nl/assets/tiny-town) | 1.1 / 2023-01-11，2026-11-10 下载 | **CC0 1.0** | 无（自愿致谢） | **v0.22 第一版 C 的反面教材留证**；v0.23 起页面与产物包均不再引用 | 5,042 B | `3a54d99ecde790d4fdea207a3644cf130fc56fa838f1beb1507c185a95b8e902` |

**当前在用素材实测**：地图裁片 416×240 / 48 色 / 9.8 KB；角色精灵 384×256 / 96 帧 / 175 KB；上游原始图集 1600×1600 / 10,000 个 16×16 瓦片 / 368 色 / 192 KB；地图 JSON 117 KB。
**已弃用素材实测**：两套 Kenney 图集合计 264 个 16×16 瓦片 / 46 种不透明颜色 / 54,467 个手绘像素 / 10,336 字节，保留仅为复盘留证。

**烘焙可复现**（离线、不联网）：

```
python scripts/bake_aitown_map.py
```

脚本读取 `aitown_tilemap.json` 与 `aitown_rpg-tileset.png`，按 Tiled 的翻转标志（H/V）合成 terrain / bridge / deco 三层，裁出 26×15 生成 `aitown_map_crop.png`。

**许可原文与致谢**：

- `prototypes/assets/LICENSE-ai-town.txt` —— ai-town 仓库 MIT 全文 + 文件对应关系 + 上游美术致谢。
- `prototypes/assets/LICENSE-tiny-dungeon.txt`、`prototypes/assets/LICENSE-tiny-town.txt` —— Kenney 两包 CC0 原文，随弃用素材一同保留。

ai-town README「Other credits」明确列出的上游美术来源（本项目据此致谢）：

- Tilesheet：opengameart.org 的 [16x16 Game Assets](https://opengameart.org/content/16x16-game-assets) by **George Bailey**、[16x16 RPG Tileset](https://opengameart.org/content/16x16-rpg-tileset) by **hilau**
- Original assets by **ansimuz**（[Tiny RPG Forest](https://opengameart.org/content/tiny-rpg-forest)）
- UI 原始素材 by **Mounir Tohami**

> 说明：仓库级 MIT 覆盖代码；上面的像素美术由 ai-town README 分别致谢上游作者，具体授权以各来源页为准。本项目非商用开源（ADR-015），无论是否有强制义务都保留署名。

## 明确未引入的素材

| 来源 | 许可 | 当前状态 |
|---|---|---|
| `pixel-agents` 角色（JIK-A-4 Metro City） | 需逐个核对 | 只借鉴交互与 BFS，不搬图 |
| LDtk 官方 samples（含 Nuclear Blaze） | 部分 CC-BY-SA 4.0 | 只看格式与 auto-layer 规则，不搬图 |
| WorkAdventure 代码与美术 | AGPL-3.0 + Commons Clause | 只看产品形态；v0.22 后不再「一行代码都不能进」，但当前仍无引入需求 |
| LPC（Liberated Pixel Cup） | CC-BY-SA 3.0 / GPL | 未引入；若引入需同等开放并署名 |

> **v0.23 变更**：`ai-town` 美术原列「只借鉴 `moveTo` 位置模型」，现已实际引入其官方地图与角色精灵，移入上方台账。

## CI 校验

`scripts/check_assets_license.py` 扫描资源目录中的图片/音频文件，逐个确认文件名出现在本台账的表格行中，且该行含可识别的许可字段；缺条目即退出码 1。M6-T9 剩余工作：把这一步挂到构建流水线（当前可手动运行）。

```
python scripts/check_assets_license.py
```

## 后续

- ~~正式版角色需要 4 方向 × 多帧精灵~~ ✅ **v0.23 已由 `aitown_32x32folk.png` 补齐**（4 方向 × 3 帧），第一版 C 的「单帧立绘 + 翻转」问题已消除。
- **碰撞层待统一**：第三版 C 直接使用上游官方地图，其树 / 栅栏 / 水域与 A/B 的家具障碍不一致；正式版由 LDtk 统一导出碰撞层（M6-T11），届时按新地图重跑台账登记。
- 若引入 LDtk 模板或其它烘焙后的分层 PNG，同样逐行登记（来源 / 许可 / 署名 / 生成脚本）。

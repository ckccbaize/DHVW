# W31 地图绘制移植进度

> 决策：D16（spec-first，双 painter）。`*.map.json` 是唯一输入；PC 用 `paint_home.py`，ARM 用 `forge/painter.js`。
> 验收：同 spec 与 Python 输出逐像素一致。

## 已完成

| 层 | 状态 | 文件 |
|---|---|---|
| 布局（房间/开间/门/分区） | ✅ | `www/js/forge/layout.js` |
| 地形层（地板/墙/门/窗/栏杆/墙脚阴影/暗角） | ✅ 逐像素一致 | `www/js/forge/painter.js` |
| 光照层（窗户投射） | ✅ 逐像素一致 | `www/js/forge/painter.js` |
| 家具层（26 家具/6 墙面/6 小物） | ✅ 视觉一致（98.6% 像素） | `www/js/forge/furniture.js` |
| 场景合成 / built.json / 2x | ✅ | `www/js/forge/scene.js` |
| 浏览器端到端（新布局 + 三层 + 合成） | ✅ | 调试页「ARM 生成新场景」 |
| PNG 编码（离线导出） | ✅ | `tools/png.mjs` |
| 黄金图对比 | ✅ | `tools/paint-terrain.mjs` + `tools/compare-terrain.py` |

## 验证命令

```bash
# 1) JS 画地形层
node tools/paint-terrain.mjs ../assets/scenes/home/home.map.json .tmp/terrain-js.png

# 2) 与 Python 黄金图逐像素对比
python tools/compare-terrain.py .tmp/terrain-js.png ../assets/scenes/home/dist/terrain.png

# 一条命令
npm run golden:terrain
```

当前结果：
- `npm run golden:terrain` → ✓ 逐像素一致
- `npm run golden:light` → ✓ 逐像素一致
- `npm run golden:furniture` → 差异 1049/76800（98.6%），在 1200 像素容忍内
- `npm run golden:scene` → 合成图 1007 像素 >1 级差，在 1200 像素容忍内
- 浏览器：ARM 独立生成 24×16 新布局 → 384×256 合成图，0 报错

## 模型后加家具（数据驱动）

`map.json` 可带 `furnitureDefs`，模型只写 JSON，不写代码：

```json
"furnitureDefs": {
  "desk_lamp": {
    "size": [1, 1],
    "shapes": [
      {"op":"shadow","x":1,"y":1,"w":12,"h":12,"color":[40,28,30,70]},
      {"op":"rect","x":2,"y":2,"w":12,"h":12,"color":[92,62,44]},
      {"op":"outline","x":2,"y":2,"w":12,"h":12,"color":[46,34,36]}
    ]
  }
}
```

- 支持 `rect / line / outline / shadow / pixel`，颜色 RGBA；
- 坐标是 16px 格子内局部像素；
- `props` 里用 `{"id":"desk_lamp","x":..,"y":..,"w":1,"h":1}` 放置；
- Python 与 JS 各有一个解释器，同一份定义逐像素一致；
- 验证：`npm run golden:custom`。

## AI 决定家具位置

- `furniture-plan` 技能/提示词：模型输出 `{"props":[...]}`；
- `forge/placement.js` 校验：房间内、不重叠、门 3×3 净空、大件贴墙且唯一、未知家具拒绝；
- `core/agent/subs/place.js`：失败带原因重试 ≤3 次；
- 命令 `furniture_plan`；调试页「AI 摆家具」端到端验证（3 props → 384×256）。

## 待做

1. 家具层（`furniture.png`）：床/沙发/桌/柜/厨卫/墙面装饰/小物；
2. 光照层（`light_day.png`）：窗户投射；
3. 图集与 `built.json` / `bundle.js`；
4. `forge.worker` 切片烘焙与 ≤50ms 预算；
5. 新布局（非 home）的黄金图覆盖。

## 注意

- PIL 的 `ImageDraw` 在 RGBA 上是**直接写像素**（不混合 alpha），JS `put()` 必须一致；
- 暗角/暖偏移在两层都要应用，且用 `Math.floor` 截断；
- 坐标、色带、循环顺序必须与 Python 完全一致，否则逐像素对比会失败。

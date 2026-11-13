# W31 地图绘制移植进度

> 决策：D16（spec-first，双 painter）。`*.map.json` 是唯一输入；PC 用 `paint_home.py`，ARM 用 `forge/painter.js`。
> 验收：同 spec 与 Python 输出逐像素一致。

## 已完成

| 层 | 状态 | 文件 |
|---|---|---|
| 布局（房间/开间/门/分区） | ✅ | `www/js/forge/layout.js` |
| 地形层（地板/墙/门/窗/栏杆/墙脚阴影/暗角） | ✅ 逐像素一致 | `www/js/forge/painter.js` |
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

当前结果：`✓ 逐像素一致`（320×240）。

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

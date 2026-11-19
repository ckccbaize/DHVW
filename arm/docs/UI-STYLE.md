# 设备 UI 风格约定

> 上游规范：`docs/design.md`（赛璐璐动画风）。设备侧实现：`www/css/cel.css`。
> 目标：与 PC 端同一套视觉语言；像素场景 + 平涂 UI。

## 1. 设计令牌

| Token | 值 | 用途 |
|---|---|---|
| `--color-ink` | `#1a1a2e` | 3px 描边、硬阴影、文字 |
| `--color-cel-white` | `#fafaf5` | 页面/卡片底色 |
| `--color-red` | `#e63946` | 主行动、开关 |
| `--color-aqua` | `#4ea8de` | 信息 |
| `--color-grass` | `#2ecc71` | 在线/成功 |
| `--color-sunset` | `#f1c40f` | 高亮/边缘档 |

- 零圆角（徽标除外）；
- 3px 墨线包住控件；
- 硬阴影 `4px 4px 0 ink`，hover `6px 6px 0 ink`；
- 过渡 75ms linear；按下 `scaleX(1.1) scaleY(0.9)` + 位移，阴影归零；
- 不用渐变、模糊阴影、ease-in-out。

## 2. 像素字体

- 字体：**Fusion Pixel 12px Proportional Simplified Chinese**（MIT，随包）；
- 位置：`www/assets/fonts/fusion-pixel/`；
- 引入：`Fusion-Pixel-12px-Proportional-Simplified-Chinese.css`；
- CSS 变量：`--font-pixel`；
- 关闭抗锯齿：`-webkit-font-smoothing: none; font-smooth: never;`。

字体许可证随目录保留 `LICENSE.txt`。

## 3. 文件

| 文件 | 作用 |
|---|---|
| `www/css/app.css` | 布局/场景/动画骨架 |
| `www/css/cel.css` | 赛璐璐覆盖层（颜色/描边/阴影/字体） |
| `www/observe.html` | 观测页（同一套令牌） |
| `www/debug-core.html` | 开发调试页，保持深色，不参与设备视觉验收 |

## 4. 布局约束

- 控件不得被挤出容器：`min-width: 0`、`flex-wrap`、按钮 `flex-shrink: 0`；
- 窄屏优先牺牲次要信息，保住操作按钮；
- 已在 1020 / 760 / 520 / 420 四档宽度验证：无横向滚动、开关可见。

## 5. 验收

- `document.fonts.check('12px "Fusion Pixel 12px Proportional Simplified Chinese"')` 为 true；
- 控件 `border-width: 3px`、`border-radius: 0`、硬阴影；
- 页面无横向滚动；
- 截图与 PC 端同风格（平涂/墨线/硬阴影）。

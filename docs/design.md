# 赛璐璐动画风 — 风格参考

> 粗墨线、平涂、硬阴影：手绘动画的每一帧都只有两种颜色。

**Theme:** light

赛璐璐来自传统动画的赛璐璐片上色法：每个色块都是平的，阴影只有一层并且是硬的，边缘用 3px 墨线勾出来。落到界面上有一条独特的时间规则——过渡只有 75ms，因为动画是抽帧的，不是流体缓动的；缓动必须用 linear 或 ease-in，绝不使用 ease-in-out。按下时元素做挤压变形（横向 110%、纵向 90%）并下沉，这是卡通物理而不是材料物理。

## Colors

| Name | Value | Token | Role |
|---|---|---|---|
| Ink | `#1a1a2e` | `--color-ink` | 所有 3px 描边、硬阴影与文字。墨线是这套风格的骨架。 |
| Cel White | `#fafaf5` | `--color-cel-white` | 平涂底色。略带暖调，像动画用的赛璐璐片。 |
| Red | `#e63946` | `--color-red` | 主行动与高能状态。平涂、不渐变。 |
| Aqua | `#4ea8de` | `--color-aqua` | 信息与次级行动，是画面里的冷色块。 |
| Grass | `#2ecc71` | `--color-grass` | 成功与生命值，卡通语义里的正向。 |
| Sunset | `#f1c40f` | `--color-sunset` | 高亮与能量，用于强调条与徽标。 |

## Typography

### Inter — 全站唯一字体，只用 700 与 900。全大写、行高 1.0，让文字像标题框。

- **Substitute:** 'Arial Black', Helvetica, sans-serif
- **Weights:** 700, 900
- **Sizes:** 14, 16, 20, 28, 40, 56
- **Line height:** 1 (display), 1.1 (headings), 1.5 (body)
- **Letter spacing:** -0.02em on display, 0.04em on uppercase labels

### Type Scale

| Role | Family | Weight | Size | Line Height | Letter Spacing | Token |
|---|---|---|---|---|---|---|
| display | — | 900 | 56px | 1 | -0.02em | `--text-display` |
| heading | — | 900 | 40px | 1.05 | — | `--text-heading` |
| subheading | — | 700 | 28px | 1.1 | — | `--text-subheading` |
| body-lg | — | 700 | 16px | 1.5 | — | `--text-body-lg` |
| body | — | 700 | 14px | 1.5 | — | `--text-body` |
| label | — | 700 | 14px | 1.35 | 0.04em | `--text-label` |

## Spacing & Layout

**Base unit:** 8px
**Density:** comfortable

### Spacing Scale

| Name | Value | Token |
|---|---|---|
| 8 | 8px | `--spacing-8` |
| 16 | 16px | `--spacing-16` |
| 24 | 24px | `--spacing-24` |
| 32 | 32px | `--spacing-32` |
| 48 | 48px | `--spacing-48` |
| 64 | 64px | `--spacing-64` |
| 96 | 96px | `--spacing-96` |

### Border Radius

| Element | Value |
|---|---|
| cards | 0 |
| buttons | 0 |
| inputs | 0 |
| badges | 999px |

- **Page max-width:** 1120px
- **Section gap:** 80px
- **Card padding:** 24px
- **Element gap:** 16px

## Components

### Cel Button

**Role:** 主行动按钮

赤色平涂、白字、3px 墨线描边、零圆角、4px 硬阴影，14px/900 全大写、padding 12px 24px。hover 时填充提亮到 #ff4d5a、上浮 4px、阴影扩到 6px，并有一道斜切白色 30% 的高光从左掠到右（300ms linear）。按下时横向缩放 1.1、纵向 0.9、位移 4px 8px、阴影归零——这是挤压变形，不是位移。过渡 75ms linear。

- **Sizes:** padding 12px 24px; label 14px
- **States:** hover: lift 4px, shadow 6px; active: scaleX 1.1, scaleY 0.9, shadow none

### Cel Card

**Role:** 内容卡与分镜卡

纸白平涂、3px 墨线描边、零圆角、内边距 24px、4px 硬阴影。标题 28px/900 全大写，正文 14px/700，字色 60% 墨。hover 时上浮并左移各 2px、阴影扩到 6px。过渡 75ms linear。

### Ink Divider

**Role:** 分区与描边线

3px 纯墨线，横跨内容宽或全宽。用于分隔区块而不是留白——这套风格更依赖线条分区。允许 8px 的短粗线作为强调标记。

### Impact Badge

**Role:** 状态与能量徽标

橙黄或草绿平涂、3px 墨线、999px 全圆角、14px/900 全大写、padding 4px 12px，可带 3px 硬阴影。用于「新」「完成」「关键」等一次性标记。

### Speed Lines

**Role:** 速度线与动势装饰

3 到 5 条 3px 墨线，长度 24px 到 64px 不等，以 15 度斜向排列在元素一侧，间距 8px。用于暗示运动方向，只出现在交互元素上，静态区块不加。

## Do's and Don'ts

### Do

- 3px 墨线包住每个元素
- 平涂填充，不用渐变
- 阴影只有一层且无模糊
- 过渡 75ms，缓动 linear 或 ease-in
- 按下做挤压变形（110%/90%）
- 零圆角，徽标除外

### Don't

- 不要用渐变色
- 不要用细边框
- 不要用低饱和或灰色调
- 不要用 300ms 以上的丝滑过渡
- 不要用 ease-in-out
- 不要用模糊阴影

## Surfaces

| Level | Name | Value | Purpose |
|---|---|---|---|
| 0 | Cel White | `#fafaf5` | 页面底 |
| 1 | Red Block | `#e63946` | 强调区块 |
| 2 | Aqua Block | `#4ea8de` | 信息区块 |

## Elevation

- **Hard shadow:** `4px 4px 0 #1a1a2e`
- **Hard shadow hover:** `6px 6px 0 #1a1a2e`
- **Pressed:** `none`

## Imagery

平涂插画与赛璐璐上色：两种明度、硬边阴影、3px 描边。允许角色与道具插画。不使用摄影、渐变与柔和阴影。

## Layout

上限 1120px、容器内边距 24px，区块间距 80px。元素可以轻微重叠与错位，像分镜排列。所有区块用 3px 墨线分隔，留白比其它硬边风格略少，因为线条本身承担了分隔。

## Agent Prompt Guide

### Implementation Contract

- 以用户请求中的页面、用户任务和真实内容为依据，只实施指定范围；标明缺失的业务信息，不编造数据或能力。
- 先检查现有项目、技术栈与组件；沿用项目结构、路由和依赖，复用已有组件，不重建未要求的页面或功能。
- 沿用项目断点，调整窄屏与桌面的网格和留白；保留信息层级，避免意外横向溢出。
- 对本次涉及的交互，处理键盘焦点与减少动态效果；补齐适用的禁用、加载、空内容与错误状态。
- 完成后按项目现有脚本检查，仅报告实际运行的测试与视觉检查，并列出未验证项。

QUICK COLOR REFERENCE:

- text: `#1a1a2e`
- background: `#fafaf5`
- red: `#e63946`
- aqua: `#4ea8de`
- grass: `#2ecc71`
- sunset: `#f1c40f`

EXAMPLE COMPONENT PROMPTS:

1. 做一个赛璐璐动画风按钮：背景 #e63946、白字、3px solid #1a1a2e 边框、border-radius 0、900 字重 14px 全大写、padding 12px 24px、box-shadow 4px 4px 0 #1a1a2e。hover 时背景 #ff4d5a、translateY(-4px)、阴影扩到 6px 6px 0 #1a1a2e。active 时 scaleX(1.1) scaleY(0.9) translate(4px,8px) 且阴影 none。transition 75ms linear。页面底色 #fafaf5。

## Similar Brands

- **Comic Style** — 同为粗描边平涂，但漫画用对话气泡与网点，赛璐璐用挤压物理
- **Neo-Brutalist Soft** — 同样硬阴影与粗边，但那边更柔和克制、没有挤压变形

## Quick Start

```css

:root {
  /* Colors */
  --color-ink: #1a1a2e;
  --color-cel-white: #fafaf5;
  --color-red: #e63946;
  --color-aqua: #4ea8de;
  --color-grass: #2ecc71;
  --color-sunset: #f1c40f;

  /* Typography — Font Families */
  --font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

  /* Typography — Scale */
  --text-display: 56px;
  --leading-display: 1;
  --tracking-display: -0.02em;
  --text-heading: 40px;
  --leading-heading: 1.05;
  --text-subheading: 28px;
  --leading-subheading: 1.1;
  --text-body-lg: 16px;
  --leading-body-lg: 1.5;
  --text-body: 14px;
  --leading-body: 1.5;
  --text-label: 14px;
  --leading-label: 1.35;
  --tracking-label: 0.04em;

  /* Typography — Weights */
  --font-weight-bold: 700;
  --font-weight-black: 900;

  /* Spacing */
  --spacing-unit: 8px;
  --spacing-8: 8px;
  --spacing-16: 16px;
  --spacing-24: 24px;
  --spacing-32: 32px;
  --spacing-48: 48px;
  --spacing-64: 64px;
  --spacing-96: 96px;

  /* Layout */
  --page-max-width: 1120px;
  --section-gap: 80px;
  --card-padding: 24px;
  --element-gap: 16px;
  --density: comfortable;

  /* Border Radius */
  --radius-cards: 0;
  --radius-buttons: 0;
  --radius-inputs: 0;
  --radius-badges: 999px;

  /* Surfaces */
  --surface-cel-white: #fafaf5;
  --surface-red-block: #e63946;
  --surface-aqua-block: #4ea8de;
}

```

## 布局硬约束（开发即验证）

- 任何控件都不许被挤出所在容器：`min-width: 0` + `flex-wrap` + `button { flex-shrink: 0 }` 是默认写法。
- 窄窗口优先牺牲次要列（`.col-optional`），保住操作按钮；表格容器允许横向滚动但不裁切按钮。
- 提交前跑 `npm run audit:layout`：连接 dev 外壳，在 1020/900/760/640/520/420 六档宽度下检查「页面横向滚动、控件越出视口、容器横向溢出、按钮被裁切」，任何一条都算失败。

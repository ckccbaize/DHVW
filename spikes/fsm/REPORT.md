# W2 状态机选型报告（XState vs 纯 reducer）

> 日期：2026-11-12。样本：世界状态机（display × conn × tier 三个并行维度，9 个事件）。
> 复现：`npm install && node spikes/fsm/compare.mjs && node --test tests/fsm.test.mjs`

## 1. 结论

**选纯 reducer（数据驱动 + `GRAPH` 描述）**，不引入 XState。

理由按权重排序：

1. **无构建静态站**：XState 的 14.2KB gzip 是 tree-shaken 后的数字；本项目没有打包器，实际要 vendor 7 个 ESM 文件，**161.2KB min / 41.5KB gzip**。
2. **图很小**：3 个并行维度、9 个事件。reducer 120 行，XState 125 行——**代码量没有优势**。
3. **跨区域守卫要镜像状态**：XState 的 guard 只能读 `context`，判断"当前是否在 present/host"必须把状态复制进 context（本 spike 里就是这么做的），等于自己维护一份冗余状态。
4. **快照更小**：reducer 62B JSON，XState 持久化快照 183B；恢复分别是 `restore(json)`（10 行）与 `createActor(machine,{snapshot})`。
5. **可视化与统计不依赖库**：`GRAPH` 导出状态/迁移，`transition()` 外面包一层计数即可做统计；不需要 Stately 或 actor inspector。

## 2. 实测数据

| 指标 | 纯 reducer | XState v5.33.4 |
|---|---|---|
| 代码行（不含注释） | 120 | 125 |
| 运行时依赖 | 0 | 7 文件 / 161.2KB min / **41.5KB gzip** |
| 快照大小 | **62 B** | 183 B |
| 恢复代码 | `restore(json)`，10 行 | `createActor(machine,{snapshot})` |
| 跨区域守卫 | 直接读 state | 需把 state 镜像进 context |
| 可视化 | `GRAPH` 数据 → 自绘 SVG | 可用 `@xstate/graph`（额外依赖） |
| 等价性 | — | **6/6 事件序列完全一致** |

## 3. 等价性验证

`spikes/fsm/compare.mjs` 跑 6 条序列（含非法组合、丢主机、跨夜档位切换、重复事件），两种实现的 `{display, conn, tier, illegal}` 全部一致。`tests/fsm.test.mjs` 固化了其中 5 条。

## 4. 什么时候重新评估 XState

满足任一条再回来看：

- 状态数 > 20，或出现 history 状态、延迟迁移（after）、嵌套 actor 监督；
- 需要"一个状态机管多个独立 actor"（例如每个任务一个 actor）；
- 团队更熟悉 XState，愿意为可视化/调试付 41.5KB。

## 5. 对主线的落地

- `core/machine/world.js` 用本 spike 的 reducer 形态（纯函数 + `GRAPH`）；
- 统计：在 `transition()` 外层记录 `(from,event,to)` 计数与驻留时长；
- 可视化：`debug.html` 用 `GRAPH` 画 SVG，当前态高亮；
- 快照：`snapshot()/restore()` 直接进 IndexedDB（W6）。

> 注：`xstate` 只作为 devDependency 用于复现本报告，不进入设备产物。

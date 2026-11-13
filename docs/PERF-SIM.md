# 本机性能模拟（不做设备部署）

> 目的：在 PC 浏览器里跑设备页面，观察 FPS / JS 堆 / 长任务 / DOM / CPU 任务时长。
> 设备部署延后；本机稳定后再真机。

## 1. 打开方式

```bash
node tools/serve.mjs        # 或 cd shell && go run . -dev
# 浏览器
http://127.0.0.1:8080/index.html?perf=1
```

`?perf=1` 左下角显示：

```
fps 24 · heap 2.9MB · long 0 · dom 51
```

- `fps`：总观绘制帧率（静止 8、行走 30 上限）；
- `heap`：`performance.memory.usedJSHeapSize`；
- `long`：长任务数量 / 最长耗时；
- `dom`：节点数。

## 2. 实测（2026-11-13，headless Chromium）

| 指标 | 结果 |
|---|---|
| JS 堆 | 2.8 → 3.5MB，约 40s 后稳定在 3.3–3.5MB |
| 长任务 | 0 |
| DOM 节点 | 51 |
| TaskDuration | 0.56s / ~40s（约 1.4% CPU 时间） |
| ScriptDuration | 0.067s |
| LayoutDuration | 0.123s |
| 页面错误 | 0 |

headless 下 rAF 被节流，FPS 显示 7–24，不代表真机；真机需另测。

## 3. 观察结论

- 内存无持续增长，40s 后趋于平稳；
- 无长任务，主线程未被阻塞；
- 布局/样式重算占比很低；
- 主要成本在 Canvas 绘制（`overview.draw`），与预期一致。

## 4. 后续

- 真机：用同一 `?perf=1` 记录 8h 内存/FPS；
- 若堆持续增长，优先查 `eventLog`、`forge` 资产缓存、气泡/日志数组上限；
- 设备部署（D 组）暂缓。

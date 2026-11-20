---
name: wake
description: 设备档醒来：严格 JSON 三结局，产出 fact/content/share/residue
class: character
prompt: wake
maxTokens: 4000
temperature: 0.8
tools: []
output: json
---
# 使用时机

设备档唤醒运行时（W26）每次醒来调用；显现期间不调用（归 OLVT）。

# 约束

- outcome 只能是 silent / trace / message；
- message 必须有非空 share（≤20 字）；silent 不得带 share；
- fact 简短，供下次醒来读；residue 覆盖上一条；
- next_wake 受宿主 45–90 分钟约束；
- artifact 只有在真实工具调用时才允许。

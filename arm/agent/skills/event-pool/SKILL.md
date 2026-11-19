---
name: event-pool
description: 生成新的日常事件，扩展剧情事件池
class: work
prompt: event-pool
maxTokens: 600
temperature: 0.9
tools: []
output: json
---
# 使用时机

事件池剩余可用事件不足，或距上次刷新超过 6 小时时，由调度器在 idle/asleep 执行。

# 约束

- 一次 4-8 条，具体、可拍成画面；
- 与已有事件相似度 <0.6；
- 字段与内置事件一致：text/hours/place/mood/imageQuery。

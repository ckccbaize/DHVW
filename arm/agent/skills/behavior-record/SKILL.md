---
name: behavior-record
description: 行为留档：由角色 LLM 写一条含"做了什么 + 心情变化"的短记录
class: character
prompt: behavior-record
maxTokens: 2000
temperature: 0.7
tools: []
output: json
---
# 使用时机

每次自主行为执行完（出门/上网/居家/休息）后调用，结果写入 behavior_log 与事件日志。

# 约束

- 20-60 字，包含做了什么与心情变化；
- 不写台词，不解释系统；
- 只输出 JSON：summary / mood / evidence（可选）。

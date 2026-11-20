---
name: memory-summarize
description: 把事件归纳成稳定事实，供本地记忆与 PC 向量库
class: work
prompt: memory-summarize
maxTokens: 6000
temperature: 0.3
tools: []
output: json
---
# 使用时机

记忆管线（W23）攒够事件后调用；一次 3–8 条事实。

# 约束

- 只输出 JSON `{"facts":[{"text":"...","tier":"L2"}]}`；
- 每条 10–60 字，写稳定事实，不写对话/情绪/系统日志；
- 与已有事实重复的不要输出。

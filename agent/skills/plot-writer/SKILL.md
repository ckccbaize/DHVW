---
name: plot-writer
description: 工作层：根据生活事件生成 30-80 字剧情
class: work
prompt: plot
maxTokens: 400
temperature: 0.5
tools: []
output: text
---
# 使用时机

端侧/主机档需要新剧情，且本地文法未命中时调用。

# 约束

- 30-80 字，含时间锚点；
- 不写台词，只写"她做了什么/感受到什么"；
- 24 小时内不重复。

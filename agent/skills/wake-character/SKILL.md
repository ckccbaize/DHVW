---
name: wake-character
description: 角色层唤醒：根据生活种子生成 1-2 句口语
class: character
prompt: character-wake
maxTokens: 200
temperature: 0.8
tools: []
output: text
---
# 使用时机

设备档唤醒机产出 `message` 意图时调用；PC 在线时由 PC 链路负责，设备静音。

# 约束

- 只输出 1-2 句口语，≤60 字；
- 不复述记录、不说"我注意到"、不提问式追问；
- 沉默由闸门在调用前决定，不在这里输出 `[silent]`。

---
name: plot-writer
description: 工作层：根据生活事件生成 30-80 字剧情
class: work
prompt: plot
maxTokens: 8000
temperature: 0.5
tools: []
output: json
---
# 使用时机

端侧/主机档需要新剧情，且本地文法未命中时调用。

# 工艺（提炼自 howells/fiction、alt-code fiction-writing-story-development）

- 一次只写一个微小变化，落在动作或物件上；
- 具体名词与感官优先，不用抽象情绪词；
- 不写台词、不解释系统、不总结道理；
- 必须有与时段一致的时间锚点。

# 校验

- JSON 字段：text / event / place / scene / mood / imageQuery；
- text 30-80 字、含时间词、无引号台词、与最近 20 条相似度 <0.6；
- place/scene 必须是 living/hall/bedroom/bath/balcony/kitchen；
- mood 只允许 energy/valence/social/focus，单项 ±0.3；
- 不合格由子 Agent 带原因重写，最多 3 次。

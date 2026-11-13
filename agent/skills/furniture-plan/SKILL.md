---
name: furniture-plan
description: 根据户型与意图决定家具摆放位置，输出 props JSON
class: work
prompt: furniture-plan
maxTokens: 700
temperature: 0.4
tools: []
output: json
---
# 使用时机

新场景生成后、或角色想重新布置房间时调用。

# 约束

- 只输出 `{"props":[...]}`，不写代码；
- 家具必须在房间内、互不重叠；
- 门内侧 3×3 留空；
- 大件必须贴墙且同类唯一；
- 地毯/门垫/浴垫不挡路，可叠在家具下。

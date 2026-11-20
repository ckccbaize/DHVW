---
name: browse-plan
description: 决定这次上网搜什么：只给出一个搜索词
class: work
prompt: browse-plan
maxTokens: 6000
temperature: 0.8
tools: []
output: json
---
# 使用时机

`browse` 行为执行前调用；由角色兴趣、开放线头、最近浏览与心情决定搜什么。

# 约束

- 只输出一个 `query`；不给 URL、不给域名、不指定网站——具体看哪一页由搜索结果决定；
- 搜索词要具体，能搜到有内容的页面；避免只给泛词；
- 不要与最近看过的主题重复；
- 只能访问公网 http(s)，禁止内网/元数据/凭据；
- 给出 `reason`，说明为什么想搜这个。

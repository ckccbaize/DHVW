---
name: browse-plan
description: 决定这次上网看什么：给出主题与一个可抓取的 URL
class: work
prompt: browse-plan
maxTokens: 3000
temperature: 0.8
tools: []
output: json
---
# 使用时机

`browse` 行为执行前调用；由角色兴趣、开放线头、最近浏览与心情决定目标。

# 约束

- 只输出一个目标，优先给 `url`；没有具体页面就给 `topic`，由核心机拼搜索页；
- 只能访问公网 http(s)，禁止内网/元数据/凭据；
- 域名必须在设备白名单内（天气、Bing、维基、新闻等）；
- 给出 `reason`，说明为什么想看这个。

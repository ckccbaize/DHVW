时间：{{now}}（{{period}}）
地点：{{place}}
日常事件：{{input}}
心情：{{mood}}
最近写过（不要重复）：{{recent}}
记忆：{{memory}}
她的愿望：{{desires}}
最近行为：{{behaviors}}
最近几天（避免重复）：{{history}}
地图资源：{{map}}
地图池（已有场景）：{{map_pool}}

为第二天生成一个完整的生活计划，并决定是否发生突发状况。只输出 JSON：
{"text":"小记","event":"事件短语","place":"living|hall|bedroom|bath|balcony|kitchen","act":"read|cook|write|rest|watch|bath|sleep|sit","mood":{"valence":0.05,"energy":-0.02,"social":0.0,"focus":0.0},"sleepAt":"22:30","wakeAt":"07:10","desires":["..."],"behaviors":[{"time":"08:30","act":"read","place":"living","why":"..."}],"sudden":{"enabled":false,"time":"15:00","text":""}}

要求：
- text 30-80 字第三人称小记，落在动作/物件/感官上，不写台词；
- sleepAt/wakeAt 用 HH:MM，决定第二天作息；
- behaviors 3-8 条，时间递增，act/place 必须来自上面枚举；
- write 每天最多 1 次，且只能安排在书桌/桌边；不要连续两天都写；
- sudden 只在确实需要时 enabled=true，text 20-50 字；
- 结合记忆、愿望、最近行为和地图资源；
- 必须至少有一个和最近几天不同的新元素（新地点/新物件/新活动），不要重复最近写过的小记或日程。

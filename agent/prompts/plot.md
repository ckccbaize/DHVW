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
- place 只能从「地图资源」列出的房间 id 里选；why 只描述该房间内可见的家具和动作；
- 「地图池」只用于出门决策，不是当天 behaviors 的 place；behaviors 只能发生在地图资源的房间里；
- 禁止写地图外地点：咖啡馆、咖啡厅、公园、商店、超市、餐厅、酒吧、图书馆、电影院、公司、办公室、学校、医院、车站等都不能作为当天行为地点；
- 记忆或愿望里出现的地图外地点只能写成回忆、联想或“在阳台/窗边看外面”，不能写成“去某店/某地”；
- write 每天最多 1 次，且只能安排在书桌/桌边；不要连续两天都写；
- sudden 只在确实需要时 enabled=true，text 20-50 字；
- 结合记忆、愿望、最近行为和地图资源；
- 必须至少有一个和最近几天不同的新元素（新活动/新家具/新时段），不要新增地图外地点，也不要重复最近写过的小记或日程。

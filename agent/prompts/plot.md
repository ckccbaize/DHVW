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
{"text":"小记","event":"事件短语","place":"living|hall|bedroom|bath|balcony|kitchen","act":"read|cook|write|rest|watch|bath|sleep|sit","mood":{"valence":0.05,"energy":-0.02,"social":0.0,"focus":0.0},"sleepAt":"22:30","wakeAt":"07:10","desires":["..."],"behaviors":[{"time":"08:30","act":"read","place":"living","why":"...","durationMin":45,"overnight":false}],"sudden":{"enabled":false,"time":"15:00","text":""}}

要求：
- text 30-80 字第三人称小记，落在动作/物件/感官上，不写台词；
- sleepAt/wakeAt 用 HH:MM，决定第二天作息；
- behaviors 3-8 条，时间递增，act/place 必须来自上面枚举或「地图池」；
- place 可以是「地图资源」里的房间 id，也可以是「地图池」里的场景 id；why 只描述该地点内可见的家具和动作；
- 每个行为都要判断“要不要去、去多久”：外部场景必须写 durationMin（15-240 分钟），表示到达后停留多久；不要默认整天；
- 停留时长由你根据场景自行判断：咖啡馆 45-90 分钟、公园 30-60 分钟、图书馆 60-120 分钟、书店 30-60 分钟；不要所有场景都用同一个时长；
- 只有确实需要停留才把外部场景写进 behaviors；只是路过、不打算停留就不要写；
- overnight 默认 false：外部场景不可过夜时必须当天回家，且回家时间要早于 sleepAt；不要安排“睡在咖啡馆/公园”；
- 只有「地图池」条目明确写了 overnight:true 才能把 overnight 设为 true；当前没有可过夜场景，所以一律 false；
- 禁止编造「地图池」里没有的地点；咖啡馆/公园/书店等必须使用地图池给出的 id，不能自己写新名字；
- 记忆或愿望里出现的地图外地点只能写成回忆、联想或“在阳台/窗边看外面”，不能写成“去某店/某地”；
- write 每天最多 1 次，且只能安排在书桌/桌边；不要连续两天都写；
- sudden 只在确实需要时 enabled=true，text 20-50 字；
- 结合记忆、愿望、最近行为和地图资源；
- 必须至少有一个和最近几天不同的新元素（新活动/新家具/新时段），不要新增地图外地点，也不要重复最近写过的小记或日程。

时间：{{now}}（{{period}}）
地点：{{place}}
日常事件：{{input}}
心情：{{mood}}
最近写过（不要重复）：{{recent}}

写一段 30-80 字第三人称小记，并给出驱动字段。只输出 JSON：
{"text":"小记","event":"事件短语","place":"living|hall|bedroom|bath|balcony|kitchen","scene":"同上","mood":{"valence":0.05,"energy":-0.02},"imageQuery":"背景图检索词"}

text 要求：
- 只写她做了什么、一个微小的变化，落在动作或物件上；
- 用具体名词和感官（雨、窗、杯子、指尖），不用"美好/温暖/孤独"这类抽象词；
- 不写台词，不解释系统，不总结心情，不写"她感到……"；
- 必须出现与当前时段一致的时间词（如 清晨/下午/傍晚/夜里）。

mood 只允许 energy / valence / social / focus，每项 -0.3~0.3。
imageQuery 用具体场景词，便于搜索背景图。

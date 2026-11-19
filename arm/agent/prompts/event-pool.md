已有事件（不要重复）：{{existing}}

生成 {{count}} 条新的日常生活事件，只输出 JSON：
{"events":[{"text":"4-24字事件","hours":[8,9],"place":"kitchen","mood":{"valence":0.05},"imageQuery":"英文检索词"}]}

要求：
- 具体、能拍成一个画面，写她正在做的一件小事；
- hours 用 0-23 的整数数组，覆盖不同时段；
- place 只能是 living/hall/bedroom/bath/balcony/kitchen；
- mood 只允许 energy/valence/social/focus，单项 ±0.3；
- 不要与已有事件重复，也不要写台词或抽象情绪。

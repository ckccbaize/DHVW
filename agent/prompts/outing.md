她现在在「{{current}}」。
心情：{{mood}}
无聊度：{{boredom}}（0–1，越高越想出门）
最近行为：{{recent}}
深层记忆：
{{memory}}

已有场景池（不能选 home / office）：
{{map_pool}}

请决定这次出门去哪里。只输出一个 JSON：
- 去已有场景：
  {"mode":"existing","placeId":"场景 id","reason":"为什么去这里"}
- 新建场景：
  {"mode":"new","kind":"indoor|street","name":"场景名（≤20 字）","description":"场景描述，包含空间、家具、光线、气氛","distance":3,"reason":"为什么需要新场景"}

规则：
- 优先已有场景；只有记忆/愿望明确需要新环境时才新建。
- 已有场景只能从 map_pool 里选，不能选 home / office。
- 新场景必须和记忆里的愿望或最近经历有关，不要随机编造。
- 只输出 JSON，不要解释。

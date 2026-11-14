根据描述生成一个完整、可运行的像素场景。只输出 JSON，不要解释。

场景意图：{{description}}
类型：{{kind}}
名称：{{name}}
网格：{{grid}}（cell=16，坐标从 0 开始，四周留 1 格墙）

可用家具 id（只能从这里选）：
{{furniture}}

可用动作 id：
{{acts}}

可用动画名（perform.animation 只能从这里选）：
{{animations}}

效果枚举：
{{effects}}

输出结构：
{
  "name": "场景名",
  "kind": "{{kind}}",
  "grid": {"w": 32, "h": 24, "cell": 16},
  "rooms": [{"id":"main","name":"主厅","kind":"cafe","rect":[1,1,30,22],"floor":"wood"}],
  "doors": [{"id":"door","x":16,"y":23,"to":"outside"}],
  "windows": [{"x":5,"y":0}],
  "props": [{"id":"counter","x":3,"y":3,"w":3,"h":1,"room":"main","facing":"S"}],
  "wallProps": [],
  "spawn": {"x":16,"y":21},
  "interactions": {
    "schema_version": 1,
    "acts": {
      "cook": {
        "label":"做饭",
        "trigger":{"props":["counter","stove"]},
        "perform":{"animation":"cook","duration_min":35,"interruptible":true},
        "effects":[{"kind":"event","name":"cook"}],
        "priority":5
      }
    }
  },
  "routes": [
    {"id":"spawn_counter","from":[16,21],"to":[4,4],"waypoints":[[16,21],[10,21],[10,4],[4,4]]}
  ]
}

要求：
- 房间必须互相连通；门格、出生点、路线 waypoint 必须可走；
- 家具必须落在房间内、互不重叠，并给可交互家具绑定 act；
- interactions 的 trigger.props 必须出现在 props 里；perform.animation 必须是可用动作的动画；
- 每个可交互家具至少一个 act；路线覆盖出生点到主要交互点；
- 不要输出坐标数组以外的解释，不要输出代码。

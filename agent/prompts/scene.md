根据描述生成一个完整、可运行的像素场景。只输出 JSON，不要解释。

场景意图：{{description}}
类型：{{kind}}
名称：{{name}}
网格：{{grid}}（cell=16，坐标从 0 开始，四周留 1 格墙；必须严格使用这个尺寸，不要输出别的尺寸）

系统已生成户型骨架（MAP-SCENE-DESIGN §3.5：1-2 间封闭房 + 开放 zones）。不要修改 rooms/zones/doors/windows；只填 props/interactions/routes/spawn/name：
{{layout}}

可用家具 id（可选素材，不是上限）：
{{furniture}}

可用动作 id：
{{acts}}

可用动画名（perform.animation 只能从这里选）：
{{animations}}

效果枚举：
{{effects}}

必须遵守 MAP-SCENE-DESIGN §3.5 的户型规则：
- 封闭房间最多 2 间；其余功能区用 zones 换地面，不砌墙；
- 两间封闭房必须对角错开，不能同高并列/同宽叠列，尺寸不能完全相同；
- 开放面积 ≥ 50%；zones 至少 2 个，每个 ≥ 6 格；
- 房间尺寸各不相同，整体紧凑；禁止一排同高盒子；
- 每个 3×3 区块至少有 1 件家具/地毯/小物（门净空 3×3 除外）；
- 大件（bed/wardrobe/dresser/desk/bookshelf/sofa/tv/counter/stove/fridge/table/bench/cat_tree/coffee_table）每类全图最多 1 件；公共场景需要多张桌子时，用 shape 自定义 `cafe_table_2`、`cafe_table_3`，不要重复 `table`；chair 可以重复；
- 门内侧 3×3 不得有家具；
- 每个 prop/zone/room 必须有唯一 name；
- 床/柜/书架/台面/灶/冰箱/浴缸/马桶/洗手盆/洗衣机/电视/桌/立架/猫爬架必须有一边贴墙；
- 有 facing 的家具正面不得朝墙；沙发背靠墙；床尾不得正对门；电视朝沙发；
- 家具必须完整落在所属 room/zone 内，互不重叠。

输出结构（示例只展示字段；户型必须使用上面的 layout，家具必须补到 45–65 件，不能只放示例里的 10 件）：
{
  "name": "咖啡馆",
  "kind": "cafe",
  "grid": {"w": 32, "h": 24, "cell": 16},
  "wallStyle": "solid",
  "rooms": [
    {"id":"bedroom","name":"卧室","rect":[1,1,8,7],"floor":"wood","unlock":{"type":"start"}},
    {"id":"bath","name":"卫生间","rect":[24,16,7,6],"floor":"tile","unlock":{"type":"start"}}
  ],
  "zones": [
    {"id":"living","name":"起居区","rect":[10,1,12,10],"floor":"wood"},
    {"id":"kitchen","name":"厨房区","rect":[1,9,9,8],"floor":"tile"},
    {"id":"hall","name":"走廊与入口","rect":[10,12,12,11],"floor":"stone"},
    {"id":"balcony","name":"阳台","rect":[23,1,8,14],"floor":"stone"}
  ],
  "doors": [
    {"id":"bed_kitchen","x":9,"y":4,"to":"kitchen"},
    {"id":"bath_hall","x":22,"y":19,"to":"hall"},
    {"id":"balcony_living","x":22,"y":7,"to":"balcony"},
    {"id":"outside","x":16,"y":23,"to":"outside"}
  ],
  "windows": [{"x":4,"y":0},{"x":26,"y":0}],
  "props": [
    {"name":"卧室-床-1","id":"bed","x":2,"y":2,"w":2,"h":3,"room":"bedroom","facing":"S"},
    {"name":"卧室-衣柜-1","id":"wardrobe","x":6,"y":2,"w":2,"h":1,"room":"bedroom","facing":"W"},
    {"name":"起居区-沙发-1","id":"sofa","x":12,"y":7,"w":3,"h":1,"room":"living","facing":"N"},
    {"name":"起居区-电视-1","id":"tv","x":12,"y":1,"w":2,"h":1,"room":"living","facing":"S"},
    {"name":"起居区-地毯-1","id":"rug","x":12,"y":3,"w":4,"h":3,"room":"living"},
    {"name":"厨房区-台面-1","id":"counter","x":2,"y":10,"w":3,"h":1,"room":"kitchen","facing":"S"},
    {"name":"厨房区-灶台-1","id":"stove","x":5,"y":10,"w":2,"h":1,"room":"kitchen","facing":"S"},
    {"name":"厨房区-冰箱-1","id":"fridge","x":2,"y":15,"w":1,"h":1,"room":"kitchen","facing":"N"},
    {"name":"走廊-地毯-1","id":"rug","x":13,"y":15,"w":4,"h":3,"room":"hall"},
    {"name":"阳台-绿植-1","id":"plant","x":29,"y":2,"w":1,"h":1,"room":"balcony"}
  ],
  "wallProps": [],
  "spawn": {"x":16,"y":21},
  "interactions": {
    "schema_version": 1,
    "acts": {
      "sleep": {
        "label":"睡觉",
        "trigger":{"props":["bed"]},
        "requires":[{"kind":"place","in":["bedroom"]},{"kind":"time","between":["22:00","07:00"]}],
        "perform":{"animation":"sleep","duration_min":480,"interruptible":true},
        "effects":[{"kind":"mood","target":"energy","delta":0.6},{"kind":"event","name":"sleep"}],
        "priority":10
      },
      "sit": {
        "label":"坐下",
        "trigger":{"props":["chair","sofa","bench"]},
        "perform":{"animation":"sit","duration_min":15,"interruptible":true},
        "effects":[{"kind":"mood","target":"valence","delta":0.05}],
        "priority":2
      }
    }
  },
  "routes": [
    {"id":"spawn_bed","from":[16,21],"to":[3,4],"waypoints":[[16,21],[16,14],[9,14],[9,4],[3,4]]},
    {"id":"spawn_living","from":[16,21],"to":[13,8],"waypoints":[[16,21],[16,14],[13,14],[13,8]]}
  ]
}

非家居/幻想场景（太空站、森林、海底、废墟等）：
- 不要复用 home 的床/沙发/吧台；用 props[].shape 直接定义新物体；
- shape 坐标相对物体左上角，单位是像素（1 格 = 16px）；颜色用 #rrggbb；
- 每个自定义物体 3–8 个图元，不要只画一个矩形；至少包含深色底座/轮廓 + 亮色面板/灯/窗；
- kind 只能是 rect / ellipse / line / polygon；polygon 用 points:[[x,y],...]；
- 自定义物体也要给 w/h，并让 interactions.trigger.props 引用它的 id。

补充要求：
- props.room 必须使用 layout 里的 room/zone id（例如 room1/open1），不要用示例里的 bedroom/living；
- 家具 45–65 件；每个 room/zone 每 12 格至少 1 件家具；
- 门连接相邻 room/zone 或室外；窗户开在外墙；出生点在入口附近且可走；
- 每个可交互道具至少一个 act；interactions.trigger.props 必须出现在 props 里；
- perform.animation 必须是可用动画名；
- 路线覆盖出生点到主要交互点，waypoint 必须可走；
- 不要输出坐标数组以外的解释，不要输出代码。

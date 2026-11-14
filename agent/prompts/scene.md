根据描述生成一个完整、可运行的像素场景。只输出 JSON，不要解释。

场景意图：{{description}}
类型：{{kind}}
名称：{{name}}
网格：{{grid}}（cell=16，坐标从 0 开始，四周留 1 格墙；必须严格使用这个尺寸，不要输出 32×24）

可用家具 id（只能从这里选）：
{{furniture}}

可用动作 id：
{{acts}}

可用动画名（perform.animation 只能从这里选）：
{{animations}}

效果枚举：
{{effects}}

输出结构（以 24×18 咖啡馆为例；必须按这个密度和分区来，不要只画一个大空房间）：
{
  "name": "咖啡馆",
  "kind": "cafe",
  "grid": {"w": 24, "h": 18, "cell": 16},
  "rooms": [
    {"id":"bar","name":"吧台与操作区","kind":"cafe","rect":[1,1,9,7],"floor":"tile"},
    {"id":"seatA","name":"座位区A","kind":"cafe","rect":[11,1,6,7],"floor":"wood"},
    {"id":"seatB","name":"座位区B","kind":"cafe","rect":[18,1,5,7],"floor":"wood"},
    {"id":"rest","name":"卫生间","kind":"cafe","rect":[1,9,7,7],"floor":"tile"},
    {"id":"entry","name":"入口","kind":"cafe","rect":[9,9,6,7],"floor":"stone"},
    {"id":"storage","name":"储藏间","kind":"cafe","rect":[16,9,7,7],"floor":"tile"}
  ],
  "doors": [
    {"id":"bar_seatA","x":10,"y":4,"to":"seatA"},
    {"id":"seatA_seatB","x":17,"y":4,"to":"seatB"},
    {"id":"seatA_entry","x":12,"y":8,"to":"entry"},
    {"id":"entry_rest","x":8,"y":12,"to":"rest"},
    {"id":"entry_storage","x":15,"y":12,"to":"storage"},
    {"id":"outside","x":12,"y":17,"to":"outside"}
  ],
  "windows": [{"x":4,"y":0},{"x":19,"y":0}],
  "props": [
    {"id":"counter","x":2,"y":2,"w":4,"h":1,"room":"bar","facing":"S"},
    {"id":"stove","x":7,"y":2,"w":2,"h":1,"room":"bar","facing":"S"},
    {"id":"sink","x":9,"y":2,"w":1,"h":1,"room":"bar","facing":"S"},
    {"id":"fridge","x":2,"y":6,"w":1,"h":2,"room":"bar","facing":"E"},
    {"id":"shelf","x":7,"y":6,"w":2,"h":1,"room":"bar","facing":"W"},
    {"id":"plant","x":9,"y":1,"w":1,"h":1,"room":"bar"},
    {"id":"lamp","x":1,"y":1,"w":1,"h":1,"room":"bar"},
    {"id":"rug","x":11,"y":2,"w":4,"h":3,"room":"seatA"},
    {"id":"table","x":12,"y":3,"w":2,"h":2,"room":"seatA"},
    {"id":"chair","x":11,"y":3,"w":1,"h":1,"room":"seatA","facing":"E"},
    {"id":"chair","x":14,"y":3,"w":1,"h":1,"room":"seatA","facing":"W"},
    {"id":"table","x":14,"y":6,"w":2,"h":2,"room":"seatA"},
    {"id":"chair","x":13,"y":6,"w":1,"h":1,"room":"seatA","facing":"E"},
    {"id":"chair","x":16,"y":6,"w":1,"h":1,"room":"seatA","facing":"W"},
    {"id":"plant","x":16,"y":1,"w":1,"h":1,"room":"seatA"},
    {"id":"lamp","x":16,"y":7,"w":1,"h":1,"room":"seatA"},
    {"id":"rug","x":18,"y":2,"w":4,"h":3,"room":"seatB"},
    {"id":"table","x":19,"y":3,"w":2,"h":2,"room":"seatB"},
    {"id":"chair","x":18,"y":3,"w":1,"h":1,"room":"seatB","facing":"E"},
    {"id":"chair","x":21,"y":3,"w":1,"h":1,"room":"seatB","facing":"W"},
    {"id":"table","x":19,"y":6,"w":2,"h":2,"room":"seatB"},
    {"id":"chair","x":18,"y":6,"w":1,"h":1,"room":"seatB","facing":"E"},
    {"id":"chair","x":21,"y":6,"w":1,"h":1,"room":"seatB","facing":"W"},
    {"id":"plant","x":22,"y":1,"w":1,"h":1,"room":"seatB"},
    {"id":"lamp","x":17,"y":7,"w":1,"h":1,"room":"seatB"},
    {"id":"bench","x":2,"y":10,"w":2,"h":1,"room":"rest"},
    {"id":"toilet","x":6,"y":10,"w":1,"h":1,"room":"rest"},
    {"id":"sink","x":6,"y":14,"w":1,"h":1,"room":"rest"},
    {"id":"bath_mat","x":5,"y":14,"w":1,"h":1,"room":"rest"},
    {"id":"shelf","x":2,"y":14,"w":2,"h":1,"room":"rest"},
    {"id":"washer","x":3,"y":14,"w":1,"h":1,"room":"rest"},
    {"id":"plant","x":1,"y":9,"w":1,"h":1,"room":"rest"},
    {"id":"coat_rack","x":10,"y":14,"w":1,"h":1,"room":"entry"},
    {"id":"door_mat","x":11,"y":15,"w":2,"h":1,"room":"entry"},
    {"id":"bench","x":12,"y":12,"w":2,"h":1,"room":"entry"},
    {"id":"plant","x":9,"y":9,"w":1,"h":1,"room":"entry"},
    {"id":"lamp","x":13,"y":9,"w":1,"h":1,"room":"entry"},
    {"id":"shelf","x":17,"y":10,"w":2,"h":1,"room":"storage"},
    {"id":"fridge","x":21,"y":10,"w":1,"h":2,"room":"storage"},
    {"id":"washer","x":17,"y":14,"w":1,"h":1,"room":"storage"},
    {"id":"plant","x":22,"y":14,"w":1,"h":1,"room":"storage"},
    {"id":"table","x":19,"y":12,"w":2,"h":2,"room":"storage"},
    {"id":"chair","x":18,"y":12,"w":1,"h":1,"room":"storage","facing":"E"},
    {"id":"chair","x":21,"y":12,"w":1,"h":1,"room":"storage","facing":"W"}
  ],
  "wallProps": [],
  "spawn": {"x":12,"y":16},
  "interactions": {
    "schema_version": 1,
    "acts": {
      "cook": {
        "label":"做咖啡",
        "trigger":{"props":["counter","stove"]},
        "perform":{"animation":"cook","duration_min":20,"interruptible":true},
        "effects":[{"kind":"event","name":"coffee"}],
        "priority":5
      },
      "sit": {
        "label":"坐下",
        "trigger":{"props":["chair"]},
        "perform":{"animation":"sit","duration_min":15,"interruptible":true},
        "effects":[{"kind":"mood","target":"valence","delta":0.05}],
        "priority":2
      }
    }
  },
  "routes": [
    {"id":"spawn_bar","from":[12,16],"to":[3,3],"waypoints":[[12,16],[12,13],[10,13],[10,4],[3,4],[3,3]]},
    {"id":"spawn_seatA","from":[12,16],"to":[13,4],"waypoints":[[12,16],[12,13],[12,9],[12,4],[13,4]]}
  ]
}

非家居/幻想场景（太空站、森林、海底、废墟等）：
- 不要复用 home 的床/沙发/吧台；用 props[].shape 直接定义新物体；
- shape 坐标相对物体左上角，单位是像素（1 格 = 16px）；颜色用 #rrggbb；
- 例：
  {"id":"console","x":3,"y":2,"w":2,"h":1,"room":"lab","blocks":true,
   "shape":[
     {"kind":"rect","x":0,"y":0,"w":32,"h":14,"color":"#2a3340"},
     {"kind":"rect","x":2,"y":2,"w":28,"h":8,"color":"#4a6a8a"},
     {"kind":"ellipse","x":6,"y":4,"w":8,"h":6,"color":"#8fd3ff"},
     {"kind":"line","x1":0,"y1":15,"x2":31,"y2":15,"color":"#111111"}
   ]}
- kind 只能是 rect / ellipse / line / polygon；polygon 用 points:[[x,y],...]；
- 每个自定义物体 3–8 个图元，不要只画一个矩形；至少包含深色底座/轮廓 + 亮色面板/灯/窗；
- 用 polygon 做山体、树冠、飞船外壳；ellipse 做舱窗、灯、石头；line 做管线、支架、栏杆；
- 自定义物体也要给 w/h，并让 interactions.trigger.props 引用它的 id。

质量基线（必须满足，否则视为不合格）：
- 4–6 个房间/功能区，rect 互不重叠，房间之间留 1 格墙；每个房间至少 5×4；
- 咖啡厅至少 5 个功能区：吧台、座位 A、座位 B、卫生间、储藏/入口；
- 房间总面积至少覆盖内部 70%；禁止一个 30×22 的大空房间；
- 家具 45–65 件；每个房间每 12 格至少 1 件家具；不要只沿四面墙摆一圈、中间全空；
- 家具成组：桌子+椅子、地毯+桌子、吧台+灶台+水槽、角落绿植、座位区台灯；
- 咖啡厅：座位区至少 4 张 table + 8 把 chair；吧台区至少 8 件；卫生间至少 4 件；入口至少 3 件；
- 咖啡厅至少有：counter、table、chair、plant×3、rug×3、lamp×2、shelf/fridge、sink；
- 门连接相邻房间/室外；窗户开在外墙；出生点在入口附近且可走；
- 每个可交互家具至少一个 act；interactions 的 trigger.props 必须出现在 props 里；
- perform.animation 必须是可用动画名；
- 路线覆盖出生点到主要交互点，waypoint 必须可走；
- 不要输出坐标数组以外的解释，不要输出代码。

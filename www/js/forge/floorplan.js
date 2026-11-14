// 语义户型：按 mapSpec 的 kind/name 生成可识别场景，而不是固定几种模板。
// home/office 用稳定户型；咖啡厅/书店/餐厅/集市等按 seed 生成 1–3 个功能区。
// 房间之间留 1 格墙，门开在墙格上；输出与 buildLayout 同构。

import { fnv1a, mulberry32 } from "./grammar.js";

const FLOORS = {
  living: "wood", bedroom: "wood", hall: "tile", bath: "tile", balcony: "stone",
  office: "tile", meeting: "carpet", lounge: "wood",
  cafe: "wood", counter: "tile", bookstore: "wood", reading: "wood",
  library: "wood", restaurant: "wood", bar: "wood", market: "stone",
  stall: "stone", shop: "tile", store: "tile", cinema: "carpet",
  gym: "stone", clinic: "tile", gallery: "wood", workshop: "stone",
  park: "stone", lawn: "stone", garden: "stone", cabin: "wood", venue: "wood",
};

const TYPE_RULES = [
  ["cafe", /咖啡|cafe|coffee/i],
  ["bookstore", /书店|bookstore|bookshop/i],
  ["library", /图书馆|library/i],
  ["restaurant", /餐厅|饭馆|restaurant|diner/i],
  ["bar", /酒吧|bar|pub/i],
  ["market", /集市|市场|夜市|market/i],
  ["shop", /商店|便利店|花店|面包|bakery|flower|shop|store/i],
  ["cinema", /电影|影院|cinema/i],
  ["gym", /健身|gym/i],
  ["clinic", /诊所|医院|clinic/i],
  ["gallery", /画廊|博物馆|展览|gallery|museum|exhibition/i],
  ["workshop", /工坊|工作室|workshop|studio/i],
  ["park", /公园|花园|park|garden/i],
  ["office", /办公室|office/i],
  ["home", /家|公寓|home|apartment/i],
];

const PROGRAMS = {
  cafe: [{ kind: "cafe", name: "咖啡区" }, { kind: "counter", name: "吧台" }],
  bookstore: [{ kind: "bookstore", name: "书店" }, { kind: "reading", name: "阅读区" }],
  library: [{ kind: "library", name: "阅览室" }, { kind: "reading", name: "书架区" }],
  restaurant: [{ kind: "restaurant", name: "用餐区" }, { kind: "counter", name: "后厨" }],
  bar: [{ kind: "bar", name: "吧台" }, { kind: "lounge", name: "卡座" }],
  market: [{ kind: "market", name: "集市" }, { kind: "stall", name: "摊位" }],
  shop: [{ kind: "shop", name: "商店" }, { kind: "counter", name: "收银台" }],
  cinema: [{ kind: "cinema", name: "放映厅" }, { kind: "lounge", name: "休息区" }],
  gym: [{ kind: "gym", name: "训练区" }, { kind: "lounge", name: "休息区" }],
  clinic: [{ kind: "clinic", name: "诊室" }, { kind: "lounge", name: "候诊区" }],
  gallery: [{ kind: "gallery", name: "展厅" }, { kind: "lounge", name: "休息区" }],
  workshop: [{ kind: "workshop", name: "工坊" }, { kind: "counter", name: "工作台" }],
  park: [{ kind: "park", name: "公园" }, { kind: "garden", name: "花园" }],
  venue: [{ kind: "venue", name: "大厅" }, { kind: "lounge", name: "休息区" }],
};

function room(id, kind, name, rect) {
  return { id, kind, name, rect, floor: FLOORS[kind] || "wood", unlock: { type: "start" }, story: "" };
}

function door(id, x, y, to) {
  return { id, x, y, to };
}

export function inferSceneType(mapSpec = {}) {
  const text = `${mapSpec.kind || ""} ${mapSpec.name || ""} ${mapSpec.description || ""} ${(mapSpec.tags || []).join(" ")}`;
  for (const [type, re] of TYPE_RULES) if (re.test(text)) return type;
  return "venue";
}

function homePlan(w, h) {
  const sx = Math.max(9, Math.floor(w * 0.62));
  const sy = Math.max(6, Math.floor(h * 0.5));
  const hallW = Math.max(5, Math.floor(w * 0.36));
  const bathX = hallW + 2;
  const bathW = Math.max(4, sx - bathX - 1);
  const rooms = [
    room("living", "living", "客厅", [1, 1, sx - 1, sy - 1]),
    room("bedroom", "bedroom", "卧室", [sx + 1, 1, w - sx - 2, sy - 1]),
    room("hall", "hall", "厨房", [1, sy + 1, hallW, h - sy - 2]),
    room("bath", "bath", "浴室", [bathX, sy + 1, bathW, h - sy - 2]),
    room("balcony", "balcony", "阳台", [sx + 1, sy + 1, w - sx - 2, h - sy - 2]),
  ];
  const doors = [
    door("living_bedroom", sx, 3, "bedroom"),
    door("living_hall", Math.max(2, Math.floor(hallW / 2)), sy, "hall"),
    door("hall_bath", hallW + 1, sy + 3, "bath"),
    door("bedroom_balcony", sx + 3, sy, "balcony"),
  ];
  return { rooms, doors };
}

function officePlan(w, h) {
  const sx = Math.max(12, Math.floor(w * 0.68));
  const sy = Math.max(5, Math.floor(h * 0.45));
  const rooms = [
    room("office", "office", "办公区", [1, 1, sx - 1, h - 2]),
    room("meeting", "meeting", "会议室", [sx + 1, 1, w - sx - 2, sy - 1]),
    room("lounge", "lounge", "休息区", [sx + 1, sy + 1, w - sx - 2, h - sy - 2]),
  ];
  const doors = [
    door("office_meeting", sx, 3, "meeting"),
    door("office_lounge", sx, sy + 3, "lounge"),
  ];
  return { rooms, doors };
}

function venuePlan(w, h, seed, type, customProgram) {
  const rnd = mulberry32(fnv1a(`${seed}|${type}`));
  const program = Array.isArray(customProgram) && customProgram.length
    ? customProgram.map((r, i) => ({ kind: r.kind || "venue", name: r.name || `区域${i + 1}` }))
    : PROGRAMS[type] || PROGRAMS.venue;
  const count = Array.isArray(customProgram) && customProgram.length
    ? Math.min(3, program.length)
    : 1 + Math.floor(rnd() * Math.min(3, program.length));
  if (count === 1) {
    return { rooms: [room("main", program[0].kind, program[0].name, [1, 1, w - 2, h - 2])], doors: [] };
  }
  const vertical = rnd() < 0.5;
  if (vertical) {
    const sx = Math.max(8, Math.floor(w * (0.5 + rnd() * 0.15)));
    const rooms = [
      room("main", program[0].kind, program[0].name, [1, 1, sx - 1, h - 2]),
      room("side", program[1].kind, program[1].name, [sx + 1, 1, w - sx - 2, h - 2]),
    ];
    const doors = [door("main_side", sx, Math.max(2, Math.floor(h * 0.35)), "side")];
    if (count === 3) {
      const sy = Math.max(5, Math.floor(h * 0.55));
      rooms[1].rect = [sx + 1, 1, w - sx - 2, sy - 1];
      rooms.push(room("extra", program[2].kind, program[2].name, [sx + 1, sy + 1, w - sx - 2, h - sy - 2]));
      doors.push(door("side_extra", sx, sy, "extra"));
    }
    return { rooms, doors };
  }
  const sy = Math.max(5, Math.floor(h * (0.5 + rnd() * 0.12)));
  const rooms = [
    room("main", program[0].kind, program[0].name, [1, 1, w - 2, sy - 1]),
    room("side", program[1].kind, program[1].name, [1, sy + 1, w - 2, h - sy - 2]),
  ];
  const doors = [door("main_side", Math.max(2, Math.floor(w * 0.35)), sy, "side")];
  if (count === 3) {
    const sx = Math.max(8, Math.floor(w * 0.55));
    rooms[1].rect = [1, sy + 1, sx - 1, h - sy - 2];
    rooms.push(room("extra", program[2].kind, program[2].name, [sx + 1, sy + 1, w - sx - 2, h - sy - 2]));
    doors.push(door("side_extra", sx, sy + 2, "extra"));
  }
  return { rooms, doors };
}

export function buildFloorplan(kind, w, h, seed = "plan", mapSpec = {}) {
  const type = inferSceneType({ ...mapSpec, kind: mapSpec.kind || kind });
  let plan;
  if (type === "home") plan = homePlan(w, h);
  else if (type === "office") plan = officePlan(w, h);
  else plan = venuePlan(w, h, seed, type, mapSpec.program);

  const windows = [];
  for (let x = 2; x < w - 2; x += 5) windows.push({ x, y: 0 });
  return {
    w,
    h,
    seed,
    semantic: true,
    sceneType: type,
    openShare: 1,
    rooms: plan.rooms,
    doors: plan.doors,
    zones: [],
    windows,
  };
}

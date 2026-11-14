// 语义户型：不再让随机矩形决定房间用途，而是按 kind 生成可识别的一居/办公室平面。
// 房间之间留 1 格墙，门开在墙格上；输出与 buildLayout 同构。

const FLOORS = {
  living: "wood",
  bedroom: "wood",
  hall: "tile",
  bath: "tile",
  balcony: "stone",
  office: "tile",
  meeting: "carpet",
  lounge: "wood",
  park: "stone",
  lawn: "stone",
  cabin: "wood",
  library: "wood",
  reading: "wood",
  cafe: "wood",
  market: "stone",
  stall: "stone",
  store: "tile",
  counter: "tile",
};

function room(id, kind, name, rect) {
  return { id, kind, name, rect, floor: FLOORS[kind] || "wood", unlock: { type: "start" }, story: "" };
}

function door(id, x, y, to) {
  return { id, x, y, to };
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

function openPlan(w, h, kind, name) {
  const rooms = [room("main", kind, name, [1, 1, w - 2, h - 2])];
  return { rooms, doors: [] };
}

export function buildFloorplan(kind, w, h, seed = "plan") {
  let plan;
  if (kind === "home") plan = homePlan(w, h);
  else if (kind === "office") plan = officePlan(w, h);
  else if (kind === "nature") plan = openPlan(w, h, "park", "公园");
  else if (kind === "quiet") plan = openPlan(w, h, "library", "阅览室");
  else if (kind === "social") plan = openPlan(w, h, "cafe", "咖啡区");
  else if (kind === "lively") plan = openPlan(w, h, "market", "集市");
  else if (kind === "errand") plan = openPlan(w, h, "store", "商店");
  else plan = openPlan(w, h, "living", "房间");

  const windows = [];
  for (let x = 2; x < w - 2; x += 5) windows.push({ x, y: 0 });
  return {
    w,
    h,
    seed,
    semantic: true,
    openShare: 1,
    rooms: plan.rooms,
    doors: plan.doors,
    zones: [],
    windows,
  };
}

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


const OPEN_FLOORS = ["wood", "tile", "carpet", "stone"];

function closedRect(corner, w, h, cw, ch) {
  if (corner === "NW") return [1, 1, cw, ch];
  if (corner === "NE") return [w - 1 - cw, 1, cw, ch];
  if (corner === "SW") return [1, h - 1 - ch, cw, ch];
  return [w - 1 - cw, h - 1 - ch, cw, ch];
}

function decompose(cells, w, h) {
  const left = new Set(cells);
  const rects = [];
  for (let y = 1; y < h - 1; y++) {
    let x = 1;
    while (x < w - 1) {
      if (!left.has(`${x},${y}`)) { x += 1; continue; }
      let x2 = x;
      while (left.has(`${x2 + 1},${y}`)) x2 += 1;
      let y2 = y;
      while (y2 + 1 < h - 1) {
        let ok = true;
        for (let xx = x; xx <= x2; xx++) if (!left.has(`${xx},${y2 + 1}`)) { ok = false; break; }
        if (!ok) break;
        y2 += 1;
      }
      rects.push([x, y, x2 - x + 1, y2 - y + 1]);
      for (let yy = y; yy <= y2; yy++) for (let xx = x; xx <= x2; xx++) left.delete(`${xx},${yy}`);
      x = x2 + 1;
    }
  }
  return rects;
}

/** 按 MAP-SCENE-DESIGN §3.5 生成 1-2 间封闭房 + 开放 zones 骨架。 */
export function pickOpenLayout(w = 32, h = 24, seed = "layout") {
  const rnd = mulberry32(fnv1a(String(seed)));
  const n = rnd() < 0.7 ? 1 : 2;
  const diag = rnd() < 0.5 ? ["NW", "SE"] : ["NE", "SW"];
  const corners = diag.slice(0, n);
  const closed = corners.map((corner) => {
    const cw = 4 + Math.floor(rnd() * Math.min(3, Math.floor(w / 4) - 3));
    const ch = 4 + Math.floor(rnd() * Math.min(3, Math.floor(h / 3) - 3));
    return { corner, rect: closedRect(corner, w, h, cw, ch) };
  });
  if (closed.length === 2 && closed[0].rect[2] === closed[1].rect[2] && closed[0].rect[3] === closed[1].rect[3]) {
    const [x, y, cw, ch] = closed[1].rect;
    closed[1].rect = [x, y, Math.max(4, cw - 1), ch];
  }
  const blocked = new Set();
  for (const c of closed) {
    const [x, y, cw, ch] = c.rect;
    for (let xx = x - 1; xx <= x + cw; xx++) for (let yy = y - 1; yy <= y + ch; yy++) {
      if (xx >= 1 && xx <= w - 2 && yy >= 1 && yy <= h - 2) blocked.add(`${xx},${yy}`);
    }
  }
  const interior = [];
  for (let y = 1; y <= h - 2; y++) for (let x = 1; x <= w - 2; x++) if (!blocked.has(`${x},${y}`)) interior.push(`${x},${y}`);
  const rawOpen = decompose(interior, w, h);
  const openRects = [];
  const queue = rawOpen.slice();
  while (queue.length && openRects.length < 6) {
    const r = queue.shift();
    const [x, y, ww, hh] = r;
    if (openRects.length + queue.length < 6 && (ww > 8 || hh > 7) && ww >= 6 && hh >= 6) {
      if (ww >= hh) {
        const half = Math.floor(ww / 2);
        queue.unshift([x, y, half, hh], [x + half, y, ww - half, hh]);
      } else {
        const half = Math.floor(hh / 2);
        queue.unshift([x, y, ww, half], [x, y + half, ww, hh - half]);
      }
    } else {
      openRects.push(r);
    }
  }
  openRects.push(...queue);
  const floors = OPEN_FLOORS.slice().sort(() => rnd() - 0.5);
  const rooms = closed.map((c, i) => ({
    id: `room${i + 1}`, name: `封闭房间${i + 1}`, kind: "room", corner: c.corner,
    rect: c.rect, floor: ["wood", "tile", "stone"][Math.floor(rnd() * 3)],
    unlock: { type: "start" }, story: "",
  }));
  const zones = openRects.map((rect, i) => ({
    id: `open${i + 1}`, name: `开放区${i + 1}`, rect,
    floor: floors[i % floors.length], unlock: { type: "start" },
  }));
  const closedArea = rooms.reduce((sum, r) => sum + r.rect[2] * r.rect[3], 0);
  const openArea = zones.reduce((sum, z) => sum + z.rect[2] * z.rect[3], 0);
  const openShare = openArea / Math.max(1, closedArea + openArea);
  const openCells = new Map();
  for (const z of zones) {
    const [x, y, ww, hh] = z.rect;
    for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + ww; xx++) openCells.set(`${xx},${yy}`, z.id);
  }
  const doors = [];
  for (const r of rooms) {
    const [x, y, cw, ch] = r.rect;
    const ring = [];
    for (let yy = y; yy < y + ch; yy++) ring.push([x - 1, yy], [x + cw, yy]);
    for (let xx = x; xx < x + cw; xx++) ring.push([xx, y - 1], [xx, y + ch]);
    const cand = [];
    for (const [cx, cy] of ring) {
      if (cx < 1 || cx > w - 2 || cy < 1 || cy > h - 2) continue;
      const near = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      const target = near.map(([nx, ny]) => openCells.get(`${nx},${ny}`)).find(Boolean);
      if (target) cand.push([cx, cy, target]);
    }
    if (cand.length) {
      const [dx, dy, target] = cand[Math.floor(rnd() * cand.length)];
      doors.push({ id: `${r.id}_door`, x: dx, y: dy, to: target });
    }
  }
  const biggest = zones.slice().sort((a, b) => b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3])[0];
  const spawn = biggest ? { x: biggest.rect[0] + 1, y: biggest.rect[1] + 1 } : { x: 2, y: 2 };
  const windows = [];
  for (let x = 2; x < w - 2; x += 5) windows.push({ x, y: 0 });
  return {
    grid: { w, h, cell: 16 }, wallStyle: "solid",
    rooms, zones, doors, windows, spawn, openShare: Math.round(openShare * 100) / 100,
  };
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

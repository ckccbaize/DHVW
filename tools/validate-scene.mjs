#!/usr/bin/env node
// 场景包校验器（T1）：把 MAP-SCENE-DESIGN.md §15.2 的不变量变成可执行检查。
// 产出 agent（PC / ARM）提交前必须全过；设备侧加载器按同一套规则拒绝坏包。
//
//   node tools/validate-scene.mjs <scene-dir | scene.json | *.built.json> [--strict] [--json] [--graph <dir>]
//
// 退出码：0 通过（可有 warning）；1 有 error；2 用法错误。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const EFFECT_KINDS = new Set([
  "mood",
  "set_flag",
  "clear_flag",
  "advance_time",
  "event",
  "produce_artifact",
  "travel",
  "say",
  "door",
]);

export const REQUIRE_KINDS = new Set([
  "place",
  "time",
  "weather",
  "mood",
  "flag",
  "prop_state",
  "network",
  "budget",
  "cooldown",
]);

const MOOD_TARGETS = new Set(["energy", "valence", "social", "focus"]);
const MOOD_APPLY = new Set(["on_complete", "per_minute", "on_interrupt"]);
const FACES = new Set(["N", "S", "E", "W"]);
const ACT_FIELDS = new Set([
  "label",
  "trigger",
  "requires",
  "approach",
  "perform",
  "effects",
  "cooldown_min",
  "priority",
  "bubble",
  "tags",
]);
const PERFORM_FIELDS = new Set(["animation", "duration_min", "interruptible"]);
const TRIGGER_FIELDS = new Set(["props", "zones"]);
const TILE = { WALK: 0, BLOCK: 1, DOOR: 2, WINDOW: 3 };

/** 读 PNG 的 IHDR 宽高（不依赖第三方库）。非 PNG 返回 null。 */
export function readPngSize(buf) {
  if (!buf || buf.length < 24) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** 解析 intGrid：支持字符串行数组（legacy）与数字数组（新格式）。 */
export function parseIntGrid(raw, w, h) {
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    if (raw.length !== h) throw new Error(`intGrid 行数 ${raw.length} ≠ ${h}`);
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      if (raw[y].length !== w) throw new Error(`intGrid 第 ${y} 行宽度 ${raw[y].length} ≠ ${w}`);
      for (let x = 0; x < w; x++) {
        const c = raw[y].charCodeAt(x) - 48;
        if (c < 0 || c > 9) throw new Error(`intGrid (${x},${y}) 非法字符`);
        data[y * w + x] = c;
      }
    }
    return data;
  }
  if (Array.isArray(raw) || raw instanceof Uint8Array) {
    if (raw.length !== w * h) throw new Error(`intGrid 长度 ${raw.length} ≠ ${w * h}`);
    return Uint8Array.from(raw);
  }
  throw new Error("intGrid 缺失或类型不支持");
}

const walkable = (data, w, x, y) => {
  const v = data[y * w + x];
  return v === TILE.WALK || v === TILE.DOOR;
};

/**
 * 校验单个场景包。
 * @param {object} p
 * @param {object} p.scene         scene.json 或 legacy built.json
 * @param {object} [p.interactions]
 * @param {object} [p.sheet]
 * @param {Record<string,{w:number,h:number}|null>} [p.pngSizes]  文件名 → 尺寸
 * @param {object} [p.manifest]    manifest.json（可选）
 * @param {Map<string,Set<string>>} [p.graph]  场景 id → anchors
 * @param {boolean} [p.legacy]
 * @param {boolean} [p.strict]
 */
export function validateScene({
  scene,
  interactions = null,
  sheet = null,
  pngSizes = {},
  manifest = null,
  graph = null,
  legacy = false,
  strict = false,
}) {
  const errors = [];
  const warnings = [];
  const err = (code, msg) => errors.push({ code, msg });
  const warn = (code, msg) => warnings.push({ code, msg });

  if (!scene || typeof scene !== "object") {
    err("schema", "scene 不是对象");
    return { ok: false, errors, warnings, stats: {} };
  }

  // ---- grid ----
  const grid = scene.grid || {};
  const w = Number(grid.w);
  const h = Number(grid.h);
  const cell = Number(grid.cell || 16);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    err("grid", `grid 非法：${JSON.stringify(grid)}`);
    return { ok: false, errors, warnings, stats: {} };
  }
  if (cell !== 16) warn("grid", `cell=${cell}，契约要求 16px 源瓦片`);

  // ---- intGrid ----
  let data = null;
  try {
    data = parseIntGrid(scene.intGrid, w, h);
  } catch (e) {
    err("intgrid", e.message);
  }
  if (data) {
    for (let i = 0; i < data.length; i++) {
      if (data[i] > 3) {
        err("intgrid", `intGrid[${i}] 值 ${data[i]} 越界（只允许 0/1/2/3）`);
        break;
      }
    }
  }

  const at = (x, y) => (data ? data[y * w + x] : TILE.BLOCK);
  const inBounds = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < w && y < h;

  // ---- entities ----
  const entities = Array.isArray(scene.entities) ? scene.entities : [];
  const legacyDoors = Array.isArray(scene.doors) ? scene.doors : [];
  const doors = [
    ...entities.filter((e) => e.type === "door"),
    ...legacyDoors.map((d) => ({ type: "door", x: d.x, y: d.y, to: d.to, anchor: d.anchor })),
  ];
  const spawns = entities.filter((e) => e.type === "spawn");
  const hotspots = entities.filter((e) => e.type === "hotspot");

  // spawn：新格式必须有；legacy 用 start 房间中心兜底（并校验可走）
  if (spawns.length === 0) {
    if (!legacy) {
      err("spawn", "缺少 spawn 实体");
    } else {
      const room = (scene.rooms || []).find((r) => r.id === scene.start) || (scene.rooms || [])[0];
      if (!room) err("spawn", "legacy 场景既无 spawn 也无 rooms");
      else {
        const [rx, ry, rw, rh] = room.rect;
        let found = null;
        for (let y = ry; y < ry + rh && !found; y++) {
          for (let x = rx; x < rx + rw && !found; x++) if (data && walkable(data, w, x, y)) found = [x, y];
        }
        if (!found) err("spawn", `legacy 场景 start 房间 "${room.id}" 内没有可走格`);
        else warn("spawn", `legacy 场景无 spawn，按 start 房间可走格 (${found[0]},${found[1]}) 兜底`);
      }
    }
  }
  for (const s of spawns) {
    if (!inBounds(s.x, s.y)) err("spawn", `spawn (${s.x},${s.y}) 越界`);
    else if (data && !walkable(data, w, s.x, s.y)) err("spawn", `spawn (${s.x},${s.y}) 不可走（intGrid=${at(s.x, s.y)}）`);
  }

  // door：门格必须是 2；to 必须存在
  for (const d of doors) {
    if (!inBounds(d.x, d.y)) {
      err("door", `door (${d.x},${d.y}) 越界`);
      continue;
    }
    if (data && at(d.x, d.y) !== TILE.DOOR) {
      err("door", `door (${d.x},${d.y}) 的 intGrid=${at(d.x, d.y)}，必须是 2`);
    }
    if (!d.to) err("door", `door (${d.x},${d.y}) 缺少 to`);
    else if (legacy && !graph) {
      const roomIds = new Set((scene.rooms || []).map((r) => r.id));
      if (!roomIds.has(d.to) && d.to !== "outside") {
        err("door", `door (${d.x},${d.y}) 指向未知房间 "${d.to}"`);
      }
    } else if (graph) {
      if (!graph.has(d.to)) err("door", `door (${d.x},${d.y}) 指向不存在的场景 "${d.to}"`);
      else if (d.anchor && !graph.get(d.to).has(d.anchor)) {
        err("door", `door (${d.x},${d.y}) 的目标场景 "${d.to}" 没有 anchor "${d.anchor}"`);
      }
    } else {
      warn("door", `door (${d.x},${d.y}) → "${d.to}" 未校验（未提供 --graph）`);
    }
  }

  // hotspot：可走 + act 有定义 + face 合法
  const acts = interactions?.acts || scene.acts || null;
  for (const s of hotspots) {
    if (!inBounds(s.x, s.y)) {
      err("hotspot", `hotspot (${s.x},${s.y}) 越界`);
      continue;
    }
    if (data && !walkable(data, w, s.x, s.y)) {
      err("hotspot", `hotspot (${s.x},${s.y}) 不可走（intGrid=${at(s.x, s.y)}）`);
    }
    if (!s.act) err("hotspot", `hotspot (${s.x},${s.y}) 缺少 act`);
    else if (acts && !acts[s.act]) err("act", `hotspot (${s.x},${s.y}) 引用了未定义的 act "${s.act}"`);
    if (s.face && !FACES.has(s.face)) err("hotspot", `hotspot (${s.x},${s.y}) face="${s.face}" 非法`);
  }

  // ---- interactions ----
  let actCount = 0;
  if (!acts) {
    if (strict) err("act", "缺少 interactions.json / acts");
    else warn("act", "缺少 interactions.json：交互不可用（设备侧只可移动）");
  } else {
    if (interactions && interactions.schema_version !== 1) {
      err("schema", `interactions.schema_version=${interactions.schema_version}，只支持 1`);
    }
    for (const [id, act] of Object.entries(acts)) {
      actCount++;
      for (const k of Object.keys(act)) {
        if (!ACT_FIELDS.has(k)) err("schema", `act "${id}" 未知字段 "${k}"`);
      }
      if (!act.label) warn("act", `act "${id}" 缺少 label`);
      const trig = act.trigger || {};
      for (const k of Object.keys(trig)) {
        if (!TRIGGER_FIELDS.has(k)) err("schema", `act "${id}".trigger 未知字段 "${k}"`);
      }
      if (!Array.isArray(trig.props) || trig.props.length === 0) {
        warn("act", `act "${id}" 没有 trigger.props，永远不会被触发`);
      }
      const perf = act.perform || {};
      for (const k of Object.keys(perf)) {
        if (!PERFORM_FIELDS.has(k)) err("schema", `act "${id}".perform 未知字段 "${k}"`);
      }
      if (!perf.animation) err("animation", `act "${id}" 缺少 perform.animation`);
      const dur = Number(perf.duration_min);
      if (!Number.isFinite(dur) || dur < 1 || dur > 1440) {
        err("duration", `act "${id}" duration_min=${perf.duration_min} 越界（1–1440）`);
      }
      if (perf.interruptible !== undefined && typeof perf.interruptible !== "boolean") {
        err("schema", `act "${id}".perform.interruptible 必须是布尔`);
      }
      if (sheet && perf.animation) {
        const anims = sheet.animations || {};
        if (!anims[perf.animation]) err("animation", `act "${id}" 的动画 "${perf.animation}" 不在 sheet.json`);
      }
      for (const req of act.requires || []) {
        if (!REQUIRE_KINDS.has(req.kind)) err("require", `act "${id}" 未知条件 "${req.kind}"`);
      }
      for (const eff of act.effects || []) {
        if (!EFFECT_KINDS.has(eff.kind)) {
          err("effect", `act "${id}" 未知效果 "${eff.kind}"`);
          continue;
        }
        if (eff.kind === "mood") {
          if (!MOOD_TARGETS.has(eff.target)) err("effect", `act "${id}" mood.target="${eff.target}" 非法`);
          if (!Number.isFinite(Number(eff.delta))) err("effect", `act "${id}" mood.delta 必须是数字`);
          if (eff.apply && !MOOD_APPLY.has(eff.apply)) err("effect", `act "${id}" mood.apply="${eff.apply}" 非法`);
        }
        if ((eff.kind === "set_flag" || eff.kind === "clear_flag") && !eff.name) {
          err("effect", `act "${id}" ${eff.kind} 缺少 name`);
        }
        if (eff.kind === "advance_time" && !Number.isFinite(Number(eff.minutes))) {
          err("effect", `act "${id}" advance_time 缺少 minutes`);
        }
        if (eff.kind === "event" && !eff.name) err("effect", `act "${id}" event 缺少 name`);
        if (eff.kind === "travel" && !eff.to) err("effect", `act "${id}" travel 缺少 to`);
        if (eff.kind === "say" && !eff.text) err("effect", `act "${id}" say 缺少 text`);
      }
    }

    // 交互覆盖：act 声明的 prop 必须在场景里存在，且有可达热点
    const props = Array.isArray(scene.props) ? scene.props : [];
    const propIds = new Set(props.map((p) => p.id));
    for (const [id, act] of Object.entries(acts)) {
      const ids = act.trigger?.props || [];
      const present = ids.filter((pid) => propIds.has(pid));
      if (present.length === 0) {
        warn("coverage", `act "${id}" 的 trigger.props 在该场景里不存在（${ids.join(",")}）`);
        continue;
      }
      const hasHotspot = hotspots.some((s) => s.act === id);
      if (!hasHotspot && hotspots.length > 0) {
        warn("coverage", `act "${id}" 有道具但没有 hotspot（设备侧将按相邻格派生）`);
      }
    }
  }

  // ---- 图层 ----
  const layers = scene.layers || {};
  const expectW = w * cell;
  const expectH = h * cell;
  const checkLayer = (name, file, required) => {
    if (!file) {
      if (required) err("layer", `缺少图层 ${name}`);
      return;
    }
    const size = pngSizes[file];
    if (size === undefined) {
      if (required) err("layer", `图层 ${name} 文件 "${file}" 不存在`);
      return;
    }
    if (!size) {
      warn("layer", `图层 ${name} "${file}" 不是可解析的 PNG`);
      return;
    }
    if (size.w !== expectW || size.h !== expectH) {
      err("layer", `图层 ${name} "${file}" 尺寸 ${size.w}×${size.h} ≠ ${expectW}×${expectH}`);
    }
  };
  if (legacy) {
    // legacy：image/image2x 由构建器生成，尺寸检查放到 2× 图上
    if (scene.image2x && pngSizes[scene.image2x]) {
      const s = pngSizes[scene.image2x];
      if (s.w !== expectW * 2 || s.h !== expectH * 2) {
        err("layer", `legacy image2x 尺寸 ${s.w}×${s.h} ≠ ${expectW * 2}×${expectH * 2}`);
      }
    }
  } else {
    checkLayer("terrain", layers.terrain, true);
    checkLayer("furniture", layers.furniture, true);
    const light = layers.light;
    if (!light) warn("layer", "缺少 light 图层");
    else if (typeof light === "string") checkLayer("light", light, false);
    else for (const [k, f] of Object.entries(light)) checkLayer(`light:${k}`, f, false);
  }

  // ---- manifest（可选）----
  if (manifest) {
    const byPath = new Map((manifest.files || []).map((f) => [f.path, f]));
    const refs = [
      scene.image,
      scene.image2x,
      layers.terrain,
      layers.furniture,
      ...(typeof layers.light === "string" ? [layers.light] : Object.values(layers.light || {})),
    ].filter(Boolean);
    for (const f of refs) {
      const entry = byPath.get(f);
      if (!entry) err("manifest", `"${f}" 未登记到 manifest`);
      else if (!entry.sha256) err("manifest", `"${f}" 的 manifest 条目缺少 sha256`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      grid: `${w}×${h}`,
      cell,
      acts: actCount,
      hotspots: hotspots.length,
      doors: doors.length,
      legacy,
    },
  };
}

// ---------------- CLI ----------------

async function loadJson(p) {
  return JSON.parse(await fsp.readFile(p, "utf8"));
}

async function loadPngSizes(dir, names) {
  const out = {};
  for (const name of names) {
    if (!name) continue;
    const p = path.join(dir, name);
    try {
      out[name] = readPngSize(await fsp.readFile(p));
    } catch {
      out[name] = undefined; // 不存在
    }
  }
  return out;
}

async function loadGraph(dir) {
  const graph = new Map();
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const p = path.join(dir, ent.name, "scene.json");
    try {
      const s = await loadJson(p);
      const anchors = new Set(
        (s.entities || []).filter((e) => e.type === "door" && e.anchor).map((e) => e.anchor),
      );
      graph.set(s.id || ent.name, anchors);
    } catch {
      // 跳过非场景目录
    }
  }
  return graph;
}

async function main(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  const target = positional[0];
  if (!target) {
    console.error("用法: node tools/validate-scene.mjs <scene-dir | scene.json | *.built.json> [--strict] [--json] [--graph <dir>]");
    process.exit(2);
  }
  const strict = flags.has("--strict");
  const asJson = flags.has("--json");
  const graphIdx = args.indexOf("--graph");
  const graphDir = graphIdx >= 0 ? args[graphIdx + 1] : null;

  const abs = path.resolve(target);
  let dir = abs;
  let scenePath = abs;
  let legacy = false;
  const st = await fsp.stat(abs);
  if (st.isDirectory()) {
    dir = abs;
    const sceneJson = path.join(dir, "scene.json");
    if (fs.existsSync(sceneJson)) {
      scenePath = sceneJson;
    } else {
      const built = (await fsp.readdir(dir)).find((f) => f.endsWith(".built.json"));
      if (!built) {
        console.error(`✗ ${dir} 下既没有 scene.json 也没有 *.built.json`);
        process.exit(2);
      }
      scenePath = path.join(dir, built);
      legacy = true;
    }
  } else {
    dir = path.dirname(abs);
    legacy = abs.endsWith(".built.json");
  }

  const scene = await loadJson(scenePath);
  const interactions = fs.existsSync(path.join(dir, "interactions.json"))
    ? await loadJson(path.join(dir, "interactions.json"))
    : null;
  const sheetPath = path.join(dir, "character", "sheet.json");
  const sheet = fs.existsSync(sheetPath) ? await loadJson(sheetPath) : null;
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = fs.existsSync(manifestPath) ? await loadJson(manifestPath) : null;
  const graph = graphDir ? await loadGraph(path.resolve(graphDir)) : null;

  const layerNames = [
    scene.image,
    scene.image2x,
    scene.layers?.terrain,
    scene.layers?.furniture,
    ...(typeof scene.layers?.light === "string" ? [scene.layers.light] : Object.values(scene.layers?.light || {})),
  ];
  const pngSizes = await loadPngSizes(dir, layerNames);

  const result = validateScene({ scene, interactions, sheet, pngSizes, manifest, graph, legacy, strict });

  if (asJson) {
    console.log(JSON.stringify(result, null, 1));
  } else {
    const tag = result.ok ? "✓" : "✗";
    console.log(`${tag} ${path.relative(process.cwd(), scenePath)}  ${JSON.stringify(result.stats)}`);
    for (const e of result.errors) console.log(`  ERROR [${e.code}] ${e.msg}`);
    for (const w of result.warnings) console.log(`  warn  [${w.code}] ${w.msg}`);
    if (result.ok && result.warnings.length === 0) console.log("  全部检查通过");
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((e) => {
    console.error("✗ 校验器异常:", e.message);
    process.exit(2);
  });
}

// W2 spike：同一张世界状态图的两种实现对比。
// 运行：node spikes/fsm/compare.mjs

import fs from "node:fs";
import path from "node:path";
import gzip from "node:zlib";
import { fileURLToPath } from "node:url";

import { createWorld, transition, snapshot as reduceSnapshot } from "./world.reducer.js";
import { createWorldMachine, normalize } from "./world.xstate.js";
import * as xstate from "xstate";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SEQUENCES = [
  ["HOST_UP", "WORLD_START", "PRESENT_REQUEST", "WORLD_STOP", "PRESENT_REQUEST", "PRESENT_EXIT", "HOST_DOWN"],
  ["PRESENT_REQUEST", "HOST_UP", "PRESENT_REQUEST", "HOST_DOWN"],
  ["HOST_DOWN", "EDGE_START", "HOST_UP", "WORLD_START", "TAKEOVER"],
  ["HOST_UP", "WORLD_START", "TAKEOVER", "PRESENT_REQUEST", "HOST_LOST"],
  [
    { type: "TIER_SET", value: "host" },
    "HOST_UP",
    { type: "TIER_SET", value: "host" },
    { type: "TIER_SET", value: "edge" },
    "HOST_DOWN",
    { type: "TIER_SET", value: "edge" },
    { type: "TIER_SET", value: "idle" },
  ],
  ["HOST_UP", "HOST_UP", "WORLD_START", "WORLD_STOP", "WORLD_STOP", "HOST_DOWN", "HOST_DOWN"],
];

function runReducer(events) {
  let s = createWorld();
  for (const e of events) s = transition(s, typeof e === "string" ? { type: e } : e);
  return s;
}

function runXState(events) {
  const actor = xstate.createActor(createWorldMachine(xstate));
  actor.start();
  for (const e of events) actor.send(typeof e === "string" ? { type: e } : e);
  const snap = actor.getSnapshot();
  const out = normalize(snap);
  actor.stop();
  return out;
}

function loc(file) {
  return fs
    .readFileSync(path.join(HERE, file), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("//")).length;
}

function closureSize() {
  const dir = path.resolve(HERE, "../../node_modules/xstate/dist");
  const seen = new Set();
  const stack = ["xstate.esm.js"];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !f.endsWith(".js")) continue;
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    seen.add(f);
    const src = fs.readFileSync(p, "utf8");
    for (const m of src.matchAll(/from\s*['"]\.\/([^'"]+)['"]/g)) {
      if (m[1].endsWith(".js")) stack.push(m[1]);
    }
  }
  let raw = 0;
  let gz = 0;
  for (const f of seen) {
    const b = fs.readFileSync(path.join(dir, f));
    raw += b.length;
    gz += gzip.gzipSync(b, { level: 9 }).length;
  }
  return { files: seen.size, raw, gz };
}

console.log("== 等价性 ==");
let allEqual = true;
for (const [i, seq] of SEQUENCES.entries()) {
  const a = runReducer(seq);
  const b = runXState(seq);
  const equal = JSON.stringify(a) === JSON.stringify(b);
  allEqual &&= equal;
  console.log(`#${i + 1} ${equal ? "OK " : "DIFF"} reducer=${JSON.stringify(a)} xstate=${JSON.stringify(b)}`);
}

const reducerSnap = reduceSnapshot(runReducer(SEQUENCES[0]));
const actor = xstate.createActor(createWorldMachine(xstate));
actor.start();
for (const e of SEQUENCES[0]) actor.send(typeof e === "string" ? { type: e } : e);
const xstateSnap = JSON.stringify(actor.getPersistedSnapshot());
actor.stop();

const bundle = closureSize();
console.log("\n== 指标 ==");
console.log(`等价性：${allEqual ? "全部一致" : "存在差异"}`);
console.log(`reducer 代码行：${loc("world.reducer.js")}`);
console.log(`xstate 代码行：${loc("world.xstate.js")}`);
console.log(`reducer 快照：${Buffer.byteLength(reducerSnap)} B`);
console.log(`xstate 持久化快照：${Buffer.byteLength(xstateSnap)} B`);
console.log(`xstate 运行时闭包：${bundle.files} 文件 / ${(bundle.raw / 1024).toFixed(1)} KB min / ${(bundle.gz / 1024).toFixed(1)} KB gzip`);
console.log(`reducer 运行时依赖：0 B`);
console.log(`\nreducer 快照: ${reducerSnap}`);
console.log(`xstate 快照: ${xstateSnap.slice(0, 300)}${xstateSnap.length > 300 ? "…" : ""}`);

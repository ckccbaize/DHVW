#!/usr/bin/env node
// 用 JS painter 生成地形层，供与 Python 黄金图逐像素对比。
// 用法：node tools/paint-terrain.mjs <spec.map.json> [out.png]
import fs from "node:fs/promises";
import path from "node:path";
import { paintTerrain } from "../www/js/forge/painter.js";
import { encodePng } from "./png.mjs";

const specPath = process.argv[2] || "../assets/scenes/home/home.map.json";
const outPath = process.argv[3] || ".tmp/terrain-js.png";
const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
const cv = paintTerrain(spec);
const png = encodePng(cv.data, cv.w, cv.h);
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, png);
console.log(`terrain-js: ${cv.w}x${cv.h} → ${outPath}`);

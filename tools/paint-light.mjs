#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { paintLight } from "../www/js/forge/painter.js";
import { encodePng } from "./png.mjs";

const specPath = process.argv[2] || "../assets/scenes/home/home.map.json";
const outPath = process.argv[3] || ".tmp/light-js.png";
const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
const cv = paintLight(spec);
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, encodePng(cv.data, cv.w, cv.h));
console.log(`light-js: ${cv.w}x${cv.h} → ${outPath}`);

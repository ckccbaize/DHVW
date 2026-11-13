#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { paintFurniture } from "../www/js/forge/furniture.js";
import { encodePng } from "./png.mjs";

const specPath = process.argv[2] || "../assets/scenes/home/home.map.json";
const outPath = process.argv[3] || ".tmp/furniture-js.png";
const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
const cv = paintFurniture(spec);
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, encodePng(cv.data, cv.w, cv.h));
console.log(`furniture-js: ${cv.w}x${cv.h} → ${outPath}`);

#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { buildScene } from "../www/js/forge/scene.js";
import { encodePng } from "./png.mjs";

const specPath = process.argv[2] || "../assets/scenes/home/home.map.json";
const outDir = process.argv[3] || ".tmp/scene-js";
const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
const scene = buildScene(spec);
await fs.mkdir(outDir, { recursive: true });
const write = async (name, cv) => fs.writeFile(path.join(outDir, name), encodePng(cv.data, cv.w, cv.h));
await write("terrain.png", scene.terrain);
await write("furniture.png", scene.furniture);
await write("light_day.png", scene.light);
await write(`${spec.name}.png`, scene.image);
await write(`${spec.name}@2x.png`, scene.image2x);
await fs.writeFile(path.join(outDir, `${spec.name}.built.json`), JSON.stringify(scene.built, null, 1) + "\n");
console.log(`scene-js: ${spec.name} ${scene.image.w}x${scene.image.h} → ${outDir}`);

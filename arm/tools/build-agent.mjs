// 构建期打包 skills / prompts → www/agent/registry.json（W12）。
// 源：agent/skills/<name>/SKILL.md（frontmatter + 正文）、agent/prompts/<name>.md
// 用法：node tools/build-agent.mjs [--check]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, "agent", "skills");
const PROMPTS_DIR = path.join(ROOT, "agent", "prompts");
const OUT = path.join(ROOT, "www", "agent", "registry.json");

export const ALLOWED_TOOLS = new Set(["web_fetch", "artifact_create", "place_travel", "weather", "clock"]);
export const CLASSES = new Set(["character", "work"]);
export const OUTPUTS = new Set(["text", "json"]);

function parseValue(v) {
  const s = String(v).trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    return s
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s.replace(/^["']|["']$/g, "");
}

export function parseFrontmatter(text) {
  const s = String(text ?? "").replace(/^\uFEFF/, "");
  if (!s.startsWith("---")) return { data: {}, body: s };
  const end = s.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: s };
  const head = s.slice(3, end).trim();
  const body = s.slice(end + 4).replace(/^\n+/, "");
  const data = {};
  for (const line of head.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) data[m[1]] = parseValue(m[2]);
  }
  return { data, body };
}

async function readDirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function buildRegistry(root = ROOT) {
  const skillsDir = path.join(root, "agent", "skills");
  const promptsDir = path.join(root, "agent", "prompts");
  const errors = [];
  const prompts = {};

  for (const ent of await readDirSafe(promptsDir)) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const name = ent.name.replace(/\.md$/, "");
    prompts[name] = await fs.readFile(path.join(promptsDir, ent.name), "utf8");
  }

  const skills = {};
  for (const ent of await readDirSafe(skillsDir)) {
    if (!ent.isDirectory()) continue;
    const file = path.join(skillsDir, ent.name, "SKILL.md");
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      errors.push({ file: `agent/skills/${ent.name}/SKILL.md`, msg: "缺少 SKILL.md" });
      continue;
    }
    const { data, body } = parseFrontmatter(text);
    const name = data.name || ent.name;
    if (name !== ent.name) errors.push({ file: `agent/skills/${ent.name}`, msg: `name "${name}" 与目录名不一致` });
    if (!data.description) errors.push({ file: `agent/skills/${ent.name}`, msg: "缺少 description" });
    if (!CLASSES.has(data.class)) errors.push({ file: `agent/skills/${ent.name}`, msg: `class 必须是 character/work` });
    if (!data.prompt) errors.push({ file: `agent/skills/${ent.name}`, msg: "缺少 prompt" });
    else if (!prompts[data.prompt]) errors.push({ file: `agent/skills/${ent.name}`, msg: `prompt "${data.prompt}" 不存在` });
    // 推理模型把 reasoning_content 也算进 max_tokens，正文预算需要在上限之上额外留出，
    // 旧上限 800 会让 plot/writing 在思考阶段就被截断，正文永远为空。
    if (!Number.isFinite(data.maxTokens) || data.maxTokens < 1 || data.maxTokens > 16000) {
      errors.push({ file: `agent/skills/${ent.name}`, msg: "maxTokens 必须在 1–16000" });
    }
    if (!Number.isFinite(data.temperature) || data.temperature < 0 || data.temperature > 2) {
      errors.push({ file: `agent/skills/${ent.name}`, msg: "temperature 必须在 0–2" });
    }
    for (const tool of data.tools || []) {
      if (!ALLOWED_TOOLS.has(tool)) errors.push({ file: `agent/skills/${ent.name}`, msg: `未知工具 "${tool}"` });
    }
    if (!OUTPUTS.has(data.output)) errors.push({ file: `agent/skills/${ent.name}`, msg: "output 必须是 text/json" });
    if (skills[name]) errors.push({ file: `agent/skills/${ent.name}`, msg: `重复的 skill "${name}"` });
    skills[name] = { ...data, name, body };
  }

  return {
    registry: { version: 1, built_at: new Date().toISOString(), skills, prompts },
    errors,
  };
}

async function main(argv) {
  const check = argv.includes("--check");
  const { registry, errors } = await buildRegistry(ROOT);
  if (errors.length) {
    console.error(`✗ agent registry 不合格（${errors.length} 项）`);
    for (const e of errors) console.error(`  - ${e.file}: ${e.msg}`);
    process.exit(1);
  }
  if (check) {
    console.log(`✓ agent registry 合法：${Object.keys(registry.skills).length} skills / ${Object.keys(registry.prompts).length} prompts`);
    return;
  }
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(registry, null, 1) + "\n", "utf8");
  console.log(
    `agent/registry.json: ${Object.keys(registry.skills).length} skills / ${Object.keys(registry.prompts).length} prompts`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((e) => {
    console.error("✗ 构建失败:", e.message);
    process.exit(2);
  });
}

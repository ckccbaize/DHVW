// 场景细化 Agent：只做加法（家具 overlay / 地板细节），不增删家具、不改交互。
import { extractJson } from "./json.js";
import { buildSceneFromLlm, validateLlmScene } from "../../forge/scene-llm.js";

const TOOLS = {
  get_scene: "返回当前场景的 props/decor/zones 摘要",
  add_prop_detail: "给家具叠加细节。args.target 是 name/id，args.shapes 是图元数组",
  add_floor_detail: "加地板细节。args.details 是 [{x,y,shape:[...]}]",
  validate: "跑闸门",
  finish: "交付细化后的场景",
};

function toolPrompt() {
  return Object.entries(TOOLS).map(([k, v]) => `- ${k}: ${v}`).join("\n");
}

export async function runSceneDetailAgent({
  llm,
  registry,
  scene,
  kind,
  name,
  maxTurns = 6,
  onTurn = async () => {},
} = {}) {
  if (!llm || !registry || !scene) return { ok: false, reason: "missing_dependency" };
  const props = JSON.parse(JSON.stringify(scene.props || []));
  const decor = JSON.parse(JSON.stringify(scene.decor || []));
  const base = {
    ...scene,
    kind,
    name,
    props,
    decor,
    interactions: scene.interactions || { schema_version: 1, acts: {} },
    routes: scene.routes || [],
  };
  const summary = () => ({
    rooms: scene.rooms || [],
    zones: scene.zones || [],
    props: props.map((p) => ({ name: p.name, id: p.id, x: p.x, y: p.y, w: p.w, h: p.h, room: p.room })),
    decor,
  });
  const system = registry.render("scene-detail", {
    kind,
    name,
    scene: JSON.stringify(summary()),
    tools: toolPrompt(),
  });
  const messages = [{ role: "system", content: system }];
  let lastErrors = [];

  const runTool = (call) => {
    const tool = String(call?.tool || "");
    const args = call?.args && typeof call.args === "object" ? call.args : {};
    if (tool === "get_scene") return { tool, result: summary() };
    if (tool === "add_prop_detail") {
      const target = String(args.target || "");
      const shapes = Array.isArray(args.shapes) ? args.shapes : [];
      const hits = props.filter((p) => p.name === target || p.id === target);
      if (!hits.length) return { tool, result: { ok: false, error: `prop_not_found:${target}` } };
      for (const p of hits) {
        if (Array.isArray(p.shape)) p.shape.push(...shapes);
        else p.overlay = [...(p.overlay || []), ...shapes];
      }
      return { tool, result: { ok: true, targets: hits.length, shapes: shapes.length } };
    }
    if (tool === "add_floor_detail") {
      const details = Array.isArray(args.details) ? args.details : [];
      for (const d of details) {
        if (!d || !Array.isArray(d.shape)) continue;
        decor.push({ name: `地板细节-${decor.length + 1}`, x: d.x, y: d.y, shape: d.shape });
      }
      return { tool, result: { ok: true, count: decor.length } };
    }
    if (tool === "validate") {
      const errors = validateLlmScene(base);
      lastErrors = errors;
      return { tool, result: { ok: errors.length === 0, errors: errors.slice(0, 30) } };
    }
    if (tool === "finish") {
      const errors = validateLlmScene(base);
      lastErrors = errors;
      if (errors.length) return { tool, result: { ok: false, errors: errors.slice(0, 30) } };
      const built = buildSceneFromLlm(base);
      if (!built.ok) return { tool, result: { ok: false, errors: built.errors.slice(0, 30) } };
      return { tool, result: { ok: true }, done: true, scene: built.scene };
    }
    return { tool, result: { ok: false, error: `unknown_tool:${tool}` } };
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    let res;
    try {
      res = await llm.complete({
        messages,
        maxTokens: 4096,
        temperature: 0.3,
        json: true,
        cls: "work",
        kind: "scene-detail",
      });
    } catch (err) {
      await onTurn({ turn, tool: "llm", ok: false, error: err.message });
      return { ok: false, reason: "llm_failed", errors: lastErrors };
    }
    const call = extractJson(res.text);
    messages.push({ role: "assistant", content: res.text });
    if (!call || typeof call !== "object" || !call.tool) {
      await onTurn({ turn, tool: "parse", ok: false, raw: String(res.text).slice(0, 300) });
      messages.push({ role: "user", content: "无效输出。每轮只输出一个 JSON：{\"tool\":\"...\",\"args\":{...}}" });
      continue;
    }
    const out = runTool(call);
    await onTurn({ turn, tool: out.tool, ok: out.result?.ok !== false, result: out.result, done: !!out.done });
    if (out.done) return { ok: true, scene: out.scene, turns: turn };
    messages.push({ role: "user", content: JSON.stringify({ tool: out.tool, result: out.result }) });
  }
  return { ok: false, reason: "max_turns", errors: lastErrors };
}

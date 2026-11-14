// 场景 Agent：多轮工具调用。LLM 自己画家具（shape 图元），本地只执行工具与校验。
import { extractJson } from "./json.js";
import { buildSceneFromLlm, validateLlmScene } from "../../forge/scene-llm.js";
import { buildInteractions, ACT_DEFS } from "../../forge/scenekit.js";
import { FURNITURE_SIZES } from "../../forge/furniture.js";
import { ANIMATIONS } from "../../forge/scene-llm.js";

const TOOLS = {
  get_layout: "返回已定的 rooms/zones/doors/windows/spawn；不要改户型",
  add_props: "追加家具/物体。args.props 是数组；非家居物体用 shape 图元自己画；重叠会被拒绝",
  remove_props: "删除家具。args.names 或 args.ids 数组",
  clear_props: "清空全部家具，重新摆",
  set_interactions: "设置 interactions；args.interactions.acts 必须是 act id → 定义",
  auto_interactions: "按家具表自动生成 interactions（推荐先用这个，再补自定义 act）",
  set_routes: "设置 routes；args.routes",
  set_spawn: "设置出生点；args.spawn",
  validate: "跑场景闸门，返回 errors",
  finish: "校验通过后交付场景",
};

function toolPrompt() {
  return Object.entries(TOOLS).map(([k, v]) => `- ${k}: ${v}`).join("\n");
}

export async function runSceneAgent({
  llm,
  registry,
  layout,
  kind,
  name,
  description,
  maxTurns = 10,
  onTurn = async () => {},
} = {}) {
  if (!llm || !registry || !layout) return { ok: false, reason: "missing_dependency" };
  const state = {
    props: [],
    interactions: null,
    routes: [],
    spawn: layout.spawn,
  };
  const system = registry.render("scene-agent", {
    description: description || name || kind,
    kind,
    name,
    layout: JSON.stringify(layout),
    tools: toolPrompt(),
    furniture: Object.keys(FURNITURE_SIZES).join(", "),
    acts: Object.keys(ACT_DEFS).join(", "),
    animations: [...ANIMATIONS].join(", "),
  });
  const messages = [{ role: "system", content: system }];
  let lastErrors = [];

  const candidate = () => {
    const acts = state.interactions?.acts;
    return {
      ...layout,
      kind,
      name,
      props: state.props,
      interactions: acts && Object.keys(acts).length ? state.interactions : buildInteractions(state.props),
      routes: state.routes,
      spawn: state.spawn,
    };
  };

  const runTool = (call) => {
    const tool = String(call?.tool || "");
    const args = call?.args && typeof call.args === "object" ? call.args : {};
    if (tool === "get_layout") return { tool, result: layout };
    if (tool === "add_props") {
      const list = Array.isArray(args.props) ? args.props : [];
      const occupied = new Set();
      for (const p of state.props) {
        if (["rug", "door_mat", "bath_mat"].includes(p.id)) continue;
        const pw = p.w || 1;
        const ph = p.h || 1;
        for (let yy = p.y; yy < p.y + ph; yy++) for (let xx = p.x; xx < p.x + pw; xx++) occupied.add(`${xx},${yy}`);
      }
      const names = new Set(state.props.map((p) => p.name).filter(Boolean));
      const added = [];
      const rejected = [];
      for (const p of list) {
        if (!p || typeof p !== "object" || !p.id) { rejected.push("prop_without_id"); continue; }
        if (p.name && names.has(p.name)) { rejected.push(`duplicate_name:${p.name}`); continue; }
        const pw = p.w || 1;
        const ph = p.h || 1;
        let clash = false;
        if (!["rug", "door_mat", "bath_mat"].includes(p.id)) {
          for (let yy = p.y; yy < p.y + ph && !clash; yy++) for (let xx = p.x; xx < p.x + pw; xx++) if (occupied.has(`${xx},${yy}`)) { clash = true; break; }
        }
        if (clash) { rejected.push(`overlap:${p.name || p.id}`); continue; }
        if (!["rug", "door_mat", "bath_mat"].includes(p.id)) {
          for (let yy = p.y; yy < p.y + ph; yy++) for (let xx = p.x; xx < p.x + pw; xx++) occupied.add(`${xx},${yy}`);
        }
        if (p.name) names.add(p.name);
        state.props.push(p);
        added.push(p.name || p.id);
      }
      const counts = {};
      for (const p of state.props) counts[p.room] = (counts[p.room] || 0) + 1;
      const empty = [...(layout.rooms || []), ...(layout.zones || [])].map((a) => a.id).filter((id) => !counts[id]);
      return { tool, result: { count: state.props.length, added, rejected, empty_areas: empty } };
    }
    if (tool === "remove_props") {
      const names = new Set(Array.isArray(args.names) ? args.names : []);
      const ids = new Set(Array.isArray(args.ids) ? args.ids : []);
      const before = state.props.length;
      state.props = state.props.filter((p) => !(names.has(p.name) || ids.has(p.id)));
      return { tool, result: { removed: before - state.props.length, count: state.props.length } };
    }
    if (tool === "clear_props") {
      state.props = [];
      return { tool, result: { count: 0 } };
    }
    if (tool === "set_interactions") {
      const raw = args.interactions && typeof args.interactions === "object" ? args.interactions : args;
      const acts = raw?.acts && typeof raw.acts === "object" ? raw.acts : null;
      if (!acts) return { tool, result: { ok: false, error: "interactions.acts 必须是对象" } };
      const errors = [];
      for (const [id, def] of Object.entries(acts)) {
        if (!def?.label) errors.push(`${id}.label`);
        if (!Array.isArray(def?.trigger?.props) || !def.trigger.props.length) errors.push(`${id}.trigger.props`);
        if (!def?.perform?.animation) errors.push(`${id}.perform.animation`);
        if (!Number.isFinite(Number(def?.perform?.duration_min))) errors.push(`${id}.duration_min`);
      }
      if (errors.length) return { tool, result: { ok: false, errors: errors.slice(0, 30) } };
      state.interactions = { schema_version: 1, acts };
      return { tool, result: { ok: true, acts: Object.keys(acts) } };
    }
    if (tool === "auto_interactions") {
      state.interactions = buildInteractions(state.props);
      return { tool, result: { ok: true, acts: Object.keys(state.interactions.acts) } };
    }
    if (tool === "set_routes") {
      const list = Array.isArray(args.routes) ? args.routes : [];
      state.routes = list.filter((r) => Array.isArray(r?.waypoints) && r.waypoints.length >= 2);
      return { tool, result: { count: state.routes.length, dropped: list.length - state.routes.length } };
    }
    if (tool === "set_spawn") {
      state.spawn = args.spawn || state.spawn;
      return { tool, result: state.spawn };
    }
    if (tool === "validate") {
      const errors = validateLlmScene(candidate());
      lastErrors = errors;
      return { tool, result: { ok: errors.length === 0, errors: errors.slice(0, 40) } };
    }
    if (tool === "finish") {
      const errors = validateLlmScene(candidate());
      lastErrors = errors;
      if (errors.length) return { tool, result: { ok: false, errors: errors.slice(0, 40) } };
      const built = buildSceneFromLlm(candidate());
      if (!built.ok) return { tool, result: { ok: false, errors: built.errors.slice(0, 40) } };
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
        temperature: turn === 1 ? 0.5 : 0.25,
        json: true,
        cls: "work",
        kind: "scene-agent",
      });
    } catch (err) {
      await onTurn({ turn, tool: "llm", ok: false, error: err.message });
      return { ok: false, reason: "llm_failed", turn, errors: lastErrors };
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

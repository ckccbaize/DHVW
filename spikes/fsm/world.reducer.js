// 世界状态机（纯 reducer 版）——W2 spike 的候选 A。
// 三个并行维度：display / conn / tier；非法迁移只计数，不抛异常。
// 契约见 docs/WORLD-CORE-SPEC.md §2.1。

export const INITIAL = Object.freeze({
  display: "overview", // overview | present
  conn: "down", // up | down
  tier: "idle", // idle | host | edge
  illegal: 0,
});

export function createWorld(init = INITIAL) {
  return { ...INITIAL, ...init };
}

/**
 * 纯函数迁移：state + event -> new state。
 * 不修改入参；非法事件/非法组合只增加 illegal 计数。
 */
export function transition(state, event) {
  const s = { ...state };
  switch (event.type) {
    case "HOST_UP":
      s.conn = "up";
      // 与 XState 的 always 对齐：主机回来时端侧档自动退出
      if (s.tier === "edge") s.tier = "idle";
      break;

    case "HOST_DOWN":
    case "HOST_LOST":
      s.conn = "down";
      if (s.display === "present") s.display = "overview";
      if (s.tier === "host") s.tier = "idle";
      break;

    case "PRESENT_REQUEST":
      if (s.conn !== "up" || s.tier !== "idle" || s.display !== "overview") {
        s.illegal += 1;
        break;
      }
      s.display = "present";
      break;

    case "PRESENT_EXIT":
      if (s.display !== "present") {
        s.illegal += 1;
        break;
      }
      s.display = "overview";
      break;

    case "WORLD_START":
      if (s.conn !== "up" || s.display !== "overview" || s.tier !== "idle") {
        s.illegal += 1;
        break;
      }
      s.tier = "host";
      break;

    case "WORLD_STOP":
      if (s.tier === "idle") {
        s.illegal += 1;
        break;
      }
      s.tier = "idle";
      break;

    case "EDGE_START":
      if (s.conn === "up" || s.display !== "overview" || s.tier !== "idle") {
        s.illegal += 1;
        break;
      }
      s.tier = "edge";
      break;

    case "TIER_SET": {
      const v = event.value;
      if (!["idle", "host", "edge"].includes(v)) {
        s.illegal += 1;
        break;
      }
      if (v === "host" && s.conn !== "up") {
        s.illegal += 1;
        break;
      }
      if (v === "edge" && s.conn === "up") {
        s.illegal += 1;
        break;
      }
      s.tier = v;
      break;
    }

    case "TAKEOVER":
      s.display = "overview";
      s.tier = "idle";
      break;

    default:
      s.illegal += 1;
      break;
  }
  return s;
}

export function snapshot(state) {
  return JSON.stringify(state);
}

export function restore(json) {
  const raw = typeof json === "string" ? JSON.parse(json) : json;
  if (!raw || typeof raw !== "object") throw new Error("快照不是对象");
  const s = createWorld(raw);
  if (!["overview", "present"].includes(s.display)) throw new Error(`display 非法: ${s.display}`);
  if (!["up", "down"].includes(s.conn)) throw new Error(`conn 非法: ${s.conn}`);
  if (!["idle", "host", "edge"].includes(s.tier)) throw new Error(`tier 非法: ${s.tier}`);
  if (!Number.isInteger(s.illegal) || s.illegal < 0) throw new Error("illegal 非法");
  return s;
}

/** 供可视化用的图描述（不是执行逻辑）。 */
export const GRAPH = {
  regions: {
    display: { initial: "overview", states: ["overview", "present"] },
    conn: { initial: "down", states: ["down", "up"] },
    tier: { initial: "idle", states: ["idle", "host", "edge"] },
  },
  transitions: [
    { event: "HOST_UP", conn: "down→up" },
    { event: "HOST_DOWN", conn: "up→down", effects: ["display→overview", "tier.host→idle"] },
    { event: "PRESENT_REQUEST", display: "overview→present", guard: "conn=up & tier=idle" },
    { event: "PRESENT_EXIT", display: "present→overview" },
    { event: "WORLD_START", tier: "idle→host", guard: "conn=up & display=overview" },
    { event: "WORLD_STOP", tier: "host|edge→idle" },
    { event: "EDGE_START", tier: "idle→edge", guard: "conn=down & display=overview" },
    { event: "TIER_SET", tier: "→idle|host|edge", guard: "host 需 conn=up；edge 需 conn=down" },
    { event: "TAKEOVER", effects: ["display→overview", "tier→idle"] },
  ],
};

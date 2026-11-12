// 世界状态机（W3 落地版）：display × conn × tier 三个并行维度。
// 选型依据：spikes/fsm/REPORT.md（纯 reducer，零依赖）。
// 契约：docs/WORLD-CORE-SPEC.md §2.1；事件：docs/CONTRACTS.md §1。

export const INITIAL = Object.freeze({
  display: "overview", // overview | present
  conn: "down", // up | down
  tier: "idle", // idle | host | edge
  illegal: 0,
});

export function createWorld(init = INITIAL) {
  return { ...INITIAL, ...init };
}

/** 纯函数迁移；非法事件/组合只增加 illegal 计数。 */
export function transition(state, event) {
  const s = { ...state };
  switch (event.type) {
    case "HOST_UP":
      s.conn = "up";
      if (s.tier === "edge") s.tier = "idle"; // 主机回来，端侧档退出
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
    { event: "HOST_UP", conn: "down→up", effects: ["tier.edge→idle"] },
    { event: "HOST_DOWN", conn: "up→down", effects: ["display→overview", "tier.host→idle"] },
    { event: "HOST_LOST", conn: "up→down", effects: ["display→overview", "tier.host→idle"] },
    { event: "PRESENT_REQUEST", display: "overview→present", guard: "conn=up & tier=idle" },
    { event: "PRESENT_EXIT", display: "present→overview" },
    { event: "WORLD_START", tier: "idle→host", guard: "conn=up & display=overview" },
    { event: "WORLD_STOP", tier: "host|edge→idle" },
    { event: "EDGE_START", tier: "idle→edge", guard: "conn=down & display=overview" },
    { event: "TIER_SET", tier: "→idle|host|edge", guard: "host 需 conn=up；edge 需 conn=down" },
    { event: "TAKEOVER", effects: ["display→overview", "tier→idle"] },
  ],
};

const LOG_CAP = 200;

/**
 * 运行时包装：迁移日志 + 计数 + 快照。
 * 统计口径：只有真正改变状态或产生非法计数的事件才记录。
 */
export function createWorldRuntime({ log = () => {}, now = () => Date.now() } = {}) {
  let state = createWorld();
  const records = [];
  const counts = new Map();
  let seq = 0;

  const keyOf = (from, eventType, to, illegal) =>
    `${eventType}|${from.display}/${from.conn}/${from.tier}->${to.display}/${to.conn}/${to.tier}${illegal ? "|illegal" : ""}`;

  return {
    get state() {
      return state;
    },
    get records() {
      return records.slice();
    },
    get counts() {
      return Object.fromEntries(counts);
    },
    dispatch(event) {
      const from = { display: state.display, conn: state.conn, tier: state.tier };
      const next = transition(state, event);
      const changed = from.display !== next.display || from.conn !== next.conn || from.tier !== next.tier;
      const illegal = next.illegal > state.illegal;
      state = next;
      if (!changed && !illegal) return { state, changed: false, illegal: false };

      seq += 1;
      const rec = {
        seq,
        t: now(),
        event: event.type,
        from,
        to: { display: next.display, conn: next.conn, tier: next.tier },
        illegal,
      };
      records.push(rec);
      if (records.length > LOG_CAP) records.shift();
      const k = keyOf(from, event.type, rec.to, illegal);
      counts.set(k, (counts.get(k) || 0) + 1);
      log(rec);
      return { state, changed, illegal, record: rec };
    },
    reset(init) {
      state = createWorld(init);
      records.length = 0;
      counts.clear();
      seq = 0;
      return state;
    },
  };
}

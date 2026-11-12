// 主机桥（W9）：把 PC 的 WS 消息翻译成世界状态机事件与 UI 消息。
// 契约：docs/CONTRACTS.md §3；PC 侧要求：docs/PC-INTEGRATION.md。

export function createHostBridge({ dispatchWorld, send, post, now = () => Date.now() }) {
  let conn = "down";
  let offsetMs = 0;
  let lastSeen = 0;
  let sessionId = null;

  function patchHost(extra = {}) {
    post("core:state", {
      patch: { host: { conn, offsetMs, lastSeen, session: sessionId, ...extra } },
    });
  }

  return {
    get conn() {
      return conn;
    },
    get offsetMs() {
      return offsetMs;
    },
    get lastSeen() {
      return lastSeen;
    },
    get sessionId() {
      return sessionId;
    },

    onConn(next, info = {}) {
      conn = next === "up" ? "up" : "down";
      lastSeen = now();
      dispatchWorld({ type: conn === "up" ? "HOST_UP" : "HOST_DOWN" });
      patchHost({ reason: info.reason || null });
      return conn;
    },

    onMessage(msg) {
      if (!msg || typeof msg.type !== "string") return;
      lastSeen = now();
      const p = msg.payload || {};
      switch (msg.type) {
        case "hello":
          if (Number.isFinite(p.t_server)) offsetMs = p.t_server - now();
          if (p.world_tier) dispatchWorld({ type: "TIER_SET", value: p.world_tier });
          patchHost();
          break;
        case "state:overview":
          if (p.work_tier) dispatchWorld({ type: "TIER_SET", value: p.work_tier });
          if (p.clock) post("core:event", { ev: { kind: "host_clock", day: p.clock.day, minute: p.clock.minute } });
          break;
        case "tier":
          dispatchWorld({ type: "TIER_SET", value: p.value });
          break;
        case "say":
          post("core:bubble", { text: p.text, ttl: p.ttl || 2600 });
          break;
        case "moveTo":
          post("core:moveTo", {
            targetGrid: p.targetGrid,
            path: p.path,
            speed: p.speed,
            t0: p.t0,
          });
          break;
        case "switchScene":
          post("core:event", { ev: { kind: "switchScene", scene_id: p.scene_id, t0: p.t0 } });
          break;
        case "present:grant":
          post("core:event", { ev: { kind: "present_grant" } });
          break;
        case "present:deny":
          post("core:event", { ev: { kind: "present_deny", reason: p.reason } });
          break;
        case "present:begin":
          sessionId = p.session_id || null;
          post("core:event", { ev: { kind: "present_begin", session_id: sessionId } });
          break;
        case "present:end":
          sessionId = null;
          post("core:event", { ev: { kind: "present_end" } });
          break;
        case "life:event":
          post("core:event", {
            ev: { kind: "life_event", cycle_id: p.cycle_id, outcome: p.outcome, fact: p.fact },
          });
          break;
        case "memory:facts":
          post("core:event", { ev: { kind: "memory_facts", since: p.since, count: (p.facts || []).length } });
          break;
        case "memory:result":
          post("core:event", { ev: { kind: "memory_result", hits: p.hits, semantic: !!p.semantic } });
          break;
        default:
          post("core:event", { ev: { kind: "host_unknown", type: msg.type } });
          break;
      }
    },

    presentBegin(id) {
      sessionId = id || `p-${now()}`;
      return send({ type: "present:begin", payload: { session_id: sessionId } });
    },
    presentEnd() {
      const id = sessionId;
      sessionId = null;
      return send({ type: "present:end", payload: { session_id: id } });
    },
    eventsBatch(events) {
      return send({ type: "events:batch", payload: { events } });
    },
    memoryPush(payload) {
      return send({ type: "memory:push", payload });
    },
    memoryQuery(text, k = 5) {
      return send({ type: "memory:query", payload: { text, k } });
    },
    worldStop() {
      return send({ type: "world:stop", payload: {} });
    },
    worldResume() {
      return send({ type: "world:resume", payload: {} });
    },
  };
}

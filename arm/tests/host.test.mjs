import test from "node:test";
import assert from "node:assert/strict";

import { createHostBridge } from "../www/js/core/host.js";

function make(now = () => 1000) {
  const dispatched = [];
  const posted = [];
  const sent = [];
  const bridge = createHostBridge({
    dispatchWorld: (ev) => dispatched.push(ev),
    post: (type, payload) => posted.push({ type, payload }),
    send: (msg) => {
      sent.push(msg);
      return true;
    },
    now,
  });
  return { bridge, dispatched, posted, sent };
}

test("onConn：up/down 驱动世界事件并推送 host 状态", () => {
  const { bridge, dispatched, posted } = make();
  bridge.onConn("up", { reason: "ws_open" });
  assert.deepEqual(dispatched[0], { type: "HOST_UP" });
  assert.equal(bridge.conn, "up");
  const patch = posted.find((p) => p.payload?.patch?.host);
  assert.equal(patch.payload.patch.host.conn, "up");

  bridge.onConn("down", { reason: "timeout" });
  assert.deepEqual(dispatched[1], { type: "HOST_DOWN" });
  assert.equal(bridge.conn, "down");
});

test("hello：校时偏移与 world_tier", () => {
  let t = 5000;
  const { bridge, dispatched } = make(() => t);
  bridge.onMessage({ type: "hello", payload: { t_server: 9000, world_tier: "host" } });
  assert.equal(bridge.offsetMs, 4000);
  assert.deepEqual(dispatched[0], { type: "TIER_SET", value: "host" });
});

test("tier / state:overview / say / moveTo", () => {
  const { bridge, dispatched, posted } = make();
  bridge.onMessage({ type: "tier", payload: { value: "edge" } });
  assert.deepEqual(dispatched[0], { type: "TIER_SET", value: "edge" });

  bridge.onMessage({ type: "state:overview", payload: { work_tier: "host", clock: { day: 2, minute: 600 } } });
  assert.deepEqual(dispatched[1], { type: "TIER_SET", value: "host" });
  assert.ok(posted.some((p) => p.type === "core:event" && p.payload.ev.kind === "host_clock"));

  bridge.onMessage({ type: "say", payload: { text: "我回来了", ttl: 1000 } });
  const bubble = posted.find((p) => p.type === "core:bubble");
  assert.equal(bubble.payload.text, "我回来了");

  bridge.onMessage({ type: "moveTo", payload: { targetGrid: [3, 4], path: [[3, 4]], speed: 2, t0: 1 } });
  const move = posted.find((p) => p.type === "core:moveTo");
  assert.deepEqual(move.payload.path, [[3, 4]]);
});

test("present：grant/deny/begin/end", () => {
  const { bridge, posted } = make();
  bridge.onMessage({ type: "present:deny", payload: { reason: "busy" } });
  assert.ok(posted.some((p) => p.type === "core:event" && p.payload.ev.kind === "present_deny"));

  bridge.onMessage({ type: "present:begin", payload: { session_id: "s1" } });
  assert.equal(bridge.sessionId, "s1");
  bridge.onMessage({ type: "present:end", payload: {} });
  assert.equal(bridge.sessionId, null);
});

test("出站：present:begin/end、events:batch、memory:query", () => {
  const { bridge, sent } = make();
  bridge.presentBegin("s9");
  assert.deepEqual(sent[0], { type: "present:begin", payload: { session_id: "s9" } });
  bridge.presentEnd();
  assert.deepEqual(sent[1], { type: "present:end", payload: { session_id: "s9" } });

  bridge.eventsBatch([{ uuid: "u1" }]);
  assert.equal(sent[2].type, "events:batch");
  assert.equal(sent[2].payload.events.length, 1);

  bridge.memoryQuery("京都", 3);
  assert.deepEqual(sent[3], { type: "memory:query", payload: { text: "京都", k: 3 } });
});

test("未知消息：转成 host_unknown 事件，不崩", () => {
  const { bridge, posted } = make();
  bridge.onMessage({ type: "weird", payload: {} });
  assert.ok(posted.some((p) => p.type === "core:event" && p.payload.ev.kind === "host_unknown"));
  bridge.onMessage(null);
});

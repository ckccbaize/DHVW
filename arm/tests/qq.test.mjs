import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLocalMemory, createMemoryDocBackend } from "../www/js/core/memory/local.js";
import { createQqBridge, createQqWorldAdapter, normalizeCandidateFacts } from "../www/js/runtime/qq-bridge.js";

describe("ARM 浏览器侧 QQ Bridge 与 PC 记忆/心情适配 (qq-bridge.js)", () => {
  it("normalizeCandidateFacts 过滤空白并规范化层级与置信度", () => {
    const out = normalizeCandidateFacts(
      [
        { text: "  喜欢喝冰美式  ", tier: "L0", conf: 1.4 },
        { text: "周末去了书店" },
        { text: "   " },
        "喜欢下雪天",
      ],
      () => 12345,
    );
    assert.equal(out.length, 3);
    assert.deepEqual(out[0], { id: undefined, text: "喜欢喝冰美式", tier: "L0", conf: 1, t: 12345 });
    assert.deepEqual(out[1], { id: undefined, text: "周末去了书店", tier: "L2", conf: 0.8, t: 12345 });
    assert.deepEqual(out[2], { id: undefined, text: "喜欢下雪天", tier: "L2", conf: 0.8, t: 12345 });
  });

  it("PC 在线优先走 remoteMemory(mood + includeL0)；离线或超时无缝回退 localMemory 与 L0 缓存", async () => {
    const localMemory = createLocalMemory({ backend: createMemoryDocBackend(), now: () => 1000 });
    await localMemory.init();
    await localMemory.add({ id: "l0-tea", text: "讨厌香菜，偏爱乌龙茶", tier: "L0", t: 900 });
    await localMemory.add({ id: "l2-cat", text: "上周在窗台拍了一只三花猫", tier: "L2", t: 950 });

    let hostUp = true;
    const remoteCalls = [];
    const adapter = createQqWorldAdapter({
      remoteMemory: {
        async query(text, k, opts) {
          remoteCalls.push({ text, k, opts });
          if (text.includes("超时") || text.includes("三花猫")) throw new Error("timeout");
          return {
            semantic: true,
            l0: [{ id: "pc-l0", text: "PC 核心设定：有点社恐但对主人很黏", tier: "L0" }],
            hits: [{ id: "pc-1", text: "上次去海边捡了贝壳", tier: "L1", score: 0.91 }],
          };
        },
      },
      getBrain: () => ({ localMemory }),
      isHostUp: () => hostUp,
    });

    // 在线走 PC 语义向量检索并携带 mood + includeL0
    const rOnline = await adapter.handleMemoryQuery({ text: "海边", k: 5, mood: { band: "happy", dims: { valence: 0.8 } } });
    assert.equal(rOnline.semantic, true);
    assert.equal(rOnline.l0.length, 1);
    assert.equal(rOnline.hits[0].id, "pc-1");
    assert.equal(remoteCalls[0].opts.includeL0, true);
    assert.equal(remoteCalls[0].opts.mood.band, "happy");

    // 主机超时降级本地检索
    const rTimeout = await adapter.handleMemoryQuery({ text: "三花猫", k: 4 });
    assert.equal(rTimeout.semantic, false);
    assert.ok(rTimeout.hits.some((h) => h.id === "l2-cat"));
    assert.ok(rTimeout.l0.some((f) => f.id === "l0-tea"));

    // 离线直接走本地记忆
    hostUp = false;
    const rOffline = await adapter.handleMemoryQuery({ text: "乌龙茶", k: 4 });
    assert.equal(rOffline.semantic, false);
    assert.ok(rOffline.hits.some((h) => h.id === "l0-tea"));
    assert.equal(remoteCalls.length, 2); // 离线不再请求 PC
  });

  it("handleFeedback 更新心情、气泡（睡眠期抑制）、动作、事件，并写入本地且推 facts:candidates 回 PC", async () => {
    const moodUpdates = [];
    const bubbles = [];
    const actions = [];
    const events = [];
    const ingested = [];
    const hostMsgs = [];
    let sleeping = false;

    const adapter = createQqWorldAdapter({
      ingestFacts: async (facts) => {
        ingested.push(...facts);
        return { accepted: facts.map((_, i) => `f-${i}`), merged: [], rejected: [] };
      },
      isHostUp: () => true,
      sendToHost: (m) => hostMsgs.push(m),
      applyMoodDelta: (d) => moodUpdates.push(d),
      onBubble: (t, ttl) => bubbles.push({ t, ttl }),
      onAction: (a) => actions.push(a),
      onEvent: (k, p) => events.push({ k, p }),
      isSleeping: () => sleeping,
    });

    const res = await adapter.handleFeedback({
      moodDelta: { valence: 0.06, social: -0.05 },
      bubble: "刚刚在 QQ 上和主人聊了会",
      action: "smile",
      event: { kind: "qq:chat", payload: { inText: "早安" } },
      facts: [{ text: "主人今天在家远程办公", tier: "L2", conf: 0.85 }],
    });

    assert.equal(res.factsAccepted, 1);
    assert.equal(res.pushedToPc, true);
    assert.deepEqual(moodUpdates, [{ valence: 0.06, social: -0.05 }]);
    assert.equal(bubbles[0].t, "刚刚在 QQ 上和主人聊了会");
    assert.deepEqual(actions, ["smile"]);
    assert.equal(events[0].k, "qq:chat");
    assert.equal(ingested.length, 1);
    assert.equal(hostMsgs[0].type, "facts:candidates");
    assert.equal(hostMsgs[0].payload.facts[0].text, "主人今天在家远程办公");

    // 睡眠期间抑制气泡弹出
    sleeping = true;
    await adapter.handleFeedback({ bubble: "不该弹出的气泡" });
    assert.equal(bubbles.length, 1);
  });

  it("PC 离线时 QQ 新事实先入本地并在重连后 flush 到 PC，且远端检索给予充足超时预算", async () => {
    const queryOpts = [];
    const hostMsgs = [];
    let hostUp = false;

    const adapter = createQqWorldAdapter({
      remoteMemory: {
        async query(text, k, opts) {
          queryOpts.push(opts);
          return { semantic: true, l0: [{ text: "主人养了一只橘猫" }], hits: [{ text: `命中:${text}`, score: 0.91 }] };
        },
      },
      ingestFacts: async (facts) => ({ accepted: facts }),
      isHostUp: () => hostUp,
      sendToHost: (msg) => {
        hostMsgs.push(msg);
        return true;
      },
    });

    // 离线写入：先落本地并进入 pending 队列，不丢 PC 事实同步
    const fbRes = await adapter.handleFeedback({
      facts: [{ text: "主人喜欢深夜喝热牛奶", tier: "L2", conf: 0.88 }],
    });
    assert.equal(fbRes.factsAccepted, 1);
    assert.equal(fbRes.pushedToPc, false);
    assert.equal(fbRes.queuedForPc, 1);
    assert.equal(hostMsgs.length, 0);

    // PC 重连后自动冲刷待同步事实 & 远端检索超时 >= 1200ms
    hostUp = true;
    const flushed = adapter.flushPendingFacts();
    assert.equal(flushed, 1);
    assert.equal(adapter.pendingFactsCount(), 0);
    assert.equal(hostMsgs[0].type, "facts:candidates");
    assert.equal(hostMsgs[0].payload.facts[0].text, "主人喜欢深夜喝热牛奶");

    const mem = await adapter.handleMemoryQuery({ text: "喝什么", k: 6 });
    assert.equal(mem.semantic, true);
    assert.equal(mem.l0[0].text, "主人养了一只橘猫");
    assert.equal(mem.hits[0].text, "命中:喝什么");
    assert.ok(queryOpts[0].timeoutMs >= 1200);
  });

  it("createQqBridge 应正确分发 qq:memory:query、qq:media:edge、qq:world:feedback 并以 replyTo 回包", async () => {
    const sent = [];
    class MockWs {
      constructor() {
        this.readyState = 1;
      }
      send(raw) {
        sent.push(JSON.parse(raw));
      }
      close() {}
    }

    const feedbacks = [];
    const statuses = [];
    const bridge = createQqBridge({
      WebSocketImpl: MockWs,
      onStatus: (s) => statuses.push(s),
      onFeedback: (fb) => feedbacks.push(fb),
      onMemoryQuery: async (q) => ({ semantic: true, l0: [], hits: [{ text: `命中:${q.text}` }] }),
      onEdgeMedia: async () => ({ dataUrl: "data:image/webp;base64,AAAA" }),
    });
    bridge.start();

    await bridge.handleMessage({ v: 1, id: "s1", type: "qq:status", payload: { connected: true } });
    await bridge.handleMessage({ v: 1, id: "q1", type: "qq:memory:query", payload: { text: "周记" } });
    await bridge.handleMessage({ v: 1, id: "m1", type: "qq:media:edge", payload: {} });
    await bridge.handleMessage({ v: 1, id: "f1", type: "qq:world:feedback", payload: { bubble: "你好" } });

    assert.equal(statuses[0].connected, true);
    assert.equal(feedbacks[0].bubble, "你好");
    assert.equal(sent.length, 2);
    assert.equal(sent[0].type, "qq:reply");
    assert.equal(sent[0].replyTo, "q1");
    assert.equal(sent[0].payload.hits[0].text, "命中:周记");
    assert.equal(sent[1].type, "qq:reply");
    assert.equal(sent[1].replyTo, "m1");
    assert.equal(sent[1].payload.dataUrl, "data:image/webp;base64,AAAA");
    bridge.stop();
  });
});

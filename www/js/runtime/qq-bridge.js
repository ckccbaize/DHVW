// 浏览器端与本地 QQ Bot（qq-openclaw 服务）之间的轻量 WS 桥与世界状态/记忆适配层。
import { makeMsg } from "../core/bus.js";

/**
 * 规范化待写入本地/PC 的事实条目（兼容 { text, tier, conf }）。
 * @param {Array<object|string>} facts
 * @param {() => number} now
 */
export function normalizeCandidateFacts(facts = [], now = () => Date.now()) {
  const out = [];
  for (const item of Array.isArray(facts) ? facts : []) {
    if (!item) continue;
    const text = typeof item === "string" ? item.trim() : String(item.text || "").trim();
    if (!text) continue;
    const tier = item.tier === "L0" || item.tier === "L1" || item.tier === "L2" ? item.tier : "L2";
    const conf = Number.isFinite(Number(item.conf)) ? Math.max(0.1, Math.min(1, Number(item.conf))) : 0.8;
    out.push({
      id: item.id || undefined,
      text: text.slice(0, 200),
      tier,
      conf,
      t: Number(item.t) || now(),
    });
  }
  return out;
}

/**
 * 构建 ARM 世界与记忆适配器：
 * - 在线时优先向 PC `memory.db` 发起带 mood 共振与 L0 核心事实的语义检索；
 * - 离线/超时无缝回退到本地 `localMemory` 检索；
 * - 接收 `qq-openclaw` 的情绪增量、总览气泡、动作、事件与事实候选并回写双端。
 */
export function createQqWorldAdapter({
  remoteMemory = null,
  getBrain = () => ({}),
  ingestFacts = null,
  isHostUp = () => false,
  sendToHost = () => false,
  applyMoodDelta = () => {},
  onBubble = () => {},
  onAction = () => {},
  onEvent = () => {},
  getEdgeMedia = async () => "",
  isSleeping = () => false,
  now = () => Date.now(),
} = {}) {
  function queryLocalFallback(text, k = 4) {
    const { localMemory } = getBrain() || {};
    if (!localMemory) return { semantic: false, l0: [], hits: [] };
    const hits = (localMemory.search(String(text || ""), { k }) || []).map((h) => ({
      id: h.id,
      text: h.text || "",
      score: Number(h.score || 0),
      tier: h.tier || "L2",
      source: "local",
    }));
    const l0 = (localMemory.all?.() || [])
      .filter((d) => d.tier === "L0" && d.text)
      .slice(-6)
      .map((d) => ({ id: d.id, text: d.text, tier: "L0" }));
    return { semantic: false, l0, hits };
  }

  return {
    async handleMemoryQuery(payload = {}) {
      const text = String(payload.text || "").trim();
      const k = Math.max(1, Math.min(12, Number(payload.k) || 4));
      const mood = payload.mood && typeof payload.mood === "object" ? payload.mood : null;

      if (text && isHostUp() && remoteMemory?.query) {
        try {
          const res = await remoteMemory.query(text, k, { mood, includeL0: true, timeoutMs: 350 });
          if (res && (res.semantic || (Array.isArray(res.hits) && res.hits.length) || (Array.isArray(res.l0) && res.l0.length))) {
            return {
              semantic: !!res.semantic,
              l0: Array.isArray(res.l0) ? res.l0 : [],
              hits: Array.isArray(res.hits) ? res.hits : [],
            };
          }
        } catch {
          // PC 离线或超时时回退本地记忆
        }
      }
      return queryLocalFallback(text, k);
    },

    async handleFeedback(fb = {}) {
      if (!fb || typeof fb !== "object") return { factsAccepted: 0 };
      if (fb.moodDelta && typeof fb.moodDelta === "object") {
        applyMoodDelta(fb.moodDelta);
      }
      if (fb.bubble && !isSleeping()) {
        onBubble(String(fb.bubble), 6500);
      }
      if (fb.action) {
        onAction(String(fb.action));
      }
      if (fb.event?.kind) {
        void onEvent(String(fb.event.kind), fb.event.payload || {});
      }
      const facts = normalizeCandidateFacts(fb.facts, now);
      let factsAccepted = 0;
      if (facts.length) {
        if (typeof ingestFacts === "function") {
          const r = await ingestFacts(facts).catch(() => null);
          factsAccepted = Array.isArray(r?.accepted) ? r.accepted.length : facts.length;
        }
        if (isHostUp()) {
          sendToHost({ type: "facts:candidates", payload: { facts, source: "qq" } });
        }
      }
      return { factsAccepted, pushedToPc: facts.length > 0 && isHostUp() };
    },

    async handleEdgeMedia() {
      const dataUrl = await getEdgeMedia().catch(() => "");
      return { dataUrl: typeof dataUrl === "string" ? dataUrl : "" };
    },
  };
}

/**
 * 浏览器侧与本地 qq-openclaw 回环 WS（ws://127.0.0.1:8088/qq/ws）的通信桥。
 */
export function createQqBridge({
  url = "ws://127.0.0.1:8088/qq/ws",
  WebSocketImpl = globalThis.WebSocket,
  onStatus = () => {},
  onFeedback = () => {},
  onMemoryQuery = async () => ({ semantic: false, l0: [], hits: [] }),
  onEdgeMedia = async () => ({ dataUrl: "" }),
  onOpen = () => {},
  onClose = () => {},
  reconnectBaseMs = 2000,
  maxReconnectMs = 30000,
} = {}) {
  let ws = null;
  let closed = true;
  let attempt = 0;
  let timer = null;

  function send(msg) {
    if (!ws || ws.readyState !== 1) return false;
    const pkt = msg?.v === 1 ? msg : makeMsg(msg.type, msg.payload || {}, { replyTo: msg.replyTo, id: msg.id });
    ws.send(JSON.stringify(pkt));
    return true;
  }

  function reply(replyTo, payload) {
    if (!replyTo) return false;
    return send(makeMsg("qq:reply", payload || {}, { replyTo }));
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "qq:status") {
      onStatus(msg.payload || {});
      return true;
    }
    if (msg.type === "qq:world:feedback") {
      await onFeedback(msg.payload || {});
      return true;
    }
    if (msg.type === "qq:memory:query") {
      const result = await Promise.resolve(onMemoryQuery(msg.payload || {})).catch(() => ({
        semantic: false,
        l0: [],
        hits: [],
      }));
      reply(msg.id, result);
      return true;
    }
    if (msg.type === "qq:media:edge") {
      const result = await Promise.resolve(onEdgeMedia(msg.payload || {})).catch(() => ({ dataUrl: "" }));
      reply(msg.id, result && typeof result === "object" ? result : { dataUrl: "" });
      return true;
    }
    return false;
  }

  function schedule() {
    if (closed || timer) return;
    const delay = Math.min(maxReconnectMs, reconnectBaseMs * Math.pow(1.6, attempt));
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (closed || !WebSocketImpl) return;
    try {
      const sock = new WebSocketImpl(url);
      ws = sock;
      sock.onopen = () => {
        attempt = 0;
        onOpen();
      };
      sock.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data || "{}"));
          void handleMessage(msg);
        } catch {}
      };
      sock.onerror = () => {};
      sock.onclose = () => {
        if (ws === sock) ws = null;
        onClose();
        schedule();
      };
    } catch {
      schedule();
    }
  }

  return {
    start() {
      if (!closed) return;
      closed = false;
      connect();
    },
    stop() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {}
        ws = null;
      }
    },
    send,
    reply,
    handleMessage,
    get connected() {
      return !!ws && ws.readyState === 1;
    },
  };
}

// 消息信封与请求跟踪（主线程、Worker、测试共用）。
// 契约见 docs/CONTRACTS.md §0。

export const PROTO = 1;

export function genId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeMsg(type, payload = {}, { replyTo, id, ts } = {}) {
  const msg = { v: PROTO, id: id || genId(), type, ts: ts ?? Date.now(), payload };
  if (replyTo) msg.replyTo = replyTo;
  return msg;
}

/** 校验信封；返回 {ok, code?, msg?}。 */
export function validateMsg(msg) {
  if (!msg || typeof msg !== "object") return { ok: false, code: "bad_payload", msg: "不是对象" };
  if (msg.v !== PROTO) return { ok: false, code: "bad_version", msg: `v=${msg.v}` };
  if (typeof msg.id !== "string" || !msg.id) return { ok: false, code: "bad_payload", msg: "缺少 id" };
  if (typeof msg.type !== "string" || !msg.type) return { ok: false, code: "bad_payload", msg: "缺少 type" };
  if (msg.payload === undefined || msg.payload === null || typeof msg.payload !== "object") {
    return { ok: false, code: "bad_payload", msg: "payload 必须是对象" };
  }
  return { ok: true };
}

export function isError(msg) {
  return !!msg && msg.type === "error";
}

export function errorMsg(replyTo, code, msg) {
  return makeMsg("error", { code, msg }, { replyTo });
}

export function replyMsg(replyTo, result) {
  return makeMsg("core:reply", { ok: true, result }, { replyTo });
}

/**
 * 请求跟踪：把 id → {resolve,reject,timer} 管起来。
 * 收到带 replyTo 的消息时结算；超时/停止时拒绝。
 */
export function createTracker({ timeoutMs = 5000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const pending = new Map();

  return {
    get size() {
      return pending.size;
    },
    track(id, { timeout = timeoutMs } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeoutImpl(() => {
          pending.delete(id);
          reject(Object.assign(new Error(`timeout:${id}`), { code: "timeout" }));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
      });
    },
    /** 返回 true 表示该消息是一条响应的结算。 */
    settle(msg) {
      if (!msg || !msg.replyTo || !pending.has(msg.replyTo)) return false;
      const p = pending.get(msg.replyTo);
      pending.delete(msg.replyTo);
      clearTimeoutImpl(p.timer);
      if (msg.type === "error") {
        const err = Object.assign(new Error(msg.payload?.msg || "error"), { code: msg.payload?.code || "internal" });
        p.reject(err);
      } else {
        p.resolve(msg.payload?.result !== undefined ? msg.payload.result : msg.payload);
      }
      return true;
    },
    rejectAll(reason = "stopped") {
      for (const p of pending.values()) {
        clearTimeoutImpl(p.timer);
        p.reject(new Error(reason));
      }
      pending.clear();
    },
  };
}

// RemoteRuntime：主机可达判定与主机消息通道（PROJECT-PLAN §10.3 / §10.7.4）。
// 心跳 5s；WS 与 HTTP 探测双证；丢失 >60s 判不可达。
// 主机不存在是**默认路径**，因此无 url 时立即 down，不重试、不报错。

import { makeMsg } from "../core/bus.js";

export function createRemoteRuntime({
  url = "",
  probeUrl = "",
  heartbeatMs = 5000,
  timeoutMs = 60000,
  role = "device",
  onMessage = () => {},
  onConn = () => {},
  log = () => {},
  WSImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let ws = null;
  let conn = "down";
  let lastSeen = 0;
  let hbTimer = null;
  let retryTimer = null;
  let stopped = true;
  let retryDelay = 2000;

  function setConn(next, reason) {
    if (conn === next) return;
    conn = next;
    onConn(next, { reason, at: now() });
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(makeMsg(obj.type, obj.payload ?? {}, { id: obj.id, ts: obj.ts, replyTo: obj.replyTo })));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null;
      retryDelay = Math.min(retryDelay * 1.6, 15000);
      connect();
    }, retryDelay);
  }

  async function probe() {
    if (!probeUrl || !fetchImpl) return false;
    try {
      const ac = new AbortController();
      const t = setTimeoutImpl(() => ac.abort(), 2000);
      const res = await fetchImpl(probeUrl, { signal: ac.signal, cache: "no-store" });
      clearTimeoutImpl(t);
      return !!res && res.ok;
    } catch {
      return false;
    }
  }

  function startHeartbeat() {
    clearIntervalImpl(hbTimer);
    hbTimer = setIntervalImpl(async () => {
      const t = now();
      if (conn === "up" && t - lastSeen > timeoutMs) {
        log(`心跳丢失 >${timeoutMs}ms → 判主机不可达`);
        setConn("down", "timeout");
        try {
          ws && ws.close();
        } catch {}
        ws = null;
        clearIntervalImpl(hbTimer);
        hbTimer = null;
        scheduleRetry();
        return;
      }
      if (conn === "up") send({ type: "heartbeat", payload: { t } });
      else if (!ws) {
        // WS 不可用时的第二证：HTTP 探测
        if (await probe()) setConn("up", "probe");
      }
    }, heartbeatMs);
  }

  function connect() {
    if (stopped || !url || !WSImpl) return;
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    let sock;
    try {
      sock = new WSImpl(url);
    } catch (err) {
      log(`WS 创建失败: ${err.message}`);
      setConn("down", "ws_error");
      scheduleRetry();
      return;
    }
    ws = sock;

    sock.onopen = () => {
      retryDelay = 2000;
      lastSeen = now();
      setConn("up", "ws_open");
      send({ type: "hello", payload: { t: now(), role, proto: 1 } });
    };
    sock.onmessage = (ev) => {
      lastSeen = now();
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && msg.type) onMessage(msg);
    };
    sock.onerror = () => {
      if (conn === "up") setConn("down", "ws_error");
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      setConn("down", "ws_close");
      if (!stopped) scheduleRetry();
    };
  }

  return {
    get conn() {
      return conn;
    },
    start() {
      stopped = false;
      if (!url) {
        // 初始态就是 down，但调用方仍需收到一次通知（否则 UI 永远等不到首个 conn 事件）
        conn = "down";
        onConn("down", { reason: "no_host", at: now() });
        return;
      }
      startHeartbeat();
      connect();
    },
    stop() {
      stopped = true;
      clearIntervalImpl(hbTimer);
      hbTimer = null;
      clearTimeout(retryTimer);
      retryTimer = null;
      if (ws) {
        try {
          ws.close();
        } catch {}
        ws = null;
      }
      setConn("down", "stopped");
    },
    send,
    /** 主机时间校准：把 hello.t_server 交给调用方算 clock_offset。 */
    markSeen() {
      lastSeen = now();
    },
  };
}

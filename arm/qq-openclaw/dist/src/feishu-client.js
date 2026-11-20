/**
 * 飞书开放平台官方自建应用机器人客户端（WebSocket 长连接 + IM OpenAPI，零第三方依赖）：
 *   - 鉴权：POST /open-apis/auth/v3/tenant_access_token/internal 自动缓存刷新
 *   - 长连接：POST /callback/ws/endpoint → Node 原生 WebSocket，pbbp2 二进制 Protobuf Frame（ping/pong + method=1 事件推送与 3s 内 ACK）
 *   - 单聊收发：监听 im.message.receive_v1 (p2p text / image / post)，支持首次发消息自动认主、im/v1/images 传图与 im/v1/messages 主动私聊
 *   - 优势：飞书官方无“60分钟4条/每日1次主动发送”限制（仅受 5 QPS 单用户频控与免费版 10,000 次/月总额度约束）
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { MsgDedupRing } from "./qq-official-client.js";

const DEFAULT_API_BASE = "https://open.feishu.cn/open-apis";
const DEFAULT_WS_ENDPOINT = "https://open.feishu.cn/callback/ws/endpoint";

// ── 轻量 pbbp2 Protobuf Frame 编解码 ────────────────────────────────────────

function encodeVarint(val) {
  let v = typeof val === "bigint" ? val : BigInt(Math.max(0, Math.trunc(Number(val) || 0)));
  const out = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, nextOffset: pos };
    shift += 7n;
    if (shift > 70n) throw new Error("Protobuf varint overflow");
  }
  throw new Error("Truncated protobuf varint");
}

function encodeFieldBytes(fieldNum, rawBuf, allowEmpty = false) {
  if (!rawBuf || (!allowEmpty && rawBuf.length === 0)) return Buffer.alloc(0);
  const tag = encodeVarint((fieldNum << 3) | 2);
  const len = encodeVarint(rawBuf.length);
  return Buffer.concat([tag, len, rawBuf]);
}

function encodeFieldVarint(fieldNum, value, emitZero = false) {
  const bv = typeof value === "bigint" ? value : BigInt(Math.max(0, Math.trunc(Number(value) || 0)));
  if (bv === 0n && !emitZero) return Buffer.alloc(0);
  return Buffer.concat([encodeVarint((fieldNum << 3) | 0), encodeVarint(bv)]);
}

function encodeHeader(key, value) {
  return Buffer.concat([
    encodeFieldBytes(1, Buffer.from(String(key ?? ""), "utf8"), true),
    encodeFieldBytes(2, Buffer.from(String(value ?? ""), "utf8"), true),
  ]);
}

function decodeHeader(buf) {
  let pos = 0;
  let key = "";
  let value = "";
  while (pos < buf.length) {
    const tagRes = decodeVarint(buf, pos);
    pos = tagRes.nextOffset;
    const tag = Number(tagRes.value);
    const fn = tag >> 3;
    const wt = tag & 7;
    if (wt === 2) {
      const lenRes = decodeVarint(buf, pos);
      const len = Number(lenRes.value);
      pos = lenRes.nextOffset;
      const slice = buf.subarray(pos, pos + len);
      pos += len;
      if (fn === 1) key = slice.toString("utf8");
      else if (fn === 2) value = slice.toString("utf8");
    } else if (wt === 0) {
      pos = decodeVarint(buf, pos).nextOffset;
    } else {
      break;
    }
  }
  return { key, value };
}

export function encodePbFrame({
  seqId = 0,
  logId = 0,
  service = 0,
  method = 0,
  headers = [],
  payloadEncoding = "",
  payloadType = "",
  payload = null,
} = {}) {
  const parts = [
    encodeFieldVarint(1, seqId, true),
    encodeFieldVarint(2, logId, true),
    encodeFieldVarint(3, service, true),
    encodeFieldVarint(4, method, true),
  ];
  for (const h of Array.isArray(headers) ? headers : []) {
    const hb = encodeHeader(h?.key, h?.value);
    if (hb.length) parts.push(encodeFieldBytes(5, hb));
  }
  if (payloadEncoding) parts.push(encodeFieldBytes(6, Buffer.from(String(payloadEncoding), "utf8")));
  if (payloadType) parts.push(encodeFieldBytes(7, Buffer.from(String(payloadType), "utf8")));
  if (payload !== null && payload !== undefined) {
    const pbuf = Buffer.isBuffer(payload)
      ? payload
      : payload instanceof Uint8Array
        ? Buffer.from(payload)
        : Buffer.from(String(payload), "utf8");
    if (pbuf.length) parts.push(encodeFieldBytes(8, pbuf));
  }
  return Buffer.concat(parts);
}

export function decodePbFrame(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  let pos = 0;
  const frame = {
    seqId: 0n,
    logId: 0n,
    service: 0,
    method: 0,
    headers: [],
    payloadEncoding: "",
    payloadType: "",
    payload: Buffer.alloc(0),
  };
  while (pos < buf.length) {
    const tagRes = decodeVarint(buf, pos);
    pos = tagRes.nextOffset;
    const tag = Number(tagRes.value);
    const fn = tag >> 3;
    const wt = tag & 7;
    if (wt === 0) {
      const vRes = decodeVarint(buf, pos);
      pos = vRes.nextOffset;
      if (fn === 1) frame.seqId = vRes.value;
      else if (fn === 2) frame.logId = vRes.value;
      else if (fn === 3) frame.service = Number(vRes.value);
      else if (fn === 4) frame.method = Number(vRes.value);
    } else if (wt === 2) {
      const lenRes = decodeVarint(buf, pos);
      const len = Number(lenRes.value);
      pos = lenRes.nextOffset;
      const slice = buf.subarray(pos, pos + len);
      pos += len;
      if (fn === 5) frame.headers.push(decodeHeader(slice));
      else if (fn === 6) frame.payloadEncoding = slice.toString("utf8");
      else if (fn === 7) frame.payloadType = slice.toString("utf8");
      else if (fn === 8) frame.payload = Buffer.from(slice);
    } else if (wt === 5) {
      pos += 4;
    } else if (wt === 1) {
      pos += 8;
    } else {
      break;
    }
  }
  return frame;
}

function getHeader(headers, name) {
  const found = (headers || []).find((h) => h?.key === name);
  return found ? String(found.value ?? "") : "";
}

function sniffMimeFromExtOrHeader(src, headerMime = "") {
  const ct = String(headerMime || "").split(";")[0].trim().toLowerCase();
  if (ct.startsWith("image/")) return ct;
  const clean = String(src || "").split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".bmp")) return "image/bmp";
  return "image/jpeg";
}

function sanitizeInboundText(raw = "") {
  return String(raw || "")
    .replace(/@_user_\d+/g, "")
    .replace(/\u200b/g, "")
    .trim();
}

export class FeishuClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.appId = String(opts.appId || "").trim();
    this.appSecret = String(opts.appSecret || opts.clientSecret || "").trim();
    this.ownerOpenId = String(opts.ownerOpenId || "").trim();
    this.allowOpenIds = Array.isArray(opts.allowOpenIds) ? opts.allowOpenIds.map(String) : [];
    this.autoPairFirst = opts.autoPairFirst !== false;
    this.onPaired = typeof opts.onPaired === "function" ? opts.onPaired : null;
    this.apiBaseUrl = String(opts.apiBaseUrl || DEFAULT_API_BASE).replace(/\/+$/, "");
    this.wsEndpointUrl = String(opts.wsEndpointUrl || DEFAULT_WS_ENDPOINT).trim();
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.WSImpl = opts.WSImpl || globalThis.WebSocket;
    this.now = typeof opts.now === "function" ? opts.now : () => Date.now();
    this.log = opts.log;

    this.capabilities = { unlimitedProactive: true, channelName: "feishu" };
    this.ledger = null;
    this.dedup = new MsgDedupRing(500);
    this.history = new Map();
    this.messageHandlers = new Set();
    this.fragCache = new Map();

    this.token = "";
    this.tokenExpiresAt = 0;
    this.ws = null;
    this.hbTimer = null;
    this.retryTimer = null;
    this.pingIntervalMs = 120_000;
    this.serviceId = 0;
    this.seq = 1n;
    this.closedByUser = false;
    this.connected = false;
    this.retryMs = 2000;
    this.lastPongAt = 0;
    this.framesReceived = 0;
    this.dataFramesReceived = 0;
    this.lastEventAt = 0;
    this.lastEventType = "";
    this.lastEventSummary = "";
  }

  isAllowedOpenId(openId) {
    const id = String(openId || "").trim();
    if (!id) return false;
    if (this.ownerOpenId && id === this.ownerOpenId) return true;
    if (this.allowOpenIds.includes(id) || this.allowOpenIds.includes("*")) return true;
    return false;
  }

  setOwnerOpenId(ownerOpenId = "") {
    this.ownerOpenId = String(ownerOpenId || "").trim();
  }

  #tryPairFirst(openId) {
    if (this.ownerOpenId || !this.autoPairFirst || !openId) return false;
    this.ownerOpenId = openId;
    this.log?.info?.(`[feishu] 收到首条激活消息，自动绑定主人 open_id=${openId}`);
    try {
      this.onPaired?.(openId);
    } catch {}
    return true;
  }

  async getTenantAccessToken() {
    const t = this.now();
    if (this.token && t < this.tokenExpiresAt) return this.token;
    if (!this.appId || !this.appSecret) {
      throw new Error("飞书 Bot 缺少 AppID 或 AppSecret");
    }
    const res = await this.fetchImpl(`${this.apiBaseUrl}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {}
    if (!res.ok || (data.code !== undefined && data.code !== 0) || !data.tenant_access_token) {
      throw new Error(`Feishu auth HTTP ${res.status} code=${data.code}: ${data.msg || text.slice(0, 200)}`);
    }
    const ttl = Math.max(120, Number(data.expire) || 7200) - 60;
    this.token = data.tenant_access_token;
    this.tokenExpiresAt = t + ttl * 1000;
    return this.token;
  }

  async apiJson(method, apiPath, payload) {
    const tok = await this.getTenantAccessToken();
    const res = await this.fetchImpl(`${this.apiBaseUrl}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${tok}`,
        ...(payload !== undefined ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const raw = await res.text();
    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = { raw };
    }
    if (!res.ok || (parsed?.code !== undefined && parsed.code !== 0)) {
      const resetSec = res.headers?.get?.("x-ogw-ratelimit-reset");
      const extra = resetSec ? ` (retry after ${resetSec}s)` : "";
      throw new Error(`Feishu API ${method} ${apiPath} HTTP ${res.status} code=${parsed?.code ?? "?"}: ${parsed?.msg || raw.slice(0, 240)}${extra}`);
    }
    return parsed;
  }

  on(event, handler) {
    super.on(event, handler);
    return () => {
      this.off(event, handler);
    };
  }

  onMessage(handler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  async connect() {
    this.closedByUser = false;
    if (!this.appId || !this.appSecret) {
      this.log?.warn?.("[feishu] 未配置 AppID/AppSecret，跳过长连接");
      return;
    }
    await this.#openGateway();
  }

  async #negotiateWsEndpoint() {
    const res = await this.fetchImpl(this.wsEndpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        locale: "zh",
      },
      body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret }),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {}
    if (!res.ok || (data.code !== undefined && data.code !== 0) || !data?.data?.URL) {
      throw new Error(`Feishu ws endpoint HTTP ${res.status} code=${data.code ?? "?"}: ${data.msg || text.slice(0, 200)}`);
    }
    const wsUrl = String(data.data.URL);
    const clientCfg = data.data.ClientConfig || {};
    const pingSec = Number(clientCfg.PingInterval);
    if (Number.isFinite(pingSec) && pingSec >= 10) {
      this.pingIntervalMs = Math.round(pingSec * 1000);
    }
    let serviceId = 0;
    try {
      serviceId = Number(new URL(wsUrl).searchParams.get("service_id")) || 0;
    } catch {}
    return { wsUrl, serviceId };
  }

  #sendPing(sock) {
    if (!sock || sock.readyState !== 1) return;
    const frame = encodePbFrame({
      seqId: this.seq++,
      logId: 0,
      service: this.serviceId,
      method: 0,
      headers: [{ key: "type", value: "ping" }],
    });
    sock.send(frame);
  }

  #startHeartbeat(sock) {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      this.#sendPing(sock);
    }, Math.max(10_000, this.pingIntervalMs));
    this.hbTimer.unref?.();
  }

  async #openGateway() {
    if (this.closedByUser) return;
    const { wsUrl, serviceId } = await this.#negotiateWsEndpoint();
    this.serviceId = serviceId;
    const sock = new this.WSImpl(wsUrl);
    try {
      sock.binaryType = "arraybuffer";
    } catch {}
    this.ws = sock;

    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve();
      };
      sock.onopen = () => {
        this.connected = true;
        this.retryMs = 2000;
        this.#sendPing(sock);
        this.#startHeartbeat(sock);
        this.log?.info?.(`[feishu] WebSocket 已建立，已发送 proto2 ping 握手 (serviceId=${this.serviceId})`);
        this.emit("open");
        done();
      };
      sock.onerror = (ev) => {
        const err = ev?.error || new Error("Feishu WebSocket error");
        this.emit("error", err);
        done(err);
      };
      sock.onclose = (ev) => {
        if (this.hbTimer) clearInterval(this.hbTimer);
        this.hbTimer = null;
        this.connected = false;
        this.emit("close", { code: ev?.code, reason: ev?.reason });
        if (!this.closedByUser) this.#scheduleReconnect();
      };
      sock.onmessage = async (ev) => {
        let rawBuf;
        try {
          if (ev.data instanceof ArrayBuffer) rawBuf = Buffer.from(ev.data);
          else if (ArrayBuffer.isView(ev.data)) rawBuf = Buffer.from(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
          else if (typeof Blob !== "undefined" && ev.data instanceof Blob) rawBuf = Buffer.from(await ev.data.arrayBuffer());
          else rawBuf = Buffer.from(String(ev.data || ""), "utf8");
        } catch {
          return;
        }
        await this.#handleIncomingFrame(sock, rawBuf);
      };
    });
  }

  #scheduleReconnect() {
    if (this.closedByUser || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
      this.#openGateway().catch((err) => {
        this.emit("error", err);
        this.#scheduleReconnect();
      });
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  async #handleIncomingFrame(sock, rawBuf) {
    let frame;
    try {
      frame = decodePbFrame(rawBuf);
    } catch (err) {
      this.log?.warn?.(`[feishu] 解码帧失败: ${String(err)}`);
      return;
    }

    const msgType = getHeader(frame.headers, "type");
    if (frame.method === 0) {
      if (msgType === "pong") {
        this.lastPongAt = this.now();
        if (frame.payload?.length) {
          try {
            const cfg = JSON.parse(frame.payload.toString("utf8"));
            const nextPingSec = Number(cfg?.PingInterval);
            if (Number.isFinite(nextPingSec) && nextPingSec >= 10) {
              const nextMs = Math.round(nextPingSec * 1000);
              if (nextMs !== this.pingIntervalMs) {
                this.pingIntervalMs = nextMs;
                this.#startHeartbeat(sock);
              }
            }
            this.log?.info?.(`[feishu] 长连接 pong 握手确认成功 (PingInterval=${cfg?.PingInterval ?? "?"}s)`);
            this.emit("pong", cfg);
          } catch {}
        } else {
          this.emit("pong", null);
        }
      }
      return;
    }

    if (frame.method !== 1) return;
    this.framesReceived += 1;
    this.dataFramesReceived += 1;
    const tStart = this.now();

    let payloadBuf = frame.payload;
    if (frame.payloadEncoding === "gzip" && payloadBuf?.length) {
      try {
        payloadBuf = zlib.gunzipSync(payloadBuf);
      } catch {}
    }

    const sum = Number(getHeader(frame.headers, "sum") || 1);
    const seq = Number(getHeader(frame.headers, "seq") || 0);
    const fragId = getHeader(frame.headers, "message_id");
    if (sum > 1 && fragId) {
      let bucket = this.fragCache.get(fragId);
      if (!bucket) {
        bucket = { total: sum, parts: new Map(), ts: this.now() };
        this.fragCache.set(fragId, bucket);
      }
      if (!bucket.parts.has(seq)) {
        bucket.parts.set(seq, payloadBuf);
      }
      if (bucket.parts.size < bucket.total) {
        return;
      }
      this.fragCache.delete(fragId);
      const ordered = [...bucket.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
      payloadBuf = Buffer.concat(ordered);
    }

    // 必须在 3 秒内立刻返回 ACK，避免飞书重复投递
    try {
      const ackHeaders = [
        ...frame.headers.filter((h) => h?.key !== "biz_rt"),
        { key: "biz_rt", value: String(Math.max(0, this.now() - tStart)) },
      ];
      const ackFrame = encodePbFrame({
        seqId: frame.seqId,
        logId: frame.logId,
        service: frame.service,
        method: 1,
        headers: ackHeaders,
        payloadType: frame.payloadType,
        payload: Buffer.from(JSON.stringify({ code: 200 }), "utf8"),
      });
      if (sock?.readyState === 1) sock.send(ackFrame);
    } catch {}

    if (msgType && msgType.toLowerCase() !== "event") {
      this.lastEventType = `non-event:${msgType}`;
      return;
    }
    let body = null;
    try {
      body = payloadBuf?.length ? JSON.parse(payloadBuf.toString("utf8")) : null;
    } catch (e) {
      this.lastEventType = "parse-error";
      this.lastEventSummary = String(e?.message || e);
      return;
    }
    const eventType = body?.header?.event_type || (body?.type === "event_callback" ? body?.event?.type : "") || "";
    this.lastEventAt = this.now();
    this.lastEventType = eventType || "unknown";
    this.lastEventSummary = `chat=${body?.event?.message?.chat_type || "?"} msgType=${body?.event?.message?.message_type || "?"} sender=${body?.event?.sender?.sender_type || "?"}`;
    this.log?.info?.(`[feishu] 收到长连接事件 type=${this.lastEventType} (${this.lastEventSummary})`);
    if (eventType === "im.message.receive_v1") {
      // 异步处理消息和图片下载，绝不阻塞 ACK 返回
      void this.#handleReceiveEvent(body).catch((err) => {
        this.lastEventSummary = `err:${String(err)}`;
        this.log?.warn?.(`[feishu] 处理接收消息失败: ${String(err)}`);
      });
    } else if (body?.type === "event_callback" && body?.event?.type === "message") {
      const v1 = body.event;
      const adapted = {
        header: { event_id: body.uuid || v1.open_message_id || String(this.now()), event_type: "im.message.receive_v1" },
        event: {
          sender: { sender_id: { open_id: v1.open_id }, sender_type: "user" },
          message: {
            message_id: v1.open_message_id || String(this.now()),
            chat_type: v1.chat_type === "private" ? "p2p" : (v1.chat_type || "p2p"),
            message_type: v1.msg_type || "text",
            content: JSON.stringify({ text: v1.text_without_at_bot ?? v1.text ?? "" }),
          },
        },
      };
      void this.#handleReceiveEvent(adapted).catch((err) => {
        this.lastEventSummary = `v1err:${String(err)}`;
        this.log?.warn?.(`[feishu] 处理 v1 消息失败: ${String(err)}`);
      });
    }
  }

  async #downloadInboundImageDataUrl(messageId, resourceKey, resourceType = "image") {
    const tok = await this.getTenantAccessToken();
    const url = `${this.apiBaseUrl}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resourceKey)}?type=${encodeURIComponent(resourceType)}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`下载飞书图片失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = sniffMimeFromExtOrHeader("", res.headers?.get?.("content-type"));
    return `data:${mime};base64,${buf.toString("base64")}`;
  }

  async #handleReceiveEvent(body) {
    const header = body?.header || {};
    const ev = body?.event || {};
    const sender = ev.sender || {};
    const msg = ev.message || {};

    if (sender.sender_type && sender.sender_type !== "user") return;
    const chatType = String(msg.chat_type || "");
    if (chatType && chatType !== "p2p") return;

    const msgId = String(msg.message_id || "").trim();
    const dedupKey = String(header.event_id || msgId || "").trim();
    if (this.dedup.seenOrAdd(dedupKey)) return;

    const openId = String(sender.sender_id?.open_id || sender.sender_id?.user_id || sender.sender_id?.union_id || "").trim();
    if (!openId) return;

    this.#tryPairFirst(openId);
    if (!this.isAllowedOpenId(openId)) {
      this.log?.info?.(`[feishu] 忽略非白名单单聊 open_id=${openId}`);
      return;
    }

    let parsedContent = {};
    try {
      parsedContent = typeof msg.content === "string" && msg.content.trim() ? JSON.parse(msg.content) : msg.content || {};
    } catch {
      parsedContent = { text: String(msg.content || "") };
    }

    const msgType = String(msg.message_type || "text");
    const segments = [];
    const textPieces = [];
    const imageKeys = [];

    if (msgType === "text") {
      const txt = sanitizeInboundText(parsedContent.text || "");
      if (txt) {
        textPieces.push(txt);
        segments.push({ type: "text", data: { text: txt } });
      }
    } else if (msgType === "image") {
      if (parsedContent.image_key) imageKeys.push({ key: String(parsedContent.image_key), type: "image" });
    } else if (msgType === "sticker") {
      if (parsedContent.file_key) imageKeys.push({ key: String(parsedContent.file_key), type: "file" });
    } else if (msgType === "post") {
      const contentRows = Array.isArray(parsedContent.content) ? parsedContent.content : [];
      if (parsedContent.title) textPieces.push(sanitizeInboundText(parsedContent.title));
      for (const row of contentRows) {
        for (const node of Array.isArray(row) ? row : []) {
          if (node?.tag === "text" && node.text) {
            const t = sanitizeInboundText(node.text);
            if (t) textPieces.push(t);
          } else if (node?.tag === "img" && node.image_key) {
            imageKeys.push({ key: String(node.image_key), type: "image" });
          }
        }
      }
      if (textPieces.length) {
        segments.push({ type: "text", data: { text: textPieces.join(" ").trim() } });
      }
    } else if (parsedContent?.text) {
      const txt = sanitizeInboundText(parsedContent.text);
      if (txt) {
        textPieces.push(txt);
        segments.push({ type: "text", data: { text: txt } });
      }
    }

    for (const item of imageKeys) {
      try {
        const dataUrl = await this.#downloadInboundImageDataUrl(msgId, item.key, item.type);
        segments.push({ type: "image", data: { url: dataUrl, file: `${item.key}.png` } });
      } catch (err) {
        if (item.type === "file") {
          try {
            const dataUrl2 = await this.#downloadInboundImageDataUrl(msgId, item.key, "image");
            segments.push({ type: "image", data: { url: dataUrl2, file: `${item.key}.png` } });
            continue;
          } catch {}
        }
        this.log?.warn?.(`[feishu] 拉取图片/表情包失败 (${item.key}): ${String(err)}`);
      }
    }

    if (!segments.length) return;
    const rawText = textPieces.join(" ").trim();
    const tsSec = Math.floor((Number(msg.create_time) || this.now()) / 1000);
    const event = {
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      channel: "feishu",
      self_id: this.appId || "feishu_bot",
      user_id: openId,
      message_id: msgId || dedupKey,
      time: tsSec,
      raw_message: rawText,
      message: segments,
      sender: { user_id: openId, nickname: "对方" },
    };
    this.#recordHistory(openId, event);
    for (const h of this.messageHandlers) {
      try {
        h(event);
      } catch (err) {
        this.log?.error?.(`[feishu] message handler error: ${String(err)}`);
      }
    }
  }

  #recordHistory(openId, entry) {
    const list = this.history.get(openId) || [];
    list.push(entry);
    if (list.length > 200) list.splice(0, list.length - 200);
    this.history.set(openId, list);
  }

  close() {
    this.closedByUser = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.hbTimer = null;
    this.retryTimer = null;
    this.connected = false;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  async getLoginInfo() {
    return { user_id: this.appId || "feishu_bot", nickname: "数字人飞书 Bot" };
  }

  async getFriendMessageHistory({ user_id, count = 20 }) {
    const list = this.history.get(String(user_id)) || [];
    return { messages: list.slice(-count) };
  }

  async uploadImage(mediaSource) {
    let buf;
    let mime = "image/png";
    let fileName = "image.png";

    if (typeof mediaSource === "string" && mediaSource.startsWith("data:")) {
      const m = /^data:([^;]+);base64,(.+)$/i.exec(mediaSource);
      if (!m) throw new Error("仅支持 base64 dataUrl");
      mime = sniffMimeFromExtOrHeader("", m[1]);
      buf = Buffer.from(m[2], "base64");
    } else if (typeof mediaSource === "string" && /^https?:\/\//i.test(mediaSource)) {
      const r = await this.fetchImpl(mediaSource);
      if (!r.ok) throw new Error(`拉取远端图片失败 HTTP ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
      mime = sniffMimeFromExtOrHeader(mediaSource, r.headers?.get?.("content-type"));
    } else if (typeof mediaSource === "string" && (mediaSource.startsWith("file://") || path.isAbsolute(mediaSource) || fs.existsSync(mediaSource))) {
      const localPath = mediaSource.startsWith("file://") ? fileURLToPath(mediaSource) : mediaSource;
      buf = await fsp.readFile(localPath);
      mime = sniffMimeFromExtOrHeader(localPath);
      fileName = path.basename(localPath) || fileName;
    } else {
      throw new Error("不支持的媒体来源");
    }

    if (!buf || buf.byteLength === 0 || buf.byteLength > 10 * 1024 * 1024) {
      throw new Error(`飞书图片体积异常: ${buf?.byteLength || 0} bytes (限制 <= 10MB)`);
    }

    const tok = await this.getTenantAccessToken();
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", new Blob([buf], { type: mime }), fileName);

    const res = await this.fetchImpl(`${this.apiBaseUrl}/im/v1/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}` },
      body: form,
    });
    const raw = await res.text();
    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {}
    if (!res.ok || (parsed?.code !== undefined && parsed.code !== 0) || !parsed?.data?.image_key) {
      throw new Error(`Feishu im/v1/images HTTP ${res.status} code=${parsed?.code ?? "?"}: ${parsed?.msg || raw.slice(0, 200)}`);
    }
    return String(parsed.data.image_key);
  }

  async sendPrivateMessage(userId, messageInput, _options = {}) {
    const openId = String(userId || this.ownerOpenId || "").trim();
    if (!openId) throw new Error("缺少飞书单聊 open_id");

    const segs = Array.isArray(messageInput)
      ? messageInput
      : typeof messageInput?.toSegments === "function"
        ? messageInput.toSegments()
        : typeof messageInput === "string"
          ? [{ type: "text", data: { text: messageInput } }]
          : [messageInput];

    const texts = [];
    const images = [];
    for (const s of segs) {
      if (s?.type === "text" && s.data?.text) texts.push(String(s.data.text));
      else if (s?.type === "image" && (s.data?.file || s.data?.url)) images.push(String(s.data.file || s.data.url));
    }

    let lastId = "";
    const content = texts.join("").trim();
    if (content) {
      const res = await this.apiJson("POST", "/im/v1/messages?receive_id_type=open_id", {
        receive_id: openId,
        msg_type: "text",
        content: JSON.stringify({ text: content }),
      });
      lastId = String(res?.data?.message_id || `feishu-out-${this.now()}`);
    }

    for (const imgSrc of images) {
      const imageKey = await this.uploadImage(imgSrc);
      const res = await this.apiJson("POST", "/im/v1/messages?receive_id_type=open_id", {
        receive_id: openId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      });
      lastId = String(res?.data?.message_id || `feishu-img-${this.now()}`);
    }

    this.#recordHistory(openId, {
      user_id: this.appId || "feishu_bot",
      message_id: lastId || `feishu-out-${this.now()}`,
      time: Math.floor(this.now() / 1000),
      message: segs,
      raw_message: content,
      sender: { user_id: this.appId || "feishu_bot", nickname: "我" },
    });
    return { message_id: lastId || `feishu-out-${this.now()}` };
  }
}

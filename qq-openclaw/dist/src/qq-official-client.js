/**
 * 合规 QQ 开放平台官方 Bot APIv2 客户端，替换 openclaw-snowluma 原生的 @snowluma/sdk (NTQQ) 入口。
 * 对外提供与 SnowLumaWebSocketClient 兼容的事件/发送契约：
 *   - 鉴权：POST /app/getAppAccessToken 自动缓存刷新
 *   - 网关：GET /gateway → Node 原生 WebSocket，Op 10/2/1/0/7/9，intents = 1 << 25
 *   - 范围：一期仅处理 C2C_MESSAGE_CREATE（单聊 + 多模态附件），支持 allowFrom/ownerOpenId 白名单
 *   - 窗口：60 分钟内最多 4 次被动回复（msg_id + 递增 msg_seq），超窗支持合规主动 is_wakeup 限额
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_AUTH_URL = "https://api.bot.qq.com/app/getAppAccessToken";
const DEFAULT_PROD_API = "https://api.sgroup.qq.com";
const DEFAULT_SANDBOX_API = "https://sandbox.api.sgroup.qq.com";
const INTENT_GROUP_AND_C2C = 1 << 25;
const C2C_PASSIVE_TTL_MS = 60 * 60_000;
const C2C_PASSIVE_MAX = 4;

const QQ_FACE_NAMES = {
  "0": "惊讶", "1": "撇嘴", "2": "色", "3": "发呆", "4": "得意", "5": "流泪",
  "6": "害羞", "7": "闭嘴", "8": "睡", "9": "大哭", "10": "尴尬",
  "11": "发怒", "12": "调皮", "13": "呲牙", "14": "微笑", "15": "难过",
  "18": "抓狂", "19": "吐", "20": "偷笑", "21": "可爱", "22": "白眼",
  "23": "傲慢", "25": "困", "26": "惊恐", "27": "流汗", "28": "憨笑",
  "29": "悠闲", "30": "奋斗", "31": "咒骂", "32": "疑问", "33": "嘘",
  "34": "晕", "36": "衰", "38": "敲打", "39": "再见", "49": "拥抱",
  "66": "爱心", "74": "太阳", "75": "月亮", "76": "赞", "77": "踩",
  "78": "握手", "79": "胜利", "99": "鼓掌", "100": "糗大了", "101": "坏笑",
  "104": "委屈", "105": "快哭了", "106": "阴险", "107": "亲亲", "109": "可怜",
  "146": "爆筋", "175": "卖萌", "179": "doge", "182": "笑哭",
  "277": "汪汪", "285": "摸鱼", "319": "比心",
};
const QQ_FACE_SHORTCUTS = new Set([...Object.values(QQ_FACE_NAMES), "晚安", "哈哈", "抱抱", "贴贴", "无语", "翻白眼", "玫瑰"]);

function decodeQqFaceExtText(extB64) {
  if (!extB64) return "";
  try {
    const parsed = JSON.parse(Buffer.from(String(extB64), "base64").toString("utf8"));
    return String(parsed?.text || "").replace(/^\/+/, "").trim();
  } catch {
    return "";
  }
}

/**
 * 将 QQ 官方消息里的内置表情标签（<faceType=...> / <emoji:ID>）与系统表情口令（如 /睡）
 * 规整为可读的 [QQ表情:睡]，避免被当成斜杠命令或漏解析成杂音。
 */
export function normalizeQqInboundContent(raw) {
  if (typeof raw !== "string") return "";
  let out = raw.trim();
  if (!out) return "";
  out = out.replace(/<faceType=[^>]*>/gi, (tag) => {
    const idMatch = /faceId="?(\d+)"?/i.exec(tag);
    const extMatch = /ext="([^"]+)"/i.exec(tag);
    const label = decodeQqFaceExtText(extMatch?.[1]) || (idMatch?.[1] && QQ_FACE_NAMES[idMatch[1]]) || (idMatch?.[1] ? `#${idMatch[1]}` : "表情");
    return `[QQ表情:${label}]`;
  });
  out = out.replace(/<emoji:(\d+)>/gi, (_m, id) => `[QQ表情:${QQ_FACE_NAMES[id] || `#${id}`}]`);
  out = out.replace(/(^|\s)\/([^\s/]{1,12})(?=\s|$)/g, (m, lead, name) =>
    QQ_FACE_SHORTCUTS.has(name) ? `${lead}[QQ表情:${name}]` : m
  );
  return out.trim();
}

export class MsgDedupRing {
  constructor(capacity = 500) {
    this.cap = Math.max(10, capacity);
    this.order = [];
    this.seen = new Set();
  }
  seenOrAdd(id) {
    if (!id) return false;
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.order.push(id);
    while (this.order.length > this.cap) {
      const old = this.order.shift();
      if (old !== undefined) this.seen.delete(old);
    }
    return false;
  }
}

export class WindowLedger {
  constructor({ proactiveCooldownMin = 40, proactiveDailyMax = 6, stateFile = "", now = () => Date.now() } = {}) {
    /** @type {Map<string, Array<{ msgId: string, receivedAt: number, usedSeq: number }>>} */
    this.passive = new Map();
    this.cooldownMs = Math.max(1, proactiveCooldownMin) * 60_000;
    this.dailyMax = Math.max(1, proactiveDailyMax);
    this.stateFile = String(stateFile || "");
    this.now = now;
    this.day = "";
    this.proactiveCount = 0;
    this.lastProactiveAt = 0;
    this.#load();
  }

  #load() {
    if (!this.stateFile) return;
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      const t = this.now();
      this.day = String(raw?.day || "");
      this.proactiveCount = Number(raw?.proactiveCount) || 0;
      this.lastProactiveAt = Number(raw?.lastProactiveAt) || 0;
      if (raw?.passive && typeof raw.passive === "object") {
        for (const [openId, entries] of Object.entries(raw.passive)) {
          const valid = (Array.isArray(entries) ? entries : []).filter(
            (e) => e?.msgId && t - Number(e.receivedAt || 0) < C2C_PASSIVE_TTL_MS && Number(e.usedSeq || 0) < C2C_PASSIVE_MAX,
          );
          if (valid.length) this.passive.set(openId, valid);
        }
      }
    } catch {}
  }

  #save() {
    if (!this.stateFile) return;
    try {
      const t = this.now();
      const passiveObj = {};
      for (const [openId, list] of this.passive.entries()) {
        const valid = list.filter((e) => t - e.receivedAt < C2C_PASSIVE_TTL_MS && e.usedSeq < C2C_PASSIVE_MAX);
        if (valid.length) passiveObj[openId] = valid.slice(-20);
      }
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify({
          day: this.day,
          proactiveCount: this.proactiveCount,
          lastProactiveAt: this.lastProactiveAt,
          passive: passiveObj,
        }),
        "utf8",
      );
    } catch {}
  }

  recordInbound(openId, msgId) {
    if (!openId || !msgId) return;
    const t = this.now();
    const list = (this.passive.get(openId) || []).filter((e) => t - e.receivedAt < C2C_PASSIVE_TTL_MS);
    const existing = list.find((e) => e.msgId === msgId);
    if (!existing) {
      list.push({ msgId, receivedAt: t, usedSeq: 0 });
      if (list.length > 20) list.splice(0, list.length - 20);
    }
    this.passive.set(openId, list);
    this.#save();
  }

  claimPassive(openId, preferredMsgId) {
    const list = this.passive.get(openId);
    if (!list?.length) return null;
    const t = this.now();
    let ent = null;
    if (preferredMsgId) {
      ent = list.find((e) => e.msgId === preferredMsgId && t - e.receivedAt < C2C_PASSIVE_TTL_MS && e.usedSeq < C2C_PASSIVE_MAX) || null;
    }
    if (!ent && !preferredMsgId) {
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (t - e.receivedAt < C2C_PASSIVE_TTL_MS && e.usedSeq < C2C_PASSIVE_MAX) {
          ent = e;
          break;
        }
      }
    }
    if (!ent) return null;
    ent.usedSeq += 1;
    this.#save();
    return { msgId: ent.msgId, seq: ent.usedSeq };
  }

  canProactive() {
    const t = this.now();
    const d = new Date(t).toISOString().slice(0, 10);
    if (this.day !== d) {
      this.day = d;
      this.proactiveCount = 0;
    }
    if (this.proactiveCount >= this.dailyMax) return { ok: false, reason: "daily_cap" };
    if (this.lastProactiveAt > 0 && t - this.lastProactiveAt < this.cooldownMs) {
      return { ok: false, reason: "cooldown" };
    }
    return { ok: true };
  }

  recordProactive() {
    const t = this.now();
    const d = new Date(t).toISOString().slice(0, 10);
    if (this.day !== d) {
      this.day = d;
      this.proactiveCount = 0;
    }
    this.proactiveCount += 1;
    this.lastProactiveAt = t;
    this.#save();
  }

  snapshot(openId) {
    const list = openId ? this.passive.get(openId) : null;
    if (!list?.length) return { active: false, remainingSeq: 0, expiresAt: 0 };
    const t = this.now();
    for (let i = list.length - 1; i >= 0; i--) {
      const ent = list[i];
      const expiresAt = ent.receivedAt + C2C_PASSIVE_TTL_MS;
      if (expiresAt > t && ent.usedSeq < C2C_PASSIVE_MAX) {
        return { active: true, remainingSeq: C2C_PASSIVE_MAX - ent.usedSeq, expiresAt };
      }
    }
    return { active: false, remainingSeq: 0, expiresAt: 0 };
  }
}

export class QQOfficialClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.appId = String(opts.appId || "").trim();
    this.clientSecret = String(opts.clientSecret || "").trim();
    this.sandbox = opts.sandbox !== false;
    this.authUrl = opts.authUrl || DEFAULT_AUTH_URL;
    this.apiBaseUrl = (opts.apiBaseUrl || (this.sandbox ? DEFAULT_SANDBOX_API : DEFAULT_PROD_API)).replace(/\/+$/, "");
    this.ownerOpenId = String(opts.ownerOpenId || "").trim();
    this.allowOpenIds = Array.isArray(opts.allowOpenIds) ? opts.allowOpenIds.map((x) => String(x).trim()).filter(Boolean) : [];
    this.autoPairFirst = opts.autoPairFirst !== false;
    this.onPaired = typeof opts.onPaired === "function" ? opts.onPaired : null;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.WSImpl = opts.WSImpl || globalThis.WebSocket;
    this.log = opts.log;
    this.ledger = new WindowLedger({
      proactiveCooldownMin: opts.proactiveCooldownMin ?? 40,
      proactiveDailyMax: opts.proactiveDailyMax ?? 6,
      stateFile: opts.ledgerStateFile || "",
      now: opts.now,
    });
    this.dedup = new MsgDedupRing(500);
    this.history = new Map(); // openId -> history entries
    this.messageHandlers = new Set();
    this.token = "";
    this.tokenExpiresAt = 0;
    this.ws = null;
    this.hbTimer = null;
    this.retryTimer = null;
    this.closedByUser = false;
    this.connected = false;
    this.retryMs = 2000;
    this.seq = null;
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
    this.log?.info?.(`[qq-official] 收到首条激活消息，自动绑定主人 openId=${openId}`);
    try {
      this.onPaired?.(openId);
    } catch {}
    return true;
  }

  async getAccessToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt) return this.token;
    if (!this.appId || !this.clientSecret) {
      throw new Error("QQ Bot 缺少 appId 或 clientSecret");
    }
    const res = await this.fetchImpl(this.authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`getAppAccessToken HTTP ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    if (!data?.access_token) throw new Error("getAppAccessToken 缺少 access_token");
    const ttl = Math.max(120, Number(data.expires_in) || 7200) - 60;
    this.token = data.access_token;
    this.tokenExpiresAt = now + ttl * 1000;
    return this.token;
  }

  async apiJson(method, path, payload) {
    const tok = await this.getAccessToken();
    const res = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${tok}`,
        ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`QQ API ${method} ${path} HTTP ${res.status}: ${raw.slice(0, 240)}`);
    }
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return { raw };
    }
  }

  onMessage(handler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  async connect() {
    this.closedByUser = false;
    if (!this.appId || !this.clientSecret) {
      this.log?.warn?.("[qq-official] 未配置 appId/clientSecret，跳过 Gateway 连接（仅本地调试）");
      return;
    }
    await this.#openGateway();
  }

  async #openGateway() {
    if (this.closedByUser) return;
    const gw = await this.apiJson("GET", "/gateway");
    if (!gw?.url) throw new Error("GET /gateway 缺少 url");
    const tok = await this.getAccessToken();
    const sock = new this.WSImpl(gw.url);
    this.ws = sock;

    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve();
      };
      sock.onerror = (ev) => {
        const err = ev?.error || new Error("QQ Gateway WebSocket error");
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
        let pkt;
        try {
          pkt = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
          return;
        }
        if (pkt.s != null) this.seq = pkt.s;
        if (pkt.op === 10) {
          const hbMs = Math.max(5000, Number(pkt.d?.heartbeat_interval) || 30000);
          sock.send(
            JSON.stringify({
              op: 2,
              d: { token: `QQBot ${tok}`, intents: INTENT_GROUP_AND_C2C, shard: [0, 1] },
            }),
          );
          if (this.hbTimer) clearInterval(this.hbTimer);
          this.hbTimer = setInterval(() => {
            if (sock.readyState === 1) sock.send(JSON.stringify({ op: 1, d: this.seq }));
          }, hbMs);
          this.hbTimer.unref?.();
          return;
        }
        if (pkt.op === 0 && pkt.t === "READY") {
          this.connected = true;
          this.retryMs = 2000;
          this.emit("open");
          done();
          return;
        }
        if (pkt.op === 0 && pkt.t === "C2C_MESSAGE_CREATE") {
          this.#handleC2CInbound(pkt.d);
          return;
        }
        if (pkt.op === 7 || pkt.op === 9) {
          sock.close();
        }
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

  #handleC2CInbound(d) {
    if (!d) return;
    const msgId = String(d.id || "").trim();
    if (this.dedup.seenOrAdd(msgId)) return;
    const openId = String(d.author?.user_openid || d.author?.union_openid || "").trim();
    const text = normalizeQqInboundContent(typeof d.content === "string" ? d.content : "");
    this.#tryPairFirst(openId);
    if (!this.isAllowedOpenId(openId)) {
      this.log?.info?.(`[qq-official] 忽略非白名单单聊 openId=${openId}`);
      return;
    }
    this.ledger.recordInbound(openId, msgId);
    const segments = [];
    if (text) segments.push({ type: "text", data: { text } });
    for (const att of Array.isArray(d.attachments) ? d.attachments : []) {
      const ct = String(att?.content_type || "").toLowerCase();
      const rawUrl = String(att?.url || "").trim();
      const attUrl = rawUrl
        ? rawUrl.startsWith("//")
          ? `https:${rawUrl}`
          : /^https?:\/\//i.test(rawUrl)
            ? rawUrl
            : `https://${rawUrl}`
        : "";
      if (ct.startsWith("image/") && attUrl) {
        segments.push({
          type: "image",
          data: { url: attUrl, content_type: att.content_type, filename: att.filename },
        });
      } else if ((ct.startsWith("audio/") || ct.includes("silk") || ct.includes("amr")) && attUrl) {
        segments.push({ type: "record", data: { url: attUrl, filename: att.filename } });
      } else if (attUrl || att?.filename) {
        segments.push({ type: "file", data: { url: attUrl, name: att.filename } });
      }
    }
    const tsSec = d.timestamp ? Math.floor(Date.parse(d.timestamp) / 1000) || Math.floor(Date.now() / 1000) : Math.floor(Date.now() / 1000);
    const event = {
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      self_id: this.appId || "qqbot",
      user_id: openId,
      message_id: msgId,
      time: tsSec,
      raw_message: text,
      message: segments,
      sender: { user_id: openId, nickname: "对方" },
    };
    this.#recordHistory(openId, event);
    for (const h of this.messageHandlers) {
      try {
        h(event);
      } catch (err) {
        this.log?.error?.(`[qq-official] message handler error: ${String(err)}`);
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
    return { user_id: this.appId || "qqbot", nickname: "数字人QQ Bot" };
  }

  async getFriendMessageHistory({ user_id, count = 20 }) {
    const list = this.history.get(String(user_id)) || [];
    return { messages: list.slice(-count) };
  }

  async uploadC2CImage(openId, mediaSource) {
    const payload = { file_type: 1, srv_send_msg: false };
    if (typeof mediaSource === "string" && mediaSource.startsWith("data:")) {
      const idx = mediaSource.indexOf(";base64,");
      if (idx < 0) throw new Error("仅支持 base64 dataUrl");
      payload.file_data = mediaSource.slice(idx + ";base64,".length);
    } else if (typeof mediaSource === "string" && /^https?:\/\//i.test(mediaSource)) {
      payload.url = mediaSource;
    } else if (typeof mediaSource === "string" && (mediaSource.startsWith("file://") || path.isAbsolute(mediaSource) || fs.existsSync(mediaSource))) {
      const localPath = mediaSource.startsWith("file://") ? fileURLToPath(mediaSource) : mediaSource;
      const buf = await fsp.readFile(localPath);
      if (buf.byteLength === 0 || buf.byteLength > 8 * 1024 * 1024) {
        throw new Error(`本地图片体积异常: ${buf.byteLength} bytes`);
      }
      payload.file_data = buf.toString("base64");
    } else {
      throw new Error("不支持的媒体来源");
    }
    const res = await this.apiJson("POST", `/v2/users/${encodeURIComponent(openId)}/files`, payload);
    if (!res?.file_info) throw new Error("上传图片未返回 file_info");
    return res.file_info;
  }

  async sendPrivateMessage(userId, messageInput, options = {}) {
    const openId = String(userId || this.ownerOpenId || "").trim();
    if (!openId) throw new Error("缺少单聊 openId");

    const segs = Array.isArray(messageInput)
      ? messageInput
      : typeof messageInput?.toSegments === "function"
        ? messageInput.toSegments()
        : typeof messageInput === "string"
          ? [{ type: "text", data: { text: messageInput } }]
          : [messageInput];

    const texts = [];
    const images = [];
    let chainReplyId = "";
    for (const s of segs) {
      if (s?.type === "text" && s.data?.text) texts.push(String(s.data.text));
      else if (s?.type === "image" && (s.data?.file || s.data?.url)) images.push(String(s.data.file || s.data.url));
      else if (s?.type === "reply" && s.data?.id && !chainReplyId) chainReplyId = String(s.data.id);
    }

    const preferredMsgId = options.replyToId ? String(options.replyToId) : chainReplyId || undefined;
    let claim = this.ledger.claimPassive(openId, preferredMsgId);
    const isProactive = !!options.proactive;
    if (!claim) {
      if (!isProactive) {
        throw new Error("单聊被动回复窗口已过期或超过 4 条上限");
      }
      const gate = this.ledger.canProactive();
      if (!gate.ok) {
        throw new Error(`主动消息受限: ${gate.reason}`);
      }
    }

    let lastId = "";
    const content = texts.join("").trim();
    if (content) {
      const body = { content, msg_type: 0 };
      if (claim) {
        body.msg_id = claim.msgId;
        body.msg_seq = claim.seq;
        const res = await this.apiJson("POST", `/v2/users/${encodeURIComponent(openId)}/messages`, body);
        lastId = String(res?.id || `out-${Date.now()}`);
      } else if (options.isWakeup) {
        // 先尝试带 is_wakeup:true 的互动召回；若当日周期额度用完或沙箱不支持，自动降级普通主动通道再试一次
        try {
          const res = await this.apiJson("POST", `/v2/users/${encodeURIComponent(openId)}/messages`, {
            ...body,
            is_wakeup: true,
          });
          lastId = String(res?.id || `out-${Date.now()}`);
        } catch (wakeupErr) {
          try {
            const res2 = await this.apiJson("POST", `/v2/users/${encodeURIComponent(openId)}/messages`, body);
            lastId = String(res2?.id || `out-${Date.now()}`);
          } catch (plainErr) {
            throw new Error(`互动召回失败(${wakeupErr.message})；普通主动也失败(${plainErr.message})`);
          }
        }
      } else {
        const res = await this.apiJson("POST", `/v2/users/${encodeURIComponent(openId)}/messages`, body);
        lastId = String(res?.id || `out-${Date.now()}`);
      }
    }

    for (const imgSrc of images) {
      if (content && claim) {
        claim = this.ledger.claimPassive(openId, claim.msgId);
        if (!claim && !isProactive) break;
      }
      const fileInfo = await this.uploadC2CImage(openId, imgSrc);
      const body = { msg_type: 7, media: { file_info: fileInfo } };
      if (claim) {
        body.msg_id = claim.msgId;
        body.msg_seq = claim.seq;
      }
      const res = await this.apiJson("POST", `/v2/users/${encodeURIComponent(openId)}/messages`, body);
      lastId = String(res?.id || `out-img-${Date.now()}`);
    }

    if (!claim && isProactive) {
      this.ledger.recordProactive();
    }
    this.#recordHistory(openId, {
      user_id: this.appId || "qqbot",
      message_id: lastId || `out-${Date.now()}`,
      time: Math.floor(Date.now() / 1000),
      message: segs,
      raw_message: content,
      sender: { user_id: this.appId || "qqbot", nickname: "我" },
    });
    return { message_id: lastId || `out-${Date.now()}` };
  }
}

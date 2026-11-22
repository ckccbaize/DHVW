/**
 * DHVW ARM 可选服务入口（魔改自 openclaw-snowluma）：
 * - 读取 /etc/dhvw/qqbot.json（或 -config 参数）；enabled !== true 时直接以 0 退出（0 内存开销）。
 * - 启动 openclaw-snowluma 的 startGateway（底层已替换为合规 QQ Bot APIv2 单聊客户端）。
 * - 在 127.0.0.1:8088 暴露轻量回环桥接 ws://127.0.0.1:8088/qq/ws 与 /__qq/health，
 *   与 arm/www/js/app.js 同步世界状态、PC 向量记忆检索、心情反馈与端侧图像共享。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { resolveSnowLumaAccount } from "./src/config.js";
import { startGateway } from "./src/gateway.js";
import { createDhvwRuntime } from "./src/dhvw-runtime.js";
import { createProactiveRunner } from "./src/dhvw-proactive.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeWsText(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let hdr;
  if (len <= 125) {
    hdr = Buffer.from([0x81, len]);
  } else if (len <= 65535) {
    hdr = Buffer.alloc(4);
    hdr[0] = 0x81;
    hdr[1] = 126;
    hdr.writeUInt16BE(len, 2);
  } else {
    hdr = Buffer.alloc(10);
    hdr[0] = 0x81;
    hdr[1] = 127;
    hdr.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([hdr, payload]);
}

function attachWsClient(req, socket, onMessage, onClose) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buf = Buffer.alloc(0);
  let fragChunks = [];
  let fragOp = 0;
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      const need = offset + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(offset + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }
      buf = buf.subarray(need);
      if (op === 0x8) {
        socket.end();
        return;
      }
      if (op === 0x9) {
        socket.write(Buffer.from([0x8a, 0x00]));
        continue;
      }
      if (op === 0xa) {
        continue;
      }
      if (op === 0x1 || op === 0x2) {
        fragChunks = [payload];
        fragOp = op;
      } else if (op === 0x0 && fragOp) {
        fragChunks.push(payload);
      } else {
        continue;
      }
      if (fin) {
        const fullBuf = fragChunks.length === 1 ? fragChunks[0] : Buffer.concat(fragChunks);
        const doneOp = fragOp;
        fragChunks = [];
        fragOp = 0;
        if (doneOp === 0x1) {
          try {
            onMessage(JSON.parse(fullBuf.toString("utf8")));
          } catch {}
        }
      }
    }
  });
  socket.on("close", onClose);
  socket.on("error", onClose);
  return {
    send(obj) {
      if (!socket.destroyed) socket.write(encodeWsText(JSON.stringify(obj)));
    },
    close() {
      if (!socket.destroyed) socket.end();
    },
  };
}

function parseArgs(argv) {
  let configPath = "/etc/dhvw/qqbot.json";
  let stateDir = "";
  let shellUrl = "";
  let followBoost = false;
  for (let i = 2; i < argv.length; i++) {
    if ((argv[i] === "-config" || argv[i] === "--config") && argv[i + 1]) {
      configPath = argv[++i];
    } else if ((argv[i] === "-stateDir" || argv[i] === "--stateDir") && argv[i + 1]) {
      stateDir = argv[++i];
    } else if ((argv[i] === "-shellUrl" || argv[i] === "--shellUrl") && argv[i + 1]) {
      shellUrl = argv[++i];
    } else if (argv[i] === "-followBoost" || argv[i] === "--followBoost") {
      followBoost = true;
    }
  }
  return { configPath, stateDir, shellUrl, followBoost };
}

function isLoopbackAddr(addr) {
  const host = addr.split(":")[0]?.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export async function startDhvwQqService(rawCfg, deps = {}) {
  const listenAddr = rawCfg.listenAddr || "127.0.0.1:8088";
  if (!isLoopbackAddr(listenAddr)) throw new Error(`拒绝监听非回环地址: ${listenAddr}`);
  const [host, portStr] = listenAddr.split(":");
  const port = Number(portStr) || 8088;

  const log = deps.log || {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
    debug: () => {},
  };

  const stateDir = rawCfg.stateDir || "/var/lib/dhvw/qq-openclaw";
  fs.mkdirSync(stateDir, { recursive: true });
  const llmCachePath = path.join(stateDir, "llm.json");
  const imageGenCachePath = path.join(stateDir, "imagegen.json");
  const personaCachePath = path.join(stateDir, "persona.json");
  const ref3dPath = path.join(stateDir, "character_ref_3d.png");
  const botConfigPath = path.join(stateDir, "bot-config.json");

  let cachedLlm = {};
  try {
    if (fs.existsSync(llmCachePath)) cachedLlm = JSON.parse(fs.readFileSync(llmCachePath, "utf8")) || {};
  } catch {}

  let imageGenConfig = {};
  try {
    if (fs.existsSync(imageGenCachePath)) imageGenConfig = JSON.parse(fs.readFileSync(imageGenCachePath, "utf8")) || {};
  } catch {}

  let personaConfig = {};
  try {
    if (fs.existsSync(personaCachePath)) personaConfig = JSON.parse(fs.readFileSync(personaCachePath, "utf8")) || {};
  } catch {}

  let ref3dFetchInFlight = null;
  function syncRef3dFromUrls(fetchUrl = "") {
    if (ref3dFetchInFlight) return ref3dFetchInFlight;
    const candidates = [
      ...(typeof fetchUrl === "string" && fetchUrl.trim() ? [fetchUrl.trim()] : []),
      "http://127.0.0.1:8877/dhvw/character-ref-3d",
    ];
    ref3dFetchInFlight = (async () => {
      for (const rawU of candidates) {
        try {
          const u = new URL(rawU);
          const mod = u.protocol === "https:" ? https : http;
          const buf = await new Promise((resolve, reject) => {
            const req = mod.get(
              u,
              { rejectUnauthorized: false, timeout: 8000 },
              (res) => {
                if (res.statusCode !== 200) {
                  res.resume();
                  return reject(new Error(`HTTP ${res.statusCode}`));
                }
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve(Buffer.concat(chunks)));
              },
            );
            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error("timeout")));
          });
          if (buf && buf.byteLength > 100) {
            fs.writeFileSync(ref3dPath, buf);
            log?.info?.(`[qq-openclaw] 已直连拉取角色三维参考图 (${buf.byteLength}B)`);
            return true;
          }
        } catch {}
      }
      return false;
    })().finally(() => {
      ref3dFetchInFlight = null;
    });
    return ref3dFetchInFlight;
  }

  if (Number(imageGenConfig.ref3dUpdatedAt || 0) > 0 && !fs.existsSync(ref3dPath)) {
    void syncRef3dFromUrls();
  }

  let persistedBot = {};
  try {
    if (fs.existsSync(botConfigPath)) persistedBot = JSON.parse(fs.readFileSync(botConfigPath, "utf8")) || {};
  } catch {}

  const effCfg = {
    ...rawCfg,
    ...persistedBot,
    gateways: {
      qq: rawCfg.gateways?.qq ?? persistedBot.gateways?.qq ?? true,
      feishu: rawCfg.gateways?.feishu ?? persistedBot.gateways?.feishu ?? false,
    },
    feishu: {
      ...(rawCfg.feishu || {}),
      ...(persistedBot.feishu || {}),
    },
    sticker: {
      eagerness: 2,
      ...(rawCfg.sticker || {}),
      ...(persistedBot.sticker || {}),
    },
  };
  if (!effCfg.clientSecret && rawCfg.clientSecret) effCfg.clientSecret = rawCfg.clientSecret;
  if (!effCfg.feishu.appSecret && rawCfg.feishu?.appSecret) effCfg.feishu.appSecret = rawCfg.feishu.appSecret;

  // 存量数据修复：bot-config.json 曾经把飞书的 ownerOpenId 写进 QQ 顶层，
  // 于是 QQ 拿 ou_ 开头的 id 发消息、永远发不出去（connected 仍为 true）。
  // QQ openid 是 32 位十六进制，绝不可能以 ou_ 开头；一旦发现就回落到
  // /etc/dhvw/qqbot.json 里的正确值。
  if (typeof effCfg.ownerOpenId === "string" && effCfg.ownerOpenId.startsWith("ou_")) {
    const fallback = String(rawCfg.ownerOpenId || "").trim();
    if (fallback && !fallback.startsWith("ou_")) {
      effCfg.ownerOpenId = fallback;
      console.log("[qq-openclaw] 修正被飞书数据污染的 QQ ownerOpenId");
    } else {
      effCfg.ownerOpenId = "";
      console.log("[qq-openclaw] 清除被飞书数据污染的 QQ ownerOpenId（需重新认主）");
    }
  }

  let worldState = { day: 1, minute: 480, phase: "morning", weather: "clear", place: "home", mood: { energy: 0.55, valence: 0.55, social: 0.4, focus: 0.5 }, band: "calm" };
  let llmConfig = effCfg.llm?.baseUrl ? effCfg.llm : cachedLlm;
  const sockets = new Set();
  const pendingBridgeReqs = new Map();
  let liveClient = null;
  let liveAccount = null;
  let lastGatewayError = "";
  let liveFeishuClient = null;
  let liveFeishuAccount = null;
  let lastFeishuGatewayError = "";

  const maskStr = (s) => {
    const str = String(s || "").trim();
    if (!str) return "";
    if (str.length <= 6) return `${str[0]}***`;
    return `${str.slice(0, 4)}****${str.slice(-3)}`;
  };

  function saveBotConfig() {
    try {
      const toSave = {
        enabled: effCfg.enabled !== false && boostActive,
        gateways: {
          qq: effCfg.gateways?.qq !== false,
          feishu: effCfg.gateways?.feishu === true,
        },
        appId: effCfg.appId || "",
        clientSecret: effCfg.clientSecret || "",
        sandbox: effCfg.sandbox !== false,
        ownerOpenId: effCfg.ownerOpenId || "",
        proactive: effCfg.proactive !== false,
        feishu: {
          appId: effCfg.feishu?.appId || "",
          appSecret: effCfg.feishu?.appSecret || "",
          ownerOpenId: effCfg.feishu?.ownerOpenId || "",
          proactive: effCfg.feishu?.proactive !== false,
          stickerEagerness: effCfg.feishu?.stickerEagerness ?? 2,
        },
        followBoost: effCfg.followBoost !== false,
        sticker: effCfg.sticker || {},
      };
      fs.writeFileSync(botConfigPath, JSON.stringify(toSave, null, 2), { mode: 0o600 });
    } catch {}
  }

  function broadcastBridge(type, payload) {
    const pkt = { v: 1, id: crypto.randomBytes(6).toString("hex"), type, ts: Date.now(), payload };
    for (const s of sockets) s.send(pkt);
  }

  function requestFromBrowser(type, payload, timeoutMs = 600) {
    const first = sockets.values().next().value;
    if (!first) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = crypto.randomBytes(6).toString("hex");
      const timer = setTimeout(() => {
        pendingBridgeReqs.delete(id);
        resolve(null);
      }, timeoutMs);
      pendingBridgeReqs.set(id, (resPayload) => {
        clearTimeout(timer);
        resolve(resPayload);
      });
      first.send({ v: 1, id, type, ts: Date.now(), payload });
    });
  }

  const runtime = createDhvwRuntime({
    stateDir,
    mediaDir: effCfg.mediaDir || "/tmp/dhvw-qq-media",
    shellUrl: effCfg.shellUrl || "http://127.0.0.1:8080",
    sticker: effCfg.sticker || {},
    partDelayMs: effCfg.partDelayMs ?? 450,
    getLlmConfig: () => llmConfig,
    getImageGenConfig: () => imageGenConfig,
    getPersonaConfig: () => personaConfig,
    getRef3dPath: () => (fs.existsSync(ref3dPath) ? ref3dPath : ""),
    getWorldState: () => worldState,
    queryMemory: async (text, k, mood) => {
      const res = await requestFromBrowser("qq:memory:query", { text, k, mood }, 2200);
      return res || { semantic: false, l0: [], hits: [] };
    },
    requestEdgeMedia: async () => {
      const res = await requestFromBrowser("qq:media:edge", {}, 1500);
      return res?.dataUrl || "";
    },
    emitFeedback: (fb) => broadcastBridge("qq:world:feedback", fb),
    log,
  });

  const proactive = createProactiveRunner({
    getClient: () => liveClient || liveFeishuClient,
    getAccount: () => liveAccount || liveFeishuAccount,
    getTargets: () => {
      const out = [];
      if (effCfg.gateways?.qq !== false && effCfg.proactive !== false && liveClient && liveAccount) {
        out.push({ channel: "qq", client: liveClient, account: liveAccount });
      }
      if (effCfg.gateways?.feishu === true && effCfg.feishu?.proactive !== false && liveFeishuClient && liveFeishuAccount) {
        out.push({ channel: "feishu", client: liveFeishuClient, account: liveFeishuAccount });
      }
      return out;
    },
    runtime,
    getWorldState: () => worldState,
    queryMemory: async (text, k, mood) => {
      const res = await requestFromBrowser("qq:memory:query", { text, k, mood }, 2200);
      return res || { semantic: false, l0: [], hits: [] };
    },
    requestEdgeMedia: async () => {
      const res = await requestFromBrowser("qq:media:edge", {}, 1500);
      return res?.dataUrl || "";
    },
    emitFeedback: (fb) => broadcastBridge("qq:world:feedback", fb),
    log,
  });

  const sharedReceive = {
    mention: { enabled: true, alwaysReplyInDirect: true },
    realtime: {
      enabled: true,
      windowMs: effCfg.debounceMs ?? 800,
      maxWindowMs: effCfg.maxWindowMs ?? 3000,
      maxMessages: effCfg.maxCoalesceMsgs ?? 10,
      maxChars: effCfg.maxCoalesceChars ?? 8000,
    },
    digest: { enabled: false },
    summary: { enabled: true },
    history: { enabled: true, maxMessages: 20, maxChars: 4000 },
  };
  const sharedImage = {
    enabled: true,
    maxPerMessage: effCfg.maxImagesPerMsg ?? 3,
    maxBytes: effCfg.mediaMaxBytes ?? 4 * 1024 * 1024,
    tool: false,
  };

  const cfg = {
    channels: {
      snowluma: {
        enabled: true,
        channelType: "qq",
        appId: effCfg.appId || "",
        clientSecret: effCfg.clientSecret || "",
        sandbox: effCfg.sandbox !== false,
        ownerOpenId: effCfg.ownerOpenId || "",
        allowOpenIds: effCfg.allowOpenIds || [],
        proactiveCooldownMin: effCfg.proactiveCooldownMin ?? 40,
        proactiveDailyMax: effCfg.proactiveDailyMax ?? 6,
        partDelayMs: effCfg.partDelayMs ?? 450,
        receive: sharedReceive,
        image: sharedImage,
        accounts: {
          feishu: {
            enabled: true,
            channelType: "feishu",
            appId: effCfg.feishu?.appId || "",
            appSecret: effCfg.feishu?.appSecret || "",
            ownerOpenId: effCfg.feishu?.ownerOpenId || "",
            allowOpenIds: effCfg.feishu?.allowOpenIds || [],
            proactiveCooldownMin: effCfg.feishu?.proactiveCooldownMin ?? effCfg.proactiveCooldownMin ?? 30,
            proactiveDailyMax: effCfg.feishu?.proactiveDailyMax ?? 30,
            partDelayMs: effCfg.partDelayMs ?? 450,
            receive: sharedReceive,
            image: sharedImage,
          },
        },
      },
    },
  };

  let account = resolveSnowLumaAccount(cfg);
  let feishuAccount = resolveSnowLumaAccount(cfg, "feishu");
  let gwAc = null;
  let gatewayPromise = null;
  let feishuGwAc = null;
  let feishuGatewayPromise = null;
  let proactiveTimer = null;
  let boostActive =
    effCfg.enabled === true ||
    (persistedBot.enabled !== false &&
      (Boolean(persistedBot.appId && persistedBot.clientSecret) ||
        Boolean(persistedBot.feishu?.appId && persistedBot.feishu?.appSecret)));

  function statusSnapshot() {
    const qqEnabled = effCfg.gateways?.qq !== false;
    const feishuEnabled = effCfg.gateways?.feishu === true;
    const qqConfigured = Boolean(account.appId && account.clientSecret);
    const feishuConfigured = Boolean(feishuAccount.appId && feishuAccount.appSecret);
    const qqConnected = !!liveClient?.connected;
    const feishuConnected = !!liveFeishuClient?.connected;
    return {
      ok: true,
      running: true,
      configured: qqConfigured || feishuConfigured,
      boostActive,
      gateways: { qq: qqEnabled, feishu: feishuEnabled },
      connected: qqConnected || feishuConnected,
      gatewayError: lastGatewayError || "",
      sandbox: account.sandbox,
      appId: account.appId || "",
      appIdMasked: maskStr(account.appId),
      paired: Boolean(account.ownerOpenId) || Boolean(feishuAccount.ownerOpenId),
      ownerOpenId: account.ownerOpenId || "",
      ownerOpenIdMasked: maskStr(account.ownerOpenId),
      awaitingActivation: Boolean(account.appId && account.clientSecret && !account.ownerOpenId),
      feishu: {
        enabled: feishuEnabled,
        configured: feishuConfigured,
        connected: feishuConnected,
        gatewayError: lastFeishuGatewayError || "",
        appId: feishuAccount.appId || "",
        appIdMasked: maskStr(feishuAccount.appId),
        paired: Boolean(feishuAccount.ownerOpenId),
        ownerOpenId: feishuAccount.ownerOpenId || "",
        ownerOpenIdMasked: maskStr(feishuAccount.ownerOpenId),
        awaitingActivation: Boolean(feishuConfigured && !feishuAccount.ownerOpenId),
        lastPongAt: Number(liveFeishuClient?.lastPongAt || 0),
        framesReceived: Number(liveFeishuClient?.framesReceived || 0),
        lastEventType: String(liveFeishuClient?.lastEventType || ""),
        lastEventSummary: String(liveFeishuClient?.lastEventSummary || ""),
        proactive: effCfg.feishu?.proactive !== false,
        unlimitedProactive: true,
      },
      stickers: runtime.stickerStore?.stats?.() || { count: 0 },
      proactive: proactive.getStatus?.() || null,
      lastLlmError: runtime.getLastLlmError?.() || "",
      imageGen: {
        enabled: Boolean(imageGenConfig.enabled),
        model: imageGenConfig.model || "",
        hasRef3d: fs.existsSync(ref3dPath),
        ref3dUpdatedAt: Number(imageGenConfig.ref3dUpdatedAt || 0),
        lastError: runtime.getLastImageGenError?.() || "",
      },
      window: liveClient?.ledger?.snapshot(account.ownerOpenId) || { active: false, remainingSeq: 0, expiresAt: 0 },
    };
  }

  function handlePaired(openId) {
    effCfg.ownerOpenId = String(openId || "").trim();
    account = { ...account, ownerOpenId: effCfg.ownerOpenId };
    saveBotConfig();
    broadcastBridge("qq:status", statusSnapshot());
  }

  function handleFeishuPaired(openId) {
    effCfg.feishu = { ...(effCfg.feishu || {}), ownerOpenId: String(openId || "").trim() };
    feishuAccount = { ...feishuAccount, ownerOpenId: effCfg.feishu.ownerOpenId };
    saveBotConfig();
    broadcastBridge("qq:status", statusSnapshot());
  }

  async function stopQqGateway() {
    if (gwAc) {
      gwAc.abort();
      gwAc = null;
      await gatewayPromise?.catch?.(() => {});
      gatewayPromise = null;
    }
    liveClient = null;
    liveAccount = null;
  }

  async function stopFeishuGateway() {
    if (feishuGwAc) {
      feishuGwAc.abort();
      feishuGwAc = null;
      await feishuGatewayPromise?.catch?.(() => {});
      feishuGatewayPromise = null;
    }
    liveFeishuClient = null;
    liveFeishuAccount = null;
  }

  async function syncProactiveTimer() {
    const anyProactive =
      boostActive &&
      ((effCfg.gateways?.qq !== false && effCfg.proactive !== false && account.appId && account.clientSecret) ||
        (effCfg.gateways?.feishu === true && effCfg.feishu?.proactive !== false && feishuAccount.appId && feishuAccount.appSecret));
    if (anyProactive) {
      if (!proactiveTimer) {
        proactiveTimer = setInterval(() => void proactive.tick(), 60_000);
        proactiveTimer.unref?.();
      }
    } else if (proactiveTimer) {
      clearInterval(proactiveTimer);
      proactiveTimer = null;
    }
  }

  async function setActive(active, nextGateways = null) {
    const next = Boolean(active);
    if (nextGateways && typeof nextGateways === "object") {
      effCfg.gateways = {
        qq: nextGateways.qq !== undefined ? Boolean(nextGateways.qq) : effCfg.gateways?.qq !== false,
        feishu: nextGateways.feishu !== undefined ? Boolean(nextGateways.feishu) : effCfg.gateways?.feishu === true,
      };
    }
    effCfg.enabled = next;
    boostActive = next;
    saveBotConfig();

    const wantQq = next && effCfg.gateways?.qq !== false && Boolean(account.appId && account.clientSecret);
    const wantFeishu = next && effCfg.gateways?.feishu === true && Boolean(feishuAccount.appId && feishuAccount.appSecret);

    if (wantQq) {
      if (!gwAc) {
        lastGatewayError = "";
        const launchAccount = {
          ...account,
          channelType: "qq",
          autoPairFirst: true,
          ledgerStateFile: path.join(stateDir, "qq-window-ledger.json"),
          onPaired: handlePaired,
        };
        gwAc = new AbortController();
        gatewayPromise = startGateway({
          account: launchAccount,
          cfg,
          runtime,
          abortSignal: gwAc.signal,
          log,
          onError: (err) => {
            lastGatewayError = String(err?.message || err || "");
            broadcastBridge("qq:status", statusSnapshot());
          },
          onReady: ({ client, account: effAcc }) => {
            liveClient = client;
            liveAccount = effAcc;
            lastGatewayError = "";
            client.onMessage(() => proactive.recordInbound());
            broadcastBridge("qq:status", statusSnapshot());
          },
        }).catch((err) => {
          lastGatewayError = String(err?.message || err || "");
          log?.warn?.(`[qq-openclaw] QQ gateway 退出: ${lastGatewayError}`);
          broadcastBridge("qq:status", statusSnapshot());
        });
        log?.info?.("[qq-openclaw] Boost 已开启，QQ Bot 网关上线");
      }
    } else {
      await stopQqGateway();
    }

    if (wantFeishu) {
      if (!feishuGwAc) {
        lastFeishuGatewayError = "";
        const launchFeishu = {
          ...feishuAccount,
          accountId: "feishu",
          channelType: "feishu",
          autoPairFirst: true,
          onPaired: handleFeishuPaired,
        };
        feishuGwAc = new AbortController();
        feishuGatewayPromise = startGateway({
          account: launchFeishu,
          cfg,
          runtime,
          abortSignal: feishuGwAc.signal,
          log,
          onError: (err) => {
            lastFeishuGatewayError = String(err?.message || err || "");
            broadcastBridge("qq:status", statusSnapshot());
          },
          onReady: ({ client, account: effAcc }) => {
            liveFeishuClient = client;
            liveFeishuAccount = effAcc;
            lastFeishuGatewayError = "";
            client.onMessage(() => proactive.recordInbound());
            client.on("open", () => broadcastBridge("qq:status", statusSnapshot()));
            client.on("pong", () => broadcastBridge("qq:status", statusSnapshot()));
            client.on("close", () => broadcastBridge("qq:status", statusSnapshot()));
            broadcastBridge("qq:status", statusSnapshot());
          },
        }).catch((err) => {
          lastFeishuGatewayError = String(err?.message || err || "");
          log?.warn?.(`[qq-openclaw] 飞书 gateway 退出: ${lastFeishuGatewayError}`);
          broadcastBridge("qq:status", statusSnapshot());
        });
        log?.info?.("[qq-openclaw] Boost 已开启，飞书长连接网关上线");
      }
    } else {
      await stopFeishuGateway();
    }

    if (!next) {
      log?.info?.("[qq-openclaw] Boost 已关闭，全部外部网关休眠");
    }
    await syncProactiveTimer();
    broadcastBridge("qq:status", statusSnapshot());
  }

  async function applyBotConfig(patch = {}) {
    const prevAppId = account.appId;
    const prevSecret = account.clientSecret;
    const prevSandbox = account.sandbox;
    const prevFeishuAppId = feishuAccount.appId;
    const prevFeishuSecret = feishuAccount.appSecret;

    if (patch.gateways && typeof patch.gateways === "object") {
      effCfg.gateways = {
        qq: patch.gateways.qq !== undefined ? Boolean(patch.gateways.qq) : effCfg.gateways?.qq !== false,
        feishu: patch.gateways.feishu !== undefined ? Boolean(patch.gateways.feishu) : effCfg.gateways?.feishu === true,
      };
    }

    const feishuPatch = patch.channel === "feishu" ? patch : (patch.feishu && typeof patch.feishu === "object" ? patch.feishu : null);
    if (feishuPatch) {
      effCfg.feishu = effCfg.feishu || {};
      if (typeof feishuPatch.appId === "string" && feishuPatch.appId.trim()) effCfg.feishu.appId = feishuPatch.appId.trim();
      const fSec = feishuPatch.appSecret || feishuPatch.clientSecret;
      if (typeof fSec === "string" && fSec.trim()) effCfg.feishu.appSecret = fSec.trim();
      if (typeof feishuPatch.ownerOpenId === "string") effCfg.feishu.ownerOpenId = feishuPatch.ownerOpenId.trim();
      if (typeof feishuPatch.proactive === "boolean") effCfg.feishu.proactive = feishuPatch.proactive;
      if (feishuPatch.stickerEagerness !== undefined && Number.isFinite(Number(feishuPatch.stickerEagerness))) {
        const eg = Math.max(0, Math.min(3, Math.floor(Number(feishuPatch.stickerEagerness))));
        effCfg.feishu.stickerEagerness = eg;
        effCfg.sticker = { ...(effCfg.sticker || {}), eagerness: eg };
        runtime.stickerStore?.setEagerness?.(eg);
      }
      if (feishuPatch.rebind === true) effCfg.feishu.ownerOpenId = "";
    }

    if (patch.channel !== "feishu") {
      if (typeof patch.appId === "string" && patch.appId.trim()) effCfg.appId = patch.appId.trim();
      if (typeof patch.clientSecret === "string" && patch.clientSecret.trim()) effCfg.clientSecret = patch.clientSecret.trim();
      if (typeof patch.sandbox === "boolean") effCfg.sandbox = patch.sandbox;
      // QQ 的 openid 是 32 位十六进制，飞书的是 ou_ 前缀。历史上 PC 侧把飞书的
      // ownerOpenId 混进 QQ 的配置 patch 下发过，导致 QQ 把消息发给不存在的用户
      // （表现：进程 connected=true 但永远收不到回应）。这里按格式挡掉。
      if (typeof patch.ownerOpenId === "string") {
        const next = patch.ownerOpenId.trim();
        if (!next || !next.startsWith("ou_")) effCfg.ownerOpenId = next;
      }
      if (typeof patch.proactive === "boolean") effCfg.proactive = patch.proactive;
      if (patch.stickerEagerness !== undefined && Number.isFinite(Number(patch.stickerEagerness))) {
        const eg = Math.max(0, Math.min(3, Math.floor(Number(patch.stickerEagerness))));
        effCfg.sticker = { ...(effCfg.sticker || {}), eagerness: eg };
        runtime.stickerStore?.setEagerness?.(eg);
      }
      if (typeof patch.followBoost === "boolean") effCfg.followBoost = patch.followBoost;
      if (patch.rebind === true) effCfg.ownerOpenId = "";
    }

    cfg.channels.snowluma.appId = effCfg.appId || "";
    cfg.channels.snowluma.clientSecret = effCfg.clientSecret || "";
    cfg.channels.snowluma.sandbox = effCfg.sandbox !== false;
    cfg.channels.snowluma.ownerOpenId = effCfg.ownerOpenId || "";
    account = resolveSnowLumaAccount(cfg);

    cfg.channels.snowluma.accounts.feishu.appId = effCfg.feishu?.appId || "";
    cfg.channels.snowluma.accounts.feishu.appSecret = effCfg.feishu?.appSecret || "";
    cfg.channels.snowluma.accounts.feishu.ownerOpenId = effCfg.feishu?.ownerOpenId || "";
    feishuAccount = resolveSnowLumaAccount(cfg, "feishu");

    saveBotConfig();

    const qqCredsChanged = account.appId !== prevAppId || account.clientSecret !== prevSecret || account.sandbox !== prevSandbox;
    const feishuCredsChanged = feishuAccount.appId !== prevFeishuAppId || feishuAccount.appSecret !== prevFeishuSecret;
    if (patch.activate === true) boostActive = true;

    if (liveClient && !qqCredsChanged) liveClient.setOwnerOpenId(account.ownerOpenId);
    if (liveFeishuClient && !feishuCredsChanged) liveFeishuClient.setOwnerOpenId(feishuAccount.ownerOpenId);

    if (qqCredsChanged && gwAc) await stopQqGateway();
    if (feishuCredsChanged && feishuGwAc) await stopFeishuGateway();

    if (boostActive) {
      await setActive(true);
    } else {
      broadcastBridge("qq:status", statusSnapshot());
    }
    return statusSnapshot();
  }

  async function triggerRebind(channel = "qq") {
    if (channel === "feishu") {
      return applyBotConfig({ channel: "feishu", rebind: true, ownerOpenId: "" });
    }
    if (channel === "all") {
      return applyBotConfig({ rebind: true, ownerOpenId: "", feishu: { rebind: true, ownerOpenId: "" } });
    }
    return applyBotConfig({ rebind: true, ownerOpenId: "" });
  }

  function readJsonBody(req) {
    return new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => {
        if (raw.length < 65536) raw += c.toString("utf8");
      });
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    const cleanUrl = (req.url || "/").split("?")[0];
    if (cleanUrl === "/__qq/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(statusSnapshot()));
      return;
    }
    if (cleanUrl === "/__qq/config" && req.method === "POST") {
      const body = await readJsonBody(req);
      const st = await applyBotConfig(body);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(st));
      return;
    }
    if (cleanUrl === "/__qq/rebind" && req.method === "POST") {
      const body = await readJsonBody(req);
      const qChannel = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("channel");
      const st = await triggerRebind(body?.channel || qChannel || "qq");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(st));
      return;
    }
    if (cleanUrl === "/__qq/proactive/trigger" && req.method === "POST") {
      const body = await readJsonBody(req);
      const r = await proactive.tick({ force: body?.force !== false });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ...r, proactive: proactive.getStatus?.() || null }));
      return;
    }
    res.writeHead(404).end();
  });

  server.on("upgrade", (req, socket) => {
    if (req.url !== "/qq/ws") {
      socket.destroy();
      return;
    }
    let clientSock = null;
    clientSock = attachWsClient(
      req,
      socket,
      (msg) => {
        if (msg?.replyTo && pendingBridgeReqs.has(msg.replyTo)) {
          const cb = pendingBridgeReqs.get(msg.replyTo);
          pendingBridgeReqs.delete(msg.replyTo);
          cb(msg.payload);
          return;
        }
        if (msg?.type === "qq:world:state" && msg.payload) {
          worldState = { ...worldState, ...msg.payload };
        } else if (msg?.type === "qq:llm:config" && msg.payload) {
          llmConfig = { ...llmConfig, ...msg.payload };
          try {
            fs.writeFileSync(llmCachePath, JSON.stringify(llmConfig), { mode: 0o600 });
          } catch {}
        } else if (msg?.type === "qq:imagegen:config" && msg.payload) {
          const { ref3dBase64, ref3dFetchUrl, ...rest } = msg.payload;
          const prevTs = Number(imageGenConfig.ref3dUpdatedAt || 0);
          imageGenConfig = { ...imageGenConfig, ...rest };
          try {
            fs.writeFileSync(imageGenCachePath, JSON.stringify(imageGenConfig), { mode: 0o600 });
            if (typeof ref3dBase64 === "string") {
              if (ref3dBase64.trim()) {
                fs.writeFileSync(ref3dPath, Buffer.from(ref3dBase64, "base64"));
                log?.info?.(`[qq-openclaw] 已通过 WS 同步角色三维参考图 (${ref3dPath})`);
              } else if (fs.existsSync(ref3dPath)) {
                fs.unlinkSync(ref3dPath);
              }
            } else if (
              Number(rest.ref3dUpdatedAt || 0) > 0 &&
              (!fs.existsSync(ref3dPath) || Number(rest.ref3dUpdatedAt) !== prevTs)
            ) {
              void syncRef3dFromUrls(ref3dFetchUrl);
            }
          } catch {}
        } else if (msg?.type === "qq:persona:config" && msg.payload) {
          personaConfig = { ...personaConfig, ...msg.payload };
          try {
            fs.writeFileSync(personaCachePath, JSON.stringify(personaConfig), { mode: 0o600 });
          } catch {}
          runtime.syncCharacterCues?.();
        } else if (msg?.type === "qq:world:event" && msg.payload) {
          proactive.recordWorldEvent(msg.payload);
        } else if (msg?.type === "qq:boost:state" && msg.payload) {
          void setActive(msg.payload.enabled, msg.payload.gateways);
        } else if (msg?.type === "qq:bot:config" && msg.payload) {
          void applyBotConfig(msg.payload);
        } else if (msg?.type === "qq:bot:rebind") {
          void triggerRebind(msg?.payload?.channel || "qq");
        } else if (msg?.type === "feishu:bot:config" && msg.payload) {
          void applyBotConfig({ ...msg.payload, channel: "feishu" });
        } else if (msg?.type === "feishu:bot:rebind") {
          void triggerRebind("feishu");
        }
      },
      () => {
        if (clientSock) sockets.delete(clientSock);
      },
    );
    if (clientSock) {
      sockets.add(clientSock);
      clientSock.send({
        v: 1,
        id: crypto.randomBytes(6).toString("hex"),
        type: "qq:status",
        ts: Date.now(),
        payload: statusSnapshot(),
      });
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  if (boostActive) await setActive(true);

  return {
    server,
    proactive,
    runtime,
    setActive,
    applyBotConfig,
    triggerRebind,
    statusSnapshot,
    isActive: () => boostActive,
    stop: async () => {
      if (proactiveTimer) clearInterval(proactiveTimer);
      proactiveTimer = null;
      await Promise.all([stopQqGateway(), stopFeishuGateway()]);
      for (const s of sockets) s.close();
      await new Promise((r) => server.close(r));
    },
  };
}

if (import.meta.url === `file://${path.resolve(process.argv[1] || "")}` || process.argv[1]?.endsWith("dhvw-server.js")) {
  const args = parseArgs(process.argv);
  let raw = {};
  if (fs.existsSync(args.configPath)) {
    raw = JSON.parse(fs.readFileSync(args.configPath, "utf8"));
  } else if (!args.followBoost) {
    console.log(`[qq-openclaw] 未找到配置 ${args.configPath}（未启用），正常退出`);
    process.exit(0);
  }
  if (args.followBoost) raw.followBoost = true;
  if (args.stateDir) raw.stateDir = args.stateDir;
  if (args.shellUrl) raw.shellUrl = args.shellUrl;
  if (!raw.enabled && !raw.followBoost) {
    console.log("[qq-openclaw] enabled=false 且未开启 followBoost，正常退出");
    process.exit(0);
  }
  const svc = await startDhvwQqService(raw);
  const shutdown = () => {
    void svc.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

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
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
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
      if (op === 0x1) {
        try {
          onMessage(JSON.parse(payload.toString("utf8")));
        } catch {}
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
  const botConfigPath = path.join(stateDir, "bot-config.json");

  let cachedLlm = {};
  try {
    if (fs.existsSync(llmCachePath)) cachedLlm = JSON.parse(fs.readFileSync(llmCachePath, "utf8")) || {};
  } catch {}

  let persistedBot = {};
  try {
    if (fs.existsSync(botConfigPath)) persistedBot = JSON.parse(fs.readFileSync(botConfigPath, "utf8")) || {};
  } catch {}

  const effCfg = {
    ...rawCfg,
    ...persistedBot,
    sticker: { ...(rawCfg.sticker || {}), ...(persistedBot.sticker || {}) },
  };
  if (!effCfg.clientSecret && rawCfg.clientSecret) effCfg.clientSecret = rawCfg.clientSecret;

  let worldState = { day: 1, minute: 480, phase: "morning", weather: "clear", place: "home", mood: { energy: 0.55, valence: 0.55, social: 0.4, focus: 0.5 }, band: "calm" };
  let llmConfig = effCfg.llm?.baseUrl ? effCfg.llm : cachedLlm;
  const sockets = new Set();
  const pendingBridgeReqs = new Map();
  let liveClient = null;
  let liveAccount = null;
  let lastGatewayError = "";

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
        appId: effCfg.appId || "",
        clientSecret: effCfg.clientSecret || "",
        sandbox: effCfg.sandbox !== false,
        ownerOpenId: effCfg.ownerOpenId || "",
        proactive: effCfg.proactive !== false,
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
    getClient: () => liveClient,
    getAccount: () => liveAccount,
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

  const cfg = {
    channels: {
      snowluma: {
        enabled: true,
        appId: effCfg.appId || "",
        clientSecret: effCfg.clientSecret || "",
        sandbox: effCfg.sandbox !== false,
        ownerOpenId: effCfg.ownerOpenId || "",
        allowOpenIds: effCfg.allowOpenIds || [],
        proactiveCooldownMin: effCfg.proactiveCooldownMin ?? 40,
        proactiveDailyMax: effCfg.proactiveDailyMax ?? 6,
        partDelayMs: effCfg.partDelayMs ?? 450,
        receive: {
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
        },
        image: {
          enabled: true,
          maxPerMessage: effCfg.maxImagesPerMsg ?? 3,
          maxBytes: effCfg.mediaMaxBytes ?? 4 * 1024 * 1024,
          tool: false,
        },
      },
    },
  };

  let account = resolveSnowLumaAccount(cfg);
  let gwAc = null;
  let gatewayPromise = null;
  let proactiveTimer = null;
  let boostActive =
    effCfg.enabled === true ||
    (Boolean(persistedBot.appId && persistedBot.clientSecret) && persistedBot.enabled !== false);

  function statusSnapshot() {
    return {
      ok: true,
      running: true,
      configured: Boolean(account.appId && account.clientSecret),
      boostActive,
      connected: !!liveClient?.connected,
      gatewayError: lastGatewayError || "",
      sandbox: account.sandbox,
      appId: account.appId || "",
      appIdMasked: maskStr(account.appId),
      paired: Boolean(account.ownerOpenId),
      ownerOpenId: account.ownerOpenId || "",
      ownerOpenIdMasked: maskStr(account.ownerOpenId),
      awaitingActivation: Boolean(account.appId && account.clientSecret && !account.ownerOpenId),
      stickers: runtime.stickerStore?.stats?.() || { count: 0 },
      proactive: proactive.getStatus?.() || null,
      window: liveClient?.ledger?.snapshot(account.ownerOpenId) || { active: false, remainingSeq: 0, expiresAt: 0 },
    };
  }

  function handlePaired(openId) {
    effCfg.ownerOpenId = String(openId || "").trim();
    account = { ...account, ownerOpenId: effCfg.ownerOpenId };
    saveBotConfig();
    broadcastBridge("qq:status", statusSnapshot());
  }

  async function setActive(active) {
    const next = Boolean(active);
    effCfg.enabled = next;
    boostActive = next;
    saveBotConfig();
    lastGatewayError = "";
    if (next) {
      if (!account.appId || !account.clientSecret) {
        log?.info?.("[qq-openclaw] Boost 已开启，等待 PC 下发 AppID / ClientSecret");
        broadcastBridge("qq:status", statusSnapshot());
        return;
      }
      if (gwAc) return;
      const launchAccount = {
        ...account,
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
        log?.warn?.(`[qq-openclaw] gateway 退出: ${lastGatewayError}`);
        broadcastBridge("qq:status", statusSnapshot());
      });
      if (effCfg.proactive !== false && !proactiveTimer) {
        proactiveTimer = setInterval(() => void proactive.tick(), 60_000);
        proactiveTimer.unref?.();
      }
      log?.info?.("[qq-openclaw] Boost 已开启，QQ Bot 网关上线");
      broadcastBridge("qq:status", statusSnapshot());
    } else {
      if (proactiveTimer) {
        clearInterval(proactiveTimer);
        proactiveTimer = null;
      }
      if (gwAc) {
        gwAc.abort();
        gwAc = null;
        await gatewayPromise?.catch?.(() => {});
        gatewayPromise = null;
      }
      liveClient = null;
      liveAccount = null;
      broadcastBridge("qq:status", statusSnapshot());
      log?.info?.("[qq-openclaw] Boost 已关闭，QQ Bot 网关休眠");
    }
  }

  async function applyBotConfig(patch = {}) {
    const prevAppId = account.appId;
    const prevSecret = account.clientSecret;
    const prevSandbox = account.sandbox;

    if (typeof patch.appId === "string" && patch.appId.trim()) effCfg.appId = patch.appId.trim();
    if (typeof patch.clientSecret === "string" && patch.clientSecret.trim()) effCfg.clientSecret = patch.clientSecret.trim();
    if (typeof patch.sandbox === "boolean") effCfg.sandbox = patch.sandbox;
    if (typeof patch.ownerOpenId === "string") effCfg.ownerOpenId = patch.ownerOpenId.trim();
    if (typeof patch.proactive === "boolean") effCfg.proactive = patch.proactive;
    if (typeof patch.followBoost === "boolean") effCfg.followBoost = patch.followBoost;
    if (patch.rebind === true) effCfg.ownerOpenId = "";

    cfg.channels.snowluma.appId = effCfg.appId || "";
    cfg.channels.snowluma.clientSecret = effCfg.clientSecret || "";
    cfg.channels.snowluma.sandbox = effCfg.sandbox !== false;
    cfg.channels.snowluma.ownerOpenId = effCfg.ownerOpenId || "";
    account = resolveSnowLumaAccount(cfg);
    saveBotConfig();

    const credsChanged = account.appId !== prevAppId || account.clientSecret !== prevSecret || account.sandbox !== prevSandbox;
    if (patch.activate === true) boostActive = true;

    if (liveClient && !credsChanged) {
      liveClient.setOwnerOpenId(account.ownerOpenId);
    }
    if (boostActive && account.appId && account.clientSecret) {
      if (credsChanged && gwAc) {
        await setActive(false);
      }
      await setActive(true);
    }
    broadcastBridge("qq:status", statusSnapshot());
    return statusSnapshot();
  }

  async function triggerRebind() {
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
      const st = await triggerRebind();
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
        } else if (msg?.type === "qq:world:event" && msg.payload) {
          proactive.recordWorldEvent(msg.payload);
        } else if (msg?.type === "qq:boost:state" && msg.payload) {
          void setActive(msg.payload.enabled);
        } else if (msg?.type === "qq:bot:config" && msg.payload) {
          void applyBotConfig(msg.payload);
        } else if (msg?.type === "qq:bot:rebind") {
          void triggerRebind();
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
      if (gwAc) gwAc.abort();
      await gatewayPromise?.catch?.(() => {});
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

// 假 PC：最小 WebSocket 服务，用于设备端 W9 联调（仅开发/测试）。
// 用法：node tools/fake-pc.mjs [port]
// 设备页：http://127.0.0.1:8080/debug-core.html?host=ws://127.0.0.1:8877/dhvw
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] || 8877);
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const head = Buffer.alloc(4);
  head[0] = 0x81;
  head[1] = 126;
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, host: "fake-pc" }));
    return;
  }
  if (req.url.startsWith("/present")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(`<!doctype html><title>fake present</title>
<body style="margin:0;background:#123;color:#eee;font:16px sans-serif">
<div id="t">fake OLVT present</div>
<script>addEventListener("message",e=>{if(e.data?.type==="dhvw:say")document.getElementById("t").textContent="say: "+e.data.text});</script>`);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("fake-pc\n");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  console.log("[fake-pc] device connected");

  const send = (obj) => socket.write(frame({ v: 1, id: `s-${Date.now()}`, ts: Date.now(), payload: {}, ...obj }));
  const sendMsg = (type, payload) => send({ type, payload });

  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    parse();
  });
  socket.on("close", () => console.log("[fake-pc] device disconnected"));
  socket.on("error", (err) => console.log(`[fake-pc] socket error: ${err.code || err.message}`));

  function parse() {
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = buf.subarray(off + maskLen, off + maskLen + len);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = masked ? data[i] ^ mask[i % 4] : data[i];
      buf = buf.subarray(off + maskLen + len);
      if (op === 8) return socket.end();
      if (op !== 1) continue;
      let msg;
      try {
        msg = JSON.parse(out.toString());
      } catch {
        continue;
      }
      console.log(`[fake-pc] ← ${msg.type}`, JSON.stringify(msg.payload ?? {}).slice(0, 160));
      if (msg.type === "hello") {
        sendMsg("hello", {
          host_id: "fake-pc",
          t_server: Date.now(),
          tts: true,
          live2d: false,
          world_tier: "idle",
        });
      }
      if (msg.type === "events:batch") {
        const events = msg.payload?.events || [];
        const seq = events.reduce((m, e) => Math.max(m, e.seq || 0), 0);
        console.log(`[fake-pc]   batch=${events.length} ack=${seq}`);
        if (seq) sendMsg("events:ack", { seq });
      }
      if (msg.type === "facts:ack") {
        console.log(`[fake-pc]   facts ack accepted=${msg.payload?.accepted} merged=${msg.payload?.merged}`);
      }
      if (msg.type === "memory:query") {
        sendMsg("memory:result", {
          req_id: msg.payload?.req_id,
          hits: [{ id: "pc-1", text: "PC 侧记忆：京都的枫叶", score: 0.91, tier: "L2" }],
          semantic: true,
        });
      }
      if (msg.type === "present:begin" || msg.type === "present:end") {
        console.log(`[fake-pc]   session=${msg.payload?.session_id}`);
      }
      if (msg.type === "pc:action") {
        sendMsg("pc:action:ack", { id: msg.payload?.id, ok: true, result: { fake: true } });
      }
      if (msg.type === "mood:state") {
        console.log(`[fake-pc]   mood band=${msg.payload?.band} series=${msg.payload?.series?.length}`);
      }
      if (msg.type === "world:digest") {
        const d = msg.payload?.digest;
        console.log(`[fake-pc]   digest agenda=${d?.agenda?.length} scenes=${d?.sceneRequests?.length} pc=${d?.pcActions?.length}`);
      }
    }
  }

  setTimeout(() => {
    sendMsg("hello", { host_id: "fake-pc", t_server: Date.now(), tts: true, live2d: false, world_tier: "idle" });
    sendMsg("say", { text: "主机上线了", ttl: 3000 });
    sendMsg("mood:get", {});
    sendMsg("memory:facts", {
      since: 0,
      facts: [
        { id: "pc-1", text: "PC 侧记忆：京都的枫叶", tier: "L2" },
        { id: "pc-2", text: "PC 侧记忆：雨天的车站", tier: "L2" },
      ],
    });
  }, 300);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fake-pc] ws://127.0.0.1:${PORT}/dhvw`);
});

// 假 LLM（OpenAI 兼容），用于验证设备侧代理链路
const LLM_PORT = PORT + 1;
const llm = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
    res.writeHead(404).end("not found");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    console.log(`[fake-llm] ← ${req.headers.authorization || "no-auth"} ${body.slice(0, 120)}`);
    const content = body.includes("可用家具") && body.includes("只输出 JSON")
      ? JSON.stringify({
          props: [
            { id: "chair", x: 10, y: 6 },
            { id: "plant", x: 15, y: 2 },
            { id: "rug", x: 10, y: 3 },
          ],
        })
      : body.includes("决定这次上网看什么")
      ? JSON.stringify({
          query: "北京 明天 天气",
          reason: "想知道明天要不要带伞",
        })
      : body.includes("写一条") && body.includes("心情变化")
      ? JSON.stringify({
          summary: "她把面煮好，吃完觉得暖了一点。",
          mood: "energy +0.08, valence +0.05",
          evidence: "",
        })
      : body.includes("严格输出 JSON") && body.includes("outcome")
      ? JSON.stringify({
          outcome: "message",
          fact: "雨停了，她开了窗",
          content: "她站在窗边，看雨后的街道",
          share: "雨停了，开窗吧",
          residue: "窗还开着",
          next_wake: { min_minutes: 50, max_minutes: 80, reason: "刚醒" },
        })
      : body.includes("日常生活事件")
      ? JSON.stringify({
          events: [
            { text: "她把窗台的灰擦了一遍", hours: [8, 9, 10], place: "living", mood: { focus: 0.04 }, imageQuery: "wiping windowsill morning" },
            { text: "她在厨房削了一个苹果", hours: [15, 16, 17], place: "kitchen", mood: { valence: 0.06 }, imageQuery: "peeling apple kitchen" },
          ],
        })
      : body.includes("背景图检索词")
      ? JSON.stringify({
          text: "夜里，她把窗推开一条缝，雨声涌进来。桌上的杯子还温着，她端起来，又放下，去拧灭了走廊的灯。",
          event: "雨停开窗",
          place: "living",
          scene: "living",
          mood: { valence: 0.05, energy: -0.02 },
          imageQuery: "rain window night",
        })
      : body.includes("第三人称小记")
      ? "夜里，她把窗推开一条缝，雨声涌进来。桌上的杯子还温着，她端起来，又放下，去拧灭了走廊的灯。"
      : body.includes("任务编排器")
      ? JSON.stringify({ tasks: [{ skill: "wake-character", input: "雨停了", reason: "演示" }] })
      : body.includes("开口要求")
        ? "雨停了，正好。"
        : "pong from fake llm";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
        model: "fake-llm",
      }),
    );
  });
});
llm.listen(LLM_PORT, "127.0.0.1", () => {
  console.log(`[fake-llm] http://127.0.0.1:${LLM_PORT}/v1/chat/completions`);
});

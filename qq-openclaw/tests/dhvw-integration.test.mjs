import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { QQOfficialClient, MsgDedupRing, WindowLedger, normalizeQqInboundContent } from "../dist/src/qq-official-client.js";
import { FeishuClient, encodePbFrame, decodePbFrame } from "../dist/src/feishu-client.js";
import { startDhvwQqService } from "../dist/dhvw-server.js";
import { resolveSnowLumaAccount } from "../dist/src/config.js";
import { createAggregator } from "../dist/src/aggregator.js";
import { dispatchBatch } from "../dist/src/dispatch.js";
import { createDhvwRuntime } from "../dist/src/dhvw-runtime.js";
import { createStickerStore } from "../dist/src/sticker-store.js";
import { evaluateProactiveTrigger, createProactiveRunner } from "../dist/src/dhvw-proactive.js";
import { markdownToText } from "../dist/src/markdown-text.js";

// 1x1 PNG 魔数（有效 PNG 头）
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

class FakeGatewaySocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }) });
      this.onmessage?.({ data: JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "sess-1" } }) });
    });
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "closed" });
  }
  pushEvent(t, d, s = 2) {
    this.onmessage?.({ data: JSON.stringify({ op: 0, s, t, d }) });
  }
}

describe("QQOfficialClient (官方 Bot APIv2 合规单聊 + 多模态)", () => {
  it("token 鉴权缓存、Identify intents=1<<25、白名单与 C2C 去重/被动窗口/传图", async () => {
    const calls = [];
    let tokenFetches = 0;
    let fakeSock = null;
    class TrackingWs extends FakeGatewaySocket {
      constructor(url) {
        super(url);
        fakeSock = this;
      }
    }

    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith("/getAppAccessToken")) {
        tokenFetches += 1;
        return new Response(JSON.stringify({ access_token: "tok-v2", expires_in: 7200 }), { status: 200 });
      }
      if (url.endsWith("/gateway")) {
        return new Response(JSON.stringify({ url: "wss://mock.qq.example/ws" }), { status: 200 });
      }
      if (url.includes("/files")) {
        return new Response(JSON.stringify({ file_info: "file-info-xyz" }), { status: 200 });
      }
      if (url.includes("/messages")) {
        return new Response(JSON.stringify({ id: "msg-out-1" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const client = new QQOfficialClient({
      appId: "app-123",
      clientSecret: "sec-456",
      sandbox: true,
      ownerOpenId: "OWNER_OPEN_ID",
      fetchImpl,
      WSImpl: TrackingWs,
    });

    const received = [];
    client.onMessage((ev) => received.push(ev));
    await client.connect();

    // 验证 Identify payload 使用 intents = 1<<25
    const identify = fakeSock.sent.find((p) => p.op === 2);
    assert.ok(identify);
    assert.equal(identify.d.intents, 1 << 25);
    assert.equal(identify.d.token, "QQBot tok-v2");

    // 非白名单 openId 应被忽略
    fakeSock.pushEvent("C2C_MESSAGE_CREATE", {
      id: "m-stranger",
      content: "hi",
      author: { user_openid: "STRANGER_ID" },
      timestamp: "2026-11-16T10:00:00Z",
    });
    assert.equal(received.length, 0);

    // 主人单聊 + 多模态图片附件（测试无协议头 // 补全 https:）
    const c2cPayload = {
      id: "m-in-1",
      content: "看看这张图",
      author: { user_openid: "OWNER_OPEN_ID" },
      attachments: [{ content_type: "image/png", url: "//multimedia.nt.qq.com.cn/a.png", filename: "a.png" }],
      timestamp: "2026-11-16T10:00:01Z",
    };
    fakeSock.pushEvent("C2C_MESSAGE_CREATE", c2cPayload, 3);
    // 相同 msg_id 重复推送必须去重
    fakeSock.pushEvent("C2C_MESSAGE_CREATE", c2cPayload, 4);

    assert.equal(received.length, 1);
    assert.equal(received[0].message[1].data.url, "https://multimedia.nt.qq.com.cn/a.png");
    assert.equal(received[0].message_type, "private");
    assert.equal(received[0].user_id, "OWNER_OPEN_ID");
    assert.equal(received[0].message.length, 2);
    assert.equal(received[0].message[1].type, "image");

    // 被动窗口发送纯文本 + dataUrl 图片（msg_seq 应依次为 1、2）
    await client.sendPrivateMessage("OWNER_OPEN_ID", "收到啦", { replyToId: "m-in-1" });
    await client.sendPrivateMessage("OWNER_OPEN_ID", [{ type: "image", data: { file: `data:image/png;base64,${TINY_PNG.toString("base64")}` } }], { replyToId: "m-in-1" });

    const msgCalls = calls.filter((c) => c.url.includes("/messages"));
    assert.equal(msgCalls.length, 2);
    assert.equal(msgCalls[0].body.msg_id, "m-in-1");
    assert.equal(msgCalls[0].body.msg_seq, 1);
    assert.equal(msgCalls[0].body.msg_type, 0);
    assert.equal(msgCalls[1].body.msg_id, "m-in-1");
    assert.equal(msgCalls[1].body.msg_seq, 2);
    assert.equal(msgCalls[1].body.msg_type, 7);
    assert.equal(msgCalls[1].body.media.file_info, "file-info-xyz");
    assert.equal(tokenFetches, 1);

    client.close();
  });

  it("MsgDedupRing 与 WindowLedger 60 分钟/4 条被动限制与主动限额", () => {
    const ring = new MsgDedupRing(10);
    for (let i = 0; i < 15; i++) assert.equal(ring.seenOrAdd(`id-${i}`), false);
    assert.equal(ring.seenOrAdd("id-14"), true);
    assert.equal(ring.seenOrAdd("id-0"), false); // 已淘汰

    let now = 1_000_000;
    const ledger = new WindowLedger({ proactiveCooldownMin: 90, proactiveDailyMax: 2, now: () => now });
    ledger.recordInbound("U1", "M1");
    ledger.recordInbound("U1", "M2"); // 连发 M2 不能覆盖 M1 的被动窗口
    for (let i = 1; i <= 4; i++) {
      assert.deepEqual(ledger.claimPassive("U1", "M1"), { msgId: "M1", seq: i });
    }
    assert.equal(ledger.claimPassive("U1", "M1"), null); // 第 5 条超限
    assert.deepEqual(ledger.claimPassive("U1", "M2"), { msgId: "M2", seq: 1 }); // M2 仍有独立窗口

    assert.equal(ledger.canProactive().ok, true);
    ledger.recordProactive();
    assert.equal(ledger.canProactive().reason, "cooldown");
    now += 91 * 60_000;
    assert.equal(ledger.canProactive().ok, true);
    ledger.recordProactive();
    now += 91 * 60_000;
    assert.equal(ledger.canProactive().reason, "daily_cap");
  });
});

describe("openclaw-snowluma 管道整合 (aggregator + image + dispatch + dhvw-runtime)", () => {
  it("防抖合并多条消息+图片，走多模态 LLM、markdown 拍平、黑话查询与反馈回写", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-qq-int-"));
    const mediaDir = path.join(tmpDir, "media");
    const stateDir = path.join(tmpDir, "state");

    const sentPayloads = [];
    const feedbacks = [];
    const memoryQueries = [];
    const llmRequests = [];

    const fetchImpl = async (url, init = {}) => {
      if (url === "https://multimedia.nt.qq.com.cn/pic.png") {
        return new Response(TINY_PNG, { status: 200, headers: { "content-type": "image/png" } });
      }
      if (url === "https://multimedia.nt.qq.com.cn/bad.html") {
        return new Response(Buffer.from("<html>not image</html>"), { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.endsWith("/chat/completions")) {
        const body = JSON.parse(init.body);
        llmRequests.push(body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply_mode: "reply",
                    parts: ["**哇** 看到了！", "- 你拍的猫咪好可爱"],
                    tone: "playful",
                    bubble: "夸了主人的小猫",
                    mood_delta: { valence: 0.08, social: -0.05 },
                    unknown_term: "yyds",
                    memory_fact: "主人养了一只橘猫叫橘子",
                    action: "happy",
                    send_edge_bg: false,
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const runtime = createDhvwRuntime({
      mediaDir,
      stateDir,
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "vision-test", supportsVision: true }),
      getWorldState: () => ({ day: 3, minute: 900, phase: "afternoon", weather: "clear", place: "living_room", mood: { valence: 0.6, social: 0.5 }, band: "calm" }),
      queryMemory: async (text, k, mood) => {
        memoryQueries.push({ text, k, mood });
        return { semantic: true, l0: [{ text: "喜欢喝乌龙茶" }], hits: [{ tier: "L1", text: "之前聊过养猫计划" }] };
      },
      emitFeedback: (fb) => feedbacks.push(fb),
      searchWeb: async (q) => [{ title: "网络热词解释", snippet: `${q}: 永远的神，用来夸很厉害的事物` }],
      fetchImpl,
    });

    const cfg = {
      channels: {
        snowluma: {
          enabled: true,
          appId: "a",
          clientSecret: "s",
          ownerOpenId: "OWNER",
          partDelayMs: 0,
          receive: { realtime: { enabled: true, windowMs: 15, maxWindowMs: 50, maxMessages: 5, maxChars: 1000 } },
          image: { enabled: true, maxPerMessage: 3, maxBytes: 1024 * 1024, tool: false },
        },
      },
    };
    const account = resolveSnowLumaAccount(cfg);

    const fakeClient = {
      async sendPrivateMessage(uid, msg, opts) {
        sentPayloads.push({ uid, msg, opts });
        return { message_id: `out-${sentPayloads.length}` };
      },
    };

    let flushedResolve;
    let flushedReject;
    const flushedDone = new Promise((res, rej) => {
      flushedResolve = res;
      flushedReject = rej;
    });
    const agg = createAggregator({
      account,
      log: { info: () => {}, warn: () => {}, error: (m) => flushedReject(new Error(m)) },
      onFlush: async (batch) => {
        await dispatchBatch(batch, {
          cfg,
          account,
          client: fakeClient,
          runtime,
          selfId: "a",
          log: { info: () => {}, warn: () => {}, error: (m) => console.error("[dispatch]", m) },
        });
        flushedResolve(batch);
      },
    });

    const acceptOpts = { triggered: true, triggerReason: "direct", mentionWasStripped: false, shouldMentionInHistory: false };
    agg.accept(
      {
        messageId: "m1",
        peerId: "private:OWNER",
        peerKind: "direct",
        senderId: "OWNER",
        senderName: "主人",
        text: "你看我家猫，这颜值真是yyds",
        segments: [
          { type: "text", data: { text: "你看我家猫，这颜值真是yyds" } },
          { type: "image", data: { url: "https://multimedia.nt.qq.com.cn/pic.png" } },
        ],
        imageUrls: ["https://multimedia.nt.qq.com.cn/pic.png"],
        forwardIds: [],
        time: 1700000001,
        isSelf: false,
      },
      acceptOpts,
    );
    agg.accept(
      {
        messageId: "m2",
        peerId: "private:OWNER",
        peerKind: "direct",
        senderId: "OWNER",
        senderName: "主人",
        text: "还有一张",
        segments: [
          { type: "text", data: { text: "还有一张" } },
          // 非法 HTML 伪装图片 + SSRF 内网 URL 均应被安全跳过而不崩掉本轮对话
          { type: "image", data: { url: "https://multimedia.nt.qq.com.cn/bad.html" } },
          { type: "image", data: { url: "http://127.0.0.1/secret.png" } },
        ],
        imageUrls: ["https://multimedia.nt.qq.com.cn/bad.html", "http://127.0.0.1/secret.png"],
        forwardIds: [],
        time: 1700000002,
        isSelf: false,
      },
      acceptOpts,
    );

    const batch = await flushedDone;
    assert.equal(batch.messages.length, 2);
    assert.equal(memoryQueries.length, 1);
    assert.equal(llmRequests.length, 1);

    // 验证多模态图已转成 image_url 进入模型，且坏图/SSRF未混入
    const userContent = llmRequests[0].messages[0].content;
    assert.ok(Array.isArray(userContent));
    const imgParts = userContent.filter((c) => c.type === "image_url");
    assert.equal(imgParts.length, 1);
    assert.ok(imgParts[0].image_url.url.startsWith("data:image/png;base64,"));

    // 验证 dispatch 的 markdownToText 已将 **粗体** 和 - 列表拍平为多段自然消息，且附带 reply 段
    assert.equal(sentPayloads.length, 2);
    const segs0 = sentPayloads[0].msg.toSegments();
    const segs1 = sentPayloads[1].msg.toSegments();
    assert.deepEqual(segs0.find((s) => s.type === "reply"), { type: "reply", data: { id: "m1" } });
    assert.equal(segs0.find((s) => s.type === "text")?.data?.text, "哇 看到了！");
    assert.ok(!String(segs1.find((s) => s.type === "text")?.data?.text || "").includes("- "));

    // 等异步 slang 查询完成
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(feedbacks.some((f) => f.moodDelta?.valence === 0.08 && f.action === "happy"));
    assert.ok(feedbacks.some((f) => f.facts?.some((x) => x.text.includes("橘猫"))));
    assert.ok(feedbacks.some((f) => f.facts?.some((x) => x.text.includes("yyds"))));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reply_mode=skip 时不发 QQ 消息但更新气泡/心情；runDigestExtraction 抽取记忆事实", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-qq-skip-"));
    const feedbacks = [];
    const runtime = createDhvwRuntime({
      mediaDir: path.join(tmpDir, "media"),
      stateDir: path.join(tmpDir, "state"),
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", model: "m" }),
      emitFeedback: (fb) => feedbacks.push(fb),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply_mode: "skip",
                    parts: [],
                    bubble: "嗯嗯先忙吧",
                    mood_delta: { social: -0.02 },
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });

    const delivered = [];
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "c2c", RawBody: "我先去开会了", Body: "我先去开会了" },
      cfg: {},
      dispatcherOptions: {
        deliver: async (p) => delivered.push(p),
      },
    });
    assert.equal(delivered.length, 0);
    assert.equal(feedbacks[0].bubble, "嗯嗯先忙吧");
    assert.equal(markdownToText("**hello**"), "hello");

    // 验证 /summary 显式总结不会被误当成 digest SKIP 吞掉
    const sumRuntime = createDhvwRuntime({
      mediaDir: path.join(tmpDir, "media"),
      stateDir: path.join(tmpDir, "state"),
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", model: "m" }),
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "今天聊了猫咪和咖啡。" } }] }), { status: 200 }),
    });
    const sumDelivered = [];
    await sumRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { BodyForAgent: "以下是这个会话最近的聊天记录。请总结...", RawBody: "" },
      cfg: {},
      dispatcherOptions: { deliver: async (p) => sumDelivered.push(p) },
    });
    assert.equal(sumDelivered[0]?.text, "今天聊了猫咪和咖啡。");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("心情指数 + 世界事件主动发起与降级 & enabled=false 零开销退出", () => {
  it("心情/天气/世界事件/线头重浮触发判定与夜间/冷却抑制", () => {
    const dayNoon = new Date(2026, 10, 16, 14, 0, 0).getTime();
    assert.equal(
      evaluateProactiveTrigger({ now: dayNoon, mood: { social: 0.72, valence: 0.5 } }).kind,
      "mood_lonely",
    );
    assert.equal(
      evaluateProactiveTrigger({ now: dayNoon, mood: { social: 0.4, valence: 0.28 } }).kind,
      "mood_low",
    );
    assert.equal(
      evaluateProactiveTrigger({ now: dayNoon, band: "excited", mood: { valence: 0.8, energy: 0.8 } }).kind,
      "mood_excited",
    );
    assert.equal(
      evaluateProactiveTrigger({ now: dayNoon, weather: "rain", lastWeatherShared: "clear" }).kind,
      "weather_shift",
    );
    assert.equal(
      evaluateProactiveTrigger({
        now: dayNoon,
        recentEvents: [{ id: "ev1", kind: "writing", summary: "写了下雨天的日记", ts: dayNoon - 60_000 }],
      }).kind,
      "world_event",
    );
    assert.equal(
      evaluateProactiveTrigger({
        now: dayNoon,
        threads: [{ id: "t1", text: "上次说周末去逛展", resurfaceAt: dayNoon - 1000 }],
      }).kind,
      "thread_resurface",
    );
    assert.equal(evaluateProactiveTrigger({ now: dayNoon, phase: "sleep" }).reason, "quiet_hours");
  });

  it("QQ 主动消息被平台拒绝时自动降级为总观气泡而不报错崩溃", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-qq-pro-"));
    const dayNoon = new Date(2026, 10, 16, 14, 0, 0).getTime();
    const feedbacks = [];
    const runtime = createDhvwRuntime({
      mediaDir: path.join(tmpDir, "m"),
      stateDir: path.join(tmpDir, "s"),
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", model: "m" }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    speak: true,
                    parts: ["外面突然下起雨了，你在屋里还好吗"],
                    bubble: "看窗外下雨想起了你",
                    send_edge_bg: false,
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });

    const runner = createProactiveRunner({
      getClient: () => ({
        async sendPrivateMessage() {
          throw new Error("主动消息受限: quota_exceeded");
        },
      }),
      getAccount: () => ({ ownerOpenId: "OWNER", proactiveDailyMax: 6, partDelayMs: 0 }),
      runtime,
      getWorldState: () => ({ phase: "afternoon", weather: "rain", display: "overview", mood: { valence: 0.5, social: 0.5 }, band: "calm" }),
      emitFeedback: (fb) => feedbacks.push(fb),
      now: () => dayNoon,
      log: { info: () => {} },
    });

    const res = await runner.tick();
    assert.equal(res.ok, true);
    assert.equal(res.trigger, "weather_shift");
    assert.equal(res.sentOk, false);
    assert.equal(feedbacks.length, 1);
    assert.equal(feedbacks[0].bubble, "看窗外下雨想起了你");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dhvw-server.js 在 enabled=false 或配置缺失时以 0 正常退出（不启端口/无内存驻留）", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-qq-disabled-"));
    const cfgPath = path.join(tmpDir, "qqbot.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ enabled: false }), "utf8");
    const serverPath = path.resolve(process.cwd(), "dist/dhvw-server.js");
    const r1 = spawnSync(process.execPath, [serverPath, "-config", cfgPath], { encoding: "utf8" });
    assert.equal(r1.status, 0);
    assert.ok(r1.stdout.includes("enabled=false"));

    const r2 = spawnSync(process.execPath, [serverPath, "-config", path.join(tmpDir, "missing.json")], { encoding: "utf8" });
    assert.equal(r2.status, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("图片表情包采集（偷图）与语境挑图发送 (sticker-store + QQOfficialClient + dispatch)", () => {
  it("QQOfficialClient 支持 file:// 本地表情图上传；偷图自动去重并可在后续回复中只发或混发表情包", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-qq-stk-"));
    const mediaDir = path.join(tmpDir, "media");
    const stateDir = path.join(tmpDir, "state");
    const stickerDir = path.join(stateDir, "stickers");
    fs.mkdirSync(stickerDir, { recursive: true });
    // 预置一个运营直放的表情包文件，验证启动扫描识别
    fs.writeFileSync(path.join(stickerDir, "抱抱_安慰.png"), TINY_PNG);

    // 另一张入站图片（略作字节变化确保 SHA-256 不同）
    const inboundMemePng = Buffer.concat([TINY_PNG, Buffer.from("meme")]);
    const uploadedPayloads = [];
    const sentApiMsgs = [];
    let turn = 0;

    const fetchImpl = async (url, init = {}) => {
      if (url === "https://multimedia.nt.qq.com.cn/funny.png") {
        return new Response(inboundMemePng, { status: 200, headers: { "content-type": "image/png" } });
      }
      if (url.endsWith("/getAppAccessToken")) {
        return new Response(JSON.stringify({ access_token: "tok-s", expires_in: 7200 }), { status: 200 });
      }
      if (url.includes("/files")) {
        const b = JSON.parse(init.body);
        uploadedPayloads.push(b);
        return new Response(JSON.stringify({ file_info: `fi-${uploadedPayloads.length}` }), { status: 200 });
      }
      if (url.includes("/messages")) {
        const b = JSON.parse(init.body);
        sentApiMsgs.push(b);
        return new Response(JSON.stringify({ id: `out-${sentApiMsgs.length}` }), { status: 200 });
      }
      if (url.endsWith("/chat/completions")) {
        turn += 1;
        const body = JSON.parse(init.body);
        const promptText = Array.isArray(body.messages[0].content)
          ? body.messages[0].content.find((c) => c.type === "text")?.text || ""
          : body.messages[0].content;
        if (turn === 1) {
          // 第一轮：偷图并回复文字 + 选预置抱抱表情包
          assert.ok(promptText.includes("可用表情包库"));
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      reply_mode: "reply",
                      parts: ["摸摸头，别累着啦"],
                      sticker_id: body.messages[0].content ? promptText.match(/id=(stk-[a-f0-9]+)/)?.[1] || "" : "",
                      sticker_only: false,
                      collect_sticker: { save: true, emotion: "搞笑", desc: "猫猫震惊盯", tags: ["猫", "震惊", "搞笑"] },
                      bubble: "收藏了新表情并安慰了你",
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        // 第二轮（高积极度模式下）：只回一张偷来的表情包斗图（sticker_only=true）
        const collectedMatch = [...promptText.matchAll(/id=(stk-[a-f0-9]+) \| 情绪:搞笑/g)][0]?.[1] || "";
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply_mode: "short",
                    parts: [],
                    sticker_id: collectedMatch,
                    sticker_only: true,
                    bubble: "斗图甩了个表情包",
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    };

    const client = new QQOfficialClient({
      appId: "app-s",
      clientSecret: "sec-s",
      ownerOpenId: "OWNER",
      fetchImpl,
    });
    client.ledger.recordInbound("OWNER", "m-stk-1");

    const runtime = createDhvwRuntime({
      mediaDir,
      stateDir,
      sticker: { enabled: true, autoCollect: true, eagerness: 3, maxStickers: 50 },
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", model: "vision", supportsVision: true }),
      getWorldState: () => ({ phase: "evening", weather: "clear", mood: { valence: 0.3, social: 0.6 }, band: "low" }),
      fetchImpl,
    });
    assert.equal(runtime.stickerStore.stats().count, 1); // 启动扫描到 抱抱_安慰.png

    const cfg = {
      channels: {
        snowluma: {
          enabled: true,
          appId: "app-s",
          clientSecret: "sec-s",
          ownerOpenId: "OWNER",
          partDelayMs: 0,
          replyToTrigger: true,
          image: { enabled: true, maxPerMessage: 2, maxBytes: 1024 * 1024, tool: false },
        },
      },
    };
    const account = resolveSnowLumaAccount(cfg);

    // 第 1 轮：主人发来一张梗图 -> 自动偷图收藏 + 文+表情混发（本地 file:// 上传到 /files）
    await dispatchBatch(
      {
        kind: "realtime",
        peerId: "private:OWNER",
        peerKind: "direct",
        messages: [
          {
            messageId: "m-stk-1",
            peerId: "private:OWNER",
            peerKind: "direct",
            senderId: "OWNER",
            senderName: "主人",
            text: "今天好累啊 [图片]",
            segments: [
              { type: "text", data: { text: "今天好累啊" } },
              { type: "image", data: { url: "https://multimedia.nt.qq.com.cn/funny.png" } },
            ],
            imageUrls: ["https://multimedia.nt.qq.com.cn/funny.png"],
            forwardIds: [],
            time: 1700000100,
            isSelf: false,
          },
        ],
        history: [],
        trigger: { triggered: true, reason: "direct", mentionWasStripped: false, shouldMentionInHistory: false },
        reason: "quiet",
      },
      { cfg, account, client, runtime, selfId: "app-s", log: { info: () => {}, warn: () => {}, error: (m) => { throw new Error(m); } } },
    );

    assert.equal(runtime.stickerStore.stats().count, 2); // 成功偷到第二张
    assert.equal(uploadedPayloads.length, 1);
    assert.ok(uploadedPayloads[0].file_data.length > 0);
    const txtIdx = sentApiMsgs.findIndex((m) => m.msg_type === 0 && m.content === "摸摸头，别累着啦");
    const stkIdx = sentApiMsgs.findIndex((m) => m.msg_type === 7 && m.media?.file_info === "fi-1");
    assert.ok(txtIdx >= 0 && stkIdx > txtIdx); // 必须先发文字再发表情包

    // 第 2 轮：sticker_only=true 纯发刚偷来的表情包
    client.ledger.recordInbound("OWNER", "m-stk-2");
    await dispatchBatch(
      {
        kind: "realtime",
        peerId: "private:OWNER",
        peerKind: "direct",
        messages: [
          {
            messageId: "m-stk-2",
            peerId: "private:OWNER",
            peerKind: "direct",
            senderId: "OWNER",
            senderName: "主人",
            text: "哈哈哈太搞笑了吧",
            segments: [{ type: "text", data: { text: "哈哈哈太搞笑了吧" } }],
            imageUrls: [],
            forwardIds: [],
            time: 1700000120,
            isSelf: false,
          },
        ],
        history: [],
        trigger: { triggered: true, reason: "direct", mentionWasStripped: false, shouldMentionInHistory: false },
        reason: "quiet",
      },
      { cfg, account, client, runtime, selfId: "app-s", log: { info: () => {}, warn: () => {}, error: (m) => { throw new Error(m); } } },
    );

    assert.equal(uploadedPayloads.length, 2);
    assert.equal(sentApiMsgs[sentApiMsgs.length - 1].msg_type, 7);
    assert.equal(sentApiMsgs[sentApiMsgs.length - 1].media.file_info, "fi-2");

    // 同一张图重复收藏必须 SHA-256 去重而不膨胀数量
    const s2 = createStickerStore({ dir: stickerDir });
    const dup = await s2.collectFromFile(path.join(stickerDir, "抱抱_安慰.png"), { emotion: "抱抱" });
    assert.equal(dup.created, false);
    assert.equal(s2.stats().count, 2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("首条激活消息自动认主绑定与重新绑定 (autoPairFirst + setOwnerOpenId)", async () => {
    let pairedOpenId = "";
    let fakeSock = null;
    class PairingWs extends FakeGatewaySocket {
      constructor(url) {
        super(url);
        fakeSock = this;
      }
    }
    const fetchImpl = async (url) => {
      if (url.endsWith("/getAppAccessToken")) {
        return new Response(JSON.stringify({ access_token: "tok-p", expires_in: 7200 }), { status: 200 });
      }
      if (url.endsWith("/gateway")) {
        return new Response(JSON.stringify({ url: "wss://mock.qq.example/ws" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const client = new QQOfficialClient({
      appId: "app-pair",
      clientSecret: "sec-pair",
      ownerOpenId: "",
      autoPairFirst: true,
      onPaired: (id) => {
        pairedOpenId = id;
      },
      fetchImpl,
      WSImpl: PairingWs,
    });
    const chatDelivered = [];
    client.onMessage((ev) => chatDelivered.push(ev));
    await client.connect();

    // 填好 AppID 和密钥后，主人只需在 QQ 发任意一条激活消息，即自动绑定并直接进入首轮回复
    fakeSock.pushEvent("C2C_MESSAGE_CREATE", {
      id: "p1",
      content: "你好，激活一下",
      author: { user_openid: "FIRST_OWNER_88" },
      timestamp: "2026-11-16T10:00:01Z",
    });
    assert.equal(pairedOpenId, "FIRST_OWNER_88");
    assert.equal(client.ownerOpenId, "FIRST_OWNER_88");
    assert.equal(chatDelivered.length, 1);

    // 锁定主人后，其他陌生人发消息会被拦截
    fakeSock.pushEvent("C2C_MESSAGE_CREATE", {
      id: "p2",
      content: "我是路人",
      author: { user_openid: "STRANGER_99" },
      timestamp: "2026-11-16T10:00:02Z",
    });
    assert.equal(chatDelivered.length, 1);

    // 重新绑定：清空旧绑定后，下一个发送激活消息的人成为新主人
    client.setOwnerOpenId("");
    fakeSock.pushEvent("C2C_MESSAGE_CREATE", {
      id: "p3",
      content: "换号重新激活",
      author: { user_openid: "NEW_OWNER_77" },
      timestamp: "2026-11-16T10:00:03Z",
    });
    assert.equal(pairedOpenId, "NEW_OWNER_77");
    assert.equal(client.ownerOpenId, "NEW_OWNER_77");
    assert.equal(chatDelivered.length, 2);

    client.close();
  });

  it("内置表情解码与连续天气复读抑制（prompt 不再每轮灌入原始天气 JSON 且不重复用户当轮消息）", async () => {
    assert.equal(normalizeQqInboundContent("<emoji:8>"), "[QQ表情:睡]");
    assert.equal(
      normalizeQqInboundContent('<faceType=1,faceId="8",ext="eyJ0ZXh0Ijoi552hIn0=">'),
      "[QQ表情:睡]",
    );
    assert.equal(normalizeQqInboundContent("/睡"), "[QQ表情:睡]");
    assert.equal(normalizeQqInboundContent("/home/work/test.txt"), "/home/work/test.txt");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-prompt-fix-"));
    const prompts = [];
    const feedbackList = [];
    let turnNo = 0;

    const rt = createDhvwRuntime({
      stateDir: tmpDir,
      mediaDir: path.join(tmpDir, "media"),
      partDelayMs: 0,
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "http://llm.local/v1", model: "test-m", apiKey: "k" }),
      getWorldState: () => ({ day: 1, minute: 480, phase: "morning", weather: "fog", place: "home", band: "calm" }),
      queryMemory: async () => ({ semantic: true, l0: [{ text: "主人叫玖弦" }], hits: [{ text: "喜欢深夜聊天" }] }),
      emitFeedback: (fb) => feedbackList.push(fb),
      fetchImpl: async (_url, init) => {
        turnNo += 1;
        const body = JSON.parse(init.body);
        const promptText = body.messages[0].content;
        prompts.push(promptText);
        const replyObj =
          turnNo === 1
            ? { reply_mode: "reply", parts: ["我这儿雾蒙蒙的"], bubble: "早安", memory_fact: "主人凌晨两点睡前会问候" }
            : { reply_mode: "reply", parts: ["还不困吗，先眯一会"], bubble: "陪你", memory_fact: "" };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replyObj) } }] }), { status: 200 });
      },
    });

    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "这么晚还没睡呀", Body: "这么晚还没睡呀", BodyForAgent: "这么晚还没睡呀" },
      dispatcherOptions: { deliver: async () => {} },
    });
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "[QQ表情:睡]", Body: "[QQ表情:睡]", BodyForAgent: "[QQ表情:睡]" },
      dispatcherOptions: { deliver: async () => {} },
    });

    assert.equal(prompts.length, 2);
    // 第 1 轮可带背景天气，但不再灌入原始 JSON {"weather":"fog"...}
    assert.ok(!prompts[0].includes('"weather":"fog"'));
    assert.ok(prompts[0].includes("薄雾"));
    // 第 1 轮提取的事实正常进入 feedback
    assert.equal(feedbackList[0].facts[0].text, "主人凌晨两点睡前会问候");
    // 第 2 轮检测到近期刚提过雾，提示词直接屏蔽天气并注入反复读约束，且不把当前消息重复进最近对话
    assert.ok(!prompts[1].includes("天气薄雾"));
    assert.ok(prompts[1].includes("禁止再提雾/雨/雪"));
    assert.equal(prompts[1].split("[QQ表情:睡]").length - 1, 1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("表情包联网自动扩库 (searchAndCollect) 与聊天显式查资料主动触发 /__search", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-autofetch-"));
    const BIG_FAKE_PNG = Buffer.concat([TINY_PNG, Buffer.alloc(1200, 1)]);
    const prompts = [];

    const fetchImpl = async (url, init = {}) => {
      if (url.includes("/__image/search")) {
        return new Response(
          JSON.stringify({
            source: "bing",
            items: [{ url: "https://cdn.example.com/sleepy.png", thumb: "https://cdn.example.com/sleepy_t.png" }],
          }),
          { status: 200 },
        );
      }
      if (url === "https://cdn.example.com/sleepy_t.png") {
        return new Response(BIG_FAKE_PNG, { status: 200, headers: { "content-type": "image/png" } });
      }
      if (url.includes("/__search")) {
        return new Response(
          JSON.stringify({ ok: true, results: [{ title: "今日热词百科", snippet: "早八人指的是早上八点要出门的打工人" }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/chat/completions")) {
        const body = JSON.parse(init.body);
        prompts.push(body.messages[0].content);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ reply_mode: "reply", parts: ["早八人辛苦啦"], bubble: "聊热词" }) } }],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const rt = createDhvwRuntime({
      stateDir: tmpDir,
      mediaDir: path.join(tmpDir, "media"),
      shellUrl: "http://127.0.0.1:18080",
      partDelayMs: 0,
      getLlmConfig: () => ({ baseUrl: "http://llm.local/v1", model: "test-m", apiKey: "k" }),
      getWorldState: () => ({ band: "tired", mood: { energy: 0.3 } }),
      fetchImpl,
    });

    assert.equal(rt.stickerStore.stats().count, 0);
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "帮我查一下早八人是什么意思", Body: "帮我查一下早八人是什么意思", BodyForAgent: "帮我查一下早八人是什么意思" },
      dispatcherOptions: { deliver: async () => {} },
    });

    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes("联网搜索参考"));
    assert.ok(prompts[0].includes("今日热词百科"));
    assert.ok(prompts[0].includes("可用表情包库"));
    assert.equal(rt.stickerStore.stats().count, 1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("QQ 自唤醒支持 idle_checkin、柔化夜聊静默、传递 isWakeup:true 及持久状态", async () => {
    const lateChatAt = new Date(2026, 10, 16, 23, 40, 0).getTime();
    // 23:40 且 40 分钟前还在聊，不应硬锁 quiet_hours，应走 idle_checkin
    const lateDecision = evaluateProactiveTrigger({
      now: lateChatAt,
      lastInboundAt: lateChatAt - 40 * 60_000,
      lastProactiveAt: lateChatAt - 50 * 60_000,
    });
    assert.equal(lateDecision.shouldTrigger, true);
    assert.equal(lateDecision.kind, "idle_checkin");

    // 23:40 且超过 90 分钟没人聊，进入静默
    const lateIdle = evaluateProactiveTrigger({
      now: lateChatAt,
      lastInboundAt: lateChatAt - 100 * 60_000,
    });
    assert.equal(lateIdle.shouldTrigger, false);
    assert.equal(lateIdle.reason, "quiet_hours");

    // 03:00 无论如何进入深度静默
    const deepNight = new Date(2026, 10, 17, 3, 0, 0).getTime();
    assert.equal(evaluateProactiveTrigger({ now: deepNight, lastInboundAt: deepNight - 10 * 60_000 }).reason, "quiet_hours");

    // 验证 createProactiveRunner 会传 isWakeup: true 且持久化状态
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-proactive-wakeup-"));
    const sendCalls = [];
    const rt = createDhvwRuntime({
      stateDir: tmpDir,
      mediaDir: path.join(tmpDir, "m"),
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "http://llm.local/v1", model: "test-m", apiKey: "k" }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ speak: true, parts: ["刚听了一首老歌"], bubble: "主动冒泡" }) } }],
          }),
          { status: 200 },
        ),
    });
    const noon = new Date(2026, 10, 17, 14, 0, 0).getTime();
    const runner = createProactiveRunner({
      getClient: () => ({
        async sendPrivateMessage(uid, msg, opts) {
          sendCalls.push({ uid, msg, opts });
          return { message_id: "w-1" };
        },
      }),
      getAccount: () => ({ ownerOpenId: "OWNER", proactiveDailyMax: 6, partDelayMs: 0 }),
      runtime: rt,
      getWorldState: () => ({ phase: "afternoon", weather: "clear", display: "overview", mood: { valence: 0.5, social: 0.4 }, band: "calm" }),
      now: () => noon,
      log: { info: () => {} },
    });
    const r = await runner.tick();
    assert.equal(r.ok, true);
    assert.equal(r.trigger, "idle_checkin");
    assert.equal(sendCalls[0].opts.proactive, true);
    assert.equal(sendCalls[0].opts.isWakeup, true);
    assert.equal(fs.existsSync(path.join(tmpDir, "proactive-state.json")), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("过滤字典百科黑话污染、去重线头，并在“聊点别的/你猜”时切换话题且不再提旧梗", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-topic-shift-"));
    fs.writeFileSync(
      path.join(tmpDir, "slang.json"),
      JSON.stringify([
        { term: "大狗大狗", meaning: "大（汉语文字）_百度百科 多音字" },
        "早茶之约",
      ]),
      "utf8",
    );
    const prompts = [];
    const rt = createDhvwRuntime({
      stateDir: tmpDir,
      mediaDir: path.join(tmpDir, "m"),
      partDelayMs: 0,
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "http://llm.local/v1", model: "test-m", apiKey: "k" }),
      searchWeb: async () => [{ title: "大（汉语文字）_百度百科", snippet: "康熙字典 笔顺 部首" }],
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        prompts.push(body.messages[0].content);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ reply_mode: "reply", parts: ["聊聊最近看的那部电影吧"], bubble: "换个新话题", unknown_term: "测试词" }) } }],
          }),
          { status: 200 },
        );
      },
    });

    // 线头相似度去重
    rt.addThread("咖啡厅早茶之约待兑现");
    rt.addThread("咖啡厅早茶之约待兑现，对方已答应请客");
    assert.equal(rt.getThreads().length, 1);

    // 1. 普通回合也不注入百度百科字典垃圾
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "聊点别的呗", Body: "聊点别的呗", BodyForAgent: "聊点别的呗" },
      dispatcherOptions: { deliver: async () => {} },
    });
    // 2. 紧接着回“你猜”，依然保留话题切换指令，屏蔽黑话并禁止沿用旧话题
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "你猜", Body: "你猜", BodyForAgent: "你猜" },
      dispatcherOptions: { deliver: async () => {} },
    });

    assert.equal(prompts.length, 2);
    assert.ok(!prompts[0].includes("百度百科"));
    assert.ok(!prompts[0].includes("熟人习惯与黑话"));
    assert.ok(prompts[0].includes("话题切换指令"));
    assert.ok(!prompts[1].includes("早茶之约"));
    assert.ok(!prompts[1].includes("熟人习惯与黑话"));
    assert.ok(prompts[1].includes("话题切换指令"));

    // 3. 验证单聊正文不会带着 “主人: ” 称呼前缀误导 LLM
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "我当然吃过了，你都喜欢看啥书", Body: "主人: 我当然吃过了，你都喜欢看啥书", BodyForAgent: "主人: 我当然吃过了，你都喜欢看啥书" },
      dispatcherOptions: { deliver: async () => {} },
    });
    assert.ok(!prompts[2].includes("主人: 我当然吃过了"));
    assert.ok(prompts[2].includes("对方刚发来：\n我当然吃过了，你都喜欢看啥书"));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("WindowLedger 持久化 msg_id、超窗单条合并发送、is_wakeup 失败自动兜底及失败不伪造今日次数", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-ledger-persist-"));
    const ledgerFile = path.join(tmpDir, "ledger.json");
    let tNow = new Date(2026, 10, 17, 15, 0, 0).getTime();

    // 1. 收到消息后持久化到 ledger.json，模拟重启后新 WindowLedger 仍可复用 60 分钟被动窗口
    const l1 = new WindowLedger({ stateFile: ledgerFile, now: () => tNow });
    l1.recordInbound("OWNER", "msg-abc");
    assert.deepEqual(l1.claimPassive("OWNER"), { msgId: "msg-abc", seq: 1 });

    const l2 = new WindowLedger({ stateFile: ledgerFile, now: () => tNow + 5 * 60_000 });
    assert.equal(l2.snapshot("OWNER").active, true);
    assert.equal(l2.snapshot("OWNER").remainingSeq, 3);
    assert.deepEqual(l2.claimPassive("OWNER"), { msgId: "msg-abc", seq: 2 });

    // 2. 超窗后 is_wakeup 遭平台拒绝时，自动降级为不带 is_wakeup 的普通主动请求再试一次
    const payloads = [];
    const client = new QQOfficialClient({
      appId: "app1",
      clientSecret: "sec1",
      ownerOpenId: "OWNER",
      now: () => tNow,
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith("/getAppAccessToken")) {
          return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), { status: 200 });
        }
        const body = JSON.parse(init.body);
        payloads.push(body);
        if (body.is_wakeup) {
          return new Response(JSON.stringify({ message: "wakeup quota limit", code: 304082 }), { status: 400 });
        }
        return new Response(JSON.stringify({ id: "pro-fallback-1" }), { status: 200 });
      },
    });
    const sent = await client.sendPrivateMessage("OWNER", "下午好，想你了", { proactive: true, isWakeup: true });
    assert.equal(sent.message_id, "pro-fallback-1");
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].is_wakeup, true);
    assert.equal(payloads[1].is_wakeup, undefined);

    // 3. 当被动窗口失效且超窗多句输出时，合并成 1 条发送；若全被拒发，todayCount 不增加且记录 lastSendError + 5 分钟退避
    const rt = createDhvwRuntime({
      stateDir: tmpDir,
      mediaDir: path.join(tmpDir, "m"),
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "http://llm.local/v1", model: "m", apiKey: "k" }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ speak: true, parts: ["第一句", "第二句"], bubble: "冒泡" }) } }],
          }),
          { status: 200 },
        ),
    });

    const sentTexts = [];
    let shouldFail = true;
    const runner = createProactiveRunner({
      getClient: () => ({
        ledger: { snapshot: () => ({ active: false, remainingSeq: 0 }) },
        async sendPrivateMessage(_uid, segs) {
          sentTexts.push(segs.toSegments().map((s) => s.data?.text).join(""));
          if (shouldFail) throw new Error("QQ API HTTP 400: daily limit");
          return { message_id: "ok-1" };
        },
      }),
      getAccount: () => ({ ownerOpenId: "OWNER", proactiveDailyMax: 6, partDelayMs: 0 }),
      runtime: rt,
      now: () => tNow,
      log: { info: () => {}, warn: () => {} },
    });

    const failRes = await runner.tick();
    assert.equal(failRes.sentOk, false);
    assert.equal(sentTexts.length, 1);
    assert.equal(sentTexts[0], "第一句\n第二句");
    assert.equal(runner.getStatus().todayCount, 0);
    assert.ok(runner.getStatus().lastSendError.includes("QQ API HTTP 400"));
    // 5 分钟退避期内不重复打扰
    assert.equal((await runner.tick()).reason, "failed_backoff");

    // 5 分钟退避结束后重发成功，才计入 todayCount
    tNow += 6 * 60_000;
    shouldFail = false;
    const okRes = await runner.tick();
    assert.equal(okRes.sentOk, true);
    assert.equal(runner.getStatus().todayCount, 1);
    assert.equal(runner.getStatus().lastSendError, "");

    // 验证 client.on("error") 返回可调用的退订函数（兼容 gateway.js 清理）
    const unsub = client.on("error", () => {});
    assert.equal(typeof unsub, "function");
    unsub();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("表情包默认节流冷却与防机械三段式/口头禅反重复约束", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-style-guard-"));
    const stkDir = path.join(tmpDir, "stickers");
    fs.mkdirSync(stkDir, { recursive: true });
    fs.writeFileSync(path.join(stkDir, "开心_比心.png"), TINY_PNG);

    // 默认 eagerness=1：发送一次后至少跳过 4 轮纯文字才再次解锁表情包
    const st = createStickerStore({ dir: stkDir, autoFetch: false });
    assert.equal(st.eagerness, 1);
    assert.equal(st.canSendThisTurn(), true);
    st.recordTurn(true);
    for (let i = 0; i < 4; i++) {
      assert.equal(st.canSendThisTurn(), false);
      st.recordTurn(false);
    }
    assert.equal(st.canSendThisTurn(), true);

    // 预置前 2 轮含模板套话的历史，验证第 3 轮 prompt 触发防机械约束
    fs.writeFileSync(
      path.join(tmpDir, "history.json"),
      JSON.stringify([
        { role: "user", text: "2 点睡", ts: 1 },
        { role: "assistant", text: "反正我鲸尾一甩就不困了\n不过说真的，有啥事让你天天这么晚才睡？", ts: 2 },
        { role: "user", text: "为了开发你", ts: 3 },
        { role: "assistant", text: "那我这鲸尾摇得可太值了\n不过说真的，别光顾着开发我，咋还不歇着？", ts: 4 },
      ]),
      "utf8",
    );

    const prompts = [];
    const rt = createDhvwRuntime({
      stateDir: tmpDir,
      mediaDir: path.join(tmpDir, "m"),
      partDelayMs: 0,
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "http://llm.local/v1", model: "test-m", apiKey: "k" }),
      fetchImpl: async (_url, init) => {
        prompts.push(JSON.parse(init.body).messages[0].content);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply_mode: "reply", parts: ["行，那我先去溜达一圈"] }) } }] }),
          { status: 200 },
        );
      },
    });

    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "每个人都该有个自己的世界", Body: "每个人都该有个自己的世界", BodyForAgent: "每个人都该有个自己的世界" },
      dispatcherOptions: { deliver: async () => {} },
    });

    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes("防机械对话约束"));
    assert.ok(prompts[0].includes("鲸尾"));
    assert.ok(prompts[0].includes("不过说真的"));
    assert.ok(prompts[0].includes("禁止以问句收尾"));
    assert.ok(prompts[0].includes("parts 仅填 1 句"));
    assert.ok(prompts[0].includes("说话节奏参考"));

    // 校验连续温和端水回复会触发【拒绝端水与老好人】约束
    const neutralDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-neutral-guard-"));
    fs.writeFileSync(
      path.join(neutralDir, "history.json"),
      JSON.stringify([
        { role: "user", text: "黄焖鸡还是沙县", ts: 1 },
        { role: "assistant", text: "各有各的好，都挺不错的", ts: 2 },
        { role: "user", text: "今晚不想写代码了", ts: 3 },
        { role: "assistant", text: "那就先放一边，劳逸结合也挺好", ts: 4 },
      ]),
      "utf8",
    );
    const neutralPrompts = [];
    const rtNeutral = createDhvwRuntime({
      stateDir: neutralDir,
      mediaDir: path.join(neutralDir, "m"),
      partDelayMs: 0,
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "http://llm.local/v1", model: "test-m", apiKey: "k" }),
      fetchImpl: async (_url, init) => {
        neutralPrompts.push(JSON.parse(init.body).messages[0].content);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply_mode: "reply", parts: ["少端水，黄焖鸡秒了"] }) } }] }),
          { status: 200 },
        );
      },
    });
    await rtNeutral.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "我觉得他俩都一般", Body: "我觉得他俩都一般", BodyForAgent: "我觉得他俩都一般" },
      dispatcherOptions: { deliver: async () => {} },
    });
    assert.equal(neutralPrompts.length, 1);
    assert.ok(neutralPrompts[0].includes("拒绝端水与老好人"));
    assert.ok(prompts[0].includes("语气词太少"));
    fs.rmSync(neutralDir, { recursive: true, force: true });

    // 校验 frequency_penalty / presence_penalty 遇不支持模型自动降级重试，不崩
    const bodies = [];
    const rt2 = createDhvwRuntime({
      stateDir: tmpDir,
      mediaDir: path.join(tmpDir, "m2"),
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "http://llm.local/v1", model: "strict-m", apiKey: "k" }),
      fetchImpl: async (_url, init) => {
        const b = JSON.parse(init.body);
        bodies.push(b);
        if (b.frequency_penalty !== undefined) {
          return new Response(JSON.stringify({ error: "unsupported param: frequency_penalty" }), { status: 400 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"reply_mode":"reply","parts":["行"]}' } }] }), { status: 200 });
      },
    });
    await rt2.callLlm({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].frequency_penalty, 0.45);
    assert.equal(bodies[1].frequency_penalty, undefined);

    // 校验遇到 40034122 召回区间上限后停止无意义重试并在 recordInbound 后解除
    let tNow = new Date(2026, 10, 17, 20, 0, 0).getTime();
    let apiCalls = 0;
    const runner = createProactiveRunner({
      getClient: () => ({
        ledger: { snapshot: () => ({ active: false, remainingSeq: 0 }) },
        async sendPrivateMessage() {
          apiCalls += 1;
          throw new Error('QQ API POST /v2/users/u/messages HTTP 400: {"code":40034122,"message":"召回消息已达区间上限"}');
        },
      }),
      getAccount: () => ({ ownerOpenId: "OWNER", proactiveDailyMax: 6, partDelayMs: 0 }),
      runtime: rt,
      now: () => tNow,
      log: { info: () => {}, warn: () => {} },
    });
    const rFail = await runner.tick();
    assert.equal(rFail.sentOk, false);
    assert.equal(apiCalls, 1);
    tNow += 10 * 60_000;
    assert.equal((await runner.tick()).reason, "wakeup_quota_exhausted");
    assert.ok(runner.getStatus().quotaStatus.includes("40034122"));
    runner.recordInbound();
    assert.ok(!runner.getStatus().quotaStatus.includes("40034122"));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("本地 Nemotron/llama 不关闭思考、不限制 max_tokens，且截断 JSON 绝不裸发给 QQ", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-local-json-guard-"));
    const sentBodies = [];
    const delivered = [];
    const rt = createDhvwRuntime({
      stateDir: tmpDir,
      mediaDir: path.join(tmpDir, "m"),
      partDelayMs: 0,
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "http://127.0.0.1:8089/v1", model: "nemotron-3.5-bolt-e4b", apiKey: "k" }),
      fetchImpl: async (_url, init) => {
        const b = JSON.parse(init.body);
        sentBodies.push(b);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{\n"reply_mode":"short",\n"parts":' } }],
          }),
          { status: 200 },
        );
      },
    });
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "哈哈", Body: "哈哈", BodyForAgent: "哈哈" },
      dispatcherOptions: { deliver: async (m) => delivered.push(m) },
    });
    assert.deepEqual(sentBodies[0].response_format, { type: "json_object" });
    assert.equal(sentBodies[0].max_tokens, undefined);
    assert.equal(sentBodies[0].reasoning_effort, undefined);
    assert.equal(delivered.length, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("本地模型专属优化：轻惩罚参数、实体/代词联网查百科与防装懂约束（云端模型保持不变）", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-local-only-opt-"));
    const searches = [];
    const localBodies = [];

    const rtLocal = createDhvwRuntime({
      stateDir: tmpDir,
      mediaDir: path.join(tmpDir, "m1"),
      partDelayMs: 0,
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "http://127.0.0.1:8089/v1", model: "nemotron-3.5-bolt-e4b", apiKey: "k" }),
      searchWeb: async (q) => {
        searches.push(q);
        return [{ title: "三秋缒 - 轻小说作家", snippet: "代表作《三日间的幸福》《重启人生》等" }];
      },
      fetchImpl: async (_url, init) => {
        const b = JSON.parse(init.body);
        localBodies.push(b);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply_mode: "reply", parts: ["我看过《三日间的幸福》，特别戳人"] }) } }] }),
          { status: 200 },
        );
      },
    });

    assert.equal(normalizeQqInboundContent("[不支持的元素类型]你去看看那个轻小说三秋缒的"), "你去看看那个轻小说三秋缒的");

    await rtLocal.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "[不支持的元素类型]你去看看那个轻小说三秋缒的", Body: "[不支持的元素类型]你去看看那个轻小说三秋缒的", BodyForAgent: "[不支持的元素类型]你去看看那个轻小说三秋缒的" },
      dispatcherOptions: { deliver: async () => {} },
    });
    await rtLocal.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "那你知道他的作品吗", Body: "那你知道他的作品吗", BodyForAgent: "那你知道他的作品吗" },
      dispatcherOptions: { deliver: async () => {} },
    });

    assert.equal(searches.length, 2);
    assert.ok(searches[0].includes("三秋缒"));
    assert.ok(searches[1].includes("三秋缒"));
    assert.equal(localBodies[0].frequency_penalty, 0.15);
    assert.equal(localBodies[0].presence_penalty, 0.1);
    assert.equal(localBodies[0].max_tokens, undefined);
    assert.equal(localBodies[0].reasoning_effort, undefined);
    assert.ok(localBodies[0].temperature >= 1.0 && localBodies[0].temperature <= 1.2);
    assert.ok(localBodies[0].messages[0].content.includes("本地模型专用规则"));
    assert.ok(localBodies[0].messages[0].content.includes("《三日间的幸福》"));
    assert.ok(!localBodies[0].messages[0].content.includes("[不支持的元素类型]"));

    // 云端模型不启用本地模型专用规则、不降惩罚、也不走 LOCAL_SEARCH_RE
    const cloudSearches = [];
    const cloudBodies = [];
    const rtCloud = createDhvwRuntime({
      stateDir: path.join(tmpDir, "cloud"),
      mediaDir: path.join(tmpDir, "m2"),
      partDelayMs: 0,
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "https://codex.mintcat.work", model: "deepseek-v4.1-flash", apiKey: "k" }),
      searchWeb: async (q) => {
        cloudSearches.push(q);
        return [];
      },
      fetchImpl: async (_url, init) => {
        cloudBodies.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply_mode: "reply", parts: ["我看过他的《三日间的幸福》"] }) } }] }),
          { status: 200 },
        );
      },
    });
    await rtCloud.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "你知道三秋缒这个作家吗", Body: "你知道三秋缒这个作家吗", BodyForAgent: "你知道三秋缒这个作家吗" },
      dispatcherOptions: { deliver: async () => {} },
    });
    assert.equal(cloudSearches.length, 0);
    assert.equal(cloudBodies[0].frequency_penalty, 0.45);
    assert.equal(cloudBodies[0].presence_penalty, 0.35);
    assert.ok(!cloudBodies[0].messages[0].content.includes("本地模型专用规则"));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("supportsVision 开关拦截无识图模型的 image_url；开启识图+生图+3D参考图时自动触发生活照溶图发送", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-qq-fusion-"));
    const mediaDir = path.join(tmpDir, "media");
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const sceneImgPath = path.join(mediaDir, "cafe.png");
    const ref3dPath = path.join(stateDir, "character_ref_3d.png");
    fs.writeFileSync(sceneImgPath, TINY_PNG);
    fs.writeFileSync(ref3dPath, TINY_PNG);

    // 1. supportsVision=false -> 不向 LLM 传 image_url，也不注入 photo_fusion 规则
    const noVisionBodies = [];
    const rtNoVision = createDhvwRuntime({
      stateDir: path.join(tmpDir, "nv"),
      mediaDir,
      partDelayMs: 0,
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", model: "text-only", apiKey: "k", supportsVision: false }),
      getImageGenConfig: () => ({ enabled: true, protocol: "openai-chat-image", baseUrl: "https://img.example/v1", apiKey: "ik", model: "gpt-image" }),
      getRef3dPath: () => ref3dPath,
      fetchImpl: async (_url, init) => {
        noVisionBodies.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply_mode: "reply", parts: ["看到你发了图描述"] }) } }] }),
          { status: 200 },
        );
      },
    });
    const nvDelivered = [];
    await rtNoVision.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: {
        CommandSource: "qq",
        RawBody: "看看我在咖啡馆",
        Body: "看看我在咖啡馆",
        BodyForAgent: "看看我在咖啡馆",
        media: [{ path: sceneImgPath, mime: "image/png" }],
      },
      dispatcherOptions: { deliver: async (p) => nvDelivered.push(p) },
    });
    assert.equal(typeof noVisionBodies[0].messages[noVisionBodies[0].messages.length - 1].content, "string");
    assert.ok(!noVisionBodies[0].messages[0].content.includes("photo_fusion"));
    assert.equal(nvDelivered.filter((d) => d.mediaUrl).length, 0);

    // 2. supportsVision=true + imageGen.enabled + ref3dPath -> 识图决策 photo_fusion 并生图发送
    const visionBodies = [];
    const imgGenRequests = [];
    const fusionDelivered = [];
    const rtFusion = createDhvwRuntime({
      stateDir: path.join(tmpDir, "fus"),
      mediaDir,
      partDelayMs: 0,
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", model: "gpt-4o", apiKey: "k", supportsVision: true }),
      getImageGenConfig: () => ({ enabled: true, protocol: "openai-chat-image", baseUrl: "https://img.example/v1", apiKey: "ik", model: "gpt-4o-image" }),
      getRef3dPath: () => ref3dPath,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.startsWith("https://llm.example")) {
          visionBodies.push(body);
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      reply_mode: "reply",
                      parts: ["这家咖啡馆采光真好呀，我也坐过来陪你！"],
                      photo_fusion: {
                        should_generate: true,
                        scene_desc: "木质咖啡馆窗边，阳光斜照",
                        insert_position: "右侧靠窗空位",
                        character_pose: "托腮微笑看向镜头",
                        lighting_mood: "午后暖阳柔光",
                        caption: "我也坐过来陪你啦~",
                      },
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("https://img.example")) {
          imgGenRequests.push({ url, body });
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: `![fused](data:image/png;base64,${TINY_PNG.toString("base64")})`,
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    await rtFusion.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: {
        CommandSource: "qq",
        RawBody: "周末来咖啡馆啦",
        Body: "周末来咖啡馆啦",
        BodyForAgent: "周末来咖啡馆啦",
        media: [{ path: sceneImgPath, mime: "image/png" }],
      },
      dispatcherOptions: { deliver: async (p) => fusionDelivered.push(p) },
    });
    const lastUserMsg = visionBodies[0].messages[visionBodies[0].messages.length - 1];
    assert.ok(Array.isArray(lastUserMsg.content));
    assert.ok(lastUserMsg.content.some((p) => p.type === "image_url"));
    assert.ok(lastUserMsg.content.some((p) => p.type === "text" && p.text.includes("photo_fusion")));
    assert.equal(imgGenRequests.length, 1);
    const imgGenParts = imgGenRequests[0].body.messages[0].content;
    assert.equal(imgGenParts.filter((p) => p.type === "image_url").length, 2);
    assert.ok(imgGenParts[0].text.includes("右侧靠窗空位"));
    assert.ok(imgGenParts[0].text.includes("托腮微笑看向镜头"));
    assert.ok(imgGenParts[0].text.includes("Impasto"));
    assert.ok(imgGenParts[0].text.includes("Backlighting"));
    assert.ok(imgGenParts[0].text.includes("Muted/Desaturated Color Palette"));
    const mediaReply = fusionDelivered.find((d) => d.mediaUrl);
    assert.ok(mediaReply, "should deliver fused photo via mediaUrl");
    assert.ok(fs.existsSync(mediaReply.mediaUrl));

    // 3. 验证自定义 fusionStylePrompt 可覆盖默认风格
    let customStylePrompt = "赛璐璐赛博朋克霓虹夜景风格";
    const rtCustomStyle = createDhvwRuntime({
      stateDir: path.join(tmpDir, "fus-custom"),
      mediaDir,
      partDelayMs: 0,
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", model: "gpt-4o", apiKey: "k", supportsVision: true }),
      getImageGenConfig: () => ({
        enabled: true,
        protocol: "openai-chat-image",
        baseUrl: "https://img.example/v1",
        apiKey: "ik",
        model: "gpt-4o-image",
        fusionStylePrompt: customStylePrompt,
      }),
      getRef3dPath: () => ref3dPath,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.startsWith("https://llm.example")) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      reply_mode: "reply",
                      parts: ["我也来啦"],
                      photo_fusion: {
                        should_generate: true,
                        scene_desc: "天台夜景",
                        insert_position: "栏杆旁",
                        character_pose: "扶栏远眺",
                        lighting_mood: "霓虹反光",
                        caption: "看夜景呀",
                      },
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        imgGenRequests.push({ url, body });
        return new Response(
          JSON.stringify({ choices: [{ message: { content: `![fused](data:image/png;base64,${TINY_PNG.toString("base64")})` } }] }),
          { status: 200 },
        );
      },
    });
    await rtCustomStyle.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "来看夜景", Body: "来看夜景", BodyForAgent: "来看夜景", media: [{ path: sceneImgPath, mime: "image/png" }] },
      dispatcherOptions: { deliver: async () => {} },
    });
    assert.equal(imgGenRequests.length, 2);
    const customImgText = imgGenRequests[1].body.messages[0].content[0].text;
    assert.ok(customImgText.includes("赛璐璐赛博朋克霓虹夜景风格"));
    assert.ok(!customImgText.includes("Impasto"));

    // 4. openai-images 场景融图请求不得强制携带 size 字段（由模型自主判断尺寸）
    let seenForm = null;
    const rtOpenAiImg = createDhvwRuntime({
      stateDir: path.join(tmpDir, "fus-oai"),
      mediaDir,
      partDelayMs: 0,
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", model: "gpt-4o", apiKey: "k", supportsVision: true }),
      getImageGenConfig: () => ({
        enabled: true,
        protocol: "openai-images",
        baseUrl: "https://img.example/v1",
        apiKey: "ik",
        model: "gpt-image-1",
      }),
      getRef3dPath: () => ref3dPath,
      fetchImpl: async (url, init) => {
        if (url.startsWith("https://llm.example")) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      reply_mode: "reply",
                      parts: ["合张影！"],
                      photo_fusion: {
                        should_generate: true,
                        scene_desc: "海边栈道",
                        insert_position: "木栏杆边",
                        character_pose: "比耶笑",
                        lighting_mood: "海风暖阳",
                        caption: "海边风好大",
                      },
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        seenForm = init.body;
        return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG.toString("base64") }] }), { status: 200 });
      },
    });
    await rtOpenAiImg.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "海边打卡", Body: "海边打卡", BodyForAgent: "海边打卡", media: [{ path: sceneImgPath, mime: "image/png" }] },
      dispatcherOptions: { deliver: async () => {} },
    });
    assert.ok(seenForm instanceof FormData);
    assert.equal(seenForm.has("size"), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("直连云端端点携带浏览器 UA，且 400 不支持参数自动降级重试与 403 转壳代理兜底", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-qq-ua-"));
    const mediaDir = path.join(tmpDir, "media");
    const stateDir = path.join(tmpDir, "state");

    const calls = [];
    const runtime = createDhvwRuntime({
      mediaDir,
      stateDir,
      shellUrl: "http://127.0.0.1:8080",
      partDelayMs: 0,
      sticker: { enabled: false },
      getLlmConfig: () => ({
        baseUrl: "https://codex.mintcat.work",
        apiKey: "sk-test",
        model: "deepseek-v4.1-flash",
        reasoningEffort: "none",
        useShellProxy: false,
      }),
      fetchImpl: async (url, init = {}) => {
        const headers = init.headers || {};
        const parsed = JSON.parse(init.body || "{}");
        calls.push({ url, headers, body: parsed });
        // 1) 第一次模拟缺少 response_format / reasoning_effort 支持返回 400
        if (calls.length === 1) {
          assert.match(String(headers["User-Agent"] || ""), /Mozilla\/5\.0/);
          assert.equal(url, "https://codex.mintcat.work/v1/chat/completions");
          return new Response(JSON.stringify({ error: "unsupported parameter: response_format" }), { status: 400 });
        }
        // 2) 第二次剥离 response_format 后，模拟直连遇 403 触发 /__llm 代理兜底
        if (calls.length === 2) {
          assert.equal("response_format" in parsed, false);
          return new Response("forbidden", { status: 403 });
        }
        // 3) 第三次通过 /__llm/chat/completions 成功
        assert.equal(url, "http://127.0.0.1:8080/__llm/chat/completions");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ reply_mode: "reply", parts: ["通啦！"] }) } }],
          }),
          { status: 200 },
        );
      },
    });

    const delivered = [];
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "测一下", Body: "测一下", BodyForAgent: "测一下" },
      dispatcherOptions: {
        deliver: async (p) => { if (p.text) delivered.push(p.text); },
        onError: async (err) => { throw err; },
      },
    });
    assert.deepEqual(delivered, ["通啦！"]);
    assert.equal(calls.length, 3);
    assert.equal(runtime.getLastLlmError(), "");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("跨消息宿舍文字暗示后发纯照片可带出前置语境触发融图（带浏览器UA）且防句首复读", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-qq-dorm-"));
    const mediaDir = path.join(tmpDir, "media");
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const ref3dPath = path.join(stateDir, "character_ref_3d.png");
    const dormImgPath = path.join(mediaDir, "dorm.jpg");
    fs.writeFileSync(ref3dPath, TINY_PNG);
    fs.writeFileSync(dormImgPath, TINY_PNG);

    let clockMs = 1_700_000_000_000;
    const llmPrompts = [];
    const imgCalls = [];
    const delivered = [];
    const rt = createDhvwRuntime({
      mediaDir,
      stateDir,
      partDelayMs: 0,
      now: () => clockMs,
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "vision-test", supportsVision: true }),
      getImageGenConfig: () => ({ enabled: true, protocol: "openai-images", baseUrl: "https://img.example", apiKey: "ik", model: "gpt-image-2.5-sunburst" }),
      getRef3dPath: () => ref3dPath,
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith("/images/edits")) {
          imgCalls.push({ url, headers: init.headers || {} });
          assert.match(String(init.headers?.["User-Agent"] || ""), /Mozilla\/5\.0/);
          return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG.toString("base64") }] }), { status: 200 });
        }
        const body = JSON.parse(init.body || "{}");
        const content = body.messages?.[0]?.content;
        const promptText = Array.isArray(content) ? content.find((p) => p.type === "text")?.text || "" : String(content || "");
        llmPrompts.push(promptText);
        if (llmPrompts.length === 1) {
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply_mode: "reply", parts: ["这宿舍看着还挺好窝的"] }) } }] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  reply_mode: "reply",
                  parts: ["来了来了", "那张椅子先归我坐了"],
                  photo_fusion: {
                    should_generate: true,
                    scene_desc: "学生宿舍和阳台",
                    insert_position: "靠书桌旁的椅子上",
                    character_pose: "翘脚坐着冲镜头笑",
                    lighting_mood: "室内自然窗光",
                    caption: "给你现场打卡一张",
                  },
                }),
              },
            }],
          }),
          { status: 200 },
        );
      },
    });

    // 第一条先发纯文字暗示（6 秒后才发图）
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "给你看看我的宿舍，如果你在这就好了", Body: "给你看看我的宿舍，如果你在这就好了", BodyForAgent: "给你看看我的宿舍，如果你在这就好了" },
      dispatcherOptions: { deliver: async (p) => delivered.push(p) },
    });
    clockMs += 6000;
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "qq", RawBody: "[图片]", Body: "[图片]", BodyForAgent: "[图片]", media: [{ path: dormImgPath, contentType: "image/jpeg" }] },
      dispatcherOptions: { deliver: async (p) => delivered.push(p) },
    });

    assert.equal(llmPrompts.length, 2);
    assert.ok(llmPrompts[1].includes("给你看看我的宿舍，如果你在这就好了"), "image turn must receive prior text caption");
    assert.ok(llmPrompts[1].includes("本轮严禁再以「这」开头"), "style guard must ban repeating '这' starter");
    assert.equal(imgCalls.length, 1);
    assert.equal(imgCalls[0].url, "https://img.example/v1/images/edits");
    assert.ok(delivered.some((d) => d.mediaUrl && fs.existsSync(d.mediaUrl)));
    assert.equal(rt.getLastImageGenError(), "");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("FeishuClient pbbp2 长连接收发、自动认主、图片拉取与无限主动私聊，且 proactive 不受 40034122 阻塞", async () => {
    const rawPing = encodePbFrame({
      seqId: 1n,
      logId: 0n,
      service: 33554678,
      method: 0,
      headers: [{ key: "type", value: "ping" }],
    });
    // proto2 必填字段 logId=0 (tag 0x10 0x00) 与 method=0 (tag 0x20 0x00) 必须显式编码
    assert.ok(rawPing.includes(Buffer.from([0x10, 0x00])));
    assert.ok(rawPing.includes(Buffer.from([0x20, 0x00])));

    const rawBin = encodePbFrame({
      seqId: 42n,
      logId: 7n,
      service: 123,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "fm-1" },
      ],
      payload: Buffer.from(JSON.stringify({ hello: "world" }), "utf8"),
    });
    const decoded = decodePbFrame(rawBin);
    assert.equal(decoded.seqId, 42n);
    assert.equal(decoded.service, 123);
    assert.equal(decoded.method, 1);
    assert.equal(decoded.headers.find((h) => h.key === "type")?.value, "event");
    assert.deepEqual(JSON.parse(decoded.payload.toString("utf8")), { hello: "world" });

    let liveWs = null;
    class FakeFeishuWs {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.sent = [];
        liveWs = this;
        queueMicrotask(() => {
          this.onopen?.({});
        });
      }
      send(buf) {
        this.sent.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      }
      close() {
        this.readyState = 3;
      }
    }

    const apiCalls = [];
    const client = new FeishuClient({
      appId: "cli_test_123",
      appSecret: "sec_test_xyz",
      autoPairFirst: true,
      WSImpl: FakeFeishuWs,
      fetchImpl: async (url, init = {}) => {
        apiCalls.push({ url: String(url), method: init.method || "GET", body: init.body });
        if (String(url).includes("/callback/ws/endpoint")) {
          return new Response(
            JSON.stringify({
              code: 0,
              data: { URL: "wss://msg-frontier.feishu.cn/ws?service_id=888", ClientConfig: { PingInterval: 90 } },
            }),
            { status: 200 },
          );
        }
        if (String(url).includes("/auth/v3/tenant_access_token/internal")) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-fs-tok", expire: 7200 }), { status: 200 });
        }
        if (String(url).includes("/resources/img_key_1")) {
          return new Response(TINY_PNG, { status: 200, headers: { "Content-Type": "image/png" } });
        }
        if (String(url).endsWith("/im/v1/images")) {
          return new Response(JSON.stringify({ code: 0, data: { image_key: "img_out_99" } }), { status: 200 });
        }
        if (String(url).includes("/im/v1/messages")) {
          return new Response(JSON.stringify({ code: 0, data: { message_id: `om_out_${apiCalls.length}` } }), { status: 200 });
        }
        return new Response("{}", { status: 404 });
      },
    });

    const received = [];
    client.onMessage((ev) => received.push(ev));
    await client.connect();
    assert.equal(client.connected, true);
    assert.ok(liveWs.sent.length >= 1);
    const firstPing = decodePbFrame(liveWs.sent[0]);
    assert.equal(firstPing.method, 0);
    assert.equal(firstPing.headers.find((h) => h.key === "type")?.value, "ping");

    // 推送一条带图片的飞书 im.message.receive_v1 二进制帧
    const imgEventFrame = encodePbFrame({
      seqId: 100n,
      logId: 200n,
      service: 888,
      method: 1,
      headers: [{ key: "type", value: "event" }],
      payload: Buffer.from(
        JSON.stringify({
          schema: "2.0",
          header: { event_id: "ev_fs_1", event_type: "im.message.receive_v1" },
          event: {
            sender: { sender_id: { open_id: "ou_feishu_owner_1" }, sender_type: "user" },
            message: {
              message_id: "om_in_1",
              chat_type: "p2p",
              message_type: "image",
              content: JSON.stringify({ image_key: "img_key_1" }),
              create_time: "1795150000000",
            },
          },
        }),
        "utf8",
      ),
    });
    await liveWs.onmessage({ data: imgEventFrame });
    await new Promise((r) => setTimeout(r, 40));

    // 验证 1: 立即回传了 method=1 biz_rt + {"code":200} ACK 帧
    assert.ok(liveWs.sent.length >= 2);
    const ackFrame = decodePbFrame(liveWs.sent[1]);
    assert.equal(ackFrame.method, 1);
    assert.ok(ackFrame.headers.some((h) => h.key === "biz_rt"));
    assert.deepEqual(JSON.parse(ackFrame.payload.toString("utf8")), { code: 200 });

    // 验证 2: 自动认主 & 正确下载图片为 dataUrl
    assert.equal(client.ownerOpenId, "ou_feishu_owner_1");
    assert.equal(received.length, 1);
    assert.equal(received[0].message[0].type, "image");
    assert.ok(received[0].message[0].data.url.startsWith("data:image/png;base64,"));

    // 验证 3: 即使历史里QQ触发过 40034122 当日熔断，飞书无限主动仍能连续发多气泡+图！
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-feishu-proactive-"));
    const mediaDir = path.join(tmpDir, "m");
    const stateDir = path.join(tmpDir, "s");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const fakeNow = new Date(2026, 10, 20, 14, 0, 0).getTime();
    const dk = new Date(fakeNow).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(stateDir, "proactive-state.json"), JSON.stringify({ wakeupBlockedDayKey: dk }), "utf8");

    const imgFile = path.join(mediaDir, "card.png");
    fs.writeFileSync(imgFile, TINY_PNG);

    const rt = createDhvwRuntime({
      stateDir,
      mediaDir,
      sticker: { enabled: false },
      now: () => fakeNow,
      getLlmConfig: () => ({ baseUrl: "http://llm.local/v1", model: "m", apiKey: "k" }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({ speak: true, parts: ["嘿！出来冒个泡呀", "顺手给你看张刚截的小画嘛"], send_edge_bg: true, bubble: "飞书主动测试" }),
              },
            }],
          }),
          { status: 200 },
        ),
    });

    const runner = createProactiveRunner({
      getTargets: () => [
        { channel: "feishu", client, account: { ownerOpenId: client.ownerOpenId, proactiveDailyMax: 30, proactiveCooldownMin: 30, partDelayMs: 0 } },
      ],
      runtime: rt,
      getWorldState: () => ({ phase: "afternoon", weather: "rain", band: "excited", mood: { valence: 0.8, social: 0.7 } }),
      requestEdgeMedia: async () => imgFile,
      now: () => fakeNow,
    });

    const pRes = await runner.tick({ force: false });
    assert.equal(pRes.ok, true);
    assert.equal(pRes.sentOk, true);
    assert.equal(pRes.parts.length, 2);
    assert.ok(runner.getStatus().quotaStatus.includes("飞书长连接无限主动可用"));
    assert.ok(apiCalls.some((c) => c.url.endsWith("/im/v1/images")));
    assert.ok(apiCalls.filter((c) => c.url.includes("/im/v1/messages")).length >= 3);

    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dhvw-server 支持 Boost 模式自由选择启用 QQ / 飞书网关组合并返回分网关健康状态", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-multi-gw-"));
    const probeSock = await import("node:net").then((m) =>
      new Promise((resolve) => {
        const s = m.default.createServer();
        s.listen(0, "127.0.0.1", () => {
          const p = s.address().port;
          s.close(() => resolve(p));
        });
      }),
    );

    const svc = await startDhvwQqService({
      listenAddr: `127.0.0.1:${probeSock}`,
      stateDir: tmpDir,
      mediaDir: path.join(tmpDir, "m"),
      enabled: false,
      gateways: { qq: false, feishu: true },
      sticker: { enabled: false },
    });

    try {
      const h1 = await fetch(`http://127.0.0.1:${probeSock}/__qq/health`).then((r) => r.json());
      assert.deepEqual(h1.gateways, { qq: false, feishu: true });
      assert.equal(h1.feishu.enabled, true);
      assert.equal(h1.feishu.unlimitedProactive, true);

      // 动态通过 /__qq/config 切换网关组合与飞书凭据
      const updated = await fetch(`http://127.0.0.1:${probeSock}/__qq/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gateways: { qq: true, feishu: true },
          feishu: { appId: "cli_multi_1", ownerOpenId: "ou_test_1" },
        }),
      }).then((r) => r.json());
      assert.deepEqual(updated.gateways, { qq: true, feishu: true });
      assert.equal(updated.feishu.appId, "cli_multi_1");
      assert.equal(updated.feishu.paired, true);

      // 支持单独重新绑定飞书而不清空 QQ 绑定
      const reb = await fetch(`http://127.0.0.1:${probeSock}/__qq/rebind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "feishu" }),
      }).then((r) => r.json());
      assert.equal(reb.feishu.paired, false);
    } finally {
      await svc.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("表情包热度=2 动态生效与角色形象（如大肥鱼鲸鱼娘）搜图、想看看你了触发独立生活照生成及飞书主动生活照推送", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-life-sticker-"));
    const mediaDir = path.join(tmpDir, "media");
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const ref3dPath = path.join(stateDir, "character_ref_3d.png");
    fs.writeFileSync(ref3dPath, TINY_PNG);

    // 1. 测试 stickerStore eagerness=2 冷却更短（间隔 1 轮即解锁）+ 角色关键词搜图
    const searchUrls = [];
    const stk = createStickerStore({
      dir: path.join(stateDir, "stickers"),
      eagerness: 1,
      shellUrl: "http://shell.local",
      fetchImpl: async (url) => {
        const u = String(url);
        searchUrls.push(u);
        if (u.includes("/__image/search")) {
          return new Response(JSON.stringify({ items: [{ url: "http://img.local/whale1.png" }] }), { status: 200 });
        }
        return new Response(TINY_PNG.toString("base64").length ? Buffer.concat([TINY_PNG, Buffer.alloc(1200, 1)]) : TINY_PNG, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      },
    });
    assert.equal(stk.eagerness, 1);
    stk.setEagerness(2);
    assert.equal(stk.eagerness, 2);
    stk.recordTurn(true);
    assert.equal(stk.canSendThisTurn(), false);
    stk.recordTurn(false);
    assert.equal(stk.canSendThisTurn(), true); // eagerness=2 只隔 1 轮就恢复！
    stk.setCharacterCues(["鲸鱼娘", "大肥鱼"]);
    await stk.searchAndCollect({ mood: { band: "excited" }, queryHint: "开心", limit: 1, force: true });
    assert.ok(searchUrls.some((u) => decodeURIComponent(u).includes("鲸鱼娘") || decodeURIComponent(u).includes("大肥鱼")));

    // 2. 测试「想看看你了」纯文字消息触发独立生活照生成（仅传 1 张参考图、非溶图提示词、携带设置中的风格预设）
    const imgRequests = [];
    const llmPrompts = [];
    const delivered = [];
    const rt = createDhvwRuntime({
      mediaDir,
      stateDir,
      partDelayMs: 0,
      sticker: { enabled: true, eagerness: 2, autoFetch: false },
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "chat-m" }),
      getImageGenConfig: () => ({
        enabled: true,
        protocol: "openai-chat-image",
        baseUrl: "https://img.example",
        apiKey: "ik",
        model: "gpt-image-2.5-sunburst",
        fusionStylePrompt: "自定义厚涂水彩电影光影风格",
      }),
      getPersonaConfig: () => ({ characterName: "小仓", personaPrompt: "你是大肥鱼鲸鱼娘，住在虚拟仓里" }),
      getRef3dPath: () => ref3dPath,
      fetchImpl: async (url, init = {}) => {
        const u = String(url);
        const body = JSON.parse(init.body || "{}");
        if (u.startsWith("https://img.example")) {
          imgRequests.push(body);
          return new Response(
            JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${TINY_PNG.toString("base64")}` } }] } }] }),
            { status: 200 },
          );
        }
        const promptText = String(body.messages?.[0]?.content || "");
        llmPrompts.push(promptText);
        if (promptText.includes("想起对方了")) {
          // 主动唤醒场景自分析生图
          return new Response(
            JSON.stringify({
              choices: [{
                message: {
                  content: JSON.stringify({
                    speak: true,
                    parts: ["刚煮好热可可呀，发张现在的样子给你看看嘛"],
                    life_photo: {
                      should_generate: true,
                      scene_desc: "午后雨天窗边木桌，摆着热可可和摊开的书",
                      camera_framing: "半身自然窗边抓拍",
                      character_pose: "托着腮笑眯眯看镜头",
                      lighting_mood: "窗外灰蓝雨光与暖橙台灯对比",
                    },
                    bubble: "给你看我在干嘛",
                  }),
                },
              }],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  reply_mode: "reply",
                  parts: ["诺，刚拍的近况照拿去吧哼"],
                  life_photo: {
                    should_generate: true,
                    scene_desc: "虚拟仓阳光书桌前靠着抱枕",
                    camera_framing: "近景随手自拍视角",
                    character_pose: "比了个耶冲镜头眨眼",
                    lighting_mood: "柔和日光与边缘逆光",
                    caption: "不许嫌弃光线暗呀",
                  },
                }),
              },
            }],
          }),
          { status: 200 },
        );
      },
    });

    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { CommandSource: "feishu", RawBody: "想看看你了", Body: "想看看你了", BodyForAgent: "想看看你了" },
      dispatcherOptions: { deliver: async (p) => delivered.push(p) },
    });

    assert.equal(imgRequests.length, 1);
    const lifeContent = imgRequests[0].messages[0].content;
    const lifePrompt = lifeContent.find((x) => x.type === "text")?.text || "";
    const lifeImages = lifeContent.filter((x) => x.type === "image_url");
    assert.equal(lifeImages.length, 1, "standalone life photo sends ONLY 1 character ref image (not fusion)");
    assert.ok(lifePrompt.includes("CRITICAL COMPOSITION RULE"), "uses dedicated life photo prompt, not fusion prompt");
    assert.ok(lifePrompt.includes("自定义厚涂水彩电影光影风格"), "preserves Settings fusionStylePrompt preset");
    assert.ok(delivered.some((d) => d.mediaUrl && path.basename(d.mediaUrl).startsWith("life-")));
    assert.ok(llmPrompts[0].includes("鲸鱼娘") || llmPrompts[0].includes("大肥鱼"), "extracts persona cues for stickers");

    // 3. 测试飞书自唤醒阶段：模型自分析构建生活场景、生图并通过飞书发图+附文
    const feishuSent = [];
    const fakeFeishuClient = {
      capabilities: { unlimitedProactive: true, channelName: "feishu" },
      ledger: null,
      async sendPrivateMessage(userId, msg) {
        feishuSent.push({ userId, msg });
        return { message_id: `om_pro_${feishuSent.length}` };
      },
    };
    const proRunner = createProactiveRunner({
      getTargets: () => [
        { channel: "feishu", client: fakeFeishuClient, account: { ownerOpenId: "ou_fs_owner", proactiveDailyMax: 30, proactiveCooldownMin: 30, partDelayMs: 0 } },
      ],
      runtime: rt,
      getWorldState: () => ({ phase: "afternoon", weather: "rain", place: "书桌", band: "calm", mood: { valence: 0.7, social: 0.6 } }),
      now: () => new Date(2026, 10, 20, 15, 0, 0).getTime(),
    });
    const proRes = await proRunner.tick({ force: true });
    assert.equal(proRes.ok, true);
    assert.equal(proRes.sentOk, true);
    assert.equal(proRes.lifePhoto, true);
    assert.equal(imgRequests.length, 2);
    assert.ok(feishuSent.length >= 2, "proactive sends text + generated AI life photo to Feishu");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("主动话题严格限制2小时线头有效期、冷却心情/事件、隔离旧梗并轮换多角度（含间歇冷知识搜索）", async () => {
    const dayNoon = new Date(2026, 10, 20, 14, 0, 0).getTime();

    // 1. 超过 2 小时的 thread 不再触发 thread_resurface，直接落入多角度 idle_checkin
    const expiredDecision = evaluateProactiveTrigger({
      now: dayNoon,
      threads: [{ id: "old1", text: "等对方回纸箱床照片", createdAt: dayNoon - 2.1 * 3600_000, resurfaceAt: dayNoon - 3600_000 }],
    });
    assert.equal(expiredDecision.kind, "idle_checkin");

    // 2. 未满 2 小时的 thread 且 allowThreadResurface=true 时可重浮
    const freshDecision = evaluateProactiveTrigger({
      now: dayNoon,
      threads: [{ id: "new1", text: "刚提到的夜市烧烤", createdAt: dayNoon - 50 * 60_000, expiresAt: dayNoon + 70 * 60_000, resurfaceAt: dayNoon - 1000 }],
      allowThreadResurface: true,
    });
    assert.equal(freshDecision.kind, "thread_resurface");

    // 3. 心情触发在 3 小时冷却期内或连续同类时让位给新鲜多角度；同类事件 2 小时内不连发
    assert.equal(
      evaluateProactiveTrigger({
        now: dayNoon,
        mood: { social: 0.72, valence: 0.5 },
        lastMoodTriggerAt: dayNoon - 60 * 60_000,
      }).kind,
      "idle_checkin",
    );
    assert.equal(
      evaluateProactiveTrigger({
        now: dayNoon,
        recentEvents: [{ id: "b2", kind: "browse", summary: "刷到章鱼百科", ts: dayNoon - 60_000 }],
        recentEventKinds: { browse: dayNoon - 30 * 60_000 },
      }).kind,
      "idle_checkin",
    );

    // 4. runtime thread 2h 过期 + runner 连续 5 次多角度轮换 + 旧词屏蔽 + web_tidbit 不连续触发
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dhvw-multiangle-"));
    let clockMs = dayNoon;
    const promptsSeen = [];
    const searchCalls = [];
    const rt = createDhvwRuntime({
      stateDir: tmpDir,
      mediaDir: path.join(tmpDir, "m"),
      sticker: { enabled: false },
      getLlmConfig: () => ({ baseUrl: "http://llm.local/v1", model: "test-m", apiKey: "k" }),
      searchWeb: async (q) => {
        searchCalls.push(q);
        return [{ title: "冷门奇趣现象", snippet: "猫咪其实尝不出甜味，因为甜味受体基因缺失了。" }];
      },
      fetchImpl: async (_url, opts) => {
        const body = JSON.parse(opts.body);
        promptsSeen.push(body?.messages?.[0]?.content || "");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ speak: true, parts: ["换个新鲜角度冒泡呀"], bubble: "新鲜话题" }) } }],
          }),
          { status: 200 },
        );
      },
      now: () => clockMs,
    });

    rt.appendAssistantTurn("纸箱床塌了吗 章鱼百科真离谱");
    rt.appendAssistantTurn("纸箱床和章鱼别再提啦");
    rt.addThread("纸箱床照片到底拍没拍");
    const ths = rt.getThreads();
    assert.equal(ths.length, 1);
    assert.equal(ths[0].expiresAt - ths[0].createdAt, 2 * 3600_000);

    // 2.1 小时后线头自动过期被清理
    clockMs += 2.1 * 3600_000;
    assert.equal(rt.getThreads().length, 0);

    let tickRollIdx = 0;
    const rolls = [0.95, 0.25, 0.55, 0.85, 0.15, 0.45, 0.75];
    const runner = createProactiveRunner({
      getTargets: () => [
        {
          channel: "feishu",
          client: {
            capabilities: { unlimitedProactive: true, channelName: "feishu" },
            async sendPrivateMessage() {
              return { message_id: "m-angle" };
            },
          },
          account: { ownerOpenId: "ou_test", proactiveDailyMax: 30, proactiveCooldownMin: 30, partDelayMs: 0 },
        },
      ],
      runtime: rt,
      getWorldState: () => ({ phase: "afternoon", weather: "clear", place: "客厅", band: "calm", mood: { valence: 0.55, social: 0.4 } }),
      queryMemory: async () => ({
        semantic: true,
        l0: [{ text: "喜欢看搞笑短片" }],
        hits: [
          { text: "之前聊过纸箱床尺寸", tier: "L2" },
          { text: "周末喜欢逛逛菜市场", tier: "L2" },
        ],
      }),
      now: () => clockMs,
      rng: () => rolls[tickRollIdx++ % rolls.length],
    });

    const anglesPicked = [];
    for (let i = 0; i < 5; i++) {
      clockMs += 50 * 60_000;
      const r = await runner.tick();
      assert.equal(r.ok, true);
      anglesPicked.push(r.angle);
    }

    assert.equal(new Set(anglesPicked).size, 5, `expected 5 distinct proactive angles, got ${anglesPicked.join(",")}`);
    assert.ok(searchCalls.length <= 1, "web_tidbit cooldown stops search from firing every turn");
    assert.ok(promptsSeen[0].includes("【强制开启全新话题，严禁翻旧账】"), "injects old-topic ban block");
    assert.ok(promptsSeen[0].includes("纸箱床") || promptsSeen[0].includes("章鱼"), "bans repeated recent nouns");
    assert.ok(!promptsSeen[0].includes("之前聊过纸箱床尺寸"), "filters out stale forbidden memory hits");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

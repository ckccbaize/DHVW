import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { QQOfficialClient, MsgDedupRing, WindowLedger, normalizeQqInboundContent } from "../dist/src/qq-official-client.js";
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
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "vision-test" }),
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
      getLlmConfig: () => ({ baseUrl: "https://llm.example/v1", model: "vision" }),
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
});

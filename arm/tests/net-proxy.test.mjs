import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isPrivateIp,
  validateSafePublicUrl,
  parseBingWebResults,
  parseBingImageResults,
  createNetProxy,
} from "../tools/net-proxy.mjs";

function makeMockRes() {
  const out = { status: 0, headers: {}, body: "" };
  return {
    out,
    writeHead(status, headers = {}) {
      out.status = status;
      out.headers = headers;
      return this;
    },
    end(chunk = "") {
      out.body = Buffer.isBuffer(chunk) ? chunk : String(chunk);
    },
  };
}

describe("net-proxy 开发壳联网/图搜路由", () => {
  it("SSRF 校验：拒绝回环/内网 IP 与非法协议，放行公网", async () => {
    assert.equal(isPrivateIp("127.0.0.1"), true);
    assert.equal(isPrivateIp("192.168.1.5"), true);
    assert.equal(isPrivateIp("10.0.0.1"), true);
    assert.equal(isPrivateIp("93.184.216.34"), false);

    assert.equal((await validateSafePublicUrl("http://127.0.0.1:8080/a")).ok, false);
    assert.equal((await validateSafePublicUrl("file:///etc/passwd")).ok, false);
    const pub = await validateSafePublicUrl("https://example.com/page", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    assert.equal(pub.ok, true);
  });

  it("解析 Bing 网页结果与图片结果并响应 /__search、/__image/search", async () => {
    const webHtml = `<li class="b_algo"><h2><a href="https://example.com/news">今日热讯</a></h2><p>摘要内容</p></li>`;
    const webItems = parseBingWebResults(webHtml, 5);
    assert.equal(webItems.length, 1);
    assert.equal(webItems[0].title, "今日热讯");

    const imgHtml = `murl&quot;:&quot;https://img.example.com/cat.jpg&quot; turl&quot;:&quot;https://th.example.com/cat_t.jpg&quot;`;
    const imgItems = parseBingImageResults(imgHtml, 6);
    assert.equal(imgItems.length, 1);
    assert.equal(imgItems[0].url, "https://img.example.com/cat.jpg");
    assert.equal(imgItems[0].thumb, "https://th.example.com/cat_t.jpg");

    const proxy = createNetProxy({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (url) => {
        if (url.includes("/images/search")) return new Response(imgHtml, { status: 200 });
        if (url.includes("/search")) return new Response(webHtml, { status: 200 });
        return new Response("<html><title>示例页</title><body><p>正文测试内容</p></body></html>", { status: 200 });
      },
    });

    const r1 = makeMockRes();
    const handled1 = await proxy.handle({ method: "GET", url: "/__search?q=猫&n=3" }, r1, "/__search");
    assert.equal(handled1, true);
    assert.equal(r1.out.status, 200);
    assert.equal(JSON.parse(r1.out.body).results[0].url, "https://example.com/news");

    const r2 = makeMockRes();
    await proxy.handle({ method: "GET", url: "/__image/search?q=表情包&n=4" }, r2, "/__image/search");
    assert.equal(r2.out.status, 200);
    assert.equal(JSON.parse(r2.out.body).source, "bing");
    assert.equal(JSON.parse(r2.out.body).items[0].thumb, "https://th.example.com/cat_t.jpg");

    const r3 = makeMockRes();
    await proxy.handle({ method: "GET", url: "/__fetch?url=https%3A%2F%2Fexample.com%2Fnews" }, r3, "/__fetch");
    assert.equal(r3.out.status, 200);
    assert.equal(JSON.parse(r3.out.body).title, "示例页");
  });
});

// 开发用静态服务：路径规则与 shell/main.go 保持一致（MIME / 缓存 / SPA 回退 / 无目录列表）。
// 设备上跑的是 Go 壳，这里只用于本机验证与浏览器实测。
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createNetProxy } from "./net-proxy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "www");
const EXPLICIT_PORT = Boolean(process.env.PORT);
const PORT = Number(process.env.PORT || 8080);
const FALLBACK_PORT = 18080;
const HOST = process.env.HOST || "127.0.0.1";
const HOST_FILE = path.resolve(ROOT, "..", "data", "host.json");
const DEFAULT_WS_URL = process.env.DHVW_HOST_WS || "ws://127.0.0.1:8877/dhvw";
const netProxy = createNetProxy();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// 开发服务一律 no-cache：生产壳（shell/main.go）才对 /js/、/assets/ 发 immutable。
// 否则改完模块刷新页面仍拿旧文件，排查成本极高。
const cacheControl = () => "no-cache";

function resolve(urlPath) {
  const clean = path.posix.normalize("/" + urlPath);
  const fsPath = path.join(ROOT, clean);
  const rel = path.relative(ROOT, fsPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return { fsPath, clean };
}

async function sendFile(req, res, urlPath, fsPath) {
  const st = await fsp.stat(fsPath);
  const etag = `W/"${st.size}-${st.mtimeMs}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", cacheControl(urlPath));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", MIME[path.extname(fsPath).toLowerCase()] || "application/octet-stream");
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304).end();
    return;
  }
  res.setHeader("Content-Length", st.size);
  if (req.method === "HEAD") return void res.writeHead(200).end();
  fs.createReadStream(fsPath).pipe(res);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { code: "too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const CA_FILE = path.resolve(ROOT, "..", "data", "ca.crt.pem");

/** 二进制请求体（录像上传用；readBody 会按 utf8 解码，不能拿来收 webm）。 */
function readBuffer(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { code: "too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function postJsonUpstream(targetUrl, headers, payloadText) {
  const u = new URL(targetUrl);
  const mod = u.protocol === "https:" ? https : http;
  const ca = u.protocol === "https:" && fs.existsSync(CA_FILE) ? fs.readFileSync(CA_FILE) : undefined;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(payloadText) },
        ...(ca ? { ca } : {}),
        timeout: 120_000,
      },
      (up) => {
        const chunks = [];
        let size = 0;
        up.on("data", (c) => {
          if (size < 4 << 20) {
            chunks.push(c);
            size += c.length;
          }
        });
        up.on("end", () => {
          resolve({
            status: up.statusCode || 502,
            contentType: up.headers["content-type"] || "application/json",
            text: Buffer.concat(chunks).toString("utf8").slice(0, 4 << 20),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payloadText);
  });
}

// 开发环境等价于 Go 壳的 /__llm 代理：页面同源请求，服务端转发到服务商。
async function proxyLlm(req, res) {
  if (req.method !== "POST") {
    return void res.writeHead(405, { Allow: "POST" }).end("method not allowed");
  }
  let wrapper;
  try {
    wrapper = JSON.parse(await readBody(req, 8 << 20));
  } catch (err) {
    return void res.writeHead(err.code === "too_large" ? 413 : 400).end("bad body");
  }
  let u;
  try {
    u = new URL(String(wrapper.baseUrl || ""));
  } catch {
    return void res.writeHead(400).end("bad baseUrl");
  }
  if (!/^https?:$/.test(u.protocol) || !u.host) return void res.writeHead(400).end("bad baseUrl");
  try {
    const targetUrl = String(wrapper.baseUrl).replace(/\/+$/, "") + "/chat/completions";
    const upstream = await postJsonUpstream(
      targetUrl,
      {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        ...(wrapper.apiKey ? { Authorization: `Bearer ${wrapper.apiKey}` } : {}),
      },
      JSON.stringify(wrapper.body ?? {}),
    );
    res.writeHead(upstream.status, {
      "Content-Type": upstream.contentType,
      "Cache-Control": "no-store",
    });
    res.end(upstream.text);
  } catch {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_unreachable" }));
  }
}

let qqChild = null;
const QQ_SERVER_JS = path.resolve(ROOT, "..", "qq-openclaw", "dist", "dhvw-server.js");
const QQ_STATE_DIR = path.resolve(ROOT, "..", "data", "qq-openclaw");

async function qqAlive() {
  try {
    const r = await fetch("http://127.0.0.1:8088/__qq/health", { signal: AbortSignal.timeout(350) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureQqStarted() {
  if (await qqAlive()) return true;
  if (!qqChild && fs.existsSync(QQ_SERVER_JS)) {
    fs.mkdirSync(QQ_STATE_DIR, { recursive: true });
    qqChild = spawn(
      process.execPath,
      [QQ_SERVER_JS, "-followBoost", "-stateDir", QQ_STATE_DIR, "-shellUrl", `http://127.0.0.1:${PORT}`],
      { stdio: "inherit" },
    );
    qqChild.on("exit", () => {
      qqChild = null;
    });
  }
  for (let i = 0; i < 30; i++) {
    if (await qqAlive()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function stopQqChild() {
  if (qqChild) {
    try {
      qqChild.kill();
    } catch {}
    qqChild = null;
  }
}

process.on("SIGINT", () => {
  stopQqChild();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopQqChild();
  process.exit(0);
});

const server = http.createServer(async (req, res) => {
  try {
    const earlyPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (earlyPath === "/__llm/chat/completions") return void (await proxyLlm(req, res));
    if (earlyPath === "/__qq/health" || earlyPath === "/__qq/config" || earlyPath === "/__qq/rebind" || earlyPath === "/__qq/boost" || earlyPath === "/__qq/proactive/trigger") {
      try {
        const body = req.method === "POST" ? await readBody(req, 65536) : undefined;
        if (earlyPath === "/__qq/boost" && req.method === "POST") {
          let parsed = {};
          try { parsed = body ? JSON.parse(body.toString("utf8")) : {}; } catch {}
          if (parsed.enabled) {
            await ensureQqStarted();
          } else {
            stopQqChild();
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            return void res.end(JSON.stringify({ ok: true, running: false, boostActive: false }));
          }
        } else if (earlyPath === "/__qq/config" || earlyPath === "/__qq/rebind") {
          await ensureQqStarted();
        }
        const targetPath = earlyPath === "/__qq/boost" ? "/__qq/health" : earlyPath;
        const upstream = await fetch(`http://127.0.0.1:8088${targetPath}`, {
          method: targetPath === "/__qq/health" ? "GET" : req.method,
          headers: targetPath !== "/__qq/health" && req.method === "POST" ? { "Content-Type": "application/json" } : undefined,
          body: targetPath !== "/__qq/health" ? body : undefined,
        });
        const txt = await upstream.text();
        res.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return void res.end(txt);
      } catch {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return void res.end(JSON.stringify({ ok: true, running: false, configured: false, paired: false }));
      }
    }
    if (earlyPath === "/__tour/save") {
      if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end("method not allowed");
      const name = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("name") || "";
      if (!/^[A-Za-z0-9._-]{1,80}\.webm$/.test(name)) return void res.writeHead(400).end("bad name");
      try {
        const body = await readBuffer(req, 512 << 20);
        if (!body.length) return void res.writeHead(400).end("empty");
        const dir = path.resolve(ROOT, "..", "data", "recordings");
        fs.mkdirSync(dir, { recursive: true });
        const dst = path.join(dir, name);
        fs.writeFileSync(`${dst}.tmp`, body);
        fs.renameSync(`${dst}.tmp`, dst);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return void res.end(JSON.stringify({ ok: true, path: `data/recordings/${name}`, bytes: body.length }));
      } catch (err) {
        return void res.writeHead(err?.code === "too_large" ? 413 : 500).end("save failed");
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return void res.writeHead(405, { Allow: "GET, HEAD" }).end("method not allowed");
    }
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/__health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return void res.end(JSON.stringify({ ok: true, server: "node-dev", root: ROOT }));
    }
    if (urlPath === "/__host") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      try {
        const raw = JSON.parse(fs.readFileSync(HOST_FILE, "utf8"));
        if (raw?.wsUrl) return void res.end(JSON.stringify({ ok: true, ...raw }));
      } catch {}
      return void res.end(JSON.stringify({ ok: true, wsUrl: DEFAULT_WS_URL, name: "local-dev" }));
    }
    if (await netProxy.handle(req, res, urlPath)) return;
    const r = resolve(urlPath);
    if (!r) return void res.writeHead(404).end("not found");

    let st = null;
    try { st = await fsp.stat(r.fsPath); } catch { st = null; }

    if (st && st.isDirectory()) {
      const idx = path.join(r.fsPath, "index.html");
      if (await fsp.stat(idx).then((s) => !s.isDirectory(), () => false)) {
        return void (await sendFile(req, res, "/index.html", idx));
      }
      return void res.writeHead(404).end("not found"); // 无目录列表
    }
    if (st) return void (await sendFile(req, res, r.clean, r.fsPath));

    if (path.extname(urlPath) === "") {
      return void (await sendFile(req, res, "/index.html", path.join(ROOT, "index.html")));
    }
    res.writeHead(404).end("not found");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end("internal error");
  }
});

let activePort = PORT;
server.on("error", (err) => {
  if (!EXPLICIT_PORT && err.code === "EADDRINUSE" && activePort === PORT && activePort !== FALLBACK_PORT) {
    console.warn(`[dhvw dev shell] 端口 ${activePort} 已被占用（可能为 llama 服务），自动改用 ${FALLBACK_PORT}`);
    activePort = FALLBACK_PORT;
    server.listen(activePort, HOST);
    return;
  }
  throw err;
});

server.listen(activePort, HOST, () => {
  console.log(`dhvw dev shell → http://${HOST}:${activePort}  (root=${ROOT}, host=${DEFAULT_WS_URL})`);
  try {
    const cfgPath = path.join(QQ_STATE_DIR, "bot-config.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      if (cfg?.appId && cfg?.clientSecret && cfg?.enabled !== false) {
        void ensureQqStarted();
      }
    }
  } catch {}
});

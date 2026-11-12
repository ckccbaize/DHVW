// 开发用静态服务：路径规则与 shell/main.go 保持一致（MIME / 缓存 / SPA 回退 / 无目录列表）。
// 设备上跑的是 Go 壳，这里只用于本机验证与浏览器实测。
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "www");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";

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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return void res.writeHead(405, { Allow: "GET, HEAD" }).end("method not allowed");
    }
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/__health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return void res.end(JSON.stringify({ ok: true, server: "node-dev", root: ROOT }));
    }
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

server.listen(PORT, HOST, () => {
  console.log(`dhvw dev shell → http://${HOST}:${PORT}  (root=${ROOT})`);
});

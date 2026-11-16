// Dev 壳轻量联网与图搜代理：补齐与 shell/*.go 一致的 /__search、/__fetch、/__image/search、/__image/fetch 路由，
// 确保开发态（node tools/serve.mjs）下的网页浏览、QQ 查梗与自动搜表情包功能同样可用（含 SSRF 校验）。
import dns from "node:dns/promises";
import net from "node:net";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HTML_ENTITY_MAP = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeHtmlEntities(s = "") {
  return String(s).replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/gi, (m) => HTML_ENTITY_MAP[m.toLowerCase()] || m);
}

function stripTags(html = "") {
  return decodeHtmlEntities(String(html).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
    return false;
  }
  return true;
}

export async function validateSafePublicUrl(rawUrl, { lookup = dns.lookup } = {}) {
  let u;
  try {
    u = new URL(String(rawUrl || ""));
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "bad_scheme" };
  if (u.username || u.password) return { ok: false, reason: "has_credentials" };
  const host = u.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "private_host" };
  }
  if (net.isIP(host)) {
    return isPrivateIp(host) ? { ok: false, reason: "private_ip" } : { ok: true, url: u };
  }
  try {
    const records = await lookup(host, { all: true });
    if (!records?.length) return { ok: false, reason: "dns_empty" };
    for (const r of records) {
      if (isPrivateIp(r.address)) return { ok: false, reason: "private_resolved" };
    }
    return { ok: true, url: u };
  } catch {
    return { ok: false, reason: "dns_failed" };
  }
}

export function parseBingWebResults(html = "", n = 5) {
  const out = [];
  const blocks = String(html).match(/<li class="b_algo"[\s\S]*?<\/li>/gi) || [];
  for (const b of blocks) {
    const hm = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!hm) continue;
    const url = decodeHtmlEntities(hm[1]).trim();
    const title = stripTags(hm[2]);
    if (!url || !title || !/^https?:\/\//i.test(url)) continue;
    const pm = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(b);
    out.push({ title, url, snippet: pm ? stripTags(pm[1]) : "" });
    if (out.length >= n) break;
  }
  return out;
}

export function parseBingImageResults(html = "", n = 8) {
  const src = String(html);
  const murls = [];
  const turls = [];
  const reM = /(?:murl&quot;:&quot;|"murl"\s*:\s*")(https?:\/\/[^"&]+)/gi;
  const reT = /(?:turl&quot;:&quot;|"turl"\s*:\s*")(https?:\/\/[^"&]+)/gi;
  let m;
  while ((m = reM.exec(src)) !== null && murls.length < n) {
    murls.push(decodeHtmlEntities(m[1]));
  }
  while ((m = reT.exec(src)) !== null && turls.length < n) {
    turls.push(decodeHtmlEntities(m[1]));
  }
  return murls.map((url, idx) => ({
    url,
    thumb: turls[idx] || url,
    title: "",
    license: "unknown",
  }));
}

export function createNetProxy({ fetchImpl = globalThis.fetch, lookup = dns.lookup } = {}) {
  const searchCache = new Map();
  const imageCache = new Map();

  async function searchWeb(q, n) {
    const key = `${q}|${n}`;
    const cached = searchCache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.items;
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&form=QBLH`;
    const res = await fetchImpl(url, {
      headers: { "User-Agent": DEFAULT_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`search_http_${res.status}`);
    const html = await res.text();
    const items = parseBingWebResults(html, n);
    if (items.length) searchCache.set(key, { at: Date.now(), items });
    return items;
  }

  async function searchImages(q, n, provider = "") {
    const key = `${provider}|${q}|${n}`;
    const cached = imageCache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.data;

    const tryBing = async () => {
      const r = await fetchImpl(`https://cn.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2&first=1`, {
        headers: { "User-Agent": DEFAULT_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return null;
      const items = parseBingImageResults(await r.text(), n);
      return items.length ? { source: "bing", items } : null;
    };

    const tryOpenverse = async () => {
      const r = await fetchImpl(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${n}`, {
        headers: { "User-Agent": "dhvw-device/0.1" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return null;
      const d = await r.json();
      const items = (d?.results || []).slice(0, n).map((x) => ({
        url: x.url,
        thumb: x.thumbnail || x.url,
        title: x.title || "",
        license: x.license || "",
      }));
      return items.length ? { source: "openverse", items } : null;
    };

    let data = null;
    if (!provider || provider === "bing") data = await tryBing().catch(() => null);
    if (!data && (!provider || provider === "openverse")) data = await tryOpenverse().catch(() => null);
    if (!data) throw new Error("no_image_results");
    imageCache.set(key, { at: Date.now(), data });
    return data;
  }

  return {
    async handle(req, res, urlPath) {
      if (urlPath !== "/__search" && urlPath !== "/__fetch" && urlPath !== "/__image/search" && urlPath !== "/__image/fetch") {
        return false;
      }
      if (req.method !== "GET") {
        res.writeHead(405, { Allow: "GET" }).end("method not allowed");
        return true;
      }
      const reqUrl = new URL(req.url || urlPath, "http://127.0.0.1");

      if (urlPath === "/__search") {
        const q = (reqUrl.searchParams.get("q") || "").trim();
        const n = Math.max(1, Math.min(10, Number(reqUrl.searchParams.get("n")) || 5));
        if (!q || q.length > 80) {
          res.writeHead(400).end("bad q");
          return true;
        }
        try {
          const results = await searchWeb(q, n);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: true, query: q, results }));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
        }
        return true;
      }

      if (urlPath === "/__fetch") {
        const target = (reqUrl.searchParams.get("url") || "").trim();
        const check = await validateSafePublicUrl(target, { lookup });
        if (!check.ok) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: check.reason }));
          return true;
        }
        try {
          const upstream = await fetchImpl(check.url.href, {
            headers: { "User-Agent": DEFAULT_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
            signal: AbortSignal.timeout(8000),
          });
          if (!upstream.ok) {
            res.writeHead(502).end(JSON.stringify({ ok: false, error: `http_${upstream.status}` }));
            return true;
          }
          const html = (await upstream.text()).slice(0, 2 << 20);
          const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
          const text = stripTags(html).slice(0, 4000);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: true, url: target, title: titleM ? stripTags(titleM[1]) : "", text, bytes: text.length }));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
        }
        return true;
      }

      if (urlPath === "/__image/search") {
        const q = (reqUrl.searchParams.get("q") || "").trim();
        const n = Math.max(1, Math.min(20, Number(reqUrl.searchParams.get("n")) || 8));
        const provider = (reqUrl.searchParams.get("provider") || "").trim();
        if (!q || q.length > 80) {
          res.writeHead(400).end("bad q");
          return true;
        }
        try {
          const data = await searchImages(q, n, provider);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
        }
        return true;
      }

      // /__image/fetch
      const imgTarget = (reqUrl.searchParams.get("url") || "").trim();
      const check = await validateSafePublicUrl(imgTarget, { lookup });
      if (!check.ok) {
        res.writeHead(400).end(check.reason);
        return true;
      }
      try {
        const upstream = await fetchImpl(check.url.href, {
          headers: { "User-Agent": DEFAULT_UA },
          signal: AbortSignal.timeout(8000),
        });
        const ct = String(upstream.headers.get("content-type") || "").toLowerCase();
        if (!upstream.ok || !ct.startsWith("image/")) {
          res.writeHead(502).end("not image");
          return true;
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (!buf.byteLength || buf.byteLength > 6 * 1024 * 1024) {
          res.writeHead(413).end("image too large");
          return true;
        }
        res.writeHead(200, { "Content-Type": ct, "Cache-Control": "public, max-age=3600" });
        res.end(buf);
      } catch (err) {
        res.writeHead(502).end(String(err?.message || err));
      }
      return true;
    },
  };
}

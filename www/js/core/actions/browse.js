// AI 自助搜索（W28b）：LLM 只给搜索词 → /__search（Bing HTML）→ 挑一条 → /__fetch。
// 不再支持模型直接给 URL/域名白名单：目标必须由搜索产生，避免退化成固定页面。
import { extractJson } from "../agent/json.js";

const PRIVATE_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|\[::1\]$|.*\.local$)/i;

function isPrivateHost(host) {
  if (PRIVATE_RE.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  return false;
}

export function validatePublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return "bad_url";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "bad_scheme";
  if (u.username || u.password) return "has_credentials";
  if (isPrivateHost(u.hostname)) return "private_host";
  return null;
}

/** 只接受一个搜索词；URL/主题会被拒，目标必须由搜索产生。 */
export function validateBrowseTarget(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "not_object";
  if (obj.url !== undefined || obj.topic !== undefined) return "not_search";
  const q = String(obj.query ?? "").trim();
  if (q.length < 2 || q.length > 80) return "bad_query";
  return null;
}

/**
 * 把搜索结果排成尝试顺序：先跳过看过的，再从随机位置开始（轮转），
 * 这样既能换页、又不固定第一页，且前一页抓不到时还有后备。
 */
export function pickSearchCandidates(results = [], { recent = [], random = Math.random, limit = 3 } = {}) {
  const usable = (Array.isArray(results) ? results : []).filter((r) => r && r.url && validatePublicUrl(r.url) === null);
  if (!usable.length) return [];
  const seen = new Set(
    recent.map((r) => `${String(r?.url || "")}|${String(r?.topic || "")}`).filter((s) => s !== "|"),
  );
  const fresh = usable.filter((r) => !seen.has(`${r.url}|${r.title || ""}`));
  const pool = fresh.length ? fresh : usable;
  const start = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  const out = [];
  for (let i = 0; i < pool.length && out.length < limit; i++) {
    out.push(pool[(start + i) % pool.length]);
  }
  return out;
}

export async function searchBing(query, { fetchImpl = globalThis.fetch, n = 5 } = {}) {
  const res = await fetchImpl(`/__search?q=${encodeURIComponent(query)}&n=${n}`, { cache: "no-store" });
  if (!res.ok) return { ok: false, reason: `search_http_${res.status}`, results: [] };
  const data = await res.json();
  return { ok: true, query, results: data.results || [] };
}

export function createBrowsePlanner({ llm, registry, now = () => Date.now() } = {}) {
  if (!llm) throw new Error("createBrowsePlanner 需要 llm");
  if (!registry) throw new Error("createBrowsePlanner 需要 registry");

  async function plan({ threads = [], recent = [], mood = {} } = {}) {
    const skill = registry.getSkill("browse-plan");
    if (!skill) return { ok: false, reason: "skill_missing" };
    const prompt = registry.render("browse-plan", {
      threads: JSON.stringify(threads.slice(0, 5)),
      recent: JSON.stringify(recent.slice(0, 3).map((r) => ({ url: r.url, topic: r.topic }))),
      mood: JSON.stringify(mood),
    });
    let res;
    try {
      res = await llm.complete({
        messages: [{ role: "user", content: prompt }],
        json: true,
        maxTokens: skill.maxTokens,
        temperature: skill.temperature,
        cls: "work",
        kind: "browse-plan",
      });
    } catch (err) {
      return { ok: false, reason: "llm_failed", error: err.message };
    }
    const obj = extractJson(res.text);
    const reason = obj ? validateBrowseTarget(obj) : "invalid_json";
    if (reason) return { ok: false, reason };
    return {
      ok: true,
      query: String(obj.query).trim(),
      reason: String(obj.reason || "").trim(),
      raw: res.text,
      ts: now(),
    };
  }

  return { plan };
}

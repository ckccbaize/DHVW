// AI 决定浏览目标（W28b）：LLM 给主题/URL → 校验白名单 → /__fetch。
import { extractJson } from "../agent/json.js";

export const DEFAULT_HOSTS = [
  "weather.com.cn",
  "cn.bing.com",
  "www.bing.com",
  "zh.wikipedia.org",
  "news.qq.com",
  "www.people.com.cn",
];

const PRIVATE_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|\[::1\]$|.*\.local$)/i;

function isPrivateHost(host) {
  if (PRIVATE_RE.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  return false;
}

export function validateBrowseTarget(obj, { hosts = DEFAULT_HOSTS } = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "not_object";
  if (obj.url) {
    let u;
    try {
      u = new URL(String(obj.url));
    } catch {
      return "bad_url";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "bad_scheme";
    if (u.username || u.password) return "has_credentials";
    if (isPrivateHost(u.hostname)) return "private_host";
    const allowed = hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    if (!allowed) return "host_not_allowed";
    return null;
  }
  const topic = String(obj.topic ?? "").trim();
  if (topic.length < 2 || topic.length > 60) return "bad_topic";
  return null;
}

export function targetUrl({ topic = "", url = "" } = {}) {
  if (url) return url;
  return `https://cn.bing.com/search?q=${encodeURIComponent(topic)}`;
}

export function createBrowsePlanner({ llm, registry, hosts = DEFAULT_HOSTS, now = () => Date.now() } = {}) {
  if (!llm) throw new Error("createBrowsePlanner 需要 llm");
  if (!registry) throw new Error("createBrowsePlanner 需要 registry");

  async function plan({ threads = [], recent = [], mood = {} } = {}) {
    const skill = registry.getSkill("browse-plan");
    if (!skill) return { ok: false, reason: "skill_missing" };
    const prompt = registry.render("browse-plan", {
      threads: JSON.stringify(threads.slice(0, 5)),
      recent: JSON.stringify(recent.slice(0, 3).map((r) => ({ url: r.url, topic: r.topic }))),
      mood: JSON.stringify(mood),
      hosts: hosts.join(", "),
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
    const reason = obj ? validateBrowseTarget(obj, { hosts }) : "invalid_json";
    if (reason) return { ok: false, reason };
    return {
      ok: true,
      topic: String(obj.topic || "").trim(),
      url: targetUrl(obj),
      reason: String(obj.reason || "").trim(),
      ts: now(),
    };
  }

  return { plan };
}

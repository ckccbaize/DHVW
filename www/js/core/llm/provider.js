// LLM 服务商配置（W11）：PC 可通过 `llm:config` 直接修改，落库生效。
// 契约：CONTRACTS.md §3；PC 侧见 PC-INTEGRATION.md §9。

export const DEFAULT_PROVIDER = Object.freeze({
  baseUrl: "", // 形如 https://api.example.com/v1
  apiKey: "",
  model: "",
  timeoutMs: 20000,
  maxAttempts: 3, // 1 次 + 2 次重试
  retryBaseMs: 500,
  reasoningEffort: "none",
});

const clampInt = (v, min, max, fallback) => {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

export function maskKey(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 3)}***${s.slice(-4)}`;
}

/** 校验并合并配置；非法 baseUrl 直接抛错（PC 侧能立刻看到）。 */
export function normalizeProvider(patch = {}, base = DEFAULT_PROVIDER) {
  const p = { ...base };
  if (patch.baseUrl !== undefined) {
    const u = String(patch.baseUrl || "").trim().replace(/\/+$/, "");
    if (u && !/^https?:\/\//i.test(u)) throw new Error("baseUrl 必须是 http(s) 地址");
    p.baseUrl = u;
  }
  if (patch.apiKey !== undefined) p.apiKey = String(patch.apiKey || "");
  if (patch.model !== undefined) p.model = String(patch.model || "");
  if (patch.timeoutMs !== undefined) p.timeoutMs = clampInt(patch.timeoutMs, 1000, 120000, p.timeoutMs);
  if (patch.maxAttempts !== undefined) p.maxAttempts = clampInt(patch.maxAttempts, 1, 5, p.maxAttempts);
  if (patch.retryBaseMs !== undefined) p.retryBaseMs = clampInt(patch.retryBaseMs, 100, 10000, p.retryBaseMs);
  if (patch.reasoningEffort !== undefined) p.reasoningEffort = String(patch.reasoningEffort || "none");
  return p;
}

export function isConfigured(p) {
  return !!p && !!p.baseUrl && !!p.model;
}

/** 配置存储：kv 后端（IndexedDB / 内存）。 */
export function createProviderStore({ backend, defaults = DEFAULT_PROVIDER } = {}) {
  if (!backend) throw new Error("createProviderStore 需要 backend");
  let current = { ...defaults };
  let loaded = false;

  return {
    async init() {
      if (loaded) return current;
      const row = await backend.get("llm_provider");
      if (row) {
        try {
          current = normalizeProvider(row, defaults);
        } catch {
          current = { ...defaults };
        }
      }
      loaded = true;
      return current;
    },
    get() {
      return { ...current };
    },
    get masked() {
      return { ...current, apiKey: maskKey(current.apiKey) };
    },
    async set(patch) {
      current = normalizeProvider(patch, current);
      await backend.put("llm_provider", current);
      return current;
    },
    async clear() {
      current = { ...defaults };
      await backend.delete("llm_provider");
      return current;
    },
  };
}

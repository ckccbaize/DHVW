// 把 PC 编排器下发的 llm:config 转成 ARM 端可达配置：
// 云端 API 保持直连；本地 llama (mode === 'local' 或回环地址) 改写到已配对网关/编排器代理。

export function isLoopbackUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(s);
}

export function normalizeOpenAiBase(rawUrl) {
  const s = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  return /\/v\d+$/i.test(s) ? s : `${s}/v1`;
}

function isLoopbackHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || h === "0.0.0.0";
}

export function resolveRemoteLlmConfig(payload = {}, hostWsUrl = "") {
  const out = { ...(payload || {}) };
  if (out.baseUrl) out.baseUrl = normalizeOpenAiBase(out.baseUrl);
  const mode = String(out.mode || "").toLowerCase();
  const isLocal = mode === "local" || isLoopbackUrl(out.baseUrl);
  if (!isLocal) {
    out.mode = "api";
    out.useShellProxy = false;
    return out;
  }

  out.mode = "local";
  const wsRaw = String(hostWsUrl || "").trim();
  if (!wsRaw) return out;

  try {
    const u = new URL(wsRaw);
    const token = u.searchParams.get("token") || "";
    const isGatewayWs = u.protocol === "wss:" && (token !== "" || u.pathname.includes("/ws/orchestrator"));
    if (isGatewayWs) {
      out.baseUrl = `https://${u.host}/llm/v1`;
      if (token) out.apiKey = token;
      else if (!out.apiKey) out.apiKey = "local-llama";
      // QQ Bot 走 dhvw-shell /__llm 代理，避免 Node 侧缺少自签 CA 信任。
      out.useShellProxy = true;
      return out;
    }
    if ((u.protocol === "ws:" || u.protocol === "wss:") && u.host && !isLoopbackHostname(u.hostname)) {
      const scheme = u.protocol === "wss:" ? "https" : "http";
      const proxyPath = String(out.localProxyPath || "/dhvw/llm/v1").trim() || "/dhvw/llm/v1";
      const pathNorm = proxyPath.startsWith("/") ? proxyPath : `/${proxyPath}`;
      out.baseUrl = `${scheme}://${u.host}${pathNorm}`;
      if (!out.apiKey) out.apiKey = "local-llama";
      out.useShellProxy = true;
      return out;
    }
  } catch {
    /* 非法 wsUrl 时保留原 baseUrl */
  }
  out.useShellProxy = false;
  return out;
}

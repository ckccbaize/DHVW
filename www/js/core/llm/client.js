// LLM 客户端（W11）：OpenAI 兼容 /chat/completions。
// 失败重试：网络/超时/429/5xx/JSON 解析失败 → 指数退避重试；4xx（除 429）不重试。

function isLocalLlamaProvider(provider = {}) {
  const model = String(provider.model || "");
  const baseUrl = String(provider.baseUrl || "");
  if (/nemotron|gemma/i.test(model)) return true;
  if (String(provider.mode || "").toLowerCase() === "local") return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)|\/(dhvw\/)?llm\/v1/i.test(baseUrl);
}

export const TRANSIENT_STATUS = (status) => status === 429 || status >= 500;

export function createLlmClient({
  getProvider,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  random = Math.random,
  onUsage = () => {},
} = {}) {
  if (typeof getProvider !== "function") throw new Error("createLlmClient 需要 getProvider");
  const stats = { calls: 0, ok: 0, failed: 0, retries: 0, lastLatencyMs: 0, lastError: null };

  async function once(provider, body, timeoutMs, externalSignal) {
    const useProxy = provider.useProxy !== false;
    const url = useProxy ? "/__llm/chat/completions" : `${provider.baseUrl}/chat/completions`;
    const payload = useProxy
      ? { baseUrl: provider.baseUrl, apiKey: provider.apiKey, body }
      : body;
    const headers = useProxy
      ? { "Content-Type": "application/json" }
      : {
          "Content-Type": "application/json",
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? provider.timeoutMs ?? 180000);
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort();
      else externalSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw Object.assign(new Error(`LLM HTTP ${res.status}`), {
          code: `http_${res.status}`,
          status: res.status,
          body: text.slice(0, 300),
        });
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw Object.assign(new Error("LLM 返回不是 JSON"), { code: "bad_json" });
      }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        const msg = data?.error?.message ? `LLM 返回错误: ${data.error.message}` : "LLM 返回缺少 content";
        throw Object.assign(new Error(msg), { code: "bad_shape" });
      }
      const finish = data?.choices?.[0]?.finish_reason ?? null;
      const usage = data.usage || null;
      // 推理模型的 reasoning_content 与正文共享 max_tokens：预算不足时 200 OK 但正文空/半截。
      // 这种情况必须如实报“预算不够”，否则上层只能看到“空剧情/空文本”，查不到根因。
      if (finish === "length" && !content.trim()) {
        const think = Number(usage?.completion_tokens_details?.reasoning_tokens || 0);
        throw Object.assign(
          new Error(`LLM 推理吃满 max_tokens=${body.max_tokens}，正文为空（reasoning ${think} tokens）`),
          { code: "truncated", status: null, finish, usage },
        );
      }
      return { text: content, usage, model: data.model || provider.model, finish };
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw Object.assign(new Error("LLM 超时/中止"), { code: "timeout" });
      }
      if (!err.code && !err.status) {
        throw Object.assign(new Error(`LLM 网络错误: ${err.message}`), { code: "network", cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {object} req
   * @param {Array} req.messages
   * @param {number} [req.maxTokens]
   * @param {number} [req.temperature]
   * @param {boolean} [req.json]        要求 JSON 对象输出
   * @param {AbortSignal} [req.signal]
   * @param {number} [req.timeoutMs]
   */
  async function complete({
    messages,
    // 推理模型把 reasoning_content 也算进 max_tokens：正文还没开始就被截断，
    // 表现为“响应 200 但 content 是思考链/空”。正文预算必须在上限之上额外留出。
    maxTokens = 4096,
    temperature = 0.3,
    json = false,
    signal,
    timeoutMs,
    cls = "work",
    kind = "generic",
  } = {}) {
    const provider = getProvider();
    if (!provider || !provider.baseUrl || !provider.model) {
      throw Object.assign(new Error("LLM 未配置（baseUrl/model）"), { code: "not_configured" });
    }
    const body = {
      model: provider.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    };
    const useJsonFormat = json && !(isLocalLlamaProvider(provider) && provider.reasoningEffort !== false);
    if (useJsonFormat) body.response_format = { type: "json_object" };
    if (provider.reasoningEffort !== false) body.reasoning_effort = provider.reasoningEffort || "none";

    const attempts = Math.max(1, Number(provider.maxAttempts) || 1);
    let lastErr = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      stats.calls += 1;
      const t0 = now();
      try {
        const out = await once(provider, body, timeoutMs ?? provider.timeoutMs, signal);
        stats.ok += 1;
        stats.lastLatencyMs = now() - t0;
        try {
          onUsage({ cls, kind, usage: out.usage, ok: true, ts: now() });
        } catch {}
        return { ...out, latencyMs: stats.lastLatencyMs, attempts: attempt };
      } catch (err) {
        lastErr = err;
        const status = err && err.status;
        const retryable =
          err.code === "timeout" ||
          err.code === "network" ||
          err.code === "bad_json" ||
          err.code === "bad_shape" ||
          (Number.isFinite(status) && TRANSIENT_STATUS(status)) ||
          (!err.code && !status); // 网络错误（fetch 抛 TypeError）

        if (!retryable || attempt >= attempts) break;

        stats.retries += 1;
        const backoff = provider.retryBaseMs * 2 ** (attempt - 1) + Math.floor(random() * 100);
        await sleep(backoff);
      }
    }

    stats.failed += 1;
    stats.lastError = lastErr ? lastErr.message : "unknown";
    try {
      onUsage({ cls, kind, usage: null, ok: false, ts: now() });
    } catch {}
    throw Object.assign(lastErr || new Error("LLM 失败"), { attempts });
  }

  return {
    complete,
    get stats() {
      return { ...stats };
    },
  };
}

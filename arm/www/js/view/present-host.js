// 显现宿主辅助（W30）：URL 归一化与 PC 页面探活。
// iframe 的加载失败/超时由 present.js 处理；这里只做进入前的判断。

export function normalizePresentUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.search) return u.href;
    return u.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export async function probePresent(url, { fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  const normalized = normalizePresentUrl(url);
  if (!normalized) return { ok: false, reason: "bad_url" };
  const parsed = new URL(normalized);
  const pathClean = parsed.pathname.replace(/\/+$/, "");
  const search = parsed.search || "";
  const candidates = [
    `${parsed.origin}${pathClean}/health${search}`,
    `${parsed.origin}${pathClean}/${search}`,
    `${parsed.origin}/health${search}`,
  ];
  let last = { ok: false, reason: "unreachable" };
  for (const target of [...new Set(candidates)]) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(target, { signal: ac.signal, cache: "no-store" });
      if (res && res.ok) return { ok: true, status: res.status, url: target };
      last = { ok: false, status: res ? res.status : 0 };
    } catch (err) {
      last = { ok: false, reason: err?.name === "AbortError" ? "timeout" : "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

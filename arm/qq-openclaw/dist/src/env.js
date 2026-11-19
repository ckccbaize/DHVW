/**
 * Environment-variable fallbacks, isolated here so the rest of the plugin never
 * touches `process.env` directly (which keeps it trivially testable).
 */
function readEnv(name) {
    const value = process.env[name];
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
export function getDefaultWsUrl() {
    return readEnv("SNOWLUMA_WS_URL");
}
export function getDefaultHttpUrl() {
    return readEnv("SNOWLUMA_HTTP_URL");
}
export function getDefaultAccessToken() {
    return readEnv("SNOWLUMA_ACCESS_TOKEN") ?? readEnv("SNOWLUMA_TOKEN");
}
export function getDefaultSelfId() {
    const raw = readEnv("SNOWLUMA_SELF_ID");
    if (!raw)
        return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
}
//# sourceMappingURL=env.js.map
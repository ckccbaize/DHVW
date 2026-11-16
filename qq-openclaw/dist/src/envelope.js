/**
 * Local, `openclaw`-free port of the host's inbound-envelope sender attribution.
 *
 * WHY LOCAL — openclaw removed `runtime.channel.reply.formatInboundEnvelope`
 * (present through 2026.5.x, gone by 2026.8.1; the surviving SDK export lives at
 * `openclaw/plugin-sdk/channel-inbound`, which this plugin may not import at
 * runtime — see the "no `openclaw/*` runtime import" hard constraint in
 * CLAUDE.md). A gateway on the new host answered every inbound message with
 * `TypeError: runtime.channel.reply.formatInboundEnvelope is not a function`.
 *
 * WHAT IS PORTED AND WHAT IS NOT — `formatInboundEnvelope` is a thin wrapper: it
 * decides the body's `sender: ` prefix from chat type + identity fields, then
 * delegates the bracketed `[Channel from … timestamp]` header to
 * `formatAgentEnvelope`. Only the first half is ported here. The header — with
 * its timezone resolution, relative-elapsed formatting and locale handling —
 * stays the host's job through `runtime.channel.reply.formatAgentEnvelope`,
 * which is still a supported runtime surface.
 *
 * Ported verbatim from openclaw 2026.8.1 (`dist/envelope-*.js`:
 * `formatInboundEnvelope`, `resolveDirectEnvelopeBodyLabel`,
 * `sanitizeEnvelopeHeaderPart`, `resolveSenderLabel`, `normalizeChatType`,
 * `normalizeOptionalString`). `test/envelope.test.ts` pins the port against the
 * real SDK function so a future host revision that changes the shape fails the
 * suite rather than the gateway.
 */
/** `normalizeOptionalString` — trims, and rejects non-strings and blanks. */
function normalizeOptionalString(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
/** `normalizeChatType` — channel labels → OpenClaw conversation kinds. */
function normalizeChatType(raw) {
    const value = normalizeOptionalString(raw)?.toLowerCase();
    if (!value)
        return undefined;
    if (value === "direct" || value === "dm")
        return "direct";
    if (value === "group")
        return "group";
    if (value === "channel")
        return "channel";
    return undefined;
}
/**
 * `sanitizeEnvelopeHeaderPart` — flattens newlines, neutralizes the brackets
 * that delimit the envelope header, and collapses runs of whitespace.
 */
export function sanitizeEnvelopeHeaderPart(value) {
    return value
        .replace(/\r\n|\r|\n/g, " ")
        .replaceAll("[", "(")
        .replaceAll("]", ")")
        .replace(/\s+/g, " ")
        .trim();
}
const OPAQUE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** `resolveSenderLabel` — best one-line label from the available identity fields. */
export function resolveSenderLabel(params) {
    const name = normalizeOptionalString(params.name);
    const username = normalizeOptionalString(params.username);
    const tag = normalizeOptionalString(params.tag);
    const e164 = normalizeOptionalString(params.e164);
    const id = normalizeOptionalString(params.id);
    const display = name ?? username ?? tag ?? "";
    const idPart = e164 ?? id ?? "";
    if (display && idPart && display !== idPart && !OPAQUE_UUID_RE.test(idPart)) {
        return `${display} (${idPart})`;
    }
    return display || idPart || null;
}
/** `resolveDirectEnvelopeBodyLabel` — the direct-chat body prefix, from `from`. */
function resolveDirectEnvelopeBodyLabel(from) {
    const label = sanitizeEnvelopeHeaderPart(from || "");
    const idMarkerIndex = label.search(/\s+id:/i);
    if (idMarkerIndex > 0) {
        const displayLabel = label.slice(0, idMarkerIndex).trim();
        return displayLabel.includes(":") ? "(sender)" : displayLabel;
    }
    return label.includes(":") ? "(sender)" : label;
}
/**
 * Attach the sender attribution the host used to add, then hand the result to
 * the host's own header formatter.
 *
 * Attribution rules, unchanged from the SDK: a direct chat labels the body with
 * `(self)` when the message is ours, otherwise with the display half of `from`;
 * a group/channel labels it with the resolved sender label. Anything else (no
 * usable label) leaves the body alone.
 */
export function formatInboundEnvelope(params, formatAgentEnvelope) {
    const chatType = normalizeChatType(params.chatType);
    const isDirect = !chatType || chatType === "direct";
    const resolvedSenderRaw = normalizeOptionalString(params.senderLabel) ?? resolveSenderLabel(params.sender ?? {});
    const resolvedSender = resolvedSenderRaw ? sanitizeEnvelopeHeaderPart(resolvedSenderRaw) : "";
    const directSender = resolveDirectEnvelopeBodyLabel(normalizeOptionalString(params.from));
    const body = isDirect && params.fromMe
        ? `(self): ${params.body}`
        : isDirect && directSender
            ? `${directSender}: ${params.body}`
            : !isDirect && resolvedSender
                ? `${resolvedSender}: ${params.body}`
                : params.body;
    return formatAgentEnvelope({
        channel: params.channel,
        from: params.from,
        timestamp: params.timestamp,
        previousTimestamp: params.previousTimestamp,
        envelope: params.envelope,
        body,
    });
}
//# sourceMappingURL=envelope.js.map
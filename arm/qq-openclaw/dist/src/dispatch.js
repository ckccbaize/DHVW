/**
 * Wave 2 module E — inbound → agent dispatch.
 *
 * Turns one `AggregatedBatch` (a coalesced realtime burst, or a periodic
 * digest window) into a single agent turn via the host's `pluginRuntime.channel.*`
 * helpers, then delivers whatever the agent replies with back to QQ. Every
 * dependency a test needs to fake — the runtime, quote resolution, and the
 * outbound senders — is injectable through `DispatchDeps`, so exercising this
 * module never requires a running OpenClaw host.
 *
 * `formatInboundEnvelope` (now `src/envelope.ts`, since openclaw dropped it from
 * `runtime.channel.reply`) takes a closed set of fields with no `imageUrls`
 * param. Image information therefore travels two other ways: `renderSegments`
 * puts a `[图片]` placeholder inline in the rendered text, and
 * `finalizeInboundContext` accepts a generic `Record<string, unknown>`, so the
 * inbound media fields are threaded through the finalized context — all
 * already-declared `MsgContext` fields the agent runner reads for attachments.
 * `image.ts` fills those in: it downloads each QQ image into the host's media
 * store first, because a LOCAL PATH (not a url) is what makes OpenClaw actually
 * attach a picture to the model turn.
 */
import { formatInboundEnvelope } from "./envelope.js";
import { buildMediaContextFields, endpointHost, resolveInboundImages as defaultResolveInboundImages, selectInboundImageUrls, } from "./image.js";
import { OPENCLAW_EMPTY_INPUT_NOTICE, rewriteNameMentions, sendMedia as defaultSendMedia, sendText as defaultSendText, } from "./outbound.js";
import { markdownToText } from "./markdown-text.js";
import { formatQuoteContext, resolveQuoteContext as defaultResolveQuoteContext } from "./quote.js";
import { getSnowLumaRuntime } from "./runtime.js";
import { countImageSegments, formatImageHint, renderSegments, safeMessageIdHandle, sanitizeDisplayName, } from "./segments.js";
import { stripLeadingMention } from "./triggers.js";
// ── Command authorization ───────────────────────────────────────────────
/**
 * Whether the sender of this batch may run privileged text commands (`/reset`,
 * etc). Delegates to the host's access-group gate when available, falling
 * back to a plain `allowFrom` allowlist check for a runtime that doesn't
 * expose the gate (e.g. a minimal test double).
 */
export function resolveInboundCommandAuthorization(params) {
    const { runtime, cfg, allowFrom, peerId } = params;
    const hasAllowFrom = Array.isArray(allowFrom) && allowFrom.length > 0;
    const senderAllowedForCommands = hasAllowFrom && allowFrom.some((pattern) => pattern === "*" || pattern === peerId);
    const resolveCommandAuthorized = runtime.channel.commands?.resolveCommandAuthorizedFromAuthorizers;
    if (typeof resolveCommandAuthorized !== "function") {
        return senderAllowedForCommands;
    }
    // `commands.useAccessGroups` was dropped from openclaw's `CommandsConfig` type
    // (2026.8.1) — the host now defaults the flag to true at the call site. Read it
    // off the raw config so an operator who still has the key set to `false` keeps
    // the behaviour they configured, and default to true otherwise, exactly as the
    // host's own `useAccessGroupsFromConfig` does.
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    return resolveCommandAuthorized({
        useAccessGroups,
        authorizers: [{ configured: hasAllowFrom, allowed: senderAllowedForCommands }],
        modeWhenAccessGroupsOff: hasAllowFrom ? "configured" : "deny",
    });
}
// ── Body composition ────────────────────────────────────────────────────
function formatHHMMSS(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/** Renders one message the same way for both the realtime body and the digest transcript. */
function renderMessageText(msg) {
    return renderSegments(msg.segments) || msg.text;
}
/**
 * A `[HH:mm:ss] name(id): text` transcript line, shared by the digest and
 * reply-history blocks.
 *
 * `handle` is an optional marker printed between the attribution and the
 * message body — the same slot `tools.ts` puts `[msgId:…]` in. It goes BEFORE
 * the text on purpose: message text is passed through verbatim (only names are
 * structural), so a message ending in a newline would strand a trailing marker
 * on a line of its own, and `renderHistoryReference`'s tail-slice truncation
 * would keep such a marker while cutting away the header it belongs to. Empty
 * by default, so a digest/summary line is byte-identical to what it always was.
 */
function renderTranscriptLine(msg, handle = "") {
    const name = sanitizeDisplayName(msg.senderName);
    return `[${formatHHMMSS(msg.time)}] ${name}(${msg.senderId}):${handle} ${renderMessageText(msg)}`;
}
/** True when `snowluma_view_image` is actually registered for this account. */
function imageToolAvailable(account) {
    return account.image.tool && account.toolsEnabled;
}
const HISTORY_HEADER = "【历史聊天记录（仅供参考上下文，请勿直接回复其中的旧消息）】";
const HISTORY_FOOTER = "【以上为历史消息；请针对下面这条最新消息进行回复】";
/**
 * The host's own sender label ("name (id)", or whichever half is available),
 * mirrored step for step from `resolveSenderLabel` + `sanitizeEnvelopeHeaderPart`
 * so an in-body attribution is byte-identical to the one `formatInboundEnvelope`
 * would have produced. That is deliberately NOT `renderTranscriptLine`'s
 * `name(id)` shape: this label stands in for the host's prefix, so the current
 * message has to look the same to the agent whether or not a history block
 * pushed the attribution into the body.
 */
function renderSenderLabel(name, id) {
    const display = name.trim();
    const idPart = String(id).trim();
    const label = display && idPart && display !== idPart ? `${display} (${idPart})` : display || idPart;
    return sanitizeDisplayName(label);
}
/**
 * A history transcript line, carrying the `snowluma_view_image` handle when the
 * message had pictures in it.
 *
 * Only the triggering message's own images are ever downloaded, so a picture
 * that scrolled past in the history block reaches the agent as a bare `[图片]`:
 * something is there, with no way to look at it and no id to ask about. That is
 * the same dead end `formatQuoteContext` closes for a quote and
 * `renderUnattachedImageHint` closes for the current message, and it is the one
 * `snowluma_view_image`'s own description already promises is reachable
 * ("引用消息、历史记录、合并转发里出现的 [图片]").
 *
 * Gated on the two switches that decide whether that tool EXISTS, and
 * deliberately not on `image.enabled`. That third gate belongs to
 * `renderUnattachedImageHint`, where `enabled: false` means the operator asked
 * us not to fetch THIS message's pictures and advertising them anyway would
 * quietly undo the setting. A history image was never a candidate for
 * attachment under any setting, so the hint contradicts nothing — with inbound
 * downloads off it is the only way to see one at all.
 */
function renderHistoryTranscriptLine(msg, withImageHint) {
    if (!withImageHint)
        return renderTranscriptLine(msg);
    return renderTranscriptLine(msg, formatImageHint(countImageSegments(msg.segments), msg.messageId));
}
/**
 * Render the peer's accumulated reply-history buffer into a transcript block,
 * trimmed from the oldest end to `history.maxChars`. Empty string when there is
 * no history to show.
 */
function renderHistoryReference(history, account) {
    if (!history || history.length === 0)
        return "";
    const limit = account.receive.history.maxChars;
    // Hints go on before the trim below, so the budget measures what the agent
    // actually reads rather than the lines without their handles.
    const withImageHint = imageToolAvailable(account);
    const lines = history.map((msg) => renderHistoryTranscriptLine(msg, withImageHint));
    while (lines.length > 1 && lines.join("\n").length > limit)
        lines.shift();
    let transcript = lines.join("\n");
    if (transcript.length > limit)
        transcript = transcript.slice(-limit);
    return transcript;
}
function buildRealtimeBody(batch, account, quoteText) {
    const joined = batch.messages.map(renderMessageText).join("\n");
    // "Leading" is singular and applies once, to the front of the whole batch —
    // only the message that opened the window can plausibly start with "@bot".
    const text = stripLeadingMention(joined, account.selfId);
    const currentBlock = quoteText ? `${quoteText}\n${text}` : text;
    // Accumulated chat context is prepended to `body` only — never to
    // `rawBody`/`commandBody`, so the command parser still sees just the user's
    // actual input, not the surrounding history.
    const historyText = renderHistoryReference(batch.history, account);
    const imageUrls = batch.messages.flatMap((m) => m.imageUrls);
    if (!historyText) {
        return { body: currentBlock, rawBody: text, commandBody: text, imageUrls, senderLabelInBody: false };
    }
    // In a group the host prefixes the *whole* body with "name (id): ". With a
    // history block in front, that attribution lands on the transcript header and
    // the turn reads as if the current sender said every historical line. Attach
    // the label to the current message ourselves instead, and let the caller drop
    // the host-level prefix. (Direct chats get no such prefix — nothing to move.)
    const last = batch.messages[batch.messages.length - 1];
    const label = batch.peerKind === "group" ? renderSenderLabel(last.senderName, last.senderId) : "";
    const attributed = label ? `${label}: ${currentBlock}` : currentBlock;
    return {
        body: `${HISTORY_HEADER}\n${historyText}\n${HISTORY_FOOTER}\n${attributed}`,
        rawBody: text,
        commandBody: text,
        imageUrls,
        senderLabelInBody: label.length > 0,
    };
}
/**
 * Body shared by the two summarisation paths — the periodic digest and the
 * on-demand `/summary` command. Both are a synthetic prompt over a rendered
 * transcript; only the prompt and the character budget differ.
 */
function buildTranscriptBody(batch, prompt, maxTranscriptChars) {
    const lines = batch.messages.map((msg) => renderTranscriptLine(msg));
    // The aggregator already trims its buffer against `maxTranscriptChars`, but
    // that budget is measured on raw message text — the rendered
    // "[HH:mm:ss] name(id): text" lines are longer, so re-trim the actual
    // transcript we are about to send from the oldest end.
    while (lines.length > 1 && lines.join("\n").length > maxTranscriptChars) {
        lines.shift();
    }
    let transcript = lines.join("\n");
    if (transcript.length > maxTranscriptChars) {
        transcript = transcript.slice(-maxTranscriptChars);
    }
    const body = `${prompt}\n\n${transcript}`;
    // A summarisation turn is a synthetic prompt, not user input — giving it an
    // empty CommandBody/RawBody means there is no text for the command parser to
    // even look at, on top of CommandAuthorized always being false. (The
    // transcript itself may well contain a line that reads like "/reset".)
    return { body, rawBody: "", commandBody: "", imageUrls: [], senderLabelInBody: false };
}
/** Compose the agent-visible text for a batch (quote context, transcript, media placeholders). */
export function buildBatchBody(batch, account, quoteText) {
    if (batch.kind === "digest") {
        const { prompt, maxTranscriptChars } = account.receive.digest;
        return buildTranscriptBody(batch, prompt, maxTranscriptChars);
    }
    if (batch.kind === "summary") {
        const { prompt, maxTranscriptChars } = account.receive.summary;
        return buildTranscriptBody(batch, prompt, maxTranscriptChars);
    }
    return buildRealtimeBody(batch, account, quoteText);
}
/**
 * Every participant a realtime group reply may @ by the tokens the agent saw in its
 * prompt: senders of the current batch plus the reply-history buffer, keyed by both
 * the sanitized display name (what `renderTranscriptLine`/`renderSegments` showed)
 * and the bare id string (what the `name(id)` labels showed). Later entries win, so
 * a duplicated display name resolves to its most recent speaker.
 */
function collectMentionTargets(batch) {
    const targets = new Map();
    const add = (msg) => {
        const name = sanitizeDisplayName(msg.senderName);
        if (name)
            targets.set(name, msg.senderId);
        targets.set(String(msg.senderId), msg.senderId);
    };
    for (const msg of batch.history ?? [])
        add(msg);
    for (const msg of batch.messages)
        add(msg);
    return targets;
}
/**
 * A trailing line naming the messages whose images were tried and FAILED, so
 * the agent can still reach them with `snowluma_view_image`.
 *
 * Attachment is the normal path and needs no handle — the picture is simply
 * there. But a download can fail (an expired QQ `rkey`, an SSRF-blocked LAN
 * URL, the phase budget running out), and then the body says `[图片]` with
 * nothing behind it and no id to ask about. The quoted and history paths both
 * carry handles for exactly this reason; this closes the same gap for the
 * current message.
 *
 * `failedUrls` must be exactly "attempted minus attached", never "everything
 * the message carried". An image the operator excluded on purpose is not a
 * failure, and inviting the agent to fetch it anyway would quietly undo the
 * setting: a url dropped by `image.maxPerMessage` would hand the agent a way
 * around that ceiling, and with `image.enabled: false` every single picture
 * would be advertised. The caller also gates on `image.tool`, since naming a
 * tool that was never registered is worse than saying nothing.
 *
 * Ids go through `safeMessageIdHandle` for the usual reason — this is a
 * structural slot in an agent-visible body.
 */
export function renderUnattachedImageHint(messages, failedUrls) {
    if (failedUrls.size === 0)
        return "";
    const ids = [];
    for (const msg of messages) {
        if (!msg.imageUrls.some((url) => failedUrls.has(url)))
            continue;
        const handle = safeMessageIdHandle(msg.messageId);
        if (handle && !ids.includes(handle))
            ids.push(handle);
    }
    if (ids.length === 0)
        return "";
    const list = ids.map((id) => `messageId=${id}`).join("、");
    return `（部分图片未能随消息送达，可用 snowluma_view_image ${list} 查看）`;
}
/** The last message (scanning backward) that carries a quote or a forward — realtime only. */
function findQuoteSource(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.replyToId || m.forwardIds.length > 0)
            return m;
    }
    return undefined;
}
/**
 * Does a digest reply mean "nothing worth reporting"? The prompt asks for a
 * bare `SKIP`, but a model that dresses it up (`**SKIP**`, `## SKIP`,
 * `- skip`) means exactly the same thing. Emphasis is already gone by the time
 * this runs — the reply has been flattened — so all that is left to peel off is
 * the decoration `markdown-text.ts` itself adds for headings and list items.
 */
function isDigestSkip(text) {
    const bare = text
        .trim()
        .replace(/^[•◦·｜]\s*/, "")
        .replace(/^【([\s\S]*)】$/, "$1")
        .trim();
    return bare.toUpperCase() === "SKIP";
}
// ── Dispatch ─────────────────────────────────────────────────────────────
/**
 * Hand one aggregated batch to the agent and stream its reply back to QQ.
 * Never rejects: every failure mode (quote resolution, the dispatch call
 * itself, a send) is caught and logged rather than thrown, so a bad batch
 * can never take the gateway's event loop down with it.
 */
export async function dispatchBatch(batch, deps) {
    const { account, cfg, client, log } = deps;
    try {
        if (batch.messages.length === 0)
            return;
        const runtime = deps.runtime ?? getSnowLumaRuntime();
        const resolveQuote = deps.resolveQuote ?? defaultResolveQuoteContext;
        const resolveImages = deps.resolveImages ?? defaultResolveInboundImages;
        const send = deps.send ?? { sendText: defaultSendText, sendMedia: defaultSendMedia };
        // In debug mode, every outbound send records its raw payload. Emitted at
        // `info` level so it is actually visible when the operator flips the flag on.
        const outboundDebug = account.debug
            ? { log: (line) => log?.info?.(`[snowluma:${account.accountId}] ${line}`) }
            : undefined;
        const first = batch.messages[0];
        const last = batch.messages[batch.messages.length - 1];
        // Who the turn is attributed to. For a `/summary` batch that is the member
        // who typed the command — the transcript's own last speaker is incidental.
        const origin = batch.commandMessage ?? last;
        const address = `snowluma:${batch.peerId}`;
        runtime.channel.activity.record({ channel: "snowluma", accountId: account.accountId, direction: "inbound" });
        const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: "snowluma",
            accountId: account.accountId,
            peer: { kind: batch.peerKind, id: batch.peerId },
        });
        let quoteText = "";
        if (batch.kind === "realtime") {
            const quoteSource = findQuoteSource(batch.messages);
            if (quoteSource) {
                try {
                    const resolved = await resolveQuote(quoteSource, { client, quote: account.quote, log });
                    quoteText = formatQuoteContext(resolved, { imageHint: imageToolAvailable(account) });
                }
                catch (err) {
                    log?.error?.(`[snowluma:${account.accountId}] quote resolution failed: ${String(err)}`);
                }
            }
        }
        const composed = buildBatchBody(batch, account, quoteText);
        // A realtime turn that composed to nothing actionable — no text (e.g. a bare
        // `@bot` whose only content was the mention we stripped, or a reply-to-self
        // with an empty body), no quote, no history, and no image — would reach the
        // OpenClaw runtime as an empty inbound turn. The runtime answers that with a
        // canned "I didn't receive any text in your message. Please resend or add a
        // caption." which then gets posted back to QQ. Skip the dispatch entirely so
        // nothing is sent. (Digest turns always carry their prompt, so this never
        // fires for them.)
        if (batch.kind === "realtime" && composed.body.trim().length === 0 && composed.imageUrls.length === 0) {
            log?.debug?.(`[snowluma:${account.accountId}] skipping empty realtime turn for ${batch.peerId} (no text/quote/history/media)`);
            return;
        }
        // Downloading happens here, after the empty-turn guard and before the
        // envelope is formatted: only a turn that is actually going to the agent is
        // worth spending a fetch on, and the body still has to be able to say which
        // images did NOT make it. A failed download degrades to the url-only fields
        // (plus that hint) rather than failing the turn.
        let attachments = [];
        if (composed.imageUrls.length > 0 && account.image.enabled) {
            try {
                attachments = await resolveImages(composed.imageUrls, {
                    runtime,
                    image: account.image,
                    trustedHost: endpointHost(account.httpUrl, account.wsUrl),
                    log,
                });
                if (attachments.length > 0) {
                    log?.debug?.(`[snowluma:${account.accountId}] attached ${attachments.length}/${composed.imageUrls.length} image(s) for ${batch.peerId}`);
                }
            }
            catch (err) {
                // `resolveInboundImages` is written not to throw, but the host media
                // helpers it drives are not ours. A broken media stack must cost the
                // picture, not the reply — fall through to the url-only fields.
                log?.error?.(`[snowluma:${account.accountId}] image resolution failed: ${String(err)}`);
            }
        }
        const mediaFields = buildMediaContextFields(attachments, composed.imageUrls);
        // Only realtime batches carry images at all (a digest/summary transcript
        // reports `imageUrls: []`), so this is where the recovery hint belongs.
        //
        // "Failed" means attempted-and-lost, not merely absent: `selectInboundImageUrls`
        // is the same selection `resolveInboundImages` made, so a url the cap or
        // `image.enabled: false` excluded never counts. And the hint names a tool,
        // so it stays silent unless that tool is actually registered.
        let unattachedHint = "";
        if (batch.kind === "realtime" && composed.imageUrls.length > 0 && imageToolAvailable(account)) {
            const attachedUrls = new Set(attachments.map((a) => a.url));
            const failedUrls = new Set(selectInboundImageUrls(composed.imageUrls, account.image).filter((url) => !attachedUrls.has(url)));
            unattachedHint = renderUnattachedImageHint(batch.messages, failedUrls);
        }
        const bodyForAgent = unattachedHint ? `${composed.body}\n${unattachedHint}` : composed.body;
        const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
        // In a group the host prefixes the body with "name (id): " and puts `from`
        // in the envelope header — correct for a realtime turn, wrong for a
        // summarisation one: a digest/summary body is our own prompt, not something
        // the last speaker said, and attributing it to them makes the agent read the
        // instruction as that user's message. Those turns therefore carry no sender
        // attribution at all.
        const isSummarisation = batch.kind !== "realtime";
        // `formatInboundEnvelope` was removed from the runtime's reply surface
        // (present through openclaw 2026.5.x, gone by 2026.8.1). `src/envelope.ts`
        // ports its sender-attribution half and delegates the bracketed header to
        // `formatAgentEnvelope`, which the host still provides; older hosts that
        // predate `formatAgentEnvelope` fall back to their own `formatInboundEnvelope`.
        const replyRuntime = runtime.channel.reply;
        const envelopeParams = {
            channel: "SnowLuma",
            // `from` is required by the host's signature, so pass "" — it is
            // normalized away and the header part is dropped entirely.
            ...(isSummarisation
                ? { from: "" }
                : {
                    from: last.senderName,
                    // `composed.body` already carries the label when a history block
                    // pushed it away from the front (see `buildRealtimeBody`); passing
                    // `sender` too would re-prefix the whole body, transcript included.
                    ...(composed.senderLabelInBody
                        ? {}
                        : { sender: { id: String(last.senderId), name: last.senderName } }),
                }),
            timestamp: origin.time * 1000,
            body: bodyForAgent,
            chatType: batch.peerKind,
            envelope: envelopeOptions,
        };
        const envelopeBody = typeof replyRuntime.formatAgentEnvelope === "function"
            ? formatInboundEnvelope(envelopeParams, replyRuntime.formatAgentEnvelope)
            : typeof replyRuntime.formatInboundEnvelope === "function"
                ? replyRuntime.formatInboundEnvelope(envelopeParams)
                : envelopeParams.body;
        // A summarisation turn feeds the agent a chat window, not a command from a
        // specific user — it must never be able to run a privileged text command, so
        // CommandAuthorized is hard-wired false and CommandSource is omitted
        // entirely (rather than merely false) for those paths. `/summary` is no
        // exception: the user authorized a summary, not whatever the transcript
        // happens to contain.
        const commandAuthorized = isSummarisation
            ? false
            : resolveInboundCommandAuthorization({ runtime, cfg, allowFrom: account.allowFrom, peerId: batch.peerId });
        const ctxPayload = runtime.channel.reply.finalizeInboundContext({
            Body: envelopeBody,
            // `BodyForAgent` is what the runtime feeds the model as the turn's prompt.
            // We set it explicitly (rather than letting the host derive it) for two
            // reasons: (1) a digest turn passes empty-string RawBody/CommandBody, and
            // the host's `BodyForAgent ?? CommandBody ?? RawBody ?? Body` fallback stops
            // at the empty *string* (`??` only skips null/undefined) — which poisoned
            // BodyForAgent → BodyStripped → the whole turn to "", so the digest never
            // summarised and the host returned its canned "empty inbound" notice;
            // (2) it guarantees the agent sees the full composed body (reply-history +
            // quote context + transcript), not just the current line. Command routing
            // still reads the (empty, for digest) CommandBody, so digest stays inert.
            BodyForAgent: envelopeBody,
            RawBody: composed.rawBody,
            CommandBody: composed.commandBody,
            From: address,
            To: address,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: batch.peerKind,
            SenderId: String(origin.senderId),
            SenderName: origin.senderName,
            Provider: "snowluma",
            Surface: "snowluma",
            MessageSid: String(origin.messageId),
            Timestamp: origin.time * 1000,
            CommandAuthorized: commandAuthorized,
            ...(batch.kind === "realtime" ? { CommandSource: "text" } : {}),
            OriginatingChannel: "snowluma",
            OriginatingTo: address,
            ...mediaFields,
        });
        const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);
        // Realtime group replies get their `@名字`/`@QQ号` tokens rewritten into real
        // mention codes — but only for participants of this very batch (current
        // messages + history buffer), so the agent can only ping people it was
        // actually shown. Private chats have no one to mention; summarisation
        // replies may quote transcript text verbatim, so they never rewrite (and
        // never convert codes either — see `convertAtCodes` below).
        const mentionTargets = batch.kind === "realtime" && batch.peerKind === "group" ? collectMentionTargets(batch) : undefined;
        const sendErrorNotice = async (errorText) => {
            try {
                // Error text embeds upstream strings verbatim — never let a stray
                // `[CQ:at,...]` inside one become a real ping.
                await send.sendText({
                    client,
                    to: address,
                    text: errorText,
                    chunkLimit: account.textChunkLimit,
                    convertAtCodes: false,
                    debug: outboundDebug,
                });
            }
            catch (sendErr) {
                log?.error?.(`[snowluma:${account.accountId}] failed to send error notice: ${String(sendErr)}`);
            }
        };
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
                responsePrefix: messagesConfig.responsePrefix,
                deliver: async (payload, _info) => {
                    const trimmed = (payload.text ?? "").trim();
                    // Never relay OpenClaw's canned "empty inbound" notice back to QQ. It
                    // is produced by the runtime (not the agent) for turns it deems empty,
                    // which we can't always detect upstream — drop it here as the reliable
                    // backstop. Nothing else in such a payload is worth sending.
                    if (trimmed.includes(OPENCLAW_EMPTY_INPUT_NOTICE)) {
                        log?.info?.(`[snowluma:${account.accountId}] suppressed OpenClaw empty-input notice — nothing sent`);
                        return;
                    }
                    const replyText = payload.text ?? "";
                    // A summarisation reply is long structured Markdown, and QQ renders
                    // none of it — `## 今日总结` / `**周四**` would arrive with the syntax
                    // showing. Flatten it to chat-readable text first. Realtime replies
                    // are short and conversational, so they go out untouched apart from
                    // mention rewriting (`@名字` → a real at, for known participants only).
                    const outgoingText = isSummarisation
                        ? markdownToText(replyText)
                        : mentionTargets
                            ? markdownToText(rewriteNameMentions(replyText, mentionTargets))
                            : markdownToText(replyText);
                    // Checked on the FLATTENED text, before anything is sent: a model that
                    // decorates its refusal (`**SKIP**`) would slip past a raw comparison
                    // and then flatten right back to "SKIP" on the way out — i.e. the
                    // digest that meant "nothing to report" posts the word to the group.
                    if (batch.kind === "digest" && isDigestSkip(outgoingText)) {
                        log?.info?.(`[snowluma:${account.accountId}] digest reply was SKIP — nothing sent`);
                        return;
                    }
                    const mediaPaths = [];
                    if (payload.mediaUrls?.length)
                        mediaPaths.push(...payload.mediaUrls);
                    if (payload.mediaUrl && !mediaPaths.includes(payload.mediaUrl))
                        mediaPaths.push(payload.mediaUrl);
                    const replyToId = account.replyToTrigger
                        ? batch.kind === "realtime"
                            ? first.messageId
                            : batch.commandMessage?.messageId
                        : undefined;
                    for (const mediaPath of mediaPaths) {
                        try {
                            await send.sendMedia({ client, to: address, mediaPath, replyToId, debug: outboundDebug });
                        }
                        catch (err) {
                            log?.error?.(`[snowluma:${account.accountId}] media send failed: ${String(err)}`);
                        }
                    }
                    // A media-only payload is legitimate — the images went out above.
                    if (!replyText.trim())
                        return;
                    if (!outgoingText.trim()) {
                        log?.info?.(`[snowluma:${account.accountId}] reply was empty after markdown flattening — nothing sent`);
                        return;
                    }
                    try {
                        await send.sendText({
                            client,
                            to: address,
                            text: outgoingText,
                            replyToId,
                            partDelayMs: account.partDelayMs ?? 0,
                            chunkLimit: account.textChunkLimit,
                            convertAtCodes: !isSummarisation,
                            debug: outboundDebug,
                        });
                        runtime.channel.activity.record({
                            channel: "snowluma",
                            accountId: account.accountId,
                            direction: "outbound",
                        });
                    }
                    catch (err) {
                        log?.error?.(`[snowluma:${account.accountId}] send failed: ${String(err)}`);
                    }
                },
                onError: async (err) => {
                    const cause = err?.cause?.code || err?.cause?.message || "";
                    const detail = `${String(err)}${cause ? ` (${cause})` : ""}`;
                    log?.error?.(`[snowluma:${account.accountId}] dispatch error: ${detail}`);
                    await sendErrorNotice("（刚刚信号晃了一下没接上，你再发一句试试~）");
                },
            },
            replyOptions: {},
        });
    }
    catch (err) {
        deps.log?.error?.(`[snowluma:${deps.account.accountId}] dispatchBatch failed: ${String(err)}`);
    }
}
//# sourceMappingURL=dispatch.js.map
/**
 * Inbound image resolution — QQ image URLs → real local attachments.
 *
 * QQ delivers images as `{type:"image",data:{url,file}}` segments pointing at a
 * CDN (or, for some OneBot implementations, at the impl's own HTTP file
 * server). `segments.ts` already extracts those URLs; this module is what turns
 * them into something a vision model can actually see.
 *
 * WHY A DOWNLOAD IS REQUIRED. OpenClaw attaches an inbound image to the model
 * turn by writing `[media attached: <path> …]` into the prompt (built from the
 * ordered `ctx.media` facts) and letting the embedded agent's
 * `detectImageReferences` pick that path back out. The detector explicitly
 * REJECTS `http://`/`https://` references, so a url-only fact is never loaded
 * into the turn. The plugin therefore has to fetch the bytes itself and hand the
 * host a local path, exactly like the bundled Slack/Telegram/Mattermost channels
 * do.
 *
 * WHY THE HOST RUNTIME DOES THE WORK. Downloading and storing go through
 * `runtime.channel.media.{readRemoteMediaBuffer,saveMediaBuffer}` rather than a
 * bare `fetch()` + `fs.writeFile`: `readRemoteMediaBuffer` carries the host's SSRF guard,
 * redirect cap and byte ceiling, and `saveMediaBuffer` writes into the media
 * store — one of the host's default media local roots, i.e. the one directory
 * the agent may read images back from with no extra configuration. Both are
 * reached off the already-injected `PluginRuntime` object, so this module still
 * imports nothing from `openclaw/*` at runtime (CLAUDE.md → hard constraints).
 *
 * Every entry point here is total: a failed download, a host runtime too old to
 * expose `channel.media`, an oversized or non-image payload — all come back as
 * "no attachment" (or `{ ok: false }`), never a throw. Losing an image must
 * never take an inbound turn down with it; the `[图片]` placeholder
 * `renderSegments` already put in the body stays as the fallback.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedImageConfig } from "./types.js";
/** `SavedMedia` from the host's media store. */
export interface SavedMediaLike {
    id?: string;
    path: string;
    size?: number;
    contentType?: string;
}
/** `FetchMediaResult` from the host's guarded media fetcher. */
export interface FetchedMediaLike {
    buffer: Uint8Array;
    contentType?: string;
    fileName?: string;
}
/**
 * The slice of `PluginRuntime` this module uses, declared structurally rather
 * than imported as `PluginRuntime`.
 *
 * Two reasons: tests hand in a small literal instead of a whole host double,
 * and — more importantly — every member is optional, so a host older than the
 * peer range's newest release (or a future one that moves these helpers)
 * degrades to "no image support" instead of throwing `undefined is not a
 * function` on the first photo somebody posts.
 */
export interface MediaRuntimeLike {
    channel?: {
        media?: {
            /** openclaw >= 2026.8.1. `fetchRemoteMedia` is its deprecated alias. */
            readRemoteMediaBuffer?: (options: {
                url: string;
                maxBytes?: number;
                maxRedirects?: number;
                readIdleTimeoutMs?: number;
                filePathHint?: string;
                requestInit?: {
                    signal?: AbortSignal;
                };
                ssrfPolicy?: {
                    allowPrivateNetwork?: boolean;
                    allowedHostnames?: string[];
                };
            }) => Promise<FetchedMediaLike>;
            /** @deprecated Older hosts only; superseded by `readRemoteMediaBuffer`. */
            fetchRemoteMedia?: (options: {
                url: string;
                maxBytes?: number;
                maxRedirects?: number;
                readIdleTimeoutMs?: number;
                filePathHint?: string;
                requestInit?: {
                    signal?: AbortSignal;
                };
                ssrfPolicy?: {
                    allowPrivateNetwork?: boolean;
                    allowedHostnames?: string[];
                };
            }) => Promise<FetchedMediaLike>;
            saveMediaBuffer?: (buffer: Buffer, contentType?: string, subdir?: string, maxBytes?: number, originalFilename?: string) => Promise<SavedMediaLike>;
        };
    };
    media?: {
        detectMime?: (opts: {
            buffer?: Buffer;
            headerMime?: string | null;
            filePath?: string;
        }) => Promise<string | undefined>;
        getImageMetadata?: (buffer: Buffer) => Promise<{
            width: number;
            height: number;
        } | null>;
        resizeToJpeg?: (params: {
            buffer: Buffer;
            maxSide: number;
            quality: number;
            withoutEnlargement?: boolean;
        }) => Promise<Buffer>;
    };
    mediaUnderstanding?: {
        describeImageFile?: (params: {
            filePath: string;
            cfg: OpenClawConfig;
            mime?: string;
            prompt?: string;
            timeoutMs?: number;
        }) => Promise<{
            text?: string;
            provider?: string;
            model?: string;
        }>;
    };
}
export interface ImageLogger {
    info?(m: string): void;
    error?(m: string): void;
    debug?(m: string): void;
}
export interface ImageDeps {
    /** Host runtime; `null`/`undefined` means "no image support available". */
    runtime?: MediaRuntimeLike | null;
    image: ResolvedImageConfig;
    /**
     * Hostname of the account's own SnowLuma endpoint. Some OneBot
     * implementations serve inbound images off their own HTTP file server, which
     * is normally a LAN address the host's SSRF guard refuses — but it is the very
     * endpoint this account already talks to, so it is exempted by hostname
     * rather than by opening private networks wholesale.
     */
    trustedHost?: string;
    log?: ImageLogger;
    /**
     * Injectable clock for the phase budget in {@link resolveInboundImages},
     * following `aggregator.ts`'s convention so a test can drive the deadline
     * instead of racing a real one. Defaults to `Date.now`.
     */
    now?: () => number;
}
/** One inbound image that made it all the way to a local file. */
export interface ResolvedImageAttachment {
    /** The original QQ URL, kept for the media note and for logs. */
    url: string;
    /** Absolute path inside the host's media store. */
    path: string;
    mime: string;
    bytes: number;
}
/** An image loaded into memory, for the agent tool's `image` mode. */
export interface LoadedImage {
    base64: string;
    mime: string;
    bytes: number;
    /** Set when the bytes were also persisted to the media store. */
    path?: string;
}
/**
 * Hostname suffixes QQ serves image content from. Used ONLY to gate URLs the
 * AGENT supplies to `snowluma_view_image` — an unrestricted "fetch this URL"
 * tool would hand the model a plain SSRF primitive. URLs that came off an
 * inbound event are not filtered by this: they arrive with the rest of the
 * event and are trusted at the same level as it.
 */
export declare const DEFAULT_IMAGE_HOSTS: string[];
/** Hostname of `url`, lowercased; `undefined` when it is not a parseable http(s) URL. */
export declare function imageUrlHost(url: string): string | undefined;
/**
 * Hostname of the account's own SnowLuma endpoint, from whichever of
 * `httpUrl`/`wsUrl` parses first. `new URL` handles `ws:`/`wss:` as happily as
 * `http:`, so both forms work.
 */
export declare function endpointHost(...urls: (string | undefined)[]): string | undefined;
/**
 * Whether the agent may ask us to download this URL. `"*"` anywhere in
 * `allowedHosts` disables the check entirely (operator opt-in), and the
 * account's own SnowLuma host is always allowed.
 */
export declare function isAllowedImageUrl(url: string, allowedHosts: string[], trustedHost?: string): boolean;
/**
 * Bound a host call that has no total-timeout parameter of its own.
 * `readRemoteMediaBuffer` exposes only a per-chunk idle timeout, so a connection
 * that stalls before the first byte could otherwise hold an inbound turn open
 * indefinitely.
 *
 * `onTimeout` is where the caller actually cancels the underlying work (an
 * `AbortController`, for the download path). Racing alone would only stop us
 * waiting — the request would keep running and keep its socket. Mirrors the
 * bundled Slack channel's `fetchSlackMedia`, including the two details that are
 * easy to miss: the timer is `unref()`ed so a pending download cannot by itself
 * hold the process open, and the losing promise's rejection is swallowed rather
 * than left to surface as an unhandled rejection after we have already moved on.
 */
export declare function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T>;
/** Download one image into memory through the host's guarded fetcher. */
export declare function downloadImage(url: string, deps: ImageDeps): Promise<{
    ok: true;
    buffer: Buffer;
    mime: string;
    fileName?: string;
} | {
    ok: false;
    error: string;
}>;
/**
 * OpenClaw's own ceiling for an image returned by a TOOL
 * (`src/agents/image-sanitization.ts`: 1200px longest edge, 5 MiB), and the
 * config key that moves the first of the two.
 *
 * This matters only for `snowluma_view_image`. An INBOUND attachment is
 * re-sanitized by the host itself — `detectAndLoadPromptImages` runs every
 * prompt image through `sanitizeImageBlocks` before the model sees it — but a
 * plugin tool's `content` blocks go to the model as written, so the tool has to
 * apply that envelope itself or it would be the one path shipping images larger
 * than the host's own tools ever do.
 */
export declare const HOST_TOOL_IMAGE_MAX_DIMENSION_PX = 1200;
export declare const HOST_TOOL_IMAGE_MAX_BYTES: number;
export interface ImageEnvelope {
    /** Longest edge, in pixels. `0` disables the dimension check. */
    maxDimensionPx: number;
    maxBytes: number;
}
/** Minimal shape of the host config fields the envelope reads. */
export interface ImageEnvelopeConfigLike {
    agents?: {
        defaults?: {
            imageMaxDimensionPx?: number;
        };
    };
}
/**
 * The envelope for a tool-returned image: the host's tool-image limits
 * (respecting `agents.defaults.imageMaxDimensionPx`), further tightened by the
 * account's own `image.maxDimensionPx` when that is smaller. Never loosened by
 * it — an operator raising the inbound resize threshold should not push tool
 * images past what the host's own tools are allowed to send.
 */
export declare function resolveToolImageEnvelope(cfg: ImageEnvelopeConfigLike | undefined, image: ResolvedImageConfig): ImageEnvelope;
/**
 * The envelope for an image that is only going to disk — an inbound attachment
 * (the host re-sanitizes it before the model sees it) or a `describe`-mode tool
 * call (the bytes go to a file for the vision model to read, never into this
 * turn's context). Both want the account's own limits and nothing stricter.
 */
export declare function resolveStoredImageEnvelope(image: ResolvedImageConfig): ImageEnvelope;
/**
 * Bring an image inside `envelope`, mirroring the host's
 * `resizeImageBase64IfNeeded`: try progressively smaller longest-edges, and
 * within each, progressively lower JPEG quality, stopping at the first result
 * under the byte ceiling.
 *
 * Never throws, and never reports failure — where the host raises "could not be
 * reduced", this returns the smallest candidate it produced with
 * `withinEnvelope: false` and lets the caller decide. That keeps the inbound
 * path (which only wants to save bandwidth, and whose output the host will
 * sanitize again anyway) from losing a picture over it, while the tool path can
 * still refuse to hand the model something oversized.
 */
export declare function fitImage(buffer: Buffer, mime: string, envelope: ImageEnvelope, deps: ImageDeps): Promise<{
    buffer: Buffer;
    mime: string;
    withinEnvelope: boolean;
}>;
/** Persist an image into the host's media store and return its absolute path. */
export declare function storeImage(buffer: Buffer, mime: string, fileName: string | undefined, deps: ImageDeps): Promise<{
    ok: true;
    path: string;
    mime: string;
} | {
    ok: false;
    error: string;
}>;
/**
 * Full pipeline for ONE url: download → shrink → store. Returns `null` (after
 * logging) instead of throwing on any failure.
 */
export declare function resolveImageAttachment(url: string, deps: ImageDeps): Promise<ResolvedImageAttachment | null>;
/**
 * Which of a batch's image urls this run will actually try to fetch: deduped,
 * in order, capped at `image.maxPerMessage`, empty when images are off.
 *
 * Exported because `dispatch.ts` needs the same list to tell a genuine download
 * FAILURE from an image that was never attempted — a url dropped by the cap is
 * not a failure, and offering the agent a "fetch it yourself" hint for one would
 * hand it a way around the ceiling the cap exists to enforce.
 */
export declare function selectInboundImageUrls(urls: string[], image: ResolvedImageConfig): string[];
/**
 * Resolve every image of one inbound batch, capped at `image.maxPerMessage` and
 * returned in the order the images appeared. Failures are skipped — a batch
 * where two of three images downloaded still attaches those two.
 *
 * WHY THERE IS A PHASE BUDGET. This blocks `dispatchBatch`: nothing reaches the
 * agent until it returns, and the user sees no reply and no typing indicator
 * while it runs. `image.timeoutMs` bounds one download, but on its own the
 * phase still scales with the picture count — at concurrency 3, ten dead URLs
 * would be four rounds, i.e. four times a single image's budget. So
 * `image.totalTimeoutMs` caps the phase as a whole, and it is a HARD cap: each
 * download's own timeout is shortened to whatever is left of it, so the last
 * one cannot overrun the deadline it started before. Whatever finished in time
 * is attached; the rest stay `[图片]` placeholders.
 */
export declare function resolveInboundImages(urls: string[], deps: ImageDeps): Promise<ResolvedImageAttachment[]>;
/**
 * The inbound media context fields for one batch.
 *
 * **`media` is the field that matters**: openclaw's prompt note
 * (`[media attached: <path> (<mime>) | <url>]`) is built by
 * `buildInboundMediaNoteProjection`, which reads `ctx.media` — an ordered list
 * of facts where array position IS the attachment's identity — and the embedded
 * agent then loads the picture by parsing that note. A fact needs a local
 * `path`; a url-only fact produces no attachment, because `detectImageReferences`
 * still explicitly rejects `http://`/`https://` references (re-verified against
 * openclaw 2026.8.1). That is why `resolveInboundImages` downloads first.
 *
 * The parallel `Media*` fields are the LEGACY projection of the same list.
 * openclaw still folds them into `ctx.media` (`resolveMediaFactsWithPrecedence`,
 * called from the SDK's `finalizeInboundContext`), but the compatibility record
 * `media-legacy-projection` is removal-eligible from **2026-10-01**. They are
 * emitted here purely so an older host keeps working, and they are built from
 * the same array in the same order, so whichever side the host gives precedence
 * to it reads identical values.
 *
 * When nothing could be downloaded we still pass the raw URLs — enough for
 * `hasInboundMedia` and for the media-understanding runner's url-only path, even
 * though no note is produced from them.
 */
export declare function buildMediaContextFields(attachments: ResolvedImageAttachment[], fallbackUrls: string[]): Record<string, unknown>;
/**
 * Pull image references out of a `get_msg`-style payload — **exactly one per
 * image segment**, `url` preferred and `file` as the fallback.
 *
 * One-per-segment is the whole contract, and it is load-bearing: the count this
 * produces is what `snowluma_view_image`'s `index` parameter indexes into, and
 * the count the agent is *told* about comes from `extractImageUrls`
 * (`segments.ts`), which resolves each image segment to a single
 * `firstNonEmpty(url, file)`. Emitting both fields would make one picture look
 * like two, so `index: 2` on a two-image message would return image #1's bare
 * `file` ("a.png") instead of image #2 — and NapCat populates both fields on
 * every image, so that is the normal case, not an edge one.
 *
 * A data-URL payload is returned verbatim so the caller can decode it without a
 * network round trip.
 */
export declare function extractImageRefsFromRaw(raw: unknown): string[];
/**
 * `data:image/png;base64,...` → decoded bytes.
 *
 * `mime` is the caller-facing convenience (declared type, or `image/jpeg` when
 * the URL declares none); `declaredMime` is `undefined` in that second case, so
 * a caller that sniffs can tell "said nothing" from "said image/jpeg" instead
 * of inheriting a guess.
 */
export declare function decodeDataUrl(ref: string): {
    buffer: Buffer;
    mime: string;
    declaredMime?: string;
} | null;
/**
 * Load one agent-supplied image reference for `snowluma_view_image`.
 *
 * Two things separate this from {@link resolveInboundImages}. It enforces the
 * host allowlist — the reference came from the model, and an unfiltered fetcher
 * would be an SSRF primitive. And it enforces `envelope`, because a plugin
 * tool's content blocks reach the model exactly as written: nothing downstream
 * re-sanitizes them the way `detectAndLoadPromptImages` re-sanitizes an inbound
 * attachment. Data URLs bypass the network entirely, but not the envelope.
 */
export declare function loadImageForTool(ref: string, deps: ImageDeps, envelope?: ImageEnvelope): Promise<{
    ok: true;
    image: LoadedImage;
} | {
    ok: false;
    error: string;
}>;
/**
 * Ask OpenClaw's media-understanding stack to describe a stored image.
 *
 * This is the escape hatch for a primary model that cannot see images at all:
 * the description comes back as text from whatever vision model
 * `tools.media.image` points at, and the agent reads that instead of pixels.
 */
export declare function describeStoredImage(params: {
    filePath: string;
    mime?: string;
    prompt?: string;
    cfg: OpenClawConfig;
    deps: ImageDeps;
}): Promise<{
    ok: true;
    text: string;
    provider?: string;
    model?: string;
} | {
    ok: false;
    error: string;
}>;
//# sourceMappingURL=image.d.ts.map
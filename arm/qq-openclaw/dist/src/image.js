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
// ── URL policy ─────────────────────────────────────────────────────────────
/**
 * Hostname suffixes QQ serves image content from. Used ONLY to gate URLs the
 * AGENT supplies to `snowluma_view_image` — an unrestricted "fetch this URL"
 * tool would hand the model a plain SSRF primitive. URLs that came off an
 * inbound event are not filtered by this: they arrive with the rest of the
 * event and are trusted at the same level as it.
 */
export const DEFAULT_IMAGE_HOSTS = [
    "qq.com",
    "qq.com.cn",
    "qpic.cn",
    "qlogo.cn",
    "gtimg.cn",
    "qqmail.com",
];
/** Hostname of `url`, lowercased; `undefined` when it is not a parseable http(s) URL. */
export function imageUrlHost(url) {
    try {
        const parsed = new URL(url.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
            return undefined;
        return parsed.hostname.toLowerCase().replace(/\.+$/, "");
    }
    catch {
        return undefined;
    }
}
/**
 * Hostname of the account's own SnowLuma endpoint, from whichever of
 * `httpUrl`/`wsUrl` parses first. `new URL` handles `ws:`/`wss:` as happily as
 * `http:`, so both forms work.
 */
export function endpointHost(...urls) {
    for (const url of urls) {
        const trimmed = url?.trim();
        if (!trimmed)
            continue;
        try {
            const host = new URL(trimmed).hostname.toLowerCase().replace(/\.+$/, "");
            if (host)
                return host;
        }
        catch {
            // Try the next candidate.
        }
    }
    return undefined;
}
/** Suffix match on a label boundary: `qpic.cn` matches `gchat.qpic.cn`, never `evilqpic.cn`. */
function hostMatches(host, pattern) {
    const needle = pattern.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    if (!needle)
        return false;
    return host === needle || host.endsWith(`.${needle}`);
}
/**
 * Whether the agent may ask us to download this URL. `"*"` anywhere in
 * `allowedHosts` disables the check entirely (operator opt-in), and the
 * account's own SnowLuma host is always allowed.
 */
export function isAllowedImageUrl(url, allowedHosts, trustedHost) {
    const host = imageUrlHost(url);
    if (!host)
        return false;
    if (trustedHost && host === trustedHost.toLowerCase())
        return true;
    return allowedHosts.some((pattern) => pattern.trim() === "*" || hostMatches(host, pattern));
}
// ── Fetch / normalize / store ──────────────────────────────────────────────
const IMAGE_MIME_RE = /^image\//i;
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function describeError(err) {
    return err instanceof Error ? err.message : String(err);
}
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
export async function withTimeout(promise, ms, label, onTimeout) {
    if (!Number.isFinite(ms) || ms <= 0)
        return promise;
    let timedOut = false;
    let timer;
    const guarded = promise.catch((err) => {
        // Aborting makes `promise` reject; that rejection is the timeout we already
        // reported, so park it forever instead of letting it escape.
        if (timedOut)
            return new Promise(() => { });
        throw err;
    });
    try {
        return await Promise.race([
            guarded,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    try {
                        onTimeout?.();
                    }
                    catch {
                        // Cancelling is best-effort; the timeout is reported either way.
                    }
                    reject(new Error(`${label} timed out after ${ms}ms`));
                }, ms);
                // `unref` is Node-only; guard so this stays usable under other runtimes.
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/** File-name hint for the media store, derived from the URL path when it looks like one. */
function fileNameHint(url, fallbackMime) {
    try {
        const name = new URL(url).pathname.split("/").filter(Boolean).pop();
        if (name && /\.[a-z0-9]{1,5}$/i.test(name))
            return decodeURIComponent(name);
    }
    catch {
        // Not a parseable URL — let the store name the file itself.
    }
    const ext = fallbackMime.split("/")[1];
    return ext ? `image.${ext.split("+")[0]}` : undefined;
}
/**
 * SSRF policy for one URL. The host blocks private-network targets by default;
 * an image served by the account's own SnowLuma endpoint is exempted by
 * hostname, and `image.allowPrivateNetwork` is the blanket operator override
 * for setups whose images come off some other LAN address.
 */
function ssrfPolicyFor(url, deps) {
    if (deps.image.allowPrivateNetwork)
        return { allowPrivateNetwork: true };
    const host = imageUrlHost(url);
    const trusted = deps.trustedHost?.toLowerCase();
    if (host && trusted && host === trusted) {
        return { allowPrivateNetwork: true, allowedHostnames: [host] };
    }
    return undefined;
}
/**
 * Magic-number sniff for the image formats a model can actually consume.
 *
 * Local on purpose, and the authority for the "is this an image at all"
 * decision, for two reasons. It cannot be talked out of its answer by a
 * declared type — which is the whole point, since the declared type is
 * attacker-supplied on both paths that reach here. And it does not depend on
 * the host's `file-type` dynamic import succeeding: if that ever fails to load,
 * `detectMime` returns `undefined` for everything, and a check built only on it
 * would reject every real photo instead of only the fakes.
 */
function sniffImageMagic(buffer) {
    const b = buffer;
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        return "image/jpeg";
    if (b.length >= 8 && b.toString("hex", 0, 8) === "89504e470d0a1a0a")
        return "image/png";
    if (b.length >= 6 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a")) {
        return "image/gif";
    }
    if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
        return "image/webp";
    }
    if (b.length >= 2 && b.toString("ascii", 0, 2) === "BM")
        return "image/bmp";
    if (b.length >= 4 && (b.toString("hex", 0, 4) === "49492a00" || b.toString("hex", 0, 4) === "4d4d002a")) {
        return "image/tiff";
    }
    // ISO-BMFF family: `....ftyp<brand>` — HEIC/HEIF and the AVIF still image.
    if (b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp") {
        const brand = b.toString("ascii", 8, 12).toLowerCase();
        if (brand.startsWith("hei") || brand.startsWith("mif") || brand.startsWith("msf"))
            return "image/heic";
        if (brand.startsWith("avi"))
            return "image/avif";
    }
    return undefined;
}
/**
 * Decide what an image payload actually is, from its bytes — never from what
 * declared it.
 *
 * The declared type is only a claim by the far end (a `Content-Type` header, or
 * the `image/png` in a `data:` URL), and on both paths that reach here it is
 * attacker-controlled. It is deliberately NOT passed to the host's
 * `detectMime`: that helper returns a non-generic `headerMime` verbatim when
 * its own sniff comes up empty (`detectMimeImpl`, and `isGenericMime` counts
 * only `application/octet-stream`/`application/zip` as generic), so handing it
 * the claim is the same as believing the claim. Verified against openclaw
 * 2026.8.1: `detectMime({buffer: <html>, headerMime: "image/png"})` answers
 * `image/png`, while `detectMime({buffer: <html>})` answers `undefined`.
 *
 * `detectMime` is still consulted, bytes-only, as a second opinion for exotic
 * formats the local magic table does not carry.
 */
async function resolveImageMime(buffer, declared, deps) {
    const magic = sniffImageMagic(buffer);
    if (magic)
        return { ok: true, mime: magic };
    const detect = deps.runtime?.media?.detectMime;
    const sniffed = typeof detect === "function" ? await detect({ buffer }).catch(() => undefined) : undefined;
    const mime = (sniffed ?? "").split(";")[0]?.trim() ?? "";
    if (mime && IMAGE_MIME_RE.test(mime))
        return { ok: true, mime };
    // Nothing recognised the bytes as an image. Report what was *claimed*, since
    // that is the useful half of the message for whoever reads the error.
    const claimed = (declared ?? "").split(";")[0]?.trim();
    return { ok: false, mime: mime || (claimed ? `${claimed}（实际内容不是图片）` : "未知类型") };
}
/** Download one image into memory through the host's guarded fetcher. */
export async function downloadImage(url, deps) {
    // openclaw renamed this helper in 2026.8.1 and kept `fetchRemoteMedia` as a
    // deprecated alias of the very same function, so preferring the new name costs
    // nothing and keeps older hosts working.
    const media = deps.runtime?.channel?.media;
    const readRemoteMedia = typeof media?.readRemoteMediaBuffer === "function"
        ? media.readRemoteMediaBuffer
        : media?.fetchRemoteMedia;
    if (typeof readRemoteMedia !== "function") {
        return {
            ok: false,
            error: "当前 OpenClaw 运行时未提供 channel.media.readRemoteMediaBuffer，无法下载图片。",
        };
    }
    try {
        const ssrfPolicy = ssrfPolicyFor(url, deps);
        // The controller is what makes the timeout real: `withTimeout` aborts the
        // in-flight request instead of merely walking away from it.
        const controller = new AbortController();
        const fetched = await withTimeout(readRemoteMedia({
            url,
            maxBytes: deps.image.maxBytes,
            readIdleTimeoutMs: deps.image.timeoutMs,
            filePathHint: fileNameHint(url, "image/jpeg"),
            requestInit: { signal: controller.signal },
            ...(ssrfPolicy ? { ssrfPolicy } : {}),
        }), deps.image.timeoutMs, "image download", () => controller.abort());
        const buffer = Buffer.from(fetched.buffer);
        if (buffer.byteLength === 0)
            return { ok: false, error: "下载到的图片为空。" };
        const resolved = await resolveImageMime(buffer, fetched.contentType, deps);
        if (!resolved.ok)
            return { ok: false, error: `该地址返回的不是图片（${resolved.mime}）。` };
        return { ok: true, buffer, mime: resolved.mime, fileName: fetched.fileName };
    }
    catch (err) {
        return { ok: false, error: describeError(err) };
    }
}
// ── Size envelope ──────────────────────────────────────────────────────────
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
export const HOST_TOOL_IMAGE_MAX_DIMENSION_PX = 1200;
export const HOST_TOOL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * The envelope for a tool-returned image: the host's tool-image limits
 * (respecting `agents.defaults.imageMaxDimensionPx`), further tightened by the
 * account's own `image.maxDimensionPx` when that is smaller. Never loosened by
 * it — an operator raising the inbound resize threshold should not push tool
 * images past what the host's own tools are allowed to send.
 */
export function resolveToolImageEnvelope(cfg, image) {
    const configured = cfg?.agents?.defaults?.imageMaxDimensionPx;
    const hostMax = typeof configured === "number" && Number.isFinite(configured) && configured >= 1
        ? Math.floor(configured)
        : HOST_TOOL_IMAGE_MAX_DIMENSION_PX;
    // `image.maxDimensionPx: 0` means "do not resize inbound"; it must not read as
    // "no ceiling" here, so it falls back to the host's own limit.
    const accountMax = image.maxDimensionPx > 0 ? image.maxDimensionPx : hostMax;
    return {
        maxDimensionPx: Math.min(hostMax, accountMax),
        maxBytes: Math.min(HOST_TOOL_IMAGE_MAX_BYTES, image.maxBytes),
    };
}
/**
 * The envelope for an image that is only going to disk — an inbound attachment
 * (the host re-sanitizes it before the model sees it) or a `describe`-mode tool
 * call (the bytes go to a file for the vision model to read, never into this
 * turn's context). Both want the account's own limits and nothing stricter.
 */
export function resolveStoredImageEnvelope(image) {
    return { maxDimensionPx: image.maxDimensionPx, maxBytes: image.maxBytes };
}
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
export async function fitImage(buffer, mime, envelope, deps) {
    const overBytes = buffer.byteLength > envelope.maxBytes;
    const resize = deps.runtime?.media?.resizeToJpeg;
    const metadata = deps.runtime?.media?.getImageMetadata;
    if (typeof resize !== "function" || (envelope.maxDimensionPx <= 0 && !overBytes)) {
        return { buffer, mime, withinEnvelope: !overBytes };
    }
    // Tracked out here so the failure paths below can report the envelope
    // honestly. Reporting `withinEnvelope` from the byte check alone would call a
    // 4000px image "fitting" whenever the resizer was unavailable or threw —
    // silently defeating the dimension ceiling this function exists to enforce.
    // It stays `false` while unknown: dimensions we could not read are not a
    // violation we can claim, and refusing every image on a host with no working
    // image backend would be worse than passing one through.
    let overDimensions = false;
    try {
        const size = typeof metadata === "function" ? await metadata(buffer).catch(() => null) : null;
        overDimensions =
            envelope.maxDimensionPx > 0 &&
                !!size &&
                (size.width > envelope.maxDimensionPx || size.height > envelope.maxDimensionPx);
        // Already inside the envelope: leave it alone. Re-encoding a small PNG as
        // JPEG would only cost transparency and quality for nothing.
        if (size && !overBytes && !overDimensions)
            return { buffer, mime, withinEnvelope: true };
        // Dimensions unreadable AND the size is fine — nothing actionable, and the
        // resizer would likely fail on the same bytes.
        if (!size && !overBytes)
            return { buffer, mime, withinEnvelope: true };
        const longestEdge = size ? Math.max(size.width, size.height) : envelope.maxDimensionPx;
        const ceiling = envelope.maxDimensionPx > 0 ? envelope.maxDimensionPx : longestEdge;
        let smallest = null;
        for (const side of buildResizeSideGrid(ceiling, Math.min(ceiling, longestEdge) || ceiling)) {
            for (const quality of RESIZE_QUALITY_STEPS) {
                const out = await resize({ buffer, maxSide: side, quality, withoutEnlargement: true });
                if (!out?.byteLength)
                    continue;
                if (!smallest || out.byteLength < smallest.byteLength)
                    smallest = out;
                if (out.byteLength <= envelope.maxBytes) {
                    // The resize also capped the longest edge, so both halves now hold.
                    return { buffer: out, mime: "image/jpeg", withinEnvelope: true };
                }
            }
        }
        if (smallest) {
            deps.log?.debug?.(`[snowluma] image could not be reduced under ${envelope.maxBytes} bytes (best ${smallest.byteLength})`);
            return { buffer: smallest, mime: "image/jpeg", withinEnvelope: false };
        }
    }
    catch (err) {
        deps.log?.debug?.(`[snowluma] image resize failed, using original: ${describeError(err)}`);
    }
    return { buffer, mime, withinEnvelope: !overBytes && !overDimensions };
}
/** Mirrors the host's `IMAGE_REDUCE_QUALITY_STEPS`. */
const RESIZE_QUALITY_STEPS = [85, 75, 65, 55, 45, 35];
/** Mirrors the host's `buildImageResizeSideGrid`: descending, deduped, capped. */
function buildResizeSideGrid(maxSide, sideStart) {
    return [sideStart, 1800, 1600, 1400, 1200, 1000, 800]
        .map((value) => Math.min(maxSide, value))
        .filter((value, idx, arr) => value > 0 && arr.indexOf(value) === idx)
        .sort((a, b) => b - a);
}
/** Persist an image into the host's media store and return its absolute path. */
export async function storeImage(buffer, mime, fileName, deps) {
    const saveMediaBuffer = deps.runtime?.channel?.media?.saveMediaBuffer;
    if (typeof saveMediaBuffer !== "function") {
        return {
            ok: false,
            error: "当前 OpenClaw 运行时未提供 channel.media.saveMediaBuffer，无法保存图片。",
        };
    }
    try {
        const saved = await saveMediaBuffer(buffer, mime, "inbound", deps.image.maxBytes, fileName);
        if (!saved?.path)
            return { ok: false, error: "媒体存储未返回文件路径。" };
        return { ok: true, path: saved.path, mime: saved.contentType || mime };
    }
    catch (err) {
        return { ok: false, error: describeError(err) };
    }
}
/**
 * Full pipeline for ONE url: download → shrink → store. Returns `null` (after
 * logging) instead of throwing on any failure.
 */
export async function resolveImageAttachment(url, deps) {
    const downloaded = await downloadImage(url, deps);
    if (!downloaded.ok) {
        deps.log?.info?.(`[snowluma] image download failed (${url}): ${downloaded.error}`);
        return null;
    }
    const shrunk = await fitImage(downloaded.buffer, downloaded.mime, resolveStoredImageEnvelope(deps.image), deps);
    const stored = await storeImage(shrunk.buffer, shrunk.mime, downloaded.fileName ?? fileNameHint(url, shrunk.mime), deps);
    if (!stored.ok) {
        deps.log?.info?.(`[snowluma] image store failed (${url}): ${stored.error}`);
        return null;
    }
    return { url, path: stored.path, mime: stored.mime, bytes: shrunk.buffer.byteLength };
}
/**
 * How many images download at once. Matches the bundled Slack channel's
 * `MAX_SLACK_MEDIA_CONCURRENCY`, and for the same reason: this runs on the
 * inbound path, before the agent turn starts, so a serial loop would multiply
 * `image.timeoutMs` by the number of pictures somebody happened to paste.
 */
const DOWNLOAD_CONCURRENCY = 3;
/** Concurrency-limited `map` that preserves input order. */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length)
                return;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}
/**
 * Which of a batch's image urls this run will actually try to fetch: deduped,
 * in order, capped at `image.maxPerMessage`, empty when images are off.
 *
 * Exported because `dispatch.ts` needs the same list to tell a genuine download
 * FAILURE from an image that was never attempted — a url dropped by the cap is
 * not a failure, and offering the agent a "fetch it yourself" hint for one would
 * hand it a way around the ceiling the cap exists to enforce.
 */
export function selectInboundImageUrls(urls, image) {
    if (!image.enabled)
        return [];
    const unique = [];
    for (const url of urls) {
        const trimmed = url.trim();
        if (!trimmed || unique.includes(trimmed))
            continue;
        if (unique.length >= image.maxPerMessage)
            break;
        unique.push(trimmed);
    }
    return unique;
}
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
export async function resolveInboundImages(urls, deps) {
    if (!deps.image.enabled || urls.length === 0)
        return [];
    const unique = selectInboundImageUrls(urls, deps.image);
    if (urls.length > unique.length) {
        deps.log?.debug?.(`[snowluma] ${urls.length} inbound image(s), attaching the first ${unique.length} (maxPerMessage=${deps.image.maxPerMessage})`);
    }
    const now = deps.now ?? Date.now;
    const deadline = now() + deps.image.totalTimeoutMs;
    let abandoned = 0;
    const settled = await mapLimit(unique, DOWNLOAD_CONCURRENCY, (url) => {
        const remaining = deadline - now();
        if (remaining <= 0) {
            abandoned += 1;
            return Promise.resolve(null);
        }
        // Shortening the per-image budget to the remaining phase budget is what
        // makes the cap hard rather than "deadline plus one more download".
        const scoped = remaining < deps.image.timeoutMs
            ? { ...deps, image: { ...deps.image, timeoutMs: remaining } }
            : deps;
        return resolveImageAttachment(url, scoped);
    });
    if (abandoned > 0) {
        deps.log?.info?.(`[snowluma] image phase hit its ${deps.image.totalTimeoutMs}ms budget — ${abandoned} image(s) not fetched`);
    }
    // `mapLimit` keeps input order, so filtering the failures out here leaves the
    // survivors in the order they appeared in the message — and array position IS
    // a media fact's identity, so that order is what lines the attachments up with
    // what the reader saw.
    return settled.filter((entry) => entry !== null);
}
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
export function buildMediaContextFields(attachments, fallbackUrls) {
    if (attachments.length > 0) {
        return {
            media: attachments.map((a) => ({
                path: a.path,
                url: a.url,
                contentType: a.mime,
                kind: "image",
            })),
            MediaPath: attachments[0].path,
            MediaPaths: attachments.map((a) => a.path),
            MediaType: attachments[0].mime,
            MediaTypes: attachments.map((a) => a.mime),
            MediaUrl: attachments[0].url,
            MediaUrls: attachments.map((a) => a.url),
        };
    }
    if (fallbackUrls.length > 0) {
        return {
            media: fallbackUrls.map((url) => ({ url, kind: "image" })),
            MediaUrl: fallbackUrls[0],
            MediaUrls: fallbackUrls,
        };
    }
    return {};
}
// ── Tool-side helpers ──────────────────────────────────────────────────────
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
export function extractImageRefsFromRaw(raw) {
    const refs = [];
    const visit = (value, depth) => {
        if (depth > 6)
            return;
        if (Array.isArray(value)) {
            for (const entry of value)
                visit(entry, depth + 1);
            return;
        }
        if (!isRecord(value))
            return;
        if (value.type === "image" && isRecord(value.data)) {
            const url = typeof value.data.url === "string" ? value.data.url.trim() : "";
            const file = typeof value.data.file === "string" ? value.data.file.trim() : "";
            const ref = url || file;
            if (ref)
                refs.push(ref);
            return;
        }
        // `get_msg` nests segments under `message`; forward nodes nest further.
        for (const key of ["message", "content", "data"]) {
            if (key in value)
                visit(value[key], depth + 1);
        }
    };
    visit(raw, 0);
    return refs;
}
/**
 * `data:image/png;base64,...` → decoded bytes.
 *
 * `mime` is the caller-facing convenience (declared type, or `image/jpeg` when
 * the URL declares none); `declaredMime` is `undefined` in that second case, so
 * a caller that sniffs can tell "said nothing" from "said image/jpeg" instead
 * of inheriting a guess.
 */
export function decodeDataUrl(ref) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(ref.trim());
    if (!match)
        return null;
    const declaredMime = match[1]?.trim() || undefined;
    const mime = declaredMime ?? "image/jpeg";
    const payload = match[3] ?? "";
    try {
        const buffer = match[2]
            ? Buffer.from(payload, "base64")
            : Buffer.from(decodeURIComponent(payload), "utf8");
        return buffer.byteLength > 0 ? { buffer, mime, ...(declaredMime ? { declaredMime } : {}) } : null;
    }
    catch {
        return null;
    }
}
/** Shared tail of {@link loadImageForTool}: fit to the envelope, store, package. */
async function packageToolImage(params) {
    const fitted = await fitImage(params.buffer, params.mime, params.envelope, params.deps);
    if (!fitted.withinEnvelope) {
        // The host's own sanitizer replaces an unshrinkable image with an error
        // note rather than shipping it; refusing here is the same call, made where
        // we can say something actionable about it. The two halves of the envelope
        // fail for different reasons — too many bytes vs. a resizer that never
        // produced anything — so name whichever one actually bit.
        const overBytes = fitted.buffer.byteLength > params.envelope.maxBytes;
        const detail = overBytes
            ? `压缩后仍有 ${(fitted.buffer.byteLength / (1024 * 1024)).toFixed(2)}MB，超过 ` +
                `${(params.envelope.maxBytes / (1024 * 1024)).toFixed(0)}MB 上限`
            : `尺寸超过 ${params.envelope.maxDimensionPx}px 且当前环境无法压缩（OpenClaw 的图片处理后端不可用）`;
        return {
            ok: false,
            error: `图片${detail}，无法交给模型。可改用 mode="describe" 让图像理解模型代读。`,
        };
    }
    // Storing is best-effort: the model gets the bytes either way, but a stored
    // path is what makes `describe` mode (which takes a file) possible at all.
    const stored = await storeImage(fitted.buffer, fitted.mime, params.fileName, params.deps);
    return {
        ok: true,
        image: {
            base64: fitted.buffer.toString("base64"),
            mime: fitted.mime,
            bytes: fitted.buffer.byteLength,
            ...(stored.ok ? { path: stored.path } : {}),
        },
    };
}
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
export async function loadImageForTool(ref, deps, envelope = resolveToolImageEnvelope(undefined, deps.image)) {
    const trimmed = ref.trim();
    if (!trimmed)
        return { ok: false, error: "图片地址为空。" };
    const inline = decodeDataUrl(trimmed);
    if (inline) {
        // Sniffed, not trusted — the same treatment `downloadImage` gives a fetched
        // payload. A `data:` reference can reach here from an image segment's
        // `file`/`url` field, so its declared type is remote input: `data:text/html,…`
        // must be refused, and `data:image/png;base64,<html bytes>` must not be
        // believed just because it says PNG. `decodeDataUrl` also defaults an
        // undeclared type to `image/jpeg`, which the sniff overrides.
        const resolved = await resolveImageMime(inline.buffer, inline.declaredMime, deps);
        if (!resolved.ok) {
            return { ok: false, error: `该 data: 地址携带的不是图片（${resolved.mime}）。` };
        }
        return packageToolImage({
            buffer: inline.buffer,
            mime: resolved.mime,
            fileName: fileNameHint(trimmed, resolved.mime),
            envelope,
            deps,
        });
    }
    if (!imageUrlHost(trimmed)) {
        return {
            ok: false,
            error: `无法识别的图片地址（仅支持 http/https 或 data: URL）：${trimmed.slice(0, 120)}`,
        };
    }
    if (!isAllowedImageUrl(trimmed, deps.image.allowedHosts, deps.trustedHost)) {
        return {
            ok: false,
            error: `图片地址的域名不在允许列表内：${imageUrlHost(trimmed)}。` +
                "如需放行，请在 channels.snowluma.image.allowedHosts 中添加该域名。",
        };
    }
    const downloaded = await downloadImage(trimmed, deps);
    if (!downloaded.ok)
        return { ok: false, error: downloaded.error };
    return packageToolImage({
        buffer: downloaded.buffer,
        mime: downloaded.mime,
        fileName: downloaded.fileName ?? fileNameHint(trimmed, downloaded.mime),
        envelope,
        deps,
    });
}
/**
 * Ask OpenClaw's media-understanding stack to describe a stored image.
 *
 * This is the escape hatch for a primary model that cannot see images at all:
 * the description comes back as text from whatever vision model
 * `tools.media.image` points at, and the agent reads that instead of pixels.
 */
export async function describeStoredImage(params) {
    const describe = params.deps.runtime?.mediaUnderstanding?.describeImageFile;
    if (typeof describe !== "function") {
        return { ok: false, error: "当前 OpenClaw 运行时未提供 mediaUnderstanding.describeImageFile。" };
    }
    try {
        const result = await withTimeout(describe({
            filePath: params.filePath,
            cfg: params.cfg,
            ...(params.mime ? { mime: params.mime } : {}),
            ...(params.prompt ? { prompt: params.prompt } : {}),
            timeoutMs: params.deps.image.timeoutMs,
        }), 
        // A vision round trip is a model call, not a byte transfer — give it a
        // materially larger budget than the download timeout it is derived from.
        params.deps.image.timeoutMs * 3, "image description");
        const text = result?.text?.trim();
        if (!text) {
            return {
                ok: false,
                error: "图像理解未返回内容——请检查 OpenClaw 的 tools.media.image 配置是否指向可用的视觉模型。",
            };
        }
        return { ok: true, text, provider: result.provider, model: result.model };
    }
    catch (err) {
        return { ok: false, error: describeError(err) };
    }
}
//# sourceMappingURL=image.js.map
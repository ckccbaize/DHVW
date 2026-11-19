/** The SDK's module namespace — type-only, erased at compile time. */
export type SnowLumaSdkModule = typeof import("@snowluma/sdk");
export interface SdkLoadLogger {
    info?(message: string): void;
    error?(message: string): void;
}
export interface SdkPatchResult {
    patchedFiles: number;
    patchedSpecifiers: number;
}
/**
 * Rewrites extensionless relative specifiers under `sdkDist` in place.
 * Idempotent: already-extensioned specifiers and bare package imports are left
 * alone, so re-running against a patched tree changes nothing.
 */
export declare function patchSnowLumaSdkDist(sdkDist: string): SdkPatchResult;
/**
 * Locates the installed SDK's `dist/` directory relative to THIS module — on a
 * gateway that is the plugin's own generation dir, exactly the copy the dynamic
 * import below will load. Returns undefined when the SDK isn't resolvable
 * (the import afterwards will then produce the real, useful error).
 */
export declare function resolveSnowLumaSdkDist(): string | undefined;
/** Injectable seams so tests can exercise every load outcome without real installs. */
export interface SdkLoadDeps {
    importSdk?: () => Promise<SnowLumaSdkModule>;
    resolveDist?: () => string | undefined;
    patchDist?: (sdkDist: string) => SdkPatchResult;
}
/**
 * One patch-then-import pass, no memoization — `ensureSnowLumaSdk` is the
 * memoized entry point production code uses.
 */
export declare function loadSnowLumaSdkModule(log?: SdkLoadLogger, deps?: SdkLoadDeps): Promise<SnowLumaSdkModule>;
/**
 * Loads (and, when needed, self-patches) the SDK exactly once per process.
 * A failed attempt clears the memo so a later call can retry.
 */
export declare function ensureSnowLumaSdk(log?: SdkLoadLogger): Promise<SnowLumaSdkModule>;
/**
 * Synchronous accessor for code paths that run strictly after
 * `ensureSnowLumaSdk()` (segment parsing, message builders). Throwing here
 * means a code path used the SDK before gateway start / client acquisition —
 * a plugin bug, not a user configuration problem.
 */
export declare function getSnowLumaSdk(): SnowLumaSdkModule;
export declare function tryGetSnowLumaSdk(): SnowLumaSdkModule | undefined;
/** Test-only: replaces (or clears) the registry so cases control load state. */
export declare function __setSnowLumaSdkForTests(mod: SnowLumaSdkModule | undefined): void;
//# sourceMappingURL=sdk.d.ts.map
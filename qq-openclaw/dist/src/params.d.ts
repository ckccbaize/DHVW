/**
 * Local, dependency-free reimplementations of the two `openclaw/plugin-sdk/core`
 * param readers this plugin uses (`readStringParam` / `readNumberParam`).
 *
 * WHY LOCAL — this is a deliberate load-time correctness fix, not a style choice.
 * Importing these from `openclaw/plugin-sdk/core` pulls that whole (large) module
 * graph into `tools.ts`, and therefore into `setup-entry.ts`'s transitive graph
 * (`setup-entry → channel → tools`). OpenClaw's plugin loader **synchronously
 * `require()`s** `setup-entry.js` (to read the setup surface) while it is
 * **asynchronously `import()`ing** `index.js` on the loader-hook thread. When the
 * sync `require()` reaches `openclaw/plugin-sdk/core.js` while that same module is
 * still mid-evaluation from the async import, Node throws
 * `ERR_REQUIRE_ESM_RACE_CONDITION` and the whole plugin fails to load. Keeping
 * these helpers local means `setup-entry.js`'s runtime graph contains ZERO
 * `openclaw/*` imports, so there is nothing for the sync require to race on.
 * See docs/guide/troubleshooting.md#err-require-esm-race-condition.
 *
 * Behaviour mirrors the SDK helpers (`common.ts`) for every option this plugin
 * relies on: snake_case key fallback, `required`, `trim`, and numeric coercion.
 */
/** Thrown when a `required` param is missing; message matches the SDK (`<label> required`). */
export declare class ToolInputError extends Error {
}
/**
 * Read `params[key]`, falling back to the snake_case spelling (`messageSeq` →
 * `message_seq`).
 *
 * Exported because a couple of tool params are not plain strings or numbers
 * (`messageId` accepts either and has to tell "absent" from "unparseable";
 * `groupId` the same; `noCache` is a boolean). Those read the raw value and
 * validate it themselves — but they must still go through this function, or
 * they silently stop accepting the snake_case spelling that every other param
 * in `tools.ts` honours.
 */
export declare function readParamRaw(params: Record<string, unknown>, key: string): unknown;
export interface ReadStringParamOptions {
    required?: boolean;
    trim?: boolean;
    label?: string;
    allowEmpty?: boolean;
}
export declare function readStringParam(params: Record<string, unknown>, key: string, options: ReadStringParamOptions & {
    required: true;
}): string;
export declare function readStringParam(params: Record<string, unknown>, key: string, options?: ReadStringParamOptions): string | undefined;
export interface ReadNumberParamOptions {
    required?: boolean;
    label?: string;
    integer?: boolean;
    strict?: boolean;
}
export declare function readNumberParam(params: Record<string, unknown>, key: string, options: ReadNumberParamOptions & {
    required: true;
}): number;
export declare function readNumberParam(params: Record<string, unknown>, key: string, options?: ReadNumberParamOptions): number | undefined;
//# sourceMappingURL=params.d.ts.map
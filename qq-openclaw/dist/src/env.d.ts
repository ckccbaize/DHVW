/**
 * Environment-variable fallbacks, isolated here so the rest of the plugin never
 * touches `process.env` directly (which keeps it trivially testable).
 */
export declare function getDefaultWsUrl(): string | undefined;
export declare function getDefaultHttpUrl(): string | undefined;
export declare function getDefaultAccessToken(): string | undefined;
export declare function getDefaultSelfId(): number | undefined;
//# sourceMappingURL=env.d.ts.map
// Hand-written declarations for usage-prices.mjs, following the pattern of
// bucketizer-core.d.mts (the SPA's tsconfig has allowJs off).
//
// Only what the browser can safely call is declared. `estimateInputTokens`
// and `estimateLlmCents` reach for Node's `Buffer` when handed a STRING, so
// the string overload is deliberately absent here: pass a byte COUNT, which
// the same code path takes without touching Buffer. Everything else in the
// module is server-side and is not declared.

export declare const PRICES_PER_MTOK: Readonly<Record<string, readonly [number, number]>>;
export declare const PROVIDER_FALLBACK_PER_MTOK: Readonly<Record<string, readonly [number, number]>>;

/** [inputUsdPerMtok, outputUsdPerMtok] for a model id, falling back by provider. */
export declare function ratePerMtok(model: string | null | undefined, provider?: string): readonly [number, number];

/**
 * Cents for one call, rounded UP — the same arithmetic /api/llm charges
 * before the provider is called.
 *
 * @param args.bodyText the request body's SIZE IN BYTES. A string would send
 *   the implementation through `Buffer.byteLength`, which does not exist in a
 *   browser.
 */
export declare function estimateLlmCents(args: {
  provider?: string;
  model?: string;
  bodyText: number;
  maxOutputTokens?: number;
}): number;

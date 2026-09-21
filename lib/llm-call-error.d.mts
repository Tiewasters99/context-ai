// Hand-written declarations for llm-call-error.mjs (the SPA's tsconfig has
// allowJs off; the worker and the API consume the .mjs directly).

export declare class LlmCallError extends Error {
  status: number;
  /** The server's machine code (`budget_exhausted`, `rate_limited`, …). */
  code: string | null;
  retryAfterSeconds: number | null;

  constructor(
    message: string,
    status: number,
    code?: string | null,
    retryAfterSeconds?: number | null,
  );

  /** 402 / 429: the wallet or the rate window, not this document. */
  get isUsagePause(): boolean;

  /** 413: this request will never succeed as written. */
  get isPermanentForThisRequest(): boolean;
}

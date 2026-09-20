// The one thing the bulk runner needs to know about a failed model call: what
// the server answered.
//
// Kept in its own module, with no imports, for two reasons. It is the only
// part of the call path the RUNNER depends on — the runner asks `instanceof`
// and nothing else — so the runner can be exercised offline without dragging
// in `@/lib/supabase`, which reads `import.meta.env` at module scope and does
// not exist outside a Vite build. And a status classification is a fact about
// the API, not about the transport that observed it.

/** An `/api/llm` failure that still knows what the server answered. */
export class LlmCallError extends Error {
  status: number;
  /** The server's machine code (`budget_exhausted`, `rate_limited`, …). */
  code: string | null;
  retryAfterSeconds: number | null;

  constructor(message: string, status: number, code: string | null = null, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'LlmCallError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /**
   * The wallet or the rate window, not this document.
   *
   * 402 is the month's budget spent; 429 is the rate limit, with a
   * `retry-after`; 413 is the plan's per-request size ceiling. A run that
   * meets one of these should STOP where it is and keep everything it has
   * finished — the next run resumes from the same place and pays for nothing
   * twice. Treating them as ordinary per-document failures is what makes a
   * bulk run throw four hundred more requests at a spent budget.
   */
  get isUsagePause(): boolean {
    return this.status === 402 || this.status === 429 || this.status === 413;
  }
}

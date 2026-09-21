// The one thing a bulk runner needs to know about a failed model call: what
// the server answered.
//
// WHY IT MOVED HERE
// ---------------------------------------------------------------------------
// It was `src/lib/bucketizer/llm-error.ts`, a browser module. The windowed
// classification loop that asks `instanceof` on it now runs in TWO places —
// the tab (`/api/llm` over HTTP) and the Fly worker (`lib/llm-server-call.mjs`,
// in process) — and the two must classify a refusal identically. A 402 that
// pauses a browser run and merely fails a server document would be the same
// bug in two colours.
//
// Kept with no imports at all, exactly as before: the runner depends on this
// and on nothing else about the call path, which is what lets the runner be
// exercised offline. A status classification is a fact about the API, not
// about the transport that observed it.
//
// No `node:` imports, deliberately: this module is bundled into the browser.

/** An `/api/llm` failure — or its in-process twin — that still knows what the server answered. */
export class LlmCallError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string|null} [code]  the server's machine code (`budget_exhausted`, `rate_limited`, …)
   * @param {number|null} [retryAfterSeconds]
   */
  constructor(message, status, code = null, retryAfterSeconds = null) {
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
   * `retry-after`. A run that meets either should STOP where it is and keep
   * everything it has finished — the next run resumes from the same place and
   * pays for nothing twice. Treating them as ordinary per-document failures is
   * what makes a bulk run throw four hundred more requests at a spent budget.
   *
   * 413 is deliberately NOT here. The plan's per-request size ceiling is a
   * fact about THIS window, and it fails identically however long you wait —
   * so pausing on it would let one oversized document block four hundred
   * others behind a message that says "try again later". It is recorded
   * against the window instead.
   */
  get isUsagePause() {
    return this.status === 402 || this.status === 429;
  }

  /**
   * This request will never succeed as written, so there is no point retrying
   * or repairing it: the window is recorded as failed and the run moves on.
   */
  get isPermanentForThisRequest() {
    return this.status === 413;
  }
}

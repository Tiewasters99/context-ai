// Shared rate limiting for provider APIs.
//
// Why this exists: the July OneDrive bulk import failed a large fraction of its
// documents with `embed 429: Rate limit reached for text-embedding-3-small in
// organization ... on tokens per min (TPM): Limit 1000000, Used 1000000`. Every
// concurrent ingest was calling the embeddings API blind — each one retried its
// own 429 with its own backoff, all of them woke up together, and the org-wide
// budget stayed pinned at the ceiling. Per-request retry cannot fix a shared
// budget; the callers have to coordinate before they spend.
//
// TokenBucket is that coordination point: one bucket per process, refilling at
// limit/60 tokens per second, and every embeddings request reserves its
// estimated cost before it goes out. When a 429 does slip through (the budget is
// shared with other apps on the same OpenAI org, so our accounting is never the
// whole picture), penalize() drains the bucket so *every* in-flight worker backs
// off together instead of the one unlucky caller.
//
// Scope limit, stated plainly: this coordinates a single Node process. The bulk
// importer and the Fly worker are single processes, so they are fully covered.
// Vercel serverless spawns an isolate per request, so /api/ingest gets one
// bucket per invocation — better than nothing (it paces a single large document)
// but not a cross-instance guarantee. Bulk work belongs on the worker queue,
// which is where the routing in needsWorkerIngest() already sends it.

const nowMs = () => Date.now();

export class TokenBucket {
  // limitPerMinute — sustained token budget (e.g. OpenAI TPM).
  // burst          — max tokens that can accumulate while idle. Defaults to one
  //                  minute's worth, so a fresh process can spend a full minute
  //                  of budget immediately and then settles to the refill rate.
  constructor({ limitPerMinute, burst = null, name = 'bucket' } = {}) {
    if (!limitPerMinute || limitPerMinute <= 0) throw new Error('TokenBucket: limitPerMinute required');
    this.name = name;
    this.limitPerMinute = limitPerMinute;
    this.ratePerMs = limitPerMinute / 60000;
    this.capacity = burst ?? limitPerMinute;
    this.tokens = this.capacity;
    this.last = nowMs();
    // Serializes waiters so reservations are granted in arrival order. Without
    // it, many concurrent reserve() calls each see a full bucket and all
    // proceed — exactly the stampede we are preventing.
    this.queue = Promise.resolve();
  }

  #refill() {
    const t = nowMs();
    const elapsed = t - this.last;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
      this.last = t;
    }
  }

  // Reserve `cost` tokens, waiting until the budget allows. A single request
  // larger than the whole bucket would deadlock, so it is clamped to capacity —
  // the caller has already capped individual inputs well below the provider's
  // per-request ceiling, so clamping only affects pathological cases.
  async reserve(cost) {
    const want = Math.max(0, Math.min(cost, this.capacity));
    const run = this.queue.then(async () => {
      for (;;) {
        this.#refill();
        if (this.tokens >= want) {
          this.tokens -= want;
          return;
        }
        const deficitMs = Math.ceil((want - this.tokens) / this.ratePerMs);
        await new Promise((r) => setTimeout(r, Math.min(Math.max(deficitMs, 25), 15000)));
      }
    });
    // Keep the chain alive even if a waiter rejects, so one failure doesn't
    // wedge every subsequent reservation.
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  // A 429 means the real budget is tighter than our accounting believed —
  // usually because something else shares the org. Drain the bucket and push
  // the refill clock forward so every concurrent caller pauses, not just this
  // one. `ms` should be the provider's Retry-After when it supplies one.
  penalize(ms = 1000) {
    const hold = Math.min(Math.max(ms, 0), 60000);
    this.tokens = 0;
    this.last = nowMs() + hold;
  }

  // Diagnostics for progress output / the monitor digest.
  stats() {
    this.#refill();
    return {
      name: this.name,
      limitPerMinute: this.limitPerMinute,
      available: Math.floor(this.tokens),
      utilizationPct: Math.round(100 * (1 - this.tokens / this.capacity)),
    };
  }
}

// Process-wide embeddings limiter.
//
// Default headroom: OpenAI's ceiling for this org is 1,000,000 TPM, and the
// observed failures were at 979k-1,000k used — i.e. we were pushing right up
// against it. Reserving 80% leaves room for the other surfaces (in-app
// Orchestrator, MCP, Librarian) that share the same key, so a bulk import can
// no longer starve interactive use. Override with EMBED_TPM_LIMIT.
let embedLimiter = null;
export function getEmbedLimiter() {
  if (!embedLimiter) {
    const configured = parseInt(process.env.EMBED_TPM_LIMIT || '', 10);
    const limitPerMinute = Number.isFinite(configured) && configured > 0 ? configured : 800000;
    embedLimiter = new TokenBucket({ limitPerMinute, name: 'openai-embeddings' });
  }
  return embedLimiter;
}

// Test seam — lets a suite install a small bucket without touching env.
export function setEmbedLimiter(bucket) {
  embedLimiter = bucket;
}

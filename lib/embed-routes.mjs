// Which embedding provider a matter's content is allowed to reach.
//
// Phase A of the seal (lib/seal-pipes.mjs) stopped sealed matters from being
// embedded at all: their passages are stored with a null embedding and searched
// on text alone. That is honest but lossy — a sealed matter loses meaning-based
// retrieval, which is most of what makes the corpus useful. Phase B gives each
// tier a route it is permitted to use, so a sealed matter gets its semantic
// search back without its text leaving a zero-retention boundary.
//
// The shape follows lib/llm/adapters.ts, for the same reason it does: the
// provider's wire format is the provider's business, and nothing upstream of
// this file should know whether a vector came from OpenAI or anyone else. What
// upstream DOES need to know is the model's NAME, because that name is stamped
// on every passage and decides which vectors may be compared with which — see
// migration 061.
//
// Three rules this module exists to enforce:
//
//   1. A tier with no route embeds NOTHING. It does not quietly fall back to
//      the unsealed provider — that is the pen's rule (lib/assistant-core.mjs)
//      and it is the whole point.
//
//   2. Every route is exactly EMBED_DIM dimensions. `passages.embedding` is
//      `vector(1024)` and pgvector will not let that column be altered while it
//      has rows, so 1024 is not a preference, it is the shape of the table. A
//      route that cannot produce 1024 cannot be used here at all.
//
//   3. A route's `model` string is written to `passages.embedding_model` and
//      passed to search as `p_embedding_model`. Change a route's model name and
//      you have declared every passage stamped with the old name to be in a
//      different space — which is true, and which is why re-tiering a matter
//      requires a backfill rather than a flag flip.

export const EMBED_DIM = 1024;

/** An OpenAI-compatible /v1/embeddings endpoint — the common case. */
function openAiCompatible({ id, provider, model, url, keyEnv, dimensionsParam = true, zdr, notes }) {
  return {
    id,
    provider,
    model,
    url,
    keyEnv,
    zdr,
    notes,
    dim: EMBED_DIM,
    headers: (key) => ({
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    }),
    // Providers that serve a natively-1024 model reject an unknown
    // `dimensions` field; OpenAI needs it to shorten 1536 → 1024.
    body: (texts) => ({
      model,
      input: texts,
      ...(dimensionsParam ? { dimensions: EMBED_DIM } : {}),
    }),
    parse: (json) => {
      const rows = json?.data;
      if (!Array.isArray(rows)) throw new Error(`${id}: response had no data array`);
      return rows.map((d) => d.embedding);
    },
  };
}

// ---------------------------------------------------------------------------
// The routes.
//
// TIER_ROUTES is the policy; ROUTES is the catalogue. Keeping them apart means
// adding a provider is not the same act as permitting a tier to use it.
// ---------------------------------------------------------------------------

export const ROUTES = {
  // Tier A — unchanged from every passage embedded before today. The model
  // name here MUST stay 'text-embedding-3-small': it is what ~300,000 existing
  // rows are stamped with, and renaming it would orphan all of them.
  'openai-3-small': openAiCompatible({
    id: 'openai-3-small',
    provider: 'openai',
    model: 'text-embedding-3-small',
    url: 'https://api.openai.com/v1/embeddings',
    keyEnv: 'OPENAI_API_KEY',
    dimensionsParam: true, // native 1536, shortened to 1024
    zdr: false,
    notes: 'Default retention. Fine for Tier A, never for a sealed matter.',
  }),
};

/**
 * tier → route id. A tier absent from this map, or mapped to null, embeds
 * nothing: lib/seal-pipes.mjs holds its work instead of sending it anywhere.
 *
 *   A — any US provider. Today's behaviour, today's model.
 *   B — SEALED. Must be a US-hosted zero-retention route.
 *   C — SILO. Local inference only. No cloud route will ever be listed here;
 *       when the Silo box exists it gets a local route, and until then Tier C
 *       embeds nothing by design.
 */
export const TIER_ROUTES = {
  A: 'openai-3-small',
  B: null,
  C: null,
};

/** The route a tier may use, or null when it may not embed at all. */
export function routeForTier(tier) {
  const id = TIER_ROUTES[tier ?? 'A'];
  if (!id) return null;
  const route = ROUTES[id];
  if (!route) throw new Error(`embed route '${id}' is named by policy but not defined`);
  return route;
}

/**
 * The route plus its key, or a plain reason why there is none. Callers refuse
 * on `null` — they never substitute another route.
 *
 * A route that is configured but has no key is NOT a reason to fall back. It is
 * a misconfiguration, and for a sealed matter the safe reading of a
 * misconfiguration is "do not send anything".
 */
export function resolveRoute(tier, env = process.env) {
  const route = routeForTier(tier);
  if (!route) {
    return {
      route: null,
      key: null,
      reason: tier === 'C'
        ? 'Tier C (Silo) runs local inference only, and no local embedding route is configured yet.'
        : `No zero-retention embedding route is configured for Tier ${tier}.`,
    };
  }
  const key = env[route.keyEnv];
  if (!key) {
    return {
      route: null,
      key: null,
      reason: `The embedding route for Tier ${tier} (${route.id}) has no ${route.keyEnv} configured.`,
    };
  }
  return { route, key, reason: null };
}

/** Every model name a search may legitimately be asked to filter on. */
export function knownModels() {
  return [...new Set(Object.values(ROUTES).map((r) => r.model))];
}

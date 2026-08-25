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
//
// A consequence of (3) worth stating outright, because it decides whether a
// given provider costs a re-embed or nothing at all: `model` names the SPACE,
// not the vendor. Two routes that serve the genuinely same model — the obvious
// case being a first-party API and the same model hosted elsewhere under a
// different contract — share a model name on purpose. Their vectors ARE
// comparable, so search must be free to mix them, and a matter moving between
// those two routes needs no backfill whatsoever: same numbers, different
// paperwork. Give two routes the same `model` string only when that is
// literally true, and never as a convenience to skip a re-embed.

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

// ---------------------------------------------------------------------------
// Candidates for Tier B, researched 2026-08-25. Recorded here so the decision
// is a line of code rather than a fresh investigation, and so the reasoning is
// attached to the thing it decides. None is implemented: each needs an account
// and a key that do not exist yet, and implementing a provider we cannot call
// would ship untested code down the most sensitive path in the product.
//
//   AWS Bedrock · Amazon Titan Text Embeddings V2   ← recommended
//     1024 dimensions natively, so no truncation and no quality tax. ~$0.02 per
//     million tokens, the same as we pay now. Bedrock is zero-retention BY
//     DEFAULT, and — the part that matters for a privilege promise — it can be
//     pinned with data_retention_mode=none and ENFORCED org-wide with a service
//     control policy, so it is structurally guaranteed rather than promised.
//     Region-pinned, FedRAMP Moderate, HIPAA-eligible. Entirely self-serve.
//     Cost: requires AWS SigV4 signing, so this is the one candidate that is
//     not a drop-in OpenAI-compatible route, and the sealed corpus must be
//     embedded once (scripts/reembed-matter.mjs).
//
//   Azure OpenAI · text-embedding-3-small
//     The only option that requires NO re-embedding, because it is literally
//     the same model — same space, same vectors, so it would share the model
//     name above per the rule at the top of this file. Blocked on eligibility:
//     true zero retention needs "modified abuse monitoring", which Microsoft
//     grants only to accounts managed by a Microsoft account team. Not
//     available pay-as-you-go.
//
//   Voyage (MongoDB) · voyage-4 in our own AWS account via SageMaker
//     Best retrieval quality of the candidates, 1024 native, and the strongest
//     story a client can be told: the text never leaves our AWS account. Costs
//     GPU-hours (~$3-4/hr) instead of per-token, plus real infrastructure to
//     run. Note the DIRECT Voyage API is a different thing and should be
//     avoided for privileged content: its default terms take a perpetual,
//     irrevocable training licence until you opt out, the opt-out is
//     prospective only and cannot be reversed, and the hosting region is
//     undocumented.
//
//   Fireworks — REJECTED despite already holding a key. Zero-retention by
//     default, but no embedding model is served from its US-pinned routers, so
//     "US-hosted" fails. The cheap integration was the wrong reason to pick it.
//
//   OpenAI ZDR — would collapse all of the above to a config change, since the
//     vectors, the model and the driver all stay put. It covers /v1/embeddings.
//     It is approval-gated through sales and not available pay-as-you-go, so it
//     is a phone call, not an implementation. Worth making before building.
// ---------------------------------------------------------------------------

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

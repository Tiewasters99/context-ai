// Which OCR provider a matter's scanned pages are allowed to reach — and, for
// an unsealed matter, which one is tried next when the first is down.
//
// Phase 4 of the ingestion plan (2026-09-04), built on Eden's decision 2:
//
//   * documents INSIDE a SecureSpace (Tier B) are read by AWS Textract in our
//     own AWS account, and by nothing else;
//   * documents OUTSIDE (Tier A) are read by Anthropic vision or Gemini —
//     Gemini stays the measured default and Anthropic is the fallback until
//     both are live and compared, after which the ORDER is flipped in the
//     environment (OCR_TIER_A_ROUTES), not in code;
//   * Tier C (Silo) has no cloud route and never will; a local route joins
//     when the Silo box exists.
//
// The shape follows lib/embed-routes.mjs, for the same reasons: ROUTES is the
// catalogue, TIER_ROUTES is the policy, and a tier with no ready route sends
// NOTHING — it never quietly borrows the unsealed provider. What is new here
// and not in embed-routes is fallback: an unsealed matter lists routes in
// order of preference, and a provider outage (the plan's gate G6 — the 09-03
// Gemini billing block took every scan in the queue down with it) means the
// next route reads the pages, not that the pages wait ten hours.
//
// ingest-core never imports this file. It receives a PROVIDER (makeOcrProvider)
// through processDocument's `ocr` option with two methods:
//
//   plan(tier) → { routes, reason }    which routes are ready for this tier,
//                                        or in words why none is
//   run(buf, { tier, onProgress })     OCR through the first route that
//                                        works; returns the pages AND a record
//                                        of which route read them and what it
//                                        roughly cost, which the pipeline
//                                        writes to documents.metadata.ocr_route
//
// so the pipeline stays provider-agnostic and the seal check stays one line:
// a sealed matter with no ready sealed route is HELD, exactly as before.

export const OCR_TIER_A_DEFAULT = ['gemini-flash', 'anthropic-vision'];

// 'PASTE' is this repo's placeholder convention for an unissued key.
const present = (v) => Boolean(v) && v !== 'PASTE';

/** Every env var a route needs before it may be used at all. */
export function ocrRouteReady(route, env = process.env) {
  return (route.requiredEnv || []).every((k) => present(env[k]));
}

export const ROUTES = {
  // Today's route, unchanged in behaviour: gemini-2.5-flash through
  // lib/ocr-gemini.mjs. Default retention — fine for Tier A, never sealed.
  'gemini-flash': {
    id: 'gemini-flash',
    provider: 'google',
    label: 'Gemini',
    zdr: false,
    requiredEnv: ['GOOGLE_API_KEY'],
    model: (env) => (present(env.GEMINI_OCR_MODEL) ? env.GEMINI_OCR_MODEL : 'gemini-2.5-flash'),
    // Flash's list price works out near $0.002 a page for a scanned page and
    // its transcription; the estimate is a flat rate, not measured usage.
    usdPerPage: 0.002,
    async run(buf, { env = process.env, onProgress } = {}) {
      const { ocrPdf } = await import('./ocr-gemini.mjs');
      const model = this.model(env);
      const pages = await ocrPdf(buf, { apiKey: env.GOOGLE_API_KEY, model, onProgress });
      return { pages, model, usage: { pages: pages.length }, estimated_usd: pages.length * this.usdPerPage };
    },
  },

  // Anthropic vision through lib/ocr-anthropic.mjs. The fidelity route, and
  // the expensive one (5–15× Flash per page depending on the model); the
  // measured usage comes back with every window and is recorded on the
  // document, so nobody is surprised by a 5,000-page production.
  'anthropic-vision': {
    id: 'anthropic-vision',
    provider: 'anthropic',
    label: 'Anthropic vision',
    zdr: false,
    requiredEnv: ['ANTHROPIC_API_KEY'],
    model: (env) => (present(env.ANTHROPIC_OCR_MODEL) ? env.ANTHROPIC_OCR_MODEL : 'claude-opus-5'),
    async run(buf, { env = process.env, onProgress } = {}) {
      const { ocrPdfAnthropic } = await import('./ocr-anthropic.mjs');
      return ocrPdfAnthropic(buf, { apiKey: env.ANTHROPIC_API_KEY, model: this.model(env), onProgress });
    },
  },

  // AWS Textract in our own account — the SEALED route. Three env vars, and
  // the third is deliberate: TEXTRACT_AI_OPT_OUT_CONFIRMED is a person's
  // attestation (the date) that the AWS Organizations AI-services opt-out
  // policy is in force on the account, because that policy is what makes
  // "nothing is retained to improve anyone's model" true, and there is no
  // API an invoke-only key can call to check it. Without the attestation the
  // route is not ready and sealed scans stay held — fail closed, like the
  // Bedrock pen's retention check. docs/SEALED_OCR_SETUP.md walks through it.
  'aws-textract': {
    id: 'aws-textract',
    provider: 'aws-textract',
    label: 'AWS Textract (our own AWS account)',
    zdr: true,
    requiredEnv: ['TEXTRACT_AWS_ACCESS_KEY_ID', 'TEXTRACT_AWS_SECRET_ACCESS_KEY', 'TEXTRACT_AI_OPT_OUT_CONFIRMED'],
    model: () => 'textract-detect-document-text',
    async run(buf, { env = process.env, onProgress } = {}) {
      const { ocrPdfTextract } = await import('./ocr-textract.mjs');
      return ocrPdfTextract(buf, { env, onProgress });
    },
  },
};

/**
 * tier → route ids in order of preference. A tier absent here, or mapped to
 * an empty list, OCRs nothing: the pipeline holds (sealed) or records the
 * pages as awaiting OCR with the reason (unsealed).
 */
export const TIER_ROUTES = {
  A: OCR_TIER_A_DEFAULT,
  B: ['aws-textract'],
  C: [],
};

/**
 * The route ids policy names for a tier. Tier A's order is overridable with
 * OCR_TIER_A_ROUTES (comma-separated ids) so the Gemini → Anthropic flip is
 * a config change; unknown ids in the override are ignored with the rest
 * kept, so a typo cannot switch OCR off. Sealed tiers take no override — the
 * sealed list is policy, not preference.
 */
export function tierRouteIds(tier, env = process.env) {
  const t = tier ?? 'A';
  if (t === 'A' && present(env.OCR_TIER_A_ROUTES)) {
    const ids = env.OCR_TIER_A_ROUTES.split(',').map((s) => s.trim()).filter((s) => s && ROUTES[s]);
    if (ids.length) return ids;
  }
  return TIER_ROUTES[t] || [];
}

/** True when `tier`'s routes are the sealed kind (every listed route is zero-retention). */
export function tierIsSealed(tier) {
  return tier === 'B' || tier === 'C';
}

/**
 * The ready routes for a tier, in order, plus — when none is ready — a plain
 * reason naming what is missing. Callers refuse on an empty list; they never
 * substitute another tier's routes.
 */
export function resolveOcrRoutes(tier, env = process.env, { routes = ROUTES } = {}) {
  const t = tier ?? 'A';
  const ids = tierRouteIds(t, env);
  const ready = [];
  const notReady = [];
  for (const id of ids) {
    const route = routes[id];
    if (!route) throw new Error(`ocr route '${id}' is named by policy but not defined`);
    if (ocrRouteReady(route, env)) ready.push(route);
    else notReady.push({ id, missing: (route.requiredEnv || []).filter((k) => !present(env[k])) });
  }
  let reason = null;
  if (!ready.length) {
    if (t === 'C') {
      reason = 'Tier C (Silo) runs local inference only, and no local OCR route is configured yet.';
    } else if (!ids.length) {
      reason = `No OCR route is configured for Tier ${t}.`;
    } else {
      const what = notReady.map((r) => `${r.id} needs ${r.missing.join(', ')}`).join('; ');
      reason = tierIsSealed(t)
        ? `The sealed OCR route for Tier ${t} is not configured where this ran: ${what}. See docs/SEALED_OCR_SETUP.md.`
        : `OCR is not configured where this ran: ${what}.`;
    }
  }
  return { tier: t, routes: ready, notReady, reason };
}

/**
 * The record written to documents.metadata.ocr_route after a successful OCR:
 * which route read the pages, what model, how many pages, and roughly what
 * it cost. `attempts` lists the routes that failed first, so "why did this
 * scan cost $0.30" has an answer ("Gemini was down").
 */
export function ocrRouteRecord(route, result, { attempts = [] } = {}) {
  const pages = Array.isArray(result?.pages) ? result.pages.length : (result?.usage?.pages ?? null);
  const usd = typeof result?.estimated_usd === 'number' ? Math.round(result.estimated_usd * 10000) / 10000 : null;
  return {
    id: route.id,
    provider: route.provider,
    model: result?.model ?? null,
    pages,
    estimated_usd: usd,
    ...(result?.usage ? { usage: result.usage } : {}),
    ...(attempts.length ? { fallback_from: attempts.map((a) => ({ id: a.id, error: String(a.error || '').split('\n')[0].slice(0, 200) })) } : {}),
    sealed: Boolean(route.zdr),
    at: new Date().toISOString(),
  };
}

/** One sentence for a status note: who read the pages and what it cost. */
export function describeOcrRoute(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const route = ROUTES[rec.id];
  const who = route ? route.label : (rec.id || 'an OCR route');
  const model = rec.model && rec.provider !== 'aws-textract' ? ` (${rec.model})` : '';
  const n = rec.pages != null ? `${rec.pages} page${rec.pages === 1 ? '' : 's'}` : 'the scanned pages';
  const cost = rec.estimated_usd != null
    ? (rec.estimated_usd < 0.005 ? ' at well under a cent' : `, about $${rec.estimated_usd.toFixed(2)}`)
    : '';
  const fb = rec.fallback_from?.length ? ` after ${rec.fallback_from.map((f) => f.id).join(' and ')} failed` : '';
  const seal = rec.sealed ? ' — inside the seal' : '';
  return `OCR: ${n} read by ${who}${model}${cost}${fb}${seal}.`;
}

/**
 * The provider the pipeline is handed. `env` is read at call time, not at
 * construction, so a key set on a running worker takes effect on the next
 * job. `routes` is injectable for tests (a catalogue of stubs).
 */
export function makeOcrProvider(env = process.env, { routes = ROUTES } = {}) {
  return {
    kind: 'ocr-provider',
    plan(tier) {
      return resolveOcrRoutes(tier, env, { routes });
    },
    /** True when ANY tier's routes could run here — "is OCR configured at all". */
    configured() {
      return Object.keys(TIER_ROUTES).some((t) => resolveOcrRoutes(t, env, { routes }).routes.length > 0);
    },
    async run(buf, { tier = 'A', onProgress = () => {} } = {}) {
      const plan = resolveOcrRoutes(tier, env, { routes });
      if (!plan.routes.length) throw new Error(plan.reason);
      const attempts = [];
      // A provider's progress is pipeline progress at the extracting stage;
      // the stage is stamped here so no route has to remember to.
      const relay = (m) => onProgress({ stage: 'extracting', ...(m || {}) });
      for (const route of plan.routes) {
        try {
          const result = await route.run(buf, { env, onProgress: relay });
          const pages = Array.isArray(result) ? result : result?.pages;
          if (!Array.isArray(pages)) throw new Error(`${route.id} returned no pages`);
          return { pages, route: ocrRouteRecord(route, Array.isArray(result) ? { pages } : result, { attempts }) };
        } catch (err) {
          attempts.push({ id: route.id, error: err?.message || String(err) });
          const next = plan.routes[plan.routes.indexOf(route) + 1];
          if (next) relay({ message: `${route.label} failed (${String(err?.message || err).split('\n')[0].slice(0, 120)}) — trying ${next.label}` });
        }
      }
      const detail = attempts.map((a) => `${a.id}: ${a.error.split('\n')[0].slice(0, 160)}`).join('; ');
      throw new Error(`OCR failed on every configured route — ${detail}`);
    },
  };
}

/** Is `x` a provider from makeOcrProvider (as opposed to a bare hook function)? */
export function isOcrProvider(x) {
  return Boolean(x) && typeof x === 'object' && x.kind === 'ocr-provider' && typeof x.run === 'function' && typeof x.plan === 'function';
}

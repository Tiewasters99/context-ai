// SecureSpace tier policy — the one place that says which model providers
// a matter's tier permits, and which matters are SEALED against external
// connectors. Enforced SERVER-SIDE by /api/llm (prod), the vite dev proxy,
// the in-app Assistant (lib/assistant-core.mjs) and the MCP endpoint
// (lib/mcp-core.mjs): the tier is read from the database, never trusted
// from the client.
//
// Tiers (matterspaces.ai_tier, migration 051):
//   A — US frontier. Today's behavior: any US provider.
//   B — SEALED. Exactly one route: a model served from OUR OWN AWS account
//       through Bedrock (provider 'aws-bedrock') under account
//       data_retention_mode=none. Nothing else. When that route is not
//       available on this server, a sealed matter is REFUSED — it is never
//       served by a provider outside the seal.
//   C — SILO. Local inference only; no cloud provider is permitted.
//       Until the Silo hardware exists, every cloud call is refused.
//
// ⚠ 2026-09-19 — Tier B's allowlist used to read
// {aws-bedrock, fireworks, anthropic}. Two providers have now been REMOVED,
// on Eden's decision of 2026-09-19 ("refuse, don't fall back"), because a
// client who seals a matter is promised a processing path, not a best
// effort:
//
//   * ANTHROPIC first-party (api.anthropic.com) retains inputs and outputs
//     for 30 days by default; its ZDR is granted per organization by sales
//     and we have not obtained it (requested 2026-09-18, no reply). It used
//     to sit in the B set so the recorded-escalation fallback kept working
//     on servers where the Bedrock pen was unprovisioned. But this gate has
//     no notion of a per-request escalation and records nothing, so on the
//     /api/llm path the "escalation" was implicit and invisible: a sealed
//     matter's text reached a retaining endpoint because a key happened to
//     be missing. Closed. The ONLY escalation that remains is the in-app
//     Assistant's explicit `escalate: true` flag, which the caller must set
//     per request and which lands in ai_messages as escalation:true
//     (lib/assistant-core.mjs choosePen) — deliberate, per-turn, recorded.
//
//   * FIREWORKS is genuinely zero-retention by default, which is the harder
//     half. The gap is geography: ordinary Fireworks serverless runs on rented
//     capacity across many regions and providers, and US-pinned routing exists
//     only for a small set of specifically US-only serverless models at a
//     price premium. Whether the pen actually in use is on one of those is
//     unverified. "US-hosted" was therefore never established for this route,
//     so it cannot carry a seal. Removed outright.
//
// What this costs, stated plainly: /api/llm has no 'aws-bedrock' route at
// all, so EVERY browser-driven model call bound to a sealed matter (the
// Editor, Bucketizer, cite-check, Moot Bench, converse/generate/structured)
// now refuses with 403 tier_violation instead of answering from a provider
// outside the seal. Sealed chat still works: /api/assistant holds the
// Bedrock pen. On a server with no BEDROCK_ keys — a bare dev checkout —
// sealed matters have no AI at all, by design.
//
// Neither point affects Tier C, which permits nothing, or the content pipes,
// which lib/seal-pipes.mjs fails closed independently of this allowlist.
//
// The seal is INHERITED: a matter's effective tier is the strongest tier
// on the path from the matter to its root (C > B > A). Sealing "Calder v.
// Atlas" seals every sub-matter and folder inside it — search already
// scopes a matter to itself + descendants, so the policy must too.
//
// Requests with NO matter bound (dashboard drafts, the Editor's desk with
// pasted text) are governed by the JWT gate only — including the Moonshot
// sandbox, which is never permitted on any matter-bound call.

// 2026-09-18: the Bedrock pen's MODEL is env-selected (BEDROCK_MODEL; default
// moonshotai.kimi-k2.5 while AWS gates the Claude 5 generation for this
// account — docs/strategy/004, "Invoke tests"). The provider stays
// 'aws-bedrock': the seal claim is the account's data_retention_mode none,
// not the model.
const TIER_PROVIDERS = {
  A: new Set(['anthropic', 'aws-bedrock', 'openai', 'google', 'xai', 'fireworks']),
  B: new Set(['aws-bedrock']),
  C: new Set(),
};

// Providers a sealed matter may reach ONLY through a deliberate, per-request
// escalation that the user asked for and that is written to the record. This
// is NOT an allowlist: nothing consults it unless the caller has already
// proved the escalation (see providerAllowed's `escalation` option, and
// choosePen in lib/assistant-core.mjs, which is the only place that can grant
// one). gateLlmRequest deliberately takes no escalation argument — /api/llm
// writes no record, so it has no way to earn one.
const TIER_ESCALATION_PROVIDERS = {
  B: new Set(['anthropic']),
};

const TIER_RANK = { A: 0, B: 1, C: 2 };
const MAX_ANCESTOR_DEPTH = 32;

/**
 * May this tier be served by this provider?
 *
 * `escalation: true` means the caller is asserting that this particular
 * request is a recorded, user-initiated escalation — the ledger's
 * within_policy column asks the question that way, because an escalation
 * that was asked for and written down is within the policy while the same
 * provider reached silently is not.
 */
export function providerAllowed(tier, provider, { escalation = false } = {}) {
  const allowed = TIER_PROVIDERS[tier];
  if (!allowed) return false;
  if (allowed.has(provider)) return true;
  if (escalation) return Boolean(TIER_ESCALATION_PROVIDERS[tier]?.has(provider));
  return false;
}

/**
 * True when reaching `provider` on this tier would be an escalation — i.e.
 * it is outside the seal and is only ever permitted as a recorded, explicit
 * one. Since 2026-09-19 such a provider is NOT in the tier's allowed set, so
 * a caller that cannot record an escalation simply gets a refusal.
 */
export function isEscalation(tier, provider) {
  return Boolean(TIER_ESCALATION_PROVIDERS[tier]?.has(provider));
}

/** B and C are sealed: closed to external connectors, sealed pens in-app. */
export function isSealedTier(tier) {
  return tier === 'B' || tier === 'C';
}

/** The stronger of two tiers (C > B > A). Unknown values count as A. */
export function strongerTier(a, b) {
  const na = TIER_RANK[a] !== undefined ? a : 'A';
  const nb = TIER_RANK[b] !== undefined ? b : 'A';
  return TIER_RANK[na] >= TIER_RANK[nb] ? na : nb;
}

/**
 * Effective tier of a matter = strongest tier on its ancestor chain.
 * `fetchRow(id)` resolves to { id, parent_matterspace_id, ai_tier } or
 * null. Returns 'A' | 'B' | 'C', or null when the matter does not exist
 * (or is not visible to the caller's client).
 */
export async function walkEffectiveTier(fetchRow, matterId) {
  let row = await fetchRow(matterId);
  if (!row) return null;
  let tier = row.ai_tier ?? 'A';
  const seen = new Set([row.id]);
  let depth = 0;
  while (row.parent_matterspace_id && depth < MAX_ANCESTOR_DEPTH) {
    if (seen.has(row.parent_matterspace_id)) break; // cycle guard
    row = await fetchRow(row.parent_matterspace_id);
    if (!row) break; // parent invisible to this client — stop, keep what we have
    seen.add(row.id);
    tier = strongerTier(tier, row.ai_tier ?? 'A');
    depth++;
  }
  return tier;
}

/**
 * Verify a Supabase JWT by asking the auth server who it belongs to.
 * Returns the user id, or null when the token is missing/invalid.
 */
export async function verifyUser(supabaseUrl, anonKey, bearer) {
  if (!bearer || !bearer.toLowerCase().startsWith('bearer ')) return null;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, authorization: bearer },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The matter's EFFECTIVE tier, read with the service role (RLS-independent
 * — the tier is policy, not content). Returns 'A' | 'B' | 'C', or null
 * when the matter does not exist.
 */
export async function fetchMatterTier(supabaseUrl, serviceKey, matterId) {
  const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
  const fetchRow = async (id) => {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/matterspaces?id=eq.${encodeURIComponent(id)}&select=id,parent_matterspace_id,ai_tier`,
      { headers },
    );
    if (!res.ok) throw new Error(`tier lookup failed (${res.status})`);
    const rows = await res.json();
    return rows?.[0] ?? null;
  };
  return walkEffectiveTier(fetchRow, matterId);
}

/**
 * Same lookup through a supabase-js client (user-scoped or service-role).
 * With a user-scoped client, RLS decides what is visible: a matter the
 * user cannot see resolves to null.
 */
export async function matterTierWithClient(supabase, matterId) {
  const fetchRow = async (id) => {
    const { data, error } = await supabase
      .from('matterspaces')
      .select('id, parent_matterspace_id, ai_tier')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`tier lookup failed: ${error.message}`);
    return data ?? null;
  };
  return walkEffectiveTier(fetchRow, matterId);
}

/**
 * Every matter id whose EFFECTIVE tier is sealed (B or C), as seen by the
 * given supabase-js client: the explicitly sealed matters plus all their
 * descendants. Queries only sealed roots (never the whole table — a full
 * scan would silently truncate at PostgREST's row cap and fail OPEN), so
 * the common case of "nothing sealed" costs one small query.
 */
export async function sealedMatterIds(supabase) {
  const { data: roots, error } = await supabase
    .from('matterspaces')
    .select('id')
    .in('ai_tier', ['B', 'C']);
  if (error) throw new Error(`seal lookup failed: ${error.message}`);
  const sealed = new Set((roots ?? []).map((r) => r.id));
  if (sealed.size === 0) return sealed;
  for (const root of [...sealed]) {
    const { data: desc, error: dErr } = await supabase
      .rpc('matterspace_descendants', { p_root: root });
    if (dErr) throw new Error(`seal lookup failed: ${dErr.message}`);
    for (const r of desc ?? []) sealed.add(r.id);
  }
  return sealed;
}

// ---------------------------------------------------------------------------
// The pause (migration 070) — "stop all AI on this matter, now"
// ---------------------------------------------------------------------------
// The tier says WHERE a matter's content may go. The pause says nothing goes
// anywhere at all — on Tier A, B and C alike. It is deliberately a separate
// question with its own lookup, and not a sixth field on the tier select,
// for one operational reason: production drifts from the migrations folder
// (project_dev_environment_cautions). A database where 070 has not been
// pasted answers a select naming ai_paused with 42703 (undefined_column) —
// so folding the pause into fetchMatterTier's select would turn a missing
// migration into a total AI outage and a broken matter tree. Kept apart, a
// missing column means exactly one thing: not deployed, therefore not paused,
// and every path behaves as it does today.
//
// Note the asymmetry with the rest of this module, which fails CLOSED. The
// pause fails OPEN on "not deployed" and CLOSED on everything else: a column
// that does not exist is a fact about the schema, while a timeout or a 500 is
// an unknown, and an unknown on a matter that may be paused is refused.

const PAUSE_COLUMNS = 'id,parent_matterspace_id,name,ai_paused,ai_paused_at,ai_paused_by,ai_paused_by_name,ai_pause_note';

// PostgREST / Postgres codes that mean "migration 070 is not in this database
// yet", as opposed to "the read failed". 42703 and PGRST204 are the two this
// list has that lib/ledger.mjs's does not, and they are the ones that matter
// here: the table exists, the COLUMN does not.
const PAUSE_NOT_DEPLOYED_CODES = new Set([
  'PGRST202',  // function not found in the schema cache (matter_ai_pause)
  'PGRST203',  // overloaded function not resolvable
  'PGRST204',  // column not found in the schema cache
  'PGRST205',  // table not found in the schema cache
  '42703',     // undefined_column  ← ai_paused, before 070 is pasted
  '42883',     // undefined_function
  '42P01',     // undefined_table
  '3F000',     // invalid_schema_name
]);
const PAUSE_NOT_DEPLOYED_RE =
  /(column .* does not exist|could not find the (column|function|table)|schema cache|function .* does not exist|relation .* does not exist)/i;

/** True when migration 070 simply is not in this database yet. */
export function isPauseNotDeployed(error) {
  if (!error) return false;
  if (error.code && PAUSE_NOT_DEPLOYED_CODES.has(String(error.code))) return true;
  return PAUSE_NOT_DEPLOYED_RE.test(String(error.message ?? ''));
}

/** Nothing is paused, and nothing went wrong. */
const NOT_PAUSED = Object.freeze({ paused: false, notDeployed: false });

/**
 * The one sentence a paused matter says, everywhere. Chat, the browser's
 * model calls, connectors, meetings, the pipeline: the same words, so a user
 * who sees it twice in two surfaces learns one fact rather than two.
 *
 * "since <date>" is the ISO calendar date — unambiguous in every locale, which
 * a rendered month name is not.
 */
export function aiPausedMessage(pause) {
  const who = (pause?.byName && String(pause.byName).trim())
    ? String(pause.byName).trim()
    : 'a member of this matter';
  const when = isoDay(pause?.at);
  return (
    `AI is paused on this matter by ${who} since ${when}. ` +
    'Nothing is being sent to any model.'
  );
}

function isoDay(at) {
  if (!at) return 'an unrecorded date';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? 'an unrecorded date' : d.toISOString().slice(0, 10);
}

/** Shape a matterspaces row into the pause record the rest of the app uses. */
function pauseFromRow(row, matterId) {
  return {
    paused: true,
    notDeployed: false,
    matterId: row.id,
    matterName: row.name ?? null,
    at: row.ai_paused_at ?? null,
    by: row.ai_paused_by ?? null,
    byName: row.ai_paused_by_name ?? null,
    note: row.ai_pause_note ?? null,
    inherited: row.id !== matterId,
  };
}

/**
 * Effective pause of a matter = paused here, or on ANY ancestor — the seal's
 * own inheritance rule (walkEffectiveTier above), walked the same way, with
 * the same depth bound and the same cycle guard. Deliberately NOT a second
 * rule: a sub-matter is paused exactly when the seal would have been
 * inherited from the same row.
 *
 * `fetchRow(id)` resolves to a matterspaces row with the pause columns, or
 * null. It may throw `{ notDeployed: true }` to mean "070 is not here".
 *
 * Returns the NEAREST paused ancestor's record (self first), or NOT_PAUSED.
 */
export async function walkEffectivePause(fetchRow, matterId) {
  if (!matterId) return NOT_PAUSED;
  let id = matterId;
  const seen = new Set();
  let depth = 0;
  while (id && depth < MAX_ANCESTOR_DEPTH) {
    if (seen.has(id)) break;
    seen.add(id);
    const row = await fetchRow(id);
    if (!row) break;               // gone, or invisible to this client
    if (row.ai_paused === true) return pauseFromRow(row, matterId);
    id = row.parent_matterspace_id;
    depth += 1;
  }
  return NOT_PAUSED;
}

/** A thrown marker meaning "the column/function is not in this database". */
class PauseNotDeployed extends Error {
  constructor() { super('ai pause is not deployed'); this.notDeployed = true; }
}

/**
 * The matter's effective pause, read with the SERVICE role over REST — the
 * shape gateLlmRequest needs (the pause is policy, not content, exactly as
 * the tier is). Never throws: a not-deployed schema resolves to NOT_PAUSED,
 * and any other failure resolves to `{ error }`, which the gate treats as a
 * refusal because an unknown is not an open door.
 */
export async function fetchMatterPause(supabaseUrl, serviceKey, matterId) {
  const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
  const fetchRow = async (id) => {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/matterspaces?id=eq.${encodeURIComponent(id)}&select=${PAUSE_COLUMNS}`,
      { headers },
    );
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      if (isPauseNotDeployed(body) || isPauseNotDeployed({ message: body?.details })) {
        throw new PauseNotDeployed();
      }
      throw new Error(`pause lookup failed (${res.status})`);
    }
    const rows = await res.json();
    return rows?.[0] ?? null;
  };
  try {
    return await walkEffectivePause(fetchRow, matterId);
  } catch (err) {
    if (err?.notDeployed) return { paused: false, notDeployed: true };
    return { paused: false, notDeployed: false, error: err?.message || 'pause lookup failed' };
  }
}

/**
 * Same question through a supabase-js client (user-scoped or service-role).
 * Used by the assistant loop, the connectors, the meeting routes and the
 * pipeline — every in-process path.
 */
export async function matterPauseWithClient(supabase, matterId) {
  const fetchRow = async (id) => {
    const { data, error } = await supabase
      .from('matterspaces')
      .select(PAUSE_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      if (isPauseNotDeployed(error)) throw new PauseNotDeployed();
      throw new Error(`pause lookup failed: ${error.message}`);
    }
    return data ?? null;
  };
  try {
    return await walkEffectivePause(fetchRow, matterId);
  } catch (err) {
    if (err?.notDeployed) return { paused: false, notDeployed: true };
    return { paused: false, notDeployed: false, error: err?.message || 'pause lookup failed' };
  }
}

/**
 * Every matter id whose EFFECTIVE pause is on, as seen by this client: the
 * explicitly paused matters plus all their descendants. Costed exactly like
 * sealedMatterIds — ask from the paused side, never scan the table — so the
 * common case (nothing paused) is one small indexed query.
 *
 * Returns `{ ids, notDeployed }`. An empty set with notDeployed:true is the
 * "070 is not pasted" answer and means today's behaviour, unchanged.
 */
export async function pausedMatterIds(supabase) {
  const { data: roots, error } = await supabase
    .from('matterspaces')
    .select('id')
    .eq('ai_paused', true);
  if (error) {
    if (isPauseNotDeployed(error)) return { ids: new Set(), notDeployed: true };
    throw new Error(`pause lookup failed: ${error.message}`);
  }
  const paused = new Set((roots ?? []).map((r) => r.id));
  if (paused.size === 0) return { ids: paused, notDeployed: false };
  for (const root of [...paused]) {
    const { data: desc, error: dErr } = await supabase
      .rpc('matterspace_descendants', { p_root: root });
    if (dErr) throw new Error(`pause lookup failed: ${dErr.message}`);
    for (const r of desc ?? []) paused.add(r.id);
  }
  return { ids: paused, notDeployed: false };
}

/**
 * Full gate for an /api/llm request. Returns { ok: true, escalation } or
 * { ok: false, status, error }. Fails CLOSED: missing auth config is a
 * refusal, not a pass-through.
 *
 * There is no `escalate` argument, and that is the point: this gate writes
 * no record, so it can never satisfy the one condition under which a sealed
 * matter may be answered from outside the seal. A sealed matter here is
 * served by an allowed sealed provider or it is refused — `escalation` in
 * the success result is therefore always false today, and is kept so callers
 * that log it keep compiling.
 */
export async function gateLlmRequest({ supabaseUrl, anonKey, serviceKey, bearer, provider, matterId }) {
  if (!supabaseUrl || !anonKey) {
    return { ok: false, status: 500, error: 'auth_not_configured' };
  }
  const userId = await verifyUser(supabaseUrl, anonKey, bearer);
  if (!userId) return { ok: false, status: 401, error: 'auth_required' };

  return gateMatterForUser({ supabaseUrl, serviceKey, provider, matterId, userId });
}

/**
 * The MATTER half of the gate, for a caller that has already established who
 * the user is by other means.
 *
 * This is verbatim what `gateLlmRequest` has always run after verifying the
 * token — extracted, not rewritten, so there is exactly one copy of the order
 * (tier → pause → the tier's allowlist) and one copy of every code and
 * sentence. The order is load-bearing and is explained below.
 *
 * The other caller is the Fly worker (`lib/llm-server-call.mjs`), which runs a
 * Bucketizer classification for a user who is not at the keyboard: there is no
 * JWT to verify, because the laptop is shut. The user id comes off the
 * `bucketizer_runs` row, which was written by /api/bucketizer-run.mjs under
 * that user's own token and checked against that user's own RLS. Exposing this
 * half is what lets the worker inherit the identical gate instead of growing a
 * second one that drifts.
 */
export async function gateMatterForUser({ supabaseUrl, serviceKey, provider, matterId, userId }) {
  if (!matterId) return { ok: true, userId, escalation: false };

  if (!serviceKey) return { ok: false, status: 500, error: 'auth_not_configured' };
  const tier = await fetchMatterTier(supabaseUrl, serviceKey, matterId);
  if (!tier) return { ok: false, status: 404, error: 'matter_not_found' };

  // The PAUSE is asked BEFORE the tier's allowlist, and the order is
  // load-bearing. lib/llm-sealed-route.mjs substitutes the sealed Bedrock pen
  // for a refusal whose error is exactly `tier_violation` on Tier B — so if a
  // paused sealed matter were refused as a tier violation, the sealed route
  // would helpfully answer it from the pen. A paused matter must refuse with
  // its own code, which that module passes straight through (it returns null
  // for every error but tier_violation), leaving /api/llm's own refusal to
  // answer and zero provider calls made.
  const pause = await fetchMatterPause(supabaseUrl, serviceKey, matterId);
  if (pause.error) {
    // Not "not deployed" — an actual failure to read. A matter that may be
    // paused and cannot be checked is treated as paused.
    return {
      ok: false, status: 503, error: 'ai_pause_unknown', tier,
      message:
        'Whether AI is paused on this matter could not be checked, so nothing was sent — a ' +
        'matter is treated as paused until that is known. Try again in a moment.',
    };
  }
  if (pause.paused) {
    return {
      ok: false, status: 403, error: 'ai_paused', tier,
      paused: { by: pause.byName, at: pause.at, matterId: pause.matterId, inherited: pause.inherited },
      message: aiPausedMessage(pause),
    };
  }

  if (!providerAllowed(tier, provider)) {
    return { ok: false, status: 403, error: 'tier_violation', tier, provider };
  }
  return { ok: true, userId, tier, escalation: isEscalation(tier, provider) };
}

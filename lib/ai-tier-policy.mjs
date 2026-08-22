// SecureSpace tier policy — the one place that says which model providers
// a matter's tier permits, and which matters are SEALED against external
// connectors. Enforced SERVER-SIDE by /api/llm (prod), the vite dev proxy,
// the in-app Assistant (lib/assistant-core.mjs) and the MCP endpoint
// (lib/mcp-core.mjs): the tier is read from the database, never trusted
// from the client.
//
// Tiers (matterspaces.ai_tier, migration 051):
//   A — US frontier. Today's behavior: any US provider.
//   B — SEALED. US-hosted zero-retention pens (Fireworks); Anthropic
//       permitted as a logged escalation (recorded, never silent).
//   C — SILO. Local inference only; no cloud provider is permitted.
//       Until the Silo hardware exists, every cloud call is refused.
//
// The seal is INHERITED: a matter's effective tier is the strongest tier
// on the path from the matter to its root (C > B > A). Sealing "Calder v.
// Atlas" seals every sub-matter and folder inside it — search already
// scopes a matter to itself + descendants, so the policy must too.
//
// Requests with NO matter bound (dashboard drafts, the Editor's desk with
// pasted text) are governed by the JWT gate only — including the Moonshot
// sandbox, which is never permitted on any matter-bound call.

const TIER_PROVIDERS = {
  A: new Set(['anthropic', 'openai', 'google', 'xai', 'fireworks']),
  B: new Set(['fireworks', 'anthropic']),
  C: new Set(),
};

const TIER_RANK = { A: 0, B: 1, C: 2 };
const MAX_ANCESTOR_DEPTH = 32;

export function providerAllowed(tier, provider) {
  const allowed = TIER_PROVIDERS[tier];
  if (!allowed) return false;
  return allowed.has(provider);
}

/** Anthropic on a Tier-B matter is allowed but must be recorded as an escalation. */
export function isEscalation(tier, provider) {
  return tier === 'B' && provider === 'anthropic';
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

/**
 * Full gate for an /api/llm request. Returns { ok: true, escalation } or
 * { ok: false, status, error }. Fails CLOSED: missing auth config is a
 * refusal, not a pass-through.
 */
export async function gateLlmRequest({ supabaseUrl, anonKey, serviceKey, bearer, provider, matterId }) {
  if (!supabaseUrl || !anonKey) {
    return { ok: false, status: 500, error: 'auth_not_configured' };
  }
  const userId = await verifyUser(supabaseUrl, anonKey, bearer);
  if (!userId) return { ok: false, status: 401, error: 'auth_required' };

  if (!matterId) return { ok: true, userId, escalation: false };

  if (!serviceKey) return { ok: false, status: 500, error: 'auth_not_configured' };
  const tier = await fetchMatterTier(supabaseUrl, serviceKey, matterId);
  if (!tier) return { ok: false, status: 404, error: 'matter_not_found' };
  if (!providerAllowed(tier, provider)) {
    return { ok: false, status: 403, error: 'tier_violation', tier, provider };
  }
  return { ok: true, userId, tier, escalation: isEscalation(tier, provider) };
}

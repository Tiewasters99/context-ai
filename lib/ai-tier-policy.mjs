// SecureSpace tier policy — the one place that says which model providers
// a matter's tier permits. Enforced SERVER-SIDE by /api/llm (prod) and the
// vite dev proxy: the tier is read from the database, never trusted from
// the client.
//
// Tiers (matterspaces.ai_tier, migration 051):
//   A — US frontier. Today's behavior: any US provider.
//   B — SEALED. US-hosted zero-retention pens (Fireworks); Anthropic
//       permitted as a logged escalation (recorded, never silent).
//   C — SILO. Local inference only; no cloud provider is permitted.
//       Until the Silo hardware exists, every cloud call is refused.
//
// Requests with NO matter bound (dashboard drafts, the Editor's desk with
// pasted text) are governed by the JWT gate only — including the Moonshot
// sandbox, which is never permitted on any matter-bound call.

const TIER_PROVIDERS = {
  A: new Set(['anthropic', 'openai', 'google', 'xai', 'fireworks']),
  B: new Set(['fireworks', 'anthropic']),
  C: new Set(),
};

export function providerAllowed(tier, provider) {
  const allowed = TIER_PROVIDERS[tier];
  if (!allowed) return false;
  return allowed.has(provider);
}

/** Anthropic on a Tier-B matter is allowed but must be recorded as an escalation. */
export function isEscalation(tier, provider) {
  return tier === 'B' && provider === 'anthropic';
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
 * The matter's tier, read with the service role (RLS-independent — the
 * tier is policy, not content). Returns 'A' | 'B' | 'C', or null when the
 * matter does not exist.
 */
export async function fetchMatterTier(supabaseUrl, serviceKey, matterId) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/matterspaces?id=eq.${encodeURIComponent(matterId)}&select=ai_tier`,
    { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } },
  );
  if (!res.ok) throw new Error(`tier lookup failed (${res.status})`);
  const rows = await res.json();
  return rows?.[0]?.ai_tier ?? null;
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

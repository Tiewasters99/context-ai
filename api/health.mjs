// GET /api/health — connector triage endpoint.
//
// One URL that answers "is the MCP server healthy, or is it my client's
// token?" in five seconds, from any device. When a connector (claude.ai,
// ChatGPT, Gemini, Grok — especially on mobile mid-trial-prep) can't reach
// Contextspaces, open https://www.contextspaces.ai/api/health in a browser:
//   - all checks ok  → the server is fine; the CLIENT's auth is stale.
//     Fix: remove + re-add / re-authenticate the connector on that device.
//   - a check failed → the named subsystem is down/misconfigured server-side.
//
// Public by design: it reports only presence/health booleans, never values,
// and touches nothing user-scoped. No auth so that it still works when auth
// itself is what broke.

import { signJwt, verifyJwt, getOauthSecret } from '../lib/oauth-jwt.mjs';

const BUILD = '2026-07-08-health-v1';

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const checks = {};

  // Env presence (booleans only — never values).
  checks.env = {
    supabase_url: !!(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL),
    supabase_anon_key: !!process.env.VITE_SUPABASE_ANON_KEY,
    openai_api_key: !!process.env.OPENAI_API_KEY,
    google_api_key: !!process.env.GOOGLE_API_KEY,
    mcp_oauth_secret: false,
    mcp_signing_key: !!process.env.MCP_SIGNING_KEY_JWK_B64,
  };

  // OAuth secret usable end-to-end: present + sign/verify roundtrip works.
  // If this fails after an env change, every connector token is dead and
  // clients need re-auth (see lib/oauth-jwt.mjs getOauthSecret).
  try {
    const secret = getOauthSecret();
    const probe = signJwt({ typ: 'health', sub: 'probe' }, secret, 60);
    checks.env.mcp_oauth_secret = true;
    checks.oauth_sign_verify = !!verifyJwt(probe, secret);
  } catch {
    checks.oauth_sign_verify = false;
  }

  // Database reachable (anon key, no user data — RLS applies regardless).
  const t0 = Date.now();
  try {
    const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const r = await fetch(`${url}/rest/v1/matterspaces?select=id&limit=1`, {
      headers: { apikey: process.env.VITE_SUPABASE_ANON_KEY || '' },
    });
    checks.database = { reachable: r.ok || r.status === 401 || r.status === 400, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    checks.database = { reachable: false, error: e.message?.slice(0, 120), ms: Date.now() - t0 };
  }

  // OAuth discovery serves on this host (what MCP clients fetch first).
  checks.oauth_metadata_url = `https://${host}/.well-known/oauth-authorization-server`;

  const ok =
    Object.values(checks.env).every(Boolean) &&
    checks.oauth_sign_verify === true &&
    checks.database.reachable === true;

  res.statusCode = ok ? 200 : 503;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify({
    ok,
    hint: ok
      ? 'Server healthy. If a connector still fails, its token is stale — remove and re-add the connector on that device.'
      : 'Server-side problem — see failed checks.',
    host,
    build: BUILD,
    checks,
  }, null, 2));
}

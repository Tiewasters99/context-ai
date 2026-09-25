// Called by the OAuthAuthorize React page after the user clicks Approve.
//
// Inputs (POST body):
//   client_id, redirect_uri, code_challenge, code_challenge_method ('S256'),
//   state, resource, scope
//   connect_as ('assistant' | 'agent') and, for 'agent',
//   agent: { name, provider, matter_scope: [matter ids] }   (migration 087)
// Plus Authorization: Bearer <supabase access_token> — proves the caller is
// the logged-in Contextspaces user. We verify it with SUPABASE_JWT_SECRET
// to extract the user_id (sub).
//
// Output: { redirect } — the full URL to redirect the user-agent to, with
// ?code=...&state=... appended. The browser then navigates there, which
// hands control back to the OAuth client (claude.ai).

import { createClient } from '@supabase/supabase-js';

import { fetchMatterTier } from '../lib/ai-tier-policy.mjs';
import {
  AgentConsentError, checkAgentScope, parseAgentConsent, unusableTokenHash,
} from '../lib/oauth-agent-consent.mjs';
import { approveGrant } from '../lib/oauth-grants.mjs';
import { signJwt, verifyJwt, getOauthSecret } from '../lib/oauth-jwt.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, { error: 'config_error', detail: 'Supabase env vars unset' });
  }

  let oauthSecret;
  try { oauthSecret = getOauthSecret(); }
  catch (e) { return json(res, 500, { error: 'config_error', detail: e.message }); }

  // 1. Caller is the logged-in user. We forward their Supabase access token
  // to Supabase itself for validation via auth.getUser(); that handles any
  // JWT key version (legacy HS256 + the newer ECC signing keys) without us
  // having to keep our own verifier in sync with Supabase's key rotation.
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'login_required', detail: 'missing bearer' });
  }
  const sbToken = auth.slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${sbToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user?.id) {
    return json(res, 401, { error: 'login_required', detail: userErr?.message || 'invalid supabase session' });
  }
  const user_id = userData.user.id;

  // 2. Validate the OAuth params.
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, resource, scope } = body;
  if (!client_id || !redirect_uri || !code_challenge) {
    return json(res, 400, { error: 'invalid_request', detail: 'client_id, redirect_uri, code_challenge required' });
  }
  if (code_challenge_method && code_challenge_method !== 'S256') {
    return json(res, 400, { error: 'invalid_request', detail: 'only S256 supported' });
  }
  // 3. Validate the client_id JWT signature + that redirect_uri matches registration.
  const client = verifyJwt(client_id, oauthSecret);
  if (!client || client.typ !== 'client' || !Array.isArray(client.redirect_uris)) {
    return json(res, 400, { error: 'invalid_client' });
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    return json(res, 400, { error: 'invalid_redirect_uri', detail: 'redirect_uri not in registration' });
  }

  // 4. Which connection the user chose (migration 087). "Full assistant" is
  // today's behaviour and the default; "agent" confines the client to the
  // matters ticked on the consent screen. The agent's matters are checked
  // here, as the signed-in user, before anything is written: each must be a
  // matter this account can open (the user's own session, so RLS answers)
  // and none may be in a SecureSpace (service role, so a sealed ancestor the
  // user cannot see still counts). Any failure refuses the whole consent.
  let agent = null;
  try {
    const parsed = parseAgentConsent(body, client.client_name || null);
    if (parsed) {
      const matterScope = await checkAgentScope(parsed.matterIds, {
        visibleIds: async (ids) => {
          const { data, error } = await sb.from('matterspaces').select('id').in('id', ids);
          if (error) throw new Error(error.message);
          return new Set((data ?? []).map((r) => String(r.id).toLowerCase()));
        },
        tierOf: (id) => {
          if (!SERVICE_KEY) throw new Error('service key unset');
          return fetchMatterTier(SUPABASE_URL, SERVICE_KEY, id);
        },
      });
      agent = { name: parsed.name, provider: parsed.provider, matterScope, tokenHash: unusableTokenHash() };
    }
  } catch (e) {
    if (e instanceof AgentConsentError) return json(res, e.status, { error: e.code, detail: e.detail });
    throw e;
  }

  // 5. Record the approval (migrations 065, 087). This is the row the
  // Connections page reads to say "Connected" truthfully, and the row the
  // user revokes to cut this one client off. Re-approving a client that is
  // already connected in the same way attaches to the grant that exists.
  //
  // Full assistant: it never blocks consent. If the grants table is not
  // deployed yet, or the database is unreachable, gid comes back null and
  // the flow continues exactly as it did before 065.
  //
  // Agent: it DOES block consent. An agent connection that could not be
  // recorded is refused, never quietly turned into a full-access one.
  const approval = await approveGrant({
    user_id,
    client_id,
    client_name: client.client_name || null,
    scope: scope || 'mcp',
    agent,
  });
  const { gid, outcome, agentTokenId } = approval;
  console.log('[oauth-approve] grant %s for sub=%s client=%s as=%s',
    gid ? `${outcome} (${gid})` : `not recorded (${outcome})`, user_id,
    (client.client_name || 'unknown').slice(0, 40), agent ? 'agent' : 'assistant');
  if (agent && !approval.ok) {
    return json(res, 503, {
      error: 'agent_connect_unavailable',
      detail: approval.undeployed
        ? 'Connecting as an agent is not switched on yet. Nothing was granted.'
        : 'Contextspaces could not record the agent connection, so nothing was granted. Try again.',
    });
  }

  // 6. Mint the authorization code. 60-second TTL. `gid` rides along so the
  // token endpoint can stamp it into the access and refresh tokens; omitted
  // entirely when there is none, which keeps the payload byte-identical to
  // the pre-065 shape.
  const code = signJwt(
    {
      typ: 'code',
      sub: user_id,
      client_id,           // bound to the same client
      redirect_uri,
      code_challenge,
      resource: resource || null,
      scope: scope || 'mcp',
      ...(gid ? { gid } : {}),
      // 087: the agent this connection is. Only ever with a gid.
      ...(gid && agentTokenId ? { agt: agentTokenId } : {}),
    },
    oauthSecret,
    60,
  );

  // 7. Build the redirect URL.
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);

  return json(res, 200, { redirect: url.toString() });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

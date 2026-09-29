// /api/oauth-client-mint — minting a confidential OAuth client on the server,
// driven through the real handler with Supabase's user endpoint stubbed.
// No database, no network, no env of yours.
//
// What it proves
// ---------------------------------------------------------------------------
//   OFF     with OAUTH_CLIENT_ADMIN_EMAILS unset → 503 not_enabled, whoever asks.
//   WHO     no bearer → 401; a session Supabase rejects → 401; a valid session
//           whose email is not listed → 403; case and spacing in the list do
//           not matter.
//   WHAT    client_name required; 1–5 https redirect URIs without query or
//           fragment; duplicates refused.
//   MINT    the answer's client_id verifies as a confidential client under
//           the server's secret, its secret_hash matches the returned secret,
//           and the returned secret appears nowhere in the client_id. Two
//           mints differ. The response never carries the signing secret.
//   FLOW    the minted client passes lib/oauth-clients.mjs checks exactly as
//           one from scripts/register-oauth-client.mjs would.
//
//   node scripts/_verify-oauth-client-mint.mjs

const SB_URL = 'https://stub.supabase.test';
process.env.VITE_SUPABASE_URL = SB_URL;
process.env.VITE_SUPABASE_ANON_KEY = 'stub-anon-key';
process.env.MCP_OAUTH_SECRET = 'harness-oauth-secret-that-is-long-enough-32+';
delete process.env.OAUTH_CLIENT_ADMIN_EMAILS;

let failures = 0; let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + String(detail).slice(0, 160) : ''}`);
  if (ok) passes += 1; else failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

// Supabase's GET /auth/v1/user, keyed by the bearer the page would send.
const SESSIONS = {
  'sb-eden': { id: '11111111-1111-4111-8111-111111111111', email: 'QuaintonLaw@gmail.com' },
  'sb-bob': { id: '22222222-2222-4222-8222-222222222222', email: 'bob@example.test' },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.origin === SB_URL && url.pathname === '/auth/v1/user') {
    const h = init.headers || {};
    const bearer = String(h.Authorization || h.authorization || '').replace(/^Bearer\s+/i, '');
    const u = SESSIONS[bearer];
    if (!u) return new Response(JSON.stringify({ msg: 'invalid JWT', code: 401 }), { status: 401, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ...u, aud: 'authenticated', role: 'authenticated' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};

const { default: handler, adminEmails } = await import('../api/oauth-client-mint.mjs');
const { verifyJwt } = await import('../lib/oauth-jwt.mjs');
const clients = await import('../lib/oauth-clients.mjs');
const SECRET = process.env.MCP_OAUTH_SECRET;

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(b) { this.body = b ?? null; return this; },
    json() { try { return JSON.parse(this.body || 'null'); } catch { return null; } },
  };
}
const CB = 'https://chat.openai.com/aip/g-abc123/oauth/callback';
const CB2 = 'https://chatgpt.com/aip/g-abc123/oauth/callback';
async function post(body, session = 'sb-eden', method = 'POST') {
  const res = mockRes();
  await handler({
    method,
    headers: { host: 'www.contextspaces.ai', 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, res);
  return res;
}
const good = { client_name: 'Contextspaces GPT', redirect_uris: [CB, CB2] };

section('switched off without the allowlist');
{
  check(adminEmails({}).length === 0 && adminEmails({ OAUTH_CLIENT_ADMIN_EMAILS: ' A@x.test, b@y.test ,, ' }).join('|') === 'a@x.test|b@y.test',
    'adminEmails: empty when unset; trimmed, lower-cased, blanks dropped');
  const r = await post(good, 'sb-eden');
  check(r.statusCode === 503 && r.json()?.error === 'not_enabled', 'OAUTH_CLIENT_ADMIN_EMAILS unset → 503 not_enabled even for a valid session', r.body);
}

process.env.OAUTH_CLIENT_ADMIN_EMAILS = 'quaintonlaw@gmail.com';

section('who may mint');
{
  let r = await post(good, null);
  check(r.statusCode === 401 && r.json()?.error === 'login_required', 'no bearer → 401');
  r = await post(good, 'sb-forged');
  check(r.statusCode === 401 && r.json()?.error === 'login_required', 'a session Supabase rejects → 401');
  r = await post(good, 'sb-bob');
  check(r.statusCode === 403 && r.json()?.error === 'not_an_admin' && !r.json()?.client_id, 'a valid session not on the list → 403, nothing minted', r.body);
  r = await post(good, 'sb-eden', 'GET');
  check(r.statusCode === 405, 'GET → 405');
}

section('what may be minted');
{
  let r = await post({ redirect_uris: [CB] });
  check(r.statusCode === 400 && /client_name/.test(r.json()?.detail || ''), 'client_name required');
  r = await post({ client_name: 'x', redirect_uris: [] });
  check(r.statusCode === 400, 'at least one redirect_uri');
  r = await post({ client_name: 'x', redirect_uris: Array.from({ length: 6 }, (_, i) => `https://h${i}.test/cb`) });
  check(r.statusCode === 400, 'at most five');
  r = await post({ client_name: 'x', redirect_uris: ['http://chat.openai.com/aip/g-1/oauth/callback'] });
  check(r.statusCode === 400 && /https/.test(r.json()?.detail || ''), 'http refused');
  r = await post({ client_name: 'x', redirect_uris: ['https://chat.openai.com/aip/g-1/oauth/callback?x=1'] });
  check(r.statusCode === 400, 'a query string refused');
  r = await post({ client_name: 'x', redirect_uris: ['not a url'] });
  check(r.statusCode === 400, 'garbage refused');
  r = await post({ client_name: 'x', redirect_uris: [CB, CB] });
  check(r.statusCode === 400 && /duplicate/.test(r.json()?.detail || ''), 'duplicates refused');
}

section('the mint');
{
  const r = await post(good, 'sb-eden');
  const j = r.json();
  check(r.statusCode === 200 && typeof j?.client_id === 'string' && typeof j?.client_secret === 'string', 'the owner mints → 200 with client_id + client_secret', r.statusCode);
  const payload = verifyJwt(j.client_id, SECRET);
  check(clients.isConfidentialClient(payload) && payload.client_name === 'Contextspaces GPT' && payload.redirect_uris.join('|') === `${CB}|${CB2}`,
    'client_id verifies under the server secret as a confidential client with the name and both callbacks');
  check(clients.clientSecretMatches(payload, j.client_secret) && !clients.clientSecretMatches(payload, j.client_secret + 'x'),
    'the returned secret matches secret_hash, nothing else does');
  check(j.client_secret.startsWith('csps_') && !j.client_id.includes(j.client_secret.slice(6)), 'the secret is csps_-prefixed and appears nowhere in the client_id');
  check(!r.body.includes(SECRET), 'the signing secret is not in the response');
  check(r.headers['cache-control'] === 'no-store', 'no-store');
  check(j.client_name === 'Contextspaces GPT' && Array.isArray(j.redirect_uris) && typeof j.minted_at === 'string', 'the echo names what was minted');
  const r2 = await post(good, 'sb-eden');
  check(r2.json()?.client_id !== j.client_id && r2.json()?.client_secret !== j.client_secret, 'a second mint is a different client');
  // Same shape scripts/register-oauth-client.mjs produces.
  const local = clients.mintConfidentialClient({ client_name: 'Contextspaces GPT', redirect_uris: [CB, CB2] }, SECRET);
  const lp = verifyJwt(local.client_id, SECRET);
  const keys = (p) => Object.keys(p).filter((k) => !['iat', 'exp', 'jti', 'secret_hash'].includes(k)).sort().join(',');
  check(keys(lp) === keys(payload) && lp.token_endpoint_auth_method === payload.token_endpoint_auth_method, 'identical registration shape to the local script\'s');
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : `CLIENT MINT HOLDS — ${passes} checks: only a listed owner, only https callbacks, the secret shown once and the signing secret never.`}\n`);
process.exit(failures ? 1 : 0);

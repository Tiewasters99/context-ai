// Live verification of the SecureSpace gate on prod /api/llm, run AFTER
// the gate deploys. As the real user (magiclink JWT):
//   1. no token            -> 401
//   2. token, no matter    -> passes through to a real (tiny) model call
//   3. token + Tier-B matter + moonshot -> 403 tier_violation
//   4. token + Tier-B matter + fireworks -> allowed
// Temporarily re-tiers one matter to B (service role) and RESTORES it.
import fs from 'node:fs/promises';

const txt = await fs.readFile('C:/Users/equai/context-ai/.env', 'utf8');
const env = {};
for (const line of txt.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = env.VITE_SUPABASE_URL, SRK = env.SUPABASE_SERVICE_ROLE_KEY, ANON = env.VITE_SUPABASE_ANON_KEY;
const API = 'https://www.contextspaces.ai/api/llm';

const j = async (res) => { const t = await res.text(); try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; } };
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => { console.log(`  FAIL  ${m}\n        ${JSON.stringify(d).slice(0, 250)}`); failures++; };
let failures = 0;

// tiny, cheap provider payload (a few tokens)
const tiny = (model) => JSON.stringify({ model, max_tokens: 8, stream: false, messages: [{ role: 'user', content: 'Say ok.' }] });

// ── sign in ───────────────────────────────────────────────────────────
let r = await j(await fetch(`${SB}/auth/v1/admin/generate_link`, {
  method: 'POST', headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', email: 'equainton@gmail.com' }),
}));
const th = r.body?.hashed_token ?? r.body?.properties?.hashed_token;
r = await j(await fetch(`${SB}/auth/v1/verify`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', token_hash: th }),
}));
const jwt = r.body?.access_token;
if (!jwt) { console.log('sign-in failed'); process.exit(1); }
console.log(`signed in as ${r.body.user.email}\n`);

// ── 1. no token -> 401 ────────────────────────────────────────────────
let g = await j(await fetch(API, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k2p6', body: tiny('accounts/fireworks/models/kimi-k2p6') }),
}));
if (g.status === 401) pass('unauthenticated request refused (401)');
else fail(`expected 401, got ${g.status}`, g.body);

// ── 2. token, no matter -> real model call passes ─────────────────────
g = await j(await fetch(API, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k2p6', body: tiny('accounts/fireworks/models/kimi-k2p6') }),
}));
if (g.status === 200 && g.body?.choices) pass('authenticated matter-less call passes through to the model');
else fail('authenticated call did not reach the model', { status: g.status, body: g.body });

// ── pick a matter and seal it temporarily ─────────────────────────────
const H = { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' };
const mt = await j(await fetch(`${SB}/rest/v1/matterspaces?select=id,name,ai_tier&limit=1`, { headers: H }));
const matter = mt.body?.[0];
if (!matter) { console.log('no matter found'); process.exit(1); }
const originalTier = matter.ai_tier;
console.log(`\ntest matter: "${matter.name}" (tier ${originalTier}) — sealing to B temporarily`);
await fetch(`${SB}/rest/v1/matterspaces?id=eq.${matter.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ ai_tier: 'B' }) });

try {
  // ── 3. sealed matter + moonshot -> 403 ──────────────────────────────
  g = await j(await fetch(API, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ provider: 'moonshot', model: 'kimi-k3', body: tiny('kimi-k3'), matterId: matter.id }),
  }));
  if (g.status === 403 && g.body?.error === 'tier_violation') pass('sealed matter refuses moonshot (403 tier_violation)');
  else fail(`expected 403 tier_violation, got ${g.status}`, g.body);

  // ── 4. sealed matter + fireworks -> allowed ─────────────────────────
  g = await j(await fetch(API, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k2p6', body: tiny('accounts/fireworks/models/kimi-k2p6'), matterId: matter.id }),
  }));
  if (g.status === 200 && g.body?.choices) pass('sealed matter allows the sealed pen (fireworks)');
  else fail('sealed pen refused on sealed matter', { status: g.status, body: g.body });
} finally {
  await fetch(`${SB}/rest/v1/matterspaces?id=eq.${matter.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ ai_tier: originalTier }) });
  const check = await j(await fetch(`${SB}/rest/v1/matterspaces?id=eq.${matter.id}&select=ai_tier`, { headers: H }));
  console.log(`matter restored to tier ${check.body?.[0]?.ai_tier}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);

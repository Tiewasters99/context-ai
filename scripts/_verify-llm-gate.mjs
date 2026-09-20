// Live verification of the SecureSpace gate on prod /api/llm, run AFTER
// the gate deploys. As the real user (magiclink JWT):
//   1. no token            -> 401
//   2. token, no matter    -> passes through to a real (tiny) model call
//   3. token + Tier-B matter + moonshot -> 403 tier_violation
//   4. token + Tier-B matter + fireworks -> the SEALED ROUTE
//   5. token + Tier-B matter + anthropic -> the SEALED ROUTE
// Temporarily re-tiers one matter to B (service role) and RESTORES it.
// The offline counterpart of cases 3–5 (no server, no secrets) is
// scripts/_verify-sealed-no-fallback.mjs and
// scripts/_verify-llm-sealed-route.mjs.
//
// What cases 4 and 5 expect, and why it changed twice
// ---------------------------------------------------------------------------
// 2026-09-19 (PR #159) narrowed Tier B to `{aws-bedrock}` and /api/llm had no
// Bedrock route, so both cases became `403 tier_violation`. PR #163 then GAVE
// /api/llm that route: a sealed matter is now served by the sealed pen, so
// neither case is a refusal any more. The outcome depends on something this
// script cannot see from the outside — whether the target server holds the
// BEDROCK_ keys (memo Step 4 on Vercel):
//
//   keys present -> 200, and the answer carries `x-contextspaces-pen` naming
//                   the pen that served it. The browser's `provider`/`model`
//                   were a request, not a fact.
//   keys absent  -> 503 `sealed_pen_unavailable`. Still never the provider
//                   the client named.
//
// So both are accepted and the script PRINTS which one it saw; a 403, a 200
// without the pen header, or anything else is a real failure. Case 3
// (moonshot) is unchanged at 403: the Moonshot sandbox is refused on every
// matter-bound call, Tier A included, and sealing a matter must not make it
// more permissive than leaving it open.
//
// EDITED 2026-09-19 WITHOUT BEING RUN. This harness signs in as the real user
// and re-tiers a production matter, so the reconciliation lane updated these
// expectations by reading the code and did not execute it. First run should
// be against prod after #163 deploys.
import fs from 'node:fs/promises';

const txt = await fs.readFile('C:/Users/equai/context-ai/.env', 'utf8');
const env = {};
for (const line of txt.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = env.VITE_SUPABASE_URL, SRK = env.SUPABASE_SERVICE_ROLE_KEY, ANON = env.VITE_SUPABASE_ANON_KEY;
const API = process.argv[2] || 'https://www.contextspaces.ai/api/llm';

const j = async (res) => {
  const t = await res.text();
  const pen = res.headers.get('x-contextspaces-pen') || null;
  try { return { status: res.status, pen, body: JSON.parse(t) }; } catch { return { status: res.status, pen, body: t }; }
};
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => { console.log(`  FAIL  ${m}\n        ${JSON.stringify(d).slice(0, 250)}`); failures++; };
let failures = 0;

/**
 * A sealed matter's browser call: served by the sealed pen, or refused
 * because this server holds none. Both are correct; the thing that must
 * never happen is the provider the client named answering. See the header.
 */
function checkSealed(label, g) {
  if (g.status === 200 && g.pen) { pass(`${label} — served by the sealed pen: "${g.pen}"`); return; }
  if (g.status === 503 && g.body?.error === 'sealed_pen_unavailable') {
    pass(`${label} — 503 sealed_pen_unavailable (no BEDROCK_ keys on this server; memo Step 4)`);
    return;
  }
  if (g.status === 403) {
    fail(`${label} — 403: the sealed route did not engage. Is PR #163 deployed?`, g.body);
    return;
  }
  fail(`${label} — expected 200 from the sealed pen or 503 sealed_pen_unavailable`, { status: g.status, pen: g.pen, body: g.body });
}

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

  // ── 4. sealed matter + fireworks -> the sealed route ────────────────
  // Fireworks left the Tier-B set on 2026-09-19: its zero retention is real
  // but its US hosting was never established, so it cannot carry a seal. The
  // browser still names it (the Editor's default pen); the SERVER answers
  // from the sealed pen instead, or says it has none. api.fireworks.ai is
  // not contacted either way — asserted offline by
  // scripts/_verify-llm-sealed-route.mjs, which witnesses every egress.
  g = await j(await fetch(API, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k2p6', body: tiny('accounts/fireworks/models/kimi-k2p6'), matterId: matter.id }),
  }));
  checkSealed('sealed matter + fireworks', g);

  // ── 5. sealed matter + first-party anthropic -> the sealed route ────
  // This route records nothing, so it can never earn an escalation. A
  // sealed matter's text must not reach a 30-day-retention endpoint because
  // some other key happened to be missing — so it is substituted, or refused,
  // but never forwarded to api.anthropic.com.
  g = await j(await fetch(API, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ provider: 'anthropic', model: 'claude-opus-4-8', body: tiny('claude-opus-4-8'), matterId: matter.id }),
  }));
  checkSealed('sealed matter + first-party anthropic', g);
  // A served turn is billed to the wallet at the PEN's price, not at the
  // Opus rate the body names (migration 063 + the reconciliation in
  // api/llm.mjs). Read it back from usage_events if you want the number:
  //   select model, cents_estimate, cents_actual, meta from public.usage_events
  //    where kind = 'llm' order by created_at desc limit 5;
} finally {
  await fetch(`${SB}/rest/v1/matterspaces?id=eq.${matter.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ ai_tier: originalTier }) });
  const check = await j(await fetch(`${SB}/rest/v1/matterspaces?id=eq.${matter.id}&select=ai_tier`, { headers: H }));
  console.log(`matter restored to tier ${check.body?.[0]?.ai_tier}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);

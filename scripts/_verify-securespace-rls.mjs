// End-to-end verification of migration 051 (SecureSpace seal) as the REAL
// user, so RLS is genuinely exercised — modeled on _verify-marginalia-rls.mjs.
// Checks the 047 bug class (INSERT .. RETURNING vs SELECT policy), the
// session→messages embed the UI will use, the CHECK and UNIQUE constraints,
// and the ai_tier column default. Creates one session + two messages on a
// real matter, then DELETES them.
import fs from 'node:fs/promises';

const txt = await fs.readFile('C:/Users/equai/context-ai/.env', 'utf8');
const env = {};
for (const line of txt.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const URL_ = env.VITE_SUPABASE_URL;
const SRK = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.VITE_SUPABASE_ANON_KEY;

const j = async (res) => {
  const t = await res.text();
  try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; }
};
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => { console.log(`  FAIL  ${m}\n        ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 300)}`); failures++; };
let failures = 0;

// ── sign in as the real user ──────────────────────────────────────────
let r = await j(await fetch(`${URL_}/auth/v1/admin/generate_link`, {
  method: 'POST',
  headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', email: 'equainton@gmail.com' }),
}));
const tokenHash = r.body?.hashed_token ?? r.body?.properties?.hashed_token;
if (!tokenHash) { console.log('generate_link failed', r.status); process.exit(1); }
r = await j(await fetch(`${URL_}/auth/v1/verify`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
}));
const jwt = r.body?.access_token;
if (!jwt) { console.log('verify failed', r.status, JSON.stringify(r.body).slice(0, 200)); process.exit(1); }
console.log(`signed in as ${r.body.user.email}\n`);
const UH = { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };

// ── 0. ai_tier column exists, defaulted, readable by the user ─────────
const mt = await j(await fetch(`${URL_}/rest/v1/matterspaces?select=id,name,ai_tier&limit=1`, { headers: UH }));
const matter = Array.isArray(mt.body) ? mt.body[0] : null;
if (matter && 'ai_tier' in matter) pass(`matterspaces.ai_tier present (matter "${matter.name}" → tier ${matter.ai_tier})`);
else { fail('matterspaces.ai_tier missing or unreadable', mt.body); process.exit(1); }
if (matter.ai_tier === 'A') pass('existing matter defaulted to Tier A (no behavior change on rollout)');
else console.log(`  note  matter carries tier ${matter.ai_tier} (already re-tiered — fine)`);

// ── 1. INSERT .. RETURNING on ai_sessions (the 42501/047 bug class) ───
const ins = await j(await fetch(`${URL_}/rest/v1/ai_sessions?select=id,tier,title`, {
  method: 'POST',
  headers: { ...UH, Prefer: 'return=representation' },
  body: JSON.stringify({
    matterspace_id: matter.id,
    tier: matter.ai_tier,
    title: '[automated verification session — safe to delete]',
  }),
}));
const sessionId = Array.isArray(ins.body) ? ins.body[0]?.id : null;
if (sessionId) pass('INSERT .. RETURNING on ai_sessions (owner clause covers SELECT)');
else { fail('INSERT .. RETURNING on ai_sessions', ins.body); process.exit(1); }

// ── 2. messages: user row + assistant ledger row ──────────────────────
const msg1 = await j(await fetch(`${URL_}/rest/v1/ai_messages?select=id`, {
  method: 'POST',
  headers: { ...UH, Prefer: 'return=representation' },
  body: JSON.stringify({
    session_id: sessionId, seq: 1, role: 'user',
    content: [{ type: 'text', text: 'verification question' }],
  }),
}));
const msg2 = await j(await fetch(`${URL_}/rest/v1/ai_messages?select=id,model,estimated_cost`, {
  method: 'POST',
  headers: { ...UH, Prefer: 'return=representation' },
  body: JSON.stringify({
    session_id: sessionId, seq: 2, role: 'assistant',
    content: [{ type: 'text', text: 'verification answer' }],
    model: 'kimi-k3-us', provider: 'fireworks',
    input_tokens: 1000, output_tokens: 200, estimated_cost: 0.006, within_policy: true,
  }),
}));
if (msg1.body?.[0]?.id && msg2.body?.[0]?.id) pass('INSERT .. RETURNING on ai_messages (user + assistant ledger row)');
else fail('ai_messages inserts', { m1: msg1.body, m2: msg2.body });

// ── 3. the UI's SELECT: session with messages embedded, in order ──────
const read = await j(await fetch(
  `${URL_}/rest/v1/ai_sessions?select=${encodeURIComponent('id,title,tier,status,ai_messages(seq,role,model,provider,estimated_cost,within_policy)')}&id=eq.${sessionId}`,
  { headers: UH },
));
const row = Array.isArray(read.body) ? read.body[0] : null;
if (row && Array.isArray(row.ai_messages) && row.ai_messages.length === 2) {
  pass('session SELECT with messages embed resolves (2 rows)');
  const ledger = row.ai_messages.find((m) => m.role === 'assistant');
  if (ledger?.model === 'kimi-k3-us' && ledger?.within_policy === true) pass('  ledger fields round-trip (model, within_policy)');
  else fail('  ledger fields wrong', ledger);
} else fail('session embed SELECT', read.body);

// ── 4. constraints: tier CHECK and (session, seq) UNIQUE ──────────────
const badTier = await j(await fetch(`${URL_}/rest/v1/ai_sessions`, {
  method: 'POST', headers: UH,
  body: JSON.stringify({ matterspace_id: matter.id, tier: 'D', title: 'bad' }),
}));
if (badTier.status >= 400) pass('tier CHECK rejects unknown tier');
else fail('tier CHECK accepted tier D', badTier.body);

const dupSeq = await j(await fetch(`${URL_}/rest/v1/ai_messages`, {
  method: 'POST', headers: UH,
  body: JSON.stringify({ session_id: sessionId, seq: 2, role: 'user', content: [] }),
}));
if (dupSeq.status === 409) pass('(session, seq) UNIQUE rejects duplicate');
else fail('duplicate seq accepted', dupSeq.body);

// ── 5. owner update (rename — what the UI does on first exchange) ─────
const upd = await j(await fetch(`${URL_}/rest/v1/ai_sessions?id=eq.${sessionId}&select=title`, {
  method: 'PATCH',
  headers: { ...UH, Prefer: 'return=representation' },
  body: JSON.stringify({ title: '[renamed by verification]' }),
}));
if (upd.body?.[0]?.title === '[renamed by verification]') pass('owner UPDATE on session');
else fail('session update', upd.body);

// ── cleanup: delete session, cascade must take the messages ───────────
await fetch(`${URL_}/rest/v1/ai_sessions?id=eq.${sessionId}`, { method: 'DELETE', headers: UH });
const gone = await j(await fetch(`${URL_}/rest/v1/ai_sessions?select=id&id=eq.${sessionId}`, { headers: UH }));
const orphans = await j(await fetch(`${URL_}/rest/v1/ai_messages?select=id&session_id=eq.${sessionId}`, { headers: UH }));
if (gone.body?.length === 0 && orphans.body?.length === 0) pass('cleanup: session deleted, messages cascaded');
else fail('cleanup left rows', { gone: gone.body, orphans: orphans.body });

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);

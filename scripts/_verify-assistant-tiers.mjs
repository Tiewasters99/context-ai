// Live verification of the tier-aware in-app Assistant (/api/assistant):
// the pen follows the matter's tier, and every exchange lands in the ledger.
// Runs as the REAL user (magiclink JWT) against a running server —
//   node scripts/_verify-assistant-tiers.mjs http://localhost:5174/api/assistant
// (default: prod https://www.contextspaces.ai/api/assistant — only after
// the port deploys). Temporarily re-tiers ONE matter (service role) and
// RESTORES it; deletes the test sessions it created.
//
//   1. no token                      → 401
//   2. matter at tier A              → session event provider=anthropic; done
//   3. same matter sealed to B       → provider=fireworks (Kimi K3, US ZDR)
//   3b. B + escalate:true            → provider=anthropic, escalation=true
//   4. same matter as C              → error code silo_not_connected
//   5. ledger: ai_sessions rows with the right tier; ai_messages user +
//      assistant rows with model/provider/tokens; refusal recorded too
import fs from 'node:fs/promises';

const txt = await fs.readFile(new URL('../.env', import.meta.url), 'utf8');
const env = {};
for (const line of txt.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = env.VITE_SUPABASE_URL, SRK = env.SUPABASE_SERVICE_ROLE_KEY, ANON = env.VITE_SUPABASE_ANON_KEY;
const API = process.argv[2] || 'https://www.contextspaces.ai/api/assistant';
const SKIP_B = process.argv.includes('--skip-b'); // when no FIREWORKS key is configured on the target

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => { console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d).slice(0, 400)}` : ''}`); failures++; };
const j = async (res) => { const t = await res.text(); try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; } };
const H = { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' };

// ── sign in ───────────────────────────────────────────────────────────
let r = await j(await fetch(`${SB}/auth/v1/admin/generate_link`, {
  method: 'POST', headers: H, body: JSON.stringify({ type: 'magiclink', email: 'equainton@gmail.com' }),
}));
const th = r.body?.hashed_token ?? r.body?.properties?.hashed_token;
r = await j(await fetch(`${SB}/auth/v1/verify`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', token_hash: th }),
}));
const jwt = r.body?.access_token;
if (!jwt) { console.log('sign-in failed', r); process.exit(1); }
console.log(`signed in as ${r.body.user.email}`);

// Ask the assistant one tiny thing and collect the SSE events.
async function ask(matterId, text, extra = {}, token = jwt) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ messages: [{ role: 'user', content: text }], matterId, context: { route: '/verify' }, ...extra }),
  });
  if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
    return { status: res.status, events: [], body: await res.text().catch(() => '') };
  }
  const events = [];
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* skip */ } }
    }
  }
  return { status: res.status, events };
}
const ev = (events, type) => events.find((e) => e.type === type);
const textOf = (events) => events.filter((e) => e.type === 'text').map((e) => e.text).join('');

// ── 1. no token → 401 ─────────────────────────────────────────────────
let out = await ask(undefined, 'ping', {}, null);
if (out.status === 401) pass('unauthenticated request refused (401)'); else fail(`expected 401, got ${out.status}`, out.body);

// ── pick a matter ─────────────────────────────────────────────────────
const mt = await j(await fetch(`${SB}/rest/v1/matterspaces?select=id,name,ai_tier&limit=1`, { headers: H }));
const matter = mt.body?.[0];
if (!matter) { console.log('no matter found'); process.exit(1); }
const originalTier = matter.ai_tier;
console.log(`test matter: "${matter.name}" (tier ${originalTier})\n`);
const PROMPT = 'Reply with exactly the single word: ready. Do not use any tools.';
const sessions = [];
const setTier = (t) => fetch(`${SB}/rest/v1/matterspaces?id=eq.${matter.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ ai_tier: t }) });

try {
  // ── 2. tier A → Claude ──────────────────────────────────────────────
  await setTier('A');
  out = await ask(matter.id, PROMPT);
  let s = ev(out.events, 'session'), d = ev(out.events, 'done'), e = ev(out.events, 'error');
  if (s?.provider === 'anthropic' && s?.tier === 'A' && s?.sessionId) { pass(`tier A → ${s.model} (session ${s.sessionId.slice(0, 8)}…)`); sessions.push(s.sessionId); }
  else fail('tier A pen/session', { s, e });
  if (d && !e && textOf(out.events).trim()) pass(`tier A answered: "${textOf(out.events).trim().slice(0, 40)}" (${d.usage?.input}/${d.usage?.output} tok)`);
  else fail('tier A did not complete', { d, e, text: textOf(out.events) });

  // continue the same session
  if (s?.sessionId) {
    const out2 = await ask(matter.id, PROMPT, { sessionId: s.sessionId });
    const s2 = ev(out2.events, 'session');
    if (s2?.sessionId === s.sessionId) pass('follow-up continues the same session'); else fail('follow-up opened a new session', s2);
  }

  // ── 3. tier B → Fireworks/Kimi ──────────────────────────────────────
  await setTier('B');
  if (SKIP_B) {
    out = await ask(matter.id, PROMPT);
    s = ev(out.events, 'session'); e = ev(out.events, 'error');
    if (e?.code === 'sealed_pen_unavailable') pass('tier B without a sealed pen is REFUSED (no silent escalation)');
    else fail('tier B without key should refuse', { s, e });
    if (s?.sessionId) sessions.push(s.sessionId);
  } else {
    out = await ask(matter.id, PROMPT);
    s = ev(out.events, 'session'); d = ev(out.events, 'done'); e = ev(out.events, 'error');
    if (s?.provider === 'fireworks' && s?.tier === 'B' && s?.escalation === false) { pass(`tier B → ${s.model}`); sessions.push(s.sessionId); }
    else fail('tier B pen', { s, e });
    if (d && !e && textOf(out.events).trim()) pass(`tier B answered: "${textOf(out.events).trim().slice(0, 40)}" (${d.usage?.input}/${d.usage?.output} tok)`);
    else fail('tier B did not complete', { d, e, text: textOf(out.events).slice(0, 200) });
  }

  // ── 3b. tier B + escalate → Claude, recorded as escalation ──────────
  out = await ask(matter.id, PROMPT, { escalate: true });
  s = ev(out.events, 'session'); e = ev(out.events, 'error');
  if (s?.provider === 'anthropic' && s?.escalation === true) { pass('tier B + escalate:true → frontier pen, flagged as escalation'); sessions.push(s.sessionId); }
  else fail('escalation', { s, e });

  // ── 4. tier C → refused ─────────────────────────────────────────────
  await setTier('C');
  out = await ask(matter.id, PROMPT);
  s = ev(out.events, 'session'); e = ev(out.events, 'error');
  if (e?.code === 'silo_not_connected' && !s) pass('tier C refused before any pen (silo_not_connected)'); else fail('tier C', { s, e });
  if (!s) {
    // the refusal is still ledgered: find the newest session for this matter
    const ls = await j(await fetch(`${SB}/rest/v1/ai_sessions?matterspace_id=eq.${matter.id}&tier=eq.C&order=created_at.desc&limit=1&select=id,tier`, { headers: H }));
    if (ls.body?.[0]?.id) { sessions.push(ls.body[0].id); pass('tier C refusal opened a tier-C session (ledgered)'); }
    else fail('tier C refusal not ledgered');
  }

  // ── 5. ledger contents ──────────────────────────────────────────────
  for (const sid of sessions) {
    const ms = await j(await fetch(`${SB}/rest/v1/ai_messages?session_id=eq.${sid}&order=seq.asc&select=seq,role,model,provider,input_tokens,output_tokens,estimated_cost,within_policy,content`, { headers: H }));
    const rows = ms.body || [];
    const user = rows.find((x) => x.role === 'user'), asst = rows.filter((x) => x.role === 'assistant');
    if (user && asst.length) {
      const a = asst[asst.length - 1];
      const desc = a.content?.error ? `refusal ${a.content.error.code}` : `${a.provider}/${a.model} ${a.input_tokens}/${a.output_tokens} tok $${a.estimated_cost} policy=${a.within_policy}`;
      pass(`ledger ${sid.slice(0, 8)}…: ${rows.length} rows — ${desc}`);
    } else fail(`ledger ${sid.slice(0, 8)}… incomplete`, rows);
  }
} finally {
  await setTier(originalTier);
  const chk = await j(await fetch(`${SB}/rest/v1/matterspaces?id=eq.${matter.id}&select=ai_tier`, { headers: H }));
  console.log(`\nmatter restored to tier ${chk.body?.[0]?.ai_tier}`);
  for (const sid of sessions) {
    await fetch(`${SB}/rest/v1/ai_sessions?id=eq.${sid}`, { method: 'DELETE', headers: H });
  }
  console.log(`${sessions.length} test session(s) deleted (messages cascade)`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);

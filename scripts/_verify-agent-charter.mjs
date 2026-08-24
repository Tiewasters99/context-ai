// Verification for the Agents tab's run path.
//
//   node scripts/_verify-agent-charter.mjs                      # offline checks only
//   node scripts/_verify-agent-charter.mjs http://localhost:5179/api/assistant
//
// PART 1 (always, no network): the narrowing rule and the charter block.
//   A charter can only take tools away. This is the whole security story of
//   the toolset, so it is checked without a server in the loop.
//
// PART 2 (only with a URL): one real run under a BUILT-IN charter against a
// running server, signed in as the real user. Checks that the charter
// reaches the run, that the answer streams, and that the ledger row carries
// the charter id. Deletes the session it created, using the USER's own JWT
// (RLS: owners delete their sessions) — the service role is used for
// nothing but minting the sign-in link.
//
// The STORED-charter path (a uuid from agent_charters) cannot be verified
// against a database where migration 052 has not been applied; the script
// says so rather than pretending.

import fs from 'node:fs/promises';
import { ALLOWED_TOOLS } from '../lib/assistant-core.mjs';
import {
  BUILTIN_CHARTERS, loadCharter, narrowToolNames, buildCharterAppendix,
} from '../lib/agent-charter.mjs';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d).slice(0, 400)}` : ''}`);
  failures++;
};

// ── PART 1 — narrowing and the charter block ────────────────────────────
console.log('\nnarrowing');

{
  const asked = ['search', 'get_passage', 'file_document', 'create_deck', 'edit_pdf'];
  const got = narrowToolNames(asked, ALLOWED_TOOLS);
  if (got.includes('search') && got.includes('get_passage')
      && !got.includes('file_document') && !got.includes('create_deck') && !got.includes('edit_pdf')) {
    pass(`a charter asking for un-sanctioned tools gets only the sanctioned ones (${got.join(', ')})`);
  } else fail('narrowing let an un-sanctioned tool through', got);
}
{
  const got = narrowToolNames([], ALLOWED_TOOLS);
  if (got.length === 0) pass('an empty charter list grants nothing (no silent default)');
  else fail('an empty charter list granted tools', got);
}
{
  // Every tool in the product, asked for at once, still cannot exceed the ceiling.
  const { TOOLS } = await import('../lib/mcp-core.mjs');
  const got = narrowToolNames(TOOLS.map((t) => t.name), ALLOWED_TOOLS);
  if (got.length === ALLOWED_TOOLS.size && got.every((n) => ALLOWED_TOOLS.has(n))) {
    pass(`asking for all ${TOOLS.length} mcp tools yields at most the ${ALLOWED_TOOLS.size} the Orchestrator allows`);
  } else fail('narrowing exceeded the ceiling', got);
}
{
  const got = narrowToolNames(['search', 'search', 'nonsense_tool', 42, null], ALLOWED_TOOLS);
  if (got.length === 1 && got[0] === 'search') pass('duplicates, junk and non-strings are dropped');
  else fail('narrowing did not clean its input', got);
}

console.log('\ncharter loading');
{
  const never = { from() { throw new Error('the database must not be touched for a built-in charter'); } };
  const c = await loadCharter(never, 'builtin:ingestion');
  if (c && c.source === 'builtin' && c.name === BUILTIN_CHARTERS.ingestion.name) {
    pass(`builtin:ingestion resolves server-side to "${c.name}" without a query`);
  } else fail('builtin charter did not resolve', c);

  const missing = await loadCharter(never, 'builtin:does_not_exist');
  if (missing === null) pass('an unknown builtin key resolves to null (the run proceeds un-chartered)');
  else fail('unknown builtin key resolved', missing);

  const junk = await loadCharter(never, 'not-a-uuid; drop table');
  if (junk === null) pass('a non-uuid, non-builtin charter id never reaches the database');
  else fail('junk charter id was not rejected', junk);
}

console.log('\nthe charter block');
{
  const c = await loadCharter({}, 'builtin:docket_monitor');
  const tools = narrowToolNames(c.allowed_tools, ALLOWED_TOOLS);
  const block = buildCharterAppendix(c, tools);
  const checks = [
    [block.includes(c.name), 'names the agent'],
    [block.includes(c.purpose.slice(0, 40)), 'carries the purpose'],
    [block.includes(c.instructions.slice(0, 60)), 'carries the instructions verbatim'],
    [tools.every((t) => block.includes(t)), 'lists every tool in force'],
    [!block.includes('grep'), 'does not list a tool the charter did not ask for'],
  ];
  for (const [ok, what] of checks) {
    if (ok) pass(`the block ${what}`); else fail(`the block ${what}`, block.slice(0, 300));
  }
  const empty = buildCharterAppendix({ ...c, allowed_tools: [] }, []);
  if (/grants no tools/.test(empty)) pass('a toolless charter says so in the prompt, plainly');
  else fail('a toolless charter did not say so', empty.slice(-300));
}

// ── PART 2 — one live run ───────────────────────────────────────────────
const API = process.argv[2];
if (!API) {
  console.log('\n(no API url given — skipping the live run; pass e.g. http://localhost:5179/api/assistant)');
} else {
  const txt = await fs.readFile(new URL('../.env', import.meta.url), 'utf8');
  const env = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const SB = env.VITE_SUPABASE_URL, SRK = env.SUPABASE_SERVICE_ROLE_KEY, ANON = env.VITE_SUPABASE_ANON_KEY;
  const j = async (res) => {
    const t = await res.text();
    try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; }
  };

  console.log('\nlive run');
  let r = await j(await fetch(`${SB}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: 'equainton@gmail.com' }),
  }));
  const th = r.body?.hashed_token ?? r.body?.properties?.hashed_token;
  r = await j(await fetch(`${SB}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: th }),
  }));
  const jwt = r.body?.access_token;
  if (!jwt) { fail('sign-in failed', r.body); process.exit(1); }
  const U = { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };
  console.log(`  signed in as ${r.body.user.email}`);

  const mt = await j(await fetch(`${SB}/rest/v1/matterspaces?select=id,name&limit=1`, { headers: U }));
  const matter = mt.body?.[0];
  if (!matter) { fail('no matter visible to this user', mt.body); process.exit(1); }
  console.log(`  matter: "${matter.name}"`);

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      messages: [{
        role: 'user',
        content: 'In one short sentence, say which agent you are running as. Do not call any tools.',
      }],
      matterId: matter.id,
      charterId: 'builtin:ingestion',
      context: { route: '/app/agents' },
    }),
  });
  const events = [];
  if (res.ok && res.headers.get('content-type')?.includes('text/event-stream')) {
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
  } else {
    fail(`the endpoint did not stream (${res.status})`, await res.text().catch(() => ''));
  }

  const session = events.find((e) => e.type === 'session');
  const done = events.find((e) => e.type === 'done');
  const errEv = events.find((e) => e.type === 'error');
  const answer = events.filter((e) => e.type === 'text').map((e) => e.text).join('').trim();

  if (session?.charterId === 'builtin:ingestion') pass(`the session event names the charter ("${session.charterName}")`);
  else fail('the session event did not carry the charter', { session, errEv });
  if (answer) pass(`the answer streamed: "${answer.slice(0, 90)}"`);
  else fail('no answer streamed', { done, errEv });
  if (done?.charterId === 'builtin:ingestion') pass('the done event carries the charter id');
  else fail('the done event did not carry the charter id', done);

  const sid = session?.sessionId;
  if (sid) {
    const ms = await j(await fetch(
      `${SB}/rest/v1/ai_messages?session_id=eq.${sid}&order=seq.asc&select=seq,role,provider,model,content`,
      { headers: U },
    ));
    const rows = ms.body || [];
    const asst = rows.filter((x) => x.role === 'assistant').pop();
    if (asst?.content?.charter_id === 'builtin:ingestion') {
      pass(`the ledger row is attributable: seq ${asst.seq}, ${asst.provider}/${asst.model}, charter_id=${asst.content.charter_id}`);
    } else fail('the ledger row does not carry the charter id', rows.map((x) => ({ seq: x.seq, role: x.role, content: x.content })));

    // Clean up as the user, not the service role. Messages cascade.
    const del = await fetch(`${SB}/rest/v1/ai_sessions?id=eq.${sid}`, { method: 'DELETE', headers: U });
    console.log(`  test session ${sid.slice(0, 8)}… deleted (${del.status})`);
  }

  console.log('  NOT VERIFIED HERE: the stored-charter path (agent_charters uuid) — migration 052');
  console.log('  has not been applied to this database, so no charter row can exist to run.');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);

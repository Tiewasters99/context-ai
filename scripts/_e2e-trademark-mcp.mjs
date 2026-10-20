// Trademark Clearance, end to end, the way a bring-your-own bot reaches it:
// an MCP client over Streamable HTTP, sending a csp_ connector token as the
// bearer, against the REAL api/mcp.mjs handler on a local port.
//
// Eden's test sentence, "Run a knockout search with the Trademark Agent on
// Equazia on quallet, quiddit and quirld and report back", is played as the
// bot would play it: for each mark, tm_start_clearance → tm_propose /
// tm_confirm (classes, decomposition) → tm_generate_queries → the person
// "runs" each query and the bot records fixture rows (tm_record_results) →
// tm_triage → tm_report. Everything below the HTTP socket is the production
// code path: authenticate() (path A, connector_tokens), the user-scoped
// client, callTool's seal / pause gates, the connector meter
// (runMeteredToolCall), and the model through lib/llm-server-call.mjs
// serverLlmCall — gate, meter on the user's month, Record — down to the
// provider HTTP call, which is a stub Anthropic in this process.
//
// Offline: PGlite with the real migration 121 (scripts/_tm-connector-fixture.mjs),
// no real model, no USPTO, no network beyond 127.0.0.1.
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//   node scripts/_e2e-trademark-mcp.mjs

import {
  harness, makeDb, installFetch, makeToken, su, stubModel, FIXTURE_ROWS, Q7_ROWS,
  ADA, BOB, OPEN, SEALED, u,
} from './_tm-connector-fixture.mjs';
import http from 'node:http';

const { check, section, done } = harness();
const db = await makeDb();
const net = installFetch(db, { anthropic: stubModel });

const handler = (await import('../api/mcp.mjs')).default;
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

// Vercel hands the function a parsed JSON body; so does this server.
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw) { try { req.body = JSON.parse(raw); } catch { req.body = undefined; } }
  try { await handler(req, res); } catch (err) { res.statusCode = 500; res.end(String(err?.message || err)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const MCP_URL = new URL(`http://127.0.0.1:${server.address().port}/api/mcp`);

async function connect(token) {
  const client = new Client({ name: 'grok-bot-harness', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(MCP_URL, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}
const tool = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) return { ok: false, text };
  try { return { ok: true, out: JSON.parse(text), text }; } catch { return { ok: false, text }; }
};
const show = (r) => (r.ok ? JSON.stringify(r.out).slice(0, 300) : r.text.slice(0, 300));

const adaTok = await makeToken(db, ADA, { name: 'Grok bot' });
const bobTok = await makeToken(db, BOB, { name: 'Bob bot' });

// ===========================================================================
section('the door');
// ===========================================================================
{
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer csp_notarealtokenatall0000' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  check(res.status === 401 && /resource_metadata=/.test(res.headers.get('www-authenticate') ?? ''), 'an unknown csp_ token is refused 401 at the door', String(res.status));
}
const ada = await connect(adaTok.token);
{
  const { tools } = await ada.listTools();
  const names = tools.map((t) => t.name);
  const tm = ['tm_start_clearance', 'tm_get_clearance', 'tm_propose', 'tm_confirm', 'tm_generate_queries', 'tm_record_results', 'tm_triage', 'tm_report'];
  check(tm.every((n) => names.includes(n)) && names.includes('list_matters') && names.length === 35,
    'tools/list over Streamable HTTP: the eight tm_* tools beside the existing 27', `${names.length}`);
  const instr = ada.getInstructions() ?? '';
  check(/TRADEMARK CLEARANCE/.test(instr) && /tmsearch/.test(instr) && /never call a mark clear/.test(instr), 'the server instructions name the recipe and the human USPTO step');
}

// ===========================================================================
section('"Run a knockout search on quallet, quiddit and quirld and report back"');
// ===========================================================================
const results = {};
for (const MARK of ['QUALLET', 'QUIDDIT', 'QUIRLD']) {
  const s = await tool(ada, 'tm_start_clearance', { matter: 'eqz-tm', mark: MARK, goods_and_services: 'A mobile wallet app and payment services' });
  check(s.ok && s.out.clearance_id, `${MARK}: tm_start_clearance`, show(s));
  const id = s.out.clearance_id;
  const pc = await tool(ada, 'tm_propose', { clearance_id: id, step: 'classes' });
  const cc = pc.ok ? await tool(ada, 'tm_confirm', { clearance_id: id, step: 'classes', value: pc.out.proposal }) : pc;
  const pd = await tool(ada, 'tm_propose', { clearance_id: id, step: 'decompose' });
  const cd = pd.ok ? await tool(ada, 'tm_confirm', { clearance_id: id, step: 'decompose', value: pd.out.proposal }) : pd;
  check(pc.ok && cc.ok && pd.ok && cd.ok, `${MARK}: classes and decomposition proposed by the model and confirmed`, [pc, cc, pd, cd].map(show).join(' | '));
  const g = await tool(ada, 'tm_generate_queries', { clearance_id: id });
  check(g.ok && g.out.queries[0]?.query === 'SN:90562533', `${MARK}: ${g.out?.queries?.length ?? 0} queries generated, Q0 first`, show(g));
  // The person runs each one on tmsearch and reads back what it showed.
  let recorded = 0;
  for (const q of g.out?.queries ?? []) {
    const rows = q.purpose === 'selftest' ? FIXTURE_ROWS : q.purpose === 'prefix' ? Q7_ROWS : [];
    const reported = q.purpose === 'prefix' ? 3 : rows.length;
    const r = await tool(ada, 'tm_record_results', { clearance_id: id, query_id: q.query_id, reported_count: reported, rows });
    if (r.ok && r.out.run.captured_count === rows.length) recorded++;
  }
  check(recorded === g.out?.queries?.length, `${MARK}: every query's run recorded (${recorded})`);
  const before = await tool(ada, 'tm_get_clearance', { clearance_id: id });
  check(before.ok && before.out.self_test === 'passed' && /tm_triage/.test(before.out.next_step), `${MARK}: self-test passed; next step is triage`, show(before));
  const t = await tool(ada, 'tm_triage', { clearance_id: id });
  // Q0's record (EQUASITE) and Q7's two live ones; Q7's dead record is kept in the log, not scored.
  check(t.ok && t.out.proposed === 3 && t.out.hits.dead === 1, `${MARK}: three live hits proposed, the dead record kept and not scored`, show(t));
  const rep = await tool(ada, 'tm_report', { clearance_id: id });
  check(rep.ok && rep.out.status === 'DRAFT' && rep.out.reviewed === false && rep.out.lint.clean
    && rep.out.markdown.startsWith('> **DRAFT — NOT REVIEWED.**') && rep.out.markdown.includes(`# Trademark knockout report — ${MARK}`),
    `${MARK}: tm_report returns the DRAFT, lint clean`, show(rep));
  results[MARK] = { id, report: rep.out?.markdown ?? '' };
}

// ===========================================================================
section('what the server did underneath');
// ===========================================================================
{
  check(net.log.anthropic.length === 9, 'nine model calls reached the (stub) provider through serverLlmCall: classes, decompose, triage × 3', String(net.log.anthropic.length));
  check(net.log.anthropic.every((b) => b.model === 'claude-opus-5-5'), 'all on the recipe\'s model constant');
  const usage = await su(db, `select p_user, p_kind from public.usage_calls`);
  check(usage.length === 9 && usage.every((x) => x.p_user === ADA && x.p_kind === 'llm'), 'each was metered on the token user\'s own month (usage_consume, kind llm)');
  const comp = await su(db, `select actor_kind, actor_ref, matter_id, payload->>'feature' f from public.events where kind in ('completion.requested', 'completion.received')`);
  check(comp.length === 18 && comp.every((e) => e.actor_kind === 'connector' && e.actor_ref === `token:${adaTok.id}` && e.matter_id === OPEN),
    'completion.requested / received: 18 rows, the connector\'s, in the matter', JSON.stringify(comp.slice(0, 1)));
  const tmEv = await su(db, `select count(*)::int n, count(*) filter (where actor_kind = 'connector' and actor_ref = $1)::int c from public.events where kind like 'tm.%'`, [`token:${adaTok.id}`]);
  check(tmEv[0].n > 0 && tmEv[0].n === tmEv[0].c, `every tm.* row (${tmEv[0].n}) is the connector's`);
  const st = await su(db, `select count(*)::int n from public.tm_stages s join public.tm_clearances c on c.id = s.clearance_id where c.mark in ('QUALLET','QUIDDIT','QUIRLD') and s.status <> 'pending'`);
  const bins = await su(db, `select count(*)::int n from public.tm_hits h join public.tm_clearances c on c.id = h.clearance_id where h.bin is not null`);
  check(st[0].n === 0 && bins[0].n === 0, 'no stage signed and no bin decided: the reviewer does that in Equazia.ai');
  const rate = await su(db, `select count(*)::int n, count(*) filter (where p_user = $1)::int a from public.rate_calls`, [ADA]);
  check(rate[0].n > 30 && rate[0].n === rate[0].a, `every tool call went through the connector meter's rate ceiling, on the token user (${rate[0].n} calls)`);
  check(net.log.refusedOutbound.length === 0, 'no call left for anywhere but the stub Supabase and the stub model (never tmsearch)', net.log.refusedOutbound.join(' '));
}

// ===========================================================================
section('isolation and the seal, over HTTP');
// ===========================================================================
{
  const bob = await connect(bobTok.token);
  const g = await tool(bob, 'tm_get_clearance', { clearance_id: results.QUALLET.id });
  check(!g.ok && /could not be found/.test(g.text), 'Bob\'s token: Ada\'s clearance is not found', g.text);
  const s = await tool(bob, 'tm_start_clearance', { matter: 'eqz-tm', mark: 'QUALLET', goods_and_services: 'x' });
  check(!s.ok, 'and her matter cannot take his clearance', s.text);
  await bob.close();

  const sealedCl = u();
  await su(db, `insert into public.tm_clearances (id, matterspace_id, mark, created_by) values ($1, $2, 'QUIRLD', $3)`, [sealedCl, SEALED, ADA]);
  const n = net.log.anthropic.length;
  const sp = await tool(ada, 'tm_propose', { clearance_id: sealedCl, step: 'classes' });
  check(!sp.ok && /sealed matter \(SecureSpace\)/.test(sp.text) && net.log.anthropic.length === n,
    'a clearance in a sealed matter: refused with the seal\'s sentence, no model call', sp.text);
  const ss = await tool(ada, 'tm_start_clearance', { matter: 'sealed-tm', mark: 'QUIRLD', goods_and_services: 'x' });
  check(!ss.ok && /sealed matter/.test(ss.text), 'and a new clearance there is refused too', ss.text);
}

await ada.close();
await new Promise((r) => server.close(r));
net.restore();

if (process.env.SHOW_REPORT) console.log(`\n${results.QUALLET.report}`);
done();

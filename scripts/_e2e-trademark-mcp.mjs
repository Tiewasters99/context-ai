// Trademark Clearance, end to end, the way a bring-your-own bot reaches it:
// an MCP client over Streamable HTTP, sending a csp_ connector token as the
// bearer, against the REAL api/mcp.mjs handler on a local port.
//
// Eden's test sentence, "Run a knockout search with the Trademark Agent on
// Equazia on quallet, quiddit and quirld and report back", is played as the
// bot would play it (slice 2, 2026-10-21): ONE tm_start_batch for the three
// marks (clearances opened, classes and decompositions PROPOSED) → per mark
// tm_confirm step "proposals" (queries generated) → the person "runs" each
// query and the bot records fixture rows (tm_record_results) → tm_triage →
// tm_deep_check against a STUBBED TSDR (never the real one) → tm_report →
// tm_application_questions / tm_application_answer / tm_application_draft:
// QUIDDIT use-based (Section 1(a), with a specimen), QUALLET and QUIRLD
// intent-to-use (Section 1(b)). The drafts are filed through the REAL
// file_document (its embedding provider answers 503 here, which it survives
// as it is built to). Everything below the HTTP socket is the production
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
// The server's env, as Vercel would set it: a TSDR key (stub TSDR below) and an
// OpenAI key for file_document's embedding (the stub provider answers 503).
process.env.USPTO_TSDR_API_KEY = 'e2e-stub-tsdr-key';
process.env.OPENAI_API_KEY = 'e2e-stub-openai-key';
const tsdrCalls = [];
const stubTsdr = (url, init) => {
  const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
  tsdrCalls.push({ ids, key: init?.headers?.['USPTO-API-KEY'] ?? init?.headers?.get?.('USPTO-API-KEY') });
  const body = { transactionList: [{ trademarks: ids.map((s) => ({
    status: { serialNumber: Number(s), markElement: s === '97333333' ? 'QUALLEX' : `REC ${s}`, status: s === '90562533' ? 800 : 630,
      tm5StatusDesc: s === '90562533' ? 'LIVE/REGISTRATION/Issued and Active' : 'LIVE/APPLICATION/Under Examination',
      filingDate: '2021-01-01', usRegistrationNumber: s === '90562533' ? '6900001' : null },
    parties: { currentOwners: [{ name: 'Some Owner LLC' }] },
    gsList: [{ description: 'Software', internationalClasses: [{ code: '42' }] }],
    prosecutionHistory: [{ entryDate: '2021-01-01', entryCode: 'NWAP', entryDesc: 'NEW APPLICATION ENTERED' }],
  })) }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
const storage = new Map();
const net = installFetch(db, { anthropic: stubModel, tsdr: stubTsdr, openaiDown: true, storage });

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
  const tm = ['tm_start_clearance', 'tm_get_clearance', 'tm_propose', 'tm_confirm', 'tm_generate_queries', 'tm_record_results', 'tm_triage', 'tm_report',
    'tm_start_batch', 'tm_deep_check', 'tm_application_questions', 'tm_application_answer', 'tm_application_draft'];
  check(tm.every((n) => names.includes(n)) && names.includes('list_matters') && names.length === 40,
    'tools/list over Streamable HTTP: the thirteen tm_* tools beside the existing 27', `${names.length}`);
  const instr = ada.getInstructions() ?? '';
  check(/TRADEMARK CLEARANCE/.test(instr) && /tmsearch/.test(instr) && /never call a mark clear/.test(instr), 'the server instructions name the recipe and the human USPTO step');
}

// ===========================================================================
section('"Run a knockout search on quallet, quiddit and quirld and report back"');
// ===========================================================================
const results = {};
const batch = await tool(ada, 'tm_start_batch', {
  matter: 'eqz-tm', marks: ['QUALLET', 'QUIDDIT', 'QUIRLD'], goods_and_services: 'A mobile wallet app and payment services',
  applicant: { legal_name: 'Grapheon.ai, LLC', entity_type: 'limited liability company', state: 'New Jersey' },
});
check(batch.ok && batch.out.clearances.length === 3 && batch.out.clearances.every((x) => x.status === 'PROPOSED'),
  'ONE tm_start_batch call: three clearances, each run to its first human step (classes and decomposition PROPOSED)', show(batch));
const idOf = Object.fromEntries((batch.out?.clearances ?? []).map((x) => [x.mark, x.clearance_id]));
for (const MARK of ['QUALLET', 'QUIDDIT', 'QUIRLD']) {
  const id = idOf[MARK];
  const g0 = await tool(ada, 'tm_get_clearance', { clearance_id: id });
  check(g0.ok && /step "proposals"/.test(g0.out.next_step), `${MARK}: next_step — show the proposals, tm_confirm step "proposals"`, g0.out?.next_step);
  const g = await tool(ada, 'tm_confirm', { clearance_id: id, step: 'proposals' });
  check(g.ok && g.out.status === 'CONFIRMED' && g.out.queries[0]?.query === 'SN:90562533', `${MARK}: the person accepts; ${g.out?.queries?.length ?? 0} queries generated, Q0 first`, show(g));
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
  const afterTriage = await tool(ada, 'tm_get_clearance', { clearance_id: id });
  check(afterTriage.ok && /tm_deep_check/.test(afterTriage.out.next_step), `${MARK}: next_step — tm_deep_check`, afterTriage.out?.next_step);
  const dc = await tool(ada, 'tm_deep_check', { clearance_id: id });
  check(dc.ok && dc.out.configured === true && dc.out.checked === dc.out.targets && dc.out.checked > 0 && dc.out.remaining === 0
    && dc.out.results.every((r) => r.ok && r.document_id), `${MARK}: tm_deep_check — ${dc.out?.checked ?? 0} official status(es) fetched (stub TSDR) and filed`, show(dc));
  const rep = await tool(ada, 'tm_report', { clearance_id: id });
  check(rep.ok && rep.out.status === 'DRAFT' && rep.out.reviewed === false && rep.out.lint.clean
    && rep.out.markdown.startsWith('> **DRAFT — NOT REVIEWED.**') && rep.out.markdown.includes(`# Trademark knockout report — ${MARK}`),
    `${MARK}: tm_report returns the DRAFT, lint clean`, show(rep));
  const nx = await tool(ada, 'tm_get_clearance', { clearance_id: id });
  check(nx.ok && /tm_application_questions/.test(nx.out.next_step), `${MARK}: next_step — the report, then tm_application_questions`, nx.out?.next_step);

  // The application: the bot asks, the person answers, the bot relays.
  const q = await tool(ada, 'tm_application_questions', { clearance_id: id });
  check(q.ok && q.out.questions.some((x) => x.id === 'classes.009.in_use'), `${MARK}: tm_application_questions asks whether the mark is in use`, show(q));
  const useBased = MARK === 'QUIDDIT';
  let specimen = null;
  if (useBased) {
    specimen = u();
    await su(db, 'insert into public.documents (id, matterspace_id, title, source_filename, storage_path) values ($1, $2, $3, $4, $5)',
      [specimen, OPEN, 'QUIDDIT store page', 'quiddit-store-page.png', `${OPEN}/quiddit-store-page.png`]);
  }
  const a = await tool(ada, 'tm_application_answer', {
    clearance_id: id,
    applicant: { formation_status: 'formed', formation_date: '2024-02-01', domicile_address: '1 Example Street, Princeton, NJ 08540', address_is_mail_drop: 'no', email: 'tm@example.com' },
    classes: [useBased
      ? { code: '009', identification: 'Downloadable software for making payments', id_source: 'id_manual', in_use: true, basis: '1a',
        first_use_anywhere: '2026-03-01', first_use_in_commerce: '2026-04-01',
        specimen: { document_id: specimen, kind: 'webpage', description: 'App store page showing QUIDDIT beside the app with its price and Get button',
          url: 'https://example.com/quiddit', access_date: '2026-10-20', shows_mark: 'yes', mark_as_brand: 'yes', goods_sold: 'yes', means_of_ordering: 'yes', mockup: 'no' } }
      : { code: '009', identification: 'Downloadable mobile application software for making payments', id_source: 'free_form', in_use: false, basis: '1b',
        intent_evidence: [{ date: '2026-09-15', description: 'Dated product plan for the app' }] }],
    transfer: { planned: 'no' },
  });
  check(a.ok && a.out.blocking === 0, `${MARK}: the person's answers recorded (${useBased ? 'in use: dates and a specimen' : 'not in use: bona fide intent evidence'})`, show(a));
  const d = await tool(ada, 'tm_application_draft', { clearance_id: id });
  check(d.ok && d.out.status === 'DRAFT' && d.out.filed_in_matter === true && d.out.filed_with_uspto === false && d.out.lint.clean
    && d.out.bases['009'] === (useBased ? '1a' : '1b') && d.out.draft_markdown.startsWith('> **DRAFT — NOT REVIEWED.**'),
    `${MARK}: tm_application_draft — ${useBased ? 'use-based, Section 1(a)' : 'intent-to-use, Section 1(b)'}, filed in the matter as a DRAFT`, show(d));
  const docs = await su(db, 'select id, source_filename, storage_path from public.documents where id = any($1::uuid[])', [`{${[d.out?.document_id, d.out?.annex_document_id].filter(Boolean).join(',')}}`]);
  check(docs.length === 2 && docs.every((x) => x.storage_path && storage.has(x.storage_path)), `${MARK}: the draft and its annex are real documents with stored bytes (file_document)`, JSON.stringify(docs.map((x) => x.source_filename)));
  const fin = await tool(ada, 'tm_get_clearance', { clearance_id: id });
  check(fin.ok && /signs stage 9 off in Equazia\.ai/.test(fin.out.next_step), `${MARK}: next_step — the reviewer signs stage 9 in Equazia.ai`, fin.out?.next_step);
  results[MARK] = { id, report: rep.out?.markdown ?? '', draft: d.out?.draft_markdown ?? '' };
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
  const st = await su(db, `select count(*)::int n from public.tm_stages s join public.tm_clearances c on c.id = s.clearance_id where c.mark in ('QUALLET','QUIDDIT','QUIRLD') and (s.status in ('done', 'skipped') or s.initials is not null)`);
  const bins = await su(db, `select count(*)::int n from public.tm_hits h join public.tm_clearances c on c.id = h.clearance_id where h.bin is not null`);
  check(st[0].n === 0 && bins[0].n === 0, 'no stage signed and no bin decided: the reviewer does that in Equazia.ai');
  const rate = await su(db, `select count(*)::int n, count(*) filter (where p_user = $1)::int a from public.rate_calls`, [ADA]);
  check(rate[0].n > 30 && rate[0].n === rate[0].a, `every tool call went through the connector meter's rate ceiling, on the token user (${rate[0].n} calls)`);
  check(tsdrCalls.length === 3 && tsdrCalls.every((c) => c.key === 'e2e-stub-tsdr-key'), 'TSDR (the stub): one caseMultiStatus request per clearance, the key from the server env in USPTO-API-KEY', JSON.stringify(tsdrCalls));
  const leaked = await su(db, `select count(*)::int n from public.events where payload::text like '%e2e-stub-tsdr-key%'`);
  check(leaked[0].n === 0 && ![...storage.values()].some((b) => new TextDecoder().decode(b).includes('e2e-stub-tsdr-key')), 'the TSDR key is in no Record row and no filed document');
  const s9 = await su(db, `select count(*)::int n from public.tm_stages s join public.tm_clearances c on c.id = s.clearance_id where s.stage = 9 and s.status = 'awaiting_review' and s.initials is null`);
  check(s9[0].n === 3, 'stage 9 on all three: awaiting review, unsigned — the reviewer signs in Equazia.ai');
  const kinds = await su(db, `select kind, count(*)::int n, count(*) filter (where actor_kind = 'connector')::int c from public.events where kind like 'tm.%' group by kind order by kind`);
  check(['tm.proposal.saved', 'tm.hit.status', 'tm.deep_check.run', 'tm.application.answered', 'tm.application.drafted'].every((k) => kinds.some((x) => x.kind === k)) && kinds.every((x) => x.n === x.c),
    'the slice-2 Record rows, every one the connector\'s', kinds.map((x) => `${x.kind}:${x.n}`).join(' '));
  check(net.log.refusedOutbound.length === 0, 'no call left for anywhere but the stub Supabase, the stub model and the stub TSDR (never tmsearch, never the real TSDR)', net.log.refusedOutbound.join(' '));
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
if (process.env.SHOW_DRAFT) console.log(`\n${results.QUIDDIT.draft}\n\n${results.QUALLET.draft}`);
done();

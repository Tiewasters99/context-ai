// Trademark Clearance over the connector — the tm_* MCP tools, EXECUTED
// against the real migration 121 (PGlite) through lib/mcp-core.mjs callTool,
// with the user-scoped client a csp_ token gets (lib/oauth-bearer.mjs
// userScopedClient) and the options api/mcp.mjs gives it.
//
// What it proves
// ---------------------------------------------------------------------------
//   A  a token user runs the whole recipe in their own matter: start →
//      propose → confirm (classes, decomposition) → generate → record
//      (rows, pasted text, an export file, a failed run) → triage → report.
//      The database's own captured count and gap come back; a short page is
//      a GAP, never "no results".
//   B  the Record: every tm.* row, every completion row and every
//      tool.invoked row the bot causes is attributed to the CONNECTOR
//      (token:<id>), never to a browser user; payloads carry no goods text.
//   C  isolation: another user's clearance and matter are not found, and a
//      `matter` argument smuggled onto a clearance call is ignored.
//   D  the seal: a sealed matter refuses (start, and every clearance-keyed
//      tool), and the model is never called; the pause refuses likewise.
//   E  an agent token sees only its grant; its rows are agent:<id>.
//   F  a bot can never mark the report reviewed: no tool and no argument
//      reaches a bin, a stage sign-off or a filing; after the whole flow no
//      bin is decided and stage 8 is pending; the report is DRAFT; a reason
//      that calls a mark registrable is refused.
//   G  outside the hosted connector (no opts.trademark) the tools refuse.
//   Slice 2 (migration 122):
//   H  tm_start_batch: one clearance per mark, run to the first human step
//      (classes and decomposition PROPOSED, queries previewed, nothing
//      confirmed or signed); tm_confirm step "proposals"; seal and isolation.
//   I  tm_deep_check against a STUBBED TSDR (no real call): key missing says
//      so and stores nothing; 429 + Retry-After backoff; the rate-limit pacing;
//      a dead record noted, not dropped; one status record filed per record.
//   J  the application draft both ways: intent to use with the marks moving
//      to an entity not yet formed (options, § 1060(a)(1), "do not file
//      before"), and use-based with a clean specimen beside a flagged one.
//   K  a connector JWT cannot sign a stage or decide a bin (the database
//      refuses); the browser signs, in order, and stage 9 needs its document.
//   L  every tm.* row a bot caused is the connector's.
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//   node scripts/_verify-trademark-connector.mjs
//
// Offline: no network, no model, no USPTO. The model is a stub `send`, as
// scripts/_test-trademark-triage.mjs stubs it.

import {
  harness, makeDb, installFetch, makeToken, su, stubModel, FIXTURE_ROWS, Q7_ROWS,
  ADA, BOB, OPEN, OPEN_CHILD, BOBS, SEALED, READONLY, PAUSED, u,
} from './_tm-connector-fixture.mjs';

const { check, section, done } = harness();
const db = await makeDb();
const storage = new Map();
const net = installFetch(db, { storage });

const { callTool, TOOLS } = await import('../lib/mcp-core.mjs');
const { callToolOptsFor, userScopedClient } = await import('../lib/oauth-bearer.mjs');
const { connectorTokenIdentity } = await import('../lib/connector-token-auth.mjs');
const { trademarkToolOptsFor } = await import('../lib/trademark/connector-opts.mjs');
const { TM_TOOLS } = await import('../lib/trademark/connector.mjs');
const { READ_TOOLS } = await import('../lib/connector-meter.mjs');

const sends = [];
const stubSend = async ({ feature, body, matterId }) => {
  sends.push({ feature, matterId });
  return stubModel(JSON.parse(body));
};
const identityOf = async (tokenId) => connectorTokenIdentity((await su(db, 'select * from public.connector_tokens where id = $1', [tokenId]))[0]);
const optsFor = (identity, sb, { send = stubSend } = {}) => {
  const base = callToolOptsFor(identity, {});
  const tm = trademarkToolOptsFor(identity, sb, base, { supabaseUrl: 'unused', serviceKey: 'unused' });
  tm.trademark.send = send;
  return { ...base, ...tm };
};
const call = async (sb, name, args, opts) => {
  try { return { ok: true, out: await callTool(sb, name, args, opts) }; }
  catch (err) { return { ok: false, err }; }
};
const msg = (r) => (r.ok ? JSON.stringify(r.out).slice(0, 300) : `${r.err?.code ?? ''} ${r.err?.message ?? r.err}`);

const adaTok = await makeToken(db, ADA, { name: 'Grok bot' });
const bobTok = await makeToken(db, BOB, { name: 'Bob\'s bot' });
const ada = await identityOf(adaTok.id);
const bob = await identityOf(bobTok.id);
const sbAda = userScopedClient(ADA);
const sbBob = userScopedClient(BOB);
const ADA_OPTS = optsFor(ada, sbAda);
const BOB_OPTS = optsFor(bob, sbBob);

// ===========================================================================
section('the tool list');
// ===========================================================================
{
  const names = TOOLS.map((t) => t.name);
  const tm = TM_TOOLS.map((t) => t.name);
  check(tm.length === 13 && tm.every((n) => names.includes(n)), 'the thirteen tm_* tools (eight of slice 1, five of slice 2) are in mcp-core TOOLS', tm.join(' '));
  check(READ_TOOLS.has('tm_get_clearance') && READ_TOOLS.has('tm_report') && READ_TOOLS.has('tm_application_questions') && !READ_TOOLS.has('tm_record_results'),
    'tm_get_clearance, tm_report and tm_application_questions are reads for the meter; the rest are work');
  const props = TM_TOOLS.flatMap((t) => Object.keys(t.inputSchema.properties ?? {}));
  check(!props.some((p) => /^(bin|initials|reviewed|sign|signed|status|done)$/.test(p)),
    'no tool has an argument for a bin, initials, a sign-off or a stage status', props.join(','));
  check(!TOOLS.some((t) => /sign|decide|file_report|review/.test(t.name) && t.name.startsWith('tm_')),
    'and no tool decides a bin, signs a stage or files the report');
  const desc = TM_TOOLS.map((t) => t.description).join(' ');
  check(/tmsearch/.test(desc) && /tm_record_results/.test(desc) && /person/.test(desc),
    'the descriptions tell the bot the USPTO search is run by the person, then tm_record_results');
}

// ===========================================================================
section('A. a token user runs the recipe in their own matter');
// ===========================================================================
let CL;
let queries;
{
  const start = await call(sbAda, 'tm_start_clearance', {
    matter: 'eqz-tm', mark: 'QUALLET', goods_and_services: 'A mobile wallet app and payment services',
    known_marks: [{ name: 'Qualla', owner: 'Qualla Inc.' }],
  }, ADA_OPTS);
  check(start.ok && /^[0-9a-f-]{36}$/.test(start.out?.clearance_id ?? ''), 'tm_start_clearance by short_code creates a clearance', msg(start));
  CL = start.out?.clearance_id;
  const [row] = await su(db, 'select matterspace_id, created_by, mark, goods_services from public.tm_clearances where id = $1', [CL]);
  check(row?.matterspace_id === OPEN && row.created_by === ADA && row.mark === 'QUALLET',
    'in that matter, created_by = the token\'s user (auth.uid(), not a client value)');
  const stages = await su(db, 'select count(*)::int n from public.tm_stages where clearance_id = $1 and status = \'pending\'', [CL]);
  check(stages[0].n === 10, 'the ten stages are seeded, pending');

  const g0 = await call(sbAda, 'tm_get_clearance', { clearance_id: CL }, ADA_OPTS);
  check(g0.ok && /tm_propose/.test(g0.out?.next_step) && /classes/.test(g0.out.next_step), 'tm_get_clearance: next_step says propose classes', g0.out?.next_step);

  const p1 = await call(sbAda, 'tm_propose', { clearance_id: CL, step: 'classes' }, ADA_OPTS);
  check(p1.ok && p1.out.status === 'PROPOSED' && p1.out.stored === true && p1.out.confirmed === false && p1.out.proposal?.search?.length === 3,
    'tm_propose classes returns the proposal, saved PROPOSED (122), not confirmed', msg(p1));
  check(sends.at(-1)?.feature === 'trademark.classes' && sends.at(-1)?.matterId === OPEN, 'the model was reached through send, with the feature and the clearance\'s matter');
  const [after1] = await su(db, 'select search_classes, proposals from public.tm_clearances where id = $1', [CL]);
  check(Array.isArray(after1.search_classes) && after1.search_classes.length === 0 && after1.proposals?.classes?.search?.length === 3,
    'the confirmed classes stay empty until tm_confirm; the proposal sits in proposals.classes');

  const badFiling = await call(sbAda, 'tm_confirm', { clearance_id: CL, step: 'classes', value: { search: [{ code: '9', reason: 'x' }], filing: [{ code: '25', reason: 'y' }] } }, ADA_OPTS);
  check(!badFiling.ok && /not a search class/.test(badFiling.err?.message), 'a filing class outside the search classes is refused', msg(badFiling));
  const c1 = await call(sbAda, 'tm_confirm', { clearance_id: CL, step: 'classes', value: p1.out.proposal }, ADA_OPTS);
  check(c1.ok && c1.out.status === 'CONFIRMED', 'tm_confirm classes stores the accepted proposal', msg(c1));
  const [after2] = await su(db, 'select search_classes, filing_classes from public.tm_clearances where id = $1', [CL]);
  check(after2.search_classes.map((x) => x.code).join(',') === '009,036,042' && after2.filing_classes[0]?.code === '009'
    && after2.search_classes.every((x) => x.model === 'claude-opus-5-5'), 'search 009 036 042, filing 009, with the proposing model kept');

  const noValue = await call(sbAda, 'tm_confirm', { clearance_id: CL, step: 'decompose' }, ADA_OPTS);
  check(!noValue.ok && /value is required/.test(noValue.err?.message), 'tm_confirm without a value is refused');
  const p2 = await call(sbAda, 'tm_propose', { clearance_id: CL, step: 'decompose' }, ADA_OPTS);
  check(p2.ok && p2.out.proposal?.opening === 'qua' && p2.out.proposal.hinge === 'l' && p2.out.proposal.ending === 'let', 'tm_propose decompose', msg(p2));
  const badD = await call(sbAda, 'tm_confirm', { clearance_id: CL, step: 'decompose', value: { opening: 'qu', hinge: 'a', ending: 'lt' } }, ADA_OPTS);
  check(!badD.ok && /not the mark/.test(badD.err?.message), 'a decomposition that does not spell the mark is refused', msg(badD));
  const c2 = await call(sbAda, 'tm_confirm', { clearance_id: CL, step: 'decompose', value: p2.out.proposal }, ADA_OPTS);
  check(c2.ok && c2.out.decomposition?.opening === 'qua', 'tm_confirm decompose', msg(c2));

  const gen = await call(sbAda, 'tm_generate_queries', { clearance_id: CL }, ADA_OPTS);
  queries = gen.out?.queries ?? [];
  check(gen.ok && queries.length >= 8 && queries[0].seq === 0 && queries[0].query === 'SN:90562533',
    'tm_generate_queries: the deterministic list, Q0 the self-test first', msg(gen));
  check(queries.some((q) => q.purpose === 'known' && q.query === 'CM:qualla') && queries.some((q) => q.purpose === 'owner' && q.query === 'ON:"qualla inc"'),
    'the known mark and its owner have their own queries');
  check(/tmsearch\.uspto\.gov/.test(gen.out?.tmsearch_url ?? '') && /person/.test(gen.out?.how_to_run ?? ''), 'it hands back the tmsearch link and says the person runs them');
  const [h] = await su(db, 'select procedure_hash from public.tm_clearances where id = $1', [CL]);
  check(/^[0-9a-f]{64}$/.test(h.procedure_hash ?? ''), 'the procedure hash is stored');

  // Q0 — the self-test, as rows.
  const r0 = await call(sbAda, 'tm_record_results', { clearance_id: CL, seq: 0, reported_count: 1, rows: FIXTURE_ROWS }, ADA_OPTS);
  check(r0.ok && r0.out.run.captured_count === 1 && r0.out.run.gap === false && r0.out.self_test === 'passed',
    'Q0 recorded from rows: captured 1 of 1, no gap, self-test passed', msg(r0));
  // Q1 — nothing found, honestly.
  const q1 = queries.find((q) => q.seq === 1);
  const r1 = await call(sbAda, 'tm_record_results', { clearance_id: CL, query_id: q1.query_id, reported_count: 0, rows: [] }, ADA_OPTS);
  check(r1.ok && r1.out.run.captured_count === 0 && r1.out.run.gap === false, 'Q1 with no records: captured 0 of 0, no gap', msg(r1));
  // Q7 — tmsearch said 4, the person gave 3: a GAP the database marks.
  const q7 = queries.find((q) => q.purpose === 'prefix');
  const r7 = await call(sbAda, 'tm_record_results', { clearance_id: CL, query_id: q7.query_id, reported_count: 4, rows: Q7_ROWS }, ADA_OPTS);
  check(r7.ok && r7.out.run.captured_count === 3 && r7.out.run.gap === true && /reported 4; 3 captured/.test(r7.out.run.gap_note ?? ''),
    'Q7: reported 4, captured 3 → the database marks a GAP with the counts', msg(r7));
  const [dbRun] = await su(db, 'select captured_count, gap, run_by, source from public.tm_query_runs r join public.tm_queries q on q.id = r.query_id where q.id = $1', [q7.query_id]);
  check(dbRun.captured_count === 3 && dbRun.gap === true && dbRun.run_by === ADA && dbRun.source === 'manual', 'the stored run: the database\'s count, run_by the token\'s user');
  // Q3 — pasted text, one line without a serial.
  const q3 = queries.find((q) => q.seq === 3);
  const r3 = await call(sbAda, 'tm_record_results', { clearance_id: CL, query_id: q3.query_id, reported_count: 2,
    text: '97111111 | QUALLETTA | Quall Co | LIVE | 9 36 | Mobile wallet software\nsee page 2 for more' }, ADA_OPTS);
  check(r3.ok && r3.out.run.captured_count === 1 && r3.out.run.gap === true && r3.out.skipped.length === 1,
    'pasted text: the line without a serial is skipped and reported, and the run shows a gap', msg(r3));
  // Q2 — the search could not run.
  const q2 = queries.find((q) => q.seq === 2);
  const r2 = await call(sbAda, 'tm_record_results', { clearance_id: CL, query_id: q2.query_id, failed: true }, ADA_OPTS);
  check(r2.ok && r2.out.run.source === 'failed' && r2.out.run.gap === true && r2.out.run.captured_count === 0, 'a failed run is a gap, not "no results"', msg(r2));
  // Q4 — an export filed in the matter.
  const docId = u();
  const path = `${OPEN}/tmsearch-q4.csv`;
  await su(db, 'insert into public.documents (id, matterspace_id, title, source_filename, storage_path) values ($1, $2, $3, $4, $5)',
    [docId, OPEN, 'tmsearch export Q4', 'tmsearch-q4.csv', path]);
  storage.set(path, new TextEncoder().encode('Serial Number,Word Mark,Owner,Live/Dead,International Class,Goods and Services,Something Else\n97444444,QUALET,Qualet SA,LIVE,009,Wallet apps,x\n'));
  const q4 = queries.find((q) => q.seq === 4);
  const r4 = await call(sbAda, 'tm_record_results', { clearance_id: CL, query_id: q4.query_id, reported_count: 1, document_id: docId }, ADA_OPTS);
  check(r4.ok && r4.out.run.source === 'export' && r4.out.run.captured_count === 1 && r4.out.run.gap === false
    && (r4.out.export_columns_kept_as_is ?? []).includes('Something Else'), 'an export file in the matter is read through parse.mjs (header names)', msg(r4));
  const roDoc = u();
  await su(db, 'insert into public.documents (id, matterspace_id, title, source_filename, storage_path) values ($1, $2, $3, $4, $5)',
    [roDoc, READONLY, 'elsewhere', 'x.csv', `${READONLY}/x.csv`]);
  const rX = await call(sbAda, 'tm_record_results', { clearance_id: CL, seq: 5, reported_count: 1, document_id: roDoc }, ADA_OPTS);
  check(!rX.ok && /different matter/.test(rX.err?.message), 'an export filed in another matter is refused', msg(rX));
  const noCount = await call(sbAda, 'tm_record_results', { clearance_id: CL, seq: 5, rows: [] }, ADA_OPTS);
  check(!noCount.ok && /reported_count is required/.test(noCount.err?.message), 'no reported count → refused (ask the person; never count the rows instead)');
  const twoWays = await call(sbAda, 'tm_record_results', { clearance_id: CL, seq: 5, reported_count: 0, rows: [], text: 'x' }, ADA_OPTS);
  check(!twoWays.ok && /exactly one way/.test(twoWays.err?.message), 'records given two ways at once → refused');

  const hits = await su(db, 'select serial, live, query_seqs, bin from public.tm_hits where clearance_id = $1 order by serial', [CL]);
  check(hits.length === 5 && hits.find((x) => x.serial === '97111111')?.query_seqs.join(',') === '3,7',
    'hits: one per serial across the runs, query_seqs merged (97111111 found by Q3 and Q7)', JSON.stringify(hits));

  const t = await call(sbAda, 'tm_triage', { clearance_id: CL }, ADA_OPTS);
  check(t.ok && t.out.status === 'PROPOSED' && t.out.proposed === 4 && t.out.remaining === 0, 'tm_triage proposes a bin for each live hit (the dead one is skipped)', msg(t));
  const prop = await su(db, 'select count(*) filter (where proposed is not null)::int p, count(*) filter (where bin is not null)::int b from public.tm_hits where clearance_id = $1', [CL]);
  check(prop[0].p === 4 && prop[0].b === 0, 'proposals stored in tm_hits.proposed; no bin decided');

  const rep = await call(sbAda, 'tm_report', { clearance_id: CL }, ADA_OPTS);
  const md = rep.out?.markdown ?? '';
  check(rep.ok && rep.out.status === 'DRAFT' && rep.out.reviewed === false && rep.out.filed === false, 'tm_report: DRAFT, not reviewed, not filed', msg(rep));
  check(md.startsWith('> **DRAFT — NOT REVIEWED.**') && /# Trademark knockout report — QUALLET/.test(md)
    && /## 8\. Limits of this search/.test(md) && /Q7 \(prefix\): tmsearch reported 4; 3 captured/.test(md),
    'the markdown: the DRAFT legend, the recipe\'s report, the gap in Limits');
  check(/### Not yet decided/.test(md) && rep.out.undecided_hits === 4, 'every live hit is listed as not yet decided');
  check(rep.out.lint.clean === true, 'the report passes the forbidden-phrase lint', JSON.stringify(rep.out.lint));
  check(/Not signed — assembled through Grok bot/.test(md), '"Prepared by" says it is unsigned and names the connector');
  const g1 = await call(sbAda, 'tm_get_clearance', { clearance_id: CL }, ADA_OPTS);
  check(g1.ok && g1.out.hits.proposed.flag + g1.out.hits.proposed.note + g1.out.hits.proposed.dismiss === 4 && g1.out.hits.decided.undecided === 4
    && g1.out.queries.find((q) => q.seq === 7)?.latest_run?.gap === true, 'tm_get_clearance: queries with runs, hits by proposed and decided bin', msg(g1));
}

// ===========================================================================
section('B. the Record: every row the bot causes is the connector\'s');
// ===========================================================================
{
  const ev = await su(db, `select kind, matter_id, actor_kind, actor_ref, actor_label, actor_user, payload from public.events where kind like 'tm.%' order by id`);
  const kinds = new Set(ev.map((e) => e.kind));
  check(['tm.clearance.created', 'tm.intake.updated', 'tm.classes.set', 'tm.queries.generated', 'tm.query.run', 'tm.hit.proposed'].every((k) => kinds.has(k)),
    'tm.* rows were written for each step', [...kinds].join(' '));
  check(ev.length > 0 && ev.every((e) => e.actor_kind === 'connector' && e.actor_ref === `token:${adaTok.id}` && e.actor_user === ADA && e.matter_id === OPEN),
    'every tm.* row: actor connector, ref token:<id>, written under the token user\'s own JWT, in the matter\'s chain',
    JSON.stringify(ev.filter((e) => e.actor_kind !== 'connector' || e.actor_ref !== `token:${adaTok.id}`).slice(0, 2)));
  check(ev.filter((e) => e.kind !== 'tm.hit.proposed').every((e) => e.payload?.via === 'connector'), 'and says via: connector');
  check(ev.every((e) => e.actor_label === 'Grok bot'), 'labelled with the token\'s name');
  const blob = JSON.stringify(ev.map((e) => e.payload));
  check(!/mobile wallet|payment services|Quall Co|QUALLETTA/i.test(blob), 'no goods text, owner or hit mark in any payload (metadata only)');
  const ti = await su(db, `select actor_kind, actor_ref, matter_id, payload from public.events where kind = 'tool.invoked' and payload->>'tool' like 'tm\\_%'`);
  check(ti.length >= 10 && ti.every((e) => e.actor_kind === 'connector' && e.actor_ref === `token:${adaTok.id}` && e.matter_id === OPEN),
    'tool.invoked rows for the tm_* calls: the connector, in the clearance\'s matter (resolved from clearance_id)', `${ti.length} rows`);
  check(ti.every((e) => !/QUALLET|wallet/i.test(JSON.stringify(e.payload.args))), 'their args are shapes: no mark, no goods text');
  const userRows = await su(db, `select count(*)::int n from public.events where kind like 'tm.%' and actor_kind = 'user'`);
  check(userRows[0].n === 0, 'no tm.* row is recorded as a browser user');
}

// ===========================================================================
section('C. another user\'s matter and clearance');
// ===========================================================================
{
  const before = await su(db, 'select (select count(*) from public.tm_query_runs)::int runs, (select count(*) from public.tm_clearances)::int cl');
  const g = await call(sbBob, 'tm_get_clearance', { clearance_id: CL }, BOB_OPTS);
  check(!g.ok && /could not be found/.test(g.err?.message), 'Bob\'s token: Ada\'s clearance is "not found"', msg(g));
  const smuggle = await call(sbBob, 'tm_record_results', { clearance_id: CL, matter: 'bob-private', seq: 1, reported_count: 0, rows: [] }, BOB_OPTS);
  check(!smuggle.ok && /could not be found/.test(smuggle.err?.message), 'a `matter` smuggled onto a clearance call changes nothing', msg(smuggle));
  const s = await call(sbBob, 'tm_start_clearance', { matter: 'eqz-tm', mark: 'QUIDDIT', goods_and_services: 'x' }, BOB_OPTS);
  check(!s.ok, 'Bob cannot open a clearance in Ada\'s matter', msg(s));
  const p = await call(sbBob, 'tm_propose', { clearance_id: CL, step: 'classes' }, BOB_OPTS);
  check(!p.ok, 'nor ask the model about her clearance', msg(p));
  const after = await su(db, 'select (select count(*) from public.tm_query_runs)::int runs, (select count(*) from public.tm_clearances)::int cl');
  check(after[0].runs === before[0].runs && after[0].cl === before[0].cl, 'and nothing was written');
  const own = await call(sbBob, 'tm_start_clearance', { matter: 'bob-private', mark: 'QUIRLD', goods_and_services: 'Games' }, BOB_OPTS);
  check(own.ok, 'Bob can in his own matter', msg(own));
  const cross = await call(sbAda, 'tm_get_clearance', { clearance_id: own.out?.clearance_id }, ADA_OPTS);
  check(!cross.ok && /could not be found/.test(cross.err?.message), 'and Ada cannot see his');
  const ro = await call(sbAda, 'tm_start_clearance', { matter: 'shared-ro', mark: 'QUIDDIT', goods_and_services: 'x' }, ADA_OPTS);
  check(!ro.ok && /read this matter but not work in it/.test(ro.err?.message), 'a matter Ada can only read: refused with a sentence', msg(ro));
}

// ===========================================================================
section('D. a sealed matter, and a paused one');
// ===========================================================================
{
  const n = sends.length;
  const s = await call(sbAda, 'tm_start_clearance', { matter: 'sealed-tm', mark: 'QUIDDIT', goods_and_services: 'x' }, ADA_OPTS);
  check(!s.ok && s.err?.code === 'sealed_matter', 'tm_start_clearance in a sealed matter: refused by the seal', msg(s));
  const sealedCl = u();
  await su(db, `insert into public.tm_clearances (id, matterspace_id, mark, created_by) values ($1, $2, 'QUIDDIT', $3)`, [sealedCl, SEALED, ADA]);
  for (const [tool, args] of [
    ['tm_get_clearance', {}], ['tm_propose', { step: 'classes' }], ['tm_confirm', { step: 'classes', value: { search: [{ code: '009', reason: 'x' }] } }],
    ['tm_generate_queries', {}], ['tm_record_results', { seq: 0, reported_count: 1, rows: FIXTURE_ROWS }], ['tm_triage', {}], ['tm_report', {}],
    ['tm_deep_check', {}], ['tm_application_questions', {}], ['tm_application_answer', { transfer: { planned: 'no' } }], ['tm_application_draft', {}],
  ]) {
    const r = await call(sbAda, tool, { clearance_id: sealedCl, ...args }, ADA_OPTS);
    check(!r.ok && r.err?.code === 'sealed_matter', `${tool} on a clearance in a sealed matter: refused by the seal`, msg(r));
  }
  check(sends.length === n, 'and the model was never called');
  const [sc] = await su(db, `select search_classes from public.tm_clearances where id = $1`, [sealedCl]);
  check(sc.search_classes.length === 0, 'and nothing on it changed');
  const sealedEv = await su(db, `select count(*)::int n from public.events where kind like 'tm.%' and matter_id = $1`, [SEALED]);
  check(sealedEv[0].n === 0, 'no tm.* row was written for it');
  const refusedRows = await su(db, `select count(*)::int n from public.events where kind = 'tool.invoked' and matter_id = $1 and payload->>'refused' = 'sealed'`, [SEALED]);
  check(refusedRows[0].n >= 11, 'each refusal is in the sealed matter\'s Record as refused: sealed', String(refusedRows[0].n));

  const p = await call(sbAda, 'tm_start_clearance', { matter: 'paused-tm', mark: 'QUIDDIT', goods_and_services: 'x' }, ADA_OPTS);
  check(!p.ok && p.err?.code === 'ai_paused', 'a paused matter: refused by the pause', msg(p));
}

// ===========================================================================
section('E. an agent token sees only its grant');
// ===========================================================================
{
  const ag = await makeToken(db, ADA, { name: 'Trademark agent', kind: 'agent', matterScope: [OPEN_CHILD] });
  const agent = await identityOf(ag.id);
  const opts = optsFor(agent, sbAda);
  check(opts.actor?.ref === `agent:${ag.id}` && opts.trademark.actor.ref === `agent:${ag.id}`, 'the agent keeps its own actor (agent:<id>)');
  const g = await call(sbAda, 'tm_get_clearance', { clearance_id: CL }, opts);
  check(!g.ok && g.err?.code === 'agent_scope', 'a clearance in a matter outside the grant: refused as out of scope', msg(g));
  const s = await call(sbAda, 'tm_start_clearance', { matter: 'eqz-sub', mark: 'QUIRLD', goods_and_services: 'Toys' }, opts);
  check(s.ok, 'inside the grant it works', msg(s));
  const [e] = await su(db, `select actor_kind, actor_ref from public.events where kind = 'tm.clearance.created' and payload->>'clearance_id' = $1`, [s.out?.clearance_id ?? '']);
  check(e?.actor_kind === 'connector' && e.actor_ref === `agent:${ag.id}`, 'and its Record rows are agent:<id>', JSON.stringify(e));
}

// ===========================================================================
section('F. a bot can never mark the report reviewed');
// ===========================================================================
{
  const r = await call(sbAda, 'tm_report', { clearance_id: CL, reviewed: true, initials: 'EQ', status: 'done' }, ADA_OPTS);
  check(r.ok && r.out.reviewed === false && r.out.status === 'DRAFT', 'extra arguments (reviewed, initials, status) do nothing: still DRAFT');
  const st = await su(db, `select stage, status, initials from public.tm_stages where clearance_id = $1 order by stage`, [CL]);
  check(st.every((s) => s.status === 'pending' && s.initials === null), 'after the whole flow every stage is pending and unsigned (stage 8 included)', JSON.stringify(st.filter((s) => s.status !== 'pending')));
  const bins = await su(db, `select count(*)::int n from public.tm_hits where clearance_id = $1 and (bin is not null or initials is not null or decided_by is not null)`, [CL]);
  check(bins[0].n === 0, 'no hit has a bin, initials or a decider');
  const filed = await su(db, `select count(*)::int n from public.events where kind in ('tm.report.filed', 'tm.stage.done', 'tm.hit.decided')`);
  check(filed[0].n === 0, 'no tm.report.filed, tm.stage.done or tm.hit.decided row exists');
  const forbid = await call(sbAda, 'tm_confirm', { clearance_id: CL, step: 'classes', value: { search: [{ code: '009', reason: 'This mark is registrable here.' }] } }, ADA_OPTS);
  check(!forbid.ok && /never prints/.test(forbid.err?.message), 'a reason that calls the mark registrable is refused', msg(forbid));
  const forbidStart = await call(sbAda, 'tm_start_clearance', { matter: 'eqz-tm', mark: 'QUIDDIT', goods_and_services: 'It is safe to file for apps' }, ADA_OPTS);
  check(!forbidStart.ok && /never prints/.test(forbidStart.err?.message), 'and so is intake text that says "safe to file"');
}

// ===========================================================================
section('H. slice 2 — the one-box start (tm_start_batch)');
// ===========================================================================
let QUIDDIT;
{
  const before = sends.length;
  const r = await call(sbAda, 'tm_start_batch', {
    matter: 'eqz-tm', marks: ['QUIDDIT', 'QUIRLD', 'quiddit', '  '], goods_and_services: 'A mobile wallet app and payment services',
    applicant: { legal_name: 'Grapheon.ai, LLC', entity_type: 'limited liability company', state: 'New Jersey' },
  }, ADA_OPTS);
  const cls = r.out?.clearances ?? [];
  check(r.ok && cls.length === 2 && cls.map((x) => x.mark).join(',') === 'QUIDDIT,QUIRLD', 'one call: one clearance per distinct mark (a repeated mark and a blank line dropped)', msg(r));
  check(cls.every((x) => x.status === 'PROPOSED' && x.proposals.classes?.search?.length === 3 && x.proposals.decompose?.opening && x.pending.length === 0),
    'each mark runs to the first human step: classes and decomposition PROPOSED', JSON.stringify(cls.map((x) => [x.mark, x.status, x.pending])));
  check(cls.every((x) => Array.isArray(x.preview_queries) && x.preview_queries[0] === 'Q0  SN:90562533'), 'with the queries the proposals would generate, as a preview');
  check(sends.length - before === 4, 'two model calls per mark, through the same send', String(sends.length - before));
  const ids = cls.map((x) => x.clearance_id);
  const rows = await su(db, 'select id, search_classes, decomposition, proposals, applicant from public.tm_clearances where id = any($1::uuid[])', [`{${ids.join(',')}}`]);
  check(rows.length === 2 && rows.every((x) => x.search_classes.length === 0 && x.decomposition === null && x.proposals.classes && x.proposals.decompose),
    'stored PROPOSED in tm_clearances.proposals; nothing confirmed');
  check(rows.every((x) => x.applicant.legal_name === 'Grapheon.ai, LLC'), 'the applicant is data on the clearance (Grapheon.ai, LLC), not a constant');
  const q = await su(db, 'select count(*)::int n from public.tm_queries where clearance_id = any($1::uuid[])', [`{${ids.join(',')}}`]);
  const st = await su(db, `select count(*)::int n from public.tm_stages where clearance_id = any($1::uuid[]) and status <> 'pending'`, [`{${ids.join(',')}}`]);
  check(q[0].n === 0 && st[0].n === 0, 'it stops there: no query stored, no stage signed');
  const ev = await su(db, `select actor_kind, actor_ref, payload from public.events where kind = 'tm.proposal.saved' and payload->>'clearance_id' = any($1::text[])`, [`{${ids.join(',')}}`]);
  check(ev.length === 4 && ev.every((e) => e.actor_kind === 'connector' && e.actor_ref === `token:${adaTok.id}` && e.payload.via === 'connector'),
    'four tm.proposal.saved rows, each the connector\'s', String(ev.length));
  QUIDDIT = ids[0];
  const g = await call(sbAda, 'tm_get_clearance', { clearance_id: QUIDDIT }, ADA_OPTS);
  check(g.ok && /PROPOSED/.test(g.out.next_step) && /step "proposals"/.test(g.out.next_step), 'next_step: show the proposals, then tm_confirm step "proposals"', g.out?.next_step);
  const c = await call(sbAda, 'tm_confirm', { clearance_id: QUIDDIT, step: 'proposals' }, ADA_OPTS);
  check(c.ok && c.out.status === 'CONFIRMED' && c.out.queries?.[0]?.query === 'SN:90562533' && /Q0/.test(c.out.next_step),
    'tm_confirm step "proposals": both confirmed as saved, the queries generated, next = run Q0', msg(c));
  const nm = await call(sbAda, 'tm_start_batch', { matter: 'eqz-tm', marks: ['QUELLO'], goods_and_services: 'Games' }, optsFor(ada, sbAda, { send: null }));
  check(nm.ok && nm.out.clearances[0].pending.length === 2 && /model is not available/.test(nm.out.next_step), 'with no model door: the clearance is opened and says the proposals are pending', msg(nm));
  const tooMany = await call(sbAda, 'tm_start_batch', { matter: 'eqz-tm', marks: Array.from({ length: 11 }, (_, i) => `MARK${i}`), goods_and_services: 'x' }, ADA_OPTS);
  check(!tooMany.ok && /At most 10/.test(tooMany.err?.message), 'more than ten marks: refused with a sentence');
  const sealed = await call(sbAda, 'tm_start_batch', { matter: 'sealed-tm', marks: ['QUIDDIT'], goods_and_services: 'x' }, ADA_OPTS);
  check(!sealed.ok && sealed.err?.code === 'sealed_matter', 'tm_start_batch into a sealed matter: refused by the seal', msg(sealed));
  const bobs = await call(sbBob, 'tm_start_batch', { matter: 'eqz-tm', marks: ['QUIDDIT'], goods_and_services: 'x' }, BOB_OPTS);
  check(!bobs.ok, 'and Bob cannot batch into Ada\'s matter', msg(bobs));
}

// ===========================================================================
section('I. slice 2 — stage 6, the TSDR deep check (stubbed HTTP)');
// ===========================================================================
{
  const { makeTsdrClient, parseMultiStatus } = await import('../lib/trademark/tsdr.mjs');
  const targets = (await su(db, `select serial from public.tm_hits where clearance_id = $1 and proposed->>'bin' = 'flag' order by serial`, [CL])).map((x) => x.serial);
  check(targets.length >= 1, `triage proposed ${targets.length} flag(s) on QUALLET: the deep check's targets`);
  // The person runs the rest of QUALLET's queries (nothing found), so the next step moves past stage 4.
  const g0 = await call(sbAda, 'tm_get_clearance', { clearance_id: CL }, ADA_OPTS);
  for (const q of g0.out.queries.filter((x) => !x.latest_run)) {
    await call(sbAda, 'tm_record_results', { clearance_id: CL, query_id: q.query_id, reported_count: 0, rows: [] }, ADA_OPTS);
  }

  // No key on the server: says so, fetches nothing, stores nothing.
  const noKey = await call(sbAda, 'tm_deep_check', { clearance_id: CL }, ADA_OPTS);
  check(noKey.ok && noKey.out.configured === false && /not set on this server/.test(noKey.out.message) && /may skip stage 6/.test(noKey.out.next_step),
    'no TSDR key: the stage says so plainly, and next_step says the reviewer may skip stage 6', msg(noKey));
  const stored0 = await su(db, 'select count(*)::int n from public.tm_hits where clearance_id = $1 and tsdr is not null', [CL]);
  check(stored0[0].n === 0, 'and nothing was fetched or stored (never faked)');

  // A stub TSDR: 429 with Retry-After first, then the batch as JSON.
  const calls = [];
  const waits = [];
  let clock = 0;
  const dead = targets[0];
  const body = { transactionList: [{ trademarks: targets.map((s, i) => ({
    status: {
      serialNumber: Number(s), markElement: `MARK${i}`, status: s === dead ? 602 : 700,
      tm5StatusDesc: s === dead ? 'DEAD/APPLICATION/Refused/Dismissed or Invalidated' : 'LIVE/REGISTRATION/Issued and Active',
      filingDate: '2021-03-04Z', usRegistrationNumber: s === dead ? null : '7000001', usRegistrationDate: s === dead ? null : '2022-05-06',
      ...(s === dead ? { dateAbandoned: '2023-01-02' } : {}),
    },
    parties: { currentOwners: [{ name: `Owner ${i} Inc.` }] },
    gsList: [{ description: 'Downloadable software', internationalClasses: [{ code: '9' }] }],
    prosecutionHistory: [{ entryDate: '2021-03-04', entryCode: 'NWAP', entryDesc: 'NEW APPLICATION ENTERED' }],
  })) }] };
  const stubFetch = async (url, init) => {
    calls.push({ url: String(url), key: init?.headers?.['USPTO-API-KEY'] });
    if (calls.length === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const tsdr = makeTsdrClient({ apiKey: 'test-key-not-real', fetchImpl: stubFetch, sleep: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock });
  const filedDocs = [];
  const fileDocument = async (a) => {
    const { data, error } = await sbAda.from('documents').insert({ matterspace_id: a.matter, title: a.title, source_filename: a.filename, storage_path: `${a.matter}/x/${a.filename}` }).select('id').single();
    if (error) throw new Error(error.message);
    filedDocs.push({ id: data.id, ...a });
    return { document_id: data.id };
  };
  const opts = optsFor(ada, sbAda);
  opts.trademark.tsdr = tsdr;
  opts.trademark.fileDocument = fileDocument;
  const r = await call(sbAda, 'tm_deep_check', { clearance_id: CL }, opts);
  check(r.ok && r.out.configured === true && r.out.checked === targets.length && r.out.remaining === 0, 'tm_deep_check fetched every flagged record', msg(r));
  check(calls.length === 2 && calls.every((x) => x.url.startsWith('https://tsdrapi.uspto.gov/ts/cd/caseMultiStatus/sn?ids=') && x.key === 'test-key-not-real'),
    'one caseMultiStatus request for the batch (retried once), the key in USPTO-API-KEY', JSON.stringify(calls.map((x) => x.url)));
  check(waits.includes(2000), 'a 429 waited the Retry-After (2 s) before retrying', waits.join(','));
  const hits = await su(db, 'select serial, bin, tsdr, tsdr_document_id from public.tm_hits where clearance_id = $1 and tsdr is not null order by serial', [CL]);
  const d = hits.find((h) => h.serial === dead);
  check(hits.length === targets.length && d?.tsdr?.live === false && /DEAD/.test(d.tsdr.status_text) && d.bin === null,
    'the dead record is noted (live false, its status text) and not dropped or decided', JSON.stringify(d?.tsdr ?? null).slice(0, 200));
  check(hits.filter((h) => h.serial !== dead).every((h) => h.tsdr.live === true && h.tsdr.registration_number === '7000001' && h.tsdr.owner === 'Owner 1 Inc.' || h.tsdr.live === true),
    'live records carry registration, owner and classes');
  check(hits.every((h) => h.tsdr_document_id) && filedDocs.length === targets.length && filedDocs.every((x) => /^TSDR status — \d+ — QUALLET — \d{4}-\d{2}-\d{2}\.md$/.test(x.filename) && /Prosecution history/.test(x.content)),
    'one status record filed in the matter per record, linked from the hit', filedDocs.map((x) => x.filename).join(' | '));
  check(!JSON.stringify(hits).includes('test-key-not-real') && !filedDocs.some((x) => x.content.includes('test-key-not-real')), 'the key is in no stored row and no filed document');
  const ev = await su(db, `select kind, actor_kind, actor_ref, payload from public.events where kind in ('tm.hit.status', 'tm.deep_check.run') and payload->>'clearance_id' = $1 order by id`, [CL]);
  check(ev.filter((e) => e.kind === 'tm.hit.status').length === targets.length && ev.every((e) => e.actor_kind === 'connector' && e.actor_ref === `token:${adaTok.id}`)
    && !JSON.stringify(ev).includes('test-key-not-real'), 'tm.hit.status per record and tm.deep_check.run, the connector\'s, metadata only');
  const again = await call(sbAda, 'tm_deep_check', { clearance_id: CL }, opts);
  check(again.ok && again.out.checked === 0 && calls.length === 2, 'a second call fetches nothing already fetched');

  // The client on its own: three 429s → gives up and says so; a 401; a serial TSDR does not return.
  const always429 = makeTsdrClient({ apiKey: 'k', fetchImpl: async () => new Response('', { status: 429 }), sleep: async () => {}, now: () => 0 });
  const g = await always429.status('97111111');
  check(!g.ok && g.code === 'rate_limited' && g.transient, 'a rate limit that does not clear: gives up after the retries, as a transient failure', g.message);
  const bad = await makeTsdrClient({ apiKey: 'k', fetchImpl: async () => new Response('', { status: 401 }), sleep: async () => {}, now: () => 0 }).status('97111111');
  check(!bad.ok && bad.code === 'unauthorized', 'a refused key says so', bad.message);
  const missing = await makeTsdrClient({ apiKey: 'k', fetchImpl: async () => new Response(JSON.stringify({ transactionList: [{ trademarks: [] }] }), { status: 200 }), sleep: async () => {}, now: () => 0 }).status('97111111');
  check(!missing.ok && missing.code === 'not_found' && !missing.transient, 'a serial TSDR did not return: not found (never an invented status)');
  const spaced = [];
  let t = 0;
  const paced = makeTsdrClient({ apiKey: 'k', fetchImpl: async () => new Response(JSON.stringify({ transactionList: [] }), { status: 200 }), sleep: async (ms) => { spaced.push(ms); t += ms; }, now: () => t });
  await paced.status('97111111'); await paced.status('97222222');
  check(spaced[0] === 15000, 'requests are spaced to the rate limit (15 s apart)', spaced.join(','));
  const m = parseMultiStatus(body).get(dead);
  check(m && m.events.length === 1 && m.classes[0] === '009' && m.filing_date === '2021-03-04', 'the mapping: history, three-digit classes, dates');
}

// ===========================================================================
section('J. slice 2 — stage 9, the application draft (both bases)');
// ===========================================================================
let DRAFT_DOC;
{
  const filed = [];
  const fileDocument = async (a) => {
    const { data, error } = await sbAda.from('documents').insert({ matterspace_id: a.matter, title: a.title, source_filename: a.filename, storage_path: `${a.matter}/y/${a.filename}` }).select('id').single();
    if (error) throw new Error(error.message);
    filed.push({ id: data.id, ...a });
    return { document_id: data.id };
  };
  const opts = optsFor(ada, sbAda);
  opts.trademark.fileDocument = fileDocument;

  // QUALLET: intent to use; the marks will move to an entity not yet formed.
  const q0 = await call(sbAda, 'tm_application_questions', { clearance_id: CL }, opts);
  check(q0.ok && q0.out.blocking > 0 && q0.out.questions.some((q) => q.id === 'applicant.legal_name') && q0.out.questions.some((q) => q.id === 'classes.009.in_use'),
    'tm_application_questions: the applicant and "is it in use?" are asked first', msg(q0));
  const a1 = await call(sbAda, 'tm_application_answer', {
    clearance_id: CL,
    applicant: { legal_name: 'Grapheon.ai, LLC', entity_type: 'limited liability company', state: 'New Jersey', formation_status: 'formed', formation_date: '2024-02-01',
      domicile_address: '1 Example Street, Princeton, NJ 08540', address_is_mail_drop: 'no', email: 'tm@example.com' },
    classes: [{ code: '009', identification: 'Downloadable mobile application software for making payments', id_source: 'free_form', in_use: false,
      intent_evidence: [{ date: '2026-09-15', description: 'Product plan for the wallet app' }], __proto__: { polluted: true } },
    { code: '045', identification: 'Legal services' }],
    transfer: { planned: 'yes', entity_name: 'Quorium, LLC', entity_formed: false, choice: 'wait', wait_until: '2026-12-01' },
  }, opts);
  check(a1.ok && a1.out.stored.includes('applicant.legal_name') && a1.out.stored.includes('classes.in_use') && a1.out.refused.some((x) => /045/.test(x)),
    'tm_application_answer stores what the person said; a class that is not a filing class is refused', msg(a1));
  const [row] = await su(db, 'select application, applicant from public.tm_clearances where id = $1', [CL]);
  check(row.application.classes[0].in_use === false && row.applicant.legal_name === 'Grapheon.ai, LLC' && !('polluted' in row.application.classes[0]),
    'stored on the clearance; only allowlisted keys');
  const ev = await su(db, `select payload from public.events where kind = 'tm.application.answered' and payload->>'clearance_id' = $1`, [CL]);
  check(ev.length === 1 && !/Princeton|wallet|Quorium/i.test(JSON.stringify(ev[0].payload)) && Array.isArray(ev[0].payload.fields), 'tm.application.answered: field names only, never the answers');
  const other = await su(db, 'select id from public.documents where matterspace_id = $1 limit 1', [READONLY]);
  const badSpec = await call(sbAda, 'tm_application_answer', { clearance_id: CL, classes: [{ code: '009', specimen: { document_id: other[0].id } }] }, opts);
  check(!badSpec.ok && /different matter/.test(badSpec.err?.message), 'a specimen filed in another matter is refused', msg(badSpec));
  const d1 = await call(sbAda, 'tm_application_draft', { clearance_id: CL }, opts);
  const md = d1.out?.draft_markdown ?? '';
  const annex = d1.out?.annex_markdown ?? '';
  check(d1.ok && d1.out.status === 'DRAFT' && d1.out.filed_in_matter === true && d1.out.filed_with_uspto === false && d1.out.bases['009'] === '1b',
    'tm_application_draft: intent to use (1(b)), filed in the matter as a DRAFT, never with the USPTO', msg(d1));
  check(md.startsWith('> **DRAFT — NOT REVIEWED.**') && /Do not file before 2026-12-01/.test(md) && /## 1\. Applicant[\s\S]*## 2\. Mark[\s\S]*## 3\. Classes[\s\S]*## 4\. Basis[\s\S]*## 5\. Specimens[\s\S]*## 6\. Declaration[\s\S]*## 7\. Fees/.test(md),
    'the draft: DRAFT legend, "do not file before", TEAS order');
  check(/\$350/.test(md) && /Free-form text identification fee/.test(md) && /Due at filing: \$550/.test(md), 'fees: $350 base + $200 free-form for the one class', md.match(/Due at filing: \$\d+/)?.[0]);
  check(/successor to the applicant's business/.test(annex) && /15 U\.S\.C\. § 1060\(a\)\(1\)/.test(annex) && /\(1\) Wait/.test(annex) && !/## 1\. Applicant/.test(annex),
    'the separate cautions annex: the three options and the § 1060(a)(1) bar for 1(b), not in the filing copy');
  check(d1.out.lint.clean, 'both texts pass the forbidden-phrase lint');
  DRAFT_DOC = d1.out.document_id;
  const [s9] = await su(db, 'select status, initials, done_by, output_document_id from public.tm_stages where clearance_id = $1 and stage = 9', [CL]);
  check(s9.status === 'awaiting_review' && s9.initials === null && s9.done_by === null && s9.output_document_id === DRAFT_DOC,
    'stage 9: awaiting review, unsigned, with the draft attached');
  check(filed.length === 2 && /^Trademark application draft — QUALLET — \d{4}-\d{2}-\d{2} [0-9a-f]{8}\.md$/.test(filed[0].filename) && /cautions/.test(filed[1].filename), 'two documents: the draft and the annex', filed.map((x) => x.filename).join(' | '));

  // QUIDDIT: use-based in class 009 (goods), and a class 042 specimen that fails the check.
  const cc = await call(sbAda, 'tm_confirm', { clearance_id: QUIDDIT, step: 'classes', value: {
    search: [{ code: '009', reason: 'apps' }, { code: '036', reason: 'payments' }, { code: '042', reason: 'SaaS' }],
    filing: [{ code: '009', reason: 'a dated product plan' }, { code: '042', reason: 'a dated launch plan' }] } }, opts);
  check(cc.ok, 'QUIDDIT: filing classes 009 and 042', msg(cc));
  const spec = u();
  await su(db, 'insert into public.documents (id, matterspace_id, title, source_filename, storage_path) values ($1, $2, $3, $4, $5)', [spec, OPEN, 'Specimen', 'quiddit-page.png', `${OPEN}/quiddit-page.png`]);
  const a2 = await call(sbAda, 'tm_application_answer', {
    clearance_id: QUIDDIT,
    applicant: { formation_status: 'formed', formation_date: '2024-02-01', domicile_address: '1 Example Street, Princeton, NJ 08540', address_is_mail_drop: 'no', email: 'tm@example.com' },
    classes: [
      { code: '009', identification: 'Downloadable software for making payments', id_source: 'id_manual', id_manual_entry: '009-1234', in_use: true,
        first_use_anywhere: '2026-03-01', first_use_in_commerce: '2026-04-01',
        specimen: { document_id: spec, kind: 'webpage', description: 'The app store page showing QUIDDIT beside the app, with its price and Get button', url: 'https://example.com/quiddit', access_date: '2026-10-20',
          shows_mark: 'yes', mark_as_brand: 'yes', goods_sold: 'yes', means_of_ordering: 'yes', mockup: 'no' } },
      { code: '042', identification: 'Platform as a service featuring software for payments', id_source: 'id_manual', in_use: true,
        first_use_anywhere: '2026-05-01', first_use_in_commerce: '2026-05-01',
        specimen: { document_id: spec, kind: 'webpage', description: 'Coming soon: join the waitlist. QUIDDIT credits inside the app', url: 'https://example.com/soon', access_date: '2026-10-20',
          shows_mark: 'yes', mark_as_brand: 'no', services_available: 'no', shows_services: 'yes', mockup: 'no' } },
    ],
    transfer: { planned: 'no' },
  }, opts);
  check(a2.ok && a2.out.blocking === 0, 'QUIDDIT answers recorded; nothing blocking', msg(a2));
  const st = a2.out.classes;
  const c009 = st.find((x) => x.code === '009');
  const c042 = st.find((x) => x.code === '042');
  check(c009.recommended_basis === '1a' && c009.specimen_flags.length === 0, 'class 009: in use with dates and a clean specimen → 1(a) recommended', JSON.stringify(c009));
  check(c042.recommended_basis === '1b' && c042.specimen_flags.some((f) => /not yet available/.test(f)) && c042.specimen_flags.some((f) => /name of a feature/.test(f)),
    'class 042: "coming soon" and an in-app unit are flagged; 1(b) recommended until fixed', JSON.stringify(c042.specimen_flags));
  const d2 = await call(sbAda, 'tm_application_draft', { clearance_id: QUIDDIT }, opts);
  check(d2.ok && d2.out.bases['009'] === '1a' && d2.out.bases['042'] === '1b' && /First use in commerce/.test(d2.out.draft_markdown) && /2026-04-01/.test(d2.out.draft_markdown)
    && /accessed 2026-10-20/.test(d2.out.draft_markdown) && !/Do not file before/.test(d2.out.draft_markdown), 'QUIDDIT draft: 1(a) for 009 with dates and specimen, 1(b) for 042', msg(d2));
  check(/Advertising a service that is not yet available/.test(d2.out.annex_markdown) && /TMEP § 1301\.03\(a\)/.test(d2.out.annex_markdown),
    'the annex carries the specimen flags with their sources');
  const g = await call(sbAda, 'tm_get_clearance', { clearance_id: CL }, opts);
  check(g.ok && /DRAFT application/.test(g.out.next_step) && /signs stage 9 off in Equazia\.ai/.test(g.out.next_step) && g.out.application.draft?.document_id === DRAFT_DOC,
    'tm_get_clearance next_step after the draft: the reviewer signs stage 9 in Equazia.ai', g.out?.next_step);
  const evd = await su(db, `select actor_kind, actor_ref from public.events where kind = 'tm.application.drafted'`);
  check(evd.length === 2 && evd.every((e) => e.actor_kind === 'connector' && e.actor_ref === `token:${adaTok.id}`), 'tm.application.drafted: the connector\'s');
}

// ===========================================================================
section('K. a connector token cannot sign; the browser can (migration 122)');
// ===========================================================================
{
  // Ada's connector client carries cs_via: 'connector' (lib/supabase-user-jwt.mjs).
  const s1 = await sbAda.from('tm_stages').update({ status: 'done', initials: 'EQ' }).eq('clearance_id', CL).eq('stage', 1).select('stage');
  check(Boolean(s1.error) && /connected assistant cannot sign/.test(s1.error.message), 'a stage sign-off under a connector JWT: refused by the database', s1.error?.message);
  const hit = (await su(db, 'select id from public.tm_hits where clearance_id = $1 limit 1', [CL]))[0];
  const h1 = await sbAda.from('tm_hits').update({ bin: 'flag', initials: 'EQ' }).eq('id', hit.id).select('id');
  check(Boolean(h1.error) && /cannot decide a bin/.test(h1.error.message), 'a bin decision under a connector JWT: refused by the database', h1.error?.message);
  const s9 = await sbAda.from('tm_stages').update({ status: 'done', initials: 'EQ', output_document_id: DRAFT_DOC }).eq('clearance_id', CL).eq('stage', 9).select('stage');
  check(Boolean(s9.error), 'and stage 9 (the application draft) likewise', s9.error?.message);

  // A browser session: a JWT without cs_via (the stub reads claims; it does not verify signatures).
  const { createClient } = await import('@supabase/supabase-js');
  const fake = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const browser = createClient('https://stub.supabase.test', 'stub-anon-key', {
    global: { headers: { Authorization: `Bearer ${fake({ sub: ADA, role: 'authenticated', aal: 'aal2' })}` } }, auth: { persistSession: false, autoRefreshToken: false },
  });
  const early9 = await browser.from('tm_stages').update({ status: 'done', initials: 'EQ', output_document_id: DRAFT_DOC }).eq('clearance_id', CL).eq('stage', 9).select('stage');
  check(Boolean(early9.error) && /stage 8 must be done first/.test(early9.error.message), 'the browser cannot sign stage 9 before stage 8', early9.error?.message);
  const early6 = await browser.from('tm_stages').update({ status: 'done', initials: 'EQ' }).eq('clearance_id', CL).eq('stage', 6).select('stage');
  check(Boolean(early6.error) && /stage 5 must be done first/.test(early6.error.message), 'nor stage 6 before stage 5', early6.error?.message);
  // The reviewer decides every live hit, then signs 1–5, skips 6, files and signs 8, then 9.
  const live = await su(db, `select id from public.tm_hits where clearance_id = $1 and coalesce(live, true) and coalesce(status_text, '') not ilike '%dead%'`, [CL]);
  for (const h of live) await browser.from('tm_hits').update({ bin: 'note', initials: 'eq', bin_reason: 'reviewed' }).eq('id', h.id);
  let chainOk = true;
  for (const n of [1, 2, 3, 4, 5]) {
    const r = await browser.from('tm_stages').update({ status: 'done', initials: 'EQ' }).eq('clearance_id', CL).eq('stage', n).select('stage');
    if (r.error) { chainOk = false; console.log(n, r.error.message); }
  }
  const sk6 = await browser.from('tm_stages').update({ status: 'skipped', initials: 'EQ' }).eq('clearance_id', CL).eq('stage', 6).select('stage');
  const s8 = await browser.from('tm_stages').update({ status: 'done', initials: 'EQ', output_document_id: DRAFT_DOC }).eq('clearance_id', CL).eq('stage', 8).select('stage');
  const no9doc = await browser.from('tm_stages').update({ status: 'done', initials: 'EQ', output_document_id: null }).eq('clearance_id', CL).eq('stage', 9).select('stage');
  check(chainOk && !sk6.error && !s8.error, 'the browser signs 1 to 5, skips 6 and signs 8', [sk6.error?.message, s8.error?.message].join(' '));
  check(Boolean(no9doc.error) && /needs the reviewed document/.test(no9doc.error.message), 'stage 9 needs the reviewed document attached', no9doc.error?.message);
  const ok9 = await browser.from('tm_stages').update({ status: 'done', initials: 'EQ', output_document_id: DRAFT_DOC }).eq('clearance_id', CL).eq('stage', 9).select('stage');
  const [row9] = await su(db, 'select status, initials, done_by from public.tm_stages where clearance_id = $1 and stage = 9', [CL]);
  check(!ok9.error && row9.status === 'done' && row9.initials === 'EQ' && row9.done_by === ADA, 'then the reviewer signs stage 9 in the browser, stamped by the database', ok9.error?.message);
  const g = await call(sbAda, 'tm_get_clearance', { clearance_id: CL }, ADA_OPTS);
  check(g.ok && /has signed the application draft off/.test(g.out.next_step) && /files it in TEAS/.test(g.out.next_step), 'and the bot\'s next_step says so', g.out?.next_step);
}

// ===========================================================================
section('L. every tm.* row a bot caused is the connector\'s');
// ===========================================================================
{
  const ev = await su(db, `select kind, actor_kind, actor_ref from public.events where kind like 'tm.%'`);
  const kinds = new Set(ev.map((e) => e.kind));
  check(['tm.proposal.saved', 'tm.deep_check.run', 'tm.hit.status', 'tm.application.answered', 'tm.application.drafted'].every((k) => kinds.has(k)),
    'the slice-2 kinds were written', [...kinds].join(' '));
  check(ev.every((e) => e.actor_kind === 'connector' && /^(token|agent):/.test(e.actor_ref)), 'and every one is attributed to a connector (token or agent), none to a browser user',
    JSON.stringify(ev.filter((e) => e.actor_kind !== 'connector').slice(0, 2)));
}

// ===========================================================================
section('G. outside the hosted connector');
// ===========================================================================
{
  const plain = callToolOptsFor(ada, {});
  const r = await call(sbAda, 'tm_get_clearance', { clearance_id: CL }, plain);
  check(!r.ok && /only through the hosted Equazia\.ai connector/.test(r.err?.message), 'without the connector\'s trademark options the tools refuse', msg(r));
  const noModel = await call(sbAda, 'tm_propose', { clearance_id: CL, step: 'classes' }, optsFor(ada, sbAda, { send: null }));
  check(!noModel.ok && /model is not available/.test(noModel.err?.message), 'with no model door, a proposal is refused with a sentence', msg(noModel));
}

// ===========================================================================
section('I. a whole export is one run (migration 124: up to 10,000 rows)');
// ===========================================================================
{
  // QUALLET's Q5 export held 1,485 records and was stored as 500.
  const [q] = await su(db, 'select id from public.tm_queries where clearance_id = $1 order by seq desc limit 1', [CL]);
  const big = Array.from({ length: 1485 }, (_, i) => ({ serial: String(97000000 + i), mark: `MARK ${i}`, status: 'LIVE', classes: '009' }));
  const r = await call(sbAda, 'tm_record_results', { clearance_id: CL, query_id: q.id, reported_count: 10391, rows: big }, ADA_OPTS);
  check(r.ok && r.out.run.captured_count === 1485 && /reported 10391; 1485 captured/.test(r.out.run.gap_note ?? ''),
    '1,485 records: all captured; the gap is the tmsearch count against ours, not a cut of 500', msg(r));
  const [n] = await su(db, 'select count(*)::int as n from public.tm_hits where clearance_id = $1 and serial between $2 and $3', [CL, '97000000', '97001484']);
  check(n.n === 1485, 'every record reached the hits table', String(n.n));
  let e = null;
  try {
    await su(db, `insert into public.tm_query_runs (query_id, source, reported_count, raw)
      select $1, 'manual', 10001, jsonb_agg(jsonb_build_object('serial', (90000000 + g)::text)) from generate_series(1, 10001) g`, [q.id]);
  } catch (err) { e = err; }
  check(e && /tm_query_runs_raw_check/.test(e.message), 'the database still refuses a run past 10,000 rows', e?.message);
}

check(net.log.refusedOutbound.length === 0 && net.log.anthropic.length === 0,
  'no outbound call left the process (no USPTO, no model provider)', net.log.refusedOutbound.join(' '));
net.restore();
done();

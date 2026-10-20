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
  check(tm.length === 8 && tm.every((n) => names.includes(n)), 'the eight tm_* tools are in mcp-core TOOLS', tm.join(' '));
  check(READ_TOOLS.has('tm_get_clearance') && READ_TOOLS.has('tm_report') && !READ_TOOLS.has('tm_record_results'),
    'tm_get_clearance and tm_report are reads for the meter; the rest are work');
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
  check(p1.ok && p1.out.status === 'PROPOSED' && p1.out.stored === false && p1.out.proposal?.search?.length === 3,
    'tm_propose classes returns the proposal, stores nothing', msg(p1));
  check(sends.at(-1)?.feature === 'trademark.classes' && sends.at(-1)?.matterId === OPEN, 'the model was reached through send, with the feature and the clearance\'s matter');
  const [after1] = await su(db, 'select search_classes from public.tm_clearances where id = $1', [CL]);
  check(Array.isArray(after1.search_classes) && after1.search_classes.length === 0, 'nothing stored until confirmed');

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
  check(refusedRows[0].n >= 7, 'each refusal is in the sealed matter\'s Record as refused: sealed', String(refusedRows[0].n));

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
section('G. outside the hosted connector');
// ===========================================================================
{
  const plain = callToolOptsFor(ada, {});
  const r = await call(sbAda, 'tm_get_clearance', { clearance_id: CL }, plain);
  check(!r.ok && /only through the hosted Equazia\.ai connector/.test(r.err?.message), 'without the connector\'s trademark options the tools refuse', msg(r));
  const noModel = await call(sbAda, 'tm_propose', { clearance_id: CL, step: 'classes' }, optsFor(ada, sbAda, { send: null }));
  check(!noModel.ok && /model is not available/.test(noModel.err?.message), 'with no model door, a proposal is refused with a sentence', msg(noModel));
}

check(net.log.refusedOutbound.length === 0 && net.log.anthropic.length === 0,
  'no outbound call left the process (no USPTO, no model provider)', net.log.refusedOutbound.join(' '));
net.restore();
done();

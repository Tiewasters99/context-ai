// Trademark Clearance on Equazia's own copy of the USPTO register, end to end,
// the way a bring-your-own bot reaches it: an MCP client over Streamable HTTP
// with a csp_ connector token, against the REAL api/mcp.mjs handler on a local
// port, with TM_REGISTER_DB_URL pointing at a LOCAL register copy (PGlite in a
// temp directory) loaded from the committed SYNTHETIC fixture.
//
//   1. the copy is offered but its recall gate has not passed → next_step hands
//      the person the tmsearch queries and names tm_run_search as preliminary;
//      tm_run_search runs every query on the copy; each run is recorded with
//      source register_copy, the as-of date and "preliminary"; the hits arrive;
//      triage is proposed; the DRAFT report states the source, the as-of date,
//      the scope and "preliminary: confirm on tmsearch";
//   2. the gate passes (a stored pass record) → next_step tells the bot to call
//      tm_run_search, and the runs are no longer preliminary;
//   3. a stale copy → tm_run_search refuses with a plain sentence, next_step
//      falls back to tmsearch;
//   4. refusals unchanged: another user's clearance, a sealed matter, a paused one.
//
// Offline: PGlite for both databases (Equazia's with the real migrations 121,
// 122 and 123; the register copy with db/tm-register/schema.sql), a stub model,
// no USPTO, no network beyond 127.0.0.1.
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//   node scripts/_e2e-tm-register-mcp.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-register-e2e-'));
// Set BEFORE the connector module loads: it decides then whether tm_run_search is listed.
process.env.TM_REGISTER_DB_URL = `pglite:${REG_DIR}`;
process.env.OPENAI_API_KEY = 'e2e-stub-openai-key';

const { harness, makeDb, installFetch, makeToken, su, stubModel, ADA, BOB, OPEN, SEALED, PAUSED, u } = await import('./_tm-connector-fixture.mjs');
const { openRegisterDb } = await import('../lib/trademark/register/db.mjs');
const { applySchema, loadFile, stampAsOf } = await import('../lib/trademark/register/load.mjs');
const { runRecall, storeRecall } = await import('../lib/trademark/register/recall.mjs');

const { check, section, done } = harness();
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

// The register copy: schema, the synthetic backfile, as of yesterday.
const reg = await openRegisterDb(process.env.TM_REGISTER_DB_URL);
await applySchema(reg);
const loaded = await loadFile(reg, path.join(ROOT, 'scripts', 'fixtures', 'tm-register', 'apc-synthetic-backfile-20261018.xml'), { kind: 'fixture', asOf: yesterday });
await stampAsOf(reg, yesterday);

// Equazia's database: 121 + 122 (the fixture) + 123.
const db = await makeDb();
await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '123_trademark_register_copy.sql'), 'utf8'));
const net = installFetch(db, { anthropic: stubModel, openaiDown: true });

const handler = (await import('../api/mcp.mjs')).default;
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
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
  await client.connect(new StreamableHTTPClientTransport(MCP_URL, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const tool = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) return { ok: false, text };
  try { return { ok: true, out: JSON.parse(text), text }; } catch { return { ok: false, text }; }
};
const show = (r) => (r.ok ? JSON.stringify(r.out).slice(0, 400) : r.text.slice(0, 400));

const adaTok = await makeToken(db, ADA, { name: 'Grok bot' });
const bobTok = await makeToken(db, BOB, { name: 'Bob bot' });
const ada = await connect(adaTok.token);

async function clearanceFor(mark, decomposition, extra = {}) {
  const s = await tool(ada, 'tm_start_clearance', { matter: 'eqz-tm', mark, goods_and_services: 'Software for legal research and document review', ...extra });
  const id = s.out?.clearance_id;
  await tool(ada, 'tm_confirm', { clearance_id: id, step: 'classes', value: { search: [{ code: '009', reason: 'software' }, { code: '042', reason: 'SaaS' }, { code: '045', reason: 'legal' }], filing: [{ code: '042', reason: 'dated plan' }] } });
  await tool(ada, 'tm_confirm', { clearance_id: id, step: 'decompose', value: { ...decomposition, foreign_equivalents: ['equazione', 'equacion'] } });
  const g = await tool(ada, 'tm_generate_queries', { clearance_id: id });
  return { id, start: s, gen: g };
}

// ===========================================================================
section('the copy, and the tool list');
// ===========================================================================
{
  check(loaded.records === 404, `the local register copy holds the fixture (${loaded.records} records, as of ${yesterday})`);
  const { tools } = await ada.listTools();
  const names = tools.map((t) => t.name);
  check(names.includes('tm_run_search') && names.length === 41, 'with TM_REGISTER_DB_URL set, tools/list adds tm_run_search (41 tools)', `${names.length}`);
  check(/copy of the USPTO register/.test(ada.getInstructions() ?? ''), 'the server instructions mention the copy');
}

// ===========================================================================
section('1. the gate has not passed: preliminary');
// ===========================================================================
const one = await clearanceFor('EQUAZIA', { opening: 'equa', hinge: 'z', ending: 'ia' }, { known_marks: [{ name: 'EQUALL', owner: 'Equall Inc' }] });
{
  check(one.gen.ok && one.gen.out.queries.length >= 10, `EQUAZIA: ${one.gen.out?.queries?.length ?? 0} queries generated`, show(one.gen));
  const g = await tool(ada, 'tm_get_clearance', { clearance_id: one.id });
  check(g.ok && g.out.register?.offered === true && g.out.register.gate_passed === false && g.out.register.as_of === yesterday,
    'tm_get_clearance: the copy is offered, as of yesterday, its gate not passed', show(g));
  check(/tmsearch/.test(g.out.next_step) && /tm_run_search/.test(g.out.next_step) && /preliminary: confirm on tmsearch/.test(g.out.next_step),
    'next_step: hand the person the tmsearch queries; tm_run_search is there but preliminary', g.out?.next_step);
  const r = await tool(ada, 'tm_run_search', { clearance_id: one.id });
  check(r.ok && r.out.source === 'register_copy' && r.out.preliminary === true && r.out.label === 'preliminary: confirm on tmsearch'
    && r.out.runs.length === one.gen.out.queries.length && r.out.not_run.length === 0,
    `tm_run_search: every query run on the copy (${r.out?.runs?.length ?? 0}), preliminary`, show(r));
  check(r.out.self_test === 'passed' && r.out.hits_total > 0, `the self-test passed on the copy (Q0 found EQUASITE); ${r.out?.hits_total} hits`, show(r));
  check(/Federal register only/.test(r.out.scope), 'the scope is stated');
  const runs = await su(db, `select r.source, to_char(r.register_as_of, 'YYYY-MM-DD') a, r.register_preliminary p, r.captured_count, r.reported_count, r.gap
    from public.tm_query_runs r join public.tm_queries q on q.id = r.query_id where q.clearance_id = $1`, [one.id]);
  check(runs.length === r.out.runs.length && runs.every((x) => x.source === 'register_copy' && x.a === yesterday && x.p === true),
    'each run is in the append-only log with source register_copy, the as-of date and preliminary', JSON.stringify(runs[0]));
  check(runs.every((x) => x.gap === (x.reported_count !== x.captured_count)), 'the database computed each capture and gap');
  const hits = await su(db, `select serial, live, raw->>'source' s from public.tm_hits where clearance_id = $1`, [one.id]);
  check(hits.some((h) => h.serial === '90562533' && h.live) && hits.some((h) => h.serial === '98137428' && h.live),
    'EQUASITE 90562533 and EQUALL 98137428 are among the live hits', `${hits.length} hits`);
  check(hits.some((h) => h.live === false), 'dead records arrive as dead (kept in the log, not scored)');
  const ev = await su(db, `select actor_kind, actor_ref, payload from public.events where kind = 'tm.query.run' and payload->>'clearance_id' = $1`, [one.id]);
  check(ev.length === runs.length && ev.every((e) => e.actor_kind === 'connector' && e.actor_ref === `token:${adaTok.id}`
    && e.payload.source === 'register_copy' && e.payload.register_as_of === yesterday && e.payload.preliminary === true && e.payload.via === 'connector'),
    'the Record: one tm.query.run per run, the connector\'s, with source and as-of date', JSON.stringify(ev[0]?.payload));
  const after = await tool(ada, 'tm_get_clearance', { clearance_id: one.id });
  check(after.ok && /ran only on Equazia's copy/.test(after.out.next_step) && /tm_record_results/.test(after.out.next_step) && after.out.register.preliminary_runs.length === runs.length,
    'next_step: give the person those queries for tmsearch; the reviewer cannot sign stage 4 until then', after.out?.next_step);
  check(after.out.queries.every((q) => q.latest_run?.source === 'register_copy' && q.latest_run.preliminary === true && q.latest_run.register_as_of === yesterday),
    'every query\'s latest run shows its source, as-of date and preliminary label', JSON.stringify(after.out.queries[0]?.latest_run));
  const t = await tool(ada, 'tm_triage', { clearance_id: one.id });
  check(t.ok && t.out.proposed > 0, `tm_triage proposes bins on the copy's live hits (${t.out?.proposed})`, show(t));
  const rep = await tool(ada, 'tm_report', { clearance_id: one.id });
  const md = rep.out?.markdown ?? '';
  check(rep.ok && rep.out.lint.clean && new RegExp(`run on Equazia's own copy of the USPTO federal register, as of ${yesterday}`).test(md)
    && /preliminary: confirm on tmsearch/.test(md) && /no design-mark image comparison; no state registrations or common-law marks; the copy is one or two days behind/.test(md)
    && md.includes(`Equazia register copy, as of ${yesterday} (preliminary: confirm on tmsearch)`),
    'the DRAFT report states the source, the as-of date, the scope and the preliminary label; lint clean', md.slice(md.indexOf('## 8.'), md.indexOf('## 8.') + 600));
  const sign = await su(db, `select count(*)::int n from public.tm_stages where clearance_id = $1 and status = 'done'`, [one.id]);
  check(sign[0].n === 0, 'nothing signed by the bot');
}

// ===========================================================================
section('2. the gate passes: the copy stands on its own');
// ===========================================================================
{
  process.env.TM_REGISTER_GATE_MIN_MARKS = '1'; // the harness's gate set is the one-mark seed
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'tm-register', 'recall-seed-2026-10-21.json'), 'utf8'));
  const rr = await runRecall(reg, seed, { minMarks: 1, asOf: yesterday });
  await storeRecall(reg, rr);
  check(rr.passed, 'a stored pass record (the seed, at a minimum of 1 mark for this harness)');
  const two = await clearanceFor('EKWAZIA', { opening: 'ekwa', hinge: 'z', ending: 'ia' });
  const g = await tool(ada, 'tm_get_clearance', { clearance_id: two.id });
  check(g.ok && g.out.register.gate_passed === true && g.out.register.default === true && /^\d+ quer.*Call tm_run_search/.test(g.out.next_step) && !/preliminary/.test(g.out.next_step),
    'next_step: call tm_run_search (the bot can complete the search alone)', g.out?.next_step);
  const r = await tool(ada, 'tm_run_search', { clearance_id: two.id });
  check(r.ok && r.out.preliminary === false && !r.out.label && r.out.runs.every((x) => x.preliminary === false), 'runs are no longer preliminary', show(r));
  const after = await tool(ada, 'tm_get_clearance', { clearance_id: two.id });
  check(after.ok && after.out.register.preliminary_runs.length === 0 && /tm_triage/.test(after.out.next_step), 'next_step moves on to triage', after.out?.next_step);
  const rep = await tool(ada, 'tm_report', { clearance_id: two.id });
  check(rep.ok && /Equazia's own copy/.test(rep.out.markdown) && !/preliminary: confirm on tmsearch/.test(rep.out.markdown), 'the report states the source and no preliminary line');
  const one2 = await tool(ada, 'tm_run_search', { clearance_id: one.id, query_ids: ['Q5'] });
  check(one2.ok && one2.out.runs.length === 1 && one2.out.runs[0].seq === 5, 'query_ids re-runs one named query (Q5)', show(one2));
  const bad = await tool(ada, 'tm_run_search', { clearance_id: one.id, query_ids: ['Q99'] });
  check(!bad.ok && /Not queries of this clearance: Q99/.test(bad.text), 'an unknown query is refused by name', bad.text);
}

// ===========================================================================
section('3. a stale copy falls back to tmsearch');
// ===========================================================================
{
  await reg.query(`update register_meta set value = '2026-01-01' where key = 'as_of'`);
  const three = await clearanceFor('EQUAZIO', { opening: 'equa', hinge: 'z', ending: 'io' });
  const r = await tool(ada, 'tm_run_search', { clearance_id: three.id });
  check(!r.ok && /out of date/.test(r.text) && /tmsearch/.test(r.text), 'tm_run_search refuses with a plain sentence and the tmsearch fallback', r.text);
  const g = await tool(ada, 'tm_get_clearance', { clearance_id: three.id });
  check(g.ok && g.out.register.offered === false && g.out.register.stale === true && /out of date/.test(g.out.next_step) && /tmsearch/.test(g.out.next_step),
    'next_step: the copy is out of date; run the queries on tmsearch', g.out?.next_step);
  await reg.query(`update register_meta set value = $1 where key = 'as_of'`, [yesterday]);
}

// ===========================================================================
section('4. refusals unchanged');
// ===========================================================================
{
  const bob = await connect(bobTok.token);
  const b = await tool(bob, 'tm_run_search', { clearance_id: one.id });
  check(!b.ok && /could not be found/.test(b.text), 'another user\'s clearance: not found', b.text);
  await bob.close();
  const sealedCl = u();
  await su(db, `insert into public.tm_clearances (id, matterspace_id, mark, created_by) values ($1, $2, 'QUIRLD', $3)`, [sealedCl, SEALED, ADA]);
  const s = await tool(ada, 'tm_run_search', { clearance_id: sealedCl });
  check(!s.ok && /sealed matter/.test(s.text), 'a sealed matter: refused by the seal', s.text);
  const pausedCl = u();
  await su(db, `insert into public.tm_clearances (id, matterspace_id, mark, created_by) values ($1, $2, 'QUIRLD', $3)`, [pausedCl, PAUSED, ADA]);
  const p = await tool(ada, 'tm_run_search', { clearance_id: pausedCl });
  check(!p.ok && /paused/i.test(p.text), 'a paused matter: refused by the pause', p.text);
  check(net.log.refusedOutbound.length === 0, 'nothing left the process (no USPTO, no tmsearch, no model provider)', net.log.refusedOutbound.join(' '));
}

await ada.close();
await new Promise((r) => server.close(r));
net.restore();
await reg.close();
fs.rmSync(REG_DIR, { recursive: true, force: true });
done();

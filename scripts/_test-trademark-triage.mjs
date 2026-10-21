// Trademark Clearance — runs, triage, the report and the lint (spec §5–§7).
//
//   node --test scripts/_test-trademark-triage.mjs
//
// Fixture rows from Opus's Part 3 (serials [M], see
// scripts/fixtures/trademark/equazia-golden.json): dedup across runs, the dead
// drop, a duplicated serial flagged as overlap, captured ≠ reported flagged;
// the assembled report carries EQUALL 98137428 and EQUASITE 90562533 as
// flagged, EQUARA 99922464 in notes, YUEQUAZELL 99887921 dismissed and a gap
// line for Q7's 392; the lint catches "the mark is clear" and passes "no
// conflicts identified for review". The model is never called: a stub stands
// in for it, and a proposal that says "clear" is discarded before storage.
// The export mapper reads the hand-built CSV through the repo's xlsx.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateQueries } from '../lib/trademark/queries.mjs';
import {
  summarizeRun, collectHits, splitLiveDead, isDead, crowdedField, selfTestState, gapLines, latestRuns,
} from '../lib/trademark/triage.mjs';
import { parseManualRows, readExportFile, mapExportTable, ExportFormatError, parseClasses, liveFromStatus } from '../lib/trademark/parse.mjs';
import { assembleReport, lintReport, lintableText, reportFilename, aiUseFrom, REPORT_SENTENCE_AI } from '../lib/trademark/report.mjs';
import { forbiddenPhrases, lintValue } from '../lib/trademark/lint.mjs';
import { proposeTriage, proposeDecomposition, proposeClasses, TRADEMARK_MODEL, TRIAGE_BATCH, FEATURES } from '../lib/trademark/model.mjs';
import { procedureHash } from '../lib/trademark/procedure.mjs';
import { LLM_FEATURES } from '../lib/llm-record.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'trademark');
const golden = JSON.parse(fs.readFileSync(path.join(FIX, 'equazia-golden.json'), 'utf8'));

// ---------------------------------------------------------------------------
// The fixture as the database would hold it.
// ---------------------------------------------------------------------------
function buildFixture() {
  const c = golden.clearance;
  const { queries: generated } = generateQueries({
    mark: c.mark, decomposition: c.decomposition, searchClasses: c.search_classes.map((x) => x.code),
    knownMarks: c.known_marks, foreignEquivalents: c.foreign_equivalents, exclusions: ['equal', 'equat', 'equator', 'equit'],
  });
  const queries = generated.map((q) => ({ ...q, id: `q${q.seq}` }));
  const runs = Object.entries(golden.runs).map(([seq, r], i) => {
    const rows = parseManualRows(r.rows.map((x) => [x.serial, x.mark, x.owner, x.status, (x.classes ?? []).join(' '), x.goods ?? ''].join(' | ')).join('\n')).rows;
    const s = summarizeRun({ source: r.source, reported_count: r.reported, rows });
    return {
      id: `r${seq}`, query_id: `q${seq}`, run_at: `2026-10-18T10:${String(i).padStart(2, '0')}:00Z`,
      source: r.source, reported_count: r.reported, captured_count: s.captured, gap: s.gap, gap_note: s.gapNote, raw: rows,
      export_document_id: r.source === 'export' ? '6b0c1e7e-0000-4000-8000-000000000001' : null,
    };
  });
  return { clearance: c, queries, runs };
}

test('a run: captured differs from reported is a gap; a repeated serial is a pagination-overlap gap', () => {
  const { runs } = buildFixture();
  const q7 = runs.find((r) => r.query_id === 'q7');
  assert.equal(q7.captured_count, 9);
  assert.equal(q7.gap, true);
  assert.match(q7.gap_note, /tmsearch reported 392; 9 captured/);
  assert.match(q7.gap_note, /98137428 repeated within the run \(pagination overlap\)/);
  const ok = runs.find((r) => r.query_id === 'q0');
  assert.equal(ok.gap, false);
  assert.equal(summarizeRun({ source: 'manual', reported_count: 2, rows: [{ serial: '1' }, { serial: '1' }] }).gap, true, 'counts agree but a serial repeats');
  assert.equal(summarizeRun({ source: 'failed', reported_count: null, rows: [] }).gap, true, 'a failed run is a gap');
  assert.match(summarizeRun({ source: 'failed', reported_count: null, rows: [] }).gapNote, /not a "no results" run/);
  assert.equal(summarizeRun({ source: 'manual', reported_count: 0, rows: [] }).gap, false, 'reported 0, captured 0 is a valid empty run');
  assert.equal(summarizeRun({ source: 'manual', reported_count: null, rows: [{ serial: '1' }] }).gap, true, 'no reported count cannot be checked');
});

test('the self-test: passed when Q0 captured exactly 1; failed otherwise; a re-run supersedes', () => {
  const { queries, runs } = buildFixture();
  assert.equal(selfTestState(queries, runs), 'passed');
  const rerun = [...runs, { id: 'r0b', query_id: 'q0', run_at: '2026-10-18T23:00:00Z', source: 'manual', reported_count: 0, captured_count: 0, raw: [] }];
  assert.equal(selfTestState(queries, rerun), 'failed');
  assert.equal(latestRuns(rerun).get('q0').id, 'r0b');
  assert.equal(selfTestState(queries, runs.filter((r) => r.query_id !== 'q0')), 'not_run');
});

test('hits: deduplicated across runs by serial, with every query that found them; dead records split out', () => {
  const { queries, runs } = buildFixture();
  const hits = collectHits(queries, runs);
  const by = Object.fromEntries(hits.map((h) => [h.serial, h]));
  assert.equal(hits.filter((h) => h.serial === '98137428').length, 1, 'EQUALL once, though found three times');
  assert.deepEqual(by['98137428'].query_seqs, [7, 9]);
  assert.deepEqual(by['90562533'].query_seqs, [0, 5, 7], 'EQUASITE found by Q0, Q5 and Q7');
  assert.equal(by['98137417'].live, false, 'EQUALL COPILOT is dead');
  const { live, dead } = splitLiveDead(hits);
  assert.deepEqual(dead.map((h) => h.serial), ['98137417']);
  assert.ok(!live.some((h) => h.serial === '98137417'));
  assert.equal(isDead({ status_text: 'Abandoned' }), true);
  assert.equal(isDead({ status_text: 'LIVE registered' }), false);
});

test('the crowded field: live hits in the search classes that start with the opening', () => {
  const { queries, runs, clearance } = buildFixture();
  const hits = collectHits(queries, runs);
  const cf = crowdedField(hits, clearance.decomposition.opening, clearance.search_classes.map((x) => x.code));
  // EQUALL, EQUASITE, EQUA, EQUARA, EQUANIMA (009/042) — not EQUAZEN (005), not
  // YUEQUAZELL (014, and does not start with equa), not the dead COPILOT, not the clothing marks (025).
  assert.deepEqual(cf.serials.sort(), ['79349638', '90562533', '98137428', '98364901', '99922464']);
  assert.equal(cf.count, 5);
});

test('gaps are listed verbatim: not-run queries, Q7\'s 392 overlap', () => {
  const { queries, runs } = buildFixture();
  const lines = gapLines(queries, runs);
  assert.ok(lines.some((l) => l.startsWith('Q7 (prefix): tmsearch reported 392; 9 captured; serial 98137428 repeated within the run (pagination overlap)')), lines.join('\n'));
  assert.ok(lines.includes('Q3 (hinge) was not run.'));
  assert.ok(!lines.some((l) => l.startsWith('Q0 ')), 'the passed self-test is not a gap');
});

async function decidedReport(overrides = {}) {
  const { clearance, queries, runs } = buildFixture();
  const hits = collectHits(queries, runs).map((h) => {
    const d = golden.decisions[h.serial];
    return d && !isDead(h)
      ? { ...h, bin: d.bin, bin_reason: d.reason, initials: d.initials, decided_at: '2026-10-18T12:00:00Z',
        proposed: h.serial === '98137428' ? { bin: 'flag', similarity: { score: 4, reason: 'shared opening' }, relatedness: { score: 5, reason: 'AI software' }, model: TRADEMARK_MODEL } : null }
      : h;
  });
  const md = assembleReport({
    clearance, matter: { name: 'Equazia trademark' }, preparer: { name: 'Eden Quainton', initials: 'EQ' }, date: '2026-10-18',
    queries, runs, hits, aiUse: aiUseFrom({ hits, clearance }), procedureHash: await procedureHash(), ...overrides,
  });
  return { md, hits };
}

const section = (md, n) => {
  const start = md.indexOf(`## ${n}.`);
  const next = md.indexOf('\n## ', start + 3);
  return md.slice(start, next === -1 ? undefined : next);
};

test('the report: EQUALL and EQUASITE flagged, EQUARA in notes, YUEQUAZELL dismissed, the 392 gap in Limits', async () => {
  const { md } = await decidedReport();
  const flagged = section(md, 4);
  assert.match(flagged, /\| 98137428 \| EQUALL \|/);
  assert.match(flagged, /\| 90562533 \| EQUASITE \|/);
  assert.match(flagged, /Flag for review — shared EQUA- opening/);
  assert.match(flagged, /\| EQ \| 2026-10-18 \|/);
  assert.match(flagged, /4 — shared opening/, 'the proposal\'s scores are printed beside the decision');
  assert.match(section(md, 5), /\| 99922464 \| EQUARA \|/);
  assert.match(section(md, 6), /\| 99887921 \| YUEQUAZELL \| jewelry, class 14 \| EQ \|/);
  assert.match(section(md, 7), /\| 98137417 \| EQUALL COPILOT \| DEAD abandoned \|/);
  assert.match(section(md, 8), /Q7 \(prefix\): tmsearch reported 392; 9 captured; serial 98137428 repeated/);
  assert.match(section(md, 8), /federal register \(USPTO\) only/);
  assert.match(md, /Self-test \(Q0\) \| Passed/);
  assert.match(md, /Procedure version \(sha256\) \| [0-9a-f]{64}/);
  assert.match(section(md, 3), /\| Q7 \| prefix \| `CM:equa\* AND LD:true AND IC:\(009 042 045 a b 200\)` \| 2026-10-18 \| 392 \| 9 \| Y — /);
  assert.match(section(md, 3), /### Not run/);
  assert.match(section(md, 9), /Source: USPTO, "Federal trademark searching: Field tag searching" handout, verified 2026-10-18/);
  assert.match(section(md, 10), /\| trademark\.triage \| claude-opus-5-5 \| 1 \|/);
  assert.ok(md.trimEnd().endsWith(REPORT_SENTENCE_AI), 'the template ends after §10: no conclusion line');
  assert.equal(reportFilename('EQUAZIA', '2026-10-18'), 'Trademark knockout report — EQUAZIA — 2026-10-18.md');
});

test('the report is deterministic and lints clean (the Method section\'s own phrase list excepted)', async () => {
  const a = (await decidedReport()).md;
  const b = (await decidedReport()).md;
  assert.equal(a, b);
  assert.deepEqual(lintReport(a), []);
  assert.ok(forbiddenPhrases(a).length > 0, 'the unfiltered text does contain the phrase list (the Method table)');
  assert.ok(!lintableText(a).includes('### Forbidden phrases'));
  assert.ok(lintableText(a).includes('## 10. AI assistance'), 'only the phrase table is left out');
});

test('a self-test failure is printed in the header and in Limits', async () => {
  const { clearance, queries, runs } = buildFixture();
  const bad = runs.map((r) => (r.query_id === 'q0' ? { ...r, captured_count: 0, raw: [] } : r));
  const md = assembleReport({ clearance, matter: { name: 'M' }, preparer: { name: 'R', initials: 'R' }, date: '2026-10-18', queries, runs: bad, hits: [], procedureHash: 'x' });
  assert.match(md, /FAILED — self-test failed; syntax or system change suspected/);
  assert.match(section(md, 8), /The self-test failed/);
});

test('a reviewer\'s reason that says "the mark is clear" makes the report fail the lint, with the sentence', async () => {
  const { clearance, queries, runs } = buildFixture();
  const hits = collectHits(queries, runs).map((h) => (h.serial === '99887921'
    ? { ...h, bin: 'dismiss', bin_reason: 'Different goods. The mark is clear of it', initials: 'EQ', decided_at: '2026-10-18' } : h));
  const md = assembleReport({ clearance, matter: { name: 'M' }, preparer: { name: 'R', initials: 'R' }, date: '2026-10-18', queries, runs, hits, procedureHash: 'x' });
  const hit = lintReport(md);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].phrase, 'is clear');
  assert.match(hit[0].sentence, /The mark is clear of it/);
});

test('the lint (spec §6)', () => {
  assert.equal(forbiddenPhrases('After review, the mark is clear.')[0]?.phrase, 'is clear');
  assert.deepEqual(forbiddenPhrases('No conflicts identified for review.'), []);
  assert.deepEqual(forbiddenPhrases('There were no conflicts that we identified for review in class 9.'), []);
  assert.equal(forbiddenPhrases('There are no conflicts.')[0]?.phrase, 'no conflicts');
  assert.equal(forbiddenPhrases('Results ARE CLEAR').length, 1, 'case-insensitive');
  for (const p of ['It was cleared yesterday.', 'The mark is registrable.', 'It is available for registration.', 'It is safe to file.', 'It will register.']) {
    assert.equal(forbiddenPhrases(p).length, 1, p);
  }
  assert.deepEqual(forbiddenPhrases('An uncleared backlog; nuclear war.'), [], 'word boundaries');
  assert.deepEqual(lintValue({ a: ['fine', { b: 'it is clear' }] }).map((x) => x.path), ['$.a[1].b']);
});

test('the manual path: serial | mark | owner | status | classes | goods; a line without a serial is an error, the rest parse', () => {
  const { rows, errors } = parseManualRows([
    'SN 90562533 | EQUASITE | Equasite, Inc. | LIVE registered | 42 | Software as a service',
    '',
    'EQUALL | Equall Inc.',
    '98137428|EQUALL|Equall Inc.|pending|9, 42|AI | chatbot',
  ].join('\n'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].classes, ['042']);
  assert.equal(rows[0].live, true);
  assert.equal(rows[1].goods, 'AI | chatbot', 'a pipe inside goods is kept');
  assert.deepEqual(errors.map((e) => e.line), [3]);
  assert.deepEqual(parseClasses('IC 009, 042; A B 200'), ['009', '042', 'A', 'B', '200']);
  assert.equal(liveFromStatus('DEAD'), false);
  assert.equal(liveFromStatus('Cancelled'), false);
  assert.equal(liveFromStatus('Live / Pending'), true);
  assert.equal(liveFromStatus('Unknown thing'), null);
});

test('the export mapper reads the hand-built CSV by header name; unknown headers go to raw', async () => {
  const bytes = fs.readFileSync(path.join(FIX, 'tmsearch-export-M-handbuilt.csv'));
  const out = await readExportFile(new Uint8Array(bytes), 'tmsearch-export-M-handbuilt.csv');
  assert.equal(out.rows.length, 5);
  assert.deepEqual(out.unknownHeaders, ['Attorney of Record']);
  assert.equal(out.mapped.serial, 'Serial Number');
  const equall = out.rows[0];
  assert.equal(equall.serial, '98137428');
  assert.equal(equall.mark, 'EQUALL');
  assert.deepEqual(equall.classes, ['009', '042']);
  assert.equal(equall.filing_date, '2023-08-14');
  assert.equal(equall.raw['Attorney of Record'], '[M] hand-built');
  assert.equal(out.rows[3].live, false, 'DEAD in the Live/Dead column');
  assert.equal(summarizeRun({ source: 'export', reported_count: 5, rows: out.rows }).gap, true, 'the duplicated EQUALL row is an overlap');
});

test('an export with no serial column is a clear error, never a silent zero-row run', async () => {
  const bytes = fs.readFileSync(path.join(FIX, 'export-no-serial.csv'));
  await assert.rejects(() => readExportFile(new Uint8Array(bytes), 'export-no-serial.csv'), (e) => e instanceof ExportFormatError && /No serial-number column/.test(e.message));
  assert.throws(() => mapExportTable([]), ExportFormatError);
  const synonyms = mapExportTable([['SN', 'Wordmark', 'Owner Name', 'LD', 'IC', 'GS'], ['90562533', 'EQUASITE', 'Equasite', 'LIVE', '042', 'SaaS']]);
  assert.equal(synonyms.rows[0].mark, 'EQUASITE');
  assert.equal(synonyms.rows[0].goods, 'SaaS');
});

// ---------------------------------------------------------------------------
// The model, stubbed
// ---------------------------------------------------------------------------
const toolAnswer = (input) => ({ content: [{ type: 'tool_use', name: 'x', input }], usage: { input_tokens: 1, output_tokens: 1 } });

test('triage: the model is reached only through send, with the feature label; a proposal that says "clear" is discarded before storage', async () => {
  const { clearance, queries, runs } = buildFixture();
  const { live } = splitLiveDead(collectHits(queries, runs));
  const calls = [];
  const send = async ({ feature, body }) => {
    calls.push({ feature, body: JSON.parse(body) });
    const asked = JSON.parse(body).messages[0].content.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).serial);
    return toolAnswer({ hits: asked.map((serial) => ({
      serial,
      similarity: { score: 4, reason: serial === '99887921' ? 'Different goods, so the mark is clear.' : 'shared opening' },
      relatedness: { score: 9, reason: 'software' },
      bin: serial === '99887921' ? 'dismiss' : 'flag',
    })).concat([{ serial: '12345678', similarity: { score: 1, reason: 'x' }, relatedness: { score: 1, reason: 'x' }, bin: 'note' }]) });
  };
  const res = await proposeTriage({ clearance, hits: live, send, now: () => '2026-10-18T00:00:00Z' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].feature, 'trademark.triage');
  assert.equal(calls[0].body.model, 'claude-opus-5-5');
  assert.equal(calls[0].body.tool_choice.type, 'auto', 'Opus 5.5 refuses a named tool_choice');
  assert.ok(!res.proposals.some((p) => p.serial === '99887921'), 'the "clear" proposal is not stored');
  assert.ok(res.discarded.some((d) => d.serial === '99887921' && /is clear/.test(d.reason)));
  assert.ok(res.discarded.some((d) => d.serial === '12345678'), 'a serial that was not asked about is discarded');
  const equall = res.proposals.find((p) => p.serial === '98137428');
  assert.equal(equall.proposed.relatedness.score, 5, 'scores are clamped to 1–5');
  assert.equal(equall.proposed.model, 'claude-opus-5-5');
  assert.equal(equall.proposed.at, '2026-10-18T00:00:00Z');
});

test('triage is batched at most 25 hits per call', async () => {
  const hits = Array.from({ length: 60 }, (_, i) => ({ serial: String(90000000 + i), mark: `EQUA${i}`, classes: ['009'] }));
  let n = 0;
  const sizes = [];
  const send = async ({ body }) => {
    n++;
    const lines = JSON.parse(body).messages[0].content.split('\n').filter((l) => l.startsWith('{'));
    sizes.push(lines.length);
    return toolAnswer({ hits: [] });
  };
  await proposeTriage({ clearance: golden.clearance, hits, send });
  assert.equal(TRIAGE_BATCH, 25);
  assert.equal(n, 3);
  assert.deepEqual(sizes, [25, 25, 10]);
});

test('decompose and classes: shape-checked, linted, labelled', async () => {
  const c = golden.clearance;
  const d = await proposeDecomposition({ clearance: c, send: async ({ feature }) => {
    assert.equal(feature, 'trademark.decompose');
    return toolAnswer({ opening: 'EQUA', hinge: 'z', ending: 'ia', reason: 'the Z is the hinge', foreign: [{ word: 'equazione', language: 'Italian', meaning: 'equation' }] });
  } });
  assert.deepEqual([d.opening, d.hinge, d.ending], ['equa', 'z', 'ia']);
  await assert.rejects(() => proposeDecomposition({ clearance: c, send: async () => toolAnswer({ opening: 'eq', hinge: 'z', ending: 'ia', reason: '', foreign: [] }) }), /did not fit the mark/);
  await assert.rejects(() => proposeDecomposition({ clearance: c, send: async () => toolAnswer({ opening: 'equa', hinge: 'z', ending: 'ia', reason: 'This mark is registrable.', foreign: [] }) }), /discarded/);
  const cl = await proposeClasses({ clearance: c, send: async ({ feature }) => {
    assert.equal(feature, 'trademark.classes');
    return toolAnswer({ search: [{ code: '9', reason: 'software' }, { code: '042', reason: 'SaaS' }, { code: '042', reason: 'dup' }], filing: [{ code: '042', reason: 'dated plan' }, { code: '045', reason: 'not searched' }] });
  } });
  assert.deepEqual(cl.search.map((x) => x.code), ['009', '042']);
  assert.deepEqual(cl.filing.map((x) => x.code), ['042'], 'a filing class outside the search classes is dropped');
});

test('the three feature labels are in the Record\'s list', () => {
  for (const f of Object.values(FEATURES)) assert.ok(LLM_FEATURES.includes(f), f);
});

// ---------------------------------------------------------------------------
// The server action (lib/trademark/actions.mjs) against a stub Supabase client
// ---------------------------------------------------------------------------
import { runTrademarkAction, TrademarkActionError, NOT_READY_MESSAGE } from '../lib/trademark/actions.mjs';

function stubSb({ clearance, hits = [], canWrite = true, missing = false }) {
  const updates = [];
  const from = (table) => {
    const q = { table, filters: {}, patch: null };
    const api = {
      select() { return api; },
      eq(k, v) { q.filters[k] = v; return api; },
      order() { return api; },
      update(p) { q.patch = p; return api; },
      async maybeSingle() {
        if (missing) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.tm_clearances' in the schema cache" } };
        return { data: clearance && clearance.id === q.filters.id ? clearance : null, error: null };
      },
      then(resolve) {
        if (q.patch) {
          const h = hits.find((x) => x.serial === q.filters.serial);
          if (h) { Object.assign(h, q.patch); updates.push({ serial: h.serial, patch: q.patch }); }
          return resolve({ data: h ? [{ serial: h.serial }] : [], error: null });
        }
        return resolve({ data: hits, error: null });
      },
    };
    return api;
  };
  return { from, rpc: async () => ({ data: canWrite, error: null }), updates };
}

const CID = '6b0c1e7e-0000-4000-8000-0000000000c1';
const MID = '6b0c1e7e-0000-4000-8000-0000000000a1';

test('the triage action stores proposals (never a bin), records one tm.hit.proposed per hit with metadata only, and keeps a "clear" proposal out', async () => {
  const hits = [
    { serial: '98137428', mark: 'EQUALL', status_text: 'LIVE', live: true, classes: ['009'], bin: null, proposed: null },
    { serial: '99887921', mark: 'YUEQUAZELL', status_text: 'LIVE', live: true, classes: ['014'], bin: null, proposed: null },
    { serial: '98137417', mark: 'EQUALL COPILOT', status_text: 'DEAD', live: false, classes: [], bin: null, proposed: null },
    { serial: '90562533', mark: 'EQUASITE', status_text: 'LIVE', live: true, classes: ['042'], bin: 'flag', proposed: null },
  ];
  const sb = stubSb({ clearance: { id: CID, matterspace_id: MID, mark: 'EQUAZIA', search_classes: [], filing_classes: [] }, hits });
  const recorded = [];
  const sent = [];
  const send = async (req) => {
    sent.push(req);
    return toolAnswer({ hits: [
      { serial: '98137428', similarity: { score: 4, reason: 'shared opening' }, relatedness: { score: 5, reason: 'AI software' }, bin: 'flag' },
      { serial: '99887921', similarity: { score: 2, reason: 'so this one is cleared' }, relatedness: { score: 1, reason: 'jewelry' }, bin: 'dismiss' },
    ] });
  };
  const out = await runTrademarkAction({ action: 'triage', args: { clearance_id: CID }, sb, userId: 'u1', send, record: async (_c, ev) => { recorded.push(ev); } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].matterId, MID, 'the matter rides in the envelope, for the gate and the Record');
  assert.equal(sent[0].feature, 'trademark.triage');
  const asked = JSON.parse(sent[0].body).messages[0].content;
  assert.ok(asked.includes('98137428') && asked.includes('99887921'));
  assert.ok(!asked.includes('98137417'), 'a dead record is not sent for scoring');
  assert.ok(!asked.includes('90562533'), 'a decided hit is not re-proposed');
  assert.equal(out.proposed, 1);
  assert.ok(out.discarded.some((d) => d.serial === '99887921'));
  assert.equal(sb.updates.length, 1);
  assert.deepEqual(Object.keys(sb.updates[0].patch), ['proposed'], 'only the proposal is written; the bin stays the reviewer\'s');
  assert.equal(hits[0].bin, null);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, 'tm.hit.proposed');
  assert.deepEqual(recorded[0].payload, { clearance_id: CID, serial: '98137428', bin: 'flag', model: 'claude-opus-5-5' });
  assert.equal(recorded[0].matterId, MID);
});

test('the action refuses a reader, an unknown clearance, a bad id, and says so before 121 is applied', async () => {
  const c = { id: CID, matterspace_id: MID, mark: 'EQUAZIA' };
  const run = (sb, args = { clearance_id: CID }, action = 'decompose') =>
    runTrademarkAction({ action, args, sb, userId: 'u1', send: async () => { throw new Error('the model must not be called'); }, record: async () => {} });
  await assert.rejects(() => run(stubSb({ clearance: c, canWrite: false })), (e) => e instanceof TrademarkActionError && e.status === 403);
  await assert.rejects(() => run(stubSb({ clearance: null })), (e) => e.status === 404);
  await assert.rejects(() => run(stubSb({ clearance: c }), { clearance_id: 'x' }), (e) => e.status === 400);
  await assert.rejects(() => run(stubSb({ clearance: c }), { clearance_id: CID }, 'guess'), (e) => e.status === 400);
  await assert.rejects(() => run(stubSb({ clearance: c, missing: true })), (e) => e.status === 503 && e.message === NOT_READY_MESSAGE);
});

test('a proposal request offers the tool without naming it, asks again once when no tool call comes back, and turns a provider refusal into a plain sentence', async () => {
  const c = { id: CID, matterspace_id: MID, mark: 'EQUORIUM', goods_services: 'Online game platform.' };
  const toolReply = { content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', name: 'propose_classes', input: { search: [{ code: '41', reason: 'games' }], filing: [{ code: '41', reason: 'games' }] } }] };
  const textReply = { content: [{ type: 'text', text: 'Here are my thoughts.' }] };

  const bodies = [];
  const replies = [textReply, toolReply];
  const out = await proposeClasses({ clearance: c, send: async ({ body }) => { bodies.push(JSON.parse(body)); return replies.shift(); } });
  assert.equal(bodies.length, 2, 'a reply without the tool call is asked once more');
  assert.deepEqual(bodies[0].tool_choice, { type: 'auto' });
  assert.deepEqual(out.search.map((x) => x.code), ['041']);

  await assert.rejects(
    () => proposeClasses({ clearance: c, send: async () => textReply }),
    (e) => e.name === 'TrademarkModelError' && /fill this step in by hand/.test(e.message) && !/400/.test(e.message),
  );

  const refused = Object.assign(new Error('The model answered 400.'), { status: 400, code: 'provider_error' });
  await assert.rejects(
    () => proposeDecomposition({ clearance: c, send: async () => { throw refused; } }),
    (e) => e.name === 'TrademarkModelError' && e.status === 502 && !/answered 400/.test(e.message),
  );

  const budget = Object.assign(new Error('This month\'s AI allowance is used up.'), { status: 402, code: 'budget_exhausted' });
  await assert.rejects(() => proposeClasses({ clearance: c, send: async () => { throw budget; } }), (e) => e === budget);
});

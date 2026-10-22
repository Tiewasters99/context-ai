// lib/trademark/register/recall.mjs — the recall gate (phase 3).
//
// The one failure that matters is a live conflict tmsearch finds and the copy
// does not. The gate measures exactly that, on a test set Eden (or a
// paralegal) builds once on tmsearch and keeps:
//
//   TEST-SET FORMAT  (format "equazia-tm-recall/1", JSON; see
//   scripts/fixtures/tm-register/recall-seed-2026-10-21.json)
//     { format, name, notes[], marks: [ {
//         mark, real (true = a real proposed mark, false = invented),
//         decomposition {opening, hinge, ending}, search_classes ["009", …],
//         known_marks [{name, owner}], foreign_equivalents [], exclusions? [],
//         tmsearch: {
//           run_on "YYYY-MM-DD", by,
//           live_conflicts [{serial, mark, why}],   ← the gate's measure
//           queries? [{query, reported_count, serials[]}]  ← optional diagnostics
//         } } ] }
//
//   RUN   for each mark: generate the agent's query set from the mark's inputs
//         (the same generateQueries the agent uses), run every query on the
//         copy, union what it found. A MISS is a live conflict tmsearch found
//         that no query on the copy returned. Optional diagnostics: each
//         recorded tmsearch query is also run on the copy as written, and the
//         serials tmsearch returned that the copy did not are listed (they do
//         not fail the gate by themselves; a live conflict among them does).
//
//   PASS  zero misses AND at least `minMarks` marks (default 50). The result
//         is appended to register_gate with the test set's sha256, its mark
//         count, the engine version and the copy's as-of date. The copy stands
//         on its own only while the LATEST run for the CURRENT engine passed
//         (meta.mjs gateState); every other state is "preliminary".

import crypto from 'node:crypto';
import { generateQueries } from '../queries.mjs';
import { canonicalJson } from '../procedure.mjs';
import { runQuery, expressible, ENGINE_VERSION, MAX_ROWS } from './search.mjs';
import { DEFAULT_MIN_MARKS } from './meta.mjs';

export const TEST_SET_FORMAT = 'equazia-tm-recall/1';

export function testSetHash(set) {
  return crypto.createHash('sha256').update(canonicalJson(set)).digest('hex');
}

/** What is wrong with a test set, as sentences (empty = usable). */
export function testSetProblems(set) {
  const out = [];
  if (!set || typeof set !== 'object') return ['The test set is not a JSON object.'];
  if (set.format !== TEST_SET_FORMAT) out.push(`format must be "${TEST_SET_FORMAT}".`);
  if (!Array.isArray(set.marks) || !set.marks.length) out.push('marks must be a non-empty list.');
  for (const [i, m] of (set.marks ?? []).entries()) {
    const at = `marks[${i}] (${m?.mark ?? '?'})`;
    if (!m?.mark) out.push(`${at}: mark is required.`);
    if (!m?.decomposition?.opening || !m?.decomposition?.ending) out.push(`${at}: decomposition {opening, hinge, ending} is required.`);
    if (!Array.isArray(m?.tmsearch?.live_conflicts)) out.push(`${at}: tmsearch.live_conflicts must be a list (empty when tmsearch found none).`);
    for (const c of m?.tmsearch?.live_conflicts ?? []) if (!/^\d{8}$/.test(String(c?.serial ?? ''))) out.push(`${at}: a live conflict needs an 8-digit serial.`);
  }
  return out;
}

/**
 * Run the test set on the copy.
 * @returns {Promise<{passed:boolean, recall_ok:boolean, marks:number, min_marks:number, conflicts:number, misses:number, per_mark:object[], hash:string, engine_version:string, as_of:string|null}>}
 */
export async function runRecall(db, set, { minMarks = DEFAULT_MIN_MARKS, asOf = null } = {}) {
  const problems = testSetProblems(set);
  if (problems.length) throw new Error(`The test set is not usable: ${problems.join(' ')}`);
  const per = [];
  let conflicts = 0; let misses = 0;
  for (const m of set.marks) {
    const { queries } = generateQueries({
      mark: m.mark, decomposition: m.decomposition, searchClasses: m.search_classes ?? [],
      knownMarks: m.known_marks ?? [], foreignEquivalents: m.foreign_equivalents ?? [],
      exclusions: m.exclusions?.length ? m.exclusions : null,
    });
    const found = new Map(); // serial → [Qn]
    const notRun = [];
    const capped = [];
    for (const q of queries) {
      if (q.purpose === 'selftest') continue; // Q0 finds its own known record; it is not a search for conflicts
      const ex = expressible(q.query);
      if (!ex.ok) { notRun.push({ seq: q.seq, query: q.query, reason: ex.reason }); continue; }
      const r = await runQuery(db, q.query, { mark: m.mark, searchClasses: m.search_classes ?? [], limit: MAX_ROWS });
      if (r.count > r.rows.length) capped.push({ seq: q.seq, count: r.count, returned: r.rows.length });
      // For recall the whole match set counts, not the first 500: read the serials beyond the cap.
      const serials = r.count > r.rows.length ? await allSerials(db, q.query) : r.rows.map((x) => x.serial);
      for (const s of serials) found.set(s, [...(found.get(s) ?? []), `Q${q.seq}`]);
    }
    const lc = m.tmsearch.live_conflicts;
    const missed = lc.filter((c) => !found.has(String(c.serial)));
    conflicts += lc.length; misses += missed.length;
    const diagnostics = [];
    for (const tq of m.tmsearch.queries ?? []) {
      const ex = expressible(tq.query);
      if (!ex.ok) { diagnostics.push({ query: tq.query, not_expressible: ex.reason }); continue; }
      const got = new Set(await allSerials(db, tq.query));
      const tmSerials = (tq.serials ?? []).map(String);
      const absent = tmSerials.filter((s) => !got.has(s));
      const extra = [...got].filter((s) => !tmSerials.includes(s));
      diagnostics.push({
        query: tq.query, tmsearch_reported: tq.reported_count ?? null, tmsearch_rows: tmSerials.length, copy_count: got.size,
        tmsearch_only: absent.length, copy_only: extra.length, tmsearch_only_serials: absent.slice(0, 200),
      });
    }
    per.push({
      mark: m.mark, real: m.real !== false, live_conflicts: lc.length,
      found: lc.filter((c) => found.has(String(c.serial))).map((c) => ({ serial: c.serial, mark: c.mark, by: found.get(String(c.serial)) })),
      misses: missed.map((c) => ({ serial: c.serial, mark: c.mark ?? null })),
      not_run: notRun, capped, diagnostics,
    });
  }
  const recallOk = misses === 0;
  const marks = set.marks.length;
  return {
    passed: recallOk && marks >= minMarks, recall_ok: recallOk, marks, min_marks: minMarks,
    conflicts, misses, per_mark: per, hash: testSetHash(set), engine_version: ENGINE_VERSION, as_of: asOf,
  };
}

async function allSerials(db, query) {
  const { parseQuery, toSql } = await import('./search.mjs');
  const { sql, params } = toSql(parseQuery(query));
  return (await db.query(`select r.serial from register_records r where ${sql}`, params)).rows.map((r) => r.serial);
}

/** Append the result to register_gate (append-only). */
export async function storeRecall(db, result) {
  const { rows } = await db.query(
    `insert into register_gate (test_set_sha256, test_set_marks, min_marks, engine_version, as_of, conflicts, misses, passed, report)
     values ($1, $2, $3, $4, $5::date, $6, $7, $8, $9::jsonb) returning id, run_at`,
    [result.hash, result.marks, result.min_marks, result.engine_version, result.as_of, result.conflicts, result.misses, result.passed,
      JSON.stringify({ recall_ok: result.recall_ok, per_mark: result.per_mark.map((p) => ({ mark: p.mark, misses: p.misses, not_run: p.not_run })) })],
  );
  return rows[0];
}

/** The plain-text report: per-mark misses and the verdict. */
export function recallReport(r) {
  const lines = [];
  lines.push(`Recall test — engine ${r.engine_version}, copy as of ${r.as_of ?? 'unknown'}, test set ${r.hash.slice(0, 12)} (${r.marks} mark${r.marks === 1 ? '' : 's'}).`);
  for (const p of r.per_mark) {
    lines.push('');
    lines.push(`${p.mark}${p.real ? '' : ' (invented)'}: ${p.live_conflicts} live conflict${p.live_conflicts === 1 ? '' : 's'} on tmsearch; ${p.misses.length} missed by the copy.`);
    for (const f of p.found) lines.push(`  found   ${f.serial} ${f.mark ?? ''} by ${f.by.join(', ')}`);
    for (const x of p.misses) lines.push(`  MISSED  ${x.serial} ${x.mark ?? ''}`);
    for (const n of p.not_run) lines.push(`  not run Q${n.seq} (${n.reason})`);
    for (const c of p.capped) lines.push(`  capped  Q${c.seq}: ${c.count} matches, a run records the first ${c.returned} (a gap)`);
    for (const d of p.diagnostics) {
      if (d.not_expressible) { lines.push(`  diag    ${d.query}: not expressible (${d.not_expressible})`); continue; }
      lines.push(`  diag    ${d.query}: tmsearch ${d.tmsearch_rows}${d.tmsearch_reported != null ? ` (reported ${d.tmsearch_reported})` : ''}, copy ${d.copy_count}; tmsearch only ${d.tmsearch_only}, copy only ${d.copy_only}`);
    }
  }
  lines.push('');
  if (!r.recall_ok) lines.push(`FAIL: ${r.misses} live conflict${r.misses === 1 ? '' : 's'} tmsearch found ${r.misses === 1 ? 'was' : 'were'} missed.`);
  else if (r.marks < r.min_marks) lines.push(`NOT A PASS: no live conflict was missed, but the set has ${r.marks} mark${r.marks === 1 ? '' : 's'} and the gate needs at least ${r.min_marks}.`);
  else lines.push(`PASS: every one of the ${r.conflicts} live conflicts tmsearch found was found on the copy.`);
  return lines.join('\n');
}

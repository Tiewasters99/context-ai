// lib/trademark/register/service.mjs — stage 4 on Equazia's copy of the
// register, for both doors: the browser (api/trademark.mjs, actions
// register_status / register_search) and the connector (tm_run_search in
// lib/trademark/connector.mjs).
//
// Every write runs on the CALLER'S OWN user-scoped Supabase client, so 121's
// RLS decides, exactly as for a run the person records from tmsearch. A run
// from the copy goes into the same append-only run log (tm_query_runs) with
// source 'register_copy', the copy's as-of date and the preliminary flag
// (migration 123); the database computes captured_count and the gap.
//
// storeRun() is the one sequence every recorded run follows (insert → read
// back the database's count and gap → collect the hits → upsert them → the
// self-test flag), shared with tm_record_results so the two cannot drift.

import { collectHits, latestRuns } from '../triage.mjs';
import { MAX_ROWS, runQuery, expressible } from './search.mjs';
import { openRegisterDb, registerDbUrl } from './db.mjs';

export const REGISTER_SOURCE = 'register_copy';

/** Whether a 123-less database refused a register run (the column or the source is unknown). */
export function isMigration123Missing(error) {
  const m = String(error?.message ?? '');
  return /register_as_of|register_preliminary|tm_query_runs_source_check/.test(m);
}
export const MIGRATION_123_MISSING =
  'This workspace\'s database does not record register-copy runs yet (migration 123 has not been applied). Run the queries on tmsearch.';

/**
 * Record one run and fold its rows into the hits.
 * @param {object} sb  the caller's client
 * @param {{clearance:object, queries:object[], runs:object[]}} b
 * @param {object} q   the query row
 * @param {{source:string, reported:number|null, rows:object[], gapNote?:string|null, exportDocumentId?:string|null, runBy:string, register?:{asOf:string, preliminary:boolean}|null}} input
 * @param {(message:string, code:string)=>Error} err
 * @returns {Promise<{stored:object, runs:object[]}>}
 */
export async function storeRun(sb, b, q, { source, reported, rows, gapNote = null, exportDocumentId = null, runBy, register = null }, err) {
  const runId = globalThis.crypto.randomUUID();
  const row = {
    id: runId, query_id: q.id, source, reported_count: reported, raw: rows,
    gap_note: gapNote, export_document_id: exportDocumentId, run_by: runBy,
  };
  // Only a register run names the 123 columns, so every other run is the
  // exact insert it was before 123 (and works on a database without it).
  if (register) { row.register_as_of = register.asOf; row.register_preliminary = Boolean(register.preliminary); }
  const { error } = await sb.from('tm_query_runs').insert(row);
  if (error) {
    if (register && isMigration123Missing(error)) throw err(MIGRATION_123_MISSING, 'not_ready');
    throw err(`Could not record the run: ${error.message}`, 'write_failed');
  }
  const cols = `id, run_at, source, reported_count, captured_count, gap, gap_note${register ? ', register_as_of, register_preliminary' : ''}`;
  const { data: stored, error: readErr } = await sb.from('tm_query_runs').select(cols).eq('id', runId).maybeSingle();
  if (readErr || !stored) throw err('The run was recorded but could not be read back.', 'read_failed');

  const runs = [...b.runs, { ...stored, query_id: q.id, raw: rows }];
  const hits = collectHits(b.queries, runs);
  for (let i = 0; i < hits.length; i += MAX_ROWS) {
    const chunk = hits.slice(i, i + MAX_ROWS).map((h) => ({ ...h, clearance_id: b.clearance.id }));
    const { error: hitErr } = await sb.from('tm_hits').upsert(chunk, { onConflict: 'clearance_id,serial' });
    if (hitErr) throw err(`The run was recorded, but its records could not be added to the hits: ${hitErr.message}`, 'write_failed');
  }
  if (q.purpose === 'selftest') {
    await sb.from('tm_clearances').update({ self_test_passed: source !== 'failed' && stored.captured_count === 1 }).eq('id', b.clearance.id);
  }
  return { stored, runs };
}

/** The register copy for this server: its status, and its database when it is offered. */
export function registerAccess({ env = process.env, status, db } = {}) {
  return {
    configured: Boolean(registerDbUrl(env) || db),
    status: async (day) => {
      const { registerStatus } = await import('./meta.mjs');
      return status ? status(day) : registerStatus({ env, db, ...(day ? { today: day } : {}) });
    },
    db: async () => db ?? openRegisterDb(registerDbUrl(env)),
  };
}

/** The queries whose CURRENT run is a preliminary register-copy run. */
export function preliminaryQueries(queries, runs) {
  const latest = latestRuns(runs);
  return [...queries].sort((a, b) => a.seq - b.seq).filter((q) => {
    const r = latest.get(q.id);
    return r && r.source === REGISTER_SOURCE && r.register_preliminary === true;
  });
}

/**
 * Run queries of one clearance on the copy and record each as a run.
 * @param {{sb:object, bundle:object, status:object, db:object, queryIds?:string[]|null, runBy:string,
 *          err:(m:string,c:string)=>Error, onRun?:(q:object, stored:object)=>Promise<void>, budgetMs?:number}} o
 * @returns {Promise<{runs:object[], not_run:object[], skipped:object[], out_of_time:string[]}>}
 */
export async function registerSearch({ sb, bundle, status, db, queryIds = null, runBy, err, onRun, budgetMs = 40_000 }) {
  const started = Date.now();
  const latest = latestRuns(bundle.runs);
  const ordered = [...bundle.queries].sort((a, b) => a.seq - b.seq);
  let targets;
  if (Array.isArray(queryIds) && queryIds.length) {
    const want = new Set(queryIds.map(String));
    targets = ordered.filter((q) => want.has(q.id) || want.has(`Q${q.seq}`) || want.has(String(q.seq)));
    const missing = [...want].filter((x) => !targets.some((q) => q.id === x || `Q${q.seq}` === x || String(q.seq) === x));
    if (missing.length) throw err(`Not queries of this clearance: ${missing.join(', ')} (tm_get_clearance lists them).`, 'not_found');
  } else {
    targets = ordered.filter((q) => !latest.has(q.id)); // every query not run yet, from any source
  }
  const searchClasses = (bundle.clearance.search_classes ?? []).map((x) => x.code);
  const preliminary = !status.gate?.passed;
  const runs = []; const notRun = []; const outOfTime = [];
  let b = bundle;
  for (const q of targets) {
    if (Date.now() - started > budgetMs) { outOfTime.push(`Q${q.seq}`); continue; }
    const ex = expressible(q.query);
    if (!ex.ok) { notRun.push({ query_id: q.id, seq: q.seq, label: `Q${q.seq}`, query: q.query, reason: ex.reason }); continue; }
    const r = await runQuery(db, q.query, { mark: b.clearance.mark, searchClasses, asOf: status.as_of });
    const note = r.count > r.rows.length
      ? `the copy matched ${r.count}; the ${r.rows.length} closest were recorded (the run log holds ${MAX_ROWS} at most)`
      : null;
    const { stored, runs: after } = await storeRun(sb, b, q, {
      source: REGISTER_SOURCE, reported: r.count, rows: r.rows, gapNote: note, runBy,
      register: { asOf: status.as_of, preliminary },
    }, err);
    b = { ...b, runs: after };
    runs.push({
      query_id: q.id, seq: q.seq, label: `Q${q.seq}`, purpose: q.purpose, run_id: stored.id,
      reported_count: stored.reported_count, captured_count: stored.captured_count, gap: stored.gap, gap_note: stored.gap_note,
      register_as_of: status.as_of, preliminary,
    });
    if (typeof onRun === 'function') await onRun(q, stored, { preliminary });
  }
  return { runs, not_run: notRun, out_of_time: outOfTime };
}

/** The report's source paragraph for the runs from the copy (null when there are none). */
export function registerSourceLines(runs) {
  const reg = (runs ?? []).filter((r) => r.source === REGISTER_SOURCE);
  if (!reg.length) return null;
  const dates = [...new Set(reg.map((r) => String(r.register_as_of ?? '').slice(0, 10)).filter(Boolean))].sort();
  const prelim = reg.some((r) => r.register_preliminary === true);
  return { dates, preliminary: prelim, count: reg.length };
}

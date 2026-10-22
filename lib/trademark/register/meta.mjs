// lib/trademark/register/meta.mjs — is the register copy usable, and how far.
//
// Three rules, each a pure function (unit-tested), and one reader:
//
//   STALE   the copy is stale when it has no as-of date, or when today is more
//           than `staleAfterDays` days after it (default 3; register_meta
//           stale_after_days, or TM_REGISTER_STALE_DAYS). A stale copy is not
//           offered: the agent falls back to tmsearch with a plain sentence.
//   GATE    the copy may stand on its own (no "confirm on tmsearch") only when
//           the LATEST recall-gate run for the CURRENT engine version passed,
//           on a test set of at least `minMarks` marks (default 50). Anything
//           else (no run, a failed latest run, an older engine, a small seed
//           set) = preliminary.
//   OFFER   configured + reachable + not stale → the copy is offered at stage 4;
//           it is the DEFAULT only when the gate has passed.
//
// The reader never throws: a copy that cannot be reached reports itself
// unavailable with the reason.

import { ENGINE_VERSION } from './search.mjs';
import { openRegisterDb, registerDbUrl } from './db.mjs';

export const DEFAULT_STALE_DAYS = 3;
export const DEFAULT_MIN_MARKS = 50;

export const PRELIMINARY_LABEL = 'preliminary: confirm on tmsearch';
export const NOT_AVAILABLE = 'Equazia\'s copy of the register is not available on this server. Run the queries on tmsearch.';

const DAY = 86_400_000;

/** Whole days from `asOf` (YYYY-MM-DD) to `today` (YYYY-MM-DD). */
export function daysBehind(asOf, today) {
  const a = Date.parse(`${asOf}T00:00:00Z`); const t = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(t)) return null;
  return Math.round((t - a) / DAY);
}

/** The stale rule. */
export function isStale(asOf, today, staleAfterDays = DEFAULT_STALE_DAYS) {
  if (!asOf) return true;
  const d = daysBehind(asOf, today);
  return d == null || d > staleAfterDays;
}

/**
 * The gate rule. `runs` are register_gate rows, any order.
 * @returns {{passed:boolean, reason:string, run:object|null}}
 */
export function gateState(runs, { engineVersion = ENGINE_VERSION, minMarks = DEFAULT_MIN_MARKS } = {}) {
  const mine = (runs ?? []).filter((r) => r.engine_version === engineVersion)
    .sort((a, b) => String(b.run_at).localeCompare(String(a.run_at)) || Number(b.id ?? 0) - Number(a.id ?? 0));
  const last = mine[0] ?? null;
  if (!last) return { passed: false, reason: `the recall test has not been run on this engine (${engineVersion})`, run: null };
  if (!last.passed) return { passed: false, reason: `the latest recall test missed ${last.misses} live conflict${last.misses === 1 ? '' : 's'} tmsearch found`, run: last };
  if (Number(last.test_set_marks) < minMarks) {
    return { passed: false, reason: `the latest recall test used ${last.test_set_marks} mark${Number(last.test_set_marks) === 1 ? '' : 's'}; the gate needs at least ${minMarks}`, run: last };
  }
  return { passed: true, reason: `recall test passed on ${String(last.run_at).slice(0, 10)} (${last.test_set_marks} marks, test set ${String(last.test_set_sha256).slice(0, 12)}, copy as of ${last.as_of ? String(last.as_of).slice(0, 10) : '?'})`, run: last };
}

/** The OFFER rule. */
export function offerState({ configured, reachable, stale, gate }) {
  if (!configured) return { offered: false, default: false, message: NOT_AVAILABLE };
  if (!reachable) return { offered: false, default: false, message: 'Equazia\'s copy of the register cannot be reached right now. Run the queries on tmsearch.' };
  if (stale) return { offered: false, default: false, message: 'Equazia\'s copy of the register is out of date (its last update is too old), so it is not offered. Run the queries on tmsearch.' };
  return { offered: true, default: Boolean(gate?.passed), message: gate?.passed ? null : `Results from the copy are ${PRELIMINARY_LABEL} (${gate?.reason ?? 'the recall test has not passed'}).` };
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The copy's status, for the stage-4 choice, the connector and the report.
 * @param {{env?:object, today?:string, db?:object}} [o]  db: an open adapter (tests)
 */
export async function registerStatus({ env = process.env, today: day = today(), db } = {}) {
  const url = registerDbUrl(env);
  const base = { configured: Boolean(url || db), reachable: false, as_of: null, stale: true, days_behind: null, stale_after_days: DEFAULT_STALE_DAYS, gate: { passed: false, reason: 'not configured', run: null }, engine_version: ENGINE_VERSION, records: null };
  if (!url && !db) return { ...base, ...offerState({ configured: false }) };
  let handle = db;
  try {
    handle ??= await openRegisterDb(url);
    const meta = await handle.query('select key, value from register_meta');
    const m = Object.fromEntries(meta.rows.map((r) => [r.key, r.value]));
    const envDays = Number(env?.TM_REGISTER_STALE_DAYS);
    const staleAfter = Number.isFinite(envDays) && envDays >= 0 ? envDays : Number.isFinite(Number(m.stale_after_days)) ? Number(m.stale_after_days) : DEFAULT_STALE_DAYS;
    const minEnv = Number(env?.TM_REGISTER_GATE_MIN_MARKS);
    const minMarks = Number.isInteger(minEnv) && minEnv > 0 ? minEnv : DEFAULT_MIN_MARKS;
    const runs = (await handle.query('select id, run_at, test_set_sha256, test_set_marks, engine_version, as_of, misses, passed from register_gate')).rows
      .map((r) => ({ ...r, run_at: r.run_at instanceof Date ? r.run_at.toISOString() : String(r.run_at), as_of: r.as_of instanceof Date ? r.as_of.toISOString().slice(0, 10) : r.as_of }));
    const asOf = m.as_of ?? null;
    const gate = gateState(runs, { minMarks });
    const stale = isStale(asOf, day, staleAfter);
    const status = {
      ...base, reachable: true, as_of: asOf, stale, days_behind: asOf ? daysBehind(asOf, day) : null,
      stale_after_days: staleAfter, gate: { passed: gate.passed, reason: gate.reason, run: gate.run ? {
        run_at: gate.run.run_at, test_set_sha256: gate.run.test_set_sha256, test_set_marks: Number(gate.run.test_set_marks), as_of: gate.run.as_of, passed: gate.run.passed,
      } : null }, min_marks: minMarks,
    };
    return { ...status, ...offerState({ configured: true, reachable: true, stale, gate }) };
  } catch (err) {
    return { ...base, error: String(err?.message ?? err).slice(0, 300), ...offerState({ configured: true, reachable: false }) };
  }
}

// lib/trademark/triage.mjs — what the runs found, deterministically (spec §2
// stages 4–5, §3 Q8, §4 "Code (no model)").
//
//   summarizeRun     captured count, gap and gap note for one run (the
//                    database computes the same; this is for the screen, at once)
//   selfTestState    passed / failed / not run, from Q0's latest run
//   latestRuns       the current run of each query (a re-run supersedes)
//   collectHits      every captured row across the current runs, deduplicated
//                    by serial, with the seqs that found it
//   isDead           a dead record: dropped from the scoring set, kept in the log
//   crowdedField     live hits in the search classes that start with the opening
//   proposeExclusions  Q8's candidate exclusions from Q7's captured marks
//   exclusionCheck   which exclusion would swallow a known mark or a flagged /
//                    noted hit (EQUALL under equal*) → rescued queries
//   gapLines         every gap, verbatim, for the report's "Limits"
//
// Nothing here calls a model or the network.

import { PROCEDURE } from './procedure.mjs';
import { liveFromStatus } from './parse.mjs';
import { markWords, normalizeTerm, termMatchesMark } from './queries.mjs';

/**
 * @param {{source:'manual'|'export'|'failed', reported_count:number|null, rows:{serial:string}[]}} run
 * @returns {{captured:number, gap:boolean, gapNote:string|null, duplicates:string[]}}
 */
export function summarizeRun({ source, reported_count: reported, rows = [] }) {
  const captured = source === 'failed' ? 0 : rows.length;
  const counts = new Map();
  for (const r of rows) counts.set(r.serial, (counts.get(r.serial) ?? 0) + 1);
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([s]) => s).sort();
  const notes = [];
  if (source === 'failed') notes.push('the run failed; this is not a "no results" run');
  if (reported == null && source !== 'failed') notes.push('no reported count was entered, so the capture cannot be checked');
  if (reported != null && source !== 'failed' && reported !== captured) notes.push(`tmsearch reported ${reported}; ${captured} captured`);
  if (duplicates.length) notes.push(`serial${duplicates.length > 1 ? 's' : ''} ${duplicates.join(', ')} repeated within the run (pagination overlap)`);
  return { captured, gap: notes.length > 0, gapNote: notes.length ? notes.join('; ') : null, duplicates };
}

/** The current run of each query: the latest by run_at. */
export function latestRuns(runs) {
  const by = new Map();
  for (const r of runs) {
    const cur = by.get(r.query_id);
    if (!cur || String(r.run_at) > String(cur.run_at)) by.set(r.query_id, r);
  }
  return by;
}

/**
 * Q0's state. Every later "no results" run is valid only when this passed.
 * @returns {'passed'|'failed'|'not_run'}
 */
export function selfTestState(queries, runs, expect = PROCEDURE.selftest.expect) {
  const q0 = queries.find((q) => q.purpose === 'selftest');
  if (!q0) return 'not_run';
  const run = latestRuns(runs).get(q0.id);
  if (!run) return 'not_run';
  return run.source !== 'failed' && run.captured_count === expect ? 'passed' : 'failed';
}

export const SELF_TEST_FAILED_WARNING = 'self-test failed; syntax or system change suspected';

/** A dead record: status says dead / abandoned / cancelled / expired, or live = false. */
export function isDead(hit) {
  if (hit.live === false) return true;
  return liveFromStatus(hit.status ?? hit.status_text) === false;
}

/**
 * The tm_hits column limits (migration 121). A real export carries wordmarks
 * longer than 500 characters (serial 77505378 in the 2026-10-18 EQUAZIA
 * sweep is 1,119: a list of statutes as a mark), and a row over the limit
 * fails the whole upsert. Clamp here, where every hit is built.
 */
export const HIT_LIMITS = Object.freeze({ registration_number: 20, mark: 500, owner: 500, status_text: 200, goods_services: 20000 });
const clip = (v, n) => (v == null ? null : String(v).length > n ? `${String(v).slice(0, n - 1)}…` : String(v));

/** A hit's text fields cut to what tm_hits accepts (an ellipsis marks a cut). */
export function clampHit(h) {
  const out = { ...h };
  for (const [k, n] of Object.entries(HIT_LIMITS)) if (out[k] != null) out[k] = clip(out[k], n);
  return out;
}

/**
 * Every captured row across the CURRENT run of each query, one per serial.
 * A later query's row fills fields an earlier one left empty; query_seqs
 * lists every query that found it. Text fields are clamped to tm_hits' limits.
 */
export function collectHits(queries, runs) {
  const seqOf = new Map(queries.map((q) => [q.id, q.seq]));
  const current = [...latestRuns(runs).values()].sort((a, b) => (seqOf.get(a.query_id) ?? 0) - (seqOf.get(b.query_id) ?? 0));
  const hits = new Map();
  for (const run of current) {
    if (run.source === 'failed') continue;
    const seq = seqOf.get(run.query_id);
    for (const r of run.raw ?? []) {
      if (!r?.serial) continue;
      const h = hits.get(r.serial) ?? {
        serial: r.serial, registration_number: null, mark: null, owner: null, status_text: null, live: null,
        classes: [], goods_services: null, filing_date: null, raw: {}, query_seqs: [],
      };
      h.registration_number ??= r.registration_number ?? null;
      h.mark ??= r.mark ?? null;
      h.owner ??= r.owner ?? null;
      h.status_text ??= r.status ?? null;
      if (h.live == null && typeof r.live === 'boolean') h.live = r.live;
      h.classes = [...new Set([...h.classes, ...(r.classes ?? [])])].sort();
      h.goods_services ??= r.goods ?? null;
      h.filing_date ??= r.filing_date ?? null;
      h.raw = { ...(r.raw ?? {}), ...h.raw };
      if (seq != null && !h.query_seqs.includes(seq)) h.query_seqs = [...h.query_seqs, seq].sort((a, b) => a - b);
      hits.set(r.serial, h);
    }
  }
  return [...hits.values()].map(clampHit).sort((a, b) => a.serial.localeCompare(b.serial));
}

/** Live hits, and dead ones kept in the log. */
export function splitLiveDead(hits) {
  const live = []; const dead = [];
  for (const h of hits) (isDead(h) ? dead : live).push(h);
  return { live, dead };
}

/**
 * The crowded-field count: live hits in the search classes whose mark (any
 * word) starts with the opening.
 */
export function crowdedField(hits, opening, searchClasses) {
  const o = normalizeTerm(opening);
  const cls = new Set((searchClasses ?? []).map((c) => String(c).padStart(3, '0')));
  const matching = hits.filter((h) => !isDead(h)
    && markWords(h.mark).some((w) => w.startsWith(o))
    && (cls.size === 0 || (h.classes ?? []).some((c) => cls.has(c))));
  return { count: matching.length, serials: matching.map((h) => h.serial) };
}

/**
 * Q8's candidate exclusions, from Q7's captured marks: the procedure's
 * defaults for this opening that occur, plus any longer stem shared by at
 * least frequencyFloor distinct words. The reviewer confirms; nothing is
 * excluded without that.
 * @returns {{distinctWords:number, overThreshold:boolean, proposed:{stem:string, words:number, source:'default'|'frequency'}[]}}
 */
export function proposeExclusions(q7Marks, opening, procedure = PROCEDURE) {
  const o = normalizeTerm(opening);
  const words = new Set();
  for (const m of q7Marks) for (const w of markWords(m)) if (w.startsWith(o)) words.add(w);
  const list = [...words];
  const ex = procedure.exclusions;
  const proposed = [];
  const seen = new Set();
  for (const stem of ex.defaults?.[o] ?? []) {
    const n = list.filter((w) => w.startsWith(stem)).length;
    if (n > 0) { proposed.push({ stem, words: n, source: 'default' }); seen.add(stem); }
  }
  // Frequency: stems one and two letters past the opening.
  for (const len of [o.length + 2, o.length + 1]) {
    const counts = new Map();
    for (const w of list) if (w.length > len) counts.set(w.slice(0, len), (counts.get(w.slice(0, len)) ?? 0) + 1);
    for (const [stem, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      if (n < (ex.frequencyFloor ?? 5)) continue;
      if ([...seen].some((s) => stem.startsWith(s) || s.startsWith(stem))) continue;
      proposed.push({ stem, words: n, source: 'frequency' }); seen.add(stem);
    }
  }
  return { distinctWords: list.length, overThreshold: q7Marks.length > (ex.reviewThreshold ?? 75), proposed };
}

/**
 * Which exclusion swallows a mark that must not be lost: a known mark, or a
 * hit already flagged or noted. Each swallowed name that is not a known mark
 * needs its own query (purpose 'rescued').
 * @returns {{swallowed:{stem:string, name:string, kind:'known'|'hit', serial?:string}[], rescue:string[]}}
 */
export function exclusionCheck({ exclusions, knownMarks = [], hits = [] }) {
  const swallowed = [];
  const stems = (exclusions ?? []).map(normalizeTerm).filter(Boolean);
  const knownNames = new Set(knownMarks.map((k) => normalizeTerm(k?.name)));
  for (const stem of stems) {
    for (const k of knownMarks) if (k?.name && termMatchesMark(`${stem}*`, k.name)) swallowed.push({ stem, name: k.name, kind: 'known' });
    for (const h of hits) {
      if (!h.mark || (h.bin !== 'flag' && h.bin !== 'note')) continue;
      if (termMatchesMark(`${stem}*`, h.mark)) swallowed.push({ stem, name: h.mark, kind: 'hit', serial: h.serial });
    }
  }
  const rescue = [...new Set(swallowed.filter((s) => s.kind === 'hit' && !knownNames.has(normalizeTerm(s.name))).map((s) => s.name))];
  return { swallowed, rescue };
}

/**
 * Every gap, as a line for the report's Limits section (verbatim, spec §5.8).
 * @param {{id:string, seq:number, purpose:string}[]} queries
 * @param {{query_id:string, run_at:string, gap:boolean, gap_note:string|null, source:string, reported_count:number|null, captured_count:number}[]} runs
 */
export function gapLines(queries, runs) {
  const latest = latestRuns(runs);
  const out = [];
  for (const q of [...queries].sort((a, b) => a.seq - b.seq)) {
    const r = latest.get(q.id);
    if (!r) { out.push(`Q${q.seq} (${q.purpose}) was not run.`); continue; }
    if (!r.gap) continue;
    const note = r.gap_note || summarizeRun({ source: r.source, reported_count: r.reported_count, rows: r.raw ?? [] }).gapNote
      || `tmsearch reported ${r.reported_count ?? 'no count'}; ${r.captured_count} captured`;
    out.push(`Q${q.seq} (${q.purpose}): ${note}.`);
  }
  return out;
}

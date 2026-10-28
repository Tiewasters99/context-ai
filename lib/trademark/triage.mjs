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
//   nearMark         whether a hit resembles the mark by spelling: ORDERS the
//                    triage queue (resemblers first), never screens a hit out
//
// Nothing here calls a model or the network.

import { PROCEDURE } from './procedure.mjs';
import { liveFromStatus } from './parse.mjs';
import { markWords, normalizeTerm, termMatchesMark, variantsOf } from './queries.mjs';

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
 * Every captured row across the CURRENT run of each query, one per serial.
 * A later query's row fills fields an earlier one left empty; query_seqs
 * lists every query that found it.
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
  return [...hits.values()].sort((a, b) => a.serial.localeCompare(b.serial));
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

// Purposes whose queries are narrow enough that whatever they found is near.
const NARROW_PURPOSES = new Set(['exact', 'embedded', 'hinge', 'variants', 'endings', 'known', 'foreign']);

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * A test for "this hit resembles the mark by spelling": found by a narrow
 * query, or contains the opening+hinge (or a variant of it), or the ending,
 * or is within two letters of the word or a variant, or contains a known
 * mark or foreign equivalent. It ORDERS the triage queue and nothing else.
 * Back-tested on QUALLET and EQUORIUM (2026-10-26) it would have screened
 * out QUELL, QUELL IMPACT, EQOS and EQUIEM, all flagged or noted, so every
 * hit still goes to the model and the reviewer: the resemblers just go first.
 * Without a decomposition every hit is near (no ordering).
 * @returns {(hit: {mark?: string|null, query_seqs?: number[]}) => boolean}
 */
export function nearMark(clearance, queries = []) {
  const d = clearance?.decomposition;
  const word = d ? normalizeTerm(`${d.opening ?? ''}${d.hinge ?? ''}${d.ending ?? ''}`) : '';
  if (!word || !d.ending) return () => true;
  const hinge = d.hinge ?? '';
  const whole = [word, ...variantsOf(word, { cap: 40 })];
  const stem = d.opening + hinge;
  const stems = [stem, ...variantsOf(stem, { cap: 40, pairs: false })].map((s) => (s.length >= 4 ? s : s + d.ending[0]));
  const tail = d.opening.slice(-1) + hinge + d.ending;
  const tails = [tail, ...variantsOf(tail, { cap: 40, pairs: false, region: { minAt: 1 } })];
  if ((hinge + d.ending).length >= 4) tails.push(hinge + d.ending);
  const extra = [
    ...(clearance.known_marks ?? []).map((k) => normalizeTerm(k?.name ?? k?.mark ?? k)),
    ...(clearance.foreign_equivalents ?? []).map(normalizeTerm),
  ].filter((w) => w.length >= 4);
  const narrow = new Set(queries.filter((q) => NARROW_PURPOSES.has(q.purpose)).map((q) => q.seq));
  return (hit) => {
    if ((hit.query_seqs ?? []).some((s) => narrow.has(s))) return true;
    const ws = markWords(hit.mark ?? '');
    const run = ws.join('');
    if (!run) return false;
    if (stems.some((s) => run.includes(s)) || tails.some((t) => run.includes(t))) return true;
    if ([...ws, run].some((w) => w.length >= 4 && whole.some((v) => editDistance(w, v) <= 2))) return true;
    return extra.some((x) => run.includes(x));
  };
}

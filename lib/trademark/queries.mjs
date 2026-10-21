// lib/trademark/queries.mjs — search-term generation (deterministic; the asset).
//
// Spec §3. Input: the reviewer-confirmed decomposition {opening, hinge,
// ending} (lower case), the search classes, the known marks (name + owner),
// foreign equivalents and the procedure config. Output: an ordered list of
// single-line tmsearch queries. No model is involved anywhere in this file.
//
// Syntax [V 10-18, USPTO "Federal trademark searching: Field tag searching"]:
// field tags upper case with a colon, terms lower case, wildcards ? and *
// never inside quotes, AND / OR / AND NOT and parentheses.
//
// Seq numbers are fixed by purpose so a query keeps its number across
// regeneration: 0 self-test, 1 exact, 2 embedded, 3 hinge wildcard, 4 whole-
// word variants, 5 substituted stems, 6 endings, 7 prefix sweep, 8 prefix
// narrowed (only once Q7 has been run and the reviewer confirmed the
// exclusions), then from 9: a CM/ON pair per known mark, the foreign
// equivalents, and any rescued names. Hand-written queries start at 100.
//
// One departure from the spec's prose, forced by its golden set: the ending
// pattern is the LAST LETTER OF THE OPENING + hinge + ending (EQUAZIA → azia),
// not hinge + ending alone; the golden Q6 is *azia *azya *asia.

import { PROCEDURE, GENERATOR_VERSION } from './procedure.mjs';

export { GENERATOR_VERSION };
export const MANUAL_SEQ_START = 100;
export const FIRST_KNOWN_SEQ = 9;
export const TMSEARCH_URL = 'https://tmsearch.uspto.gov/search/search-information';

/** Lower case, letters and digits only: a search term. */
export function normalizeTerm(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

/** The mark's words, each normalized; empty words dropped. */
export function markWords(mark) {
  return String(mark ?? '').split(/\s+/).map(normalizeTerm).filter(Boolean);
}

/** An owner or multi-word name for a quoted phrase: lower case, single spaces, no punctuation. */
export function normalizePhrase(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A CM term for a name: one word bare, several words quoted. */
export function nameTerm(name) {
  const words = normalizePhrase(name).split(' ').filter(Boolean);
  if (words.length === 0) return '';
  return words.length === 1 ? words[0] : `"${words.join(' ')}"`;
}

/**
 * What is wrong with a decomposition, as sentences. Empty when it is usable.
 * The concatenation must equal the mark without spaces (one word) or one
 * word of the mark (a multi-word mark: the word the decomposition is for).
 */
export function decompositionProblems(mark, d) {
  const out = [];
  if (!d || typeof d !== 'object') return ['No decomposition yet: an opening, a hinge and an ending are needed.'];
  const opening = String(d.opening ?? '');
  const hinge = String(d.hinge ?? '');
  const ending = String(d.ending ?? '');
  for (const [k, v] of [['opening', opening], ['hinge', hinge], ['ending', ending]]) {
    if (v !== v.toLowerCase() || /[^a-z0-9]/.test(v)) out.push(`The ${k} must be lower-case letters or digits ("${v}").`);
  }
  if (!opening) out.push('The opening cannot be empty.');
  if (!ending) out.push('The ending cannot be empty.');
  const joined = opening + hinge + ending;
  const words = markWords(mark);
  const whole = words.join('');
  if (joined && joined !== whole && !words.includes(joined)) {
    out.push(`opening + hinge + ending = "${joined}", which is not the mark ("${whole}") or one of its words.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Substitutions
// ---------------------------------------------------------------------------

/**
 * Every single edit the substitution table allows on `word`, in table order
 * then position order. An edit is {at, len, to, tier, id}. `minAt`/`maxEnd`
 * restrict edits to a region of the word.
 */
export function editsFor(word, rows = PROCEDURE.substitutions.rows, { minAt = 0, maxEnd = Infinity } = {}) {
  const out = [];
  for (const row of rows) {
    if (row.rule === 'undouble') {
      for (let i = 0; i + 1 < word.length; i++) {
        if (word[i] === word[i + 1] && /[bcdfghjklmnpqrstvwxyz]/.test(word[i]) && i >= minAt && i + 2 <= maxEnd) {
          out.push({ at: i, len: 2, to: word[i], tier: row.tier, id: row.id });
        }
      }
      continue;
    }
    const from = String(row.from);
    for (let i = word.indexOf(from); i !== -1; i = word.indexOf(from, i + 1)) {
      if (row.initialOnly && i !== 0) continue;
      if (i < minAt || i + from.length > maxEnd) continue;
      for (const to of row.to) out.push({ at: i, len: from.length, to, tier: row.tier, id: row.id });
    }
  }
  return out;
}

function applyEdits(word, edits) {
  let w = word;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) w = w.slice(0, e.at) + e.to + w.slice(e.at + e.len);
  return w;
}

const overlaps = (a, b) => a.at < b.at + b.len && b.at < a.at + a.len;

/**
 * Variants of `word`: tier by tier, the single edits of that tier, then the
 * pairs whose stronger edit is of that tier, until `cap`. Duplicates and the
 * word itself are removed.
 */
export function variantsOf(word, { cap = 12, pairs = true, rows, region } = {}) {
  const edits = editsFor(word, rows, region);
  const seen = new Set([word]);
  const out = [];
  const push = (w) => {
    if (out.length >= cap || seen.has(w)) return;
    seen.add(w); out.push(w);
  };
  const tiers = [...new Set(edits.map((e) => e.tier))].sort((a, b) => a - b);
  for (const t of tiers) {
    for (const e of edits) if (e.tier === t) push(applyEdits(word, [e]));
    if (!pairs) continue;
    for (let i = 0; i < edits.length; i++) {
      for (let j = i + 1; j < edits.length; j++) {
        const a = edits[i]; const b = edits[j];
        if (Math.max(a.tier, b.tier) !== t || overlaps(a, b) || a.id === b.id) continue;
        push(applyEdits(word, [a, b]));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** IC:(<codes> a b 200) — the coordinated-class group the spec uses. */
export function classGroup(codes) {
  const list = [...new Set((codes ?? []).map((c) => String(c).padStart(3, '0')))].filter((c) => /^\d{3}$/.test(c)).sort();
  return list.length ? `IC:(${list.join(' ')} a b 200)` : '';
}

const termList = (terms) => (terms.length === 1 ? terms[0] : `(${terms.join(' ')})`);

/**
 * The ordered query list.
 *
 * @param {object} o
 * @param {string} o.mark
 * @param {{opening:string, hinge:string, ending:string}} o.decomposition
 * @param {string[]} [o.searchClasses]   three-digit codes
 * @param {{name:string, owner?:string}[]} [o.knownMarks]
 * @param {string[]} [o.foreignEquivalents]
 * @param {string[]|null} [o.exclusions] confirmed Q8 exclusions (word stems); null = Q7 not yet narrowed
 * @param {string[]} [o.rescued]          names an exclusion would swallow
 * @returns {{queries: Array<{seq:number, purpose:string, query:string, class_filter:string[], live_only:boolean, generator_version:string}>, warnings: string[]}}
 */
export function generateQueries({
  mark, decomposition, searchClasses = [], knownMarks = [], foreignEquivalents = [],
  exclusions = null, rescued = [], procedure = PROCEDURE,
}) {
  const problems = decompositionProblems(mark, decomposition);
  if (problems.length) throw new Error(problems.join(' '));
  const { opening, hinge = '', ending } = decomposition;
  const subs = procedure.substitutions;
  const word = opening + hinge + ending;
  const words = markWords(mark);
  const classes = [...new Set(searchClasses.map((c) => String(c).padStart(3, '0')))].sort();
  const cls = classGroup(classes);
  const warnings = [];
  if (!cls) warnings.push('No search classes: the broad queries (Q5 to Q8, foreign) run without a class filter.');
  const withCls = (q) => (cls ? `${q} AND ${cls}` : q);

  const queries = [];
  const add = (seq, purpose, query, { classFilter = [], liveOnly = false } = {}) => {
    queries.push({ seq, purpose, query, class_filter: classFilter, live_only: liveOnly, generator_version: GENERATOR_VERSION });
  };
  const broad = { classFilter: classes, liveOnly: true };

  // Q0 — the self-test: must return exactly one known record.
  add(0, 'selftest', `SN:${procedure.selftest.serial}`);
  // Q1 — exact (a multi-word mark is a quoted phrase).
  add(1, 'exact', `CM:${words.length > 1 ? `"${words.join(' ')}"` : words[0]}`);
  // Q2 — embedded stem (no filters: a rare string).
  const S = opening + hinge;
  add(2, 'embedded', `CM:*${S}*`);
  // Q3 — hinge wildcard.
  add(3, 'hinge', `CM:${opening}?${ending} AND LD:true`, { liveOnly: true });
  // Q4 — whole-word variants (no class filter: rare strings).
  const v = variantsOf(word, { cap: subs.variantCap ?? 12 });
  if (v.length) add(4, 'variants', `CM:${termList(v)} AND LD:true`, { liveOnly: true });
  else warnings.push('The substitution table produced no whole-word variants; Q4 is omitted.');
  // Q5 — substituted stems: each single substitution of the hinge and the opening.
  const stems = variantsOf(S, { cap: subs.stemCap ?? 12, pairs: false });
  if (stems.length) add(5, 'stems', withCls(`CM:${termList(stems.map((s) => `${s}*`))} AND LD:true`), broad);
  else warnings.push('The substitution table produced no substituted stems; Q5 is omitted.');
  // Q6 — endings: last letter of the opening + hinge + ending, and its substitutions.
  const E = opening.slice(-1) + hinge + ending;
  const endingsList = [E, ...variantsOf(E, { cap: (subs.endingCap ?? 12) - 1, pairs: false, region: { minAt: 1 } })];
  add(6, 'endings', withCls(`CM:${termList(endingsList.map((e) => `*${e}`))} AND LD:true`), broad);
  // Q7 — prefix sweep.
  const q7 = withCls(`CM:${opening}* AND LD:true`);
  add(7, 'prefix', q7, broad);
  // Q8 — prefix narrowed: only once the reviewer has confirmed exclusions after Q7's run.
  const excl = (exclusions ?? []).map(normalizeTerm).filter(Boolean);
  if (exclusions && excl.length) add(8, 'prefix_narrowed', `${q7} AND NOT CM:${termList(excl.map((x) => `${x}*`))}`, broad);
  else warnings.push('Q8 (prefix narrowed) is built after Q7 has been run and its exclusions confirmed.');

  // Q9+ — known marks: CM:<name> and ON:"<owner>", no LD and no class filter,
  // so abandoned filings by the same owner appear.
  let seq = FIRST_KNOWN_SEQ;
  const knownTerms = new Set();
  for (const k of knownMarks) {
    const t = nameTerm(k?.name);
    if (!t) continue;
    knownTerms.add(t);
    add(seq++, 'known', `CM:${t}`);
    const owner = normalizePhrase(k?.owner);
    if (owner) add(seq++, 'owner', `ON:"${owner}"`);
  }
  // Foreign equivalents.
  const foreign = [...new Set(foreignEquivalents.map(nameTerm).filter(Boolean))];
  if (foreign.length) add(seq++, 'foreign', withCls(`CM:${termList(foreign)} AND LD:true`), broad);
  // Rescued: a name an exclusion would swallow that is not already a known mark.
  for (const name of rescued) {
    const t = nameTerm(name);
    if (!t || knownTerms.has(t)) continue;
    knownTerms.add(t);
    add(seq++, 'rescued', `CM:${t}`);
  }

  for (const q of queries) {
    const bad = queryProblems(q.query);
    if (bad.length) throw new Error(`Q${q.seq} is malformed (${bad.join('; ')}): ${q.query}`);
  }
  return { queries, warnings };
}

// ---------------------------------------------------------------------------
// Well-formedness
// ---------------------------------------------------------------------------

const OPERATORS = new Set(['AND', 'OR', 'NOT', 'TO']);

/**
 * What is wrong with a query string, as short phrases. Empty = well formed:
 * balanced parentheses and quotes, no wildcard inside quotes, upper-case
 * field tags, lower-case terms, three-digit classes (or a / b / 200).
 */
export function queryProblems(q) {
  const out = [];
  const s = String(q ?? '');
  if (!s.trim()) return ['empty'];
  if ((s.match(/"/g) ?? []).length % 2) out.push('unbalanced quotes');
  for (const m of s.matchAll(/"([^"]*)"/g)) {
    if (/[*?]/.test(m[1])) out.push(`wildcard inside quotes ("${m[1]}")`);
    if (m[1] !== m[1].toLowerCase()) out.push(`upper case inside quotes ("${m[1]}")`);
  }
  const bare = s.replace(/"[^"]*"/g, ' Q ');
  let depth = 0;
  for (const ch of bare) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) out.push('unbalanced parentheses');
  // Ranges [a TO b] are left alone apart from their bounds.
  const tokens = bare.replace(/[[\]]/g, ' ').split(/[\s()]+/).filter(Boolean);
  let field = null;
  for (const tok of tokens) {
    if (OPERATORS.has(tok)) continue;
    if (tok === 'Q') continue; // a quoted phrase, checked above
    const tag = /^([A-Za-z]{2}):(.*)$/.exec(tok);
    let term = tok;
    if (tag) {
      if (tag[1] !== tag[1].toUpperCase()) out.push(`field tag must be upper case (${tag[1]}:)`);
      field = tag[1].toUpperCase();
      term = tag[2];
      if (!term) continue;
    }
    if (field === 'LD') {
      if (term !== 'true' && term !== 'false') out.push(`LD: takes true or false (${term})`);
      continue;
    }
    if (field === 'IC' || field === 'CC') {
      if (!/^(\d{3}|a|b|200)$/.test(term)) out.push(`class must be three digits, a, b or 200 (${term})`);
      continue;
    }
    if (field === 'FD') continue;
    if (/[A-Z]/.test(term)) out.push(`terms are lower case (${term})`);
    else if (!/^[a-z0-9?*]+$/.test(term)) out.push(`unexpected characters in a term (${term})`);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Matching (for the tests and the exclusion check; not a search engine)
// ---------------------------------------------------------------------------

function wildcardRe(term) {
  const esc = term.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

/** Whether one CM term matches a mark (any word of it, or all of it run together). */
export function termMatchesMark(term, mark) {
  const words = markWords(mark);
  if (!words.length) return false;
  if (term.startsWith('"')) return ` ${words.join(' ')} `.includes(` ${term.slice(1, -1)} `);
  const re = wildcardRe(term);
  return words.some((w) => re.test(w)) || re.test(words.join(''));
}

function cmTerms(fragment) {
  const m = /^CM:(\((?:[^()"]|"[^"]*")*\)|"[^"]*"|\S+)/.exec(fragment.trim());
  if (!m) return [];
  const body = m[1].startsWith('(') ? m[1].slice(1, -1) : m[1];
  return [...body.matchAll(/"[^"]*"|[^\s"]+/g)].map((x) => x[0]).filter((t) => !OPERATORS.has(t));
}

/**
 * Whether a query's CM: clause would return `mark`, ignoring the LD: and IC:
 * filters (the caller checks those against the record). Terms after
 * AND NOT CM: are exclusions. A query with no CM: clause matches nothing.
 */
export function cmMatches(query, mark) {
  const s = String(query);
  const notAt = s.indexOf('AND NOT CM:');
  const positive = notAt === -1 ? s : s.slice(0, notAt);
  const first = positive.indexOf('CM:');
  if (first === -1) return false;
  const pos = cmTerms(positive.slice(first));
  if (!pos.some((t) => termMatchesMark(t, mark))) return false;
  if (notAt !== -1) {
    const neg = cmTerms(s.slice(notAt + 'AND NOT '.length));
    if (neg.some((t) => termMatchesMark(t, mark))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Regeneration
// ---------------------------------------------------------------------------

/**
 * Regeneration replaces only queries not yet run (spec §2, stage 3).
 *
 * @param {Array<{id:string, seq:number, purpose:string, query:string, run_count:number}>} existing
 * @param {Array<{seq:number, purpose:string, query:string}>} generated
 * @returns {{remove: string[], insert: object[], kept: number}}
 *   remove: ids of un-run, non-manual queries; insert: generated queries not
 *   already present among the run ones, each with a free seq.
 */
export function planRegeneration(existing, generated) {
  const run = existing.filter((q) => (q.run_count ?? 0) > 0);
  const manual = existing.filter((q) => (q.run_count ?? 0) === 0 && q.purpose === 'manual');
  const remove = existing.filter((q) => (q.run_count ?? 0) === 0 && q.purpose !== 'manual').map((q) => q.id);
  const taken = new Set([...run, ...manual].map((q) => q.seq));
  const present = new Set(run.map((q) => q.query));
  const insert = [];
  let next = FIRST_KNOWN_SEQ;
  for (const g of generated) {
    if (present.has(g.query)) continue;
    let seq = g.seq;
    if (taken.has(seq)) {
      while (taken.has(next) || next < FIRST_KNOWN_SEQ) next++;
      if (next >= MANUAL_SEQ_START) throw new Error('No free query numbers below 100.');
      seq = next;
    }
    taken.add(seq);
    insert.push({ ...g, seq });
  }
  return { remove, insert, kept: run.length + manual.length };
}

/** The next free number for a hand-written query. */
export function nextManualSeq(existing) {
  const used = new Set(existing.map((q) => q.seq));
  let s = MANUAL_SEQ_START;
  while (used.has(s)) s++;
  return s;
}

/**
 * The deterministic verifier — constitution principle 4.
 *
 * Citations, quotations, record cites, numbers, and defined terms are
 * untouchable; this module checks them in plain code after every pass.
 * It also grounds each edit in the manuscript: an edit whose `before`
 * cannot be found verbatim (or is ambiguous, or overlaps another edit)
 * is refused and reported — never silently dropped, never guessed at.
 */

import type { ProposedEdit, RejectedEdit } from './types';

export interface RawEdit extends Omit<ProposedEdit, 'pos'> {}

export interface VerifyOutcome {
  accepted: ProposedEdit[];
  rejected: RejectedEdit[];
}

/** Curly → straight quotes; whitespace runs → single space; with an index map back to the original. */
export function buildNormalized(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    if (ch === '‘' || ch === '’') ch = "'";
    else if (ch === '“' || ch === '”') ch = '"';
    if (/\s/.test(ch)) {
      if (norm.endsWith(' ')) continue;
      ch = ' ';
    }
    norm += ch;
    map.push(i);
  }
  return { norm, map };
}

export function normalize(text: string): string {
  return buildNormalized(text).norm;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return count;
}

/**
 * Locate `before` in the manuscript. Tries verbatim first, then a
 * quote/whitespace-normalized match mapped back to original offsets.
 * Returns the grounded span, or an error string.
 */
function locate(
  manuscript: string,
  normManuscript: { norm: string; map: number[] },
  before: string,
): { pos: number; actual: string } | { error: string } {
  const exactCount = countOccurrences(manuscript, before);
  if (exactCount === 1) return { pos: manuscript.indexOf(before), actual: before };
  if (exactCount > 1) return { error: `the passage appears ${exactCount} times in the manuscript — ambiguous anchor` };

  const normBefore = normalize(before).trim();
  if (normBefore.length < 3) return { error: 'the passage is too short to anchor' };
  const normCount = countOccurrences(normManuscript.norm, normBefore);
  if (normCount === 0) return { error: 'the passage is not in the manuscript verbatim' };
  if (normCount > 1) return { error: `the passage appears ${normCount} times in the manuscript — ambiguous anchor` };

  const normIdx = normManuscript.norm.indexOf(normBefore);
  const pos = normManuscript.map[normIdx];
  const end = normManuscript.map[normIdx + normBefore.length - 1] + 1;
  return { pos, actual: manuscript.slice(pos, end) };
}

/** Defined terms established anywhere in the manuscript: (“Term”) / ("Term"). */
export function extractDefinedTerms(manuscript: string): string[] {
  const terms = new Set<string>();
  const re = /\((?:the\s+|collectively,?\s+)?["“]([^"“”]{2,60})["”]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(manuscript)) !== null) terms.add(m[1]);
  return [...terms];
}

interface Untouchable {
  kind: 'number' | 'quotation' | 'citation' | 'defined term';
  token: string;
}

function extractUntouchables(text: string, definedTerms: string[]): Untouchable[] {
  const found: Untouchable[] = [];
  const push = (kind: Untouchable['kind'], token: string) => found.push({ kind, token });

  for (const m of text.match(/\d[\d,./:§-]*\d|\d/g) ?? []) push('number', m);
  const quoteRe = /["“]([^"“”]{2,})["”]/g;
  let q: RegExpExecArray | null;
  while ((q = quoteRe.exec(text)) !== null) push('quotation', q[1]);
  for (const m of text.match(/§{1,2}\s*[\w.()-]*\w/g) ?? []) push('citation', m);
  for (const m of text.match(/\b[A-Z][\w.'-]*\s+v\.\s+[A-Z][\w.'-]*/g) ?? []) push('citation', m);
  for (const term of definedTerms) {
    if (text.includes(term)) push('defined term', term);
  }
  return found;
}

/**
 * Every untouchable token in `before` must survive, unchanged, in `after`.
 * A cut (empty `after`) is permitted — a deletion is conspicuous in a
 * redline — but earns a caution the lawyer sees.
 */
function checkUntouchables(
  before: string,
  after: string,
  definedTerms: string[],
): { violation?: string; caution?: string } {
  const untouchables = extractUntouchables(before, definedTerms);
  if (untouchables.length === 0) return {};

  if (after === '') {
    const kinds = [...new Set(untouchables.map((u) => u.kind))].join(', ');
    return { caution: `this cut removes ${kinds === 'number' ? 'numbers' : kinds} — review the strikethrough carefully` };
  }

  const normAfter = normalize(after);
  for (const u of untouchables) {
    const needle = u.kind === 'quotation' || u.kind === 'defined term' ? normalize(u.token) : u.token;
    const haystack = u.kind === 'number' || u.kind === 'citation' ? after : normAfter;
    if (!haystack.includes(needle)) {
      return { violation: `the rewrite drops or alters a ${u.kind}: “${u.token}”` };
    }
  }
  return {};
}

export function verifyEdits(manuscript: string, rawEdits: RawEdit[]): VerifyOutcome {
  const normManuscript = buildNormalized(manuscript);
  const definedTerms = extractDefinedTerms(manuscript);

  const located: ProposedEdit[] = [];
  const rejected: RejectedEdit[] = [];
  const reject = (edit: RawEdit, rejectionReason: string) => rejected.push({ ...edit, rejectionReason });

  for (const edit of rawEdits) {
    if (edit.before === edit.after) {
      reject(edit, 'the rewrite is identical to the original');
      continue;
    }
    const span = locate(manuscript, normManuscript, edit.before);
    if ('error' in span) {
      reject(edit, span.error);
      continue;
    }
    const check = checkUntouchables(span.actual, edit.after, definedTerms);
    if (check.violation) {
      reject(edit, check.violation);
      continue;
    }
    located.push({ ...edit, before: span.actual, pos: span.pos, caution: check.caution });
  }

  located.sort((a, b) => a.pos - b.pos);
  const accepted: ProposedEdit[] = [];
  let cursor = 0;
  for (const edit of located) {
    if (edit.pos < cursor) {
      const { pos: _pos, ...rest } = edit;
      reject(rest, 'overlaps an earlier edit');
      continue;
    }
    accepted.push(edit);
    cursor = edit.pos + edit.before.length;
  }

  return { accepted, rejected };
}

/** Apply a set of (non-overlapping, position-sorted) edits to the manuscript. */
export function applyEdits(manuscript: string, edits: ProposedEdit[]): string {
  let result = '';
  let cursor = 0;
  for (const edit of edits) {
    result += manuscript.slice(cursor, edit.pos) + edit.after;
    cursor = edit.pos + edit.before.length;
  }
  return result + manuscript.slice(cursor);
}

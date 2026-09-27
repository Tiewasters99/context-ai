// Cite marks on the brief (slice D3; docs/specs/BRIEF-DESK-2026-09-26.md §3.3).
//
// A cite-check run returns entries that name a citation by its `raw` text and
// an ~80-character `location`. This module puts each entry onto the words it
// names, as a `cite` mark, and keeps the mark honest after that:
//
//   • project(doc)       the plain-text projection the cite-check read —
//                        byte-identical to toPlainText() (lib/brief-md.mjs) —
//                        with a map from every character back to a
//                        ProseMirror position. The harness asserts the two
//                        strings are equal; if they ever drift, marks land on
//                        the wrong words.
//   • anchorEntries()    raw → range, by the Editor's normalisation
//                        (src/lib/editor/verifier.ts `buildNormalized`: curly
//                        quotes, whitespace) plus the folds the extractor's
//                        own contract check already accepts (dashes, case, the
//                        stray apostrophes, soft hyphens; and, last, all
//                        whitespace removed). An entry that does not anchor is
//                        returned as "not located", never dropped. The same
//                        raw can appear several times (the extractor emits one
//                        entry per place); each entry takes the occurrence
//                        nearest its `location`, and no occurrence is used twice.
//   • citeStalePlugin()  the edit rule: a mark whose words no longer
//                        normalise to its raw becomes `stale`. The run row is
//                        never touched.
//   • diffForConfirm()   B6: which freshly extracted cites need a model check
//                        and which carry their flag forward from the last run.
//   • tableRows()        the table as a projection of the marks, in document
//                        order, plus the entries that have no mark.
//
// Pure: no Supabase, no DOM. The Brief Desk and the harness
// (scripts/_verify-brief-desk-marks.mjs) import the same functions.

import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { Mark, MarkType, Node as PMNode } from '@tiptap/pm/model';
import { buildNormalized } from '@/lib/editor/verifier';
import type { ReportEntry } from '@/lib/cite-check/types';

// ---------------------------------------------------------------------------
// The cite key (§3.3) — stable across runs and snapshots
// ---------------------------------------------------------------------------

/** Lowercase, whitespace collapsed, punctuation stripped except dots (the reporter's) and §. */
function keyText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*_]/g, '')
    .replace(/[^\p{L}\p{N}\s.§]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The citation without its pinpoint: ", 460" / " at 460" after the first page, when it is the entry's own pin. */
function withoutPin(citation: string, pin: string | null): string {
  if (!pin) return citation;
  const p = pin.trim().replace(/^at\s+/i, '');
  if (!p) return citation;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return citation.replace(new RegExp(`(?:,\\s*|\\s+at\\s+)${esc}(?=\\s*(?:\\(|,|;|$))`), '');
}

/** `normalize(citation without pin) + '|' + (pin ?? '')`. */
export function citeKey(citation: string | null | undefined, pin: string | null | undefined): string {
  const c = String(citation ?? '');
  const p = pin ? keyText(pin.replace(/^\s*at\s+/i, '')) : '';
  return `${keyText(withoutPin(c, pin ?? null))}|${p}`;
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/** A run of plain text that is one ProseMirror text node: plain [start, end) ↔ PM [pmFrom, pmFrom + end - start). */
export interface Segment {
  plainStart: number;
  plainEnd: number;
  pmFrom: number;
}

export interface Projection {
  text: string;
  segments: Segment[];
}

interface Piece { text: string; pmFrom: number | null }

/**
 * toPlainText, walked over a ProseMirror document with positions kept.
 * Mirrors lib/brief-md.mjs exactly: blockquote paragraphs are blocks of their
 * own; a signature block's lines join with "\n"; a hard break is "\n"; a
 * footnote reference is zero-width and its text is appended after the body,
 * in document order; empty blocks are dropped; blocks join with "\n\n".
 */
export function project(doc: PMNode): Projection {
  const notes: Piece[][] = [];
  const blocks: Piece[][] = [];

  // `start` = the position of the first child of `node`.
  const inline = (node: PMNode, start: number): Piece[] => {
    const out: Piece[] = [];
    node.forEach((child, offset) => {
      const pos = start + offset;
      if (child.isText) out.push({ text: child.text ?? '', pmFrom: pos });
      else if (child.type.name === 'hardBreak') out.push({ text: '\n', pmFrom: null });
      else if (child.type.name === 'footnote') notes.push(inline(child, pos + 1));
      else out.push(...inline(child, pos + 1));
    });
    return out;
  };

  doc.forEach((b, offset) => {
    const pos = offset;
    if (b.type.name === 'blockquote') {
      b.forEach((p, o) => { blocks.push(inline(p, pos + 1 + o + 1)); });
    } else if (b.type.name === 'signatureBlock') {
      const lines: Piece[] = [];
      let first = true;
      b.forEach((p, o) => {
        if (!first) lines.push({ text: '\n', pmFrom: null });
        first = false;
        lines.push(...inline(p, pos + 1 + o + 1));
      });
      blocks.push(lines);
    } else {
      blocks.push(inline(b, pos + 1));
    }
  });

  let text = '';
  const segments: Segment[] = [];
  let firstBlock = true;
  for (const pieces of [...blocks, ...notes]) {
    const len = pieces.reduce((n, p) => n + p.text.length, 0);
    if (!len) continue;
    if (!firstBlock) text += '\n\n';
    firstBlock = false;
    for (const p of pieces) {
      if (p.pmFrom !== null && p.text.length) {
        segments.push({ plainStart: text.length, plainEnd: text.length + p.text.length, pmFrom: p.pmFrom });
      }
      text += p.text;
    }
  }
  return { text, segments };
}

/** A plain-text offset → ProseMirror position. `edge` 'end' maps an exclusive end. */
function toPm(segments: Segment[], off: number, edge: 'start' | 'end'): number | null {
  for (const s of segments) {
    if (edge === 'start' ? off >= s.plainStart && off < s.plainEnd : off > s.plainStart && off <= s.plainEnd) {
      return s.pmFrom + (off - s.plainStart);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalisation: the verifier's, then the extractor's folds
// ---------------------------------------------------------------------------

interface Folded { norm: string; map: number[] }

/**
 * buildNormalized (verifier.ts: curly quotes, whitespace runs) and then, per
 * character, the folds extract-cites.ts's contract check accepts: dashes,
 * the other apostrophes, case, soft hyphens dropped. Every character of
 * `norm` maps back to an offset in the original string.
 */
export function fold(text: string): Folded {
  const base = buildNormalized(text);
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < base.norm.length; i++) {
    let ch = base.norm[i];
    if (ch === '­') continue; // soft hyphen: a line-break hint, not a character
    if (/[‐-―−]/.test(ch)) ch = '-';
    else if (/[ʼ`´]/.test(ch)) ch = "'";
    const lower = ch.toLowerCase();
    if (lower.length === 1) ch = lower; // İ and friends change length; leave them be
    norm += ch;
    map.push(base.map[i]);
  }
  return { norm, map };
}

/** The same with every space removed — "§ 523(a)" against "§523(a)". */
function tight(f: Folded): Folded {
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < f.norm.length; i++) {
    if (f.norm[i] === ' ') continue;
    norm += f.norm[i];
    map.push(f.map[i]);
  }
  return { norm, map };
}

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let at = hay.indexOf(needle);
  while (at !== -1) { out.push(at); at = hay.indexOf(needle, at + 1); }
  return out;
}

/** Normalised text equality — the stale rule's test. */
export function sameWords(a: string, b: string): boolean {
  const fa = fold(a).norm.trim();
  const fb = fold(b).norm.trim();
  return fa === fb || fa.replace(/ /g, '') === fb.replace(/ /g, '');
}

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

/** What the desk stores per cite in cite_check_runs.report: a ReportEntry and the words it was read from. */
export interface DeskEntry extends ReportEntry {
  /** The citation exactly as the draft has it — what the mark wraps. */
  raw: string;
  cite_key: string;
  /** Set when the flag came forward from an earlier run without a new model check (B6). */
  carried_from?: string | null;
  /** Where the corpus has the case (D2 resolvers), written after the run. */
  resolution?: StoredResolution | null;
}

/** A resolveEntry() result, cut down to what the table shows. */
export interface StoredResolution {
  status: 'resolved' | 'two_copies' | 'not_in_corpus' | 'not_a_case' | 'error';
  hits: { document_id: string; title: string | null; how: 'reporter' | 'name'; star_level: number | null }[];
  pin: number | null;
  passage: { passage_id: string; page_start: number | null; basis: string; caveat: string | null; printed_page: number | null } | null;
  error?: string;
}

export interface Located { index: number; from: number; to: number; plainStart: number; plainEnd: number }

export interface AnchorResult {
  located: Located[];
  /** Entry indexes that did not anchor — each is a table row saying so. */
  notLocated: number[];
}

type AnchorEntry = Pick<DeskEntry, 'raw' | 'location'>;

/**
 * Put every entry on its words. Each entry's raw is searched in the folded
 * projection (then without spaces); among its occurrences the entry takes the
 * one inside or nearest its `location`, and no occurrence is used twice.
 * `location` is only a tiebreaker: it is never itself marked.
 */
export function anchorEntries(doc: PMNode, entries: AnchorEntry[]): AnchorResult {
  const proj = project(doc);
  const spaced = fold(proj.text);
  const tightHay = tight(spaced);
  // Plain-text ranges already taken: a second entry never lands on (or inside) the first's words.
  const used: { at: number; end: number }[] = [];
  const overlaps = (h: { at: number; end: number }) => used.some((u) => h.at < u.end && u.at < h.end);
  const located: Located[] = [];
  const notLocated: number[] = [];

  const where = (hay: Folded, needle: string): { at: number; end: number }[] =>
    allIndexes(hay.norm, needle).map((i) => ({ at: hay.map[i], end: hay.map[i + needle.length - 1] + 1 }));

  entries.forEach((e, index) => {
    const raw = fold(e.raw ?? '').norm.trim();
    if (raw.length < 3) { notLocated.push(index); return; }
    let hits = where(spaced, raw);
    if (!hits.length) hits = where(tightHay, raw.replace(/ /g, ''));
    hits = hits.filter((h) => !overlaps(h));
    if (!hits.length) { notLocated.push(index); return; }

    let pick = hits[0];
    const loc = fold(e.location ?? '').norm.trim();
    if (hits.length > 1 && loc.length >= 3) {
      const spots = where(spaced, loc);
      if (spots.length) {
        const dist = (h: { at: number; end: number }) => Math.min(...spots.map((s) =>
          h.at >= s.at && h.end <= s.end ? 0 : Math.min(Math.abs(h.at - s.at), Math.abs(h.end - s.end))));
        pick = hits.reduce((best, h) => (dist(h) < dist(best) ? h : best), hits[0]);
      }
    }
    const from = toPm(proj.segments, pick.at, 'start');
    const to = toPm(proj.segments, pick.end, 'end');
    if (from === null || to === null || to <= from) { notLocated.push(index); return; }
    used.push(pick);
    located.push({ index, from, to, plainStart: pick.at, plainEnd: pick.end });
  });
  return { located, notLocated };
}

/** The mark attrs a located entry gets (schema.ts `Cite`). */
export interface CiteAttrs {
  cite_key: string;
  run_id: string;
  flag: string;
  raw: string;
  authority_document_id: string | null;
  passage_id: string | null;
  pin: string | null;
  stale: boolean;
}

export function markAttrsFor(entry: DeskEntry, runId: string): CiteAttrs {
  const r = entry.resolution;
  const resolved = r?.status === 'resolved';
  return {
    cite_key: entry.cite_key,
    run_id: runId,
    flag: entry.flag,
    raw: entry.raw,
    authority_document_id: resolved ? r!.hits[0]?.document_id ?? null : null,
    passage_id: resolved ? r!.passage?.passage_id ?? null : null,
    pin: r?.pin != null ? String(r.pin) : entry.pin ?? null,
    stale: false,
  };
}

export const CITE_META = 'briefDeskCites';

/**
 * One transaction: every old cite mark removed, the run's marks laid down.
 * Tagged with CITE_META so the stale rule leaves it alone.
 */
export function applyRunMarks(state: EditorState, entries: DeskEntry[], runId: string): { tr: Transaction; result: AnchorResult } {
  const type = state.schema.marks.cite;
  const tr = state.tr.removeMark(0, state.doc.content.size, type);
  const result = anchorEntries(tr.doc, entries);
  for (const l of result.located) tr.addMark(l.from, l.to, type.create(markAttrsFor(entries[l.index], runId)));
  tr.setMeta(CITE_META, 'run');
  tr.setMeta('addToHistory', false);
  return { tr, result };
}

// ---------------------------------------------------------------------------
// The marks as they stand, and the stale rule
// ---------------------------------------------------------------------------

export interface MarkSpan { from: number; to: number; text: string; attrs: CiteAttrs; mark: Mark }

/**
 * Every cite mark in the document, in document order. Consecutive text nodes
 * carrying an equal mark are one span (a case name in italics followed by the
 * reporter cite in roman is one cite). A mark without a key — a paste from
 * elsewhere — is not a cite and is skipped.
 */
export function citeSpans(doc: PMNode, type?: MarkType): MarkSpan[] {
  const citeType = type ?? doc.type.schema.marks.cite;
  const spans: MarkSpan[] = [];
  let cur: MarkSpan | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText) {
      // A hard break inside a cite is a space in its words, and the span runs on.
      if (node.type.name === 'hardBreak' && cur && cur.to === pos) { cur.to = pos + node.nodeSize; cur.text += ' '; }
      return true;
    }
    const mark = node.marks.find((m) => m.type === citeType) ?? null;
    if (mark && cur && cur.mark.eq(mark) && cur.to === pos) {
      cur.to = pos + node.nodeSize;
      cur.text += node.text ?? '';
      return false;
    }
    if (cur) { spans.push(cur); cur = null; }
    if (mark && mark.attrs.cite_key && mark.attrs.raw) {
      cur = { from: pos, to: pos + node.nodeSize, text: node.text ?? '', attrs: mark.attrs as CiteAttrs, mark };
    }
    return false;
  });
  if (cur) spans.push(cur);
  // A span that ended on a hard break gives the break back.
  for (const s of spans) if (s.text.endsWith(' ') && doc.nodeAt(s.to - 1)?.type.name === 'hardBreak') { s.to -= 1; s.text = s.text.slice(0, -1); }
  return spans;
}

/** Spans whose words no longer normalise to their raw and are not yet marked stale. */
export function staleUpdates(doc: PMNode): MarkSpan[] {
  return citeSpans(doc).filter((s) => !s.attrs.stale && !sameWords(s.text, s.attrs.raw));
}

/** Mark those spans stale, in a transaction of their own. Null when nothing changed. */
export function markStale(state: EditorState): Transaction | null {
  const stale = staleUpdates(state.doc);
  if (!stale.length) return null;
  const type = state.schema.marks.cite;
  const tr = state.tr;
  for (const s of stale) tr.addMark(s.from, s.to, type.create({ ...s.attrs, stale: true }));
  tr.setMeta(CITE_META, 'stale');
  return tr;
}

/**
 * §3.3's edit rule, on every transaction that changes the document: a cite
 * whose words changed since the check reads "changed since check". Appended
 * to the user's own transaction, so undo takes both back together.
 */
export function citeStalePlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('briefCiteStale'),
    appendTransaction(trs, _old, state) {
      if (!trs.some((t) => t.docChanged) || trs.some((t) => t.getMeta(CITE_META))) return null;
      return markStale(state);
    },
  });
}

// ---------------------------------------------------------------------------
// Confirm's incremental diff (B6)
// ---------------------------------------------------------------------------

/** The pair the diff matches on: cite_key + the raw text, folded. */
export function pairKey(key: string, raw: string): string {
  return `${key}\u0000${fold(raw).norm.trim()}`;
}

export interface FreshCite { raw: string | null; citation_bluebook: string | null; pin_cite: string | null }

export interface Diff<C> {
  /** Fresh cites that need checkOne: new, or stale since the last run. */
  toCheck: { cite: C; index: number }[];
  /** Fresh cites whose flag comes forward from the prior entry, unchanged. */
  carried: { cite: C; index: number; prior: DeskEntry }[];
  /** Prior entries no fresh cite matched: gone from the brief. */
  dropped: DeskEntry[];
}

/**
 * Match every freshly extracted cite against the last run by cite_key + raw.
 * Each prior entry carries at most one fresh cite: the same citation in a
 * new sentence is checked, because a flag says something about the
 * proposition it was cited for, too. A pair whose mark went stale is checked
 * even when the fresh extraction reads the same words. `all` ignores the
 * prior run (Re-check all).
 */
export function diffForConfirm<C extends FreshCite>(
  prior: DeskEntry[] | null,
  fresh: C[],
  stalePairs: Set<string>,
  all = false,
): Diff<C> {
  const pool = new Map<string, DeskEntry[]>();
  if (!all) {
    for (const e of prior ?? []) {
      if (e.flag === 'unchecked') continue; // never carry "not checked" forward — try again
      const k = pairKey(e.cite_key, e.raw);
      pool.set(k, [...(pool.get(k) ?? []), e]);
    }
  }
  const toCheck: Diff<C>['toCheck'] = [];
  const carried: Diff<C>['carried'] = [];
  fresh.forEach((cite, index) => {
    const key = citeKey(cite.citation_bluebook ?? cite.raw, cite.pin_cite);
    const k = pairKey(key, cite.raw ?? '');
    const avail = pool.get(k);
    if (!all && !stalePairs.has(k) && avail && avail.length) {
      carried.push({ cite, index, prior: avail.shift()! });
    } else {
      toCheck.push({ cite, index });
    }
  });
  const dropped = [...pool.values()].flat();
  return { toCheck, carried, dropped };
}

/** The pairs whose marks are stale in this document. */
export function stalePairsOf(doc: PMNode): Set<string> {
  return new Set(citeSpans(doc).filter((s) => s.attrs.stale).map((s) => pairKey(s.attrs.cite_key, s.attrs.raw)));
}

// ---------------------------------------------------------------------------
// The table: a projection of the marks
// ---------------------------------------------------------------------------

export interface TableRow {
  /** Index into the run's entries; null when a mark's entry is not in the run shown. */
  entryIndex: number | null;
  entry: DeskEntry | null;
  /** Where the mark is; null for an entry with no mark ("not located in the text"). */
  from: number | null;
  to: number | null;
  stale: boolean;
  attrs: CiteAttrs | null;
}

/**
 * Rows in document order, one per cite mark, each joined to its run entry by
 * run_id + cite_key + raw (occurrences consumed in order); then every entry of
 * the run that has no mark, in the run's order, as "not located".
 */
export function tableRows(doc: PMNode, entries: DeskEntry[], runId: string | null): TableRow[] {
  const pool = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const k = pairKey(e.cite_key, e.raw);
    pool.set(k, [...(pool.get(k) ?? []), i]);
  });
  const rows: TableRow[] = [];
  const seen = new Set<number>();
  for (const s of citeSpans(doc)) {
    let idx: number | null = null;
    if (s.attrs.run_id === runId) {
      const list = pool.get(pairKey(s.attrs.cite_key, s.attrs.raw));
      if (list && list.length) idx = list.shift()!;
    }
    if (idx !== null) seen.add(idx);
    rows.push({ entryIndex: idx, entry: idx === null ? null : entries[idx], from: s.from, to: s.to, stale: !!s.attrs.stale || idx === null, attrs: s.attrs });
  }
  entries.forEach((e, i) => {
    if (!seen.has(i)) rows.push({ entryIndex: i, entry: e, from: null, to: null, stale: false, attrs: null });
  });
  return rows;
}

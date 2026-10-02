// Versions of a brief, Word style (Eden, 10-02): one person works on a brief at
// a time; when a review is done it is saved as a new version (v18 → v19), a
// document of its own in the Vault, and the old one is left as it was. Compare
// shows what changed between any two versions as a redline.
//
// Pure: no Supabase, no DOM, so a node harness can drive it.

import { diffArrays, diffWordsWithSpace } from 'diff';
import type { BriefDoc, BriefNode } from './md';

// ---------------------------------------------------------------------------
// The next version's name
// ---------------------------------------------------------------------------

/**
 * The title with its version number moved on by one, keeping everything else:
 * "Bushell-Verified-Petition-Art78-v18-FILING" → "…-v19-FILING",
 * "Reply Brief v. 3" → "Reply Brief v. 4". The LAST number marked as a version
 * wins ("Art78" is not one). A title with none gets " v2".
 */
export function nextVersionTitle(title: string): string {
  const t = title.trim() || 'Untitled brief';
  const re = /(^|[^A-Za-z])([vV](?:er(?:sion)?)?\.?\s?)(\d{1,4})(?!\d)/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(t); m; m = re.exec(t)) last = m;
  if (!last) return `${t} v2`;
  const at = last.index + last[1].length + last[2].length;
  const n = last[3];
  const next = String(Number(n) + 1).padStart(n.length, '0');
  return t.slice(0, at) + next + t.slice(at + n.length);
}

/** The version number in a title, if it has one (for sorting a picker). */
export function versionNumber(title: string): number | null {
  const re = /(^|[^A-Za-z])[vV](?:er(?:sion)?)?\.?\s?(\d{1,4})(?!\d)/g;
  let n: number | null = null;
  for (let m = re.exec(title); m; m = re.exec(title)) n = Number(m[2]);
  return n;
}

// ---------------------------------------------------------------------------
// The text a redline compares
// ---------------------------------------------------------------------------

/**
 * The brief as blocks of plain text, in reading order: each heading, paragraph
 * and quoted paragraph is a block; a footnote leaves "[n]" where it sits and
 * its text is listed at the end under "Footnotes", numbered by position as
 * Word numbers them. So a note added, cut or reworded shows in the redline.
 */
export function redlineBlocks(doc: BriefDoc): string[] {
  const notes: string[] = [];
  const inline = (content: BriefNode[] | undefined): string => (content ?? []).map((n) => {
    if (n.type === 'text') return n.text ?? '';
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'footnote') { notes.push(inline(n.content)); return `[${notes.length}]`; }
    return inline(n.content);
  }).join('');
  const blocks: string[] = [];
  for (const b of doc?.content ?? []) {
    if (b.type === 'blockquote') {
      for (const p of b.content ?? []) blocks.push(inline(p.content));
    } else if (b.type === 'signatureBlock') {
      blocks.push((b.content ?? []).map((p) => inline(p.content)).join('\n'));
    } else {
      blocks.push(inline(b.content));
    }
  }
  const body = blocks.filter((s) => s.trim().length);
  if (!notes.length) return body;
  return [...body, 'Footnotes', ...notes.map((t, i) => `${i + 1}. ${t}`)];
}

// ---------------------------------------------------------------------------
// The redline
// ---------------------------------------------------------------------------

export type Piece = { op: '=' | '+' | '-'; text: string };
/** One block of the redline: unchanged, inserted whole, deleted whole, or changed within. */
export type RedlineBlock = { kind: 'same' | 'ins' | 'del' | 'chg'; pieces: Piece[] };
export interface Redline {
  blocks: RedlineBlock[];
  /** Blocks with any change, for "change 3 of 41" and the jump buttons. */
  changes: number;
  wordsAdded: number;
  wordsDeleted: number;
}

const words = (s: string) => (s.match(/\S+/g) ?? []).length;

/**
 * Paragraph by paragraph, then word by word inside each changed paragraph:
 * reads like a Word redline, and stays fast on a 60-page brief because the
 * word diff only runs on the paragraphs that differ.
 */
export function redline(older: BriefDoc, newer: BriefDoc): Redline {
  return redlineOfBlocks(redlineBlocks(older), redlineBlocks(newer));
}

export function redlineOfBlocks(a: string[], b: string[]): Redline {
  const out: RedlineBlock[] = [];
  let wordsAdded = 0;
  let wordsDeleted = 0;
  const parts = diffArrays(a, b);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      for (const s of p.value) out.push({ kind: 'same', pieces: [{ op: '=', text: s }] });
      continue;
    }
    // A run of removed blocks next to a run of added ones is the same
    // paragraphs rewritten: pair them up and diff their words.
    const removed = p.removed ? p.value : [];
    const added = p.added ? p.value : [];
    const nx = parts[i + 1];
    if (p.removed && nx?.added) { added.push(...nx.value); i++; }
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k++) {
      const pieces: Piece[] = diffWordsWithSpace(removed[k], added[k]).map((c) =>
        ({ op: c.added ? '+' : c.removed ? '-' : '=', text: c.value }));
      for (const pc of pieces) {
        if (pc.op === '+') wordsAdded += words(pc.text);
        if (pc.op === '-') wordsDeleted += words(pc.text);
      }
      out.push({ kind: 'chg', pieces });
    }
    for (const s of removed.slice(pairs)) { wordsDeleted += words(s); out.push({ kind: 'del', pieces: [{ op: '-', text: s }] }); }
    for (const s of added.slice(pairs)) { wordsAdded += words(s); out.push({ kind: 'ins', pieces: [{ op: '+', text: s }] }); }
  }
  return { blocks: out, changes: out.filter((x) => x.kind !== 'same').length, wordsAdded, wordsDeleted };
}

/** The button's short name for the next version: "v19", or "new version" when the title has no number. */
export function nextVersionLabel(title: string): string {
  const n = versionNumber(title);
  return n === null ? 'new version' : `v${n + 1}`;
}

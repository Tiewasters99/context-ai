// Defined terms: what a short form in THIS brief means (Eden, 10-16, after the
// Atkinson rehearing petitions: "Op." was the Fifth Circuit's opinion, never
// defined in the brief; "ROA" was the electronic record; "TAC" the third
// amended complaint). Every lawyer names things differently from the way the
// Vault files them, so the lawyer says it once — highlight "Op.", Define, pick
// "Fifth Circuit Opinion" — and every "Op. 13" opens that document at page 13.
//
// Two kinds:
//   document — the number after the term is a PAGE of one document ("Op. 13"),
//              or a paragraph when it carries ¶ ("TAC ¶ 55").
//   stamped  — the number is a page STAMP across a document or a folder of
//              volumes ("ROA.583", "JA 1845", a Bates number): the page whose
//              head or foot carries it.
// Kept on the brief (documents.metadata.defined_terms). Deterministic.

import type { QueryClient } from './record-cite';

export interface DefinedTerm {
  /** As the brief writes it: "Op.", "TAC", "ROA". */
  term: string;
  kind: 'document' | 'stamped';
  /** The document (kind document, or a single stamped volume). */
  documentId?: string;
  /** The folder of stamped volumes (kind stamped). */
  matterId?: string;
  /** What it opens, for the caveat line: "Fifth Circuit Opinion". */
  title: string;
}

/** "Op." / "op" / "OP " → "op". */
export const termKey = (t: string): string => t.trim().replace(/[.\s]+$/, '').toLowerCase();

// Signals and openers a highlight may carry in front of the term.
const LEAD = /^[\s(“"'‘[]*(?:(?:see\s+also|see|cf\.|citing|quoting|accord|but\s+see|e\.g\.,?)\s+)?/i;

/**
 * The defined term the highlight starts with — the longest that fits, so
 * "Pet. App." wins over "Pet." — and what follows it ("13", "¶¶ 85–89").
 */
export function matchDefinedTerm<T extends { term: string }>(label: string, terms: T[]): { def: T; rest: string } | null {
  const s = label.replace(LEAD, '');
  const sorted = [...terms].sort((a, b) => termKey(b.term).length - termKey(a.term).length);
  for (const def of sorted) {
    const k = termKey(def.term);
    if (!k) continue;
    if (s.slice(0, k.length).toLowerCase() !== k) continue;
    const after = s.slice(k.length);
    // a whole term: "Op." is not the start of "Opposition"
    if (/^[A-Za-z]/.test(after)) continue;
    return { def, rest: after.replace(/^\./, '').trim() };
  }
  return null;
}

export interface Pin { number: number | null; paragraph: number | null }

/** "13" → page 13; "¶¶ 85–89" → ¶ 85; "at 9–10" → 9; ".583–85" → 583; "" → nothing. */
export function parsePin(rest: string): Pin {
  const para = /¶¶?\s*(\d{1,5})/.exec(rest);
  if (para) return { number: null, paragraph: Number(para[1]) };
  const n = /^[\s.,:]*(?:at\s+)?(?:pp?\.\s*)?\*?(\d{1,7})/i.exec(rest);
  return { number: n ? Number(n[1]) : null, paragraph: null };
}

const CONNECT = new Set(['of', 'the', 'and', '&', 'for', 'to', 'on', 'in', 're']);

/**
 * The definitions a brief makes itself — "the Third Amended Complaint
 * (“TAC”)", "Record on Appeal (“ROA”)" — term key → long name. The long name
 * is the run of capitalised words (and connectors) just before the
 * parenthesis; a lower-case name ("the panel opinion (“Op.”)") gives its last
 * three words.
 */
export function briefDefinitions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\(\s*(?:the\s+|hereinafter\s+)?[“"]([^”"\n]{1,20})[”"]\s*\)/g;
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 160), m.index).replace(/[,\s]+$/, '');
    const words = before.split(/\s+/);
    const name: string[] = [];
    for (let i = words.length - 1; i >= 0 && name.length < 10; i--) {
      const raw = words[i];
      // the previous sentence, or the previous definition, ends the name
      if (name.length && (/[)”"]$/.test(raw) || /^\d.*\.$/.test(raw) || /^[a-z].*\.$/.test(raw))) break;
      const w = raw.replace(/^[“"‘(]+|[”"’),;:]+$/g, '');
      if (!w) break;
      if (/^[A-Z0-9]/.test(w) || (CONNECT.has(w.toLowerCase()) && name.length)) name.unshift(w);
      else break;
    }
    while (name.length && CONNECT.has(name[0].toLowerCase())) name.shift();
    const long = (name.length ? name : words.slice(-3)).join(' ').replace(/^[“"‘(]+/, '').trim();
    const key = termKey(m[1]);
    if (key && long && !out.has(key)) out.set(key, long);
  }
  return out;
}

type PassageRow = { document_id: string; page_start: number | null; sequence_number?: number | null; text: string | null; metadata: { pdf_page?: unknown } | null };
const pageOf = (p: PassageRow) => Number(p.metadata?.pdf_page ?? p.page_start);

/**
 * The page holding numbered paragraph `n` — a complaint's "55. Defendant…".
 * The number opens a line (or follows a blank), and a capital or a quote
 * begins the paragraph, so "in 2055." or "55 F.4th" does not count.
 */
export function paragraphPage(rows: PassageRow[], n: number): number | null {
  const re = new RegExp(`(?:^|\\n|\\s{2,}|\\.\\s)${n}\\.\\s+[A-Z“"‘(]`);
  const hit = [...rows]
    .sort((a, b) => (a.sequence_number ?? 0) - (b.sequence_number ?? 0) || pageOf(a) - pageOf(b))
    .find((r) => r.text && re.test(r.text));
  return hit ? pageOf(hit) : null;
}

export async function findParagraphPage(client: QueryClient, documentId: string, n: number): Promise<number | null> {
  const { data } = await client
    .from('passages')
    .select('document_id, page_start, sequence_number, text, metadata')
    .eq('document_id', documentId)
    .eq('summary_level', 0)
    .like('text', `%${n}.%`)
    .limit(300);
  return paragraphPage((data ?? []) as PassageRow[], n);
}

export interface StampHit { documentId: string; title: string; page: number }

/**
 * Pages stamped `n`: the number stands alone (no digit either side) in the
 * first or last 160 characters of the page, where a clerk's or a vendor's
 * stamp sits. A page listing many numbers there (an index) is passed over.
 */
export function stampedPageHits(rows: PassageRow[], titles: Map<string, string>, n: number): StampHit[] {
  const own = new RegExp(`(?<![0-9])0*${n}(?![0-9])`);   // Bates numbers are zero-padded
  // A stamp is glued to its prefix ("25-20513.56", "A-56", "DEF00056"); a
  // number after a space ("Document 56" in the court's header) ranks below.
  const glued = new RegExp(`[.\\-A-Za-z]0*${n}(?![0-9])`);
  const all: (StampHit & { score: number })[] = [];
  for (const r of rows) {
    const t = r.text ?? '';
    const ends = [t.slice(0, 160), t.slice(-160)];
    if (!ends.some((e) => own.test(e))) continue;
    const many = ends.some((e) => (e.match(/(?<![0-9])\d{2,7}(?![0-9])/g) ?? []).length > 8);
    if (many) continue;
    const page = pageOf(r);
    if (!Number.isFinite(page)) continue;
    all.push({ documentId: r.document_id, title: titles.get(r.document_id) ?? 'Document', page, score: ends.some((e) => glued.test(e)) ? 0 : 1 });
  }
  // the best page of each document, best documents first
  const seen = new Set<string>();
  return all
    .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title) || a.page - b.page)
    .filter((h) => (seen.has(h.documentId) ? false : (seen.add(h.documentId), true)))
    .map(({ documentId, title, page }) => ({ documentId, title, page }));
}

/** The documents a stamped term covers: one volume, or every document in a folder and its subfolders. */
export async function findStampedPages(client: QueryClient, docs: { id: string; title: string }[], n: number): Promise<StampHit[]> {
  if (!docs.length) return [];
  const titles = new Map(docs.map((d) => [d.id, d.title]));
  const ids = docs.map((d) => d.id);
  const rows: PassageRow[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await client
      .from('passages')
      .select('document_id, page_start, text, metadata')
      .in('document_id', ids.slice(i, i + 100))
      .eq('summary_level', 0)
      .like('text', `%${n}%`)
      .limit(1000);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as PassageRow[]));
  }
  return stampedPageHits(rows, titles, n);
}

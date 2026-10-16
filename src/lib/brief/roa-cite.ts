// A Fifth Circuit record cite — "ROA.1527", "ROA.1506–07, 1510",
// "ROA.25-20513.1527" — to the page of the electronic record on appeal that
// carries that stamp.
//
// The clerk's EROA stamps every page "25-20513.1527" (docket, dot, page), so
// unlike an appendix volume the page is found by its stamp alone: no named
// range, no chooser. The record is whatever document the person can read
// whose title says so (EROA, ROA, Record on Appeal, E-Record). When the cite
// names no docket, the brief's own caption does ("No. 25-20513"); failing
// both, the first record that carries the page wins and the others are named.
//
// Deterministic. No model.

import type { QueryClient } from './record-cite';

export interface RoaCite { docket: string | null; first: number; last: number | null }

/** The first ROA cite in `text` — the highlight may carry a signal or a trailing list. */
export function parseRoaCite(text: string): RoaCite | null {
  const m = /\bROA\s*\.?\s*(?:(\d{2}-\d{4,5})\.)?(\d{1,6})(?:\s*[-–—]\s*(\d{1,6}))?(?!\d)/i.exec(text);
  if (!m) return null;
  const first = Number(m[2]);
  let last: number | null = null;
  if (m[3]) {
    // "1506–07" means 1507: the short form borrows the leading digits.
    last = m[3].length < m[2].length ? Number(m[2].slice(0, m[2].length - m[3].length) + m[3]) : Number(m[3]);
    if (last < first) last = null;
  }
  return { docket: m[1] ?? null, first, last };
}

/** "No. 25-20513" in the brief's caption, the docket an unnumbered "ROA.1527" belongs to. */
export function docketOfCaption(text: string): string | null {
  return /\bNo\.\s*(\d{2}-\d{4,5})\b/.exec(text)?.[1] ?? null;
}

export interface RoaPage { documentId: string; title: string; docket: string; page: number }

const STAMPS = /(?<![0-9])(\d{2}-\d{4,5})\.(\d{1,6})(?![0-9])/g;

/**
 * The record pages stamped `<docket>.<n>`, best first. A page carries its own
 * stamp; an index or a table of contents carries dozens, so a passage with
 * more than three distinct stamps is not the page.
 */
export function stampedPages(
  rows: { document_id: string; page_start: number | null; text: string | null; metadata: { pdf_page?: unknown } | null }[],
  titles: Map<string, string>,
  n: number,
): RoaPage[] {
  const out: RoaPage[] = [];
  for (const r of rows) {
    const stamps = [...(r.text ?? '').matchAll(STAMPS)];
    if (new Set(stamps.map((s) => s[0])).size > 3) continue;
    const own = stamps.find((s) => Number(s[2]) === n);
    if (!own) continue;
    const page = Number(r.metadata?.pdf_page ?? r.page_start);
    if (!Number.isFinite(page)) continue;
    out.push({ documentId: r.document_id, title: titles.get(r.document_id) ?? 'Record on appeal', docket: own[1], page });
  }
  // one row per document (the first page carrying it), in title order
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.title.localeCompare(b.title) || a.page - b.page)
    .filter((h) => (seen.has(h.documentId) ? false : (seen.add(h.documentId), true)));
}

/** Every page of a record on appeal the caller can read stamped `<docket>.<n>`; the docket's own first. */
export async function findRoaPages(client: QueryClient, n: number, docket: string | null): Promise<RoaPage[]> {
  const { data, error } = await client
    .from('documents')
    .select('id, title')
    .or('title.ilike.%EROA%,title.like.%ROA%,title.ilike.%record on appeal%,title.ilike.%e-record%')
    .limit(1000);
  if (error) throw new Error(error.message);
  const docs = (data ?? []) as { id: string; title: string | null }[];
  if (!docs.length) return [];
  const titles = new Map(docs.map((d) => [d.id, d.title ?? 'Record on appeal']));
  const ids = docs.map((d) => d.id);
  const rows: Parameters<typeof stampedPages>[0] = [];
  // a hundred ids a request keeps the query string well short of any limit
  for (let i = 0; i < ids.length; i += 100) {
    const { data: ps, error: pe } = await client
      .from('passages')
      .select('document_id, page_start, text, metadata')
      .in('document_id', ids.slice(i, i + 100))
      .eq('summary_level', 0)
      .like('text', docket ? `%${docket}.${n}%` : `%.${n}%`)
      .limit(500);
    if (pe) throw new Error(pe.message);
    rows.push(...((ps ?? []) as typeof rows));
  }
  const hits = stampedPages(rows, titles, n);
  return docket ? hits.filter((h) => h.docket === docket) : hits;
}

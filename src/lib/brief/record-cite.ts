// A record cite — "A-10", "JA 1845", "Appx. 59", "A-1845–46" — to the page of
// the appendix the brief cites (Eden, 09-27: "here we do need some judgment").
//
// Name search cannot do this: a volume is named for its RANGE ("Joint
// Appendix Vol. I (A-1 to A-77) …"), so "A-10" matched a Webster document that
// happened to carry "A-10" in its name, and "A-8" matched nothing. And the
// same numbers exist in several appendices (the FINAL set, two dry runs, an
// exhibit elsewhere), so which appendix a brief cites is the lawyer's call,
// asked once and remembered on the brief (metadata.record_matter_id).
//
// Deterministic: the volume whose named range covers the number; the page
// whose indexed text carries the stamp "A-10" (the page nearest where A-10
// should fall, when the stamp appears on more than one — a table of contents
// lists them too); else that estimate. No model.

import type { RpcClient } from './resolve';

/** What the desk needs of a Supabase client here (a PostgREST query builder). */
export interface QueryClient extends RpcClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface RecordCite { first: number; last: number | null }

/** "A-10", "JA 10", "J.A. 10", "Appx. 10", "A-1845–46", "A-1845-1846" → numbers; null if it is not one. */
export function parseRecordCite(text: string): RecordCite | null {
  const m = /^\s*(?:J\.?\s?A\.?|Appx\.?|App\.?|A)\s*[-‑]?\s*(\d{1,5})(?:\s*[-–—]\s*(?:A-?)?(\d{1,5}))?\s*[.,;)]?\s*$/i.exec(text);
  if (!m) return null;
  const first = Number(m[1]);
  let last: number | null = null;
  if (m[2]) {
    // "1845–46" means 1846: the short form borrows the leading digits.
    last = m[2].length < m[1].length ? Number(m[1].slice(0, m[1].length - m[2].length) + m[2]) : Number(m[2]);
    if (last < first) last = null;
  }
  return { first, last };
}

/** "(A-1 to A-77)" in a volume's name → [1, 77]. */
export function rangeOfTitle(title: string): [number, number] | null {
  const m = /\(\s*A-?\s*(\d{1,5})\s*(?:to|–|-|—)\s*A-?\s*(\d{1,5})\s*\)/i.exec(title);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export interface Volume { id: string; title: string; matterspace_id: string; from: number; to: number }

/** Every appendix volume the caller can open whose named range covers `n`, grouped by the set (matter) it belongs to. */
export async function appendixSetsFor(client: QueryClient, n: number): Promise<Map<string, Volume[]>> {
  const { data, error } = await client
    .from('documents')
    .select('id, title, matterspace_id')
    .ilike('title', '%(A-% to A-%)%')
    .limit(1000);
  if (error) throw new Error(error.message);
  const sets = new Map<string, Volume[]>();
  for (const d of (data ?? []) as { id: string; title: string; matterspace_id: string }[]) {
    const r = rangeOfTitle(d.title ?? '');
    if (!r || n < r[0] || n > r[1]) continue;
    const v: Volume = { ...d, from: r[0], to: r[1] };
    sets.set(d.matterspace_id, [...(sets.get(d.matterspace_id) ?? []), v]);
  }
  return sets;
}

const stampRe = (n: number) => new RegExp(`(^|[^0-9A-Za-z-])A-${n}(?![0-9])`);

/**
 * The PDF page of A-`n` in a volume. A record page carries its own stamp and
 * perhaps a neighbour's; a table of contents or index carries dozens of
 * A-numbers, so a page with many is not the stamp. Of the stamped pages, the
 * first at or after the earliest place A-`n` can sit (a volume's record starts
 * on or after PDF page 1, so A-`n` is on page n − from + 1 or later).
 */
export async function pageOfStamp(client: QueryClient, volume: Volume, n: number): Promise<{ page: number; basis: 'stamp' | 'estimate' }> {
  const { data } = await client
    .from('passages')
    .select('page_start, text, metadata')
    .eq('document_id', volume.id)
    .eq('summary_level', 0)
    .ilike('text', `%A-${n}%`)
    .limit(200);
  const re = stampRe(n);
  const earliest = n - volume.from + 1;
  const hits = ((data ?? []) as { page_start: number | null; text: string | null; metadata: { pdf_page?: unknown } | null }[])
    .filter((p) => p.text && re.test(p.text))
    // A cover or a contents page names a range ("A-1 to A-77"); a record page does not.
    .filter((p) => !/A-\d{1,5}\s*(?:to|through|–|—)\s*A-\d{1,5}/i.test(p.text as string))
    .filter((p) => new Set((p.text as string).match(/(?<![0-9A-Za-z-])A-\d{1,5}(?![0-9])/g) ?? []).size <= 3)
    // A transcript's passages are filed under its PRINTED page ("Pages 90..93");
    // the physical page is metadata.pdf_page. The Reader navigates by the physical one.
    .map((p) => Number(p.metadata?.pdf_page ?? p.page_start))
    .filter((p) => Number.isFinite(p) && p >= earliest)
    .sort((a, b) => a - b);
  if (hits.length) return { page: hits[0], basis: 'stamp' };
  // No readable stamp (a scanned page): the usual front matter is a cover and an index.
  return { page: earliest + 2, basis: 'estimate' };
}

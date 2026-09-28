// A docket cite — "No. 26-2098, Doc. 5" (an appellate docket entry), "ECF 80"
// (a district docket entry) — to the docket sheet in the record, at the page
// that lists the entry (Eden, 09-28: "Those are not getting picked up by the
// system. Is the docketing event not in the appeal record?" It was; the desk
// did not read the cite).
//
// Deterministic, like record-cite.ts: the docket sheet is the document in the
// record whose title carries the docket number and the word Docket (the
// Third Circuit pull "26-2098 Docket"; the PACER report for the district
// case); the page is the one whose text lists the entry number after a date.
// The filed paper itself, when the pull also holds it ("26-2098_Documents"),
// is named in the caveat so the reader can go on to it. No model.

import type { QueryClient } from './record-cite';

export interface DocketCite {
  /** "26-2098" for an appellate docket; null for a district ECF cite. */
  docket: string | null;
  entry: number;
  kind: 'appellate' | 'district';
}

/**
 * "No. 26-2098, Doc. 5" / "No. 26-2098, Dkt. 5" → appellate; "Id., Doc. 23" / "Doc. 23" → appellate, the docket
 * carried over from the cite before it (`fallbackDocket`, read from the sentence or the last docket opened);
 * "ECF 80" / "ECF No. 80" → district.
 */
export function parseDocketCite(text: string, fallbackDocket: string | null = null): DocketCite | null {
  const s = text.replace(/\s+/g, ' ').trim();
  let m = /^(?:No\.|Nos\.)?\s*(\d{2}-\d{4,5}),?\s*(?:Doc\.|Docket|Dkt\.|D\.E\.|ECF)\s*(?:No\.)?\s*(\d{1,4})\s*[.,;)]?$/i.exec(s);
  if (m) return { docket: m[1], entry: Number(m[2]), kind: 'appellate' };
  m = /^(?:Id\.,?\s*)?(?:Doc\.|Dkt\.)\s*(?:No\.)?\s*(\d{1,4})\s*[.,;)]?$/i.exec(s);
  if (m) return fallbackDocket ? { docket: fallbackDocket, entry: Number(m[1]), kind: 'appellate' } : null;
  m = /^(?:ECF|D\.E\.|Dkt\.|Docket)\s*(?:No\.)?\s*(\d{1,4})(?:\s*(?:at|,)\s*\d{1,4}(?:[–-]\d{1,4})?)?\s*[.,;)]?$/i.exec(s);
  if (m) return { docket: null, entry: Number(m[1]), kind: 'district' };
  return null;
}

export interface DocketHit { documentId: string; title: string; page: number; basis: 'entry' | 'estimate' | 'start'; papers?: { documentId: string; title: string } | null }

/**
 * The docket sheet and the page listing the entry. Appellate: a document titled
 * "<docket> Docket…"; district: a document whose title says "docket" and the
 * district case ("District court docket, 2:25-cv-…" or a PACER "Docketsheet").
 * The page: the first passage whose text has "<date> <entry> " (a PACER line
 * begins with the filed date, then the entry number).
 */
export async function findDocketEntry(client: QueryClient, cite: DocketCite): Promise<DocketHit | null> {
  const like = cite.kind === 'appellate' ? `${cite.docket} Docket%` : '%docket%';
  const { data, error } = await client
    .from('documents')
    .select('id, title')
    .ilike('title', like)
    .limit(50);
  if (error) throw new Error(error.message);
  let sheets = (data ?? []) as { id: string; title: string }[];
  if (cite.kind === 'district') {
    // the district case's docket, not an appellate one and not a note about the docket
    sheets = sheets.filter((d) => /docket ?sheet|district court docket|pacer report/i.test(d.title) && !/^\d{2}-\d{4}/.test(d.title) && !/inventory|status|map|not included/i.test(d.title));
  }
  if (!sheets.length) return null;
  const sheet = sheets[0];
  const { data: pages } = await client
    .from('passages')
    .select('page_start, text')
    .eq('document_id', sheet.id)
    .eq('summary_level', 0)
    .order('page_start', { ascending: true })
    .limit(400);
  // A PACER line: the filed date, then the entry number. The text layer of a
  // district report can run them together ("04/09/202680 MEMORANDUM"), so the
  // year is pinned to four digits and the space after it is optional.
  // Every "<date> <entry>" pair on the sheet → the page it is on. An entry whose
  // line the text layer lost (the 26-2098 sheet lacks 6–20) is placed between
  // its neighbours: the page of the nearest listed entry below it.
  const lineRe = /(?:^|\n|\s)\d{1,2}\/\d{1,2}\/\d{4}\s*(\d{1,4})\s/g;
  const where = new Map<number, number>();
  for (const p of (pages ?? []) as { page_start: number | null; text: string | null }[]) {
    if (!p.text || p.page_start == null) continue;
    for (const m of p.text.matchAll(lineRe)) {
      const n = Number(m[1]);
      if (n > 0 && n < 10000 && !where.has(n)) where.set(n, p.page_start);
    }
  }
  let hit: { page_start: number } | null = where.has(cite.entry) ? { page_start: where.get(cite.entry)! } : null;
  let estimated = false;
  if (!hit && where.size) {
    const below = [...where.keys()].filter((n) => n < cite.entry).sort((a, b) => b - a)[0];
    if (below !== undefined) { hit = { page_start: where.get(below)! }; estimated = true; }
  }
  let papers: DocketHit['papers'] = null;
  if (cite.kind === 'appellate') {
    const { data: docs } = await client.from('documents').select('id, title').ilike('title', `${cite.docket}_Documents%`).limit(1);
    const d = ((docs ?? []) as { id: string; title: string }[])[0];
    if (d) papers = { documentId: d.id, title: d.title };
  }
  return { documentId: sheet.id, title: sheet.title, page: hit?.page_start ?? 1, basis: hit ? (estimated ? 'estimate' : 'entry') : 'start', papers };
}

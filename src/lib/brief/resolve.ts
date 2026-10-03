// The Brief Desk's resolvers, browser side (slice D2; docs/specs/
// BRIEF-DESK-2026-09-26.md §3.4). A cite-check entry → the case document in
// the matter it names, and its pinpoint → the passage on that printed page.
// Deterministic: two RPCs over metadata ingest already wrote (migration 101),
// no model.
//
// The cite is parsed with lib/bluebook.mjs's reporter grammar — the same
// normalizeReporter() ingest used to write document_citations — so a brief's
// "143 F.3d 1219" and the stored row are spelled alike.
//
// D3 calls resolveEntry() per entry after a run (or a carry-forward) and puts
// citeMarkAttrs() onto the cite mark. The client is passed in, so this module
// does not import '@/lib/supabase' and the harness can drive it directly.

import { parseReporterCites, type ReporterCite } from '../../../lib/bluebook.mjs';
import type { ReportEntry } from '@/lib/cite-check/types';

/** What the resolvers need of a Supabase client. */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/** One row of public.resolve_citation. */
export interface CitationHit {
  document_id: string;
  title: string | null;
  how: 'reporter' | 'name';
  matterspace_id: string;
  reporter: string | null;
  volume: number | null;
  page: number | null;
  /** The star level carrying this reporter's pages; null = this copy does not mark them. */
  star_level: number | null;
  case_name: string | null;
}

export type PageBasis = 'printed' | 'parallel' | 'pin_not_found' | 'pdf_index_declined' | 'unknown';

/** One row of public.passage_for_printed_page. */
export interface PassageHit {
  passage_id: string;
  page_start: number | null;
  basis: PageBasis;
  /** In words, for under the authority's title; null when the page is the reporter's own. */
  caveat: string | null;
  printed_page: number | null;
  printed_page_end: number | null;
}

export type ResolutionStatus =
  | 'resolved'        // one document; `passage` says where
  | 'two_copies'      // more than one document carries the cite — the row says "N copies — pick one"
  | 'not_in_corpus'   // nothing in the matter carries it
  | 'not_a_case';     // no reporter cite and no case name to look up by

export interface Resolution {
  status: ResolutionStatus;
  /** The reporter cites parsed from the entry, in order (a parallel cite gives two). */
  cites: ReporterCite[];
  /** The pinpoint looked up, from `entry.pin` or else the citation text. */
  pin: number | null;
  /** Every document found; one when resolved. */
  hits: CitationHit[];
  /** For a resolved entry: the passage at the pin (or where the case opens). */
  passage: PassageHit | null;
}

type Entry = Pick<ReportEntry, 'citation' | 'case_name' | 'pin'>;

/**
 * The pinpoint as a reporter page number. "1221", "at 1221", "1221–22" → 1221.
 * A Westlaw star page ("*3") is a WL cite's screen page, not a reporter page: null.
 */
export function pinPage(pin: string | null | undefined): number | null {
  if (!pin) return null;
  const s = String(pin).trim();
  if (/^\*|\bWL\b/.test(s)) return null;
  const m = /^(?:at\s+)?(\d{1,5})\b/.exec(s);
  return m ? Number(m[1]) : null;
}

/** The case name to fall back on: the extractor's, else the citation up to its first comma. */
export function caseNameOf(entry: Entry): string | null {
  const own = entry.case_name?.trim();
  if (own) return own;
  const head = /^([^,]{3,200}?\sv\.?\s[^,]{1,200}?),/.exec(String(entry.citation || '').trim());
  return head ? head[1].replace(/^\*|\*$/g, '').trim() : null;
}

/**
 * Where a cite-check entry lives in the matter's corpus.
 *
 * Reporter first, each parallel cite in turn until one is found; the name
 * fallback runs only when the citation has no reporter cite at all (the RPC
 * enforces the same rule). With exactly one document, the passage at the pin.
 */
export async function resolveEntry(client: RpcClient, matterId: string, entry: Entry): Promise<Resolution> {
  const cites = parseReporterCites(entry.citation);
  const fromPin = pinPage(entry.pin);
  let hits: CitationHit[] = [];
  let matched: ReporterCite | null = null;

  for (const c of cites) {
    hits = await callResolve(client, {
      p_matter: matterId, p_reporter: c.reporter, p_volume: c.volume, p_page: c.page, p_case_name: null,
    });
    if (hits.length) { matched = c; break; }
  }

  const name = cites.length ? null : caseNameOf(entry);
  if (!cites.length) {
    if (!name) return { status: 'not_a_case', cites, pin: fromPin, hits: [], passage: null };
    hits = await callResolve(client, {
      p_matter: matterId, p_reporter: null, p_volume: null, p_page: null, p_case_name: name,
    });
  }

  // Every reporter cite missed. A Westlaw file often opens with ONE of a
  // case's parallel cites (Pioneer, 09-28: "113 S.Ct. 1489" and never "507
  // U.S. 380"), so the index has no row for the reporter the brief uses. The
  // same case name AND the same decision year is that case, not a guess; a
  // name alone would be (the RPC's rule). Only where the client can read the
  // header the ingest parsed.
  let usByStar = false;   // a Supreme Court file's unnamed single-star pages are U.S. Reports pages
  if (cites.length && !hits.length && hasFrom(client)) {
    const byName = caseNameOf(entry);
    const year = yearOf(entry.citation);
    if (byName && year) {
      const named = await callResolve(client, {
        p_matter: matterId, p_reporter: null, p_volume: null, p_page: null, p_case_name: byName,
      });
      if (named.length) {
        const heads = await headersOf(client, [...new Set(named.map((h) => h.document_id))]);
        const same = new Set([...heads].filter(([, h]) => h.year === year).map(([id]) => id));
        hits = named.filter((h) => same.has(h.document_id));
        if (hits.length) {
          matched = cites[0];
          const h = heads.get(hits[0].document_id);
          usByStar = cites[0].reporter === 'U.S.' && h?.scotus === true && !h.reporters.includes('U.S.');
        }
      }
    }
  }

  // The pin: the one written after the cite that matched; else the
  // extractor's own field. A pin written after one reporter is not a page of
  // another — in "556 U.S. 662, 678, 129 S. Ct. 1937, 1949" matched on the
  // S. Ct. copy, the extractor's "678" is a U.S. page.
  const pin = matched?.pin ?? fromPin ?? null;

  if (!hits.length) return { status: 'not_in_corpus', cites, pin, hits, passage: null };
  // One document can appear once per matching reporter row; count documents.
  const documents = [...new Set(hits.map((h) => h.document_id))];
  if (documents.length > 1) return { status: 'two_copies', cites, pin, hits, passage: null };

  const hit = hits[0];
  // A name match has no reporter, so no level: open where the case begins —
  // unless the file is a Supreme Court opinion whose single-star pages name
  // no reporter: Westlaw's first star set on a Supreme Court case is the U.S.
  // Reports, so a U.S. pin is looked up at level 1.
  const ordinal = hit.how === 'reporter' ? hit.star_level : 1;
  const passage = await passageForPrintedPage(client, hit.document_id, hit.how === 'reporter' || usByStar ? pin : null, ordinal);
  return { status: 'resolved', cites, pin, hits, passage };
}

/** The decision year in a citation's court parenthetical: "(3d Cir. 2012)", "(1993)" → 2012, 1993. */
export function yearOf(citation: string | null | undefined): number | null {
  const s = String(citation ?? '');
  let m: RegExpExecArray | null; let last: string | null = null;
  const re = /\(([^()]*?)\b((?:1[89]|20)\d{2})\)/g;
  while ((m = re.exec(s))) last = m[2];
  return last ? Number(last) : null;
}

type FromClient = RpcClient & { from(table: string): { select(cols: string): { in(col: string, ids: string[]): PromiseLike<{ data: unknown; error: { message: string } | null }> } } };
const hasFrom = (c: RpcClient): c is FromClient => typeof (c as { from?: unknown }).from === 'function';

/** What the ingest parsed from each document's Westlaw header: the year, the court, the reporters it opens with. */
async function headersOf(client: FromClient, ids: string[]): Promise<Map<string, { year: number | null; scotus: boolean; reporters: string[] }>> {
  const out = new Map<string, { year: number | null; scotus: boolean; reporters: string[] }>();
  if (!ids.length) return out;
  const { data } = await client.from('documents').select('id, metadata').in('id', ids);
  type Row = { id: string; metadata: { westlaw_case?: { date?: { year?: unknown }; court?: { level?: unknown }; reporters?: { reporter?: unknown }[] } } | null };
  for (const r of (data ?? []) as Row[]) {
    const wc = r.metadata?.westlaw_case;
    const y = Number(wc?.date?.year);
    out.set(r.id, {
      year: Number.isFinite(y) && y > 0 ? y : null,
      scotus: wc?.court?.level === 'scotus',
      reporters: (wc?.reporters ?? []).map((x) => String(x?.reporter ?? '')),
    });
  }
  return out;
}

/** public.passage_for_printed_page — null when the document has no passages or is out of scope. */
export async function passageForPrintedPage(
  client: RpcClient, documentId: string, page: number | null, reporterOrdinal: number | null,
): Promise<PassageHit | null> {
  const { data, error } = await client.rpc('passage_for_printed_page', {
    p_document: documentId, p_page: page, p_reporter_ordinal: reporterOrdinal,
  });
  if (error) throw new Error(`passage_for_printed_page: ${error.message}`);
  const rows = (data ?? []) as PassageHit[];
  return rows[0] ?? null;
}

async function callResolve(client: RpcClient, args: Record<string, unknown>): Promise<CitationHit[]> {
  const { data, error } = await client.rpc('resolve_citation', args);
  if (error) throw new Error(`resolve_citation: ${error.message}`);
  return (data ?? []) as CitationHit[];
}

/** The cite mark's corpus attrs (src/lib/brief/schema.ts `Cite`) for a resolution. */
export function citeMarkAttrs(r: Resolution): { authority_document_id: string | null; passage_id: string | null; pin: string | null } {
  const resolved = r.status === 'resolved';
  return {
    authority_document_id: resolved ? r.hits[0].document_id : null,
    passage_id: resolved ? r.passage?.passage_id ?? null : null,
    pin: r.pin === null ? null : String(r.pin),
  };
}

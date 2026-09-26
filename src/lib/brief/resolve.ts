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
  // A name match has no reporter, so no level: open where the case begins.
  const ordinal = hit.how === 'reporter' ? hit.star_level : 1;
  const passage = await passageForPrintedPage(client, hit.document_id, hit.how === 'reporter' ? pin : null, ordinal);
  return { status: 'resolved', cites, pin, hits, passage };
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

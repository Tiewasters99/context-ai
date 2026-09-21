// The Vault's document reads, paged.
//
// PostgREST answers an unbounded `select` with at most `db-max-rows` rows
// (1,000 on this project) and says nothing about it. Until this module the
// Vault's file list was exactly that read: a matter tree with 1,240 documents
// showed 1,000 of them, in recency order, with no notice and no error — and
// the 240 that were missing were missing from the count, from the "Search
// files…" filter, and from the Moot Bench's source picker too. For a lawyer
// working a matter to the bottom, a list that is quietly short is worse than
// a list that fails: nothing on the screen says to look again.
//
// The query lives here, away from `vault-persist.ts`, for one practical
// reason: `vault-persist.ts` imports the browser Supabase client at module
// scope, so nothing in it can be exercised by an offline harness. Here the
// client is an argument, and `scripts/_verify-vault-paged-reads.mjs` drives
// the real query builder with a stub that hands back 12,000 synthetic rows.
//
// Two rules of `paged.ts` apply, and both are honoured below:
//   1. A UNIQUE TIEBREAKER. `created_at` alone is not a stable order here —
//      a folder dropped on the Vault inserts hundreds of rows inside the same
//      millisecond, and rows the ORDER BY treats as equal swap between
//      `.range()` pages, which duplicates some and DROPS others. `id` breaks
//      every tie.
//   2. A CEILING, AND SAYING SO. The loop stops at `VAULT_DOCUMENT_CEILING`
//      and reports `truncated`, so the surface can say "Showing the first
//      20,000 of 43,118" instead of pretending.

import { fetchPaged, type PagedPage, type PagedRows } from './paged';
import type { VaultGrouping } from './vault-grouping';

/**
 * The columns the Vault's file rows are built from. One string, so the
 * single-matter and whole-tree reads cannot drift apart.
 */
export const VAULT_DOCUMENT_COLUMNS =
  'id, title, source_filename, file_size_bytes, processing_status, processing_error, ' +
  'matterspace_id, storage_path, text_status:metadata->>text_status, ocr_pending:metadata->ocr_pending';

/**
 * The same columns plus the two migration 081 adds. Asked for ONLY when the
 * reader has chosen A–Z or Category, which is what keeps this change invisible
 * — and harmless — on a database where 081 has not been pasted yet: the
 * default date list sends byte for byte the request it has always sent.
 */
export const VAULT_DOCUMENT_COLUMNS_ORGANIZED = `${VAULT_DOCUMENT_COLUMNS}, sort_key, category`;

/**
 * What each grouping asks the SERVER to order by. Every chain ends with the
 * unique tiebreaker `id` — paged.ts's first rule, and not optional: a folder
 * dropped on the Vault gives hundreds of rows the same `created_at`, and rows
 * the ORDER BY treats as equal swap between `.range()` pages, which duplicates
 * some and drops others.
 *
 * Migration 081 builds one index per line below, so each of these is an
 * ordered index read inside a single matter rather than a sort of the matter.
 */
const ORDER_BY: Record<VaultGrouping, { col: string; ascending: boolean }[]> = {
  date: [
    { col: 'created_at', ascending: false },
    { col: 'id', ascending: false },
  ],
  name: [
    { col: 'sort_key', ascending: true },
    { col: 'id', ascending: true },
  ],
  category: [
    { col: 'category_rank', ascending: true },
    { col: 'sort_key', ascending: true },
    { col: 'id', ascending: true },
  ],
};

/**
 * PostgREST's answer when a column does not exist — which, for this module, is
 * the whole of "the code merged before the migration was pasted". It is not a
 * transient failure and must not be retried three times with sleeps; it is a
 * signal to go back to the date list and say so.
 */
export class VaultColumnsMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultColumnsMissingError';
  }
}

function looksLikeMissingColumn(message: string): boolean {
  // Deliberately narrow. A loose `/sort_key/` would swallow a genuine outage
  // whose message happened to quote the query, and silently downgrade the
  // list for the rest of the session instead of retrying it.
  return /42703/.test(message)
    || /column .*(sort_key|category_rank|category).* does not exist/i.test(message);
}

export interface VaultDocumentRow {
  id: string;
  title: string | null;
  source_filename: string | null;
  file_size_bytes: number | null;
  processing_status: string;
  processing_error: string | null;
  matterspace_id: string;
  storage_path?: string | null;
  text_status?: string | null;
  /** `metadata->ocr_pending` arrives typed as Json; the caller narrows it. */
  ocr_pending?: unknown;
  /** Migration 081, and only on an A–Z or Category read. */
  sort_key?: string | null;
  category?: string | null;
}

/**
 * The slice of the PostgREST query builder this module drives. Declared
 * structurally rather than imported from supabase-js so the harness can pass
 * a recorder in its place (`vault-persist.ts` casts the real client to it, as
 * that module already does for the matter lookup's embedded select).
 */
export interface DocumentsQuery {
  in(column: string, values: string[]): DocumentsQuery;
  order(column: string, options?: { ascending?: boolean }): DocumentsQuery;
  range(from: number, to: number): PromiseLike<PagedPage<VaultDocumentRow>>;
}

export interface DocumentsSource {
  from(table: 'documents'): {
    select(columns: string, options?: { count: 'exact' }): DocumentsQuery;
  };
}

/**
 * Where the loop stops. 20,000 documents is past anything one matter tree
 * holds today (the largest on this deployment is in the hundreds) and still
 * a finite number of requests; past it the list says how many it is showing.
 */
export const VAULT_DOCUMENT_CEILING = 20_000;

export interface FetchMatterDocumentsOptions {
  /** Stop after this many rows and report `truncated`. */
  ceiling?: number;
  /** Rows per request. Clamped to 1,000 by `fetchPaged`. */
  pageSize?: number;
  /**
   * Attempts per page. A transient failure — most often an expired session
   * token being refreshed as the app opens — used to be swallowed and
   * rendered as an EMPTY FOLDER ("Blue Book / Robert Frost not showing up",
   * 2026-08-10). Retry briefly, then throw so the caller shows a real error.
   */
  attempts?: number;
  /** Injected by the harness so a retry test does not actually sleep. */
  delay?: (ms: number) => Promise<void>;
  /**
   * Which order the SERVER should return the rows in. Defaults to 'date' —
   * the Vault's behaviour since it had a list. 'name' and 'category' need
   * migration 081's columns; if they are absent the read falls back to 'date'
   * and reports `orderFellBack`, because a list that errors is worse than a
   * list in the wrong order.
   */
  order?: VaultGrouping;
}

export interface VaultDocumentPage extends PagedRows<VaultDocumentRow> {
  /** The asked-for order needed migration 081 and this database has not got it. */
  orderFellBack?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Every document row in a set of matters (one matter, or a parent and its
 * descendants), newest first, paged past the 1,000-row cap.
 *
 * `total` is the server's own `count: 'exact'` — asked for once, on the first
 * page only, because a COUNT(*) under RLS on 46,000 documents is not free and
 * `fetchPaged` reads only the first one. It is what a badge should show: the
 * number of documents that exist, not the number this call happens to hold.
 */
export async function fetchMatterDocumentRows(
  db: DocumentsSource,
  matterIds: string[],
  options: FetchMatterDocumentsOptions = {},
): Promise<VaultDocumentPage> {
  if (matterIds.length === 0) return { rows: [], total: 0, truncated: false };

  const attempts = Math.max(1, options.attempts ?? 3);
  const delay = options.delay ?? sleep;
  const wanted = options.order ?? 'date';

  const readIn = (order: VaultGrouping) => {
    const columns = order === 'date' ? VAULT_DOCUMENT_COLUMNS : VAULT_DOCUMENT_COLUMNS_ORGANIZED;
    const readPage = async (from: number, to: number): Promise<PagedPage<VaultDocumentRow>> => {
      let lastMsg = 'unknown error';
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await delay(600 * attempt);
        // The count is asked for on the first page only.
        let qb = db
          .from('documents')
          .select(columns, from === 0 ? { count: 'exact' } : undefined)
          .in('matterspace_id', matterIds);
        // Ends with the unique tiebreaker `id` in every mode. Without it a
        // bulk import's identical created_at values let rows swap between
        // pages — and A–Z has the same trap, because two copies of the same
        // case export share a sort key exactly.
        for (const { col, ascending } of ORDER_BY[order]) qb = qb.order(col, { ascending });
        const res = await qb.range(from, to);
        if (!res.error) return res;
        lastMsg = res.error.message;
        // A column this database has not got is not a transient failure.
        if (order !== 'date' && looksLikeMissingColumn(lastMsg)) {
          throw new VaultColumnsMissingError(lastMsg);
        }
        console.error(`list documents [${from}–${to}] (attempt ${attempt + 1}/${attempts}):`, lastMsg);
      }
      throw new Error(`list documents: ${lastMsg}`);
    };
    return fetchPaged<VaultDocumentRow>(readPage, {
      ceiling: options.ceiling ?? VAULT_DOCUMENT_CEILING,
      pageSize: options.pageSize,
      label: 'list documents',
    });
  };

  if (wanted === 'date') return readIn('date');
  try {
    return await readIn(wanted);
  } catch (err) {
    if (!(err instanceof VaultColumnsMissingError)) throw err;
    return { ...await readIn('date'), orderFellBack: true };
  }
}

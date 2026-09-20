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

/**
 * The columns the Vault's file rows are built from. One string, so the
 * single-matter and whole-tree reads cannot drift apart.
 */
export const VAULT_DOCUMENT_COLUMNS =
  'id, title, source_filename, file_size_bytes, processing_status, processing_error, ' +
  'matterspace_id, storage_path, text_status:metadata->>text_status, ocr_pending:metadata->ocr_pending';

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
): Promise<PagedRows<VaultDocumentRow>> {
  if (matterIds.length === 0) return { rows: [], total: 0, truncated: false };

  const attempts = Math.max(1, options.attempts ?? 3);
  const delay = options.delay ?? sleep;

  const readPage = async (from: number, to: number): Promise<PagedPage<VaultDocumentRow>> => {
    let lastMsg = 'unknown error';
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await delay(600 * attempt);
      const res = await db
        .from('documents')
        // The count is asked for on the first page only.
        .select(VAULT_DOCUMENT_COLUMNS, from === 0 ? { count: 'exact' } : undefined)
        .in('matterspace_id', matterIds)
        .order('created_at', { ascending: false })
        // The unique tiebreaker. Without it a bulk import's identical
        // created_at values let rows swap between pages.
        .order('id', { ascending: false })
        .range(from, to);
      if (!res.error) return res;
      lastMsg = res.error.message;
      console.error(`list documents [${from}–${to}] (attempt ${attempt + 1}/${attempts}):`, lastMsg);
    }
    throw new Error(`list documents: ${lastMsg}`);
  };

  return fetchPaged<VaultDocumentRow>(readPage, {
    ceiling: options.ceiling ?? VAULT_DOCUMENT_CEILING,
    pageSize: options.pageSize,
    label: 'list documents',
  });
}

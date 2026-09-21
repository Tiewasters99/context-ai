// Finding a DOCUMENT by name, across every matter the person can open.
//
// This is not passage search. `search_passages` (and the box in the Vault that
// drives it) finds a sentence inside a document; this finds the document. It
// reads titles, filenames, categories and dates and returns nothing else —
// there is no body text in the result at all — which is why it runs over
// sealed matters as well, flagged, exactly as the sidebar and the Vault's own
// file list already show them.
//
// One RPC per query, debounced, with every in-flight answer that is no longer
// the current query discarded: typing "watson" fires at most a couple of
// calls and the box can never paint the results of "wat" over the results of
// "watson".

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

export interface DocumentHit {
  document_id: string;
  title: string | null;
  source_filename: string | null;
  matterspace_id: string;
  matterspace_name: string | null;
  category: string | null;
  doc_type: string | null;
  processing_status: string | null;
  page_count: number | null;
  file_size_bytes: number | null;
  created_at: string | null;
  updated_at: string | null;
  sealed: boolean;
  rank: number;
}

/** How many hits a page holds. One more than this is fetched, so the surface
 *  can say "there are more" without a second count over the whole corpus. */
export const DOCUMENT_SEARCH_PAGE = 25;

/** Below this the server searches PREFIXES only (pg_trgm has no trigrams to
 *  work with under three characters). The box says so rather than quietly
 *  answering a narrower question. */
export const TRIGRAM_FLOOR = 3;

const NEEDS_081 = 'Search arrives with migration 081 — ask Eden to apply it.';

function is404(message: string): boolean {
  return /PGRST202|could not find the function|does not exist/i.test(message);
}

export interface DocumentSearchOptions {
  /** Restrict to these matters (and nothing else). Null = everywhere the
   *  caller may look; the server decides what that means, not this file. */
  matterIds?: string[] | null;
  categories?: string[] | null;
  /** Milliseconds of quiet before a query is sent. */
  debounceMs?: number;
}

export interface DocumentSearchState {
  query: string;
  setQuery: (q: string) => void;
  hits: DocumentHit[];
  /** The server had at least one more row than this page holds. */
  hasMore: boolean;
  page: number;
  nextPage: () => void;
  prevPage: () => void;
  searching: boolean;
  error: string | null;
  /** True while the query is short enough that only prefixes are matched. */
  prefixOnly: boolean;
  clear: () => void;
}

export function useDocumentSearch(options: DocumentSearchOptions = {}): DocumentSearchState {
  const { matterIds = null, categories = null, debounceMs = 180 } = options;
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [hits, setHits] = useState<DocumentHit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every request carries the number it was issued with; an answer that is not
  // the latest is dropped rather than painted.
  const issued = useRef(0);
  const matterKey = matterIds ? matterIds.join(',') : '';
  const categoryKey = categories ? categories.join(',') : '';

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      issued.current += 1;
      setHits([]); setHasMore(false); setError(null); setSearching(false);
      return;
    }
    const mine = ++issued.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const { data, error: err } = await supabase.rpc('search_documents', {
          p_query: q,
          p_matterspace_ids: matterKey ? matterKey.split(',') : null,
          p_categories: categoryKey ? categoryKey.split(',') : null,
          p_from: null,
          p_to: null,
          p_limit: DOCUMENT_SEARCH_PAGE + 1,
          p_offset: page * DOCUMENT_SEARCH_PAGE,
        } as never);
        if (issued.current !== mine) return;
        if (err) throw new Error(is404(err.message) ? NEEDS_081 : err.message);
        const rows = (data ?? []) as DocumentHit[];
        setHasMore(rows.length > DOCUMENT_SEARCH_PAGE);
        setHits(rows.slice(0, DOCUMENT_SEARCH_PAGE));
        setError(null);
      } catch (e) {
        if (issued.current !== mine) return;
        setHits([]); setHasMore(false);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (issued.current === mine) setSearching(false);
      }
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [query, page, matterKey, categoryKey, debounceMs]);

  // A new query starts at the first page; changing the page must not.
  const setQueryAndReset = useCallback((q: string) => {
    setQuery(q);
    setPage(0);
  }, []);

  const clear = useCallback(() => {
    issued.current += 1;
    setQuery(''); setPage(0); setHits([]); setHasMore(false); setError(null); setSearching(false);
  }, []);

  return {
    query,
    setQuery: setQueryAndReset,
    hits,
    hasMore,
    page,
    nextPage: () => setPage((p) => (hasMore ? p + 1 : p)),
    prevPage: () => setPage((p) => Math.max(0, p - 1)),
    searching,
    error,
    prefixOnly: query.trim().length > 0 && query.trim().length < TRIGRAM_FLOOR,
    clear,
  };
}

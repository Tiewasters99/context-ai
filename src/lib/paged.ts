// Paged reads against PostgREST.
//
// PostgREST answers every unbounded `select` with at most `db-max-rows` rows
// (1,000 on this project) and says nothing about it: the client gets 1,000
// rows and a 200. For a list that is *displayed*, that is not a performance
// characteristic, it is a correctness bug wearing a success code — a bucket
// with 1,240 documents shows 1,000 of them and looks complete, and a
// production of 2,500 items stamps the first 1,000.
//
// Two rules make a paged read trustworthy, and both are the caller's job:
//
//   1. STABLE ORDER. `.range()` re-runs the query for every page, so any two
//      rows the ORDER BY treats as equal may swap between pages — which both
//      duplicates and DROPS rows at the page boundary. Ordering by
//      `confidence` or `sort_order` alone is exactly that trap: ties are
//      normal in both. Every paged query must end with a UNIQUE tiebreaker,
//      in practice `.order('id')`.
//
//   2. A CEILING, AND SAYING SO. An unbounded loop over a runaway table is a
//      browser tab that never finishes. So the loop stops at `ceiling` — and
//      when it does, `truncated` is true and the caller must show the person
//      "showing N of M" rather than pretending N is all of it. Silence is the
//      bug this module exists to remove; re-introducing it at a higher row
//      count would be the same bug.
//
// Ask for a count (`{ count: 'exact' }` on the caller's select) when the list
// can be truncated: without it the helper can only report what it holds, and
// "showing 20,000 of 20,000" would be another quiet lie.

/** The shape supabase-js resolves a `.range()` query to. */
export interface PagedPage<T> {
  data: T[] | null;
  error: { message: string } | null;
  count?: number | null;
}

export interface PagedOptions {
  /** Rows per request. Clamped to 1..1000 — PostgREST will not return more. */
  pageSize?: number;
  /** Stop after this many rows and report `truncated`. */
  ceiling?: number;
  /** Named in the thrown error, so a failure says which list broke. */
  label?: string;
}

export interface PagedRows<T> {
  rows: T[];
  /**
   * What the server says exists, when the query asked for a count; otherwise
   * the number of rows actually held. Never less than `rows.length`.
   */
  total: number;
  /** The ceiling stopped the loop before the server ran out of rows. */
  truncated: boolean;
}

/** PostgREST's `db-max-rows` on this project. A larger page silently yields this many. */
export const POSTGREST_MAX_ROWS = 1000;

/** Default stop. High enough for any real matter, low enough to end. */
export const DEFAULT_CEILING = 20_000;

/**
 * Read every row a query matches, one `.range()` page at a time.
 *
 * @param page Called with an inclusive `[from, to]` row range; return the
 *   query. The query MUST carry a stable, unique-tiebroken order (see above).
 *
 * @example
 *   const { rows, total, truncated } = await fetchPaged(
 *     (from, to) => supabase
 *       .from('production_items')
 *       .select('*', { count: 'exact' })
 *       .eq('production_id', id)
 *       .order('sort_order', { ascending: true })
 *       .order('id')                       // <- the unique tiebreaker
 *       .range(from, to),
 *     { label: 'production items' },
 *   );
 */
export async function fetchPaged<T>(
  page: (from: number, to: number) => PromiseLike<PagedPage<T>>,
  options: PagedOptions = {},
): Promise<PagedRows<T>> {
  const pageSize = Math.max(1, Math.min(POSTGREST_MAX_ROWS, options.pageSize ?? POSTGREST_MAX_ROWS));
  const ceiling = Math.max(pageSize, options.ceiling ?? DEFAULT_CEILING);
  const label = options.label ?? 'rows';

  const rows: T[] = [];
  let serverTotal: number | null = null;
  let truncated = false;

  for (let from = 0; ; from += pageSize) {
    const { data, error, count } = await page(from, from + pageSize - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    if (typeof count === 'number' && serverTotal === null) serverTotal = count;

    const batch = data ?? [];
    rows.push(...batch);

    // Short page = the server has no more rows to give.
    if (batch.length < pageSize) break;

    if (rows.length >= ceiling) {
      truncated = true;
      break;
    }
  }

  const total = Math.max(rows.length, serverTotal ?? rows.length);
  return { rows, total, truncated };
}

/**
 * The sentence a truncated list owes the person reading it, or null when the
 * list is whole. Rendered wherever the rows are — never swallowed.
 */
export function showingOf(result: PagedRows<unknown>, noun = 'items'): string | null {
  if (!result.truncated) return null;
  const n = result.rows.length.toLocaleString();
  const m = result.total > result.rows.length ? result.total.toLocaleString() : 'more';
  return `Showing the first ${n} of ${m} ${noun}. Narrow the list to see the rest.`;
}

// lib/trademark/rows.mjs — read every row, not the first page.
//
// PostgREST answers an unbounded select with at most its max-rows (1,000 on
// this project) and says nothing. A clearance's hits pass that easily
// (QUALLET: 2,729), and a clipped read ordered by serial drops every filing
// after the 1,000th serial — the recent ones, which matter most. Every read
// of tm_hits and tm_query_runs goes through selectAll.
//
// `build` makes a fresh query each call (a builder takes one range). Pages
// advance by the rows actually returned and stop on an empty page, so a
// server cap smaller than PAGE_ROWS still reads everything. The query must
// be ordered on a unique key (serial is unique per clearance; run id breaks
// run_at ties) or rows can move between pages.

export const PAGE_ROWS = 1000;

/**
 * @param {() => any} build   returns a supabase-js select, already filtered and ordered
 * @returns {Promise<{data: any[] | null, error: any}>}
 */
export async function selectAll(build, { pageSize = PAGE_ROWS } = {}) {
  const out = [];
  for (let from = 0; ; ) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    const rows = data ?? [];
    if (!rows.length) return { data: out, error: null };
    out.push(...rows);
    from += rows.length;
  }
}

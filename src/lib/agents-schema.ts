// Whether the agents task board's database is there yet (migration 085).
// Pure, no imports, so a node harness can check it.

export const AGENTS_MIGRATION_MESSAGE =
  'Agents need a database update (migration 085) before they can be used.';

/**
 * A missing table or column: the migration has not been applied.
 *   PGRST205  PostgREST: table not in the schema cache
 *   PGRST204  PostgREST: column not in the schema cache (an insert naming `kind`)
 *   42P01     Postgres: undefined table
 *   42703     Postgres: undefined column (a filter on `kind`)
 */
export function isMissingSchema(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  const code = err.code ?? '';
  if (code === 'PGRST205' || code === 'PGRST204' || code === '42P01' || code === '42703') return true;
  return /schema cache|does not exist|could not find the (table|.*column)/i.test(err.message ?? '');
}

// ── agent tokens kept out of the user-token surfaces ────────────────

/**
 * A connector token that is NOT an agent token. Before 085 no row has a
 * kind, and every token without one is a user token.
 */
export function isUserToken(row: { kind?: string | null }): boolean {
  return row.kind !== 'agent';
}

type TokenRead = PromiseLike<{
  data: unknown[] | null;
  error: { code?: string; message: string } | null;
}>;

/**
 * Reads connector_tokens with `columns` and drops agent tokens, filtering in
 * the browser because a `.eq('kind', …)` filter fails with 42703 until 085
 * is applied. The read asks for `kind` as well; when that column does not
 * exist yet it asks again without it, and every row counts as a user token.
 * `run` builds the query from a column list.
 */
export async function readUserTokens<T>(
  run: (columns: string) => TokenRead,
  columns: string,
): Promise<{ data: T[] | null; error: { code?: string; message: string } | null }> {
  let r = await run(`${columns}, kind`);
  if (r.error && isMissingSchema(r.error)) r = await run(columns);
  if (r.error) return { data: null, error: r.error };
  const rows = (r.data ?? []) as (T & { kind?: string | null })[];
  return { data: rows.filter(isUserToken), error: null };
}

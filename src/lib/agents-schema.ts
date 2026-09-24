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

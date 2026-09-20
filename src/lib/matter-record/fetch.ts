// Reading the matter's Record.
//
// One matter's Record is the matter's own events plus every sub-matter's:
// `matterspace_descendants` (migration 012) expands the tree, and RLS on
// `events` already lets a parent's members read a child's rows
// (docs/THE_MATTER_RECORD.md, "Who may read").
//
// PostgREST answers at most 1,000 rows, so every read here is a range loop
// over a total order — (ts, chain_key, seq) — and the reader says how many of
// how many it is showing rather than quietly stopping at a thousand.
//
// No function in this file writes anything, and none of them fetches document
// text: the ledger holds metadata only and the Record must not go looking for
// more.

import type {
  ChainStatus,
  CiteCheckRunRef,
  LedgerEvent,
  MatterRecordData,
  MatterRef,
  QueryError,
  QueryResult,
  RecordClient,
  SelectBuilder,
} from './types';

export const PAGE_SIZE = 1000;
/** How many events one read will pull before it says "showing N of M". */
export const DEFAULT_CEILING = 5000;

const EVENT_COLUMNS =
  'id, ts, chain_key, seq, kind, matterspace_id, matter_name, serverspace_id, ' +
  'session_id, actor_kind, actor_ref, actor_user_id, actor_label, payload, ' +
  'prev_hash, hash';

// Cite-check runs are referenced by run id and brief filename only. The
// report jsonb and the markdown columns are deliberately not selected: the
// Record says a check ran, it does not reproduce its contents.
const CITE_RUN_COLUMNS =
  'id, matterspace_id, source_label, status, citations_total, created_at, ' +
  'completed_at, created_by';

// The codes PostgREST and Postgres give when migration 064 simply is not in
// this database yet. Same list as lib/ledger.mjs `isNotDeployed`, so the read
// side and the write side agree on what "not enabled" means.
const NOT_DEPLOYED_CODES = new Set([
  'PGRST202', // function missing from the schema cache
  'PGRST203', // overloaded function not resolvable
  'PGRST205', // table missing from the schema cache
  '42883', // undefined_function
  '42P01', // undefined_table
  '3F000', // invalid_schema_name
]);

const NOT_DEPLOYED_RE =
  /(could not find the (function|table)|schema cache|function .* does not exist|relation .* does not exist)/i;

/** True when the ledger is simply not in this database yet. */
export function isNotDeployed(error: QueryError | null | undefined): boolean {
  if (!error) return false;
  if (error.code && NOT_DEPLOYED_CODES.has(String(error.code))) return true;
  return NOT_DEPLOYED_RE.test(String(error.message ?? ''));
}

export function errorText(error: QueryError | null | undefined): string {
  if (!error) return 'Unknown error';
  return String(error.message ?? error.details ?? error.code ?? 'Unknown error');
}

/**
 * The matter and every sub-matter beneath it.
 *
 * `matterspace_descendants` is SECURITY INVOKER, so a caller only ever gets
 * matters they can already see. If the rpc is unavailable the caller still
 * gets its own matter back — a feed that shows one matter is better than a
 * feed that shows an error.
 */
export async function matterDescendantIds(
  client: RecordClient,
  matterId: string,
): Promise<string[]> {
  const { data, error } = await client.rpc<{ id: string }>(
    'matterspace_descendants',
    { p_root: matterId },
  );
  if (error || !data) return [matterId];
  const ids = data.map((row) => row.id).filter((id): id is string => !!id);
  return ids.includes(matterId) ? ids : [matterId, ...ids];
}

/**
 * Read every row a filtered select matches, a page at a time.
 *
 * `build` must apply a total order, or a row can appear on two pages and
 * another on none. Stops at `ceiling` and reports that it did.
 */
export async function readAllPages<T>(
  build: () => SelectBuilder<T>,
  ceiling = DEFAULT_CEILING,
): Promise<{ rows: T[]; truncated: boolean; error: QueryError | null }> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const wanted = Math.min(PAGE_SIZE, ceiling - rows.length);
    if (wanted <= 0) break;
    const { data, error }: QueryResult<T> = await build().range(
      offset,
      offset + wanted - 1,
    );
    if (error) return { rows, truncated: false, error };
    const page = data ?? [];
    rows.push(...page);
    if (page.length < wanted) return { rows, truncated: false, error: null };
    offset += page.length;
  }
  return { rows, truncated: true, error: null };
}

async function countRows(
  client: RecordClient,
  table: string,
  matterIds: string[],
): Promise<number | null> {
  const { count, error } = await client
    .from(table)
    .select<{ id: string }>('id', { count: 'exact', head: true })
    .in('matterspace_id', matterIds);
  if (error) return null;
  return typeof count === 'number' ? count : null;
}

/**
 * `verify_chain` for each matter that has events in it. One chain per matter,
 * so a parent matter's header is the sum of several chains.
 */
export async function verifyChains(
  client: RecordClient,
  matters: MatterRef[],
): Promise<{ chains: ChainStatus[]; notDeployed: boolean }> {
  const chains: ChainStatus[] = [];
  let notDeployed = false;
  for (const matter of matters) {
    const { data, error } = await client.rpc<{
      ok: boolean;
      checked: number | string;
      first_bad_seq: number | string | null;
    }>('verify_chain', { p_chain_key: matter.id });
    if (error) {
      if (isNotDeployed(error)) notDeployed = true;
      chains.push({
        matterId: matter.id,
        matterName: matter.name,
        ok: false,
        checked: 0,
        firstBadSeq: null,
        unavailable: true,
      });
      continue;
    }
    const row = (data ?? [])[0];
    if (!row) {
      chains.push({
        matterId: matter.id,
        matterName: matter.name,
        ok: false,
        checked: 0,
        firstBadSeq: null,
        unavailable: true,
      });
      continue;
    }
    chains.push({
      matterId: matter.id,
      matterName: matter.name,
      ok: !!row.ok,
      checked: Number(row.checked ?? 0),
      firstBadSeq:
        row.first_bad_seq === null || row.first_bad_seq === undefined
          ? null
          : Number(row.first_bad_seq),
    });
  }
  return { chains, notDeployed };
}

function collectPeopleIds(
  events: LedgerEvent[],
  citeRuns: CiteCheckRunRef[],
): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.actor_user_id) ids.add(event.actor_user_id);
    const target = event.payload?.target_user_id;
    if (typeof target === 'string' && target) ids.add(target);
    const by = event.payload?.by;
    if (typeof by === 'string' && by.includes('-')) ids.add(by);
  }
  for (const run of citeRuns) if (run.created_by) ids.add(run.created_by);
  return [...ids].sort();
}

/**
 * Resolve user ids to display names in one batched query, exactly as the
 * activity feed does. If `profiles` RLS hides someone, the Record says
 * "A member" rather than printing a uuid at a court.
 */
export async function resolvePeople(
  client: RecordClient,
  userIds: string[],
): Promise<Record<string, string>> {
  const people: Record<string, string> = {};
  if (userIds.length === 0) return people;
  for (let i = 0; i < userIds.length; i += 200) {
    const slice = userIds.slice(i, i + 200);
    const { data } = await client
      .from('profiles')
      .select<{ id: string; display_name: string | null; email: string | null }>(
        'id, display_name, email',
      )
      .in('id', slice);
    for (const row of data ?? []) {
      const name = (row.display_name ?? '').trim() || row.email || '';
      if (name) people[row.id] = name;
    }
  }
  return people;
}

export interface FetchOptions {
  ceiling?: number;
}

/**
 * One read of the whole Record for a matter and its sub-matters.
 *
 * Returns partial data rather than throwing: a Record that can show the
 * events but not the chain check is still worth reading, and a lawyer should
 * be told which part is missing.
 */
export async function fetchMatterRecord(
  client: RecordClient,
  matter: MatterRef,
  options: FetchOptions = {},
): Promise<MatterRecordData> {
  const ceiling = options.ceiling ?? DEFAULT_CEILING;
  const ids = await matterDescendantIds(client, matter.id);

  // Names for the sub-matter filter. The events carry their own snapshotted
  // matter_name, so this is only for the picker and the header.
  const { data: matterRows } = await client
    .from('matterspaces')
    .select<{ id: string; name: string }>('id, name')
    .in('id', ids);
  const nameById = new Map<string, string>();
  for (const row of matterRows ?? []) nameById.set(row.id, row.name);
  const others = ids
    .filter((id) => id !== matter.id)
    .map((id) => ({ id, name: nameById.get(id) ?? 'Untitled matter' }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const matters: MatterRef[] = [
    { id: matter.id, name: nameById.get(matter.id) ?? matter.name },
    ...others,
  ];

  const empty: MatterRecordData = {
    matter: matters[0],
    matters,
    events: [],
    totalEvents: null,
    ceiling,
    truncated: false,
    chains: [],
    people: {},
    citeRuns: [],
    notDeployed: false,
    error: null,
  };

  const { rows, truncated, error } = await readAllPages<LedgerEvent>(
    () =>
      client
        .from('events')
        .select<LedgerEvent>(EVENT_COLUMNS)
        .in('matterspace_id', ids)
        .order('ts', { ascending: true })
        .order('chain_key', { ascending: true })
        .order('seq', { ascending: true }),
    ceiling,
  );

  if (error) {
    if (isNotDeployed(error)) return { ...empty, notDeployed: true };
    return { ...empty, error: errorText(error) };
  }

  const events = rows.map((row) => ({
    ...row,
    payload: (row.payload ?? {}) as Record<string, unknown>,
  }));

  // `truncated` from the pager only means "I stopped at the ceiling I was
  // given". Whether anything was actually left behind needs the count.
  const totalEvents = truncated ? await countRows(client, 'events', ids) : events.length;
  const leftBehind =
    truncated && totalEvents !== null ? totalEvents > events.length : truncated;

  // Verify the chains that hold events for this reader. When the read stopped
  // at a ceiling, "the chains we saw" is not the same set as "the chains there
  // are" — a sub-matter whose entries all fall past the ceiling would go
  // unchecked while the export claims the check covered everything — so in
  // that case every matter is asked. A chain with no rows checks 0 and passes.
  const chainIds = new Set(events.map((e) => e.chain_key));
  const chainMatters = leftBehind ? matters : matters.filter((m) => chainIds.has(m.id));
  const { chains, notDeployed } = await verifyChains(
    client,
    chainMatters.length > 0 ? chainMatters : [],
  );

  const { rows: citeRows } = await readAllPages<CiteCheckRunRef>(
    () =>
      client
        .from('cite_check_runs')
        .select<CiteCheckRunRef>(CITE_RUN_COLUMNS)
        .in('matterspace_id', ids)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true }),
    1000,
  );

  const people = await resolvePeople(client, collectPeopleIds(events, citeRows));

  return {
    ...empty,
    events,
    totalEvents,
    truncated: leftBehind,
    chains,
    people,
    citeRuns: citeRows,
    notDeployed,
  };
}

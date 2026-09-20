// The shapes the Record tab and the Matter Record export read.
//
// The contract is docs/THE_MATTER_RECORD.md (migration 064 + lib/ledger.mjs).
// Nothing here writes; the ledger is append-only and this is its read side.
//
// Everything in this folder is pure and client-agnostic on purpose: the only
// thing it needs from Supabase is the small structural interface below, so the
// offline harness can hand it a stub and assert on the bytes that come out.

/** One row of `public.events`, exactly as the table holds it. */
export interface LedgerEvent {
  id: string;
  ts: string;
  chain_key: string;
  seq: number;
  kind: string;
  matterspace_id: string | null;
  matter_name: string | null;
  serverspace_id: string | null;
  session_id: string | null;
  actor_kind: string;
  actor_ref: string;
  actor_user_id: string | null;
  actor_label: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

/** `verify_chain(chain_key)` for one matter — one chain per matter. */
export interface ChainStatus {
  matterId: string;
  matterName: string;
  ok: boolean;
  checked: number;
  firstBadSeq: number | null;
  /** The chain could not be checked at all (RLS, or the rpc is not deployed). */
  unavailable?: boolean;
}

/** Cite-check run metadata — run id and brief filename only, never the report. */
export interface CiteCheckRunRef {
  id: string;
  matterspace_id: string;
  source_label: string;
  status: string;
  citations_total: number;
  created_at: string | null;
  completed_at: string | null;
  created_by: string | null;
}

export interface MatterRef {
  id: string;
  name: string;
}

/** Everything one Record read produced. Assembly and rendering take only this. */
export interface MatterRecordData {
  matter: MatterRef;
  /** The matter itself plus every descendant, in the order they were read. */
  matters: MatterRef[];
  events: LedgerEvent[];
  /** Rows in the ledger for these matters, when the count could be taken. */
  totalEvents: number | null;
  /** The ceiling this read imposed; `truncated` says whether it bit. */
  ceiling: number;
  truncated: boolean;
  chains: ChainStatus[];
  /** user id → display name, for the ids this reader was allowed to resolve. */
  people: Record<string, string>;
  citeRuns: CiteCheckRunRef[];
  /** Migration 064 is not in this database yet. */
  notDeployed: boolean;
  /** A real read failure (not "not deployed"), in the reader's own words. */
  error: string | null;
}

/** Inputs the caller supplies so a render is a pure function of its inputs. */
export interface ExportContext {
  /** ISO instant the export was produced. Never read from the clock in here. */
  generatedAt: string;
  /** The person who pressed the button, as the record should name them. */
  generatedBy: string;
  /** Optional: the jurisdiction entry id the attorney picked. */
  jurisdictionId?: string | null;
}

/** One entry of the AI Use Record rules matrix, as the YAML file holds it. */
export interface JurisdictionSource {
  title?: string | null;
  url?: string | null;
  verbatim?: string | null;
  effective?: string | null;
  fetched?: string | null;
}

export interface JurisdictionEntry {
  // The matrix carries fields this build does not know about (a verifier's
  // own result line, for instance) and fields whose value is a word where a
  // boolean was expected ("draft", "judge_specific"). Both are printed as the
  // file has them rather than coerced, so the index signature stays.
  [field: string]: unknown;
  id: string;
  kind?: string | null;
  name?: string | null;
  disclosure_to_court?: string | null;
  certification_required?: boolean | string | null;
  certificate_language?: string | null;
  verification_duty?: string | null;
  confidentiality_restriction?: string | null;
  record_keeping_duty?: string | null;
  client_disclosure_duty?: string | null;
  fees_note?: string | null;
  sources?: JurisdictionSource[] | null;
  status?: string | null;
  verified_on?: string | null;
  verified_by?: string | null;
  attorney_signoff?: string | null;
  notes?: string | null;
}

export interface JurisdictionMatrix {
  schema_version?: number | null;
  matrix_version: string;
  entries: JurisdictionEntry[];
}

// ---------------------------------------------------------------------------
// The slice of a Supabase client this folder uses. A stub implements it in
// four lines; the real client is cast to it once, in useMatterRecord.ts.
// ---------------------------------------------------------------------------

export interface QueryError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

export interface QueryResult<T> {
  data: T[] | null;
  error: QueryError | null;
  count?: number | null;
}

export interface SelectBuilder<T> extends PromiseLike<QueryResult<T>> {
  eq(column: string, value: unknown): SelectBuilder<T>;
  in(column: string, values: readonly unknown[]): SelectBuilder<T>;
  order(column: string, options?: { ascending?: boolean }): SelectBuilder<T>;
  range(from: number, to: number): SelectBuilder<T>;
  limit(count: number): SelectBuilder<T>;
}

export interface TableRef {
  select<T>(
    columns: string,
    options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean },
  ): SelectBuilder<T>;
}

export interface RecordClient {
  from(table: string): TableRef;
  rpc<T>(fn: string, args: Record<string, unknown>): PromiseLike<QueryResult<T>>;
}

// The first-run docket's decisions, with no React and no Supabase client in
// the file.
//
// Everything here is a pure function or a function that takes the client it
// talks to as an argument, for one reason: scripts/_test-first-run.mjs runs it
// under plain Node against a fake client, so the rules a stranger's first five
// minutes depend on are asserted rather than eyeballed. The React that renders
// it (FirstRunDocket.tsx) and the React that feeds it (useFirstRun.ts) hold no
// rule of their own. Strings all live in ./copy.ts.
//
// Three rules worth stating before the code:
//
//   1. **A tick is derived from data, never from a click.** `stepDone` reads
//      facts — a row exists, or it does not — and a fact that could not be
//      READ is `null`, which renders as no tick at all. A failed read must
//      never look like an accomplishment, and it must never look like a
//      failure either.
//   2. **Nothing is created without a click, and a second click creates
//      nothing.** `createFirstServerspace` re-reads the table before it
//      inserts, so a double-click, a slow network or a stale React Query cache
//      cannot produce two workspaces.
//   3. **The docket hides itself while it does not yet know.** An unknown plan
//      is not "not workshop", and an unloaded serverspace list is not "no
//      serverspaces". Both render nothing rather than a list that rearranges
//      itself a moment later.

import { isWorkshop, type Plan } from '@/lib/plan';

// ---------------------------------------------------------------------------
// The six steps
// ---------------------------------------------------------------------------

export type StepId = 'workspace' | 'matter' | 'documents' | 'ask' | 'connect' | 'record';

/** Docket order. The numbers a person reads are these positions plus one. */
export const STEP_IDS: readonly StepId[] = [
  'workspace',
  'matter',
  'documents',
  'ask',
  'connect',
  'record',
] as const;

/**
 * What is true of this account, read from the database.
 *
 * `boolean | null`: `null` means the read did not come back — the table is not
 * deployed on this install, RLS refused, the network failed. Anything the app
 * could not read is reported as unknown and claimed neither way.
 */
export interface FirstRunFacts {
  /** At least one serverspace. From the shared serverspaces query. */
  hasServerspace: boolean;
  /** At least one matter, anywhere. From the same query. */
  hasMatter: boolean;
  /** At least one document row this account can read. */
  hasDocument: boolean | null;
  /** At least one model call on a matter's Record (`events`: completion.*). */
  hasAssistantRun: boolean | null;
  /** At least one live approved AI client (`oauth_grants`). */
  hasAiConnection: boolean | null;
  /** At least one entry on a matter's Record (`events`, any kind). */
  hasRecordEntry: boolean | null;
}

export const UNKNOWN_FACTS: FirstRunFacts = {
  hasServerspace: false,
  hasMatter: false,
  hasDocument: null,
  hasAssistantRun: null,
  hasAiConnection: null,
  hasRecordEntry: null,
};

/** Is this step already true? `null` = could not be read, so no tick. */
export function stepDone(step: StepId, facts: FirstRunFacts): boolean | null {
  switch (step) {
    case 'workspace':
      return facts.hasServerspace;
    case 'matter':
      return facts.hasMatter;
    case 'documents':
      return facts.hasDocument;
    case 'ask':
      return facts.hasAssistantRun;
    case 'connect':
      return facts.hasAiConnection;
    case 'record':
      return facts.hasRecordEntry;
  }
}

/**
 * May this step's action run right now?
 *
 * A step whose action would have nowhere to go is inert rather than hidden —
 * the docket is a list of six things in order, and a missing line would break
 * the numbering a person is reading. Step 1 goes inert once a serverspace
 * exists, because "create the first one" is then finished for good; the other
 * five stay live after their tick, because opening the Vault or the Record a
 * second time is an ordinary thing to want.
 */
export function stepReady(step: StepId, facts: FirstRunFacts): boolean {
  switch (step) {
    case 'workspace':
      return !facts.hasServerspace;
    case 'matter':
      return facts.hasServerspace;
    case 'documents':
    case 'ask':
    case 'record':
      return facts.hasMatter;
    case 'connect':
      return true;
  }
}

// ---------------------------------------------------------------------------
// Whether the docket is on screen at all
// ---------------------------------------------------------------------------

export interface FirstRunVisibility {
  /** profiles.pricing_tier, or null while it is unknown. */
  plan: Plan | null;
  /** True while the profile row is still being read. */
  planLoading: boolean;
  /** True while the shared serverspaces query is still in flight. */
  serverspacesLoading: boolean;
  /** This user has put the list away for good. */
  dismissed: boolean;
}

/**
 * `workshop` is Eden's own account and the one he demos from: it never sees
 * onboarding. Everything else sees the docket until it is dismissed — an
 * account that has a serverspace but no matter is exactly the case the ticks
 * exist for, so "has done some of it" is not a reason to hide the rest.
 */
export function shouldShowFirstRun(v: FirstRunVisibility): boolean {
  if (v.dismissed) return false;
  if (v.planLoading || v.plan === null) return false;
  if (isWorkshop(v.plan)) return false;
  if (v.serverspacesLoading) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Remembering the dismissal
// ---------------------------------------------------------------------------

// Keyed by user id, and the user comes first in the key, exactly as
// lib/draft-store.ts keys a draft: two lawyers at one firm desk is the
// ordinary case, and one person's dismissal must not hide the docket from the
// next person who signs in. There is no UI-preferences column on `profiles`
// and migration 062 revoked column-level UPDATE there anyway, so this is a
// browser preference and nothing more — a new machine sees the list again,
// which is the right failure.
export const FIRST_RUN_DISMISS_PREFIX = 'cs.firstrun.v1.';
export const FIRST_RUN_DISMISSED_VALUE = 'dismissed';

export interface FirstRunStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function dismissKey(userId: string): string {
  return `${FIRST_RUN_DISMISS_PREFIX}${userId}`;
}

/** A store that throws, or is absent, reads as "not dismissed" — show the list. */
export function readDismissed(store: FirstRunStore | null, userId: string | null): boolean {
  if (!store || !userId) return false;
  try {
    return store.getItem(dismissKey(userId)) === FIRST_RUN_DISMISSED_VALUE;
  } catch {
    return false;
  }
}

/** Returns whether it stuck. A blocked store costs the preference, nothing more. */
export function writeDismissed(store: FirstRunStore | null, userId: string | null): boolean {
  if (!store || !userId) return false;
  try {
    store.setItem(dismissKey(userId), FIRST_RUN_DISMISSED_VALUE);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Naming the first workspace
// ---------------------------------------------------------------------------

/** Longer than this and it stops fitting the sidebar rail. */
export const MAX_WORKSPACE_NAME = 64;

/**
 * A name taken from the account rather than invented.
 *
 * `handle_new_user` (migration 001) writes `profiles.display_name` from
 * `raw_user_meta_data->>'display_name'`, falling back to the email's local
 * part — but a Google or Apple sign-in puts the person's name under
 * `full_name` or `name`, not `display_name`, so all three are tried before the
 * email. The name is shown in the docket line BEFORE the click, because the
 * product has no rename control for a serverspace today.
 */
export function defaultWorkspaceName(
  metadata: Record<string, unknown> | null | undefined,
  email: string | null | undefined,
  fallback: string,
): string {
  const candidates = [
    metadata?.display_name,
    metadata?.full_name,
    metadata?.name,
    typeof email === 'string' ? email.split('@')[0] : null,
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    // Control characters and runs of whitespace collapse; a name is one line.
    // `\p{Cc}` rather than a literal range so the source carries no control
    // character of its own (eslint no-control-regex).
    const clean = raw.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
    if (clean) return clean.slice(0, MAX_WORKSPACE_NAME);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Which matter steps 3, 4 and 6 point at
// ---------------------------------------------------------------------------

export interface DocketMatter {
  id: string;
  name: string;
  short_code: string | null;
  parent_matterspace_id: string | null;
  ai_tier: 'A' | 'B' | 'C';
}

export interface DocketServerspace {
  id: string;
  name: string;
  matterspaces: DocketMatter[];
}

export interface FirstRunTarget {
  serverspaceId: string;
  serverspaceName: string;
  matterId: string;
  matterName: string;
  /** What `/app/vault?matter=` and `/app/discovery?matter=` take. */
  matterKey: string;
  /** Tier B or C — passed to the Assistant as a display hint only. */
  sealed: boolean;
}

/** The first serverspace, in the order the shared query returns them (created_at). */
export function pickFirstServerspace(
  serverspaces: readonly DocketServerspace[],
): { id: string; name: string } | null {
  const first = serverspaces[0];
  return first ? { id: first.id, name: first.name } : null;
}

/**
 * The matter the docket's later steps act on.
 *
 * Deterministic and stated, because a line that moves between renders is worse
 * than a line that points somewhere arguable: the first serverspace that has
 * a top-level matter, and within it the first matter by name (case-folded),
 * with the id breaking a tie. `matterspaces` carries no `created_at` in the
 * shared query, so "oldest" is not available to sort on.
 */
export function pickFirstMatter(
  serverspaces: readonly DocketServerspace[],
): FirstRunTarget | null {
  for (const server of serverspaces) {
    const roots = (server.matterspaces ?? [])
      .filter((m) => m.parent_matterspace_id === null)
      .slice()
      .sort((a, b) => {
        const an = a.name.toLowerCase();
        const bn = b.name.toLowerCase();
        if (an < bn) return -1;
        if (an > bn) return 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    const matter = roots[0];
    if (!matter) continue;
    return {
      serverspaceId: server.id,
      serverspaceName: server.name,
      matterId: matter.id,
      matterName: matter.name,
      matterKey: matter.short_code ?? matter.id,
      sealed: matter.ai_tier !== 'A',
    };
  }
  return null;
}

/** Does any serverspace hold any matter at all? Drives the step-2 tick. */
export function hasAnyMatter(serverspaces: readonly DocketServerspace[]): boolean {
  return serverspaces.some((s) => (s.matterspaces ?? []).length > 0);
}

// ---------------------------------------------------------------------------
// Creating the first workspace, once
// ---------------------------------------------------------------------------

// The slice of a Supabase client this file uses. A fake implements it in a few
// lines (scripts/_fake-supabase.mjs already does); the real client is cast to
// it once, in useFirstRun.ts — the same arrangement as RecordClient in
// lib/matter-record/types.ts.
export interface FirstRunQueryError {
  code?: string | null;
  message?: string | null;
}

export interface FirstRunResult<T> {
  data: T[] | null;
  error: FirstRunQueryError | null;
}

export interface FirstRunBuilder<T> extends PromiseLike<FirstRunResult<T>> {
  eq(column: string, value: unknown): FirstRunBuilder<T>;
  is(column: string, value: unknown): FirstRunBuilder<T>;
  in(column: string, values: readonly unknown[]): FirstRunBuilder<T>;
  limit(count: number): FirstRunBuilder<T>;
}

export interface FirstRunTable {
  select<T>(columns: string): FirstRunBuilder<T>;
  insert<T>(row: Record<string, unknown>): { select(columns: string): FirstRunBuilder<T> };
}

export interface FirstRunClient {
  from(table: string): FirstRunTable;
}

export type CreateFailure = 'read_failed' | 'no_clientspace' | 'insert_failed';

export interface CreateOutcome {
  ok: boolean;
  serverspaceId: string | null;
  /** False when one already existed and nothing was written. */
  created: boolean;
  reason: CreateFailure | null;
  /** The server's own words, when it had any. Never invented here. */
  message: string | null;
}

/**
 * Create the account's first serverspace — at most once, ever.
 *
 * The guard is a fresh read of the table immediately before the insert, not
 * the React Query cache (30 s stale is long enough for two clicks) and not an
 * in-flight flag alone (that is also held, in the hook, but it dies with a
 * remount). If a row is already there this returns it and writes nothing, so
 * the caller's retry is a no-op rather than a second workspace.
 *
 * `cover_url` is chosen by the caller from the core set (lib/covers.ts) so a
 * new account's first space opens on a picture rather than an empty strip; a
 * null cover must never stop the space being created.
 */
export async function createFirstServerspace(
  client: FirstRunClient,
  opts: { userId: string; name: string; coverUrl: string | null },
): Promise<CreateOutcome> {
  const fail = (reason: CreateFailure, message: string | null): CreateOutcome => ({
    ok: false, serverspaceId: null, created: false, reason, message,
  });

  const existing = await client.from('serverspaces').select<{ id: string }>('id').limit(1);
  if (existing.error) return fail('read_failed', existing.error.message ?? null);
  const already = existing.data?.[0];
  if (already) {
    return { ok: true, serverspaceId: already.id, created: false, reason: null, message: null };
  }

  const cs = await client
    .from('clientspaces')
    .select<{ id: string }>('id')
    .eq('user_id', opts.userId)
    .limit(1);
  if (cs.error) return fail('read_failed', cs.error.message ?? null);
  const clientspaceId = cs.data?.[0]?.id;
  if (!clientspaceId) return fail('no_clientspace', null);

  const inserted = await client
    .from('serverspaces')
    .insert<{ id: string }>({
      clientspace_id: clientspaceId,
      name: opts.name,
      cover_url: opts.coverUrl,
    })
    .select('id');
  if (inserted.error) return fail('insert_failed', inserted.error.message ?? null);
  const row = inserted.data?.[0];
  if (!row) return fail('insert_failed', null);
  return { ok: true, serverspaceId: row.id, created: true, reason: null, message: null };
}

// ---------------------------------------------------------------------------
// Where each step goes
// ---------------------------------------------------------------------------

/** `?tab=` is matched exactly in MatterspaceView.tsx — the capital R matters. */
export const RECORD_TAB = 'Record';

export function vaultPathFor(target: FirstRunTarget): string {
  return `/app/vault?matter=${encodeURIComponent(target.matterKey)}`;
}

export function recordPathFor(target: FirstRunTarget): string {
  return `/app/matterspace/${target.matterId}?tab=${RECORD_TAB}`;
}

export const CONNECTIONS_PATH = '/app/connections';

/**
 * The kinds on `events` that mean a model was actually asked something.
 *
 * Both, because the two paths write different ones: a FEATURE call through
 * `/api/llm` opens with `completion.requested` (lib/llm-record.mjs), while the
 * Assistant itself writes `completion.received` when the answer lands
 * (lib/assistant-core.mjs). Step 4's own button drives the second, so its tick
 * is reachable from its own action.
 */
export const COMPLETION_KINDS: readonly string[] = ['completion.requested', 'completion.received'];

/**
 * `events` also carries ACCOUNT-chain rows, which have no matter at all
 * (migration 072: "account row — matterspace_id null, serverspace_id null").
 * Step 6's mark says "A matter's Record has at least one entry", so the reads
 * behind it must exclude those rows or the mark would be false the moment a
 * connector was registered.
 */
export const MATTER_EVENTS_ONLY = { column: 'matterspace_id', operator: 'is', value: null } as const;

/**
 * Is a connector token live? The same rule `Connections.tsx` applies, because
 * the two must not disagree about whether an account is connected.
 */
export function tokenIsLive(
  row: { revoked_at?: string | null; expires_at?: string | null },
  now: number,
): boolean {
  if (row.revoked_at) return false;
  return !row.expires_at || new Date(row.expires_at).getTime() > now;
}

/**
 * Step 5 is done if EITHER signal says so, because the two AI-connection paths
 * are recorded differently: ChatGPT (and anything that signs in over OAuth)
 * leaves an `oauth_grants` row, while a Claude connection made with a pasted
 * token leaves only a `connector_tokens` row — "the only readable signal" for
 * that path (Connections.tsx). Unknown only when NEITHER could be read: one
 * table answering "no" while the other is unreadable is still a "no" that was
 * genuinely read, and a false tick is worse than a missing one.
 */
export function anyAiConnection(
  grants: boolean | null,
  tokens: boolean | null,
): boolean | null {
  if (grants === true || tokens === true) return true;
  if (grants === null && tokens === null) return null;
  return false;
}

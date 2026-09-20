// Types for lib/ledger.mjs, so a TypeScript surface can write to the matter's
// Record. Added by the W3 pause lane: the pause control is the first thing in
// src/ that records an event, and `npx tsc -b` needs a declaration for the
// dynamic import it uses.
//
// The import is dynamic on purpose. lib/ledger.mjs arrives with PR #170; this
// lane must work whether that has merged or not, so the control imports it
// inside a try and treats an import failure exactly as it treats a
// not-deployed database — the pause still happens, it is simply not recorded.

export type LedgerEventKind =
  | 'tool.invoked'
  | 'completion.received'
  | 'file.exported'
  | 'file.sent'
  | 'file.delivered'
  | 'file.gate'
  | 'citation.verified'
  | 'acl.changed'
  | 'seal.changed'
  | 'connector.registered'
  | 'connector.revoked'
  | 'ai.paused'
  | 'ai.resumed'
  | 'run.aborted';

export interface LedgerActor {
  kind: 'user' | 'charter' | 'connector' | 'system';
  ref?: string | null;
  user_id?: string | null;
  session_id?: string | null;
  label?: string | null;
}

export interface LedgerResult {
  ok: boolean;
  notDeployed?: boolean;
  id?: string | null;
  seq?: number | null;
  hash?: string | null;
  error?: { message?: string; code?: string } | null;
}

export const EVENT_KINDS: readonly LedgerEventKind[];
export const EVENT_TYPES: readonly LedgerEventKind[];
export const NIL_CHAIN: string;

export function isNotDeployed(error: unknown): boolean;
export function redact(obj: unknown, depth?: number): unknown;

/** `supabase` is a supabase-js client — typed loosely so this plain-JS
 *  module does not drag the SDK types into its callers. */
export function record(
  supabase: unknown,
  o: {
    kind?: LedgerEventKind;
    type?: LedgerEventKind;
    matterId?: string | null;
    serverspaceId?: string | null;
    sessionId?: string | null;
    actor?: LedgerActor | null;
    payload?: Record<string, unknown>;
    strict?: boolean;
  },
): Promise<LedgerResult>;

export function recordStrict(supabase: unknown, o: Parameters<typeof record>[1]): Promise<LedgerResult>;
export function verifyChain(
  supabase: unknown,
  chainKey?: string | null,
): Promise<{ ok: boolean; checked: number; first_bad_seq: number | null; notDeployed?: boolean }>;

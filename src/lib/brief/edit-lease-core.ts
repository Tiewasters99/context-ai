// The pure half of the brief edit hold (105): states and the rules that move
// between them. No Supabase import, so a node harness can drive it.

export type LeaseState =
  | { kind: 'checking' }
  | { kind: 'mine' }
  /** Someone else's window holds it. `lost`: this window held it and no longer does. */
  | { kind: 'theirs'; holderName: string; sameUser: boolean; since: string; lost: boolean }
  /** 105 not applied, or the first claim failed: behave as before 105. */
  | { kind: 'off' };

export type LeaseRow = { holder_is_me: boolean; holder_user: string; holder_name: string; claimed_at: string };

/** True when the error says the function is not deployed (105 not pasted). */
export function isLeaseMissing(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.code === 'PGRST202' || e.code === '42883' || /claim_brief_edit/.test(e.message ?? '') && /find|exist/i.test(e.message ?? ''));
}

/**
 * The state the desk shows after a claim. Pure, for the harness: a window that
 * held the brief and now does not has `lost` set, so it can say so.
 */
export function nextLeaseState(prev: LeaseState, row: LeaseRow | null, me: string | null): LeaseState {
  if (!row) return { kind: 'off' };            // a viewer with nobody holding: nothing to say
  if (row.holder_is_me) return { kind: 'mine' };
  return {
    kind: 'theirs',
    holderName: row.holder_name || 'someone',
    sameUser: !!me && row.holder_user === me,
    since: row.claimed_at,
    lost: prev.kind === 'mine' || (prev.kind === 'theirs' && prev.lost),
  };
}


// "Disconnect everything" and "Disconnect all assistants from this matter",
// from the browser (migration 095, docs/specs/SECURITY-BUILD-2026-09-26.md §S2).
//
// Three calls:
//   previewDisconnect  disconnect_all_preview — the counts the confirm card
//                      names before the press. Changes nothing.
//   disconnectAccount  /api/account-lockdown — the database half AND the
//                      sign-out of every other browser, which only the server
//                      can do. The presser's session is kept.
//   disconnectMatter   disconnect_all('matter') straight to the database:
//                      there are no sessions to end for one matter.
//
// NOT DEPLOYED IS NOT AN ERROR. Until 095 is pasted the preview RPC is missing
// (PGRST202) and both buttons hide themselves, as the AI pause does.
//
// Since 099:
//   * an account with a second factor presses at aal2. /api/account-lockdown
//     answers `step_up_required` otherwise (nothing done); disconnectAccount
//     throws StepUpRequiredError, the card asks for the factor and presses
//     again.
//   * after the press, THIS tab's sign-in is older than the lock, and the
//     database refuses to let a sign-in that old reconnect anything (that is
//     what stops a stolen token doing it). So disconnectAccount waits past the
//     lock's second and refreshes the session: the presser reconnects from a
//     new token. The devices the press signed out cannot refresh.
//   * a failure says, in the same words everywhere, that nothing happened.

import { supabase } from '@/lib/supabase';
import { normaliseCounts, type DisconnectCounts } from '@/lib/disconnect-all-sentence';

export type { DisconnectCounts } from '@/lib/disconnect-all-sentence';

const NOT_DEPLOYED_CODES = new Set(['PGRST202', 'PGRST203', '42883', '3F000']);

export function isDisconnectNotDeployed(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code && NOT_DEPLOYED_CODES.has(String(e.code))) return true;
  return /could not find the function|schema cache|function .* does not exist/i.test(String(e.message ?? ''));
}

/** The press needs this session stepped up to aal2 first. Nothing was done. */
export class StepUpRequiredError extends Error {
  constructor() {
    super('Confirm it’s you to disconnect everything.');
    this.name = 'StepUpRequiredError';
  }
}

/** The one sentence for a press that did not happen. */
export const NOTHING_DISCONNECTED = 'Nothing was disconnected — try again.';

function nothingDisconnected(detail?: string | null): Error {
  return new Error(detail ? `${NOTHING_DISCONNECTED} (${detail})` : NOTHING_DISCONNECTED);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type PreviewResult =
  | { ok: true; counts: DisconnectCounts }
  | { ok: false; notDeployed: boolean; error?: string };

export async function previewDisconnect(
  scope: 'account' | 'matter',
  matterId?: string | null,
): Promise<PreviewResult> {
  const { data, error } = await supabase.rpc('disconnect_all_preview', {
    p_scope: scope,
    p_matter: matterId ?? null,
  });
  if (error) {
    if (isDisconnectNotDeployed(error)) return { ok: false, notDeployed: true };
    return { ok: false, notDeployed: false, error: error.message };
  }
  return { ok: true, counts: normaliseCounts(data) };
}

export async function disconnectAccount(): Promise<{ counts: DisconnectCounts; othersSignedOut: boolean }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch('/api/account-lockdown', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = (await res.json().catch(() => null)) as
    | { counts?: unknown; others_signed_out?: boolean; error?: string; message?: string | null }
    | null;
  if (!res.ok) {
    if (body?.error === 'step_up_required') throw new StepUpRequiredError();
    if (body?.error === 'not_available') {
      throw new Error('This is not set up on this workspace yet. Nothing was disconnected.');
    }
    throw nothingDisconnected(body?.message);
  }
  // The lock is stamped in whole seconds against the sign-in's issue time;
  // a token refreshed in the same second as the press would still count as
  // older. A failed refresh is not the press failing — the next reconnection
  // will say "sign in again", which is true.
  await sleep(1100);
  await supabase.auth.refreshSession().catch(() => undefined);
  return { counts: normaliseCounts(body?.counts), othersSignedOut: body?.others_signed_out === true };
}

export async function disconnectMatter(matterId: string): Promise<DisconnectCounts> {
  const { data, error } = await supabase.rpc('disconnect_all', {
    p_scope: 'matter',
    p_matter: matterId,
  });
  if (error) {
    if (isDisconnectNotDeployed(error)) {
      throw new Error('This is not set up on this workspace yet. Nothing was disconnected.');
    }
    throw nothingDisconnected(error.message);
  }
  return normaliseCounts(data);
}

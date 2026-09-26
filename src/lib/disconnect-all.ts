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
//   * the press itself never waits for a second factor (revoking is the safe
//     direction). Signing the OTHER browsers out may: when the account has a
//     factor this session has not confirmed, the press answers
//     signOutNeedsStepUp, the card asks for the factor, and signOutOthers()
//     finishes the job. Nothing further is revoked by it.
//   * this tab keeps working after the press: the database lets the session
//     that pressed reconnect things by identity, and refuses every other
//     session that began before the press.
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
    super('Confirm it’s you to sign your other browsers out.');
    this.name = 'StepUpRequiredError';
  }
}

/** The one sentence for a press that did not happen. */
export const NOTHING_DISCONNECTED = 'Nothing was disconnected — try again.';

function nothingDisconnected(detail?: string | null): Error {
  return new Error(detail ? `${NOTHING_DISCONNECTED} (${detail})` : NOTHING_DISCONNECTED);
}

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

type LockdownBody = {
  counts?: unknown; others_signed_out?: boolean; sign_out?: string; error?: string; message?: string | null;
} | null;

async function postLockdown(payload: Record<string, unknown>): Promise<{ ok: boolean; body: LockdownBody }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch('/api/account-lockdown', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, body: (await res.json().catch(() => null)) as LockdownBody };
}

export async function disconnectAccount(): Promise<{
  counts: DisconnectCounts; othersSignedOut: boolean; signOutNeedsStepUp: boolean;
}> {
  const { ok, body } = await postLockdown({});
  if (!ok) {
    if (body?.error === 'not_available') {
      throw new Error('This is not set up on this workspace yet. Nothing was disconnected.');
    }
    throw nothingDisconnected(body?.message);
  }
  return {
    counts: normaliseCounts(body?.counts),
    othersSignedOut: body?.others_signed_out === true,
    signOutNeedsStepUp: body?.sign_out === 'step_up_required',
  };
}

/** The second half on its own, once the factor is confirmed. Revokes nothing. */
export async function signOutOthers(): Promise<boolean> {
  const { ok, body } = await postLockdown({ sign_out_only: true });
  if (!ok) {
    if (body?.error === 'step_up_required') throw new StepUpRequiredError();
    return false;
  }
  return body?.others_signed_out === true;
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

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
    if (body?.error === 'not_available') {
      throw new Error('This is not set up on this workspace yet. Nothing was disconnected.');
    }
    throw new Error(
      `Nothing was disconnected${body?.message ? `: ${body.message}` : '. Try again in a moment.'}`,
    );
  }
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
    throw new Error(`Nothing was disconnected: ${error.message}`);
  }
  return normaliseCounts(data);
}

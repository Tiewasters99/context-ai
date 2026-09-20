// The AI pause, from the browser (migration 070).
//
// One switch: stop everything on this matter. Not a tier — the tier says where
// content may go, the pause says nothing goes anywhere, on any tier. Server
// enforcement lives in lib/ai-tier-policy.mjs (the /api/llm gate and the
// assistant loop), lib/mcp-core.mjs (connectors) and lib/seal-pipes.mjs (the
// pipeline). This file is the two RPCs and the classification the UI needs.
//
// NOT DEPLOYED IS NOT AN ERROR. Until 070 is pasted, `matter_ai_pause` is not
// in PostgREST's schema cache (PGRST202) and `matterspaces.ai_paused` does not
// exist (42703). Both mean one thing — this database does not have the pause
// yet — and the product must behave exactly as it does today: the control
// hides itself and nothing is blocked. Everything else is a real error, and on
// a matter we already know to be paused a real error fails CLOSED.

import { supabase } from '@/lib/supabase';

export interface AiPauseState {
  paused: boolean;
  /** migration 070 is not in this database — behave as today, hide the control. */
  notDeployed: boolean;
  /** the read failed for a reason that is NOT "not deployed". */
  error?: string;
  /** the matter that actually carries the pause (this one, or an ancestor). */
  pausedMatterId?: string | null;
  pausedMatterName?: string | null;
  at?: string | null;
  by?: string | null;
  byName?: string | null;
  note?: string | null;
  inherited?: boolean;
}

export const NOT_PAUSED: AiPauseState = { paused: false, notDeployed: false };

/**
 * Codes that mean "migration 070 has not been applied here", and nothing else.
 * 42703 (undefined_column) and PGRST204 are the two that matter for a
 * migration which adds COLUMNS to a table that already exists — the rest are
 * lib/ledger.mjs's list, kept in step so the two lanes classify alike.
 */
const NOT_DEPLOYED_CODES = new Set([
  'PGRST202', 'PGRST203', 'PGRST204', 'PGRST205', '42703', '42883', '42P01', '3F000',
]);
const NOT_DEPLOYED_RE =
  /(column .* does not exist|could not find the (column|function|table)|schema cache|function .* does not exist|relation .* does not exist)/i;

export function isPauseNotDeployed(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code && NOT_DEPLOYED_CODES.has(String(e.code))) return true;
  return NOT_DEPLOYED_RE.test(String(e.message ?? ''));
}

interface PauseRow {
  paused: boolean;
  paused_matter: string | null;
  paused_matter_name: string | null;
  paused_at: string | null;
  paused_by: string | null;
  paused_by_name: string | null;
  note: string | null;
  inherited: boolean;
}

/**
 * Is AI paused on this matter — here or on any ancestor? One round trip; the
 * chain is walked in SQL (migration 070 §7) so the browser does not make a
 * request per ancestor.
 */
export async function readAiPause(matterId: string): Promise<AiPauseState> {
  const { data, error } = await supabase.rpc('matter_ai_pause', { p_matter: matterId });
  if (error) {
    if (isPauseNotDeployed(error)) return { paused: false, notDeployed: true };
    return { paused: false, notDeployed: false, error: error.message };
  }
  const row = (Array.isArray(data) ? data[0] : data) as PauseRow | null;
  if (!row || !row.paused) return NOT_PAUSED;
  return {
    paused: true,
    notDeployed: false,
    pausedMatterId: row.paused_matter,
    pausedMatterName: row.paused_matter_name,
    at: row.paused_at,
    by: row.paused_by,
    byName: row.paused_by_name,
    note: row.note,
    inherited: row.inherited,
  };
}

/**
 * The sentence, client-side. Identical wording to aiPausedMessage() in
 * lib/ai-tier-policy.mjs — a user who meets the pause in two surfaces should
 * learn one fact, not two. scripts/_verify-ai-pause.mjs asserts the two
 * strings match.
 */
export function aiPausedSentence(p: Pick<AiPauseState, 'byName' | 'at'>): string {
  const who = p.byName && p.byName.trim() ? p.byName.trim() : 'a member of this matter';
  const when = p.at && !Number.isNaN(new Date(p.at).getTime())
    ? new Date(p.at).toISOString().slice(0, 10)
    : 'an unrecorded date';
  return `AI is paused on this matter by ${who} since ${when}. Nothing is being sent to any model.`;
}

/**
 * Pause or resume. The RPC is the only door: migration 070 puts a trigger on
 * matterspaces that refuses a direct UPDATE of the pause columns, because the
 * byline (who, when) is evidence and evidence a client can type is not
 * evidence.
 *
 * Returns the number of held documents/jobs released on a resume.
 */
export async function setAiPause(
  matterId: string,
  paused: boolean,
  note?: string | null,
): Promise<{ released: number }> {
  const { data, error } = await supabase.rpc('matter_set_ai_pause', {
    p_matter: matterId,
    p_paused: paused,
    p_note: note ?? null,
  });
  if (error) {
    if (isPauseNotDeployed(error)) {
      throw new Error(
        'The AI pause is not set up on this workspace yet (migration 070 has not been applied).',
      );
    }
    throw new Error(error.message);
  }
  const out = (data ?? {}) as { released?: number };
  await recordPauseEvent(matterId, paused, note ?? null);
  return { released: Number(out.released ?? 0) };
}

/**
 * The matter's Record gets a line for it (lib/ledger.mjs, migration 064).
 *
 * Dynamic import, and everything swallowed: this lane must work whether the
 * ledger has merged or not, and whether 064 has been pasted or not. record()
 * already classifies a missing table as "not deployed" rather than a failure;
 * an import that does not resolve is treated the same way. The pause itself
 * has already happened by the time this runs — it is never the reason a pause
 * fails.
 *
 * Metadata only: the note travels under the key `note`, which lib/ledger.mjs
 * lists as content-bearing and replaces with its size. The Record says a
 * matter was paused and by whom; it does not copy the words.
 */
async function recordPauseEvent(matterId: string, paused: boolean, note: string | null) {
  try {
    const { record } = await import('../../lib/ledger.mjs');
    const { data: auth } = await supabase.auth.getUser();
    await record(supabase, {
      kind: paused ? 'ai.paused' : 'ai.resumed',
      matterId,
      actor: { kind: 'user', ref: auth?.user?.id ?? null, user_id: auth?.user?.id ?? null },
      payload: { note, via: 'matter_header' },
    });
  } catch {
    /* the Record is never the reason a pause fails */
  }
}

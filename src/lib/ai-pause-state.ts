// The pause control's state machine, on its own and with no imports.
//
// It lives apart from src/lib/ai-pause.ts for one reason: that file reaches
// for the Supabase client at module load, so the rule below could not be
// exercised by anything but a browser. A safety switch whose failure mode
// cannot be tested is a safety switch nobody has checked, and this one had a
// failure mode worth checking — see nextPauseState().

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
 * What the control should show after a read, given the last answer it trusts.
 *
 * Three outcomes, and the middle one is the fix (2026-09-20):
 *
 *   * NOT DEPLOYED — migration 070 is absent. The control hides itself and
 *     nothing about the product changes. Only a genuine not-deployed answer
 *     does this.
 *   * A READ ERROR — the control STAYS VISIBLE and says it could not check.
 *     Until today the initial state carried `notDeployed: true` and an error
 *     kept the previous state, so the very first failed read left that flag
 *     standing and the component returned null: the emergency stop removed
 *     itself from the screen at exactly the moment something was wrong, and
 *     did it silently. Failing closed is the file's own stated rule, and
 *     vanishing is not a closed state — it is the same claim as "AI is
 *     running", made without a word.
 *   * A READ ERROR ON A MATTER WE KNOW TO BE PAUSED — the last trusted answer
 *     stands. "Paused" is the safe reading, and it is also the true one until
 *     something says otherwise.
 */
export function nextPauseState(known: AiPauseState, next: AiPauseState): AiPauseState {
  if (!next.error) return next;
  if (known.paused) return known;
  return { ...NOT_PAUSED, error: next.error };
}

/** The control cannot say whether AI is paused, and must say so rather than hide. */
export function isPauseUnknown(state: AiPauseState): boolean {
  return !state.notDeployed && !state.paused && Boolean(state.error);
}

/** The words for that state. One sentence, and it claims nothing either way. */
export const PAUSE_UNKNOWN_SENTENCE = 'Could not check whether AI is paused — retry';

// Tiny event bus that lets any surface hand a command to the Orchestrator.
// The docket's selection-to-command chip ("highlight text → Run") and its
// next-step Run buttons dispatch here; MainLayout listens to open the
// panel and Assistant listens to execute the prompt, scoped to the matter
// the command came from. A DOM CustomEvent (not React context) so the
// dispatcher and the panel need no component relationship.

export interface AssistantCommand {
  /**
   * The prompt to run. OPTIONAL: a command with no prompt just opens the
   * panel scoped to the matter/charter it names — SecureChat's "open the
   * sealed room" button — without spending a model call.
   */
  prompt?: string;
  matterId?: string;
  matterName?: string;
  /**
   * Display hint: the named matter is sealed (SecureSpace Tier B/C), so the
   * panel may show the sealed-room strip immediately instead of waiting for
   * the server's `session` event. Display only — the server enforces the
   * tier from the database regardless of what this says.
   */
  sealed?: boolean;
  /**
   * Run under an agent charter: an agent_charters uuid, or `builtin:<key>`
   * for one of the standing "On duty" agents. Only the ID travels — the
   * server loads the charter under the user's own RLS and narrows the run's
   * tools to it (lib/agent-charter.mjs). The scope sticks for follow-up
   * questions in the same panel, exactly like the matter does.
   */
  charterId?: string;
  charterName?: string;
}

export const ASSISTANT_COMMAND_EVENT = 'cs:assistant-command';

export function runInAssistant(cmd: AssistantCommand): void {
  window.dispatchEvent(new CustomEvent<AssistantCommand>(ASSISTANT_COMMAND_EVENT, { detail: cmd }));
}

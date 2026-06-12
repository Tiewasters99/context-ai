// Situational context for the Orchestrator panel.
//
// The active Matterspace tab lives in MatterspaceView component state (not
// the URL), so the panel can't derive it from the router. Instead, views
// publish what they know here and the panel snapshots it when a message is
// sent. Module-level on purpose: no provider plumbing, no re-renders — the
// value is only ever read at send time.

export interface OrchestratorPageContext {
  /** Active Matterspace tab, e.g. "Updates". */
  tab?: string;
  /** Display name of the matter being viewed. */
  matterName?: string;
}

let current: OrchestratorPageContext = {};

export function setOrchestratorContext(ctx: OrchestratorPageContext) {
  current = ctx;
}

export function clearOrchestratorContext() {
  current = {};
}

export function getOrchestratorContext(): OrchestratorPageContext {
  return current;
}

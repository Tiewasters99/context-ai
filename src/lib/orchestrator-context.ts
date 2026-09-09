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
  /** The matter the view belongs to when the URL does not name one — the
   *  reader's route names a document, not its matter. */
  matterId?: string;
  /** The document open in the reader, and the page in front of the user. */
  documentId?: string;
  documentTitle?: string;
  page?: number;
  pageCount?: number;
  /** That page's text, bounded, so the companion can discuss what is on screen. */
  pageText?: string;
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

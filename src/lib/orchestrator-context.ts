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
  /** The page with the most of the screen — the reader's estimate. */
  page?: number;
  pageCount?: number;
  /** The pages on screen, most visible first, each with its text (bounded),
   *  so the companion can discuss what is actually in front of the user. */
  pages?: { page: number; share: number; text?: string }[];
  /** False for a generated copy that has no indexed passages (an edited
   *  PDF): search and quotes must go to the original it was made from. */
  indexed?: boolean;
  sourceDocumentId?: string;
  /** Why an unindexed document has no passages: a generated copy, or an
   *  import that never ran or produced nothing. */
  unindexedReason?: 'generated' | 'not-ingested';
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

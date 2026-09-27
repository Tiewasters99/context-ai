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
  /** The Brief Desk: the brief on the desk and the matters it draws on. */
  brief?: BriefContext;
}

export interface BriefContext {
  title: string;
  /** The first lines of the brief as it reads — the caption, court and parties. */
  caption?: string;
  /** The matter the brief draws on: the record, the appendix, the cases (the bound matter). */
  recordMatterName?: string;
  /** Where its A-cites open: the Joint Appendix set. */
  appendixMatterName?: string;
  /** Where "Add a case" files. */
  casesMatterName?: string;
  citesChecked?: number;
}

let current: OrchestratorPageContext = {};
// A surface that owns the page (the Brief Desk) publishes here, OVER whatever
// a component inside it publishes: the authority pane's embedded Reader
// publishes the case's own folder as the matter, which is exactly the folder
// the desk must not bind the Orchestrator to.
let surface: Partial<OrchestratorPageContext> = {};

export function setOrchestratorContext(ctx: OrchestratorPageContext) {
  current = ctx;
}

export function clearOrchestratorContext() {
  current = {};
}

export function setSurfaceContext(ctx: Partial<OrchestratorPageContext>) {
  surface = ctx;
}

export function clearSurfaceContext() {
  surface = {};
}

export function getOrchestratorContext(): OrchestratorPageContext {
  return { ...current, ...surface };
}

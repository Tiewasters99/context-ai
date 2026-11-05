// Types for lib/orchestrator-guide.mjs — the browser bundle imports that
// module directly (src/pages/Help.tsx) so the Help page and the Orchestrator's
// app_guide tool read one and the same set of entries.

export interface GuideEntry {
  /** Stable slug; the Help page's anchor. */
  id: string;
  /** One of ROOMS. */
  room: string;
  /** What the entry answers, as a short heading. */
  title: string;
  /** The rooms it concerns, as routes ("/app/document/<id>"); [] = everywhere. */
  routes: string[];
  /** Phrasings people use, for the lookup. */
  asks: string[];
  /** The answer, for a person and the Orchestrator alike. */
  text: string;
  /** What only the Orchestrator needs to know. */
  orchestrator?: string;
}

export const ROOMS: readonly string[];
export const GUIDE: GuideEntry[];

export const GUIDE_TOOL: {
  readonly name: 'app_guide';
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
};

export function guideTokens(text: unknown): string[];
export function guideForPlan(plan?: string | null): GuideEntry[];
export function guideIndex(plan?: string | null): string[];
export function lookupGuide(question: string, plan?: string | null, limit?: number): GuideEntry[];
export function renderGuide(entries: GuideEntry[]): string;
export function guidePromptBlock(plan?: string | null): string;

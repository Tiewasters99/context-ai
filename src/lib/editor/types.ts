/**
 * The Contextspaces Editor — engine types.
 *
 * The Editor's identity and procedures live in docs/editor/CONSTITUTION.md
 * (loaded verbatim into its prompts). These types are the shape of its
 * work-product: every proposed edit carries the claim-before-rewrite
 * intermediate work the constitution requires, and every edit is delivered
 * as a reviewable redline the lawyer rules on — never a regenerated blob.
 */

export const CORRECTIVE_MARKS = [
  'obscure',
  'confusing',
  'transition',
  'choppy',
  'repetitive',
  'weak',
  'vague',
  'awkward',
  'diction',
  'antecedent',
  'barbare',
] as const;
export type CorrectiveMark = (typeof CORRECTIVE_MARKS)[number];

/**
 * The forms of the work (charter v0.3). The Editor holds every manuscript
 * to the demands of its form; undeclared, it names the form in its plan.
 */
export const DOCUMENT_FORMS = [
  'brief',
  'memo',
  'letter',
  'research paper',
  'creative writing',
  'marketing',
  'presentation',
] as const;
export type DocumentForm = (typeof DOCUMENT_FORMS)[number];

export const PRAISE_MARKS = [
  'excellent',
  'insightful',
  'well said',
  'nice',
  'very sharp',
  'strong',
  'yes!',
  'clear',
  'brilliant',
] as const;
export type PraiseMark = (typeof PRAISE_MARKS)[number];

export interface ProposedEdit {
  id: string;
  /** Character offset of `before` in the manuscript (set by the verifier). */
  pos: number;
  /** Verbatim manuscript text this edit replaces. */
  before: string;
  /** The rewrite, generated from the claim. Empty string proposes a cut. */
  after: string;
  mark: CorrectiveMark;
  /** The claim in propositional form — or '' when no claim extracts (that null result IS the diagnosis). */
  claim: string;
  /** Why the current words fail to deliver the claim. */
  failure: string;
  /** The constitutional principle, vocabulary entry, or image-bench test being applied. */
  authority: string;
  /** Warning attached by the deterministic verifier (e.g. a cut removes a citation). */
  caution?: string;
  /** Second opinion from the blind critic, when the critic flagged this rewrite. */
  criticNote?: string;
}

export interface RejectedEdit extends Omit<ProposedEdit, 'pos'> {
  rejectionReason: string;
}

export interface PraiseNote {
  id: string;
  /** Character offset in the manuscript, or -1 if the quote couldn't be anchored. */
  pos: number;
  /** Verbatim passage that earns the mark. */
  quote: string;
  mark: PraiseMark;
  note: string;
}

export interface PlannedSection {
  title: string;
  /** Verbatim opening words of the section — the anchor used to split the manuscript. */
  firstWords: string;
  /** What this section does for the thesis. */
  role: string;
  /** Section-level AI-structure diagnosis, if any. */
  structuralNote?: string;
}

export interface DocumentPlan {
  /** What the document is trying to say, in one committed sentence. */
  thesis: string;
  /** The Editor's overall structural assessment. */
  assessment: string;
  sections: PlannedSection[];
}

export interface PassUsage {
  inputTokens: number;
  outputTokens: number;
  modelId: string;
  /** USD at list prices, when the model's price is on file. Thinking tokens bill as output. */
  estimatedCost?: number;
}

export interface EditorPassResult {
  plan: DocumentPlan;
  /** Verified edits, in manuscript order, awaiting the lawyer's ruling. */
  edits: ProposedEdit[];
  praise: PraiseNote[];
  /** Edits the deterministic verifier refused to deliver — shown, never silently dropped. */
  rejected: RejectedEdit[];
  /** The blind critic's overall note on the rewritten text. */
  criticReport: string;
  /** Non-fatal incidents during the pass (a section that errored, an unmatched anchor). */
  passNotes: string[];
  /** What the pass cost — every call's tokens, summed, priced when possible. */
  usage?: PassUsage;
}

export interface EditorProgress {
  phase: 'plan' | 'edit' | 'critic' | 'verify';
  /** Narration for the room, e.g. "Editing section 2 of 4 — 'The standard of review'". */
  label: string;
  sectionIndex?: number;
  sectionCount?: number;
}

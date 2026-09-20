// Which feature made a model call — the label that reaches the matter's
// Record.
//
// `/api/llm` is one endpoint behind six surfaces. Without this, the Record
// could say "a model was called on this matter" and nothing more, which is
// not an answer to the question a court, a bar or a client actually asks:
// what was the AI used FOR. So every call carries a label, and the label is
// per ACT rather than per feature — classifying a document, proposing a
// bucket tree and pulling evidence are three different things to have done to
// a client's file, and counsel's AI Use Record lists them separately.
//
// The server does not trust this. `lib/llm-record.mjs` holds the same list and
// validates against it, because these rows cannot be deleted by anybody and a
// caller must not be able to write free text into one. An unrecognised label
// is recorded as 'unspecified'; it is never a reason to refuse the call.
//
// The two lists are asserted identical by scripts/_verify-llm-record.mjs. This
// one is TypeScript so that a typo at a call site is a build error rather than
// a row in a court exhibit that says 'unspecified'.

export const LLM_FEATURES = [
  'bucketizer.tree',
  'bucketizer.classify',
  'bucketizer.evidence',
  'citecheck.extract',
  'citecheck.check',
  'editor.light',
  'editor.plan',
  'editor.section',
  'editor.critic',
  'deck',
  'workbench',
  'moot.generate',
  'moot.converse',
] as const;

export type LlmFeature = (typeof LLM_FEATURES)[number];

/**
 * What every `/api/llm` caller may add to its request envelope. Optional
 * throughout: a call that does not say leaves 'unspecified' in the Record,
 * which is honest, and a call with no matter is not recorded at all.
 */
export interface LlmRecordFields {
  /** The act this call performs, for the matter's Record. */
  feature?: LlmFeature;
  /**
   * The documents this call is working on — ids only, never titles. Kept in
   * the Record only when every element is a uuid (lib/ledger.mjs uuidList).
   */
  documentIds?: string[];
}

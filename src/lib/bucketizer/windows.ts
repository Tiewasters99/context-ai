// Whole-document classification: the window plan, the per-window prompt, the
// output contract, and the deterministic merge.
//
// The implementation now lives in `lib/bucketizer-windows.mjs`, because the
// same plan, the same words and the same merge have to run on the Fly worker
// as well: a classification run must survive a closed laptop, and a run that
// starts in the tab and finishes on the worker must partition the document the
// same way, ask the model the same question, and fold the answers together the
// same way. Two copies of that would be two copies of the case theory.
//
// Nothing about the behaviour changed in the move — the types became a
// `.d.mts` and that is all — and this file stays where every importer and
// `scripts/_verify-bucketizer-scale.mjs` expect it.
export {
  WINDOW_CHAR_BUDGET,
  MAX_WINDOW_CHAR_BUDGET,
  TARGET_MAX_WINDOWS,
  MERGED_ASSIGNMENT_CAP,
  MERGED_PASSAGE_CAP,
  WINDOW_SYSTEM_SUFFIX,
  planWindows,
  buildWindowUserContent,
  checkWindowContract,
  buildRepairUserContent,
  mergeWindowResults,
} from '../../../lib/bucketizer-windows.mjs';

export type {
  WindowPassage,
  PassageWindow,
  WindowPlan,
  WindowPromptResult,
  WindowAssignment,
  ContractCheck,
  WindowResult,
  MergedAssignment,
} from '../../../lib/bucketizer-windows.mjs';

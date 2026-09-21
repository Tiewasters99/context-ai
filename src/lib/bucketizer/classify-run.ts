// The windowed classification run: resumable, per-window, and pure with
// respect to everything it touches.
//
// The loop now lives in `lib/bucketizer-document.mjs`. It was always
// dependency-injected — every effect arrives as `RunDeps` — and that is what
// made it portable: the browser builds a Supabase-and-`/api/llm` set of deps,
// the Fly worker builds a service-role-and-in-process set
// (`lib/bucketizer-run.mjs`), and the offline harness builds a set backed by
// arrays and a counter. Three callers, one loop, which is the only way "the
// run that moved to the worker is the same run" can be an assertion rather
// than a hope.
//
// Nothing about the behaviour changed in the move — the types became a
// `.d.mts` and that is all — and this file stays where every importer and
// `scripts/_verify-bucketizer-scale.mjs` expect it.
export {
  WINDOW_MAX_TOKENS,
  STORED_RATIONALE_CHARS,
  classifyDocumentWindowed,
} from '../../../lib/bucketizer-document.mjs';

export type {
  StoredWindow,
  StoredRun,
  Coverage,
  WindowCall,
  RunDeps,
  DocStatus,
  DocOutcome,
  RunDocumentInput,
} from '../../../lib/bucketizer-document.mjs';

// The repair turn's user content — the prose half of "validate → ONE repair →
// fail plainly" (PR #200).
//
// WHY IT MOVED HERE
// ---------------------------------------------------------------------------
// It was written in `src/lib/llm/contract.ts`, which is a browser module: it is
// reachable from the SPA and from harnesses that can resolve the `@/` alias,
// and from nowhere else. The server-side Bucketizer runner
// (`lib/bucketizer-run.mjs`) runs the SAME windowed classification on the Fly
// worker, and it has to send the SAME repair turn — a run that moves from the
// tab to the worker must not quietly start asking the model a different
// question.
//
// So the text lives in `lib/`, which both sides import, and
// `src/lib/llm/contract.ts` re-exports it. The string this builds is
// byte-identical to what that module built; `scripts/_verify-bucketizer-scale.mjs`
// and `scripts/_verify-cite-check-contracts.mjs` hold it unchanged.
//
// No `node:` imports, deliberately: this module is bundled into the browser.

/** Characters of the model's own answer echoed back to it in the repair turn. */
export const REPAIR_ECHO_CHARS = 1200;

/**
 * The narrowest possible restatement: the original request, what was wrong,
 * what the model actually sent, and the exact shape wanted. `shape` is one line
 * of literal JSON; `rules` is the prose that follows it — what an empty answer
 * looks like, and the two or three mistakes worth naming.
 *
 * @param {{original: string, reason: string, sent: unknown, shape: string, rules: string}} args
 * @returns {string}
 */
export function buildRepairContent(args) {
  const { original, reason, sent, shape, rules } = args;
  let shown;
  try {
    shown = JSON.stringify(sent).slice(0, REPAIR_ECHO_CHARS);
  } catch {
    shown = String(sent).slice(0, REPAIR_ECHO_CHARS);
  }
  return (
    `${original}\n\n`
    + `## Your previous answer could not be used\n`
    + `Reason: ${reason}.\n`
    + `You sent: ${shown}\n\n`
    + `Answer again by calling the tool, with exactly this shape and nothing else:\n`
    + `${shape}\n`
    + `${rules}`
  );
}

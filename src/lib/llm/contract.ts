// Holding a model to an output contract: validate → ONE repair → fail plainly.
//
// WHY THIS IS A SHARED MODULE NOW
// ---------------------------------------------------------------------------
// Inside a sealed matter every feature model call is answered by the sealed pen
// (`lib/llm-sealed-route.mjs`), and the pen is less reliable than frontier
// Claude at holding a forced tool call to a shape. PR #168 worked the right
// pattern out for Bucketizer's classify step and #177 repeated it for the
// evidence step; both grew their own copy of the same two helpers.
//
// The pattern, stated once:
//
//   1. VALIDATE the model's answer against the contract the caller actually
//      needs — shape, required fields, enumerations, referential integrity.
//      Never `as T` a model's output into a type and hope.
//   2. On failure, ONE repair turn. It shows the model its own answer and the
//      precise reason it could not be used, and asks for the corrected answer
//      only. It goes through the SAME `/api/llm` path with the SAME feature
//      label, so it is metered and recorded exactly like the first turn — a
//      repair is a call that was paid for, and the matter's Record says so.
//   3. On a second failure, a plain, specific sentence the surface can show,
//      and NOTHING persisted from the failed attempt. A second
//      misunderstanding of the same contract will not be resolved by a third
//      payment, and a half-written answer is worse than no answer: a row that
//      carries a confidence and a rationale reads as reviewed.
//
// What this module deliberately does NOT do: catch. A refusal — 402 budget,
// 429 rate window, a sealed matter's 403, an abort — is not a contract failure
// and must reach the caller with the server's own sentence intact. `call`
// throws and `runWithContract` lets it through untouched.

/** The result of checking a model's answer against a contract. */
export type ContractCheck<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/** Characters of the model's own answer echoed back to it in the repair turn. */
export const REPAIR_ECHO_CHARS = 1200;

/**
 * The repair turn's user content.
 *
 * The narrowest possible restatement: the original request, what was wrong,
 * what the model actually sent, and the exact shape wanted. `shape` is one
 * line of literal JSON; `rules` is the prose that follows it — what an empty
 * answer looks like, and the two or three mistakes worth naming.
 *
 * Byte-for-byte the text `src/lib/bucketizer/windows.ts` and
 * `src/lib/bucketizer/evidence-prompt.ts` built before this module existed;
 * both now delegate here, and their harnesses hold that text unchanged.
 */
export function buildRepairContent(args: {
  original: string;
  reason: string;
  sent: unknown;
  shape: string;
  rules: string;
}): string {
  const { original, reason, sent, shape, rules } = args;
  let shown: string;
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

/** One turn of a contracted call. `attempt` is 1, or 2 on the repair. */
export interface ContractAttempt {
  userContent: string;
  attempt: 1 | 2;
}

export type ContractOutcome<T> =
  | { ok: true; value: T; repaired: boolean }
  | { ok: false; reason: string };

/**
 * Make the call, validate, repair once, and report a plain failure.
 *
 * `call` owns the model call and everything about it that must not change
 * between the two turns — the model, the system prompt, the tool, the schema,
 * the output allowance, the feature label. The ONLY thing that differs on the
 * repair turn is the user content, which is why it is the only thing passed.
 *
 * Errors from `call` are NOT caught. A 402, a 429, a sealed refusal or an
 * abort is a fact about the server or the wallet, not about this answer, and
 * flattening it into "the model's answer could not be read" would be the same
 * class of bug as flattening a 402 into "cite not found".
 */
export async function runWithContract<T>(args: {
  userContent: string;
  call: (attempt: ContractAttempt) => Promise<unknown>;
  validate: (raw: unknown) => ContractCheck<T>;
  /** Build the repair turn's user content from the original, reason and answer. */
  repair: (original: string, reason: string, sent: unknown) => string;
}): Promise<ContractOutcome<T>> {
  const { userContent, call, validate, repair } = args;

  const first = await call({ userContent, attempt: 1 });
  const checked = validate(first);
  if (checked.ok) return { ok: true, value: checked.value, repaired: false };

  // One repair. A second misunderstanding of the same contract is not going to
  // be resolved by a third payment.
  const second = await call({
    userContent: repair(userContent, checked.reason, first),
    attempt: 2,
  });
  const rechecked = validate(second);
  if (rechecked.ok) return { ok: true, value: rechecked.value, repaired: true };

  return { ok: false, reason: rechecked.reason };
}

// ---------------------------------------------------------------------------
// Small shared validators
// ---------------------------------------------------------------------------

/** A trimmed, non-empty string, or null. Never a number the model wrote as one. */
export function trimmedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
}

/**
 * Sibling labels, whitespace-folded and case-folded, for a duplicate check.
 * Two buckets called "Notice" and "notice " are one bucket typed twice.
 */
export function labelKey(label: string): string {
  return label.replace(/\s+/g, ' ').trim().toLowerCase();
}

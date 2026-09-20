// What a refused server call says to the person who made it.
//
// Three things can refuse now, and until 2026-09-20 each one reached the user
// differently or not at all:
//
//   403/502/503 — the SEAL. /api/llm answers a machine code —
//     `tier_violation`, `sealed_pen_unavailable`, `sealed_pen_error`,
//     `sealed_route_untranslatable` (PRs #159, #163); the content pipes answer
//     `sealed_pipe`. A lawyer who sealed a matter and pressed Classify read
//     the word "tier_violation" and had no idea whether their client's file
//     had just been sent somewhere.
//   402 — the monthly WALLET (migration 063, PR #161). `over_monthly_budget`
//     or `over_kind_budget`.
//   429 — the RATE window (same migration). `over_rate_limit`, or
//     `meter_error` from the unauthenticated limiter.
//
// The 402/429 bodies carry a `message` written for a person and, on a 429, a
// `retry_after_seconds`; a `retry-after` header says the same thing. Every
// paid endpoint answers this shape — /api/llm, /api/assistant, /api/tts,
// /api/ingest, /api/student-hub-ocr, /api/deepgram-token, /api/meeting-chat,
// /api/sandbox, /api/legal-source — so the parser here is shared by all of
// them rather than living once per caller. It is in this folder because the
// sealed copy already lived here and must not be duplicated.
//
// The voice is the one the Assistant and the content pipes already use
// (lib/assistant-core.mjs, lib/seal-pipes.mjs): name the step, say whether
// anything was sent, say what would unblock it. Nothing here claims the
// sealed pen is as good as the model the feature was tuned on — it isn't, and
// saying so is the feature's job, not the error's.
//
// The server is the authority: when it sends a `message`, that message is
// shown as written. These strings are the fallback for a server that predates
// those PRs, or for a code that carries no copy. There are exactly two
// documented departures from "as written", and both are below: the upsell
// clause and the retry seconds.

export interface LlmErrorBody {
  error?: string | { message?: string };
  message?: string;
  tier?: 'A' | 'B' | 'C' | null;
  provider?: string;
  retry_after_seconds?: number | null;
}

/**
 * What kind of "no" this was.
 *
 *   budget — the month's wallet is spent (402). Waiting will not help before
 *            the month turns.
 *   rate   — too many requests in the window (429). Waiting a few seconds will.
 *   sealed — a SecureSpace refusal (403/502/503). The work stopped rather
 *            than being sent outside the seal.
 *   other  — anything else: auth, a provider error, a 5xx, a bad body.
 */
export type RefusalKind = 'budget' | 'rate' | 'sealed' | 'other';

export interface ServerRefusal {
  kind: RefusalKind;
  /** A sentence for a person. Never a code, never raw JSON. */
  message: string;
  /** Seconds until the rate window reopens, when the server said. */
  retryAfterSeconds?: number;
  /** The HTTP status that carried it. */
  status: number;
  /** The server's machine code, for logs and tests — never for display. */
  code?: string;
}

const SEALED_UNAVAILABLE =
  'This matter is sealed (SecureSpace Tier B), and the sealed pen — a model in our own AWS ' +
  'account under zero data retention — is not available on this server. Nothing was sent: no ' +
  'model outside the seal was asked, and no part of this matter left the room. The step waits ' +
  'until the sealed pen is in place — or unseal the matter to use an ordinary model.';

const SEALED_ERROR =
  'This matter is sealed (SecureSpace Tier B) and the sealed pen could not answer. No other ' +
  'model was asked — a sealed matter is never handed to a provider outside the seal — so the ' +
  'step stopped rather than being sent elsewhere. Try again in a moment; if it keeps failing, ' +
  'the sealed pen needs attention.';

const SEALED_UNTRANSLATABLE =
  'This matter is sealed (SecureSpace Tier B), and this step cannot be carried to the sealed ' +
  'pen unchanged — it asks the model for something the sealed route does not carry. Nothing ' +
  'was sent. Try the same step with a text-only prompt and a Claude or OpenAI model, or ' +
  'unseal the matter.';

const SILO =
  'This matter is a Silo (SecureSpace Tier C): nothing may leave the building, and the Silo ' +
  'appliance is not connected yet. No model was called.';

const SEALED_PIPE =
  'This matter is sealed (SecureSpace), so this step was not sent outside the seal. Nothing ' +
  'left the room.';

// The wallet's own words, minus the upsell — see withoutUpsell() below. This
// is character-for-character lib/usage-meter.mjs's fallback sentence, so a
// server that sends no message and a server whose message we trim read alike.
const BUDGET_FALLBACK =
  "You've reached this month's included AI usage. It resets at the start of next month.";

const RATE_FALLBACK =
  'Too many requests just now — give it a moment and try again.';

/** Every code that means "the seal stopped this", whatever status carried it. */
const SEALED_CODES = new Set([
  'tier_violation',
  'sealed_pen_unavailable',
  'sealed_pen_error',
  'sealed_route_untranslatable',
  'sealed_pipe',
  'escalation_unrecorded',
]);

/** Reasons migration 063 returns with a 402. */
const BUDGET_CODES = new Set(['over_monthly_budget', 'over_kind_budget', 'budget_exhausted']);

/** Reasons migration 063 (and the IP limiter) return with a 429. */
const RATE_CODES = new Set(['over_rate_limit', 'rate_limited', 'usage_limit', 'meter_error']);

/**
 * Departure 1 from "the server's message wins": the 402 sentence in migration
 * 063 ends "— or upgrade your plan to continue now." There is no upgrade to
 * make. Pricing is undecided, there are no plan names, no prices and no
 * billing surface in the product, so that clause sends a person who has just
 * been stopped mid-sentence looking for a door that does not exist.
 *
 * Trimming it is not an invention: what is left is exactly the fallback
 * sentence lib/usage-meter.mjs writes when the RPC sends no message of its own
 * (usage-meter.mjs, sendUsageRefusal). When pricing is decided, delete this
 * function and the clause comes back on its own.
 */
export function withoutUpsell(text: string): string {
  const trimmed = text.replace(/\s*[—–-]\s*or upgrade[\s\S]*$/i, '');
  if (trimmed === text) return text;
  return `${trimmed.replace(/[\s—–-]+$/, '')}.`;
}

function tierViolationText(tier: LlmErrorBody['tier'], provider?: string): string {
  if (tier === 'C') return SILO;
  if (tier === 'B') {
    return (
      'This matter is sealed (SecureSpace Tier B), and ' +
      (provider ? `${provider} is` : 'the model this step asked for is') +
      ' outside the seal. Nothing was sent — a sealed matter is never handed to a provider ' +
      'outside the seal. Unseal the matter to use an ordinary model.'
    );
  }
  // Tier A still refuses one provider: the Moonshot sandbox, which is not
  // permitted on any matter-bound call (lib/ai-tier-policy.mjs).
  return (
    (provider ? `${provider} is ` : 'The model this step asked for is ') +
    'not permitted on a matter. Nothing was sent. Pick a different model and try again.'
  );
}

function sealedText(code: string | undefined, body: LlmErrorBody): string {
  switch (code) {
    case 'tier_violation': return tierViolationText(body.tier, body.provider);
    case 'sealed_pen_unavailable': return SEALED_UNAVAILABLE;
    case 'sealed_pen_error': return SEALED_ERROR;
    case 'sealed_route_untranslatable': return SEALED_UNTRANSLATABLE;
    default: return SEALED_PIPE;
  }
}

function seconds(n: number): string {
  return n === 1 ? '1 second' : `${n} seconds`;
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.ceil(n);
}

/**
 * Classify and phrase one refusal. Synchronous, because the body has usually
 * already been read — a Response body can only be read once, and callers like
 * structured.ts need the text for the success path too.
 *
 * `status` decides first and the code second: #163's harness returns
 * `budget_exhausted` where the deployed RPC returns `over_monthly_budget`, so
 * keying on the reason string alone would miss one of them. A sealed code wins
 * over the status, because the seal answers on 403, 502 and 503.
 */
export function parseRefusalBody(
  status: number,
  raw: unknown,
  retryAfterHeader?: string | null,
): ServerRefusal {
  const body = (raw && typeof raw === 'object' ? raw : {}) as LlmErrorBody;
  const code = typeof body.error === 'string' ? body.error : undefined;
  const serverMessage =
    typeof body.message === 'string' && body.message.trim() ? body.message.trim() : undefined;
  const retryAfterSeconds =
    positiveInt(body.retry_after_seconds) ?? positiveInt(retryAfterHeader);

  // The seal, on whichever status it arrived.
  if (code && SEALED_CODES.has(code)) {
    return { kind: 'sealed', message: serverMessage ?? sealedText(code, body), status, code };
  }

  // The wallet.
  if (status === 402 || (code && BUDGET_CODES.has(code))) {
    return {
      kind: 'budget',
      message: serverMessage ? withoutUpsell(serverMessage) : BUDGET_FALLBACK,
      status,
      code,
    };
  }

  // The rate window.
  if (status === 429 || (code && RATE_CODES.has(code))) {
    // Departure 2: when the server told us how long, say how long. Its own
    // sentence ("Give it a moment and try again") carries less than the
    // `retry_after_seconds` it sends in the next field, and a person deciding
    // whether to wait or to go and do something else needs the number.
    const message = retryAfterSeconds
      ? `Too many requests just now — try again in ${seconds(retryAfterSeconds)}.`
      : serverMessage ?? RATE_FALLBACK;
    return { kind: 'rate', message, status, code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
  }

  if (serverMessage) return { kind: 'other', message: serverMessage, status, code };

  switch (code) {
    case 'auth_required':
      return { kind: 'other', status, code, message: 'Your session has expired — sign in again and retry. Nothing was sent.' };
    case 'auth_not_configured':
      return { kind: 'other', status, code, message: 'This server is not configured to check who you are, so it refused the request. Nothing was sent.' };
    case 'matter_not_found':
      return { kind: 'other', status, code, message: 'That matter could not be found, so its confidentiality tier could not be checked. Nothing was sent.' };
    default: break;
  }

  // A provider's own error object ({ error: { message } }), then the raw
  // string, then the bare status.
  if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string') {
    return { kind: 'other', message: body.error.message, status, code };
  }
  if (code) return { kind: 'other', message: code, status, code };
  return { kind: 'other', message: `The server refused this step (${status}).`, status };
}

/**
 * The same thing for a caller that still holds an unread Response. Reads the
 * body once, tolerates a body that is empty or is not JSON, and never throws.
 */
export async function parseServerRefusal(res: Response): Promise<ServerRefusal> {
  let raw: unknown = null;
  try {
    const text = await res.text();
    if (text) raw = JSON.parse(text);
  } catch {
    /* no body, or not JSON — the status still classifies it */
  }
  return parseRefusalBody(res.status, raw, res.headers?.get?.('retry-after'));
}

/**
 * Plain-language text for a failed /api/llm call. `raw` is the parsed JSON
 * body, when there was one. Kept as the name generate/converse/structured
 * already call; the classification lives in parseRefusalBody.
 */
export function llmErrorText(status: number, raw: unknown, retryAfterHeader?: string | null): string {
  return parseRefusalBody(status, raw, retryAfterHeader).message;
}

/**
 * The refusal as an Error, for the callers that throw rather than report.
 *
 * It carries the kind, which is the thing a retry loop needs: a 5xx is worth
 * trying again, and a spent wallet, a full rate window or a sealed matter is
 * not. Without it every fallback in the app answers a refusal by making the
 * same refused request a second time — the Editor's second pen, cite-check's
 * per-citation rating — and turns one honest "no" into a page of them.
 *
 * It reads as an ordinary Error to anything that does not care: `.message` is
 * the sentence, so existing `err instanceof Error ? err.message` paths are
 * unchanged.
 */
export class ServerRefusalError extends Error {
  readonly refusal: ServerRefusal;
  constructor(refusal: ServerRefusal) {
    super(refusal.message);
    this.name = 'ServerRefusalError';
    this.refusal = refusal;
  }
}

/**
 * True when this error is a refusal that repeating will not cure — the wallet,
 * the rate window, or the seal. A plain provider error or a 5xx is not.
 */
export function isFinalRefusal(err: unknown): err is ServerRefusalError {
  return err instanceof ServerRefusalError && err.refusal.kind !== 'other';
}

/** Longest window worth sitting out. Beyond this, stop and tell the person. */
const MAX_WAIT_SECONDS = 120;

/**
 * A rate window is the one refusal that time alone fixes, and the server says
 * how much time. Bucketizer, cite-check and the Editor all run dozens of model
 * calls in a loop, and the free tier's window is twenty a minute — so without
 * this, the common outcome of a long run is that it dies a fifth of the way in
 * and the work is lost.
 *
 * Returns true when it has waited and the caller should try once more. False
 * for anything that waiting cannot fix: a spent wallet, a sealed matter, a
 * provider error, a window longer than two minutes, or an aborted run.
 */
export async function waitOutRateWindow(err: unknown, signal?: AbortSignal): Promise<boolean> {
  if (!(err instanceof ServerRefusalError)) return false;
  const { kind, retryAfterSeconds } = err.refusal;
  if (kind !== 'rate' || !retryAfterSeconds || retryAfterSeconds > MAX_WAIT_SECONDS) return false;
  if (signal?.aborted) return false;
  await new Promise<void>((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
  return !signal?.aborted;
}

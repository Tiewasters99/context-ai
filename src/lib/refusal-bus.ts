// One place a server's "no" becomes something the person can read.
//
// The refusals this carries come from the server, not from the browser: a 402
// when the month's AI budget is spent, a 429 when the rate window is full, a
// 403/502/503 when a SecureSpace refuses to let a matter leave the seal
// (migration 063 + PRs #159/#161/#163). Before 2026-09-20 most of those
// reached the user as raw JSON, as a machine code like `over_monthly_budget`,
// or as nothing at all — an upload that simply never finished.
//
// A DOM CustomEvent rather than a React context, for the same reason
// assistant-bus.ts is one: half the callers are plain modules with no
// component relationship to the shell (vault-persist.ts, sandbox-api.ts,
// student-hub-upload.ts, the Student Hub's voice pump). They call
// reportServerRefusal(res) and know nothing about where it is drawn.
//
// The banner draws whatever is current. There is exactly one slot — a new
// refusal replaces the old one, the way the Vault's own notice does — because
// two refusals stacked on a screen is the shape of the problem, not the fix.

import { parseServerRefusal, type RefusalKind, type ServerRefusal } from '@/lib/llm/refusals';

export const SERVER_REFUSAL_EVENT = 'cs:server-refusal';

/**
 * A refusal rarely arrives alone. The Student Hub's voice pump keeps two TTS
 * requests in flight per turn, OCR runs two workers over a batched book, a
 * cite-check loops once per citation. When the wallet closes, every one of
 * them gets the same 402 within the same second. One sentence is the news;
 * twenty is noise, and a banner that redraws twenty times is worse than
 * silence. So a refusal of the same kind inside this window is dropped.
 */
const COALESCE_MS = 10_000;

let current: ServerRefusal | null = null;
const lastShownAt = new Map<RefusalKind, number>();

function announce(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SERVER_REFUSAL_EVENT));
}

/** Show a refusal that has already been parsed. Returns what it did. */
export function showServerRefusal(refusal: ServerRefusal): 'shown' | 'coalesced' {
  const now = Date.now();
  const previous = lastShownAt.get(refusal.kind) ?? 0;
  if (current && now - previous < COALESCE_MS) return 'coalesced';
  lastShownAt.set(refusal.kind, now);
  current = refusal;
  announce();
  return 'shown';
}

/**
 * Read a refused Response and show it. The body is consumed here, so call it
 * only on a response the caller is not going to read itself.
 */
export async function reportServerRefusal(res: Response): Promise<ServerRefusal> {
  const refusal = await parseServerRefusal(res);
  showServerRefusal(refusal);
  return refusal;
}

export function dismissServerRefusal(): void {
  if (!current) return;
  current = null;
  announce();
}

/** For useSyncExternalStore — stable between changes, so React can compare. */
export function currentServerRefusal(): ServerRefusal | null {
  return current;
}

export function subscribeServerRefusal(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(SERVER_REFUSAL_EVENT, onChange);
  return () => window.removeEventListener(SERVER_REFUSAL_EVENT, onChange);
}

/** Forget everything, including the coalescing window. Nothing calls this in
 *  the app today; it is here for a test, and for a sign-out path if one ever
 *  wants to clear the shell. */
export function resetServerRefusals(): void {
  current = null;
  lastShownAt.clear();
  announce();
}

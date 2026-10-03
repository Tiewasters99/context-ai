// "Connect an agent to this matter" (the matter's Share dialog) hands the
// consent screen a hint: the OAuth flow starts in Grok (or ChatGPT, or
// Claude), not here, so the only thing that can carry "this matter" across is
// the browser itself. The Share dialog writes { matterId, provider, at } to
// localStorage; OAuthAuthorize reads it, and if it is fresh and fits the
// client asking, starts on "An agent" with that matter ticked.
//
// It is a convenience, never a grant. The person still sees the matter ticked
// and presses Connect themselves, the server re-checks every matter the
// consent POST names, and nothing server-side ever reads this key. Same
// browser only: a phone that opens the sign-in page sees no hint.
//
// Also here: which way the consent screen starts (Gap 4). Pure functions, no
// imports, so a node harness can drive them directly.

export type HintProvider = 'grok' | 'chatgpt' | 'claude' | 'gemini' | 'other';

export interface PendingAgentConnect {
  matterId: string;
  provider: HintProvider;
  /** Date.now() when it was written. */
  at: number;
}

export const PENDING_AGENT_CONNECT_KEY = 'cs.pendingAgentConnect';
/** A hint older than this is ignored and cleared. */
export const PENDING_AGENT_CONNECT_TTL_MS = 30 * 60 * 1000;

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): KV | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // storage blocked (private window, site data off)
  }
}

const PROVIDERS: readonly HintProvider[] = ['grok', 'chatgpt', 'claude', 'gemini', 'other'];

export function writePendingAgentConnect(
  hint: { matterId: string; provider: HintProvider },
  now = Date.now(),
  store: KV | null = defaultStore(),
): void {
  try {
    store?.setItem(PENDING_AGENT_CONNECT_KEY, JSON.stringify({ ...hint, at: now }));
  } catch {
    /* a hint only */
  }
}

export function clearPendingAgentConnect(store: KV | null = defaultStore()): void {
  try {
    store?.removeItem(PENDING_AGENT_CONNECT_KEY);
  } catch {
    /* a hint only */
  }
}

/**
 * The hint, if there is one written in the last 30 minutes. A stale or
 * malformed one is cleared and answers null.
 */
export function readPendingAgentConnect(
  now = Date.now(),
  store: KV | null = defaultStore(),
): PendingAgentConnect | null {
  let raw: string | null = null;
  try {
    raw = store?.getItem(PENDING_AGENT_CONNECT_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  let h: Partial<PendingAgentConnect> | null = null;
  try {
    h = JSON.parse(raw) as Partial<PendingAgentConnect>;
  } catch {
    h = null;
  }
  const fresh =
    !!h &&
    typeof h.matterId === 'string' && h.matterId.length > 0 &&
    typeof h.at === 'number' &&
    now - h.at >= 0 && now - h.at <= PENDING_AGENT_CONNECT_TTL_MS &&
    PROVIDERS.includes(h.provider as HintProvider);
  if (!fresh) {
    clearPendingAgentConnect(store);
    return null;
  }
  return { matterId: h!.matterId!, provider: h!.provider as HintProvider, at: h!.at! };
}

/** Best guess at the provider from the name the client registered under. */
export function guessAgentProvider(clientName: string): HintProvider {
  const n = clientName || '';
  if (/grok|xai|x\.ai/i.test(n)) return 'grok';
  if (/chatgpt|openai|\bgpt\b/i.test(n)) return 'chatgpt';
  if (/claude|anthropic/i.test(n)) return 'claude';
  if (/gemini|antigravity|google/i.test(n)) return 'gemini';
  return 'other';
}

/**
 * Whether a hint was meant for this client. A Grok hint written ten minutes
 * ago must not turn a Claude sign-in into an agent, so the providers have to
 * agree; 'other' on either side (a client whose name says nothing) is let
 * through.
 */
export function hintFitsClient(hint: PendingAgentConnect | null, clientName: string): boolean {
  if (!hint) return false;
  const guessed = guessAgentProvider(clientName);
  return hint.provider === guessed || hint.provider === 'other' || guessed === 'other';
}

/**
 * Which way the consent screen starts, before any existing agent is read:
 *   * Grok → "An agent". Grok's connection is account-wide and Grok Bots act
 *     unattended, so the scoped choice is the safe one.
 *   * A fitting hint from a matter's "Connect an agent" → "An agent".
 *   * Everything else (Claude, ChatGPT, …) → "A full assistant", as before.
 * A client already linked to an agent is switched to "An agent" afterwards,
 * when that agent has been read.
 */
export function defaultConnectAs(input: {
  clientName: string;
  hint: PendingAgentConnect | null;
}): 'assistant' | 'agent' {
  if (guessAgentProvider(input.clientName) === 'grok') return 'agent';
  if (hintFitsClient(input.hint, input.clientName)) return 'agent';
  return 'assistant';
}

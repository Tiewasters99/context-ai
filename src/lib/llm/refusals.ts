// What a refused model call says to the person who made it.
//
// /api/llm answers a refusal with a machine code — `tier_violation`,
// `sealed_pen_unavailable`, `sealed_pen_error`, `sealed_route_untranslatable`.
// Until 2026-09-19 the Vault, Bucketizer, cite-check, the Editor and Moot
// Bench rendered that code verbatim: a lawyer who sealed a matter and pressed
// Classify read the words "tier_violation" and had no idea whether their
// client's file had just been sent somewhere.
//
// The voice here is the one the Assistant and the content pipes already use
// (lib/assistant-core.mjs, lib/seal-pipes.mjs): name the step, say whether
// anything was sent, say what would unblock it. Nothing here claims the
// sealed pen is as good as the model the feature was tuned on — it isn't, and
// saying so is the feature's job, not the error's.
//
// The server is the authority: when it sends a `message`, that message is
// shown as written. These strings are the fallback for a server that predates
// this PR, or for a code that carries no copy.

export interface LlmErrorBody {
  error?: string | { message?: string };
  message?: string;
  tier?: 'A' | 'B' | 'C' | null;
  provider?: string;
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

/**
 * Plain-language text for a failed /api/llm call. `raw` is the parsed JSON
 * body, when there was one.
 */
export function llmErrorText(status: number, raw: unknown): string {
  const body = (raw && typeof raw === 'object' ? raw : {}) as LlmErrorBody;

  // A message written by the server wins: it is the authority on what it did.
  if (typeof body.message === 'string' && body.message.trim()) return body.message;

  const code = typeof body.error === 'string' ? body.error : undefined;
  switch (code) {
    case 'tier_violation': return tierViolationText(body.tier, body.provider);
    case 'sealed_pen_unavailable': return SEALED_UNAVAILABLE;
    case 'sealed_pen_error': return SEALED_ERROR;
    case 'sealed_route_untranslatable': return SEALED_UNTRANSLATABLE;
    case 'auth_required': return 'Your session has expired — sign in again and retry. Nothing was sent.';
    case 'auth_not_configured': return 'This server is not configured to check who you are, so it refused the request. Nothing was sent.';
    case 'matter_not_found': return 'That matter could not be found, so its confidentiality tier could not be checked. Nothing was sent.';
    default: break;
  }

  // A provider's own error object ({ error: { message } }), then the raw
  // string, then the bare status.
  if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string') return body.error.message;
  if (code) return code;
  return `API error (${status})`;
}

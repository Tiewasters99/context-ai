// Creating a connector token — the one door (migration 098).
//
// A csp_ token is a standing password for an outside app, and the sealed-
// matter step-up (094) does not see the requests made with it. So the
// database no longer takes a token row straight from the browser: it takes
// it through connector_token_create(), which asks a person who has a second
// factor to confirm it in this session first. When they have not, the call
// fails with `step_up_required`; the page shows the factor prompt in place
// and, once confirmed, creates the token.
//
// The plaintext is still generated here and never leaves the browser except
// to be shown once: the RPC receives the hash and the display prefix, exactly
// the two things the direct insert sent.
//
// Before 098 is pasted the RPC does not exist (PGRST202); the direct insert
// is then used, as it was, so deploying this code first changes nothing.
// After it is pasted the direct insert is refused, so there is no fallback
// in that direction to leave open.

import { supabase } from '@/lib/supabase';
import { generateConnectorToken } from '@/lib/connectorTokens';

export class StepUpRequiredError extends Error {
  readonly code = 'step_up_required';
  constructor() {
    super('Confirm your second factor to create a connection.');
    this.name = 'StepUpRequiredError';
  }
}

type PgError = { code?: string; message?: string; hint?: string } | null | undefined;

/** The database said "confirm your second factor first". */
export function isStepUpRequired(err: unknown): boolean {
  if (err instanceof StepUpRequiredError) return true;
  const e = err as PgError;
  return Boolean(e) && /step_up_required/.test(`${e?.message ?? ''} ${e?.hint ?? ''}`);
}

const rpcMissing = (e: PgError) =>
  Boolean(e) && (e!.code === 'PGRST202' || /could not find the function|schema cache/i.test(e!.message ?? ''));

export interface TokenRowInput {
  tokenHash: string;
  tokenPrefix: string;
  name: string;
  kind?: 'user' | 'agent';
  agentProvider?: string | null;
  matterScope?: string[];
  scopeAll?: boolean;
}

/**
 * Writes the row through connector_token_create. `legacyRow` is the direct
 * insert the caller made before 098, used only while the RPC does not exist.
 * Throws StepUpRequiredError when the database wants the second factor;
 * returns any other database error for the caller to word.
 */
export async function createTokenRow(
  input: TokenRowInput,
  legacyRow: Record<string, unknown>,
): Promise<{ code?: string; message: string } | null> {
  const kind = input.kind ?? 'user';
  const all = kind === 'agent' && input.scopeAll === true;
  const { error } = await supabase.rpc('connector_token_create', {
    p_token_hash: input.tokenHash,
    p_token_prefix: input.tokenPrefix,
    p_name: input.name.trim(),
    p_kind: kind,
    p_agent_provider: kind === 'agent' ? input.agentProvider ?? null : null,
    p_matter_scope: kind === 'agent' && !all ? input.matterScope ?? [] : [],
    p_scope_all: all,
  });
  if (!error) return null;
  if (isStepUpRequired(error)) throw new StepUpRequiredError();
  if (!rpcMissing(error)) return error;
  // Pre-098 database: the insert the pages made before this file existed.
  const { error: insertErr } = await supabase.from('connector_tokens').insert(legacyRow);
  return insertErr ?? null;
}

/**
 * A full-access token for the Connect pages (Claude, ChatGPT, Gemini, Grok).
 * Returns the plaintext, which the page shows once.
 */
export async function createUserConnectorToken(userId: string, name: string): Promise<{ token: string }> {
  const { token, tokenHash, tokenPrefix } = await generateConnectorToken();
  const error = await createTokenRow(
    { tokenHash, tokenPrefix, name },
    { user_id: userId, token_hash: tokenHash, token_prefix: tokenPrefix, name: name.trim() },
  );
  if (error) throw error;
  return { token };
}

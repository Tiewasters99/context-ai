// Agent tokens (spec A3): a connector token of kind 'agent', which sees only
// the matters in its matter_scope (each grant covering the matters beneath
// it) and never a sealed matter. Generated exactly as the full-access tokens
// on the Claude / Gemini / Grok pages are — in the browser, stored as a hash
// — and then inserted with kind='agent', agent_provider and matter_scope.
//
// The existing token pages and their queries are untouched: a user token is
// still a row with the default kind 'user'.
//
// Before migration 085 the kind / agent_provider / matter_scope columns do
// not exist; every helper here turns that into AgentsNotReadyError.

import { supabase } from '@/lib/supabase';
import { generateConnectorToken } from '@/lib/connectorTokens';
import { raise } from '@/lib/agentTasks';

export type AgentProvider = 'grok' | 'chatgpt' | 'claude' | 'gemini' | 'other';

export const AGENT_PROVIDERS: { value: AgentProvider; label: string }[] = [
  { value: 'grok', label: 'Grok' },
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'other', label: 'Other' },
];

export function providerLabel(p: string | null | undefined): string {
  return AGENT_PROVIDERS.find((x) => x.value === p)?.label ?? 'Other';
}

export interface AgentToken {
  id: string;
  name: string | null;
  token_prefix: string;
  agent_provider: AgentProvider | null;
  matter_scope: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

/** "Grok Bot — Discovery" style label for pickers and the log. */
export function agentLabel(a: Pick<AgentToken, 'name' | 'agent_provider'>): string {
  const name = (a.name ?? '').trim();
  return name || `${providerLabel(a.agent_provider)} agent`;
}

/** Live agent tokens (not revoked, not expired), newest first. */
export async function listAgentTokens(): Promise<AgentToken[]> {
  const { data, error } = await supabase
    .from('connector_tokens')
    .select('id, name, token_prefix, agent_provider, matter_scope, created_at, last_used_at, expires_at, revoked_at')
    .eq('kind', 'agent')
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) raise(error, 'Could not read your agents.');
  const now = Date.now();
  return ((data ?? []) as (AgentToken & { revoked_at: string | null })[])
    .filter((t) => !t.expires_at || new Date(t.expires_at).getTime() > now)
    .map((t) => ({ ...t, matter_scope: Array.isArray(t.matter_scope) ? t.matter_scope : [] }));
}

/**
 * Issues a new agent token. Returns the plaintext ONCE; only its hash is
 * stored. `scope` should already be normalised (see agent-scope.ts).
 */
export async function createAgentToken(input: {
  userId: string;
  name: string;
  provider: AgentProvider;
  scope: string[];
}): Promise<{ token: string }> {
  const { token, tokenHash, tokenPrefix } = await generateConnectorToken();
  const { error } = await supabase.from('connector_tokens').insert({
    user_id: input.userId,
    token_hash: tokenHash,
    token_prefix: tokenPrefix,
    name: input.name.trim(),
    kind: 'agent',
    agent_provider: input.provider,
    matter_scope: input.scope,
  });
  if (error) raise(error, 'Could not create the agent.');
  return { token };
}

export async function updateAgentScope(id: string, scope: string[]): Promise<void> {
  const { error } = await supabase
    .from('connector_tokens')
    .update({ matter_scope: scope })
    .eq('id', id)
    .eq('kind', 'agent');
  if (error) raise(error, 'Could not save the matters.');
}

/** Revoking sets revoked_at; the row stays so the task history survives. */
export async function revokeAgentToken(id: string): Promise<void> {
  const { error } = await supabase
    .from('connector_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('kind', 'agent');
  if (error) raise(error, 'Could not revoke the agent.');
}

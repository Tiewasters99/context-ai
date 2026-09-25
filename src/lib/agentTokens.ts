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
  revoked_at: string | null;
}

/** "Grok Bot — Discovery" style label for pickers and the log. */
export function agentLabel(a: Pick<AgentToken, 'name' | 'agent_provider'>): string {
  const name = (a.name ?? '').trim();
  return name || `${providerLabel(a.agent_provider)} agent`;
}

/** A token that still authenticates: not revoked, not expired. */
export function isLiveAgent(t: Pick<AgentToken, 'revoked_at' | 'expires_at'>, now = Date.now()): boolean {
  return !t.revoked_at && (!t.expires_at || new Date(t.expires_at).getTime() > now);
}

/**
 * Every agent token this account owns, revoked ones included, newest first.
 * connector_tokens RLS returns only the caller's own rows, so this is also
 * the answer to "is this task's agent mine?" (a revoked agent is still
 * mine, and its history still names it). Filter with isLiveAgent for
 * anything that hands out work.
 */
export async function listAgentTokens(): Promise<AgentToken[]> {
  const { data, error } = await supabase
    .from('connector_tokens')
    .select('id, name, token_prefix, agent_provider, matter_scope, created_at, last_used_at, expires_at, revoked_at')
    .eq('kind', 'agent')
    .order('created_at', { ascending: false });
  if (error) raise(error, 'Could not read your agents.');
  return ((data ?? []) as AgentToken[])
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

// ── Agents connected by OAuth sign-in (migration 087) ────────────────

/**
 * An agent made on the OAuth consent screen ("Connect as an agent") rather
 * than here. Its row holds no usable secret — the server stored the hash of
 * random bytes nobody kept — so there is never a token to show or copy; the
 * connection lives in its oauth_grants row. token_prefix 'oauth' marks it.
 */
export function isOauthAgent(t: Pick<AgentToken, 'token_prefix'>): boolean {
  return t.token_prefix === 'oauth';
}

export interface OauthAgentLink {
  grantId: string;
  agentTokenId: string;
  clientName: string;
}

/**
 * The live OAuth grants that are agent connections, keyed by agent token id.
 * `select('*')` on purpose: before 087 the agent_token_id column does not
 * exist, and naming it would fail the whole read. With '*' a pre-087 row
 * simply has no link, which is the truth (no agent grant can exist then).
 * Any error answers an empty map: this is a label, not a permission.
 */
export async function listOauthAgentLinks(): Promise<Map<string, OauthAgentLink>> {
  const out = new Map<string, OauthAgentLink>();
  try {
    const { data, error } = await supabase.from('oauth_grants').select('*').is('revoked_at', null);
    if (error || !data) return out;
    for (const g of data as Array<Record<string, unknown>>) {
      const agentId = typeof g.agent_token_id === 'string' ? g.agent_token_id : null;
      if (!agentId) continue;
      out.set(agentId, {
        grantId: String(g.id),
        agentTokenId: agentId,
        clientName: typeof g.client_name === 'string' ? g.client_name : 'an AI client',
      });
    }
  } catch {
    /* a label only */
  }
  return out;
}

/** Agent names for display (Approved AI clients: "connected as agent X"). */
export async function agentNamesById(ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!ids.length) return out;
  const { data } = await supabase.from('connector_tokens').select('id, name').in('id', ids);
  for (const a of (data ?? []) as Array<{ id: string; name: string | null }>) out.set(a.id, a.name);
  return out;
}

/** Ends the sign-in behind an OAuth agent (revokes its grant). */
export async function revokeOauthGrant(grantId: string): Promise<void> {
  const { error } = await supabase
    .from('oauth_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', grantId);
  if (error) raise(error, 'Could not end the sign-in.');
}

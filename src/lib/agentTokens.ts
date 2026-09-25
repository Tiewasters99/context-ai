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
  /**
   * Migration 088: "All my matters (except SecureSpaces)" — every matter
   * the user can see, now or later, except a sealed one. matter_scope is
   * ignored while true. False on a database without 088.
   */
  scope_all: boolean;
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

const AGENT_COLUMNS = 'id, name, token_prefix, agent_provider, matter_scope, created_at, last_used_at, expires_at, revoked_at';

/**
 * A read that named scope_all and failed for that reason: 42703 (the column
 * does not exist — 088 not applied) or 42501 (it exists but its column
 * SELECT grant is gone — 086 pasted again after 088). Either way the read is
 * retried without it.
 */
function isScopeAllUnreadable(err: { code?: string } | null | undefined): boolean {
  return err?.code === '42703' || err?.code === '42501';
}

/**
 * Every agent token this account owns, revoked ones included, newest first.
 * connector_tokens RLS returns only the caller's own rows, so this is also
 * the answer to "is this task's agent mine?" (a revoked agent is still
 * mine, and its history still names it). Filter with isLiveAgent for
 * anything that hands out work.
 */
export async function listAgentTokens(): Promise<AgentToken[]> {
  const read = (columns: string) => supabase
    .from('connector_tokens')
    .select(columns)
    .eq('kind', 'agent')
    .order('created_at', { ascending: false });
  // scope_all is named (086 forbids '*' here). Before 088 it does not exist
  // and naming it fails, which must not take the whole Agents list down:
  // read again without it — every agent is then a listed one, which is the
  // truth on such a database. A failure of the second read (no `kind`, i.e.
  // 085 missing) still becomes the 085 sentence through raise().
  let { data, error } = await read(`${AGENT_COLUMNS}, scope_all`);
  if (error && isScopeAllUnreadable(error)) ({ data, error } = await read(AGENT_COLUMNS));
  if (error) raise(error, 'Could not read your agents.');
  return ((data ?? []) as unknown as AgentToken[])
    .map((t) => ({
      ...t,
      matter_scope: Array.isArray(t.matter_scope) ? t.matter_scope : [],
      scope_all: t.scope_all === true,
    }));
}

/**
 * One agent row for the OAuth consent screen's prefill, scope_all included
 * when the database has it (088), without it when it does not.
 */
export async function readAgentForConsent(id: string): Promise<{
  id: string; name: string | null; agent_provider: string | null;
  matter_scope: string[]; scope_all: boolean; revoked_at: string | null;
} | null> {
  const base = 'id, name, agent_provider, matter_scope, revoked_at';
  const read = (columns: string) => supabase.from('connector_tokens').select(columns).eq('id', id).maybeSingle();
  let { data, error } = await read(`${base}, scope_all`);
  if (error && isScopeAllUnreadable(error)) ({ data, error } = await read(base));
  if (error || !data) return null;
  const a = data as unknown as Record<string, unknown>;
  return {
    id: String(a.id),
    name: typeof a.name === 'string' ? a.name : null,
    agent_provider: typeof a.agent_provider === 'string' ? a.agent_provider : null,
    matter_scope: Array.isArray(a.matter_scope) ? (a.matter_scope as string[]) : [],
    scope_all: a.scope_all === true,
    revoked_at: typeof a.revoked_at === 'string' ? a.revoked_at : null,
  };
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
  /** 088: "All my matters (except SecureSpaces)". */
  scopeAll?: boolean;
}): Promise<{ token: string }> {
  const { token, tokenHash, tokenPrefix } = await generateConnectorToken();
  const all = input.scopeAll === true;
  const { error } = await supabase.from('connector_tokens').insert({
    user_id: input.userId,
    token_hash: tokenHash,
    token_prefix: tokenPrefix,
    name: input.name.trim(),
    kind: 'agent',
    agent_provider: input.provider,
    matter_scope: all ? [] : input.scope,
    // Named only when true: a database without 088 then still takes a
    // listed agent, and refuses an "all" one rather than widening anything.
    ...(all ? { scope_all: true } : {}),
  });
  if (error) {
    if (all) throwIfScopeAllMissing(error);
    raise(error, 'Could not create the agent.');
  }
  return { token };
}

/**
 * Saves what an agent may see. `scopeAll` is sent only when it is, or was,
 * true (`wasAll`): turning "all" off must write false, and a database
 * without 088 never sees the column named for an ordinary listed save.
 */
export async function updateAgentScope(
  id: string,
  scope: string[],
  opts: { scopeAll?: boolean; wasAll?: boolean } = {},
): Promise<void> {
  const all = opts.scopeAll === true;
  const patch: Record<string, unknown> = { matter_scope: all ? [] : scope };
  if (all || opts.wasAll === true) patch.scope_all = all;
  const { error } = await supabase
    .from('connector_tokens')
    .update(patch)
    .eq('id', id)
    .eq('kind', 'agent');
  if (error) {
    if ('scope_all' in patch) throwIfScopeAllMissing(error);
    raise(error, 'Could not save the matters.');
  }
}

/**
 * The column-missing failure of an "all" write reads as its own sentence,
 * not as "run migration 085" (085 is there; 088 is not).
 */
export const SCOPE_ALL_NOT_READY =
  '"All my matters" is not switched on yet on this server. Tick the matters instead.';
function throwIfScopeAllMissing(err: { code?: string; message?: string }): void {
  if (/scope_all/.test(err.message ?? '')) throw new Error(SCOPE_ALL_NOT_READY);
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

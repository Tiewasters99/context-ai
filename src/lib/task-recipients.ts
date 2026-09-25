// Who a task can be handed to (migration 089): every AI connected to this
// account, not only agents.
//
//   agent  a connector_tokens row of kind 'agent' (a pasted token, or an
//          OAuth sign-in linked to it on the consent screen). Sees only its
//          matters; it polls for work.
//   token  a full-access connector token (kind 'user'): Claude Desktop, the
//          Gemini CLI, anything given a pasted csp_ token.
//   grant  a full-assistant OAuth sign-in (oauth_grants with no agent link):
//          Claude, ChatGPT, Grok connected "as a full assistant".
//
// Tokens and grants are chat assistants: they see what their user sees,
// except SecureSpaces, and they pick a task up only when their user asks
// them to check. A task names its recipient by assigned_token_id (agent or
// token) or assigned_grant_id (grant).
//
// Pure, no '@/' imports, so a node harness can drive it directly.

import { agentCoversMatter, isEffectivelySealed, type ScopeMatter } from './agent-scope.ts';

export type RecipientKind = 'agent' | 'token' | 'grant';
export type RecipientGroup = 'agents' | 'assistants';

/** What agent_tasks stores: which column, which id. */
export interface RecipientRef {
  kind: 'token' | 'grant';
  id: string;
}

export interface TaskRecipient {
  /** 'token:<id>' or 'grant:<id>' — the same key a task's columns give. */
  key: string;
  kind: RecipientKind;
  id: string;
  /** The name the person sees: the agent's name, the token's name, the client's name. */
  name: string;
  /** Claude, ChatGPT, Gemini, Grok, or the name the client gave itself. */
  provider: string;
  /** How it is connected, in words. */
  how: string;
  group: RecipientGroup;
  lastUsed: string | null;
  createdAt: string | null;
  /** Still connected: not revoked, not expired. */
  live: boolean;
  /** Agents only. */
  matterScope?: string[];
  scopeAll?: boolean;
  /** An agent made on the OAuth consent screen (no pasted token). */
  bySignIn?: boolean;
}

/** The Agents page: where every task lives (surface 'agentTasks'). */
export const AGENTS_PAGE_PATH = '/app/agent-tasks';
export const OPEN_IN_AGENTS = 'Open in Agents →';

export const GROUP_LABEL: Record<RecipientGroup, string> = {
  agents: 'Agents',
  assistants: 'Assistants you chat with',
};

export const CHAT_ASSISTANT_NOTE = 'Waits until you ask it to check its tasks.';

export const HOW_LABEL: Record<RecipientKind, string> = {
  agent: 'Agent',
  token: 'Full assistant (token)',
  grant: 'Full assistant (sign-in)',
};

const PROVIDER_LABEL: Record<string, string> = {
  grok: 'Grok', chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', other: 'Other',
};

// An AI client names itself, so the provider is guessed from that name; one
// that matches nothing is shown under its own name.
const CLIENT_MATCHERS: { name: string; test: RegExp }[] = [
  { name: 'Claude', test: /claude|anthropic/i },
  { name: 'ChatGPT', test: /chatgpt|openai|\bgpt\b/i },
  { name: 'Gemini', test: /gemini|antigravity|google/i },
  { name: 'Grok', test: /grok|xai|x\.ai/i },
];

export function providerForClient(name: string | null | undefined): string | null {
  return CLIENT_MATCHERS.find((m) => m.test.test(name || ''))?.name ?? null;
}

export function recipientKey(ref: RecipientRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function refOf(r: Pick<TaskRecipient, 'kind' | 'id'>): RecipientRef {
  return { kind: r.kind === 'grant' ? 'grant' : 'token', id: r.id };
}

/** The recipient a task row names, or null for a malformed row. */
export function taskRecipientRef(t: {
  assigned_token_id?: string | null;
  assigned_grant_id?: string | null;
}): RecipientRef | null {
  if (t.assigned_grant_id) return { kind: 'grant', id: t.assigned_grant_id };
  if (t.assigned_token_id) return { kind: 'token', id: t.assigned_token_id };
  return null;
}

function isLive(revokedAt: string | null | undefined, expiresAt: string | null | undefined, now: number): boolean {
  return !revokedAt && (!expiresAt || new Date(expiresAt).getTime() > now);
}

export interface AgentRow {
  id: string;
  name: string | null;
  token_prefix?: string | null;
  agent_provider: string | null;
  matter_scope: string[] | null;
  scope_all?: boolean | null;
  created_at?: string | null;
  last_used_at: string | null;
  expires_at?: string | null;
  revoked_at: string | null;
}

export interface UserTokenRow {
  id: string;
  name: string | null;
  created_at?: string | null;
  last_used_at: string | null;
  expires_at?: string | null;
  revoked_at: string | null;
}

export interface GrantRow {
  id: string;
  client_name: string | null;
  created_at?: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  /** 087: set when this sign-in IS an agent — then the agent row stands for it. */
  agent_token_id?: string | null;
}

/**
 * Every connection this account owns, revoked ones included (so an old task
 * can still name who it went to). Filter on `live` for anything that hands
 * out work. An agent-linked grant is left out: its agent row is the recipient.
 */
export function buildRecipients(input: {
  agents: readonly AgentRow[];
  userTokens: readonly UserTokenRow[];
  grants: readonly GrantRow[];
  now?: number;
}): TaskRecipient[] {
  const now = input.now ?? Date.now();
  const out: TaskRecipient[] = [];
  for (const a of input.agents) {
    const provider = PROVIDER_LABEL[a.agent_provider ?? ''] ?? 'Other';
    const bySignIn = a.token_prefix === 'oauth';
    out.push({
      key: recipientKey({ kind: 'token', id: a.id }),
      kind: 'agent',
      id: a.id,
      name: (a.name ?? '').trim() || `${provider} agent`,
      provider,
      how: bySignIn ? 'Agent (sign-in)' : HOW_LABEL.agent,
      group: 'agents',
      lastUsed: a.last_used_at ?? null,
      createdAt: a.created_at ?? null,
      live: isLive(a.revoked_at, a.expires_at, now),
      matterScope: Array.isArray(a.matter_scope) ? a.matter_scope : [],
      scopeAll: a.scope_all === true,
      bySignIn,
    });
  }
  for (const t of input.userTokens) {
    const name = (t.name ?? '').trim();
    out.push({
      key: recipientKey({ kind: 'token', id: t.id }),
      kind: 'token',
      id: t.id,
      name: name || 'Full-access token',
      provider: providerForClient(name) ?? 'Token',
      how: HOW_LABEL.token,
      group: 'assistants',
      lastUsed: t.last_used_at ?? null,
      createdAt: t.created_at ?? null,
      live: isLive(t.revoked_at, t.expires_at, now),
    });
  }
  for (const g of input.grants) {
    if (g.agent_token_id) continue;
    const name = (g.client_name ?? '').trim() || 'An AI client';
    out.push({
      key: recipientKey({ kind: 'grant', id: g.id }),
      kind: 'grant',
      id: g.id,
      name,
      provider: providerForClient(name) ?? name,
      how: HOW_LABEL.grant,
      group: 'assistants',
      lastUsed: g.last_used_at ?? null,
      createdAt: g.created_at ?? null,
      live: !g.revoked_at,
    });
  }
  return out;
}

/** "Claude" / "Grok bot (Grok)" — the label a picker shows. */
export function recipientLabel(r: Pick<TaskRecipient, 'name' | 'provider'>): string {
  return r.name === r.provider || r.provider === 'Token' || r.provider === 'Other'
    ? r.name
    : `${r.name} (${r.provider})`;
}

/**
 * Who can take a task in this matter: live agents whose scope covers it, and
 * every live chat assistant — unless the matter is sealed, which hides it
 * from every connector, so then nobody.
 */
export function recipientsForMatter(
  matters: readonly ScopeMatter[],
  recipients: readonly TaskRecipient[],
  matterId: string | null | undefined,
): { agents: TaskRecipient[]; assistants: TaskRecipient[]; sealed: boolean } {
  if (!matterId) return { agents: [], assistants: [], sealed: false };
  const sealed = isEffectivelySealed(matters, matterId);
  if (sealed) return { agents: [], assistants: [], sealed: true };
  const live = recipients.filter((r) => r.live);
  return {
    agents: live.filter((r) => r.kind === 'agent'
      && agentCoversMatter(matters, { matter_scope: r.matterScope ?? [], scope_all: r.scopeAll === true }, matterId)),
    assistants: live.filter((r) => r.kind !== 'agent'),
    sealed: false,
  };
}

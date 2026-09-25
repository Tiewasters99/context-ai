// "Connect as an agent" on the OAuth consent screen (migration 087): the
// server-side half of the consent POST.
//
// The consent page sends { connect_as: 'agent', agent: { name, provider,
// matter_scope } } next to the OAuth params. Nothing the browser sends is
// trusted: every matter id must be one the signed-in user can open (checked
// through the user's OWN session, so RLS answers), and none may be in a
// SecureSpace, its own tier or inherited from any ancestor (checked with the
// service role, so an ancestor the user cannot see still counts). The rule
// is the Agents section's: a sealed matter can never be granted. /api/mcp
// enforces the seal again on every call regardless.
//
// Pure where it can be, so the offline harness drives it directly.

import { createHash, randomBytes } from 'node:crypto';

export const AGENT_PROVIDERS = ['grok', 'chatgpt', 'claude', 'gemini', 'other'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MATTERS = 500;
const MAX_NAME = 120;

export class AgentConsentError extends Error {
  constructor(status, code, detail) {
    super(detail);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Best guess at the provider from the name the client registered under. */
export function guessAgentProvider(clientName) {
  const n = String(clientName || '');
  if (/grok|xai|x\.ai/i.test(n)) return 'grok';
  if (/chatgpt|openai|\bgpt\b/i.test(n)) return 'chatgpt';
  if (/claude|anthropic/i.test(n)) return 'claude';
  if (/gemini|antigravity|google/i.test(n)) return 'gemini';
  return 'other';
}

/**
 * Which choice the consent POST made. Anything but an explicit 'agent' is
 * the full-assistant connection, today's behaviour.
 *
 * `agent.scope_all === true` (migration 088) is "All my matters (except
 * SecureSpaces)": it needs no matter ids, and any sent with it are ignored
 * (the agent's matter_scope is stored as '{}'). Only a literal true counts.
 * @returns {null | { name:string, provider:string, matterIds:string[], scopeAll:boolean }}
 */
export function parseAgentConsent(body, clientName) {
  if (body?.connect_as !== 'agent') return null;
  const a = body.agent && typeof body.agent === 'object' ? body.agent : {};
  const scopeAll = a.scope_all === true;
  const rawIds = scopeAll ? [] : a.matter_scope ?? [];
  if (!Array.isArray(rawIds)) throw new AgentConsentError(400, 'invalid_scope', 'matter_scope must be a list of matter ids.');
  if (rawIds.length > MAX_MATTERS) throw new AgentConsentError(400, 'invalid_scope', `At most ${MAX_MATTERS} matters.`);
  const ids = [];
  for (const id of rawIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new AgentConsentError(400, 'invalid_scope', 'matter_scope contains something that is not a matter id.');
    }
    const lower = id.toLowerCase();
    if (!ids.includes(lower)) ids.push(lower);
  }
  const name = String(a.name ?? '').trim().slice(0, MAX_NAME) || String(clientName || '').trim().slice(0, MAX_NAME) || 'Agent';
  const provider = AGENT_PROVIDERS.includes(a.provider) ? a.provider : guessAgentProvider(clientName);
  return { name, provider, matterIds: ids, scopeAll };
}

/**
 * Refuses the whole consent if any id is not a matter the user can open, or
 * is sealed. All or nothing: a grant that silently dropped a ticked matter
 * would not be the grant the user read on the screen.
 *
 * @param {string[]} ids
 * @param {{ visibleIds: (ids:string[]) => Promise<Set<string>>,
 *           tierOf: (id:string) => Promise<'A'|'B'|'C'|null> }} io
 */
export async function checkAgentScope(ids, { visibleIds, tierOf }) {
  if (ids.length === 0) return [];
  let visible;
  try {
    visible = await visibleIds(ids);
  } catch {
    throw new AgentConsentError(503, 'scope_unverifiable', 'Could not check those matters just now, so nothing was granted. Try again.');
  }
  if (ids.some((id) => !visible.has(id))) {
    throw new AgentConsentError(403, 'matter_not_accessible',
      'One of the ticked matters is not one your account can open. Nothing was granted.');
  }
  for (const id of ids) {
    let tier;
    try {
      tier = await tierOf(id);
    } catch {
      throw new AgentConsentError(503, 'scope_unverifiable', 'Could not check those matters just now, so nothing was granted. Try again.');
    }
    if (tier === null) {
      throw new AgentConsentError(403, 'matter_not_accessible',
        'One of the ticked matters is not one your account can open. Nothing was granted.');
    }
    if (tier !== 'A') {
      throw new AgentConsentError(403, 'sealed_matter',
        'One of the ticked matters is in a SecureSpace. No outside agent can see a SecureSpace, so nothing was granted.');
    }
  }
  return ids;
}

/**
 * The agent row's token_hash: SHA-256 of 32 random bytes that are dropped at
 * once. connector_tokens.token_hash is NOT NULL UNIQUE; nobody holds this
 * hash's preimage, so no csp_ token can ever authenticate as this agent. It
 * is reachable only through its OAuth grant.
 */
export function unusableTokenHash() {
  return createHash('sha256').update(randomBytes(32)).digest('hex');
}

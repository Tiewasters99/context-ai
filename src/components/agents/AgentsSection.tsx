// Connections › Agents (spec A3).
//
// An agent is an outside AI (a Grok Bot first; any MCP client) that works a
// task board inside the matters Eden grants it, and nowhere else. Privilege
// defaults OFF: a new agent sees nothing until a matter is ticked. The server
// enforces the scope in /api/mcp; this section only issues the token, shows
// what each agent may see, and lets Eden change or revoke that.
//
// Before migration 085 the token columns and task tables do not exist. The
// section then says so in one sentence and offers nothing that would fail.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Check, Copy } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useServerspaces } from '@/hooks/useServerspaces';
import { useAgentTokensInvalidate } from '@/hooks/useAgentTokens';
import { MCP_ENDPOINT_URL } from '@/lib/connectorTokens';
import { isEffectivelySealed, normalizeScope } from '@/lib/agent-scope';
import { AGENTS_MIGRATION_MESSAGE, countLiveTasksByToken, isAgentsNotReady } from '@/lib/agentTasks';
import {
  AGENT_PROVIDERS,
  agentLabel,
  createAgentToken,
  isLiveAgent,
  isOauthAgent,
  listAgentTokens,
  listOauthAgentLinks,
  revokeOauthGrant,
  providerLabel,
  revokeAgentToken,
  updateAgentScope,
  type AgentProvider,
  type AgentToken,
  type OauthAgentLink,
} from '@/lib/agentTokens';
import AgentCard, { cardField, cardLegend } from './AgentCard';
import StepUpPrompt from '@/components/account/StepUpPrompt';
import { isStepUpRequired } from '@/lib/connector-token-create';
import AgentMatterPicker from './AgentMatterPicker';

export const AGENT_SCOPE_COPY =
  'This agent sees only the matters you tick. Nothing else, and never a SecureSpace.';

/** The agents list's line for an agent with scope_all (migration 088). */
export const ALL_MATTERS_LABEL = 'All matters (except SecureSpaces)';
const ALL_MATTERS_SUBTITLE =
  'This agent sees every matter you can see, including ones you create later. Never a SecureSpace.';

// The setup guide (B8) is not written yet; until it is, each provider's
// connect page is the nearest thing to one.
function setupGuideHref(p: AgentProvider): string {
  if (p === 'chatgpt') return '/app/connections/chatgpt';
  if (p === 'claude') return '/app/connections/claude';
  if (p === 'gemini') return '/app/connections/gemini';
  return '/app/connections/grok';
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function useMatterIndex() {
  const { data: serverspaces = [] } = useServerspaces();
  return useMemo(() => {
    const all = serverspaces.flatMap((s) => s.matterspaces ?? []);
    const name = new Map(all.map((m) => [m.id, m.name] as const));
    return { all, name };
  }, [serverspaces]);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        });
      }}
      className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[rgba(255,255,255,0.14)] text-[11px] text-white/70 hover:text-white shrink-0"
    >
      {done ? <Check size={11} /> : <Copy size={11} />}
      {done ? 'Copied' : label}
    </button>
  );
}

// ── Add an agent ─────────────────────────────────────────────────────

export function AddAgentCard({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { user } = useAuth();
  const { all } = useMatterIndex();
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<AgentProvider>('grok');
  const [scope, setScope] = useState<string[]>([]);
  const [scopeAll, setScopeAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ token: string; name: string; provider: AgentProvider } | null>(null);
  const [stepUp, setStepUp] = useState(false);

  const create = async () => {
    if (!user) { setError('You must be signed in.'); return; }
    const n = name.trim();
    if (!n) { setError('Give the agent a name, so you can tell it apart later.'); return; }
    setBusy(true);
    setError(null);
    try {
      const { token } = await createAgentToken({
        userId: user.id,
        name: n,
        provider,
        scope: normalizeScope(all, scope),
        scopeAll,
      });
      setIssued({ token, name: n, provider });
      onCreated();
    } catch (e) {
      // 098: a person with a second factor confirms it before a new agent exists.
      if (isStepUpRequired(e)) { setStepUp(true); return; }
      setError(isAgentsNotReady(e) ? AGENTS_MIGRATION_MESSAGE : e instanceof Error ? e.message : 'Could not create the agent.');
    } finally {
      setBusy(false);
    }
  };

  if (issued) {
    return (
      <AgentCard
        storageKey="cs.agents.addAgent"
        title={`${issued.name}: connection details`}
        subtitle="The token is shown once. Copy it into the agent now; Contextspaces keeps only a fingerprint of it."
        onClose={onClose}
        footer={
          <button
            onClick={onClose}
            className="ml-auto px-3.5 py-1.5 rounded-md bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[12px] font-bold"
          >
            Done
          </button>
        }
      >
        <div>
          <p className={cardLegend}>MCP server URL</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate text-[12px] text-white/85 bg-[rgba(255,255,255,0.04)] rounded px-2 py-1.5">{MCP_ENDPOINT_URL}</code>
            <CopyButton text={MCP_ENDPOINT_URL} label="Copy URL" />
          </div>
        </div>
        <div>
          <p className={cardLegend}>Bearer token</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all text-[12px] text-white/85 bg-[rgba(255,255,255,0.04)] rounded px-2 py-1.5">{issued.token}</code>
            <CopyButton text={issued.token} label="Copy token" />
          </div>
        </div>
        <p className="text-[12px] text-white/55 leading-relaxed">
          In the agent's settings, add an MCP server with this URL, and send the token as
          {' '}<code className="text-[11.5px]">Authorization: Bearer …</code>. The agent then polls
          its task list, claims a task, works inside the task's matter, and posts its result back.
        </p>
        <p className="text-[12px] text-white/55 leading-relaxed">{AGENT_SCOPE_COPY}</p>
        <Link
          to={setupGuideHref(issued.provider)}
          className="inline-block text-[12px] text-[#e8b84a] hover:underline"
        >
          Setup guide for {providerLabel(issued.provider)} →
        </Link>
      </AgentCard>
    );
  }

  return (
    <AgentCard
      storageKey="cs.agents.addAgent"
      title="Add an agent"
      subtitle={AGENT_SCOPE_COPY}
      onClose={onClose}
      footer={
        <>
          {error && <p className="flex-1 text-[12px] text-red-300">{error}</p>}
          <button
            onClick={onClose}
            disabled={busy}
            className="ml-auto px-3 py-1.5 rounded-md border border-[rgba(255,255,255,0.12)] text-[12px] text-white/60 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={() => void create()}
            disabled={busy}
            className="px-3.5 py-1.5 rounded-md bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[12px] font-bold disabled:opacity-40"
          >
            {busy ? 'Creating…' : 'Create agent'}
          </button>
        </>
      }
    >
      {stepUp && (
        <StepUpPrompt
          mode="stepup"
          heading="Confirm it’s you to create an agent."
          onConfirmed={() => { setStepUp(false); void create(); }}
        />
      )}
      <div>
        <p className={cardLegend}>Name</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Grok Bot, discovery"
          className={cardField}
          autoFocus
        />
      </div>
      <div>
        <p className={cardLegend}>Provider</p>
        <select value={provider} onChange={(e) => setProvider(e.target.value as AgentProvider)} className={cardField}>
          {AGENT_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>
      <div>
        <p className={cardLegend}>Matters it may see</p>
        <AgentMatterPicker value={scope} onChange={setScope} scopeAll={scopeAll} onScopeAllChange={setScopeAll} />
        <p className="text-[11px] text-white/40 mt-1.5 leading-relaxed">
          A ticked matter includes its sub-matters. Tick nothing and the agent can see nothing
          until you come back and grant a matter.
        </p>
      </div>
    </AgentCard>
  );
}

// ── Edit matters ─────────────────────────────────────────────────────

export function EditMattersCard({
  agent,
  onClose,
  onSaved,
}: {
  agent: AgentToken;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { all } = useMatterIndex();
  const [scope, setScope] = useState<string[]>(agent.matter_scope);
  const [scopeAll, setScopeAll] = useState<boolean>(agent.scope_all === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateAgentScope(agent.id, normalizeScope(all, scope), { scopeAll, wasAll: agent.scope_all === true });
      onSaved();
      onClose();
    } catch (e) {
      setError(isAgentsNotReady(e) ? AGENTS_MIGRATION_MESSAGE : e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AgentCard
      storageKey="cs.agents.editMatters"
      title={`Matters ${agentLabel(agent)} may see`}
      subtitle={scopeAll ? ALL_MATTERS_SUBTITLE : AGENT_SCOPE_COPY}
      onClose={onClose}
      footer={
        <>
          {error && <p className="flex-1 text-[12px] text-red-300">{error}</p>}
          <button
            onClick={onClose}
            disabled={busy}
            className="ml-auto px-3 py-1.5 rounded-md border border-[rgba(255,255,255,0.12)] text-[12px] text-white/60 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={busy}
            className="px-3.5 py-1.5 rounded-md bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[12px] font-bold disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <AgentMatterPicker value={scope} onChange={setScope} scopeAll={scopeAll} onScopeAllChange={setScopeAll} />
      <p className="text-[11px] text-white/40 leading-relaxed">
        Removing a matter takes effect on the agent's next request. Tasks it already holds in
        that matter stay on the matter's Tasks tab, where you can cancel or reassign them.
      </p>
    </AgentCard>
  );
}

// ── the section ──────────────────────────────────────────────────────

export default function AgentsSection({ refreshKey = 0 }: { refreshKey?: number } = {}) {
  const { all: allMatters, name: matterName } = useMatterIndex();
  const [agents, setAgents] = useState<AgentToken[] | null>(null);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  // Agents connected on the OAuth consent screen (migration 087), by agent id.
  const [oauthLinks, setOauthLinks] = useState<Map<string, OauthAgentLink>>(new Map());
  const [notReady, setNotReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AgentToken | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const invalidateAgents = useAgentTokensInvalidate();

  const load = useCallback(async () => {
    // The Delegate cards read the same tokens through a shared cache.
    void invalidateAgents();
    try {
      const rows = (await listAgentTokens()).filter((t) => isLiveAgent(t));
      setAgents(rows);
      setNotReady(false);
      setError(null);
      try {
        setCounts(await countLiveTasksByToken(rows.map((r) => r.id)));
      } catch {
        setCounts(new Map()); // a count is a courtesy; the list stands without it
      }
      setOauthLinks(rows.some((r) => isOauthAgent(r)) ? await listOauthAgentLinks() : new Map());
    } catch (e) {
      if (isAgentsNotReady(e)) setNotReady(true);
      else setError(e instanceof Error ? e.message : 'Could not read your agents.');
      setAgents([]);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // refreshKey: Connections bumps it after revoking an OAuth grant, which
  // also revokes the agent behind it (migration 087).
  useEffect(() => { void load(); }, [load, refreshKey]);

  // /app/connections#agents (the link from the Grok page and from an empty
  // Delegate card) lands on this section, once it has something to show.
  const loaded = agents !== null;
  useEffect(() => {
    if (!loaded || window.location.hash !== '#agents') return;
    document.getElementById('agents')?.scrollIntoView({ block: 'start' });
  }, [loaded]);

  const revoke = async (a: AgentToken) => {
    const link = oauthLinks.get(a.id);
    const how = link ? ` Its sign-in from ${link.clientName} ends with it.` : '';
    if (!confirm(`Revoke ${agentLabel(a)}?\n\nIt stops working on its next request.${how} Its tasks and their log stay in each matter.`)) return;
    setBusyId(a.id);
    try {
      await revokeAgentToken(a.id);
      // The server already refuses an OAuth connection whose agent is revoked;
      // ending the grant too keeps Approved AI clients truthful.
      if (link) await revokeOauthGrant(link.grantId).catch(() => {});
      await load();
    } catch (e) {
      setError(isAgentsNotReady(e) ? AGENTS_MIGRATION_MESSAGE : e instanceof Error ? e.message : 'Could not revoke.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section id="agents" className="mt-10 scroll-mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-medium text-[var(--color-text-bright)]">Agents</h2>
        {!notReady && (
          <button
            onClick={() => setAdding(true)}
            className="px-3.5 py-1.5 rounded-lg bg-[var(--color-primary)] text-[#1a1408] text-[13px] font-semibold transition hover:bg-[var(--color-primary-hover)]"
          >
            Add an agent
          </button>
        )}
      </div>
      <p className="mt-1.5 mb-4 text-[13px] text-[var(--color-text-secondary)] max-w-xl leading-relaxed">
        An agent is an outside AI, such as a Grok Bot, that you hand tasks to from a document,
        a list, a page or a calendar entry. It connects over MCP with a token of its own and
        works through a task board. {AGENT_SCOPE_COPY}
      </p>

      {notReady && (
        <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-[13px] text-[var(--color-text-secondary)]">
          {AGENTS_MIGRATION_MESSAGE}
        </p>
      )}
      {error && <p className="mb-3 text-[13px] text-[#f87171]">{error}</p>}

      {!notReady && agents && agents.length === 0 && !error && (
        <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-[13px] text-[var(--color-text-secondary)]">
          No agents yet.
        </p>
      )}

      {!notReady && agents && agents.length > 0 && (
        <div className="flex flex-col gap-2">
          {agents.map((a) => {
            const granted = a.matter_scope.map((id) => {
              const n = matterName.get(id);
              if (!n) return 'a matter you no longer see';
              // Granted before the matter was sealed: the seal wins.
              return isEffectivelySealed(allMatters, id) ? `${n} (now in a SecureSpace, so not visible)` : n;
            });
            const used = shortDate(a.last_used_at);
            const open = counts.get(a.id) ?? 0;
            const link = oauthLinks.get(a.id);
            return (
              <div
                key={a.id}
                className="flex items-start gap-4 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-4"
              >
                <span className="w-10 h-10 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
                  <Bot size={18} className="text-[var(--color-primary)]" strokeWidth={1.75} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2.5 flex-wrap">
                    <span className="text-[15px] font-medium text-[var(--color-text-bright)] truncate">{agentLabel(a)}</span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--color-border)] text-[var(--color-text-secondary)]">
                      {providerLabel(a.agent_provider)}
                    </span>
                  </span>
                  {isOauthAgent(a) && (
                    <span className="block text-[12px] text-[var(--color-text-muted)] mt-1">
                      {link
                        ? `Connected by sign-in (OAuth) from ${link.clientName}.`
                        : 'Connected by sign-in (OAuth). That sign-in has ended; connect it again from the client.'}
                    </span>
                  )}
                  <span className="block text-[13px] text-[var(--color-text-secondary)] mt-1">
                    {a.scope_all
                      ? `Sees: ${ALL_MATTERS_LABEL}.`
                      : granted.length ? `Sees: ${granted.join('; ')}.` : 'Sees nothing yet. No matter is ticked.'}
                  </span>
                  <span className="block text-[12px] text-[var(--color-text-muted)] mt-0.5">
                    {used ? `Last used ${used}.` : 'Not used yet.'}{' '}
                    {open === 0 ? 'No open tasks.' : `${open} open task${open === 1 ? '' : 's'}.`}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1.5 shrink-0">
                  <button
                    onClick={() => setEditing(a)}
                    className="text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)] transition"
                  >
                    Edit matters
                  </button>
                  <button
                    onClick={() => void revoke(a)}
                    disabled={busyId === a.id}
                    className="text-[13px] text-[var(--color-text-secondary)] hover:text-[#f87171] transition disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {adding && <AddAgentCard onClose={() => setAdding(false)} onCreated={() => void load()} />}
      {editing && (
        <EditMattersCard agent={editing} onClose={() => setEditing(null)} onSaved={() => void load()} />
      )}
    </section>
  );
}

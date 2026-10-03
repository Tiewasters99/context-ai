// "AI with access" — the matter's Share dialog, below the people.
//
// Agents are not members, so without this a matter never shows which outside
// AI can reach it (Eden, 09-30: "how does Grok see Direct Challenges?"). It
// lists:
//   * the signed-in person's own agents that can see this matter, and why
//     ("this matter", "via Bushell", "All matters"), with Edit matters and
//     Revoke — the same cards and calls as Connections › Agents;
//   * one line for assistants connected with the person's full access
//     (Claude, ChatGPT…), which are not scoped and are not listed as if they
//     were;
//   * for a sealed matter, only the seal: no outside AI can see it.
// And a "Connect an agent to this matter" card (Gap 3).
//
// Scope of what it can know: connector_tokens and oauth_grants return only
// the caller's own rows, so a co-counsel's agents never appear here. The
// section says nothing about them rather than implying the list is complete.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Check, Copy, Lock, Plus } from 'lucide-react';
import { useServerspaces } from '@/hooks/useServerspaces';
import { useAgentsForMatter, useAgentTokensInvalidate } from '@/hooks/useAgentTokens';
import { useRecipientsForMatter } from '@/hooks/useTaskRecipients';
import { MCP_ENDPOINT_URL } from '@/lib/connectorTokens';
import { agentCoverageReason, agentCoversMatter, normalizeScope } from '@/lib/agent-scope';
import { coverageLabel, fullAccessLine } from '@/lib/matter-ai-access';
import { writePendingAgentConnect } from '@/lib/pending-agent-connect';
import { AGENTS_MIGRATION_MESSAGE, isAgentsNotReady } from '@/lib/agentTasks';
import {
  AGENT_PROVIDERS,
  agentLabel,
  isLiveAgent,
  listOauthAgentLinks,
  providerLabel,
  revokeAgentToken,
  revokeOauthGrant,
  updateAgentScope,
  type AgentProvider,
  type AgentToken,
  type OauthAgentLink,
} from '@/lib/agentTokens';
import AgentCard from './AgentCard';
import { AddAgentCard, EditMattersCard } from './AgentsSection';

// Above the Share dialog (CardDialog z 70).
const CARD_Z = 80;

const AGENTS_LINK = '/app/connections#agents';

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function MatterAgentsSection({ matterId, matterName }: { matterId: string; matterName: string }) {
  const { own, sealed, loading, notReady, error } = useAgentsForMatter(matterId);
  const { data: serverspaces = [] } = useServerspaces();
  const matters = useMemo(() => serverspaces.flatMap((s) => s.matterspaces ?? []), [serverspaces]);
  const nameOf = useCallback((id: string) => matters.find((m) => m.id === id)?.name, [matters]);
  const known = matters.some((m) => m.id === matterId);
  const invalidate = useAgentTokensInvalidate();
  // Full-access connections (tokens, and sign-ins not linked to an agent):
  // the same cached read the Delegate card and the Agents page use.
  const { assistants } = useRecipientsForMatter(matterId);

  const [oauthLinks, setOauthLinks] = useState<Map<string, OauthAgentLink>>(new Map());
  const [editing, setEditing] = useState<AgentToken | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const live = useMemo(() => own.filter((a) => isLiveAgent(a)), [own]);
  const covering = useMemo(
    () => live
      .map((a) => ({ a, reason: agentCoverageReason(matters, a, matterId) }))
      .filter((x): x is { a: AgentToken; reason: NonNullable<typeof x.reason> } => x.reason !== null),
    [live, matters, matterId],
  );

  useEffect(() => {
    if (!live.length) return;
    let cancelled = false;
    void listOauthAgentLinks().then((m) => { if (!cancelled) setOauthLinks(m); });
    return () => { cancelled = true; };
  }, [live.length]);

  const revoke = async (a: AgentToken) => {
    const link = oauthLinks.get(a.id);
    const how = link ? ` Its sign-in from ${link.clientName} ends with it.` : '';
    if (!confirm(`Revoke ${agentLabel(a)}?\n\nIt stops working on its next request.${how} Its tasks and their log stay in each matter.`)) return;
    setBusyId(a.id);
    setActionError(null);
    try {
      await revokeAgentToken(a.id);
      if (link) await revokeOauthGrant(link.grantId).catch(() => {});
      await invalidate();
    } catch (e) {
      setActionError(isAgentsNotReady(e) ? AGENTS_MIGRATION_MESSAGE : e instanceof Error ? e.message : 'Could not revoke.');
    } finally {
      setBusyId(null);
    }
  };

  // A matter this browser does not have in its tree: say nothing rather than guess.
  if (!known) return null;

  const heading = (
    <p className="text-[11px] font-semibold text-white/60 uppercase tracking-wider mb-2">AI with access</p>
  );

  if (sealed) {
    return (
      <div className="mt-5 pt-4 border-t border-[rgba(255,255,255,0.06)]">
        {heading}
        <p className="flex items-start gap-2 text-[12px] text-white/70 leading-relaxed">
          <Lock size={13} className="shrink-0 mt-0.5 text-[#e8b84a]" />
          This matter is in a SecureSpace. No outside AI can see it.
        </p>
      </div>
    );
  }

  const fullLine = fullAccessLine(
    assistants.filter((r) => r.kind === 'grant').map((r) => r.name),
    assistants.filter((r) => r.kind === 'token').length,
  );

  return (
    <div className="mt-5 pt-4 border-t border-[rgba(255,255,255,0.06)]">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <p className="text-[11px] font-semibold text-white/60 uppercase tracking-wider">AI with access</p>
        {!notReady && (
          <button
            type="button"
            onClick={() => setConnecting(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[rgba(232,184,74,0.35)] text-[11.5px] text-[#e8b84a] hover:bg-[rgba(232,184,74,0.08)] transition-colors"
          >
            <Plus size={12} /> Connect an agent to this matter
          </button>
        )}
      </div>

      {notReady ? (
        <p className="text-[12px] text-white/50">{AGENTS_MIGRATION_MESSAGE}</p>
      ) : loading ? (
        <p className="text-[12px] text-white/40">Reading your agents…</p>
      ) : error ? (
        <p className="text-[12px] text-red-300/90">{error}</p>
      ) : covering.length === 0 ? (
        <p className="text-[12px] text-white/45">None of your agents can see this matter.</p>
      ) : (
        <ul className="space-y-1">
          {covering.map(({ a, reason }) => {
            const used = shortDate(a.last_used_at);
            return (
              <li key={a.id} className="flex items-start gap-3 px-3 py-2.5 rounded-md hover:bg-[rgba(255,255,255,0.03)] transition-colors">
                <div className="w-8 h-8 rounded-full bg-[#e8b84a]/15 flex items-center justify-center shrink-0">
                  <Bot size={14} className="text-[#e8b84a]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="flex items-center gap-2 flex-wrap text-[13px] text-white">
                    <span className="truncate max-w-full">{agentLabel(a)}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-[rgba(255,255,255,0.12)] text-white/60">
                      {providerLabel(a.agent_provider)}
                    </span>
                  </p>
                  <p className="text-[11px] text-white/45 mt-0.5">
                    Sees it: {coverageLabel(reason, nameOf)}. {used ? `Last used ${used}.` : 'Not used yet.'}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setEditing(a)}
                    className="text-[11.5px] text-white/60 hover:text-white transition-colors"
                  >
                    Edit matters
                  </button>
                  <button
                    type="button"
                    onClick={() => void revoke(a)}
                    disabled={busyId === a.id}
                    className="text-[11.5px] text-white/60 hover:text-red-300 transition-colors disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {actionError && <p className="mt-2 text-[11px] text-red-300">{actionError}</p>}

      {fullLine && (
        <p className="mt-3 text-[11.5px] text-white/50 leading-relaxed">
          {fullLine}{' '}
          <Link to="/app/connections" className="text-[#e8b84a] hover:underline">Connections</Link>
        </p>
      )}

      {editing && (
        <EditMattersCard
          agent={editing}
          z={CARD_Z}
          onClose={() => setEditing(null)}
          onSaved={() => void invalidate()}
        />
      )}
      {connecting && (
        <ConnectAgentCard
          matterId={matterId}
          matterName={matterName}
          candidates={live.filter((a) => !agentCoversMatter(matters, a, matterId))}
          onClose={() => setConnecting(false)}
          onChanged={() => void invalidate()}
        />
      )}
    </div>
  );
}

// ── Connect an agent to this matter ──────────────────────────────────

function CopyUrl() {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code data-card-inert="" className="flex-1 min-w-0 break-all text-[12px] text-white/85 bg-[rgba(255,255,255,0.04)] rounded px-2 py-1.5">
        {MCP_ENDPOINT_URL}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(MCP_ENDPOINT_URL).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1600);
          }).catch(() => {});
        }}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[rgba(255,255,255,0.14)] text-[11px] text-white/70 hover:text-white shrink-0"
      >
        {done ? <Check size={11} /> : <Copy size={11} />}
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

const step = 'flex gap-2.5';
const num = 'text-[#e8b84a] font-mono shrink-0';
const strong = 'text-white';

/** The provider's own steps, from the verified Grok flow and the Connect pages. */
function ProviderSteps({ provider, matterName }: { provider: AgentProvider; matterName: string }) {
  const client = provider === 'grok' ? 'Grok' : provider === 'chatgpt' ? 'ChatGPT' : provider === 'claude' ? 'Claude' : 'it';
  const consent = (
    <>
      On that page, under <strong className={strong}>Connect {client === 'it' ? '…' : client} as</strong>, choose{' '}
      <strong className={strong}>An agent</strong>. {matterName} is ticked for you; change it if you like.
      Then press <strong className={strong}>Connect as an agent</strong>.
    </>
  );
  if (provider === 'grok') {
    return (
      <ol className="space-y-2 text-[12px] text-white/70 leading-relaxed">
        <li className={step}><span className={num}>1.</span><span>
          Go to{' '}
          <a href="https://grok.com/connectors" target="_blank" rel="noopener noreferrer" className="text-[#e8b84a] hover:underline">grok.com/connectors</a>,
          click <strong className={strong}>New Connector</strong>, then choose <strong className={strong}>Custom</strong>.
        </span></li>
        <li className={step}><span className={num}>2.</span><span className="flex-1 min-w-0">
          Paste this address as the server URL, then continue:
          <span className="block mt-1.5"><CopyUrl /></span>
        </span></li>
        <li className={step}><span className={num}>3.</span><span>
          Grok opens a Contextspaces page. Sign in if it asks. {consent}
        </span></li>
      </ol>
    );
  }
  if (provider === 'chatgpt' || provider === 'claude') {
    const name = provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
    const page = provider === 'chatgpt' ? '/app/connections/chatgpt' : '/app/connections/claude';
    return (
      <ol className="space-y-2 text-[12px] text-white/70 leading-relaxed">
        <li className={step}><span className={num}>1.</span><span className="flex-1 min-w-0">
          In {name}, add a custom connector with this address, signing in rather than pasting a key.
          The exact clicks are on the{' '}
          <Link to={page} className="text-[#e8b84a] hover:underline">{name} page</Link>.
          <span className="block mt-1.5"><CopyUrl /></span>
        </span></li>
        <li className={step}><span className={num}>2.</span><span>
          {name} opens a Contextspaces page. Sign in if it asks. {consent}
        </span></li>
      </ol>
    );
  }
  // 'other': it may sign in, or it may want a key.
  return (
    <ol className="space-y-2 text-[12px] text-white/70 leading-relaxed">
      <li className={step}><span className={num}>1.</span><span className="flex-1 min-w-0">
        Add Contextspaces to it with this address:
        <span className="block mt-1.5"><CopyUrl /></span>
      </span></li>
      <li className={step}><span className={num}>2.</span><span>
        If it opens a Contextspaces page to sign in: {consent}
      </span></li>
      <li className={step}><span className={num}>3.</span><span>
        If instead it asks for a key, create the agent here with the button below.
      </span></li>
    </ol>
  );
}

function ConnectAgentCard({
  matterId,
  matterName,
  candidates,
  onClose,
  onChanged,
}: {
  matterId: string;
  matterName: string;
  /** The person's live agents that cannot see this matter yet. */
  candidates: AgentToken[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data: serverspaces = [] } = useServerspaces();
  const matters = useMemo(() => serverspaces.flatMap((s) => s.matterspaces ?? []), [serverspaces]);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<AgentProvider | null>(null);
  const [creating, setCreating] = useState(false);

  const addTo = async (a: AgentToken) => {
    setBusyId(a.id);
    setError(null);
    try {
      // The rest of its grant stays as it is; a sub-matter already ticked
      // under this one is folded into it.
      await updateAgentScope(a.id, normalizeScope(matters, [...a.matter_scope, matterId]));
      setAdded((s) => new Set(s).add(a.id));
      onChanged();
    } catch (e) {
      setError(isAgentsNotReady(e) ? AGENTS_MIGRATION_MESSAGE : e instanceof Error ? e.message : 'Could not add the matter.');
    } finally {
      setBusyId(null);
    }
  };

  const pick = (p: AgentProvider) => {
    setProvider(p);
    // Gemini connects with a key, not a sign-in page: no hint to leave.
    if (p !== 'gemini') writePendingAgentConnect({ matterId, provider: p });
  };

  if (creating && provider) {
    return (
      <AddAgentCard
        z={CARD_Z}
        initialProvider={provider}
        initialScope={[matterId]}
        onClose={onClose}
        onCreated={onChanged}
      />
    );
  }

  return (
    <AgentCard
      storageKey="cs.agents.connectToMatter"
      z={CARD_Z}
      title={`Connect an agent to ${matterName}`}
      subtitle="An agent sees only the matters you give it. Nothing else, and never a SecureSpace."
      onClose={onClose}
      footer={
        <>
          {error && <p className="flex-1 text-[12px] text-red-300">{error}</p>}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-3.5 py-1.5 rounded-md border border-[rgba(255,255,255,0.12)] text-[12px] text-white/70 hover:text-white"
          >
            Done
          </button>
        </>
      }
    >
      {candidates.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8a8693] mb-1.5">An agent you already have</p>
          <ul className="space-y-1.5">
            {candidates.map((a) => (
              <li key={a.id} className="flex items-center gap-2 flex-wrap">
                <span className="flex-1 min-w-0 text-[13px] text-white/85 truncate">
                  {agentLabel(a)} <span className="text-[11px] text-white/40">{providerLabel(a.agent_provider)}</span>
                </span>
                {added.has(a.id) ? (
                  <span className="inline-flex items-center gap-1 text-[11.5px] text-emerald-400"><Check size={12} /> Added</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void addTo(a)}
                    disabled={busyId !== null}
                    className="px-2.5 py-1 rounded-md bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[11.5px] font-bold disabled:opacity-40 shrink-0"
                  >
                    {busyId === a.id ? 'Adding…' : 'Add this matter'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-white/40 mt-1.5">It keeps every matter it already sees.</p>
        </div>
      )}

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8a8693] mb-1.5">A new agent</p>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Which AI">
          {AGENT_PROVIDERS.map((p) => (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={provider === p.value}
              onClick={() => pick(p.value)}
              className={`px-2.5 py-1 rounded-md border text-[12px] transition-colors ${
                provider === p.value
                  ? 'border-[rgba(232,184,74,0.55)] bg-[rgba(232,184,74,0.08)] text-white'
                  : 'border-[rgba(255,255,255,0.12)] text-white/65 hover:text-white'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {provider && provider !== 'gemini' && (
        <div className="space-y-2.5">
          <ProviderSteps provider={provider} matterName={matterName} />
          {provider === 'grok' && (
            <p className="text-[11px] text-white/45 leading-relaxed">
              Grok's connectors are account-wide: every Grok chat and Grok Bot on your Grok account
              shares this one agent and its matters. To change what it sees later, use Edit matters
              here or under <Link to={AGENTS_LINK} className="text-[#e8b84a] hover:underline">Connections › Agents</Link>.
            </p>
          )}
          <p className="text-[11px] text-white/40 leading-relaxed">
            Do this in this browser within 30 minutes: that is how the Contextspaces page knows which
            matter to tick. You still confirm it there.
          </p>
          {provider === 'other' && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="text-[12px] text-[#e8b84a] hover:underline"
            >
              Create the agent here instead →
            </button>
          )}
        </div>
      )}

      {provider === 'gemini' && (
        <div className="space-y-2">
          <p className="text-[12px] text-white/70 leading-relaxed">
            Gemini connects with a key you paste into its settings, not by signing in. Create the
            agent here with {matterName} ticked; you will get the address and key to paste, and the{' '}
            <Link to="/app/connections/gemini" className="text-[#e8b84a] hover:underline">Gemini page</Link>{' '}
            says where they go.
          </p>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="px-3 py-1.5 rounded-md bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[12px] font-bold"
          >
            Create a Gemini agent
          </button>
        </div>
      )}
    </AgentCard>
  );
}

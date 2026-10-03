// Grok MCP connection page.
//
// grok.com connects to MCP servers by OAuth only, and its connectors are
// account-wide (docs.x.ai/grok/connectors, confirmed 09-25). So the page
// leads with the verified flow: add a Custom connector with our URL, sign
// in, and connect Grok as AN AGENT on the consent screen (OAuthAuthorize
// starts there for Grok). The Bearer-token generator is kept, demoted, for
// the xAI API and other HTTP MCP clients that send their own headers, and as
// the place to revoke tokens made here before 09-25.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Copy,
  Check,
  Plus,
  Trash2,
  Key,
  AlertCircle,
  X,
  ChevronRight,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { readUserTokens } from '@/lib/agents-schema';
import { useAuth } from '@/contexts/AuthContext';
import {
  grokConfigSnippet,
  MCP_ENDPOINT_URL,
} from '@/lib/connectorTokens';
import CardDialog from '@/components/ui/CardDialog';
import StepUpPrompt from '@/components/account/StepUpPrompt';
import { createUserConnectorToken, isStepUpRequired } from '@/lib/connector-token-create';

interface TokenRow {
  id: string;
  token_prefix: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

interface NewTokenDisplay { token: string; name: string }

export default function GrokConnect() {
  const { user } = useAuth();
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [justIssued, setJustIssued] = useState<NewTokenDisplay | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    // Agent tokens (kind 'agent', migration 085) live under Connections ›
    // Agents, not here; readUserTokens drops them without a kind filter,
    // which would fail before 085 is applied.
    const { data, error } = await readUserTokens<TokenRow>(
      (cols) => supabase
        .from('connector_tokens')
        .select(cols)
        .order('created_at', { ascending: false }),
      'id, token_prefix, name, created_at, last_used_at, revoked_at, expires_at',
    );
    if (error) setError(error.message); else setTokens((data ?? []) as TokenRow[]);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleGenerate() {
    if (!user) { setError('You must be signed in.'); return; }
    const trimmed = newTokenName.trim();
    if (!trimmed) { setError("Give the token a name so you can identify it later."); return; }
    setError(null);
    setGenerating(true);
    try {
      // 098: through connector_token_create, which may ask for the second factor.
      const { token } = await createUserConnectorToken(user.id, trimmed);
      setJustIssued({ token, name: trimmed });
      setNewTokenName('');
      await refresh();
    } catch (err) {
      if (isStepUpRequired(err)) { setStepUp(true); return; }
      setError((err as Error).message || 'Failed to generate token');
    } finally {
      setGenerating(false);
    }
  }

  async function handleRevoke(id: string, name: string | null) {
    const label = name || 'this token';
    if (!confirm(`Revoke ${label}? Any client currently using it will immediately lose access.`)) return;
    const { error } = await supabase
      .from('connector_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id);
    if (error) setError(error.message);
    await refresh();
  }

  return (
    <div className="min-h-screen text-[var(--color-text)]">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <Link
          to="/app/connections"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)] transition mb-8"
        >
          <ArrowLeft size={14} /> Back to Connections
        </Link>

        <header className="mb-10">
          <h1
            className="text-4xl font-serif tracking-tight text-[var(--color-text-bright)]"
            style={{ fontFamily: 'Playfair Display Variable, serif' }}
          >
            Connect to Grok
          </h1>
          <p className="mt-3 text-[var(--color-text-secondary)] max-w-2xl leading-relaxed">
            <strong className="text-[var(--color-text-bright)]">Grok</strong>{' '}
            connects by signing in to Contextspaces, not with a pasted token,
            and it connects best as an{' '}
            <strong className="text-[var(--color-text-bright)]">agent</strong>:
            it sees only the matters you tick, never a SecureSpace, and works
            the tasks you hand it from a document, a list, a page or a
            calendar entry.
          </p>

          <div className="mt-5 max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-xs text-[var(--color-text-secondary)] leading-relaxed">
            <strong className="text-[var(--color-text-bright)]">Checked end to end on 25 September 2026.</strong>{' '}
            A Grok task ran from start to finish with these steps. If one of
            Grok's menus no longer matches what you see, Grok has moved it
            since; the Contextspaces side is unchanged.
          </div>
        </header>

        {/* Walkthrough — the verified flow (GROK-AGENT-SETUP v3, 09-25).
            Labels on our side are OAuthAuthorize.tsx's own. */}
        <section className="mb-6 rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-surface)] p-6">
          <h2 className="text-lg font-semibold text-[var(--color-text-bright)] mb-4"
              style={{ fontFamily: 'Playfair Display Variable, serif' }}>
            Grok as an agent, in four steps
          </h2>
          <ol className="space-y-3 text-sm text-[var(--color-text-secondary)] leading-relaxed">
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">1.</span>
              <span>
                Go to{' '}
                <a href="https://grok.com/connectors" target="_blank" rel="noopener noreferrer"
                   className="text-[var(--color-primary)] hover:underline">
                  grok.com/connectors
                </a>
                , click <strong className="text-[var(--color-text-bright)]">New Connector</strong>,
                then choose <strong className="text-[var(--color-text-bright)]">Custom</strong>.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">2.</span>
              <span className="flex-1 min-w-0">
                Paste this address as the server URL, and continue:
                <span className="mt-2 flex items-center gap-2 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded px-3 py-2">
                  <code className="text-xs text-[var(--color-primary)] font-mono break-all flex-1">
                    {MCP_ENDPOINT_URL}
                  </code>
                  <CopyButton value={MCP_ENDPOINT_URL} label="URL" />
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">3.</span>
              <span>
                Grok opens a Contextspaces page. Sign in if it asks. The page
                says <strong className="text-[var(--color-text-bright)]">Authorize Grok</strong>;
                under <strong className="text-[var(--color-text-bright)]">Connect Grok as</strong>,
                keep <strong className="text-[var(--color-text-bright)]">An agent</strong>{' '}
                (it starts there for Grok). Under{' '}
                <strong className="text-[var(--color-text-bright)]">Matters it may see</strong>,
                tick the matters Grok may work in (a ticked matter includes its
                sub-matters), or{' '}
                <strong className="text-[var(--color-text-bright)]">All my matters (except SecureSpaces)</strong>.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">4.</span>
              <span>
                Click <strong className="text-[var(--color-text-bright)]">Connect as an agent</strong>.
                You land back in Grok, which now lists Contextspaces as
                connected. Hand it a task with{' '}
                <strong className="text-[var(--color-text-bright)]">Delegate</strong> on a
                document in one of those matters, then ask Grok to check its
                Contextspaces tasks.
              </span>
            </li>
          </ol>
          <p className="text-xs text-[var(--color-text-muted)] mt-5 leading-relaxed">
            Starting from a matter instead? Open the matter's{' '}
            <strong>Share</strong> dialog and choose{' '}
            <strong>Connect an agent to this matter</strong>: it shows these
            steps and ticks that matter for you on the Contextspaces page.
          </p>
        </section>

        <div className="mb-3 max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-sm text-[var(--color-text-secondary)] leading-relaxed">
          <strong className="text-[var(--color-text-bright)]">One agent for all of Grok.</strong>{' '}
          Grok's connectors are account-wide, so every Grok chat and every
          Grok Bot on your Grok account shares this one agent and its matters;
          there is no giving one bot different matters from another. To change
          what it sees, go to{' '}
          <Link to="/app/connections#agents" className="text-[var(--color-primary)] hover:underline">
            Connections › Agents
          </Link>{' '}
          and choose <strong className="text-[var(--color-text-bright)]">Edit matters</strong>{' '}
          (or use a matter's Share dialog). Revoke it there and Grok is cut
          off on its next request.
        </div>

        <div className="mb-10 max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-sm text-[var(--color-text-secondary)] leading-relaxed">
          <strong className="text-[var(--color-text-bright)]">If you chose "A full assistant".</strong>{' '}
          Grok then carries your own access: every matter you can see, except
          SecureSpaces, and it cannot work the task board (it will say "These
          tools are for agent connections"). To switch, revoke it under
          Connections › Approved AI clients and repeat the steps above,
          choosing An agent.
        </div>

        {/* Demoted: the token path. grok.com cannot use it (OAuth only);
            it stays for the xAI API and other HTTP MCP clients, and as the
            place to revoke tokens made here before 09-25. */}
        <h2 className="text-lg font-semibold text-[var(--color-text-bright)] mb-2"
            style={{ fontFamily: 'Playfair Display Variable, serif' }}>
          The xAI API, or another HTTP MCP client
        </h2>
        <p className="mb-6 max-w-2xl text-sm text-[var(--color-text-secondary)] leading-relaxed">
          Not for grok.com. A script or client that sends its own headers can
          connect with this address and a Bearer token instead of signing in.
          A token made below carries your own access, no more, no less:
          whatever your account can open, except SecureSpaces. It can read,
          search, file new documents and organise them; it cannot delete a
          document or overwrite an original. To give such a client only
          certain matters, add it as an agent under{' '}
          <Link to="/app/connections#agents" className="text-[var(--color-primary)] hover:underline">
            Connections › Agents
          </Link>{' '}
          and use that agent's token instead.
        </p>

        {/* Endpoint banner */}
        <div className="mb-6 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">
                Endpoint URL
              </div>
              <code className="text-sm text-[var(--color-primary)] font-mono break-all">
                {MCP_ENDPOINT_URL}
              </code>
            </div>
            <CopyButton value={MCP_ENDPOINT_URL} label="URL" />
          </div>
        </div>

        {/* Generate */}
        <section className="mb-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <h2 className="text-lg font-semibold text-[var(--color-text-bright)] mb-4"
              style={{ fontFamily: 'Playfair Display Variable, serif' }}>
            Generate a new token
          </h2>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !generating && newTokenName.trim()) handleGenerate(); }}
              placeholder="Label (e.g. 'Grok — Web')"
              className="flex-1 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded px-3 py-2 text-sm text-[var(--color-text-bright)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] transition"
              disabled={generating}
            />
            <button
              onClick={handleGenerate}
              disabled={generating || !newTokenName.trim()}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded bg-[var(--color-primary)] text-[#0a0a0a] hover:bg-[var(--color-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              <Plus size={16} />
              {generating ? 'Generating…' : 'Generate'}
            </button>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] mt-3 leading-relaxed">
            The token is created in your browser and only its SHA-256 hash is
            stored. You'll see the full value exactly once — copy it
            immediately.
          </p>
        </section>

        {stepUp && (
          <div className="mb-6">
            <StepUpPrompt
              mode="stepup"
              heading="Confirm it’s you to create a connection."
              onConfirmed={() => { setStepUp(false); void handleGenerate(); }}
            />
          </div>
        )}

        {error && (
          <div className="mb-6 rounded border border-red-500/40 bg-red-500/10 text-red-300 px-4 py-3 text-sm flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200">
              <X size={14} />
            </button>
          </div>
        )}

        <section>
          <h2 className="text-lg font-semibold text-[var(--color-text-bright)] mb-4"
              style={{ fontFamily: 'Playfair Display Variable, serif' }}>
            Your tokens
          </h2>
          {loading ? (
            <div className="text-sm text-[var(--color-text-muted)]">Loading…</div>
          ) : tokens.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
              No tokens yet. Grok itself needs none: it connects by signing in.
            </div>
          ) : (
            <ul className="space-y-2">
              {tokens.map((t) => <TokenItem key={t.id} token={t} onRevoke={handleRevoke} />)}
            </ul>
          )}
          <p className="text-xs text-[var(--color-text-muted)] mt-4 leading-relaxed">
            Tokens here are shared across Claude, Gemini, and Grok — one
            connector token, every assistant. Name them by client so you can
            tell at a glance which one is plumbed where.
          </p>
        </section>
      </div>

      {justIssued && (
        <NewTokenModal
          token={justIssued.token}
          name={justIssued.name}
          onClose={() => setJustIssued(null)}
        />
      )}
    </div>
  );
}


function TokenItem({ token, onRevoke }: { token: TokenRow; onRevoke: (id: string, name: string | null) => void; }) {
  const revoked = !!token.revoked_at;
  const expired = !!(token.expires_at && new Date(token.expires_at) < new Date());
  const status = revoked ? 'revoked' : expired ? 'expired' : 'active';
  return (
    <li className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex items-center justify-between gap-4 ${status !== 'active' ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-3 min-w-0">
        <Key size={18} className={status === 'active' ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]'} />
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--color-text-bright)] truncate">{token.name || 'Unnamed'}</div>
          <div className="text-xs text-[var(--color-text-muted)] font-mono mt-0.5">
            {token.token_prefix}… · created {new Date(token.created_at).toLocaleDateString()}
            {token.last_used_at && <> · last used {new Date(token.last_used_at).toLocaleDateString()}</>}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {status === 'revoked' && <span className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">revoked</span>}
        {status === 'expired' && <span className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">expired</span>}
        {status === 'active' && (
          <button
            onClick={() => onRevoke(token.id, token.name)}
            className="p-1.5 rounded text-[var(--color-text-muted)] hover:text-red-400 hover:bg-red-500/10 transition"
            title="Revoke token"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </li>
  );
}


function NewTokenModal({ token, name, onClose }: { token: string; name: string; onClose: () => void }) {
  const snippet = grokConfigSnippet(token);
  const [showAdvanced, setShowAdvanced] = useState(false);
  return (
    // The token is shown once. Only the explicit close button dismisses this
    // card: no Escape, no backdrop, so a stray key cannot throw it away.
    <CardDialog
      storageKey="cs.dialog.newToken"
      z={50}
      maxWidth={672}
      onClose={onClose}
      closeOnEscape={false}
      title="Token ready"
      subtitle={
        <>
          <span className="text-[var(--color-primary)]">{name}</span> —
          visible only now. Copy both values before closing.
        </>
      }
      surface="var(--color-surface-raised)"
      bodyClassName="px-6 py-5"
    >
      <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-5">
        In your client (the xAI API, or any HTTP MCP client), add a server
        with the URL below and send the token as{' '}
        <code className="text-xs">Authorization: Bearer …</code>. Name it{' '}
        <em>Contextspaces</em>. grok.com does not take tokens; it connects by
        signing in.
      </p>

      <div className="mb-4">
        <label className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] block mb-2">Endpoint URL</label>
        <div className="flex items-center gap-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
          <code data-card-inert="" className="text-xs text-[var(--color-primary)] font-mono break-all flex-1">{MCP_ENDPOINT_URL}</code>
          <CopyButton value={MCP_ENDPOINT_URL} label="URL" />
        </div>
      </div>

      <div className="mb-6">
        <label className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] block mb-2">Bearer token</label>
        <div className="flex items-center gap-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
          <code data-card-inert="" className="text-xs text-[var(--color-primary)] font-mono break-all flex-1">{token}</code>
          <CopyButton value={token} label="token" />
        </div>
      </div>

      <div className="mb-6 border-t border-[var(--color-border)] pt-4">
        <button onClick={() => setShowAdvanced((v) => !v)} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-bright)] transition flex items-center gap-1.5">
          <ChevronRight size={12} className={`transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
          Advanced: paste a config block instead
        </button>
        {showAdvanced && (
          <div className="mt-3">
            <p className="text-xs text-[var(--color-text-muted)] mb-2 leading-relaxed">
              For any HTTP-MCP client that takes a JSON config (Grok via the
              xAI API, scripted setups, etc.), this is the canonical block:
            </p>
            <div className="relative bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
              <pre data-card-inert="" className="text-xs text-[var(--color-text)] font-mono whitespace-pre-wrap break-all">{snippet}</pre>
              <div className="absolute top-2 right-2">
                <CopyButton value={snippet} label="config" />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3">
        <button onClick={onClose} className="px-4 py-2 text-sm font-medium rounded bg-[var(--color-primary)] text-[#0a0a0a] hover:bg-[var(--color-primary-hover)] transition">
          I have what I need — close
        </button>
      </div>
    </CardDialog>
  );
}


function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function handle() {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  }
  return (
    <button onClick={handle} className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] transition px-2 py-1 rounded" title={`Copy ${label}`}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

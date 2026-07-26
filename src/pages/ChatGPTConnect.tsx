// ChatGPT MCP connection page.
//
// Deliberately NOT a copy of ClaudeConnect/GrokConnect. Those pages hand
// the user a csp_ token to paste into a header field. ChatGPT has no such
// field: OpenAI's connector flow speaks OAuth (authorization code + PKCE,
// client registered via CIMD or our /api/oauth-register DCR endpoint) and
// will not present a static bearer token or API key. So the primary path
// here is "add the URL, pick OAuth, sign in" — no token at all.
//
// Tokens still matter for one ChatGPT-adjacent case: the OpenAI Responses
// API's `mcp` tool accepts arbitrary headers. That's what the second half
// of the page is for.

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
  ShieldCheck,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  generateConnectorToken,
  openaiResponsesSnippet,
  MCP_ENDPOINT_URL,
} from '@/lib/connectorTokens';

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

export default function ChatGPTConnect() {
  const { user } = useAuth();
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTokenName, setNewTokenName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [justIssued, setJustIssued] = useState<NewTokenDisplay | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('connector_tokens')
      .select('id, token_prefix, name, created_at, last_used_at, revoked_at, expires_at')
      .order('created_at', { ascending: false });
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
      const { token, tokenHash, tokenPrefix } = await generateConnectorToken();
      const { error: insertErr } = await supabase
        .from('connector_tokens')
        .insert({ user_id: user.id, token_hash: tokenHash, token_prefix: tokenPrefix, name: trimmed });
      if (insertErr) throw insertErr;
      setJustIssued({ token, name: trimmed });
      setNewTokenName('');
      await refresh();
    } catch (err) {
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
            Connect to ChatGPT
          </h1>
          <p className="mt-3 text-[var(--color-text-secondary)] max-w-2xl leading-relaxed">
            Wire Contextspaces into{' '}
            <strong className="text-[var(--color-text-bright)]">ChatGPT</strong>{' '}
            as a custom connector. Once connected, GPT can search your
            matters, pull pincites from your Vault, and cite them while you
            draft — the same toolset Claude, Gemini, and Grok get.
          </p>

          <div className="mt-7 max-w-2xl rounded-lg border border-[var(--color-primary)]/30 bg-[var(--color-primary-light)] px-5 py-4 text-sm text-[var(--color-text-secondary)] leading-relaxed flex gap-3">
            <ShieldCheck size={18} className="text-[var(--color-primary)] mt-0.5 flex-shrink-0" />
            <span>
              <strong className="text-[var(--color-text-bright)]">
                ChatGPT doesn't use a pasted token.
              </strong>{' '}
              Unlike Grok and Gemini, OpenAI's connector only speaks OAuth —
              it signs you in to Contextspaces in a browser window and holds
              the credential itself. There is nothing to copy. Skip straight to
              the steps below; the token section further down is only for
              calling GPT through the OpenAI API.
            </span>
          </div>
        </header>

        {/* Walkthrough */}
        <section className="mb-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <h2 className="text-lg font-semibold text-[var(--color-text-bright)] mb-4"
              style={{ fontFamily: 'Playfair Display Variable, serif' }}>
            ChatGPT, in four steps
          </h2>
          <ol className="space-y-3 text-sm text-[var(--color-text-secondary)] leading-relaxed">
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">1.</span>
              <span>
                In ChatGPT, open{' '}
                <strong className="text-[var(--color-text-bright)]">
                  Settings → Connectors → Advanced
                </strong>{' '}
                and switch on{' '}
                <strong className="text-[var(--color-text-bright)]">Developer mode</strong>.
                Custom MCP servers with a full toolset are gated behind it.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">2.</span>
              <span>
                Go back to{' '}
                <strong className="text-[var(--color-text-bright)]">Settings → Connectors</strong>{' '}
                and choose{' '}
                <strong className="text-[var(--color-text-bright)]">Create</strong>{' '}
                (or <em>Add custom connector</em>). Name it{' '}
                <em>Contextspaces</em> and paste the endpoint URL below into the{' '}
                <strong className="text-[var(--color-text-bright)]">MCP Server URL</strong> field.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">3.</span>
              <span>
                Set{' '}
                <strong className="text-[var(--color-text-bright)]">Authentication</strong>{' '}
                to <strong className="text-[var(--color-text-bright)]">OAuth</strong> —
                not "No authentication" — and click{' '}
                <strong className="text-[var(--color-text-bright)]">Create</strong>. ChatGPT
                registers itself with Contextspaces automatically and opens a
                sign-in window. Sign in and approve access.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">4.</span>
              <span>
                In any chat, open the{' '}
                <strong className="text-[var(--color-text-bright)]">+ → More</strong>{' '}
                menu and enable{' '}
                <strong className="text-[var(--color-text-bright)]">Contextspaces</strong>. Ask
                it to <em>list my matters</em> to confirm the tools are live.
              </span>
            </li>
          </ol>
          <p className="text-xs text-[var(--color-text-muted)] mt-5 leading-relaxed">
            Start every session with <em>list my matters</em>: the Contextspaces
            tools are matter-scoped, so GPT needs a matter before it can search.
            Note that ChatGPT's separate <strong>Deep research</strong> connector
            picker expects a narrower <code>search</code>/<code>fetch</code> tool
            pair and won't show the full toolset — use the connector from a normal
            chat.
          </p>
        </section>

        {/* Endpoint banner */}
        <div className="mb-10 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">
                MCP Server URL
              </div>
              <code className="text-sm text-[var(--color-primary)] font-mono break-all">
                {MCP_ENDPOINT_URL}
              </code>
            </div>
            <CopyButton value={MCP_ENDPOINT_URL} label="URL" />
          </div>
          <p className="text-xs text-[var(--color-text-muted)] mt-3 leading-relaxed">
            Use the <code>www.</code> host exactly as shown. The bare
            <code> contextspaces.ai</code> apex redirects, and some MCP clients
            drop credentials across a cross-host redirect.
          </p>
        </div>

        {/* Permissions */}
        <div className="mb-10 max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-sm text-[var(--color-text-secondary)] leading-relaxed">
          <strong className="text-[var(--color-text-bright)]">Permissions.</strong>{' '}
          ChatGPT sees only what your account can see — Contextspaces' RLS gates
          per-matter access regardless of which AI is asking. Revoke ChatGPT's
          access at any time from{' '}
          <strong className="text-[var(--color-text-bright)]">
            Settings → Connectors
          </strong>{' '}
          in ChatGPT.
        </div>

        {/* API path */}
        <section className="mb-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <h2 className="text-lg font-semibold text-[var(--color-text-bright)] mb-2"
              style={{ fontFamily: 'Playfair Display Variable, serif' }}>
            Calling GPT through the OpenAI API
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-5">
            The ChatGPT app can't take a token — but the OpenAI API can. The
            Responses API's <code>mcp</code> tool accepts arbitrary headers, so
            a connector token plugs Contextspaces into your own scripts and
            agents. Generate one below.
          </p>

          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !generating && newTokenName.trim()) handleGenerate(); }}
              placeholder="Label (e.g. 'GPT — Responses API')"
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
              No tokens yet. You don't need one for the ChatGPT app — only for
              the OpenAI API.
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
  const snippet = openaiResponsesSnippet(token);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl bg-[var(--color-surface-raised)] border border-[var(--color-border-strong)] rounded-xl shadow-2xl p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h3 className="text-2xl font-semibold text-[var(--color-text-bright)]" style={{ fontFamily: 'Playfair Display Variable, serif' }}>
              Token ready
            </h3>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">
              <span className="text-[var(--color-primary)]">{name}</span> —
              visible only now. Copy it before closing.
            </p>
          </div>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-bright)]">
            <X size={20} />
          </button>
        </div>

        <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-5">
          This token is for the{' '}
          <strong className="text-[var(--color-text-bright)]">OpenAI API</strong>,
          not the ChatGPT app — the app connects over OAuth and never asks for
          one.
        </p>

        <div className="mb-6">
          <label className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] block mb-2">Bearer token</label>
          <div className="flex items-center gap-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
            <code className="text-xs text-[var(--color-primary)] font-mono break-all flex-1">{token}</code>
            <CopyButton value={token} label="token" />
          </div>
        </div>

        <div className="mb-6">
          <label className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] block mb-2">
            Responses API request
          </label>
          <div className="relative bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
            <pre className="text-xs text-[var(--color-text)] font-mono whitespace-pre-wrap break-all">{snippet}</pre>
            <div className="absolute top-2 right-2">
              <CopyButton value={snippet} label="config" />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium rounded bg-[var(--color-primary)] text-[#0a0a0a] hover:bg-[var(--color-primary-hover)] transition">
            I have what I need — close
          </button>
        </div>
      </div>
    </div>
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

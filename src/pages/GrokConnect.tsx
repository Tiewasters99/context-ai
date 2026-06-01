// Grok MCP connection page — mirror of ClaudeConnect/GeminiConnect,
// tailored to xAI's Grok which exposes MCP via grok.com's settings
// (URL + Bearer token) and via the xAI API for SDK users.

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
import { useAuth } from '@/contexts/AuthContext';
import {
  generateConnectorToken,
  grokConfigSnippet,
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

export default function GrokConnect() {
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
            Connect to Grok
          </h1>
          <p className="mt-3 text-[var(--color-text-secondary)] max-w-2xl leading-relaxed">
            Wire Contextspaces into{' '}
            <strong className="text-[var(--color-text-bright)]">Grok</strong>{' '}
            via xAI's MCP support. Once connected, Grok can search your
            matters, pull pincites from your Vault, and act inside any
            workflow you point it at — same toolset Claude and Gemini get.
          </p>

          <div className="mt-7 max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-sm text-[var(--color-text-secondary)] leading-relaxed">
            <strong className="text-[var(--color-text-bright)]">Permissions.</strong>{' '}
            Grok only sees what your token authorises — and Contextspaces' RLS
            gates per-matter access regardless of which AI is asking. Revoke
            any token at any time and access stops immediately.
          </div>
        </header>

        {/* Walkthrough */}
        <section className="mb-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <h2 className="text-lg font-semibold text-[var(--color-text-bright)] mb-4"
              style={{ fontFamily: 'Playfair Display Variable, serif' }}>
            Grok, in three steps
          </h2>
          <ol className="space-y-3 text-sm text-[var(--color-text-secondary)] leading-relaxed">
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">1.</span>
              <span>
                Open{' '}
                <a href="https://grok.com" target="_blank" rel="noopener noreferrer"
                   className="text-[var(--color-primary)] hover:underline">
                  grok.com
                </a>
                {' '}and sign in.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">2.</span>
              <span>
                Generate a token below — you'll see the Contextspaces endpoint
                URL and a Bearer token.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">3.</span>
              <span>
                In Grok's settings, find the{' '}
                <strong className="text-[var(--color-text-bright)]">MCP Connectors</strong>{' '}
                (sometimes labelled Tools, Custom Servers, or Integrations
                depending on your build), add a new server, paste the URL and
                the token, and save.
              </span>
            </li>
          </ol>
          <p className="text-xs text-[var(--color-text-muted)] mt-5 leading-relaxed">
            xAI's MCP UI is still evolving; the exact menu name may differ in
            your build. If you're using the xAI API directly, the same URL +
            Bearer-token shape works in any HTTP MCP client.
          </p>
        </section>

        {/* Endpoint banner */}
        <div className="mb-10 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
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
              No tokens yet. Generate one above to connect Grok to your matters.
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl bg-[var(--color-surface-raised)] border border-[var(--color-border-strong)] rounded-xl shadow-2xl p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h3 className="text-2xl font-semibold text-[var(--color-text-bright)]" style={{ fontFamily: 'Playfair Display Variable, serif' }}>
              Token ready
            </h3>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">
              <span className="text-[var(--color-primary)]">{name}</span> —
              visible only now. Copy both values before closing.
            </p>
          </div>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-bright)]">
            <X size={20} />
          </button>
        </div>

        <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-5">
          In Grok's settings, open the{' '}
          <strong className="text-[var(--color-text-bright)]">MCP Connectors</strong>{' '}
          panel and add a new server with the URL and token below. Name it{' '}
          <em>Contextspaces</em>.
        </p>

        <div className="mb-4">
          <label className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] block mb-2">Endpoint URL</label>
          <div className="flex items-center gap-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
            <code className="text-xs text-[var(--color-primary)] font-mono break-all flex-1">{MCP_ENDPOINT_URL}</code>
            <CopyButton value={MCP_ENDPOINT_URL} label="URL" />
          </div>
        </div>

        <div className="mb-6">
          <label className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] block mb-2">Bearer token</label>
          <div className="flex items-center gap-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
            <code className="text-xs text-[var(--color-primary)] font-mono break-all flex-1">{token}</code>
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
                <pre className="text-xs text-[var(--color-text)] font-mono whitespace-pre-wrap break-all">{snippet}</pre>
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

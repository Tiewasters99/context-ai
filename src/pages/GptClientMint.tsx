// /app/connections/gpt-client — mint the OAuth client for a Custom GPT.
//
// The one-time set-up step for docs/specs/GPT-ACTIONS-2026-09-29.md §2, done
// here rather than with scripts/register-oauth-client.mjs because the
// signing secret is a Sensitive variable in Vercel and only the server can
// use it. The page posts the GPT's name and callback URLs to
// /api/oauth-client-mint with the signed-in session; the server answers with
// a client id and a client secret, shown ONCE with copy buttons. Only
// accounts listed in OAUTH_CLIENT_ADMIN_EMAILS get an answer; everyone else
// sees the refusal in plain words. Nothing is stored anywhere.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, Copy, KeyRound, AlertCircle, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface Minted { client_id: string; client_secret: string; client_name: string; redirect_uris: string[]; minted_at: string }

const serif = { fontFamily: 'Playfair Display Variable, serif' } as const;

function CopyField({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked; the text is selectable */ }
  };
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">{label}</span>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 text-xs text-[var(--color-primary)] hover:underline">
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <code className={`block break-all text-[12px] leading-relaxed ${secret ? 'text-[var(--color-text-bright)]' : 'text-[var(--color-text)]'}`}>{value}</code>
    </div>
  );
}

export default function GptClientMint() {
  const [name, setName] = useState('Contextspaces GPT');
  const [redirects, setRedirects] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<Minted | null>(null);

  const mint = async () => {
    setError(null);
    const redirect_uris = redirects.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!redirect_uris.length) { setError('Paste at least one callback URL from the GPT builder.'); return; }
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { setError('Sign in to Contextspaces first.'); return; }
      const res = await fetch('/api/oauth-client-mint', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ client_name: name.trim(), redirect_uris }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.detail || body.error || `The server refused (${res.status}).`);
        return;
      }
      setMinted(body as Minted);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen text-[var(--color-text)]">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <Link to="/app/connections/chatgpt" className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)] transition mb-8">
          <ArrowLeft size={14} /> Back to ChatGPT
        </Link>

        <header className="mb-8">
          <h1 className="text-4xl font-serif tracking-tight text-[var(--color-text-bright)]" style={serif}>Mint a GPT client</h1>
          <p className="mt-3 text-[var(--color-text-secondary)] max-w-2xl leading-relaxed">
            A Custom GPT signs in to Contextspaces with an OAuth client id and secret. This page mints that pair on the
            server. The secret is shown once, here, and then exists only where you paste it: the GPT builder's
            Authentication panel. Only the account owner's email may mint.
          </p>
        </header>

        {!minted ? (
          <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-5">
            <ol className="text-sm text-[var(--color-text-secondary)] leading-relaxed space-y-2">
              <li className="flex gap-3"><span className="text-[var(--color-primary)] font-mono shrink-0">1.</span><span>In the GPT builder, add the Action (import <code>https://www.contextspaces.ai/api/gpt/openapi.json</code>), choose <strong className="text-[var(--color-text-bright)]">OAuth</strong>, and save once. The builder then shows the <strong className="text-[var(--color-text-bright)]">callback URL</strong>.</span></li>
              <li className="flex gap-3"><span className="text-[var(--color-primary)] font-mono shrink-0">2.</span><span>Paste that URL below, one per line. Add the <code>chatgpt.com</code> twin of the same path as a second line.</span></li>
              <li className="flex gap-3"><span className="text-[var(--color-primary)] font-mono shrink-0">3.</span><span>Mint, copy both values into the builder, then leave this page. They are not shown again.</span></li>
            </ol>
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">Client name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200}
                className="mt-1.5 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-text-bright)] outline-none focus:border-[var(--color-primary)]" />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">Callback URLs (one per line)</span>
              <textarea value={redirects} onChange={(e) => setRedirects(e.target.value)} rows={3} spellCheck={false}
                placeholder={'https://chat.openai.com/aip/g-XXXXXXXX/oauth/callback\nhttps://chatgpt.com/aip/g-XXXXXXXX/oauth/callback'}
                className="mt-1.5 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-[12px] font-mono text-[var(--color-text-bright)] outline-none focus:border-[var(--color-primary)]" />
            </label>
            {error && (
              <p className="text-sm text-red-400 inline-flex items-start gap-2"><AlertCircle size={15} className="mt-0.5 shrink-0" />{error}</p>
            )}
            <button type="button" onClick={mint} disabled={busy}
              className="inline-flex items-center gap-2 rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-black disabled:opacity-60">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} {busy ? 'Minting…' : 'Mint the client'}
            </button>
          </section>
        ) : (
          <section className="space-y-4">
            <div className="rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-primary-light)] px-5 py-4 text-sm text-[var(--color-text-secondary)] leading-relaxed">
              <strong className="text-[var(--color-text-bright)]">Shown once.</strong> Paste both into the GPT builder now (Authentication → OAuth →
              Client ID and Client Secret). Then set Authorization URL <code>https://www.contextspaces.ai/oauth/authorize</code>, Token URL{' '}
              <code>https://www.contextspaces.ai/api/oauth-token</code>, Scope <code>contextspaces</code>, Token Exchange Method <em>Default (POST request)</em>.
              If you lose the secret, mint again and replace both values in the builder.
            </div>
            <CopyField label="Client ID" value={minted.client_id} />
            <CopyField label="Client Secret" value={minted.client_secret} secret />
            <p className="text-xs text-[var(--color-text-secondary)]">
              {minted.client_name} · callbacks: {minted.redirect_uris.join(' , ')} · minted {new Date(minted.minted_at).toLocaleString()}
            </p>
            <button type="button" onClick={() => { setMinted(null); setRedirects(''); }} className="text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)] underline underline-offset-2">
              Done — clear this page
            </button>
          </section>
        )}
      </div>
    </div>
  );
}

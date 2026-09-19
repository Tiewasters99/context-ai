// OAuth authorization endpoint — the user-visible part of the OAuth flow.
//
// The /.well-known/oauth-authorization-server metadata advertises this URL
// (https://www.contextspaces.ai/oauth/authorize) as the authorization_endpoint.
// OAuth clients (claude.ai's Custom Connector UI, Claude Desktop's OAuth
// flow) navigate the user's browser here with the OAuth params in the
// query string. We:
//   1. Validate the params.
//   2. Ensure the user is signed in to Contextspaces — inline if not, by
//      password or by Google / Apple. The SSO path parks the authorize
//      request (src/lib/oauthAuthorizeResume.ts) so /auth/callback can put
//      the visitor back here with it intact.
//   3. Show a plain-language consent screen enumerating what the connected
//      client can and cannot do with the MCP tools (lib/mcp-core.mjs TOOLS).
//   4. On Approve, POST the Supabase access token + OAuth params to
//      /api/oauth-approve, which mints the auth code and returns the
//      redirect URL. The page then navigates the browser to that URL,
//      handing control back to the OAuth client.
//   5. On Cancel, redirect to the client's redirect_uri with
//      error=access_denied (per OAuth 2.1).

import { useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Shield, Loader2, AlertCircle, Check, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { stashAuthorizeRequest } from '@/lib/oauthAuthorizeResume';

// Decode (without verifying) a JWT's payload. We use this only to display
// the registered client_name to the user before they consent. The /approve
// endpoint verifies the signature for real.
function readJwtPayload(jwt: string): Record<string, any> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export default function OAuthAuthorize() {
  const [params] = useSearchParams();
  const { user, loading: authLoading, signInWithEmail } = useAuth();

  // Sign-in state (only shown when user isn't authenticated).
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [ssoBusy, setSsoBusy] = useState<'google' | 'apple' | null>(null);

  // Consent submission state.
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Pull the OAuth params once.
  const oauth = useMemo(() => ({
    response_type: params.get('response_type'),
    client_id: params.get('client_id') || '',
    redirect_uri: params.get('redirect_uri') || '',
    code_challenge: params.get('code_challenge') || '',
    code_challenge_method: params.get('code_challenge_method') || 'S256',
    state: params.get('state') || '',
    resource: params.get('resource') || '',
    scope: params.get('scope') || 'mcp',
  }), [params]);

  const paramErrors: string[] = [];
  if (oauth.response_type !== 'code') paramErrors.push('response_type must be "code"');
  if (!oauth.client_id) paramErrors.push('client_id missing');
  if (!oauth.redirect_uri) paramErrors.push('redirect_uri missing');
  if (!oauth.code_challenge) paramErrors.push('code_challenge missing (PKCE required)');
  if (oauth.code_challenge_method !== 'S256') paramErrors.push('only S256 code_challenge_method is supported');

  const clientMeta = useMemo(() => readJwtPayload(oauth.client_id), [oauth.client_id]);
  const clientName = clientMeta?.client_name || 'an MCP client';

  // Cancel → redirect back with error.
  const cancel = () => {
    if (!oauth.redirect_uri) { window.history.back(); return; }
    const url = new URL(oauth.redirect_uri);
    url.searchParams.set('error', 'access_denied');
    if (oauth.state) url.searchParams.set('state', oauth.state);
    window.location.replace(url.toString());
  };

  // Approve → POST to /api/oauth-approve with the Supabase token in Authorization.
  const approve = async () => {
    if (submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error('Not signed in (no Supabase session)');

      const res = await fetch('/api/oauth-approve', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(oauth),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.detail || body?.error || `approve failed (${res.status})`);
      if (!body?.redirect) throw new Error('approve returned no redirect URL');
      window.location.replace(body.redirect);
    } catch (err: any) {
      setSubmitError(err?.message ?? 'approve failed');
      setSubmitting(false);
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (signingIn) return;
    setSignInError(null);
    setSigningIn(true);
    try {
      const { error } = await signInWithEmail(email, password);
      if (error) throw new Error(error.message);
      // useAuth will update user; the consent screen renders automatically.
    } catch (err: any) {
      setSignInError(err?.message ?? 'sign-in failed');
    } finally {
      setSigningIn(false);
    }
  };

  // Google / Apple sign-in. An account created with SSO has no password to
  // type here, so without this a Google user simply cannot finish a
  // connector authorization. We call supabase directly rather than
  // useAuth()'s helpers only to park the authorize request first: the
  // provider round trip returns to /auth/callback, which replays the whole
  // request — every OAuth param, the PKCE challenge, the client's state —
  // back onto this consent screen. `window.location.origin` keeps the
  // return address same-origin by construction.
  const handleSso = async (provider: 'google' | 'apple') => {
    if (ssoBusy || signingIn) return;
    setSignInError(null);
    setSsoBusy(provider);
    stashAuthorizeRequest(window.location.search);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setSignInError(error.message);
      setSsoBusy(null);
    }
    // On success the browser is already navigating to the provider.
  };

  // -- Render ----------------------------------------------------------------

  if (paramErrors.length > 0) {
    return (
      <Frame>
        <h1 className="text-[20px] font-semibold text-white mb-2 flex items-center gap-2">
          <AlertCircle size={18} className="text-red-300" /> Invalid request
        </h1>
        <p className="text-[13px] text-white/70 mb-4">This OAuth request is missing or has invalid parameters:</p>
        <ul className="space-y-1 text-[12px] text-red-300/90 list-disc pl-5 mb-4">
          {paramErrors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
        <Link to="/app" className="text-[12px] text-[#e8b84a] hover:underline">Back to Contextspaces</Link>
      </Frame>
    );
  }

  if (authLoading) {
    return <Frame><p className="text-[13px] text-white/60 text-center"><Loader2 size={14} className="inline animate-spin mr-2" /> Loading…</p></Frame>;
  }

  if (!user) {
    return (
      <Frame>
        <h1 className="text-[18px] font-semibold text-white mb-2 flex items-center gap-2">
          <Shield size={16} className="text-[#e8b84a]" /> Sign in to continue
        </h1>
        <p className="text-[12px] text-white/60 mb-5">
          <span className="text-white">{clientName}</span> wants to access your Contextspaces matters. Sign in to your Contextspaces account first.
        </p>
        <form onSubmit={handleSignIn} className="space-y-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email"
            autoComplete="email"
            required
            className="w-full px-3 py-2 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[13px] text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-[#e8b84a]"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password"
            autoComplete="current-password"
            required
            className="w-full px-3 py-2 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[13px] text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-[#e8b84a]"
          />
          {signInError && <p className="text-[12px] text-red-300 flex items-start gap-1.5"><AlertCircle size={12} className="shrink-0 mt-0.5" /> {signInError}</p>}
          <button
            type="submit"
            disabled={signingIn || !!ssoBusy || !email || !password}
            className="w-full py-2 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[13px] font-bold transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {signingIn && <Loader2 size={13} className="animate-spin" />}
            {signingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-[rgba(255,255,255,0.08)]" />
          <span className="text-[11px] text-white/40">or continue with</span>
          <div className="flex-1 h-px bg-[rgba(255,255,255,0.08)]" />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleSso('google')}
            disabled={signingIn || !!ssoBusy}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border border-[rgba(255,255,255,0.1)] text-[13px] text-white/80 hover:bg-[rgba(255,255,255,0.04)] transition-colors disabled:opacity-40"
          >
            {ssoBusy === 'google'
              ? <Loader2 size={13} className="animate-spin" />
              : <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>}
            Google
          </button>
          <button
            type="button"
            onClick={() => handleSso('apple')}
            disabled={signingIn || !!ssoBusy}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border border-[rgba(255,255,255,0.1)] text-[13px] text-white/80 hover:bg-[rgba(255,255,255,0.04)] transition-colors disabled:opacity-40"
          >
            {ssoBusy === 'apple'
              ? <Loader2 size={13} className="animate-spin" />
              : <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" /></svg>}
            Apple
          </button>
        </div>
        <p className="text-[11px] text-white/40 mt-4 text-center">
          You'll come straight back to this screen to approve or decline.
        </p>
        <p className="text-[11px] text-white/40 mt-2 text-center">
          No account yet? <Link to="/auth" className="text-[#e8b84a] hover:underline">Create one</Link>, then return here.
        </p>
      </Frame>
    );
  }

  // Signed in — consent screen.
  return (
    <Frame>
      <h1 className="text-[18px] font-semibold text-white mb-2 flex items-center gap-2">
        <Shield size={16} className="text-[#e8b84a]" /> Authorize {clientName}
      </h1>
      <p className="text-[13px] text-white/70 mb-4">
        <span className="text-white font-medium">{clientName}</span> is requesting access to your Contextspaces account
        as <span className="text-[#e8b84a]">{user.email}</span>.
      </p>
      <div className="rounded-lg border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.03)] p-4 mb-4 space-y-2">
        <p className="text-[11px] font-semibold text-white/60 uppercase tracking-wider">It will be able to:</p>
        <ul className="space-y-1.5 text-[12px] text-white/80">
          <li className="flex items-start gap-2"><Check size={12} className="text-emerald-400 shrink-0 mt-0.5" /> Read and search every matter your account can open — list them, search and grep their documents, and pull passages and outlines with page citations.</li>
          <li className="flex items-start gap-2"><Check size={12} className="text-emerald-400 shrink-0 mt-0.5" /> Create matters, sub-matters and folders, and file new documents into them.</li>
          <li className="flex items-start gap-2"><Check size={12} className="text-emerald-400 shrink-0 mt-0.5" /> Move and copy stored documents between matters, and stage copies in your Sandbox.</li>
          <li className="flex items-start gap-2"><Check size={12} className="text-emerald-400 shrink-0 mt-0.5" /> File new work product: merged PDFs, edited <em>copies</em> of a PDF (pages reordered, rotated or dropped), decks and charts.</li>
          <li className="flex items-start gap-2"><Check size={12} className="text-emerald-400 shrink-0 mt-0.5" /> Re-index a stored document, and update a matter's status, headline and next action.</li>
        </ul>
        <p className="text-[11px] font-semibold text-white/60 uppercase tracking-wider pt-2">It will NOT be able to:</p>
        <ul className="space-y-1.5 text-[12px] text-white/80">
          <li className="flex items-start gap-2"><X size={12} className="text-red-300 shrink-0 mt-0.5" /> Delete a document or a matter. There is no tool that deletes your work.</li>
          <li className="flex items-start gap-2"><X size={12} className="text-red-300 shrink-0 mt-0.5" /> Overwrite a stored original. Every edit is filed as a new document; the source stays exactly as it was.</li>
          <li className="flex items-start gap-2"><X size={12} className="text-red-300 shrink-0 mt-0.5" /> See a sealed (SecureSpace) matter. Sealed matters are invisible to every outside connector.</li>
          <li className="flex items-start gap-2"><X size={12} className="text-red-300 shrink-0 mt-0.5" /> See matters you aren't a member of — it reads the database as you, under the same rules as your own browser session.</li>
          <li className="flex items-start gap-2"><X size={12} className="text-red-300 shrink-0 mt-0.5" /> Touch your account, your billing, or who a matter is shared with.</li>
        </ul>
      </div>
      <p className="text-[11px] text-white/40 mb-4">
        To end this access, remove the Contextspaces connector in {clientName}, which is what stops it
        asking for more. A token already issued stays valid for 12 hours, and the renewal token that
        comes with it is replaced each time the client uses it — so access ends when the client stops,
        not on a fixed date. Revoking one connection from inside Contextspaces is not built yet.
      </p>
      {submitError && (
        <p className="text-[12px] text-red-300 mb-3 flex items-start gap-1.5">
          <AlertCircle size={12} className="shrink-0 mt-0.5" /> {submitError}
        </p>
      )}
      <div className="flex gap-2">
        <button
          onClick={cancel}
          disabled={submitting}
          className="flex-1 py-2 rounded-lg border border-[rgba(255,255,255,0.1)] text-[13px] text-white/80 hover:bg-[rgba(255,255,255,0.04)] transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          onClick={approve}
          disabled={submitting}
          className="flex-1 py-2 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[13px] font-bold transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {submitting && <Loader2 size={13} className="animate-spin" />}
          {submitting ? 'Authorizing…' : 'Allow access'}
        </button>
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ backgroundColor: '#0a0a10' }}>
      <div className="w-full max-w-md rounded-2xl border border-[rgba(255,255,255,0.08)] p-6" style={{ backgroundColor: 'rgba(20,20,28,0.95)' }}>
        <div className="mb-6 text-center">
          <span className="text-[18px] font-semibold tracking-tight">
            <span className="text-white">Context</span><span className="text-[#d4a054]">spaces</span><span className="text-white">.ai</span>
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

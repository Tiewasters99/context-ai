// OAuth authorization endpoint — the user-visible part of the OAuth flow.
//
// The /.well-known/oauth-authorization-server metadata advertises this URL
// (https://www.contextspaces.ai/oauth/authorize) as the authorization_endpoint.
// OAuth clients (claude.ai's Custom Connector UI, Claude Desktop's OAuth
// flow) navigate the user's browser here with the OAuth params in the
// query string. We:
//   1. Validate the params.
//   2. Ensure the user is signed in to Contextspaces (inline sign-in if not).
//   3. Show a plain-language consent screen ("Allow <client> to read your
//      matters via the MCP retrieval tools?").
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

  // Sign-in form state (only shown when user isn't authenticated).
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

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
            disabled={signingIn || !email || !password}
            className="w-full py-2 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[13px] font-bold transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {signingIn && <Loader2 size={13} className="animate-spin" />}
            {signingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="text-[11px] text-white/40 mt-4 text-center">
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
          <li className="flex items-start gap-2"><Check size={12} className="text-emerald-400 shrink-0 mt-0.5" /> List the matters you own or have been added to.</li>
          <li className="flex items-start gap-2"><Check size={12} className="text-emerald-400 shrink-0 mt-0.5" /> Search and read passages from documents in those matters.</li>
          <li className="flex items-start gap-2"><Check size={12} className="text-emerald-400 shrink-0 mt-0.5" /> Pull the outline of any document in those matters.</li>
        </ul>
        <p className="text-[11px] font-semibold text-white/60 uppercase tracking-wider pt-2">It will NOT be able to:</p>
        <ul className="space-y-1.5 text-[12px] text-white/80">
          <li className="flex items-start gap-2"><X size={12} className="text-red-300 shrink-0 mt-0.5" /> Modify or delete any document or passage.</li>
          <li className="flex items-start gap-2"><X size={12} className="text-red-300 shrink-0 mt-0.5" /> See matters you aren't a member of.</li>
          <li className="flex items-start gap-2"><X size={12} className="text-red-300 shrink-0 mt-0.5" /> Access your account on any other Anthropic surface.</li>
        </ul>
      </div>
      <p className="text-[11px] text-white/40 mb-4">
        You can revoke this access anytime — sign out from {clientName}, or rotate the secret in your Contextspaces deployment.
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

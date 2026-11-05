import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Lock, ArrowLeft, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { verifiedFactors, confirmFactor, type VerifiedFactor } from '@/lib/second-factor';

// Landing page users hit after clicking the password-reset link in their
// email. Supabase puts a recovery session into the URL fragment on arrival;
// its client sets an auth.uid() for the limited duration of that session,
// which is enough to authorize updateUser({ password }). The form below
// captures a new password and commits it.
//
// Known quirk: if the user opens the reset link in a different browser
// than the one they requested it from, the recovery session still works
// because the token-in-URL carries its own context. No extra wiring needed.

export default function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [hasRecoverySession, setHasRecoverySession] = useState(false);
  // An account with a second factor may only change its password from a
  // session that has passed that factor (Supabase: "AAL2 session is required").
  // The recovery link gives a first-factor session, so the factor is asked
  // for here, before the new password.
  const [factor, setFactor] = useState<VerifiedFactor | null>(null);
  const [stepUp, setStepUp] = useState<'checking' | 'none' | 'needed' | 'done'>('checking');
  const [code, setCode] = useState('');

  async function askForFactor() {
    const all = await verifiedFactors();
    const f = all.find((x) => x.factor_type === 'totp') ?? all[0] ?? null;
    setFactor(f);
    setStepUp(f ? 'needed' : 'none');
  }
  useEffect(() => {
    if (!hasRecoverySession) return;
    let live = true;
    void (async () => {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (!live) return;
      if (data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2') await askForFactor();
      else setStepUp('none');
    })();
    return () => { live = false; };
  }, [hasRecoverySession]);

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!factor) return;
    setError('');
    setLoading(true);
    const fail = await confirmFactor(factor, code);
    setLoading(false);
    if (fail) { setError(fail); return; }
    setCode('');
    setStepUp('done');
  }

  // Confirm the page actually has a recovery session (otherwise the user
  // landed here directly without clicking the email link). onAuthStateChange
  // emits 'PASSWORD_RECOVERY' on arrival.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setHasRecoverySession(true);
    });
    // Also accept already-present session in case the event fired before mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setHasRecoverySession(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      if (/aal2/i.test(error.message)) { await askForFactor(); setError('Confirm your second factor first.'); return; }
      setError(error.message);
      return;
    }
    setDone(true);
    setTimeout(() => navigate('/app', { replace: true }), 1500);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a10] px-4">
      <div className="w-full max-w-sm bg-[rgba(10,10,16,0.72)] backdrop-blur-[24px] rounded-2xl shadow-sm border border-[rgba(255,255,255,0.08)] p-8">
        <Link
          to="/auth"
          className="inline-flex items-center gap-1 text-sm text-white/70 hover:text-white mb-4"
        >
          <ArrowLeft size={14} /> Back to sign in
        </Link>

        <h1
          className="text-2xl font-semibold text-white mb-2"
          style={{ fontFamily: '"Playfair Display Variable", serif' }}
        >
          Set a new password
        </h1>
        <p className="text-sm text-white/60 mb-6">
          Choose a password you'll remember. At least 8 characters.
        </p>

        {!hasRecoverySession && !done && (
          <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm">
            Waiting for recovery session. If this page doesn't unlock in a few
            seconds, your reset link may have expired — request a new one from
            the sign-in page.
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        {done ? (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
            <CheckCircle2 size={16} />
            Password updated. Redirecting to app…
          </div>
        ) : hasRecoverySession && stepUp === 'needed' && factor ? (
          <form onSubmit={handleConfirm} className="space-y-4">
            <p className="text-sm text-white/70">
              {factor.factor_type === 'webauthn'
                ? 'Your account has a passkey. Confirm it, then set the new password.'
                : 'Your account has an authenticator app. Enter its six-digit code, then set the new password.'}
            </p>
            {factor.factor_type !== 'webauthn' && (
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Six-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg border border-[rgba(255,255,255,0.06)] bg-[#1c1c26] text-sm text-white placeholder-[#8a8693] focus:outline-none focus:ring-2 focus:ring-[#d4a054] focus:border-transparent"
              />
            )}
            <button
              type="submit"
              disabled={loading || (factor.factor_type !== 'webauthn' && code.replace(/\s+/g, '').length < 6)}
              className="w-full py-2.5 rounded-lg bg-[#d4a054] hover:bg-[#c4903a] text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? 'Checking…' : factor.factor_type === 'webauthn' ? 'Use my passkey' : 'Confirm the code'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8a8693]" />
              <input
                type="password"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-[rgba(255,255,255,0.06)] bg-[#1c1c26] text-sm text-white placeholder-[#8a8693] focus:outline-none focus:ring-2 focus:ring-[#d4a054] focus:border-transparent"
              />
            </div>
            <div className="relative">
              <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8a8693]" />
              <input
                type="password"
                placeholder="Confirm new password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-[rgba(255,255,255,0.06)] bg-[#1c1c26] text-sm text-white placeholder-[#8a8693] focus:outline-none focus:ring-2 focus:ring-[#d4a054] focus:border-transparent"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !hasRecoverySession}
              className="w-full py-2.5 rounded-lg bg-[#d4a054] hover:bg-[#c4903a] text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? 'Saving…' : 'Set new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

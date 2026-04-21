import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Lock, ArrowLeft, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';

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

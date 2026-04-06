import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, Lock, User, ArrowLeft } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

type View = 'signin' | 'signup' | 'reset';

export default function Auth() {
  const navigate = useNavigate();
  const { signInWithEmail, signUpWithEmail, signInWithGoogle, signInWithApple, resetPassword } = useAuth();

  const [view, setView] = useState<View>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      if (view === 'signin') {
        const { error } = await signInWithEmail(email, password);
        if (error) { setError(error.message); return; }
        navigate('/app');
      } else if (view === 'signup') {
        const { error } = await signUpWithEmail(email, password, displayName);
        if (error) { setError(error.message); return; }
        setSuccess('Check your email to confirm your account.');
      } else {
        const { error } = await resetPassword(email);
        if (error) { setError(error.message); return; }
        setSuccess('Password reset link sent to your email.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleOAuth = async (provider: 'google' | 'apple') => {
    setError('');
    const fn = provider === 'google' ? signInWithGoogle : signInWithApple;
    const { error } = await fn();
    if (error) setError(error.message);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-8">
          <Link to="/" className="text-3xl font-bold text-slate-900 tracking-tight">
            Context<span className="text-indigo-500">.ai</span>
          </Link>
          <p className="text-slate-500 mt-2">Your workspace, simplified.</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          {/* View tabs (sign in / sign up) */}
          {view !== 'reset' && (
            <div className="flex bg-slate-100 rounded-lg p-1 mb-6">
              <button
                onClick={() => { setView('signin'); setError(''); setSuccess(''); }}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                  view === 'signin' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Sign In
              </button>
              <button
                onClick={() => { setView('signup'); setError(''); setSuccess(''); }}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                  view === 'signup' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Sign Up
              </button>
            </div>
          )}

          {view === 'reset' && (
            <button
              onClick={() => { setView('signin'); setError(''); setSuccess(''); }}
              className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"
            >
              <ArrowLeft size={14} /> Back to sign in
            </button>
          )}

          {/* Error / Success messages */}
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
              {error}
            </div>
          )}
          {success && (
            <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm">
              {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {view === 'signup' && (
              <div className="relative">
                <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Display name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                  className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
            )}

            <div className="relative">
              <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>

            {view !== 'reset' && (
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
            )}

            {view === 'signin' && (
              <div className="text-right">
                <button
                  type="button"
                  onClick={() => { setView('reset'); setError(''); setSuccess(''); }}
                  className="text-sm text-indigo-500 hover:text-indigo-600"
                >
                  Forgot password?
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loading ? 'Please wait...' : view === 'reset' ? 'Send Reset Link' : view === 'signin' ? 'Sign In' : 'Create Account'}
            </button>
          </form>

          {view !== 'reset' && (
            <>
              <div className="flex items-center gap-3 my-6">
                <div className="flex-1 h-px bg-slate-200" />
                <span className="text-xs text-slate-400">or continue with</span>
                <div className="flex-1 h-px bg-slate-200" />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => handleOAuth('google')}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                  Google
                </button>
                <button
                  onClick={() => handleOAuth('apple')}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
                  </svg>
                  Apple
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

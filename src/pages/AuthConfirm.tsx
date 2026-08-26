import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { EmailOtpType } from '@supabase/supabase-js';

// Scanner-proof landing for auth email links. The email template carries
// token_hash={{ .TokenHash }} instead of a one-time action link, so mail
// scanners that pre-fetch URLs can't consume the token — it is only redeemed
// here, by an explicit verifyOtp call on the user's real click.
//
// Expected params: ?token_hash=...&type=recovery|email|magiclink[&next=/path]
// On success we navigate to `next` (default /auth/reset for recovery,
// /app otherwise) with a live session in place.

export default function AuthConfirm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    // React 18 StrictMode double-invokes effects; verifyOtp consumes the
    // token, so the second invocation must not fire.
    if (ran.current) return;
    ran.current = true;

    const token_hash = params.get('token_hash');
    const type = (params.get('type') || 'recovery') as EmailOtpType;
    const next = params.get('next') || (type === 'recovery' ? '/auth/reset' : '/app');

    if (!token_hash) {
      setError('This link is missing its token. Request a new one from the sign-in page.');
      return;
    }

    supabase.auth.verifyOtp({ type, token_hash }).then(({ error }) => {
      if (error) {
        setError(
          error.message.toLowerCase().includes('expired')
            ? 'This link has expired or was already used. Request a fresh one from the sign-in page.'
            : error.message
        );
        return;
      }
      navigate(next, { replace: true });
    });
  }, [navigate, params]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a10] px-4">
      <div className="w-full max-w-sm bg-[rgba(10,10,16,0.72)] backdrop-blur-[24px] rounded-2xl shadow-sm border border-[rgba(255,255,255,0.08)] p-8">
        {error ? (
          <>
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
            <Link
              to="/auth"
              className="inline-flex items-center gap-1 text-sm text-white/70 hover:text-white"
            >
              <ArrowLeft size={14} /> Back to sign in
            </Link>
          </>
        ) : (
          <p className="text-sm text-white/60">Verifying your link…</p>
        )}
      </div>
    </div>
  );
}

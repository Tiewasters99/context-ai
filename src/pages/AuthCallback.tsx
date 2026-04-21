import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Spinner from '@/components/ui/Spinner';
import { useAuth } from '@/contexts/AuthContext';

// Landing page after OAuth providers redirect the user back with a code.
// Supabase's client picks up the session from the URL automatically via
// onAuthStateChange (wired up in AuthContext); we just have to wait for
// it to fire, then route the user into the app. If something goes wrong
// (denied consent, expired code), fall back to the auth page with an error.
export default function AuthCallback() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 4000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (loading) return;
    if (user) {
      navigate('/app', { replace: true });
    } else if (waited) {
      navigate('/auth?error=oauth_failed', { replace: true });
    }
  }, [loading, user, waited, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a10]">
      <div className="text-center">
        <Spinner size="lg" />
        <p className="mt-4 text-sm text-white/70">Signing you in…</p>
      </div>
    </div>
  );
}

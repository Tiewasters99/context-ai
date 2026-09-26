// Minimal Settings surface. The sidebar has linked to /app/settings since the
// shell was built; until now the route didn't exist and the links 404'd. This
// page covers the essentials (account, billing, sign out, pointer to
// Connections) and grows as real preferences land.
//
// Account also holds the second factor and the devices list (S1,
// docs/specs/SECURITY-BUILD-2026-09-26.md). ?enrol=required is where the
// sign-in lands someone who must add a factor before the rest of the app.

import { Link, useSearchParams } from 'react-router-dom';
import { Plug, LogOut, ChevronRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import BillingSection from '@/components/billing/BillingSection';
import SecondFactorSection from '@/components/account/SecondFactorSection';
import DevicesSection from '@/components/account/DevicesSection';
import { useFactorStatus } from '@/hooks/useFactorStatus';

export default function Settings() {
  const { user, signOut } = useAuth();
  const [params] = useSearchParams();
  const status = useFactorStatus(user?.id);
  const enrolRequired = params.get('enrol') === 'required' && status?.has_factor === false;

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold text-[var(--color-text)]">Settings</h1>
      {enrolRequired && (
        <p className="mt-3 text-sm text-[#f0dfa8]">
          Your account needs a second factor before the rest of Contextspaces opens. Add one below —
          it takes a minute.
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Account
        </h2>
        <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
          <div className="px-4 py-3">
            <div className="text-[11px] text-[var(--color-text-muted)]">Signed in as</div>
            <div className="text-sm text-[var(--color-text)]">{user?.email ?? '—'}</div>
          </div>
          <button
            onClick={() => signOut()}
            className="w-full flex items-center gap-2 px-4 py-3 text-sm text-[#f87171] hover:bg-white/5 transition-colors text-left"
          >
            <LogOut size={15} strokeWidth={1.75} />
            Sign out
          </button>
        </div>
        <SecondFactorSection />
        <DevicesSection />
      </section>

      <BillingSection />

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Integrations
        </h2>
        <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <Link
            to="/app/connections"
            className="flex items-center justify-between px-4 py-3 text-sm text-[var(--color-text)] hover:bg-white/5 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Plug size={15} strokeWidth={1.75} />
              Connections
            </span>
            <ChevronRight size={15} className="text-[var(--color-text-muted)]" />
          </Link>
        </div>
        <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">
          Claude, Gemini, Grok, Gmail, Google Calendar, and Microsoft 365 are managed from
          Connections.
        </p>
      </section>
    </div>
  );
}

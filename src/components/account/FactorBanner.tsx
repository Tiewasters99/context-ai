// The quiet line at the top of the app about the second factor (E2).
//
// Two things it can say, and it says at most one:
//
//   * "Sealed matters are hidden until you confirm it's you." — migration 094
//     hides a sealed matter from a session that has not confirmed a factor,
//     so the sidebar and dashboard simply do not list them. Silence there
//     would read as "your matter is gone". This names no matter and counts
//     none; it says there is something to confirm, and confirms it in place.
//
//   * "A second factor will be required for your account from 15 October." —
//     for the people E2 names (they run a workspace, or work in a sealed
//     matter) who have not added one. Persistent until they do, and quiet: it
//     never covers the page and never interrupts anything.
//
// Nothing renders until the database has answered, and nothing ever renders
// if it cannot (migration 094 not pasted).

import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useFactorStatus } from '@/hooks/useFactorStatus';
import { useServerspacesRefresh } from '@/hooks/useServerspaces';
import { longDate } from '@/lib/second-factor';
import StepUpPrompt from './StepUpPrompt';

const STRIP =
  'mx-3 sm:mx-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-[12px] leading-snug';

export default function FactorBanner() {
  const { user } = useAuth();
  const status = useFactorStatus(user?.id);
  const location = useLocation();
  const refreshServerspaces = useServerspacesRefresh();
  const [confirming, setConfirming] = useState(false);

  if (!status) return null;

  if (status.sealed_waiting && status.has_factor) {
    if (confirming) {
      return (
        <div className="mx-3 sm:mx-4 mt-3">
          <StepUpPrompt
            mode="stepup"
            heading="Sealed matters are hidden until you confirm it’s you."
            onConfirmed={() => { setConfirming(false); refreshServerspaces(); }}
          />
        </div>
      );
    }
    return (
      <div role="status" className={`${STRIP} border-[#5aa88f]/30 bg-[#12211c]/80 text-[#bfe0d2]`}>
        <Lock size={13} className="text-[#5aa88f] shrink-0" />
        <span className="flex-1">Sealed matters are hidden until you confirm it’s you.</span>
        <button
          onClick={() => setConfirming(true)}
          className="underline underline-offset-2 decoration-[#5aa88f]/60 hover:text-[#d7eee4]"
        >
          Confirm
        </button>
      </div>
    );
  }

  if (status.required && !status.has_factor && !location.pathname.startsWith('/app/settings')) {
    return (
      <div role="status" className={`${STRIP} border-[#e8b84a]/25 bg-[#2a2412]/70 text-[#f0dfa8]`}>
        <span className="flex-1">
          {!status.in_force
            ? `A second factor will be required for your account from ${longDate(status.required_from)}.`
            : 'A second factor is required for your account.'}
        </span>
        <Link
          to="/app/settings#second-factor"
          className="underline underline-offset-2 decoration-[#e8b84a]/60 hover:text-[#fff3cf]"
        >
          Add one
        </Link>
      </div>
    );
  }

  return null;
}

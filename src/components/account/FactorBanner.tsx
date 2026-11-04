// The quiet line at the top of the app about the second factor.
//
// One thing it can say: "Sealed matters are hidden until you confirm it's
// you." Migration 094 hides a sealed matter from a session that has not
// confirmed a factor, so the sidebar and dashboard simply do not list them.
// Silence there would read as "your matter is gone". This names no matter
// and counts none; it says there is something to confirm, and confirms it in
// place.
//
// It no longer says "a second factor is required for your account": Eden,
// 2026-11-04 — the factor is for sealed matters only, nobody is required to
// add one to use the rest of the site. The prompt at a sealed matter's door
// (StepUpPrompt, mode 'enrol') is where someone without one learns to add it.
//
// Nothing renders until the database has answered, and nothing ever renders
// if it cannot (migration 094 not pasted).

import { useState } from 'react';
import { Lock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useFactorStatus } from '@/hooks/useFactorStatus';
import { useServerspacesRefresh } from '@/hooks/useServerspaces';
import StepUpPrompt from './StepUpPrompt';

const STRIP =
  'mx-3 sm:mx-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-[12px] leading-snug';

export default function FactorBanner() {
  const { user } = useAuth();
  const status = useFactorStatus(user?.id);
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

  return null;
}

// What the database says about this account's second factor (migration 094,
// second_factor_status). Shared by the quiet banner in MainLayout and the
// sign-in gate in App.tsx; re-read whenever Settings adds or removes a factor
// or a sealed matter is confirmed, via one window event.
//
// undefined = still asking; null = the database cannot say (094 not pasted),
// in which case nothing anywhere changes.

import { useEffect, useState } from 'react';
import { factorStatus, type FactorStatus } from '@/lib/second-factor';

export const FACTOR_STATUS_EVENT = 'cs:factor-status-changed';

export function notifyFactorStatusChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FACTOR_STATUS_EVENT));
}

export function useFactorStatus(userId: string | null | undefined): FactorStatus | null | undefined {
  const [status, setStatus] = useState<FactorStatus | null | undefined>(undefined);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = () => {
      void factorStatus().then((s) => { if (!cancelled) setStatus(s); });
    };
    load();
    window.addEventListener(FACTOR_STATUS_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(FACTOR_STATUS_EVENT, load);
    };
  }, [userId]);

  return userId ? status : null;
}

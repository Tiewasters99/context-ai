// One person edits a brief at a time (migration 105; Eden, 10-02).
//
// The window that opens a brief first holds it and may type; every other
// window — a second tab, a phone, a colleague — shows it read-only and says
// who holds it. The holder renews every 30 s; a hold not renewed for 150 s has
// lapsed and the next window takes it. "Take over editing" takes a live hold.
//
// Advisory, never a lock on the data: saves are still refused when the brief
// changed since it was loaded (migration 100). Until 105 is pasted the RPC is
// missing and this answers 'off': the desk behaves exactly as before.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { isLeaseMissing, nextLeaseState, type LeaseRow, type LeaseState } from './edit-lease-core';

export type { LeaseState } from './edit-lease-core';

export const RENEW_MS = 30_000;
const TAB_KEY = 'cs.brief.tab';

/** One id per browser tab, kept across a reload of that tab (sessionStorage is per tab). */
function tabId(): string {
  try {
    const have = sessionStorage.getItem(TAB_KEY);
    if (have) return have;
    const id = crypto.randomUUID();
    sessionStorage.setItem(TAB_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function useBriefEditLease(documentId: string | null | undefined, enabled: boolean): {
  lease: LeaseState;
  takeOver: () => Promise<boolean>;
} {
  const [lease, setLease] = useState<LeaseState>({ kind: 'checking' });
  const leaseRef = useRef(lease);
  useEffect(() => { leaseRef.current = lease; }, [lease]);
  const tab = useRef<string>('');
  const name = useRef('');
  const me = useRef<string | null>(null);

  const claim = useCallback(async (force: boolean): Promise<LeaseState | null> => {
    if (!documentId) return null;
    const { data, error } = await supabase.rpc('claim_brief_edit', {
      p_document_id: documentId, p_tab: tab.current, p_name: name.current, p_force: force,
    });
    if (error) {
      // Not deployed, or a first claim that failed: as before 105. A failed
      // RENEWAL keeps the state it had — a network blip must not lock a
      // person out of the brief they are typing in.
      if (isLeaseMissing(error) || leaseRef.current.kind === 'checking') {
        const off: LeaseState = { kind: 'off' };
        setLease(off);
        return off;
      }
      return null;
    }
    const row = (Array.isArray(data) ? data[0] : data) as LeaseRow | undefined;
    const next = nextLeaseState(leaseRef.current, row ?? null, me.current);
    setLease(next);
    return next;
  }, [documentId]);

  useEffect(() => {
    if (!documentId || !enabled) return;
    tab.current = tabId();
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    void supabase.auth.getUser().then(({ data }) => {
      if (!live) return;
      const u = data.user;
      me.current = u?.id ?? null;
      const meta = (u?.user_metadata ?? {}) as { full_name?: string; name?: string };
      name.current = (meta.full_name || meta.name || u?.email || '').slice(0, 120);
      void claim(false);
      timer = setInterval(() => { void claim(false); }, RENEW_MS);
    });
    const release = () => {
      void supabase.rpc('release_brief_edit', { p_document_id: documentId, p_tab: tab.current });
    };
    window.addEventListener('pagehide', release);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
      window.removeEventListener('pagehide', release);
      if (leaseRef.current.kind === 'mine') release();
    };
  }, [documentId, enabled, claim]);

  const takeOver = useCallback(async () => (await claim(true))?.kind === 'mine', [claim]);
  // A phone, or no brief yet: nothing is held, and nothing is claimed.
  return { lease: !documentId || !enabled ? { kind: 'off' } : lease, takeOver };
}

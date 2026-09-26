// Settings → Account → Devices: where this account is signed in.
//
// Read from /api/account-sessions (the browser cannot read auth.sessions
// itself). Each row: the browser and system, the IP address, when it was last
// active; "This device" for the one you are using; "Sign out" for any other.
// Signing a device out stops it renewing; whatever page it has open keeps
// working until its current sign-in token runs out (an hour at most by
// default), which the line under the list says plainly.
//
// Dormant until migration 094 is pasted: the endpoint answers
// available:false and this renders nothing.

import { useCallback, useEffect, useState } from 'react';
import { Laptop, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import StepUpPrompt from '@/components/account/StepUpPrompt';

interface Device {
  id: string;
  device: string;
  ip: string | null;
  last_active: string | null;
  current: boolean;
}

const when = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 2) return 'active now';
  if (mins < 60) return `active ${mins} minutes ago`;
  if (mins < 60 * 24) return `active ${Math.round(mins / 60)} hours ago`;
  return `active ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
};

async function call(method: 'GET' | 'POST', body?: unknown) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch('/api/account-sessions', {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, body: await res.json().catch(() => null) };
}

export default function DevicesSection() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Device | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await call('GET');
      if (!r.ok || !r.body) {
        setError('The list of devices could not be read just now.');
        setDevices([]);
        return;
      }
      setAvailable(r.body.available !== false);
      setDevices(r.body.sessions ?? []);
    } catch {
      setError('The list of devices could not be read just now.');
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    call('GET')
      .then((r) => {
        if (cancelled) return;
        if (!r.ok || !r.body) {
          setError('The list of devices could not be read just now.');
          setDevices([]);
          return;
        }
        setAvailable(r.body.available !== false);
        setDevices(r.body.sessions ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setError('The list of devices could not be read just now.');
        setDevices([]);
      });
    return () => { cancelled = true; };
  }, []);

  const signOut = async (d: Device) => {
    setBusy(d.id);
    setError(null);
    const r = await call('POST', { session_id: d.id }).catch(() => ({ ok: false, body: null }));
    setBusy(null);
    if (!r.ok && r.body?.error === 'step_up_required') {
      // 098: signing another device out needs this session's second factor.
      setPending(d);
      return;
    }
    if (!r.ok) {
      setError('That device was not signed out. Try again in a moment.');
      return;
    }
    await load();
  };

  if (!available) return null;

  return (
    <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
      <div className="px-4 py-3">
        <div className="text-sm text-[var(--color-text)]">Devices</div>
        <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
          Where this account is signed in.
        </p>
      </div>
      {devices === null ? (
        <div className="px-4 py-3 text-[13px] text-[var(--color-text-muted)] flex items-center gap-2">
          <Loader2 size={13} className="animate-spin" /> Loading…
        </div>
      ) : (
        devices.map((d) => (
          <div key={d.id} className="px-4 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Laptop size={15} className="text-[var(--color-text-muted)] shrink-0" />
              <div className="min-w-0">
                <div className="text-sm text-[var(--color-text)] truncate">{d.device}</div>
                <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                  {[d.ip, when(d.last_active)].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
            {d.current ? (
              <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">This device</span>
            ) : (
              <button
                onClick={() => void signOut(d)}
                disabled={busy !== null}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-[12px] text-[var(--color-text)] hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                {busy === d.id && <Loader2 size={12} className="animate-spin" />}
                Sign out
              </button>
            )}
          </div>
        ))
      )}
      {devices !== null && devices.some((d) => !d.current) && (
        <p className="px-4 py-2 text-[11px] text-[var(--color-text-muted)]">
          A device you sign out here cannot renew its sign-in; a page it already has open
          stops working within the hour.
        </p>
      )}
      {pending && (
        <div className="px-4 py-3">
          <StepUpPrompt
            mode="stepup"
            heading="Confirm it’s you to sign that device out."
            onConfirmed={() => { const d = pending; setPending(null); void signOut(d); }}
          />
        </div>
      )}
            {error && <div className="px-4 py-2 text-[12px] text-[#f8b4b4]">{error}</div>}
    </div>
  );
}

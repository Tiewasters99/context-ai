// Settings → Account → Second factor.
//
// Add an authenticator app (a QR code and a six-digit code) or, where this
// browser and the project allow it, a passkey; see the factor's name; remove
// it. Removing asks for the factor once more first — someone who walked up
// to an unlocked laptop should not be able to take the factor off the
// account — and Supabase Auth itself refuses to remove a verified factor
// from a session that has not confirmed one.
//
// Every change is reported to /api/account-factor-event, which checks it
// against Supabase Auth and writes it to this account's Record.
//
// Plain words, no shield icons: the house rule is that the only visible
// security is a refusal a person can read.

import { useCallback, useEffect, useState } from 'react';
import { Fingerprint, KeyRound, Loader2, Plus, Smartphone } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useServerspacesRefresh } from '@/hooks/useServerspaces';
import { notifyFactorStatusChanged, useFactorStatus } from '@/hooks/useFactorStatus';
import {
  confirmFactor, discardUnverifiedFactors, longDate, passkeysSupported, reportFactorEvent,
  verifiedFactors, type VerifiedFactor,
} from '@/lib/second-factor';

type Adding =
  | null
  | { kind: 'totp'; factorId: string; qr: string; secret: string };

const kindLabel = (f: VerifiedFactor) => (f.factor_type === 'webauthn' ? 'Passkey' : 'Authenticator app');

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export default function SecondFactorSection() {
  const { user } = useAuth();
  const status = useFactorStatus(user?.id);
  const refreshServerspaces = useServerspacesRefresh();

  const [factors, setFactors] = useState<VerifiedFactor[] | null>(null);
  const [adding, setAdding] = useState<Adding>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [removing, setRemoving] = useState<VerifiedFactor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFactors(await verifiedFactors());
  }, []);

  useEffect(() => { void load(); }, [load]);

  // A link to #second-factor (the enrolment route, the step-up prompt) lands here.
  useEffect(() => {
    if (window.location.hash === '#second-factor') {
      document.getElementById('second-factor')?.scrollIntoView({ block: 'start' });
    }
  }, []);

  const changed = async () => {
    await load();
    notifyFactorStatusChanged();
    refreshServerspaces();
  };

  const reset = () => {
    setAdding(null);
    setRemoving(null);
    setCode('');
    setName('');
    setError(null);
  };

  const uniqueName = (base: string) => {
    const taken = new Set((factors ?? []).map((f) => f.friendly_name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
  };

  const startTotp = async () => {
    setBusy(true);
    setError(null);
    await discardUnverifiedFactors();
    const { data, error: err } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: uniqueName(name.trim() || 'Authenticator app'),
      issuer: 'Contextspaces',
    });
    setBusy(false);
    if (err || !data) {
      setError('Could not start. Try again in a moment.');
      return;
    }
    setAdding({ kind: 'totp', factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  };

  const finishTotp = async () => {
    if (!adding) return;
    setBusy(true);
    setError(null);
    const problem = await confirmFactor(
      { id: adding.factorId, factor_type: 'totp', created_at: '' }, code,
    );
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    void reportFactorEvent('auth.factor_enrolled', { factor_id: adding.factorId });
    reset();
    await changed();
  };

  const addPasskey = async () => {
    setBusy(true);
    setError(null);
    await discardUnverifiedFactors();
    const { data, error: err } = await supabase.auth.mfa.webauthn.register({
      friendlyName: uniqueName(name.trim() || 'Passkey'),
    });
    setBusy(false);
    if (err) {
      const text = String(err.message ?? '');
      setError(
        /disabled|not enabled|not supported/i.test(text)
          ? 'Passkeys are not switched on for Contextspaces yet. An authenticator app works today.'
          : 'The passkey was not created. Try again, or use an authenticator app.',
      );
      return;
    }
    const factorId = (data as { factor?: { id?: string } } | null)?.factor?.id;
    const list = await verifiedFactors();
    const made = list.find((f) => f.id === factorId) ?? list.find((f) => f.factor_type === 'webauthn');
    if (made) void reportFactorEvent('auth.factor_enrolled', { factor_id: made.id });
    reset();
    await changed();
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setError(null);
    const problem = await confirmFactor(removing, code);
    if (problem) {
      setBusy(false);
      setError(problem);
      return;
    }
    const { error: err } = await supabase.auth.mfa.unenroll({ factorId: removing.id });
    setBusy(false);
    if (err) {
      setError('It was not removed. Try again in a moment.');
      return;
    }
    void reportFactorEvent('auth.factor_unenrolled', {
      factor_id: removing.id, factor_type: removing.factor_type,
    });
    reset();
    await changed();
  };

  const requiredLine = status?.required && !status.has_factor
    ? `Required for your account from ${longDate(status.required_from)} — you run a workspace or work in a sealed matter.`
    : null;

  const input =
    'rounded-md border border-[var(--color-border)] bg-black/20 px-2 py-1.5 text-[13px] text-[var(--color-text)]';
  const button =
    'inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 ' +
    'text-[12px] text-[var(--color-text)] hover:bg-white/5 transition-colors disabled:opacity-50';

  return (
    <div id="second-factor" className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] scroll-mt-20">
      <div className="px-4 py-3">
        <div className="text-sm text-[var(--color-text)]">Second factor</div>
        <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
          A code from your phone, or a passkey, after your password. Sealed matters ask for it.
        </p>
        {requiredLine && <p className="mt-1 text-[12px] text-[#e8b84a]">{requiredLine}</p>}
      </div>

      {factors === null ? (
        <div className="px-4 py-3 text-[13px] text-[var(--color-text-muted)] flex items-center gap-2">
          <Loader2 size={13} className="animate-spin" /> Loading…
        </div>
      ) : (
        factors.map((f) => (
          <div key={f.id} className="px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {f.factor_type === 'webauthn'
                  ? <Fingerprint size={15} className="text-[var(--color-text-muted)] shrink-0" />
                  : <Smartphone size={15} className="text-[var(--color-text-muted)] shrink-0" />}
                <div className="min-w-0">
                  <div className="text-sm text-[var(--color-text)] truncate">{f.friendly_name || kindLabel(f)}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    {kindLabel(f)}{f.created_at ? ` · added ${shortDate(f.created_at)}` : ''}
                  </div>
                </div>
              </div>
              {removing?.id !== f.id && (
                <button onClick={() => { reset(); setRemoving(f); }} disabled={busy} className={button}>
                  Remove
                </button>
              )}
            </div>
            {removing?.id === f.id && (
              <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void remove(); }}>
                <span className="text-[12px] text-[var(--color-text-secondary)] w-full">
                  {f.factor_type === 'webauthn'
                    ? 'Confirm with this passkey once more to remove it.'
                    : 'Enter the current code from this app to remove it.'}
                </span>
                {f.factor_type !== 'webauthn' && (
                  <input
                    value={code}
                    onChange={(e) => { setCode(e.target.value); setError(null); }}
                    inputMode="numeric" autoComplete="one-time-code" maxLength={7}
                    placeholder="123456" aria-label="Six-digit code" className={`${input} w-28 tracking-[0.2em]`}
                  />
                )}
                <button type="submit" disabled={busy} className={button}>
                  {busy && <Loader2 size={12} className="animate-spin" />} Remove it
                </button>
                <button type="button" onClick={reset} className="text-[12px] text-[var(--color-text-muted)] hover:underline">
                  Keep it
                </button>
              </form>
            )}
          </div>
        ))
      )}

      {factors !== null && !adding && !removing && (
        <div className="px-4 py-3 flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder={factors.length ? 'Name, e.g. office phone' : 'Name (optional)'}
            aria-label="A name for this factor"
            className={`${input} flex-1 min-w-[10rem]`}
          />
          <button onClick={() => void startTotp()} disabled={busy} className={button}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Authenticator app
          </button>
          {passkeysSupported() && (
            <button onClick={() => void addPasskey()} disabled={busy} className={button}>
              <KeyRound size={12} /> Passkey
            </button>
          )}
        </div>
      )}

      {adding?.kind === 'totp' && (
        <form className="px-4 py-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void finishTotp(); }}>
          <p className="text-[12px] text-[var(--color-text-secondary)]">
            Scan this with an authenticator app (Google Authenticator, 1Password, Microsoft
            Authenticator, the iPhone’s Passwords app), then enter the six-digit code it shows.
          </p>
          <div className="flex flex-wrap items-start gap-4">
            <img src={adding.qr} alt="QR code for your authenticator app" className="w-40 h-40 rounded bg-white p-2" />
            <div className="text-[11px] text-[var(--color-text-muted)] max-w-[16rem] break-all">
              Can’t scan? Enter this key by hand:
              <div className="mt-1 font-mono text-[12px] text-[var(--color-text)] select-all">{adding.secret}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={code}
              onChange={(e) => { setCode(e.target.value); setError(null); }}
              inputMode="numeric" autoComplete="one-time-code" maxLength={7} autoFocus
              placeholder="123456" aria-label="Six-digit code" className={`${input} w-28 tracking-[0.2em]`}
            />
            <button type="submit" disabled={busy} className={button}>
              {busy && <Loader2 size={12} className="animate-spin" />} Turn it on
            </button>
            <button
              type="button"
              onClick={() => { void supabase.auth.mfa.unenroll({ factorId: adding.factorId }); reset(); }}
              className="text-[12px] text-[var(--color-text-muted)] hover:underline"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <div className="px-4 py-2 text-[12px] text-[#f8b4b4]">{error}</div>}
    </div>
  );
}

// "This matter is sealed. Confirm it's you."
//
// Drawn IN PLACE of a sealed matter the session cannot enter yet — the matter
// page shows this where the matter would be, never an error. Confirming a
// factor upgrades this session to aal2 for the rest of its life (Supabase
// Auth issues the new token; supabase-js keeps it), and the caller re-reads
// the matter. The words are the seal's, in the seal's colour: the seal holding
// is the feature, not a failure (RefusalBanner's rule).
//
// Two shapes:
//   stepup — the person has a factor: ask for it.
//   enrol  — they have none: say so, and point at the one place to add one.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Fingerprint, Loader2, Lock } from 'lucide-react';
import {
  confirmFactor, reportFactorEvent, verifiedFactors, type VerifiedFactor,
} from '@/lib/second-factor';
import { notifyFactorStatusChanged } from '@/hooks/useFactorStatus';

interface Props {
  mode: 'stepup' | 'enrol';
  /** Recorded with the step-up, so the Record says which door it opened. */
  matterId?: string;
  /** Overrides the first line (the sidebar's "sealed matters" notice uses its own). */
  heading?: string;
  onConfirmed: () => void;
}

export default function StepUpPrompt({ mode, matterId, heading, onConfirmed }: Props) {
  const [factors, setFactors] = useState<VerifiedFactor[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'stepup') return;
    let cancelled = false;
    void verifiedFactors().then((list) => {
      if (cancelled) return;
      setFactors(list);
      setChosen(list[0]?.id ?? null);
    });
    return () => { cancelled = true; };
  }, [mode]);

  const factor = factors?.find((f) => f.id === chosen) ?? null;

  const confirm = async () => {
    if (!factor || busy) return;
    setBusy(true);
    setError(null);
    const problem = await confirmFactor(factor, code);
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    setCode('');
    void reportFactorEvent('auth.stepup', { matter_id: matterId });
    notifyFactorStatusChanged();
    onConfirmed();
  };

  return (
    <div className="mx-auto max-w-md rounded-lg border border-[#5aa88f]/30 bg-[#12211c]/70 px-5 py-5 text-[#bfe0d2]">
      <div className="flex items-center gap-2 text-sm font-medium text-[#d7eee4]">
        <Lock size={15} strokeWidth={1.75} className="text-[#5aa88f]" />
        {heading ?? (mode === 'enrol'
          ? 'This matter is sealed. Add a second factor to open it.'
          : 'This matter is sealed. Confirm it’s you.')}
      </div>

      {mode === 'enrol' ? (
        <p className="mt-3 text-[13px] leading-relaxed">
          Sealed matters open only after a second factor — an authenticator app or a passkey.
          It takes a minute:{' '}
          <Link to="/app/settings#second-factor" className="underline underline-offset-2 decoration-[#5aa88f]/60">
            Settings → Account → Second factor
          </Link>
          .
        </p>
      ) : factors === null ? (
        <div className="mt-3 flex items-center gap-2 text-[13px]">
          <Loader2 size={13} className="animate-spin" /> Checking…
        </div>
      ) : factors.length === 0 ? (
        <p className="mt-3 text-[13px] leading-relaxed">
          No second factor is set up on this account.{' '}
          <Link to="/app/settings#second-factor" className="underline underline-offset-2 decoration-[#5aa88f]/60">
            Add one in Settings
          </Link>
          .
        </p>
      ) : (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => { e.preventDefault(); void confirm(); }}
        >
          {factors.length > 1 && (
            <select
              value={chosen ?? ''}
              onChange={(e) => { setChosen(e.target.value); setError(null); }}
              className="w-full rounded-md border border-[#5aa88f]/30 bg-black/30 px-2 py-1.5 text-[13px] text-[#d7eee4]"
            >
              {factors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.friendly_name || (f.factor_type === 'webauthn' ? 'Passkey' : 'Authenticator app')}
                </option>
              ))}
            </select>
          )}

          {factor?.factor_type === 'webauthn' ? (
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-md border border-[#5aa88f]/50 px-3 py-1.5 text-[13px] hover:bg-[#5aa88f]/10 disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Fingerprint size={14} />}
              Use passkey
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <input
                value={code}
                onChange={(e) => { setCode(e.target.value); setError(null); }}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={7}
                placeholder="123456"
                aria-label="Six-digit code"
                className="w-28 rounded-md border border-[#5aa88f]/30 bg-black/30 px-2 py-1.5 text-[14px] tracking-[0.2em] text-[#d7eee4] placeholder:text-[#bfe0d2]/30"
              />
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-md border border-[#5aa88f]/50 px-3 py-1.5 text-[13px] hover:bg-[#5aa88f]/10 disabled:opacity-50"
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                Confirm
              </button>
            </div>
          )}
          <p className="text-[12px] text-[#bfe0d2]/70">
            {factor?.factor_type === 'webauthn'
              ? 'Your device will ask for the passkey.'
              : 'The code from your authenticator app. Once confirmed, sealed matters stay open for the rest of this session.'}
          </p>
          {error && <p className="text-[12px] text-[#f8b4b4]">{error}</p>}
        </form>
      )}
    </div>
  );
}

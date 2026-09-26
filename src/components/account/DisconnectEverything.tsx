import { useEffect, useState } from 'react';
import { Unplug } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';
import StepUpPrompt from '@/components/account/StepUpPrompt';
import {
  previewDisconnect, disconnectAccount, StepUpRequiredError, NOTHING_DISCONNECTED, type DisconnectCounts,
} from '@/lib/disconnect-all';
import { accountSentence, countsLine } from '@/lib/disconnect-all-sentence';

// Settings → Connections, at the foot: "Disconnect everything" (migration 095).
//
// One quiet link, not a red panel: the roadmap's rule is no security chrome,
// and the moment someone needs this they will look for it at the bottom of the
// page that lists what is connected. The confirm card names the counts BEFORE
// the press, read from disconnect_all_preview — the same selection the press
// acts on — so the sentence cannot promise something the press does not do.
//
// After the press the page re-reads everything it lists (onDone), so each row
// shows as disconnected from the tables themselves, not from a guess here.
//
// Not deployed (095 not pasted): the preview is missing and this renders
// nothing, exactly as the AI pause control does before 070.
//
// An account with a second factor confirms it first (099): the endpoint says
// `step_up_required` and has done nothing; the card shows S1's StepUpPrompt in
// place of the buttons and presses again once the factor is confirmed.

interface Props {
  /** Told after a successful press, so the page can re-read what it shows. */
  onDone?: (counts: DisconnectCounts, othersSignedOut: boolean) => void;
}

export default function DisconnectEverything({ onDone }: Props) {
  const [deployed, setDeployed] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<DisconnectCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);

  // One probe on mount, so the link is never offered on a database that
  // cannot act on it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await previewDisconnect('account');
      if (!cancelled) setDeployed(r.ok || !r.notDeployed);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!deployed) return null;

  const start = async () => {
    setError(null);
    setCounts(null);
    setStepUp(false);
    setOpen(true);
    const r = await previewDisconnect('account');
    if (r.ok) setCounts(r.counts);
    else setError(r.error ?? 'What is connected could not be read just now, so nothing will be done.');
  };

  const press = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { counts: done, othersSignedOut } = await disconnectAccount();
      setOpen(false);
      onDone?.(done, othersSignedOut);
    } catch (e) {
      if (e instanceof StepUpRequiredError) setStepUp(true);
      else setError(e instanceof Error ? e.message : NOTHING_DISCONNECTED);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mt-10 pt-6 border-t border-[var(--color-border)]">
        <button
          onClick={() => void start()}
          className="inline-flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)] hover:text-[#f87171] transition"
        >
          <Unplug size={14} strokeWidth={1.75} />
          Disconnect everything
        </button>
        <p className="mt-1.5 text-xs text-[var(--color-text-muted)] max-w-xl leading-relaxed">
          Every assistant, agent and connected app loses access at once, AI is paused on
          the matters of the workspaces you own, and every other browser is signed out. You
          stay signed in here and reconnect what you want, one at a time.
        </p>
      </div>

      {open && (
        <CardDialog
          storageKey="cs.dialog.disconnectEverything"
          z={60}
          maxWidth={420}
          onClose={() => setOpen(false)}
          closeOnBackdrop
          busy={busy}
          icon={<Unplug size={15} className="text-[#f87171]" />}
          title="Disconnect everything"
          subtitle={counts ? countsLine(counts) : undefined}
        >
          {counts ? (
            <p className="text-[13px] text-white/80 mb-3 leading-relaxed">{accountSentence(counts)}</p>
          ) : !error ? (
            <p className="text-[13px] text-white/50 mb-3">Reading what is connected…</p>
          ) : null}

          {error && <p className="text-[12px] text-amber-200/80 mb-3">{error}</p>}

          {stepUp ? (
            <div className="mb-1">
              <StepUpPrompt
                mode="stepup"
                heading="Confirm it’s you to disconnect everything."
                onConfirmed={() => {
                  setStepUp(false);
                  void press();
                }}
              />
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                disabled={busy}
                className="px-3 py-1.5 rounded-md text-[13px] text-white/70 hover:bg-[rgba(255,255,255,0.06)] transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={() => void press()}
                disabled={busy || !counts}
                className="px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors disabled:opacity-40 bg-[#f87171]/15 text-[#f87171] hover:bg-[#f87171]/25"
              >
                {busy ? 'Disconnecting…' : 'Disconnect everything'}
              </button>
            </div>
          )}
        </CardDialog>
      )}
    </>
  );
}

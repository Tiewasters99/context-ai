import { useEffect, useState } from 'react';
import { Unplug } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';
import { previewDisconnect, disconnectMatter, type DisconnectCounts } from '@/lib/disconnect-all';
import { matterSentence } from '@/lib/disconnect-all-sentence';

// "Disconnect all assistants from this matter" — beside Pause AI in the
// matter's header (migration 095).
//
// The pause stops AI here; this goes one step further and takes away the
// presser's own connections that can reach the matter. The confirm sentence
// is read from disconnect_all_preview before the press and says the one thing
// that is not obvious: a full-access assistant reaches every matter, so it
// can only be disconnected from all of them.
//
// Renders nothing until 095 is pasted, and nothing for someone who is not an
// owner or admin of the matter (the preview refuses them with 42501 — the
// same rule the press enforces).

interface Props {
  matterId: string;
  matterName: string;
  /** Told after a successful press (the pause beside this has changed too). */
  onDone?: (counts: DisconnectCounts) => void;
}

export default function DisconnectMatterControl({ matterId, matterName, onDone }: Props) {
  const [allowed, setAllowed] = useState(false);
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<DisconnectCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAllowed(false);
    (async () => {
      const r = await previewDisconnect('matter', matterId);
      if (!cancelled) setAllowed(r.ok);
    })();
    return () => {
      cancelled = true;
    };
  }, [matterId]);

  if (!allowed) return null;

  const start = async () => {
    setError(null);
    setCounts(null);
    setOpen(true);
    const r = await previewDisconnect('matter', matterId);
    if (r.ok) setCounts(r.counts);
    else setError(r.error ?? 'What is connected could not be read just now, so nothing will be done.');
  };

  const press = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const done = await disconnectMatter(matterId);
      setOpen(false);
      onDone?.(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nothing was disconnected. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={() => void start()}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-white/55 hover:text-white/90 hover:bg-[rgba(255,255,255,0.06)] border border-[rgba(255,255,255,0.08)] transition-colors"
        title="Disconnect all assistants from this matter"
        aria-label="Disconnect all assistants from this matter"
      >
        <Unplug size={15} strokeWidth={1.75} />
        Disconnect assistants
      </button>

      {open && (
        <CardDialog
          storageKey="cs.dialog.disconnectMatter"
          z={60}
          maxWidth={400}
          onClose={() => setOpen(false)}
          closeOnBackdrop
          busy={busy}
          icon={<Unplug size={15} className="text-[#e8b84a]" />}
          title="Disconnect all assistants from this matter"
        >
          {counts ? (
            <p className="text-[13px] text-white/80 mb-3 leading-relaxed">{matterSentence(counts, matterName)}</p>
          ) : !error ? (
            <p className="text-[13px] text-white/50 mb-3">Reading what is connected…</p>
          ) : null}
          <p className="text-[12px] text-white/50 mb-3 leading-relaxed">
            Nothing comes back by itself: resume AI here and reconnect each one when you choose.
          </p>

          {error && <p className="text-[12px] text-amber-200/80 mb-3">{error}</p>}

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
              className="px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors disabled:opacity-40"
              style={{ backgroundColor: 'rgba(232,184,74,0.16)', color: '#e8b84a' }}
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        </CardDialog>
      )}
    </>
  );
}

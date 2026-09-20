import { LockOpen, X } from 'lucide-react';
import ModalPortal from '@/components/ui/ModalPortal';

// Taking a copy of a sealed matter's document out to Google Drive, a Gmail
// draft — later OneDrive or Dropbox — is the one click in the reader with
// contractual weight, so it gets the same treatment as sealing itself: a real
// confirmation that says what actually happens, not a generic "are you sure".
//
// Eden's rule of 2026-09-20 is warn and record, not block: the user may take
// their own file wherever they like, and the product's job is to make sure
// they know the copy is leaving the seal, once per copy.
//
// EVERY WORD OF THE WARNING COMES FROM THE SERVER. lib/export-gate.mjs
// composes it, including the sentence about whether the export is written to
// the matter's record — which depends on whether the append-only ledger is
// live on that deployment, and must never be assumed here. This component
// renders what it was given and asks the question.

interface Props {
  // The gate's own sentence, from the 409 body's `message`.
  message: string;
  // e.g. "Save to Google Drive" — what the confirm button does.
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const LEAVING_SEAL = '#e8b84a';

export default function SealedExportDialog({
  message,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <ModalPortal>
      <>
        <div className="fixed inset-0 z-[80] bg-black/40" onClick={onCancel} />
        <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[80] w-full max-w-sm rounded-xl border border-[rgba(255,255,255,0.12)] p-6 bg-[#12121a]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[15px] font-semibold text-white flex items-center gap-2">
              <LockOpen size={15} style={{ color: LEAVING_SEAL }} />
              A copy would leave the seal
            </h3>
            <button
              onClick={onCancel}
              disabled={busy}
              className="p-1 rounded hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white transition-colors disabled:opacity-40"
              aria-label="Cancel"
            >
              <X size={16} />
            </button>
          </div>

          <div className="rounded-lg border border-amber-300/30 bg-amber-300/5 px-3 py-2.5 mb-3 text-[12px] leading-relaxed text-white/75">
            {message}
          </div>

          <p className="text-[13px] text-white/80 mb-3">Continue?</p>

          <div className="flex justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-[13px] text-white/70 hover:bg-[rgba(255,255,255,0.06)] transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors disabled:opacity-40"
              style={{ backgroundColor: 'rgba(232,184,74,0.14)', color: LEAVING_SEAL }}
            >
              {busy ? 'Working…' : confirmLabel}
            </button>
          </div>
        </div>
      </>
    </ModalPortal>
  );
}

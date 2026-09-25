import { LockOpen } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';

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
    <CardDialog
      storageKey="cs.dialog.sealedExport"
      z={80}
      maxWidth={384}
      onClose={onCancel}
      closeOnBackdrop
      busy={busy}
      icon={<LockOpen size={15} style={{ color: LEAVING_SEAL }} />}
      title="A copy would leave the seal"
    >
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
    </CardDialog>
  );
}

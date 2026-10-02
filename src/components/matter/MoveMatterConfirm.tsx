// The two halves of a safe move in the sidebar (Eden, 09-30):
//
//   * MoveMatterConfirm — asked before a drag re-parents a matter when the
//     move would change who or what can see it (lib/matter-move.ts decides).
//     Cancel is the default: it has the focus, and Enter on the move button
//     does nothing (Space and a click still work).
//   * MovedToast — after every move, "Moved Teman into UKC · Undo" for ten
//     seconds. Portalled to the page, so neither a sidebar re-render nor the
//     phone drawer sliding shut takes it away.

import { useEffect, useRef } from 'react';
import { AlertTriangle, FolderInput, Lock, Undo2, X } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';
import ModalPortal from '@/components/ui/ModalPortal';
import type { MoveWords } from '@/lib/matter-move';

export function MoveMatterConfirm({
  words,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  words: MoveWords;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Focus on Cancel, so a stray Enter or Space backs out rather than moves.
  useEffect(() => { cancelRef.current?.focus(); }, []);

  return (
    <CardDialog
      storageKey="cs.dialog.moveMatter"
      title={words.title}
      icon={<FolderInput size={16} className="text-[#e8b84a] shrink-0" />}
      onClose={onCancel}
      busy={busy}
      autoFocus={false}
      maxWidth={460}
      footer={
        <>
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={busy}
            className="px-3.5 py-1.5 rounded-md text-[13px] font-medium bg-[#e8b84a] text-black hover:bg-[#f0c860] transition-colors disabled:opacity-50"
          >
            {words.blocked ? 'Close' : 'Cancel'}
          </button>
          {!words.blocked && (
            <button
              onClick={onConfirm}
              onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
              disabled={busy}
              className="px-3.5 py-1.5 rounded-md text-[13px] text-white/80 border border-white/15 hover:bg-white/[0.06] hover:text-white transition-colors disabled:opacity-50"
            >
              {busy ? 'Moving…' : words.action}
            </button>
          )}
        </>
      }
    >
      <ul className="space-y-2.5">
        {words.lines.map((line, i) => (
          <li
            key={i}
            className={`text-[13px] leading-relaxed rounded-md ${
              line.tone === 'warn'
                ? 'px-3 py-2 border border-amber-400/40 bg-amber-400/10 text-amber-100'
                : line.tone === 'seal'
                  ? 'px-3 py-2 border border-[#5aa88f]/40 bg-[#5aa88f]/10 text-[#cfe9e0]'
                  : 'text-white/80'
            }`}
          >
            {line.tone === 'warn' && <AlertTriangle size={13} className="inline-block mr-1.5 -mt-0.5 text-amber-300" />}
            {line.tone === 'seal' && <Lock size={12} className="inline-block mr-1.5 -mt-0.5 text-[#5aa88f]" />}
            {line.text}
          </li>
        ))}
      </ul>
      {!words.blocked && (
        <p className="mt-3.5 text-[11.5px] text-white/45 leading-relaxed">
          After moving, you can undo it for a few seconds.
        </p>
      )}
      {error && <p className="mt-3 text-[12px] text-red-300">{error}</p>}
    </CardDialog>
  );
}

export const MOVED_TOAST_MS = 10_000;

export function MovedToast({
  text,
  busy,
  onUndo,
  onDismiss,
}: {
  text: string;
  busy: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  return (
    <ModalPortal>
      <div
        role="status"
        aria-live="polite"
        className="fixed z-[70] bottom-4 left-4 right-4 sm:right-auto sm:max-w-[26rem] flex items-center gap-3 rounded-lg border border-white/12 px-3.5 py-2.5 shadow-2xl shadow-black/50"
        style={{ backgroundColor: 'rgba(20,20,28,0.97)' }}
      >
        <span className="flex-1 min-w-0 text-[13px] text-white/85 leading-snug break-words">{text}</span>
        <button
          onClick={onUndo}
          disabled={busy}
          className="flex items-center gap-1 shrink-0 px-2 py-1 rounded-md text-[13px] font-semibold text-[#e8b84a] hover:bg-[#e8b84a]/10 transition-colors disabled:opacity-50"
        >
          <Undo2 size={13} strokeWidth={2.25} />
          {busy ? 'Undoing…' : 'Undo'}
        </button>
        <button
          onClick={onDismiss}
          className="p-1 shrink-0 rounded text-white/40 hover:text-white hover:bg-white/[0.06] transition-colors"
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </div>
    </ModalPortal>
  );
}

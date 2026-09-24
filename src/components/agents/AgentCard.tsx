// The one card shell the agents surfaces open (Add an agent, Edit matters,
// Delegate…). House rule: every card and modal is draggable, resizable and
// pinnable, and the ribbon header is the drag handle — the same shell as
// CharterEditor, on the same hook.

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import ModalPortal from '@/components/ui/ModalPortal';
import PinToggle from '@/components/ui/PinToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';

export const cardField =
  'w-full bg-[rgba(20,20,30,0.8)] border border-[rgba(255,255,255,0.1)] rounded-lg px-3 py-2 text-[13px] text-white placeholder-white/25 outline-none focus:border-[rgba(232,184,74,0.45)] transition-colors';
export const cardLegend = 'text-[10px] font-semibold uppercase tracking-wider text-[#8a8693] mb-1.5';

export default function AgentCard({
  storageKey,
  title,
  subtitle,
  maxWidth = 560,
  onClose,
  children,
  footer,
}: {
  storageKey: string;
  title: string;
  subtitle?: string;
  maxWidth?: number;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { cardRef, pinned, togglePin, isMobile } = useDraggableResizable(storageKey);
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3">
        <div
          ref={cardRef}
          role="dialog"
          aria-label={title}
          className="w-full max-h-[88vh] rounded-xl border border-[rgba(255,255,255,0.1)] overflow-hidden flex flex-col"
          style={{ backgroundColor: 'rgba(10,10,16,0.98)', maxWidth }}
        >
          {/* Ribbon header — also the drag handle */}
          <div className="px-5 pt-2 pb-3 border-b border-[rgba(255,255,255,0.08)] shrink-0 cursor-grab">
            {!isMobile && (
              <div className="flex justify-center mb-2">
                <div className="w-12 h-1 rounded-full bg-white/25 hover:bg-white/45 transition-colors" title="Drag to move" />
              </div>
            )}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold text-white">{title}</h2>
                {subtitle && <p className="text-[11.5px] text-white/45 mt-0.5 leading-relaxed">{subtitle}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!isMobile && <PinToggle pinned={pinned} onToggle={togglePin} />}
                <button
                  onClick={onClose}
                  className="p-2 rounded-lg hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
                  title="Close"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">{children}</div>

          {footer && (
            <div className="px-5 py-3 border-t border-[rgba(255,255,255,0.08)] shrink-0 flex items-center gap-2">
              {footer}
            </div>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}

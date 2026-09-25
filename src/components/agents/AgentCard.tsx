// The one card shell the agents surfaces open (Add an agent, Edit matters,
// Delegate…). House rule: every card and modal is draggable, resizable and
// pinnable, and the ribbon header is the drag handle — the same shell as
// CharterEditor, on the same hook.

import type { ReactNode } from 'react';
import CardDialog from '@/components/ui/CardDialog';

export const cardField =
  'w-full bg-[rgba(20,20,30,0.8)] border border-[rgba(255,255,255,0.1)] rounded-lg px-3 py-2 text-[13px] text-white placeholder-white/25 outline-none focus:border-[rgba(232,184,74,0.45)] transition-colors';
export const cardLegend = 'text-[10px] font-semibold uppercase tracking-wider text-[#8a8693] mb-1.5';

// Since 2026-09-25 the frame itself is the shared CardDialog (every dialog in
// the app is the same card); this keeps the agents surfaces' props and look.
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
  return (
    <CardDialog
      storageKey={storageKey}
      title={title}
      subtitle={subtitle}
      maxWidth={maxWidth}
      z={50}
      onClose={onClose}
      surface="rgba(10,10,16,0.98)"
      bodyClassName="px-5 py-4 space-y-4"
      footer={footer}
      footerClassName="px-5 py-3 flex items-center gap-2"
    >
      {children}
    </CardDialog>
  );
}

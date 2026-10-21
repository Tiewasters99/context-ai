// Shared pieces of the Trademark tab: the panel frame, the status chip (the
// Tasks tab's chip, for stage statuses), buttons, the initials field and a
// horizontally scrolling table wrapper so a phone never scrolls the page
// sideways. Plain, lawyerly, no animation.

import type { ReactNode } from 'react';
import type { StageStatus } from '@/lib/trademark/data';
import { field } from './styles';

const CHIP: Record<StageStatus | 'later', string> = {
  pending: 'border-white/20 text-white/70',
  in_progress: 'border-[#8b9dc3]/50 text-[#aebbd8]',
  awaiting_review: 'border-[#e8b84a]/60 text-[#e8b84a]',
  done: 'border-[#4ade80]/40 text-[#86e0a8]',
  skipped: 'border-white/10 text-white/40',
  later: 'border-white/10 text-white/40',
};
const CHIP_LABEL: Record<StageStatus | 'later', string> = {
  pending: 'Pending', in_progress: 'In progress', awaiting_review: 'Awaiting review', done: 'Done', skipped: 'Skipped',
  later: 'Not in this version',
};

export function StageChip({ status }: { status: StageStatus | 'later' }) {
  return (
    <span className={`text-[10.5px] px-1.5 py-0.5 rounded border whitespace-nowrap ${CHIP[status]}`}>{CHIP_LABEL[status]}</span>
  );
}

export function Panel({ id, title, children, aside }: { id?: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section id={id} className="mt-6 rounded-lg border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.02)] px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h3 className="text-[14px] font-medium text-[var(--color-text-bright)]">{title}</h3>
        {aside && <div className="flex flex-wrap items-center gap-2">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Scroll({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto -mx-1 px-1">{children}</div>;
}

export function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="mt-2 text-[12.5px] text-[#f87171]" role="alert">{text}</p>;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed">{children}</p>;
}

export function InitialsField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value.toUpperCase().slice(0, 4))}
      placeholder="Initials"
      aria-label="Your initials"
      className={`${field} w-[84px] uppercase`}
      maxLength={4}
    />
  );
}

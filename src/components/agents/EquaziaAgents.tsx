// The Agents page's first section: the agents Equazia builds. Each agent is a
// row; a live one opens with a chevron to its Procedures (matter-scoped
// methods the reviewer runs stage by stage). The others are marked Coming and
// do nothing yet. Eden (2026-10-28): "Equazia Agents that we are constantly
// building and adding. The first one is Trademark Agent, with Procedures below
// that."

import { useState, type ReactNode } from 'react';
import { ChevronRight, FileSearch, Landmark, PenLine, Stamp, type LucideIcon } from 'lucide-react';
import ProcedureCard from '@/components/trademark/ProcedureCard';

interface EquaziaAgent {
  key: string;
  name: string;
  line: string;
  icon: LucideIcon;
  /** Live agents open to their procedures; the rest are marked Coming. */
  procedures?: () => ReactNode;
}

const AGENTS: EquaziaAgent[] = [
  {
    key: 'trademark',
    name: 'Trademark Agent',
    line: 'Knockout search of the U.S. federal register, and an application draft. You decide every hit and sign off.',
    icon: Stamp,
    procedures: () => <ProcedureCard />,
  },
  {
    key: 'discovery',
    name: 'Discovery Agent',
    line: 'Receives and classifies productions, and prepares productions under your supervision.',
    icon: FileSearch,
  },
  {
    key: 'brief',
    name: 'Brief Writing Agent',
    line: 'Drafts briefs from the record for your review.',
    icon: PenLine,
  },
  {
    key: 'incorporation',
    name: 'Incorporation Agent',
    line: 'Prepares formation documents for your review.',
    icon: Landmark,
  },
];

export default function EquaziaAgents() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      {AGENTS.map((a) => {
        const live = !!a.procedures;
        const isOpen = live && open === a.key;
        const Icon = a.icon;
        const head = (
          <>
            <span className="w-9 h-9 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
              <Icon size={16} className={live ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]'} strokeWidth={1.75} />
            </span>
            <span className="flex-1 min-w-0 text-left">
              <span className="flex items-center gap-2">
                <span className={`text-[14px] font-medium ${live ? 'text-[var(--color-text-bright)]' : 'text-[var(--color-text-secondary)]'}`}>{a.name}</span>
                {!live && (
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] border border-[var(--color-border)] rounded px-1.5 py-px">
                    Coming
                  </span>
                )}
              </span>
              <span className="block mt-0.5 text-[12.5px] text-[var(--color-text-secondary)] leading-relaxed">{a.line}</span>
            </span>
            {live && (
              <ChevronRight
                size={16}
                className={`shrink-0 text-[var(--color-text-muted)] transition-transform ${isOpen ? 'rotate-90' : ''}`}
              />
            )}
          </>
        );
        return (
          <div key={a.key} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
            {live ? (
              <button
                onClick={() => setOpen(isOpen ? null : a.key)}
                aria-expanded={isOpen}
                className="w-full flex items-start gap-3 px-4 py-3.5"
              >
                {head}
              </button>
            ) : (
              <div className="flex items-start gap-3 px-4 py-3.5 opacity-80">{head}</div>
            )}
            {isOpen && a.procedures && (
              <div className="px-4 pb-4 border-t border-[var(--color-border)]">
                <h4 className="mt-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Procedures</h4>
                {a.procedures()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// The Delegate… entry point, one component for every surface that offers it:
// the Reader toolbar, a list's or page's ribbon, and a calendar entry.
// An item that is not filed under a matter cannot be delegated (an agent's
// reach is defined by matters), so the button says why instead of opening.

import { useState } from 'react';
import { Send } from 'lucide-react';
import type { TaskRef } from '@/lib/agentTasks';
import DelegateCard from './DelegateCard';

const NO_MATTER_TITLE = 'Delegate… is available once this is filed under a matter.';

export default function DelegateButton({
  matterId,
  attachment,
  defaultTitle,
  variant,
}: {
  matterId: string | null | undefined;
  attachment: TaskRef | null;
  defaultTitle: string;
  /** 'toolbar' = the Reader's 32px icon row; 'ribbon' = a card ribbon; 'text' = a labelled button. */
  variant: 'toolbar' | 'ribbon' | 'text';
}) {
  const [open, setOpen] = useState(false);
  const disabled = !matterId;
  const title = disabled ? NO_MATTER_TITLE : 'Delegate… — hand this to an agent that can see this matter';

  const button =
    variant === 'toolbar' ? (
      <button
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
        title={title}
        aria-label="Delegate…"
      >
        <Send size={15} />
      </button>
    ) : variant === 'ribbon' ? (
      <button
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title={title}
        aria-label="Delegate…"
      >
        <Send size={14} strokeWidth={2} />
      </button>
    ) : (
      <button
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[rgba(255,255,255,0.12)] text-[11px] text-white/60 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title={title}
      >
        <Send size={12} /> Delegate…
      </button>
    );

  return (
    <>
      {button}
      {open && matterId && (
        <DelegateCard
          matterId={matterId}
          attachment={attachment}
          defaultTitle={defaultTitle}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

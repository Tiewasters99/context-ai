// A stage's sign-off: the reviewer's initials, stamped by the database with
// who and when. A stage cannot be signed off before its prerequisite (the
// database refuses it too; this says why first).

import { useState } from 'react';
import { signStage, rememberInitials, type ClearanceBundle } from '@/lib/trademark/data';
import { btn, btnPrimary, day } from './styles';
import { ErrorLine, InitialsField, StageChip } from './ui';

export default function SignOff({
  b, stage, initials, setInitials, blocked, onChanged, label = 'Sign off this stage',
}: {
  b: ClearanceBundle;
  stage: number;
  initials: string;
  setInitials: (v: string) => void;
  /** Why the stage cannot be signed off yet, or null when it can. */
  blocked: string | null;
  onChanged: () => Promise<void>;
  label?: string;
}) {
  const row = b.stages.find((s) => s.stage === stage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!row) return null;

  const act = async (status: 'done' | 'in_progress') => {
    setBusy(true); setError(null);
    try {
      await signStage(b.clearance, stage, status, initials);
      if (status === 'done') rememberInitials(initials);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 pt-3 border-t border-[rgba(255,255,255,0.06)]">
      <div className="flex flex-wrap items-center gap-2">
        <StageChip status={row.status} />
        {row.status === 'done' ? (
          <>
            <span className="text-[12.5px] text-white/75">Signed off {row.initials ? `(${row.initials}) ` : ''}{day(row.done_at)}</span>
            <button className={btn} disabled={busy} onClick={() => void act('in_progress')}>Reopen</button>
          </>
        ) : (
          <>
            <InitialsField value={initials} onChange={setInitials} />
            <button className={btnPrimary} disabled={busy || Boolean(blocked) || !initials.trim()} onClick={() => void act('done')}>
              {label}
            </button>
            {blocked && <span className="text-[12px] text-[var(--color-text-muted)]">{blocked}</span>}
          </>
        )}
      </div>
      <ErrorLine text={error} />
    </div>
  );
}

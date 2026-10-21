// The one-box start (slice 2). Type the marks, one per line, and one sentence
// on what they are for; the recipe opens one clearance per mark and runs to the
// first human step — the model's class and decomposition proposals, saved
// PROPOSED — and the review screen below shows them for the reviewer to
// confirm. Nothing is confirmed or signed here.

import { useState } from 'react';
import { marksFromText, startBatch, type BatchProgress } from '@/lib/trademark/data';
import { btnPrimary, field, label } from './styles';
import { ErrorLine, Note } from './ui';

const STEP_LABEL: Record<BatchProgress['step'], string> = {
  creating: 'opening…', classes: 'proposing classes…', decompose: 'proposing the decomposition…', proposed: 'proposed — ready to review', failed: 'stopped',
};

export default function StartBox({ matterId, onStarted, compact = false, disabled = false }: {
  matterId: string; onStarted: (ids: string[]) => Promise<void> | void; compact?: boolean; disabled?: boolean;
}) {
  const [marks, setMarks] = useState('');
  const [sentence, setSentence] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<BatchProgress[]>([]);
  const list = marksFromText(marks);

  const start = async () => {
    setBusy(true); setError(null); setProgress([]);
    try {
      const ids = await startBatch(matterId, list, sentence, setProgress);
      setMarks(''); setSentence('');
      await onStarted(ids);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? '' : 'rounded-lg border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.02)] px-4 py-4'}>
      {!compact && <h3 className="text-[14px] font-medium text-[var(--color-text-bright)] mb-1">Start a clearance</h3>}
      {!compact && (
        <Note>
          Type the marks and one sentence on what they are for. The recipe proposes the classes and the search terms for
          each mark and stops for you to confirm them. You then run the searches on the USPTO site and decide every hit.
        </Note>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div>
          <span className={label}>Marks, one per line</span>
          <textarea className={`${field} min-h-[96px] font-mono`} value={marks} onChange={(e) => setMarks(e.target.value)}
            placeholder={'QUALLET\nQUIDDIT\nQUIRLD'} aria-label="Marks, one per line" spellCheck={false} />
        </div>
        <div>
          <span className={label}>What they are for, in one sentence</span>
          <textarea className={`${field} min-h-[96px]`} value={sentence} onChange={(e) => setSentence(e.target.value)}
            placeholder="A mobile wallet app and payment services for small businesses" aria-label="What the marks are for" />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className={btnPrimary} disabled={disabled || busy || !list.length || !sentence.trim() || list.length > 10} onClick={() => void start()}>
          {busy ? 'Working…' : list.length > 1 ? `Start ${list.length} clearances` : 'Start'}
        </button>
        {list.length > 10 && <span className="text-[12px] text-[#f8a1a1]">At most 10 marks at a time.</span>}
        {!busy && list.length > 0 && list.length <= 10 && (
          <span className="text-[12px] text-[var(--color-text-muted)]">{list.join(' · ')}</span>
        )}
      </div>
      {progress.length > 0 && (
        <ul className="mt-2 space-y-0.5" aria-live="polite">
          {progress.map((p) => (
            <li key={p.mark} className="text-[12px] text-white/75">
              <span className="font-mono">{p.mark}</span> — {STEP_LABEL[p.step]}{p.error ? `: ${p.error}` : ''}
            </li>
          ))}
        </ul>
      )}
      <ErrorLine text={error} />
    </div>
  );
}

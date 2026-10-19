// The Agents page's Recipes section: one card, Trademark clearance. Pick a
// matter, type the mark, start a clearance, and land on the matter's
// Trademark tab. No agent task is created: the recipe's work lives in the
// matter, and the reviewer runs it stage by stage.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Stamp } from 'lucide-react';
import MatterSelect from '@/components/agents/MatterSelect';
import { createClearance } from '@/lib/trademark/data';
import { btnPrimary, field, label } from './styles';
import { ErrorLine } from './ui';

export default function RecipeCard() {
  const navigate = useNavigate();
  const [matterId, setMatterId] = useState('');
  const [mark, setMark] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      await createClearance(matterId, mark);
      navigate(`/app/matterspace/${matterId}?tab=Trademark`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
          <Stamp size={16} className="text-[var(--color-primary)]" strokeWidth={1.75} />
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-medium text-[var(--color-text-bright)]">Trademark clearance — knockout search, reviewed by you</h3>
          <p className="mt-0.5 text-[12.5px] text-[var(--color-text-secondary)] leading-relaxed">
            A U.S. federal register knockout search for a proposed mark: intake, classes, generated queries you run on the
            USPTO search page, every hit decided by you with your initials, and a report filed into the matter. It never
            says a mark is clear.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto] items-end">
            <div><span className={label}>Matter</span><MatterSelect value={matterId} onChange={setMatterId} /></div>
            <div><span className={label}>Mark</span>
              <input className={field} value={mark} onChange={(e) => setMark(e.target.value)} placeholder="Exactly as it will be used" maxLength={200} />
            </div>
            <button className={btnPrimary} disabled={busy || !matterId || !mark.trim()} onClick={() => void start()}>
              {busy ? 'Starting…' : 'Start'}
            </button>
          </div>
          <ErrorLine text={error} />
        </div>
      </div>
    </div>
  );
}

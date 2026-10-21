// The Agents page's Recipes section: one card, Trademark clearance. Pick a
// matter, type the marks (one per line) and one sentence, and land on the
// matter's Trademark tab with the proposals ready to review (slice 2's one-box
// start). No agent task is created: the recipe's work lives in the matter.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Stamp } from 'lucide-react';
import MatterSelect from '@/components/agents/MatterSelect';
import { label } from './styles';
import StartBox from './StartBox';

export default function RecipeCard() {
  const navigate = useNavigate();
  const [matterId, setMatterId] = useState('');

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
          <Stamp size={16} className="text-[var(--color-primary)]" strokeWidth={1.75} />
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-medium text-[var(--color-text-bright)]">Trademark clearance — knockout search, reviewed by you</h3>
          <p className="mt-0.5 text-[12.5px] text-[var(--color-text-secondary)] leading-relaxed">
            A U.S. federal register knockout search for one or more proposed marks: type the marks and one sentence; the
            recipe proposes classes and search terms, you confirm them and run the queries on the USPTO search page, you
            decide every hit, and the report and an application draft (use-based or intent-to-use) are filed into the
            matter for you to sign off. It never says a mark is clear, and it never files with the USPTO.
          </p>
          <div className="mt-3 max-w-[420px]"><span className={label}>Matter</span><MatterSelect value={matterId} onChange={setMatterId} /></div>
          <StartBox compact matterId={matterId} disabled={!matterId} onStarted={() => navigate(`/app/matterspace/${matterId}?tab=Trademark`)} />
        </div>
      </div>
    </div>
  );
}

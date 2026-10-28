// The Trademark Agent's procedure on the Agents page (under Equazia Agents →
// Trademark Agent → Procedures): Trademark clearance. Pick a matter, type the
// marks (one per line) and one sentence, and land on the matter's Trademark
// tab with the proposals ready to review (slice 2's one-box start). No agent
// task is created: the procedure's work lives in the matter.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MatterSelect from '@/components/agents/MatterSelect';
import { label } from './styles';
import StartBox from './StartBox';

export default function ProcedureCard() {
  const navigate = useNavigate();
  const [matterId, setMatterId] = useState('');

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-4">
      <h3 className="text-[14px] font-medium text-[var(--color-text-bright)]">Trademark clearance — knockout search, reviewed by you</h3>
      <p className="mt-0.5 text-[12.5px] text-[var(--color-text-secondary)] leading-relaxed">
        A U.S. federal register knockout search for one or more proposed marks: type the marks and one sentence; the
        procedure proposes classes and search terms, you confirm them and run the queries on the USPTO search page, you
        decide every hit, and the report and an application draft (use-based or intent-to-use) are filed into the
        matter for you to sign off. It never says a mark is clear, and it never files with the USPTO.
      </p>
      <div className="mt-3 max-w-[420px]"><span className={label}>Matter</span><MatterSelect value={matterId} onChange={setMatterId} /></div>
      <StartBox compact matterId={matterId} disabled={!matterId} onStarted={() => navigate(`/app/matterspace/${matterId}?tab=Trademark`)} />
    </div>
  );
}

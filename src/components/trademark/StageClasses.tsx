// Stage 2 — Classes. Two lists side by side: search classes (broad) and
// filing classes (only where there is dated evidence of a bona fide intent).
// "Propose classes" asks the model; the reviewer accepts or edits.

import { useState } from 'react';
import { saveClasses, trademarkApi, type ClassEntry, type ClearanceBundle } from '@/lib/trademark/data';
import { PROCEDURE } from '../../../lib/trademark/procedure.mjs';
import { btn, btnPrimary, field, label } from './styles';
import { ErrorLine, Note, Panel } from './ui';
import SignOff from './SignOff';

function ClassList({ title, rows, setRows, hint }: { title: string; rows: ClassEntry[]; setRows: (r: ClassEntry[]) => void; hint: string }) {
  return (
    <div>
      <span className={label}>{title}</span>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2">
            <input className={`${field} w-[70px] shrink-0`} value={r.code} placeholder="009" maxLength={3} aria-label="Class"
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, code: e.target.value.replace(/\D/g, '') } : x)))} />
            <input className={field} value={r.reason} placeholder={hint} aria-label="Reason"
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} />
            <button className={btn} onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove">×</button>
          </div>
        ))}
        <button className={btn} onClick={() => setRows([...rows, { code: '', reason: '' }])}>Add a class</button>
      </div>
    </div>
  );
}

export default function StageClasses({ b, initials, setInitials, onChanged }: {
  b: ClearanceBundle; initials: string; setInitials: (v: string) => void; onChanged: () => Promise<void>;
}) {
  const c = b.clearance;
  const [search, setSearch] = useState<ClassEntry[]>(c.search_classes ?? []);
  const [filing, setFiling] = useState<ClassEntry[]>(c.filing_classes ?? []);
  const [busy, setBusy] = useState<'save' | 'propose' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposedBy, setProposedBy] = useState<string | null>(null);

  const propose = async () => {
    setBusy('propose'); setError(null);
    try {
      const { proposal } = await trademarkApi<{ proposal: { search: ClassEntry[]; filing: ClassEntry[]; model: string } }>('classes', { clearance_id: c.id });
      setSearch(proposal.search.map((x) => ({ ...x, model: proposal.model })));
      setFiling(proposal.filing.map((x) => ({ ...x, model: proposal.model })));
      setProposedBy(proposal.model);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save'); setError(null);
    try {
      await saveClasses(c, search, filing);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel id="tm-stage-2" title="2. Classes" aside={
      <button className={btn} disabled={busy !== null} onClick={() => void propose()}>{busy === 'propose' ? 'Asking…' : 'Propose classes'}</button>
    }>
      <Note>
        Filing classes must be a subset of search classes, and every filing class needs a reason that names the dated
        evidence of intent (M.Z. Berger &amp; Co. v. Swatch AG, 787 F.3d 1368 (Fed. Cir. 2015)).
      </Note>
      {proposedBy && <p className="mt-2 text-[12px] text-[#e8b84a]">Proposed by {proposedBy}. Review each class and reason, then save.</p>}
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <ClassList title="Search classes" rows={search} setRows={setSearch} hint="why search here" />
        <ClassList title="Filing classes" rows={filing} setRows={setFiling} hint="the dated evidence of intent" />
      </div>
      <details className="mt-3">
        <summary className="text-[12px] text-white/70 cursor-pointer">Class notes</summary>
        <ul className="mt-2 space-y-1">
          {PROCEDURE.classes.notes.map((n) => (
            <li key={n.code} className="text-[12px] text-white/75"><span className="font-mono">{n.code}</span> {n.label}. <span className="text-white/55">{n.why}</span></li>
          ))}
        </ul>
      </details>
      <div className="mt-4"><button className={btnPrimary} disabled={busy !== null} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save classes'}</button></div>
      <ErrorLine text={error} />
      <SignOff b={b} stage={2} initials={initials} setInitials={setInitials} onChanged={onChanged}
        blocked={(c.search_classes ?? []).length === 0 ? 'Save at least one search class first.' : null} />
    </Panel>
  );
}

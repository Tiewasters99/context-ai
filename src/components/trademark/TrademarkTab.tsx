// The matter's Trademark tab (Trademark Clearance, a recipe; migration 121).
//
// Shown only when the matter holds at least one clearance. A matter may hold
// several (several marks); they are listed, one open at a time. The work
// surface is a docket: the header line, the stage list, then one panel per
// stage in order (1–5 and 8 in this version), and the Method panel. The
// reviewer decides every bin and signs every stage; nothing here says a mark
// is clear.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import {
  createClearance, listClearances, loadClearance, savedInitials, LATER_STAGES, STAGE_NAMES, type ClearanceBundle,
} from '@/lib/trademark/data';
import { btn, btnPrimary, day, field, mono, td, th } from './styles';
import { ErrorLine, Note, Scroll, StageChip } from './ui';
import StageIntake from './StageIntake';
import StageClasses from './StageClasses';
import StageTerms from './StageTerms';
import StageSearch from './StageSearch';
import StageTriage from './StageTriage';
import StageReport from './StageReport';
import MethodPanel from './MethodPanel';

const TM_LIST_KEY = (matterId: string) => ['tm_clearances', matterId];
const TM_KEY = (id: string) => ['tm_clearance', id];

function outputOf(b: ClearanceBundle, stage: number): string {
  switch (stage) {
    case 3: return b.queries.length ? `${b.queries.length} queries` : '—';
    case 4: {
      const run = new Set(b.runs.map((r) => r.query_id)).size;
      return b.queries.length ? `${run} of ${b.queries.length} run` : '—';
    }
    case 5: return b.hits.length ? `${b.hits.length} hits` : '—';
    case 8: return b.stages.find((s) => s.stage === 8)?.output_document_id ? 'filed' : '—';
    default: return '—';
  }
}

function Docket({ b }: { b: ClearanceBundle }) {
  return (
    <Scroll>
      <table className="w-full min-w-[520px] border-collapse">
        <thead><tr className="border-b border-white/10"><th className={th}>#</th><th className={th}>Stage</th><th className={th}>Status</th><th className={th}>Done by</th><th className={th}>Output</th></tr></thead>
        <tbody>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
            const s = b.stages.find((x) => x.stage === n);
            const later = LATER_STAGES.has(n);
            return (
              <tr key={n} className="border-b border-white/5">
                <td className={td}>{n}</td>
                <td className={td}>{later ? STAGE_NAMES[n] : <a className="hover:underline" href={`#tm-stage-${n}`}>{STAGE_NAMES[n]}</a>}</td>
                <td className={td}><StageChip status={later && s?.status !== 'skipped' ? 'later' : (s?.status ?? 'pending')} /></td>
                <td className={td}>{s?.initials ? `${s.initials}, ${day(s.done_at)}` : ''}</td>
                <td className={td}>{later ? '' : outputOf(b, n)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Scroll>
  );
}

function ClearanceView({ id, matterName }: { id: string; matterName: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [initials, setInitials] = useState(savedInitials());
  const [showMethod, setShowMethod] = useState(false);
  const q = useQuery({ queryKey: TM_KEY(id), queryFn: () => loadClearance(id), staleTime: 5_000 });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: TM_KEY(id) }); };

  if (q.isLoading) return <p className="text-[12.5px] text-[var(--color-text-muted)] italic">Reading the clearance…</p>;
  if (q.error || !q.data) return <ErrorLine text={(q.error as Error)?.message ?? 'Could not read the clearance.'} />;
  const b = q.data;
  const c = b.clearance;
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const preparer = String(meta.display_name ?? meta.full_name ?? user?.email ?? 'the reviewer');
  const common = { b, initials, setInitials, onChanged: refresh };

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-[20px] font-serif text-[var(--color-text-bright)]">{c.mark}</h2>
        <span className="text-[12.5px] text-white/70">{c.applicant?.legal_name || 'Applicant not stated'}</span>
        <span className="text-[12.5px] text-white/55">{matterName} · created {day(c.created_at)}</span>
        <span className={`text-[11.5px] text-white/45 ${mono}`}>{c.procedure_hash ? `procedure ${c.procedure_hash.slice(0, 12)}…` : 'queries not generated'}</span>
        <button className={`${btn} ml-auto`} onClick={() => setShowMethod(!showMethod)}>{showMethod ? 'Hide method' : 'Method'}</button>
      </div>
      <Note>Every bin and every stage sign-off is the reviewer's; the model only proposes.</Note>
      <div className="mt-3"><Docket b={b} /></div>
      {showMethod && <MethodPanel storedHash={c.procedure_hash} />}
      <StageIntake key={`1:${c.id}`} {...common} />
      <StageClasses key={`2:${c.id}`} {...common} />
      <StageTerms key={`3:${c.id}`} {...common} />
      <StageSearch key={`4:${c.id}`} {...common} />
      <StageTriage key={`5:${c.id}`} {...common} />
      <StageReport key={`8:${c.id}`} {...common} matterName={matterName} preparerName={preparer} />
    </div>
  );
}

export default function TrademarkTab({ matterId, matterName }: { matterId: string; matterName: string }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: TM_LIST_KEY(matterId), queryFn: () => listClearances(matterId) });
  const [chosen, setChosen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [mark, setMark] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = list.data ?? [];
  const openId = chosen && rows.some((r) => r.id === chosen) ? chosen : rows[0]?.id ?? null;

  const add = async () => {
    setBusy(true); setError(null);
    try {
      const id = await createClearance(matterId, mark);
      setMark(''); setAdding(false);
      await qc.invalidateQueries({ queryKey: TM_LIST_KEY(matterId) });
      setChosen(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Trademark clearance</span>
        {rows.length > 1 && rows.map((r) => (
          <button key={r.id} className={`${btn} ${r.id === openId ? 'border-[#e8b84a] text-[#e8b84a]' : ''}`} onClick={() => setChosen(r.id)}>{r.mark}</button>
        ))}
        <button className={btn} onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'Another mark'}</button>
      </div>
      {adding && (
        <div className="mb-4 flex flex-wrap gap-2">
          <input className={`${field} max-w-[320px]`} value={mark} onChange={(e) => setMark(e.target.value)} placeholder="The mark, exactly as it will be used" maxLength={200} />
          <button className={btnPrimary} disabled={busy || !mark.trim()} onClick={() => void add()}>{busy ? 'Creating…' : 'Start a clearance'}</button>
        </div>
      )}
      <ErrorLine text={error} />
      {list.isLoading && <p className="text-[12.5px] text-[var(--color-text-muted)] italic">Reading…</p>}
      {list.error && <ErrorLine text={(list.error as Error).message} />}
      {!list.isLoading && !list.error && rows.length === 0 && <Note>No clearance in this matter yet.</Note>}
      {openId && <ClearanceView key={openId} id={openId} matterName={matterName} />}
    </div>
  );
}

// The matter's Trademark tab (Trademark Clearance, a recipe; migrations 121, 122).
//
// Shown only when the matter holds at least one clearance. Slice 2 puts the
// work in the order a person meets it:
//   1. the one box — marks, one per line, and one sentence; the recipe runs
//      each mark to its first human step;
//   2. ONE review screen for every mark not yet confirmed (BatchReview): the
//      proposals, accept or edit, one confirmation per mark with initials;
//   3. ONE search sheet for every query not yet run, across the marks
//      (SearchSheet) — the USPTO search is the person's;
//   4. per mark, the docket and the stage panels (1–6, 8, 9), the reviewer's
//      decisions and sign-offs, unchanged in substance.
// Triage is proposed on its own when a mark's last query is recorded; the
// report preview assembles on its own. Nothing here says a mark is clear, and
// every bin and every sign-off is still the reviewer's.

import { useEffect, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import {
  listClearances, loadClearance, savedInitials, trademarkApi, LATER_STAGES, STAGE_NAMES, type ClearanceBundle,
} from '@/lib/trademark/data';
import { isDead, latestRuns, selfTestState } from '../../../lib/trademark/triage.mjs';
import { btn, day, mono, td, th } from './styles';
import { ErrorLine, Note, Scroll, StageChip } from './ui';
import StartBox from './StartBox';
import BatchReview from './BatchReview';
import SearchSheet from './SearchSheet';
import StageIntake from './StageIntake';
import StageClasses from './StageClasses';
import StageTerms from './StageTerms';
import StageSearch from './StageSearch';
import StageTriage from './StageTriage';
import StageDeepCheck from './StageDeepCheck';
import StageReport from './StageReport';
import StageApplication from './StageApplication';
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
    case 6: {
      const t = b.hits.filter((h) => h.bin === 'flag' || (!h.bin && h.proposed?.bin === 'flag') || h.deep_check);
      return t.length ? `${t.filter((h) => h.tsdr_checked_at).length} of ${t.length} fetched` : '—';
    }
    case 8: return b.stages.find((s) => s.stage === 8)?.output_document_id ? 'filed' : '—';
    case 9: {
      const s9 = b.stages.find((s) => s.stage === 9);
      return s9?.status === 'done' ? 'reviewed copy filed' : b.clearance.application?.draft ? 'DRAFT filed' : '—';
    }
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

function ClearanceView({ b, matterName, initials, setInitials, refresh }: {
  b: ClearanceBundle; matterName: string; initials: string; setInitials: (v: string) => void; refresh: () => Promise<void>;
}) {
  const { user } = useAuth();
  const [showMethod, setShowMethod] = useState(false);
  const c = b.clearance;
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const preparer = String(meta.display_name ?? meta.full_name ?? user?.email ?? 'the reviewer');
  const common = { b, initials, setInitials, onChanged: refresh };

  return (
    <div className="mt-6">
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
      <StageIntake key={`1:${c.id}:${c.updated_at}`} {...common} />
      <StageClasses key={`2:${c.id}:${c.updated_at}`} {...common} />
      <StageTerms key={`3:${c.id}:${c.updated_at}`} {...common} />
      <StageSearch key={`4:${c.id}`} {...common} />
      <StageTriage key={`5:${c.id}`} {...common} />
      <StageDeepCheck key={`6:${c.id}`} {...common} />
      <StageReport key={`8:${c.id}`} {...common} matterName={matterName} preparerName={preparer} />
      <StageApplication key={`9:${c.id}:${c.updated_at}`} {...common} />
    </div>
  );
}

/** Ready for triage: every query run, the self-test passed, live hits without a proposal or a decision. */
function needsTriage(b: ClearanceBundle): boolean {
  if (!b.queries.length || b.stages.find((s) => s.stage === 5)?.status === 'done') return false;
  const latest = latestRuns(b.runs);
  if (b.queries.some((q) => !latest.has(q.id))) return false;
  if (selfTestState(b.queries, b.runs) !== 'passed') return false;
  return b.hits.some((h) => !isDead(h) && !h.bin && !h.proposed);
}

export default function TrademarkTab({ matterId, matterName }: { matterId: string; matterName: string }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: TM_LIST_KEY(matterId), queryFn: () => listClearances(matterId) });
  const rows = list.data ?? [];
  const bundles = useQueries({ queries: rows.map((r) => ({ queryKey: TM_KEY(r.id), queryFn: () => loadClearance(r.id), staleTime: 5_000 })) });
  const loaded = bundles.map((q) => q.data).filter((x): x is ClearanceBundle => Boolean(x));
  const [chosen, setChosen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [initials, setInitials] = useState(savedInitials());
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const openId = chosen && rows.some((r) => r.id === chosen) ? chosen : rows[0]?.id ?? null;
  const open = loaded.find((b) => b.clearance.id === openId) ?? null;

  const refreshAll = async () => {
    await qc.invalidateQueries({ queryKey: TM_LIST_KEY(matterId) });
    await qc.invalidateQueries({ queryKey: ['tm_clearance'] });
  };

  // Triage runs on its own when a mark's last query is recorded (proposals only).
  const triaged = useRef(new Set<string>());
  useEffect(() => {
    const due = loaded.filter((b) => needsTriage(b) && !triaged.current.has(b.clearance.id));
    if (!due.length) return;
    for (const b of due) triaged.current.add(b.clearance.id);
    void (async () => {
      for (const b of due) {
        try {
          setAutoNote(`Proposing triage for ${b.clearance.mark}…`);
          for (let i = 0; i < 20; i++) {
            const out = await trademarkApi<{ proposed: number; remaining: number }>('triage', { clearance_id: b.clearance.id });
            if (!out.remaining || out.proposed === 0) break;
          }
          setAutoNote(`Triage proposed for ${b.clearance.mark}. Decide each record in stage 5.`);
        } catch (e) {
          setAutoNote(`Triage for ${b.clearance.mark} was not proposed: ${e instanceof Error ? e.message : String(e)} Use "Propose triage" in stage 5.`);
        }
      }
      await refreshAll();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded.map((b) => `${b.clearance.id}:${b.runs.length}:${b.hits.length}`).join('|')]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Trademark clearance</span>
        <button className={`${btn} ml-auto`} onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'More marks'}</button>
      </div>
      {(adding || (!list.isLoading && rows.length === 0)) && (
        <div className="mb-4"><StartBox matterId={matterId} onStarted={async () => { setAdding(false); await refreshAll(); }} /></div>
      )}
      {list.isLoading && <p className="text-[12.5px] text-[var(--color-text-muted)] italic">Reading…</p>}
      {list.error && <ErrorLine text={(list.error as Error).message} />}
      {autoNote && <p className="mb-2 text-[12.5px] text-white/75" role="status">{autoNote}</p>}

      <BatchReview bundles={loaded} initials={initials} setInitials={setInitials} onChanged={refreshAll} onOpen={(id) => {
        setChosen(id); setTimeout(() => document.getElementById('tm-stage-2')?.scrollIntoView({ behavior: 'smooth' }), 50);
      }} />
      <SearchSheet bundles={loaded} onChanged={refreshAll} />

      {rows.length > 1 && (
        <div className="mt-6 flex flex-wrap items-center gap-2" role="tablist" aria-label="Marks">
          {rows.map((r) => (
            <button key={r.id} role="tab" aria-selected={r.id === openId} className={`${btn} ${r.id === openId ? 'border-[#e8b84a] text-[#e8b84a]' : ''}`} onClick={() => setChosen(r.id)}>{r.mark}</button>
          ))}
        </div>
      )}
      {openId && !open && <p className="mt-4 text-[12.5px] text-[var(--color-text-muted)] italic">Reading the clearance…</p>}
      {open && <ClearanceView key={open.clearance.id} b={open} matterName={matterName} initials={initials} setInitials={setInitials} refresh={refreshAll} />}
    </div>
  );
}

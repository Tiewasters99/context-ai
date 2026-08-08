import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { findModel } from '@/lib/llm';
import { GoldButton, QuietButton, Working, Notice } from '@/components/mediation/ui';
import { samplePanel } from '@/lib/courtroom/sampler.ts';
import { runSession, flatnessAlarm } from '@/lib/courtroom/engine.ts';
import { composeReport } from '@/lib/courtroom/report.ts';
import { makeLivePorts } from '@/lib/courtroom/live.ts';
import { newUsage, formatUsage } from '@/lib/courtroom/meter.ts';
import { NOT_FOR_JURY_SELECTION, computeSplit } from '@/lib/courtroom/prompts.ts';
import {
  clearSessionData, deleteJurors, fileReportToMatter, getReport, getTrial,
  listJurors, listSegments, saveBallot, saveJurors, saveReaction, saveReport,
  saveTurn, updateTrial, updateTrialSeed, type TrialListRow,
} from '@/lib/courtroom/persist.ts';
import type {
  Ballot, DeliberationTurn, JurorProfile, ProgressEvent, Segment, UsageRecord,
} from '@/lib/courtroom/types.ts';
import PanelSheet from './PanelSheet';
import SegmentComposer from './SegmentComposer';
import ReportView from './ReportView';

// The trial room — one linear, lawyerly flow (spec §11 Phase 1):
//   panel sheet → the record → the session, live → the Rehearsal Report.

export default function TrialRoom() {
  const { id } = useParams();
  const [trial, setTrial] = useState<TrialListRow | null>(null);
  const [jurors, setJurors] = useState<JurorProfile[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [report, setReport] = useState<{ markdown: string; document_id: string | null } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Live session state
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [liveTurns, setLiveTurns] = useState<DeliberationTurn[]>([]);
  const [liveBallots, setLiveBallots] = useState<Ballot[]>([]);
  const runLock = useRef(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([getTrial(id), listJurors(id), listSegments(id), getReport(id)])
      .then(([t, j, s, r]) => {
        if (!t) { setLoadError('Rehearsal not found.'); return; }
        setTrial(t); setJurors(j); setSegments(s); setReport(r);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not open the rehearsal.'));
  }, [id]);

  const jurorName = useMemo(() => {
    const m = new Map(jurors.map((j) => [j.id, `${j.display_name} (seat ${j.seat})`]));
    return (jid: string) => m.get(jid) ?? jid;
  }, [jurors]);

  /* ------------------------------ Stages ------------------------------ */

  const empanel = async () => {
    if (!trial) return;
    setBusy(true);
    setError('');
    try {
      await updateTrial(trial.id, { status: 'segments' });
      setTrial({ ...trial, status: 'segments' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not empanel.');
    } finally {
      setBusy(false);
    }
  };

  const resample = async () => {
    if (!trial) return;
    setBusy(true);
    setError('');
    try {
      const nextSeed = (trial.seed + 1) | 0;
      await deleteJurors(trial.id);
      await updateTrialSeed(trial.id, nextSeed);
      const { panel_size, ...mix } = trial.venue_mix;
      const fresh = await saveJurors(trial, samplePanel(mix, nextSeed, panel_size));
      setJurors(fresh);
      setTrial({ ...trial, seed: nextSeed });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not resample the venire.');
    } finally {
      setBusy(false);
    }
  };

  const onJurorSaved = useCallback((j: JurorProfile) => {
    setJurors((prev) => prev.map((x) => (x.id === j.id ? j : x)));
  }, []);

  /* ----------------------------- The session -------------------------- */

  const run = async () => {
    if (!trial || runLock.current || jurors.length === 0 || segments.length === 0) return;
    runLock.current = true;
    setRunning(true);
    setError('');
    setLiveTurns([]);
    setLiveBallots([]);
    try {
      await clearSessionData(trial.id);
      await updateTrial(trial.id, { status: 'running' });
      setTrial((t) => (t ? { ...t, status: 'running' } : t));

      const usage = newUsage(trial.model_id);
      let usageCounter = 0;
      const ports = makeLivePorts({
        modelId: trial.model_id,
        usage,
        onProgress: setProgress,
        saveReaction: (r) => saveReaction(trial, r),
        saveBallot: async (b) => {
          setLiveBallots((prev) => [...prev, b]);
          await saveBallot(trial, b);
        },
        saveTurn: async (t) => {
          setLiveTurns((prev) => [...prev, t]);
          await saveTurn(trial, t);
        },
        onUsage: (u) => {
          usageCounter += 1;
          if (usageCounter % 12 === 0) void updateTrial(trial.id, { usage: u });
        },
      });

      const result = await runSession(
        { trialTitle: trial.title, jurors, segments },
        ports,
      );

      setProgress({ stage: 'report', detail: 'Writing the Rehearsal Report' });
      let markdown = await composeReport({
        trialTitle: trial.title,
        matterName: trial.matterspace?.name ?? 'the matter',
        modelName: findModel(trial.model_id)?.model.name ?? trial.model_id,
        panel: jurors,
        segments,
        reactions: result.reactions,
        deliberation: result.deliberation,
        usage,
        generatedAt: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      }, ports);

      // Runtime flatness alarm (§6.6): flat deliberation is a defect —
      // surface it on the record, not in a toast that evaporates.
      const alarm = flatnessAlarm(result);
      if (alarm) {
        const lines = markdown.split('\n');
        lines.splice(1, 0, '', `> ⚠ FLATNESS ALARM: ${alarm} Treat this session's deliberation as unreliable.`);
        markdown = lines.join('\n');
      }

      setProgress({ stage: 'report', detail: 'Filing the report into the matter' });
      const documentId = await fileReportToMatter(trial, markdown).catch(() => null);
      await saveReport(trial, markdown, documentId);
      await updateTrial(trial.id, { status: 'complete', usage });
      setReport({ markdown, document_id: documentId });
      setTrial((t) => (t ? { ...t, status: 'complete', usage } : t));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The session failed.');
      await updateTrial(trial.id, { status: 'error' }).catch(() => undefined);
      setTrial((t) => (t ? { ...t, status: 'error' } : t));
    } finally {
      runLock.current = false;
      setRunning(false);
      setProgress(null);
    }
  };

  /* ------------------------------- Render ------------------------------ */

  if (loadError) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 sm:px-8 sm:py-12"><Notice>{loadError}</Notice></div>
    );
  }
  if (!trial) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 sm:px-8 sm:py-12"><Working>Opening the courtroom…</Working></div>
    );
  }

  const modelName = findModel(trial.model_id)?.model.name ?? trial.model_id;
  const usage = trial.usage as UsageRecord;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:px-8 sm:py-12">
      <header className="mb-7">
        <p className="text-[11px] uppercase tracking-[0.18em] text-[#d4a054] mb-2">
          <Link to="/app/courtroom" className="hover:text-[#e8b84a] transition-colors">The Courtroom</Link>
        </p>
        <h1 className="text-[22px] sm:text-[26px] font-semibold tracking-tight text-white" style={{ fontFamily: '"Playfair Display Variable", serif' }}>
          {trial.title}
        </h1>
        <p className="text-[12.5px] text-white/50 mt-1.5">
          {trial.matterspace?.name ?? 'matter'}
          <span className="mx-2 text-white/25">—</span>
          panel of {jurors.length || trial.venue_mix.panel_size} · {modelName}
          {usage?.calls ? <><span className="mx-2 text-white/25">—</span>{formatUsage(usage)}</> : null}
        </p>
        <p className="text-[10.5px] text-white/30 mt-2 max-w-xl leading-relaxed">{NOT_FOR_JURY_SELECTION}</p>
        <div className="mt-4 h-px w-24 bg-gradient-to-r from-[#d4a054] to-transparent" />
      </header>

      {error && <div className="mb-5"><Notice>{error}</Notice></div>}

      {/* Stage: approve the panel */}
      {trial.status === 'empanel' && (
        <PanelSheet
          jurors={jurors}
          onJurorSaved={(j) => { onJurorSaved(j); }}
          onResample={() => void resample()}
          onEmpanel={() => void empanel()}
          busy={busy}
        />
      )}

      {/* Stage: build the record */}
      {trial.status === 'segments' && (
        <SegmentComposer
          trial={trial}
          segments={segments}
          onSegmentsChanged={setSegments}
          onBegin={() => void run()}
          busy={running}
        />
      )}

      {/* Stage: interrupted run (tab closed mid-session) */}
      {trial.status === 'running' && !running && (
        <div className="rounded-lg border border-[rgba(212,160,84,0.25)] bg-[rgba(212,160,84,0.04)] px-5 py-5 mb-6">
          <p className="text-[13px] text-white/70 leading-relaxed mb-4">
            This session was interrupted before the panel finished. Restart it — the panel will
            react, ballot, and deliberate from the top.
          </p>
          <GoldButton onClick={() => void run()}><RotateCcw size={14} /> Restart the session</GoldButton>
        </div>
      )}

      {/* Stage: the session, live */}
      {running && (
        <SessionLive
          jurors={jurors}
          progress={progress}
          turns={liveTurns}
          ballots={liveBallots}
          jurorName={jurorName}
        />
      )}

      {/* Stage: the work product */}
      {trial.status === 'complete' && report && !running && (
        <>
          <ReportView markdown={report.markdown} documentId={report.document_id} trialTitle={trial.title} />
          <div className="mt-6">
            <QuietButton onClick={() => void run()}>
              <RotateCcw size={13} /> Run the session again (replaces this report)
            </QuietButton>
          </div>
        </>
      )}

      {trial.status === 'error' && !running && (
        <div className="mt-2">
          <GoldButton onClick={() => void run()}><RotateCcw size={14} /> Run the session again</GoldButton>
        </div>
      )}
    </div>
  );
}

/* ========================== Live session surface ========================== */

function SessionLive({
  jurors, progress, turns, ballots, jurorName,
}: {
  jurors: JurorProfile[];
  progress: ProgressEvent | null;
  turns: DeliberationTurn[];
  ballots: Ballot[];
  jurorName: (id: string) => string;
}) {
  const rounds = useMemo(() => {
    const byRound = new Map<number, Ballot[]>();
    for (const b of ballots) {
      const list = byRound.get(b.round) ?? [];
      list.push(b);
      byRound.set(b.round, list);
    }
    return [...byRound.entries()].sort((a, b) => a[0] - b[0]);
  }, [ballots]);

  return (
    <section aria-label="Session in progress">
      {/* Who has the floor */}
      <div className="rounded-lg border border-[rgba(212,160,84,0.25)] bg-[rgba(212,160,84,0.04)] px-5 py-4 mb-5">
        <Working>{progress?.detail ?? 'The panel is settling in…'}</Working>
        <div className="flex gap-1.5 mt-3" aria-hidden>
          {jurors.map((j) => (
            <span
              key={j.id}
              title={`Seat ${j.seat} — ${j.display_name}`}
              className={`h-2.5 flex-1 rounded-sm transition-colors ${
                progress?.seat === j.seat ? 'bg-[#e8b84a]' : 'bg-[rgba(212,160,84,0.18)]'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Ballot board */}
      {rounds.length > 0 && (
        <div className="rounded-lg border border-[rgba(255,255,255,0.08)] px-5 py-4 mb-5" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
          <h3 className="text-[11px] uppercase tracking-wider text-white/50 mb-2.5">Ballot board</h3>
          <ol className="space-y-1.5">
            {rounds.map(([round, list]) => {
              const split = computeSplit(list);
              return (
                <li key={round} className="flex items-center gap-3 text-[12.5px] text-white/75">
                  <span className="w-24 shrink-0 text-white/40">{round === 0 ? 'Secret ballot' : `Round ${round}`}</span>
                  <span className="text-[#8fd4a0]">{split.ours} with us</span>
                  <span className="text-[#e0a9a9]">{split.theirs} against</span>
                  <span className="text-white/40">{split.undecided} undecided</span>
                  <span className="text-white/25">({list.length}/{jurors.length} in)</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {/* Deliberation feed */}
      {turns.length > 0 && (
        <div className="rounded-lg border border-[rgba(255,255,255,0.08)] px-5 py-4" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
          <h3 className="text-[11px] uppercase tracking-wider text-white/50 mb-3">Deliberation — the jury room</h3>
          <div className="space-y-3 max-h-[26rem] overflow-y-auto pr-1">
            {turns.map((t, i) => (
              <div key={i}>
                <span className="block text-[10px] uppercase tracking-wider text-[#d4a054] mb-0.5">
                  {t.role === 'foreman' ? 'Foreman — ' : ''}{jurorName(t.juror_id)} · round {t.round}
                  {t.responding_to ? ` · answering ${t.responding_to}` : ''}
                </span>
                <p className="text-[13px] text-white/80 leading-relaxed whitespace-pre-wrap border-l border-[rgba(212,160,84,0.25)] pl-3">
                  {t.speech}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

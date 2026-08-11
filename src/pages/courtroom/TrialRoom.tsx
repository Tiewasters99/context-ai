import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RotateCcw, Square } from 'lucide-react';
import { findModel } from '@/lib/llm';
import { GoldButton, QuietButton, Working, Notice } from '@/components/mediation/ui';
import { samplePanel } from '@/lib/courtroom/sampler.ts';
import { runSession, flatnessAlarm, MAX_ROUNDS, SessionAborted } from '@/lib/courtroom/engine.ts';
import { composeReport } from '@/lib/courtroom/report.ts';
import { makeLivePorts } from '@/lib/courtroom/live.ts';
import { newUsage, formatUsage } from '@/lib/courtroom/meter.ts';
import { NOT_FOR_JURY_SELECTION, computeSplit } from '@/lib/courtroom/prompts.ts';
import {
  addSegment, clearSessionData, deleteJurors, fileReportToMatter, getReport,
  getTrial, listExhibitEvents, listJurors, listSegments, saveBallot,
  saveExhibitPublication, saveJurors, saveProcedureEvent,
  saveReaction, saveReport, saveTurn, updateTrial, updateTrialSeed,
  type TrialListRow,
} from '@/lib/courtroom/persist.ts';
import {
  exhibitExcerpt, exhibitLabel, exhibitSegmentTranscript, foldExhibits,
  publishColloquy, type ExhibitFold, type TrialExhibit,
} from '@/lib/courtroom/exhibits.ts';
import { isImageDoc, renderExhibitDataUrl } from '@/lib/courtroom/exhibit-render.ts';
import { loadCorpusDocumentText } from '@/lib/cite-check/corpus';
import { listMatterDocumentsRecursive } from '@/lib/vault-persist';
import { useServerspaces } from '@/hooks/useServerspaces';
import { collectDescendantIds } from '@/components/matter/DeleteMatterModal';
import type { VaultFile } from '@/lib/vault-types';
import type { CourtroomSceneApi } from '@/lib/courtroom/three/courtroom-scene.ts';
import type {
  Ballot, DeliberationTurn, JurorProfile, ProgressEvent, Ruling, Segment,
  UsageRecord,
} from '@/lib/courtroom/types.ts';
import PanelSheet from './PanelSheet';
import SegmentComposer from './SegmentComposer';
import ReportView from './ReportView';
import CourtroomStageView from './CourtroomStageView';
import ExhibitsPanel from './ExhibitsPanel';

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
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [liveTurns, setLiveTurns] = useState<DeliberationTurn[]>([]);
  const [liveBallots, setLiveBallots] = useState<Ballot[]>([]);
  const [liveRulings, setLiveRulings] = useState<Ruling[]>([]);
  // Twin Panel is a per-run choice, not a stored setting (spec §12.4: opt-in —
  // it doubles juror cost).
  const [twinPanel, setTwinPanel] = useState(false);
  // The room (Phase 3): always up during a session; a quiet door otherwise.
  const [roomOpen, setRoomOpen] = useState(false);
  const runLock = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Exhibits (spec §2): the fold of the trial's exhibit events, the matter's
  // documents, and the in-flight publication (theater ends at the click).
  const [exhibitFold, setExhibitFold] = useState<ExhibitFold>({
    exhibits: [], witness: null, publishedKeys: new Set(),
  });
  const [docs, setDocs] = useState<VaultFile[] | null>(null);
  const [publishingKey, setPublishingKey] = useState<string | null>(null);
  const sceneApiRef = useRef<CourtroomSceneApi | null>(null);
  const pendingPublishRef = useRef<{ exhibit: TrialExhibit; excerpt: string } | null>(null);
  const segmentsRef = useRef<Segment[]>([]);
  segmentsRef.current = segments;

  useEffect(() => {
    if (!id) return;
    Promise.all([getTrial(id), listJurors(id), listSegments(id), getReport(id), listExhibitEvents(id)])
      .then(([t, j, s, r, ev]) => {
        if (!t) { setLoadError('Rehearsal not found.'); return; }
        setTrial(t); setJurors(j); setSegments(s); setReport(r);
        setExhibitFold(foldExhibits(ev));
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not open the rehearsal.'));
  }, [id]);

  const reloadExhibits = useCallback(() => {
    if (!id) return;
    listExhibitEvents(id)
      .then((ev) => setExhibitFold(foldExhibits(ev)))
      .catch(() => {});
  }, [id]);

  // The matter's documents — the exhibit drawer's source (and the witness's).
  const { data: serverspaces = [] } = useServerspaces();
  useEffect(() => {
    if (!trial) return;
    let cancelled = false;
    const ids = collectDescendantIds(serverspaces, trial.matterspace_id);
    const nameById = new Map(
      serverspaces.flatMap((sv) => sv.matterspaces.map((m) => [m.id, m.name] as const)),
    );
    listMatterDocumentsRecursive(ids.length ? ids : [trial.matterspace_id], nameById)
      .then((d) => { if (!cancelled) setDocs(d); })
      .catch(() => { if (!cancelled) setDocs([]); });
    return () => { cancelled = true; };
  }, [trial, serverspaces]);

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

  /* ----------------------------- Exhibits ------------------------------ */

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** The record's side of a publication: an 'exhibit' SEGMENT (jurors react
   *  to it and cite PX-n natively) plus the session publication event. */
  const finalizePublication = useCallback(async (exhibit: TrialExhibit, excerpt: string) => {
    if (!trial) return;
    try {
      const seg = await addSegment(trial, {
        kind: 'exhibit',
        side: exhibit.side,
        transcript: exhibitSegmentTranscript(exhibit, excerpt),
        position: segmentsRef.current.length,
        sourceDocumentId: exhibit.doc_id,
      });
      setSegments((prev) => [...prev, seg]);
      await saveExhibitPublication(
        trial,
        { event: 'published', key: exhibit.key, exhibit_no: exhibit.exhibit_no },
        seg.id,
      );
      reloadExhibits();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The publication could not be recorded.');
    }
  }, [trial, reloadExhibits]);

  /** The armed exhibit was clicked up on the screen — write the record. */
  const onExhibitPublished = useCallback(() => {
    const pending = pendingPublishRef.current;
    pendingPublishRef.current = null;
    if (pending) void finalizePublication(pending.exhibit, pending.excerpt);
  }, [finalizePublication]);

  /** Publish a pre-admitted/admitted exhibit: render the page, run the canned
   *  colloquy in the room (Eden 2026-08-11: never an objection), arm the
   *  screen, and let the click publish. Without the room, publish directly. */
  const publishExhibit = useCallback(async (exhibit: TrialExhibit, doc: VaultFile) => {
    if (!trial || publishingKey) return;
    setPublishingKey(exhibit.key);
    setError('');
    try {
      const excerpt = isImageDoc(doc.name)
        ? ''
        : exhibitExcerpt((await loadCorpusDocumentText(exhibit.doc_id)).text);
      const dataUrl = await renderExhibitDataUrl(doc, exhibit.page);
      const api = sceneApiRef.current;
      if (api) {
        const c = publishColloquy(exhibit);
        if (!api.atLectern()) api.counselToLectern('lead');
        api.say(api.atLectern() ?? 'lead', c.counsel);
        await sleep(3600);
        api.say('judge', c.judge!);
        await sleep(2200);
        api.say('opposing', c.opposing!);
        await sleep(2000);
        pendingPublishRef.current = { exhibit, excerpt };
        api.armExhibit(dataUrl, exhibitLabel(exhibit));
      } else {
        await finalizePublication(exhibit, excerpt);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The exhibit could not be published.');
    } finally {
      setPublishingKey(null);
    }
  }, [trial, publishingKey, finalizePublication]);

  // The witness on the stand follows the fold: seat the portrait when the
  // room is up, clear it when the stand empties.
  useEffect(() => {
    const api = sceneApiRef.current;
    if (!api) return;
    const w = exhibitFold.witness;
    if (!w?.doc_id) {
      api.setWitnessPortrait(null);
      return;
    }
    const doc = (docs ?? []).find((d) => d.id === w.doc_id);
    if (!doc) return;
    let cancelled = false;
    renderExhibitDataUrl(doc, null)
      .then((url) => { if (!cancelled) sceneApiRef.current?.setWitnessPortrait(url); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [exhibitFold.witness, docs, roomOpen, running]);

  /* ----------------------------- The session -------------------------- */

  /** Kill switch: takes effect before the next juror turn (the model call in
   *  flight still finishes — a few seconds, not another round). */
  const stopSession = () => {
    setStopping(true);
    abortRef.current?.abort();
  };

  /** Start over: discard this run's reactions, ballots, deliberation, and
   *  report; keep the panel and the record; return to the record stage. */
  const startOver = async () => {
    if (!trial) return;
    if (!window.confirm(
      'Start over? This discards the current run — reactions, ballots, deliberation, and report. Your panel and your record stay.',
    )) return;
    if (running) stopSession();
    setBusy(true);
    setError('');
    try {
      await clearSessionData(trial.id);
      await updateTrial(trial.id, { status: 'segments' });
      setReport(null);
      setLiveTurns([]);
      setLiveBallots([]);
      setTrial((t) => (t ? { ...t, status: 'segments' } : t));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset the session.');
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!trial || runLock.current || jurors.length === 0 || segments.length === 0) return;
    runLock.current = true;
    setRunning(true);
    setStopping(false);
    abortRef.current = new AbortController();
    setError('');
    setLiveTurns([]);
    setLiveBallots([]);
    setLiveRulings([]);
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
        saveEvent: async (e, type) => {
          if (type === 'ruling') setLiveRulings((prev) => [...prev, e as Ruling]);
          await saveProcedureEvent(trial, e, type);
        },
        onUsage: (u) => {
          usageCounter += 1;
          if (usageCounter % 12 === 0) void updateTrial(trial.id, { usage: u });
        },
      });

      const result = await runSession(
        { trialTitle: trial.title, jurors, segments, mode: trial.mode, twinPanel },
        { ...ports, signal: abortRef.current.signal },
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
        mode: trial.mode,
        procedure: result.procedure,
        leakage: result.leakage,
        twin: result.twin,
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
      if (e instanceof SessionAborted) {
        // Clean stop, not an error: back to the record, run data discarded on
        // the next run's clearSessionData.
        await updateTrial(trial.id, { status: 'segments' }).catch(() => undefined);
        setTrial((t) => (t ? { ...t, status: 'segments' } : t));
      } else {
        setError(e instanceof Error ? e.message : 'The session failed.');
        await updateTrial(trial.id, { status: 'error' }).catch(() => undefined);
        setTrial((t) => (t ? { ...t, status: 'error' } : t));
      }
    } finally {
      runLock.current = false;
      setRunning(false);
      setStopping(false);
      abortRef.current = null;
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

      {/* The room (Phase 3): live during a session; openable any other time
          the panel is seated. The report remains the record — the room is
          where you feel the panel. */}
      {(running || roomOpen) && jurors.length > 0 && (
        <CourtroomStageView
          jurors={jurors}
          progress={running ? progress : null}
          ballots={liveBallots}
          rulings={liveRulings}
          panel={trial.venue_mix.house_panel ?? 'A'}
          sceneApiRef={sceneApiRef}
          onExhibitPublished={onExhibitPublished}
        />
      )}
      {!running && jurors.length > 0 && trial.status !== 'empanel' && (
        <div className="mb-5 -mt-1">
          <button
            type="button"
            onClick={() => setRoomOpen((v) => !v)}
            className="text-[11px] uppercase tracking-[0.14em] text-[#d4a054]/80 hover:text-[#e8b84a] transition-colors"
          >
            {roomOpen ? '— Close the courtroom' : '+ Step into the courtroom'}
          </button>
        </div>
      )}

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
        <>
          {trial.mode === 'full' && (
            <div className="rounded-lg border border-[rgba(212,160,84,0.25)] bg-[rgba(212,160,84,0.04)] px-5 py-4 mb-5">
              <p className="text-[11px] uppercase tracking-wider text-[#d4a054] mb-2">Full Trial</p>
              <p className="text-[12.5px] text-white/60 leading-relaxed mb-3">
                Opposing counsel will review your advocacy and object; the Court rules. Sustained
                strikes stay in the panel's memory with the disregard instruction — the report
                measures whether the instruction held.
              </p>
              <label className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={twinPanel}
                  onChange={(e) => setTwinPanel(e.target.checked)}
                  className="mt-0.5 accent-[#d4a054]"
                />
                <span className="text-[12.5px] text-white/75 leading-relaxed">
                  <span className="font-medium text-white/90">Twin Panel</span> — also run the same
                  twelve against a record that never contained the stricken material, so the report
                  prices the moment the objection couldn't cure. <span className="text-white/45">Doubles juror cost.</span>
                </span>
              </label>
            </div>
          )}
          <ExhibitsPanel
            trial={trial}
            docs={docs}
            exhibits={exhibitFold.exhibits}
            witness={exhibitFold.witness}
            publishedKeys={exhibitFold.publishedKeys}
            onChanged={reloadExhibits}
            onPublish={(ex, doc) => void publishExhibit(ex, doc)}
            publishingKey={publishingKey}
            theater={roomOpen}
          />
          <SegmentComposer
            trial={trial}
            segments={segments}
            onSegmentsChanged={setSegments}
            onBegin={() => void run()}
            busy={running}
          />
        </>
      )}

      {/* The drawer also rides along whenever the room is open outside the
          record stage — publishing from the well is the point. */}
      {roomOpen && !running && trial.status !== 'segments' && trial.status !== 'empanel' && (
        <ExhibitsPanel
          trial={trial}
          docs={docs}
          exhibits={exhibitFold.exhibits}
          witness={exhibitFold.witness}
          publishedKeys={exhibitFold.publishedKeys}
          onChanged={reloadExhibits}
          onPublish={(ex, doc) => void publishExhibit(ex, doc)}
          publishingKey={publishingKey}
          theater
        />
      )}

      {/* Stage: interrupted run (tab closed mid-session) */}
      {trial.status === 'running' && !running && (
        <div className="rounded-lg border border-[rgba(212,160,84,0.25)] bg-[rgba(212,160,84,0.04)] px-5 py-5 mb-6">
          <p className="text-[13px] text-white/70 leading-relaxed mb-4">
            This session was interrupted before the panel finished. Restart it — the panel will
            react, ballot, and deliberate from the top — or start over to go back to your record.
          </p>
          <div className="flex flex-wrap gap-3">
            <GoldButton onClick={() => void run()}><RotateCcw size={14} /> Restart the session</GoldButton>
            <QuietButton onClick={() => void startOver()} disabled={busy}>
              <Square size={13} /> Start over
            </QuietButton>
          </div>
        </div>
      )}

      {/* Stage: the session, live */}
      {running && (
        <SessionLive
          jurors={jurors}
          progress={progress}
          turns={liveTurns}
          ballots={liveBallots}
          rulings={liveRulings}
          segments={segments}
          jurorName={jurorName}
          stopping={stopping}
          onStop={stopSession}
        />
      )}

      {/* Stage: the work product */}
      {trial.status === 'complete' && report && !running && (
        <>
          <ReportView markdown={report.markdown} documentId={report.document_id} trialTitle={trial.title} />
          <div className="mt-6 flex flex-wrap gap-3">
            <QuietButton onClick={() => void run()}>
              <RotateCcw size={13} /> Run the session again (replaces this report)
            </QuietButton>
            <QuietButton onClick={() => void startOver()} disabled={busy}>
              <Square size={13} /> Start over — edit the record first
            </QuietButton>
          </div>
        </>
      )}

      {trial.status === 'error' && !running && (
        <div className="mt-2 flex flex-wrap gap-3">
          <GoldButton onClick={() => void run()}><RotateCcw size={14} /> Run the session again</GoldButton>
          <QuietButton onClick={() => void startOver()} disabled={busy}>
            <Square size={13} /> Start over
          </QuietButton>
        </div>
      )}
    </div>
  );
}

/* ========================== Live session surface ========================== */

function SessionLive({
  jurors, progress, turns, ballots, rulings, segments, jurorName, stopping, onStop,
}: {
  jurors: JurorProfile[];
  progress: ProgressEvent | null;
  turns: DeliberationTurn[];
  ballots: Ballot[];
  rulings: Ruling[];
  segments: Segment[];
  jurorName: (id: string) => string;
  stopping: boolean;
  onStop: () => void;
}) {
  const segPosition = useMemo(
    () => new Map(segments.map((s) => [s.id, s.position + 1])),
    [segments],
  );
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
        <div className="flex items-start justify-between gap-4">
          <Working>
            {(progress?.round ? `Round ${progress.round} of ${MAX_ROUNDS} — ` : '')
              + (progress?.detail ?? 'The panel is settling in…')}
          </Working>
          <QuietButton onClick={onStop} disabled={stopping}>
            <Square size={12} /> {stopping ? 'Stopping after this juror…' : 'Stop session'}
          </QuietButton>
        </div>
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

      {/* Objections & rulings (Full Trial) */}
      {rulings.length > 0 && (
        <div className="rounded-lg border border-[rgba(255,255,255,0.08)] px-5 py-4 mb-5" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
          <h3 className="text-[11px] uppercase tracking-wider text-white/50 mb-2.5">Objections &amp; rulings</h3>
          <ol className="space-y-1.5">
            {rulings.map((r, i) => (
              <li key={i} className="text-[12.5px] text-white/75 leading-relaxed">
                <span className="text-white/45">Seg {segPosition.get(r.segment_id) ?? '?'} ¶{r.para}</span>
                <span className="mx-2 text-white/25">—</span>
                {r.ground}:{' '}
                <span className={r.ruling === 'sustained' ? 'text-[#e0a9a9]' : 'text-[#8fd4a0]'}>
                  {r.ruling.toUpperCase()}
                </span>
                {r.ruling === 'sustained' && r.disregard_instruction && (
                  <span className="block text-[11.5px] text-white/40 mt-0.5 pl-4 border-l border-[rgba(212,160,84,0.25)] ml-1">
                    “{r.disregard_instruction}”
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

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

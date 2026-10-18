import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams, useLocation } from 'react-router-dom';
import {
  ChevronLeft, Video, Play, Pause, RotateCcw, FastForward, Clock, Eye, EyeOff, Users, ListOrdered,
  MessageSquareText, ScrollText, Ruler, Plus, X, Loader2, AlertTriangle, CheckCircle2, Flag, RefreshCw,
} from 'lucide-react';
import { storageObjectUrl, isStepUpRequired } from '@/lib/vault-object';
import {
  videoRoom, VideoApiError, fmtTime, fmtDuration, parseTime, latestReview,
  type VideoRoomStatus, type VideoAnalysis, type VideoEvent, type VideoInterrogation, type InterrogationResult,
  type CoverageStatus, type Position,
} from '@/lib/video-discovery';

// The Video Room: one stored recording, what a multimodal model said it saw,
// and a place to ask the model about a stretch of it (migration 119).
//
// Three rules the layout keeps:
//   1. Everything on screen that came from a model says so. The legend sits at
//      the top for as long as no person has pressed Reviewed, and every answer
//      carries the model's name.
//   2. No verdict colours. A claim assessment is a sentence with its basis and
//      a finding word; the lawyer reads the footage the sentence points at.
//   3. Everything is derived from the one event graph the worker stored. There
//      is no per-matter text in this file.

const GOLD = '#d4a054';

const COVERAGE_STYLE: Record<CoverageStatus, { band: string; label: string }> = {
  CLEAR: { band: 'bg-emerald-400/35', label: 'in view' },
  PARTIAL: { band: 'bg-amber-400/45', label: 'partly in view' },
  OCCLUDED: { band: 'bg-rose-500/55', label: 'out of view' },
};
const POSITION_STYLE: Record<Position, string> = {
  PRONE: 'bg-rose-400/60', SUPINE: 'bg-orange-300/50', SIDE: 'bg-amber-300/50', SEATED: 'bg-sky-300/45',
  STANDING: 'bg-emerald-300/40', KNEELING: 'bg-violet-300/45', CARRIED: 'bg-indigo-300/50', UNKNOWN: 'bg-white/15',
};
const EVENT_TYPE_LABEL: Record<string, string> = {
  BRIEFING: 'Briefing', ENTRY: 'Entry', FORCE_CONTACT: 'Contact', RESTRAINT_APPLIED: 'Restraint', POSITION_CHANGE: 'Position',
  VERBAL: 'Spoken', MEDICAL: 'Medical', TRANSPORT: 'Transport', CAMERA: 'Camera', OTHER: 'Other',
};
const FINDING_LABEL: Record<string, string> = {
  CORROBORATES: 'The footage in this window shows this to be so',
  REFUTES: 'The footage in this window shows this not to be so',
  CANNOT_DETERMINE_FROM_FOOTAGE: 'The footage cannot settle this',
};

type SideTab = 'events' | 'people' | 'transcript' | 'measures';

export default function VideoRoom() {
  const { documentId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const matterParam = searchParams.get('matter');
  const inApp = location.pathname.startsWith('/app');

  const [status, setStatus] = useState<VideoRoomStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!documentId) return;
    try {
      const s = await videoRoom.status(documentId);
      setStatus(s);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load this recording.');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while the worker is on it, or while a re-upload is pending.
  const analysis = status?.analysis ?? null;
  const inflight = analysis?.status === 'queued' || analysis?.status === 'running';
  const [awaitingMedia, setAwaitingMedia] = useState(false);
  useEffect(() => {
    if (!inflight && !awaitingMedia) return;
    const t = setInterval(() => { void refresh(); }, 4000);
    return () => clearInterval(t);
  }, [inflight, awaitingMedia, refresh]);
  useEffect(() => {
    if (!awaitingMedia || !analysis?.media_expires_at) return;
    if (Date.parse(analysis.media_expires_at) > Date.now() + 60_000) setAwaitingMedia(false);
  }, [awaitingMedia, analysis?.media_expires_at]);

  const backHref = inApp
    ? (matterParam ? `/app/discovery?matter=${encodeURIComponent(matterParam)}` : '/app/discovery')
    : (matterParam ? `/discovery/case?matter=${encodeURIComponent(matterParam)}` : '/discovery');

  return (
    <div className="min-h-full bg-[#07070b] text-white px-4 sm:px-6 py-5">
      <div className="max-w-[1440px] mx-auto space-y-5">
        <header className="flex flex-wrap items-center gap-3 pb-4 border-b border-white/[0.08]">
          <button
            type="button"
            onClick={() => navigate(backHref)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/75 hover:text-white text-[12px] transition-colors"
          >
            <ChevronLeft size={15} />
            Discovery
          </button>
          <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${GOLD}22`, border: `1px solid ${GOLD}55` }}>
            <Video size={18} style={{ color: GOLD }} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[22px] font-semibold tracking-tight leading-tight truncate" style={{ fontFamily: 'Playfair Display Variable, serif' }}>
              {status?.document.title ?? 'Video Room'}
            </h1>
            <p className="text-[12px] text-white/45 truncate">
              {status?.document.source_filename ?? ''}{status?.document.file_size_bytes ? ` · ${(status.document.file_size_bytes / 1e6).toFixed(0)} MB` : ''}
            </p>
          </div>
          {analysis && <Legend analysis={analysis} reviews={status?.reviews ?? []} />}
        </header>

        {loading && <p className="text-[12px] text-white/40 py-12 text-center">Loading the recording…</p>}
        {loadError && <p className="text-sm text-red-300">{loadError}</p>}

        {status && !status.document.is_video && (
          <p className="text-sm text-amber-200/90">This document is not a video file. The Video Room reads {['.mp4', '.mov', '.webm', '.avi', '.mpg'].join(', ')} and similar recordings.</p>
        )}

        {status && status.document.is_video && documentId && (
          <RoomBody status={status} documentId={documentId} onChanged={refresh} onMediaExpired={() => setAwaitingMedia(true)} awaitingMedia={awaitingMedia} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Legend({ analysis, reviews }: { analysis: VideoAnalysis; reviews: VideoRoomStatus['reviews'] }) {
  const review = latestReview(reviews, analysis.id);
  if (analysis.status !== 'ready') return null;
  if (review?.status === 'reviewed') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] bg-emerald-500/10 border border-emerald-400/30 text-emerald-200">
        <CheckCircle2 size={12} /> Reviewed against the footage by {review.initials} · {new Date(review.created_at).toLocaleDateString()}
      </span>
    );
  }
  if (review?.status === 'problem') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] bg-amber-500/10 border border-amber-400/30 text-amber-200" title={review.note}>
        <Flag size={12} /> Problem noted by {review.initials} · {new Date(review.created_at).toLocaleDateString()}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] bg-white/[0.04] border border-white/15 text-white/70">
      <AlertTriangle size={12} className="text-amber-300" /> AI-generated · not yet reviewed by a person
    </span>
  );
}

// ---------------------------------------------------------------------------
function RoomBody({ status, documentId, onChanged, onMediaExpired, awaitingMedia }: {
  status: VideoRoomStatus; documentId: string; onChanged: () => Promise<void>; onMediaExpired: () => void; awaitingMedia: boolean;
}) {
  const analysis = status.analysis;
  const graph = analysis?.status === 'ready' ? analysis.event_graph : null;

  // --- player -------------------------------------------------------------
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [srcExpiresAt, setSrcExpiresAt] = useState<number>(0);
  const [srcError, setSrcError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  // The playhead survives a re-mint: a new src resets the element, so the
  // position is saved before and restored once metadata is back.
  const resumeAtRef = useRef<number | null>(null);
  const errorCountRef = useRef(0);
  const [duration, setDuration] = useState<number>(analysis?.duration_sec ?? graph?.video.duration_sec ?? 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);

  const mint = useCallback(async () => {
    if (!status.document.storage_path) { setSrcError('This document has no stored file.'); return; }
    if (videoRef.current && videoRef.current.currentTime > 0) resumeAtRef.current = videoRef.current.currentTime;
    try {
      const u = await storageObjectUrl(status.document.storage_path, { ttlSeconds: 3600 });
      setSrc(u.url);
      setSrcExpiresAt(u.expiresAt);
      setSrcError(null);
    } catch (e) {
      if (isStepUpRequired(e)) setSrcError('This matter asks for a second factor before its files open. Open the document in the Vault first, then come back.');
      else setSrcError(e instanceof Error ? e.message : 'Could not open the recording.');
    }
  }, [status.document.storage_path]);
  useEffect(() => { void mint(); }, [mint]);
  // A signed URL lapses; mint again before it does, keeping the playhead.
  useEffect(() => {
    if (!srcExpiresAt) return;
    const ms = Math.max(10_000, srcExpiresAt - Date.now() - 60_000);
    const t = setTimeout(() => { void mint(); }, ms);
    return () => clearTimeout(t);
  }, [srcExpiresAt, mint]);

  const seek = useCallback((sec: number) => {
    const v = videoRef.current;
    const target = Math.max(0, sec);
    setCurrentTime(target);
    if (v) { try { v.currentTime = target; } catch { /* metadata not loaded yet */ } }
  }, []);
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {}); else v.pause();
  };
  const setSpeed = (r: number) => { setRate(r); if (videoRef.current) videoRef.current.playbackRate = r; };

  // --- window for questions ---------------------------------------------
  const [inSec, setInSec] = useState<number | null>(null);
  const [outSec, setOutSec] = useState<number | null>(null);
  const [inText, setInText] = useState('');
  const [outText, setOutText] = useState('');
  const setIn = (sec: number | null) => { setInSec(sec); setInText(sec == null ? '' : fmtTime(sec)); };
  const setOut = (sec: number | null) => { setOutSec(sec); setOutText(sec == null ? '' : fmtTime(sec)); };

  // --- sidebar ----------------------------------------------------------
  const [side, setSide] = useState<SideTab>('events');
  const total = duration || graph?.video.duration_sec || analysis?.duration_sec || 0;

  return (
    <>
      {!analysis && (
        <AnalyzePanel documentId={documentId} onStarted={onChanged} />
      )}
      {analysis && (analysis.status === 'queued' || analysis.status === 'running') && (
        <ProgressPanel analysis={analysis} />
      )}
      {analysis && analysis.status === 'error' && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-4 space-y-2">
          <p className="text-[13px] text-rose-200">The analysis did not finish: {analysis.error ?? 'unknown error'}</p>
          <AnalyzeButton documentId={documentId} onStarted={onChanged} label="Try again" />
        </div>
      )}
      {analysis && analysis.status === 'held' && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4">
          <p className="text-[13px] text-amber-100">{analysis.error ?? 'This matter is sealed; the recording cannot be sent to an outside video model.'}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Player + questions */}
        <div className="lg:col-span-7 space-y-5">
          <div className="rounded-xl border border-white/[0.09] bg-[#0d0d14] overflow-hidden shadow-2xl">
            <div className="px-4 py-2.5 border-b border-white/[0.07] flex items-center justify-between gap-3">
              <span className="text-[12px] text-white/80 truncate">{status.document.source_filename}</span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-[11px] text-white/40 mr-1">Speed</span>
                {[0.25, 0.5, 1, 1.5, 2].map((r) => (
                  <button key={r} type="button" onClick={() => setSpeed(r)}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${rate === r ? 'text-[#1a1408] font-semibold' : 'bg-white/[0.06] text-white/70 hover:text-white'}`}
                    style={rate === r ? { background: GOLD } : undefined}>
                    {r}x
                  </button>
                ))}
              </div>
            </div>
            <div className="relative bg-black aspect-video flex items-center justify-center">
              {src && !srcError ? (
                <video
                  ref={videoRef}
                  src={src}
                  controls
                  preload="metadata"
                  className="w-full h-full object-contain"
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  onLoadedMetadata={(e) => {
                    if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
                    errorCountRef.current = 0;
                    if (resumeAtRef.current != null) { try { e.currentTarget.currentTime = resumeAtRef.current; } catch { /* not seekable yet */ } resumeAtRef.current = null; }
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onError={() => {
                    // A lapsed URL is minted again, once. Anything else (a container the
                    // browser cannot play such as .avi, .wmv, .mpg, or a network fault) is
                    // said plainly, never retried in a loop against the sign endpoint.
                    errorCountRef.current += 1;
                    if (errorCountRef.current <= 1 && srcExpiresAt && Date.now() > srcExpiresAt - 60_000) { void mint(); return; }
                    setSrcError('The browser could not play this recording. Formats like .avi, .wmv and .mpg do not play in a browser; download the original from the Vault to watch it locally. The timeline and questions still work.');
                  }}
                />
              ) : (
                <div className="p-8 text-center max-w-md text-[12px] text-white/55">
                  {srcError ?? 'Opening the recording…'}
                </div>
              )}
              <div className="absolute top-3 left-3 pointer-events-none flex items-center gap-2">
                <span className="px-2.5 py-1 rounded bg-black/80 backdrop-blur border border-white/15 font-mono text-[12px] font-semibold" style={{ color: '#e8b84a' }}>
                  {fmtTime(currentTime)} / {fmtTime(total)}
                </span>
                {graph && <NowBadges graph={graph} t={currentTime} />}
              </div>
            </div>

            <div className="px-4 py-3 bg-[#101018] border-t border-white/[0.07] space-y-2.5">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/60">
                <button type="button" onClick={togglePlay} className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-white/[0.08] hover:bg-white/[0.14] text-white">
                  {playing ? <Pause size={12} /> : <Play size={12} />}{playing ? 'Pause' : 'Play'}
                </button>
                <button type="button" onClick={() => seek(currentTime - 5)} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1]" title="Back 5 seconds"><RotateCcw size={11} />5s</button>
                <button type="button" onClick={() => seek(currentTime + 5)} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1]" title="Forward 5 seconds"><FastForward size={11} />5s</button>
                <span className="mx-1 text-white/20">|</span>
                <button type="button" onClick={() => setIn(Math.floor(currentTime))} className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1]" title="Start the question window here">Set in</button>
                <button type="button" onClick={() => setOut(Math.ceil(currentTime))} className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1]" title="End the question window here">Set out</button>
                {(inSec != null || outSec != null) && (
                  <button type="button" onClick={() => { setIn(null); setOut(null); }} className="px-2 py-1 rounded hover:bg-white/[0.1] text-white/50" title="Clear the window"><X size={11} /></button>
                )}
                <span className="ml-auto text-white/35">Click a band or a pin to jump</span>
              </div>

              {graph && total > 0 && (
                <Timeline graph={graph} total={total} t={currentTime} inSec={inSec} outSec={outSec} onSeek={seek} />
              )}
            </div>
          </div>

          {graph && analysis && (
            <QuestionConsole
              documentId={documentId}
              analysis={analysis}
              interrogations={status.interrogations}
              inSec={inSec} outSec={outSec} inText={inText} outText={outText}
              onInText={(t) => { setInText(t); const s = parseTime(t); setInSec(s); }}
              onOutText={(t) => { setOutText(t); const s = parseTime(t); setOutSec(s); }}
              onSeek={seek}
              onAsked={onChanged}
              onMediaExpired={onMediaExpired}
              awaitingMedia={awaitingMedia}
              total={total}
            />
          )}
        </div>

        {/* Sidebar */}
        <div className="lg:col-span-5 flex flex-col rounded-xl border border-white/[0.09] bg-[#0d0d14] overflow-hidden shadow-xl lg:max-h-[1100px]">
          <div className="flex items-stretch border-b border-white/[0.08] bg-[#11111a]">
            {([
              ['events', ListOrdered, `Events${graph ? ` (${graph.events.length})` : ''}`],
              ['people', Users, `People${graph ? ` (${graph.actors.length})` : ''}`],
              ['transcript', ScrollText, 'Transcript'],
              ['measures', Ruler, 'Measures'],
            ] as const).map(([key, Icon, label]) => (
              <button key={key} type="button" onClick={() => setSide(key)}
                className={`flex-1 py-2.5 px-2 text-[11.5px] font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors ${side === key ? 'text-white' : 'border-transparent text-white/50 hover:text-white/80'}`}
                style={side === key ? { borderColor: GOLD, background: `${GOLD}14` } : undefined}>
                <Icon size={13} />{label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {!graph && <p className="text-[12px] text-white/40 py-10 text-center">{analysis ? 'The timeline appears when the analysis is ready.' : 'Analyse the recording to build its timeline.'}</p>}
            {graph && side === 'events' && <EventsList events={graph.events} actors={graph.actors} t={currentTime} onSeek={seek} />}
            {graph && side === 'people' && (
              <div className="space-y-2">
                <p className="text-[11px] text-white/45 px-1">Identified only by what is visible or spoken. A handle like A1 is the model's, not a name.</p>
                {graph.actors.map((a) => (
                  <div key={a.id} className="p-3 rounded-lg bg-white/[0.03] border border-white/[0.08]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-white">{a.label}</span>
                      <button type="button" onClick={() => seek(a.first_seen_sec)} className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-black/60 border border-white/10" style={{ color: '#e8b84a' }}>{a.id} · {fmtTime(a.first_seen_sec)}</button>
                    </div>
                    {a.identifying_marks && <p className="text-[11.5px] text-white/65 mt-1">{a.identifying_marks}</p>}
                    {a.role_observed && <p className="text-[11.5px] text-white/50 mt-0.5">{a.role_observed}</p>}
                  </div>
                ))}
                {graph.actors.length === 0 && <p className="text-[12px] text-white/40 py-6 text-center">No people were identified.</p>}
              </div>
            )}
            {graph && side === 'transcript' && (
              <div className="space-y-1.5">
                {graph.transcript.map((l, i) => (
                  <button key={i} type="button" onClick={() => seek(l.start_sec)} className="w-full text-left p-2 rounded-lg hover:bg-white/[0.04] flex gap-2">
                    <span className="font-mono text-[11px] shrink-0 mt-0.5" style={{ color: '#e8b84a' }}>{fmtTime(l.start_sec)}</span>
                    <span className="text-[12.5px] text-white/85"><span className="text-white/50">{l.speaker}: </span>{l.text}</span>
                  </button>
                ))}
                {graph.transcript.length === 0 && <p className="text-[12px] text-white/40 py-6 text-center">{graph.video.has_audio ? 'Nothing spoken was transcribed.' : 'This recording has no audio.'}</p>}
              </div>
            )}
            {graph && side === 'measures' && analysis && <MeasuresPanel analysis={analysis} />}
          </div>
          {analysis?.status === 'ready' && (
            <ReviewBox documentId={documentId} analysis={analysis} reviews={status.reviews} onChanged={onChanged} />
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
function AnalyzePanel({ documentId, onStarted }: { documentId: string; onStarted: () => Promise<void> }) {
  return (
    <div className="rounded-xl border border-white/[0.1] bg-[#0d0d14] p-5 flex flex-wrap items-start gap-4">
      <div className="flex-1 min-w-[260px] space-y-1.5">
        <h2 className="text-[15px] font-semibold">Analyse this recording</h2>
        <p className="text-[12.5px] text-white/60 leading-relaxed">
          The recording is sent to a video model, which returns a timed account of what it saw and heard: who appears, what happens
          when, where the camera could and could not see, how the subject is positioned, and everything spoken. Long recordings are
          read in twenty-minute passes. The model&rsquo;s copy lasts 48 hours; questions after that re-upload it first. Nothing it
          returns is a finding until a person has watched the footage against it and said so.
        </p>
        <p className="text-[11.5px] text-white/40">Sealed matters are refused: their recordings do not leave the seal.</p>
      </div>
      <AnalyzeButton documentId={documentId} onStarted={onStarted} label="Analyse" />
    </div>
  );
}

function AnalyzeButton({ documentId, onStarted, label }: { documentId: string; onStarted: () => Promise<void>; label: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = async () => {
    setBusy(true); setErr(null);
    try {
      await videoRoom.analyze(documentId);
      await onStarted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start the analysis.');
    } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2">
      <button type="button" disabled={busy} onClick={() => void start()}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[#1a1408] font-semibold text-[12.5px] disabled:opacity-50"
        style={{ background: GOLD }}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Video size={14} />}{label}
      </button>
      {err && <p className="text-[12px] text-rose-300 max-w-xs">{err}</p>}
    </div>
  );
}

function ProgressPanel({ analysis }: { analysis: VideoAnalysis }) {
  return (
    <div className="rounded-xl border border-white/[0.1] bg-[#0d0d14] p-4 space-y-2">
      <div className="flex items-center gap-2 text-[13px]">
        <Loader2 size={14} className="animate-spin" style={{ color: GOLD }} />
        <span>{analysis.status === 'queued' ? 'Waiting for the worker' : (analysis.progress_note ?? 'Analysing')}</span>
        <span className="ml-auto font-mono text-[11px] text-white/50">{analysis.progress}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(2, analysis.progress)}%`, background: GOLD }} />
      </div>
      <p className="text-[11px] text-white/40">A gigabyte-scale recording takes several minutes to fetch, upload and read. This page refreshes itself.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
function NowBadges({ graph, t }: { graph: NonNullable<VideoAnalysis['event_graph']>; t: number }) {
  const cov = graph.camera_coverage.find((c) => t >= c.start_sec && t < c.end_sec);
  const pos = graph.subject_position.find((p) => t >= p.start_sec && t < p.end_sec);
  return (
    <>
      {cov && cov.status !== 'CLEAR' && (
        <span className="px-2 py-1 rounded bg-black/75 border border-white/15 text-[11px] text-white/90 flex items-center gap-1.5">
          <EyeOff size={12} className={cov.status === 'OCCLUDED' ? 'text-rose-300' : 'text-amber-300'} />
          camera {COVERAGE_STYLE[cov.status].label}{cov.obstructed_by.length ? ` · ${cov.obstructed_by.slice(0, 2).join(', ')}` : ''}
        </span>
      )}
      {pos && pos.position !== 'UNKNOWN' && (
        <span className="px-2 py-1 rounded bg-black/75 border border-white/15 text-[11px] text-white/90">
          subject {pos.position.toLowerCase()}{pos.restrained ? ' · restrained' : ''}
        </span>
      )}
    </>
  );
}

function Timeline({ graph, total, t, inSec, outSec, onSeek }: {
  graph: NonNullable<VideoAnalysis['event_graph']>; total: number; t: number; inSec: number | null; outSec: number | null; onSeek: (s: number) => void;
}) {
  const pct = (s: number) => `${Math.min(100, Math.max(0, (s / total) * 100))}%`;
  const width = (a: number, b: number) => `${Math.max(0.3, ((Math.min(b, total) - a) / total) * 100)}%`;
  const clickAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - r.left) / r.width) * total);
  };
  return (
    <div className="space-y-1">
      <Row label="camera">
        <div className="relative h-3.5 rounded bg-white/[0.04] overflow-hidden cursor-pointer" onClick={clickAt}>
          {graph.camera_coverage.map((c, i) => (
            <div key={i} className={`absolute top-0 bottom-0 ${COVERAGE_STYLE[c.status].band}`} style={{ left: pct(c.start_sec), width: width(c.start_sec, c.end_sec) }}
              title={`${fmtTime(c.start_sec)}–${fmtTime(c.end_sec)} ${COVERAGE_STYLE[c.status].label}${c.obstructed_by.length ? ` (${c.obstructed_by.join(', ')})` : ''}${c.what_is_not_visible ? `: ${c.what_is_not_visible}` : ''}`} />
          ))}
          <Playhead pct={pct(t)} />
        </div>
      </Row>
      {graph.subject_position.length > 0 && (
        <Row label="subject">
          <div className="relative h-3.5 rounded bg-white/[0.04] overflow-hidden cursor-pointer" onClick={clickAt}>
            {graph.subject_position.map((p, i) => (
              <div key={i} className={`absolute top-0 bottom-0 ${POSITION_STYLE[p.position]} ${p.restrained ? 'border-y border-white/40' : ''}`} style={{ left: pct(p.start_sec), width: width(p.start_sec, p.end_sec) }}
                title={`${fmtTime(p.start_sec)}–${fmtTime(p.end_sec)} ${p.position.toLowerCase()}${p.restrained ? ', restrained' : ''} (${p.confidence} confidence, ${p.basis})`} />
            ))}
            <Playhead pct={pct(t)} />
          </div>
        </Row>
      )}
      <Row label="events">
        <div className="relative h-5 rounded bg-white/[0.04] overflow-hidden cursor-pointer" onClick={clickAt}>
          {inSec != null && outSec != null && outSec > inSec && (
            <div className="absolute top-0 bottom-0 bg-white/10 border-x border-white/40" style={{ left: pct(inSec), width: width(inSec, outSec) }} />
          )}
          {graph.events.map((e, i) => (
            <button key={i} type="button" onClick={(ev) => { ev.stopPropagation(); onSeek(e.start_sec); }}
              className="absolute top-1 bottom-1 w-1.5 -ml-[3px] rounded-sm hover:scale-125 transition-transform"
              style={{ left: pct(e.start_sec), background: e.type === 'FORCE_CONTACT' || e.type === 'RESTRAINT_APPLIED' ? '#fb7185' : e.type === 'MEDICAL' ? '#c4b5fd' : GOLD, opacity: e.confidence === 'low' ? 0.45 : 1 }}
              title={`[${fmtTime(e.start_sec)}] ${EVENT_TYPE_LABEL[e.type] ?? e.type}: ${e.description}`} />
          ))}
          <Playhead pct={pct(t)} />
        </div>
      </Row>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-white/40 pt-0.5">
        <span><i className="inline-block w-2.5 h-2 rounded-sm bg-emerald-400/35 mr-1 align-middle" />in view</span>
        <span><i className="inline-block w-2.5 h-2 rounded-sm bg-amber-400/45 mr-1 align-middle" />partly</span>
        <span><i className="inline-block w-2.5 h-2 rounded-sm bg-rose-500/55 mr-1 align-middle" />out of view</span>
        {graph.subject_position.length > 0 && <span><i className="inline-block w-2.5 h-2 rounded-sm bg-rose-400/60 mr-1 align-middle" />prone</span>}
        <span className="ml-auto">bands are the model&rsquo;s entries, not measurements</span>
      </div>
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-white/35 text-right">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
function Playhead({ pct }: { pct: string }) {
  return <div className="absolute top-0 bottom-0 w-px bg-white pointer-events-none" style={{ left: pct }} />;
}

// ---------------------------------------------------------------------------
function EventsList({ events, actors, t, onSeek }: {
  events: VideoEvent[]; actors: { id: string; label: string }[]; t: number; onSeek: (s: number) => void;
}) {
  const nameOf = useMemo(() => new Map(actors.map((a) => [a.id, a.label])), [actors]);
  if (events.length === 0) return <p className="text-[12px] text-white/40 py-6 text-center">No events were recorded.</p>;
  return (
    <>
      {events.map((e, i) => {
        const current = t >= e.start_sec && t < (e.end_sec ?? e.start_sec + 8);
        return (
          <div key={i} onClick={() => onSeek(e.start_sec)}
            className={`p-2.5 rounded-lg border cursor-pointer transition-colors ${current ? 'border-[#d4a054] bg-[#d4a054]/10' : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.05]'}`}>
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-black/60 border border-white/10" style={{ color: '#e8b84a' }}>
                {fmtTime(e.start_sec)}{e.end_sec != null && e.end_sec > e.start_sec ? `–${fmtTime(e.end_sec)}` : ''}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-white/55">{EVENT_TYPE_LABEL[e.type] ?? e.type}</span>
              <span className="text-[10px] text-white/35 ml-auto">{e.basis}{e.confidence !== 'high' ? ` · ${e.confidence} confidence` : ''}</span>
            </div>
            <p className="text-[12.5px] text-white/85 leading-relaxed">{e.description}</p>
            {e.verbatim_quote && <p className="text-[12px] text-white/65 italic mt-1">&ldquo;{e.verbatim_quote}&rdquo;</p>}
            {e.actor_ids.length > 0 && (
              <p className="text-[10.5px] text-white/40 mt-1">{e.actor_ids.map((id) => nameOf.get(id) ?? id).join(' · ')}</p>
            )}
          </div>
        );
      })}
    </>
  );
}

function MeasuresPanel({ analysis }: { analysis: VideoAnalysis }) {
  const m = analysis.measures;
  if (!m) return null;
  const positions = Object.entries(m.position_totals_sec).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-3 text-[12.5px]">
      <p className="text-[11px] text-white/45 px-1">
        Totals added up from the model&rsquo;s own interval entries. They are a reading aid, not measurements: verify any number you rely on against the footage.
      </p>
      <div className="rounded-lg border border-white/[0.08] divide-y divide-white/[0.06]">
        <Stat label="Camera: main action in view" value={fmtDuration(m.coverage_sec.CLEAR)} />
        <Stat label="Camera: partly in view" value={fmtDuration(m.coverage_sec.PARTIAL)} />
        <Stat label="Camera: out of view" value={fmtDuration(m.coverage_sec.OCCLUDED)} />
        {positions.map(([p, s]) => <Stat key={p} label={`Subject ${p.toLowerCase()}`} value={fmtDuration(s)} />)}
        {m.restrained_total_sec > 0 && <Stat label="Subject visibly restrained" value={fmtDuration(m.restrained_total_sec)} />}
        <Stat label="Events recorded" value={`${m.event_count}${m.low_confidence_events ? ` (${m.low_confidence_events} low confidence)` : ''}`} />
        <Stat label="People identified" value={String(m.actor_count)} />
        <Stat label="Passes" value={String(analysis.windows ?? 1)} />
        <Stat label="Model" value={analysis.model ?? '—'} />
      </div>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-white/65">{label}</span>
      <span className="font-mono text-white/90">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
function QuestionConsole(props: {
  documentId: string; analysis: VideoAnalysis; interrogations: VideoInterrogation[];
  inSec: number | null; outSec: number | null; inText: string; outText: string;
  onInText: (t: string) => void; onOutText: (t: string) => void;
  onSeek: (s: number) => void; onAsked: () => Promise<void>; onMediaExpired: () => void; awaitingMedia: boolean; total: number;
}) {
  const { documentId, analysis, interrogations, inSec, outSec, inText, outText, onInText, onOutText, onSeek, onAsked, onMediaExpired, awaitingMedia, total } = props;
  const [question, setQuestion] = useState('');
  const [claims, setClaims] = useState<string[]>([]);
  const [claimDraft, setClaimDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [local, setLocal] = useState<VideoInterrogation[]>([]);

  // One question watches at most one analysis pass's worth of footage (20 min).
  const MAX_WINDOW = 20 * 60;
  const needsWindow = total > MAX_WINDOW;
  const windowOk = (inSec == null && outSec == null && !needsWindow)
    || (inSec != null && outSec != null && outSec > inSec && outSec - inSec <= MAX_WINDOW);
  const mediaGone = analysis.media_expires_at ? Date.parse(analysis.media_expires_at) < Date.now() : false;

  const ask = async () => {
    const q = question.trim();
    if (!q || !windowOk) return;
    setBusy(true); setErr(null);
    try {
      const r = await videoRoom.interrogate(documentId, {
        question: q, claims,
        start_sec: inSec != null && outSec != null ? inSec : null,
        end_sec: inSec != null && outSec != null ? outSec : null,
      });
      setLocal((l) => [r.interrogation, ...l]);
      setQuestion('');
      if (r.interrogation.start_sec != null) onSeek(r.interrogation.start_sec);
      void onAsked();
    } catch (e) {
      if (e instanceof VideoApiError && e.code === 'media_expired') {
        onMediaExpired();
        setErr(e.message);
      } else {
        setErr(e instanceof Error ? e.message : 'The question could not be asked.');
      }
    } finally { setBusy(false); }
  };

  const shown = useMemo(() => {
    const ids = new Set(local.map((x) => x.id).filter(Boolean));
    return [...local, ...interrogations.filter((x) => !ids.has(x.id))];
  }, [local, interrogations]);

  return (
    <div className="rounded-xl border border-white/[0.1] bg-[#0d0d14] p-4 space-y-3 shadow-xl">
      <div className="flex items-center gap-2">
        <MessageSquareText size={15} style={{ color: GOLD }} />
        <h2 className="text-[14px] font-semibold">Ask about the footage</h2>
        <span className="ml-auto text-[11px] text-white/35 font-mono">{analysis.model ?? ''}</span>
      </div>

      {(awaitingMedia || mediaGone) && (
        <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-400/25 text-[12px] text-amber-100">
          <RefreshCw size={13} className={awaitingMedia ? 'animate-spin' : ''} />
          {awaitingMedia
            ? 'The video model no longer holds this recording. It is being re-uploaded; this page will say when you can ask again.'
            : 'The video model\'s copy of this recording has lapsed (48 hours). Your next question will start a re-upload.'}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-[11px] text-white/50 flex items-center gap-1"><Clock size={11} /> From</label>
          <input value={inText} onChange={(e) => onInText(e.target.value)} placeholder="mm:ss"
            className="w-24 px-2.5 py-1.5 rounded-lg bg-black/50 border border-white/[0.12] font-mono text-[12px] focus:outline-none focus:border-[#d4a054]" style={{ color: '#e8b84a' }} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-white/50">To</label>
          <input value={outText} onChange={(e) => onOutText(e.target.value)} placeholder="mm:ss"
            className="w-24 px-2.5 py-1.5 rounded-lg bg-black/50 border border-white/[0.12] font-mono text-[12px] focus:outline-none focus:border-[#d4a054]" style={{ color: '#e8b84a' }} />
        </div>
        <p className="text-[11px] text-white/40 pb-2">
          {inSec != null && outSec != null && windowOk ? `The model watches ${fmtTime(inSec)}–${fmtTime(outSec)} (${fmtDuration(outSec - inSec)}).`
            : inSec != null && outSec != null && outSec - inSec > MAX_WINDOW ? 'A window can be at most twenty minutes.'
            : inSec != null && outSec != null && !windowOk ? 'The end must be after the start.'
            : needsWindow ? 'This recording is longer than twenty minutes, so a question needs a window. Set in / Set out under the player fills them.'
            : 'Leave both empty to ask about the whole recording. Set in / Set out under the player fills them.'}
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-[11px] text-white/50">Claims to test against the footage (optional, up to 6)</label>
        {claims.map((c, i) => (
          <div key={i} className="flex items-start gap-2 text-[12.5px]">
            <span className="text-white/40 font-mono mt-0.5">{i + 1}.</span>
            <span className="flex-1 text-white/85">{c}</span>
            <button type="button" onClick={() => setClaims(claims.filter((_, j) => j !== i))} className="text-white/40 hover:text-white"><X size={13} /></button>
          </div>
        ))}
        {claims.length < 6 && (
          <div className="flex gap-2">
            <input value={claimDraft} onChange={(e) => setClaimDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && claimDraft.trim()) { setClaims([...claims, claimDraft.trim()]); setClaimDraft(''); } }}
              placeholder="e.g. a statement from a report or a pleading, as written"
              className="flex-1 px-3 py-1.5 rounded-lg bg-black/50 border border-white/[0.1] text-[12.5px] focus:outline-none focus:border-[#d4a054]" />
            <button type="button" disabled={!claimDraft.trim()} onClick={() => { setClaims([...claims, claimDraft.trim()]); setClaimDraft(''); }}
              className="px-2.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-40"><Plus size={14} /></button>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !busy) { e.preventDefault(); void ask(); } }}
          placeholder="What can be seen of the subject between the set times? Who is in frame? What is said?"
          className="flex-1 px-3 py-2 rounded-lg bg-black/50 border border-white/[0.12] text-[13px] focus:outline-none focus:border-[#d4a054] resize-y" />
        <button type="button" disabled={busy || !question.trim() || !windowOk || awaitingMedia} onClick={() => void ask()}
          className="px-4 rounded-lg text-[#1a1408] font-semibold text-[12.5px] inline-flex items-center gap-1.5 disabled:opacity-50 shrink-0 self-stretch"
          style={{ background: GOLD }}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <MessageSquareText size={14} />}
          {busy ? 'Watching…' : 'Ask'}
        </button>
      </div>
      {err && <p className="text-[12px] text-rose-300">{err}</p>}

      <div className="space-y-3 pt-1">
        {shown.map((q, i) => <Answer key={q.id ?? `local-${i}`} q={q} onSeek={onSeek} />)}
      </div>
    </div>
  );
}

function Answer({ q, onSeek }: { q: VideoInterrogation; onSeek: (s: number) => void }) {
  const r: InterrogationResult | null = q.result;
  return (
    <div className="rounded-lg border border-white/[0.08] bg-black/40 p-3.5 space-y-3">
      <div className="flex items-start gap-2 flex-wrap text-[12px]">
        <span className="text-white/45">Q</span>
        <span className="text-white/90 flex-1">{q.question}</span>
        <span className="text-[10.5px] text-white/35 font-mono">
          {q.start_sec != null && q.end_sec != null ? `${fmtTime(q.start_sec)}–${fmtTime(q.end_sec)} · ` : ''}{new Date(q.created_at).toLocaleString()}
        </span>
      </div>
      {q.outcome !== 'ok' && (
        <p className="text-[12px] text-amber-200">
          {q.outcome === 'media_expired' ? 'Not answered: the model\'s copy of the recording had lapsed; it was re-uploaded.' : 'Not answered: the provider returned an error.'}
        </p>
      )}
      {r && (
        <>
          <Markdown text={r.answer_markdown} onSeek={onSeek} />
          {r.cited_intervals.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {r.cited_intervals.map((c, i) => (
                <button key={i} type="button" onClick={() => onSeek(c.start_sec)} title={c.what_is_seen}
                  className="px-2 py-0.5 rounded font-mono text-[11px] border border-white/15 bg-white/[0.04] hover:bg-white/[0.1]" style={{ color: '#e8b84a' }}>
                  {fmtTime(c.start_sec)}{c.end_sec > c.start_sec ? `–${fmtTime(c.end_sec)}` : ''}
                </button>
              ))}
            </div>
          )}
          <div className="text-[12px] text-white/75 flex items-start gap-2">
            {r.line_of_sight.status === 'CLEAR' ? <Eye size={13} className="mt-0.5 shrink-0 text-white/50" /> : <EyeOff size={13} className="mt-0.5 shrink-0 text-amber-300" />}
            <span>
              <span className="text-white/50">Camera {COVERAGE_STYLE[r.line_of_sight.status]?.label ?? r.line_of_sight.status.toLowerCase()}.</span>{' '}
              {r.line_of_sight.basis}{r.line_of_sight.what_cannot_be_seen ? ` Not visible: ${r.line_of_sight.what_cannot_be_seen}` : ''}
            </span>
          </div>
          {r.claim_assessments.length > 0 && (
            <div className="rounded-lg border border-white/[0.08] divide-y divide-white/[0.06]">
              {r.claim_assessments.map((c, i) => (
                <div key={i} className="p-2.5 text-[12px] space-y-1">
                  <p className="text-white/85"><span className="text-white/40 font-mono mr-1.5">{i + 1}.</span>{c.claim_text}</p>
                  <p className="text-white/70"><span className="text-white/45">{FINDING_LABEL[c.finding] ?? c.finding}.</span> <Markdown inline text={c.basis} onSeek={onSeek} /></p>
                </div>
              ))}
            </div>
          )}
          {r.limitations.length > 0 && (
            <ul className="text-[11.5px] text-white/50 list-disc pl-5 space-y-0.5">
              {r.limitations.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          )}
          <p className="text-[10.5px] text-white/35">AI-generated by {q.model ?? 'the video model'}. Watch the cited moments before relying on any of it.</p>
        </>
      )}
    </div>
  );
}

/** Tiny markdown: paragraphs, bullets, bold, and [mm:ss] times that seek the player. */
function Markdown({ text, onSeek, inline = false }: { text: string; onSeek: (s: number) => void; inline?: boolean }) {
  const renderInline = (line: string, key: string) => {
    const parts = line.split(/(\[\d{1,2}:\d{2}(?::\d{2})?\]|\*\*[^*]+\*\*)/g);
    return (
      <span key={key}>
        {parts.map((p, i) => {
          const ts = p.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]$/);
          if (ts) {
            const sec = parseTime(ts[1]);
            return (
              <button key={i} type="button" onClick={() => sec != null && onSeek(sec)}
                className="inline-flex items-center gap-0.5 mx-0.5 px-1 rounded font-mono text-[11px] border border-white/15 bg-white/[0.05] hover:bg-white/[0.12]" style={{ color: '#e8b84a' }}>
                <Play size={8} className="fill-current" />{ts[1]}
              </button>
            );
          }
          if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} className="text-white font-semibold">{p.slice(2, -2)}</strong>;
          return <span key={i}>{p}</span>;
        })}
      </span>
    );
  };
  if (inline) return renderInline(text, 'i');
  return (
    <div className="text-[13px] text-white/85 leading-relaxed space-y-1.5">
      {text.split('\n').map((line, i) => {
        const t = line.trim();
        if (!t) return null;
        if (/^#{1,4}\s/.test(t)) return <p key={i} className="font-semibold text-white mt-2">{renderInline(t.replace(/^#{1,4}\s+/, ''), String(i))}</p>;
        if (/^[-*]\s/.test(t)) return <p key={i} className="pl-4 relative"><span className="absolute left-1 text-white/40">•</span>{renderInline(t.replace(/^[-*]\s+/, ''), String(i))}</p>;
        return <p key={i}>{renderInline(t, String(i))}</p>;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
function ReviewBox({ documentId, analysis, reviews, onChanged }: {
  documentId: string; analysis: VideoAnalysis; reviews: VideoRoomStatus['reviews']; onChanged: () => Promise<void>;
}) {
  const [initials, setInitials] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'reviewed' | 'problem' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const latest = latestReview(reviews, analysis.id);
  const submit = async (status: 'reviewed' | 'problem') => {
    if (!initials.trim()) { setErr('Initials are required.'); return; }
    if (status === 'problem' && !note.trim()) { setErr('Say what the problem is.'); return; }
    setBusy(status); setErr(null);
    try {
      await videoRoom.review(documentId, { analysis_id: analysis.id, status, initials: initials.trim(), note: note.trim() });
      setNote('');
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not record the review.');
    } finally { setBusy(null); }
  };
  return (
    <div className="border-t border-white/[0.08] p-3 space-y-2 bg-[#0b0b11]">
      <p className="text-[11px] text-white/50">
        Your reading. Reviewed means you watched the footage against this timeline and it holds; Problem means something is wrong, say what. Each press is one row in the matter&rsquo;s record.
      </p>
      {latest && (
        <p className="text-[11.5px] text-white/60">
          Latest: <span className="text-white/85">{latest.status === 'reviewed' ? 'Reviewed' : 'Problem'}</span> by {latest.initials} on {new Date(latest.created_at).toLocaleString()}{latest.note ? ` — ${latest.note}` : ''}
        </p>
      )}
      <div className="flex gap-2">
        <input value={initials} onChange={(e) => setInitials(e.target.value.slice(0, 6))} placeholder="Initials" className="w-20 px-2.5 py-1.5 rounded-lg bg-black/50 border border-white/[0.12] text-[12px] focus:outline-none focus:border-[#d4a054]" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (required for a problem)" className="flex-1 px-2.5 py-1.5 rounded-lg bg-black/50 border border-white/[0.12] text-[12px] focus:outline-none focus:border-[#d4a054]" />
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={busy != null} onClick={() => void submit('reviewed')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-100 text-[12px] disabled:opacity-50">
          {busy === 'reviewed' ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Reviewed
        </button>
        <button type="button" disabled={busy != null} onClick={() => void submit('problem')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/30 text-amber-100 text-[12px] disabled:opacity-50">
          {busy === 'problem' ? <Loader2 size={12} className="animate-spin" /> : <Flag size={12} />} Problem
        </button>
      </div>
      {err && <p className="text-[12px] text-rose-300">{err}</p>}
    </div>
  );
}

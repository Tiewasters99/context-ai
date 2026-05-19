import { useState, useRef, useCallback } from 'react';
import { FileText, X, ChevronRight, ChevronDown, Upload, Download, Loader2 } from 'lucide-react';
import { extractText } from '@/lib/extract';
import { runCiteCheck, FLAG_GLYPH, FLAG_LABEL, type RunProgress, type CiteFlag, type ReportEntry } from '@/lib/cite-check';
import {
  useCiteCheckRuns,
  useCiteCheckRun,
  useCiteCheckRunsInvalidate,
  type CiteCheckRunSummary,
  type RunStatus,
} from '@/hooks/useCiteCheckRuns';

const FLAG_TINT: Record<CiteFlag, string> = {
  green: 'text-emerald-400',
  'lean-green': 'text-[#d4a054]',
  'lean-red': 'text-orange-400',
  red: 'text-red-400',
  blue: 'text-sky-400/70',
};

// Worst-first: a lawyer wants the verified mismatches and unverified
// concerns at the top, then the clean ones, then the Westlaw-paste pile.
const FLAG_ORDER: CiteFlag[] = ['red', 'lean-red', 'lean-green', 'green', 'blue'];

const ACCEPTED_EXT = '.docx,.pdf,.txt,.md';

interface PendingSource {
  label: string;
  text: string;
}

export default function CiteCheckSurface({ matterId }: { matterId: string; matterName?: string }) {
  const [view, setView] = useState<'start' | 'running' | 'results'>('start');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [source, setSource] = useState<PendingSource | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const runs = useCiteCheckRuns(matterId);
  const invalidate = useCiteCheckRunsInvalidate();

  const acceptFile = useCallback(async (file: File) => {
    setError(null);
    setExtracting(true);
    try {
      const text = await extractText(file);
      if (!text || text.trim().length < 40) {
        setError('Could not read any text from that file.');
        setSource(null);
      } else {
        setSource({ label: file.name, text });
      }
    } catch (e) {
      setError(`Failed to read file: ${e instanceof Error ? e.message : 'unknown error'}`);
      setSource(null);
    } finally {
      setExtracting(false);
    }
  }, []);

  const startRun = useCallback(async () => {
    const src: PendingSource | null = source
      ?? (pasteText.trim().length >= 40
        ? { label: `Pasted text — ${new Date().toLocaleString()}`, text: pasteText.trim() }
        : null);
    if (!src) { setError('Add a brief (drop a file or paste text) first.'); return; }

    setError(null);
    setProgress({ phase: 'extracting-cites', message: 'Reading the brief…' });
    setView('running');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await runCiteCheck({
        matterId,
        draftText: src.text,
        sourceLabel: src.label,
        onProgress: setProgress,
        signal: controller.signal,
      });
      invalidate.invalidateList(matterId);
      setActiveRunId(result.runId);
      setView('results');
      setSource(null);
      setPasteText('');
      setShowPaste(false);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        invalidate.invalidateList(matterId);
        setView('start');
        setProgress(null);
        return;
      }
      setError(e instanceof Error ? e.message : 'Cite-check failed.');
      setView('start');
    } finally {
      abortRef.current = null;
    }
  }, [source, pasteText, matterId, invalidate]);

  const cancelRun = () => abortRef.current?.abort();

  const openRun = (runId: string) => {
    setActiveRunId(runId);
    setView('results');
  };

  const resetToStart = () => {
    setView('start');
    setActiveRunId(null);
    setProgress(null);
    setError(null);
  };

  // ---- Running ------------------------------------------------------------
  if (view === 'running') {
    return (
      <div className="py-10">
        <div className="flex flex-col items-center text-center gap-4">
          <Loader2 size={26} className="text-[#d4a054] animate-spin" strokeWidth={1.75} />
          <div>
            <p className="text-[16px] text-[#f5f1e8]">{progressHeadline(progress)}</p>
            {progress?.phase === 'checking' && progress.total ? (
              <p className="text-[14px] text-white/50 mt-1">
                {progress.index}/{progress.total} · <span className="text-white/70">{progress.current}</span>
              </p>
            ) : (
              <p className="text-[14px] text-white/50 mt-1">{progress?.message ?? 'Working…'}</p>
            )}
          </div>
          {progress?.phase === 'checking' && progress.total ? (
            <div className="w-64 h-1 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full bg-[#d4a054] transition-all"
                style={{ width: `${Math.round(((progress.index ?? 0) / progress.total) * 100)}%` }}
              />
            </div>
          ) : null}
          <button
            onClick={cancelRun}
            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] text-[14px] text-white/70 hover:bg-[#1c1c26] hover:text-white transition-colors"
          >
            <X size={12} strokeWidth={2} /> Cancel
          </button>
        </div>
      </div>
    );
  }

  // ---- Results ------------------------------------------------------------
  if (view === 'results' && activeRunId) {
    return <ResultsView runId={activeRunId} onNewRun={resetToStart} />;
  }

  // ---- Start --------------------------------------------------------------
  const canRun = !!source || pasteText.trim().length >= 40;
  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) acceptFile(f);
        }}
        className={`rounded-lg border border-dashed px-6 py-10 text-center transition-colors ${
          dragOver ? 'border-[#d4a054] bg-[#d4a054]/5' : 'border-[rgba(255,255,255,0.12)]'
        }`}
      >
        {extracting ? (
          <div className="flex flex-col items-center gap-2 text-white/60">
            <Loader2 size={20} className="animate-spin text-[#d4a054]" />
            <span className="text-[14px]">Reading file…</span>
          </div>
        ) : source ? (
          <div className="flex flex-col items-center gap-2">
            <FileText size={22} className="text-[#d4a054]" strokeWidth={1.5} />
            <span className="text-[15px] text-[#f5f1e8]">{source.label}</span>
            <span className="text-[13px] text-white/40">{source.text.length.toLocaleString()} characters ready</span>
            <button
              onClick={() => { setSource(null); setError(null); }}
              className="mt-1 text-[13px] text-white/40 hover:text-white/70 transition-colors"
            >
              Choose a different file
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Upload size={22} className="text-white/30" strokeWidth={1.5} />
            <p className="text-[15px] text-white/60">
              Drop a brief here, or{' '}
              <button onClick={() => fileInputRef.current?.click()} className="text-[#e8b84a] hover:underline">browse</button>
            </p>
            <p className="text-[13px] text-white/30">.docx, .pdf, .txt, .md</p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_EXT}
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) acceptFile(f); e.target.value = ''; }}
        />
      </div>

      <div className="mt-3">
        {!showPaste ? (
          <button onClick={() => setShowPaste(true)} className="text-[14px] text-white/40 hover:text-white/70 transition-colors">
            …or paste text instead
          </button>
        ) : (
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste the brief text here…"
            rows={6}
            className="w-full select-text rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(10,10,16,0.72)] px-3 py-2 text-[15px] text-[#f5f1e8] placeholder:text-white/25 outline-none focus:border-[#d4a054]/40"
          />
        )}
      </div>

      {error && <p className="text-[14px] text-red-300 mt-3">{error}</p>}

      <div className="flex justify-end mt-4">
        <button
          onClick={startRun}
          disabled={!canRun || extracting}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#e8b84a]/10 hover:bg-[#e8b84a]/20 border border-[#e8b84a]/30 text-[#e8b84a] text-[15px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <FileText size={14} strokeWidth={1.75} /> Run cite-check
        </button>
      </div>

      {/* Run history */}
      {runs.data && runs.data.length > 0 && (
        <section className="mt-10">
          <h2 className="text-[15px] font-semibold text-[#8a8693] uppercase tracking-wider mb-3">Past runs</h2>
          <div className="rounded-lg border border-[rgba(255,255,255,0.14)] overflow-hidden divide-y divide-[rgba(255,255,255,0.08)]">
            {runs.data.map((r) => (
              <RunHistoryRow key={r.id} run={r} onOpen={() => openRun(r.id)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function progressHeadline(p: RunProgress | null): string {
  switch (p?.phase) {
    case 'extracting-cites': return 'Pulling every citation from the brief…';
    case 'checking': return 'Checking citations against the authority store and free legal databases…';
    case 'persisting': return 'Linking verified authorities to this matter…';
    case 'done': return 'Done.';
    case 'error': return 'Something went wrong.';
    default: return 'Working…';
  }
}

function statusBadge(status: RunStatus): { label: string; cls: string } {
  switch (status) {
    case 'running': return { label: 'running', cls: 'text-[#d4a054]' };
    case 'complete': return { label: 'complete', cls: 'text-emerald-400/80' };
    case 'interrupted': return { label: 'interrupted', cls: 'text-orange-400/80' };
    case 'error': return { label: 'error', cls: 'text-red-400/80' };
  }
}

function RunHistoryRow({ run, onOpen }: { run: CiteCheckRunSummary; onOpen: () => void }) {
  const badge = statusBadge(run.status);
  const counts = (run.counts && 'green' in run.counts) ? run.counts : null;
  return (
    <button onClick={onOpen} className="flex items-center gap-3 w-full px-4 py-2.5 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors group">
      <FileText size={14} className="text-[#d4a054] shrink-0" strokeWidth={1.75} />
      <span className="text-[15px] text-[#f5f1e8] truncate flex-1">{run.source_label}</span>
      {counts && (
        <span className="text-[13px] text-white/40 shrink-0 hidden sm:inline">
          {counts.red > 0 && <span className="text-red-400/80 mr-2">{FLAG_GLYPH.red}{counts.red}</span>}
          {counts.lean_red > 0 && <span className="text-orange-400/80 mr-2">{FLAG_GLYPH['lean-red']}{counts.lean_red}</span>}
          {counts.lean_green > 0 && <span className="text-[#d4a054] mr-2">{FLAG_GLYPH['lean-green']}{counts.lean_green}</span>}
          {counts.green > 0 && <span className="text-emerald-400/80 mr-2">{FLAG_GLYPH.green}{counts.green}</span>}
          {counts.blue > 0 && <span className="text-sky-400/60">{FLAG_GLYPH.blue}{counts.blue}</span>}
        </span>
      )}
      <span className={`text-[12px] shrink-0 ${badge.cls}`}>{badge.label}</span>
      <span className="text-[12px] text-white/30 shrink-0">{new Date(run.created_at).toLocaleDateString()}</span>
      <ChevronRight size={13} className="text-white/30 group-hover:text-[#e8b84a] transition-colors shrink-0" strokeWidth={2} />
    </button>
  );
}

// ---- Results view ---------------------------------------------------------

function ResultsView({ runId, onNewRun }: { runId: string; onNewRun: () => void }) {
  const { data: run, isLoading, error } = useCiteCheckRun(runId);
  const [filter, setFilter] = useState<CiteFlag | 'all'>('all');
  const [expanded, setExpanded] = useState<number | null>(null);

  if (isLoading) return <p className="text-center text-[14px] text-white/40 py-10">Loading run…</p>;
  if (error || !run) return <p className="text-center text-[14px] text-red-300 py-10">{error instanceof Error ? error.message : 'Run not found'}</p>;

  if (run.status === 'running') {
    return (
      <div className="py-10 text-center">
        <Loader2 size={22} className="text-[#d4a054] animate-spin mx-auto mb-3" />
        <p className="text-[15px] text-white/60">This run is still in progress in another tab or session.</p>
        <button onClick={onNewRun} className="mt-4 text-[14px] text-[#e8b84a] hover:underline">Start a new cite-check</button>
      </div>
    );
  }
  if (run.status === 'error') {
    return (
      <div className="py-10 text-center">
        <p className="text-[15px] text-red-300">This run failed: {run.error_message ?? 'unknown error'}</p>
        <button onClick={onNewRun} className="mt-4 text-[14px] text-[#e8b84a] hover:underline">Start a new cite-check</button>
      </div>
    );
  }

  const counts = (run.counts && 'green' in run.counts) ? run.counts : { green: 0, lean_green: 0, lean_red: 0, red: 0, blue: 0 };
  const entries = run.report ?? [];
  const sorted = [...entries].sort((a, b) => FLAG_ORDER.indexOf(a.flag) - FLAG_ORDER.indexOf(b.flag));
  const shown = filter === 'all' ? sorted : sorted.filter((e) => e.flag === filter);

  const chips: Array<{ flag: CiteFlag; n: number }> = [
    { flag: 'green', n: counts.green },
    { flag: 'lean-green', n: counts.lean_green },
    { flag: 'lean-red', n: counts.lean_red },
    { flag: 'red', n: counts.red },
    { flag: 'blue', n: counts.blue },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <p className="text-[15px] text-[#f5f1e8] truncate">{run.source_label}</p>
          <p className="text-[13px] text-white/40">
            {run.citations_total} citations · {run.status === 'interrupted' ? 'interrupted — partial results' : new Date(run.completed_at ?? run.created_at).toLocaleString()}
          </p>
        </div>
        <button onClick={onNewRun} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] text-[14px] text-white/80 hover:bg-[#1c1c26] hover:text-white transition-colors">
          New cite-check
        </button>
      </div>

      {/* Flag tally / filter */}
      <div className="flex flex-wrap items-center gap-1.5 mb-1">
        <button
          onClick={() => setFilter('all')}
          className={`px-2.5 py-1 rounded-md text-[14px] transition-colors ${filter === 'all' ? 'bg-[rgba(255,255,255,0.08)] text-[#f5f1e8]' : 'text-white/50 hover:text-white/80'}`}
        >
          All {run.citations_total}
        </button>
        {chips.filter((c) => c.n > 0).map((c) => (
          <button
            key={c.flag}
            onClick={() => setFilter(filter === c.flag ? 'all' : c.flag)}
            title={FLAG_LABEL[c.flag]}
            className={`px-2.5 py-1 rounded-md text-[14px] transition-colors ${filter === c.flag ? 'bg-[rgba(255,255,255,0.08)]' : 'hover:bg-[rgba(255,255,255,0.04)]'} ${FLAG_TINT[c.flag]}`}
          >
            {FLAG_GLYPH[c.flag]} {c.n}
          </button>
        ))}
      </div>
      <p className="text-[12px] text-white/30 mb-4">✓ verified clean · ⊕ verified, minor issue · ⊖ unverified concern · ✗ verified mismatch · ◇ Westlaw paste needed</p>

      {/* Per-cite list */}
      <div className="rounded-lg border border-[rgba(255,255,255,0.14)] overflow-hidden divide-y divide-[rgba(255,255,255,0.08)]">
        {shown.map((e) => {
          const idx = entries.indexOf(e);
          const isOpen = expanded === idx;
          return (
            <div key={idx}>
              <button
                onClick={() => setExpanded(isOpen ? null : idx)}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors group"
              >
                <span className={`text-[16px] w-4 text-center shrink-0 ${FLAG_TINT[e.flag]}`}>{FLAG_GLYPH[e.flag]}</span>
                <span className="text-[15px] text-[#f5f1e8] truncate flex-1">
                  {e.citation}{e.pin ? <span className="text-white/40">, {e.pin}</span> : null}
                </span>
                {e.flags.length > 0 && <span className="text-[12px] text-white/30 shrink-0">{e.flags.length} note{e.flags.length === 1 ? '' : 's'}</span>}
                {isOpen ? <ChevronDown size={13} className="text-white/30 shrink-0" /> : <ChevronRight size={13} className="text-white/30 group-hover:text-[#e8b84a] transition-colors shrink-0" />}
              </button>
              {isOpen && <CiteDetail e={e} />}
            </div>
          );
        })}
        {shown.length === 0 && <p className="px-4 py-6 text-center text-[14px] text-white/40">No citations with that flag.</p>}
      </div>

      {/* Downloads */}
      <div className="flex flex-wrap gap-2 mt-4">
        {run.report_markdown && (
          <DownloadButton filename={`${baseName(run.source_label)}.cite-report.md`} text={run.report_markdown} label="Download report (.md)" />
        )}
        {run.toa_markdown && (
          <DownloadButton filename={`${baseName(run.source_label)}.toa.md`} text={run.toa_markdown} label="Download TOA (.md)" />
        )}
      </div>
    </div>
  );
}

function CiteDetail({ e }: { e: ReportEntry }) {
  return (
    <div className="px-4 pb-3 pt-1 pl-11 text-[14px] space-y-1 bg-[rgba(255,255,255,0.015)]">
      <p><span className="text-white/40">Status:</span> <span className="text-white/80">{FLAG_LABEL[e.flag]}</span> <span className="text-white/30">({e.verification_status} · {e.rating} confidence)</span></p>
      {e.proposition && <p><span className="text-white/40">Cited for:</span> <span className="text-white/80">{e.proposition}</span></p>}
      {e.signal && <p><span className="text-white/40">Signal:</span> <span className="text-white/80">{e.signal}</span></p>}
      <p>
        <span className="text-white/40">Source:</span>{' '}
        {e.source_url ? <a href={e.source_url} target="_blank" rel="noreferrer" className="text-[#e8b84a] hover:underline">{e.source_label}</a> : <span className="text-white/70">{e.source_label}</span>}
      </p>
      {e.note && <p><span className="text-white/40">Note:</span> <span className="text-white/80">{e.note}</span></p>}
      {e.flags.length > 0 && (
        <ul className="pl-3 list-disc text-white/60 space-y-0.5 marker:text-white/20">
          {e.flags.map((f, i) => <li key={i}><span className="text-white/40">{f.kind}:</span> {f.detail}</li>)}
        </ul>
      )}
      {e.location && <p className="text-white/40 italic">…{e.location}…</p>}
    </div>
  );
}

function DownloadButton({ filename, text, label }: { filename: string; text: string; label: string }) {
  const download = () => {
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <button onClick={download} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] text-[14px] text-white/80 hover:bg-[#1c1c26] hover:text-white transition-colors">
      <Download size={12} strokeWidth={2} /> {label}
    </button>
  );
}

function baseName(label: string): string {
  return label.replace(/\.(docx|pdf|txt|md)$/i, '').slice(0, 80) || 'cite-check';
}

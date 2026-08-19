// The Editor's Room — the front door of the Contextspaces Editor.
// The desk is open: lay a manuscript on it and the Editor returns a redline
// with margin marks — every edit carrying its claim-before-rewrite
// work-product, checked by a deterministic verifier and read cold by a
// blind critic. The Editor's charter lives in docs/editor/CONSTITUTION.md
// and is loaded verbatim into its prompts.

import { useMemo, useRef, useState } from 'react';
import { runEditorPass } from '@/lib/editor/pass';
import { applyEdits } from '@/lib/editor/verifier';
import { wordDiff } from '@/lib/editor/diff';
import { DOCUMENT_FORMS } from '@/lib/editor/types';
import type { DocumentForm, EditorPassResult, ProposedEdit, PraiseNote } from '@/lib/editor/types';
import DeskSourcePicker from './DeskSourcePicker';

const RED = '#c96852'; // the red pen
const GOLD = '#e8b84a'; // praise, on dark
const INK_RED = '#a33b2a'; // the red pen, on paper
const INK_GOLD = '#8a6d1a'; // praise, on paper

const CORRECTIVE_AMBIENCE = ['obscure', 'transition', 'choppy', 'repetitive', 'weak', 'vague', 'awkward', 'diction', 'barbare'];
const PRAISE_AMBIENCE = ['excellent', 'very sharp', 'yes!', 'brilliant'];

type Phase = 'desk' | 'working' | 'redline';
type Decision = 'accepted' | 'declined';

/** The manuscript cut into plain runs and edit spans, in order. */
type Segment =
  | { type: 'plain'; text: string; start: number }
  | { type: 'edit'; edit: ProposedEdit };

function buildSegments(manuscript: string, edits: ProposedEdit[]): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.pos > cursor) segments.push({ type: 'plain', text: manuscript.slice(cursor, edit.pos), start: cursor });
    segments.push({ type: 'edit', edit });
    cursor = edit.pos + edit.before.length;
  }
  if (cursor < manuscript.length) segments.push({ type: 'plain', text: manuscript.slice(cursor), start: cursor });
  return segments;
}

/** A one-word verdict in the margin hand. */
function MarkTag({
  word,
  tone,
  state,
  onClick,
}: {
  word: string;
  tone: 'red' | 'gold';
  state: 'open' | 'accepted' | 'declined';
  onClick: () => void;
}) {
  const color = state === 'declined' ? '#a8a29e' : tone === 'red' ? INK_RED : INK_GOLD;
  return (
    <button
      onClick={onClick}
      className="mx-1 align-baseline italic text-[13px] leading-none whitespace-nowrap"
      style={{
        fontFamily: 'Georgia, serif',
        color,
        borderBottom: state === 'open' ? `1px dotted ${color}` : 'none',
        fontWeight: state === 'accepted' ? 700 : 400,
        textDecoration: state === 'declined' ? 'line-through' : 'none',
        opacity: state === 'declined' ? 0.7 : 1,
      }}
    >
      {state === 'accepted' ? `${word} ✓` : word}
    </button>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="block">
      <span className="text-[10px] font-semibold tracking-[0.18em] uppercase text-stone-500">{label}</span>
      <span className="block text-[13.5px] leading-relaxed text-stone-800">{children}</span>
    </span>
  );
}

export default function EditorRoom() {
  const [phase, setPhase] = useState<Phase>('desk');
  const [manuscript, setManuscript] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EditorPassResult | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [form, setForm] = useState<DocumentForm | ''>('');
  const [sourceNote, setSourceNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const segments = useMemo(
    () => (result ? buildSegments(submitted, result.edits) : []),
    [result, submitted],
  );

  const acceptedCount = result ? result.edits.filter((e) => decisions[e.id] === 'accepted').length : 0;
  const openCount = result ? result.edits.filter((e) => !decisions[e.id]).length : 0;

  async function submit() {
    const text = manuscript.trim();
    if (!text) return;
    setError(null);
    setResult(null);
    setDecisions({});
    setExpanded(null);
    setSubmitted(text);
    setPhase('working');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const pass = await runEditorPass(text, {
        form: form || undefined,
        signal: controller.signal,
        onProgress: (p) => setProgress(p.label),
      });
      setResult(pass);
      setPhase('redline');
    } catch (err) {
      if (controller.signal.aborted) {
        setPhase('desk');
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setPhase('desk');
    }
  }

  function decide(id: string, decision: Decision) {
    setDecisions((prev) => ({ ...prev, [id]: decision }));
    setExpanded(null);
  }

  async function copyEdited() {
    if (!result) return;
    const accepted = result.edits.filter((e) => decisions[e.id] === 'accepted');
    await navigator.clipboard.writeText(applyEdits(submitted, accepted));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function backToDesk() {
    abortRef.current?.abort();
    setPhase('desk');
  }

  async function readFile(file: File) {
    setSourceNote({ kind: 'info', text: `Reading “${file.name}”…` });
    try {
      const { extractManuscript, StaleChunkError } = await import('@/lib/editor/extract-manuscript');
      const { prepareDeskText } = await import('@/lib/editor/desk-text');
      let text: string;
      try {
        text = (await extractManuscript(file, (label) => setSourceNote({ kind: 'info', text: label }))).trim();
      } catch (err) {
        // A redeploy deleted this tab's hashed chunks (the pdfjs worker
        // fetch isn't covered by the vite:preloadError self-heal) —
        // reload once, with the same loop guard main.tsx uses.
        if (err instanceof StaleChunkError && Date.now() - Number(sessionStorage.getItem('chunk-reload-at') || 0) > 60_000) {
          sessionStorage.setItem('chunk-reload-at', String(Date.now()));
          setSourceNote({ kind: 'info', text: 'The app updated under this tab — reloading…' });
          window.location.reload();
          return;
        }
        throw err;
      }
      if (text.length < 40) {
        throw new Error('no readable text found — if it is a scan, ingest it into Contextspaces (OCR runs there) and pull it from your matters instead');
      }
      const prepared = prepareDeskText(text);
      if (prepared.kind === 'refused') throw new Error(prepared.reason);
      setManuscript(prepared.text);
      setSourceNote({
        kind: 'info',
        text: `Loaded “${file.name}”${prepared.kind === 'converted' ? ` (${prepared.note})` : ''} — review the text, then submit.`,
      });
    } catch (err) {
      setSourceNote({ kind: 'error', text: `Could not read “${file.name}”: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-picking the same file
    if (file) void readFile(file);
  }

  function openFileDialog() {
    // Warm the extraction chunks while the OS dialog is up, so the first
    // upload doesn't pay the pdfjs load mid-gesture.
    void import('@/lib/editor/extract-manuscript');
    fileInputRef.current?.click();
  }

  async function handleVaultLoaded(text: string, title: string) {
    setPickerOpen(false);
    const { prepareDeskText } = await import('@/lib/editor/desk-text');
    const prepared = prepareDeskText(text);
    if (prepared.kind === 'refused') {
      setSourceNote({ kind: 'error', text: `“${title}” can’t be edited: ${prepared.reason}` });
      return;
    }
    setManuscript(prepared.text);
    setSourceNote({
      kind: 'info',
      text: `Loaded “${title}” from your matters${prepared.kind === 'converted' ? ` (${prepared.note})` : ''} — review the text, then submit.`,
    });
  }

  const backdrop = (
    <>
      <img
        src="/editor/the-editor.png"
        alt="The Editor, waiting in a wood-panelled study"
        className="absolute inset-0 w-full h-full object-cover"
        style={{ objectPosition: '50% 30%', opacity: phase === 'redline' ? 0.18 : 1 }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-black/40" />
    </>
  );

  // ── The desk ─────────────────────────────────────────────────────────
  // The sheet sits to the left, over the Editor's paper-stacked desk, so
  // the Editor himself stays visible beside the manuscript — you are
  // handing him a draft, not papering over him.
  if (phase === 'desk') {
    return (
      <div
        className="relative min-h-full bg-black overflow-y-auto animate-[fadeIn_1.4s_ease-out]"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) void readFile(file);
        }}
      >
        {backdrop}
        <div className="relative z-10 max-w-xl px-6 sm:px-10 lg:pl-[5%] lg:pr-0 pt-[16vh] lg:pt-[12vh] pb-10 mx-auto lg:mx-0">
          <p className="text-[11px] font-semibold tracking-[0.3em] uppercase" style={{ color: GOLD }}>
            The Contextspaces Editor
          </p>
          <p className="mt-2 text-[15px] leading-snug text-[#f5f2ed]" style={{ fontFamily: 'Georgia, serif' }}>
            Bring any AI draft — a brief, a memo, a letter. Comments in the margin, then a proposed
            edit; every change returned as a redline for you to rule on.
          </p>

          {error && (
            <p className="mt-4 text-[13px] text-[#e8a090]">
              The Editor could not finish the last read: {error}
            </p>
          )}

          <div
            className="mt-6 bg-[#faf7f0] rounded-sm shadow-2xl p-5 sm:p-6"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) void readFile(file);
            }}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="text-[10px] font-semibold tracking-[0.24em] uppercase text-stone-500">
                Lay a manuscript on the desk
              </p>
              <span className="text-[12px] text-stone-500">
                <button
                  onClick={openFileDialog}
                  className="underline underline-offset-2 hover:text-stone-700"
                  style={{ color: INK_RED }}
                >
                  Upload a file
                </button>
                {' · '}
                <button
                  onClick={() => setPickerOpen(true)}
                  className="underline underline-offset-2 hover:text-stone-700"
                  style={{ color: INK_RED }}
                >
                  From your matters
                </button>
              </span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md"
              onChange={handleFile}
              className="hidden"
            />
            <textarea
              value={manuscript}
              onChange={(e) => setManuscript(e.target.value)}
              placeholder="Paste the draft — or drop a file here, upload one, or pull one from your matters…"
              className="mt-3 w-full min-h-[220px] bg-transparent text-[15px] leading-relaxed text-[#1c1917] placeholder:text-stone-400 focus:outline-none resize-y"
              style={{ fontFamily: 'Georgia, serif' }}
            />
            {sourceNote && (
              <p className={`mt-1 text-[12px] ${sourceNote.kind === 'error' ? 'text-red-700' : 'text-stone-500'}`}>
                {sourceNote.text}
              </p>
            )}
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="min-w-0 flex items-baseline gap-3">
                <label className="text-[12px] text-stone-500 shrink-0" style={{ fontFamily: 'Georgia, serif' }}>
                  <span className="italic">The form:</span>{' '}
                  <select
                    value={form}
                    onChange={(e) => setForm(e.target.value as DocumentForm | '')}
                    className="bg-transparent text-[12px] cursor-pointer focus:outline-none"
                    style={{ color: INK_RED, fontFamily: 'Georgia, serif' }}
                  >
                    <option value="">let the Editor judge</option>
                    {DOCUMENT_FORMS.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </label>
                <span className="text-[11px] text-stone-400 truncate">
                  {manuscript.trim() ? `${manuscript.trim().length.toLocaleString()} characters` : ''}
                </span>
              </span>
              <button
                onClick={submit}
                disabled={!manuscript.trim()}
                className="px-5 py-2 text-[13px] font-semibold text-[#faf7f0] rounded-sm disabled:opacity-40 transition-opacity"
                style={{ background: RED }}
              >
                Submit for editing
              </button>
            </div>
          </div>

          {pickerOpen && (
            <DeskSourcePicker onCancel={() => setPickerOpen(false)} onLoaded={handleVaultLoaded} />
          )}

          <p className="mt-5 text-[12px] italic text-white/35" style={{ fontFamily: 'Georgia, serif' }}>
            <span style={{ color: `${RED}cc` }}>{CORRECTIVE_AMBIENCE.join(' · ')}</span>
            <span className="text-white/25">&ensp;—&ensp;</span>
            <span style={{ color: `${GOLD}cc` }}>{PRAISE_AMBIENCE.join(' · ')}</span>
          </p>
        </div>
      </div>
    );
  }

  // ── The reading ──────────────────────────────────────────────────────
  if (phase === 'working') {
    return (
      <div className="relative h-full min-h-[480px] overflow-hidden bg-black">
        {backdrop}
        <div className="relative z-10 h-full flex flex-col items-center justify-end pb-16 px-6 text-center">
          <span className="relative flex h-2.5 w-2.5 mb-4">
            <span className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping" style={{ background: RED }} />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: RED }} />
          </span>
          <p className="text-[17px] text-[#f5f2ed]" style={{ fontFamily: 'Georgia, serif' }}>
            {progress || 'The Editor takes up the manuscript…'}
          </p>
          <p className="mt-2 text-[12px] text-white/50">
            Plan, section-by-section edit, blind critic, verification — this takes a few minutes.
          </p>
          <button onClick={backToDesk} className="mt-6 text-[12px] text-white/40 underline underline-offset-2">
            Take the manuscript back
          </button>
        </div>
      </div>
    );
  }

  // ── The redline ──────────────────────────────────────────────────────
  if (!result) return null;
  const anchoredPraise = new Map<number, PraiseNote[]>();
  for (const p of result.praise) {
    if (p.pos < 0) continue;
    const seg = segments.find(
      (s): s is Extract<Segment, { type: 'plain' }> =>
        s.type === 'plain' && p.pos >= s.start && p.pos + p.quote.length <= s.start + s.text.length,
    );
    if (!seg) continue;
    const list = anchoredPraise.get(seg.start) ?? [];
    list.push(p);
    anchoredPraise.set(seg.start, list);
  }

  return (
    <div className="relative min-h-full bg-[#171412] overflow-y-auto">
      {backdrop}

      <div className="sticky top-0 z-30 backdrop-blur bg-black/60 border-b border-white/10">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-[11px] font-semibold tracking-[0.24em] uppercase mr-auto" style={{ color: GOLD }}>
            The redline
          </span>
          <button onClick={copyEdited} className="text-[12px] text-white/80 hover:text-white underline underline-offset-2">
            {copied ? 'Copied.' : `Copy the edited text (${acceptedCount} of ${result.edits.length} applied)`}
          </button>
          {openCount > 0 && (
            <button
              onClick={() => setDecisions((prev) => {
                const next = { ...prev };
                for (const e of result.edits) if (!next[e.id]) next[e.id] = 'accepted';
                return next;
              })}
              className="text-[12px] text-white/80 hover:text-white underline underline-offset-2"
            >
              Accept remaining ({openCount})
            </button>
          )}
          <button onClick={backToDesk} className="text-[12px] text-white/50 hover:text-white/80 underline underline-offset-2">
            New manuscript
          </button>
        </div>
      </div>

      <div className="relative z-10 max-w-3xl mx-auto px-3 sm:px-6 py-8">
        <div className="bg-[#faf7f0] rounded-sm shadow-2xl px-6 sm:px-10 py-8 sm:py-10">
          {/* The Editor's cover note */}
          <div className="pb-6 mb-6 border-b border-stone-300">
            <p className="text-[10px] font-semibold tracking-[0.24em] uppercase" style={{ color: INK_RED }}>
              The Editor’s reading
            </p>
            <p className="mt-2 text-[16px] italic leading-snug text-[#1c1917]" style={{ fontFamily: 'Georgia, serif' }}>
              {result.plan.thesis}
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-stone-600">{result.plan.assessment}</p>
            <p className="mt-3 text-[12px] text-stone-500">
              {result.edits.length} {result.edits.length === 1 ? 'edit' : 'edits'} proposed · {result.praise.length} praised
              {result.rejected.length > 0 && ` · ${result.rejected.length} refused by the verifier`}
              {result.usage && (
                ` · this pass: ${(result.usage.inputTokens / 1000).toFixed(1)}k in / ${(result.usage.outputTokens / 1000).toFixed(1)}k out` +
                (result.usage.estimatedCost != null ? ` ≈ $${result.usage.estimatedCost.toFixed(2)}` : '')
              )}
            </p>
            {result.criticReport && (
              <details className="mt-3">
                <summary className="cursor-pointer text-[12px] font-semibold text-stone-600">The blind critic</summary>
                <p className="mt-1 text-[13px] leading-relaxed text-stone-700 whitespace-pre-wrap">{result.criticReport}</p>
              </details>
            )}
            {result.passNotes.length > 0 && (
              <p className="mt-2 text-[11.5px] text-amber-700">{result.passNotes.join(' ')}</p>
            )}
          </div>

          {/* The manuscript, redlined */}
          <div
            className="text-[15.5px] leading-[1.85] text-[#1c1917] whitespace-pre-wrap break-words"
            style={{ fontFamily: 'Georgia, serif' }}
          >
            {segments.map((seg, i) => {
              if (seg.type === 'plain') {
                const notes = anchoredPraise.get(seg.start);
                if (!notes || notes.length === 0) return <span key={i}>{seg.text}</span>;
                const sorted = [...notes].sort((a, b) => a.pos - b.pos);
                const parts: React.ReactNode[] = [];
                let cursor = seg.start;
                for (const p of sorted) {
                  if (p.pos < cursor) continue;
                  parts.push(<span key={`${p.id}-pre`}>{submitted.slice(cursor, p.pos)}</span>);
                  parts.push(
                    <span key={p.id}>
                      <span style={{ borderBottom: `1px dotted ${INK_GOLD}` }}>{p.quote}</span>
                      <MarkTag
                        word={p.mark}
                        tone="gold"
                        state="open"
                        onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                      />
                      {expanded === p.id && (
                        <span className="block my-2 pl-3 py-2 whitespace-normal" style={{ borderLeft: `2px solid ${INK_GOLD}` }}>
                          <DetailRow label="Why it earns the mark">{p.note}</DetailRow>
                        </span>
                      )}
                    </span>,
                  );
                  cursor = p.pos + p.quote.length;
                }
                parts.push(<span key="tail">{submitted.slice(cursor, seg.start + seg.text.length)}</span>);
                return <span key={i}>{parts}</span>;
              }

              const edit = seg.edit;
              const decision = decisions[edit.id];
              const state = decision === 'accepted' ? 'accepted' : decision === 'declined' ? 'declined' : 'open';
              return (
                <span key={edit.id}>
                  {decision === 'declined' ? (
                    <span>{edit.before}</span>
                  ) : (
                    wordDiff(edit.before, edit.after).map((op, j) =>
                      op.type === 'same' ? (
                        <span key={j}>{op.text}</span>
                      ) : op.type === 'del' ? (
                        <span key={j} style={{ color: INK_RED, textDecoration: 'line-through', opacity: 0.65 }}>
                          {op.text}
                        </span>
                      ) : (
                        <span key={j} style={{ color: INK_RED, textDecoration: 'underline', textUnderlineOffset: 3 }}>
                          {op.text}
                        </span>
                      ),
                    )
                  )}
                  <MarkTag
                    word={edit.after === '' ? `${edit.mark} — cut` : edit.mark}
                    tone="red"
                    state={state}
                    onClick={() => setExpanded(expanded === edit.id ? null : edit.id)}
                  />
                  {expanded === edit.id && (
                    <span className="block my-2 pl-3 py-2 space-y-2 whitespace-normal" style={{ borderLeft: `2px solid ${INK_RED}` }}>
                      <DetailRow label="The claim">
                        {edit.claim || 'No claim extracts — that is the diagnosis.'}
                      </DetailRow>
                      <DetailRow label="The failure">{edit.failure}</DetailRow>
                      <DetailRow label="Authority">{edit.authority}</DetailRow>
                      {edit.caution && (
                        <span className="block text-[12.5px] text-amber-700">⚠ {edit.caution}</span>
                      )}
                      {edit.criticNote && <DetailRow label="The blind critic">{edit.criticNote}</DetailRow>}
                      <span className="block pt-1">
                        <button
                          onClick={() => decide(edit.id, 'accepted')}
                          className="mr-3 px-3 py-1 text-[12px] font-semibold text-[#faf7f0] rounded-sm"
                          style={{ background: INK_RED }}
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => decide(edit.id, 'declined')}
                          className="px-3 py-1 text-[12px] font-semibold text-stone-600 border border-stone-400 rounded-sm"
                        >
                          Decline
                        </button>
                      </span>
                    </span>
                  )}
                </span>
              );
            })}
          </div>

          {/* Refused edits — shown, never silently dropped */}
          {result.rejected.length > 0 && (
            <div className="mt-8 pt-5 border-t border-stone-300">
              <p className="text-[10px] font-semibold tracking-[0.24em] uppercase text-stone-500">
                Refused by the verifier
              </p>
              {result.rejected.map((r) => (
                <p key={r.id} className="mt-2 text-[12.5px] leading-relaxed text-stone-500">
                  <span className="italic" style={{ color: INK_RED }}>{r.mark}</span>
                  {' — '}
                  <span className="line-through">{r.before.length > 160 ? `${r.before.slice(0, 160)}…` : r.before}</span>
                  <span className="text-stone-400"> ({r.rejectionReason})</span>
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

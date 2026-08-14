// The intake desk for a whole chapter — the student scans their casebook
// (vFlat page images, or a PDF of the scan), the hub reads it, maps its
// § structure, and shelves it as a text. Design source of truth:
// docs/student-hub/student-hub-design.md — this is the "upload (with
// copyright guardrails) → what would you like me to do?" flow: the pause
// before anything is filed is the review of the detected structure.

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { T } from '@/components/student-hub/theme';
import { HubStyles, CaseCaption, GreenButton, QuietControl, ErrorNote } from '@/components/student-hub/ui';
import {
  newChapterPrefix, uploadPageFiles, uploadPdfPages, ocrPages, buildChapterPlan, seedChapter,
  type ChapterPlan, type StageProgress,
} from '@/lib/student-hub-upload';

type Phase = 'intake' | 'working' | 'review' | 'seeding';

const STAGE_LABELS: Record<StageProgress['stage'], string> = {
  pages: 'Receiving the pages',
  ocr: 'Reading the pages',
  map: 'Mapping the chapter',
  segment: 'Walking the sections',
  seed: 'Shelving the readings',
};
const STAGE_ORDER: StageProgress['stage'][] = ['pages', 'ocr', 'map', 'segment', 'seed'];

const label: React.CSSProperties = {
  fontFamily: T.sans, fontSize: 11, fontWeight: 700,
  letterSpacing: '0.12em', textTransform: 'uppercase', color: T.faint,
};

export default function AddChapter() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('intake');
  const [files, setFiles] = useState<File[]>([]);
  const [attested, setAttested] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<Partial<Record<StageProgress['stage'], StageProgress>>>({});
  const [plan, setPlan] = useState<ChapterPlan | null>(null);

  // Checkpoints so "try again" resumes instead of restarting (OCR results
  // are also persisted server-side, so a retry never re-spends them).
  const checkpoint = useRef<{ prefix?: string; pagePaths?: string[]; pageTexts?: string[] }>({});
  const imageInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);

  const isPdf = files.length === 1 && /\.pdf$/i.test(files[0].name);
  const onProgress = (p: StageProgress) => setProgress((prev) => ({ ...prev, [p.stage]: p }));

  const run = async () => {
    setError('');
    setPhase('working');
    try {
      const cp = checkpoint.current;
      if (!cp.prefix) cp.prefix = await newChapterPrefix();
      if (!cp.pagePaths) {
        cp.pagePaths = isPdf
          ? await uploadPdfPages(cp.prefix, files[0], onProgress)
          : await uploadPageFiles(cp.prefix, files, onProgress);
      }
      if (!cp.pageTexts) cp.pageTexts = await ocrPages(cp.prefix, cp.pagePaths, onProgress);
      const built = await buildChapterPlan(cp.prefix, cp.pagePaths, cp.pageTexts, onProgress);
      setPlan(built);
      setPhase('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The chapter could not be prepared.');
    }
  };

  const shelve = async () => {
    if (!plan) return;
    setError('');
    setPhase('seeding');
    try {
      const textId = await seedChapter(plan, onProgress);
      navigate(`/app/student-hub?text=${textId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The chapter could not be shelved.');
      setPhase('review');
    }
  };

  const patchItem = (si: number, ii: number, patch: Partial<ChapterPlan['sections'][number]['items'][number]>) => {
    setPlan((p) => {
      if (!p) return p;
      const sections = p.sections.map((s, i) =>
        i !== si ? s : { ...s, items: s.items.map((it, j) => (j !== ii ? it : { ...it, ...patch })) });
      return { ...p, sections };
    });
  };

  return (
    <div className="student-hub-root" style={{ background: T.paper, minHeight: '100%' }}>
      <HubStyles />
      <CaseCaption
        backTo="/app/student-hub"
        kicker="Contextspaces · Student Hub · New chapter"
        title="Add a chapter"
        citation="From your own scanned casebook to its place on the shelf."
      />

      <main style={{ maxWidth: 780, margin: '0 auto', padding: '26px 20px 48px' }}>
        {error && (
          <div style={{ marginBottom: 14 }}>
            <ErrorNote>{error}</ErrorNote>
            {phase === 'working' && <QuietControl onClick={() => void run()}>try again — it resumes where it stopped</QuietControl>}
          </div>
        )}

        {/* ---- Intake ---- */}
        {phase === 'intake' && (
          <section>
            <p style={{ fontFamily: T.serif, fontSize: 15, color: T.ink, lineHeight: 1.6, maxWidth: 520, marginTop: 0 }}>
              Scan the chapter — vFlat's page images work best — and hand the pages over.
              The hub reads them, finds the sections and the cases, and shows you the
              chapter's structure before anything is shelved.
            </p>

            <input
              ref={imageInput} type="file" multiple accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <input
              ref={pdfInput} type="file" accept="application/pdf"
              style={{ display: 'none' }}
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '18px 0 6px' }}>
              <GreenButton onClick={() => imageInput.current?.click()}>Choose page images…</GreenButton>
              <QuietControl onClick={() => pdfInput.current?.click()} style={{ fontSize: 12, padding: '8px 16px' }}>
                or a PDF of the scan (from a computer)
              </QuietControl>
            </div>
            {files.length > 0 && (
              <div style={{ fontFamily: T.mono, fontSize: 12, color: T.green, margin: '8px 0 2px' }}>
                {isPdf ? files[0].name : `${files.length} page image${files.length === 1 ? '' : 's'}, in page order`}
              </div>
            )}

            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '22px 0 6px', maxWidth: 520, cursor: 'pointer' }}>
              <input
                type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)}
                style={{ marginTop: 3, accentColor: T.green }}
              />
              <span style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, lineHeight: 1.55 }}>
                This is my own lawful copy of the casebook, scanned for my personal study.
                I understand the scan stays locked to my account and is never shared or
                transmitted in any form.
              </span>
            </label>

            <div style={{ marginTop: 20 }}>
              <GreenButton disabled={!files.length || !attested} onClick={() => void run()}>
                Read the chapter
              </GreenButton>
            </div>
          </section>
        )}

        {/* ---- The ledger: progress as stages complete ---- */}
        {(phase === 'working' || phase === 'seeding') && (
          <section style={{ maxWidth: 520 }}>
            <div style={{ ...label, color: T.green, marginBottom: 10 }}>The intake ledger</div>
            {STAGE_ORDER.map((stage) => {
              const p = progress[stage];
              if (!p && stage === 'seed' && phase !== 'seeding') return null;
              const done = p && p.done >= p.total;
              return (
                <div key={stage} style={{
                  display: 'flex', alignItems: 'baseline', gap: 12,
                  borderBottom: `1px solid ${T.rule}`, padding: '10px 0',
                }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: done ? T.brass : T.rule, width: 16 }}>
                    {done ? '✓' : p ? '·' : ''}
                  </span>
                  <span style={{ fontFamily: T.serif, fontSize: 15.5, color: p ? T.ink : T.faint, flex: 1 }}>
                    {STAGE_LABELS[stage]}
                    {p?.note && <span style={{ fontStyle: 'italic', color: T.faint }}> — {p.note}</span>}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.faint }}>
                    {p ? `${p.done}/${p.total}` : ''}
                  </span>
                </div>
              );
            })}
            <p style={{ fontFamily: T.sans, fontSize: 12, color: T.faint, marginTop: 14, lineHeight: 1.5 }}>
              Keep this page open while the hub works. If it's interrupted, come back and
              try again — pages already read are not read twice.
            </p>
          </section>
        )}

        {/* ---- Review: the detected structure, before shelving ---- */}
        {phase === 'review' && plan && (
          <section>
            <div style={{ ...label, color: T.green }}>The chapter, as read</div>

            <input
              value={plan.chapterTitle}
              onChange={(e) => setPlan({ ...plan, chapterTitle: e.target.value })}
              aria-label="Chapter title"
              style={{
                display: 'block', width: '100%', boxSizing: 'border-box', margin: '10px 0 2px',
                border: 'none', borderBottom: `1px solid ${T.rule}`, background: 'transparent',
                outline: 'none', padding: '4px 0',
                fontFamily: T.serif, fontSize: 24, fontStyle: 'italic', color: T.ink,
              }}
            />
            <input
              value={plan.bookTitle}
              onChange={(e) => setPlan({ ...plan, bookTitle: e.target.value })}
              aria-label="Book title"
              placeholder="The book it belongs to (optional)"
              style={{
                display: 'block', width: '100%', boxSizing: 'border-box', margin: '0 0 18px',
                border: 'none', background: 'transparent', outline: 'none', padding: '4px 0',
                fontFamily: T.serif, fontSize: 14, color: T.faint,
              }}
            />

            {plan.sections.map((sec, si) => (
              <div key={si} style={{ marginBottom: 18 }}>
                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: 10,
                  borderBottom: `2px solid ${T.green}`, paddingBottom: 6,
                }}>
                  <span style={{ fontFamily: T.serif, fontSize: 16, color: T.green, fontWeight: 600 }}>
                    {sec.title}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint }}>
                    pp. {sec.first}–{sec.last}
                  </span>
                </div>
                {sec.items.map((it, ii) => (
                  <div key={ii} style={{
                    display: 'flex', alignItems: 'baseline', gap: 10,
                    borderBottom: `1px solid ${T.rule}`, padding: '9px 0',
                  }}>
                    <button
                      type="button"
                      onClick={() => patchItem(si, ii, { kind: it.kind === 'case' ? 'material' : 'case' })}
                      title="Click to switch between case and material"
                      style={{
                        appearance: 'none', border: 'none', cursor: 'pointer', background: 'transparent',
                        fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', padding: 0,
                        color: it.kind === 'case' ? T.oxblood : T.faint, width: 64, textAlign: 'left', flexShrink: 0,
                      }}
                    >
                      {it.kind.toUpperCase()}
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <input
                        value={it.title}
                        onChange={(e) => patchItem(si, ii, { title: e.target.value })}
                        aria-label="Reading title"
                        style={{
                          display: 'block', width: '100%', boxSizing: 'border-box',
                          border: 'none', background: 'transparent', outline: 'none', padding: 0,
                          fontFamily: T.serif, fontSize: 15.5, fontStyle: it.kind === 'case' ? 'italic' : 'normal',
                          color: T.ink,
                        }}
                      />
                      {(it.citation || it.flagged) && (
                        <div style={{ fontFamily: T.serif, fontSize: 12.5, color: it.flagged ? T.oxblood : T.faint }}>
                          {it.flagged || it.citation}
                        </div>
                      )}
                    </div>
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint, flexShrink: 0 }}>
                      pp. {it.first}–{it.last}
                    </span>
                  </div>
                ))}
              </div>
            ))}

            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 24 }}>
              <GreenButton onClick={() => void shelve()}>Add to my library</GreenButton>
              <QuietControl onClick={() => { setPlan(null); void run(); }}>read it again</QuietControl>
            </div>
            <p style={{ fontFamily: T.sans, fontSize: 12, color: T.faint, marginTop: 12, lineHeight: 1.5 }}>
              Titles are editable in place; click a CASE / MATERIAL tag to reclassify.
              If the structure looks wrong, have it read again.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}

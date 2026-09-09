import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { StudySession } from '@/lib/student-hub';
import { orderPageFiles, pageImageBlob, pdfPageBlobs, pdfPageCount } from '@/lib/student-hub-upload';
import {
  applyPageEdits, hasEdits, plannedPages,
  type NewPage, type PageEditResult,
} from '@/lib/student-hub-pages';
import { useIsMobile } from '@/hooks/useIsMobile';
import { T } from './theme';
import { QuietControl, GreenButton, ErrorNote } from './ui';

// The pages of a scanned reading, laid out to be edited: any page can be
// cut, and pages from elsewhere — a cleaner copy of a smeared page, from
// another edition; a plate the scan missed — can go in before any page or
// after the last. Nothing moves until "save the pages": the edits are
// staged here and applied in one pass (student-hub-pages.ts), so the book,
// its highlights and the assistant's copy all follow.
//
// A PDF picked as the source is not taken whole: the student names the
// pages wanted (a page number, a range) and sees them before they go in.

const PDF_PAGE_CAP = 40;
const THUMB_H = 108;

const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
const isImage = (f: File) => /\.(jpe?g|png|webp)$/i.test(f.name) || f.type.startsWith('image/');

/** "3, 12-15" → [3, 12, 13, 14, 15], within 1..max, each page once. */
function parsePageSpec(spec: string, max: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of spec.split(/[,\s]+/)) {
    if (!part) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a page number or a range like 12-15.`);
    let a = parseInt(m[1], 10);
    let b = m[2] ? parseInt(m[2], 10) : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > max) throw new Error(`This PDF has ${max} page${max === 1 ? '' : 's'}.`);
    for (let n = a; n <= b; n += 1) {
      if (!seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  return out;
}

let serial = 0;

interface PdfPick {
  file: File;
  count: number;
  /** The position the pages go in at. */
  at: number;
  spec: string;
  pages: NewPage[];
  rendering: boolean;
  error: string;
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
  padding: '8px 0', borderBottom: `1px solid ${T.rule}`,
};
const thumbStyle: React.CSSProperties = {
  height: THUMB_H, width: 'auto', maxWidth: 120, display: 'block',
  background: '#FFFFFF', border: `1px solid ${T.rule}`, borderRadius: 2,
};
const numStyle: React.CSSProperties = { fontFamily: T.mono, fontSize: 11.5, color: T.faint, minWidth: 72 };
const noteStyle: React.CSSProperties = { fontFamily: T.mono, fontSize: 11.5, color: T.faint, margin: '8px 0 0' };

export function ScanPagesEditor({ session, pageUrls, onSaved, onClose }: {
  session: StudySession;
  /** Signed URLs for session.pages, in order. */
  pageUrls: string[];
  onSaved: (result: PageEditResult) => void;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const count = session.pages?.length ?? 0;
  const [deleted, setDeleted] = useState<ReadonlySet<number>>(() => new Set());
  const [inserts, setInserts] = useState<ReadonlyMap<number, readonly NewPage[]>>(() => new Map());
  // Where the next picked file's pages go.
  const [target, setTarget] = useState<number | null>(null);
  const [pdf, setPdf] = useState<PdfPick | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);
  const renderRun = useRef(0);

  // Every preview made here is let go when the editor closes.
  useEffect(() => {
    const made = urls.current;
    return () => { for (const u of made) URL.revokeObjectURL(u); };
  }, []);

  const make = useCallback((blob: Blob, label: string): NewPage => {
    serial += 1;
    const page = { id: `new-${Date.now().toString(36)}-${serial}`, blob, previewUrl: URL.createObjectURL(blob), label };
    urls.current.push(page.previewUrl);
    return page;
  }, []);

  const addPages = (at: number, pages: NewPage[]) => {
    if (!pages.length) return;
    setInserts((prev) => {
      const next = new Map(prev);
      next.set(at, [...(prev.get(at) ?? []), ...pages]);
      return next;
    });
  };
  const removeNew = (at: number, id: string) => {
    setInserts((prev) => {
      const next = new Map(prev);
      next.set(at, (prev.get(at) ?? []).filter((p) => p.id !== id));
      return next;
    });
  };
  const toggleCut = (i: number) => {
    setDeleted((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const pick = (at: number) => {
    if (saving) return;
    setTarget(at);
    setError('');
    input.current?.click();
  };

  /* ---------------- Pages out of a PDF ---------------- */

  // The named pages, rendered at page size and shown as they come; a
  // changed spec starts a new run and the old one stops at its next page.
  const renderPdf = useCallback(async (file: File, total: number, spec: string) => {
    const run = (renderRun.current += 1);
    const patch = (p: Partial<PdfPick>) => setPdf((cur) => (cur && cur.file === file ? { ...cur, ...p } : cur));
    let wanted: number[];
    try {
      wanted = parsePageSpec(spec, total);
    } catch (e) {
      patch({ pages: [], rendering: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (wanted.length > PDF_PAGE_CAP) {
      patch({ pages: [], rendering: false, error: `At most ${PDF_PAGE_CAP} pages at a time.` });
      return;
    }
    patch({ pages: [], rendering: wanted.length > 0, error: '' });
    if (!wanted.length) return;
    try {
      for await (const { blob, n } of pdfPageBlobs(file, wanted)) {
        if (renderRun.current !== run) return;
        const page = make(blob, `${file.name} · p. ${n}`);
        setPdf((cur) => (cur && cur.file === file ? { ...cur, pages: [...cur.pages, page] } : cur));
      }
      if (renderRun.current === run) patch({ rendering: false });
    } catch (e) {
      if (renderRun.current === run) {
        patch({ rendering: false, error: e instanceof Error ? e.message : 'That PDF could not be read.' });
      }
    }
  }, [make]);

  const openPdf = async (file: File, at: number) => {
    let total: number;
    try {
      total = await pdfPageCount(file);
    } catch {
      setError('That PDF could not be opened.');
      return;
    }
    // A short PDF is wanted whole, as a rule; a long one needs its pages named.
    const spec = total <= 12 ? `1-${total}` : '';
    setPdf({ file, count: total, at, spec, pages: [], rendering: false, error: '' });
    if (spec) void renderPdf(file, total, spec);
  };

  const onFiles = async (files: File[]) => {
    const at = target;
    setTarget(null);
    if (at === null || !files.length) return;
    setError('');
    const pdfFile = files.find(isPdf);
    if (pdfFile) { await openPdf(pdfFile, at); return; }
    const images = orderPageFiles(files.filter(isImage));
    if (!images.length) { setError('Pick page images (JPEG, PNG, WebP) or a PDF.'); return; }
    const pages: NewPage[] = [];
    for (const f of images) pages.push(make(await pageImageBlob(f), f.name));
    addPages(at, pages);
  };

  const confirmPdf = () => {
    if (!pdf || pdf.rendering || !pdf.pages.length) return;
    addPages(pdf.at, pdf.pages);
    setPdf(null);
  };
  const cancelPdf = () => { renderRun.current += 1; setPdf(null); };

  /* ---------------- Saving ---------------- */

  const edits = { deleted, inserts };
  const plan = plannedPages(count, edits);
  const inCount = plan.filter((p) => p.kind === 'new').length;
  const changed = hasEdits(edits);

  const save = async () => {
    if (saving || !changed) return;
    setError('');
    setSaving('Preparing…');
    try {
      onSaved(await applyPageEdits(session, edits, setSaving));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The pages could not be saved.');
      setSaving(null);
    }
  };

  /* ---------------- Render ---------------- */

  const insertButton = (at: number, label: string) => (
    <QuietControl onClick={() => pick(at)} disabled={!!saving} title="Page images, or pages picked out of a PDF">
      ＋ {label}
    </QuietControl>
  );

  const newRows = (at: number) => (inserts.get(at) ?? []).map((p) => (
    <li key={p.id} style={{ ...rowStyle, borderLeft: `2px solid ${T.brass}`, paddingLeft: 10 }}>
      <img src={p.previewUrl} alt="" style={thumbStyle} />
      <span style={{ ...numStyle, color: T.brass }}>new</span>
      <span
        style={{
          fontFamily: T.sans, fontSize: 12, color: T.ink, flex: '1 1 160px', minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {p.label}
      </span>
      <QuietControl onClick={() => removeNew(at, p.id)} disabled={!!saving}>take it back out</QuietControl>
    </li>
  ));

  const where = pdf ? (pdf.at < count ? `before p. ${pdf.at + 1}` : 'after the last page') : '';

  return (
    <section aria-label="Edit the pages">
      <p style={{ fontFamily: T.serif, fontSize: 14.5, color: T.faint, lineHeight: 1.55, margin: '0 0 12px' }}>
        Cut the pages this reading never needed, or put in pages from another copy — page images,
        or pages picked out of a PDF. Nothing changes until you save; then the book, its find box,
        the assistant's copy and your highlights all follow the new pages (a highlight on a cut
        page goes with it).
      </p>
      <input
        ref={input}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,application/pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void onFiles(files);
        }}
      />

      {pdf && (
        <div
          style={{
            border: `1px solid ${T.rule}`, borderTop: `2px solid ${T.brass}`, borderRadius: 2,
            padding: '10px 12px', margin: '0 0 12px', background: '#FFFFFF',
          }}
        >
          <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink, marginBottom: 8, lineHeight: 1.5 }}>
            <strong>{pdf.file.name}</strong> — {pdf.count} page{pdf.count === 1 ? '' : 's'}. Which go in {where}?
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={pdf.spec}
              onChange={(e) => { const spec = e.target.value; setPdf((cur) => (cur ? { ...cur, spec } : cur)); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void renderPdf(pdf.file, pdf.count, pdf.spec); } }}
              onBlur={() => { if (pdf.spec.trim()) void renderPdf(pdf.file, pdf.count, pdf.spec); }}
              placeholder="e.g. 12-15, 20"
              inputMode="numeric"
              aria-label="Pages to put in"
              style={{
                fontFamily: T.mono, fontSize: isMobile ? 16 : 13, color: T.ink, background: '#FFFFFF',
                border: `1px solid ${T.rule}`, borderRadius: 2, padding: '6px 8px', outline: 'none', width: 150,
              }}
            />
            <QuietControl onClick={() => void renderPdf(pdf.file, pdf.count, pdf.spec)} disabled={pdf.rendering}>
              show them
            </QuietControl>
            <GreenButton
              onClick={confirmPdf}
              disabled={pdf.rendering || !pdf.pages.length}
              style={{ fontSize: 12, padding: '7px 16px' }}
            >
              {pdf.pages.length ? `put in these ${pdf.pages.length}` : 'put them in'}
            </GreenButton>
            <QuietControl onClick={cancelPdf}>never mind</QuietControl>
          </div>
          {pdf.error && <div style={{ marginTop: 8 }}><ErrorNote>{pdf.error}</ErrorNote></div>}
          {pdf.rendering && <p style={noteStyle}>Rendering the pages…</p>}
          {pdf.pages.length > 0 && (
            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingTop: 10 }}>
              {pdf.pages.map((p) => (
                <figure key={p.id} style={{ margin: 0, flexShrink: 0 }}>
                  <img src={p.previewUrl} alt="" style={thumbStyle} />
                  <figcaption style={{ fontFamily: T.mono, fontSize: 10.5, color: T.faint, textAlign: 'center', paddingTop: 3 }}>
                    {p.label.replace(/^.*· /, '')}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      )}

      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {Array.from({ length: count }, (_, i) => {
          const cut = deleted.has(i);
          return (
            <Fragment key={i}>
              {newRows(i)}
              <li style={{ ...rowStyle, opacity: cut ? 0.45 : 1 }}>
                {pageUrls[i] ? (
                  <img src={pageUrls[i]} alt={`Page ${i + 1}`} loading="lazy" style={thumbStyle} />
                ) : (
                  <div style={{ ...thumbStyle, width: Math.round(THUMB_H * 0.72) }} />
                )}
                <span style={numStyle}>{cut ? `p. ${i + 1} · out` : `p. ${i + 1}`}</span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {insertButton(i, 'put pages in before')}
                  <QuietControl
                    onClick={() => toggleCut(i)}
                    disabled={!!saving}
                    style={cut ? { color: T.green, borderColor: T.green } : { color: T.oxblood, borderColor: T.oxblood }}
                  >
                    {cut ? '↶ keep this page' : '✕ cut this page'}
                  </QuietControl>
                </span>
              </li>
            </Fragment>
          );
        })}
        {newRows(count)}
        <li style={{ ...rowStyle, borderBottom: 'none' }}>{insertButton(count, 'put pages in after the last page')}</li>
      </ol>

      <footer
        style={{
          position: 'sticky', bottom: isMobile ? 56 : 0, zIndex: 5,
          background: T.paper, borderTop: `1px solid ${T.rule}`, padding: '10px 0', marginTop: 8,
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}
      >
        <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.faint, flex: '1 1 200px' }}>
          {saving ?? `${count} page${count === 1 ? '' : 's'} → ${plan.length} · ${inCount} in · ${deleted.size} out`}
        </span>
        <GreenButton onClick={() => void save()} disabled={!!saving || !changed} style={{ fontSize: 12, padding: '8px 18px' }}>
          {saving ? 'Saving…' : 'Save the pages'}
        </GreenButton>
        <QuietControl onClick={onClose} disabled={!!saving}>{changed ? 'discard' : 'done'}</QuietControl>
      </footer>
      {error && <div style={{ marginTop: 8 }}><ErrorNote>{error}</ErrorNote></div>}
    </section>
  );
}

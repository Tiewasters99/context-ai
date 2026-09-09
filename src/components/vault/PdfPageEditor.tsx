import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { X, RotateCw, Trash2, Undo2, Loader2, Check, Plus } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { downloadVaultDocument } from '@/lib/vault-persist';
import { sandboxApi } from '@/lib/sandbox-api';
import { PDFJS_DOC_PARAMS } from '@/lib/pdfjs';
import { useIsMobile } from '@/hooks/useIsMobile';
import ModalPortal from '@/components/ui/ModalPortal';

// Light PDF editing: cut, reorder (drag, on a laptop), rotate — and put in
// pages from another PDF filed in the same matter: a cleaner copy of a page
// the scanner smeared, from another edition; an exhibit into a filing. The
// result is saved as a NEW document via the edit_pdf server action; the
// original is never touched.
//
// Thumbnails are rendered as tiles scroll into view, one page at a time, so
// a 400-page scan opens at once and costs only the pages looked at.

// Same worker resolution pattern as DocumentReader / extract.ts.
const PDFJS_WORKER_URL = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const THUMB_W = 132;
const INSERT_CAP = 60;
const FIRST_ROWS = 12;

interface PageTile {
  key: string;
  /** The document the page comes from — this one, or another PDF in the matter. */
  docId: string;
  srcPage: number;       // 1-based page number in that document
  rotation: 0 | 90 | 180 | 270;
  deleted: boolean;
  /** For a page from another document: its title, for the tile. */
  from?: string;
}

interface SourceDoc {
  id: string;
  title: string;
  storage_path: string;
  page_count: number | null;
}

interface Picker {
  /** Tile index the pages go in before; tiles.length for the end. */
  at: number;
  docs: SourceDoc[] | null;
  chosen: SourceDoc | null;
  count: number | null;
  spec: string;
  pages: number[];
  error: string;
  busy: boolean;
}

interface Props {
  doc: {
    id: string;
    title: string;
    storage_path: string | null;
    source_filename: string | null;
    matterspace_id?: string | null;
  };
  onClose: () => void;
  onSaved: (result: { filename: string; downloadUrl?: string; documentId?: string }) => void;
}

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
    if (a < 1 || b > max) throw new Error(`That PDF has ${max} page${max === 1 ? '' : 's'}.`);
    for (let n = a; n <= b; n += 1) {
      if (!seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  if (!out.length) throw new Error('Name the pages to put in — a number, or a range like 12-15.');
  return out;
}

let serial = 0;
const tileKey = () => `t${(serial += 1)}`;

const iconBtn = 'p-1 rounded hover:bg-[rgba(255,255,255,0.1)] text-white/60 disabled:opacity-40';

export default function PdfPageEditor({ doc, onClose, onSaved }: Props) {
  const isMobile = useIsMobile();
  const [tiles, setTiles] = useState<PageTile[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [filename, setFilename] = useState(
    (doc.source_filename ?? doc.title ?? 'document').replace(/\.pdf$/i, '') + '-edited.pdf',
  );
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [picker, setPicker] = useState<Picker | null>(null);
  const dragFrom = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  /* ---------------- The PDFs, opened once each ---------------- */

  const pdfsRef = useRef(new Map<string, Promise<PDFDocumentProxy>>());
  const openPdf = useCallback((docId: string, storagePath: string) => {
    let p = pdfsRef.current.get(docId);
    if (!p) {
      p = (async () => {
        const blob = await downloadVaultDocument(storagePath);
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        return pdfjsLib.getDocument({ data: await blob.arrayBuffer(), ...PDFJS_DOC_PARAMS }).promise;
      })();
      pdfsRef.current.set(docId, p);
      p.catch(() => pdfsRef.current.delete(docId));
    }
    return p;
  }, []);

  /* ---------------- Thumbnails, as tiles come into view ---------------- */

  const queueRef = useRef<{ docId: string; page: number }[]>([]);
  const queuedRef = useRef(new Set<string>());
  const pumpingRef = useRef(false);

  useEffect(() => {
    const opened = pdfsRef.current;
    const queued = queuedRef.current;
    return () => {
      // Closing the editor — or React's development-mode rehearsal of it —
      // lets every PDF go and forgets it, so a later effect pass opens the
      // document afresh instead of finding a destroyed one that never answers.
      for (const p of opened.values()) p.then((pdf) => pdf.destroy()).catch(() => undefined);
      opened.clear();
      queued.clear();
      queueRef.current = [];
      pumpingRef.current = false;
    };
  }, []);
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      for (;;) {
        const next = queueRef.current.shift();
        if (!next) break;
        const opened = pdfsRef.current.get(next.docId);
        if (!opened) continue;
        try {
          const pdf = await opened;
          const page = await pdf.getPage(next.page);
          const viewport = page.getViewport({ scale: THUMB_W / page.getViewport({ scale: 1 }).width });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          // The print intent paces its work with timers rather than animation
          // frames, so thumbnails keep coming when the tab is not in front.
          await page.render({ canvas, canvasContext: ctx, viewport, intent: 'print' }).promise;
          const url = canvas.toDataURL('image/jpeg', 0.7);
          page.cleanup();
          setThumbs((prev) => ({ ...prev, [`${next.docId}:${next.page}`]: url }));
        } catch (e) {
          // A page that will not render keeps its placeholder; say why.
          console.warn('page editor: thumbnail failed', next, e);
        }
      }
    } finally {
      pumpingRef.current = false;
    }
  }, []);
  const requestThumb = useCallback((docId: string, page: number) => {
    const key = `${docId}:${page}`;
    if (queuedRef.current.has(key)) return;
    queuedRef.current.add(key);
    queueRef.current.push({ docId, page });
    void pump();
  }, [pump]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || loading) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        const page = Number(el.dataset.page);
        if (el.dataset.doc && page) requestThumb(el.dataset.doc, page);
      }
    }, { root: grid, rootMargin: '320px 0px' });
    grid.querySelectorAll<HTMLElement>('[data-page]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [tiles, loading, requestThumb]);

  /* ---------------- This document's pages ---------------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!doc.storage_path) throw new Error('This document has no stored file.');
        const pdf = await openPdf(doc.id, doc.storage_path);
        if (cancelled) return;
        setTotalPages(pdf.numPages);
        setTiles(Array.from({ length: pdf.numPages }, (_, i) => ({
          key: tileKey(), docId: doc.id, srcPage: i + 1, rotation: 0, deleted: false,
        })));
        setLoading(false);
        // The first rows straight away; the rest as they scroll into view.
        for (let n = 1; n <= Math.min(FIRST_ROWS, pdf.numPages); n += 1) requestThumb(doc.id, n);
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [doc.id, doc.storage_path, openPdf, requestThumb]);

  const rotateTile = (idx: number) =>
    setTiles((prev) => prev.map((t, i) => (i === idx ? { ...t, rotation: ((t.rotation + 90) % 360) as PageTile['rotation'] } : t)));
  const toggleDelete = (idx: number) =>
    setTiles((prev) => prev.map((t, i) => (i === idx ? { ...t, deleted: !t.deleted } : t)));
  const reorder = (from: number, to: number) =>
    setTiles((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  /* ---------------- Pages from another PDF in the matter ---------------- */

  const openPicker = async (at: number) => {
    setPicker({ at, docs: null, chosen: null, count: null, spec: '', pages: [], error: '', busy: false });
    if (!doc.matterspace_id) { setPicker((p) => (p ? { ...p, docs: [] } : p)); return; }
    const { data, error: qErr } = await supabase
      .from('documents')
      .select('id, title, source_filename, storage_path, page_count')
      .eq('matterspace_id', doc.matterspace_id)
      .neq('id', doc.id)
      .not('storage_path', 'is', null)
      .order('title');
    const docs: SourceDoc[] = (data ?? [])
      .filter((d) => /\.pdf$/i.test(d.source_filename || d.storage_path || ''))
      .map((d) => ({ id: d.id, title: d.title, storage_path: String(d.storage_path), page_count: d.page_count }));
    setPicker((p) => (p && p.at === at ? { ...p, docs, error: qErr ? qErr.message : '' } : p));
  };

  const showPages = (source: SourceDoc, count: number, spec: string) => {
    try {
      const pages = parsePageSpec(spec, count);
      if (pages.length > INSERT_CAP) throw new Error(`At most ${INSERT_CAP} pages at a time.`);
      setPicker((p) => (p ? { ...p, pages, error: '' } : p));
      for (const n of pages) requestThumb(source.id, n);
    } catch (e) {
      setPicker((p) => (p ? { ...p, pages: [], error: e instanceof Error ? e.message : String(e) } : p));
    }
  };

  const chooseSource = async (source: SourceDoc) => {
    setPicker((p) => (p ? { ...p, chosen: source, count: null, spec: '', pages: [], error: '', busy: true } : p));
    try {
      const pdf = await openPdf(source.id, source.storage_path);
      // A short PDF is wanted whole, as a rule; a long one needs its pages named.
      const spec = pdf.numPages <= 12 ? `1-${pdf.numPages}` : '';
      setPicker((p) => (p && p.chosen?.id === source.id ? { ...p, count: pdf.numPages, spec, busy: false } : p));
      if (spec) showPages(source, pdf.numPages, spec);
    } catch (e) {
      setPicker((p) => (p && p.chosen?.id === source.id
        ? { ...p, busy: false, error: e instanceof Error ? e.message : 'That PDF could not be opened.' }
        : p));
    }
  };

  const confirmInsert = () => {
    if (!picker?.chosen || !picker.pages.length) return;
    const source = picker.chosen;
    const at = picker.at;
    const fresh: PageTile[] = picker.pages.map((n) => ({
      key: tileKey(), docId: source.id, srcPage: n, rotation: 0, deleted: false, from: source.title,
    }));
    setTiles((prev) => [...prev.slice(0, at), ...fresh, ...prev.slice(at)]);
    setPicker(null);
  };

  /* ---------------- Saving ---------------- */

  const kept = tiles.filter((t) => !t.deleted);
  const ownKept = kept.filter((t) => t.docId === doc.id);
  const foreignCount = kept.length - ownKept.length;
  const changed =
    kept.length !== tiles.length ||
    foreignCount > 0 ||
    tiles.some((t) => t.rotation !== 0) ||
    ownKept.length !== totalPages ||
    ownKept.some((t, i) => t.srcPage !== i + 1);

  const handleSave = async () => {
    if (saving || !changed) return;
    if (!ownKept.length) {
      setError('Keep at least one page of this document — the edited copy is filed beside it.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const pages = ownKept.map((t) => String(t.srcPage)).join(',');
      const rotate = ownKept
        .filter((t) => t.rotation !== 0)
        .map((t) => ({ pages: String(t.srcPage), degrees: t.rotation }));
      // Pages from other documents, as runs: each run names the position in
      // the output (1-based, before that many kept pages) it goes at.
      type Run = { at: number; document_id: string; pages: number[]; degrees: number };
      const runs: Run[] = [];
      let ownSeen = 0;
      let open: Run | null = null;
      for (const t of kept) {
        if (t.docId === doc.id) { open = null; ownSeen += 1; continue; }
        if (open && open.document_id === t.docId && open.degrees === t.rotation) { open.pages.push(t.srcPage); continue; }
        open = { at: ownSeen + 1, document_id: t.docId, pages: [t.srcPage], degrees: t.rotation };
        runs.push(open);
      }
      const inserts = runs.map((r) => ({
        at: r.at, document_id: r.document_id, pages: r.pages.join(','), ...(r.degrees ? { degrees: r.degrees } : {}),
      }));
      const out = await sandboxApi<{ document_id?: string; download_url?: string | null }>('edit_pdf', {
        document_id: doc.id,
        pages,
        ...(rotate.length ? { rotate } : {}),
        ...(inserts.length ? { inserts } : {}),
        filename,
      });
      onSaved({ filename, downloadUrl: out.download_url ?? undefined, documentId: out.document_id });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  /* ---------------- Render ---------------- */

  const chosen = picker?.chosen ?? null;
  const controls = isMobile
    ? 'flex items-center gap-0.5'
    : 'flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity';
  const field = 'h-8 rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.05)] px-2 text-[12px] text-white focus:outline-none focus:ring-1 focus:ring-[#e8b84a]';

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[70] bg-black/50" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-[94vw] max-w-4xl h-[88vh] rounded-xl border border-[rgba(255,255,255,0.12)] bg-[#12121a] flex flex-col">
        <div className="px-4 sm:px-5 py-3 border-b border-[rgba(255,255,255,0.08)] flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-white truncate">Edit pages — {doc.title}</h3>
            <p className="text-[11px] text-white/50 mt-0.5">
              Cut, rotate{isMobile ? '' : ', drag to reorder'}, or put in pages from another PDF in this matter.
              Saves as a new PDF beside this one; the original stays untouched.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white" aria-label="Close"><X size={16} /></button>
        </div>

        {picker && (
          <div className="px-4 sm:px-5 py-3 border-b border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[12px] text-white/80">
            <div className="flex items-start justify-between gap-3">
              <span>
                Put pages in {picker.at < tiles.length ? `before position ${picker.at + 1}` : 'at the end'}, from another PDF filed in this matter.
              </span>
              <button onClick={() => setPicker(null)} className="p-1 rounded hover:bg-[rgba(255,255,255,0.08)] text-white/50 hover:text-white shrink-0" aria-label="Close"><X size={14} /></button>
            </div>
            {picker.docs === null && <p className="text-white/50 mt-1">Looking for PDFs in this matter…</p>}
            {picker.docs && picker.docs.length === 0 && (
              <p className="text-white/50 mt-1">
                No other PDF is filed in this matter yet. Upload the other copy into the matter first, then come back here.
              </p>
            )}
            {picker.docs && picker.docs.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <select
                  value={chosen?.id ?? ''}
                  onChange={(e) => {
                    const s = (picker.docs ?? []).find((d) => d.id === e.target.value);
                    if (s) void chooseSource(s);
                  }}
                  className={`${field} max-w-[60vw]`}
                  aria-label="The PDF to take pages from"
                >
                  <option value="">Choose a PDF…</option>
                  {picker.docs.map((d) => (
                    <option key={d.id} value={d.id}>{d.title}{d.page_count ? ` (${d.page_count} pp.)` : ''}</option>
                  ))}
                </select>
                {picker.busy && <Loader2 size={14} className="animate-spin text-white/50" />}
                {chosen && picker.count !== null && (
                  <>
                    <span className="text-white/50">{picker.count} pages — which?</span>
                    <input
                      value={picker.spec}
                      onChange={(e) => { const spec = e.target.value; setPicker((p) => (p ? { ...p, spec } : p)); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); showPages(chosen, picker.count ?? 0, picker.spec); } }}
                      placeholder="e.g. 12-15, 20"
                      inputMode="numeric"
                      aria-label="Pages to put in"
                      className={`${field} w-32`}
                      style={{ fontSize: isMobile ? 16 : undefined }}
                    />
                    <button onClick={() => showPages(chosen, picker.count ?? 0, picker.spec)} className="h-8 px-3 rounded-md border border-[rgba(255,255,255,0.12)] hover:bg-white/5 text-white/80">show</button>
                    <button
                      onClick={confirmInsert}
                      disabled={!picker.pages.length}
                      className="h-8 px-3 rounded-md bg-[#f0c850] hover:bg-[#e8b84a] text-black font-bold disabled:opacity-40"
                    >
                      Put in {picker.pages.length || ''} page{picker.pages.length === 1 ? '' : 's'}
                    </button>
                  </>
                )}
              </div>
            )}
            {picker.error && <p className="text-red-400 mt-1.5">{picker.error}</p>}
            {chosen && picker.pages.length > 0 && (
              <div className="flex gap-2 overflow-x-auto mt-2 pb-1">
                {picker.pages.map((n) => (
                  <figure key={n} className="shrink-0 w-16 m-0">
                    <div className="aspect-[8.5/11] rounded bg-white/95 overflow-hidden flex items-center justify-center">
                      {thumbs[`${chosen.id}:${n}`]
                        ? <img src={thumbs[`${chosen.id}:${n}`]} alt={`page ${n}`} className="max-w-full max-h-full" draggable={false} />
                        : <Loader2 size={12} className="animate-spin text-black/30" />}
                    </div>
                    <figcaption className="text-[10px] text-white/50 text-center mt-0.5">p.{n}</figcaption>
                  </figure>
                ))}
              </div>
            )}
          </div>
        )}

        <div ref={gridRef} className="flex-1 overflow-y-auto p-4 sm:p-5">
          {loading ? (
            <p className="flex items-center gap-2 text-[12px] text-white/50"><Loader2 size={14} className="animate-spin" /> Loading PDF…</p>
          ) : error && !tiles.length ? (
            <p className="text-[12px] text-red-400">{error}</p>
          ) : (
            <div className={`grid gap-3 ${isMobile ? 'grid-cols-[repeat(auto-fill,minmax(120px,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(140px,1fr))]'}`}>
              {tiles.map((t, idx) => {
                const thumb = thumbs[`${t.docId}:${t.srcPage}`];
                return (
                  <div
                    key={t.key}
                    data-doc={t.docId}
                    data-page={t.srcPage}
                    draggable={!isMobile}
                    onDragStart={() => { dragFrom.current = idx; }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragFrom.current !== null && dragFrom.current !== idx) reorder(dragFrom.current, idx);
                      dragFrom.current = null;
                    }}
                    className={`group relative rounded-lg border p-2 ${isMobile ? '' : 'cursor-grab'} transition-colors ${
                      t.deleted
                        ? 'border-red-500/30 opacity-40'
                        : t.from
                          ? 'border-[rgba(232,184,74,0.45)] hover:border-[rgba(232,184,74,0.8)]'
                          : 'border-[rgba(255,255,255,0.1)] hover:border-[rgba(232,184,74,0.4)]'
                    }`}
                  >
                    <div className="aspect-[8.5/11] rounded bg-white/95 overflow-hidden flex items-center justify-center">
                      {thumb ? (
                        <img
                          src={thumb}
                          alt={`page ${t.srcPage}`}
                          className="max-w-full max-h-full transition-transform"
                          style={{ transform: `rotate(${t.rotation}deg)` }}
                          draggable={false}
                        />
                      ) : (
                        <span className="text-[12px] text-black/30 tabular-nums">{t.srcPage}</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-1 mt-1.5">
                      <span className="text-[10px] text-white/50 truncate" title={t.from ? `${t.from}, p.${t.srcPage}` : undefined}>
                        {t.from ? `${t.from} · ` : ''}p.{t.srcPage}{t.rotation ? ` · ${t.rotation}°` : ''}
                      </span>
                      <div className={controls}>
                        <button onClick={() => void openPicker(idx)} title="Put pages in before this one" className={`${iconBtn} hover:text-[#e8b84a]`}><Plus size={12} /></button>
                        <button onClick={() => rotateTile(idx)} title="Rotate 90° clockwise" className={`${iconBtn} hover:text-[#e8b84a]`}><RotateCw size={12} /></button>
                        <button onClick={() => toggleDelete(idx)} title={t.deleted ? 'Keep this page' : 'Cut this page'} className={`${iconBtn} hover:text-red-400`}>
                          {t.deleted ? <Undo2 size={12} /> : <Trash2 size={12} />}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              <button
                onClick={() => void openPicker(tiles.length)}
                className="rounded-lg border border-dashed border-[rgba(255,255,255,0.18)] hover:border-[rgba(232,184,74,0.6)] text-white/50 hover:text-[#e8b84a] text-[11px] flex flex-col items-center justify-center gap-1 min-h-[120px] transition-colors"
                title="Put pages in at the end"
              >
                <Plus size={16} />
                pages at the end
              </button>
            </div>
          )}
        </div>

        <div className="px-4 sm:px-5 py-3 border-t border-[rgba(255,255,255,0.08)] flex flex-wrap items-center gap-3">
          <input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            aria-label="Filename for the edited copy"
            className={`${field} flex-1 min-w-[160px]`}
          />
          <span className="text-[11px] text-white/40 shrink-0">
            {kept.length} page{kept.length !== 1 ? 's' : ''}{foreignCount ? ` · ${foreignCount} from another copy` : ''}
          </span>
          <button
            onClick={() => void handleSave()}
            disabled={saving || kept.length === 0 || !changed}
            title={changed ? 'Save the edited copy' : 'No changes yet'}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[12px] font-bold transition-colors disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            Save as new PDF
          </button>
          {error && tiles.length > 0 && <p className="w-full text-[12px] text-red-400">{error}</p>}
        </div>
      </div>
    </ModalPortal>
  );
}

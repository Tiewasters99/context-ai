import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Sun,
  Moon,
  X,
  Search,
  PanelLeft,
  Scan,
  Maximize,
  Minimize,
  Download,
  HardDrive,
  StickyNote,
  Copy,
  Check,
  Printer,
  FileText,
  Pencil,
} from 'lucide-react';
import mammoth from 'mammoth';
import { Fountain } from 'fountain-js';
import { supabase } from '@/lib/supabase';
import { PDFJS_DOC_PARAMS } from '@/lib/pdfjs';
import ReaderSidebar, { type OutlineNode } from '@/components/reader/ReaderSidebar';
import CoverImage from '@/components/layout/CoverImage';
import CoverModeToggle from '@/components/ui/CoverModeToggle';
import CanvasPinToggle from '@/components/canvas/CanvasPinToggle';
import type { EmbeddableViewProps } from '@/lib/canvas';
import { useCoverExpanded } from '@/hooks/useCoverExpanded';
import { useConnections } from '@/hooks/useConnections';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  addAnnotationLink,
  annotationIsNote,
  createAnnotation,
  deleteAnnotation,
  derivePageLine,
  listAnnotations,
  listIncomingLinks,
  updateAnnotation,
  type Annotation,
  type AnnotationColor,
  type AnnotationLink,
  type AnnotationVisibility,
  type FractionalRect,
  type IncomingLink,
} from '@/lib/document-annotations';
import {
  CrossRefRail,
  NoteCard,
  NoteComposer,
  NotesRail,
  NOTE_RAIL_W,
  NOTE_RAIL_W_MOBILE,
  RefCard,
  type ComposerLink,
} from '@/components/reader/Marginalia';
import { useAuth } from '@/contexts/AuthContext';
import {
  interceptStyledCopy,
  pdfDocumentText,
  reflowedHtml,
  selectionHtml,
  htmlPlainText,
  writeClipboard,
} from '@/lib/reader-copy';

// pdfjs worker URL — same pattern as src/lib/extract.ts. Resolved at build
// time by Vite from the installed pdfjs-dist package.
const PDFJS_WORKER_URL = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

type DocMeta = {
  id: string;
  title: string;
  storage_path: string | null;
  source_filename: string | null;
  page_count: number | null;
  cover_url: string | null;
  matterspace_id: string | null;
};

type FileKind = 'pdf' | 'docx' | 'fountain' | 'pptx' | 'unsupported';

// PPTX display: one white card per slide, built from the same slide text the
// ingest pipeline indexes (lib/pptx-extract.mjs's browser twin). Not a pixel
// render of the deck — a readable one, with speaker notes kept visible.
async function pptxDeckHtml(data: ArrayBuffer): Promise<string> {
  const { extractPptxSlides } = await import('@/lib/pptx');
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const slides = await extractPptxSlides(data);
  return slides
    .map((s) => {
      const [title, ...rest] = s.lines;
      return (
        `<section class="pptx-slide"><span class="pptx-slide-num">${s.num}</span>` +
        (title ? `<h2>${esc(title)}</h2>` : '') +
        rest.map((l) => `<p>${esc(l)}</p>`).join('') +
        (s.notes.length
          ? `<aside class="pptx-notes"><strong>Speaker notes</strong>${s.notes
              .map((l) => `<p>${esc(l)}</p>`)
              .join('')}</aside>`
          : '') +
        `</section>`
      );
    })
    .join('');
}
type LoadState = 'loading' | 'ready' | 'error';
type Theme = 'parchment' | 'dark';
type Match = { page: number; index: number };

// Vertical gap between page slots in the continuous stack.
const PAGE_GAP = 16;

export default function DocumentReader({ id: propId, embedded = false, onClose }: EmbeddableViewProps = {}) {
  const params = useParams<{ id: string }>();
  const id = propId ?? params.id;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isMobile = useIsMobile();

  const [doc, setDoc] = useState<DocMeta | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fileKind, setFileKind] = useState<FileKind>('pdf');
  const [docHtml, setDocHtml] = useState<string | null>(null);
  // For .fountain — the parser produces a separate title-page block we
  // want to render above the script body.
  const [titlePageHtml, setTitlePageHtml] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [zoom, setZoom] = useState(1.5);
  const [theme, setTheme] = useState<Theme>('parchment');

  // Fit-page mode (PDF only). When on, each page is scaled so the entire
  // page is visible at once — one screenful = exactly one PDF page, so the
  // reader's pages line up with the PDF's pages for citation/citechecking.
  // Default on. The stack scrolls continuously in either mode.
  const [fitPage, setFitPage] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Bumped whenever the content pane resizes, to re-fit the page.
  const [containerTick, setContainerTick] = useState(0);

  // Search state — PDF only.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [matchIdx, setMatchIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  const pageTextCacheRef = useRef<string[]>([]);

  // Sidebar state — PDF only.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [thumbnails, setThumbnails] = useState<(string | null)[]>([]);
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);

  // Annotations state — PDF only. Loaded once per document; updated
  // optimistically on create/delete so we don't round-trip the DB for UX.
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
    page: number;
    rects: FractionalRect[];
    anchorText: string;
  } | null>(null);

  // Marginalia state — the margin rails and their popovers. `incomingLinks`
  // are cross-references: notes in OTHER documents whose links point here.
  const { user } = useAuth();
  const [noteComposer, setNoteComposer] = useState<{
    x: number;
    y: number;
    page: number;
    rects: FractionalRect[];
    anchorText: string;
  } | null>(null);
  const [openNote, setOpenNote] = useState<{ id: string; x: number; y: number } | null>(null);
  const [openRef, setOpenRef] = useState<{ link: IncomingLink; x: number; y: number } | null>(null);
  const [incomingLinks, setIncomingLinks] = useState<IncomingLink[]>([]);

  const pdfDocRef = useRef<unknown>(null);
  // Natural (scale-1) size of every page, so the stack can lay out a
  // fixed-height slot per page before any page paints. Seeded with page
  // 1's size on load; a background sweep corrects odd-sized pages.
  const [pageDims, setPageDims] = useState<{ w: number; h: number }[] | null>(null);
  // One canvas + text layer per slot; only slots near the viewport are
  // painted. pdfjs refuses overlapping renders on one canvas, so each
  // slot's in-flight task is tracked and cancelled per page number.
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const textLayerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const renderedKeyRef = useRef(new Map<number, string>());
  const renderTasksRef = useRef(new Map<number, { cancel(): void }>());
  const stackRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pageStateRef = useRef(1);
  const restoredRef = useRef(false);
  const anchorReadyRef = useRef(false);

  // Restore persisted prefs.
  useEffect(() => {
    const z = localStorage.getItem('ctx_reader_zoom');
    if (z) {
      const parsed = parseFloat(z);
      if (parsed >= 0.5 && parsed <= 4) setZoom(parsed);
    }
    const t = localStorage.getItem('ctx_reader_theme') as Theme | null;
    if (t === 'parchment' || t === 'dark') setTheme(t);
    const f = localStorage.getItem('ctx_reader_fit');
    if (f === '0') setFitPage(false);
  }, []);
  useEffect(() => { localStorage.setItem('ctx_reader_zoom', String(zoom)); }, [zoom]);
  useEffect(() => { localStorage.setItem('ctx_reader_theme', theme); }, [theme]);
  useEffect(() => { localStorage.setItem('ctx_reader_fit', fitPage ? '1' : '0'); }, [fitPage]);
  useEffect(() => {
    // On a phone the thumbnail rail would swallow the page, so start closed
    // regardless of the saved desktop preference.
    if (isMobile) { setSidebarOpen(false); return; }
    const s = localStorage.getItem('ctx_reader_sidebar_open');
    if (s === '0') setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    localStorage.setItem('ctx_reader_sidebar_open', sidebarOpen ? '1' : '0');
  }, [sidebarOpen]);

  // Deep links (?page=N) are honored by the restore + follow effects in the
  // continuous-stack block below, once the stack can be measured.

  // Track OS fullscreen state so the toolbar button reflects reality even
  // when the user leaves fullscreen via Escape.
  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(document.fullscreenElement === rootRef.current);
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Re-fit the page whenever the content pane resizes — window resize,
  // sidebar toggle, or entering/leaving fullscreen.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (rootRef.current) {
      void rootRef.current.requestFullscreen();
      // Entering fullscreen is about reading one page at a time — fit it.
      setFitPage(true);
    }
  }, []);

  // Load metadata, download blob, branch by file kind.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoadState('loading');
    setErrorMsg(null);
    setDocHtml(null);
    pageTextCacheRef.current = [];
    setMatches([]);
    setMatchIdx(0);
    setThumbnails([]);
    setOutline(null);
    setAnnotations([]);
    setSelectionMenu(null);
    setPageDims(null);
    renderedKeyRef.current.clear();
    canvasRefs.current = [];
    textLayerRefs.current = [];
    restoredRef.current = false;
    anchorReadyRef.current = false;

    void (async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('id, title, storage_path, source_filename, page_count, cover_url, matterspace_id')
        .eq('id', id)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setErrorMsg(error?.message || "Document not found, or you don't have access.");
        setLoadState('error');
        return;
      }
      if (!data.storage_path) {
        setErrorMsg('This document has no file attached.');
        setLoadState('error');
        return;
      }
      setDoc(data as DocMeta);

      const fn = (data.source_filename || data.storage_path).toLowerCase();
      const kind: FileKind =
        fn.endsWith('.pdf') ? 'pdf'
        : fn.endsWith('.docx') ? 'docx'
        : fn.endsWith('.fountain') ? 'fountain'
        : fn.endsWith('.pptx') ? 'pptx'
        : 'unsupported';
      setFileKind(kind);

      if (kind === 'unsupported') {
        setErrorMsg('Unsupported file type — the reader currently handles PDF, Word (.docx), PowerPoint (.pptx), and Fountain (.fountain).');
        setLoadState('error');
        return;
      }

      const { data: blob, error: dlErr } = await supabase.storage
        .from('vault-documents')
        .download(data.storage_path);
      if (cancelled) return;
      if (dlErr || !blob) {
        setErrorMsg(dlErr?.message || 'Failed to download the file.');
        setLoadState('error');
        return;
      }

      const arrayBuffer = await blob.arrayBuffer();
      if (cancelled) return;

      try {
        if (kind === 'pdf') {
          const pdfjsLib = await import('pdfjs-dist');
          pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
          const pdf = await pdfjsLib.getDocument({
            data: arrayBuffer,
            ...PDFJS_DOC_PARAMS,
          }).promise;
          if (cancelled) return;
          pdfDocRef.current = pdf;
          // Page 1's size stands in for every slot until the dims sweep
          // below reports the real per-page sizes.
          const firstPage = await pdf.getPage(1);
          const v1 = firstPage.getViewport({ scale: 1 });
          if (cancelled) return;
          setPageDims(new Array(pdf.numPages).fill({ w: v1.width, h: v1.height }));
          setTotalPages(pdf.numPages);

          const savedPage = localStorage.getItem(`ctx_reader_page_${id}`);
          const start = savedPage ? parseInt(savedPage, 10) : 1;
          setPage(start >= 1 && start <= pdf.numPages ? start : 1);
        } else if (kind === 'fountain') {
          // Fountain — plain-text screenplay. Parse via fountain-js and let
          // the parser hand us back semantic HTML (h3 scene headings,
          // .dialogue divs, h4 character names, p action/dialogue) — our
          // CSS does the Courier / centred-name / indented-dialogue layout.
          const text = await blob.text();
          if (cancelled) return;
          const parsed = new Fountain().parse(text, true);
          setTitlePageHtml(parsed.html?.title_page ?? null);
          setDocHtml(parsed.html?.script ?? '');
          setTotalPages(1);
          setPage(1);
        } else if (kind === 'pptx') {
          // PPTX — one card per slide, single scrollable deck.
          const html = await pptxDeckHtml(arrayBuffer);
          if (cancelled) return;
          setDocHtml(html);
          setTotalPages(1);
          setPage(1);
        } else {
          // DOCX — convert to HTML once. Word has no page concept, so we
          // treat it as a single scrollable document.
          const result = await mammoth.convertToHtml({ arrayBuffer });
          if (cancelled) return;
          setDocHtml(result.value);
          setTotalPages(1);
          setPage(1);
        }
        setLoadState('ready');
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to open the document.');
        setLoadState('error');
      }
    })();

    return () => { cancelled = true; };
  }, [id]);

  // ── The continuous page stack ───────────────────────────────────────
  // Every page owns a fixed-height slot in one scrollable column, so the
  // pane's native scrollbar spans the whole document: drag the thumb to
  // cross a hundred pages, roll the wheel to move a line. Only the slots
  // near the viewport are painted; the rest stay white paper with a faint
  // page number until scrolled into reach. Before this, the reader drew
  // one page at a time — in fit mode nothing could scroll at all, and
  // zoomed in the native bar spanned just the one page, which is why long
  // cases could be scrolled finely but never quickly, and short pleadings
  // quickly but never finely.

  // One uniform scale for the stack. Fit mode sizes a page to the pane as
  // the single-page reader did (a screenful ≈ a page, for citation work);
  // zoom mode uses the chosen zoom. Page 1 stands in for the document's
  // page size — filings are uniform, and odd-sized exhibits correct once
  // the dims sweep reports in.
  const renderedScale = useMemo(() => {
    if (fileKind !== 'pdf' || !fitPage) return zoom;
    const pane = contentRef.current;
    const d = pageDims?.[0];
    if (!pane || !d || pane.clientWidth <= 0 || pane.clientHeight <= 0) return zoom;
    const PAD = 24; // breathing room around the page
    // The margin rails flank each page in-flow; subtract them so the page
    // never overflows horizontally.
    const rails = 2 * (isMobile ? NOTE_RAIL_W_MOBILE : NOTE_RAIL_W);
    const fit = Math.min(
      (pane.clientWidth - PAD * 2 - rails) / d.w,
      (pane.clientHeight - PAD * 2) / d.h,
    );
    return Math.max(0.1, Math.min(fit, 6));
    // containerTick re-measures the pane on resize / sidebar / fullscreen;
    // loadState re-measures once the pane exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKind, fitPage, zoom, pageDims, isMobile, containerTick, loadState]);

  // Top offset of every slot inside the scroll content — the map between
  // scrollTop and page numbers, used by jumps and by scroll derivation.
  const slotTops = useMemo(() => {
    if (!pageDims) return null;
    const tops: number[] = [];
    let y = 24; // the stack container's top padding (py-6)
    for (const d of pageDims) {
      tops.push(y);
      y += d.h * renderedScale + PAGE_GAP;
    }
    return tops;
  }, [pageDims, renderedScale]);
  const slotTopsRef = useRef<number[] | null>(null);
  useEffect(() => { slotTopsRef.current = slotTops; }, [slotTops]);
  useEffect(() => { pageStateRef.current = page; }, [page]);

  // Every control that names a page — rail, slider, thumbnails, outline,
  // search, deep links, arrow keys — lands here: set the indicator and
  // scroll the stack. Hand-scrolling flows the other way (scroll → page)
  // and never scrolls back, so the two directions cannot fight.
  const gotoPage = useCallback((p: number) => {
    const clamped = Math.max(1, Math.min(totalPages || 1, p));
    setPage(clamped);
    const tops = slotTopsRef.current;
    const el = contentRef.current;
    if (tops && el) el.scrollTo({ top: Math.max(0, tops[clamped - 1] - 8) });
  }, [totalPages]);

  // Derive the current page while the user scrolls: the page whose band
  // holds the point 40% down the viewport.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || loadState !== 'ready' || fileKind !== 'pdf') return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const tops = slotTopsRef.current;
        if (!tops || tops.length === 0) return;
        const probe = el.scrollTop + el.clientHeight * 0.4;
        let p = tops.length;
        for (let i = 0; i < tops.length; i++) {
          if (tops[i] > probe) { p = i; break; }
        }
        p = Math.max(1, p);
        if (p !== pageStateRef.current) setPage(p);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [loadState, fileKind]);

  // Restore the last-read page — or honor a ?page= deep link (the in-app
  // assistant opens documents to a cited page) — once the stack can be
  // measured, exactly once per document.
  useEffect(() => {
    if (restoredRef.current || !slotTops || loadState !== 'ready' || fileKind !== 'pdf') return;
    restoredRef.current = true;
    const linked = parseInt(searchParams.get('page') ?? '', 10);
    const saved = parseInt(localStorage.getItem(`ctx_reader_page_${id}`) ?? '', 10);
    const target = Number.isFinite(linked) && linked >= 1 ? linked
      : Number.isFinite(saved) && saved >= 1 ? saved
      : 1;
    if (target > 1) gotoPage(target);
  }, [slotTops, loadState, fileKind, id, searchParams, gotoPage]);

  // Follow later deep links on the SAME mounted document (query-only
  // change, no remount).
  useEffect(() => {
    if (!restoredRef.current) return; // the restore effect takes the first
    const p = parseInt(searchParams.get('page') ?? '', 10);
    if (Number.isFinite(p) && p >= 1 && totalPages > 0) gotoPage(p);
  }, [searchParams, totalPages, gotoPage]);

  // When the geometry changes under the reader — zoom, fit toggle, pane
  // resize, or the dims sweep correcting slot heights — re-anchor to the
  // page being read instead of drifting to wherever the old offsets land.
  useEffect(() => {
    if (!slotTops || loadState !== 'ready' || fileKind !== 'pdf') return;
    if (!restoredRef.current) return;
    if (!anchorReadyRef.current) { anchorReadyRef.current = true; return; }
    const el = contentRef.current;
    if (el) el.scrollTo({ top: Math.max(0, slotTops[pageStateRef.current - 1] - 8) });
  }, [slotTops, loadState, fileKind]);

  // Remember where the reader stands, for next time this document opens.
  useEffect(() => {
    if (loadState === 'ready' && fileKind === 'pdf' && id && page >= 1) {
      localStorage.setItem(`ctx_reader_page_${id}`, String(page));
    }
  }, [page, id, loadState, fileKind]);

  // The dims sweep: real per-page sizes, replacing the page-1 stand-in.
  // Cheap relative to the thumbnail strip, which renders every page.
  useEffect(() => {
    if (loadState !== 'ready' || fileKind !== 'pdf') return;
    const pdf = pdfDocRef.current as {
      numPages: number;
      getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number } }>;
    } | null;
    if (!pdf) return;
    let cancelled = false;
    void (async () => {
      const dims: { w: number; h: number }[] = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        try {
          const v = (await pdf.getPage(p)).getViewport({ scale: 1 });
          dims.push({ w: v.width, h: v.height });
        } catch {
          dims.push({ w: 612, h: 792 });
        }
        if (cancelled) return;
      }
      setPageDims((prev) => {
        if (!prev || prev.length !== dims.length) return dims;
        const changed = dims.some(
          (d, i) => Math.abs(d.h - prev[i].h) > 0.5 || Math.abs(d.w - prev[i].w) > 0.5,
        );
        return changed ? dims : prev;
      });
    })();
    return () => { cancelled = true; };
  }, [loadState, fileKind, id]);

  // Paint the slots near the viewport; free the ones left far behind so a
  // long case never holds hundreds of live canvases. A page repaints only
  // when its render key (scale, highlight state) changes.
  useEffect(() => {
    if (loadState !== 'ready' || fileKind !== 'pdf' || !pageDims) return;
    const pdf = pdfDocRef.current as {
      getPage(n: number): Promise<{
        getViewport(opts: { scale: number }): { width: number; height: number };
        render(opts: unknown): { promise: Promise<void>; cancel(): void };
        streamTextContent(): ReadableStream;
      }>;
    } | null;
    if (!pdf) return;

    let cancelled = false;
    const from = Math.max(1, page - 2);
    const to = Math.min(totalPages, page + 2);

    for (const [p] of Array.from(renderedKeyRef.current)) {
      if (p >= from - 3 && p <= to + 3) continue;
      try { renderTasksRef.current.get(p)?.cancel(); } catch { /* settled */ }
      renderTasksRef.current.delete(p);
      const canvas = canvasRefs.current[p - 1];
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.style.width = '0px';
        canvas.style.height = '0px';
      }
      const layer = textLayerRefs.current[p - 1];
      if (layer) layer.innerHTML = '';
      renderedKeyRef.current.delete(p);
    }

    const highlightFor = (p: number) =>
      searchQuery && matches.some((m) => m.page === p) ? searchQuery : '';

    const renderPage = async (p: number, key: string) => {
      const canvas = canvasRefs.current[p - 1];
      const layerEl = textLayerRefs.current[p - 1];
      if (!canvas || !layerEl) return;
      // pdfjs refuses two renders on one canvas ("Cannot use the same
      // canvas during multiple render operations") — cancel this slot's
      // in-flight work before starting over.
      try { renderTasksRef.current.get(p)?.cancel(); } catch { /* settled */ }
      renderTasksRef.current.delete(p);
      try {
        const pdfPage = await pdf.getPage(p);
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale: renderedScale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // PACER-style rendering: leave the document's own colors alone —
        // true white pages, true black ink, faithful images for scans —
        // and let the surrounding frame do the dark-mode work. Recoloring
        // via pdfjs pageColors made scanned exhibits black-on-black.
        const task = pdfPage.render({ canvasContext: ctx, viewport });
        renderTasksRef.current.set(p, task);
        await task.promise;
        if (cancelled) return;
        renderTasksRef.current.delete(p);

        layerEl.innerHTML = '';
        // pdfjs's TextLayer sizes spans off viewer-supplied CSS variables;
        // without them every span falls back to 16px and selection drifts
        // inches off the canvas.
        layerEl.style.setProperty('--scale-factor', String(renderedScale));
        layerEl.style.setProperty('--total-scale-factor', String(renderedScale));
        const pdfjsLib = await import('pdfjs-dist');
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: pdfPage.streamTextContent(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          viewport: viewport as any,
          container: layerEl,
        });
        renderTasksRef.current.set(p, textLayer);
        await textLayer.render();
        if (cancelled) return;
        renderTasksRef.current.delete(p);
        const hl = highlightFor(p);
        if (hl) highlightTextLayerMatches(layerEl, hl);
        renderedKeyRef.current.set(p, key);
      } catch {
        // Cancellation or a render race; a later pass repaints the slot.
        renderTasksRef.current.delete(p);
      }
    };

    for (let p = from; p <= to; p++) {
      const key = `${renderedScale.toFixed(4)}|${highlightFor(p)}`;
      if (renderedKeyRef.current.get(p) === key) continue;
      renderedKeyRef.current.delete(p);
      void renderPage(p, key);
    }

    return () => { cancelled = true; };
  }, [page, totalPages, renderedScale, loadState, fileKind, id, pageDims, searchQuery, matches]);

  // On unmount, stop whatever pdfjs still has in flight.
  useEffect(() => () => {
    for (const t of renderTasksRef.current.values()) {
      try { t.cancel(); } catch { /* settled */ }
    }
    renderTasksRef.current.clear();
  }, []);

  const goPrev = useCallback(() => gotoPage(pageStateRef.current - 1), [gotoPage]);
  const goNext = useCallback(() => gotoPage(pageStateRef.current + 1), [gotoPage]);

  // ── Clean copy ──────────────────────────────────────────────────────
  // The whole document onto the clipboard as it should paste into Word:
  // a PDF's text reflowed into flowing paragraphs, a .docx as its own
  // semantic HTML (its real bold and italics travel), slides and scripts
  // as plain text. Selection copy over the PDF text layer is intercepted
  // in the content pane below for the same reason — the painted layer's
  // styling is not the document's.
  const [copyState, setCopyState] = useState<'idle' | 'busy' | 'done'>('idle');
  const handleCopyText = useCallback(async () => {
    if (copyState !== 'idle' || loadState !== 'ready') return;
    setCopyState('busy');
    try {
      let text = '';
      let html = '';
      if (fileKind === 'pdf' && pdfDocRef.current) {
        text = await pdfDocumentText(
          pdfDocRef.current as Parameters<typeof pdfDocumentText>[0],
        );
        html = reflowedHtml(text);
      } else if (docHtml) {
        const full = (titlePageHtml ?? '') + docHtml;
        text = htmlPlainText(full);
        html = fileKind === 'docx' ? full : selectionHtml(text);
      }
      if (!text) {
        setCopyState('idle');
        return;
      }
      await writeClipboard(text, html);
      setCopyState('done');
      window.setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('idle');
    }
  }, [copyState, loadState, fileKind, docHtml, titlePageHtml]);

  // ── Print ───────────────────────────────────────────────────────────
  // A PDF prints as itself: the original file into a hidden same-origin
  // iframe, whose viewer takes the print dialog. Rendered documents
  // (docx, slides, scripts) print the page through the print stylesheet,
  // which shows only the document.
  const [printing, setPrinting] = useState(false);
  const handlePrint = useCallback(async () => {
    if (printing || loadState !== 'ready') return;
    if (fileKind !== 'pdf') {
      window.print();
      return;
    }
    if (!doc?.storage_path) return;
    setPrinting(true);
    try {
      const { data: blob, error } = await supabase.storage
        .from('vault-documents')
        .download(doc.storage_path);
      if (error || !blob) {
        setErrorMsg(error?.message || 'The file could not be fetched to print.');
        return;
      }
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
      const frame = document.createElement('iframe');
      frame.style.position = 'fixed';
      frame.style.right = '0';
      frame.style.bottom = '0';
      frame.style.width = '0';
      frame.style.height = '0';
      frame.style.border = '0';
      frame.src = url;
      frame.onload = () => {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      };
      document.body.appendChild(frame);
      // The frame outlives the dialog; a minute is plenty, and the blob URL
      // dies with it.
      window.setTimeout(() => {
        frame.remove();
        URL.revokeObjectURL(url);
      }, 60000);
    } finally {
      setPrinting(false);
    }
  }, [printing, loadState, fileKind, doc]);

  // ── The reader's own right-click menu ───────────────────────────────
  // The browser's context menu over a privileged document offers the
  // document to the browser — "Ask Gemini" included. Ours offers the
  // reader's own verbs instead; content leaves Contextspaces only through
  // a connection the user chose.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const openContextMenu = useCallback((e: React.MouseEvent) => {
    if (loadState !== 'ready') return; // an empty pane can keep the browser's menu
    e.preventDefault();
    const sel = window.getSelection();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      hasSelection: !!sel && !sel.isCollapsed && sel.toString().trim().length > 0,
    });
  }, [loadState]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  const copySelection = useCallback(async () => {
    const sel = window.getSelection();
    const text = sel?.toString() ?? '';
    if (!text.trim()) return;
    await writeClipboard(text, selectionHtml(text));
  }, []);

  // Cover support — mirrors how Pages/Lists/Tables use CoverImage.
  // Expanded mode promotes the cover to the page background via a CSS var,
  // so we don't need to do anything beyond passing through the controlled
  // expansion state.
  const [coverExpanded, setCoverExpanded] = useCoverExpanded(id);
  const handleCoverChange = useCallback(async (next: string | null) => {
    if (!id) return;
    setDoc((cur) => (cur ? { ...cur, cover_url: next } : cur));
    const { error } = await supabase
      .from('documents')
      .update({ cover_url: next })
      .eq('id', id);
    if (error) {
      console.error('cover save failed', error);
    }
  }, [id]);

  // Google Drive export — visible only when the user has a google_drive
  // connection. Clicking POSTs to /api/drive-export, which fetches the
  // blob server-side and pushes to the user's Drive (in a Contextspaces
  // folder).
  const { data: connections = [] } = useConnections();
  const hasDriveConnection = connections.some(
    (c) => c.kind === 'google_drive' && c.status === 'connected',
  );
  const [driveExporting, setDriveExporting] = useState(false);
  const [driveBanner, setDriveBanner] = useState<
    { kind: 'ok'; text: string; link: string | null }
    | { kind: 'err'; text: string }
    | null
  >(null);
  const handleDriveExport = useCallback(async () => {
    if (!id || !doc?.storage_path || driveExporting) return;
    setDriveExporting(true);
    setDriveBanner(null);
    try {
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) throw new Error('Not signed in');
      const resp = await fetch('/api/drive-export', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ documentId: id, folderName: 'Contextspaces' }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok || !body.ok) {
        // Google's API returns details under body.detail.error.message — surface
        // that string when we have it so we don't show the bare code.
        const googleMsg = body?.detail?.error?.message
          || body?.detail?.error_description
          || (typeof body?.detail === 'string' ? body.detail : null);
        const msg =
          body.error === 'drive_needs_reconnect' ? 'Reconnect Google Drive — your token expired.'
          : body.error === 'drive_not_connected' ? 'Connect Google Drive in Connections first.'
          : body.error === 'file_too_large' ? 'File is too large for Drive export (75 MB cap).'
          : googleMsg ? `Drive: ${googleMsg}`
          : body.error || 'Drive export failed.';
        // Always log the full response — the banner is for the user, the
        // console is for us to debug from a screenshot.
        console.error('drive-export failed:', body);
        setDriveBanner({ kind: 'err', text: msg });
        return;
      }
      setDriveBanner({
        kind: 'ok',
        text: `Saved to your Google Drive${body.folderName ? ` › ${body.folderName}` : ''}.`,
        link: body.webViewLink ?? null,
      });
    } catch (e) {
      setDriveBanner({ kind: 'err', text: e instanceof Error ? e.message : 'Drive export failed.' });
    } finally {
      setDriveExporting(false);
    }
  }, [id, doc, driveExporting]);

  const [downloading, setDownloading] = useState(false);
  const handleDownload = useCallback(async () => {
    if (!doc?.storage_path || downloading) return;
    setDownloading(true);
    try {
      const { data: blob, error } = await supabase.storage
        .from('vault-documents')
        .download(doc.storage_path);
      if (error || !blob) {
        setErrorMsg(error?.message || 'Failed to download the file.');
        return;
      }
      const ext = fileKind === 'pdf' ? '.pdf' : fileKind === 'pptx' ? '.pptx' : '.docx';
      const fallback = (doc.title || 'document').replace(/[\\/:*?"<>|]+/g, '_') + ext;
      const filename = doc.source_filename || fallback;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setDownloading(false);
    }
  }, [doc, fileKind, downloading]);

  // Fetch the PDF's outline (table of contents) once it loads. Many PDFs
  // don't have one — that's fine, we just hide the Contents tab.
  useEffect(() => {
    if (loadState !== 'ready' || fileKind !== 'pdf') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdf = pdfDocRef.current as any;
    if (!pdf) return;
    let cancelled = false;
    void (async () => {
      try {
        const o = await pdf.getOutline();
        if (!cancelled) setOutline(o || null);
      } catch {
        if (!cancelled) setOutline(null);
      }
    })();
    return () => { cancelled = true; };
  }, [loadState, fileKind, id]);

  // Render the thumbnail strip sequentially. Each page rendered to an
  // offscreen canvas at low scale, captured as a data URL, and added to
  // the thumbnails state so the sidebar can show it.
  useEffect(() => {
    if (loadState !== 'ready' || fileKind !== 'pdf') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdf = pdfDocRef.current as any;
    if (!pdf) return;
    const N: number = pdf.numPages;
    setThumbnails(new Array(N).fill(null));

    let cancelled = false;
    void (async () => {
      for (let p = 1; p <= N; p++) {
        if (cancelled) return;
        try {
          const pdfPage = await pdf.getPage(p);
          const viewport = pdfPage.getViewport({ scale: 0.18 });
          const off = document.createElement('canvas');
          off.width = viewport.width;
          off.height = viewport.height;
          const ctx = off.getContext('2d');
          if (!ctx) continue;
          await pdfPage.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          const dataUrl = off.toDataURL('image/png');
          setThumbnails((prev) => {
            const next = prev.slice();
            next[p - 1] = dataUrl;
            return next;
          });
        } catch {
          // Skip this thumbnail; sidebar will show "Rendering…" until eventually rerendered.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [loadState, fileKind, id]);

  // Load annotations + incoming cross-references once per document, and
  // keep them live: margin notes are collaborative, so a teammate's note
  // should appear without a reload (the matter_comments realtime pattern;
  // RLS filters what each subscriber may see).
  useEffect(() => {
    if (!id || loadState !== 'ready' || fileKind !== 'pdf') return;
    let cancelled = false;
    const refresh = async () => {
      const [rows, incoming] = await Promise.all([
        listAnnotations(id),
        listIncomingLinks(id),
      ]);
      if (!cancelled) {
        setAnnotations(rows);
        setIncomingLinks(incoming);
      }
    };
    void refresh();
    const channel = supabase
      .channel(`doc-annotations-${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'document_annotations', filter: `document_id=eq.${id}` },
        () => { void refresh(); },
      )
      .subscribe();
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [id, loadState, fileKind]);

  // Watch text-layer selections — when the user releases the mouse after
  // selecting text inside the current page, capture the rectangles in
  // page-fractional coordinates so we can persist a highlight that scales
  // cleanly to any zoom level.
  useEffect(() => {
    if (loadState !== 'ready' || fileKind !== 'pdf') return;

    function captureSelection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setSelectionMenu(null);
        return;
      }

      // Only act on selections that actually touch a page's text layer,
      // and remember WHICH page — annotations anchor to a page number.
      //
      // Testing sel.anchorNode alone was wrong, and silently broke both
      // highlighting and margin notes: a drag that begins a few pixels off a
      // glyph — i.e. almost every real drag — anchors in whichever sibling
      // element sits under the cursor at mousedown, usually the annotations
      // overlay (`absolute inset-0`, same box as the text layer), and only
      // *ends* inside the text layer. Range.intersectsNode covers every
      // direction the user can drag, including selections that start above
      // the page and end below it.
      if (sel.rangeCount === 0) {
        setSelectionMenu(null);
        return;
      }
      const range = sel.getRangeAt(0);
      let layer: HTMLDivElement | null = null;
      let layerPage = 0;
      for (let i = 0; i < textLayerRefs.current.length; i++) {
        const el = textLayerRefs.current[i];
        if (!el || el.childNodes.length === 0) continue;
        if (
          el.contains(sel.anchorNode) ||
          el.contains(sel.focusNode) ||
          range.intersectsNode(el)
        ) {
          layer = el;
          layerPage = i + 1;
          break;
        }
      }
      if (!layer) {
        setSelectionMenu(null);
        return;
      }

      const layerRect = layer.getBoundingClientRect();
      // A drag that crosses into the next page still anchors to the first
      // page it touched; keep only the rectangles on that page.
      const clientRects = Array.from(range.getClientRects()).filter(
        (r) =>
          r.width > 0 && r.height > 0 &&
          r.bottom > layerRect.top - 1 && r.top < layerRect.bottom + 1,
      );
      if (clientRects.length === 0) {
        setSelectionMenu(null);
        return;
      }

      const fractRects: FractionalRect[] = clientRects.map((r) => ({
        x: (r.left - layerRect.left) / layerRect.width,
        y: (r.top - layerRect.top) / layerRect.height,
        w: r.width / layerRect.width,
        h: r.height / layerRect.height,
      }));

      const union = range.getBoundingClientRect();
      setSelectionMenu({
        x: union.left + union.width / 2,
        y: union.top - 8,
        page: layerPage,
        rects: fractRects,
        anchorText: sel.toString().trim().slice(0, 1000),
      });
    }

    // Double-click that lands in a gap: snap to the nearest word.
    //
    // On scanned exhibits the OCR text layer is sparse and its spans often
    // overlap, so a double-click aimed at a word frequently falls between
    // spans. The browser then "selects" an empty line break — a live
    // selection with no visible rectangles — and captureSelection correctly
    // declines it, which reads to the user as a dead double-click on a word
    // they can plainly see. Rather than loosen the rect test (an empty
    // selection must never open the popover), find the nearest span and
    // select the word within it closest to the click.
    //
    // Deliberately double-click only: snapping a single click would select a
    // word every time the user clicked anywhere on the page, and clicking
    // empty space has to stay a way to dismiss.
    function handleDoubleClick(e: MouseEvent) {
      let layer: HTMLDivElement | null = null;
      for (const el of textLayerRefs.current) {
        if (!el || el.childNodes.length === 0) continue;
        const box = el.getBoundingClientRect();
        if (
          e.clientX >= box.left && e.clientX <= box.right &&
          e.clientY >= box.top && e.clientY <= box.bottom
        ) {
          layer = el;
          break;
        }
      }
      if (!layer) return;

      // If the double-click already produced something selectable, the
      // mouseup handler has it — don't second-guess the browser.
      const sel = window.getSelection();
      const alreadyUsable =
        sel != null &&
        sel.rangeCount > 0 &&
        Array.from(sel.getRangeAt(0).getClientRects()).some(
          (r) => r.width > 0 && r.height > 0,
        );
      if (alreadyUsable) return;

      if (selectWordNearPoint(layer, e.clientX, e.clientY)) captureSelection();
    }

    document.addEventListener('mouseup', captureSelection);
    document.addEventListener('dblclick', handleDoubleClick);
    return () => {
      document.removeEventListener('mouseup', captureSelection);
      document.removeEventListener('dblclick', handleDoubleClick);
    };
  }, [loadState, fileKind]);

  const saveAnnotation = useCallback(
    async (color: AnnotationColor) => {
      if (!id || !selectionMenu) return;
      const ann = await createAnnotation({
        documentId: id,
        page: selectionMenu.page,
        color,
        rects: selectionMenu.rects,
        anchorText: selectionMenu.anchorText,
      });
      if (ann) {
        setAnnotations((prev) => [...prev, ann]);
      }
      // Clear selection + popover regardless of success.
      window.getSelection()?.removeAllRanges();
      setSelectionMenu(null);
    },
    [id, selectionMenu],
  );

  const removeAnnotation = useCallback(async (annId: string) => {
    const ok = await deleteAnnotation(annId);
    if (ok) {
      setAnnotations((prev) => prev.filter((a) => a.id !== annId));
    }
  }, []);

  // Rename — the document title in the toolbar is editable in place, with
  // the pencil making it visible (the matter-heading idiom). The empty
  // element gets its text imperatively so React never fights the caret.
  const docTitleRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = docTitleRef.current;
    if (el && document.activeElement !== el) el.textContent = doc?.title ?? '';
  }, [doc?.title, loadState]);
  const handleTitleBlur = useCallback(async () => {
    const el = docTitleRef.current;
    if (!el || !id || !doc) return;
    const prev = doc.title || '';
    const next = (el.textContent ?? '').trim();
    if (!next || next === prev) {
      el.textContent = prev;
      return;
    }
    setDoc((cur) => (cur ? { ...cur, title: next } : cur));
    const { error } = await supabase.from('documents').update({ title: next }).eq('id', id);
    if (error) {
      console.error('document rename failed', error);
      setDoc((cur) => (cur ? { ...cur, title: prev } : cur));
      if (docTitleRef.current) docTitleRef.current.textContent = prev;
    }
  }, [id, doc]);
  const startDocRename = useCallback(() => {
    const el = docTitleRef.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);

  // Stable handlers for the memoized page slots — the stack re-renders on
  // every derived-page change while scrolling, and these keep the hundreds
  // of untouched slots from re-rendering with it.
  const openNoteAt = useCallback((n: Annotation, a: { x: number; y: number }) => {
    setOpenNote({ id: n.id, x: a.x, y: a.y });
  }, []);
  const openRefAt = useCallback((link: IncomingLink, a: { x: number; y: number }) => {
    setOpenRef({ link, x: a.x, y: a.y });
  }, []);
  const removeAnnotationCb = useCallback((annId: string) => {
    void removeAnnotation(annId);
  }, [removeAnnotation]);
  const setCanvasEl = useCallback((p: number, el: HTMLCanvasElement | null) => {
    canvasRefs.current[p - 1] = el;
  }, []);
  const setTextLayerEl = useCallback((p: number, el: HTMLDivElement | null) => {
    textLayerRefs.current[p - 1] = el;
  }, []);

  // Save a margin note: derive page:line deterministically from the ingested
  // passages (transcripts get real line numbers; everything else stays
  // page-only — the verbatim quote in anchor_text is the ground truth),
  // persist, then attach any document links.
  const saveNote = useCallback(
    async (args: { body: string; visibility: AnnotationVisibility; links: ComposerLink[] }) => {
      if (!id || !noteComposer) return;
      const derived = await derivePageLine(id, noteComposer.page, noteComposer.anchorText);
      const ann = await createAnnotation({
        documentId: id,
        page: noteComposer.page,
        color: 'gold',
        rects: noteComposer.rects,
        anchorText: noteComposer.anchorText,
        note: args.body,
        visibility: args.visibility,
        lineStart: derived?.lineStart ?? null,
        lineEnd: derived?.lineEnd ?? null,
      });
      if (ann) {
        const savedLinks: AnnotationLink[] = [];
        for (const l of args.links) {
          const link = await addAnnotationLink({
            annotationId: ann.id,
            targetDocumentId: l.documentId,
            targetPage: l.page,
            label: l.title,
          });
          if (link) savedLinks.push(link);
        }
        setAnnotations((prev) => [...prev, { ...ann, links: savedLinks }]);
      }
      setNoteComposer(null);
    },
    [id, noteComposer],
  );

  const editNote = useCallback(
    async (annId: string, body: string, visibility: AnnotationVisibility) => {
      const ok = await updateAnnotation(annId, { note: body, visibility });
      if (ok) {
        setAnnotations((prev) =>
          prev.map((a) => (a.id === annId ? { ...a, note: body, visibility } : a)),
        );
      }
    },
    [],
  );

  const jumpDest = useCallback(async (dest: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdf = pdfDocRef.current as any;
    if (!pdf || !dest) return;
    let destArr: unknown[] | null = null;
    if (typeof dest === 'string') {
      try { destArr = await pdf.getDestination(dest); } catch { return; }
    } else if (Array.isArray(dest)) {
      destArr = dest as unknown[];
    }
    if (!destArr) return;
    try {
      const pageIdx = await pdf.getPageIndex(destArr[0]);
      gotoPage(pageIdx + 1);
    } catch { /* dest resolution can fail on malformed PDFs */ }
  }, [gotoPage]);

  // Arrow-key navigation.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      if (
        tgt instanceof HTMLInputElement ||
        tgt instanceof HTMLTextAreaElement ||
        tgt?.isContentEditable
      ) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext, toggleFullscreen]);

  // ────────────────────────────────────────────────────────────────────
  // Search (PDF only). On submit, scan every page's text content for the
  // query (caching results per page), collect matches, navigate to the
  // first hit, and highlight matching tokens in the text layer.
  // ────────────────────────────────────────────────────────────────────
  const runSearch = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q || fileKind !== 'pdf') {
      setMatches([]);
      setMatchIdx(0);
      return;
    }
    const pdf = pdfDocRef.current as
      | { numPages: number; getPage(n: number): Promise<unknown> }
      | null;
    if (!pdf) return;

    setSearching(true);
    const needle = q.toLowerCase();
    const found: Match[] = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      let pageText = pageTextCacheRef.current[p - 1];
      if (!pageText) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pdfPage = (await pdf.getPage(p)) as any;
        const content = await pdfPage.getTextContent();
        pageText = (content.items as Array<{ str?: string }>)
          .map((i) => i.str || '')
          .join(' ');
        pageTextCacheRef.current[p - 1] = pageText;
      }
      const hay = pageText.toLowerCase();
      let i = 0;
      let at: number;
      while ((at = hay.indexOf(needle, i)) !== -1) {
        found.push({ page: p, index: at });
        i = at + needle.length;
      }
    }

    setMatches(found);
    setMatchIdx(0);
    setSearching(false);
    if (found.length > 0) gotoPage(found[0].page);
  }, [fileKind, gotoPage]);

  const goNextMatch = useCallback(() => {
    if (matches.length === 0) return;
    const next = (matchIdx + 1) % matches.length;
    setMatchIdx(next);
    gotoPage(matches[next].page);
  }, [matchIdx, matches, gotoPage]);
  const goPrevMatch = useCallback(() => {
    if (matches.length === 0) return;
    const next = (matchIdx - 1 + matches.length) % matches.length;
    setMatchIdx(next);
    gotoPage(matches[next].page);
  }, [matchIdx, matches, gotoPage]);

  // ────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────
  const rootBg = theme === 'dark' ? '#000000' : '#f3ecd9';
  const showBottomNav = loadState === 'ready' && fileKind === 'pdf' && totalPages > 0;

  return (
    <div
      ref={rootRef}
      className="flex flex-col h-full"
      style={{ backgroundColor: rootBg }}
    >
      <ReaderStyle theme={theme} />

      {/* Cover image — same component Pages/Lists/Tables use. When no cover
          is set, this is a discoverable "Add cover" bar (subtle until hover);
          when set, a 180px banner; when expanded, becomes the page background
          via CSS variable so the reader chrome stays in front. */}
      {loadState === 'ready' && !embedded && (
        <CoverImage
          coverUrl={doc?.cover_url ?? null}
          onCoverChange={handleCoverChange}
          editable={!!doc}
          expanded={coverExpanded}
          onExpandChange={setCoverExpanded}
          persistKey={id ? `cs.doc.cover.${id}` : undefined}
        />
      )}

      <div className="flex items-center justify-between gap-2 px-3 h-12 border-b border-[var(--color-border)] bg-[var(--color-surface)] backdrop-blur-md shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button
            onClick={() => {
              // In a canvas panel, closing means taking the card off the
              // canvas — there is no history to walk back through.
              if (embedded) { onClose?.(); return; }
              // In a fresh tab (opened from the Bucketizer or a shared link)
              // there is no history to go back to — land on the document's
              // matter instead of silently doing nothing.
              if (window.history.length > 1) navigate(-1);
              else if (doc?.matterspace_id) navigate(`/app/matterspace/${doc.matterspace_id}`);
              else navigate('/app');
            }}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
            title="Close"
          >
            <X size={15} />
          </button>
          {fileKind === 'pdf' && (
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 ${
                sidebarOpen ? 'text-[var(--color-primary)]' : 'text-white/70 hover:text-white'
              }`}
              title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar (pages, contents)'}
            >
              <PanelLeft size={15} />
            </button>
          )}
          <span
            ref={docTitleRef}
            contentEditable={!!doc}
            suppressContentEditableWarning
            spellCheck={false}
            onBlur={() => void handleTitleBlur()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); }
              if (e.key === 'Escape') {
                if (docTitleRef.current) docTitleRef.current.textContent = doc?.title ?? '';
                (e.target as HTMLElement).blur();
              }
            }}
            title="Click to rename this document"
            className="text-sm text-[var(--color-text-bright)] truncate outline-none rounded px-1 -mx-1 hover:bg-[rgba(255,255,255,0.04)] focus:bg-[rgba(255,255,255,0.08)] focus:overflow-visible focus:text-clip transition-colors empty:before:content-['Document'] empty:before:text-white/30"
          />
          {doc && (
            <button
              onClick={startDocRename}
              className="p-1 rounded-md text-white/35 hover:text-[#e8b84a] hover:bg-[rgba(255,255,255,0.06)] transition-colors shrink-0"
              title="Rename this document"
              aria-label="Rename this document"
            >
              <Pencil size={13} strokeWidth={1.75} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {fileKind === 'pdf' && (
            <>
              {searchOpen ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void runSearch(searchQuery);
                      else if (e.key === 'Escape') {
                        setSearchOpen(false);
                        setSearchQuery('');
                        setMatches([]);
                      }
                    }}
                    placeholder="Find in document…"
                    className="h-8 w-44 rounded-md bg-[var(--color-surface-raised)] border border-[var(--color-border)] px-2 text-xs text-[var(--color-text-bright)] placeholder:text-white/30 focus:outline-none focus:border-[var(--color-primary)]"
                  />
                  {matches.length > 0 ? (
                    <span className="text-[10px] text-white/55 tabular-nums px-1">
                      {matchIdx + 1}/{matches.length}
                    </span>
                  ) : searchQuery && !searching ? (
                    <span className="text-[10px] text-white/35 px-1">0</span>
                  ) : null}
                  <button
                    onClick={goPrevMatch}
                    disabled={matches.length === 0}
                    className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-30"
                    title="Previous match"
                  >
                    <ChevronLeft size={13} />
                  </button>
                  <button
                    onClick={goNextMatch}
                    disabled={matches.length === 0}
                    className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-30"
                    title="Next match"
                  >
                    <ChevronRight size={13} />
                  </button>
                  <button
                    onClick={() => {
                      setSearchOpen(false);
                      setSearchQuery('');
                      setMatches([]);
                    }}
                    className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
                    title="Close search"
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setSearchOpen(true)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
                  title="Find in document"
                >
                  <Search size={15} />
                </button>
              )}
              <div className="w-px h-5 bg-white/10 mx-1" />
            </>
          )}
          <button
            onClick={() => {
              const base = fitPage ? renderedScale : zoom;
              setFitPage(false);
              setZoom(Math.max(0.5, +(base - 0.25).toFixed(2)));
            }}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
            title="Zoom out"
          >
            <ZoomOut size={15} />
          </button>
          <span className="text-xs text-white/55 tabular-nums w-12 text-center">
            {fileKind === 'pdf' && fitPage ? 'Fit' : `${Math.round(zoom * 100)}%`}
          </span>
          <button
            onClick={() => {
              const base = fitPage ? renderedScale : zoom;
              setFitPage(false);
              setZoom(Math.min(4, +(base + 0.25).toFixed(2)));
            }}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
            title="Zoom in"
          >
            <ZoomIn size={15} />
          </button>
          {fileKind === 'pdf' && (
            <button
              onClick={() => setFitPage((v) => !v)}
              className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 ${
                fitPage ? 'text-[var(--color-primary)]' : 'text-white/70 hover:text-white'
              }`}
              title={fitPage ? 'Fit page is on — whole page visible' : 'Fit whole page to screen'}
            >
              <Scan size={15} />
            </button>
          )}
          <button
            onClick={toggleFullscreen}
            className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 ${
              isFullscreen ? 'text-[var(--color-primary)]' : 'text-white/70 hover:text-white'
            }`}
            title={isFullscreen ? 'Exit full screen (F)' : 'Full screen (F)'}
          >
            {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
          {!embedded && (
            <CoverModeToggle
              hasCover={!!doc?.cover_url}
              expanded={coverExpanded}
              onToggle={() => setCoverExpanded(!coverExpanded)}
            />
          )}
          {!embedded && (
            <CanvasPinToggle kind="document" id={id} title={doc?.title || 'Document'} />
          )}
          <div className="w-px h-5 bg-white/10 mx-1" />
          <button
            onClick={() => void handleCopyText()}
            disabled={copyState === 'busy' || loadState !== 'ready' || (fileKind !== 'pdf' && !docHtml)}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              copyState === 'done'
                ? 'Copied — paste into Word or anywhere'
                : copyState === 'busy'
                  ? 'Copying…'
                  : 'Copy the whole document as clean text'
            }
          >
            {copyState === 'done' ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <button
            onClick={() => void handlePrint()}
            disabled={printing || loadState !== 'ready'}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            title={printing ? 'Printing…' : 'Print the document'}
          >
            <Printer size={15} />
          </button>
          <button
            onClick={handleDownload}
            disabled={downloading || !doc?.storage_path}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            title={downloading ? 'Downloading…' : 'Download original file'}
          >
            <Download size={15} />
          </button>
          {hasDriveConnection && (
            <button
              onClick={handleDriveExport}
              disabled={driveExporting || !doc?.storage_path}
              className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
              title={driveExporting ? 'Saving to Drive…' : 'Save to Google Drive'}
            >
              <HardDrive size={15} />
            </button>
          )}
          <button
            onClick={() => setTheme((t) => (t === 'parchment' ? 'dark' : 'parchment'))}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
            title={theme === 'parchment' ? 'Dark mode' : 'Light mode'}
          >
            {theme === 'parchment' ? <Moon size={15} /> : <Sun size={15} />}
          </button>
        </div>
      </div>

      {driveBanner && (
        <div
          className={`flex items-center gap-2 px-3 py-2 text-xs border-b border-[var(--color-border)] ${
            driveBanner.kind === 'ok'
              ? 'bg-[#4ade80]/10 text-[#4ade80]'
              : 'bg-[#f87171]/10 text-[#f87171]'
          }`}
        >
          <span className="flex-1">{driveBanner.text}</span>
          {driveBanner.kind === 'ok' && driveBanner.link && (
            <a
              href={driveBanner.link}
              target="_blank"
              rel="noreferrer"
              className="underline hover:no-underline"
            >
              Open in Drive
            </a>
          )}
          <button
            onClick={() => setDriveBanner(null)}
            className="opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-row min-h-0">
        {sidebarOpen && fileKind === 'pdf' && loadState === 'ready' && (
          <ReaderSidebar
            totalPages={totalPages}
            currentPage={page}
            thumbnails={thumbnails}
            outline={outline}
            onJumpPage={(p) => gotoPage(p)}
            onJumpDest={(d) => void jumpDest(d)}
          />
        )}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="relative flex-1 min-h-0 flex" onContextMenu={openContextMenu}>
          <div
            ref={contentRef}
            className="reader-scroll flex-1 overflow-auto flex justify-center items-start py-6 px-4"
            style={{ backgroundColor: rootBg }}
            // A selection copied off the PDF text layer would otherwise carry
            // the layer's own paint — transformed spans, transparent ink,
            // search-highlight color — into Word. Hand the clipboard the text.
            onCopy={(e) => {
              if (fileKind === 'pdf') interceptStyledCopy(e, stackRef.current);
            }}
          >
            {loadState === 'loading' && (
              <p className="mt-10 text-[13px] text-white/50">Loading document…</p>
            )}
            {loadState === 'error' && (
              <p className="mt-10 text-[13px] text-red-400">{errorMsg}</p>
            )}
            {loadState === 'ready' && fileKind === 'pdf' && pageDims && (
              <div ref={stackRef} className="flex flex-col items-center">
                {pageDims.map((d, i) => (
                  <PageSlot
                    key={i + 1}
                    p={i + 1}
                    w={d.w * renderedScale}
                    h={d.h * renderedScale}
                    annotations={annotations}
                    incomingLinks={incomingLinks}
                    isMobile={isMobile}
                    currentUserId={user?.id ?? null}
                    setCanvasEl={setCanvasEl}
                    setTextLayerEl={setTextLayerEl}
                    onRemove={removeAnnotationCb}
                    onOpenNote={openNoteAt}
                    onOpenRef={openRefAt}
                  />
                ))}
              </div>
            )}
            {loadState === 'ready' && fileKind === 'docx' && docHtml && (
              <div
                className="docx-page print-root max-w-3xl w-full mx-auto shadow-2xl"
                style={{
                  backgroundColor: '#ffffff',
                  color: '#1a1810',
                  padding: isMobile ? '28px 20px' : '64px 80px',
                  fontSize: `${Math.round(16 * (zoom / 1.5))}px`,
                  lineHeight: 1.6,
                }}
              >
                <div dangerouslySetInnerHTML={{ __html: docHtml }} />
              </div>
            )}
            {loadState === 'ready' && fileKind === 'pptx' && docHtml && (
              <div
                className="pptx-deck print-root max-w-3xl w-full mx-auto"
                style={{ fontSize: `${Math.round(16 * (zoom / 1.5))}px` }}
                dangerouslySetInnerHTML={{ __html: docHtml }}
              />
            )}
            {loadState === 'ready' && fileKind === 'fountain' && (
              <div
                className="fountain-page print-root max-w-[8.5in] w-full mx-auto shadow-2xl"
                style={{
                  backgroundColor: '#fafaf6',
                  color: '#15130b',
                  padding: isMobile ? '32px 22px' : '72px 96px',
                  fontFamily: '"Courier Prime", "Courier New", Courier, monospace',
                  fontSize: `${Math.round(15 * (zoom / 1.5))}px`,
                  lineHeight: 1.4,
                }}
              >
                {titlePageHtml && (
                  <div
                    className="fountain-title-page"
                    dangerouslySetInnerHTML={{ __html: titlePageHtml }}
                  />
                )}
                {docHtml && (
                  <div
                    className="fountain-script"
                    dangerouslySetInnerHTML={{ __html: docHtml }}
                  />
                )}
              </div>
            )}
          </div>
          {fileKind === 'pdf' && loadState === 'ready' && totalPages > 1 && (
            <PageRail
              page={page}
              total={totalPages}
              theme={theme}
              onPage={gotoPage}
            />
          )}
          </div>

          {showBottomNav && (
            <div className="flex items-center justify-center gap-3 h-12 border-t border-[var(--color-border)] bg-[var(--color-surface)] backdrop-blur-md shrink-0">


          <button
            onClick={goPrev}
            disabled={page <= 1}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-30"
            title="Previous page"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-xs text-white/65 tabular-nums">
            {page} / {totalPages}
          </span>
          {totalPages > 1 && (
            <input
              type="range"
              min={1}
              max={totalPages}
              value={page}
              onChange={(e) => gotoPage(parseInt(e.target.value, 10))}
              className="w-56"
              aria-label="Page slider"
            />
          )}
          <button
            onClick={goNext}
            disabled={page >= totalPages}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-30"
            title="Next page"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
        </div>
      </div>
      {ctxMenu && (
        <ReaderMenu
          at={ctxMenu}
          hasSelection={ctxMenu.hasSelection}
          canDownload={!downloading && !!doc?.storage_path}
          canDrive={hasDriveConnection && !driveExporting && !!doc?.storage_path}
          printing={printing}
          onCopySel={() => void copySelection()}
          onCopyDoc={() => void handleCopyText()}
          onPrint={() => void handlePrint()}
          onDownload={() => void handleDownload()}
          onDrive={() => void handleDriveExport()}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {selectionMenu && (
        <SelectionMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          onPick={(c) => void saveAnnotation(c)}
          onNote={() => {
            setNoteComposer({
              x: selectionMenu.x,
              y: selectionMenu.y,
              page: selectionMenu.page,
              rects: selectionMenu.rects,
              anchorText: selectionMenu.anchorText,
            });
            window.getSelection()?.removeAllRanges();
            setSelectionMenu(null);
          }}
          onCancel={() => {
            window.getSelection()?.removeAllRanges();
            setSelectionMenu(null);
          }}
        />
      )}
      {noteComposer && id && (
        <NoteComposer
          anchor={{ x: noteComposer.x, y: noteComposer.y }}
          quote={noteComposer.anchorText}
          matterId={doc?.matterspace_id ?? null}
          currentDocumentId={id}
          isMobile={isMobile}
          onSave={(args) => void saveNote(args)}
          onCancel={() => setNoteComposer(null)}
        />
      )}
      {openNote && (() => {
        const ann = annotations.find((a) => a.id === openNote.id);
        if (!ann) return null;
        return (
          <NoteCard
            note={ann}
            anchor={{ x: openNote.x, y: openNote.y }}
            isMobile={isMobile}
            isAuthor={ann.user_id === user?.id}
            onClose={() => setOpenNote(null)}
            onDelete={() => {
              void removeAnnotation(ann.id);
              setOpenNote(null);
            }}
            onSaveEdit={(body, visibility) => void editNote(ann.id, body, visibility)}
            onOpenLink={(l) =>
              navigate(
                `/app/document/${l.target_document_id}${l.target_page ? `?page=${l.target_page}` : ''}`,
              )
            }
          />
        );
      })()}
      {openRef && (
        <RefCard
          refLink={openRef.link}
          anchor={{ x: openRef.x, y: openRef.y }}
          isMobile={isMobile}
          onClose={() => setOpenRef(null)}
          onOpenSource={() => {
            const a = openRef.link.annotation;
            if (a) navigate(`/app/document/${a.document_id}?page=${a.page}`);
            setOpenRef(null);
          }}
        />
      )}
    </div>
  );
}

// Distance from a point to a rectangle; 0 when the point is inside it.
function distanceToRect(x: number, y: number, r: DOMRect): number {
  const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
  const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
  return Math.hypot(dx, dy);
}

// Select the word nearest (x, y) in the text layer, and report whether one
// was found. Used to rescue double-clicks that land between the sparse,
// overlapping spans of an OCR'd page.
//
// The search radius is derived from the matched span's own height rather
// than being a fixed pixel count, so it scales with zoom and with the
// document's type size: a word roughly a line-and-a-half away is fair game,
// anything further is treated as a click on blank paper.
function selectWordNearPoint(layer: HTMLElement, x: number, y: number): boolean {
  let bestNode: Text | null = null;
  let bestDist = Infinity;
  let bestHeight = 0;

  for (const span of layer.querySelectorAll('span')) {
    const node = span.firstChild;
    // Leaf spans only — pdfjs wraps marked content in spans of spans, and
    // emits <br> for line breaks.
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const text = (node as Text).data;
    if (!/\S/.test(text)) continue;
    const rect = span.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const dist = distanceToRect(x, y, rect);
    if (dist < bestDist) {
      bestDist = dist;
      bestNode = node as Text;
      bestHeight = rect.height;
    }
  }

  if (!bestNode || bestDist > Math.max(12, bestHeight * 1.5)) return false;

  // A pdfjs span can hold a whole run of text, so pick the word inside it
  // closest to the click rather than selecting the entire run.
  const text = bestNode.data;
  const range = document.createRange();
  let start = -1;
  let end = -1;
  let wordDist = Infinity;
  for (const m of text.matchAll(/\S+/g)) {
    const s = m.index;
    const e = s + m[0].length;
    range.setStart(bestNode, s);
    range.setEnd(bestNode, e);
    const d = distanceToRect(x, y, range.getBoundingClientRect());
    if (d < wordDist) {
      wordDist = d;
      start = s;
      end = e;
    }
  }
  if (start < 0) return false;

  range.setStart(bestNode, start);
  range.setEnd(bestNode, end);
  const sel = window.getSelection();
  if (!sel) return false;
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

// Walk the rendered text-layer spans on the current page and tint any span
// whose content contains the query. Lightweight v1; doesn't isolate the
// *specific* match instance within a span, just the spans that contain at
// least one occurrence.
function highlightTextLayerMatches(container: HTMLElement, query: string) {
  if (!query) return;
  const q = query.toLowerCase();
  const spans = container.querySelectorAll<HTMLElement>('span');
  spans.forEach((span) => {
    if (span.textContent?.toLowerCase().includes(q)) {
      span.style.backgroundColor = 'rgba(255, 234, 160, 0.55)';
      span.style.color = 'inherit';
    }
  });
}

// One page's slot in the continuous stack: margin rails flanking a
// fixed-size page box holding the canvas, the annotation overlay, and the
// text layer. The box keeps its full size whether or not the page is
// painted — the stack's scroll geometry must never depend on what happens
// to be rendered — and an unpainted slot reads as white paper with a faint
// page number. Memoized because the stack re-renders on every derived-page
// change while scrolling; without this, a 600-page record rebuilds 600
// slots per page crossed.
const PageSlot = memo(function PageSlot({
  p,
  w,
  h,
  annotations,
  incomingLinks,
  isMobile,
  currentUserId,
  setCanvasEl,
  setTextLayerEl,
  onRemove,
  onOpenNote,
  onOpenRef,
}: {
  p: number;
  w: number;
  h: number;
  annotations: Annotation[];
  incomingLinks: IncomingLink[];
  isMobile: boolean;
  currentUserId: string | null;
  setCanvasEl: (p: number, el: HTMLCanvasElement | null) => void;
  setTextLayerEl: (p: number, el: HTMLDivElement | null) => void;
  onRemove: (id: string) => void;
  onOpenNote: (n: Annotation, a: { x: number; y: number }) => void;
  onOpenRef: (link: IncomingLink, a: { x: number; y: number }) => void;
}) {
  return (
    <div className="flex flex-row items-stretch" style={{ marginBottom: PAGE_GAP }}>
      <CrossRefRail
        refs={incomingLinks.filter((r) => r.target_page === p)}
        isMobile={isMobile}
        onOpen={onOpenRef}
      />
      <div
        className="relative shadow-2xl"
        style={{ width: w, height: h, backgroundColor: '#ffffff' }}
      >
        <div className="absolute inset-0 flex items-center justify-center text-[13px] text-black/25 select-none">
          {p}
        </div>
        <canvas
          ref={(el) => setCanvasEl(p, el)}
          width={0}
          height={0}
          className="absolute left-0 top-0 block"
        />
        <AnnotationsOverlay
          annotations={annotations.filter((a) => a.page === p)}
          onRemove={onRemove}
        />
        <div
          ref={(el) => setTextLayerEl(p, el)}
          className="textLayer absolute inset-0"
        />
      </div>
      <NotesRail
        notes={annotations.filter((a) => a.page === p && annotationIsNote(a))}
        currentUserId={currentUserId}
        isMobile={isMobile}
        onOpen={onOpenNote}
      />
    </div>
  );
});

// Inline colored boxes for each annotation rect on the current page.
// Positioned inside the same parent as the canvas + text layer; sits
// between them in z-order so highlights show through the (transparent)
// text layer but selection still works on top.
const ANNOTATION_FILL: Record<AnnotationColor, string> = {
  gold: 'rgba(245, 207, 96, 0.45)',
  green: 'rgba(134, 239, 172, 0.4)',
  pink: 'rgba(244, 114, 182, 0.4)',
  blue: 'rgba(96, 165, 250, 0.4)',
};
const ANNOTATION_DOT: Record<AnnotationColor, string> = {
  gold: '#f5cf60',
  green: '#86efac',
  pink: '#f472b6',
  blue: '#60a5fa',
};

// The right-edge page rail: a scrollbar-shaped thumb mapped over the whole
// document. Drag it, or click anywhere on the track, to move through the
// pages — the vertical companion to the bottom slider, present even in
// fit-page mode where no native scrollbar can exist. It owns a permanent
// flex lane at the pane's right edge, so it never moves and never shares
// ground with the native bar; its ink follows the reader's theme, so it
// reads on parchment as plainly as by lamplight. Exported for the harness
// probes; the reader is its only product surface.
export function PageRail({ page, total, theme, onPage }: {
  page: number;
  total: number;
  theme: Theme;
  onPage: (p: number) => void;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const THUMB = 56;
  const dark = theme === 'dark';

  const pageAt = (clientY: number): number => {
    const el = railRef.current;
    if (!el) return page;
    const r = el.getBoundingClientRect();
    const usable = r.height - THUMB;
    if (usable <= 0) return page;
    const frac = Math.min(1, Math.max(0, (clientY - r.top - THUMB / 2) / usable));
    return 1 + Math.round(frac * (total - 1));
  };

  return (
    <div
      ref={railRef}
      className="w-[15px] shrink-0 relative cursor-pointer touch-none select-none"
      style={{ background: dark ? 'rgba(255,255,255,0.07)' : 'rgba(42,30,16,0.10)' }}
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        setDragging(true);
        onPage(pageAt(e.clientY));
      }}
      onPointerMove={(e) => { if (dragging) onPage(pageAt(e.clientY)); }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      role="slider"
      aria-label="Scroll through the pages"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={page}
      title={`Page ${page} of ${total} — drag to move through the document`}
    >
      <div
        className="absolute left-[2px] right-[2px] rounded-full"
        style={{
          height: THUMB,
          top: `calc(${(page - 1) / Math.max(1, total - 1)} * (100% - ${THUMB}px))`,
          background: dragging
            ? '#e8b84a'
            : hover
              ? (dark ? 'rgba(232, 184, 74, 0.85)' : 'rgba(160, 109, 31, 0.9)')
              : (dark ? 'rgba(255, 255, 255, 0.45)' : 'rgba(42, 30, 16, 0.55)'),
          transition: dragging ? 'none' : 'top 120ms ease, background 120ms ease',
        }}
      />
    </div>
  );
}

// The reader's context menu — its own verbs where the browser's menu stood.
function ReaderMenu({ at, hasSelection, canDownload, canDrive, printing, onCopySel, onCopyDoc, onPrint, onDownload, onDrive, onClose }: {
  at: { x: number; y: number };
  hasSelection: boolean;
  canDownload: boolean;
  canDrive: boolean;
  printing: boolean;
  onCopySel: () => void;
  onCopyDoc: () => void;
  onPrint: () => void;
  onDownload: () => void;
  onDrive: () => void;
  onClose: () => void;
}) {
  const items: { icon: React.ReactNode; label: string; run: () => void; disabled?: boolean }[] = [
    { icon: <Copy size={14} />, label: 'Copy', run: onCopySel, disabled: !hasSelection },
    { icon: <FileText size={14} />, label: 'Copy the whole document', run: onCopyDoc },
    { icon: <Printer size={14} />, label: printing ? 'Printing…' : 'Print', run: onPrint, disabled: printing },
    { icon: <Download size={14} />, label: 'Download the original', run: onDownload, disabled: !canDownload },
    ...(canDrive
      ? [{ icon: <HardDrive size={14} />, label: 'Save to Google Drive', run: onDrive }]
      : []),
  ];
  const W = 240;
  const x = Math.max(8, Math.min(at.x, window.innerWidth - W - 8));
  const y = Math.max(8, Math.min(at.y, window.innerHeight - (items.length * 34 + 14)));
  return (
    <div
      role="menu"
      className="fixed z-[80] py-1 rounded-lg bg-[#1a1a22] border border-white/15 shadow-2xl"
      style={{ left: x, top: y, width: W }}
      // Keep the click inside from collapsing the selection or reaching the
      // document-level closer before the item runs.
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          disabled={it.disabled}
          onClick={() => { it.run(); onClose(); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs text-white/80 hover:text-white hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="shrink-0 opacity-80">{it.icon}</span>
          <span className="flex-1">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

function AnnotationsOverlay({
  annotations,
  onRemove,
}: {
  annotations: Annotation[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="absolute inset-0 pointer-events-none">
      {annotations.map((ann) => {
        // Margin notes anchor with a quiet dotted underline, not a color
        // fill — the margin mark is the affordance; the page stays calm.
        // They're managed from the note card, so no inline remove button.
        const isNote = ann.note != null && ann.note.trim().length > 0;
        return ann.rects.map((rect, i) => (
          <div
            key={`${ann.id}-${i}`}
            className="absolute group"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
              backgroundColor: isNote ? 'transparent' : ANNOTATION_FILL[ann.color],
              borderBottom: isNote ? '1.5px dotted rgba(212,160,84,0.6)' : undefined,
              borderRadius: '2px',
              pointerEvents: 'auto',
            }}
            title={isNote ? ann.note ?? undefined : ann.anchor_text || undefined}
          >
            {i === 0 && !isNote && (
              <button
                onClick={(e) => { e.stopPropagation(); onRemove(ann.id); }}
                className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-black/70 text-white text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                title="Remove highlight"
              >
                ×
              </button>
            )}
          </div>
        ));
      })}
    </div>
  );
}

function SelectionMenu({
  x,
  y,
  onPick,
  onNote,
  onCancel,
}: {
  x: number;
  y: number;
  onPick: (color: AnnotationColor) => void;
  onNote: () => void;
  onCancel: () => void;
}) {
  const colors: AnnotationColor[] = ['gold', 'green', 'pink', 'blue'];
  // Clamp to viewport so the popover doesn't get clipped off the top.
  const top = Math.max(8, y - 44);
  return (
    <div
      className="fixed z-[60] flex items-center gap-1 px-1.5 py-1 rounded-lg bg-[#1a1a22] border border-white/15 shadow-2xl"
      style={{ left: x, top, transform: 'translateX(-50%)' }}
      onMouseDown={(e) => e.preventDefault()} // don't drop the selection on click
    >
      {colors.map((c) => (
        <button
          key={c}
          onClick={() => onPick(c)}
          className="w-5 h-5 rounded-full hover:scale-110 transition"
          style={{ backgroundColor: ANNOTATION_DOT[c] }}
          title={`Highlight ${c}`}
        />
      ))}
      <div className="w-px h-4 bg-white/15 mx-0.5" />
      <button
        onClick={onNote}
        className="h-5 px-1 inline-flex items-center justify-center rounded text-white/70 hover:text-[#e8b84a] transition"
        title="Add a margin note"
      >
        <StickyNote size={14} />
      </button>
      <div className="w-px h-4 bg-white/15 mx-0.5" />
      <button
        onClick={onCancel}
        className="w-5 h-5 rounded-full flex items-center justify-center text-white/55 hover:text-white text-[12px] leading-none"
        title="Cancel"
      >
        ×
      </button>
    </div>
  );
}

function ReaderStyle({ theme }: { theme: Theme }) {
  const selectionBg =
    theme === 'dark'
      ? 'rgba(245, 207, 96, 0.55)'
      : 'rgba(212, 160, 84, 0.45)';
  const dark = theme === 'dark';
  const sbTrack = dark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(42, 30, 16, 0.08)';
  const sbThumb = dark ? 'rgba(255, 255, 255, 0.45)' : 'rgba(42, 30, 16, 0.5)';
  const sbBtnHover = dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(42, 30, 16, 0.16)';
  const sbInk = dark ? 'rgba(255,255,255,0.65)' : 'rgba(42,30,16,0.75)';
  return (
    <style>{`
      .textLayer {
        position: absolute;
        left: 0;
        top: 0;
        overflow: hidden;
        opacity: 0.25;
        line-height: 1.0;
        user-select: text;
        pointer-events: auto;
        --min-font-size: 1;
        --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
        --min-font-size-inv: calc(1 / var(--min-font-size));
      }
      /* Mirrors pdfjs-dist's own pdf_viewer.css text-layer contract —
         spans carry --font-height/--scale-x/--rotate inline; these rules
         turn them into real geometry. Keep selector shapes identical to
         upstream (marked-content PDFs nest their spans). */
      .textLayer :is(span, br) {
        color: transparent;
        position: absolute;
        white-space: pre;
        cursor: text;
        transform-origin: 0% 0%;
      }
      .textLayer > :not(.markedContent),
      .textLayer .markedContent span:not(.markedContent) {
        z-index: 1;
        --font-height: 0;
        font-size: calc(var(--text-scale-factor) * var(--font-height));
        --scale-x: 1;
        --rotate: 0deg;
        transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
      }
      .textLayer .markedContent { display: contents; }
      .textLayer ::selection { background: ${selectionBg}; }
      /* The reading pane's scrollbar wears the reader's theme — the app-wide
         white-on-dark bar washes out on parchment. The thumb rides the whole
         case; the step arrows move it a line at a time (hold to crawl). */
      .reader-scroll::-webkit-scrollbar-track { background: ${sbTrack}; }
      .reader-scroll::-webkit-scrollbar-thumb {
        background: ${sbThumb};
        border-radius: 8px;
        border: 3px solid transparent;
        background-clip: padding-box;
        min-height: 48px;
      }
      .reader-scroll::-webkit-scrollbar-thumb:hover { background: rgba(232, 184, 74, 0.9); background-clip: padding-box; }
      .reader-scroll::-webkit-scrollbar-thumb:active { background: #e8b84a; background-clip: padding-box; }
      .reader-scroll::-webkit-scrollbar-button {
        width: 15px;
        height: 15px;
        background-color: ${sbTrack};
        background-repeat: no-repeat;
        background-position: center;
      }
      .reader-scroll::-webkit-scrollbar-button:hover { background-color: ${sbBtnHover}; }
      .reader-scroll::-webkit-scrollbar-button:vertical:decrement { background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'%3E%3Cpath d='M4.5 1.5 L8 7 L1 7 Z' fill='${sbInk}'/%3E%3C/svg%3E"); }
      .reader-scroll::-webkit-scrollbar-button:vertical:decrement:hover { background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'%3E%3Cpath d='M4.5 1.5 L8 7 L1 7 Z' fill='%23e8b84a'/%3E%3C/svg%3E"); }
      .reader-scroll::-webkit-scrollbar-button:vertical:increment { background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'%3E%3Cpath d='M4.5 7.5 L8 2 L1 2 Z' fill='${sbInk}'/%3E%3C/svg%3E"); }
      .reader-scroll::-webkit-scrollbar-button:vertical:increment:hover { background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'%3E%3Cpath d='M4.5 7.5 L8 2 L1 2 Z' fill='%23e8b84a'/%3E%3C/svg%3E"); }
      .reader-scroll::-webkit-scrollbar-button:horizontal:decrement { background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'%3E%3Cpath d='M1.5 4.5 L7 8 L7 1 Z' fill='${sbInk}'/%3E%3C/svg%3E"); }
      .reader-scroll::-webkit-scrollbar-button:horizontal:increment { background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'%3E%3Cpath d='M7.5 4.5 L2 8 L2 1 Z' fill='${sbInk}'/%3E%3C/svg%3E"); }
      /* Printing a rendered document (docx, slides, script): only the
         document itself reaches the paper — no app chrome, no dark ground.
         PDFs never come this way; they print as their original file. */
      @media print {
        body * { visibility: hidden !important; }
        .print-root, .print-root * { visibility: visible !important; }
        .print-root {
          position: absolute !important;
          left: 0 !important;
          top: 0 !important;
          width: 100% !important;
          max-width: none !important;
          margin: 0 !important;
          box-shadow: none !important;
        }
      }
      .textLayer ::-moz-selection { background: ${selectionBg}; }

      .docx-page :is(h1,h2,h3,h4) { font-weight: 700; margin: 1em 0 0.4em; line-height: 1.25; }
      .docx-page h1 { font-size: 1.8em; }
      .docx-page h2 { font-size: 1.45em; }
      .docx-page h3 { font-size: 1.2em; }
      .docx-page p { margin: 0.65em 0; }
      .docx-page ul, .docx-page ol { padding-left: 1.5em; margin: 0.6em 0; }
      .docx-page li { margin: 0.2em 0; }
      .docx-page table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
      .docx-page table td, .docx-page table th { border: 1px solid rgba(0,0,0,0.15); padding: 6px 10px; }
      .docx-page img { max-width: 100%; height: auto; }
      .docx-page strong { font-weight: 700; }
      .docx-page em { font-style: italic; }

      /* PPTX — one white card per slide, slide number top-right, speaker
         notes in a marked block under the slide body. A readable rendering
         of the deck's text, not a pixel-faithful one. */
      .pptx-deck { display: flex; flex-direction: column; gap: 1.75em; }
      .pptx-slide { position: relative; background: #ffffff; color: #1a1810; border-radius: 6px; padding: 2.4em 2.8em 2.1em; box-shadow: 0 12px 40px rgba(0,0,0,0.45); }
      .pptx-slide h2 { font-size: 1.45em; font-weight: 700; line-height: 1.25; margin: 0 0 0.7em; }
      .pptx-slide p { margin: 0.45em 0; line-height: 1.5; }
      .pptx-slide-num { position: absolute; top: 0.6em; right: 0.9em; font-size: 0.72em; color: rgba(0,0,0,0.35); }
      .pptx-notes { margin-top: 1.5em; padding: 0.9em 1.1em; background: #f6f3ea; border-left: 3px solid #d4a054; font-size: 0.85em; color: #5c574a; }
      .pptx-notes strong { display: block; font-size: 0.78em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #a08340; margin-bottom: 0.35em; }
      .pptx-notes p { margin: 0.3em 0; }

      /* Fountain — standard screenplay layout. fountain-js emits semantic
         HTML (h3 scene headings, .dialogue divs with h4 character + p
         dialogue, p action, .centered transitions). We do the standard
         Hollywood-style positioning: scene headings in caps bold flush
         left, action flush left, character names centred uppercase,
         dialogue indented from both sides, parentheticals indented
         further and italicised, transitions right-aligned caps. */
      .fountain-page { white-space: pre-wrap; }
      .fountain-title-page { text-align: center; margin-bottom: 4em; padding-bottom: 2em; border-bottom: 1px solid rgba(0,0,0,0.1); }
      .fountain-title-page h1 { font-size: 1.4em; font-weight: 700; text-transform: uppercase; margin: 0.5em 0; letter-spacing: 0.05em; }
      .fountain-title-page p { margin: 0.3em 0; }
      .fountain-title-page .authors { margin-top: 2em; }
      .fountain-script h3 { font-weight: 700; text-transform: uppercase; margin: 1.6em 0 0.4em; font-size: 1em; }
      .fountain-script p { margin: 0.7em 0; }
      .fountain-script .dialogue { margin: 0.8em 0 0.8em 1.6in; max-width: 3.5in; }
      .fountain-script .dialogue h4 { font-weight: 400; text-transform: uppercase; text-align: left; margin: 0 0 0 1in; font-size: 1em; }
      .fountain-script .dialogue p { margin: 0; }
      .fountain-script .dialogue .parenthetical { font-style: italic; margin-left: 0.5in; }
      .fountain-script .centered { text-align: center; }
      .fountain-script .transition,
      .fountain-script p.transition { text-align: right; text-transform: uppercase; font-weight: 700; margin: 1em 0; }
      .fountain-script .note { background: rgba(250, 220, 120, 0.25); padding: 0 2px; border-radius: 2px; }
      .fountain-script .section { font-weight: 700; text-transform: uppercase; margin: 1.6em 0 0.4em; color: rgba(21,19,11,0.55); }
      .fountain-script .synopsis { color: rgba(21,19,11,0.55); font-style: italic; }
    `}</style>
  );
}

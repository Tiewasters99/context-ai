import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
} from 'lucide-react';
import mammoth from 'mammoth';
import { Fountain } from 'fountain-js';
import { supabase } from '@/lib/supabase';
import ReaderSidebar, { type OutlineNode } from '@/components/reader/ReaderSidebar';
import CoverImage from '@/components/layout/CoverImage';
import CoverModeToggle from '@/components/ui/CoverModeToggle';
import { useCoverExpanded } from '@/hooks/useCoverExpanded';
import { useConnections } from '@/hooks/useConnections';
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  type Annotation,
  type AnnotationColor,
  type FractionalRect,
} from '@/lib/document-annotations';

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
};

type FileKind = 'pdf' | 'docx' | 'fountain' | 'unsupported';
type LoadState = 'loading' | 'ready' | 'error';
type Theme = 'parchment' | 'dark';
type Match = { page: number; index: number };

export default function DocumentReader() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

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
  // Default on; `renderedScale` is the scale the last render actually used.
  const [fitPage, setFitPage] = useState(true);
  const [renderedScale, setRenderedScale] = useState(1.5);
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
    rects: FractionalRect[];
    anchorText: string;
  } | null>(null);

  const pdfDocRef = useRef<unknown>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

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
    const s = localStorage.getItem('ctx_reader_sidebar_open');
    if (s === '0') setSidebarOpen(false);
  }, []);
  useEffect(() => {
    localStorage.setItem('ctx_reader_sidebar_open', sidebarOpen ? '1' : '0');
  }, [sidebarOpen]);

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

    void (async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('id, title, storage_path, source_filename, page_count, cover_url')
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
        : 'unsupported';
      setFileKind(kind);

      if (kind === 'unsupported') {
        setErrorMsg('Unsupported file type — the reader currently handles PDF, Word (.docx), and Fountain (.fountain).');
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
          const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
          if (cancelled) return;
          pdfDocRef.current = pdf;
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

  // Render the current PDF page on page / zoom / theme change.
  useEffect(() => {
    if (loadState !== 'ready' || fileKind !== 'pdf') return;
    const pdf = pdfDocRef.current as { getPage(n: number): Promise<unknown> } | null;
    const canvas = canvasRef.current;
    const textLayerContainer = textLayerRef.current;
    if (!pdf || !canvas || !textLayerContainer) return;

    let cancelled = false;
    let textLayer: { render(): Promise<unknown>; cancel(): void } | null = null;

    void (async () => {
      try {
        const pdfPage = await pdf.getPage(page) as {
          getViewport(opts: { scale: number }): { width: number; height: number };
          render(opts: unknown): { promise: Promise<void> };
          streamTextContent(): ReadableStream;
        };
        if (cancelled) return;

        // Compute the render scale. In fit-page mode, scale the page so
        // the entire page is visible at once inside the content pane —
        // one screenful = exactly one PDF page, which is what makes the
        // reader's pages line up with the PDF's pages for citation.
        let scale = zoom;
        if (fitPage) {
          const pane = contentRef.current;
          if (pane && pane.clientWidth > 0 && pane.clientHeight > 0) {
            const natural = pdfPage.getViewport({ scale: 1 });
            const PAD = 24; // breathing room around the page
            const fit = Math.min(
              (pane.clientWidth - PAD * 2) / natural.width,
              (pane.clientHeight - PAD * 2) / natural.height,
            );
            scale = Math.max(0.1, Math.min(fit, 6));
          }
        }
        setRenderedScale(scale);

        const viewport = pdfPage.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // PACER-style rendering: leave the document's own colors alone —
        // true white pages, true black ink, faithful images for scans
        // (death certificates, handwritten exhibits, etc.) — and let the
        // surrounding frame do the dark-mode work. Recoloring the page
        // itself via pdfjs pageColors made everything look black-on-black
        // and distorted scanned exhibits.
        const renderOpts: Record<string, unknown> = {
          canvasContext: ctx,
          viewport,
        };
        await pdfPage.render(renderOpts).promise;
        if (cancelled) return;

        textLayerContainer.innerHTML = '';
        textLayerContainer.style.width = `${viewport.width}px`;
        textLayerContainer.style.height = `${viewport.height}px`;

        const pdfjsLib = await import('pdfjs-dist');
        textLayer = new pdfjsLib.TextLayer({
          textContentSource: pdfPage.streamTextContent(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          viewport: viewport as any,
          container: textLayerContainer,
        });
        await textLayer.render();

        if (searchQuery && matches.length > 0 && matches[matchIdx]?.page === page) {
          highlightTextLayerMatches(textLayerContainer, searchQuery);
        }

        localStorage.setItem(`ctx_reader_page_${id}`, String(page));
      } catch {
        // Render race conditions can happen if page changes mid-render;
        // a subsequent render will correct the canvas.
      }
    })();

    return () => {
      cancelled = true;
      if (textLayer) try { textLayer.cancel(); } catch { /* noop */ }
    };
  }, [page, zoom, fitPage, containerTick, loadState, fileKind, id, theme, searchQuery, matches, matchIdx]);

  const goPrev = useCallback(() => setPage((p) => Math.max(1, p - 1)), []);
  const goNext = useCallback(
    () => setPage((p) => Math.min(totalPages, p + 1)),
    [totalPages],
  );

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
        const msg =
          body.error === 'drive_needs_reconnect' ? 'Reconnect Google Drive — your token expired.'
          : body.error === 'drive_not_connected' ? 'Connect Google Drive in Connections first.'
          : body.error === 'file_too_large' ? 'File is too large for Drive export (75 MB cap).'
          : body.error || 'Drive export failed.';
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
      const ext = fileKind === 'pdf' ? '.pdf' : '.docx';
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

  // Load annotations once per document.
  useEffect(() => {
    if (!id || loadState !== 'ready' || fileKind !== 'pdf') return;
    let cancelled = false;
    void (async () => {
      const rows = await listAnnotations(id);
      if (!cancelled) setAnnotations(rows);
    })();
    return () => { cancelled = true; };
  }, [id, loadState, fileKind]);

  // Watch text-layer selections — when the user releases the mouse after
  // selecting text inside the current page, capture the rectangles in
  // page-fractional coordinates so we can persist a highlight that scales
  // cleanly to any zoom level.
  useEffect(() => {
    if (loadState !== 'ready' || fileKind !== 'pdf') return;

    function handleMouseUp() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setSelectionMenu(null);
        return;
      }
      const layer = textLayerRef.current;
      if (!layer) return;

      // Only show the popover when the selection is anchored inside the
      // text layer (not random page chrome).
      const anchorNode = sel.anchorNode;
      if (!anchorNode || !layer.contains(anchorNode)) {
        setSelectionMenu(null);
        return;
      }

      const range = sel.getRangeAt(0);
      const clientRects = Array.from(range.getClientRects()).filter(
        (r) => r.width > 0 && r.height > 0,
      );
      if (clientRects.length === 0) {
        setSelectionMenu(null);
        return;
      }

      const layerRect = layer.getBoundingClientRect();
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
        rects: fractRects,
        anchorText: sel.toString().trim().slice(0, 1000),
      });
    }

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [loadState, fileKind, page, zoom]);

  const saveAnnotation = useCallback(
    async (color: AnnotationColor) => {
      if (!id || !selectionMenu) return;
      const ann = await createAnnotation({
        documentId: id,
        page,
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
    [id, page, selectionMenu],
  );

  const removeAnnotation = useCallback(async (annId: string) => {
    const ok = await deleteAnnotation(annId);
    if (ok) {
      setAnnotations((prev) => prev.filter((a) => a.id !== annId));
    }
  }, []);

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
      setPage(pageIdx + 1);
    } catch { /* dest resolution can fail on malformed PDFs */ }
  }, []);

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
    if (found.length > 0) setPage(found[0].page);
  }, [fileKind]);

  const goNextMatch = useCallback(() => {
    if (matches.length === 0) return;
    const next = (matchIdx + 1) % matches.length;
    setMatchIdx(next);
    setPage(matches[next].page);
  }, [matchIdx, matches]);
  const goPrevMatch = useCallback(() => {
    if (matches.length === 0) return;
    const next = (matchIdx - 1 + matches.length) % matches.length;
    setMatchIdx(next);
    setPage(matches[next].page);
  }, [matchIdx, matches]);

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
      {loadState === 'ready' && (
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
            onClick={() => navigate(-1)}
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
          <span className="text-sm text-[var(--color-text-bright)] truncate">
            {doc?.title || 'Document'}
          </span>
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
          <CoverModeToggle
            hasCover={!!doc?.cover_url}
            expanded={coverExpanded}
            onToggle={() => setCoverExpanded(!coverExpanded)}
          />
          <div className="w-px h-5 bg-white/10 mx-1" />
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
            onJumpPage={(p) => setPage(p)}
            onJumpDest={(d) => void jumpDest(d)}
          />
        )}
        <div className="flex-1 flex flex-col min-w-0">
          <div
            ref={contentRef}
            className={`flex-1 overflow-auto flex justify-center ${
              fileKind === 'pdf' && fitPage ? 'items-center' : 'items-start py-6 px-4'
            }`}
            style={{ backgroundColor: rootBg }}
          >
            {loadState === 'loading' && (
              <p className="mt-10 text-[13px] text-white/50">Loading document…</p>
            )}
            {loadState === 'error' && (
              <p className="mt-10 text-[13px] text-red-400">{errorMsg}</p>
            )}
            {loadState === 'ready' && fileKind === 'pdf' && (
              <div className="relative">
                <canvas ref={canvasRef} className="block shadow-2xl" />
                <AnnotationsOverlay
                  annotations={annotations.filter((a) => a.page === page)}
                  onRemove={(annId) => void removeAnnotation(annId)}
                />
                <div ref={textLayerRef} className="textLayer absolute inset-0" />
              </div>
            )}
            {loadState === 'ready' && fileKind === 'docx' && docHtml && (
              <div
                className="docx-page max-w-3xl w-full mx-auto shadow-2xl"
                style={{
                  backgroundColor: '#ffffff',
                  color: '#1a1810',
                  padding: '64px 80px',
                  fontSize: `${Math.round(16 * (zoom / 1.5))}px`,
                  lineHeight: 1.6,
                }}
              >
                <div dangerouslySetInnerHTML={{ __html: docHtml }} />
              </div>
            )}
            {loadState === 'ready' && fileKind === 'fountain' && (
              <div
                className="fountain-page max-w-[8.5in] w-full mx-auto shadow-2xl"
                style={{
                  backgroundColor: '#fafaf6',
                  color: '#15130b',
                  padding: '72px 96px',
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
              onChange={(e) => setPage(parseInt(e.target.value, 10))}
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
      {selectionMenu && (
        <SelectionMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          onPick={(c) => void saveAnnotation(c)}
          onCancel={() => {
            window.getSelection()?.removeAllRanges();
            setSelectionMenu(null);
          }}
        />
      )}
    </div>
  );
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

function AnnotationsOverlay({
  annotations,
  onRemove,
}: {
  annotations: Annotation[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="absolute inset-0 pointer-events-none">
      {annotations.map((ann) =>
        ann.rects.map((rect, i) => (
          <div
            key={`${ann.id}-${i}`}
            className="absolute group"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
              backgroundColor: ANNOTATION_FILL[ann.color],
              borderRadius: '2px',
              pointerEvents: 'auto',
            }}
            title={ann.anchor_text || undefined}
          >
            {i === 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); onRemove(ann.id); }}
                className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-black/70 text-white text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                title="Remove highlight"
              >
                ×
              </button>
            )}
          </div>
        )),
      )}
    </div>
  );
}

function SelectionMenu({
  x,
  y,
  onPick,
  onCancel,
}: {
  x: number;
  y: number;
  onPick: (color: AnnotationColor) => void;
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
      }
      .textLayer > span,
      .textLayer > br {
        color: transparent;
        position: absolute;
        white-space: pre;
        cursor: text;
        transform-origin: 0% 0%;
      }
      .textLayer ::selection { background: ${selectionBg}; }
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

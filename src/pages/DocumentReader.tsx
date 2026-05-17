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
} from 'lucide-react';
import mammoth from 'mammoth';
import { supabase } from '@/lib/supabase';
import ReaderSidebar, { type OutlineNode } from '@/components/reader/ReaderSidebar';

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
};

type FileKind = 'pdf' | 'docx' | 'unsupported';
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

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [zoom, setZoom] = useState(1.5);
  const [theme, setTheme] = useState<Theme>('parchment');

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

  const pdfDocRef = useRef<unknown>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);

  // Restore persisted prefs.
  useEffect(() => {
    const z = localStorage.getItem('ctx_reader_zoom');
    if (z) {
      const parsed = parseFloat(z);
      if (parsed >= 0.5 && parsed <= 4) setZoom(parsed);
    }
    const t = localStorage.getItem('ctx_reader_theme') as Theme | null;
    if (t === 'parchment' || t === 'dark') setTheme(t);
  }, []);
  useEffect(() => { localStorage.setItem('ctx_reader_zoom', String(zoom)); }, [zoom]);
  useEffect(() => { localStorage.setItem('ctx_reader_theme', theme); }, [theme]);
  useEffect(() => {
    const s = localStorage.getItem('ctx_reader_sidebar_open');
    if (s === '0') setSidebarOpen(false);
  }, []);
  useEffect(() => {
    localStorage.setItem('ctx_reader_sidebar_open', sidebarOpen ? '1' : '0');
  }, [sidebarOpen]);

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

    void (async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('id, title, storage_path, source_filename, page_count')
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
        : 'unsupported';
      setFileKind(kind);

      if (kind === 'unsupported') {
        setErrorMsg('Unsupported file type — the reader currently handles PDF and Word (.docx).');
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

        const viewport = pdfPage.getViewport({ scale: zoom });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // pdfjs renders natively in the target colors when pageColors is
        // passed. This is the "true" dark mode — light text on a dark page
        // background, not a CSS-filter invert. Far cleaner for color images.
        const renderOpts: Record<string, unknown> = {
          canvasContext: ctx,
          viewport,
        };
        if (theme === 'dark') {
          renderOpts.pageColors = {
            background: '#0a0a10',
            foreground: '#f0ebe3',
          };
        }
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
  }, [page, zoom, loadState, fileKind, id, theme, searchQuery, matches, matchIdx]);

  const goPrev = useCallback(() => setPage((p) => Math.max(1, p - 1)), []);
  const goNext = useCallback(
    () => setPage((p) => Math.min(totalPages, p + 1)),
    [totalPages],
  );

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
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext]);

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
  const rootBg = theme === 'dark' ? '#0a0a10' : '#f3ecd9';
  const showBottomNav = loadState === 'ready' && fileKind === 'pdf' && totalPages > 0;

  return (
    <div
      className="flex flex-col h-full"
      style={{ backgroundColor: rootBg }}
    >
      <ReaderStyle theme={theme} />

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
            onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
            title="Zoom out"
          >
            <ZoomOut size={15} />
          </button>
          <span className="text-xs text-white/55 tabular-nums w-12 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
            title="Zoom in"
          >
            <ZoomIn size={15} />
          </button>
          <button
            onClick={() => setTheme((t) => (t === 'parchment' ? 'dark' : 'parchment'))}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
            title={theme === 'parchment' ? 'Dark mode' : 'Light mode'}
          >
            {theme === 'parchment' ? <Moon size={15} /> : <Sun size={15} />}
          </button>
        </div>
      </div>

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
            className="flex-1 overflow-auto flex items-start justify-center py-6 px-4"
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
                <div ref={textLayerRef} className="textLayer absolute inset-0" />
              </div>
            )}
            {loadState === 'ready' && fileKind === 'docx' && docHtml && (
              <div
                className="docx-page max-w-3xl w-full mx-auto shadow-2xl"
                style={{
                  backgroundColor: theme === 'dark' ? '#1a1a22' : '#ffffff',
                  color: theme === 'dark' ? '#f0ebe3' : '#1a1810',
                  padding: '64px 80px',
                  fontSize: `${Math.round(16 * (zoom / 1.5))}px`,
                  lineHeight: 1.6,
                }}
              >
                <div dangerouslySetInnerHTML={{ __html: docHtml }} />
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
    `}</style>
  );
}

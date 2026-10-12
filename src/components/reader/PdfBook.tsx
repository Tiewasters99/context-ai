import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Sun,
  Moon,
  X,
  ArrowLeft,
  Search,
  PanelLeft,
  Hammer,
  Undo2,
  Scan,
  Maximize,
  Minimize,
  MoreHorizontal,
  Loader2,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfOpenProgress, PdfOpenProgressFn } from '@/lib/pdf-source';
import { guardTextLayerSelection, releaseTextLayerGuards } from '@/lib/pdf-text-selection';
import ReaderSidebar, { type OutlineNode, type SidebarTabId } from '@/components/reader/ReaderSidebar';
import AnimationLayer from '@/components/reader/AnimationLayer';
import { MediaUrlProvider, useMediaUrl, type MediaUrlResolver } from '@/lib/media-url';
import type { WorkshopPanelProps } from '@/components/reader/WorkshopPanel';
import type { DocumentAnimation, Turn } from '@/lib/document-animations';
import { nextTurn, unionRect, type WorkshopItem } from '@/lib/document-workshop';
import { downloadBlob } from '@/lib/export-page';
import { renderPageCanvas, cropCanvas, rotateCanvas, canvasToBlob } from '@/lib/pdf-page-image';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  annotationIsNote,
  type Annotation,
  type AnnotationColor,
  type FractionalRect,
} from '@/lib/document-annotations';
import { interceptStyledCopy } from '@/lib/reader-copy';
import { phraseRegex } from '@/lib/reader-find';
import { ANNOTATION_DOT, ANNOTATION_FILL, printCss, scrollbarCss, type ReaderTheme } from '@/lib/reader-style';
import {
  FindBox,
  LoadingCard,
  ReaderMoreMenu,
  SelectionMenu,
  type MoreItem,
} from '@/components/reader/reader-chrome';

// The book: a PDF's pages in a continuous stack, with the text layer and
// its selection guard, highlights and the menus on them, Undo, the living
// illustrations (AnimationLayer), the find box, the page counter, the
// sidebar with its Workshop tab and the toolbar's Workshop button. It knows
// nothing of matters, the Vault or the Orchestrator: it takes its data
// through three small interfaces — a source (the file and what is laid on
// it), a marks store (the reader's highlights) and a bench store (the
// Workshop) — and offers slots for whatever a host puts around the page.
// The document view (src/pages/DocumentReader.tsx) is the first host; the
// Grapheon Reader (docs/specs/GRAPHEON-READER-2026-10-10.md) is the second.
// "One copy. One Reader."

type LoadState = 'loading' | 'ready' | 'error';
type Match = { page: number; index: number };

// Vertical gap between page slots in the continuous stack.
const PAGE_GAP = 16;

/** The file, and what is laid on its pages. */
export type PdfSource = {
  /** Identity: a new key opens the book afresh (another document, or a reload of this one). */
  key: string;
  openPdf(onProgress: PdfOpenProgressFn): Promise<PDFDocumentProxy>;
  /** The clips laid on the pages (document_animations in Contextspaces; edition_illustrations in the Reader). */
  listIllustrations(): Promise<DocumentAnimation[]>;
  /** Take a clip off the page. Absent where a reader cannot. */
  removeIllustration?(id: string): Promise<void>;
  /** Hits from the indexed text, tried before the pages' own text layers (a scan's words live only there). */
  findInIndex?(query: string): Promise<Match[]>;
  /** Where a clip's bytes come from, by its storage path. Absent = the vault bucket (clipUrl). */
  mediaUrl?: MediaUrlResolver;
};

/** The reader's own highlights: document_annotations in Contextspaces, edition_marks in the Reader. */
export type MarksStore = {
  list(): Promise<Annotation[]>;
  create(args: { page: number; color: AnnotationColor; rects: FractionalRect[]; anchorText: string }): Promise<Annotation | null>;
  update(id: string, patch: { color: AnnotationColor }): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  /** Marks are collaborative in Contextspaces; a change by someone else arrives here. Returns the unsubscribe. */
  subscribe?(onChange: () => void): () => void;
};

/** The Workshop bench. Null for a book the reader cannot edit. */
export type BenchStore = {
  canWrite: boolean;
  list(): Promise<WorkshopItem[]>;
  createSnip(args: { page: number; rect: FractionalRect }): Promise<WorkshopItem>;
  createSnippet(args: { page: number; text: string; rect: FractionalRect | null }): Promise<WorkshopItem>;
  update(id: string, patch: { page?: number; rect?: FractionalRect | null; turn?: Turn; text?: string; parent_id?: string | null }): Promise<WorkshopItem>;
  /** Throws with the sentence to show when it cannot. */
  remove(id: string): Promise<void>;
  /** A clip or a still brought back from a generator. `notice` is what to say once it is on the bench. */
  bringIn(parent: WorkshopItem | null, file: File, page: number): Promise<{ item: WorkshopItem; notice?: string }>;
  /** Lay a media item on the page where its source sits. */
  lay(media: WorkshopItem, source: WorkshopItem): Promise<DocumentAnimation>;
};

/** A `?page=` deep link: the page, and a key that changes when the link does. */
export type PageLink = { page: number; key: string };

/** Imperative navigation from a host (the Brief Desk's authority pane): a page, and the words to light there. */
export type PdfBookGoto = { page?: number | null; phrase?: string | null; nonce: number };

/** What the reader sees — reported to the host as it changes. */
export type PdfBookView = {
  state: LoadState;
  page: number;
  totalPages: number;
  /** The pages actually on screen, most visible first. */
  visiblePages: { page: number; share: number }[];
};

/** The reader's selection on a page, in page-fractional coordinates. */
export type BookSelection = {
  x: number;
  y: number;
  page: number;
  rects: FractionalRect[];
  anchorText: string;
};

/** What a host draws beside each page (the notes rail, the cross-references) and how wide it is. */
export type PageSides = {
  width: number;
  render: (page: number, marks: Annotation[]) => { before?: React.ReactNode; after?: React.ReactNode };
};

/** The second half of "add a clip": the rectangle is drawn; the host says which clip plays there. */
export type AttachArgs = {
  page: number;
  rect: FractionalRect;
  makePreview: (page: number, rect: FractionalRect, turn: Turn) => Promise<string | null>;
  onSaved: (animation: DocumentAnimation) => void;
  onClose: () => void;
};

export type PdfBookHandle = {
  gotoPage(p: number): void;
  /** Which page a DOM node sits on, when it is in a page's text layer. */
  pageOfNode(node: Node | null | undefined): number | undefined;
  /** Read the marks again (after the host wrote one of its own, e.g. a margin note). */
  reloadMarks(): Promise<void>;
  removeMark(id: string): Promise<void>;
};

export type PdfBookProps = {
  source: PdfSource | null;
  marks: MarksStore | null;
  bench: BenchStore | null;
  currentUserId: string | null;
  /** Inside another surface's column: fits to its width, keeps no preferences, no rails, sidebar shut. */
  pane?: boolean;
  hideSidebarToggle?: boolean;
  /** What the book is called and how long it is: the card shown while it opens, and the name of a saved snip. */
  meta?: { title: string | null; pageCount: number | null };
  /** localStorage key for the last-read page; null = not remembered. */
  pageMemoryKey?: string | null;
  pageLink?: PageLink | null;
  goto?: PdfBookGoto | null;
  onClose?: () => void;
  /** Above the toolbar, once the book is open (the cover). */
  header?: React.ReactNode;
  /** The toolbar's title. */
  title?: React.ReactNode;
  /** Toolbar actions after the find box, before zoom. */
  toolbarStart?: React.ReactNode;
  /** Toolbar actions after full screen, before the theme toggle (desktop). */
  toolbarEnd?: React.ReactNode;
  /** The phone's "more" menu: between full screen and the theme toggle. */
  moreItems?: MoreItem[];
  /** Between the toolbar and the page. */
  banners?: React.ReactNode;
  /** Drawn in the reading pane before the pages: an error, a second-factor prompt. */
  notice?: React.ReactNode;
  /** Absolutely positioned children of the page area (a status toast). */
  paneChildren?: React.ReactNode;
  pageSides?: PageSides | null;
  /** Offered in the sidebar as "add a clip"; absent = not offered. */
  renderAttach?: ((a: AttachArgs) => React.ReactNode) | null;
  /** The selection menu's Ask; absent = no Ask button. */
  onAsk?: (text: string, page: number) => void;
  /** The selection menu's Note; absent = no Note button. */
  onNote?: (selection: BookSelection) => void;
  /** The selection menu's Copy, where the host reports the outcome (its toolbar's copy state); absent = a quiet copy. */
  onCopySelection?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onOpened?: (pdf: PDFDocumentProxy) => void;
  onError?: (e: unknown) => void;
  onView?: (view: PdfBookView) => void;
  onMarks?: (marks: Annotation[]) => void;
  /** Overlays the host owns, rendered inside the book's root (so they show in full screen too). */
  children?: React.ReactNode;
  ref?: React.Ref<PdfBookHandle>;
};

export default function PdfBook({
  source,
  marks,
  bench,
  currentUserId,
  pane = false,
  hideSidebarToggle = false,
  meta,
  pageMemoryKey = null,
  pageLink = null,
  goto = null,
  onClose,
  header,
  title,
  toolbarStart,
  toolbarEnd,
  moreItems,
  banners,
  notice,
  paneChildren,
  pageSides = null,
  renderAttach = null,
  onAsk,
  onNote,
  onCopySelection,
  onContextMenu,
  onOpened,
  onError,
  onView,
  onMarks,
  children,
  ref,
}: PdfBookProps) {
  const paneChrome = pane;
  const isMobile = useIsMobile();

  // The host's callbacks, read through refs so an effect never re-runs for a
  // new function identity.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const sourceKey = source?.key ?? null;
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const onMarksRef = useRef(onMarks);
  onMarksRef.current = onMarks;

  const [loadState, setLoadState] = useState<LoadState>('loading');
  // What the loader is doing right now, for the card shown while it works.
  const [loadProgress, setLoadProgress] = useState<PdfOpenProgress | null>(null);

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [zoom, setZoom] = useState(1.5);
  const [theme, setTheme] = useState<ReaderTheme>('parchment');

  // Fit-page mode. When on, each page is scaled so the entire page is
  // visible at once — one screenful = exactly one PDF page, so the reader's
  // pages line up with the PDF's pages for citation/citechecking. Default
  // on. The stack scrolls continuously in either mode.
  const [fitPage, setFitPage] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Bumped whenever the content pane resizes, to re-fit the page.
  const [containerTick, setContainerTick] = useState(0);

  // Search state. Matches name a page and are drawn as boxes over the text
  // layer.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [matchIdx, setMatchIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  /** A find has run for the current query (so "Not found" means it looked). */
  const [searched, setSearched] = useState(false);
  const pageTextCacheRef = useRef<string[]>([]);

  // Sidebar state.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Held here, not in the sidebar, so the toolbar's Workshop button can open
  // the sidebar straight onto the bench.
  const [sidebarTab, setSidebarTab] = useState<SidebarTabId>('pages');
  const [thumbnails, setThumbnails] = useState<(string | null)[]>([]);
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);

  // Annotations state. Loaded once per document; updated optimistically on
  // create/delete so we don't round-trip the store for UX.
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectionMenu, setSelectionMenu] = useState<BookSelection | null>(null);

  // Living illustrations: a clip laid over a picture on the page, played
  // by tapping it (migration 062).
  const [animations, setAnimations] = useState<DocumentAnimation[]>([]);
  // True while waiting for a rectangle to be drawn round a picture.
  const [attaching, setAttaching] = useState(false);
  const [pendingArea, setPendingArea] = useState<{ page: number; rect: FractionalRect } | null>(null);
  // The Workshop bench (migration 106). `snipping` is the same rectangle
  // mode as `attaching`, landing a snip on the bench instead of opening the
  // attach dialog; `resnip` is the snip whose rectangle is being redrawn.
  const [workshopItems, setWorkshopItems] = useState<WorkshopItem[]>([]);
  const [snipping, setSnipping] = useState(false);
  const [resnip, setResnip] = useState<WorkshopItem | null>(null);
  const [workshopNotice, setWorkshopNotice] = useState<string | null>(null);

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
  // One overlay per slot for search hits, drawn over the page at full
  // strength — the text layer itself sits at a quarter opacity so its
  // transparent glyphs never show, which also made any tint on its spans
  // all but invisible.
  const hitLayerRefs = useRef<(HTMLDivElement | null)[]>([]);
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
    // A pane beside another surface fits to its own width (below) and leaves
    // the full Reader's saved zoom and fit alone, in both directions.
    if (pane) return;
    const z = localStorage.getItem('ctx_reader_zoom');
    if (z) {
      const parsed = parseFloat(z);
      if (parsed >= 0.5 && parsed <= 4) setZoom(parsed);
    }
    const t = localStorage.getItem('ctx_reader_theme') as ReaderTheme | null;
    if (t === 'parchment' || t === 'dark') setTheme(t);
    const f = localStorage.getItem('ctx_reader_fit');
    if (f === '0') setFitPage(false);
  }, [pane]);
  useEffect(() => { if (!pane) localStorage.setItem('ctx_reader_zoom', String(zoom)); }, [zoom, pane]);
  useEffect(() => { localStorage.setItem('ctx_reader_theme', theme); }, [theme]);
  useEffect(() => { if (!pane) localStorage.setItem('ctx_reader_fit', fitPage ? '1' : '0'); }, [fitPage, pane]);
  useEffect(() => {
    // On a phone the thumbnail rail would swallow the page, so start closed
    // regardless of the saved desktop preference.
    // A pane has no room for it either, and no toggle to open it.
    if (isMobile || pane) { setSidebarOpen(false); return; }
    const s = localStorage.getItem('ctx_reader_sidebar_open');
    if (s === '0') setSidebarOpen(false);
  }, [isMobile, pane]);
  useEffect(() => {
    if (pane) return; // the pane's shut sidebar is not the reader's preference
    localStorage.setItem('ctx_reader_sidebar_open', sidebarOpen ? '1' : '0');
  }, [sidebarOpen, pane]);

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

  // Open the book. A new source (another document, or a reload of this one)
  // starts over; no source yet is the loading card, waiting.
  useEffect(() => {
    setLoadState('loading');
    setLoadProgress(null);
    pdfDocRef.current = null;
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
    releaseTextLayerGuards();
    textLayerRefs.current = [];
    restoredRef.current = false;
    anchorReadyRef.current = false;

    const src = sourceRef.current;
    if (!src) return;
    let cancelled = false;

    void (async () => {
      try {
        // A PDF is opened by ranges, page by page, so a scanned book paints
        // its first page in a second instead of after the whole file has
        // arrived (src/lib/pdf-source.ts, behind the source).
        const pdf = await src.openPdf((p) => { if (!cancelled) setLoadProgress(p); });
        if (cancelled) return;
        pdfDocRef.current = pdf;
        // Page 1's size stands in for every slot until the dims sweep
        // below reports the real per-page sizes.
        const firstPage = await pdf.getPage(1);
        const v1 = firstPage.getViewport({ scale: 1 });
        if (cancelled) return;
        setPageDims(new Array(pdf.numPages).fill({ w: v1.width, h: v1.height }));
        setTotalPages(pdf.numPages);

        const savedPage = pageMemoryKey ? localStorage.getItem(pageMemoryKey) : null;
        const start = savedPage ? parseInt(savedPage, 10) : 1;
        setPage(start >= 1 && start <= pdf.numPages ? start : 1);
        setLoadState('ready');
        onOpenedRef.current?.(pdf);
      } catch (err) {
        if (cancelled) return;
        setLoadState('error');
        onErrorRef.current?.(err);
      }
    })();

    return () => { cancelled = true; };
    // The key is the source's identity; the memory key changes with it.
  }, [sourceKey, pageMemoryKey]);

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
  const sideWidth = pageSides?.width ?? 0;
  const renderedScale = useMemo(() => {
    if (!fitPage) return zoom;
    const pane = contentRef.current;
    const d = pageDims?.[0];
    if (!pane || !d || pane.clientWidth <= 0 || pane.clientHeight <= 0) return zoom;
    const PAD = paneChrome ? 6 : 24; // breathing room around the page
    // The margin rails flank each page in-flow; subtract them so the page
    // never overflows horizontally. A pane draws none.
    const rails = paneChrome ? 0 : 2 * sideWidth;
    const byWidth = (pane.clientWidth - PAD * 2 - rails) / d.w;
    const fit = paneChrome ? byWidth : Math.min(byWidth, (pane.clientHeight - PAD * 2) / d.h);
    return Math.max(0.1, Math.min(fit, 6));
    // containerTick re-measures the pane on resize / sidebar / fullscreen;
    // loadState re-measures once the pane exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitPage, zoom, pageDims, sideWidth, containerTick, loadState, paneChrome]);

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

  // The page the slots are painted around. Scrolling a page at a time paints
  // at once; a jump of several pages (the rail's thumb dragged, a search hit)
  // waits until the page holds still for a moment. Painting every page a fast
  // drag passed over queued dozens of renders and froze the pane (10-01).
  const [paintPage, setPaintPage] = useState(1);
  const paintPageRef = useRef(1);
  useEffect(() => {
    const settle = () => { paintPageRef.current = page; setPaintPage(page); };
    if (Math.abs(page - paintPageRef.current) <= 1) { settle(); return; }
    const t = setTimeout(settle, 140);
    return () => clearTimeout(t);
  }, [page]);

  // The pages actually on screen, most visible first, by overlap with the
  // viewport. The rail's "current page" is a single point 40% down the
  // screen, which on a zoomed page can name the next page while the reader
  // is still on this one; the companion is told what is truly in view.
  const [visiblePages, setVisiblePages] = useState<{ page: number; share: number }[]>([]);
  // Pages in view that may still be waiting on their bytes show a spinner
  // in the blank paper until the canvas covers it.
  const visibleSet = useMemo(() => new Set(visiblePages.map((v) => v.page)), [visiblePages]);
  const slotBandsRef = useRef<{ top: number; bottom: number }[] | null>(null);
  useEffect(() => {
    slotBandsRef.current = slotTops && pageDims
      ? slotTops.map((top, i) => ({ top, bottom: top + pageDims[i].h * renderedScale }))
      : null;
  }, [slotTops, pageDims, renderedScale]);
  const visibleKeyRef = useRef('');
  const computeVisible = useCallback(() => {
    const el = contentRef.current;
    const bands = slotBandsRef.current;
    if (!el || !bands) return;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    const vh = Math.max(1, el.clientHeight);
    const seen: { page: number; share: number }[] = [];
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (b.bottom < top) continue;
      if (b.top > bottom) break;
      const overlap = Math.min(b.bottom, bottom) - Math.max(b.top, top);
      if (overlap > 0) seen.push({ page: i + 1, share: overlap / vh });
    }
    seen.sort((a, b) => b.share - a.share);
    const pick = seen.filter((s) => s.share >= 0.15).slice(0, 2);
    // Shares are coarsened so a scroll of a few pixels does not re-render.
    const key = pick.map((s) => `${s.page}:${Math.round(s.share * 20)}`).join(',');
    if (key !== visibleKeyRef.current) {
      visibleKeyRef.current = key;
      setVisiblePages(pick.map((s) => ({ page: s.page, share: Math.round(s.share * 20) / 20 })));
    }
  }, []);
  useEffect(() => {
    if (loadState !== 'ready') return;
    const frame = requestAnimationFrame(computeVisible);
    return () => cancelAnimationFrame(frame);
  }, [page, slotTops, loadState, computeVisible]);

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

  // The rail's drag: a fraction of the document's scroll range → a scroll
  // position. The thumb follows the scroll itself (PageRail), so moving it
  // does not re-render the whole reader every frame.
  const seekTo = useCallback((f: number) => {
    const el = contentRef.current;
    if (!el) return;
    el.scrollTo({ top: Math.min(1, Math.max(0, f)) * Math.max(0, el.scrollHeight - el.clientHeight) });
  }, []);

  // Derive the current page while the user scrolls: the page whose band
  // holds the point 40% down the viewport.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || loadState !== 'ready') return;
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
        computeVisible();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [loadState, computeVisible]);

  // Restore the last-read page — or honor a ?page= deep link (the in-app
  // assistant opens documents to a cited page) — once the stack can be
  // measured, exactly once per document.
  useEffect(() => {
    if (restoredRef.current || !slotTops || loadState !== 'ready') return;
    restoredRef.current = true;
    // ?page= belongs to the route's own Reader: the host hands it in only
    // there. An embedded one (a canvas card, the desk's pane) shares the URL
    // with its host and is steered by the `goto` prop instead.
    const linked = pageLink ? pageLink.page : NaN;
    const saved = parseInt((pageMemoryKey ? localStorage.getItem(pageMemoryKey) : null) ?? '', 10);
    const target = Number.isFinite(linked) && linked >= 1 ? linked
      : Number.isFinite(saved) && saved >= 1 ? saved
      : 1;
    if (target > 1) gotoPage(target);
  }, [slotTops, loadState, pageMemoryKey, pageLink, gotoPage]);

  // Follow later deep links on the SAME mounted document (query-only
  // change, no remount). The route's Reader only, as above.
  useEffect(() => {
    if (!pageLink) return;
    if (!restoredRef.current) return; // the restore effect takes the first
    const p = pageLink.page;
    if (Number.isFinite(p) && p >= 1 && totalPages > 0) gotoPage(p);
  }, [pageLink, totalPages, gotoPage]);

  // When the geometry changes under the reader — zoom, fit toggle, pane
  // resize, or the dims sweep correcting slot heights — re-anchor to the
  // page being read instead of drifting to wherever the old offsets land.
  useEffect(() => {
    if (!slotTops || loadState !== 'ready') return;
    if (!restoredRef.current) return;
    if (!anchorReadyRef.current) { anchorReadyRef.current = true; return; }
    const el = contentRef.current;
    if (el) el.scrollTo({ top: Math.max(0, slotTops[pageStateRef.current - 1] - 8) });
  }, [slotTops, loadState]);

  // Remember where the reader stands, for next time this document opens.
  useEffect(() => {
    if (loadState === 'ready' && pageMemoryKey && page >= 1) {
      localStorage.setItem(pageMemoryKey, String(page));
    }
  }, [page, pageMemoryKey, loadState]);

  // The dims sweep: real per-page sizes, replacing the page-1 stand-in.
  // Cheap relative to the thumbnail strip, which renders every page.
  useEffect(() => {
    if (loadState !== 'ready') return;
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
  }, [loadState, sourceKey]);

  // Search hits, drawn as boxes over the words. Each occurrence of the
  // query in a rendered text layer becomes a Range; its client rects,
  // taken relative to the page box, become positioned divs in the slot's
  // hit overlay — so a hit is the word, not the span it sits in, and the
  // boxes ride along when the page is zoomed. The current match is marked,
  // and scrolled into view once, when the match changes.
  const matchesRef = useRef<Match[]>([]);
  const matchIdxRef = useRef(0);
  const searchQueryRef = useRef('');
  const scrollToMatchRef = useRef(-1);
  const paintHits = useCallback((p: number): HTMLElement | null => {
    const layer = textLayerRefs.current[p - 1];
    const hits = hitLayerRefs.current[p - 1];
    if (!layer || !hits) return null;
    hits.replaceChildren();
    const q = searchQueryRef.current.trim().toLowerCase();
    if (!q) return null;
    const re = phraseRegex(q);
    const onPage = matchesRef.current.map((m, i) => ({ ...m, i })).filter((m) => m.page === p);
    if (!onPage.length) return null;
    const currentOrdinal = onPage.findIndex((m) => m.i === matchIdxRef.current);
    const box = layer.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    let ordinal = 0;
    let currentEl: HTMLElement | null = null;
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const hay = node.textContent ?? '';
      re.lastIndex = 0;
      for (let m = re.exec(hay); m; m = re.exec(hay)) {
        const at = m.index;
        if (!m[0].length) { re.lastIndex += 1; continue; }
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + m[0].length);
        const isCurrent = ordinal === currentOrdinal;
        for (const r of Array.from(range.getClientRects())) {
          if (!r.width || !r.height) continue;
          const el = document.createElement('div');
          el.className = isCurrent ? 'search-hit current' : 'search-hit';
          el.style.left = `${((r.left - box.left) / box.width) * 100}%`;
          el.style.top = `${((r.top - box.top) / box.height) * 100}%`;
          el.style.width = `${(r.width / box.width) * 100}%`;
          el.style.height = `${(r.height / box.height) * 100}%`;
          hits.appendChild(el);
          if (isCurrent && !currentEl) currentEl = el;
        }
        ordinal += 1;
      }
    }
    return currentEl;
  }, []);
  const revealIfCurrent = useCallback((el: HTMLElement | null) => {
    if (!el || scrollToMatchRef.current < 0 || scrollToMatchRef.current !== matchIdxRef.current) return;
    scrollToMatchRef.current = -1;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);
  useEffect(() => {
    matchesRef.current = matches;
    matchIdxRef.current = matchIdx;
    searchQueryRef.current = searchQuery;
    scrollToMatchRef.current = matches.length ? matchIdx : -1;
    for (const p of Array.from(renderedKeyRef.current.keys())) revealIfCurrent(paintHits(p));
  }, [matches, matchIdx, searchQuery, paintHits, revealIfCurrent]);

  // Paint the slots near the viewport; free the ones left far behind so a
  // long case never holds hundreds of live canvases. A page repaints only
  // when its render key (scale, highlight state) changes.
  useEffect(() => {
    if (loadState !== 'ready' || !pageDims) return;
    const pdf = pdfDocRef.current as {
      getPage(n: number): Promise<{
        getViewport(opts: { scale: number }): { width: number; height: number };
        render(opts: unknown): { promise: Promise<void>; cancel(): void };
        streamTextContent(): ReadableStream;
      }>;
    } | null;
    if (!pdf) return;

    let cancelled = false;
    const from = Math.max(1, paintPage - 2);
    const to = Math.min(totalPages, paintPage + 2);

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
      hitLayerRefs.current[p - 1]?.replaceChildren();
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
        guardTextLayerSelection(layerEl);
        renderTasksRef.current.delete(p);
        renderedKeyRef.current.set(p, key);
        revealIfCurrent(paintHits(p));
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
  }, [paintPage, totalPages, renderedScale, loadState, sourceKey, pageDims, searchQuery, matches, paintHits, revealIfCurrent]);

  // On unmount, stop whatever pdfjs still has in flight.
  useEffect(() => () => {
    for (const t of renderTasksRef.current.values()) {
      try { t.cancel(); } catch { /* settled */ }
    }
    renderTasksRef.current.clear();
  }, []);

  const goPrev = useCallback(() => gotoPage(pageStateRef.current - 1), [gotoPage]);
  const goNext = useCallback(() => gotoPage(pageStateRef.current + 1), [gotoPage]);

  // Which page a node sits on — for a host asking about the selection.
  const pageOfNode = useCallback((node: Node | null | undefined): number | undefined => {
    if (!node) return undefined;
    const i = textLayerRefs.current.findIndex((el) => !!el && el.contains(node));
    return i >= 0 ? i + 1 : undefined;
  }, []);

  // Fetch the PDF's outline (table of contents) once it loads. Many PDFs
  // don't have one — that's fine, we just hide the Contents tab.
  useEffect(() => {
    if (loadState !== 'ready') return;
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
  }, [loadState, sourceKey]);

  // Render the thumbnail strip sequentially. Each page rendered to an
  // offscreen canvas at low scale, captured as a data URL, and added to
  // the thumbnails state so the sidebar can show it.
  useEffect(() => {
    if (loadState !== 'ready') return;
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
  }, [loadState, sourceKey]);

  // The clips attached to this document. A failure is an empty list (the
  // table may not exist yet), so the book always opens.
  useEffect(() => {
    const src = sourceRef.current;
    if (!src) return;
    let cancelled = false;
    void src.listIllustrations().then((rows) => { if (!cancelled) setAnimations(rows); });
    return () => { cancelled = true; };
  }, [sourceKey]);

  // Esc gives up on drawing the rectangle.
  useEffect(() => {
    if (!attaching) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setAttaching(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [attaching]);

  // The chosen area of the page, cropped and turned — the attach dialog's
  // preview, drawn by the same renderer the page grid uses for its images.
  const makeAnimationPreview = useCallback(async (p: number, rect: FractionalRect, turn: Turn) => {
    const pdf = pdfDocRef.current as PDFDocumentProxy | null;
    if (!pdf) return null;
    try {
      const canvas = await renderPageCanvas(pdf, p, { width: 1000, maxEdge: 2000 });
      const blob = await canvasToBlob(rotateCanvas(cropCanvas(canvas, rect), turn), 'image/jpeg', 0.85);
      return URL.createObjectURL(blob);
    } catch (e) {
      console.warn('[animation preview] failed:', e instanceof Error ? e.message : e);
      return null;
    }
  }, []);

  const removeAnimation = useCallback(async (animationId: string) => {
    const src = sourceRef.current;
    if (!src?.removeIllustration) return;
    try {
      await src.removeIllustration(animationId);
    } catch {
      return; // the clip stays; nothing to say on the page
    }
    setAnimations((prev) => prev.filter((a) => a.id !== animationId));
  }, []);

  // The Workshop bench for this document. A failure is an empty bench.
  useEffect(() => {
    if (!bench) { setWorkshopItems([]); return; }
    let cancelled = false;
    void bench.list().then((rows) => { if (!cancelled) setWorkshopItems(rows); }, () => { if (!cancelled) setWorkshopItems([]); });
    return () => { cancelled = true; };
  }, [bench]);
  useEffect(() => {
    if (!workshopNotice) return;
    const t = window.setTimeout(() => setWorkshopNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [workshopNotice]);
  // Esc gives up on the snip rectangle too.
  useEffect(() => {
    if (!snipping) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setSnipping(false);
      setResnip(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [snipping]);

  const workshopFail = useCallback((e: unknown, fallback: string) => {
    setWorkshopNotice(e instanceof Error ? e.message : fallback);
  }, []);

  // A rectangle drawn in snip mode: a new snip, the redrawn rectangle of an
  // existing one (crop), or where a passage's clip should play (a snippet
  // being placed on the page).
  const landSnip = useCallback(async (p: number, rect: FractionalRect) => {
    if (!bench) return;
    try {
      if (resnip) {
        const updated = await bench.update(resnip.id, { page: p, rect });
        setWorkshopItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
      } else {
        const made = await bench.createSnip({ page: p, rect });
        setWorkshopItems((prev) => [...prev, made]);
      }
    } catch (e) {
      workshopFail(e, 'The snip was not kept.');
    } finally {
      setResnip(null);
    }
  }, [bench, resnip, workshopFail]);

  // The snip as a PNG at the chosen size, for Flow or Midjourney.
  const downloadSnip = useCallback(async (item: WorkshopItem, scale: 1 | 2 | 3) => {
    const pdf = pdfDocRef.current as PDFDocumentProxy | null;
    if (!pdf || !item.rect) return;
    try {
      const canvas = await renderPageCanvas(pdf, item.page, { width: 1200 * scale, maxEdge: 1600 * scale });
      const blob = await canvasToBlob(rotateCanvas(cropCanvas(canvas, item.rect), item.turn), 'image/png');
      const base = (meta?.title || 'plate').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'plate';
      downloadBlob(blob, `${base} p${item.page} snip.png`);
    } catch (e) {
      workshopFail(e, 'The snip could not be drawn.');
    }
  }, [meta?.title, workshopFail]);

  // The snip onto the clipboard as a PNG (2×), so it can be pasted straight
  // into a generator's prompt box — none of them take a file from another
  // site, all of them take a paste. Safari wants the blob as a promise made
  // inside the gesture; Chrome takes either.
  const copySnip = useCallback(async (item: WorkshopItem) => {
    const pdf = pdfDocRef.current as PDFDocumentProxy | null;
    if (!pdf || !item.rect) return;
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      setWorkshopNotice('This browser cannot copy pictures; use Download instead.');
      return;
    }
    try {
      const png = (async () => {
        const canvas = await renderPageCanvas(pdf, item.page, { width: 2400, maxEdge: 3200 });
        return canvasToBlob(rotateCanvas(cropCanvas(canvas, item.rect!), item.turn), 'image/png');
      })();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      setWorkshopNotice('Copied. Paste it into Flow, Midjourney, Runway, Grok or ChatGPT (Ctrl/⌘-V).');
    } catch (e) {
      workshopFail(e, 'The snip could not be copied; use Download instead.');
    }
  }, [workshopFail]);

  // A clip or a still brought back: kept by the store (filed in the matter,
  // or in the editions bucket), and set on the bench under its source.
  const bringIn = useCallback(async (parent: WorkshopItem | null, file: File) => {
    if (!bench) return;
    try {
      const { item, notice: said } = await bench.bringIn(parent, file, parent?.page ?? page);
      setWorkshopItems((prev) => [...prev, item]);
      setWorkshopNotice(said ?? `"${file.name}" is on the bench.`);
    } catch (e) {
      workshopFail(e, 'The file could not be brought in.');
    }
  }, [bench, page, workshopFail]);

  // The decision: the media item laid on the page where its plate sits
  // (062), upright per the snip's turn.
  const layOnPage = useCallback(async (media: WorkshopItem, source: WorkshopItem) => {
    if (!bench || !source.rect || !media.media_document_id) return;
    try {
      const animation = await bench.lay(media, source);
      setAnimations((prev) => [...prev, animation]);
      setWorkshopNotice(`Laid on page ${source.page}. A reader taps the plate and it plays.`);
    } catch (e) {
      workshopFail(e, 'It could not be laid on the page.');
    }
  }, [bench, workshopFail]);

  const workshop: WorkshopPanelProps | null = bench ? {
    page,
    items: workshopItems,
    snipping,
    selection: selectionMenu?.anchorText?.trim()
      ? { text: selectionMenu.anchorText.trim(), page: selectionMenu.page, rect: unionRect(selectionMenu.rects) }
      : null,
    canWrite: bench.canWrite,
    notice: workshopNotice,
    onSnip: () => { setResnip(null); setAttaching(false); setSnipping(true); },
    onCancelSnip: () => { setSnipping(false); setResnip(null); },
    onSnippet: async (text: string, at: { page: number; rect: FractionalRect | null } | null) => {
      try {
        const made = await bench.createSnippet({ page: at?.page ?? page, text, rect: at?.rect ?? null });
        setWorkshopItems((prev) => [...prev, made]);
      } catch (e) { workshopFail(e, 'The snippet was not kept.'); }
    },
    makePreview: makeAnimationPreview,
    onDownload: downloadSnip,
    onCopy: copySnip,
    onTurn: async (item: WorkshopItem) => {
      try {
        const updated = await bench.update(item.id, { turn: nextTurn(item.turn) });
        setWorkshopItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
      } catch (e) { workshopFail(e, 'The turn was not kept.'); }
    },
    onRetext: async (item: WorkshopItem, text: string) => {
      try {
        const updated = await bench.update(item.id, { text });
        setWorkshopItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
      } catch (e) { workshopFail(e, 'The passage was not kept.'); }
    },
    onResnip: (item: WorkshopItem) => { setResnip(item); setAttaching(false); setSnipping(true); gotoPage(item.page); },
    onAdopt: async (media: WorkshopItem, source: WorkshopItem) => {
      try {
        const updated = await bench.update(media.id, { parent_id: source.id, page: source.page });
        setWorkshopItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
      } catch (e) { workshopFail(e, 'The clip was not moved.'); }
    },
    onDelete: async (item: WorkshopItem) => {
      try {
        await bench.remove(item.id);
      } catch (e) {
        workshopFail(e, 'It could not be taken off the bench.');
        return;
      }
      setWorkshopItems((prev) => prev.filter((it) => it.id !== item.id && it.parent_id !== item.id));
    },
    onBringIn: bringIn,
    onLayOnPage: layOnPage,
    onJumpPage: (p: number) => gotoPage(p),
  } : null;

  // Load the marks once per document, and keep them live: margin notes are
  // collaborative, so a teammate's note should appear without a reload
  // (the store's subscription; RLS filters what each subscriber may see).
  const reloadMarks = useCallback(async () => {
    if (!marks) return;
    const rows = await marks.list();
    setAnnotations(rows);
  }, [marks]);
  useEffect(() => {
    if (!marks || loadState !== 'ready') return;
    let cancelled = false;
    const refresh = async () => {
      const rows = await marks.list();
      if (!cancelled) setAnnotations(rows);
    };
    void refresh();
    const unsubscribe = marks.subscribe?.(() => { void refresh(); });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [marks, loadState]);
  useEffect(() => { onMarksRef.current?.(annotations); }, [annotations]);

  // Watch text-layer selections — when the user releases the mouse after
  // selecting text inside the current page, capture the rectangles in
  // page-fractional coordinates so we can persist a highlight that scales
  // cleanly to any zoom level.
  useEffect(() => {
    if (loadState !== 'ready') return;

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
  }, [loadState]);

  // A click on one of the reader's own highlights opens a small menu on it:
  // recolour, or take it back. This is how an old highlight is removed —
  // the × drawn on the box never showed on hover, because the text layer
  // (which must stay on top for selection) sits over the box and takes the
  // hover itself. A click is a press and release within a few pixels; a
  // drag is a selection and belongs to the effect above. Where highlights
  // overlap, the newest is the one meant.
  const [markMenu, setMarkMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const annotationsRef = useRef<Annotation[]>([]);
  annotationsRef.current = annotations;
  useEffect(() => {
    if (loadState !== 'ready') return;
    const uid = currentUserId;
    let downAt: { x: number; y: number } | null = null;
    function onDown(e: MouseEvent) {
      downAt = { x: e.clientX, y: e.clientY };
    }
    function onUp(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[data-mark-menu]')) return;
      const start = downAt;
      downAt = null;
      if (!start || Math.abs(e.clientX - start.x) > 4 || Math.abs(e.clientY - start.y) > 4) {
        setMarkMenu(null);
        return;
      }
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) { setMarkMenu(null); return; }
      let hit: { id: string; top: number } | null = null;
      for (let i = 0; i < textLayerRefs.current.length; i++) {
        const el = textLayerRefs.current[i];
        if (!el) continue;
        const box = el.getBoundingClientRect();
        if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) continue;
        const fx = (e.clientX - box.left) / box.width;
        const fy = (e.clientY - box.top) / box.height;
        const onPage = annotationsRef.current.filter(
          (a) => a.page === i + 1 && !annotationIsNote(a) && (uid == null || a.user_id === uid),
        );
        for (let k = onPage.length - 1; k >= 0 && !hit; k--) {
          const a = onPage[k];
          const r = a.rects.find((q) => fx >= q.x && fx <= q.x + q.w && fy >= q.y && fy <= q.y + q.h);
          if (r) hit = { id: a.id, top: box.top + Math.min(...a.rects.map((q) => q.y)) * box.height };
        }
        break;
      }
      setMarkMenu(hit ? { id: hit.id, x: e.clientX, y: hit.top } : null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMarkMenu(null);
    }
    const scroller = contentRef.current;
    const onScroll = () => setMarkMenu(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onKey);
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onKey);
      scroller?.removeEventListener('scroll', onScroll);
    };
  }, [loadState, currentUserId]);

  const recolorAnnotation = useCallback(async (annId: string, color: AnnotationColor) => {
    if (!marks) return;
    const ok = await marks.update(annId, { color });
    if (ok) setAnnotations((prev) => prev.map((a) => (a.id === annId ? { ...a, color } : a)));
    setMarkMenu(null);
  }, [marks]);

  const saveAnnotation = useCallback(
    async (color: AnnotationColor) => {
      if (!marks || !selectionMenu) return;
      const ann = await marks.create({
        page: selectionMenu.page,
        color,
        rects: selectionMenu.rects,
        anchorText: selectionMenu.anchorText,
      });
      if (ann) {
        setAnnotations((prev) => [...prev, ann]);
        // A highlight is easy to regret and, until now, hard to take back:
        // the × on it shows on hover, which a finger never does. Offer undo
        // for a moment, and keep the order for Ctrl/⌘-Z.
        createdRef.current.push(ann.id);
        setUndoDepth(createdRef.current.length);
        setUndoable({ id: ann.id, color, at: Date.now() });
      }
      // Clear selection + popover regardless of success.
      window.getSelection()?.removeAllRanges();
      setSelectionMenu(null);
    },
    [marks, selectionMenu],
  );

  const removeAnnotation = useCallback(async (annId: string) => {
    if (!marks) return;
    const ok = await marks.remove(annId);
    if (ok) {
      setAnnotations((prev) => prev.filter((a) => a.id !== annId));
      createdRef.current = createdRef.current.filter((x) => x !== annId);
      setUndoDepth(createdRef.current.length);
      setUndoable((u) => (u?.id === annId ? null : u));
    }
  }, [marks]);

  // Undo: the last highlight made in this sitting. The toast offers it for
  // eight seconds after each highlight — too short to be found by someone
  // still looking at the words they marked — so the toolbar also carries an
  // Undo button for as long as there is a highlight to take back, and
  // Ctrl-Z / ⌘-Z takes them back in order for as long as the reader stays
  // open. `undoDepth` mirrors the ref so the button can render.
  const createdRef = useRef<string[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);
  const [undoable, setUndoable] = useState<{ id: string; color: AnnotationColor; at: number } | null>(null);
  useEffect(() => {
    if (!undoable) return;
    const t = window.setTimeout(() => setUndoable((u) => (u?.at === undoable.at ? null : u)), 8000);
    return () => window.clearTimeout(t);
  }, [undoable]);
  const undoLastHighlight = useCallback(() => {
    const last = createdRef.current[createdRef.current.length - 1];
    if (last) void removeAnnotation(last);
  }, [removeAnnotation]);

  // Stable handlers for the memoized page slots — the stack re-renders on
  // every derived-page change while scrolling, and these keep the hundreds
  // of untouched slots from re-rendering with it.
  const removeAnnotationCb = useCallback((annId: string) => {
    void removeAnnotation(annId);
  }, [removeAnnotation]);
  const setCanvasEl = useCallback((p: number, el: HTMLCanvasElement | null) => {
    canvasRefs.current[p - 1] = el;
  }, []);
  const setHitLayerEl = useCallback((p: number, el: HTMLDivElement | null) => {
    hitLayerRefs.current[p - 1] = el;
  }, []);
  const setTextLayerEl = useCallback((p: number, el: HTMLDivElement | null) => {
    textLayerRefs.current[p - 1] = el;
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
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        if (createdRef.current.length) { e.preventDefault(); undoLastHighlight(); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext, toggleFullscreen, undoLastHighlight]);

  // ────────────────────────────────────────────────────────────────────
  // Search. On submit, ask the source's index first, then scan every
  // page's text content for the query (caching results per page), collect
  // matches, navigate to the first hit, and highlight matching tokens in
  // the text layer.
  // ────────────────────────────────────────────────────────────────────
  // The query the current `matches` answer, and a counter so a slow PDF
  // search that a newer keystroke has overtaken drops its answer.
  const searchedQueryRef = useRef('');
  const searchSeqRef = useRef(0);
  const runSearch = useCallback(async (query: string) => {
    const q = query.trim();
    const seq = ++searchSeqRef.current;
    searchedQueryRef.current = q;
    if (!q) {
      setSearching(false);
      setMatches([]);
      setMatchIdx(0);
      setSearched(false);
      return;
    }
    const pdf = pdfDocRef.current as
      | { numPages: number; getPage(n: number): Promise<unknown> }
      | null;
    if (!pdf) return;

    setSearching(true);
    // A phrase matches across any whitespace: a transcript's text is broken
    // by line ("individual\nstudents"), and the brief quotes it in one line.
    const re = phraseRegex(q);
    const found: Match[] = [];
    const countIn = (text: string, page: number) => {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        found.push({ page, index: m.index });
        if (!m[0].length) re.lastIndex += 1;
      }
    };

    try {
      // The indexed text first. It is what search reads everywhere else in
      // the app, it is one query, and for most OCR'd books it is the only
      // place the words exist: the scan's PDF carries no text layer at all
      // (Brandeis's Other People's Money found nothing for "money"). Hits
      // name the page; the boxes over the words come from the text layer
      // when the page has one.
      const src = sourceRef.current;
      if (src?.findInIndex) {
        for (const hit of await src.findInIndex(q)) found.push(hit);
      }

      // Nothing indexed — an edited copy, say — so read the PDF's own text
      // layer, page by page.
      if (!found.length) {
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
          countIn(pageText, p);
        }
      }
    } catch (e) {
      console.warn('[reader] find failed', e);
    }
    if (seq !== searchSeqRef.current) return; // overtaken by a newer query
    found.sort((a, b) => a.page - b.page || a.index - b.index);

    setMatches(found);
    setMatchIdx(0);
    setSearching(false);
    setSearched(true);
    if (found.length > 0) gotoPage(found[0].page);
  }, [gotoPage]);

  // A query typed but not yet searched is searched first: the arrows (and
  // Enter) never sit dead beside words in the box (Eden, 10-01: typed a word,
  // clicked the arrow, nothing happened).
  const unsearched = () => searchQuery.trim() !== searchedQueryRef.current;
  const goNextMatch = useCallback(() => {
    if (searchQuery.trim() !== searchedQueryRef.current) { void runSearch(searchQuery); return; }
    if (matches.length === 0) return;
    const next = (matchIdx + 1) % matches.length;
    setMatchIdx(next);
    gotoPage(matches[next].page);
  }, [matchIdx, matches, gotoPage, searchQuery, runSearch]);
  const goPrevMatch = useCallback(() => {
    if (searchQuery.trim() !== searchedQueryRef.current) { void runSearch(searchQuery); return; }
    if (matches.length === 0) return;
    const next = (matchIdx - 1 + matches.length) % matches.length;
    setMatchIdx(next);
    gotoPage(matches[next].page);
  }, [matchIdx, matches, gotoPage, searchQuery, runSearch]);
  // Search as you type, once the typing pauses.
  useEffect(() => {
    if (!searchOpen) return;
    if (searchQuery.trim() === searchedQueryRef.current) return;
    const t = setTimeout(() => { void runSearch(searchQuery); }, 450);
    return () => clearTimeout(t);
  }, [searchOpen, searchQuery, runSearch]);
  const closeSearch = useCallback(() => {
    searchSeqRef.current++;
    searchedQueryRef.current = '';
    setSearching(false);
    setSearchOpen(false);
    setSearchQuery('');
    setMatches([]);
    setMatchIdx(0);
    setSearched(false);
  }, []);

  // The host's `goto` (see PdfBookGoto). Declared after the restore effect,
  // so on first load the goto wins over the remembered page. Applied once per
  // nonce, as soon as the page stack is measured.
  const appliedGotoRef = useRef<number | null>(null);
  useEffect(() => {
    if (!goto || appliedGotoRef.current === goto.nonce || loadState !== 'ready') return;
    if (!slotTops || totalPages === 0) return;
    appliedGotoRef.current = goto.nonce;
    const target = goto.page ?? null;
    const phrase = goto.phrase ?? null;
    if (target) gotoPage(target);
    // The passage's opening words, lit through the find path. The page is
    // the promise; the boxes are a bonus — a PDF's text layer is split by
    // line, and the paint finds a phrase only within one line.
    if (phrase && target) {
      setSearchOpen(true);
      setSearchQuery(phrase);
      setMatches([{ page: target, index: 0 }]);
      setMatchIdx(0);
    }
  }, [goto, loadState, slotTops, totalPages, gotoPage]);

  // What the reader sees, for the host (its companion, its title bar).
  useEffect(() => {
    onViewRef.current?.({ state: loadState, page, totalPages, visiblePages });
  }, [loadState, page, totalPages, visiblePages]);

  useImperativeHandle(ref, () => ({
    gotoPage,
    pageOfNode,
    reloadMarks,
    removeMark: removeAnnotation,
  }), [gotoPage, pageOfNode, reloadMarks, removeAnnotation]);

  // ────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────
  const rootBg = theme === 'dark' ? '#000000' : '#f3ecd9';
  const showBottomNav = loadState === 'ready' && totalPages > 0;
  const sides = paneChrome ? null : pageSides;

  // The clips' bytes: the source's own door when it has one (an edition),
  // the vault's otherwise — for the page's players and the bench's rows alike.
  const vaultMediaUrl = useMediaUrl();
  const mediaUrl = source?.mediaUrl ?? vaultMediaUrl;

  return (
    <MediaUrlProvider value={mediaUrl}>
    <div
      ref={rootRef}
      className="flex flex-col h-full"
      style={{ backgroundColor: rootBg }}
    >
      <PdfBookStyle theme={theme} />

      {loadState === 'ready' && header}

      <div className="flex items-center justify-between gap-2 px-3 h-12 overflow-hidden border-b border-[var(--color-border)] bg-[var(--color-surface)] backdrop-blur-md shrink-0">
        {/* On a phone the find box takes the row. The title's node stays —
            its text is set by hand, not by React — and is only hidden. */}
        <div className={`flex items-center gap-2 min-w-0 flex-1 ${isMobile && searchOpen ? 'hidden' : ''}`}>
          {/* On a phone this is the only way out, so it reads as one: an
              arrow, named Back. On a laptop, the X it has always been. */}
          <button
            onClick={onClose}
            className={`${isMobile ? 'h-9 w-9' : 'h-8 w-8'} inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white`}
            title={isMobile ? 'Back' : 'Close'}
            aria-label={isMobile ? 'Back' : 'Close'}
          >
            {isMobile ? <ArrowLeft size={19} /> : <X size={15} />}
          </button>
          {!hideSidebarToggle && (
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
          {/* The bench lives in the sidebar's fourth tab, where nobody found
              it. This opens the sidebar straight onto it — in a pane too,
              where the sidebar otherwise stays shut, since the bench is the
              reason to open it there. Not on a phone: the 360px bench would
              leave no page beside it. */}
          {workshop && loadState === 'ready' && !isMobile && (
            <button
              onClick={() => {
                if (sidebarOpen && sidebarTab === 'workshop') { setSidebarOpen(false); return; }
                setSidebarTab('workshop');
                setSidebarOpen(true);
              }}
              className={`h-8 px-2 inline-flex items-center gap-1.5 rounded-md hover:bg-white/5 text-xs shrink-0 ${
                sidebarOpen && sidebarTab === 'workshop' ? 'text-[var(--color-primary)]' : 'text-white/70 hover:text-white'
              }`}
              title="Workshop: snip, snippets, bring in, lay on page"
            >
              <Hammer size={15} />
              <span>Workshop</span>
            </button>
          )}
          {/* Takes back the last highlight made in this sitting, newest
              first; appears with the first one and goes when none is left. */}
          {undoDepth > 0 && (
            <button
              onClick={undoLastHighlight}
              className="h-8 px-2 inline-flex items-center gap-1.5 rounded-md hover:bg-white/5 text-xs shrink-0 text-white/70 hover:text-white"
              title={`Undo the last highlight (${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'}Z)`}
              aria-label="Undo the last highlight"
            >
              <Undo2 size={15} />
              {!isMobile && <span>Undo</span>}
            </button>
          )}
          {title}
        </div>
        <div className={`flex items-center gap-1 ${isMobile && searchOpen ? 'flex-1 min-w-0' : 'shrink-0'}`}>
          {searchOpen ? (
            <FindBox
              query={searchQuery}
              onQuery={setSearchQuery}
              searching={searching}
              matchCount={matches.length}
              matchIdx={matchIdx}
              searched={searched}
              stepDisabled={matches.length === 0 && !unsearched()}
              onPrev={goPrevMatch}
              onNext={goNextMatch}
              onClose={closeSearch}
              isMobile={isMobile}
            />
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
          {!(isMobile && searchOpen) && (
          <>
          {toolbarStart}
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
            {fitPage ? 'Fit' : `${Math.round(zoom * 100)}%`}
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
          {!isMobile && (
          <>
          <button
            onClick={() => setFitPage((v) => !v)}
            className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 ${
              fitPage ? 'text-[var(--color-primary)]' : 'text-white/70 hover:text-white'
            }`}
            title={fitPage ? 'Fit page is on — whole page visible' : 'Fit whole page to screen'}
          >
            <Scan size={15} />
          </button>
          <button
            onClick={toggleFullscreen}
            className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 ${
              isFullscreen ? 'text-[var(--color-primary)]' : 'text-white/70 hover:text-white'
            }`}
            title={isFullscreen ? 'Exit full screen (F)' : 'Full screen (F)'}
          >
            {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
          {toolbarEnd}
          <button
            onClick={() => setTheme((t) => (t === 'parchment' ? 'dark' : 'parchment'))}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
            title={theme === 'parchment' ? 'Dark mode' : 'Light mode'}
          >
            {theme === 'parchment' ? <Moon size={15} /> : <Sun size={15} />}
          </button>
          </>
          )}
          {isMobile && (
            <PhoneMore
              items={[
                { icon: <Scan size={14} />, label: fitPage ? '✓ Fit the whole page' : 'Fit the whole page', run: () => setFitPage((v) => !v) },
                { icon: isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />, label: isFullscreen ? 'Exit full screen' : 'Full screen', run: toggleFullscreen },
                ...(moreItems ?? []),
                { icon: theme === 'parchment' ? <Moon size={14} /> : <Sun size={14} />, label: theme === 'parchment' ? 'Dark mode' : 'Light mode', run: () => setTheme((t) => (t === 'parchment' ? 'dark' : 'parchment')) },
              ]}
            />
          )}
          </>
          )}
        </div>
      </div>

      {banners}

      <div className="flex-1 flex flex-row min-h-0">
        {sidebarOpen && loadState === 'ready' && (
          <ReaderSidebar
            totalPages={totalPages}
            currentPage={page}
            thumbnails={thumbnails}
            outline={outline}
            onJumpPage={(p) => gotoPage(p)}
            onJumpDest={(d) => void jumpDest(d)}
            animations={animations}
            onAddAnimation={renderAttach ? () => { setSnipping(false); setAttaching(true); } : null}
            onRemoveAnimation={(animationId) => void removeAnimation(animationId)}
            addingAnimation={attaching}
            workshop={workshop}
            tab={sidebarTab}
            onTabChange={setSidebarTab}
          />
        )}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="relative flex-1 min-h-0 flex" onContextMenu={onContextMenu}>
          {/* While a rectangle is being drawn the page is a crosshair canvas
              and text cannot be selected; say so on the page itself, with a
              way out, rather than only in the sidebar (which may be closed,
              or not where the eye is). */}
          {(snipping || attaching) && (
            <div
              role="status"
              className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-3 py-2 rounded-lg bg-[#1a1a22] border border-[#e8b84a]/60 shadow-2xl text-[12px] text-white/85"
            >
              <Scan size={14} className="text-[#e8b84a] shrink-0" />
              <span>
                {attaching
                  ? 'Drag a rectangle round the picture — the clip will play there.'
                  : resnip?.kind === 'snippet'
                    ? 'Drag a rectangle round the passage — its clip will play there.'
                    : resnip
                      ? 'Drag the rectangle again round the plate.'
                      : 'Drag a rectangle round the plate to snip it.'}
                {' '}Text cannot be selected meanwhile.
              </span>
              <button
                onClick={() => { setSnipping(false); setResnip(null); setAttaching(false); }}
                className="font-semibold text-[#e8b84a] hover:underline shrink-0"
                title="Stop drawing (Esc)"
              >
                Stop
              </button>
            </div>
          )}
          <div
            ref={contentRef}
            className={`reader-scroll flex-1 overflow-auto flex justify-center items-start ${paneChrome ? 'py-2 px-[6px]' : 'py-6 px-4'}`}
            style={{ backgroundColor: rootBg }}
            // A selection copied off the PDF text layer would otherwise carry
            // the layer's own paint — transformed spans, transparent ink,
            // search-highlight color — into Word. Hand the clipboard the text.
            onCopy={(e) => interceptStyledCopy(e, stackRef.current)}
          >
            {loadState === 'loading' && !notice && (
              <LoadingCard title={meta?.title ?? null} progress={loadProgress} pageCount={meta?.pageCount ?? null} />
            )}
            {notice}
            {loadState === 'ready' && pageDims && (
              <div ref={stackRef} className="flex flex-col items-center">
                {pageDims.map((d, i) => (
                  <PageSlot
                    key={i + 1}
                    p={i + 1}
                    w={d.w * renderedScale}
                    h={d.h * renderedScale}
                    pending={visibleSet.has(i + 1)}
                    annotations={annotations}
                    animations={animations}
                    attachMode={attaching || snipping}
                    onAreaChosen={(chosenPage, rect) => {
                      if (snipping) {
                        setSnipping(false);
                        void landSnip(chosenPage, rect);
                        return;
                      }
                      setAttaching(false);
                      setPendingArea({ page: chosenPage, rect });
                    }}
                    sides={sides}
                    setCanvasEl={setCanvasEl}
                    setTextLayerEl={setTextLayerEl}
                    setHitLayerEl={setHitLayerEl}
                    onRemove={removeAnnotationCb}
                  />
                ))}
              </div>
            )}
          </div>
          {loadState === 'ready' && totalPages > 1 && (
            <PageRail
              page={page}
              total={totalPages}
              scroller={contentRef}
              theme={theme}
              onSeek={seekTo}
            />
          )}
          {paneChildren}
          {undoable && (
            <div
              role="status"
              className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-3 py-2 rounded-lg bg-[#1a1a22] border border-white/15 shadow-2xl text-[12px] text-white/85"
            >
              <span>Highlighted in {undoable.color}.</span>
              <button
                onClick={() => void removeAnnotation(undoable.id)}
                className="font-semibold text-[#e8b84a] hover:underline"
              >
                Undo
              </button>
              <button
                onClick={() => setUndoable(null)}
                className="text-white/45 hover:text-white"
                aria-label="Dismiss"
              >
                ×
              </button>
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
      {pendingArea && renderAttach && renderAttach({
        page: pendingArea.page,
        rect: pendingArea.rect,
        makePreview: makeAnimationPreview,
        onSaved: (animation) => {
          setAnimations((prev) => [...prev, animation]);
          setPendingArea(null);
        },
        onClose: () => setPendingArea(null),
      })}
      {markMenu && !selectionMenu && (() => {
        const mark = annotations.find((a) => a.id === markMenu.id);
        return mark ? (
          <MarkMenu
            x={markMenu.x}
            y={markMenu.y}
            color={mark.color}
            onPick={(c) => void recolorAnnotation(mark.id, c)}
            onRemove={() => { setMarkMenu(null); void removeAnnotation(mark.id); }}
          />
        ) : null;
      })()}
      {selectionMenu && (
        <SelectionMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          onAsk={onAsk ? () => {
            onAsk(selectionMenu.anchorText, selectionMenu.page);
            window.getSelection()?.removeAllRanges();
            setSelectionMenu(null);
          } : undefined}
          onPick={(c) => void saveAnnotation(c)}
          onCopy={onCopySelection ?? (() => void quietCopySelection())}
          onNote={onNote ? () => {
            onNote(selectionMenu);
            window.getSelection()?.removeAllRanges();
            setSelectionMenu(null);
          } : undefined}
          onCancel={() => {
            window.getSelection()?.removeAllRanges();
            setSelectionMenu(null);
          }}
        />
      )}
      {children}
    </div>
    </MediaUrlProvider>
  );
}

// The selection menu's Copy where the host offers no reporting of its own:
// the browser's own copy command first. It runs synchronously inside the
// click, needs no clipboard permission, and takes exactly the path Ctrl+C
// takes — the PDF intercept on the pane. The async Clipboard API is the
// fallback, not the route.
async function quietCopySelection() {
  const sel = window.getSelection();
  const text = sel?.toString() ?? '';
  if (!text.trim()) return;
  let native = false;
  try {
    native = document.execCommand('copy');
  } catch {
    native = false;
  }
  if (native) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* the host's toolbar copy says why when it is refused; the popover stays quiet */
  }
}

// The phone toolbar's "more" button and its menu, with the book's own items
// around the host's.
function PhoneMore({ items }: { items: MoreItem[] }) {
  const [moreOpen, setMoreOpen] = useState(false);
  // The button element, held in state so the menu can be placed from its
  // rectangle during render.
  const [moreBtn, setMoreBtn] = useState<HTMLButtonElement | null>(null);
  return (
    <div className="relative">
      <button
        ref={setMoreBtn}
        onClick={() => setMoreOpen((v) => !v)}
        className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 ${
          moreOpen ? 'text-[var(--color-primary)]' : 'text-white/70 hover:text-white'
        }`}
        title="More"
        aria-label="More actions"
        aria-expanded={moreOpen}
      >
        <MoreHorizontal size={15} />
      </button>
      {moreOpen && (
        <ReaderMoreMenu
          anchor={moreBtn}
          onClose={() => setMoreOpen(false)}
          items={items}
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


// One page's slot in the continuous stack: whatever the host draws beside
// the page (the margin rails) flanking a fixed-size page box holding the
// canvas, the annotation overlay, and the text layer. The box keeps its
// full size whether or not the page is painted — the stack's scroll
// geometry must never depend on what happens to be rendered — and an
// unpainted slot reads as white paper with a faint page number. Memoized
// because the stack re-renders on every derived-page change while
// scrolling; without this, a 600-page record rebuilds 600 slots per page
// crossed.
const PageSlot = memo(function PageSlot({
  p,
  w,
  h,
  pending,
  annotations,
  animations,
  attachMode,
  onAreaChosen,
  sides,
  setCanvasEl,
  setTextLayerEl,
  setHitLayerEl,
  onRemove,
}: {
  p: number;
  w: number;
  h: number;
  /** In view: show a spinner on the blank paper until the page paints. */
  pending: boolean;
  annotations: Annotation[];
  animations: DocumentAnimation[];
  /** Drawing a rectangle round a picture, to attach a clip to it. */
  attachMode: boolean;
  onAreaChosen: (page: number, rect: FractionalRect) => void;
  /** What flanks the page; null for the page alone (a pane). */
  sides: PageSides | null;
  setCanvasEl: (p: number, el: HTMLCanvasElement | null) => void;
  setTextLayerEl: (p: number, el: HTMLDivElement | null) => void;
  setHitLayerEl: (p: number, el: HTMLDivElement | null) => void;
  onRemove: (id: string) => void;
}) {
  const side = sides ? sides.render(p, annotations) : null;
  return (
    <div className="flex flex-row items-stretch" style={{ marginBottom: PAGE_GAP }}>
      {side?.before}
      <div
        className="relative shadow-2xl"
        style={{ width: w, height: h, backgroundColor: '#ffffff' }}
      >
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-black/25 select-none">
          {pending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
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
        <div
          ref={(el) => setHitLayerEl(p, el)}
          className="search-hits absolute inset-0 pointer-events-none"
          aria-hidden="true"
        />
        {/* Last, so a play badge sits above the text layer's own hit area. */}
        <AnimationLayer
          page={p}
          animations={animations}
          attachMode={attachMode}
          onAreaChosen={onAreaChosen}
        />
      </div>
      {side?.after}
    </div>
  );
});

// The right-edge page rail: a scrollbar-shaped thumb mapped over the whole
// document. Drag it, or click anywhere on the track, to move through the
// pages — the vertical companion to the bottom slider, present even in
// fit-page mode where no native scrollbar can exist. It owns a permanent
// flex lane at the pane's right edge, so it never moves and never shares
// ground with the native bar; its ink follows the reader's theme, so it
// reads on parchment as plainly as by lamplight. Exported for the harness
// probes; the reader is its only product surface.
// The rail is a scrollbar for the whole document — the one a finger can
// find. Its thumb is the scroll position, and dragging it moves through
// pages and through a page alike; it used to snap to page tops, so on a
// phone with the page taller than the screen the bottom of every page
// was out of reach. The page number is derived from the scroll, as ever.
export function PageRail({ page, total, scroller, theme, onSeek }: {
  page: number;
  total: number;
  /** The scrolling page stack; the thumb follows its scroll position. */
  scroller: React.RefObject<HTMLDivElement | null>;
  theme: ReaderTheme;
  onSeek: (fraction: number) => void;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const THUMB = 56;
  const dark = theme === 'dark';

  // The scroll position as a fraction of the scroll range, read here so only
  // the rail re-renders as the document moves.
  const [fraction, setFraction] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const range = el.scrollHeight - el.clientHeight;
      const f = range > 0 ? el.scrollTop / range : 0;
      setFraction((prev) => (Math.abs(prev - f) < 0.002 ? prev : f));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(read); };
    read();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [scroller]);

  // A drag seeks at most once a frame: pointer events can outrun the screen.
  const pendingSeek = useRef<number | null>(null);
  const seekRaf = useRef(0);
  const seek = (f: number) => {
    pendingSeek.current = f;
    if (seekRaf.current) return;
    seekRaf.current = requestAnimationFrame(() => {
      seekRaf.current = 0;
      if (pendingSeek.current !== null) onSeek(pendingSeek.current);
      pendingSeek.current = null;
    });
  };
  useEffect(() => () => { if (seekRaf.current) cancelAnimationFrame(seekRaf.current); }, []);

  const fractionAt = (clientY: number): number => {
    const el = railRef.current;
    if (!el) return fraction;
    const r = el.getBoundingClientRect();
    const usable = r.height - THUMB;
    if (usable <= 0) return fraction;
    return Math.min(1, Math.max(0, (clientY - r.top - THUMB / 2) / usable));
  };

  return (
    <div
      ref={railRef}
      className="reader-rail w-[15px] shrink-0 relative cursor-pointer touch-none select-none"
      style={{ background: dark ? 'rgba(255,255,255,0.07)' : 'rgba(42,30,16,0.10)' }}
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        setDragging(true);
        seek(fractionAt(e.clientY));
      }}
      onPointerMove={(e) => { if (dragging) seek(fractionAt(e.clientY)); }}
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
          top: `calc(${Math.min(1, Math.max(0, fraction))} * (100% - ${THUMB}px))`,
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

// Inline colored boxes for each annotation rect on the current page.
// Positioned inside the same parent as the canvas + text layer; sits
// between them in z-order so highlights show through the (transparent)
// text layer but selection still works on top.
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
                className="ann-remove absolute -top-2 -right-2 w-4 h-4 rounded-full bg-black/70 text-white text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
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

// On a highlight that already exists: the same four colours, the one it
// has ringed, and a way to take it back. Opens on a click on the mark.
function MarkMenu({
  x,
  y,
  color,
  onPick,
  onRemove,
}: {
  x: number;
  y: number;
  color: AnnotationColor;
  onPick: (color: AnnotationColor) => void;
  onRemove: () => void;
}) {
  const colors: AnnotationColor[] = ['gold', 'green', 'pink', 'blue'];
  const top = Math.max(8, y - 44);
  return (
    <div
      data-mark-menu
      role="menu"
      aria-label="This highlight"
      className="fixed z-[60] flex items-center gap-1 px-1.5 py-1 rounded-lg bg-[#1a1a22] border border-white/15 shadow-2xl"
      style={{ left: x, top, transform: 'translateX(-50%)' }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {colors.map((c) => (
        <button
          key={c}
          onClick={() => { if (c !== color) onPick(c); }}
          className={`w-5 h-5 rounded-full transition ${c === color ? 'ring-2 ring-white ring-offset-1 ring-offset-[#1a1a22]' : 'hover:scale-110'}`}
          style={{ backgroundColor: ANNOTATION_DOT[c] }}
          title={c === color ? `Highlighted ${c}` : `Change to ${c}`}
          aria-label={c === color ? `Highlighted ${c}` : `Change to ${c}`}
        />
      ))}
      <div className="w-px h-4 bg-white/15 mx-0.5" />
      <button
        onClick={onRemove}
        className="h-5 px-1.5 inline-flex items-center gap-1 rounded text-white/70 hover:text-[#e8b84a] transition text-[11px] font-medium"
        title="Remove this highlight"
      >
        <X size={13} />
        Remove
      </button>
    </div>
  );
}

function PdfBookStyle({ theme }: { theme: ReaderTheme }) {
  // The words being chosen, at the strength a gold highlight will have once
  // the color is picked: what is seen is what is made.
  const selectionBg =
    theme === 'dark'
      ? 'rgba(245, 207, 96, 0.5)'
      : 'rgba(212, 160, 84, 0.45)';
  return (
    <style>{`
      .textLayer {
        position: absolute;
        left: 0;
        top: 0;
        overflow: hidden;
        /* Full strength, as pdf.js 5 has it: the glyphs are transparent
           anyway, and a dimmed layer dimmed the selection with it (a 0.55
           gold at 0.25 opacity was a 14% wash nobody could see). */
        opacity: 1;
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
      /* The selection guard (src/lib/pdf-text-selection.ts): an empty,
         unselectable div under the spans that covers the layer while a
         drag is in progress, so a gap between spans ends the selection
         where the mouse is instead of at the next span on the page. */
      .textLayer .endOfContent {
        display: block;
        position: absolute;
        inset: 100% 0 0;
        z-index: 0;
        cursor: default;
        user-select: none;
      }
      .textLayer.selecting .endOfContent { top: 0; }
      .textLayer ::selection { background: ${selectionBg}; color: transparent; }
      .textLayer br::selection { background: transparent; }
      /* Search hits: the words themselves, lit at full strength over the
         page; the current match stronger, with a ring. Multiply keeps the
         ink readable through the color. */
      /* On a touch screen nothing hovers: the × that takes a highlight back
         is always shown, and big enough for a finger; so is the rail. */
      @media (hover: none) {
        .reader-rail { width: 24px !important; }
        .ann-remove {
          opacity: 1 !important;
          width: 22px !important;
          height: 22px !important;
          font-size: 13px !important;
          top: -11px !important;
          right: -11px !important;
        }
      }
      .search-hits { z-index: 2; }
      .search-hit {
        position: absolute;
        background: rgba(255, 214, 0, 0.6);
        border-radius: 2px;
        mix-blend-mode: multiply;
      }
      .search-hit.current {
        background: rgba(255, 150, 0, 0.8);
        box-shadow: 0 0 0 2px rgba(255, 120, 0, 0.95);
      }
      ${scrollbarCss(theme)}
      ${printCss}
      .textLayer ::-moz-selection { background: ${selectionBg}; color: transparent; }
      .textLayer br::-moz-selection { background: transparent; }
    `}</style>
  );
}

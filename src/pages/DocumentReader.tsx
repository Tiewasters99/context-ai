import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ZoomIn,
  ZoomOut,
  Sun,
  Moon,
  X,
  Search,
  Undo2,
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
  Scissors,
  MoreHorizontal,
  MessageCircle,
  Loader2,
  Send,
  PenLine,
  BookMarked,
} from 'lucide-react';
import mammoth from 'mammoth';
import { labelWordNotes } from '@/lib/reader-notes';
import { Fountain } from 'fountain-js';
import { supabase } from '@/lib/supabase';
import { LIBRARY_SERVERSPACE, findOrCreateLibrarySection, publishDocumentToOffice, captureJacket } from '@/lib/office-publish';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { fetchPaged } from '@/lib/paged';
import { hasDraftBody } from '@/lib/brief/draft-store';
import { openStoredPdf, type PdfOpenProgress } from '@/lib/pdf-source';
import { storageObjectBlob, downloadDocumentFile, isStepUpRequired } from '@/lib/vault-object';
import StepUpPrompt from '@/components/account/StepUpPrompt';
import PdfBook, {
  type AttachArgs,
  type BenchStore,
  type BookSelection,
  type MarksStore,
  type PageLink,
  type PageSides,
  type PdfBookGoto,
  type PdfBookHandle,
  type PdfBookView,
  type PdfSource,
} from '@/components/reader/PdfBook';
import AnimationAttach from '@/components/reader/AnimationAttach';
import { listAnimations, deleteAnimation, createAnimation } from '@/lib/document-animations';
import {
  listWorkshopItems, createSnip, createSnippet, addMedia, updateWorkshopItem, deleteWorkshopItem,
} from '@/lib/document-workshop';
import { persistVaultFile, resolveMatter as resolveVaultMatter } from '@/lib/vault-persist';
import { canvasToBlob } from '@/lib/pdf-page-image';
import SealedExportDialog from '@/components/reader/SealedExportDialog';
import { documentEntry } from '@/lib/second-factor';
import DriveExportControl from '@/components/reader/DriveExportControl';
import DelegateCard from '@/components/agents/DelegateCard';
import { DRIVE_KINDS, DRIVE_LABEL, type DriveKind } from '@/lib/export-connectors';
import CoverImage from '@/components/layout/CoverImage';
import CoverModeToggle from '@/components/ui/CoverModeToggle';
import CanvasPinToggle from '@/components/canvas/CanvasPinToggle';
import PdfPageEditor from '@/components/vault/PdfPageEditor';
import { setOrchestratorContext, clearOrchestratorContext, getOrchestratorContext } from '@/lib/orchestrator-context';
import { runInAssistant } from '@/lib/assistant-bus';
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
  textAnchorsAvailable,
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
  anchorFromRange,
  flattenText,
  isTextAnchor,
  offsetsFromAnchor,
  rangeFromOffsets,
  type TextAnchor,
} from '@/lib/text-anchor';
import {
  pdfDocumentText,
  reflowedHtml,
  selectionHtml,
  htmlPlainText,
  writeClipboard,
} from '@/lib/reader-copy';
import { phraseRegex, likePattern } from '@/lib/reader-find';
import { ANNOTATION_DOT, ANNOTATION_FILL, printCss, scrollbarCss, type ReaderTheme } from '@/lib/reader-style';
import {
  FindBox,
  LoadingCard,
  ReaderMoreMenu,
  SelectionMenu,
  type MoreItem,
} from '@/components/reader/reader-chrome';


type DocMeta = {
  id: string;
  title: string;
  storage_path: string | null;
  source_filename: string | null;
  page_count: number | null;
  cover_url: string | null;
  matterspace_id: string | null;
  /** Saves a HEAD request when the PDF is opened by ranges. */
  file_size_bytes?: number | null;
  /** 'generated' for a deliverable filed without passages (an edited PDF). */
  text_status?: string | null;
  /** What a vision model wrote about a picture (metadata.image_description):
   *  the tile label, the search line, the words printed in it. Absent on
   *  anything that is not a described picture. */
  image_description?: { kind?: string; label?: string; line?: string; text?: string; model?: string | null } | null;
  /** For an edited copy: the indexed original it was made from. */
  source_document_id?: string | null;
  /** 'brief' offers "Edit in the Brief Desk". */
  doc_type?: string | null;
};

type FileKind = 'pdf' | 'docx' | 'fountain' | 'pptx' | 'text' | 'image' | 'unsupported';

// Pictures the browser draws natively. A stored image is the document — a
// concept render for a screenplay, a photographed exhibit, a chart — and
// until 2026-09-26 the reader answered every one of them with "Unsupported
// file type" while the Vault row promised it was "stored and viewable".
// TIFF is left out on purpose: no browser renders it, so a .tif falls to the
// text edition of its OCR (a Bates production) or the error page.
const BROWSER_IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};
function imageTypeFor(filename: string): string | null {
  const i = filename.lastIndexOf('.');
  if (i < 0) return null;
  return BROWSER_IMAGE_TYPES[filename.slice(i)] ?? null;
}

// Plain text → minimal HTML: escape, split paragraphs on blank lines.
// Single newlines inside a paragraph survive through the text page's
// pre-line whitespace, so hard-wrapped sources keep their lines.
const plainTextHtml = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
    .join('');

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
type Match = { page: number; index: number };

// The two shapes of a find query live in src/lib/reader-find.ts, shared
// with the book; the page rail (PageRail) is the book's own now.

// The opening words of a passage, for the find box.
const firstWords = (t: string, n: number) => t.split(/\s+/).filter(Boolean).slice(0, n).join(' ');

// Find every occurrence of `needle` in the text of a rendered document,
// as DOM Ranges. The text nodes are joined into one string first, so a
// hit may run across inline boundaries — a brief sets the case name in
// italics and the reporter cite in roman, and "Smith v. Jones, 123 F.3d"
// has to be found as one thing.
function findInRendered(root: HTMLElement, needle: string): Range[] {
  // The same text walk the margin marks anchor to (src/lib/text-anchor.ts).
  const { text, pieces } = flattenText(root);
  const ranges: Range[] = [];
  if (!needle.trim()) return ranges;
  // Case-insensitive in the regex engine (no lower-casing, which changes
  // some letters' length and would put every later offset off), and any
  // whitespace between the words: a transcript's lines break mid-phrase.
  const re = phraseRegex(needle);
  let i = 0; // piece cursor — hits arrive in document order
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0].length) { re.lastIndex += 1; continue; }
    const at = m.index;
    const end = at + m[0].length;
    while (i < pieces.length - 1 && pieces[i + 1].start <= at) i++;
    let j = i;
    while (j < pieces.length - 1 && pieces[j + 1].start < end) j++;
    const r = document.createRange();
    r.setStart(pieces[i].node, at - pieces[i].start);
    r.setEnd(pieces[j].node, end - pieces[j].start);
    ranges.push(r);
  }
  return ranges;
}

// The CSS Custom Highlight API, where the browser has it. Highlights
// paint over the text without touching the DOM, so nothing leaks into a
// copy and there is nothing to unwrap when the search closes.
type HighlightCtor = new (...ranges: Range[]) => unknown;
function customHighlights(): { registry: Map<string, unknown>; Highlight: HighlightCtor } | null {
  const g = globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> }; Highlight?: HighlightCtor };
  return g.CSS?.highlights && g.Highlight ? { registry: g.CSS.highlights, Highlight: g.Highlight } : null;
}
const FIND_HL = 'reader-find';
const FIND_HL_CURRENT = 'reader-find-current';
// Marks on a rendered document: one Highlight per color, plus one for the
// dotted underline under a margin note's words. Painted at priority -1 so
// the find highlights (priority 0) always sit on top of them.
const ANN_HL_COLORS: AnnotationColor[] = ['gold', 'green', 'pink', 'blue'];
const annHl = (c: AnnotationColor) => `reader-ann-${c}`;
const ANN_HL_NOTE = 'reader-ann-note';

// Two small lookups for the companion's provenance walk, typed at the
// boundary so the walk's loop variable does not feed back into the query
// builder's inference.
async function passageCountOf(documentId: string): Promise<number> {
  const { count } = await supabase
    .from('passages')
    .select('id', { count: 'exact', head: true })
    .eq('document_id', documentId);
  return count ?? 0;
}
// The indexed text of a document, in reading order — what ingest extracted
// (or OCR'd). It is the copy fallback for a PDF whose own text layer is
// empty: a scanned opinion selects nothing and pdf.js reads nothing, but
// the words are here.
async function indexedDocumentText(documentId: string): Promise<string> {
  // PostgREST answers an unbounded read with at most db-max-rows — 1,000 here
  // — and a 200. A client .limit(5000) does not raise it (PR #173), so "Copy
  // the whole document" on a scanned deposition silently stopped at passage
  // 1,000 and the lawyer pasted a truncated record with nothing saying so.
  const { rows } = await fetchPaged<{ text: string | null }>(
    (from, to) => supabase
      .from('passages')
      .select('sequence_number, text')
      .eq('document_id', documentId)
      .eq('summary_level', 0)
      .order('sequence_number', { ascending: true })
      .order('id')
      .range(from, to),
    { label: 'document text' },
  );
  return rows
    .map((p) => (p.text ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}
async function sourceDocumentOf(documentId: string): Promise<string | null> {
  const { data } = await supabase.from('documents').select('metadata').eq('id', documentId).maybeSingle();
  const meta = (data as { metadata?: { source_document_id?: string | null } | null } | null)?.metadata;
  return meta?.source_document_id ?? null;
}

/**
 * Imperative navigation for a host that shows the Reader beside something
 * else (the Brief Desk's authority pane). Applied when `nonce` changes and on
 * first load; a prop, not a URL parameter, because two Readers on one route
 * would fight over `?page=`.
 *   page       → that page (PDF)
 *   passageId  → the passage's page, its first twelve words lit through the
 *                find highlight (PDF: the .search-hits boxes; other formats:
 *                the rendered text)
 *   anchor     → a text anchor in a rendered (non-PDF) document
 */
export interface ReaderGoto {
  page?: number;
  passageId?: string;
  anchor?: TextAnchor;
  /** A footnote the cite pins to ("at 2 n.1"): a Word file opens AT that note. */
  footnote?: number;
  nonce: number;
}

/**
 * 'full' — the Reader as it is on its route. 'pane' — inside another
 * surface's column: no cover, no sidebar toggle (the sidebar stays shut), no
 * page editor. `embedded` (a canvas card) hides the cover and the page editor
 * as before; 'pane' names the whole set.
 */
export type ReaderChrome = 'full' | 'pane';

type ReaderProps = EmbeddableViewProps & { goto?: ReaderGoto; chrome?: ReaderChrome };

export default function DocumentReader({ id: propId, embedded = false, onClose, goto, chrome = 'full' }: ReaderProps = {}) {
  const pane = chrome === 'pane';
  const paneChrome = pane;
  const hideCover = embedded || pane;
  const hidePageEditor = embedded || pane;
  const hideSidebarToggle = pane;
  const params = useParams<{ id: string }>();
  const id = propId ?? params.id;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isMobile = useIsMobile();

  // A brief with an editable body lives in the Brief Desk (spec §3.1). The
  // standalone route only: an embedded Reader (a canvas card, the desk's own
  // authority pane, the Vault's overlay) must never take over the page, so only
  // the Reader mounted by the route itself redirects. `?reader=1` opens the
  // filed text here anyway.
  useEffect(() => {
    if (propId !== undefined || embedded || !id || searchParams.get('reader') === '1') return;
    let live = true;
    void hasDraftBody(id).then((yes) => {
      if (live && yes) navigate(`/app/brief/${id}`, { replace: true });
    });
    return () => { live = false; };
  }, [propId, embedded, id, navigate, searchParams]);

  const [doc, setDoc] = useState<DocMeta | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  // What the loader is doing right now, for the card shown while it works.
  const [loadProgress, setLoadProgress] = useState<PdfOpenProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // A sealed matter's file asked for on a session that has not confirmed a
  // second factor (S4a: /api/document-url refuses it), or a sealed document's
  // row that reads as nothing at aal1 (098: document_entry says why). The
  // prompt is drawn in the reading pane; confirming re-runs whatever was
  // refused.
  const [stepUp, setStepUp] = useState<{ mode: 'stepup' | 'enrol'; matterId: string | null; retry: 'load' | 'download' } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [fileKind, setFileKind] = useState<FileKind>('pdf');
  const [docHtml, setDocHtml] = useState<string | null>(null);
  // For .fountain — the parser produces a separate title-page block we
  // want to render above the script body.
  const [titlePageHtml, setTitlePageHtml] = useState<string | null>(null);
  // For an image — the picture itself, as a blob URL over the bytes the
  // Vault holds, and its pixel size once the browser has decoded it. The URL
  // is revoked when the next one replaces it and when the reader unmounts.
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);

  // For a PDF these mirror the book (PdfBook reports what it shows); a
  // rendered document is one page.
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  // The pages actually on screen, most visible first (a PDF; the book reports them).
  const [visiblePages, setVisiblePages] = useState<{ page: number; share: number }[]>([]);
  const [zoom, setZoom] = useState(1.5);
  const [theme, setTheme] = useState<ReaderTheme>('parchment');
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Search state, for the rendered formats (a PDF's find is the book's): the
  // rendered document is the text itself, so each match is a DOM Range, kept
  // here and lit with the CSS Custom Highlight API. `matches` carries one
  // entry per range so the count and the arrows read the same.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [matchIdx, setMatchIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  /** A find has run for the current query (so "Not found" means it looked). */
  const [searched, setSearched] = useState(false);
  const pageTextCacheRef = useRef<string[]>([]);
  const textRangesRef = useRef<Range[]>([]);
  // React 19 resets innerHTML whenever this object is a new one, which a
  // fresh literal on every render would make it: the document re-parses,
  // the reader's selection drops, and the search's ranges collapse. One
  // object per document instead.
  const docHtmlProp = useMemo(() => (docHtml ? { __html: docHtml } : undefined), [docHtml]);
  const titlePageHtmlProp = useMemo(() => (titlePageHtml ? { __html: titlePageHtml } : undefined), [titlePageHtml]);

  // Annotations state. A PDF's marks are the book's (PdfBook reports them
  // here, so the note cards can find them); a rendered document's are loaded
  // once per document and updated optimistically on create/delete.
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // Marks on documents without pages need migration 084's text_anchor
  // column; false once the database has shown it is missing.
  const [textMarksOn, setTextMarksOn] = useState(true);
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
    page: number;
    rects: FractionalRect[];
    anchorText: string;
    /** Documents without pages: where the selection sits in the text. */
    textAnchor?: TextAnchor;
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
    /** Documents without pages: where the selection sits in the text. */
    textAnchor?: TextAnchor;
  } | null>(null);
  const [openNote, setOpenNote] = useState<{ id: string; x: number; y: number } | null>(null);
  const [openRef, setOpenRef] = useState<{ link: IncomingLink; x: number; y: number } | null>(null);
  const [incomingLinks, setIncomingLinks] = useState<IncomingLink[]>([]);
  // The open PDF, handed up by the book once it has it: the whole-document
  // copy and the companion's page texts read it here.
  const pdfDocRef = useRef<unknown>(null);
  const bookRef = useRef<PdfBookHandle | null>(null);
  // A rendered document's root and its scrolling pane (a PDF's are the book's).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Restore persisted prefs (a rendered document's; the book keeps its own,
  // under the same keys).
  useEffect(() => {
    // A pane beside another surface leaves the full Reader's saved zoom
    // alone, in both directions.
    if (pane) return;
    const z = localStorage.getItem('ctx_reader_zoom');
    if (z) {
      const parsed = parseFloat(z);
      if (parsed >= 0.5 && parsed <= 4) setZoom(parsed);
    }
    const t = localStorage.getItem('ctx_reader_theme') as ReaderTheme | null;
    if (t === 'parchment' || t === 'dark') setTheme(t);
  }, [pane]);
  useEffect(() => { if (!pane) localStorage.setItem('ctx_reader_zoom', String(zoom)); }, [zoom, pane]);
  useEffect(() => { localStorage.setItem('ctx_reader_theme', theme); }, [theme]);

  // Track OS fullscreen state so the toolbar button reflects reality even
  // when the user leaves fullscreen via Escape.
  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(document.fullscreenElement === rootRef.current);
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (rootRef.current) {
      void rootRef.current.requestFullscreen();
    }
  }, []);

  // Load metadata, download blob, branch by file kind.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoadState('loading');
    setLoadProgress(null);
    setErrorMsg(null);
    setStepUp(null);
    setDocHtml(null);
    setImageUrl(null);
    setImageDims(null);
    pdfDocRef.current = null;
    pageTextCacheRef.current = [];
    setMatches([]);
    setMatchIdx(0);
    setAnnotations([]);
    setSelectionMenu(null);

    void (async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('id, title, storage_path, source_filename, page_count, cover_url, matterspace_id, file_size_bytes, doc_type, text_status:metadata->>text_status, source_document_id:metadata->>source_document_id, image_description:metadata->image_description')
        .eq('id', id)
        .maybeSingle();
      if (cancelled) return;
      if (!error && !data) {
        // 098: a sealed document reads as nothing until this session confirms
        // its second factor. Ask whether that nothing is "confirm it's you"
        // before calling it missing.
        const entry = await documentEntry(id);
        if (cancelled) return;
        if (entry === 'stepup' || entry === 'enrol') {
          // The same prompt, and the same retry, as /api/document-url's refusal.
          setStepUp({ mode: entry, matterId: null, retry: 'load' });
          setLoadState('error');
          return;
        }
      }
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
        : fn.endsWith('.txt') || fn.endsWith('.md') ? 'text'
        : imageTypeFor(fn) ? 'image'
        : 'unsupported';
      setFileKind(kind);

      if (kind === 'unsupported') {
        // Not a file the reader can draw — but if ingest indexed its text,
        // serve that as a text edition. The error page is the last resort.
        // Paged, for the same reason as indexedDocumentText above: .limit(2000)
        // is capped at 1,000 by PostgREST, so the text edition of a long
        // OCR'd file simply ended mid-document. The read is wrapped because
        // fetchPaged throws and this branch sits outside the load's try — a
        // failed read must land on the error page, never as an unhandled
        // rejection.
        let passages: { text: string | null }[] = [];
        try {
          ({ rows: passages } = await fetchPaged<{ text: string | null }>(
            (from, to) => supabase
              .from('passages')
              .select('sequence_number, text')
              .eq('document_id', data.id)
              .eq('summary_level', 0)
              .order('sequence_number', { ascending: true })
              .order('id')
              .range(from, to),
            { label: 'document text' },
          ));
        } catch {
          passages = [];
        }
        if (cancelled) return;
        if (passages.length > 0) {
          setFileKind('text');
          setDocHtml(plainTextHtml(passages.map((p) => p.text ?? '').join('\n\n')));
          setTotalPages(1);
          setPage(1);
          setLoadState('ready');
          return;
        }
        setErrorMsg('Unsupported file type — the reader currently handles PDF, Word (.docx), PowerPoint (.pptx), Fountain (.fountain), plain text (.txt, .md), and images (PNG, JPEG, GIF, WebP, SVG, BMP).');
        setLoadState('error');
        return;
      }

      // A PDF is opened by ranges, page by page, so a scanned book paints
      // its first page in a second instead of after the whole file has
      // arrived (src/lib/pdf-source.ts). Everything else is small and comes
      // down whole.
      let blob: Blob | null = null;
      let arrayBuffer: ArrayBuffer | null = null;
      if (kind !== 'pdf') {
        setLoadProgress({ stage: 'downloading', loaded: 0, total: data.file_size_bytes ?? null });
        let dl: Blob | null = null;
        try {
          // Direct on an unsealed matter; through /api/document-url (and
          // into the matter's Record) on a sealed one — vault-object.ts.
          dl = await storageObjectBlob(data.storage_path);
        } catch (e) {
          if (cancelled) return;
          if (isStepUpRequired(e)) {
            setStepUp({ mode: e.mode, matterId: e.matterId ?? data.matterspace_id ?? null, retry: 'load' });
          } else {
            setErrorMsg(e instanceof Error ? e.message : 'Failed to download the file.');
          }
          setLoadState('error');
          return;
        }
        if (cancelled) return;
        blob = dl;
        arrayBuffer = await dl.arrayBuffer();
        if (cancelled) return;
      }

      try {
        if (kind === 'pdf') {
          // The book opens the file itself (PdfBook, through the source built
          // below) and reports when it is ready; nothing more to do here.
          return;
        } else if (kind === 'fountain') {
          // Fountain — plain-text screenplay. Parse via fountain-js and let
          // the parser hand us back semantic HTML (h3 scene headings,
          // .dialogue divs, h4 character names, p action/dialogue) — our
          // CSS does the Courier / centred-name / indented-dialogue layout.
          const text = await (blob as Blob).text();
          if (cancelled) return;
          const parsed = new Fountain().parse(text, true);
          setTitlePageHtml(parsed.html?.title_page ?? null);
          setDocHtml(parsed.html?.script ?? '');
          setTotalPages(1);
          setPage(1);
        } else if (kind === 'pptx') {
          // PPTX — one card per slide, single scrollable deck.
          const html = await pptxDeckHtml(arrayBuffer as ArrayBuffer);
          if (cancelled) return;
          setDocHtml(html);
          setTotalPages(1);
          setPage(1);
        } else if (kind === 'text') {
          // Plain text — the book as filed, one scrollable page.
          const text = await (blob as Blob).text();
          if (cancelled) return;
          setDocHtml(plainTextHtml(text));
          setTotalPages(1);
          setPage(1);
        } else if (kind === 'image') {
          // An image — the bytes as filed, drawn by the browser. Storage
          // does not always return a typed blob, and an untyped SVG will
          // not render, so the type comes from the name. The URL is the
          // reader's to revoke (see the imageUrl effect).
          const typed = new Blob([blob as Blob], { type: imageTypeFor(fn) ?? 'application/octet-stream' });
          setImageUrl(URL.createObjectURL(typed));
          setTotalPages(1);
          setPage(1);
        } else {
          // DOCX — convert to HTML once. Word has no page concept, so we
          // treat it as a single scrollable document.
          const result = await mammoth.convertToHtml({ arrayBuffer: arrayBuffer as ArrayBuffer });
          if (cancelled) return;
          setDocHtml(labelWordNotes(result.value));
          setTotalPages(1);
          setPage(1);
        }
        setLoadState('ready');
      } catch (err) {
        if (cancelled) return;
        if (isStepUpRequired(err)) {
          setStepUp({ mode: err.mode, matterId: err.matterId ?? data.matterspace_id ?? null, retry: 'load' });
        } else {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to open the document.');
        }
        setLoadState('error');
      }
    })();

    return () => { cancelled = true; };
  }, [id, reloadKey]);

  // ── Clean copy ──────────────────────────────────────────────────────
  // The whole document onto the clipboard as it should paste into Word:
  // a PDF's text reflowed into flowing paragraphs, a .docx as its own
  // semantic HTML (its real bold and italics travel), slides and scripts
  // as plain text. Selection copy over the PDF text layer is intercepted
  // in the content pane below for the same reason — the painted layer's
  // styling is not the document's.
  const [copyState, setCopyState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  // Why the last copy failed, said in a banner: a copy that silently does
  // nothing reads as "copy is broken" (2026-09-17). Every copy gesture —
  // toolbar, popover, context menu — reports through copyState and this.
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const copyResetRef = useRef<number | null>(null);
  const settleCopy = useCallback((state: 'done' | 'failed', note: string | null = null) => {
    setCopyState(state);
    setCopyNote(note);
    if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
    copyResetRef.current = window.setTimeout(() => {
      setCopyState('idle');
      setCopyNote(null);
    }, state === 'failed' ? 6000 : 2000);
  }, []);
  const CLIPBOARD_REFUSED = 'The browser refused the clipboard write — click the page once, then copy again.';
  // The whole document's text, extracted once per document and kept:
  // extracting a long opinion outlives the browser's user-activation
  // window, and the clipboard write after it is refused — the click "did
  // nothing". With the text cached, the next click writes at once.
  const docTextRef = useRef<{ id: string | undefined; text: string; html: string } | null>(null);
  // The toolbar's copy button copies the SELECTION when there is one, and the
  // whole document only when nothing is selected. Until 2026-09-08 it always
  // copied the whole document — and, since its mousedown was not prevented,
  // the click first collapsed the highlight the user had just made.
  const handleCopyText = useCallback(async () => {
    if (copyState === 'busy' || loadState !== 'ready') return;
    const sel = window.getSelection();
    const selected = sel && !sel.isCollapsed ? sel.toString() : '';
    if (selected.trim()) {
      try {
        await writeClipboard(selected, selectionHtml(selected));
        settleCopy('done');
      } catch {
        settleCopy('failed', CLIPBOARD_REFUSED);
      }
      return;
    }
    setCopyState('busy');
    setCopyNote(null);
    // An image has no words to copy; the picture itself goes to the
    // clipboard, as PNG, which is the one bitmap type every browser's
    // clipboard accepts. A JPEG or WebP is redrawn to PNG on a canvas first.
    if (fileKind === 'image' && imageUrl) {
      try {
        if (typeof ClipboardItem === 'undefined') throw new Error('no ClipboardItem');
        const src = await (await fetch(imageUrl)).blob();
        let png: Blob = src;
        if (src.type !== 'image/png') {
          const bitmap = await createImageBitmap(src);
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          bitmap.close();
          png = await canvasToBlob(canvas, 'image/png');
        }
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        settleCopy('done');
      } catch {
        settleCopy('failed', CLIPBOARD_REFUSED);
      }
      return;
    }
    let extracted = false;
    try {
      let cached = docTextRef.current && docTextRef.current.id === id ? docTextRef.current : null;
      if (!cached) {
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
        if (!text.trim() && id) {
          // A scan: the PDF carries no text layer, so pdf.js read nothing.
          // Ingest's OCR text is the document's words; copy that.
          text = await indexedDocumentText(id);
          html = selectionHtml(text);
        }
        if (!text.trim()) {
          settleCopy(
            'failed',
            'Nothing to copy: this file has no text layer and no indexed text. Ingest it (OCR) and the words will be here.',
          );
          return;
        }
        cached = { id, text, html };
        docTextRef.current = cached;
        extracted = true;
      }
      await writeClipboard(cached.text, cached.html);
      settleCopy('done');
    } catch {
      // Usually the activation window closed during extraction; the text is
      // cached now, so the next click writes immediately.
      settleCopy(
        'failed',
        extracted
          ? 'The text is ready but the browser refused the clipboard after the wait — click Copy once more.'
          : CLIPBOARD_REFUSED,
      );
    }
  }, [copyState, loadState, fileKind, imageUrl, docHtml, titlePageHtml, id, settleCopy, CLIPBOARD_REFUSED]);

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
      // Printing reads the file again; on a sealed matter that is one more
      // `file.opened` (purpose 'read') in the Record.
      let blob: Blob;
      try {
        blob = await storageObjectBlob(doc.storage_path);
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : 'The file could not be fetched to print.');
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
    if (!text.trim()) {
      settleCopy('failed', 'Nothing is selected — drag over the words first, then copy.');
      return;
    }
    // The browser's own copy command first. It runs synchronously inside
    // the click, needs no clipboard permission, and takes exactly the path
    // Ctrl+C takes — the PDF intercept above, or the browser's default for a
    // rendered .docx. The async Clipboard API is the fallback, not the
    // route: a right-click → Copy that went through it alone came back
    // with nothing on the clipboard for Eden (2026-09-17), and a refused
    // write there was swallowed without a word.
    let native = false;
    try {
      native = document.execCommand('copy');
    } catch {
      native = false;
    }
    if (native) {
      settleCopy('done');
      return;
    }
    try {
      await writeClipboard(text, selectionHtml(text));
      settleCopy('done');
    } catch {
      settleCopy('failed', CLIPBOARD_REFUSED);
    }
  }, [settleCopy, CLIPBOARD_REFUSED]);

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
  // Every drive with a live connection, in a stable order. One of them and the
  // toolbar control is the single button it has always been; two or three and
  // it becomes a short menu; none and it offers the way to connect one.
  const connectedDrives = DRIVE_KINDS.filter((kind) =>
    connections.some((c) => c.kind === kind && c.status === 'connected'),
  );
  const [driveExporting, setDriveExporting] = useState(false);
  const [driveBanner, setDriveBanner] = useState<
    { kind: 'ok'; text: string; link: string | null; linkLabel?: string }
    | { kind: 'err'; text: string }
    | null
  >(null);
  // When the matter is sealed the server answers 409 instead of exporting, and
  // hands back the sentence to show. Confirming re-issues the same request with
  // confirm_leave_seal — per copy, never remembered. `drive` is carried so the
  // confirmation re-issues the export the user actually asked for.
  const [sealPrompt, setSealPrompt] = useState<{ message: string; drive: DriveKind } | null>(null);
  const handleDriveExport = useCallback(async (opts?: { confirmLeaveSeal?: boolean }) => {
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
        body: JSON.stringify({
          documentId: id,
          folderName: 'Contextspaces',
          ...(opts?.confirmLeaveSeal ? { confirm_leave_seal: true } : {}),
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (resp.status === 409 && body.error === 'export_needs_confirmation') {
        setSealPrompt({ message: body.message, drive: 'google_drive' });
        return;
      }
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
        // On a sealed matter the server says, in its own words, that a copy
        // left and whether that is recorded. Never re-worded here.
        text: `Saved to your Google Drive${body.folderName ? ` › ${body.folderName}` : ''}.${body.seal?.note ? ` ${body.seal.note}` : ''}`,
        link: body.webViewLink ?? null,
        linkLabel: 'Open in Drive',
      });
    } catch (e) {
      setDriveBanner({ kind: 'err', text: e instanceof Error ? e.message : 'Drive export failed.' });
    } finally {
      setDriveExporting(false);
    }
  }, [id, doc, driveExporting]);

  // OneDrive and Dropbox go through /api/cloud-export — the same export gate,
  // the same 409-then-confirm dance, a different provider at the far end.
  // Google keeps its own path above, untouched.
  const handleCloudExport = useCallback(async (
    service: Exclude<DriveKind, 'google_drive'>,
    opts?: { confirmLeaveSeal?: boolean },
  ) => {
    if (!id || !doc?.storage_path || driveExporting) return;
    const label = DRIVE_LABEL[service];
    setDriveExporting(true);
    setDriveBanner(null);
    try {
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) throw new Error('Not signed in');
      const resp = await fetch('/api/cloud-export', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          service,
          documentId: id,
          ...(opts?.confirmLeaveSeal ? { confirm_leave_seal: true } : {}),
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (resp.status === 409 && body.error === 'export_needs_confirmation') {
        setSealPrompt({ message: body.message, drive: service });
        return;
      }
      if (!resp.ok || !body.ok) {
        const msg =
          body.error === 'not_configured' ? `${label} is not available yet.`
          : body.error === 'cloud_needs_reconnect' ? `Reconnect ${label} in Connections — your access expired.`
          : body.error === 'cloud_not_connected' ? `Connect ${label} in Connections first.`
          : body.error === 'file_too_large' ? `File is too large for ${label} export (75 MB cap).`
          : typeof body.detail === 'string' && body.detail ? `${label}: ${body.detail}`
          : body.error || `${label} export failed.`;
        console.error('cloud-export failed:', body);
        setDriveBanner({ kind: 'err', text: msg });
        return;
      }
      setDriveBanner({
        kind: 'ok',
        // The server's own words on the seal, never re-worded here.
        text: `Saved to your ${label}${body.folderPath ? ` › ${body.folderPath}` : ''}${
          body.name ? ` as “${body.name}”` : ''
        }.${body.seal?.note ? ` ${body.seal.note}` : ''}`,
        // Dropbox is connected with one write-only scope, so it hands back no
        // link; the banner then names the folder and offers no dead button.
        link: body.link ?? null,
        linkLabel: `Open in ${label}`,
      });
    } catch (e) {
      setDriveBanner({ kind: 'err', text: e instanceof Error ? e.message : `${label} export failed.` });
    } finally {
      setDriveExporting(false);
    }
  }, [id, doc, driveExporting]);

  // One entry point for the toolbar, the phone menu and the seal dialog.
  const runDriveExport = useCallback((kind: DriveKind, opts?: { confirmLeaveSeal?: boolean }) => {
    if (kind === 'google_drive') return void handleDriveExport(opts);
    return void handleCloudExport(kind, opts);
  }, [handleDriveExport, handleCloudExport]);

  const [downloading, setDownloading] = useState(false);

  // The page editor — cut, rotate, reorder, or put in pages from another
  // copy — and the note left after it saves the edited copy beside this one.
  const [pageEditorOpen, setPageEditorOpen] = useState(false);
  const [savedCopy, setSavedCopy] = useState<{ filename: string; documentId?: string; downloadUrl?: string } | null>(null);
  // On a phone the toolbar keeps only what a thumb needs — close, the
  // sidebar, find, zoom — and the rest waits behind one "more" button.
  const [moreOpen, setMoreOpen] = useState(false);
  // Delegate… (agents task board): hand this document to an agent that can
  // see its matter. A document outside any matter cannot be delegated.
  const [delegateOpen, setDelegateOpen] = useState(false);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);

  // The companion. The Assistant is scoped to this document's matter and
  // told which document is open, which page, and what that page says — so
  // "what is this passage saying?" needs no preamble. The reader publishes
  // that context here (the route names a document, not a matter) and the
  // panel reads it when a message is sent.
  const [matterName, setMatterName] = useState<string | null>(null);
  // A book in the Library serverspace can be filed to the Office Library
  // from here (the serverspace's matter — "Literature" — names the shelf).
  const [inLibrary, setInLibrary] = useState(false);
  const [filing, setFiling] = useState<
    | { step: 'confirm' }
    | { step: 'working'; text: string }
    | { step: 'done'; text: string }
    | null
  >(null);
  const [pageTexts, setPageTexts] = useState<Record<number, string>>({});
  // Whether anything of this document is indexed. An edited copy is filed
  // without passages, and an import can fail or stall; from the model's
  // side both look like an ordinary document until a search comes back
  // empty — so the count is checked here and stated up front.
  const [passageCount, setPassageCount] = useState<number | null>(null);
  useEffect(() => {
    if (!id) return;
    let stale = false;
    setPassageCount(null);
    void supabase
      .from('passages')
      .select('id', { count: 'exact', head: true })
      .eq('document_id', id)
      .then(({ count }) => { if (!stale) setPassageCount(count ?? 0); });
    return () => { stale = true; };
  }, [id]);
  // For an unindexed copy, the nearest ancestor that IS indexed — a copy of
  // a copy points at a copy, so the chain is walked back, a few hops at
  // most, to the one whose text can be searched.
  const [searchableSourceId, setSearchableSourceId] = useState<string | null>(null);
  useEffect(() => {
    const start = doc?.source_document_id;
    if (passageCount !== 0 || !start) { setSearchableSourceId(null); return; }
    let stale = false;
    (async () => {
      let cur: string | null = start;
      for (let hop = 0; cur && hop < 4; hop += 1) {
        const indexed = (await passageCountOf(cur)) > 0;
        if (stale) return;
        if (indexed) { setSearchableSourceId(cur); return; }
        cur = await sourceDocumentOf(cur);
        if (stale) return;
      }
      if (!stale) setSearchableSourceId(null);
    })();
    return () => { stale = true; };
  }, [doc?.source_document_id, passageCount]);
  useEffect(() => {
    const mid = doc?.matterspace_id;
    if (!mid) { setMatterName(null); return; }
    let stale = false;
    void (async () => {
      const { data } = await supabase
        .from('matterspaces')
        .select('name, serverspace_id')
        .eq('id', mid)
        .maybeSingle();
      if (stale) return;
      setMatterName(data?.name ?? null);
      let lib = false;
      if (data?.serverspace_id) {
        const { data: ss } = await supabase
          .from('serverspaces')
          .select('name')
          .eq('id', data.serverspace_id)
          .maybeSingle();
        lib = String(ss?.name ?? '').trim().toLowerCase() === LIBRARY_SERVERSPACE;
      }
      if (!stale) setInLibrary(lib);
    })();
    return () => { stale = true; };
  }, [doc?.matterspace_id]);

  // File this book to the Office Library: the shelf is the matter's name,
  // made on first use. The jacket is captured afterwards and reported as it
  // goes; the filing itself is done by then.
  const fileToOfficeLibrary = useCallback(async () => {
    if (!doc || !matterName) return;
    setFiling({ step: 'working', text: `Filing "${doc.title}"…` });
    try {
      const section = await findOrCreateLibrarySection(matterName);
      const res = await publishDocumentToOffice(doc.id, section);
      if (res.status === 'already') {
        setFiling({ step: 'done', text: `"${doc.title}" is already on the ${section.title} shelf.` });
        return;
      }
      setFiling({ step: 'working', text: `"${doc.title}" is on the ${section.title} shelf. Capturing the jacket…` });
      const got = await captureJacket(res.itemId, doc.id, (done, total) => {
        setFiling({ step: 'working', text: `Capturing the pages of "${doc.title}"… ${done} of ${total}` });
      });
      setFiling({
        step: 'done',
        text: got?.pages
          ? `"${doc.title}" is in the Office Library (${section.title}), jacket and ${got.pages} pages.`
          : `"${doc.title}" is in the Office Library (${section.title}).`,
      });
    } catch (e) {
      setFiling({ step: 'done', text: e instanceof Error ? e.message : 'The book could not be filed.' });
    }
  }, [doc, matterName]);
  useEffect(() => {
    if (filing?.step !== 'done') return;
    const t = window.setTimeout(() => setFiling((f) => (f?.step === 'done' ? null : f)), 8000);
    return () => window.clearTimeout(t);
  }, [filing]);
  // The text of each page on screen, from the PDF's own text layer (the
  // same cache the search fills). Fetched as pages come into view.
  useEffect(() => {
    if (loadState !== 'ready' || fileKind !== 'pdf') { setPageTexts({}); return; }
    const pdf = pdfDocRef.current as {
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string }[] }> }>;
    } | null;
    if (!pdf) return;
    let stale = false;
    const wanted = visiblePages.map((v) => v.page);
    void Promise.all(wanted.map(async (p) => {
      const cached = pageTextCacheRef.current[p - 1];
      if (cached !== undefined) return [p, cached] as const;
      try {
        const content = await (await pdf.getPage(p)).getTextContent();
        const text = content.items.map((i) => i.str || '').join(' ');
        pageTextCacheRef.current[p - 1] = text;
        return [p, text] as const;
      } catch {
        return [p, ''] as const; // a page without text leaves the companion its number
      }
    })).then((entries) => {
      if (!stale) setPageTexts(Object.fromEntries(entries));
    });
    return () => { stale = true; };
  }, [visiblePages, loadState, fileKind, id]);
  useEffect(() => {
    if (!doc) return;
    const pdf = fileKind === 'pdf';
    setOrchestratorContext({
      matterId: doc.matterspace_id ?? undefined,
      matterName: matterName ?? undefined,
      documentId: doc.id,
      documentTitle: doc.title,
      page: pdf ? (visiblePages[0]?.page ?? page) : undefined,
      pageCount: pdf && totalPages ? totalPages : undefined,
      pages: pdf
        ? visiblePages.map((v) => ({
          page: v.page,
          share: v.share,
          text: (pageTexts[v.page] ?? '').replace(/\s+/g, ' ').trim().slice(0, 2500) || undefined,
        }))
        : undefined,
      indexed: passageCount === null ? undefined : passageCount > 0,
      sourceDocumentId: searchableSourceId ?? undefined,
      unindexedReason: passageCount === 0
        ? (doc.text_status === 'generated' ? 'generated' : 'not-ingested')
        : undefined,
    });
  }, [doc, matterName, page, totalPages, visiblePages, pageTexts, fileKind, passageCount, searchableSourceId]);
  useEffect(() => () => {
    // Leaving: take the document out of the context, unless another view
    // has already put its own there.
    if (getOrchestratorContext().documentId === id) clearOrchestratorContext();
  }, [id]);

  // Ask about the book, or about a passage. With a quote the question is
  // put outright, framed so the answer reads it rather than acts on it;
  // without one the panel opens scoped to the book, for whatever the
  // reader wants to ask.
  const pageOfNode = useCallback((node: Node | null | undefined): number | undefined => {
    return bookRef.current?.pageOfNode(node);
  }, []);
  const askAbout = useCallback((quote?: string, atPage?: number) => {
    if (!doc) return;
    const p = atPage ?? visiblePages[0]?.page ?? page;
    const where = fileKind === 'pdf' ? `p. ${p} of “${doc.title}”` : `“${doc.title}”`;
    const q = quote?.replace(/\s+/g, ' ').trim();
    runInAssistant({
      matterId: doc.matterspace_id ?? undefined,
      matterName: matterName ?? undefined,
      // The passage goes into the box, cursor after it; the reader asks the
      // question. Nothing is sent until they do.
      draft: q ? `On ${where}: “${q.slice(0, 1200)}” — ` : undefined,
    });
  }, [doc, fileKind, page, matterName, visiblePages]);
  const handleDownload = useCallback(async () => {
    if (!doc?.storage_path || downloading) return;
    setDownloading(true);
    try {
      // Every matter, sealed or not: a download is a copy leaving, and the
      // endpoint writes `file.exported {destination:'download'}` to the
      // matter's Record before it hands over the link (S4a).
      let blob: Blob;
      try {
        ({ blob } = await downloadDocumentFile(doc.id));
      } catch (e) {
        if (isStepUpRequired(e)) {
          setStepUp({ mode: e.mode, matterId: e.matterId ?? doc.matterspace_id ?? null, retry: 'download' });
        } else {
          setErrorMsg(e instanceof Error ? e.message : 'Failed to download the file.');
        }
        return;
      }
      // The stored name carries the real extension; the fallback only
      // matters when it is missing, and then the kind is the best guess.
      const storedExt = (doc.source_filename || doc.storage_path).match(/\.[a-z0-9]+$/i)?.[0];
      const ext = storedExt
        ?? (fileKind === 'pdf' ? '.pdf' : fileKind === 'pptx' ? '.pptx' : fileKind === 'image' ? '.png' : '.docx');
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

  // ── The book's three doors (src/components/reader/PdfBook.tsx) ─────
  // The matter's data, handed to the book through the three interfaces it
  // takes: the file and what is laid on it, the reader's marks, the bench.
  // The book knows nothing of matters; everything here is what makes it a
  // Contextspaces document.

  // The file. Keyed by the document and the reload counter, so a rename or
  // a new cover never reopens the PDF.
  const docId = doc?.id ?? null;
  const storagePath = doc?.storage_path ?? null;
  const fileSize = doc?.file_size_bytes ?? null;
  const pdfSource = useMemo<PdfSource | null>(() => {
    if (fileKind !== 'pdf' || !id || !docId || docId !== id || !storagePath) return null;
    const documentId = docId;
    return {
      key: `${documentId}:${reloadKey}`,
      // A PDF is opened by ranges, page by page, so a scanned book paints
      // its first page in a second instead of after the whole file has
      // arrived (src/lib/pdf-source.ts).
      openPdf: (onProgress) => openStoredPdf(storagePath, { sizeBytes: fileSize, onProgress }),
      // The clips attached to this document (migration 062).
      listIllustrations: () => listAnimations(documentId),
      removeIllustration: async (animationId) => {
        const err = await deleteAnimation(animationId);
        if (err) throw new Error(err);
      },
      // The indexed text first. It is what search reads everywhere else in
      // the app, it is one query, and for most OCR'd books it is the only
      // place the words exist: the scan's PDF carries no text layer at all
      // (Brandeis's Other People's Money found nothing for "money"). Hits
      // name the page; the boxes over the words come from the text layer
      // when the page has one.
      findInIndex: async (q) => {
        const found: Match[] = [];
        // A phrase matches across any whitespace: a transcript's text is broken
        // by line ("individual\nstudents"), and the brief quotes it in one line.
        const re = phraseRegex(q);
        const countIn = (text: string, page: number) => {
          re.lastIndex = 0;
          for (let m = re.exec(text); m; m = re.exec(text)) {
            found.push({ page, index: m.index });
            if (!m[0].length) re.lastIndex += 1;
          }
        };
        const { data } = await supabase
          .from('passages')
          .select('page_start, text, metadata')
          .eq('document_id', documentId)
          .eq('summary_level', 0)
          .ilike('text', likePattern(q))
          .order('page_start', { ascending: true })
          .limit(2000);
        type Row = { page_start: number | null; text: string | null; metadata: { pdf_page?: unknown } | null };
        for (const row of (data ?? []) as Row[]) {
          if (!row.text) continue;
          // A transcript's passages are filed under the printed page; the
          // page to go to is the physical one, metadata.pdf_page (four
          // printed pages sit on one sheet of a condensed transcript).
          const physical = Number(row.metadata?.pdf_page);
          const page = Number.isFinite(physical) && physical > 0 ? physical : row.page_start;
          if (!page) continue;
          countIn(row.text, page);
        }
        return found;
      },
    };
  }, [fileKind, id, docId, storagePath, fileSize, reloadKey]);

  // Cross-references: notes in OTHER documents whose links point here. The
  // book's rails draw them; they are read with the marks and refreshed with
  // them (the marks store's subscription below).
  const refreshIncoming = useCallback(async () => {
    if (!id) return;
    const incoming = await listIncomingLinks(id);
    setIncomingLinks(incoming);
  }, [id]);
  useEffect(() => {
    if (fileKind !== 'pdf' || loadState !== 'ready') return;
    void refreshIncoming();
  }, [fileKind, loadState, refreshIncoming]);

  // The reader's highlights: document_annotations (020/048), kept live —
  // margin notes are collaborative, so a teammate's note should appear
  // without a reload (the matter_comments realtime pattern; RLS filters
  // what each subscriber may see).
  const marksStore = useMemo<MarksStore | null>(() => {
    if (!id) return null;
    const documentId = id;
    return {
      list: () => listAnnotations(documentId),
      create: ({ page, color, rects, anchorText }) =>
        createAnnotation({ documentId, page, color, rects, anchorText, textAnchor: null }),
      update: (annId, patch) => updateAnnotation(annId, patch),
      remove: (annId) => deleteAnnotation(annId),
      subscribe: (onChange) => {
        const channel = supabase
          .channel(`doc-annotations-${documentId}`)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'document_annotations', filter: `document_id=eq.${documentId}` },
            () => { onChange(); void refreshIncoming(); },
          )
          .subscribe();
        return () => { void supabase.removeChannel(channel); };
      },
    };
  }, [id, refreshIncoming]);

  // The Workshop bench (migration 106): snips and snippets on the bench, a
  // clip or a still brought back filed in the matter (store-only, never
  // transcribed), the decision laid on the page as a living illustration
  // (062). A document outside any matter has no bench.
  const matterId = doc?.matterspace_id ?? null;
  const canWrite = !!user;
  const benchStore = useMemo<BenchStore | null>(() => {
    if (!docId || !matterId) return null;
    const documentId = docId;
    return {
      canWrite,
      list: () => listWorkshopItems(documentId),
      createSnip: ({ page, rect }) => createSnip({ documentId, page, rect }),
      createSnippet: ({ page, text, rect }) => createSnippet({ documentId, page, text, rect }),
      update: (itemId, patch) => updateWorkshopItem(itemId, patch),
      remove: async (itemId) => {
        const err = await deleteWorkshopItem(itemId);
        if (err) throw new Error(err);
      },
      bringIn: async (parent, file, page) => {
        const matter = await resolveVaultMatter(matterId);
        if (!matter) throw new Error("This document's matter could not be read.");
        const { documentId: mediaDocumentId } = await persistVaultFile(matter, file, { storeOnly: true, ingestDeclaration: null });
        const item = await addMedia({
          documentId, page, parentId: parent?.id ?? null,
          mediaDocumentId, label: file.name.replace(/\.[^.]+$/, ''),
        });
        return { item, notice: `"${file.name}" is on the bench and filed in the matter (not transcribed).` };
      },
      lay: async (media, source) => {
        if (!source.rect || !media.media_document_id) throw new Error('It could not be laid on the page.');
        const { animation, error } = await createAnimation({
          documentId, mediaDocumentId: media.media_document_id,
          page: source.page, rect: source.rect, turn: source.turn, loops: true,
          label: media.label ?? source.label ?? null,
        });
        if (error || !animation) throw new Error(error ?? 'It could not be laid on the page.');
        return animation;
      },
    };
  }, [docId, matterId, canWrite]);

  // "Add a clip" from the sidebar: the rectangle is the book's; which clip
  // plays there is the matter's (AnimationAttach offers the matter's clips).
  const renderAttach = useCallback((a: AttachArgs) => (docId ? (
    <AnimationAttach
      documentId={docId}
      matterId={matterId}
      page={a.page}
      rect={a.rect}
      makePreview={a.makePreview}
      onSaved={a.onSaved}
      onClose={a.onClose}
    />
  ) : null), [docId, matterId]);

  // What the book shows, mirrored here for the companion and the toolbar;
  // the open file, for the whole-document copy and the page texts.
  const onBookView = useCallback((v: PdfBookView) => {
    setLoadState(v.state);
    setPage(v.page);
    setTotalPages(v.totalPages);
    setVisiblePages(v.visiblePages);
  }, []);
  const onBookOpened = useCallback((pdf: PDFDocumentProxy) => { pdfDocRef.current = pdf; }, []);
  // The file refused: a sealed matter's file asked for on a session that has
  // not confirmed a second factor (S4a: /api/document-url refuses it), or a
  // plain failure.
  const onBookError = useCallback((err: unknown) => {
    if (isStepUpRequired(err)) {
      setStepUp({ mode: err.mode, matterId: err.matterId ?? matterId, retry: 'load' });
    } else {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to open the document.');
    }
  }, [matterId]);
  const bookMeta = useMemo(
    () => ({ title: doc?.title ?? null, pageCount: doc?.page_count ?? null }),
    [doc?.title, doc?.page_count],
  );
  // ?page= belongs to the route's own Reader. An embedded one (a canvas
  // card, the desk's pane) shares the URL with its host and is steered by
  // the `goto` prop instead.
  const linked = embedded ? NaN : parseInt(searchParams.get('page') ?? '', 10);
  const pageLink = useMemo<PageLink | null>(
    () => (embedded ? null : { page: linked, key: searchParams.toString() }),
    [embedded, linked, searchParams],
  );
  // The selection menu's Note, on the book: the composer opens over the words.
  const openNoteComposer = useCallback((sel: BookSelection) => {
    setNoteComposer({ x: sel.x, y: sel.y, page: sel.page, rects: sel.rects, anchorText: sel.anchorText });
  }, []);

  // A rendered document's marks (a PDF's are the book's, through the marks
  // store above), loaded once per document and kept live the same way:
  // margin notes are collaborative, so a teammate's note should appear
  // without a reload (the matter_comments realtime pattern; RLS filters
  // what each subscriber may see).
  // Documents without pages load the same rows; theirs carry text_anchor.
  useEffect(() => {
    if (!id || loadState !== 'ready' || fileKind === 'pdf') return;
    let cancelled = false;
    const refresh = async () => {
      const rows = await listAnnotations(id);
      if (!cancelled) {
        setAnnotations(rows);
        setTextMarksOn(textAnchorsAvailable());
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

  // The same selection menu for a rendered document (Word, text, markdown,
  // slides, screenplay). There is no page and no text layer: the selection
  // is anchored by its character offsets in the rendered text plus the
  // quoted words (src/lib/text-anchor.ts), and the menu opens over it.
  // PDFs never reach this effect.
  useEffect(() => {
    if (loadState !== 'ready' || fileKind === 'pdf' || !textMarksOn) return;

    function captureTextSelection() {
      const sel = window.getSelection();
      const root = contentRef.current?.querySelector<HTMLElement>('.print-root');
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root) {
        setSelectionMenu(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const anchor = anchorFromRange(root, range);
      if (!anchor) {
        setSelectionMenu(null);
        return;
      }
      const union = range.getBoundingClientRect();
      if (union.width === 0 && union.height === 0) {
        setSelectionMenu(null);
        return;
      }
      setSelectionMenu({
        x: union.left + union.width / 2,
        y: union.top - 8,
        page: 1,
        rects: [],
        anchorText: anchor.exact.slice(0, 1000),
        textAnchor: anchor,
      });
    }

    // Mouse: on release. Touch (iPhone): the selection is made and adjusted
    // with handles, which fire no mouseup, so settle on selectionchange once
    // it has been still for a moment and no finger or button is down.
    let down = false;
    let timer: number | undefined;
    const onDown = () => { down = true; };
    const onUp = () => { down = false; };
    const onSelChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (!down) captureTextSelection(); }, 350);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    document.addEventListener('mouseup', captureTextSelection);
    document.addEventListener('selectionchange', onSelChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('mouseup', captureTextSelection);
      document.removeEventListener('selectionchange', onSelChange);
    };
  }, [loadState, fileKind, textMarksOn]);

  const saveAnnotation = useCallback(
    async (color: AnnotationColor) => {
      if (!id || !selectionMenu) return;
      const ann = await createAnnotation({
        documentId: id,
        page: selectionMenu.page,
        color,
        rects: selectionMenu.rects,
        anchorText: selectionMenu.anchorText,
        textAnchor: selectionMenu.textAnchor ?? null,
      });
      // A text mark refused because migration 084 is missing switches the
      // menu off for rendered documents (a PDF never takes this branch).
      if (!ann && selectionMenu.textAnchor) setTextMarksOn(textAnchorsAvailable());
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
    [id, selectionMenu],
  );

  const removeAnnotation = useCallback(async (annId: string) => {
    // A PDF's marks are the book's: it removes, and reports the list back.
    if (fileKind === 'pdf') { await bookRef.current?.removeMark(annId); return; }
    const ok = await deleteAnnotation(annId);
    if (ok) {
      setAnnotations((prev) => prev.filter((a) => a.id !== annId));
      createdRef.current = createdRef.current.filter((x) => x !== annId);
      setUndoDepth(createdRef.current.length);
      setUndoable((u) => (u?.id === annId ? null : u));
    }
  }, [fileKind]);

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
  // What flanks each page of the book: cross-references on the left, the
  // margin notes on the right — the matter's parts, drawn by the book's
  // page slots. Memoized with the slots' other props so a scroll does not
  // rebuild them.
  const pageSides = useMemo<PageSides>(() => ({
    width: isMobile ? NOTE_RAIL_W_MOBILE : NOTE_RAIL_W,
    render: (p, marks) => ({
      before: (
        <CrossRefRail
          refs={incomingLinks.filter((r) => r.target_page === p)}
          isMobile={isMobile}
          onOpen={openRefAt}
        />
      ),
      after: (
        <NotesRail
          notes={marks.filter((a) => a.page === p && annotationIsNote(a))}
          currentUserId={user?.id ?? null}
          isMobile={isMobile}
          onOpen={openNoteAt}
        />
      ),
    }),
  }), [isMobile, incomingLinks, openRefAt, openNoteAt, user?.id]);

  // Save a margin note: derive page:line deterministically from the ingested
  // passages (transcripts get real line numbers; everything else stays
  // page-only — the verbatim quote in anchor_text is the ground truth),
  // persist, then attach any document links.
  const saveNote = useCallback(
    async (args: { body: string; visibility: AnnotationVisibility; links: ComposerLink[] }) => {
      if (!id || !noteComposer) return;
      // page:line comes from ingested transcript passages, which a document
      // without pages cannot be matched against; its anchor is the text.
      const derived = noteComposer.textAnchor
        ? null
        : await derivePageLine(id, noteComposer.page, noteComposer.anchorText);
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
        textAnchor: noteComposer.textAnchor ?? null,
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
        if (fileKind === 'pdf') await bookRef.current?.reloadMarks();
        else setAnnotations((prev) => [...prev, { ...ann, links: savedLinks }]);
      }
      setNoteComposer(null);
    },
    [id, noteComposer, fileKind],
  );

  const editNote = useCallback(
    async (annId: string, body: string, visibility: AnnotationVisibility) => {
      const ok = await updateAnnotation(annId, { note: body, visibility });
      if (ok) {
        if (fileKind === 'pdf') { await bookRef.current?.reloadMarks(); return; }
        setAnnotations((prev) =>
          prev.map((a) => (a.id === annId ? { ...a, note: body, visibility } : a)),
        );
      }
    },
    [fileKind],
  );

  // The keys of a rendered document (a PDF's, the arrows among them, are the
  // book's): F for full screen, Ctrl-Z for the last highlight. The arrows
  // stay the reader's — one page, nothing to turn to — as they always were.
  useEffect(() => {
    if (fileKind === 'pdf') return;
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      if (
        tgt instanceof HTMLInputElement ||
        tgt instanceof HTMLTextAreaElement ||
        tgt?.isContentEditable
      ) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        if (createdRef.current.length) { e.preventDefault(); undoLastHighlight(); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fileKind, toggleFullscreen, undoLastHighlight]);

  // ────────────────────────────────────────────────────────────────────
  // Search, for a rendered document (a PDF's is the book's).
  // ────────────────────────────────────────────────────────────────────
  // Light the matches of a rendered (non-PDF) document and bring the
  // current one to the middle of the pane. Without the Highlight API the
  // current hit is selected instead, so it still shows.
  const showTextMatch = useCallback((ranges: Range[], current: number) => {
    const hl = customHighlights();
    const cur = ranges[current];
    if (hl) {
      if (ranges.length) hl.registry.set(FIND_HL, new hl.Highlight(...ranges));
      else hl.registry.delete(FIND_HL);
      if (cur) hl.registry.set(FIND_HL_CURRENT, new hl.Highlight(cur));
      else hl.registry.delete(FIND_HL_CURRENT);
    } else if (cur) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(cur);
    }
    if (!cur) return;
    // Scroll whatever actually scrolls around the match. In 'pane' chrome (the
    // Brief Desk) the scroller is .reader-scroll, not the content element, and
    // scrolling the wrong one left every match painted but out of view
    // (Eden, 09-28: "Find in text in cases is not working").
    let node: Node | null = cur.startContainer;
    let scroller: HTMLElement | null = null;
    while (node && node !== document.body) {
      if (node instanceof HTMLElement) {
        const cs = getComputedStyle(node);
        if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1) { scroller = node; break; }
      }
      node = node.parentNode;
    }
    const pane = scroller ?? contentRef.current;
    if (!pane) return;
    const rect = cur.getBoundingClientRect();
    const pr = pane.getBoundingClientRect();
    pane.scrollBy({ top: rect.top - pr.top - pr.height / 2 + rect.height / 2, behavior: 'smooth' });
  }, []);
  const clearTextMatches = useCallback(() => {
    textRangesRef.current = [];
    const hl = customHighlights();
    hl?.registry.delete(FIND_HL);
    hl?.registry.delete(FIND_HL_CURRENT);
  }, []);
  // A new document, or leaving: nothing of the old search should linger.
  useEffect(() => clearTextMatches, [docHtml, clearTextMatches]);

  // Paint the marks of a rendered document. Each anchor is turned back into
  // a Range over the current DOM (offsets first, then the quote), and the
  // Ranges are handed to the Custom Highlight API, which paints without
  // touching the DOM, so copy and find see the text exactly as before.
  // Runs again whenever the rendered HTML changes (new nodes, stale Ranges).
  // A mark whose words cannot be found is listed as unplaced, not painted.
  // Without the Highlight API (older Safari) nothing is painted, and the
  // marks panel still lists every mark.
  const textMarks = useMemo(
    () => (fileKind === 'pdf' ? [] : annotations.filter((a) => isTextAnchor(a.text_anchor))),
    [annotations, fileKind],
  );
  const textMarkRangesRef = useRef<Map<string, Range>>(new Map());
  const [unplacedMarks, setUnplacedMarks] = useState<string[]>([]);
  useEffect(() => {
    if (fileKind === 'pdf' || loadState !== 'ready') return;
    const root = contentRef.current?.querySelector<HTMLElement>('.print-root');
    const ranges = new Map<string, Range>();
    const unplaced: string[] = [];
    if (root && textMarks.length) {
      const flat = flattenText(root);
      for (const a of textMarks) {
        const at = offsetsFromAnchor(flat.text, a.text_anchor as TextAnchor);
        const r = at ? rangeFromOffsets(flat, at.start, at.end) : null;
        if (r) ranges.set(a.id, r);
        else unplaced.push(a.id);
      }
    }
    textMarkRangesRef.current = ranges;
    setUnplacedMarks((prev) => (prev.join() === unplaced.join() ? prev : unplaced));
    const hl = customHighlights();
    if (!hl) return;
    const names: string[] = [];
    const paint = (name: string, list: Annotation[]) => {
      const rs = list.map((a) => ranges.get(a.id)).filter((r): r is Range => !!r);
      if (!rs.length) return;
      const h = new hl.Highlight(...rs) as { priority?: number };
      h.priority = -1;
      hl.registry.set(name, h);
      names.push(name);
    };
    const highlights = textMarks.filter((a) => !annotationIsNote(a));
    for (const c of ANN_HL_COLORS) paint(annHl(c), highlights.filter((a) => a.color === c));
    paint(ANN_HL_NOTE, textMarks.filter(annotationIsNote));
    return () => {
      for (const n of names) hl.registry.delete(n);
    };
  }, [fileKind, loadState, textMarks, docHtml, titlePageHtml]);

  // Bring a mark's words to the middle of the pane.
  const scrollToTextMark = useCallback((annId: string) => {
    const r = textMarkRangesRef.current.get(annId);
    const pane = contentRef.current;
    if (!r || !pane) return;
    const rect = r.getBoundingClientRect();
    const pr = pane.getBoundingClientRect();
    pane.scrollBy({ top: rect.top - pr.top - pr.height / 2 + rect.height / 2, behavior: 'smooth' });
  }, []);
  const [marksOpen, setMarksOpen] = useState(!isMobile);

  // The query the current `matches` answer.
  const searchedQueryRef = useRef('');
  const runSearch = useCallback((query: string) => {
    const q = query.trim();
    searchedQueryRef.current = q;
    if (!q) {
      setSearching(false);
      setMatches([]);
      setMatchIdx(0);
      setSearched(false);
      clearTextMatches();
      return;
    }
    // The rendered document is the text. Every non-PDF page carries
    // .print-root, whatever wrapper sits inside it.
    const root = contentRef.current?.querySelector<HTMLElement>('.print-root');
    const ranges = root ? findInRendered(root, q) : [];
    textRangesRef.current = ranges;
    setMatches(ranges.map((_, i) => ({ page: 1, index: i })));
    setMatchIdx(0);
    setSearched(true);
    showTextMatch(ranges, 0);
  }, [clearTextMatches, showTextMatch]);

  // A query typed but not yet searched is searched first: the arrows (and
  // Enter) never sit dead beside words in the box (Eden, 10-01: typed a word,
  // clicked the arrow, nothing happened).
  const unsearched = () => searchQuery.trim() !== searchedQueryRef.current;
  const goNextMatch = useCallback(() => {
    if (searchQuery.trim() !== searchedQueryRef.current) { runSearch(searchQuery); return; }
    if (matches.length === 0) return;
    const next = (matchIdx + 1) % matches.length;
    setMatchIdx(next);
    showTextMatch(textRangesRef.current, next);
  }, [matchIdx, matches, showTextMatch, searchQuery, runSearch]);
  const goPrevMatch = useCallback(() => {
    if (searchQuery.trim() !== searchedQueryRef.current) { runSearch(searchQuery); return; }
    if (matches.length === 0) return;
    const next = (matchIdx - 1 + matches.length) % matches.length;
    setMatchIdx(next);
    showTextMatch(textRangesRef.current, next);
  }, [matchIdx, matches, showTextMatch, searchQuery, runSearch]);
  // Search as you type, once the typing pauses.
  useEffect(() => {
    if (!searchOpen) return;
    if (searchQuery.trim() === searchedQueryRef.current) return;
    const t = setTimeout(() => { runSearch(searchQuery); }, 450);
    return () => clearTimeout(t);
  }, [searchOpen, searchQuery, runSearch]);
  const closeSearch = useCallback(() => {
    searchedQueryRef.current = '';
    setSearching(false);
    setSearchOpen(false);
    setSearchQuery('');
    setMatches([]);
    setMatchIdx(0);
    setSearched(false);
    clearTextMatches();
  }, [clearTextMatches]);

  // The host's `goto` (see ReaderGoto) for a PDF: the passage is looked up
  // here — its page, and its opening words to light — and handed to the
  // book, which applies it once its page stack is measured (and, on first
  // load, ahead of the remembered page).
  const [bookGoto, setBookGoto] = useState<PdfBookGoto | null>(null);
  useEffect(() => {
    if (!goto || fileKind !== 'pdf') return;
    let live = true;
    const nonce = goto.nonce;
    void (async () => {
      let target = goto.page ?? null;
      let phrase: string | null = null;
      if (goto.passageId) {
        const { data } = await supabase
          .from('passages')
          .select('page_start, text, metadata')
          .eq('id', goto.passageId)
          .maybeSingle();
        const row = data as { page_start: number | null; text: string | null; metadata: { pdf_page?: unknown } | null } | null;
        if (row) {
          // A transcript's passages are filed under its printed page; the
          // physical page, the one to go to, is metadata.pdf_page.
          const physical = Number(row.metadata?.pdf_page);
          target = target ?? (Number.isFinite(physical) && physical > 0 ? physical : row.page_start);
          phrase = row.text ? firstWords(row.text, 12) : null;
        }
      }
      if (!live) return; // a newer goto arrived meanwhile
      setBookGoto({ page: target, phrase, nonce });
    })();
    return () => { live = false; };
  }, [goto, fileKind]);

  // The same `goto` for a rendered document, applied once per nonce, as
  // soon as it is rendered.
  const appliedGotoRef = useRef<number | null>(null);
  useEffect(() => {
    if (!goto || appliedGotoRef.current === goto.nonce || loadState !== 'ready') return;
    if (fileKind === 'pdf' || !docHtml) return;
    appliedGotoRef.current = goto.nonce;
    const nonce = goto.nonce;
    void (async () => {
      let phrase: string | null = null;
      if (goto.passageId) {
        const { data } = await supabase
          .from('passages')
          .select('text')
          .eq('id', goto.passageId)
          .maybeSingle();
        const row = data as { text: string | null } | null;
        if (row) phrase = row.text ? firstWords(row.text, 12) : null;
      }
      if (appliedGotoRef.current !== nonce) return; // a newer goto arrived meanwhile
      const root = contentRef.current?.querySelector<HTMLElement>('.print-root');
      if (!root) return;
      let ranges: Range[] = [];
      // "at 2 n.1": the note itself, by position (mammoth's ids are its own,
      // not Word's numbers). Falls through to the passage when there is none.
      if (goto.footnote) {
        const notes = root.querySelectorAll<HTMLElement>('li[id^="footnote-"]');
        const li = notes[goto.footnote - 1];
        if (li) {
          const r = document.createRange();
          r.selectNodeContents(li);
          ranges = [r];
        }
      }
      if (!ranges.length && goto.anchor) {
        const flat = flattenText(root);
        const at = offsetsFromAnchor(flat.text, goto.anchor);
        const r = at ? rangeFromOffsets(flat, at.start, at.end) : null;
        if (r) ranges = [r];
      }
      // A passage's text and the rendered document differ at the edges
      // (headers, joined lines); a shorter opening finds more often.
      for (const n of [12, 6, 3]) {
        if (ranges.length || !phrase) break;
        ranges = findInRendered(root, firstWords(phrase, n));
      }
      if (!ranges.length) return;
      textRangesRef.current = ranges;
      setMatches(ranges.map((_, i) => ({ page: 1, index: i })));
      setMatchIdx(0);
      showTextMatch(ranges, 0);
    })();
  }, [goto, loadState, fileKind, docHtml, showTextMatch]);

  // ────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────
  const rootBg = theme === 'dark' ? '#000000' : '#f3ecd9';

  // Back, or close. A host that opened this reader in place (a canvas card,
  // or the Vault's overlay over its file list) closes it itself — there is
  // no history to walk back through, and walking it would drop the user
  // outside the surface they were in.
  const closeReader = () => {
    if (onClose) { onClose(); return; }
    if (embedded) return;
    // In a fresh tab (opened from the Bucketizer or a shared link)
    // there is no history to go back to — land on the document's
    // matter instead of silently doing nothing.
    if (window.history.length > 1) navigate(-1);
    else if (doc?.matterspace_id) navigate(`/app/matterspace/${doc.matterspace_id}`);
    else navigate('/app');
  };

  // The title, editable in place, with the pencil making it visible.
  const titleNode = (
    <>
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
      {doc && !isMobile && (
        <button
          onClick={startDocRename}
          className="p-1 rounded-md text-white/35 hover:text-[#e8b84a] hover:bg-[rgba(255,255,255,0.06)] transition-colors shrink-0"
          title="Rename this document"
          aria-label="Rename this document"
        >
          <Pencil size={13} strokeWidth={1.75} />
        </button>
      )}
    </>
  );

  // The matter's own actions on the toolbar, in the places they have always
  // had: after the find box, and after full screen (desktop) or in the
  // phone's "more" menu. The same nodes serve the book and a rendered
  // document.
  const toolbarStart = (
    <>
      {doc && inLibrary && !isMobile && (
        <button
          onClick={() => setFiling((f) => (f ? null : { step: 'confirm' }))}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-[#e8b84a]/80 hover:text-[#e8b84a]"
          title="File to Office Library — put this book on the public Office shelf"
          aria-label="File to Office Library"
        >
          <BookMarked size={15} />
        </button>
      )}
      {doc && (
        <button
          onClick={() => askAbout()}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-[#e8b84a]/80 hover:text-[#e8b84a]"
          title="Ask about this document — the Assistant, with this page in front of it"
          aria-label="Ask about this document"
        >
          <MessageCircle size={15} />
        </button>
      )}
    </>
  );
  const toolbarEnd = (
    <>
      {fileKind === 'pdf' && !hidePageEditor && (
        <button
          onClick={() => setPageEditorOpen(true)}
          disabled={loadState !== 'ready' || !doc?.storage_path}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
          title="Edit pages — cut, rotate, reorder, or put in pages from another copy; saved as a new PDF"
        >
          <Scissors size={15} />
        </button>
      )}
      {!hideCover && (
        <CoverModeToggle
          hasCover={!!doc?.cover_url}
          expanded={coverExpanded}
          onToggle={() => setCoverExpanded(!coverExpanded)}
        />
      )}
      {!embedded && id && (doc?.doc_type === 'brief' || /\.(docx|md|markdown|txt)$/i.test(doc?.source_filename ?? '')) && (
        <button
          onClick={() => navigate(`/app/brief/${id}`)}
          className="h-8 px-2 inline-flex items-center gap-1.5 rounded-md hover:bg-white/5 text-[12px] text-white/70 hover:text-white"
          title="Open it in the Brief Desk: edit it as text and check its cites. A filed document is copied in; the original stays as filed."
        >
          <PenLine size={14} /> <span className="hidden md:inline">Open in the Brief Desk</span>
        </button>
      )}
      {!embedded && (
        <CanvasPinToggle kind="document" id={id} title={doc?.title || 'Document'} />
      )}
      <div className="w-px h-5 bg-white/10 mx-1" />
      <button
        // Prevent the mousedown default so the text the user selected is
        // still selected when the click copies it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void handleCopyText()}
        disabled={copyState === 'busy' || loadState !== 'ready' || (fileKind !== 'pdf' && !docHtml && !imageUrl)}
        className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed ${copyState === 'failed' ? 'text-red-400' : copyState === 'done' ? 'text-emerald-400' : 'text-white/70'}`}
        title={
          copyState === 'done'
            ? 'Copied — paste into Word or anywhere'
            : copyState === 'failed'
              ? (copyNote ?? 'The copy did not go through — click again')
              : copyState === 'busy'
                ? 'Copying…'
                : fileKind === 'image'
                  ? 'Copy the picture — paste it into Word, a slide, or a chat'
                  : 'Copy the selected text — or the whole document as clean text when nothing is selected'
        }
      >
        {copyState === 'done' ? <Check size={15} /> : copyState === 'failed' ? <X size={15} /> : <Copy size={15} />}
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
      <DriveExportControl
        connected={connectedDrives}
        busy={driveExporting}
        disabled={!doc?.storage_path}
        onExport={(kind) => runDriveExport(kind)}
        onConnect={() => navigate('/app/connections')}
      />
      <button
        onClick={() => setDelegateOpen(true)}
        disabled={!doc?.matterspace_id}
        className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
        title={doc?.matterspace_id
          ? 'Delegate… — hand this document to an agent that can see its matter'
          : 'Delegate… is available once this document is filed under a matter.'}
        aria-label="Delegate…"
      >
        <Send size={15} />
      </button>
    </>
  );
  // On a phone the toolbar keeps only what a thumb needs — close, the
  // sidebar, find, zoom — and the rest waits behind one "more" button.
  const moreItems: MoreItem[] = [
    ...(fileKind === 'pdf' && !hidePageEditor ? [
      { icon: <Scissors size={14} />, label: 'Edit pages', run: () => setPageEditorOpen(true), disabled: loadState !== 'ready' || !doc?.storage_path },
    ] : []),
    { icon: <FileText size={14} />, label: fileKind === 'image' ? 'Copy the picture' : 'Copy the whole document', run: () => void handleCopyText(), disabled: copyState === 'busy' || loadState !== 'ready' || (fileKind !== 'pdf' && !docHtml && !imageUrl) },
    { icon: <Printer size={14} />, label: printing ? 'Printing…' : 'Print', run: () => void handlePrint(), disabled: printing || loadState !== 'ready' },
    { icon: <Download size={14} />, label: 'Download the original', run: () => void handleDownload(), disabled: downloading || !doc?.storage_path },
    ...(connectedDrives.length
      ? connectedDrives.map((kind) => ({
          icon: <HardDrive size={14} />,
          label: `Save to ${DRIVE_LABEL[kind]}`,
          run: () => runDriveExport(kind),
          disabled: driveExporting || !doc?.storage_path,
        }))
      : [
          // Never nothing: a reader with no drive connected is
          // told the feature exists and where to switch it on.
          { icon: <HardDrive size={14} />, label: 'Connect a drive to export…', run: () => navigate('/app/connections') },
        ]),
    { icon: <Send size={14} />, label: 'Delegate…', run: () => setDelegateOpen(true), disabled: !doc?.matterspace_id },
  ];

  // Between the toolbar and the page: what a copy, a save or an export said.
  const banners = (
    <>
      {copyState === 'failed' && copyNote && (
        <div className="flex items-center gap-3 px-3 py-2 text-xs border-b border-[var(--color-border)] bg-red-400/10 text-red-300" role="status">
          <span className="flex-1 min-w-0">{copyNote}</span>
          <button onClick={() => { setCopyState('idle'); setCopyNote(null); }} className="opacity-70 hover:opacity-100" aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}
      {savedCopy && (
        <div className="flex items-center gap-3 px-3 py-2 text-xs border-b border-[var(--color-border)] bg-[#4ade80]/10 text-[#4ade80]">
          <span className="flex-1 min-w-0 truncate">Saved the edited copy "{savedCopy.filename}" beside this document.</span>
          {savedCopy.documentId && (
            <button
              onClick={() => navigate(`/app/document/${savedCopy.documentId}`)}
              className="underline hover:no-underline shrink-0"
            >
              Open it
            </button>
          )}
          {savedCopy.downloadUrl && (
            <a href={savedCopy.downloadUrl} target="_blank" rel="noreferrer" className="underline hover:no-underline shrink-0">
              Download
            </a>
          )}
          <button onClick={() => setSavedCopy(null)} className="opacity-70 hover:opacity-100" aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}

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
              {driveBanner.linkLabel ?? 'Open in Drive'}
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

      {sealPrompt && (
        <SealedExportDialog
          message={sealPrompt.message}
          confirmLabel={`Save to ${DRIVE_LABEL[sealPrompt.drive]}`}
          busy={driveExporting}
          onCancel={() => setSealPrompt(null)}
          onConfirm={() => {
            const drive = sealPrompt.drive;
            setSealPrompt(null);
            runDriveExport(drive, { confirmLeaveSeal: true });
          }}
        />
      )}
    </>
  );

  // Filing to the Office Library: the question, then the progress, at the
  // foot of the page area.
  const filingNode = filing && (
    <div
      role={filing.step === 'confirm' ? 'dialog' : 'status'}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-3 py-2 rounded-lg bg-[#1a1a22] border border-white/15 shadow-2xl text-[13px] text-white/85 max-w-[min(92vw,640px)]"
    >
      {filing.step === 'confirm' ? (
        <>
          <span>
            File <span className="text-white">"{doc?.title}"</span> to the Office Library, on the{' '}
            <span className="text-white">{matterName}</span> shelf? It will be public in the Reading Room.
          </span>
          <button
            onClick={() => void fileToOfficeLibrary()}
            className="font-semibold text-[#e8b84a] hover:underline whitespace-nowrap"
          >
            File it
          </button>
          <button onClick={() => setFiling(null)} className="text-white/45 hover:text-white">
            Cancel
          </button>
        </>
      ) : (
        <>
          {filing.step === 'working' && <Loader2 size={13} className="animate-spin shrink-0 text-[#e8b84a]" />}
          <span>{filing.text}</span>
          {filing.step === 'done' && (
            <button onClick={() => setFiling(null)} className="text-white/45 hover:text-white" aria-label="Dismiss">
              <X size={13} />
            </button>
          )}
        </>
      )}
    </div>
  );

  // The matter's dialogs and cards, drawn over the page.
  const dialogs = (
    <>
      {delegateOpen && doc?.matterspace_id && (
        <DelegateCard
          matterId={doc.matterspace_id}
          attachment={{ kind: 'document', id: doc.id, label: doc.title || doc.source_filename || 'Document' }}
          defaultTitle={doc.title || doc.source_filename || 'Document'}
          onClose={() => setDelegateOpen(false)}
        />
      )}
      {pageEditorOpen && doc && (
        <PdfPageEditor
          doc={doc}
          onClose={() => setPageEditorOpen(false)}
          onSaved={({ filename, downloadUrl, documentId }) => setSavedCopy({ filename, downloadUrl, documentId })}
        />
      )}
      {ctxMenu && (
        <ReaderMenu
          at={ctxMenu}
          hasSelection={ctxMenu.hasSelection}
          onAskSel={() => {
            const sel = window.getSelection();
            askAbout(sel?.toString() ?? '', pageOfNode(sel?.anchorNode));
          }}
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
    </>
  );
  const noteCards = (
    <>
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
    </>
  );

  // A PDF is the book, with the matter's parts in its slots. The second
  // factor's prompt and an error are drawn in its reading pane; confirming
  // re-runs whatever was refused.
  if (fileKind === 'pdf') {
    return (
      <PdfBook
        ref={bookRef}
        source={pdfSource}
        marks={marksStore}
        bench={benchStore}
        currentUserId={user?.id ?? null}
        pane={pane}
        hideSidebarToggle={hideSidebarToggle}
        meta={bookMeta}
        pageMemoryKey={id ? `ctx_reader_page_${id}` : null}
        pageLink={pageLink}
        goto={bookGoto}
        onClose={closeReader}
        header={!hideCover ? (
          /* Cover image — same component Pages/Lists/Tables use. When no cover
             is set, this is a discoverable "Add cover" bar (subtle until hover);
             when set, a 180px banner; when expanded, becomes the page background
             via CSS variable so the reader chrome stays in front. */
          <CoverImage
            coverUrl={doc?.cover_url ?? null}
            onCoverChange={handleCoverChange}
            editable={!!doc}
            expanded={coverExpanded}
            onExpandChange={setCoverExpanded}
            persistKey={id ? `cs.doc.cover.${id}` : undefined}
          />
        ) : undefined}
        title={titleNode}
        toolbarStart={toolbarStart}
        toolbarEnd={toolbarEnd}
        moreItems={moreItems}
        banners={banners}
        notice={(stepUp || loadState === 'error') ? (
          <>
            {stepUp && (
              <div className="mt-10">
                <StepUpPrompt
                  mode={stepUp.mode}
                  matterId={stepUp.matterId ?? undefined}
                  onConfirmed={() => {
                    const retry = stepUp.retry;
                    setStepUp(null);
                    if (retry === 'load') setReloadKey((k) => k + 1);
                    else void handleDownload();
                  }}
                />
              </div>
            )}
            {loadState === 'error' && !stepUp && (
              <p className="mt-10 text-[13px] text-red-400">{errorMsg}</p>
            )}
          </>
        ) : null}
        paneChildren={filingNode}
        pageSides={pageSides}
        renderAttach={doc?.matterspace_id ? renderAttach : null}
        onAsk={askAbout}
        onNote={openNoteComposer}
        onCopySelection={() => void copySelection()}
        onContextMenu={openContextMenu}
        onOpened={onBookOpened}
        onError={onBookError}
        onView={onBookView}
        onMarks={setAnnotations}
      >
        {dialogs}
        {noteCards}
      </PdfBook>
    );
  }

  // A rendered document — Word, text, slides, a screenplay, a picture — in
  // the same chrome.
  return (
    <div
      ref={rootRef}
      className="flex flex-col h-full"
      style={{ backgroundColor: rootBg }}
    >
      <RenderedDocStyle theme={theme} />

      {/* Cover image — same component Pages/Lists/Tables use. When no cover
          is set, this is a discoverable "Add cover" bar (subtle until hover);
          when set, a 180px banner; when expanded, becomes the page background
          via CSS variable so the reader chrome stays in front. */}
      {loadState === 'ready' && !hideCover && (
        <CoverImage
          coverUrl={doc?.cover_url ?? null}
          onCoverChange={handleCoverChange}
          editable={!!doc}
          expanded={coverExpanded}
          onExpandChange={setCoverExpanded}
          persistKey={id ? `cs.doc.cover.${id}` : undefined}
        />
      )}

      <div className="flex items-center justify-between gap-2 px-3 h-12 overflow-hidden border-b border-[var(--color-border)] bg-[var(--color-surface)] backdrop-blur-md shrink-0">
        {/* On a phone the find box takes the row. The title's node stays —
            its text is set by hand, not by React — and is only hidden. */}
        <div className={`flex items-center gap-2 min-w-0 flex-1 ${isMobile && searchOpen ? 'hidden' : ''}`}>
          <button
            onClick={closeReader}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
            title="Close"
          >
            <X size={15} />
          </button>
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
          {titleNode}
        </div>
        <div className={`flex items-center gap-1 ${isMobile && searchOpen ? 'flex-1 min-w-0' : 'shrink-0'}`}>
          {loadState === 'ready' && !!docHtml && (
            <>
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
            </>
          )}
          {!(isMobile && searchOpen) && (
          <>
          {toolbarStart}
          <button
            onClick={() => setZoom(Math.max(0.5, +(zoom - 0.25).toFixed(2)))}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
            title="Zoom out"
          >
            <ZoomOut size={15} />
          </button>
          <span className="text-xs text-white/55 tabular-nums w-12 text-center">
            {/* An image fills the pane at the default zoom; say 100% for
                that, not the 150% the text formats' type size is scaled from. */}
            {fileKind === 'image'
              ? `${Math.round((zoom / 1.5) * 100)}%`
              : `${Math.round(zoom * 100)}%`}
          </span>
          <button
            onClick={() => setZoom(Math.min(4, +(zoom + 0.25).toFixed(2)))}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
            title="Zoom in"
          >
            <ZoomIn size={15} />
          </button>
          {!isMobile && (
          <>
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
            <div className="relative">
              <button
                ref={moreBtnRef}
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
                  anchor={moreBtnRef.current}
                  onClose={() => setMoreOpen(false)}
                  items={[
                    { icon: isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />, label: isFullscreen ? 'Exit full screen' : 'Full screen', run: toggleFullscreen },
                    ...moreItems,
                    { icon: theme === 'parchment' ? <Moon size={14} /> : <Sun size={14} />, label: theme === 'parchment' ? 'Dark mode' : 'Light mode', run: () => setTheme((t) => (t === 'parchment' ? 'dark' : 'parchment')) },
                  ]}
                />
              )}
            </div>
          )}
          </>
          )}
        </div>
      </div>

      {banners}

      <div className="flex-1 flex flex-row min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="relative flex-1 min-h-0 flex" onContextMenu={openContextMenu}>
          <div
            ref={contentRef}
            className={`reader-scroll flex-1 overflow-auto flex justify-center items-start ${paneChrome ? 'py-2 px-[6px]' : 'py-6 px-4'}`}
            style={{ backgroundColor: rootBg }}
          >
            {loadState === 'loading' && (
              <LoadingCard title={doc?.title ?? null} progress={loadProgress} pageCount={doc?.page_count ?? null} />
            )}
            {stepUp && (
              <div className="mt-10">
                <StepUpPrompt
                  mode={stepUp.mode}
                  matterId={stepUp.matterId ?? undefined}
                  onConfirmed={() => {
                    const retry = stepUp.retry;
                    setStepUp(null);
                    if (retry === 'load') setReloadKey((k) => k + 1);
                    else void handleDownload();
                  }}
                />
              </div>
            )}
            {loadState === 'error' && !stepUp && (
              <p className="mt-10 text-[13px] text-red-400">{errorMsg}</p>
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
                <div dangerouslySetInnerHTML={docHtmlProp} />
              </div>
            )}
            {loadState === 'ready' && fileKind === 'text' && docHtml && (
              <div
                className="text-book-page print-root max-w-3xl w-full mx-auto shadow-2xl"
                style={{
                  backgroundColor: '#fffdf6',
                  color: '#1a1810',
                  padding: isMobile ? '28px 22px' : '64px 88px',
                  fontFamily: 'Georgia, "Times New Roman", serif',
                  fontSize: `${Math.round(17 * (zoom / 1.5))}px`,
                  lineHeight: 1.75,
                  whiteSpace: 'pre-line',
                }}
              >
                <div dangerouslySetInnerHTML={docHtmlProp} />
              </div>
            )}
            {loadState === 'ready' && fileKind === 'image' && imageUrl && (
              // The figure is the pane's width and scrolls sideways when the
              // picture is zoomed past it; the picture is a block with auto
              // margins, so it is centred while it fits and left-anchored
              // (every pixel reachable by scrolling) once it does not. A
              // flex column with items-center would clip both edges instead.
              <figure className="image-page print-root w-full mx-auto overflow-x-auto">
                <img
                  src={imageUrl}
                  alt={doc?.title ?? 'Image'}
                  draggable={false}
                  onLoad={(e) => {
                    const el = e.currentTarget;
                    if (el.naturalWidth && el.naturalHeight) setImageDims({ w: el.naturalWidth, h: el.naturalHeight });
                  }}
                  className="block mx-auto h-auto shadow-2xl select-none"
                  // At 100% the picture is its own size or the pane's width,
                  // whichever is smaller — a 1024-px render stretched to a wide
                  // pane goes soft. Past 100% it is natural × zoom, deliberately
                  // wider than the pane if need be.
                  style={{
                    width: imageDims ? `${Math.round(imageDims.w * (zoom / 1.5))}px` : 'auto',
                    maxWidth: zoom <= 1.5 ? '100%' : 'none',
                    imageRendering: zoom > 3 ? 'pixelated' : 'auto',
                  }}
                />
                {imageDims && (
                  <figcaption className="mt-3 text-center text-[11px] text-white/45 tracking-wide print:hidden">
                    {imageDims.w} × {imageDims.h} px
                    {doc?.source_filename ? ` · ${doc.source_filename.slice(doc.source_filename.lastIndexOf('.') + 1).toUpperCase()}` : ''}
                    {doc?.file_size_bytes ? ` · ${doc.file_size_bytes >= 1048576 ? `${(doc.file_size_bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(doc.file_size_bytes / 1024))} KB`}` : ''}
                    {/* What a model wrote about it, said as such: a description
                        is never a quotation, and the words it saw in the
                        picture are given verbatim under their own heading. */}
                    {doc?.image_description?.line && (
                      <span className="block mt-1.5 text-white/60 normal-case tracking-normal">
                        <span className="text-white/35">AI description · </span>{doc.image_description.line}
                      </span>
                    )}
                    {doc?.image_description?.text && (
                      <span className="block mt-1 text-white/60 normal-case tracking-normal">
                        <span className="text-white/35">Words in the picture · </span>“{doc.image_description.text.slice(0, 300)}”
                      </span>
                    )}
                  </figcaption>
                )}
              </figure>
            )}
            {loadState === 'ready' && fileKind === 'pptx' && docHtml && (
              <div
                className="pptx-deck print-root max-w-3xl w-full mx-auto"
                style={{ fontSize: `${Math.round(16 * (zoom / 1.5))}px` }}
                dangerouslySetInnerHTML={docHtmlProp}
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
                    dangerouslySetInnerHTML={titlePageHtmlProp}
                  />
                )}
                {docHtml && (
                  <div
                    className="fountain-script"
                    dangerouslySetInnerHTML={docHtmlProp}
                  />
                )}
              </div>
            )}
          </div>
          {loadState === 'ready' && textMarks.length > 0 && (
            <TextMarksPanel
              marks={textMarks}
              unplaced={unplacedMarks}
              open={marksOpen}
              isMobile={isMobile}
              currentUserId={user?.id ?? null}
              onToggle={() => setMarksOpen((o) => !o)}
              onGo={(ann, at) => {
                scrollToTextMark(ann.id);
                if (annotationIsNote(ann)) setOpenNote({ id: ann.id, x: at.x, y: at.y });
              }}
              onRemove={removeAnnotationCb}
            />
          )}
          {filingNode}
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
        </div>
      </div>
      {dialogs}
      {selectionMenu && (
        <SelectionMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          onAsk={() => {
            askAbout(selectionMenu.anchorText, selectionMenu.page);
            window.getSelection()?.removeAllRanges();
            setSelectionMenu(null);
          }}
          onPick={(c) => void saveAnnotation(c)}
          onCopy={() => void copySelection()}
          onNote={() => {
            setNoteComposer({
              x: selectionMenu.x,
              y: selectionMenu.y,
              page: selectionMenu.page,
              rects: selectionMenu.rects,
              anchorText: selectionMenu.anchorText,
              textAnchor: selectionMenu.textAnchor,
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
      {noteCards}
    </div>
  );
}

// The reader's context menu — its own verbs where the browser's menu stood.
function ReaderMenu({ at, hasSelection, canDownload, canDrive, printing, onAskSel, onCopySel, onCopyDoc, onPrint, onDownload, onDrive, onClose }: {
  at: { x: number; y: number };
  hasSelection: boolean;
  canDownload: boolean;
  canDrive: boolean;
  printing: boolean;
  onAskSel: () => void;
  onCopySel: () => void;
  onCopyDoc: () => void;
  onPrint: () => void;
  onDownload: () => void;
  onDrive: () => void;
  onClose: () => void;
}) {
  const items: { icon: React.ReactNode; label: string; run: () => void; disabled?: boolean }[] = [
    { icon: <MessageCircle size={14} />, label: 'Ask about this passage', run: onAskSel, disabled: !hasSelection },
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

// The marks on a rendered document, listed down the right of the pane.
// A PDF shows its marks on the page and its notes in the margin rail; a
// rendered document has neither, so this list is where each mark can be
// found again (click to scroll to it; a note also opens its card), taken
// back (×, the author's own marks), or seen to be unplaced when its words
// are no longer in the document. It appears only once a mark exists, so an
// unmarked document looks exactly as before.
function TextMarksPanel({
  marks,
  unplaced,
  open,
  isMobile,
  currentUserId,
  onToggle,
  onGo,
  onRemove,
}: {
  marks: Annotation[];
  unplaced: string[];
  open: boolean;
  isMobile: boolean;
  currentUserId: string | null;
  onToggle: () => void;
  onGo: (ann: Annotation, at: { x: number; y: number }) => void;
  onRemove: (id: string) => void;
}) {
  const lost = new Set(unplaced);
  if (!open) {
    return (
      <button
        onClick={onToggle}
        className="absolute right-2 top-2 z-10 h-7 px-2 inline-flex items-center gap-1.5 rounded-md bg-[#1a1a22]/90 border border-white/15 text-[11px] text-white/80 hover:text-white shadow-lg"
        title="Show the marks in this document"
      >
        <StickyNote size={12} />
        Marks {marks.length}
      </button>
    );
  }
  return (
    <aside
      className={
        (isMobile ? 'absolute right-0 top-0 bottom-0 z-10 w-64 ' : 'w-64 shrink-0 ') +
        'flex flex-col min-h-0 border-l border-[var(--color-border)] bg-[var(--color-surface)]'
      }
      aria-label="Marks in this document"
    >
      <div className="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-[var(--color-border)]">
        <span className="text-[12px] font-medium text-white/85">Marks</span>
        <span className="text-[11px] text-white/40 tabular-nums">{marks.length}</span>
        <span className="flex-1" />
        <button
          onClick={onToggle}
          className="h-6 w-6 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/55 hover:text-white"
          title="Hide the marks list"
          aria-label="Hide the marks list"
        >
          ×
        </button>
      </div>
      <ul className="flex-1 overflow-auto py-1">
        {marks.map((m) => {
          const isNote = annotationIsNote(m);
          const missing = lost.has(m.id);
          const quote = (m.text_anchor?.exact ?? m.anchor_text ?? '').replace(/\s+/g, ' ').trim();
          return (
            <li key={m.id} className="group relative">
              <button
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  onGo(m, { x: r.left, y: r.top + r.height / 2 });
                }}
                className="w-full text-left px-3 py-2 pr-7 hover:bg-white/5 flex gap-2 items-start"
                title={missing ? 'These words are no longer in this version of the document.' : 'Go to this mark'}
              >
                {isNote ? (
                  <StickyNote size={12} className="mt-0.5 shrink-0 text-[#d4a054]" />
                ) : (
                  <span
                    className="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: ANNOTATION_DOT[m.color] }}
                  />
                )}
                <span className="min-w-0 flex-1">
                  {isNote && (
                    <span className="block text-[12px] text-white/85 line-clamp-2">{m.note}</span>
                  )}
                  <span className={'block text-[11px] line-clamp-2 ' + (isNote ? 'text-white/45 italic' : 'text-white/75')}>
                    {quote.length > 140 ? `${quote.slice(0, 140)}…` : quote}
                  </span>
                  {missing && (
                    <span className="block text-[10px] text-amber-300/80 mt-0.5">Unplaced: words not found</span>
                  )}
                </span>
              </button>
              {m.user_id === currentUserId && (
                <button
                  onClick={() => onRemove(m.id)}
                  className="absolute right-1.5 top-1.5 w-5 h-5 rounded-full text-white/40 hover:text-white hover:bg-white/10 text-[12px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
                  title={isNote ? 'Delete note' : 'Remove highlight'}
                  aria-label={isNote ? 'Delete note' : 'Remove highlight'}
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

// The styles of a rendered document: a Word file's notes, the find and the
// marks painted by the Custom Highlight API, the themed scrollbar, print,
// and the three page dialects. (A PDF's styles are the book's.)
function RenderedDocStyle({ theme }: { theme: ReaderTheme }) {
  return (
    <style>{`
      /* A Word file's notes, labelled (src/lib/reader-notes.ts). */
      .reader-notes-heading { margin-top: 2.5em; padding-top: 0.8em; border-top: 1px solid currentColor; font-size: 0.95em; opacity: 0.85; }
      /* The find's two colors for a rendered document (docx, text, slides,
         screenplay), painted by the Custom Highlight API over the words. */
      ::highlight(${FIND_HL}) { background-color: rgba(255, 214, 0, 0.6); }
      ::highlight(${FIND_HL_CURRENT}) { background-color: rgba(255, 150, 0, 0.85); }
      /* Highlights and margin-note underlines on a rendered document, in the
         PDF overlay's colors. Registered at priority -1, so a find hit over a
         highlighted word shows the find color. */
      ::highlight(${annHl('gold')}) { background-color: ${ANNOTATION_FILL.gold}; }
      ::highlight(${annHl('green')}) { background-color: ${ANNOTATION_FILL.green}; }
      ::highlight(${annHl('pink')}) { background-color: ${ANNOTATION_FILL.pink}; }
      ::highlight(${annHl('blue')}) { background-color: ${ANNOTATION_FILL.blue}; }
      ::highlight(${ANN_HL_NOTE}) {
        text-decoration-line: underline;
        text-decoration-style: dotted;
        text-decoration-color: rgba(212, 160, 84, 0.8);
        text-decoration-thickness: 1.5px;
      }
      ${scrollbarCss(theme)}
      ${printCss}

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

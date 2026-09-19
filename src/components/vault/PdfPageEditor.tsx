import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  X, RotateCw, Trash2, Undo2, Loader2, Check, Plus, Copy, ImageDown, Maximize2, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { sandboxApi } from '@/lib/sandbox-api';
import { openStoredPdf } from '@/lib/pdf-source';
import {
  canvasToBlob, copyPngToClipboard, pageImageFilename, renderPageCanvas, renderPageForExport, saveBlobAs,
  type ImageType,
} from '@/lib/pdf-page-image';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import PinToggle from '@/components/ui/PinToggle';

// The pages of a PDF, as a card beside the document: look at them, take them
// out as pictures, and make a new PDF of them.
//
// Every page is a tile. Click one to open it larger; right-click it to copy
// it as an image (paste into Word, an email, Paint), save it as PNG or JPEG,
// rotate it, cut it, or put pages in before it. Drag tiles to reorder. The
// images come from pdf-page-image.ts, rendered with the tile's rotation baked
// in, so what is pasted is what the tile shows.
//
// Light PDF editing: cut, reorder, rotate — and put in pages from another PDF
// filed in the same matter: a cleaner copy of a page the scanner smeared,
// from another edition; an exhibit into a filing. The result is saved as a
// NEW document via the edit_pdf server action; the original is never touched.
//
// The card is not modal: no backdrop, the document behind stays in reach, and
// it closes by X or Esc. It drags by its header and footer and resizes from
// any edge (useDraggableResizable); the page grid is `data-card-inert`, so a
// tile's own drag, click and right-click are not taken for the card's. On a
// phone it stays the sheet it was.
//
// Thumbnails are rendered as tiles scroll into view, one page at a time, so
// a 400-page scan opens at once and costs only the pages looked at.

/** Tile widths for the S / M / L control; thumbnails render once, at L. */
const TILE_W = { S: 132, M: 200, L: 280 } as const;
type TileSize = keyof typeof TILE_W;
const THUMB_RENDER_W = TILE_W.L;
const VIEW_W = 1200;
const INSERT_CAP = 60;
const FIRST_ROWS = 12;
const TILE_SIZE_KEY = 'cs.reader.pageEditor.tileSize';
/** An 8.5 × 11 box turned a quarter turn fits back inside itself at this scale. */
const QUARTER_TURN_FIT = 8.5 / 11;

interface PageTile {
  key: string;
  /** The document the page comes from — this one, or another PDF in the matter. */
  docId: string;
  storagePath: string;
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

interface Notice { text: string; tone: 'ok' | 'warn' | 'error'; busy?: boolean }

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

function readTileSize(): TileSize {
  try {
    const v = localStorage.getItem(TILE_SIZE_KEY);
    return v === 'M' || v === 'L' ? v : 'S';
  } catch { return 'S'; }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let serial = 0;
const tileKey = () => `t${(serial += 1)}`;

const iconBtn = 'p-1 rounded hover:bg-[rgba(255,255,255,0.1)] text-white/60 disabled:opacity-40';
const barBtn = 'inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-[11px] text-white/75 hover:text-white hover:bg-white/[0.08] disabled:opacity-40';

export default function PdfPageEditor({ doc, onClose, onSaved }: Props) {
  const { cardRef, pinned, togglePin, isMobile } = useDraggableResizable('cs.reader.pageEditor');
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
  const [tileSize, setTileSize] = useState<TileSize>(readTileSize);
  const [menu, setMenu] = useState<{ idx: number; x: number; y: number } | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [viewSrc, setViewSrc] = useState<{ key: string; url: string } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const dragFrom = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /* ---------------- The card ---------------- */

  // Take focus on opening so Esc and the arrow keys reach the card first
  // (the reader behind listens on window for its own page turns). A card
  // left off-screen by a smaller window comes back into view.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    card.focus({ preventScroll: true });
    if (isMobile || card.style.position !== 'fixed') return;
    const r = card.getBoundingClientRect();
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (r.height > h - 16) card.style.height = `${h - 16}px`;
    if (r.width > w - 16) card.style.width = `${w - 16}px`;
    const r2 = card.getBoundingClientRect();
    card.style.left = `${Math.min(Math.max(8, r2.left), Math.max(8, w - r2.width - 8))}px`;
    card.style.top = `${Math.min(Math.max(8, r2.top), Math.max(8, h - r2.height - 8))}px`;
  }, [cardRef, isMobile]);

  // A menu item or the view's close button unmounts under the pointer and
  // takes the focus with it; hand it back so Esc and the arrows still work.
  const refocus = () => cardRef.current?.focus({ preventScroll: true });

  const pickTileSize = (s: TileSize) => {
    setTileSize(s);
    try { localStorage.setItem(TILE_SIZE_KEY, s); } catch { /* private mode */ }
  };

  const say = useCallback((text: string, tone: Notice['tone'] = 'ok', busy = false) => {
    setNotice({ text, tone, busy });
  }, []);
  useEffect(() => {
    if (!notice || notice.busy) return;
    const t = setTimeout(() => setNotice(null), notice.tone === 'ok' ? 3500 : 7000);
    return () => clearTimeout(t);
  }, [notice]);

  /* ---------------- The PDFs, opened once each ---------------- */

  const pdfsRef = useRef(new Map<string, Promise<PDFDocumentProxy>>());
  // Opened by ranges (pdf-source.ts): the grid of a 300-page scan appears
  // at once, and only the pages whose thumbnails are looked at are fetched.
  const openPdf = useCallback((docId: string, storagePath: string) => {
    let p = pdfsRef.current.get(docId);
    if (!p) {
      p = openStoredPdf(storagePath);
      pdfsRef.current.set(docId, p);
      p.catch(() => pdfsRef.current.delete(docId));
    }
    return p;
  }, []);

  /* ---------------- Thumbnails, as tiles come into view ---------------- */

  const queueRef = useRef<{ docId: string; storagePath: string; page: number }[]>([]);
  const queuedRef = useRef(new Set<string>());
  const pumpingRef = useRef(false);
  const blobUrlsRef = useRef(new Set<string>());

  useEffect(() => {
    const opened = pdfsRef.current;
    const queued = queuedRef.current;
    const urls = blobUrlsRef.current;
    return () => {
      // Closing the editor — or React's development-mode rehearsal of it —
      // lets every PDF go and forgets it, so a later effect pass opens the
      // document afresh instead of finding a destroyed one that never answers.
      for (const p of opened.values()) p.then((pdf) => pdf.destroy()).catch(() => undefined);
      opened.clear();
      queued.clear();
      queueRef.current = [];
      pumpingRef.current = false;
      for (const u of urls) URL.revokeObjectURL(u);
      urls.clear();
    };
  }, []);
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      for (;;) {
        const next = queueRef.current.shift();
        if (!next) break;
        try {
          const pdf = await openPdf(next.docId, next.storagePath);
          const canvas = await renderPageCanvas(pdf, next.page, { width: THUMB_RENDER_W });
          const url = URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', 0.8));
          blobUrlsRef.current.add(url);
          setThumbs((prev) => ({ ...prev, [`${next.docId}:${next.page}`]: url }));
        } catch (e) {
          // A page that will not render keeps its placeholder; say why.
          console.warn('page editor: thumbnail failed', next, e);
        }
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [openPdf]);
  const requestThumb = useCallback((docId: string, storagePath: string, page: number) => {
    const key = `${docId}:${page}`;
    if (queuedRef.current.has(key)) return;
    queuedRef.current.add(key);
    queueRef.current.push({ docId, storagePath, page });
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
        if (el.dataset.doc && el.dataset.path && page) requestThumb(el.dataset.doc, el.dataset.path, page);
      }
    }, { root: grid, rootMargin: '320px 0px' });
    grid.querySelectorAll<HTMLElement>('[data-page]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [tiles, loading, requestThumb, tileSize]);

  /* ---------------- This document's pages ---------------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!doc.storage_path) throw new Error('This document has no stored file.');
        const storagePath = doc.storage_path;
        const pdf = await openPdf(doc.id, storagePath);
        if (cancelled) return;
        setTotalPages(pdf.numPages);
        setTiles(Array.from({ length: pdf.numPages }, (_, i) => ({
          key: tileKey(), docId: doc.id, storagePath, srcPage: i + 1, rotation: 0, deleted: false,
        })));
        setLoading(false);
        // The first rows straight away; the rest as they scroll into view.
        for (let n = 1; n <= Math.min(FIRST_ROWS, pdf.numPages); n += 1) requestThumb(doc.id, storagePath, n);
      } catch (e) {
        if (!cancelled) { setError(errText(e)); setLoading(false); }
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

  /* ---------------- A page as a picture ---------------- */

  const tileLabel = (t: PageTile) => `${t.from ? `${t.from}, ` : ''}p. ${t.srcPage}`;
  const renderTile = (t: PageTile) =>
    openPdf(t.docId, t.storagePath).then((pdf) => renderPageForExport(pdf, t.srcPage, t.rotation));

  // Synchronous up to the clipboard write, which must be made inside the
  // click (see copyPngToClipboard); the render finishes behind it.
  const copyTile = (t: PageTile) => {
    const png = renderTile(t).then((c) => canvasToBlob(c, 'image/png'));
    say(`Copying ${tileLabel(t)}…`, 'ok', true);
    copyPngToClipboard(png).then(
      () => say(`Copied ${tileLabel(t)} as an image — paste it into Word, an email, or anywhere else.`),
      async (e) => {
        console.warn('page editor: image copy refused', e);
        try {
          saveBlobAs(await png, pageImageFilename(t.from ?? doc.title, t.srcPage, 'png'));
          say('Copy isn\'t available in this browser — saved as a PNG instead.', 'warn');
        } catch (e2) {
          say(`${tileLabel(t)} could not be made into an image: ${errText(e2)}`, 'error');
        }
      },
    );
  };

  const saveTile = async (t: PageTile, type: ImageType) => {
    const ext = type === 'image/png' ? 'png' : 'jpg';
    say(`Saving ${tileLabel(t)} as ${ext.toUpperCase()}…`, 'ok', true);
    try {
      const blob = await canvasToBlob(await renderTile(t), type);
      saveBlobAs(blob, pageImageFilename(t.from ?? doc.title, t.srcPage, ext));
      say(`Saved ${tileLabel(t)} as ${ext.toUpperCase()}.`);
    } catch (e) {
      say(`${tileLabel(t)} could not be saved: ${errText(e)}`, 'error');
    }
  };

  /* ---------------- The larger view ---------------- */

  const viewTile = viewer !== null ? tiles[viewer] ?? null : null;
  const viewKey = viewTile ? `${viewTile.docId}:${viewTile.srcPage}:${viewTile.rotation}` : null;
  // The image on show; the one it replaces is let go as the new one lands,
  // so stepping through pages keeps the last page up (dimmed) meanwhile.
  const showView = useCallback((next: { key: string; url: string } | null) => {
    setViewSrc((prev) => {
      if (prev && prev.url !== next?.url) {
        const old = prev.url;
        setTimeout(() => { URL.revokeObjectURL(old); blobUrlsRef.current.delete(old); }, 0);
      }
      return next;
    });
  }, []);
  const viewDocId = viewTile?.docId;
  const viewPath = viewTile?.storagePath;
  const viewPage = viewTile?.srcPage;
  const viewRotation = viewTile?.rotation ?? 0;
  useEffect(() => {
    if (!viewKey || !viewDocId || !viewPath || !viewPage) return;
    let cancelled = false;
    (async () => {
      try {
        const pdf = await openPdf(viewDocId, viewPath);
        const canvas = await renderPageCanvas(pdf, viewPage, { width: VIEW_W, rotation: viewRotation, maxEdge: 2400 });
        if (cancelled) return;
        const url = URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', 0.9));
        blobUrlsRef.current.add(url);
        if (cancelled) { URL.revokeObjectURL(url); blobUrlsRef.current.delete(url); return; }
        showView({ key: viewKey, url });
      } catch (e) {
        if (!cancelled) say(`That page could not be shown: ${errText(e)}`, 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [viewKey, viewDocId, viewPath, viewPage, viewRotation, openPdf, say, showView]);
  useEffect(() => { if (viewer === null) showView(null); }, [viewer, showView]);

  const step = (d: number) =>
    setViewer((v) => (v === null || !tiles.length ? v : Math.min(tiles.length - 1, Math.max(0, v + d))));

  /* ---------------- The tile menu ---------------- */

  const openMenu = (idx: number, x: number, y: number) => {
    const w = 230;
    const h = 300;
    setMenu({
      idx,
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    });
  };
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [menu]);

  const onCardKey = (e: KeyboardEvent) => {
    const tgt = e.target as HTMLElement;
    const typing = tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement || tgt instanceof HTMLSelectElement;
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (menu) setMenu(null);
      else if (viewer !== null) setViewer(null);
      else onClose();
      return;
    }
    if (typing) return;
    if (viewer !== null && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      step(e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    // The reader behind turns pages on the arrow keys and goes full screen
    // on F; neither should happen while the card has the keyboard.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'f' || e.key === 'F') e.stopPropagation();
    if (!menu && viewer === null && (e.key === 'Enter' || e.key === ' ')) {
      const idx = Number(tgt.dataset.idx);
      if (tgt.dataset.idx && Number.isFinite(idx)) { e.preventDefault(); setViewer(idx); }
    }
  };

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
      for (const n of pages) requestThumb(source.id, source.storage_path, n);
    } catch (e) {
      setPicker((p) => (p ? { ...p, pages: [], error: errText(e) } : p));
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
      key: tileKey(), docId: source.id, storagePath: source.storage_path, srcPage: n, rotation: 0, deleted: false, from: source.title,
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
      setError(errText(e));
      setSaving(false);
    }
  };

  /* ---------------- Render ---------------- */

  const chosen = picker?.chosen ?? null;
  const controls = isMobile
    ? 'flex items-center gap-0.5'
    : 'flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity';
  const field = 'h-8 rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.05)] px-2 text-[12px] text-white focus:outline-none focus:ring-1 focus:ring-[#e8b84a]';
  const tileW = isMobile ? 120 : TILE_W[tileSize];
  const turn = (r: number) => `rotate(${r}deg)${r % 180 ? ` scale(${QUARTER_TURN_FIT})` : ''}`;
  const menuTile = menu ? tiles[menu.idx] ?? null : null;

  return createPortal(
    <div className={`fixed inset-0 z-[70] flex items-center justify-center ${isMobile ? '' : 'pointer-events-none'}`}>
      {isMobile && <div className="absolute inset-0 bg-black/50" onClick={onClose} />}
      <div
        ref={cardRef}
        tabIndex={-1}
        onKeyDown={onCardKey}
        role="dialog"
        aria-label={`Pages — ${doc.title}`}
        className="pointer-events-auto relative w-[94vw] max-w-4xl h-[88vh] rounded-xl border border-[rgba(255,255,255,0.12)] bg-[#12121a] flex flex-col outline-none shadow-[0_24px_64px_rgba(0,0,0,0.55)]"
      >
        {/* Header — also the drag ribbon */}
        <div className="px-4 sm:px-5 pt-1.5 pb-3 border-b border-[rgba(255,255,255,0.08)] shrink-0">
          {!isMobile && (
            <div className="flex justify-center mb-1.5">
              <div className="w-12 h-1 rounded-full bg-white/25 hover:bg-white/45 transition-colors" title="Drag to move" />
            </div>
          )}
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold text-white truncate">Pages — {doc.title}</h3>
              <p className="text-[11px] text-white/50 mt-0.5">
                Click a page to open it larger; right-click to copy it as an image or save it.
                Cut, rotate{isMobile ? '' : ', drag to reorder'}, or put in pages from another PDF in this matter —
                saved as a new PDF beside this one; the original stays untouched.
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {!isMobile && (
                <div className="flex items-center rounded-md border border-white/10 overflow-hidden mr-1" role="group" aria-label="Tile size">
                  {(Object.keys(TILE_W) as TileSize[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => pickTileSize(s)}
                      aria-pressed={tileSize === s}
                      title={`${s === 'S' ? 'Small' : s === 'M' ? 'Medium' : 'Large'} tiles`}
                      className={`w-6 h-6 text-[10px] font-semibold ${tileSize === s ? 'bg-[#e8b84a] text-black' : 'text-white/55 hover:text-white hover:bg-white/[0.06]'}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {!isMobile && <PinToggle pinned={pinned} onToggle={togglePin} />}
              <button onClick={onClose} className="p-1.5 rounded hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white" aria-label="Close" title="Close (Esc)"><X size={16} /></button>
            </div>
          </div>
        </div>

        {picker && (
          <div className="px-4 sm:px-5 py-3 border-b border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[12px] text-white/80 shrink-0">
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

        {/* The page grid. The 8px band around it belongs to the card, so every
            edge still resizes; inside it, gestures are the tiles' own. */}
        <div className="relative flex-1 min-h-0 flex flex-col px-2">
          <div
            ref={gridRef}
            data-card-inert
            onScroll={() => { if (menu) setMenu(null); }}
            className="flex-1 min-h-0 overflow-y-auto px-2 sm:px-3 py-4 cursor-default"
          >
            {loading ? (
              <p className="flex items-center gap-2 text-[12px] text-white/50"><Loader2 size={14} className="animate-spin" /> Loading PDF…</p>
            ) : error && !tiles.length ? (
              <p className="text-[12px] text-red-400">{error}</p>
            ) : (
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileW + 18}px, 1fr))` }}>
                {tiles.map((t, idx) => {
                  const thumb = thumbs[`${t.docId}:${t.srcPage}`];
                  return (
                    <div
                      key={t.key}
                      data-doc={t.docId}
                      data-path={t.storagePath}
                      data-page={t.srcPage}
                      data-idx={idx}
                      role="button"
                      tabIndex={0}
                      aria-label={`${tileLabel(t)} — open larger`}
                      title="Click to open larger · right-click to copy, save, rotate or cut · drag to reorder"
                      draggable={!isMobile}
                      onDragStart={(e) => {
                        dragFrom.current = idx;
                        e.dataTransfer.effectAllowed = 'copyMove';
                        // The page itself travels with the drag, for a drop
                        // outside the grid (the reader's desk, later).
                        e.dataTransfer.setData('application/x-ctx-page', JSON.stringify({
                          docId: t.docId, storagePath: t.storagePath, page: t.srcPage, rotation: t.rotation,
                        }));
                      }}
                      onDragEnd={() => { dragFrom.current = null; }}
                      onDragOver={(e) => { if (dragFrom.current !== null) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragFrom.current !== null && dragFrom.current !== idx) reorder(dragFrom.current, idx);
                        dragFrom.current = null;
                      }}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('button')) return;
                        setViewer(idx);
                      }}
                      onContextMenu={(e) => { e.preventDefault(); openMenu(idx, e.clientX, e.clientY); }}
                      className={`group relative rounded-lg border p-2 cursor-pointer transition-colors outline-none focus-visible:ring-1 focus-visible:ring-[#e8b84a] ${
                        t.deleted
                          ? 'border-red-500/30 opacity-40'
                          : t.from
                            ? 'border-[rgba(232,184,74,0.45)] hover:border-[rgba(232,184,74,0.8)]'
                            : 'border-[rgba(255,255,255,0.1)] hover:border-[rgba(232,184,74,0.4)]'
                      } ${menu?.idx === idx ? 'border-[rgba(232,184,74,0.9)]' : ''}`}
                    >
                      <div className="aspect-[8.5/11] rounded bg-white/95 overflow-hidden flex items-center justify-center">
                        {thumb ? (
                          <img
                            src={thumb}
                            alt={`page ${t.srcPage}`}
                            className="w-full h-full object-contain transition-transform"
                            style={{ transform: turn(t.rotation) }}
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

          {/* The larger view, over the grid (which keeps its scroll). */}
          {viewTile && viewer !== null && (
            <div data-card-inert className="absolute inset-y-0 inset-x-2 z-10 flex flex-col bg-[#12121a] cursor-default">
              <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-white/[0.08]">
                <span className="text-[12px] text-white/80 mr-2 truncate max-w-[40%]" title={viewTile.from ?? doc.title}>
                  {tileLabel(viewTile)}{viewTile.rotation ? ` · ${viewTile.rotation}°` : ''}{viewTile.deleted ? ' · cut' : ''}
                  <span className="text-white/40"> — {viewer + 1} of {tiles.length}</span>
                </span>
                <button className={barBtn} onClick={() => copyTile(viewTile)} title="Copy this page as an image (PNG)"><Copy size={13} /> Copy image</button>
                <button className={barBtn} onClick={() => void saveTile(viewTile, 'image/png')} title="Save this page as a PNG file"><ImageDown size={13} /> PNG</button>
                <button className={barBtn} onClick={() => void saveTile(viewTile, 'image/jpeg')} title="Save this page as a JPEG file"><ImageDown size={13} /> JPEG</button>
                <button className={barBtn} onClick={() => rotateTile(viewer)} title="Rotate 90° clockwise"><RotateCw size={13} /> Rotate</button>
                <button className={`${barBtn} hover:text-red-300`} onClick={() => toggleDelete(viewer)} title={viewTile.deleted ? 'Keep this page' : 'Cut this page'}>
                  {viewTile.deleted ? <><Undo2 size={13} /> Keep</> : <><Trash2 size={13} /> Cut</>}
                </button>
                <button className={`${barBtn} ml-auto`} onClick={() => { setViewer(null); refocus(); }} title="Back to all pages (Esc)" aria-label="Back to all pages"><X size={14} /></button>
              </div>
              <div
                className="relative flex-1 min-h-0 flex items-center justify-center p-3"
                onContextMenu={(e) => { e.preventDefault(); openMenu(viewer, e.clientX, e.clientY); }}
              >
                {viewSrc && (
                  <img
                    src={viewSrc.url}
                    alt={tileLabel(viewTile)}
                    draggable={false}
                    className={`max-w-full max-h-full object-contain bg-white shadow-lg transition-opacity ${viewSrc.key === viewKey ? '' : 'opacity-40'}`}
                  />
                )}
                {viewSrc?.key !== viewKey && <Loader2 size={20} className="absolute animate-spin text-white/50" />}
                <button
                  onClick={() => step(-1)}
                  disabled={viewer === 0}
                  className="absolute left-1 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 hover:bg-black/60 text-white/80 disabled:opacity-20"
                  aria-label="Previous page"
                  title="Previous (←)"
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  onClick={() => step(1)}
                  disabled={viewer >= tiles.length - 1}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 hover:bg-black/60 text-white/80 disabled:opacity-20"
                  aria-label="Next page"
                  title="Next (→)"
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>
          )}

          {notice && (
            <div
              role="status"
              aria-live="polite"
              className={`absolute bottom-3 left-1/2 -translate-x-1/2 z-20 max-w-[90%] flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] shadow-lg border ${
                notice.tone === 'error'
                  ? 'bg-[#2a1215] border-red-500/40 text-red-200'
                  : notice.tone === 'warn'
                    ? 'bg-[#2a2212] border-[#e8b84a]/40 text-[#f5d178]'
                    : 'bg-[#1b1b26] border-white/15 text-white/85'
              }`}
            >
              {notice.busy && <Loader2 size={12} className="animate-spin shrink-0" />}
              <span>{notice.text}</span>
            </div>
          )}
        </div>

        <div className="px-4 sm:px-5 py-3 border-t border-[rgba(255,255,255,0.08)] flex flex-wrap items-center gap-3 shrink-0">
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

        {/* The tile menu: the same verbs as the larger view's bar. */}
        {menu && menuTile && (
          <div
            ref={menuRef}
            data-card-inert
            role="menu"
            className="fixed z-30 w-[230px] py-1 rounded-lg border border-white/12 bg-[#1b1b26] shadow-[0_12px_32px_rgba(0,0,0,0.5)] text-[12px] text-white/85"
            style={{ left: menu.x, top: menu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider text-white/40 truncate">
              {tileLabel(menuTile)}{menuTile.rotation ? ` · ${menuTile.rotation}°` : ''}
            </div>
            {([
              { icon: <Maximize2 size={13} />, label: 'Open larger', run: () => setViewer(menu.idx) },
              null,
              { icon: <Copy size={13} />, label: 'Copy image', run: () => copyTile(menuTile) },
              { icon: <ImageDown size={13} />, label: 'Save as PNG', run: () => void saveTile(menuTile, 'image/png') },
              { icon: <ImageDown size={13} />, label: 'Save as JPEG', run: () => void saveTile(menuTile, 'image/jpeg') },
              null,
              { icon: <RotateCw size={13} />, label: 'Rotate 90°', run: () => rotateTile(menu.idx) },
              menuTile.deleted
                ? { icon: <Undo2 size={13} />, label: 'Keep this page', run: () => toggleDelete(menu.idx) }
                : { icon: <Trash2 size={13} />, label: 'Cut this page', run: () => toggleDelete(menu.idx) },
              { icon: <Plus size={13} />, label: 'Put pages in before this one', run: () => void openPicker(menu.idx) },
            ] as const).map((item, i) => (item === null
              ? <div key={`sep${i}`} className="my-1 border-t border-white/[0.08]" />
              : (
                <button
                  key={item.label}
                  role="menuitem"
                  onClick={() => { setMenu(null); item.run(); refocus(); }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-white/[0.07] hover:text-white"
                >
                  <span className="text-white/55">{item.icon}</span>
                  {item.label}
                </button>
              )))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// Pick documents out of Contextspaces.
//
// The picker MIRRORS the main UI: the same serverspaces, in the same
// order, with the same nested matter tree — because it consumes the same
// shared source the sidebar does (useServerspaces + buildMatterTree).
// Never a parallel query of its own: a flat re-query capped at 1,000 rows
// once silently dropped whole sub-matters from this list.
//
// Drill down: serverspaces → matters → sub-matters (any depth). A matter
// level shows its sub-matters first, then its ready documents (fetched
// per matter, paged past PostgREST's 1,000-row cap).
//
// `rootMatterId` opens the picker already drilled into that matter (its
// serverspace and ancestors pre-filled as crumbs), so the caller's own
// matter is the first thing seen; Back still walks up to every matter and
// every serverspace.
//
// FOUR OPTIONAL MODES, so this stays the only document picker in the app.
// None of them changes the default single-pick behaviour Cite-Check and the
// Editor use:
//
//   `confineToRoot`  Never leave `rootMatterId`'s tree — no serverspace
//                    level, and Back stops at the root matter. The
//                    Bucketizer files documents into ONE matter's tree, and
//                    offering another matter's documents there would break
//                    matter isolation at the point of a click.
//   `loadDocuments`  Replaces the "ready documents in this matter" read, so
//                    a caller that already knows more about these documents
//                    (what has been classified, what is still in OCR) can
//                    say so on the row. Rows may be `disabled` — shown with
//                    the reason, never hidden.
//   `multi`          Choose several. The picker returns ids and titles and
//                    loads NO text: a bulk classify reads its own passages.
//   Drag + resize    Per Eden's standing rule for cards and modals: the
//                    ribbon header drags, the corner resizes. Kept local and
//                    small rather than reaching for `useDraggableResizable`,
//                    which carries route-card semantics (right-click to pin,
//                    z-index below pinned panels) a modal must not have.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, X, FileText, Folder, ChevronLeft, ChevronRight, Server, Check, GripHorizontal,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { loadCorpusDocumentText } from '@/lib/cite-check/corpus';
import { useServerspaces } from '@/hooks/useServerspaces';
import { useIsMobile } from '@/hooks/useIsMobile';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';

type Doc = { id: string; title: string | null; source_filename: string | null };
type Crumb = { id: string; name: string };

export type PickedCorpusDocument = {
  documentId: string;
  title: string;
  text: string;
  /**
   * The document's OWN matter (documents.matterspace_id) — the tier that
   * governs its text. Null when the document has no matter.
   */
  matterId: string | null;
  /** That matter's place in the tree, e.g. "DeCamara › Appeal". */
  matterName?: string;
};

/** A row in the document list, when the caller supplies the list itself. */
export type PickerDocument = {
  id: string;
  title: string;
  /** The quiet second line: what has happened to this document. */
  hint?: string;
  /** Cannot be chosen. The row is still shown, with `hint` saying why. */
  disabled?: boolean;
};

/** What a caller's `toolbar` can do to the selection. */
export type PickerSelectionApi = {
  select: (docs: { id: string; title: string }[]) => void;
  clear: () => void;
  selectedCount: number;
};

type Props = {
  title?: string;
  rootMatterId?: string;
  /** The Editor's desk sits the picker left of centre on wide screens. */
  deskAligned?: boolean;
  /** Stay inside `rootMatterId` and its sub-matters. Requires `rootMatterId`. */
  confineToRoot?: boolean;
  /** Choose several documents; confirmed with the footer button. */
  multi?: boolean;
  /** The footer's confirm label in `multi` mode. Never says "Run". */
  confirmLabel?: string;
  /** Replaces the default per-matter read of ready documents. */
  loadDocuments?: (matterId: string) => Promise<PickerDocument[]>;
  /**
   * Search the WHOLE tree, not just this level. With it, typing in the filter
   * box searches every document the caller holds — which is what a person
   * means by "search your documents" when the one they want is three
   * sub-matters down.
   */
  searchAll?: (query: string) => PickerDocument[];
  /**
   * Select a folder: the picker hands over that sub-matter AND every
   * sub-matter beneath it, and the caller returns the documents to select.
   * Folders and sub-matters are the same container in this product, so
   * "run the whole folder" is this.
   */
  onSelectFolder?: (matterIds: string[]) => { id: string; title: string }[];
  /** A caller's own controls above the list (e.g. "select everything new"). */
  toolbar?: (api: PickerSelectionApi) => React.ReactNode;
  onCancel: () => void;
  /** Single-pick: the document's text is loaded before this is called. */
  onPicked?: (picked: PickedCorpusDocument) => void;
  /** `multi`: the chosen rows. No text is loaded. */
  onConfirmMany?: (picked: { id: string; title: string }[]) => void;
};

const PAGE = 1000;

/** At most this many document rows in the DOM; the filter reaches the rest. */
const VISIBLE_DOCS = 300;

/**
 * Ready documents in one matter, paged past PostgREST's 1,000-row cap.
 *
 * `onPage` receives each page as it lands, in order, so the first documents
 * reach the screen after one round trip instead of after all of them: a
 * matter with ~7,000 documents (DeCamara) spent 13 s showing nothing but a
 * search box, which reads as a prompt to type a document's name. The first
 * page carries the total, so the remaining ranges go out together rather
 * than one after another. Returning false from `onPage` stops the fetch.
 */
async function fetchReadyDocs(matterId: string, onPage: (rows: Doc[]) => boolean | void): Promise<void> {
  const page = (from: number, withCount: boolean) =>
    supabase
      .from('documents')
      .select('id, title, source_filename', withCount ? { count: 'exact' } : undefined)
      .eq('matterspace_id', matterId)
      .eq('processing_status', 'ready')
      .order('title', { ascending: true })
      // The unique tiebreaker. Titles tie constantly ("Exhibit A", a
      // repeated PACER filename), and rows the ORDER BY calls equal swap
      // between `.range()` pages — duplicating some and dropping others.
      .order('id')
      .range(from, from + PAGE - 1);

  const first = await page(0, true);
  if (first.error) throw new Error(first.error.message);
  const firstRows = (first.data ?? []) as Doc[];
  if (onPage(firstRows) === false) return;

  const total = first.count ?? firstRows.length;
  if (firstRows.length < PAGE || total <= PAGE) return;

  const rest = await Promise.all(
    Array.from({ length: Math.ceil(total / PAGE) - 1 }, (_, i) => page((i + 1) * PAGE, false)),
  );
  for (const p of rest) {
    if (p.error) throw new Error(p.error.message);
    if (onPage((p.data ?? []) as Doc[]) === false) return;
  }
}

/** id → node lookup for one serverspace's tree. */
function indexTree(roots: MatterTreeNode[]): Map<string, MatterTreeNode> {
  const byId = new Map<string, MatterTreeNode>();
  const walk = (nodes: MatterTreeNode[]) => {
    for (const n of nodes) {
      byId.set(n.matter.id, n);
      walk(n.children);
    }
  };
  walk(roots);
  return byId;
}

export default function CorpusDocumentPicker({
  title = 'Pull a draft from your matters',
  rootMatterId,
  deskAligned = false,
  confineToRoot = false,
  multi = false,
  confirmLabel = 'Continue',
  loadDocuments,
  searchAll,
  onSelectFolder,
  toolbar,
  onCancel,
  onPicked,
  onConfirmMany,
}: Props) {
  const { data: serverspaces = [], isLoading, error: spacesError } = useServerspaces();
  const isMobile = useIsMobile();

  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [path, setPath] = useState<Crumb[]>([]); // matter drill-down within the space
  const [docs, setDocs] = useState<PickerDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [fetchingDoc, setFetchingDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Selection survives navigation: documents chosen in one sub-matter stay
  // chosen while the person walks into the next one.
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  // Seed from rootMatterId exactly once: serverspaces refetch in the
  // background, and re-seeding would yank Back down to the root again.
  const [seeded, setSeeded] = useState(!rootMatterId);
  const [seedFailed, setSeedFailed] = useState(false);
  const pressedBackdrop = useRef(false);

  // Drag, from the ribbon only. Resize is the browser's own corner grip.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  // The anchor a shift-click ranges from.
  const anchor = useRef<string | null>(null);

  // Escape closes the picker. A modal a keyboard cannot dismiss is a trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  useEffect(() => {
    if (seeded || isLoading) return;
    const home = serverspaces.find((s) => s.matterspaces.some((m) => m.id === rootMatterId));
    if (home) {
      // Walk up the parent chain the way buildMatterTree does: a parent
      // outside this serverspace's list makes the matter a root.
      const byId = new Map(home.matterspaces.map((m) => [m.id, m]));
      const chain: Crumb[] = [];
      for (let m = byId.get(rootMatterId!); m; m = m.parent_matterspace_id ? byId.get(m.parent_matterspace_id) : undefined) {
        chain.unshift({ id: m.id, name: m.name });
        if (chain.length > byId.size) break; // a parent cycle — never loop
      }
      setSpaceId(home.id);
      setPath(chain);
    } else if (confineToRoot) {
      setSeedFailed(true);
    }
    setSeeded(true);
  }, [seeded, isLoading, serverspaces, rootMatterId, confineToRoot]);

  const space = serverspaces.find((s) => s.id === spaceId) ?? null;
  const tree = useMemo(() => (space ? buildMatterTree(space.matterspaces) : []), [space]);
  const byId = useMemo(() => indexTree(tree), [tree]);

  const currentMatter = path.length > 0 ? path[path.length - 1] : null;
  const currentChildren: MatterTreeNode[] = currentMatter
    ? byId.get(currentMatter.id)?.children ?? []
    : tree;
  // Confined, the root matter IS the floor: Back never walks above it.
  const rootDepth = confineToRoot ? path.findIndex((c) => c.id === rootMatterId) + 1 : 0;
  const canGoBack = confineToRoot ? path.length > Math.max(1, rootDepth) : Boolean(space || path.length);

  // Documents live only at matter levels; fetched per matter, on demand.
  useEffect(() => {
    if (!currentMatter) {
      // Back out of a matter mid-fetch: the cancelled fetch never clears this.
      setDocs([]);
      setDocsLoading(false);
      return;
    }
    let cancelled = false;
    setDocsLoading(true);
    setDocs([]);
    void (async () => {
      try {
        if (loadDocuments) {
          const loaded = await loadDocuments(currentMatter.id);
          if (!cancelled) setDocs(loaded);
        } else {
          // Each page renders as it lands, so the list is never an empty box
          // with a search field in it. `cancelled` is checked per page
          // because state is set mid-fetch now, not once at the end.
          await fetchReadyDocs(currentMatter.id, (rows) => {
            if (cancelled) return false;
            setDocs((prev) => [...prev, ...rows.map((d) => ({
              id: d.id,
              title: d.title || d.source_filename || 'Untitled document',
            }))]);
          });
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setDocsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentMatter?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function goBack() {
    setSearch('');
    setError(null);
    if (path.length > 0) setPath(path.slice(0, -1));
    else setSpaceId(null);
  }

  function addMany(docs: { id: string; title: string }[]) {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const d of docs) next.set(d.id, d.title);
      return next;
    });
  }

  /**
   * Click toggles and becomes the anchor; shift-click takes the range from
   * the anchor to here, the way a file list behaves. Ctrl/cmd-click is the
   * same as a plain click here — every click is already a toggle.
   */
  function onRowClick(row: PickerDocument, index: number, shiftKey: boolean) {
    // The rendered rows, not every matching row: `index` comes from the list
    // on screen, and a range must mean what the person can see.
    const visible = shownDocRows;
    if (shiftKey && anchor.current) {
      const start = visible.findIndex((r) => r.id === anchor.current);
      if (start >= 0) {
        const [from, to] = start <= index ? [start, index] : [index, start];
        addMany(visible.slice(from, to + 1).filter((r) => !r.disabled));
        return;
      }
    }
    anchor.current = row.id;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.set(row.id, row.title);
      return next;
    });
  }

  /** This folder and every folder under it — the same container, recursively. */
  function subtreeMatterIds(matterId: string): string[] {
    const out: string[] = [matterId];
    const walk = (nodes: MatterTreeNode[]) => {
      for (const n of nodes) { out.push(n.matter.id); walk(n.children); }
    };
    walk(byId.get(matterId)?.children ?? []);
    return out;
  }

  async function pickDocument(id: string) {
    setFetchingDoc(id);
    setError(null);
    try {
      const loaded = await loadCorpusDocumentText(id);
      onPicked?.({
        documentId: loaded.documentId,
        title: loaded.title,
        text: loaded.text,
        matterId: loaded.matterId,
        matterName: loaded.matterId === currentMatter?.id ? path.map((c) => c.name).join(' › ') : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFetchingDoc(null);
    }
  }

  const q = search.trim().toLowerCase();
  // Searching the whole tree replaces the level, folders and all: a search for
  // "Marlow" that shows the current folder's sub-folders is not a search.
  const searching = Boolean(q && searchAll);
  const folderRows = searching ? [] : currentChildren
    .map((n) => ({ id: n.matter.id, name: n.matter.name, childCount: n.children.length }))
    .filter((r) => !q || r.name.toLowerCase().includes(q));
  const docRows = searching
    ? searchAll!(search.trim())
    : docs.filter((r) => !q || r.title.toLowerCase().includes(q));
  // Only this many rows reach the DOM. DeCamara's 6,974 documents rendered
  // 63,016 nodes at once; the filter still runs over every row above, so a
  // title past the cap is one keystroke away. Folders are never capped.
  const shownDocRows = docRows.slice(0, VISIBLE_DOCS);

  const header = currentMatter?.name ?? space?.name ?? title;
  // Confined, the header is always a matter name, so the picker's own purpose
  // would never appear anywhere. It leads the crumb line instead.
  const crumbs = confineToRoot
    ? [title, ...path.slice(0, -1).map((c) => c.name)]
    : space ? [space.name, ...path.slice(0, -1).map((c) => c.name)] : [];
  // Only the serverspaces and the matter tree gate the list — both are
  // already in memory. Documents arrive underneath them as they load; they
  // must never hold back the sub-matter a lawyer is reaching for.
  const busy = isLoading || !seeded;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 ${deskAligned ? 'lg:justify-start lg:pl-[7%]' : ''}`}
      // Close on a full click on the backdrop, not on mousedown: closing on
      // mousedown lets the click land on whatever sat underneath (the
      // Cite-Check drop zone reopens the picker). Both halves must be on
      // the backdrop, so a text-select dragged out of the filter never closes.
      onMouseDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (pressedBackdrop.current && e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="w-[480px] max-w-full max-h-[70vh] flex flex-col rounded-xl border border-[rgba(255,255,255,0.1)] bg-[#1a1a22] shadow-2xl"
        style={isMobile ? undefined : {
          transform: offset.x || offset.y ? `translate(${offset.x}px, ${offset.y}px)` : undefined,
          resize: 'both',
          overflow: 'hidden',
          maxHeight: '88vh',
          minWidth: '320px',
          minHeight: '240px',
        }}
      >
        <div
          className={`flex items-center gap-2 px-4 h-12 border-b border-[rgba(255,255,255,0.08)] shrink-0 ${isMobile ? '' : 'cursor-grab active:cursor-grabbing select-none'}`}
          // The ribbon is the handle, and it looks like one. Buttons inside it
          // keep working: a press that starts on Back or Cancel is not a drag.
          onPointerDown={(e) => {
            if (isMobile || (e.target as HTMLElement).closest('button')) return;
            dragFrom.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const from = dragFrom.current;
            if (!from) return;
            setOffset({ x: e.clientX - from.x, y: e.clientY - from.y });
          }}
          onPointerUp={(e) => {
            dragFrom.current = null;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          }}
        >
          {canGoBack && (
            <button
              onClick={goBack}
              className="h-7 w-7 -ml-1 shrink-0 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/60 hover:text-white"
              title="Back"
            >
              <ChevronLeft size={15} />
            </button>
          )}
          <span className="min-w-0 flex-1">
            {crumbs.length > 0 && (
              <span className="block text-[10px] text-white/35 truncate leading-tight">
                {crumbs.join(' › ')}
              </span>
            )}
            <span className="block text-[13px] font-medium text-[var(--color-text-bright)] truncate leading-tight">
              {header}
            </span>
          </span>
          {!isMobile && <GripHorizontal size={14} className="shrink-0 text-white/20" />}
          <button
            onClick={onCancel}
            className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/60 hover:text-white"
            title="Cancel"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-3 py-2 border-b border-[rgba(255,255,255,0.06)] shrink-0">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/35" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchAll ? 'Search this matter\'s documents…' : space ? 'Filter this level…' : 'Filter serverspaces…'}
              className="w-full h-8 pl-7 pr-2 rounded-md bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] text-[12px] text-[var(--color-text-bright)] placeholder:text-white/30 focus:outline-none focus:border-[var(--color-primary)]"
            />
          </div>
        </div>
        {toolbar && (
          <div className="px-3 py-2 border-b border-[rgba(255,255,255,0.06)] shrink-0">
            {toolbar({
              select: addMany,
              clear: () => setSelected(new Map()),
              selectedCount: selected.size,
            })}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {(error || spacesError) && (
            <p className="text-[12px] text-red-300 py-4 px-4 text-center">
              {error || (spacesError instanceof Error ? spacesError.message : String(spacesError))}
            </p>
          )}
          {seedFailed && !busy && (
            <p className="text-[12px] text-white/40 py-8 px-4 text-center">
              This matter could not be opened here. Reload the page and try again.
            </p>
          )}
          {busy && <p className="text-[12px] text-white/40 py-8 text-center">Loading…</p>}

          {/* Level 0: the serverspaces, in the sidebar's order. Never shown
              confined — there is exactly one matter tree to choose from. */}
          {!space && !busy && !confineToRoot && (
            <ul className="py-1">
              {serverspaces
                .filter((s) => !q || s.name.toLowerCase().includes(q))
                .map((s) => (
                  <li key={s.id}>
                    <button
                      onClick={() => { setSpaceId(s.id); setSearch(''); }}
                      className="flex items-center gap-3 w-full px-3 py-2 text-left transition hover:bg-white/4"
                    >
                      <Server size={14} className="text-[var(--color-primary)] shrink-0" strokeWidth={1.75} />
                      <span className="text-[12.5px] text-[var(--color-text-bright)] truncate flex-1">{s.name}</span>
                      <ChevronRight size={13} className="text-white/25 shrink-0" />
                    </button>
                  </li>
                ))}
              {serverspaces.length === 0 && (
                <p className="text-[12px] text-white/40 py-8 text-center">No serverspaces found.</p>
              )}
            </ul>
          )}

          {/* Matter levels: sub-matters first (the sidebar's tree), then this matter's documents */}
          {space && !busy && (
            <>
              {folderRows.length === 0 && docRows.length === 0 && !docsLoading && !error && (
                <p className="text-[12px] text-white/40 py-8 text-center">
                  {searching ? 'No documents matched.'
                    : currentMatter ? 'Nothing here — no sub-matters, no documents.'
                      : 'No matters in this serverspace.'}
                </p>
              )}
              {(folderRows.length > 0 || docRows.length > 0) && (
                <ul className="py-1">
                  {folderRows.map((row) => (
                    <li key={row.id} className="flex items-center">
                      <button
                        onClick={() => { setPath([...path, { id: row.id, name: row.name }]); setSearch(''); }}
                        disabled={fetchingDoc !== null}
                        className="flex items-center gap-3 flex-1 min-w-0 px-3 py-2 text-left transition hover:bg-white/4 disabled:opacity-50"
                      >
                        <Folder size={14} className="text-[var(--color-primary)] shrink-0" strokeWidth={1.75} />
                        <span className="text-[12.5px] text-[var(--color-text-bright)] truncate flex-1">{row.name}</span>
                        <ChevronRight size={13} className="text-white/25 shrink-0" />
                      </button>
                      {/* A folder IS a selection: everything under it, however
                          deep, and the names are shown before anything runs. */}
                      {multi && onSelectFolder && (
                        <button
                          onClick={() => addMany(onSelectFolder(subtreeMatterIds(row.id)))}
                          title={`Select every document in ${row.name} and its sub-matters`}
                          className="mr-2 shrink-0 rounded-md border border-white/10 px-2 py-1 text-[11px] text-white/60 hover:text-white hover:bg-white/5"
                        >
                          Select all
                        </button>
                      )}
                    </li>
                  ))}
                  {shownDocRows.map((row, index) => {
                    const isPicked = selected.has(row.id);
                    return (
                      <li key={row.id}>
                        <button
                          onClick={(e) => (multi ? onRowClick(row, index, e.shiftKey) : void pickDocument(row.id))}
                          disabled={row.disabled || fetchingDoc !== null}
                          title={row.disabled ? row.hint : undefined}
                          className={`flex items-start gap-3 w-full px-3 py-2 text-left transition ${
                            isPicked ? 'bg-[var(--color-primary-light)]' : 'hover:bg-white/4'
                          } ${row.disabled ? 'opacity-45 cursor-not-allowed hover:bg-transparent' : ''}`}
                        >
                          <FileText size={14} className="mt-0.5 text-[var(--color-primary)] shrink-0" strokeWidth={1.75} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[12.5px] text-[var(--color-text-bright)] truncate">
                              {row.title}
                            </span>
                            {row.hint && (
                              <span className="block text-[11px] text-white/40 leading-snug">{row.hint}</span>
                            )}
                          </span>
                          {multi && isPicked && (
                            <Check size={13} className="mt-0.5 text-[var(--color-primary)] shrink-0" strokeWidth={2.5} />
                          )}
                          {!multi && fetchingDoc === row.id && (
                            <span className="text-[11px] text-white/45 shrink-0">Loading…</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {docsLoading && currentMatter && (
                <p className="text-[12px] text-white/40 py-3 text-center">
                  {docs.length > 0 ? `Loading documents… ${docs.length.toLocaleString()} so far` : 'Loading documents…'}
                </p>
              )}
              {!docsLoading && docRows.length > shownDocRows.length && (
                <p className="text-[12px] text-white/35 py-3 text-center">
                  Showing {shownDocRows.length.toLocaleString()} of {docRows.length.toLocaleString()} documents — type to narrow.
                </p>
              )}
            </>
          )}
        </div>

        {multi && (
          <div className="flex items-center justify-between gap-2 px-3 h-12 border-t border-[rgba(255,255,255,0.08)] shrink-0">
            <span className="text-[11px] text-white/45 truncate">
              {selected.size} selected
              {selected.size > 0 ? '' : ' · click rows, shift-click for a range'}
            </span>
            <div className="flex gap-2">
              <button
                onClick={onCancel}
                className="h-8 px-3 rounded-md text-[12px] text-white/65 hover:text-white hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                onClick={() => onConfirmMany?.([...selected].map(([id, t]) => ({ id, title: t })))}
                disabled={selected.size === 0}
                className="h-8 px-3 rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[#1a1408] text-[12px] font-semibold disabled:opacity-40 transition"
              >
                {confirmLabel}{selected.size > 0 ? ` (${selected.size})` : ''}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

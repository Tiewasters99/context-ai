// Pick one ready document out of Contextspaces.
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, FileText, Folder, ChevronLeft, ChevronRight, Server } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { loadCorpusDocumentText } from '@/lib/cite-check/corpus';
import { useServerspaces } from '@/hooks/useServerspaces';
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

type Props = {
  title?: string;
  rootMatterId?: string;
  /** The Editor's desk sits the picker left of centre on wide screens. */
  deskAligned?: boolean;
  onCancel: () => void;
  onPicked: (picked: PickedCorpusDocument) => void;
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
  onCancel,
  onPicked,
}: Props) {
  const { data: serverspaces = [], isLoading, error: spacesError } = useServerspaces();

  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [path, setPath] = useState<Crumb[]>([]); // matter drill-down within the space
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [fetchingDoc, setFetchingDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Seed from rootMatterId exactly once: serverspaces refetch in the
  // background, and re-seeding would yank Back down to the root again.
  const [seeded, setSeeded] = useState(!rootMatterId);
  const pressedBackdrop = useRef(false);

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
    }
    setSeeded(true);
  }, [seeded, isLoading, serverspaces, rootMatterId]);

  const space = serverspaces.find((s) => s.id === spaceId) ?? null;
  const tree = useMemo(() => (space ? buildMatterTree(space.matterspaces) : []), [space]);
  const byId = useMemo(() => indexTree(tree), [tree]);

  const currentMatter = path.length > 0 ? path[path.length - 1] : null;
  const currentChildren: MatterTreeNode[] = currentMatter
    ? byId.get(currentMatter.id)?.children ?? []
    : tree;

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
        await fetchReadyDocs(currentMatter.id, (rows) => {
          if (cancelled) return false; // checked per page: state is set mid-fetch now
          setDocs((prev) => [...prev, ...rows]);
        });
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

  async function pickDocument(id: string) {
    setFetchingDoc(id);
    setError(null);
    try {
      const loaded = await loadCorpusDocumentText(id);
      onPicked({
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
  const folderRows = currentChildren
    .map((n) => ({ id: n.matter.id, name: n.matter.name, childCount: n.children.length }))
    .filter((r) => !q || r.name.toLowerCase().includes(q));
  const docRows = docs
    .map((d) => ({ id: d.id, title: d.title || d.source_filename || 'Untitled document' }))
    .filter((r) => !q || r.title.toLowerCase().includes(q));

  const shownDocRows = docRows.slice(0, VISIBLE_DOCS);

  const header = currentMatter?.name ?? space?.name ?? title;
  const crumbs = space ? [space.name, ...path.slice(0, -1).map((c) => c.name)] : [];
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
      <div className="w-[480px] max-w-full max-h-[70vh] flex flex-col rounded-xl border border-[rgba(255,255,255,0.1)] bg-[#1a1a22] shadow-2xl">
        <div className="flex items-center gap-2 px-4 h-12 border-b border-[rgba(255,255,255,0.08)]">
          {(space || path.length > 0) && (
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
          <button
            onClick={onCancel}
            className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/60 hover:text-white"
            title="Cancel"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-3 py-2 border-b border-[rgba(255,255,255,0.06)]">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/35" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={space ? 'Filter this level…' : 'Filter serverspaces…'}
              className="w-full h-8 pl-7 pr-2 rounded-md bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] text-[12px] text-[var(--color-text-bright)] placeholder:text-white/30 focus:outline-none focus:border-[var(--color-primary)]"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {(error || spacesError) && (
            <p className="text-[12px] text-red-300 py-4 px-4 text-center">
              {error || (spacesError instanceof Error ? spacesError.message : String(spacesError))}
            </p>
          )}
          {busy && <p className="text-[12px] text-white/40 py-8 text-center">Loading…</p>}

          {/* Level 0: the serverspaces, in the sidebar's order */}
          {!space && !busy && (
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

          {/* Matter levels: sub-matters first (the sidebar's tree), then this matter's ready documents */}
          {space && !busy && (
            <>
              {folderRows.length === 0 && docRows.length === 0 && !docsLoading && !error && (
                <p className="text-[12px] text-white/40 py-8 text-center">
                  {currentMatter ? 'Nothing here — no sub-matters, no ready documents.' : 'No matters in this serverspace.'}
                </p>
              )}
              {(folderRows.length > 0 || docRows.length > 0) && (
                <ul className="py-1">
                  {folderRows.map((row) => (
                    <li key={row.id}>
                      <button
                        onClick={() => { setPath([...path, { id: row.id, name: row.name }]); setSearch(''); }}
                        disabled={fetchingDoc !== null}
                        className="flex items-center gap-3 w-full px-3 py-2 text-left transition hover:bg-white/4 disabled:opacity-50"
                      >
                        <Folder size={14} className="text-[var(--color-primary)] shrink-0" strokeWidth={1.75} />
                        <span className="text-[12.5px] text-[var(--color-text-bright)] truncate flex-1">{row.name}</span>
                        <ChevronRight size={13} className="text-white/25 shrink-0" />
                      </button>
                    </li>
                  ))}
                  {shownDocRows.map((row) => (
                    <li key={row.id}>
                      <button
                        onClick={() => void pickDocument(row.id)}
                        disabled={fetchingDoc !== null}
                        className="flex items-center gap-3 w-full px-3 py-2 text-left transition hover:bg-white/4 disabled:opacity-50"
                      >
                        <FileText size={14} className="text-[var(--color-primary)] shrink-0" strokeWidth={1.75} />
                        <span className="text-[12.5px] text-[var(--color-text-bright)] truncate flex-1">{row.title}</span>
                        {fetchingDoc === row.id && <span className="text-[11px] text-white/45 shrink-0">Loading…</span>}
                      </button>
                    </li>
                  ))}
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
      </div>
    </div>
  );
}

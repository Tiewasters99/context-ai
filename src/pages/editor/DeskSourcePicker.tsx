// Pull a manuscript from Contextspaces onto the Editor's desk.
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

import { useEffect, useMemo, useState } from 'react';
import { Search, X, FileText, Folder, ChevronLeft, ChevronRight, Server } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { loadCorpusDocumentText } from '@/lib/cite-check/corpus';
import { useServerspaces } from '@/hooks/useServerspaces';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';

type Doc = { id: string; title: string | null; source_filename: string | null };
type Crumb = { id: string; name: string };

type Props = {
  onCancel: () => void;
  onLoaded: (text: string, title: string) => void;
};

/** Ready documents in one matter, paged past the 1,000-row cap. */
async function fetchReadyDocs(matterId: string): Promise<Doc[]> {
  const all: Doc[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('documents')
      .select('id, title, source_filename')
      .eq('matterspace_id', matterId)
      .eq('processing_status', 'ready')
      .order('title', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as Doc[]));
    if (!data || data.length < 1000) break;
  }
  return all;
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

export default function DeskSourcePicker({ onCancel, onLoaded }: Props) {
  const { data: serverspaces = [], isLoading, error: spacesError } = useServerspaces();

  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [path, setPath] = useState<Crumb[]>([]); // matter drill-down within the space
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [fetchingDoc, setFetchingDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

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
      setDocs([]);
      return;
    }
    let cancelled = false;
    setDocsLoading(true);
    setDocs([]);
    void (async () => {
      try {
        const loaded = await fetchReadyDocs(currentMatter.id);
        if (!cancelled) setDocs(loaded);
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

  async function pickDocument(id: string, title: string) {
    setFetchingDoc(id);
    setError(null);
    try {
      const loaded = await loadCorpusDocumentText(id);
      onLoaded(loaded.text, title);
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

  const header = currentMatter?.name ?? space?.name ?? 'Pull a draft from your matters';
  const crumbs = space ? [space.name, ...path.slice(0, -1).map((c) => c.name)] : [];
  const busy = isLoading || docsLoading;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center lg:justify-start lg:pl-[7%] bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
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
          {!space && !isLoading && (
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
              {!isLoading && serverspaces.length === 0 && (
                <p className="text-[12px] text-white/40 py-8 text-center">No serverspaces found.</p>
              )}
            </ul>
          )}

          {/* Matter levels: sub-matters first (the sidebar's tree), then this matter's ready documents */}
          {space && !busy && (
            <>
              {folderRows.length === 0 && docRows.length === 0 && !error && (
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
                  {docRows.map((row) => (
                    <li key={row.id}>
                      <button
                        onClick={() => void pickDocument(row.id, row.title)}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

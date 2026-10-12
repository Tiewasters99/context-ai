import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Search, X } from 'lucide-react';
import {
  ensurePresetTagDefs, listReviewDocuments, listReviewTags, applyReviewTag, removeReviewTag,
  isReviewTagsMissing, tagKindOf, TAG_KIND_LABEL, matchesRule,
  type DocumentTagDef, type ReviewDocument, type TagKind, type FilterRule, type DiscoverySet,
} from '@/lib/discovery';
import { TagChip } from './bits';
import SetsBar from './SetsBar';

// Discovery R1 (spec DISCOVERY-REVIEW-SETS-2026-10-12): review across the
// whole matter. One row per document filed in the matter and its folders;
// tags live on the document (migration 113), so a tag applied here is the
// same tag in every production built later.

type TagFilter = 'has' | 'not';
const KIND_ORDER: TagKind[] = ['exclusion', 'designation', 'note', 'issue'];
const PAGE = 300;

export default function ReviewTab({ matterId, onProduced }: { matterId: string; onProduced: () => void }) {
  const [defs, setDefs] = useState<DocumentTagDef[]>([]);
  const [docs, setDocs] = useState<ReviewDocument[]>([]);
  const [truncated, setTruncated] = useState(false);
  // document id → set of tag_def ids
  const [tagsByDoc, setTagsByDoc] = useState<Map<string, Set<string>>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needsSql, setNeedsSql] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [text, setText] = useState('');
  const [folder, setFolder] = useState('');
  const [ext, setExt] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [tagFilters, setTagFilters] = useState<Map<string, TagFilter>>(new Map());
  const [shown, setShown] = useState(PAGE);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  // The set in use (R2). A saved filter fills in the filters; a hand-picked
  // list narrows the table to its documents.
  const [activeSet, setActiveSet] = useState<DiscoverySet | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [d, list] = await Promise.all([ensurePresetTagDefs(matterId), listReviewDocuments(matterId)]);
      setDefs(d);
      setDocs(list.docs);
      setTruncated(list.truncated);
      try {
        const tags = await listReviewTags(matterId);
        const map = new Map<string, Set<string>>();
        for (const t of tags) {
          const s = map.get(t.document_id) ?? new Set<string>();
          s.add(t.tag_def_id);
          map.set(t.document_id, s);
        }
        setTagsByDoc(map);
        setNeedsSql(false);
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        if (isReviewTagsMissing(msg)) setNeedsSql(true);
        else throw e;
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load the matter\'s documents');
    } finally {
      setLoading(false);
    }
  }, [matterId]);

  useEffect(() => { void load(); }, [load]);

  const defById = useMemo(() => new Map(defs.map((d) => [d.id, d])), [defs]);
  const defsByKind = useMemo(() => {
    const groups = new Map<TagKind, DocumentTagDef[]>();
    for (const d of defs) {
      const k = tagKindOf(d);
      groups.set(k, [...(groups.get(k) ?? []), d]);
    }
    return KIND_ORDER.filter((k) => groups.has(k)).map((k) => ({ kind: k, defs: groups.get(k)! }));
  }, [defs]);

  const folders = useMemo(
    () => [...new Set(docs.map((d) => d.folder ?? ''))].sort((a, b) => a.localeCompare(b)),
    [docs],
  );
  const exts = useMemo(() => [...new Set(docs.map((d) => d.ext).filter(Boolean))].sort(), [docs]);

  const currentFilter = useMemo((): FilterRule => ({
    kind: 'filter',
    tags_has: [...tagFilters].filter(([, m]) => m === 'has').map(([id]) => id),
    tags_not: [...tagFilters].filter(([, m]) => m === 'not').map(([id]) => id),
    folder, ext, text, from: fromDate, to: toDate,
  }), [tagFilters, folder, ext, text, fromDate, toDate]);

  const filtered = useMemo(() => docs.filter((d) => {
    const tags = tagsByDoc.get(d.id);
    if (!matchesRule(d, tags, currentFilter)) return false;
    return activeSet?.rule.kind === 'list' ? matchesRule(d, tags, activeSet.rule) : true;
  }), [docs, tagsByDoc, currentFilter, activeSet]);

  const activate = (set: DiscoverySet | null) => {
    setActiveSet(set);
    const r = set?.rule.kind === 'filter' ? set.rule : null;
    setText(r?.text ?? '');
    setFolder(r?.folder ?? '');
    setExt(r?.ext ?? '');
    setFromDate(r?.from ?? '');
    setToDate(r?.to ?? '');
    const m = new Map<string, TagFilter>();
    for (const id of r?.tags_has ?? []) m.set(id, 'has');
    for (const id of r?.tags_not ?? []) m.set(id, 'not');
    setTagFilters(m);
  };

  useEffect(() => { setShown(PAGE); }, [text, folder, ext, fromDate, toDate, tagFilters]);
  const visible = filtered.slice(0, shown);

  const cycleTagFilter = (defId: string) => {
    setTagFilters((prev) => {
      const next = new Map(prev);
      const cur = next.get(defId);
      if (!cur) next.set(defId, 'has');
      else if (cur === 'has') next.set(defId, 'not');
      else next.delete(defId);
      return next;
    });
  };

  const allFilteredSelected = filtered.length > 0 && filtered.every((d) => selected.has(d.id));
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) for (const d of filtered) next.delete(d.id);
      else for (const d of filtered) next.add(d.id);
      return next;
    });
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Apply or remove one tag on a set of documents: optimistic, then the
  // server; on failure, reload from the truth.
  const setTag = useCallback(async (def: DocumentTagDef, ids: string[], on: boolean) => {
    if (ids.length === 0 || needsSql) return;
    setActionError(null);
    setBusy(true);
    setTagsByDoc((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        const s = new Set(next.get(id) ?? []);
        if (on) s.add(def.id); else s.delete(def.id);
        next.set(id, s);
      }
      return next;
    });
    try {
      if (on) await applyReviewTag(def.id, ids, matterId);
      else await removeReviewTag(def.id, ids);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Tagging failed');
      void load();
    } finally {
      setBusy(false);
    }
  }, [matterId, needsSql, load]);

  const toggleOnCursor = useCallback((def: DocumentTagDef | null) => {
    if (!def || !cursor) return;
    void setTag(def, [cursor], !tagsByDoc.get(cursor)?.has(def.id));
  }, [cursor, tagsByDoc, setTag]);

  const presetByKey = useMemo(() => {
    const find = (pred: (d: DocumentTagDef) => boolean) => defs.find(pred) ?? null;
    return {
      p: find((d) => d.behavior === 'privileged') ?? find((d) => d.name === 'Privileged'),
      h: find((d) => d.name === 'Hot Doc'),
      c: find((d) => d.name === 'Confidential'),
      n: find((d) => d.name === 'Non-Responsive') ?? find((d) => d.behavior === 'non_responsive'),
    };
  }, [defs]);

  // Keyboard, as in the Review Room: j/k or arrows move, space ticks,
  // Enter opens, P H C N tag the highlighted document.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      if (
        tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement
        || tgt instanceof HTMLSelectElement || tgt?.isContentEditable
      ) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      const idx = cursor ? visible.findIndex((d) => d.id === cursor) : -1;
      const move = (delta: number) => {
        if (visible.length === 0) return;
        const next = Math.max(0, Math.min(visible.length - 1, (idx < 0 ? -1 : idx) + delta));
        setCursor(visible[next].id);
        document.getElementById(`review-row-${visible[next].id}`)?.scrollIntoView({ block: 'nearest' });
      };
      if (e.key === 'ArrowDown' || k === 'j') { e.preventDefault(); move(1); return; }
      if (e.key === 'ArrowUp' || k === 'k') { e.preventDefault(); move(-1); return; }
      if (!cursor) return;
      if (e.key === ' ') { e.preventDefault(); toggleOne(cursor); return; }
      if (e.key === 'Enter') { e.preventDefault(); window.open(`/app/document/${cursor}`, '_blank', 'noopener'); return; }
      if (k === 'p') { e.preventDefault(); toggleOnCursor(presetByKey.p); return; }
      if (k === 'h') { e.preventDefault(); toggleOnCursor(presetByKey.h); return; }
      if (k === 'c') { e.preventDefault(); toggleOnCursor(presetByKey.c); return; }
      if (k === 'n') { e.preventDefault(); toggleOnCursor(presetByKey.n); return; }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cursor, visible, presetByKey, toggleOnCursor]);

  // The tag bar acts on the ticked documents, or else on the highlighted one.
  const targets = selected.size > 0 ? [...selected] : cursor ? [cursor] : [];
  const targetState = (defId: string): 'all' | 'some' | 'none' => {
    let n = 0;
    for (const id of targets) if (tagsByDoc.get(id)?.has(defId)) n++;
    return n === 0 ? 'none' : n === targets.length ? 'all' : 'some';
  };
  const cursorTitle = cursor ? docs.find((d) => d.id === cursor)?.title ?? '' : '';
  const fmtDay = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  if (loading) return <p className="text-center text-[12px] text-white/40 py-10">Loading the matter&rsquo;s documents…</p>;
  if (loadError) return <p className="text-sm text-red-300">{loadError}</p>;

  const inputCls = '[color-scheme:dark] [&_option]:bg-[#16161e] [&_option]:text-white bg-white/[0.04] border border-white/10 rounded-md px-2 py-1 text-[12px] text-white/85 outline-none focus:border-[#e8b84a]/50';

  return (
    <div>
      {needsSql && (
        <div className="mb-3 rounded-md border border-[#e8b84a]/30 bg-[#e8b84a]/10 px-3 py-2 text-[12px] text-[#e8b84a]">
          Tagging here needs one database update (migration 113) that has not been run yet.
          You can look through the documents; tags cannot be saved until it is.
        </div>
      )}

      <SetsBar
        matterId={matterId}
        defs={defs}
        docs={docs}
        tagsByDoc={tagsByDoc}
        currentFilter={currentFilter}
        selectedIds={[...selected]}
        activeSetId={activeSet?.id ?? null}
        onActivate={activate}
        onProduced={onProduced}
        tagsReady={!needsSql}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/35" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter by name"
            className={`${inputCls} w-full pl-6`}
          />
        </div>
        {folders.length > 1 && (
          <select value={folder} onChange={(e) => setFolder(e.target.value)} className={inputCls} title="Folder">
            <option value="">All folders</option>
            {folders.map((f) => (
              <option key={f || '(matter)'} value={f || '(matter)'}>{f || 'The matter itself'}</option>
            ))}
          </select>
        )}
        {exts.length > 1 && (
          <select value={ext} onChange={(e) => setExt(e.target.value)} className={inputCls} title="File type">
            <option value="">All types</option>
            {exts.map((x) => <option key={x} value={x}>.{x}</option>)}
          </select>
        )}
        <label className="flex items-center gap-1 text-[11px] text-white/45">
          Filed from
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={inputCls} />
        </label>
        <label className="flex items-center gap-1 text-[11px] text-white/45">
          to
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={inputCls} />
        </label>
      </div>

      {/* Tag filter: click once = has the tag, twice = does not, third = off */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3">
        <span className="text-[11px] text-white/55" title="Click a tag once to show only documents with it, twice for documents without it, a third time to stop">
          Show only:
        </span>
        {defsByKind.map(({ kind, defs: group }) => (
          <div key={kind} className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-white/35">{TAG_KIND_LABEL[kind]}</span>
            {group.map((d) => {
              const mode = tagFilters.get(d.id);
              return (
                <button
                  key={d.id}
                  onClick={() => cycleTagFilter(d.id)}
                  title={!mode ? `Show only documents tagged ${d.name}` : mode === 'has' ? `Show only documents NOT tagged ${d.name}` : 'Stop filtering on this tag'}
                  className={`rounded-full transition-opacity ${mode ? 'opacity-100' : 'opacity-55 hover:opacity-90'} ${mode === 'not' ? 'line-through' : ''}`}
                >
                  <TagChip def={d} small />
                </button>
              );
            })}
          </div>
        ))}
        {tagFilters.size > 0 && (
          <button onClick={() => setTagFilters(new Map())} className="text-[11px] text-white/45 hover:text-white inline-flex items-center gap-1">
            <X size={11} /> clear tag filter
          </button>
        )}
      </div>

      {/* Tagging: click a pill to tag the highlighted document, or every
          ticked one; click it again to take the tag off. */}
      <div className="mb-2 rounded-lg border border-[#e8b84a]/25 bg-[#e8b84a]/[0.04] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-[12px] mb-1.5">
          <span className="text-[#e8b84a] font-medium">
            {selected.size > 0
              ? `Tag the ${selected.size} ticked ${selected.size === 1 ? 'document' : 'documents'}:`
              : cursor ? 'Tag this document:' : 'Tagging'}
          </span>
          {selected.size === 0 && cursor && (
            <span className="text-white/60 truncate max-w-[50%]" title={cursorTitle}>{cursorTitle}</span>
          )}
          {targets.length === 0 && (
            <span className="text-white/45">Click a document below to tag it, or tick several to tag them together.</span>
          )}
          <span className="ml-auto text-white/45 tabular-nums">
            {filtered.length} of {docs.length} {docs.length === 1 ? 'document' : 'documents'}
          </span>
          {selected.size > 0 && (
            <button onClick={() => setSelected(new Set())} className="text-white/45 hover:text-white">Untick all</button>
          )}
        </div>
        {targets.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {defs.map((d) => {
              const state = targetState(d.id);
              const on = state === 'all';
              return (
                <button
                  key={d.id}
                  disabled={busy || needsSql}
                  onClick={() => void setTag(d, targets, !on)}
                  title={on
                    ? `Take ${d.name} off ${targets.length === 1 ? 'this document' : `these ${targets.length} documents`}`
                    : `Tag ${targets.length === 1 ? 'this document' : `these ${targets.length} documents`} ${d.name}`}
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-40"
                  style={{
                    color: on ? '#0b0b10' : d.color,
                    backgroundColor: on ? d.color : `${d.color}10`,
                    borderColor: on ? d.color : `${d.color}66`,
                    borderStyle: state === 'some' ? 'dashed' : 'solid',
                  }}
                >
                  {on ? '✓' : '+'} {d.name}
                  {state === 'some' && <span className="opacity-70">(some)</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {actionError && <p className="text-[12px] text-red-300 mb-2">{actionError}</p>}
      {truncated && (
        <p className="text-[11px] text-[#e8b84a]/80 mb-2">Showing the first 20,000 documents in this matter.</p>
      )}

      {/* The table */}
      {docs.length === 0 ? (
        <p className="text-center text-[12px] text-white/45 py-10">No documents are filed in this matter yet.</p>
      ) : (
        <div className="rounded-lg border border-[rgba(255,255,255,0.14)] overflow-hidden">
          <div className="grid grid-cols-[28px_minmax(0,1fr)_120px_52px_90px] gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-white/35 border-b border-white/[0.07]">
            <input type="checkbox" checked={allFilteredSelected} onChange={toggleAll} title="Tick every document shown by the filters" />
            <span>Document</span>
            <span>Folder</span>
            <span className="text-right">Pages</span>
            <span className="text-right">Filed</span>
          </div>
          <div className="max-h-[60vh] overflow-y-auto divide-y divide-white/[0.05]">
            {visible.map((d) => {
              const tags = [...(tagsByDoc.get(d.id) ?? [])].map((id) => defById.get(id)).filter(Boolean) as DocumentTagDef[];
              const isCursor = cursor === d.id;
              return (
                <div
                  key={d.id}
                  id={`review-row-${d.id}`}
                  onClick={() => setCursor(d.id)}
                  className={`grid grid-cols-[28px_minmax(0,1fr)_120px_52px_90px] gap-2 px-3 py-1.5 items-start cursor-pointer text-[12px] ${
                    isCursor ? 'bg-[#e8b84a]/[0.07]' : 'hover:bg-white/[0.03]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(d.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleOne(d.id)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate text-[#f5f1e8]" title={d.source_filename ?? d.title}>{d.title}</span>
                      <a
                        href={`/app/document/${d.id}`}
                        target="_blank"
                        rel="noopener"
                        onClick={(e) => e.stopPropagation()}
                        className="text-white/30 hover:text-[#e8b84a] shrink-0"
                        title="Open the document in a new tab"
                      >
                        <ExternalLink size={11} />
                      </a>
                    </div>
                    {tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {tags.map((t) => (
                          <TagChip key={t.id} def={t} small onRemove={needsSql ? undefined : () => void setTag(t, [d.id], false)} />
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="truncate text-white/50" title={d.folder ?? undefined}>{d.folder ?? '—'}</span>
                  <span className="text-right tabular-nums text-white/50">{d.page_count ?? '—'}</span>
                  <span className="text-right tabular-nums text-white/45">{fmtDay(d.created_at)}</span>
                </div>
              );
            })}
            {filtered.length > shown && (
              <button
                onClick={() => setShown((n) => n + PAGE)}
                className="w-full py-2 text-[12px] text-[#e8b84a] hover:bg-white/[0.03]"
              >
                Show {Math.min(PAGE, filtered.length - shown)} more of {filtered.length - shown}
              </button>
            )}
            {filtered.length === 0 && (
              <p className="text-center text-[12px] text-white/45 py-8">No document matches these filters.</p>
            )}
          </div>
        </div>
      )}
      <p className="mt-2 text-[10.5px] text-white/35">
        Click a row, then a tag above to tag it. Keys: j / k move · space ticks · Enter opens · P privileged · C confidential · H hot · N non-responsive.
        Tags here are on the document itself and are seen in every production.
      </p>
    </div>
  );
}

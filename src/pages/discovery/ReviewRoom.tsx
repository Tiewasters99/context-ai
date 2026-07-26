import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, PanelLeft, ChevronLeft, ChevronRight, ChevronUp, ChevronDown,
  Info, Tags, ShieldAlert, Stamp, FileText, FileWarning, Download, Search,
} from 'lucide-react';
import { resolveMatter, type MatterRef } from '@/lib/vault-persist';
import {
  getProduction, listProductionItems, ensurePresetTagDefs,
  applyTag, removeTag, ensurePrivilegeDraft, getDiscoverySignedUrl,
  listJobsForProduction,
  type Production, type ProductionItem, type DocumentTagDef, type ProcessingJob,
} from '@/lib/discovery';
import { DirectionBadge, StatusBadge, TagChip, JobProgress } from './bits';
import FloatingPanel from './FloatingPanel';
import TagPickerPanel from './TagPickerPanel';
import PrivilegeLogPanel from './PrivilegeLogPanel';
import ProducePanel from './ProducePanel';

// pdfjs worker URL — same build-time resolution pattern as DocumentReader.
const PDFJS_WORKER_URL = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// The REVIEW ROOM — /app/discovery/production/:id. Keyboard-first document
// review: click-through display PDFs, single-key tagging, floating
// metadata / tag / privilege-log / produce panels.
export default function ReviewRoom() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [production, setProduction] = useState<Production | null>(null);
  const [matter, setMatter] = useState<MatterRef | null>(null);
  const [items, setItems] = useState<ProductionItem[]>([]);
  const [defs, setDefs] = useState<DocumentTagDef[]>([]);
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // UI state
  const [listOpen, setListOpen] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [filterTagIds, setFilterTagIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [showMeta, setShowMeta] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [showPrivLog, setShowPrivLog] = useState(false);
  const [showProduce, setShowProduce] = useState(false);
  const [privLogRefresh, setPrivLogRefresh] = useState(0);
  const [tagError, setTagError] = useState<string | null>(null);

  // ── Loading ────────────────────────────────────────────────────────────

  const refreshProduction = useCallback(async () => {
    if (!id) return;
    const p = await getProduction(id);
    if (p) setProduction(p);
    return p;
  }, [id]);

  const refreshItems = useCallback(async () => {
    if (!id) return;
    setItems(await listProductionItems(id));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const p = await getProduction(id);
        if (cancelled) return;
        if (!p) { setLoadError('Production not found, or you don’t have access.'); setLoading(false); return; }
        setProduction(p);
        const [m, its, ds] = await Promise.all([
          resolveMatter(p.matterspace_id),
          listProductionItems(id),
          ensurePresetTagDefs(p.matterspace_id),
        ]);
        if (cancelled) return;
        setMatter(m);
        setItems(its);
        setDefs(ds);
        setSelectedId((cur) => cur ?? its[0]?.id ?? null);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load production');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // Poll worker jobs while any is active so stamping/packaging progress and
  // the resulting status flips show up without a manual reload.
  const hasActiveJobs = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const js = await listJobsForProduction(id);
        if (cancelled) return;
        setJobs(js);
      } catch { /* transient */ }
    };
    void tick();
    const t = setInterval(() => {
      void tick();
      if (hasActiveJobs) { void refreshProduction(); void refreshItems(); }
    }, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [id, hasActiveJobs, refreshProduction, refreshItems]);

  // ── Filtering + selection ──────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return items.filter((it) => {
      if (q && !it.original_filename.toLowerCase().includes(q)
        && !(it.original_path ?? '').toLowerCase().includes(q)
        && !(it.bates_first ?? '').toLowerCase().includes(q)) return false;
      if (filterTagIds.size > 0 && !it.tags.some((t) => filterTagIds.has(t.tag_def_id))) return false;
      return true;
    });
  }, [items, filterText, filterTagIds]);

  const selected = useMemo(
    () => items.find((it) => it.id === selectedId) ?? null,
    [items, selectedId],
  );
  const selectedIdx = filtered.findIndex((it) => it.id === selectedId);

  const goDoc = useCallback((delta: number) => {
    if (filtered.length === 0) return;
    const cur = selectedIdx === -1 ? 0 : selectedIdx;
    const next = Math.max(0, Math.min(filtered.length - 1, cur + delta));
    setSelectedId(filtered[next].id);
  }, [filtered, selectedIdx]);

  // New document → back to page 1.
  useEffect(() => { setPage(1); setNumPages(0); }, [selectedId]);

  // ── Tagging ────────────────────────────────────────────────────────────

  const toggleTag = useCallback(async (def: DocumentTagDef) => {
    if (!selected || !production) return;
    setTagError(null);
    const has = selected.tags.some((t) => t.tag_def_id === def.id);
    // Optimistic flip — review speed lives on this.
    setItems((prev) => prev.map((it) => {
      if (it.id !== selected.id) return it;
      if (has) return { ...it, tags: it.tags.filter((t) => t.tag_def_id !== def.id) };
      return {
        ...it,
        tags: [...it.tags, {
          id: `optimistic-${def.id}`,
          tag_def_id: def.id,
          production_item_id: it.id,
          matterspace_id: it.matterspace_id,
          created_by: null,
          created_at: new Date().toISOString(),
          tag_def: def,
        }],
      };
    }));
    try {
      if (has) {
        await removeTag(def.id, selected.id);
      } else {
        const tag = await applyTag(def.id, selected.id, selected.matterspace_id);
        setItems((prev) => prev.map((it) =>
          it.id === selected.id
            ? { ...it, tags: it.tags.map((t) => (t.id === `optimistic-${def.id}` ? tag : t)) }
            : it,
        ));
        // Tagging Privileged in an OUTGOING production drafts a privilege
        // log entry, pre-filled from the document's extracted metadata.
        if (def.behavior === 'privileged' && production.direction === 'outgoing') {
          await ensurePrivilegeDraft({
            matterspace_id: selected.matterspace_id,
            production_id: production.id,
            production_item_id: selected.id,
            source_metadata: selected.source_metadata,
          });
          setPrivLogRefresh((n) => n + 1);
        }
      }
    } catch (e) {
      setTagError(e instanceof Error ? e.message : 'Tagging failed');
      void refreshItems(); // roll back the optimistic flip from truth
    }
  }, [selected, production, refreshItems]);

  const presetByKey = useMemo(() => {
    const find = (pred: (d: DocumentTagDef) => boolean) => defs.find(pred) ?? null;
    return {
      p: find((d) => d.behavior === 'privileged') ?? find((d) => d.name === 'Privileged'),
      h: find((d) => d.name === 'Hot Doc'),
      c: find((d) => d.name === 'Confidential'),
      n: find((d) => d.behavior === 'non_responsive') ?? find((d) => d.name === 'Non-Responsive'),
    };
  }, [defs]);

  // ── Keyboard — the review room's primary input ─────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      if (
        tgt instanceof HTMLInputElement ||
        tgt instanceof HTMLTextAreaElement ||
        tgt instanceof HTMLSelectElement ||
        tgt?.isContentEditable
      ) return;
      if (e.altKey) return;

      const k = e.key.toLowerCase();
      // Modifier + arrows = document navigation; bare arrows = pages.
      if (e.key === 'ArrowLeft') { e.preventDefault(); if (e.ctrlKey || e.metaKey) goDoc(-1); else setPage((p) => Math.max(1, p - 1)); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); if (e.ctrlKey || e.metaKey) goDoc(1); else setPage((p) => (numPages ? Math.min(numPages, p + 1) : p + 1)); return; }
      if (e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowDown' || k === 'j') { e.preventDefault(); goDoc(1); return; }
      if (e.key === 'ArrowUp' || k === 'k') { e.preventDefault(); goDoc(-1); return; }
      if (k === 'p' && presetByKey.p) { e.preventDefault(); void toggleTag(presetByKey.p); return; }
      if (k === 'h' && presetByKey.h) { e.preventDefault(); void toggleTag(presetByKey.h); return; }
      if (k === 'c' && presetByKey.c) { e.preventDefault(); void toggleTag(presetByKey.c); return; }
      if (k === 'n' && presetByKey.n) { e.preventDefault(); void toggleTag(presetByKey.n); return; }
      if (k === 't') { e.preventDefault(); setShowTags((v) => !v); return; }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goDoc, numPages, presetByKey, toggleTag]);

  // ── Render ─────────────────────────────────────────────────────────────

  if (loadError) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-[13px] text-red-300">{loadError}</p>
      </div>
    );
  }

  const activeJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'running');

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: 'rgba(4,4,8,0.55)' }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-3 h-12 border-b border-[rgba(255,255,255,0.08)] shrink-0 backdrop-blur-[30px]"
        style={{ backgroundColor: 'rgba(10,10,16,0.72)' }}
      >
        <button
          onClick={() =>
            navigate(production && matter
              ? `/app/discovery?matter=${encodeURIComponent(matter.short_code ?? matter.id)}`
              : '/app')
          }
          className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
          title="Back to Discovery"
        >
          <ArrowLeft size={15} />
        </button>
        <button
          onClick={() => setListOpen((v) => !v)}
          className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 ${
            listOpen ? 'text-[#d4a054]' : 'text-white/70 hover:text-white'
          }`}
          title={listOpen ? 'Hide document list' : 'Show document list'}
        >
          <PanelLeft size={15} />
        </button>
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <span
            className="text-[14.5px] text-[#f5f2ed] truncate"
            style={{ fontFamily: 'Playfair Display Variable, serif' }}
          >
            {production?.name ?? 'Loading…'}
          </span>
          {production && <DirectionBadge direction={production.direction} />}
          {production && <StatusBadge status={production.status} />}
        </div>

        {/* Doc navigation */}
        <div className="flex items-center gap-0.5 mr-1">
          <button
            onClick={() => goDoc(-1)}
            disabled={selectedIdx <= 0}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-30"
            title="Previous document (K / ↑)"
          >
            <ChevronUp size={15} />
          </button>
          <span className="text-[10.5px] text-white/45 tabular-nums w-14 text-center">
            {selectedIdx >= 0 ? selectedIdx + 1 : '—'} / {filtered.length}
          </span>
          <button
            onClick={() => goDoc(1)}
            disabled={selectedIdx === -1 || selectedIdx >= filtered.length - 1}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-30"
            title="Next document (J / ↓)"
          >
            <ChevronDown size={15} />
          </button>
        </div>

        <div className="w-px h-5 bg-white/10" />

        {/* Panel toggles */}
        <button
          onClick={() => setShowMeta((v) => !v)}
          className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 ${showMeta ? 'text-[#d4a054]' : 'text-white/70 hover:text-white'}`}
          title="Document metadata"
        >
          <Info size={15} />
        </button>
        <button
          onClick={() => setShowTags((v) => !v)}
          className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 ${showTags ? 'text-[#d4a054]' : 'text-white/70 hover:text-white'}`}
          title="Tags (T)"
        >
          <Tags size={15} />
        </button>
        {production?.direction === 'outgoing' && (
          <>
            <button
              onClick={() => setShowPrivLog((v) => !v)}
              className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 ${showPrivLog ? 'text-[#f87171]' : 'text-white/70 hover:text-white'}`}
              title="Privilege log"
            >
              <ShieldAlert size={15} />
            </button>
            <button
              onClick={() => setShowProduce((v) => !v)}
              className={`h-8 px-2.5 inline-flex items-center gap-1.5 justify-center rounded-md border text-[11.5px] font-medium transition-colors ${
                showProduce
                  ? 'border-[#e8b84a]/45 bg-[#e8b84a]/15 text-[#e8b84a]'
                  : 'border-[#e8b84a]/25 bg-[#e8b84a]/8 text-[#e8b84a]/85 hover:bg-[#e8b84a]/15'
              }`}
              title="Bates & Produce"
            >
              <Stamp size={13} />
              Bates &amp; Produce
            </button>
          </>
        )}
      </div>

      {/* Active job strip */}
      {activeJobs.length > 0 && (
        <div className="px-4 py-1.5 border-b border-[rgba(255,255,255,0.06)] space-y-1" style={{ backgroundColor: 'rgba(212,160,84,0.05)' }}>
          {activeJobs.map((j) => <JobProgress key={j.id} job={j} />)}
        </div>
      )}
      {tagError && (
        <div className="px-4 py-1.5 border-b border-[rgba(255,255,255,0.06)] text-[11px] text-red-300 bg-red-500/8">
          {tagError}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Left — document list */}
        {listOpen && (
          <div className="w-[300px] shrink-0 border-r border-[rgba(255,255,255,0.08)] flex flex-col min-h-0" style={{ backgroundColor: 'rgba(8,8,14,0.7)' }}>
            <div className="p-2.5 border-b border-[rgba(255,255,255,0.06)] space-y-2 shrink-0">
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
                <input
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="Filter by filename or Bates…"
                  className="w-full rounded-md bg-[rgba(18,18,28,0.78)] border border-[rgba(255,255,255,0.08)] pl-7 pr-2 py-1.5 text-[11.5px] text-[#f0ebe3] placeholder:text-white/30 focus:outline-none focus:border-[#d4a054]/50"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {defs.map((def) => {
                  const on = filterTagIds.has(def.id);
                  return (
                    <button
                      key={def.id}
                      onClick={() => setFilterTagIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(def.id)) next.delete(def.id); else next.add(def.id);
                        return next;
                      })}
                      className={`rounded-full border px-1.5 py-px text-[9px] font-medium transition-all ${on ? '' : 'opacity-45 hover:opacity-80'}`}
                      style={{ color: def.color, borderColor: `${def.color}66`, backgroundColor: on ? `${def.color}22` : 'transparent' }}
                      title={`Filter: ${def.name}`}
                    >
                      {def.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {loading && <p className="text-[11px] text-white/40 text-center py-6">Loading documents…</p>}
              {!loading && filtered.length === 0 && (
                <p className="text-[11px] text-white/40 text-center py-6 px-4">
                  {items.length === 0 ? 'No documents yet — intake is empty or still processing.' : 'Nothing matches the filter.'}
                </p>
              )}
              {filtered.map((it) => {
                const sel = it.id === selectedId;
                return (
                  <button
                    key={it.id}
                    onClick={() => setSelectedId(it.id)}
                    className={`block w-full text-left px-3 py-2 border-l-2 transition-colors ${
                      sel
                        ? 'border-[#d4a054] bg-[#d4a054]/8'
                        : 'border-transparent hover:bg-[rgba(255,255,255,0.03)]'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {it.kind === 'native' || !it.display_storage_path
                        ? <FileWarning size={11} className="text-white/35 shrink-0" />
                        : <FileText size={11} className="text-[#d4a054]/70 shrink-0" />}
                      <span className={`text-[11.5px] truncate flex-1 ${sel ? 'text-[#f5f1e8]' : 'text-white/75'}`}>
                        {it.original_filename}
                      </span>
                      {it.status === 'error' && <span className="w-1.5 h-1.5 rounded-full bg-[#f87171] shrink-0" title={it.error ?? 'error'} />}
                      {it.status === 'pending' && <span className="w-1.5 h-1.5 rounded-full bg-[#fbbf24] shrink-0" title="processing" />}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap pl-[17px]">
                      <span className="text-[9.5px] text-white/35 tabular-nums">
                        {it.page_count != null ? `${it.page_count} pp` : it.kind === 'native' ? 'native' : '…'}
                      </span>
                      {it.bates_first && (
                        <span className="text-[9px] font-mono text-[#d4a054]/70">{it.bates_first}</span>
                      )}
                      {it.tags.map((t) => t.tag_def && <TagChip key={t.id} def={t.tag_def} small />)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Center — the document */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="flex-1 min-h-0 relative">
            {selected ? (
              selected.kind === 'native' || !selected.display_storage_path ? (
                <NativePlaceholder item={selected} />
              ) : (
                <PdfPane
                  storagePath={selected.display_storage_path}
                  page={page}
                  onNumPages={setNumPages}
                />
              )
            ) : (
              <div className="h-full flex items-center justify-center">
                <p className="text-[12.5px] text-white/40">
                  {loading ? '' : 'Select a document to begin review.'}
                </p>
              </div>
            )}
          </div>

          {/* Page nav + keymap hint */}
          <div className="shrink-0 border-t border-[rgba(255,255,255,0.08)] px-3 h-11 flex items-center gap-3 backdrop-blur-[30px]" style={{ backgroundColor: 'rgba(10,10,16,0.72)' }}>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-30"
                title="Previous page (←)"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="text-[10.5px] text-white/55 tabular-nums w-14 text-center">
                {numPages > 0 ? `${page} / ${numPages}` : '— / —'}
              </span>
              <button
                onClick={() => setPage((p) => (numPages ? Math.min(numPages, p + 1) : p))}
                disabled={numPages === 0 || page >= numPages}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-30"
                title="Next page (→)"
              >
                <ChevronRight size={14} />
              </button>
            </div>
            <div className="flex-1 min-w-0 text-right">
              <span className="text-[9.5px] text-white/35 tracking-wide whitespace-nowrap">
                <Kbd>P</Kbd> privileged · <Kbd>H</Kbd> hot doc · <Kbd>C</Kbd> confidential · <Kbd>N</Kbd> non-resp ·{' '}
                <Kbd>T</Kbd> tags · <Kbd>←</Kbd><Kbd>→</Kbd> pages · <Kbd>J</Kbd><Kbd>K</Kbd> or <Kbd>↑</Kbd><Kbd>↓</Kbd> docs · <Kbd>Ctrl</Kbd>+<Kbd>←→</Kbd> docs
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Floating panels */}
      {showMeta && selected && (
        <MetadataPanel item={selected} onClose={() => setShowMeta(false)} />
      )}
      {showTags && production && (
        <TagPickerPanel
          matterspaceId={production.matterspace_id}
          defs={defs}
          item={selected}
          onToggle={(def) => void toggleTag(def)}
          onDefsChanged={setDefs}
          onClose={() => setShowTags(false)}
        />
      )}
      {showPrivLog && production && (
        <PrivilegeLogPanel
          productionId={production.id}
          items={items}
          refreshKey={privLogRefresh}
          onClose={() => setShowPrivLog(false)}
          onJump={(itemId) => setSelectedId(itemId)}
        />
      )}
      {showProduce && production && (
        <ProducePanel
          production={production}
          items={items}
          onClose={() => setShowProduce(false)}
          onChanged={() => { void refreshProduction(); }}
        />
      )}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1 py-px rounded border border-white/15 bg-white/5 text-white/55 text-[9px] font-sans">
      {children}
    </kbd>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF pane — renders one page of the display PDF from a signed storage URL.
// ─────────────────────────────────────────────────────────────────────────────

function PdfPane({
  storagePath,
  page,
  onNumPages,
}: {
  storagePath: string;
  page: number;
  onNumPages: (n: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<unknown>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Re-fit on pane resize.
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load the document whenever the storage path changes.
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setErrorMsg(null);
    pdfRef.current = null;
    void (async () => {
      try {
        const url = await getDiscoverySignedUrl(storagePath, 3600);
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        const pdf = await pdfjsLib.getDocument({ url }).promise;
        if (cancelled) { void pdf.destroy(); return; }
        pdfRef.current = pdf;
        onNumPages(pdf.numPages);
        setState('ready');
      } catch (e) {
        if (!cancelled) {
          setErrorMsg(e instanceof Error ? e.message : 'Failed to open the display PDF.');
          setState('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [storagePath, onNumPages]);

  // Render the current page, fit to the pane.
  useEffect(() => {
    if (state !== 'ready') return;
    const pdf = pdfRef.current as {
      numPages: number;
      getPage(n: number): Promise<{
        getViewport(opts: { scale: number }): { width: number; height: number };
        render(opts: unknown): { promise: Promise<void> };
      }>;
    } | null;
    const canvas = canvasRef.current;
    const pane = paneRef.current;
    if (!pdf || !canvas || !pane) return;
    let cancelled = false;
    void (async () => {
      try {
        const n = Math.max(1, Math.min(pdf.numPages, page));
        const pdfPage = await pdf.getPage(n);
        if (cancelled) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const PAD = 28;
        const fit = Math.min(
          (pane.clientWidth - PAD * 2) / natural.width,
          (pane.clientHeight - PAD * 2) / natural.height,
        );
        const scale = Math.max(0.1, Math.min(fit, 4));
        const viewport = pdfPage.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
      } catch {
        // page-change races correct themselves on the next render
      }
    })();
    return () => { cancelled = true; };
  }, [state, page, tick]);

  return (
    <div ref={paneRef} className="absolute inset-0 flex items-center justify-center overflow-auto">
      {state === 'loading' && <p className="text-[12px] text-white/45">Opening document…</p>}
      {state === 'error' && <p className="text-[12px] text-red-300 px-6 text-center">{errorMsg}</p>}
      {state === 'ready' && <canvas ref={canvasRef} className="block shadow-2xl" />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Native-file placeholder — no display PDF; offer the native for download.
// ─────────────────────────────────────────────────────────────────────────────

function NativePlaceholder({ item }: { item: ProductionItem }) {
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    if (!item.native_storage_path) return;
    try {
      const url = await getDiscoverySignedUrl(item.native_storage_path, 600);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to sign download URL');
    }
  };
  const ext = (item.original_filename.split('.').pop() ?? '').toUpperCase();
  return (
    <div className="h-full flex items-center justify-center">
      <div className="rounded-xl border border-[rgba(255,255,255,0.1)] px-10 py-9 text-center max-w-sm backdrop-blur-[20px]" style={{ backgroundColor: 'rgba(10,10,16,0.8)' }}>
        <div className="w-14 h-16 mx-auto mb-4 rounded-md border border-white/15 bg-white/4 flex items-center justify-center relative">
          <span className="text-[10px] font-bold tracking-wider text-[#d4a054]">{ext || 'FILE'}</span>
          <span className="absolute top-0 right-0 w-3.5 h-3.5 bg-[#0a0a10] border-l border-b border-white/15 rounded-bl" />
        </div>
        <p className="text-[13px] text-[#f5f1e8] font-medium break-all mb-1">{item.original_filename}</p>
        <p className="text-[11px] text-white/45 mb-5">
          {item.kind === 'native'
            ? 'Native file — no display rendering. Review it in its own application.'
            : 'The display PDF for this document isn’t ready yet.'}
          {item.file_size_bytes != null && (
            <span className="block mt-1 tabular-nums">{(item.file_size_bytes / 1048576).toFixed(2)} MB</span>
          )}
        </p>
        {item.native_storage_path && (
          <button
            onClick={() => void download()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#e8b84a]/12 hover:bg-[#e8b84a]/22 border border-[#e8b84a]/30 text-[#e8b84a] text-[12px] font-medium transition-colors"
          >
            <Download size={13} strokeWidth={1.75} />
            Download native file
          </button>
        )}
        {error && <p className="text-[10.5px] text-red-300 mt-3">{error}</p>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata panel — source_metadata jsonb pretty-rendered + integrity fields.
// ─────────────────────────────────────────────────────────────────────────────

function MetadataPanel({ item, onClose }: { item: ProductionItem; onClose: () => void }) {
  const metaEntries = Object.entries(item.source_metadata ?? {});
  return (
    <FloatingPanel
      title="Document Metadata"
      icon={<Info size={14} />}
      storageKey="cs.discovery.meta"
      defaultStyle={{ right: 24, top: 170, width: 360 }}
      onClose={onClose}
    >
      <div className="px-3.5 py-3 cursor-default">
        <p className="text-[12px] text-[#f5f1e8] font-medium break-all mb-3">{item.original_filename}</p>

        <MetaSection label="File">
          <MetaRow k="Kind" v={item.kind === 'native' ? 'Native only' : 'Display PDF'} />
          {item.original_path && <MetaRow k="Path in production" v={item.original_path} mono />}
          {item.page_count != null && <MetaRow k="Pages" v={String(item.page_count)} />}
          {item.file_size_bytes != null && (
            <MetaRow k="Size" v={`${(item.file_size_bytes / 1048576).toFixed(2)} MB`} />
          )}
          <MetaRow k="Status" v={item.status} />
          {item.error && <MetaRow k="Error" v={item.error} />}
          <MetaRow k="Added" v={new Date(item.created_at).toLocaleString()} />
        </MetaSection>

        {(item.bates_first || item.bates_last) && (
          <MetaSection label="Bates">
            {item.bates_first && <MetaRow k="First" v={item.bates_first} mono />}
            {item.bates_last && <MetaRow k="Last" v={item.bates_last} mono />}
          </MetaSection>
        )}

        {item.sha256 && (
          <MetaSection label="Integrity">
            <MetaRow k="sha256" v={item.sha256} mono breakAll />
          </MetaSection>
        )}

        <MetaSection label="Source metadata">
          {metaEntries.length === 0 && (
            <p className="text-[11px] text-white/35 py-1">No extracted metadata.</p>
          )}
          {metaEntries.map(([k, v]) => (
            <MetaRow
              key={k}
              k={k}
              v={typeof v === 'object' && v !== null ? JSON.stringify(v, null, 1) : String(v)}
              mono={typeof v === 'object'}
              breakAll
            />
          ))}
        </MetaSection>
      </div>
    </FloatingPanel>
  );
}

function MetaSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p className="text-[9.5px] font-semibold text-[#d4a054]/75 uppercase tracking-widest mb-1 border-b border-[rgba(255,255,255,0.06)] pb-1">
        {label}
      </p>
      <div className="divide-y divide-[rgba(255,255,255,0.04)]">{children}</div>
    </div>
  );
}

function MetaRow({ k, v, mono, breakAll }: { k: string; v: string; mono?: boolean; breakAll?: boolean }) {
  return (
    <div className="flex gap-3 py-1">
      <span className="text-[10.5px] text-white/40 w-24 shrink-0 truncate" title={k}>{k}</span>
      <span
        className={`text-[10.5px] text-white/80 min-w-0 whitespace-pre-wrap ${mono ? 'font-mono text-[10px]' : ''} ${breakAll ? 'break-all' : 'break-words'}`}
      >
        {v}
      </span>
    </div>
  );
}

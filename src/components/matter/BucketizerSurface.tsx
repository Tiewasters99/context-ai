import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, Check, X, Plus, Trash2, Loader2,
  Sparkles, FolderTree, ArrowUp, ArrowDown, FileText, Play, Square,
} from 'lucide-react';
import DocumentPicker from '@/components/matter/DocumentPicker';
import {
  fetchTree, createNode, updateNode, deleteNode,
  generateTreeFromPleadings, listUnclassifiedDocs, classifyDocuments,
  decideClassification, addManualClassification,
  fetchClassificationsForNode, fetchNodeCounts,
  estimateClassifyRun, formatCents, emptyProgress,
  type BucketNode, type NodeKind, type ClassifiedDoc, type ClassifyProgress,
  type DocRow, type RunEstimate,
} from '@/lib/bucketizer';
import { showingOf } from '@/lib/paged';

// The Bucketizer: the matter's living case-theory tree (claims → elements →
// subissues, plus cross-cutting themes) with documents classified into it —
// AI-proposed, attorney-confirmed. The attorney owns the tree: every label
// and description is editable, and descriptions are the routing criteria the
// classifier reads, so editing them retunes future classification.

const KIND_TINT: Record<NodeKind, string> = {
  claim: 'text-[#d4a054]',
  element: 'text-sky-300',
  subissue: 'text-zinc-300',
  theme: 'text-emerald-300',
};
const KIND_LABEL: Record<NodeKind, string> = {
  claim: 'Claim', element: 'Element', subissue: 'Subissue', theme: 'Theme',
};
const CHILD_KIND: Record<NodeKind, NodeKind> = {
  claim: 'element', element: 'subissue', subissue: 'subissue', theme: 'subissue',
};

export default function BucketizerSurface({ matterId }: { matterId: string }) {
  const [nodes, setNodes] = useState<BucketNode[] | null>(null);
  const [counts, setCounts] = useState<Map<string, { proposed: number; confirmed: number }>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [showPleadingPicker, setShowPleadingPicker] = useState(false);
  const [generating, setGenerating] = useState(false);

  const [classifying, setClassifying] = useState<ClassifyProgress | null>(null);
  const [unclassifiedCount, setUnclassifiedCount] = useState<number | null>(null);
  const classifyAbort = useRef<AbortController | null>(null);

  // A bulk run is quoted before it is started, never after.
  const [pending, setPending] = useState<{ docs: DocRow[]; estimate: RunEstimate } | null>(null);
  const [preparing, setPreparing] = useState(false);
  // What the last run has to say for itself: a meter pause, windows that
  // could not be used, documents left for next time.
  const [runReport, setRunReport] = useState<ClassifyProgress | null>(null);

  const [nodeDocs, setNodeDocs] = useState<ClassifiedDoc[] | null>(null);
  const [nodeDocsNotice, setNodeDocsNotice] = useState<string | null>(null);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [tree, cts] = await Promise.all([fetchTree(matterId), fetchNodeCounts(matterId)]);
      setNodes(tree);
      setCounts(cts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the tree.');
    }
  }, [matterId]);

  useEffect(() => {
    setNodes(null);
    setSelectedId(null);
    setNodeDocs(null);
    void reload();
    void listUnclassifiedDocs(matterId)
      .then((d) => setUnclassifiedCount(d.length))
      .catch(() => setUnclassifiedCount(null));
  }, [matterId, reload]);

  const loadNodeDocs = useCallback(async (nodeId: string) => {
    const page = await fetchClassificationsForNode(nodeId);
    setNodeDocs(page.rows);
    setNodeDocsNotice(showingOf(page, 'documents'));
  }, []);

  // Load the selected node's documents.
  useEffect(() => {
    if (!selectedId) { setNodeDocs(null); setNodeDocsNotice(null); return; }
    let cancelled = false;
    setNodeDocs(null);
    setNodeDocsNotice(null);
    void fetchClassificationsForNode(selectedId)
      .then((page) => {
        if (cancelled) return;
        setNodeDocs(page.rows);
        setNodeDocsNotice(showingOf(page, 'documents'));
      })
      .catch(() => { if (!cancelled) setNodeDocs([]); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const byParent = useMemo(() => {
    const m = new Map<string, BucketNode[]>();
    for (const n of nodes ?? []) {
      const key = n.parent_id ?? 'root';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(n);
    }
    for (const list of m.values()) list.sort((a, b) => a.position - b.position);
    return m;
  }, [nodes]);

  const selected = useMemo(
    () => nodes?.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  // ---- tree generation ----------------------------------------------------

  const handleGenerate = useCallback(async (docs: { id: string }[]) => {
    setShowPleadingPicker(false);
    if (!docs.length) return;
    setGenerating(true);
    setError(null);
    try {
      await generateTreeFromPleadings({ matterId, pleadingDocIds: docs.map((d) => d.id) });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tree generation failed.');
    } finally {
      setGenerating(false);
    }
  }, [matterId, reload]);

  // ---- classification -----------------------------------------------------

  /** Step one: count the work and price it. Nothing is spent here. */
  const handlePrepareRun = useCallback(async () => {
    if (!nodes?.length) return;
    setPreparing(true);
    setError(null);
    setRunReport(null);
    try {
      const docs = await listUnclassifiedDocs(matterId);
      setUnclassifiedCount(docs.length);
      if (!docs.length) return;
      setPending({ docs, estimate: estimateClassifyRun(docs, nodes) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not work out what is left to classify.');
    } finally {
      setPreparing(false);
    }
  }, [matterId, nodes]);

  /** Step two: the person clicked through the estimate. */
  const handleClassifyAll = useCallback(async () => {
    const run = pending;
    if (!run || !nodes?.length) return;
    setPending(null);
    const controller = new AbortController();
    classifyAbort.current = controller;
    setClassifying(emptyProgress(run.docs.length));
    try {
      const final = await classifyDocuments({
        matterId, docs: run.docs, nodes,
        signal: controller.signal,
        onProgress: setClassifying,
      });
      // Kept on screen after the spinner goes: a pause, or a window that could
      // not be used, is something the attorney has to know about.
      if (final.pausedMessage || final.notes.length || final.errors) setRunReport(final);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Classification failed.');
    } finally {
      setClassifying(null);
      classifyAbort.current = null;
      setCounts(await fetchNodeCounts(matterId));
      void listUnclassifiedDocs(matterId).then((d) => setUnclassifiedCount(d.length)).catch(() => {});
      if (selectedId) void loadNodeDocs(selectedId).catch(() => {});
    }
  }, [matterId, nodes, pending, selectedId, loadNodeDocs]);

  // ---- node edits ---------------------------------------------------------

  const handleAddNode = useCallback(async (parent: BucketNode | null) => {
    const siblings = byParent.get(parent?.id ?? 'root') ?? [];
    const kind: NodeKind = parent ? CHILD_KIND[parent.kind] : 'theme';
    try {
      const created = await createNode({
        matterId,
        parentId: parent?.id ?? null,
        kind,
        label: parent ? `New ${KIND_LABEL[kind].toLowerCase()}` : 'New bucket',
        position: siblings.length,
      });
      setNodes((prev) => (prev ? [...prev, created] : [created]));
      setSelectedId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the bucket.');
    }
  }, [matterId, byParent]);

  const handleDelete = useCallback(async (node: BucketNode) => {
    if (!window.confirm(`Delete "${node.label}" and everything under it? Classifications into these buckets are removed too.`)) return;
    try {
      await deleteNode(node.id);
      if (selectedId === node.id) setSelectedId(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed.');
    }
  }, [reload, selectedId]);

  const handleMove = useCallback(async (node: BucketNode, dir: -1 | 1) => {
    const siblings = byParent.get(node.parent_id ?? 'root') ?? [];
    const idx = siblings.findIndex((s) => s.id === node.id);
    const swap = siblings[idx + dir];
    if (!swap) return;
    try {
      await Promise.all([
        updateNode(node.id, { position: swap.position }),
        updateNode(swap.id, { position: node.position }),
      ]);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reorder failed.');
    }
  }, [byParent, reload]);

  const saveNodePatch = useCallback(async (nodeId: string, patch: { label?: string; description?: string }) => {
    setBusy(true);
    try {
      await updateNode(nodeId, patch);
      setNodes((prev) => prev?.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }, []);

  // ---- review decisions ---------------------------------------------------

  const handleDecide = useCallback(async (c: ClassifiedDoc, decision: 'confirmed' | 'rejected') => {
    try {
      await decideClassification(c.classification.id, decision);
      setNodeDocs((prev) => prev?.map((d) =>
        d.classification.id === c.classification.id
          ? { ...d, classification: { ...d.classification, status: decision } }
          : d) ?? null);
      setCounts(await fetchNodeCounts(matterId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the decision.');
    }
  }, [matterId]);

  const handleManualAdd = useCallback(async (docs: { id: string }[]) => {
    setShowManualAdd(false);
    if (!selectedId || !docs.length) return;
    try {
      for (const d of docs) {
        await addManualClassification({ matterId, documentId: d.id, nodeId: selectedId });
      }
      await loadNodeDocs(selectedId);
      setCounts(await fetchNodeCounts(matterId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the document.');
    }
  }, [matterId, selectedId, loadNodeDocs]);

  // ---- render -------------------------------------------------------------

  if (nodes === null && !error) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading the case-theory tree…
      </div>
    );
  }

  const roots = byParent.get('root') ?? [];

  return (
    <div className="flex flex-col gap-3 min-h-0">
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span>{error}</span>
          <button className="text-red-300/70 hover:text-red-200" onClick={() => setError(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setShowPleadingPicker(true)}
          disabled={generating || !!classifying}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#d4a054]/40 bg-[#d4a054]/10 px-3 py-1.5 text-sm text-[#d4a054] hover:bg-[#d4a054]/20 disabled:opacity-50"
        >
          {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {roots.length ? 'Regenerate from pleadings' : 'Generate tree from pleadings'}
        </button>
        <button
          onClick={() => void handleAddNode(null)}
          disabled={generating}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" /> Add bucket
        </button>
        {roots.length > 0 && !classifying && (
          <button
            onClick={() => void handlePrepareRun()}
            disabled={preparing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
          >
            {preparing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Classify new documents{unclassifiedCount != null ? ` (${unclassifiedCount})` : ''}
          </button>
        )}
        {classifying && (
          <div className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-300">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-300" />
            {classifying.done}/{classifying.total} · {classifying.proposed} proposals
            {classifying.docWindowsTotal > 1 && (
              <span className="text-zinc-500">
                · part {classifying.docWindowsDone}/{classifying.docWindowsTotal}
              </span>
            )}
            {classifying.windowsResumed > 0 && (
              <span className="text-emerald-400/80" title="Windows a previous run had already finished — not charged again">
                · {classifying.windowsResumed} resumed
              </span>
            )}
            {classifying.errors > 0 && <span className="text-orange-300">· {classifying.errors} errors</span>}
            <span className="max-w-[220px] truncate text-zinc-500">{classifying.currentTitle}</span>
            <button
              onClick={() => classifyAbort.current?.abort()}
              className="ml-1 text-zinc-400 hover:text-zinc-200" title="Stop"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {runReport && <RunReport report={runReport} onDismiss={() => setRunReport(null)} />}

      {/* Empty state */}
      {roots.length === 0 && !generating && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-6 py-10 text-center">
          <FolderTree className="mx-auto mb-3 w-8 h-8 text-[#d4a054]/70" />
          <p className="text-zinc-300 font-medium">No case-theory tree yet</p>
          <p className="mt-1 text-sm text-zinc-500 max-w-md mx-auto">
            Pick the operative complaint and answer, and the Bucketizer drafts your working
            outline — claims, elements to prove, contested subissues, and themes. You own the
            tree: edit anything; documents are then classified into it for your review.
          </p>
        </div>
      )}
      {generating && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-6 py-8 text-center text-zinc-400">
          <Loader2 className="mx-auto mb-2 w-6 h-6 animate-spin text-[#d4a054]" />
          Reading the pleadings and drafting the case-theory tree…
        </div>
      )}

      {/* Tree + detail panes */}
      {roots.length > 0 && (
        <div className="flex gap-3 min-h-0 flex-1 flex-col lg:flex-row">
          <div className="lg:w-1/2 min-w-0 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.02] p-2">
            {roots.map((n) => (
              <TreeNode
                key={n.id}
                node={n}
                depth={0}
                byParent={byParent}
                counts={counts}
                collapsed={collapsed}
                setCollapsed={setCollapsed}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onAddChild={handleAddNode}
                onDelete={handleDelete}
                onMove={handleMove}
              />
            ))}
          </div>

          <div className="lg:w-1/2 min-w-0 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.02] p-4">
            {!selected && (
              <p className="text-sm text-zinc-500 py-8 text-center">
                Select a bucket to edit it and review its documents.
              </p>
            )}
            {selected && (
              <NodeDetail
                key={selected.id}
                node={selected}
                docs={nodeDocs}
                docsNotice={nodeDocsNotice}
                busy={busy}
                onSave={saveNodePatch}
                onDecide={handleDecide}
                onManualAdd={() => setShowManualAdd(true)}
              />
            )}
          </div>
        </div>
      )}

      {pending && (
        <RunEstimateDialog
          estimate={pending.estimate}
          onCancel={() => setPending(null)}
          onConfirm={() => void handleClassifyAll()}
        />
      )}

      {showPleadingPicker && (
        <DocumentPicker
          matterId={matterId}
          onCancel={() => setShowPleadingPicker(false)}
          onConfirm={(docs) => void handleGenerate(docs)}
        />
      )}
      {showManualAdd && selectedId && (
        <DocumentPicker
          matterId={matterId}
          onCancel={() => setShowManualAdd(false)}
          onConfirm={(docs) => void handleManualAdd(docs)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The bill, before the work.
 *
 * Classifying a matter used to be one model call per document, and this
 * change makes it one call per WINDOW so that a 247-page deposition is read
 * to the end rather than bucketed on its first thirty pages. That is more
 * calls and more money, and a change that multiplies a bill has to say so
 * before it runs — not in a ledger afterwards
 * (feedback: agent-economics-deterministic-first).
 *
 * Every number here is arithmetic over the price table `/api/llm` actually
 * charges from (lib/usage-prices.mjs). No rate is invented, and the estimate
 * is biased high in the same direction the server's is.
 */
function RunEstimateDialog({
  estimate, onCancel, onConfirm,
}: {
  estimate: RunEstimate;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-white/10 bg-zinc-950 p-5 shadow-2xl">
        <h3 className="text-base font-medium text-zinc-100">Classify {estimate.documents.toLocaleString()} documents?</h3>

        <dl className="mt-4 space-y-2 text-sm">
          <Row label="Documents" value={estimate.documents.toLocaleString()} />
          <Row
            label="Model calls"
            value={estimate.windows.toLocaleString()}
            hint={estimate.longDocuments > 0
              ? `${estimate.longDocuments.toLocaleString()} are long enough to be read in parts (largest: ${estimate.largestDocumentWindows} parts)`
              : 'one per document'}
          />
          <Row
            label="Estimated cost"
            value={formatCents(estimate.cents)}
            hint={`at ${estimate.modelId} list rates — the estimate is deliberately high, and you are charged what the calls actually use`}
          />
        </dl>

        <p className="mt-4 text-xs leading-relaxed text-zinc-500">
          Every page of every document is read — long documents are split into parts and the
          results merged, so a deposition is no longer bucketed on its opening pages.
          {estimate.documentsWithoutPageCount > 0 && (
            <> {estimate.documentsWithoutPageCount.toLocaleString()} document
              {estimate.documentsWithoutPageCount === 1 ? ' has' : 's have'} no page count recorded and
              {estimate.documentsWithoutPageCount === 1 ? ' is' : ' are'} assumed short here; if
              {estimate.documentsWithoutPageCount === 1 ? ' it turns' : ' they turn'} out to be long,
              the real cost will be higher than this.</>
          )}
          {' '}Page counts are converted at about {estimate.assumedCharsPerPage.toLocaleString()} characters
          a page. You can stop the run at any time, and closing the tab does not lose the parts already done.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          If this matter is sealed, it is served by the sealed pen inside our own AWS account,
          which costs less than the figure above — you are metered at the price of the model that
          actually answers.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-500/20"
          >
            <Play className="w-4 h-4" /> Run it
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/5 pb-2">
      <dt className="text-zinc-400">{label}</dt>
      <dd className="text-right">
        <span className="text-zinc-100">{value}</span>
        {hint && <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>}
      </dd>
    </div>
  );
}

/**
 * What the run has to say for itself afterwards. A paused run is not a failed
 * run — everything finished is saved, and pressing the button again picks up
 * where it stopped without paying for any window twice.
 */
function RunReport({ report, onDismiss }: { report: ClassifyProgress; onDismiss: () => void }) {
  const paused = Boolean(report.pausedMessage);
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${paused
      ? 'border-[#d4a054]/40 bg-[#d4a054]/10 text-[#d4a054]'
      : 'border-orange-500/30 bg-orange-500/10 text-orange-200'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {paused && (
            <>
              <p className="font-medium">Paused — {report.done} of {report.total} documents done.</p>
              <p className="mt-0.5 text-xs opacity-90">{report.pausedMessage}</p>
              {report.retryAfterSeconds != null && (
                <p className="mt-0.5 text-xs opacity-75">
                  Try again in about {Math.ceil(report.retryAfterSeconds / 60)} minute
                  {Math.ceil(report.retryAfterSeconds / 60) === 1 ? '' : 's'}.
                </p>
              )}
              <p className="mt-1 text-xs opacity-75">
                Nothing already read is lost, and none of it will be charged again.
              </p>
            </>
          )}
          {!paused && report.errors > 0 && (
            <p className="font-medium">
              {report.errors} document{report.errors === 1 ? '' : 's'} could not be finished and
              will be retried the next time you run this.
            </p>
          )}
          {report.notes.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-xs opacity-90">
              {report.notes.slice(0, 8).map((n, i) => <li key={i}>· {n}</li>)}
              {report.notes.length > 8 && <li>· and {report.notes.length - 8} more</li>}
            </ul>
          )}
        </div>
        <button className="shrink-0 opacity-70 hover:opacity-100" onClick={onDismiss}>
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TreeNode({
  node, depth, byParent, counts, collapsed, setCollapsed,
  selectedId, onSelect, onAddChild, onDelete, onMove,
}: {
  node: BucketNode;
  depth: number;
  byParent: Map<string, BucketNode[]>;
  counts: Map<string, { proposed: number; confirmed: number }>;
  collapsed: Set<string>;
  setCollapsed: (fn: (prev: Set<string>) => Set<string>) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddChild: (parent: BucketNode) => Promise<void> | void;
  onDelete: (node: BucketNode) => Promise<void> | void;
  onMove: (node: BucketNode, dir: -1 | 1) => Promise<void> | void;
}) {
  const children = byParent.get(node.id) ?? [];
  const isCollapsed = collapsed.has(node.id);
  const count = counts.get(node.id);
  const isSelected = selectedId === node.id;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-lg px-1.5 py-1 cursor-pointer ${isSelected ? 'bg-[#d4a054]/15' : 'hover:bg-white/5'}`}
        style={{ paddingLeft: `${depth * 18 + 6}px` }}
        onClick={() => onSelect(node.id)}
      >
        <button
          className={`w-4 h-4 shrink-0 text-zinc-500 ${children.length ? '' : 'invisible'}`}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
              return next;
            });
          }}
        >
          {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        <span className={`text-[10px] uppercase tracking-wider ${KIND_TINT[node.kind]} shrink-0 w-14`}>
          {KIND_LABEL[node.kind]}
        </span>
        <span className="text-sm text-zinc-200 truncate">{node.label}</span>
        {count && (count.proposed > 0 || count.confirmed > 0) && (
          <span className="ml-1 shrink-0 text-[11px] text-zinc-500">
            {count.confirmed > 0 && <span className="text-emerald-400">{count.confirmed}✓</span>}
            {count.confirmed > 0 && count.proposed > 0 && ' '}
            {count.proposed > 0 && <span className="text-[#d4a054]">{count.proposed}?</span>}
          </span>
        )}
        <span className="ml-auto hidden group-hover:flex items-center gap-0.5 shrink-0">
          <button title="Move up" className="p-0.5 text-zinc-500 hover:text-zinc-200" onClick={(e) => { e.stopPropagation(); void onMove(node, -1); }}><ArrowUp className="w-3.5 h-3.5" /></button>
          <button title="Move down" className="p-0.5 text-zinc-500 hover:text-zinc-200" onClick={(e) => { e.stopPropagation(); void onMove(node, 1); }}><ArrowDown className="w-3.5 h-3.5" /></button>
          {node.kind !== 'subissue' && (
            <button title={`Add ${KIND_LABEL[CHILD_KIND[node.kind]].toLowerCase()}`} className="p-0.5 text-zinc-500 hover:text-zinc-200" onClick={(e) => { e.stopPropagation(); void onAddChild(node); }}><Plus className="w-3.5 h-3.5" /></button>
          )}
          <button title="Delete" className="p-0.5 text-zinc-500 hover:text-red-300" onClick={(e) => { e.stopPropagation(); void onDelete(node); }}><Trash2 className="w-3.5 h-3.5" /></button>
        </span>
      </div>
      {!isCollapsed && children.map((c) => (
        <TreeNode
          key={c.id}
          node={c}
          depth={depth + 1}
          byParent={byParent}
          counts={counts}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          selectedId={selectedId}
          onSelect={onSelect}
          onAddChild={onAddChild}
          onDelete={onDelete}
          onMove={onMove}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function NodeDetail({
  node, docs, docsNotice, busy, onSave, onDecide, onManualAdd,
}: {
  node: BucketNode;
  docs: ClassifiedDoc[] | null;
  /** Set only when the bucket holds more documents than are listed. */
  docsNotice: string | null;
  busy: boolean;
  onSave: (nodeId: string, patch: { label?: string; description?: string }) => Promise<void>;
  onDecide: (c: ClassifiedDoc, decision: 'confirmed' | 'rejected') => Promise<void>;
  onManualAdd: () => void;
}) {
  const [label, setLabel] = useState(node.label);
  const [description, setDescription] = useState(node.description ?? '');
  const dirty = label.trim() !== node.label || description.trim() !== (node.description ?? '');

  const visible = (docs ?? []).filter((d) => d.classification.status !== 'rejected');
  const rejected = (docs ?? []).filter((d) => d.classification.status === 'rejected');

  return (
    <div className="flex flex-col gap-3">
      <div>
        <span className={`text-[10px] uppercase tracking-wider ${KIND_TINT[node.kind]}`}>{KIND_LABEL[node.kind]}</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="mt-1 w-full rounded-lg border border-white/10 bg-transparent px-3 py-1.5 text-sm text-zinc-100 focus:border-[#d4a054]/50 focus:outline-none"
        />
      </div>
      <div>
        <label className="text-xs text-zinc-500">
          What belongs in this bucket (the classifier reads this — your words steer it)
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg border border-white/10 bg-transparent px-3 py-2 text-sm text-zinc-300 focus:border-[#d4a054]/50 focus:outline-none resize-y"
        />
      </div>
      {dirty && (
        <button
          disabled={busy || !label.trim()}
          onClick={() => void onSave(node.id, { label: label.trim(), description: description.trim() })}
          className="self-start inline-flex items-center gap-1.5 rounded-lg border border-[#d4a054]/40 bg-[#d4a054]/10 px-3 py-1.5 text-sm text-[#d4a054] hover:bg-[#d4a054]/20 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save
        </button>
      )}

      <div className="flex items-center justify-between border-t border-white/10 pt-3">
        <h4 className="text-sm font-medium text-zinc-300">
          Documents {docs === null ? '' : `(${visible.length})`}
        </h4>
        <button
          onClick={onManualAdd}
          className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
        >
          <Plus className="w-3.5 h-3.5" /> Add by hand
        </button>
      </div>

      {docsNotice && (
        <p className="rounded-lg border border-[#d4a054]/40 bg-[#d4a054]/10 px-3 py-2 text-xs text-[#d4a054]">
          {docsNotice}
        </p>
      )}

      {docs === null && (
        <div className="flex items-center gap-2 py-4 text-sm text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      )}
      {docs !== null && visible.length === 0 && (
        <p className="text-sm text-zinc-600 py-2">Nothing in this bucket yet.</p>
      )}
      {visible.map((d) => (
        <div key={d.classification.id} className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
          <div className="flex items-start gap-2">
            <FileText className="w-4 h-4 mt-0.5 shrink-0 text-zinc-500" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {/* The whole point of the chain: bucket → document → open and
                    review. New tab so the review queue stays put. */}
                <a
                  href={`/app/document/${d.classification.document_id}`}
                  target="_blank"
                  rel="noopener"
                  className="text-sm text-zinc-200 truncate hover:text-[#d4a054] hover:underline underline-offset-2"
                  title="Open document in a new tab"
                >
                  {d.documentTitle}
                </a>
                {d.classification.status === 'confirmed' ? (
                  <span className="shrink-0 text-[11px] text-emerald-400">confirmed</span>
                ) : (
                  <span className="shrink-0 text-[11px] text-[#d4a054]">
                    proposed{d.classification.confidence != null ? ` · ${Math.round(d.classification.confidence * 100)}%` : ''}
                  </span>
                )}
              </div>
              {d.classification.rationale && (
                <p className="mt-0.5 text-xs text-zinc-500">{d.classification.rationale}</p>
              )}
            </div>
            {d.classification.status === 'proposed' && (
              <div className="flex shrink-0 gap-1">
                <button
                  title="Confirm"
                  onClick={() => void onDecide(d, 'confirmed')}
                  className="rounded-md border border-emerald-500/40 p-1 text-emerald-300 hover:bg-emerald-500/15"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  title="Reject"
                  onClick={() => void onDecide(d, 'rejected')}
                  className="rounded-md border border-red-500/30 p-1 text-red-300 hover:bg-red-500/15"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
      {rejected.length > 0 && (
        <p className="text-xs text-zinc-600">{rejected.length} rejected proposal{rejected.length === 1 ? '' : 's'} hidden.</p>
      )}
    </div>
  );
}

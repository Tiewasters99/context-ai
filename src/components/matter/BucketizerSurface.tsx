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
  type BucketNode, type NodeKind, type ClassifiedDoc, type ClassifyProgress,
} from '@/lib/bucketizer';

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

  const [nodeDocs, setNodeDocs] = useState<ClassifiedDoc[] | null>(null);
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

  // Load the selected node's documents.
  useEffect(() => {
    if (!selectedId) { setNodeDocs(null); return; }
    let cancelled = false;
    setNodeDocs(null);
    void fetchClassificationsForNode(selectedId)
      .then((d) => { if (!cancelled) setNodeDocs(d); })
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

  const handleClassifyAll = useCallback(async () => {
    if (!nodes?.length) return;
    const docs = await listUnclassifiedDocs(matterId);
    if (!docs.length) { setUnclassifiedCount(0); return; }
    const controller = new AbortController();
    classifyAbort.current = controller;
    setClassifying({ done: 0, total: docs.length, currentTitle: '', proposed: 0, errors: 0 });
    try {
      await classifyDocuments({
        matterId, docs, nodes,
        signal: controller.signal,
        onProgress: setClassifying,
      });
    } finally {
      setClassifying(null);
      classifyAbort.current = null;
      setCounts(await fetchNodeCounts(matterId));
      void listUnclassifiedDocs(matterId).then((d) => setUnclassifiedCount(d.length)).catch(() => {});
      if (selectedId) void fetchClassificationsForNode(selectedId).then(setNodeDocs).catch(() => {});
    }
  }, [matterId, nodes, selectedId]);

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
      setNodeDocs(await fetchClassificationsForNode(selectedId));
      setCounts(await fetchNodeCounts(matterId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the document.');
    }
  }, [matterId, selectedId]);

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
            onClick={() => void handleClassifyAll()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-500/20"
          >
            <Play className="w-4 h-4" />
            Classify new documents{unclassifiedCount != null ? ` (${unclassifiedCount})` : ''}
          </button>
        )}
        {classifying && (
          <div className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-300">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-300" />
            {classifying.done}/{classifying.total} · {classifying.proposed} proposals
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
                busy={busy}
                onSave={saveNodePatch}
                onDecide={handleDecide}
                onManualAdd={() => setShowManualAdd(true)}
              />
            )}
          </div>
        </div>
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
  node, docs, busy, onSave, onDecide, onManualAdd,
}: {
  node: BucketNode;
  docs: ClassifiedDoc[] | null;
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
                <span className="text-sm text-zinc-200 truncate">{d.documentTitle}</span>
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

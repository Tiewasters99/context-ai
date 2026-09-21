import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown, ChevronRight, Check, X, Plus, Trash2, Loader2,
  Sparkles, FolderTree, ArrowUp, ArrowDown, FileText, Play, Square,
  Quote, Scale, FolderOpen, Info, ArrowLeft,
} from 'lucide-react';
import DocumentPicker from '@/components/matter/DocumentPicker';
import CorpusDocumentPicker, { type PickerDocument } from '@/components/matter/CorpusDocumentPicker';
import BucketizerEvidence from '@/components/matter/BucketizerEvidence';
import BucketizerEvidenceRunDialog from '@/components/matter/BucketizerEvidenceRunDialog';
import BucketizerOutlineDialog from '@/components/matter/BucketizerOutlineDialog';
import {
  countUnconfirmedEvidence, estimateEvidencePass, listEvidencePairs,
  retryFailedPairs, runEvidenceForMatter,
  type EvidenceEstimate, type EvidenceProgress, type PairInventory,
} from '@/lib/bucketizer/evidence';
import {
  fetchTree, createNode, updateNode, deleteNode,
  generateTreeFromPleadings, classifyDocuments,
  decideClassification, addManualClassification,
  fetchClassificationsForNode, fetchNodeCounts,
  estimateClassifyRun, formatCents, emptyProgress,
  choosableIn, classifyAction, docRowsForRun, freshCandidateRows, groupChosen,
  loadChooserInventory, reclassifyNotices, summarizeChosen, NOTHING_NEW_MESSAGE,
  type BucketNode, type NodeKind, type ClassifiedDoc, type ClassifyProgress,
  type DocRow, type RunEstimate, type ChooserRow,
} from '@/lib/bucketizer';
import { BUCKETIZER_DEFAULT_MODEL } from '@/lib/bucketizer';
import {
  SERVER_RUN_MIN_DOCUMENTS, ServerRunError, cancelServerRun, describeServerRun,
  fetchServerRun, resumeServerRun, shouldRunOnServer, startServerRun,
  type ServerRunState,
} from '@/lib/bucketizer/server-run';
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
  const navigate = useNavigate();
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

  // A bulk run is quoted before it is started, never after. `notices` are the
  // sentences a re-run owes the person: what is read again, what is charged
  // again, and what their own decisions are protected from.
  const [pending, setPending] = useState<{
    docs: DocRow[];
    estimate: RunEstimate;
    notices: string[];
    /** The chosen documents BY NAME, grouped by the matter they live in. */
    groups: { matterName: string; titles: string[] }[];
  } | null>(null);

  // Choosing documents by hand — the answer to "it does not open up documents".
  const [chooserRows, setChooserRows] = useState<ChooserRow[] | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [openingChooser, setOpeningChooser] = useState(false);
  // The "nothing new to classify" line is shown until it is dismissed: it is
  // the answer to a count of zero, and a count of zero used to be silence.
  const [nothingNewDismissed, setNothingNewDismissed] = useState(false);
  // What the last run has to say for itself: a meter pause, windows that
  // could not be used, documents left for next time.
  const [runReport, setRunReport] = useState<ClassifyProgress | null>(null);

  // A run that does not need this tab. Read from the `bucketizer_runs` row
  // (migration 079), so it survives a reload, a different browser and a
  // different machine — which is the entire point of the server lane.
  const [serverRun, setServerRun] = useState<ServerRunState | null>(null);
  const [serverBusy, setServerBusy] = useState(false);

  const [nodeDocs, setNodeDocs] = useState<ClassifiedDoc[] | null>(null);
  const [nodeDocsNotice, setNodeDocsNotice] = useState<string | null>(null);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [busy, setBusy] = useState(false);

  // ---- the evidence lane --------------------------------------------------
  // From a confirmed classification to the passages that support it, and from
  // those to the filed outline. Quoted before it runs, resumable, and every
  // quotation checked against the stored passage before it is written.
  const [pendingEvidence, setPendingEvidence] =
    useState<{ inventory: PairInventory; estimate: EvidenceEstimate } | null>(null);
  const [preparingEvidence, setPreparingEvidence] = useState(false);
  const [evidenceRun, setEvidenceRun] = useState<EvidenceProgress | null>(null);
  const [evidenceReport, setEvidenceReport] = useState<EvidenceProgress | null>(null);
  const [pairsTodo, setPairsTodo] = useState<number | null>(null);
  const [unconfirmedEvidence, setUnconfirmedEvidence] = useState(0);
  const [showOutline, setShowOutline] = useState(false);
  const [evidenceBump, setEvidenceBump] = useState(0);
  const evidenceAbort = useRef<AbortController | null>(null);

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

  /**
   * Read the server run's row. Quiet on failure: until migration 079 is
   * applied, or on a deployment without the endpoint, there simply is no
   * server run, and the browser path is exactly what it was.
   */
  const refreshServerRun = useCallback(async () => {
    try {
      setServerRun(await fetchServerRun(matterId));
    } catch {
      setServerRun(null);
    }
  }, [matterId]);

  // The progress line, after a reload and on another machine. A run that is
  // still going is polled; a finished one is read once and left on screen
  // until it is dismissed, because the closing report is the point.
  useEffect(() => {
    let alive = true;
    const tick = async () => { if (alive) await refreshServerRun(); };
    void tick();
    const going = serverRun?.run
      && ['queued', 'running'].includes(serverRun.run.status);
    if (!going) return () => { alive = false; };
    const timer = setInterval(() => { void tick(); }, 5_000);
    return () => { alive = false; clearInterval(timer); };
  }, [refreshServerRun, serverRun?.run?.status]);

  /**
   * How much evidence work is outstanding.
   *
   * Both reads fail plainly until migration 068 is applied, which is a setup
   * state rather than a broken tab: the counters simply go quiet and the tree,
   * the classifier and the review queue carry on working.
   */
  const refreshEvidenceCounts = useCallback(async () => {
    try {
      const [inventory, unconfirmed] = await Promise.all([
        listEvidencePairs(matterId),
        countUnconfirmedEvidence(matterId),
      ]);
      setPairsTodo(inventory.todo.length);
      setUnconfirmedEvidence(unconfirmed);
    } catch {
      setPairsTodo(null);
    }
  }, [matterId]);

  /**
   * Every document in this matter tree, with what has happened to it — read
   * once and used twice: the count beside step 2, and the list the chooser
   * shows. One read, one predicate, so the number and the rows agree.
   */
  const refreshInventory = useCallback(async (): Promise<boolean> => {
    try {
      const inventory = await loadChooserInventory(matterId);
      setChooserRows(inventory.rows);
      setUnclassifiedCount(freshCandidateRows(inventory.rows).length);
      return true;
    } catch {
      // The count goes quiet rather than claiming a number it does not have.
      setChooserRows(null);
      setUnclassifiedCount(null);
      return false;
    }
  }, [matterId]);

  useEffect(() => {
    setNodes(null);
    setSelectedId(null);
    setNodeDocs(null);
    setEvidenceReport(null);
    setNothingNewDismissed(false);
    void reload();
    void refreshInventory();
    void refreshEvidenceCounts();
  }, [matterId, reload, refreshInventory, refreshEvidenceCounts]);

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
      // The pleadings are now marked as the tree's sources, so the count of
      // "not yet classified" drops by however many they were.
      await refreshInventory();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tree generation failed.');
    } finally {
      setGenerating(false);
    }
  }, [matterId, reload, refreshInventory]);

  // ---- classification -----------------------------------------------------

  /**
   * Step 2 opens the list. Always.
   *
   * It used to count the unclassified documents and start a run on whatever
   * the count turned out to be — and the confirmation said "Classify 1
   * document?" without naming it. Eden uploaded a document, was asked to run
   * one, said run, and the classifier read the COMPLAINT: his upload was
   * still processing, and the complaint the tree was built from was the only
   * ready document with no rows. Nothing about that click was visible until
   * it had happened.
   *
   * Strict matter isolation: the picker is confined to this matter's tree,
   * and `docRowsForRun` drops anything outside it before a run is quoted.
   */
  const openChooser = useCallback(async (refresh = true) => {
    setError(null);
    setRunReport(null);
    setOpeningChooser(true);
    try {
      if (refresh || !chooserRows) {
        const ok = await refreshInventory();
        if (!ok) {
          setError('Could not list this matter\'s documents. Reload and try again.');
          return;
        }
      }
      setChooserOpen(true);
      // Browser Back closes the chooser instead of ejecting him from the
      // module. The router's own state object is preserved, so react-router
      // still recognises the entry it is on.
      try {
        window.history.pushState(
          { ...(window.history.state ?? {}), bucketizerChooser: true }, '',
        );
      } catch { /* history is unavailable: the Back button in the ribbon still closes it */ }
    } finally {
      setOpeningChooser(false);
    }
  }, [chooserRows, refreshInventory]);

  const closeChooser = useCallback(() => {
    setChooserOpen(false);
    if (typeof window !== 'undefined' && window.history.state?.bucketizerChooser) {
      window.history.back();
    }
  }, []);

  // Browser Back while the chooser is open closes the chooser.
  useEffect(() => {
    if (!chooserOpen) return;
    const onPop = () => setChooserOpen(false);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [chooserOpen]);

  /** The person chose documents. Same estimate dialog, same run. */
  const handleChosen = useCallback((picked: { id: string }[]) => {
    closeChooser();
    const rows = chooserRows ?? [];
    const ids = picked.map((p) => p.id);
    const docs = docRowsForRun(rows, ids);
    if (!nodes?.length || !docs.length) return;
    setPending({
      docs,
      estimate: estimateClassifyRun(docs, nodes),
      notices: reclassifyNotices(summarizeChosen(rows, ids)),
      groups: groupChosen(rows, ids),
    });
  }, [chooserRows, nodes, closeChooser]);

  /** One document, as the picker renders it: the title, and what it is. */
  const toPickerDoc = useCallback((r: ChooserRow, withMatter = false): PickerDocument => {
    const where = withMatter && r.matterName ? `${r.matterName} · ` : '';
    return {
      id: r.id,
      title: r.title,
      hint: r.blockedReason
        ? `${where}${r.status} — ${r.blockedReason}`
        : r.caution ? `${where}${r.status} · ${r.caution}` : `${where}${r.status}`,
      disabled: Boolean(r.blockedReason),
    };
  }, []);

  const chooserDocsFor = useCallback((id: string): Promise<PickerDocument[]> => (
    Promise.resolve((chooserRows ?? []).filter((r) => r.matterId === id).map((r) => toPickerDoc(r)))
  ), [chooserRows, toPickerDoc]);

  /** Search the whole matter tree — title AND uploaded filename. */
  const chooserSearch = useCallback((query: string): PickerDocument[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (chooserRows ?? [])
      .filter((r) => r.title.toLowerCase().includes(q)
        || (r.filename ?? '').toLowerCase().includes(q))
      .slice(0, 300)
      .map((r) => toPickerDoc(r, true));
  }, [chooserRows, toPickerDoc]);

  /** A folder and everything under it, resolved to its choosable documents. */
  const chooserFolder = useCallback((matterIds: string[]) => (
    choosableIn(chooserRows ?? [], matterIds).map((r) => ({ id: r.id, title: r.title }))
  ), [chooserRows]);

  /**
   * Step two: the person clicked through the estimate.
   *
   * A run of any size goes to the SERVER by default, and the tab is then free:
   * close it, open another machine tomorrow, the progress line reads the same
   * row. Below the threshold the browser path stays, because for four
   * documents it is immediate, it shows every window as it lands, and it costs
   * the shared queue nothing.
   *
   * If the server is not switched on for background runs yet — which is the
   * state between merging this and deploying the worker — it says so and the
   * run happens here instead. A refusal to start on the server has never been
   * a refusal to classify.
   */
  const handleClassifyAll = useCallback(async () => {
    const run = pending;
    if (!run || !nodes?.length) return;
    setPending(null);

    if (shouldRunOnServer(run.docs.length, SERVER_RUN_MIN_DOCUMENTS)) {
      setServerBusy(true);
      try {
        await startServerRun({
          matterId,
          documentIds: run.docs.map((d) => d.id),
          modelId: BUCKETIZER_DEFAULT_MODEL,
          estimateCents: run.estimate.cents,
        });
        await refreshServerRun();
        return;
      } catch (e) {
        if (!(e instanceof ServerRunError) || !e.shouldFallBackToBrowser) {
          setError(e instanceof Error ? e.message : 'The run could not be started.');
          return;
        }
        // Fall through to the browser loop, and say why it needs the window.
        setError(e.message);
      } finally {
        setServerBusy(false);
      }
    }

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
      void refreshInventory();
      if (selectedId) void loadNodeDocs(selectedId).catch(() => {});
    }
  }, [matterId, nodes, pending, selectedId, loadNodeDocs, refreshInventory, refreshServerRun]);

  /** Stop a server run, or put a paused one back to work. Always explicit. */
  const handleServerRunAction = useCallback(async (what: 'cancel' | 'resume') => {
    const id = serverRun?.run?.id;
    if (!id) return;
    setServerBusy(true);
    try {
      if (what === 'cancel') await cancelServerRun(matterId, id);
      else await resumeServerRun(matterId, id);
      await refreshServerRun();
      setCounts(await fetchNodeCounts(matterId));
      void refreshInventory();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That could not be done.');
    } finally {
      setServerBusy(false);
    }
  }, [matterId, serverRun?.run?.id, refreshServerRun, refreshInventory]);

  // ---- evidence -----------------------------------------------------------

  /** Step one: count the pairings and price them. Nothing is spent here. */
  const handlePrepareEvidence = useCallback(async (retryFailed = false) => {
    setPreparingEvidence(true);
    setError(null);
    setEvidenceReport(null);
    try {
      if (retryFailed) await retryFailedPairs(matterId);
      const inventory = await listEvidencePairs(matterId);
      setPairsTodo(inventory.todo.length);
      setPendingEvidence({ inventory, estimate: estimateEvidencePass(inventory) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not work out what is left to read.');
    } finally {
      setPreparingEvidence(false);
    }
  }, [matterId]);

  /** Step two: the person clicked through the estimate. */
  const handleRunEvidence = useCallback(async () => {
    const run = pendingEvidence;
    if (!run || !nodes?.length) return;
    setPendingEvidence(null);
    const controller = new AbortController();
    evidenceAbort.current = controller;
    setEvidenceRun({
      done: 0, total: run.inventory.todo.length, current: '', items: 0, empty: 0,
      failed: 0, dropped: 0, called: 0, pausedMessage: null, retryAfterSeconds: null, notes: [],
    });
    try {
      const final = await runEvidenceForMatter({
        matterId,
        pairs: run.inventory.todo,
        nodes,
        signal: controller.signal,
        onProgress: setEvidenceRun,
      });
      // A pause, a dropped quotation or a pairing that could not be read is
      // something the attorney has to know about, so it stays on screen.
      if (final.pausedMessage || final.notes.length || final.failed) setEvidenceReport(final);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The evidence pass failed.');
    } finally {
      setEvidenceRun(null);
      evidenceAbort.current = null;
      await refreshEvidenceCounts();
      setEvidenceBump((n) => n + 1);
    }
  }, [matterId, nodes, pendingEvidence, refreshEvidenceCounts]);

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
  const action = classifyAction(unclassifiedCount);

  return (
    <div className="flex flex-col gap-3 min-h-0">
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span>{error}</span>
          <button className="text-red-300/70 hover:text-red-200" onClick={() => setError(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Where you are, and the way back. The Bucketizer is a Productivity
          Suite tool a matter calls into, and until now there was no way out of
          it but the browser's own Back. */}
      <div className="flex items-center gap-2 text-sm">
        <button
          onClick={() => navigate(`/app/matterspace/${encodeURIComponent(matterId)}`)}
          className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
          title="Back to the matter"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to the matter
        </button>
        <span className="text-xs text-zinc-600">·</span>
        <button
          onClick={() => navigate('/app/bucketizer')}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          All matters
        </button>
      </div>

      {/* Two steps, named and in order. Step 1 builds the tree from the
          pleadings; step 2 chooses what to file into it. They were two buttons
          of equal weight in one row, and which one came first was not said. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-zinc-600 mr-0.5">1 · Tree</span>
        <button
          onClick={() => setShowPleadingPicker(true)}
          disabled={generating || !!classifying}
          title="Read the pleadings and draft the claims, elements, subissues and themes"
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#d4a054]/40 bg-[#d4a054]/10 px-3 py-1.5 text-sm text-[#d4a054] hover:bg-[#d4a054]/20 disabled:opacity-50"
        >
          {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {roots.length ? 'Regenerate from pleadings' : 'Build the tree from the pleadings'}
        </button>
        <button
          onClick={() => void handleAddNode(null)}
          disabled={generating}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" /> Add bucket
        </button>
        {roots.length > 0 && !classifying && (
          <>
            <span className="ml-2 text-[11px] uppercase tracking-wider text-zinc-600">2 · Documents</span>
            {/* The button opens the list. It never starts a run on a count. */}
            <button
              onClick={() => void openChooser()}
              disabled={openingChooser}
              title="Search this matter, highlight documents or a whole folder, then classify them"
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              {openingChooser ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
              {action.label}
              {action.badge && (
                <span className="text-[11px] text-emerald-300/70">({action.badge})</span>
              )}
            </button>
          </>
        )}
        {roots.length > 0 && !classifying && !evidenceRun && (
          <button
            onClick={() => void handlePrepareEvidence()}
            disabled={preparingEvidence || pairsTodo === null}
            title={pairsTodo === null
              ? 'Needs migration 068_bucketizer_evidence.sql'
              : 'Read the confirmed documents for the passages that support each issue'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-sm text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
          >
            {preparingEvidence ? <Loader2 className="w-4 h-4 animate-spin" /> : <Quote className="w-4 h-4" />}
            Find evidence{pairsTodo != null ? ` (${pairsTodo})` : ''}
          </button>
        )}
        {roots.length > 0 && !classifying && !evidenceRun && (
          <button
            onClick={() => setShowOutline(true)}
            title="Build the trial outline and file it into the matter"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#d4a054]/40 bg-[#d4a054]/10 px-3 py-1.5 text-sm text-[#d4a054] hover:bg-[#d4a054]/20"
          >
            <Scale className="w-4 h-4" /> Outline
          </button>
        )}
        {evidenceRun && (
          <div className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-300">
            <Loader2 className="w-4 h-4 animate-spin text-sky-300" />
            {evidenceRun.done}/{evidenceRun.total} · {evidenceRun.items} quotations
            {evidenceRun.dropped > 0 && (
              <span className="text-orange-300" title="Quotations that were not in the stored passage word for word">
                · {evidenceRun.dropped} dropped
              </span>
            )}
            {evidenceRun.failed > 0 && <span className="text-orange-300">· {evidenceRun.failed} failed</span>}
            <span className="max-w-[240px] truncate text-zinc-500">{evidenceRun.current}</span>
            <button
              onClick={() => evidenceAbort.current?.abort()}
              className="ml-1 text-zinc-400 hover:text-zinc-200" title="Stop"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          </div>
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

      {roots.length > 0 && unclassifiedCount === 0 && !classifying && !nothingNewDismissed && (
        <NothingNewNotice
          onOpenVault={() => navigate(`/app/vault?matter=${encodeURIComponent(matterId)}`)}
          onChoose={() => void openChooser()}
          onDismiss={() => setNothingNewDismissed(true)}
        />
      )}

      {serverRun?.run && (
        <ServerRunPanel
          state={serverRun}
          busy={serverBusy}
          onCancel={() => void handleServerRunAction('cancel')}
          onResume={() => void handleServerRunAction('resume')}
          onDismiss={() => setServerRun(null)}
        />
      )}

      {runReport && <RunReport report={runReport} onDismiss={() => setRunReport(null)} />}
      {evidenceReport && (
        <EvidenceReport report={evidenceReport} onDismiss={() => setEvidenceReport(null)} />
      )}

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
              <>
                {/* Back, inside the surface: on a narrow screen the detail
                    pane is what you are looking at, and there was no way out
                    of it but the browser's Back. */}
                <button
                  onClick={() => setSelectedId(null)}
                  className="mb-2 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                >
                  <ArrowLeft className="w-3.5 h-3.5" /> All buckets
                </button>
                <NodeDetail
                  key={selected.id}
                  node={selected}
                  docs={nodeDocs}
                  docsNotice={nodeDocsNotice}
                  busy={busy}
                  evidenceBump={evidenceBump}
                  onEvidenceChanged={() => void refreshEvidenceCounts()}
                  onSave={saveNodePatch}
                  onDecide={handleDecide}
                  onManualAdd={() => setShowManualAdd(true)}
                />
              </>
            )}
          </div>
        </div>
      )}

      {chooserOpen && (
        <CorpusDocumentPicker
          title="Choose documents to classify"
          rootMatterId={matterId}
          confineToRoot
          multi
          confirmLabel="Continue"
          loadDocuments={chooserDocsFor}
          searchAll={chooserSearch}
          onSelectFolder={chooserFolder}
          toolbar={(api) => (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/50">
              {unclassifiedCount != null && unclassifiedCount > 0 ? (
                <button
                  onClick={() => api.select(
                    freshCandidateRows(chooserRows ?? []).map((r) => ({ id: r.id, title: r.title })),
                  )}
                  className="rounded-md border border-white/10 px-2 py-1 text-white/70 hover:text-white hover:bg-white/5"
                >
                  Select everything not yet classified ({unclassifiedCount})
                </button>
              ) : (
                <span className="leading-snug">{NOTHING_NEW_MESSAGE}</span>
              )}
              {api.selectedCount > 0 && (
                <button onClick={api.clear} className="text-white/45 hover:text-white/80">
                  Clear
                </button>
              )}
              <button
                onClick={() => navigate(`/app/vault?matter=${encodeURIComponent(matterId)}`)}
                className="ml-auto text-white/45 hover:text-white/80"
              >
                Open this matter&rsquo;s Vault
              </button>
            </div>
          )}
          onCancel={closeChooser}
          onConfirmMany={handleChosen}
        />
      )}

      {pending && (
        <RunEstimateDialog
          estimate={pending.estimate}
          notices={pending.notices}
          groups={pending.groups}
          onCancel={() => setPending(null)}
          onConfirm={() => void handleClassifyAll()}
        />
      )}

      {pendingEvidence && (
        <BucketizerEvidenceRunDialog
          estimate={pendingEvidence.estimate}
          failed={pendingEvidence.inventory.failed}
          onCancel={() => setPendingEvidence(null)}
          onConfirm={() => void handleRunEvidence()}
          onRetryFailed={() => { setPendingEvidence(null); void handlePrepareEvidence(true); }}
        />
      )}

      {showOutline && (
        <BucketizerOutlineDialog
          matterId={matterId}
          unconfirmedEvidence={unconfirmedEvidence}
          onClose={() => setShowOutline(false)}
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
  estimate, notices, groups, onCancel, onConfirm,
}: {
  estimate: RunEstimate;
  /** What a re-run owes the person before it starts. Empty on a first pass. */
  notices: string[];
  /** The documents about to be read, BY NAME, grouped by their matter. */
  groups: { matterName: string; titles: string[] }[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Escape cancels. Nothing is spent here, so leaving must be effortless.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-white/10 bg-zinc-950 p-5 shadow-2xl">
        <h3 className="text-base font-medium text-zinc-100">
          Classify {estimate.documents.toLocaleString()} document{estimate.documents === 1 ? '' : 's'}?
        </h3>

        {/* THE NAMES. A dialog that said "Classify 1 document?" and then read
            the complaint is what this list exists to prevent. */}
        {groups.length > 0 && (
          <div className="mt-3 max-h-52 overflow-y-auto rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
            {groups.map((g) => (
              <div key={g.matterName} className="mb-2 last:mb-0">
                <p className="text-[11px] uppercase tracking-wider text-zinc-500">{g.matterName}</p>
                <ul className="mt-0.5 space-y-0.5">
                  {/* Keyed by position: three exhibits called "Exhibit A" is
                      the normal case in a matter, not an edge case. */}
                  {g.titles.map((t, i) => (
                    <li key={`${g.matterName}:${i}`} className="flex items-start gap-1.5 text-xs text-zinc-300">
                      <FileText className="mt-0.5 w-3 h-3 shrink-0 text-zinc-600" />
                      <span className="min-w-0 break-words">{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

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
        {notices.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-lg border border-[#d4a054]/30 bg-[#d4a054]/[0.07] px-3 py-2 text-xs leading-relaxed text-[#d4a054]">
            {notices.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}

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
 * The answer to a click that used to do nothing.
 *
 * "Classify new documents" listed the matter's unclassified documents and, on
 * an empty list, returned — no dialog, no message, no change on screen. Eden
 * read the button as "choose a document", pressed it, and nothing opened. So
 * the empty case is now a sentence and two controls: where documents come
 * from (this matter's Vault), and how to read one again (the chooser).
 */
function NothingNewNotice({
  onOpenVault, onChoose, onDismiss,
}: {
  onOpenVault: () => void;
  onChoose: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-zinc-300">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-start gap-2 leading-relaxed">
            <Info className="mt-0.5 w-4 h-4 shrink-0 text-zinc-500" />
            <span>{NOTHING_NEW_MESSAGE}</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-2 pl-6">
            <button
              onClick={onOpenVault}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/5"
            >
              <FolderTree className="w-3.5 h-3.5" /> Open this matter&rsquo;s Vault
            </button>
            <button
              onClick={onChoose}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20"
            >
              <FolderOpen className="w-3.5 h-3.5" /> Choose documents…
            </button>
          </div>
        </div>
        <button className="shrink-0 text-zinc-500 hover:text-zinc-300" onClick={onDismiss}>
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * A run that is not in this window.
 *
 * Everything shown here is read from the `bucketizer_runs` row, never from
 * this tab's own counters — which is what makes the line survive a reload, a
 * different browser and a different machine. The sentence a stopped run shows
 * is the SERVER's own: the meter's, the gate's, or the seal's.
 */
function ServerRunPanel({ state, busy, onCancel, onResume, onDismiss }: {
  state: ServerRunState;
  busy: boolean;
  onCancel: () => void;
  onResume: () => void;
  onDismiss: () => void;
}) {
  const run = state.run;
  if (!run) return null;
  const going = run.status === 'queued' || run.status === 'running';
  const stopped = run.status === 'paused' || run.status === 'held';
  const finished = run.status === 'done' || run.status === 'cancelled' || run.status === 'failed';
  const trouble = state.documents.filter((d) => d.status !== 'done' && d.note);

  const tint = stopped
    ? 'border-[#d4a054]/40 bg-[#d4a054]/10 text-[#d4a054]'
    : run.status === 'failed'
      ? 'border-orange-500/30 bg-orange-500/10 text-orange-200'
      : 'border-white/10 bg-white/[0.03] text-zinc-300';

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-sm ${tint}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-medium">
            {going
              ? <Loader2 className="w-4 h-4 animate-spin text-emerald-300" />
              : <Info className="w-4 h-4 shrink-0" />}
            {going ? 'Classifying on the server' : `Run ${run.status}`}
            <span className="text-zinc-500">
              {run.documents_done + run.documents_skipped + run.documents_failed}/{run.documents_total}
            </span>
          </p>
          {going && (
            <p className="mt-1 pl-6 text-xs text-zinc-500">
              This will keep running if you close this window.
            </p>
          )}
          {state.stalled && going && (
            <p className="mt-1 pl-6 text-xs text-[#d4a054]">
              Nothing is queued for this run at the moment — press Resume to put the rest back in the queue.
            </p>
          )}
          <ul className="mt-1.5 space-y-0.5 pl-6 text-xs leading-relaxed">
            {describeServerRun(state).map((line, i) => <li key={i}>{line}</li>)}
          </ul>
          {finished && trouble.length > 0 && (
            <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-auto pl-6 text-xs text-zinc-400">
              {trouble.slice(0, 50).map((d) => <li key={d.document_id}>{d.note}</li>)}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-2 pl-6">
            {(going || stalledOrStopped(state)) && (
              <button
                onClick={onCancel}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/5 disabled:opacity-50"
              >
                <Square className="w-3.5 h-3.5" /> Cancel
              </button>
            )}
            {stalledOrStopped(state) && (
              <button
                onClick={onResume}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" /> Resume
              </button>
            )}
          </div>
        </div>
        {finished && (
          <button className="shrink-0 text-zinc-500 hover:text-zinc-300" onClick={onDismiss}>
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Paused, held, or going-but-with-nothing-queued: all three offer Resume. */
function stalledOrStopped(state: ServerRunState): boolean {
  const s = state.run?.status;
  return s === 'paused' || s === 'held' || (state.stalled && (s === 'queued' || s === 'running'));
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

/**
 * What the evidence pass has to say for itself.
 *
 * The number that matters most here is DROPPED — quotations the model gave
 * that are not in the stored passage word for word. They were discarded rather
 * than corrected, and an attorney reading a thin bucket deserves to know that
 * is why it is thin.
 */
function EvidenceReport({
  report, onDismiss,
}: { report: EvidenceProgress; onDismiss: () => void }) {
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
              <p className="font-medium">Paused — {report.done} of {report.total} pairings read.</p>
              <p className="mt-0.5 text-xs opacity-90">{report.pausedMessage}</p>
              {report.retryAfterSeconds != null && (
                <p className="mt-0.5 text-xs opacity-75">
                  Try again in about {Math.ceil(report.retryAfterSeconds / 60)} minute
                  {Math.ceil(report.retryAfterSeconds / 60) === 1 ? '' : 's'}.
                </p>
              )}
              <p className="mt-1 text-xs opacity-75">
                Everything already read is saved, and none of it will be charged again.
              </p>
            </>
          )}
          {!paused && (
            <p className="font-medium">
              {report.items} quotation{report.items === 1 ? '' : 's'} recorded
              {report.dropped > 0 && (
                <> · {report.dropped} discarded for not matching the stored text word for word</>
              )}
              {report.failed > 0 && (
                <> · {report.failed} pairing{report.failed === 1 ? '' : 's'} could not be read</>
              )}
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
  node, docs, docsNotice, busy, evidenceBump, onEvidenceChanged,
  onSave, onDecide, onManualAdd,
}: {
  node: BucketNode;
  docs: ClassifiedDoc[] | null;
  /** Set only when the bucket holds more documents than are listed. */
  docsNotice: string | null;
  busy: boolean;
  /** Bumped when a run finishes, to re-read this node's evidence. */
  evidenceBump: number;
  onEvidenceChanged: () => void;
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

      {/* The evidence comes FIRST, above the documents it was drawn from.
          A bucket's documents are the working list; its quoted testimony is
          the work product, and it is what goes into the outline. */}
      <div className="border-t border-white/10 pt-3">
        <h4 className="mb-2 text-sm font-medium text-zinc-300">Evidence</h4>
        <BucketizerEvidence
          key={`${node.id}:${evidenceBump}`}
          nodeId={node.id}
          onChanged={onEvidenceChanged}
        />
      </div>

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

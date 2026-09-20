// Bucketizer engine — the living case-theory tree and AI-proposed /
// attorney-confirmed classification of matter documents into it.
//
// Provider-neutral by construction: all model calls go through
// generateStructured() (src/lib/llm), and all prompt/schema text lives in
// lib/bucketizer-core.mjs, shared with the service-role CLI
// (scripts/bucketize.mjs) so the in-app and batch paths cannot drift.

import { supabase } from '@/lib/supabase';
import { generateStructured } from '@/lib/llm/structured';
import { findModel } from '@/lib/llm/providers';
import { fetchPaged, type PagedRows } from '@/lib/paged';
import {
  TREE_TOOL_NAME,
  TREE_TOOL_DESCRIPTION,
  TREE_SCHEMA,
  TREE_SYSTEM,
  buildTreeUserContent,
  CLASSIFY_TOOL_NAME,
  CLASSIFY_TOOL_DESCRIPTION,
  CLASSIFY_SCHEMA,
  serializeOutline,
  type TreeResult,
} from '../../../lib/bucketizer-core.mjs';
import { loadCorpusDocumentText } from '@/lib/cite-check/corpus';
import { callStructured } from './llm-call';
import { LlmCallError } from './llm-error';
import {
  classifyDocumentWindowed,
  type DocOutcome,
  type RunDeps,
  type StoredRun,
} from './classify-run';
import type { MergedAssignment, WindowPassage } from './windows';
import { estimateRun, type EstimateDoc, type RunEstimate } from './estimate';
import { isFiledOutline } from './outline-model';

export const BUCKETIZER_DEFAULT_MODEL = 'claude-opus-4-8';

export { LlmCallError } from './llm-error';
export { formatCents } from './estimate';
export type { RunEstimate } from './estimate';
export type { DocOutcome } from './classify-run';

export type NodeKind = 'claim' | 'element' | 'theme' | 'subissue';
export type ClassificationStatus = 'proposed' | 'confirmed' | 'rejected';

export interface BucketNode {
  id: string;
  matterspace_id: string;
  parent_id: string | null;
  kind: NodeKind;
  label: string;
  description: string | null;
  position: number;
  origin: 'generated' | 'manual';
}

export interface BucketClassification {
  id: string;
  matterspace_id: string;
  document_id: string;
  node_id: string;
  status: ClassificationStatus;
  confidence: number | null;
  rationale: string | null;
  passage_ids: string[];
  model_id: string | null;
  proposed_at: string;
  decided_at: string | null;
}

export interface ClassifiedDoc {
  classification: BucketClassification;
  documentTitle: string;
  docType: string | null;
}

// ---------------------------------------------------------------------------
// Tree CRUD
// ---------------------------------------------------------------------------

export async function fetchTree(matterId: string): Promise<BucketNode[]> {
  const { data, error } = await supabase
    .from('bucketizer_nodes')
    .select('id, matterspace_id, parent_id, kind, label, description, position, origin')
    .eq('matterspace_id', matterId)
    .order('position');
  if (error) throw new Error(error.message);
  return (data ?? []) as BucketNode[];
}

export async function createNode(input: {
  matterId: string;
  parentId: string | null;
  kind: NodeKind;
  label: string;
  description?: string;
  position: number;
  origin?: 'generated' | 'manual';
}): Promise<BucketNode> {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('bucketizer_nodes')
    .insert({
      matterspace_id: input.matterId,
      parent_id: input.parentId,
      kind: input.kind,
      label: input.label,
      description: input.description ?? null,
      position: input.position,
      origin: input.origin ?? 'manual',
      created_by: auth.user?.id,
    })
    .select('id, matterspace_id, parent_id, kind, label, description, position, origin')
    .single();
  if (error) throw new Error(error.message);
  return data as BucketNode;
}

export async function updateNode(
  nodeId: string,
  patch: Partial<Pick<BucketNode, 'label' | 'description' | 'position' | 'kind'>>,
): Promise<void> {
  const { error } = await supabase
    .from('bucketizer_nodes')
    .update({ ...patch, origin: 'manual' })
    .eq('id', nodeId);
  if (error) throw new Error(error.message);
}

/** Deleting a node cascades to its descendants and their classifications. */
export async function deleteNode(nodeId: string): Promise<void> {
  const { error } = await supabase.from('bucketizer_nodes').delete().eq('id', nodeId);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Tree generation from pleadings
// ---------------------------------------------------------------------------

export async function generateTreeFromPleadings(input: {
  matterId: string;
  pleadingDocIds: string[];
  modelId?: string;
  signal?: AbortSignal;
}): Promise<BucketNode[]> {
  const pleadings = [] as { title: string; text: string }[];
  for (const docId of input.pleadingDocIds) {
    const loaded = await loadCorpusDocumentText(docId);
    pleadings.push({ title: loaded.title, text: loaded.text });
  }
  if (!pleadings.length) throw new Error('No pleading text could be loaded.');

  const result = await generateStructured<TreeResult>({
    modelId: input.modelId ?? BUCKETIZER_DEFAULT_MODEL,
    system: TREE_SYSTEM,
    userContent: buildTreeUserContent(pleadings),
    toolName: TREE_TOOL_NAME,
    toolDescription: TREE_TOOL_DESCRIPTION,
    inputSchema: TREE_SCHEMA,
    maxTokens: 16_000,
    signal: input.signal,
    matterId: input.matterId,
  });

  if (!result?.claims?.length) throw new Error('The model returned no claims.');

  // Insert level by level so parent ids exist before children reference them.
  const created: BucketNode[] = [];
  let rootPos = 0;
  for (const claim of result.claims) {
    const claimNode = await createNode({
      matterId: input.matterId,
      parentId: null,
      kind: 'claim',
      label: claim.label,
      description: claim.description,
      position: rootPos++,
      origin: 'generated',
    });
    created.push(claimNode);
    let elPos = 0;
    for (const el of claim.elements ?? []) {
      const elNode = await createNode({
        matterId: input.matterId,
        parentId: claimNode.id,
        kind: 'element',
        label: el.label,
        description: el.description,
        position: elPos++,
        origin: 'generated',
      });
      created.push(elNode);
      let subPos = 0;
      for (const sub of el.subissues ?? []) {
        created.push(await createNode({
          matterId: input.matterId,
          parentId: elNode.id,
          kind: 'subissue',
          label: sub.label,
          description: sub.description,
          position: subPos++,
          origin: 'generated',
        }));
      }
    }
  }
  for (const theme of result.themes ?? []) {
    created.push(await createNode({
      matterId: input.matterId,
      parentId: null,
      kind: 'theme',
      label: theme.label,
      description: theme.description,
      position: rootPos++,
      origin: 'generated',
    }));
  }
  return created;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassifyProgress {
  done: number;
  total: number;
  currentTitle: string;
  proposed: number;
  errors: number;
  /** Windows actually sent to the model this run — what is being paid for. */
  windowsCalled: number;
  /** Windows skipped because a previous run had already finished them. */
  windowsResumed: number;
  /** Windows inside the document currently being read. */
  docWindowsDone: number;
  docWindowsTotal: number;
  /** Set when the meter stopped the run. The run is resumable as it stands. */
  pausedMessage: string | null;
  retryAfterSeconds: number | null;
  /** One line per window that could not be used, for the person to read. */
  notes: string[];
}

export function emptyProgress(total: number): ClassifyProgress {
  return {
    done: 0, total, currentTitle: '', proposed: 0, errors: 0,
    windowsCalled: 0, windowsResumed: 0, docWindowsDone: 0, docWindowsTotal: 0,
    pausedMessage: null, retryAfterSeconds: null, notes: [],
  };
}

export interface DocRow {
  id: string;
  title: string;
  doc_type: string | null;
  /** Nullable in the schema; the estimate says how many are unknown. */
  page_count?: number | null;
  metadata?: { bucketizer?: { no_buckets_at?: string } } | null;
}

/**
 * Ready documents in the matter AND its sub-matters that haven't been
 * examined yet — no classification rows AND no "no buckets fit" sentinel
 * (without the sentinel, zero-assignment docs would be re-classified on
 * every run). The tree belongs to the matter, but the documents it files can
 * sit in sub-matters (Fleming's depositions and medical records do); until
 * 2026-09-09 this read the matter's own rows only, and no deposition was
 * ever a candidate. The same expansion search uses.
 */
export async function listUnclassifiedDocs(matterId: string): Promise<DocRow[]> {
  const { data: descRows } = await supabase.rpc('matterspace_descendants', { p_root: matterId });
  const matterIds = ((descRows ?? []) as { id: string }[]).map((r) => r.id);
  if (!matterIds.includes(matterId)) matterIds.push(matterId);

  const { rows: docs } = await fetchPaged<DocRow>(
    (from, to) => supabase
      .from('documents')
      .select('id, title, doc_type, page_count, metadata')
      .in('matterspace_id', matterIds)
      .eq('processing_status', 'ready')
      .order('id')
      .range(from, to),
    { label: 'matter documents', ceiling: 100_000 },
  );

  // The membership probe was itself capped, and it caused the exact harm it
  // was guarding against: 200 documents can hold well over 1,000
  // classification rows, PostgREST returned the first 1,000, and every
  // document past the cut read back as UNCLASSIFIED — so a re-run classified
  // it again and charged for it again. Paged, and in smaller chunks.
  const classified = new Set<string>();
  for (let i = 0; i < docs.length; i += 100) {
    const ids = docs.slice(i, i + 100).map((d) => d.id);
    const { rows } = await fetchPaged<{ document_id: string }>(
      (from, to) => supabase
        .from('bucketizer_classifications')
        .select('document_id, id')
        .in('document_id', ids)
        .order('id')
        .range(from, to),
      { label: 'classification membership', ceiling: 100_000 },
    );
    for (const row of rows) classified.add(row.document_id);
  }
  return docs.filter((d) => !classified.has(d.id)
    && !d.metadata?.bucketizer?.no_buckets_at
    // A trial outline this matter filed earlier is not evidence about the
    // matter. See `isFiledOutline` for why excluding it is not cosmetic.
    && !isFiledOutline(d.title));
}

// ---------------------------------------------------------------------------
// Cost, before the run
// ---------------------------------------------------------------------------

/**
 * What a bulk classify of `docs` will cost, at the rates `/api/llm` charges.
 * The surface shows this and waits for a click; nothing is spent first.
 */
export function estimateClassifyRun(
  docs: EstimateDoc[],
  nodes: BucketNode[],
  modelId: string = BUCKETIZER_DEFAULT_MODEL,
): RunEstimate {
  const { outline } = serializeOutline(nodes);
  const provider = findModel(modelId)?.provider.id ?? 'anthropic';
  return estimateRun(docs, { modelId, provider, outlineChars: outline.length });
}

/**
 * The Supabase-backed effects the windowed runner needs. Kept as a factory so
 * the offline harness can hand `classifyDocumentWindowed` arrays and counters
 * instead of a database and a model.
 */
export function supabaseRunDeps(input: {
  matterId: string;
  modelId: string;
  signal?: AbortSignal;
}): RunDeps {
  return {
    /**
     * EVERY passage, in reading order — the fix this change exists for. The
     * old read was `.range(0, 199)`, which on a 247-page deposition is the
     * first thirty pages. Page start/end come along because the merged
     * rationale cites them.
     */
    async fetchPassages(documentId: string): Promise<WindowPassage[]> {
      const page = await fetchPaged<WindowPassage>(
        (from, to) => supabase
          .from('passages')
          .select('id, text, page_start, page_end, sequence_number')
          .eq('document_id', documentId)
          .order('sequence_number')
          .order('id')
          .range(from, to),
        { label: 'passages', ceiling: 50_000 },
      );
      // Returning a prefix here would be the very silence this whole change
      // removes — a half-read document classified as if it were whole. Fifty
      // thousand passages is far past any real document, so this is a refusal,
      // and the run records it against this document and carries on.
      if (page.truncated) {
        throw new Error(
          `this document has more than ${page.rows.length.toLocaleString()} passages, `
          + 'which is past what the classifier will read in one pass; it was not classified.',
        );
      }
      return page.rows;
    },

    async loadRun(documentId: string): Promise<StoredRun | null> {
      const meta = await readBucketizerMeta(documentId);
      const run = meta?.run as StoredRun | undefined;
      return run && run.v === 1 && Array.isArray(run.w) ? run : null;
    },

    async saveRun(documentId: string, run: StoredRun): Promise<void> {
      await writeBucketizerMeta(documentId, (prior) => ({ ...prior, run }));
    },

    async finish(documentId, result): Promise<void> {
      if (result.rows.length) {
        const rows = result.rows.map((r: MergedAssignment) => ({
          node_id: r.node_id,
          confidence: r.confidence,
          rationale: r.rationale,
          passage_ids: r.passage_ids,
          matterspace_id: input.matterId,
          document_id: documentId,
          status: 'proposed',
          model_id: input.modelId,
        }));
        // `ignoreDuplicates` protects the attorney: a row they already
        // confirmed or rejected is never overwritten by a fresh proposal.
        const { error } = await supabase
          .from('bucketizer_classifications')
          .upsert(rows, { onConflict: 'document_id,node_id', ignoreDuplicates: true });
        if (error) throw new Error(error.message);
      }
      // `run` is replaced by `coverage`: the working state goes, the record of
      // how much of the document was read stays. When nothing fit, the
      // "examined, no bucket" sentinel keeps the document out of the next run.
      await writeBucketizerMeta(documentId, (prior) => {
        const next: Record<string, unknown> = { ...prior, coverage: result.coverage };
        delete next.run;
        if (!result.rows.length) next.no_buckets_at = result.coverage.completed_at;
        return next;
      });
    },

    async callWindow(call) {
      const { raw } = await callStructured({
        modelId: input.modelId,
        system: call.system,
        userContent: call.userContent,
        toolName: CLASSIFY_TOOL_NAME,
        toolDescription: CLASSIFY_TOOL_DESCRIPTION,
        inputSchema: CLASSIFY_SCHEMA,
        maxTokens: call.maxTokens,
        matterId: input.matterId,
        signal: input.signal,
      });
      return raw;
    },
  };
}

/**
 * Read-modify-write on `documents.metadata.bucketizer`.
 *
 * The metadata is re-read immediately before every write rather than spread
 * from a cached copy, so a `coverage` written by this run does not clobber an
 * unrelated key another writer added in between. The read-modify-write race
 * itself is not closed — that needs a jsonb merge in SQL, which needs a
 * migration — but the window is one round-trip and the candidates are
 * documents already in `ready`, so ingestion is finished with them.
 */
async function readBucketizerMeta(documentId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('documents').select('metadata').eq('id', documentId).maybeSingle();
  if (error) throw new Error(error.message);
  const meta = (data?.metadata ?? {}) as Record<string, unknown>;
  return (meta.bucketizer as Record<string, unknown> | undefined) ?? {};
}

async function writeBucketizerMeta(
  documentId: string,
  mutate: (prior: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const { data, error } = await supabase
    .from('documents').select('metadata').eq('id', documentId).maybeSingle();
  if (error) throw new Error(error.message);
  const meta = (data?.metadata ?? {}) as Record<string, unknown>;
  const bucketizer = (meta.bucketizer as Record<string, unknown> | undefined) ?? {};
  const { error: upErr } = await supabase
    .from('documents')
    .update({ metadata: { ...meta, bucketizer: mutate(bucketizer) } })
    .eq('id', documentId);
  if (upErr) throw new Error(upErr.message);
}

/**
 * Classify one document, whole. Returns the outcome rather than a count: the
 * caller needs to know whether the document finished, ran out of reach
 * mid-way, or has no text at all.
 */
export async function classifyDocument(input: {
  matterId: string;
  doc: DocRow;
  nodes: BucketNode[];
  modelId?: string;
  signal?: AbortSignal;
  deps?: RunDeps;
  onWindow?: (p: { done: number; total: number; charged: boolean }) => void;
}): Promise<DocOutcome> {
  const modelId = input.modelId ?? BUCKETIZER_DEFAULT_MODEL;
  return classifyDocumentWindowed({
    doc: input.doc,
    nodes: input.nodes,
    modelId,
    signal: input.signal,
    onWindow: input.onWindow,
    deps: input.deps ?? supabaseRunDeps({ matterId: input.matterId, modelId, signal: input.signal }),
  });
}

/**
 * Classify a batch, one document at a time, reporting progress.
 *
 * Three behaviours matter here and each was chosen deliberately:
 *
 * - ONE DOCUMENT'S FAILURE DOES NOT STOP THE RUN. A corrupt text layer, a
 *   model that will not answer about one exhibit, a row-level permission
 *   surprise: counted, noted in plain language, next document.
 * - A METER REFUSAL STOPS THE RUN, AND SAYS WHEN TO COME BACK. 402/429/413
 *   are not this document's problem, and four hundred more attempts against a
 *   spent budget is not diligence. Everything finished is already saved, so
 *   pressing the button again later resumes.
 * - NOTHING FINISHED IS PAID FOR TWICE, including across the pause: the
 *   per-window records live on the documents, not in this loop.
 */
export async function classifyDocuments(input: {
  matterId: string;
  docs: DocRow[];
  nodes: BucketNode[];
  modelId?: string;
  signal?: AbortSignal;
  deps?: RunDeps;
  onProgress?: (p: ClassifyProgress) => void;
}): Promise<ClassifyProgress> {
  const progress = emptyProgress(input.docs.length);
  const modelId = input.modelId ?? BUCKETIZER_DEFAULT_MODEL;
  const deps = input.deps
    ?? supabaseRunDeps({ matterId: input.matterId, modelId, signal: input.signal });

  for (const doc of input.docs) {
    if (input.signal?.aborted) break;
    progress.currentTitle = doc.title;
    progress.docWindowsDone = 0;
    progress.docWindowsTotal = 0;
    input.onProgress?.({ ...progress, notes: [...progress.notes] });

    try {
      const outcome = await classifyDocument({
        matterId: input.matterId,
        doc,
        nodes: input.nodes,
        modelId,
        signal: input.signal,
        deps,
        onWindow: (p) => {
          progress.docWindowsDone = p.done;
          progress.docWindowsTotal = p.total;
          if (p.charged) progress.windowsCalled += 1; else progress.windowsResumed += 1;
          input.onProgress?.({ ...progress, notes: [...progress.notes] });
        },
      });
      progress.proposed += outcome.proposed;
      progress.notes.push(...outcome.notes);
      if (outcome.status === 'incomplete') progress.errors += 1;
      if (outcome.status === 'aborted') break;
    } catch (e) {
      if (input.signal?.aborted) break;
      if (e instanceof LlmCallError && e.isUsagePause) {
        progress.pausedMessage = e.message;
        progress.retryAfterSeconds = e.retryAfterSeconds;
        input.onProgress?.({ ...progress, notes: [...progress.notes] });
        return { ...progress, notes: [...progress.notes] };
      }
      progress.errors += 1;
      progress.notes.push(`${doc.title}: ${e instanceof Error ? e.message : String(e)}`);
      console.warn('bucketizer: classify failed', doc.title, e);
    }
    progress.done += 1;
    input.onProgress?.({ ...progress, notes: [...progress.notes] });
  }
  return { ...progress, notes: [...progress.notes] };
}

// ---------------------------------------------------------------------------
// Review (attorney decisions)
// ---------------------------------------------------------------------------

export async function decideClassification(
  classificationId: string,
  decision: 'confirmed' | 'rejected',
): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('bucketizer_classifications')
    .update({ status: decision, decided_by: auth.user?.id, decided_at: new Date().toISOString() })
    .eq('id', classificationId);
  if (error) throw new Error(error.message);
}

/** Attorney adds a document to a bucket by hand — born confirmed. */
export async function addManualClassification(input: {
  matterId: string;
  documentId: string;
  nodeId: string;
}): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('bucketizer_classifications')
    .upsert({
      matterspace_id: input.matterId,
      document_id: input.documentId,
      node_id: input.nodeId,
      status: 'confirmed',
      model_id: null,
      decided_by: auth.user?.id,
      decided_at: new Date().toISOString(),
    }, { onConflict: 'document_id,node_id' });
  if (error) throw new Error(error.message);
}

/**
 * A bucket's documents.
 *
 * Paged. Unpaged, this returned PostgREST's first 1,000 rows and said nothing
 * — a bucket holding 1,240 documents showed 1,000 of them and looked
 * complete, which for a review surface is the worst possible failure: the
 * attorney works the list to the bottom and believes they are done.
 *
 * Note the second `.order('id')`. Confidence ties are the norm here (every
 * manual row is null, and models cluster on 0.9), and an ORDER BY that leaves
 * ties unbroken lets rows swap between `.range()` pages — which does not just
 * reorder the list, it DUPLICATES some rows and DROPS others.
 */
export async function fetchClassificationsForNode(nodeId: string): Promise<PagedRows<ClassifiedDoc>> {
  const page = await fetchPaged<Record<string, unknown>>(
    (from, to) => supabase
      .from('bucketizer_classifications')
      .select(
        'id, matterspace_id, document_id, node_id, status, confidence, rationale, passage_ids, model_id, proposed_at, decided_at, documents(title, doc_type)',
        { count: 'exact' },
      )
      .eq('node_id', nodeId)
      .order('confidence', { ascending: false, nullsFirst: false })
      .order('id')
      .range(from, to),
    { label: 'bucket documents' },
  );
  return {
    ...page,
    rows: page.rows.map((row) => {
      const { documents, ...classification } = row as unknown as BucketClassification & {
        documents: { title: string; doc_type: string | null } | null;
      };
      return {
        classification,
        documentTitle: documents?.title ?? '(deleted document)',
        docType: documents?.doc_type ?? null,
      };
    }),
  };
}

/** Per-node classification counts for the tree display. */
export async function fetchNodeCounts(
  matterId: string,
): Promise<Map<string, { proposed: number; confirmed: number }>> {
  const counts = new Map<string, { proposed: number; confirmed: number }>();
  const { rows } = await fetchPaged<{ node_id: string; status: ClassificationStatus }>(
    (from, to) => supabase
      .from('bucketizer_classifications')
      .select('node_id, status, id')
      .eq('matterspace_id', matterId)
      .order('id')
      .range(from, to),
    { label: 'bucket counts', ceiling: 200_000 },
  );
  for (const row of rows) {
    if (row.status === 'rejected') continue;
    const c = counts.get(row.node_id) ?? { proposed: 0, confirmed: 0 };
    if (row.status === 'proposed') c.proposed += 1;
    else c.confirmed += 1;
    counts.set(row.node_id, c);
  }
  return counts;
}

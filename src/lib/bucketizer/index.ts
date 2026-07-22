// Bucketizer engine — the living case-theory tree and AI-proposed /
// attorney-confirmed classification of matter documents into it.
//
// Provider-neutral by construction: all model calls go through
// generateStructured() (src/lib/llm), and all prompt/schema text lives in
// lib/bucketizer-core.mjs, shared with the service-role CLI
// (scripts/bucketize.mjs) so the in-app and batch paths cannot drift.

import { supabase } from '@/lib/supabase';
import { generateStructured } from '@/lib/llm/structured';
import {
  TREE_TOOL_NAME,
  TREE_TOOL_DESCRIPTION,
  TREE_SCHEMA,
  TREE_SYSTEM,
  buildTreeUserContent,
  CLASSIFY_TOOL_NAME,
  CLASSIFY_TOOL_DESCRIPTION,
  CLASSIFY_SCHEMA,
  CLASSIFY_SYSTEM,
  serializeOutline,
  buildClassifyUserContent,
  decodeAssignments,
  type TreeResult,
  type ClassifyResult,
} from '../../../lib/bucketizer-core.mjs';
import { loadCorpusDocumentText } from '@/lib/cite-check/corpus';

export const BUCKETIZER_DEFAULT_MODEL = 'claude-opus-4-8';

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
}

interface DocRow {
  id: string;
  title: string;
  doc_type: string | null;
  metadata?: { bucketizer?: { no_buckets_at?: string } } | null;
}

/**
 * Ready documents in the matter that haven't been examined yet — no
 * classification rows AND no "no buckets fit" sentinel (without the
 * sentinel, zero-assignment docs would be re-classified on every run).
 */
export async function listUnclassifiedDocs(matterId: string): Promise<DocRow[]> {
  const docs: DocRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('documents')
      .select('id, title, doc_type, metadata')
      .eq('matterspace_id', matterId)
      .eq('processing_status', 'ready')
      .order('id')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    docs.push(...((data ?? []) as DocRow[]));
    if (!data || data.length < 1000) break;
  }
  const classified = new Set<string>();
  for (let i = 0; i < docs.length; i += 200) {
    const ids = docs.slice(i, i + 200).map((d) => d.id);
    const { data, error } = await supabase
      .from('bucketizer_classifications')
      .select('document_id')
      .in('document_id', ids);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) classified.add(row.document_id as string);
  }
  return docs.filter((d) => !classified.has(d.id) && !d.metadata?.bucketizer?.no_buckets_at);
}

/**
 * Classify one document into the current tree. Returns the number of
 * proposals inserted (0 = the model found no bucket that fits).
 */
export async function classifyDocument(input: {
  matterId: string;
  doc: DocRow;
  nodes: BucketNode[];
  modelId?: string;
  signal?: AbortSignal;
}): Promise<number> {
  const { outline, refToId } = serializeOutline(input.nodes);
  if (!outline) throw new Error('The tree is empty — generate or add buckets first.');

  const passages: { id: string; text: string }[] = [];
  const { data, error } = await supabase
    .from('passages')
    .select('id, text')
    .eq('document_id', input.doc.id)
    .order('sequence_number')
    .range(0, 199);
  if (error) throw new Error(error.message);
  passages.push(...((data ?? []) as { id: string; text: string }[]));
  if (!passages.length) return 0;

  const { userContent, refToPassageId } = buildClassifyUserContent(
    { title: input.doc.title, docType: input.doc.doc_type },
    passages,
    outline,
  );

  const modelId = input.modelId ?? BUCKETIZER_DEFAULT_MODEL;
  const result = await generateStructured<ClassifyResult>({
    modelId,
    system: CLASSIFY_SYSTEM,
    userContent,
    toolName: CLASSIFY_TOOL_NAME,
    toolDescription: CLASSIFY_TOOL_DESCRIPTION,
    inputSchema: CLASSIFY_SCHEMA,
    maxTokens: 4_000,
    signal: input.signal,
  });

  const rows = decodeAssignments(result, refToId, refToPassageId).map((r) => ({
    ...r,
    matterspace_id: input.matterId,
    document_id: input.doc.id,
    status: 'proposed',
    model_id: modelId,
  }));
  if (!rows.length) {
    // Examined, no bucket fits — mark so the doc isn't re-queued next run.
    const { data: d } = await supabase
      .from('documents').select('metadata').eq('id', input.doc.id).single();
    const prior = (d?.metadata ?? {}) as Record<string, unknown>;
    await supabase.from('documents').update({
      metadata: {
        ...prior,
        bucketizer: { ...(prior.bucketizer as object ?? {}), no_buckets_at: new Date().toISOString() },
      },
    }).eq('id', input.doc.id);
    return 0;
  }
  const { error: insErr } = await supabase
    .from('bucketizer_classifications')
    .upsert(rows, { onConflict: 'document_id,node_id', ignoreDuplicates: true });
  if (insErr) throw new Error(insErr.message);
  return rows.length;
}

/** Sequentially classify a batch, reporting progress. Continues past
 *  individual failures; stops on abort. */
export async function classifyDocuments(input: {
  matterId: string;
  docs: DocRow[];
  nodes: BucketNode[];
  modelId?: string;
  signal?: AbortSignal;
  onProgress?: (p: ClassifyProgress) => void;
}): Promise<ClassifyProgress> {
  const progress: ClassifyProgress = {
    done: 0, total: input.docs.length, currentTitle: '', proposed: 0, errors: 0,
  };
  for (const doc of input.docs) {
    if (input.signal?.aborted) break;
    progress.currentTitle = doc.title;
    input.onProgress?.({ ...progress });
    try {
      progress.proposed += await classifyDocument({ ...input, doc });
    } catch (e) {
      if (input.signal?.aborted) break;
      progress.errors += 1;
      console.warn('bucketizer: classify failed', doc.title, e);
    }
    progress.done += 1;
    input.onProgress?.({ ...progress });
  }
  return progress;
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

export async function fetchClassificationsForNode(nodeId: string): Promise<ClassifiedDoc[]> {
  const { data, error } = await supabase
    .from('bucketizer_classifications')
    .select('id, matterspace_id, document_id, node_id, status, confidence, rationale, passage_ids, model_id, proposed_at, decided_at, documents(title, doc_type)')
    .eq('node_id', nodeId)
    .order('confidence', { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => {
    const { documents, ...classification } = row as unknown as BucketClassification & {
      documents: { title: string; doc_type: string | null } | null;
    };
    return {
      classification,
      documentTitle: documents?.title ?? '(deleted document)',
      docType: documents?.doc_type ?? null,
    };
  });
}

/** Per-node classification counts for the tree display. */
export async function fetchNodeCounts(
  matterId: string,
): Promise<Map<string, { proposed: number; confirmed: number }>> {
  const counts = new Map<string, { proposed: number; confirmed: number }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('bucketizer_classifications')
      .select('node_id, status')
      .eq('matterspace_id', matterId)
      .order('id')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as { node_id: string; status: ClassificationStatus }[]) {
      if (row.status === 'rejected') continue;
      const c = counts.get(row.node_id) ?? { proposed: 0, confirmed: 0 };
      if (row.status === 'proposed') c.proposed += 1;
      else c.confirmed += 1;
      counts.set(row.node_id, c);
    }
    if (!data || data.length < 1000) break;
  }
  return counts;
}

// The database side of the evidence lane: listing the pairings that are left,
// running the pass, and the attorney's decisions on what it found.
//
// Everything with judgment in it lives in `evidence-run.ts`, which imports no
// database and no `@/` alias so the offline harness can exercise it. This file
// is the wiring: PostgREST reads (paged, because a matter's classifications go
// past a thousand rows the moment a corpus is real), the model call through
// the same `/api/llm` the classifier uses, and the writes.

import { supabase } from '@/lib/supabase';
import { findModel } from '@/lib/llm/providers';
import { fetchPaged, type PagedRows } from '@/lib/paged';
import { callStructured } from './llm-call';
import { BUCKETIZER_DEFAULT_MODEL } from './index';
import {
  EVIDENCE_SCHEMA,
  EVIDENCE_TOOL_DESCRIPTION,
  EVIDENCE_TOOL_NAME,
} from './evidence-prompt';
import {
  partitionPairs,
  runEvidencePass,
  type EvidenceDeps,
  type EvidenceNode,
  type EvidencePair,
  type EvidencePassageRow,
  type EvidenceProgress,
  type PairPartition,
  type SavePairInput,
} from './evidence-run';
import { estimateEvidenceRun, type EvidenceEstimate } from './evidence-estimate';
import { buildCite, readerUrl, type Cite } from './cite';

/**
 * Until migration 068 is applied, the three pair-level columns are not there
 * and PostgREST answers a select naming them with a schema error. That is a
 * setup state, not a bug, and it deserves a sentence rather than
 * `column bucketizer_classifications.evidence_run_at does not exist`.
 */
const MISSING_068 =
  'The evidence tables are not installed on this database yet. Apply migration '
  + '068_bucketizer_evidence.sql, then try again.';

function friendly(error: { message: string }): Error {
  const m = error.message ?? '';
  if (/evidence_run_at|evidence_failed|evidence_model|bucketizer_evidence/.test(m)) {
    return new Error(MISSING_068);
  }
  return new Error(m);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface EvidenceRow {
  id: string;
  matterspace_id: string;
  node_id: string;
  document_id: string;
  passage_id: string;
  quote: string;
  quote_offset: number;
  rationale: string | null;
  status: 'proposed' | 'confirmed' | 'rejected';
  position: number;
  model_id: string | null;
  proposed_at: string;
  decided_at: string | null;
}

/** An evidence item with everything the review panel shows beside it. */
export interface NodeEvidenceItem {
  row: EvidenceRow;
  documentTitle: string;
  cite: Cite;
  readerUrl: string;
}

export async function fetchEvidenceForNode(nodeId: string): Promise<PagedRows<NodeEvidenceItem>> {
  const page = await fetchPaged<Record<string, unknown>>(
    (from, to) => supabase
      .from('bucketizer_evidence')
      // One string literal, not a concatenation: supabase-js parses the select
      // at the TYPE level, and a `+` expression degrades the whole query to
      // `GenericStringError[]`.
      .select(
        'id, matterspace_id, node_id, document_id, passage_id, quote, quote_offset, rationale, status, position, model_id, proposed_at, decided_at, documents(title, doc_type, witness_name), passages(id, page_start, page_end, line_start, line_end, witness_name, metadata)',
        { count: 'exact' },
      )
      .eq('node_id', nodeId)
      // The attorney's order, with the id as the unique tiebreaker that keeps
      // `.range()` pages from swapping rows (src/lib/paged.ts).
      .order('position')
      .order('id')
      .range(from, to),
    { label: 'evidence' },
  );

  return {
    ...page,
    rows: page.rows.map((raw) => {
      const { documents, passages, ...row } = raw as unknown as EvidenceRow & {
        documents: { title: string; doc_type: string | null; witness_name: string | null } | null;
        passages: {
          id: string; page_start: number | null; page_end: number | null;
          line_start: number | null; line_end: number | null;
          witness_name: string | null; metadata: { line_numbers?: string } | null;
        } | null;
      };
      const doc = {
        id: row.document_id,
        title: documents?.title ?? '(deleted document)',
        doc_type: documents?.doc_type ?? null,
        witness_name: documents?.witness_name ?? null,
      };
      const cite = buildCite(passages ?? { id: row.passage_id }, doc);
      return { row, documentTitle: doc.title, cite, readerUrl: readerUrl(doc.id, cite.readerPage) };
    }),
  };
}

export async function decideEvidence(
  evidenceId: string,
  decision: 'confirmed' | 'rejected',
): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('bucketizer_evidence')
    .update({ status: decision, decided_by: auth.user?.id, decided_at: new Date().toISOString() })
    .eq('id', evidenceId);
  if (error) throw friendly(error);
}

/**
 * The attorney's order for one issue.
 *
 * Written as explicit positions rather than a swap, because the outline reads
 * `position` verbatim and a half-applied swap would silently change what the
 * filed document says the strongest evidence is.
 */
export async function reorderEvidence(orderedIds: string[]): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    const { error } = await supabase
      .from('bucketizer_evidence')
      .update({ position: i })
      .eq('id', orderedIds[i]);
    if (error) throw friendly(error);
  }
}

// ---------------------------------------------------------------------------
// The pairings
// ---------------------------------------------------------------------------

/**
 * `todo` = confirmed pairings not yet read for evidence — what the pass will
 * do and pay for. `alreadyRun` = pairings a previous pass finished, of which
 * `failed` could not be used. `withoutPassages` = pairings whose
 * classification records no candidate passages at all.
 */
export type PairInventory = PairPartition;

/**
 * What the evidence pass has left to do, over CONFIRMED classifications only.
 *
 * Proposed classifications are deliberately out of scope. Quoting from a
 * bucket assignment nobody has agreed with would put a witness's words under
 * an issue the attorney has not accepted the document belongs to — and it
 * would multiply the bill by every unreviewed proposal in the matter.
 */
export async function listEvidencePairs(
  matterId: string,
  options: { retryFailed?: boolean } = {},
): Promise<PairInventory> {
  interface Row {
    id: string; node_id: string; document_id: string; passage_ids: string[] | null;
    evidence_run_at: string | null; evidence_failed: string | null;
    documents: { title: string; doc_type: string | null; witness_name: string | null } | null;
  }
  // `Record<string, unknown>` and a cast, as `fetchClassificationsForNode`
  // does: with no generated schema types, supabase-js infers an embedded
  // resource as an ARRAY, and PostgREST returns an object for a to-one embed.
  let rows: Row[];
  try {
    const page = await fetchPaged<Record<string, unknown>>(
      (from, to) => supabase
        .from('bucketizer_classifications')
        .select(
          'id, node_id, document_id, passage_ids, evidence_run_at, evidence_failed, documents(title, doc_type, witness_name)',
        )
        .eq('matterspace_id', matterId)
        .eq('status', 'confirmed')
        .order('id')
        .range(from, to),
      { label: 'confirmed classifications', ceiling: 200_000 },
    );
    rows = page.rows as unknown as Row[];
  } catch (e) {
    throw friendly({ message: e instanceof Error ? e.message : String(e) });
  }

  // The decision about what still has to be paid for is a pure function, so
  // the offline harness asserts it rather than hoping.
  return partitionPairs(
    rows.map((row) => ({
      classificationId: row.id,
      nodeId: row.node_id,
      documentId: row.document_id,
      documentTitle: row.documents?.title ?? '(deleted document)',
      docType: row.documents?.doc_type ?? null,
      documentWitness: row.documents?.witness_name ?? null,
      passageIds: (row.passage_ids ?? []).filter(Boolean),
      evidenceRunAt: row.evidence_run_at,
      evidenceFailed: row.evidence_failed,
    })),
    { retryFailed: options.retryFailed },
  );
}

/** Price the pass, at the rates `/api/llm` charges. Nothing is spent here. */
export function estimateEvidencePass(
  inventory: PairInventory,
  modelId: string = BUCKETIZER_DEFAULT_MODEL,
): EvidenceEstimate {
  const provider = findModel(modelId)?.provider.id ?? 'anthropic';
  return estimateEvidenceRun(
    inventory.todo.map((p) => ({
      nodeId: p.nodeId, documentId: p.documentId, passageCount: p.passageIds.length,
    })),
    { modelId, provider, alreadyRun: inventory.alreadyRun },
  );
}

/**
 * Quotations proposed and not yet decided, across the whole matter.
 *
 * The Outline dialog reads it to say how much of what it is about to file is
 * still unconfirmed — and to refuse to drop the DRAFT legend while any of it
 * is.
 */
export async function countUnconfirmedEvidence(matterId: string): Promise<number> {
  const { count, error } = await supabase
    .from('bucketizer_evidence')
    .select('id', { count: 'exact', head: true })
    .eq('matterspace_id', matterId)
    .eq('status', 'proposed');
  if (error) throw friendly(error);
  return count ?? 0;
}

/** Clear the run mark on the pairings that failed, so they can be retried. */
export async function retryFailedPairs(matterId: string): Promise<number> {
  const { data, error } = await supabase
    .from('bucketizer_classifications')
    .update({ evidence_run_at: null, evidence_failed: null })
    .eq('matterspace_id', matterId)
    .not('evidence_failed', 'is', null)
    .select('id');
  if (error) throw friendly(error);
  return (data ?? []).length;
}

// ---------------------------------------------------------------------------
// The effects the runner needs
// ---------------------------------------------------------------------------

export function supabaseEvidenceDeps(input: {
  matterId: string;
  modelId: string;
  signal?: AbortSignal;
}): EvidenceDeps {
  return {
    async fetchPassages(passageIds: string[]): Promise<EvidencePassageRow[]> {
      if (!passageIds.length) return [];
      const { data, error } = await supabase
        .from('passages')
        .select('id, text, page_start, page_end, line_start, line_end, witness_name, sequence_number, metadata')
        .in('id', passageIds)
        .order('sequence_number')
        .order('id');
      if (error) throw friendly(error);
      return (data ?? []) as EvidencePassageRow[];
    },

    async call(call) {
      const { raw } = await callStructured({
        modelId: input.modelId,
        system: call.system,
        userContent: call.userContent,
        toolName: EVIDENCE_TOOL_NAME,
        toolDescription: EVIDENCE_TOOL_DESCRIPTION,
        inputSchema: EVIDENCE_SCHEMA,
        maxTokens: call.maxTokens,
        matterId: input.matterId,
        signal: input.signal,
        // For the matter's Record: the act, and the document whose passages
        // are being read for a quotation. Ids only, never the excerpt.
        feature: 'bucketizer.evidence',
        documentIds: [call.documentId],
      });
      return raw;
    },

    /**
     * Rows first, then the run mark.
     *
     * In that order on purpose: if the write of the mark fails, the pair looks
     * un-run and is read again — one repeated call. The other order would
     * record the pair as done and lose the evidence, which is the same money
     * spent for nothing plus a bucket that reads as reviewed and empty.
     * `ignoreDuplicates` protects a quotation the attorney has already decided
     * on from being reset to 'proposed' by a re-run.
     */
    async savePair(save: SavePairInput): Promise<void> {
      if (save.items.length) {
        const { error } = await supabase
          .from('bucketizer_evidence')
          .upsert(
            save.items.map((item) => ({
              ...item,
              matterspace_id: input.matterId,
              model_id: input.modelId,
            })),
            { onConflict: 'node_id,passage_id', ignoreDuplicates: true },
          );
        if (error) throw friendly(error);
      }
      const { error: markError } = await supabase
        .from('bucketizer_classifications')
        .update({
          evidence_run_at: save.at,
          evidence_model: input.modelId,
          evidence_failed: save.failed,
        })
        .eq('id', save.pair.classificationId);
      if (markError) throw friendly(markError);
    },
  };
}

/**
 * Run the pass over a matter's confirmed pairings.
 *
 * `nodes` is the tree as the surface already has it; the ancestor chain is
 * assembled here so the model sees where the issue sits ("Excessive force ›
 * Objective unreasonableness › Pre-assault status") rather than a bare label.
 */
export async function runEvidenceForMatter(input: {
  matterId: string;
  pairs: EvidencePair[];
  nodes: { id: string; parent_id: string | null; kind: string; label: string; description: string | null }[];
  modelId?: string;
  signal?: AbortSignal;
  deps?: EvidenceDeps;
  onProgress?: (p: EvidenceProgress) => void;
}): Promise<EvidenceProgress> {
  const modelId = input.modelId ?? BUCKETIZER_DEFAULT_MODEL;
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const nodesById = new Map<string, EvidenceNode>();
  for (const node of input.nodes) {
    const ancestors: { kind: string; label: string }[] = [];
    let parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    let guard = 0;
    while (parent && guard++ < 12) {
      ancestors.unshift({ kind: parent.kind, label: parent.label });
      parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
    }
    nodesById.set(node.id, {
      id: node.id, label: node.label, kind: node.kind, description: node.description, ancestors,
    });
  }

  return runEvidencePass({
    pairs: input.pairs,
    nodesById,
    deps: input.deps ?? supabaseEvidenceDeps({ matterId: input.matterId, modelId, signal: input.signal }),
    modelId,
    signal: input.signal,
    onProgress: input.onProgress,
  });
}

export type { EvidenceProgress } from './evidence-run';
export type { EvidenceEstimate } from './evidence-estimate';

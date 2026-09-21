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
} from '../../../lib/bucketizer-core.mjs';
import {
  buildRepairContent,
  labelKey,
  runWithContract,
  trimmedText,
  type ContractAttempt,
  type ContractCheck,
} from '@/lib/llm/contract';
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
import {
  freshCandidates,
  planClassificationWrites,
  sentinelAfterRun,
  type ProposedClassification,
} from './chooser';
import { fetchExistingClassifications, loadChooserInventory } from './inventory';

export const BUCKETIZER_DEFAULT_MODEL = 'claude-opus-4-8';

export { LlmCallError } from './llm-error';
export { formatCents } from './estimate';
export type { RunEstimate } from './estimate';
export type { DocOutcome } from './classify-run';
export { loadChooserInventory } from './inventory';
export {
  choosableIn,
  classifyAction,
  docRowsForRun,
  freshCandidateRows,
  groupChosen,
  reclassifyNotices,
  summarizeChosen,
  NOTHING_NEW_MESSAGE,
} from './chooser';
export type { ChooserRow, ChooserState, ChosenSummary } from './chooser';

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

/**
 * THE OUTPUT CONTRACT FOR A CASE-THEORY TREE.
 *
 * Until this existed the tree call checked one thing — `result.claims.length`
 * — and then walked the answer inserting rows. On frontier Claude that was
 * nearly always enough. Inside a SEALED matter every feature call is answered
 * by the sealed pen (Kimi K2.5), which holds a forced-tool contract less
 * literally, and "nearly always" becomes a bucket in the attorney's tree whose
 * label is `undefined`, or the same element typed twice, or a claim whose
 * elements arrived as a flat list with parent references. Each of those is
 * written to `bucketizer_nodes` and has to be deleted by hand.
 *
 * So: validated whole BEFORE the first insert, which is also what makes
 * "nothing is persisted from a failed attempt" true rather than hoped for.
 */
export const TREE_MAX_CLAIMS = 24;
export const TREE_MAX_ELEMENTS_PER_CLAIM = 24;
export const TREE_MAX_SUBISSUES_PER_ELEMENT = 24;
export const TREE_MAX_THEMES = 32;
/** Every node the answer would create. A tree past this is not a working tree. */
export const TREE_MAX_NODES = 400;
export const TREE_MAX_LABEL_CHARS = 300;

interface CheckedTreeNode {
  label: string;
  description: string | null;
}
export interface CheckedTreeElement extends CheckedTreeNode {
  subissues: CheckedTreeNode[];
}
export interface CheckedTreeClaim extends CheckedTreeNode {
  elements: CheckedTreeElement[];
}
export interface CheckedTree {
  claims: CheckedTreeClaim[];
  themes: CheckedTreeNode[];
  /** How many `bucketizer_nodes` rows this answer would create. */
  nodeCount: number;
}

/** A label/description pair, or the reason it is not one. */
function checkNode(value: unknown, where: string): ContractCheck<CheckedTreeNode> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: `${where} was not an object` };
  }
  const n = value as Record<string, unknown>;
  const label = trimmedText(n.label);
  if (!label) return { ok: false, reason: `${where} has no label` };
  if (label.length > TREE_MAX_LABEL_CHARS) {
    return { ok: false, reason: `the label for ${where} is longer than ${TREE_MAX_LABEL_CHARS} characters` };
  }
  if (n.description != null && typeof n.description !== 'string') {
    return { ok: false, reason: `the description for ${where} was not text` };
  }
  return { ok: true, value: { label, description: trimmedText(n.description) } };
}

/** An array field that may be absent, but may not be something else. */
function checkList(value: unknown, where: string, cap: number): ContractCheck<unknown[]> {
  if (value == null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, reason: `${where} was not an array` };
  if (value.length > cap) {
    return { ok: false, reason: `${where} holds ${value.length} entries — no more than ${cap} are accepted` };
  }
  return { ok: true, value };
}

/** Siblings that are the same bucket typed twice. */
function firstDuplicate(labels: string[]): string | null {
  const seen = new Set<string>();
  for (const label of labels) {
    const key = labelKey(label);
    if (seen.has(key)) return label;
    seen.add(key);
  }
  return null;
}

/**
 * REFERENTIAL INTEGRITY, for a shape that carries no refs.
 *
 * The tree's parent relation is the NESTING — an element is inside its claim.
 * The failure mode worth naming is a model that flattens it: a `nodes` array,
 * or claims carrying `parent` / `parent_ref` fields, with the hierarchy
 * expressed as references. Some of those references then point at nothing.
 * That shape is REFUSED, never adopted: repairing a flattened answer here
 * would be this module guessing at a case-theory tree, and a bucket the
 * attorney never approved is exactly what must not reach the database.
 */
function describeFlattened(raw: Record<string, unknown>): string | null {
  const flat = Array.isArray(raw.nodes) ? raw.nodes
    : Array.isArray(raw.elements) ? raw.elements
      : null;
  if (!flat) return null;
  const known = new Set<string>();
  for (const item of flat) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Record<string, unknown>;
    for (const key of ['id', 'ref', 'label']) {
      const v = trimmedText(n[key]);
      if (v) known.add(labelKey(v));
    }
  }
  let dangling = 0;
  for (const item of flat) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Record<string, unknown>;
    const parent = trimmedText(n.parent) ?? trimmedText(n.parent_id) ?? trimmedText(n.parent_ref);
    if (parent && !known.has(labelKey(parent))) dangling += 1;
  }
  return `the answer was a flat list of ${flat.length} nodes with parent references`
    + (dangling ? ` (${dangling} of them naming a parent that is not in the answer)` : '')
    + `, not the nested claims → elements → subissues shape`;
}

export function checkTreeContract(raw: unknown): ContractCheck<CheckedTree> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'the answer was not an object' };
  }
  const root = raw as Record<string, unknown>;

  if (!Array.isArray(root.claims)) {
    const flattened = describeFlattened(root);
    if (flattened) return { ok: false, reason: flattened };
    return { ok: false, reason: 'no "claims" array' };
  }
  if (!root.claims.length) return { ok: false, reason: 'the "claims" array was empty' };
  if (root.claims.length > TREE_MAX_CLAIMS) {
    return { ok: false, reason: `${root.claims.length} claims — no more than ${TREE_MAX_CLAIMS} are accepted` };
  }

  // A claim that names a parent has been flattened into the claims array.
  const claimKeys = new Set<string>();
  for (const entry of root.claims) {
    if (!entry || typeof entry !== 'object') continue;
    const label = trimmedText((entry as Record<string, unknown>).label);
    if (label) claimKeys.add(labelKey(label));
  }
  for (let i = 0; i < root.claims.length; i++) {
    const entry = root.claims[i];
    if (!entry || typeof entry !== 'object') continue;
    const n = entry as Record<string, unknown>;
    const parent = trimmedText(n.parent) ?? trimmedText(n.parent_id) ?? trimmedText(n.parent_ref);
    if (parent) {
      // A claim has no parent in this schema. Whether the ref resolves or
      // dangles, the hierarchy has been flattened into references and the
      // nesting no longer says what belongs to what — so an "element" sitting
      // in `claims` would become a top-level bucket. Refused either way; the
      // dangling count is named because it is the more obvious symptom.
      const dangles = !claimKeys.has(labelKey(parent));
      return {
        ok: false,
        reason: `claim ${i + 1} names a parent "${parent}"`
          + (dangles ? ' that is not in the answer' : '')
          + ' — a claim has no parent; elements belong inside their claim, not beside it with a reference',
      };
    }
  }

  const claims: CheckedTreeClaim[] = [];
  let nodeCount = 0;
  for (let i = 0; i < root.claims.length; i++) {
    const where = `claim ${i + 1}`;
    const claim = checkNode(root.claims[i], where);
    if (!claim.ok) return claim;
    nodeCount += 1;

    const elementList = checkList(
      (root.claims[i] as Record<string, unknown>).elements,
      `the elements of ${where}`,
      TREE_MAX_ELEMENTS_PER_CLAIM,
    );
    if (!elementList.ok) return elementList;

    const elements: CheckedTreeElement[] = [];
    for (let j = 0; j < elementList.value.length; j++) {
      const elWhere = `element ${j + 1} of ${where}`;
      const element = checkNode(elementList.value[j], elWhere);
      if (!element.ok) return element;
      nodeCount += 1;

      const subList = checkList(
        (elementList.value[j] as Record<string, unknown>).subissues,
        `the subissues of ${elWhere}`,
        TREE_MAX_SUBISSUES_PER_ELEMENT,
      );
      if (!subList.ok) return subList;

      const subissues: CheckedTreeNode[] = [];
      for (let k = 0; k < subList.value.length; k++) {
        const sub = checkNode(subList.value[k], `subissue ${k + 1} of ${elWhere}`);
        if (!sub.ok) return sub;
        nodeCount += 1;
        subissues.push(sub.value);
      }
      const dupSub = firstDuplicate(subissues.map((s) => s.label));
      if (dupSub) return { ok: false, reason: `${elWhere} has two subissues labelled "${dupSub}"` };

      elements.push({ ...element.value, subissues });
    }
    const dupEl = firstDuplicate(elements.map((e) => e.label));
    if (dupEl) return { ok: false, reason: `${where} has two elements labelled "${dupEl}"` };

    claims.push({ ...claim.value, elements });
  }
  const dupClaim = firstDuplicate(claims.map((c) => c.label));
  if (dupClaim) return { ok: false, reason: `two claims share the label "${dupClaim}"` };

  const themeList = checkList(root.themes, 'the "themes" array', TREE_MAX_THEMES);
  if (!themeList.ok) return themeList;
  const themes: CheckedTreeNode[] = [];
  for (let i = 0; i < themeList.value.length; i++) {
    const theme = checkNode(themeList.value[i], `theme ${i + 1}`);
    if (!theme.ok) return theme;
    nodeCount += 1;
    themes.push(theme.value);
  }
  const dupTheme = firstDuplicate(themes.map((t) => t.label));
  if (dupTheme) return { ok: false, reason: `two themes share the label "${dupTheme}"` };

  if (nodeCount > TREE_MAX_NODES) {
    return { ok: false, reason: `the tree holds ${nodeCount} buckets — no more than ${TREE_MAX_NODES} are accepted` };
  }

  return { ok: true, value: { claims, themes, nodeCount } };
}

/** The tree's single repair turn. */
export function buildTreeRepairContent(original: string, reason: string, sent: unknown): string {
  return buildRepairContent({
    original,
    reason,
    sent,
    shape:
      `{"claims":[{"label":"<the cause of action>","description":"<one or two sentences>",`
      + `"elements":[{"label":"<an element of that claim>","description":"<routing criteria>",`
      + `"subissues":[{"label":"<a contested subissue>","description":"<routing criteria>"}]}]}],`
      + `"themes":[{"label":"<a cross-cutting theme>","description":"<routing criteria>"}]}`,
    rules:
      `Every claim, element, subissue and theme is an object with a non-empty "label" and a "description". `
      + `Nest elements inside their claim and subissues inside their element — do not send a flat list with `
      + `parent references, and do not repeat a label among siblings.`,
  });
}

/**
 * The sentence the surface shows when the tree could not be read, twice.
 * Deliberately says what did NOT happen: nothing in the matter changed.
 */
export const TREE_CONTRACT_FAILURE =
  'The model’s answer could not be read as a case-theory tree. Nothing was changed. '
  + 'Try again, or build the tree by hand.';

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

  const userContent = buildTreeUserContent(pleadings);

  // The repair turn is the SAME call: same model, same system prompt, same
  // tool and schema, same allowance, and the same 'bucketizer.tree' label — so
  // it is metered and written to the matter's Record exactly like the first.
  // A 402, a 429 or a sealed refusal throws straight through `runWithContract`
  // and reaches the surface as the server's own sentence.
  const call = async ({ userContent: content }: ContractAttempt) => generateStructured<unknown>({
    modelId: input.modelId ?? BUCKETIZER_DEFAULT_MODEL,
    system: TREE_SYSTEM,
    userContent: content,
    toolName: TREE_TOOL_NAME,
    toolDescription: TREE_TOOL_DESCRIPTION,
    inputSchema: TREE_SCHEMA,
    maxTokens: 16_000,
    signal: input.signal,
    matterId: input.matterId,
    // For the matter's Record: the act, and the pleadings it was performed on.
    // Ids only — the Record never carries a title or a word of the text.
    feature: 'bucketizer.tree',
    documentIds: input.pleadingDocIds,
  });

  const outcome = await runWithContract<CheckedTree>({
    userContent,
    call,
    validate: checkTreeContract,
    repair: buildTreeRepairContent,
  });

  // NOTHING HAS BEEN WRITTEN YET, and on this path nothing will be. The
  // insert loop below is the first write in this function, so a failed answer
  // leaves the existing tree — every node, every classification hanging off
  // it — exactly as the attorney left it.
  if (!outcome.ok) {
    throw new Error(`${TREE_CONTRACT_FAILURE} (Twice: ${outcome.reason}.)`);
  }
  const result: CheckedTree = outcome.value;

  // Insert level by level so parent ids exist before children reference them.
  const created: BucketNode[] = [];
  let rootPos = 0;
  for (const claim of result.claims) {
    const claimNode = await createNode({
      matterId: input.matterId,
      parentId: null,
      kind: 'claim',
      label: claim.label,
      description: claim.description ?? undefined,
      position: rootPos++,
      origin: 'generated',
    });
    created.push(claimNode);
    let elPos = 0;
    for (const el of claim.elements) {
      const elNode = await createNode({
        matterId: input.matterId,
        parentId: claimNode.id,
        kind: 'element',
        label: el.label,
        description: el.description ?? undefined,
        position: elPos++,
        origin: 'generated',
      });
      created.push(elNode);
      let subPos = 0;
      for (const sub of el.subissues) {
        created.push(await createNode({
          matterId: input.matterId,
          parentId: elNode.id,
          kind: 'subissue',
          label: sub.label,
          description: sub.description ?? undefined,
          position: subPos++,
          origin: 'generated',
        }));
      }
    }
  }
  for (const theme of result.themes) {
    created.push(await createNode({
      matterId: input.matterId,
      parentId: null,
      kind: 'theme',
      label: theme.label,
      description: theme.description ?? undefined,
      position: rootPos++,
      origin: 'generated',
    }));
  }

  // REMEMBER WHICH DOCUMENTS THE TREE CAME FROM.
  //
  // Nothing recorded this, and the omission had teeth: a pleading the tree was
  // drawn from carries no classification rows, so it sat in "documents not yet
  // classified" as though it were a new upload. Eden added one document, was
  // asked to run "1 document", ran it, and the classifier read the COMPLAINT —
  // his upload was still processing, and the complaint was the only ready
  // document with no rows.
  //
  // The mark goes on `documents.metadata.bucketizer`, the blob this module
  // already owns on that row (`run`, `coverage`, `no_buckets_at`), so no
  // migration and no new column. It is a LABEL, not a ban: the chooser shows
  // these documents, says what they are, and lets the attorney pick them —
  // filing the complaint under the claims it pleads is a reasonable thing to
  // want. It only keeps them out of "everything not yet classified".
  //
  // Trees generated BEFORE this shipped recorded nothing, so their pleadings
  // are unmarked until the tree is regenerated. The chooser names every
  // document either way, which is what stops the silent version of this.
  for (const docId of input.pleadingDocIds) {
    try {
      await writeBucketizerMeta(docId, (prior) => ({
        ...prior,
        tree_source_at: new Date().toISOString(),
      }));
    } catch (e) {
      // The tree is built and saved; failing to label its sources is not worth
      // throwing that away. The chooser still shows the document by name.
      console.warn('bucketizer: could not mark a tree source', docId, e);
    }
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
 * Documents in the matter AND its sub-matters that have not been examined yet
 * — ready, holding text, with no classification rows, no "no buckets fit"
 * sentinel, and not one of this matter's own filed outlines.
 *
 * The tree belongs to the matter, but the documents it files can sit in
 * sub-matters (Fleming's depositions and medical records do); until 2026-09-09
 * this read the matter's own rows only, and no deposition was ever a
 * candidate. The same expansion search uses.
 *
 * The predicate now lives in `chooser.ts` and is shared with the chooser's
 * list, so the number on the button and the state printed beside each row
 * cannot drift apart. Two consequences of that move, both deliberate:
 *
 *  - a ready document whose ingestion recorded that it holds NO TEXT (an
 *    image-only scan, a recording without a transcript) is no longer counted.
 *    It used to sit in this list forever: the button said "(5)", every run
 *    read nothing, wrote nothing and reported nothing, and the count never
 *    moved. It is now shown in the chooser with the reason instead;
 *  - a document still being ingested is named in the chooser rather than
 *    being silently absent from it.
 */
export async function listUnclassifiedDocs(matterId: string): Promise<DocRow[]> {
  const inventory = await loadChooserInventory(matterId);
  return freshCandidates(inventory.rows);
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

    /**
     * Write the document's rows — and, on a document that has been classified
     * before, write only what a re-run is allowed to.
     *
     * The rule, decided in `planClassificationWrites` and enforced twice: a
     * CONFIRMED or REJECTED row is an attorney's decision and is never
     * overwritten and never deleted; an undecided proposal is refreshed from
     * the new read; a bucket the document is not yet in gets a new row. The
     * `status = 'proposed'` filter rides on the UPDATE itself, so a row
     * confirmed in another tab while this run was in flight is not overwritten
     * by a refresh planned a minute ago.
     */
    async finish(documentId, result): Promise<void> {
      const existing = await fetchExistingClassifications(documentId);
      const proposed: ProposedClassification[] = result.rows.map((r: MergedAssignment) => ({
        node_id: r.node_id,
        confidence: r.confidence,
        rationale: r.rationale,
        passage_ids: r.passage_ids,
      }));
      const plan = planClassificationWrites(existing, proposed);

      if (plan.insert.length) {
        // `ignoreDuplicates` is kept for the race the plan cannot see: a row
        // created between the read above and this insert.
        const { error } = await supabase
          .from('bucketizer_classifications')
          .upsert(
            plan.insert.map((r) => ({
              ...r,
              matterspace_id: input.matterId,
              document_id: documentId,
              status: 'proposed',
              model_id: input.modelId,
            })),
            { onConflict: 'document_id,node_id', ignoreDuplicates: true },
          );
        if (error) throw new Error(error.message);
      }

      for (const { id, row } of plan.refresh) {
        const { error } = await supabase
          .from('bucketizer_classifications')
          .update({
            confidence: row.confidence,
            rationale: row.rationale,
            passage_ids: row.passage_ids,
            model_id: input.modelId,
            proposed_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('status', 'proposed');
        if (error) throw new Error(error.message);
      }

      // `run` is replaced by `coverage`: the working state goes, the record of
      // how much of the document was read stays. The "examined, no bucket"
      // sentinel is set only when the document ends this run in no bucket at
      // all — and CLEARED otherwise, so a re-read that finally finds a bucket
      // does not leave behind a flag saying nothing fitted.
      const sentinel = sentinelAfterRun({
        existingRows: existing.length,
        writtenRows: result.rows.length,
        completedAt: result.coverage.completed_at,
      });
      await writeBucketizerMeta(documentId, (prior) => {
        const next: Record<string, unknown> = { ...prior, coverage: result.coverage };
        delete next.run;
        if (sentinel) next.no_buckets_at = sentinel;
        else delete next.no_buckets_at;
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
        // For the matter's Record. Every window of a document is one call, so
        // a long deposition leaves several rows naming the same document —
        // which is what happened, and is what the Record should say.
        feature: 'bucketizer.classify',
        documentIds: [call.documentId],
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
      // A document with no passages is not an error and not a success, and it
      // used to be neither: the run read it, wrote nothing, and said nothing.
      // A person watching a run finish with no proposals is owed the reason.
      if (outcome.status === 'no_text') {
        progress.notes.push(
          `${doc.title}: no text to read — an image-only scan, a recording, or a file still `
          + 'awaiting OCR. It was not classified.',
        );
      }
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

// Generating the trial outline: gather, assemble, render, file.
//
// The assembly itself is in `outline-model.ts` and is pure — this file is
// everything around it that talks to the database or the Vault.
//
// FILED, NOT DOWNLOADED. The outline is work product about the matter, so it
// goes into the matter: both files are uploaded through the same Vault path
// any other document takes (`persistVaultFile`), which means the .md is
// ingested and becomes searchable next to the record it cites, and the .docx
// sits beside it for the binder. The download is offered as well, because an
// attorney who wants the file in Word now should not have to go and fetch it.
//
// EVERY RUN IS A NEW VERSION. The filename carries the date and the minute, so
// a second run this afternoon files a second document rather than replacing
// this morning's. Nothing filed is ever overwritten: what the outline said
// last week is part of the record of how the case was worked.

import { supabase } from '@/lib/supabase';
import { fetchPaged } from '@/lib/paged';
import { persistVaultFile, resolveMatter } from '@/lib/vault-persist';
import { downloadBlob } from '@/lib/export-page';
import {
  buildOutline,
  outlineFilename,
  type OutlineClassification,
  type OutlineDocument,
  type OutlineEvidenceRow,
  type OutlineModel,
  type OutlinePassage,
  type OutlineTreeNode,
} from './outline-model';
import { renderOutlineMarkdown } from './outline-md';
import { renderOutlineDocx } from './outline-docx';

const CHUNK = 100;

function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function fail(message: string): Error {
  if (/evidence_run_at|evidence_failed|evidence_model|bucketizer_evidence/.test(message)) {
    return new Error(
      'The evidence tables are not installed on this database yet. Apply migration '
      + '068_bucketizer_evidence.sql, then try again.',
    );
  }
  return new Error(message);
}

// ---------------------------------------------------------------------------
// Gather
// ---------------------------------------------------------------------------

export interface GatheredOutline {
  nodes: OutlineTreeNode[];
  classifications: OutlineClassification[];
  evidence: OutlineEvidenceRow[];
  documents: OutlineDocument[];
  passages: OutlinePassage[];
}

/**
 * Everything the outline is built from, in a handful of paged reads.
 *
 * Paged throughout, with `.order('id')` as the unique tiebreaker on every one:
 * a matter's classifications pass a thousand rows as soon as a real corpus is
 * classified, and an outline silently built from the first thousand would be
 * the worst kind of wrong — complete-looking and short.
 */
export async function gatherOutline(matterId: string): Promise<GatheredOutline> {
  try {
    const { data: nodeRows, error: nodeError } = await supabase
      .from('bucketizer_nodes')
      .select('id, parent_id, kind, label, description, position')
      .eq('matterspace_id', matterId)
      .order('position')
      .order('id');
    if (nodeError) throw new Error(nodeError.message);
    const nodes = (nodeRows ?? []) as OutlineTreeNode[];

    const { rows: classifications } = await fetchPaged<OutlineClassification>(
      (from, to) => supabase
        .from('bucketizer_classifications')
        .select('id, node_id, document_id, status, confidence, rationale, evidence_run_at, evidence_failed')
        .eq('matterspace_id', matterId)
        .neq('status', 'rejected')
        .order('id')
        .range(from, to),
      { label: 'classifications', ceiling: 200_000 },
    );

    const { rows: evidence } = await fetchPaged<OutlineEvidenceRow>(
      (from, to) => supabase
        .from('bucketizer_evidence')
        .select('id, node_id, document_id, passage_id, quote, rationale, status, position')
        .eq('matterspace_id', matterId)
        .neq('status', 'rejected')
        .order('id')
        .range(from, to),
      { label: 'evidence', ceiling: 200_000 },
    );

    const documentIds = [...new Set([
      ...classifications.map((c) => c.document_id),
      ...evidence.map((e) => e.document_id),
    ])];
    const documents: OutlineDocument[] = [];
    for (const ids of chunk(documentIds)) {
      const { data, error } = await supabase
        .from('documents')
        .select('id, title, doc_type, witness_name')
        .in('id', ids);
      if (error) throw new Error(error.message);
      documents.push(...((data ?? []) as OutlineDocument[]));
    }

    const passageIds = [...new Set(evidence.map((e) => e.passage_id))];
    const passages: OutlinePassage[] = [];
    for (const ids of chunk(passageIds)) {
      const { data, error } = await supabase
        .from('passages')
        .select('id, page_start, page_end, line_start, line_end, witness_name, metadata')
        .in('id', ids);
      if (error) throw new Error(error.message);
      passages.push(...((data ?? []) as OutlinePassage[]));
    }

    return { nodes, classifications, evidence, documents, passages };
  } catch (e) {
    throw fail(e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Generate, render, file
// ---------------------------------------------------------------------------

export interface OutlineResult {
  model: OutlineModel;
  markdown: string;
  docx: Blob;
  mdFilename: string;
  docxFilename: string;
  mdDocumentId: string | null;
  docxDocumentId: string | null;
  /** Anything that did not go to plan, in words. */
  notes: string[];
}

export interface GenerateOutlineInput {
  matterId: string;
  /**
   * Counsel has reviewed the evidence and the DRAFT legend comes off.
   *
   * There is no stored "reviewed" flag, deliberately. The legend is baked into
   * a file that is then immutable, so the only honest moment to decide whether
   * it belongs is the moment the file is written — and a sticky flag set three
   * weeks and two hundred new documents ago would quietly strip the legend
   * from an outline nobody had looked at.
   */
  reviewed?: boolean;
  /** Injected so a test can produce the same bytes twice. */
  now?: () => Date;
  onProgress?: (message: string) => void;
}

export async function generateOutline(input: GenerateOutlineInput): Promise<OutlineResult> {
  const say = input.onProgress ?? (() => {});
  const generatedAt = (input.now?.() ?? new Date()).toISOString();

  say('Reading the tree, the classifications and the confirmed evidence…');
  const matter = await resolveMatter(input.matterId);
  if (!matter) throw new Error('That matter could not be opened.');
  const gathered = await gatherOutline(input.matterId);

  say('Assembling the outline…');
  const model = buildOutline({
    matter: { id: matter.id, title: matter.name, shortCode: matter.short_code ?? null },
    ...gathered,
    generatedAt,
    reviewedAt: input.reviewed ? generatedAt : null,
  });

  const markdown = renderOutlineMarkdown(model);
  const docx = await renderOutlineDocx(model);
  const mdFilename = outlineFilename(model, '.md');
  const docxFilename = outlineFilename(model, '.docx');

  const notes: string[] = [];
  let mdDocumentId: string | null = null;
  let docxDocumentId: string | null = null;

  // Filing is best-effort in one direction only: if it fails, the attorney
  // still gets the files, and the failure is reported rather than swallowed.
  say('Filing the outline into the matter…');
  try {
    const filed = await persistVaultFile(
      matter,
      new File([markdown], mdFilename, { type: 'text/markdown' }),
    );
    mdDocumentId = filed.documentId;
  } catch (e) {
    notes.push(`The Markdown copy could not be filed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const filed = await persistVaultFile(
      matter,
      new File(
        [docx],
        docxFilename,
        { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      ),
    );
    docxDocumentId = filed.documentId;
  } catch (e) {
    notes.push(`The Word copy could not be filed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { model, markdown, docx, mdFilename, docxFilename, mdDocumentId, docxDocumentId, notes };
}

/** Hand the attorney both files now, without waiting for ingestion. */
export function downloadOutline(result: OutlineResult): void {
  downloadBlob(new Blob([result.markdown], { type: 'text/markdown' }), result.mdFilename);
  downloadBlob(result.docx, result.docxFilename);
}

/**
 * Outlines already filed into this matter, newest first.
 *
 * Found by title, not by a metadata flag: `persistVaultFile` fires ingestion
 * without waiting, and ingestion rewrites `documents.metadata`, so a marker
 * written here a moment later would race it. The filename is the version, and
 * it is stable.
 */
export async function listFiledOutlines(
  matterId: string,
  matterTitle: string,
): Promise<{ id: string; title: string; createdAt: string }[]> {
  const prefix = `${matterTitle.slice(0, 40)}`;
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, created_at')
    .eq('matterspace_id', matterId)
    .ilike('title', `%Trial Outline%`)
    .order('created_at', { ascending: false })
    .limit(25);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((d) => String(d.title ?? '').startsWith(prefix.slice(0, 8)))
    .map((d) => ({ id: d.id as string, title: d.title as string, createdAt: d.created_at as string }));
}

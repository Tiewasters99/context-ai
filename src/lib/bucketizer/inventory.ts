// The matter tree's documents, with what has happened to each one.
//
// One read, used twice: the number on "Classify new documents (N)" and the
// list the chooser shows are the same rows (see `chooser.ts` — one predicate,
// not two). The decisions are all in `chooser.ts`; this file only fetches.
//
// STRICT MATTER ISOLATION. The tree is `matterspace_descendants(matterId)` —
// this matter and its sub-matters, nothing else — and `buildChooserRows`
// filters to the same set a second time. Fleming's depositions and medical
// records live in sub-matters, so a matter-only read would offer none of them;
// a read any wider would offer another client's.

import { supabase } from '@/lib/supabase';
import { fetchPaged } from '@/lib/paged';
import {
  buildChooserRows,
  type ChooserClassification,
  type ChooserDocument,
  type ChooserRow,
  type ExistingClassification,
} from './chooser';

export interface ChooserInventory {
  /** The matter and its sub-matters. */
  matterIds: string[];
  rows: ChooserRow[];
  /** The document read stopped at its ceiling — the list is not all of it. */
  truncated: boolean;
  total: number;
}

/** This matter and every matter under it. The same expansion search uses. */
export async function fetchMatterTreeIds(matterId: string): Promise<string[]> {
  const { data } = await supabase.rpc('matterspace_descendants', { p_root: matterId });
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  if (!ids.includes(matterId)) ids.push(matterId);
  return ids;
}

export async function loadChooserInventory(matterId: string): Promise<ChooserInventory> {
  const matterIds = await fetchMatterTreeIds(matterId);

  // Every document, not only the ready ones: a scan still in OCR is shown
  // with the reason it cannot be chosen. Hiding it would leave a person who
  // uploaded it ten minutes ago looking for it.
  const docs = await fetchPaged<ChooserDocument>(
    (from, to) => supabase
      .from('documents')
      // One string literal, deliberately: supabase-js parses the select at the
      // type level, and a concatenated string comes back as `GenericStringError`.
      .select('id, title, doc_type, page_count, metadata, processing_status, processing_error, matterspace_id, text_status:metadata->>text_status', from === 0 ? { count: 'exact' } : undefined)
      .in('matterspace_id', matterIds)
      .order('id')
      .range(from, to),
    { label: 'matter documents', ceiling: 100_000 },
  );

  const [classifications, matterNames] = await Promise.all([
    fetchClassificationsFor(docs.rows.map((d) => d.id)),
    fetchMatterNames(matterIds),
  ]);

  return {
    matterIds,
    rows: buildChooserRows({ matterIds, documents: docs.rows, classifications, matterNames }),
    truncated: docs.truncated,
    total: docs.total,
  };
}

/** The tree's matter names, so a chosen document says where it lives. */
async function fetchMatterNames(matterIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < matterIds.length; i += 200) {
    const { data, error } = await supabase
      .from('matterspaces')
      .select('id, name')
      .in('id', matterIds.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as { id: string; name: string }[]) names.set(row.id, row.name);
  }
  return names;
}

/**
 * The classification rows those documents carry.
 *
 * Chunked AND paged, for the reason #168 found the hard way: 200 documents can
 * hold well over 1,000 classification rows, PostgREST returns the first 1,000
 * and says nothing, and every document past the cut reads back as
 * unclassified — so it is classified again and charged again.
 */
async function fetchClassificationsFor(documentIds: string[]): Promise<ChooserClassification[]> {
  const out: ChooserClassification[] = [];
  for (let i = 0; i < documentIds.length; i += 100) {
    const ids = documentIds.slice(i, i + 100);
    if (!ids.length) continue;
    const { rows } = await fetchPaged<ChooserClassification>(
      (from, to) => supabase
        .from('bucketizer_classifications')
        .select('document_id, status, proposed_at, decided_at, id')
        .in('document_id', ids)
        .order('id')
        .range(from, to),
      { label: 'classification membership', ceiling: 100_000 },
    );
    out.push(...rows);
  }
  return out;
}

/**
 * One document's existing classification rows, read immediately before the
 * run writes — so the write plan is made against what is on the row now, not
 * against an inventory taken when the chooser opened.
 */
export async function fetchExistingClassifications(
  documentId: string,
): Promise<ExistingClassification[]> {
  const { rows } = await fetchPaged<ExistingClassification>(
    (from, to) => supabase
      .from('bucketizer_classifications')
      .select('id, node_id, status')
      .eq('document_id', documentId)
      .order('id')
      .range(from, to),
    { label: 'existing classifications', ceiling: 10_000 },
  );
  return rows;
}

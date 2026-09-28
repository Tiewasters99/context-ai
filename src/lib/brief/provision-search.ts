// Where a provision's text sits inside the record: the passages of the
// matter tree that carry its patterns (provision-core.ts), grouped by
// document. Plain text matching through PostgREST, scoped by matter — no
// embedding, no model; RLS decides what the person may read.

import { supabase } from '@/lib/supabase';
import type { ProvisionQuery } from './provision-core';

export interface ProvisionHit {
  document_id: string;
  title: string;
  /** Passages that carry the provision, in page order; the first is what opens. */
  passages: { passage_id: string; page: number | null; snippet: string }[];
  /** The document is named for the number too (filed as "2203 Powers …"). */
  namedForIt: boolean;
}

const esc = (s: string) => s.replace(/[%_\\]/g, (c) => '\\' + c).replace(/[,()]/g, ' ');

/**
 * Documents in `matterIds` whose text carries the provision. `excludeDocumentId`
 * is the brief itself: it cites the section, it is not its text.
 */
export async function findProvisionInRecord(
  q: ProvisionQuery,
  matterIds: string[],
  excludeDocumentId: string | null,
  limit = 60,
): Promise<ProvisionHit[]> {
  if (!matterIds.length || !q.patterns.length) return [];
  const ors = q.patterns.map((p) => `text.ilike.%${esc(p)}%`).join(',');
  let query = supabase
    .from('passages')
    .select('id, document_id, page_start, text')
    .in('matterspace_id', matterIds)
    .eq('summary_level', 0)
    .or(ors)
    .limit(limit);
  if (excludeDocumentId) query = query.neq('document_id', excludeDocumentId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  type Row = { id: string; document_id: string; page_start: number | null; text: string | null };
  const rows = (data ?? []) as Row[];
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.document_id))];
  const { data: docs } = await supabase.from('documents').select('id, title, source_filename').in('id', ids);
  const titles = new Map(((docs ?? []) as { id: string; title: string | null; source_filename: string | null }[])
    .map((d) => [d.id, d.title || d.source_filename || 'Untitled document']));
  const needle = q.patterns[0].toLowerCase();
  const snippetOf = (t: string) => {
    const flat = t.replace(/\s+/g, ' ');
    const at = q.patterns.map((p) => flat.toLowerCase().indexOf(p.toLowerCase())).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? flat.toLowerCase().indexOf(needle);
    const start = Math.max(0, (at < 0 ? 0 : at) - 60);
    return (start > 0 ? '…' : '') + flat.slice(start, start + 180) + (flat.length > start + 180 ? '…' : '');
  };
  const byDoc = new Map<string, ProvisionHit>();
  for (const r of rows) {
    const hit = byDoc.get(r.document_id) ?? {
      document_id: r.document_id,
      title: titles.get(r.document_id) ?? 'Untitled document',
      passages: [],
      namedForIt: !!q.number && (titles.get(r.document_id) ?? '').includes(q.number),
    };
    hit.passages.push({ passage_id: r.id, page: r.page_start, snippet: snippetOf(r.text ?? '') });
    byDoc.set(r.document_id, hit);
  }
  const out = [...byDoc.values()];
  for (const h of out) h.passages.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
  // the section's own text first (named for it), then the documents that quote it most
  out.sort((a, b) => Number(b.namedForIt) - Number(a.namedForIt) || b.passages.length - a.passages.length || a.title.localeCompare(b.title));
  return out;
}

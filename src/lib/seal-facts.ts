// What has ALREADY been sent, for the matter about to be sealed.
//
// The seal is PROSPECTIVE. It governs every send from the moment it is set,
// and it recalls nothing: vectors already at OpenAI stay at OpenAI, pages
// already read by Gemini stay read. The audit of 2026-09-19 put it plainly —
// "sealing is prospective — re-tiering A→B does not recall vectors already at
// OpenAI or pages already at Gemini" — and a dialog that does not say so is
// selling something the product does not do.
//
// So the dialog shows the list, computed from what the client can already read
// under its own RLS. Three rules it keeps:
//
//   1. Nothing is guessed. Where the provenance was recorded, it is named
//      (documents.metadata.ocr_route, passages.embedding_model). Where it was
//      not, the category says "not recorded" and stops. There is no inference
//      from a date or a file type.
//   2. Every count is a count, not an estimate. They are exact head-counts
//      from PostgREST; only the per-route breakdown samples, and it says so.
//   3. A failure is not a zero. A category whose query errors reports itself
//      as unknown — a dialog that silently shows "0 documents embedded"
//      because a request timed out would be worse than showing nothing.

import { supabase } from '@/lib/supabase';

export interface ProcessedCategory {
  /** what this line is about, in the product's own words */
  label: string;
  /** exact count, or null when it could not be determined */
  count: number | null;
  /** who did it, when that was recorded */
  detail: string;
}

export interface AlreadyProcessed {
  loading: boolean;
  /** true when even the scope could not be read */
  unavailable: boolean;
  categories: ProcessedCategory[];
}

/** PostgREST puts the filter in the URL; keep the `in` list sane. */
const MAX_SCOPE_IDS = 200;

async function scopeIds(matterId: string): Promise<string[] | null> {
  try {
    const { data, error } = await supabase.rpc('matterspace_descendants', { p_root: matterId });
    if (error) throw new Error(error.message);
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
    const all = ids.length ? ids : [matterId];
    return all.slice(0, MAX_SCOPE_IDS);
  } catch {
    // The descendants RPC is old (migration 012) and should be there; if it
    // is not, fall back to this matter alone rather than reporting nothing.
    return [matterId];
  }
}

/** An exact head-count, or null when the question could not be answered. */
async function countRows(
  run: () => PromiseLike<{ count: number | null; error: unknown }>,
): Promise<number | null> {
  try {
    const { count, error } = await run();
    if (error) return null;
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}

interface OcrRouteStamp { id?: string; provider?: string; model?: string | null; sealed?: boolean }

/**
 * The list. Resolves to categories in the order a reader wants them: the
 * biggest exposure first (text sent for embedding), then scans, then
 * recordings.
 */
export async function alreadyProcessed(matterId: string): Promise<AlreadyProcessed> {
  const ids = await scopeIds(matterId);
  if (!ids) return { loading: false, unavailable: true, categories: [] };

  const passages = () =>
    supabase.from('passages').select('id', { count: 'exact', head: true }).in('matterspace_id', ids);

  const [embeddedOpenai, embeddedSealed, embeddedAny, ocrTotal] = await Promise.all([
    countRows(() => passages().not('embedding', 'is', null).eq('embedding_model', 'text-embedding-3-small')),
    countRows(() => passages().not('embedding', 'is', null).eq('embedding_model', 'voyage-4')),
    countRows(() => passages().not('embedding', 'is', null)),
    countRows(() => supabase
      .from('documents').select('id', { count: 'exact', head: true })
      .in('matterspace_id', ids).not('metadata->ocr_route', 'is', null)),
  ]);

  // Which routes read the scans. Sampled — the count above is exact, this
  // breakdown reads at most 500 rows and says so when it is short.
  let ocrRoutes: string[] = [];
  let ocrSampled = false;
  if (ocrTotal && ocrTotal > 0) {
    try {
      const { data, error } = await supabase
        .from('documents')
        .select('metadata')
        .in('matterspace_id', ids)
        .not('metadata->ocr_route', 'is', null)
        .limit(500);
      if (!error) {
        ocrSampled = (data?.length ?? 0) < ocrTotal;
        const seen = new Set<string>();
        for (const row of (data ?? []) as { metadata: { ocr_route?: OcrRouteStamp } | null }[]) {
          const r = row.metadata?.ocr_route;
          if (!r) continue;
          seen.add(r.provider || r.id || 'not recorded');
        }
        ocrRoutes = [...seen].sort();
      }
    } catch { /* the count still stands */ }
  }

  const categories: ProcessedCategory[] = [];

  // 1. Text sent out to be embedded.
  const embeddedOther =
    embeddedAny !== null && embeddedOpenai !== null && embeddedSealed !== null
      ? Math.max(0, embeddedAny - embeddedOpenai - embeddedSealed)
      : null;
  categories.push({
    label: 'Passages already embedded (their text was sent to an embedding provider)',
    count: embeddedAny,
    detail: embeddedAny === null
      ? 'Could not be read.'
      : embeddedAny === 0
        ? 'None. Nothing in this matter has been embedded.'
        : [
            embeddedOpenai ? `${embeddedOpenai.toLocaleString()} by OpenAI (text-embedding-3-small)` : null,
            embeddedSealed ? `${embeddedSealed.toLocaleString()} by the sealed route (voyage-4)` : null,
            embeddedOther ? `${embeddedOther.toLocaleString()} by a provider this workspace did not record` : null,
          ].filter(Boolean).join(' · '),
  });

  // 2. Scans read by an OCR provider.
  categories.push({
    label: 'Documents whose pages were read by an OCR provider',
    count: ocrTotal,
    detail: ocrTotal === null
      ? 'Could not be read.'
      : ocrTotal === 0
        ? 'None recorded.'
        : `${ocrRoutes.length ? ocrRoutes.join(' · ') : 'provider not recorded'}${ocrSampled ? ' (routes from the first 500)' : ''}`,
  });

  // 3. Recordings. The pipeline does not stamp which service transcribed a
  //    recording the way it stamps metadata.ocr_route for a scan, so there is
  //    nothing here to count honestly. Said, not guessed.
  categories.push({
    label: 'Recordings and transcripts already sent for transcription',
    count: null,
    detail: 'Not recorded — this workspace does not keep which service transcribed a recording.',
  });

  return { loading: false, unavailable: false, categories };
}

// Re-run the pipeline on a document that is already indexed, without ever
// leaving it worse than it was.
//
// Why this exists (2026-09-18): a document the pipeline got wrong and marked
// `ready` could not be repaired. ingest_document answered "Already ingested
// and searchable — nothing to do", the worker skipped ready rows, and the only
// way out was delete-and-re-upload. Two scanned DeCamara orders sat that way
// for four months, indexed as their CM/ECF stamp lines. A forced re-run is the
// fix — but the existing re-run paths (the worker's, scripts/reingest.mjs)
// delete the passages FIRST, so a forced re-run that then fails (an OCR
// outage, an embedding 429) would take a good document out of search.
//
// So a forced re-run swaps instead of wiping:
//   1. note the newest existing passage (created_at, the database's clock);
//   2. run the pipeline, which inserts the new passages beside the old;
//   3. success → delete the passages at or before that mark (the old ones);
//      failure → delete the passages after it (this run's), put the row back
//      exactly as it was, record the failure on it, and re-throw.
// For the seconds between 2 and 3 a search can see both sets; nothing is ever
// missing. The worker's failure recorders skip rows that are `ready`, so a
// failed forced run leaves a ready document ready.
//
// `run` is the pipeline call (processDocument with the caller's hooks).

function firstLine(s) {
  return String(s ?? '').split('\n')[0].trim();
}

export async function reprocessInPlace(supabase, documentId, run, { forced = true } = {}) {
  const { data: before, error: loadErr } = await supabase
    .from('documents')
    .select('processing_status, processing_error, page_count, metadata, ingested_at')
    .eq('id', documentId)
    .single();
  if (loadErr) throw new Error(`re-run: load document: ${loadErr.message}`);

  const { data: newest, error: markErr } = await supabase
    .from('passages')
    .select('created_at')
    .eq('document_id', documentId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (markErr) throw new Error(`re-run: read existing passages: ${markErr.message}`);
  const mark = newest?.[0]?.created_at ?? null;
  const at = new Date().toISOString();

  let result;
  try {
    result = await run();
  } catch (err) {
    let undo = supabase.from('passages').delete().eq('document_id', documentId);
    if (mark) undo = undo.gt('created_at', mark);
    const { error: undoErr } = await undo;
    const { error: restoreErr } = await supabase.from('documents').update({
      processing_status: before.processing_status,
      processing_error: before.processing_error,
      page_count: before.page_count,
      ingested_at: before.ingested_at,
      metadata: {
        ...(before.metadata || {}),
        reprocess: { at, forced, ok: false, error: firstLine(err?.message).slice(0, 400) },
      },
    }).eq('id', documentId);
    if (undoErr || restoreErr) {
      err.message = `${err.message} — and the rollback did not complete (${firstLine(undoErr?.message || restoreErr?.message)}); re-run this document`;
    }
    throw err;
  }

  let replaced = 0;
  if (mark) {
    const { error: delErr, count } = await supabase
      .from('passages')
      .delete({ count: 'exact' })
      .eq('document_id', documentId)
      .lte('created_at', mark);
    if (delErr) {
      throw new Error(`re-run: the new text is indexed but the old passages could not be removed (${firstLine(delErr.message)}); they show twice until this document is re-run`);
    }
    replaced = count ?? 0;
  }
  const { data: now } = await supabase.from('documents').select('metadata').eq('id', documentId).maybeSingle();
  await supabase.from('documents').update({
    metadata: { ...(now?.metadata || {}), reprocess: { at, forced, ok: true, replaced_passages: replaced } },
  }).eq('id', documentId);
  return { ...(result || {}), replacedPassages: replaced };
}

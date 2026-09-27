// "Confirm this brief" — the desk's cite-check run (slice D3; docs/specs/
// BRIEF-DESK-2026-09-26.md §3.3, B6).
//
//   snapshot → extract (one call, over toPlainText(body) — never body_md,
//   §3.2) → diff against the last run by cite_key + raw → checkOne for the
//   new and stale cites only → carry the rest forward with their flags →
//   one cite_check_runs row with snapshot_id → the D2 resolvers per entry →
//   `cite.checked` in the Record. "Re-check all" is the same path with the
//   diff switched off.
//
// Why not runCiteCheck(): it checks every cite it extracts (no way to skip
// the ones that have not changed, which is the whole of B6's saving), and the
// entries it saves carry the Bluebook form of a cite, not the words the draft
// has — the marks anchor on those words. So the desk composes the engine's own
// exported pieces (extractCitations, checkOne, the renderers, the tally) and
// src/lib/cite-check/* is untouched. The run row is the same table, the same
// columns, the same report shape plus three fields (raw, cite_key,
// carried_from, resolution); the Cite-Check tab reads it unchanged.
//
// Everything runs in this browser under the person's own session, like the
// Cite-Check tab: a long brief is dozens of model calls. matterId is passed
// to every model call, which is how a sealed matter's calls reach the sealed pen.

import { supabase } from '@/lib/supabase';
import { extractCitations } from '@/lib/cite-check/extract-cites';
import { checkOne } from '@/lib/cite-check/check';
import { linkAuthorityToMatter } from '@/lib/cite-check/persist';
import { renderReport, renderToa } from '@/lib/cite-check/render';
import { tallyFlags, type CheckResult, type Cite, type FlagCounts } from '@/lib/cite-check/types';
import { toPlainText, type BriefDoc } from './md';
import { takeSnapshot, recordEvent, type BriefMeta } from './draft-store';
import { resolveEntry } from './resolve';
import { citeKey, diffForConfirm, type DeskEntry, type StoredResolution } from './anchor';

const DEFAULT_MODEL_ID = 'claude-opus-4-8';

/** A desk run as the desk reads it back. */
export interface DeskRun {
  id: string;
  created_at: string;
  snapshot_id: string | null;
  counts: FlagCounts | null;
  entries: DeskEntry[];
}

export type ConfirmProgress =
  | { phase: 'snapshot' }
  | { phase: 'extracting'; done?: number; total?: number }
  | { phase: 'checking'; index: number; total: number; current: string; carried: number }
  | { phase: 'resolving'; index: number; total: number }
  | { phase: 'saving' };

export interface ConfirmOutcome {
  run: DeskRun;
  checked: number;
  carried: number;
  /** Cites in the last run that the brief no longer has. */
  dropped: number;
  /** Extracted cites the model named that are not in the text (the extractor's own contract). */
  setAside: number;
  snapshotPublished: boolean;
}

// ---------------------------------------------------------------------------
// Reading runs back
// ---------------------------------------------------------------------------

/** The latest complete desk run for this brief (a run with a snapshot), or null. */
export async function loadLatestRun(documentId: string): Promise<DeskRun | null> {
  const { data, error } = await supabase
    .from('cite_check_runs')
    .select('id, created_at, snapshot_id, counts, report')
    .eq('document_id', documentId)
    .eq('status', 'complete')
    .not('snapshot_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    // Before migration 100 the column does not exist; the desk simply has no runs.
    if (/snapshot_id/.test(error.message)) return null;
    throw new Error(error.message);
  }
  if (!data) return null;
  const row = data as { id: string; created_at: string; snapshot_id: string | null; counts: FlagCounts | null; report: unknown };
  const entries = Array.isArray(row.report) ? (row.report as DeskEntry[]).filter((e) => e && typeof e.raw === 'string') : [];
  return { id: row.id, created_at: row.created_at, snapshot_id: row.snapshot_id, counts: row.counts, entries };
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

function entryFromResult(r: CheckResult): DeskEntry {
  return {
    citation: r.cite.citation_bluebook ?? r.cite.raw ?? '(unknown)',
    case_name: r.cite.case_name,
    authority_type: r.cite.authority_type,
    proposition: r.cite.proposition,
    pin: r.cite.pin_cite,
    signal: r.cite.signal,
    flag: r.flag,
    verification_status: r.verification_status,
    rating: r.rating,
    source_label: r.source_label,
    source_url: r.source_url,
    note: r.justification,
    flags: r.flags,
    location: r.cite.location,
    authority_id: r.authority_id,
    raw: r.cite.raw ?? r.cite.citation_bluebook ?? '',
    cite_key: citeKey(r.cite.citation_bluebook ?? r.cite.raw, r.cite.pin_cite),
    carried_from: null,
    resolution: null,
  };
}

/** A carried entry as a CheckResult, for the tally and the two renderers. */
function resultFromEntry(e: DeskEntry): CheckResult {
  return {
    cite: {
      raw: e.raw,
      citation_bluebook: e.citation,
      case_name: e.case_name,
      court: null,
      year: null,
      pin_cite: e.pin,
      proposition: e.proposition,
      signal: e.signal,
      authority_type: e.authority_type,
      doctrinal_subject: [],
      location: e.location,
    },
    authority_id: e.authority_id,
    source_label: e.source_label,
    source_url: e.source_url,
    rating: e.rating,
    justification: e.note,
    verification_status: e.verification_status,
    flags: e.flags,
    flag: e.flag,
  };
}

async function resolveAll(
  matterId: string,
  entries: DeskEntry[],
  onProgress?: (p: ConfirmProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      if (signal?.aborted) return;
      const e = entries[next++];
      let res: StoredResolution;
      try {
        const r = await resolveEntry(supabase, matterId, e);
        res = {
          status: r.status,
          pin: r.pin,
          hits: r.hits.map((h) => ({ document_id: h.document_id, title: h.title, how: h.how, star_level: h.star_level })),
          passage: r.passage
            ? { passage_id: r.passage.passage_id, page_start: r.passage.page_start, basis: r.passage.basis, caveat: r.passage.caveat, printed_page: r.passage.printed_page }
            : null,
        };
      } catch (err) {
        // Before migration 101, or a dropped connection: the row says the
        // lookup failed, never "not in corpus".
        res = { status: 'error', pin: null, hits: [], passage: null, error: (err as Error).message };
      }
      e.resolution = res;
      onProgress?.({ phase: 'resolving', index: ++done, total: entries.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker));
}

/** Resolve a run's entries again (the corpus may have changed) without a new run. */
export async function refreshResolutions(matterId: string, run: DeskRun): Promise<DeskRun> {
  const entries = run.entries.map((e) => ({ ...e }));
  await resolveAll(matterId, entries);
  return { ...run, entries };
}

export async function confirmBrief(opts: {
  meta: BriefMeta;
  body: BriefDoc;
  prior: DeskRun | null;
  /** pairKey()s of marks that are stale in the editor right now. */
  stalePairs: Set<string>;
  /** Re-check all: ignore the prior run. */
  all: boolean;
  modelId?: string;
  onProgress?: (p: ConfirmProgress) => void;
  signal?: AbortSignal;
}): Promise<ConfirmOutcome> {
  const { meta, body, prior, stalePairs, all, onProgress, signal } = opts;
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const matterId = meta.matterspace_id;
  const aborted = () => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };

  onProgress?.({ phase: 'snapshot' });
  const snap = await takeSnapshot(meta, body, all ? 'confirmed — every cite re-checked' : 'confirmed');
  const draftText = toPlainText(body);

  const { data: userData } = await supabase.auth.getUser();
  const { data: runRow, error: insErr } = await supabase
    .from('cite_check_runs')
    .insert({
      matterspace_id: matterId,
      document_id: meta.id,
      snapshot_id: snap.id,
      source_label: meta.title,
      status: 'running',
      created_by: userData?.user?.id ?? null,
    })
    .select('id, created_at')
    .single();
  if (insErr || !runRow) throw new Error(`The check could not start: ${insErr?.message ?? 'unknown'}`);
  const runId = (runRow as { id: string }).id;

  try {
    aborted();
    onProgress?.({ phase: 'extracting' });
    const extraction = await extractCitations(draftText, {
      modelId, signal, matterId,
      onSection: (done, total) => { if (total > 1) onProgress?.({ phase: 'extracting', done, total }); },
    });
    const fresh = extraction.cites;
    const diff = diffForConfirm<Cite>(prior?.entries ?? null, fresh, stalePairs, all);

    const entries: DeskEntry[] = new Array(fresh.length);
    const results: CheckResult[] = new Array(fresh.length);
    for (const c of diff.carried) {
      entries[c.index] = {
        ...c.prior,
        raw: c.cite.raw ?? c.prior.raw,
        location: c.cite.location ?? c.prior.location,
        carried_from: c.prior.carried_from ?? prior?.id ?? null,
        resolution: null,
      };
      results[c.index] = resultFromEntry(entries[c.index]);
    }
    let i = 0;
    for (const t of diff.toCheck) {
      aborted();
      onProgress?.({
        phase: 'checking', index: ++i, total: diff.toCheck.length,
        current: t.cite.citation_bluebook ?? t.cite.raw ?? '', carried: diff.carried.length,
      });
      const r = await checkOne(t.cite, { modelId, signal, matterId });
      results[t.index] = r;
      entries[t.index] = entryFromResult(r);
    }

    aborted();
    await resolveAll(matterId, entries, onProgress, signal);

    onProgress?.({ phase: 'saving' });
    const counts = tallyFlags(results);
    for (const t of diff.toCheck) {
      const id = results[t.index].authority_id;
      if (!id) continue;
      try { await linkAuthorityToMatter({ matter_id: matterId, authority_id: id, cited_in_briefs: [meta.title] }); } catch { /* non-fatal */ }
    }
    const { error: upErr } = await supabase
      .from('cite_check_runs')
      .update({
        status: 'complete',
        citations_total: entries.length,
        counts,
        report: entries,
        toa_markdown: renderToa(results),
        report_markdown: renderReport(meta.title, results, { setAside: extraction.setAside }),
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId);
    if (upErr) throw new Error(`The results could not be saved: ${upErr.message}`);

    await recordEvent('cite.checked', matterId, { document_id: meta.id, run_id: runId, snapshot_id: snap.id, counts });

    return {
      run: { id: runId, created_at: (runRow as { created_at: string }).created_at, snapshot_id: snap.id, counts, entries },
      checked: diff.toCheck.length,
      carried: diff.carried.length,
      dropped: diff.dropped.length,
      setAside: extraction.setAside,
      snapshotPublished: snap.published,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      await supabase.from('cite_check_runs').update({ status: 'interrupted' }).eq('id', runId);
    } else {
      await supabase.from('cite_check_runs')
        .update({ status: 'error', error_message: ((err as Error).message ?? 'failed').slice(0, 500) })
        .eq('id', runId);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// cite_notes — the telegraphic note per cite (≤ 280 characters)
// ---------------------------------------------------------------------------

export interface CiteNote {
  id: string;
  cite_key: string;
  user_id: string;
  note: string;
  annotation_id: string | null;
  updated_at: string;
}

export async function loadNotes(documentId: string): Promise<CiteNote[]> {
  const { data, error } = await supabase
    .from('cite_notes')
    .select('id, cite_key, user_id, note, annotation_id, updated_at')
    .eq('document_id', documentId)
    .order('updated_at', { ascending: true });
  if (error) {
    if (/cite_notes/.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as CiteNote[];
}

/** Save (or, when empty, delete) my note on a cite. */
export async function saveNote(documentId: string, key: string, note: string): Promise<CiteNote | null> {
  const { data: u } = await supabase.auth.getUser();
  const me = u.user?.id;
  if (!me) throw new Error('You are signed out.');
  const text = note.trim().slice(0, 280);
  if (!text) {
    const { error } = await supabase.from('cite_notes').delete()
      .eq('document_id', documentId).eq('cite_key', key).eq('user_id', me);
    if (error) throw new Error(error.message);
    return null;
  }
  const { data, error } = await supabase
    .from('cite_notes')
    .upsert(
      { document_id: documentId, cite_key: key, user_id: me, note: text, updated_at: new Date().toISOString() },
      { onConflict: 'document_id,cite_key,user_id' },
    )
    .select('id, cite_key, user_id, note, annotation_id, updated_at')
    .single();
  if (error) throw new Error(error.message);
  return data as CiteNote;
}

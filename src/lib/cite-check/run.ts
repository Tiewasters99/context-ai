// Orchestrator for an in-app cite-check run. The whole loop executes in
// the browser (a long brief is dozens of model calls — far past the
// serverless timeout), so it writes a cite_check_runs row up front, then
// updates it on completion / interruption. If the user navigates away the
// run is left 'interrupted' and can be re-run later.

import { supabase } from '@/lib/supabase';
import type { CheckResult, FlagCounts, ReportEntry, RunProgress, RunResult } from './types';
import { extractCitations } from './extract-cites';
import { checkOne } from './check';
import { linkAuthorityToMatter } from './persist';
import { renderToa, renderReport } from './render';

const DEFAULT_MODEL_ID = 'claude-opus-4-8';

export interface RunCiteCheckOptions {
  matterId: string;
  /** Already-extracted draft text (the UI does the file extraction). */
  draftText: string;
  /** Human label for the source — filename or short description. */
  sourceLabel: string;
  /** Vault document id, when the run targets an uploaded brief. */
  documentId?: string | null;
  modelId?: string;
  onProgress?: (p: RunProgress) => void;
  signal?: AbortSignal;
}

function emptyCounts(): FlagCounts {
  return { green: 0, lean_green: 0, lean_red: 0, red: 0, blue: 0 };
}

function tally(results: CheckResult[]): FlagCounts {
  const c = emptyCounts();
  for (const r of results) {
    if (r.flag === 'green') c.green++;
    else if (r.flag === 'lean-green') c.lean_green++;
    else if (r.flag === 'lean-red') c.lean_red++;
    else if (r.flag === 'red') c.red++;
    else if (r.flag === 'blue') c.blue++;
  }
  return c;
}

function toReportEntries(results: CheckResult[]): ReportEntry[] {
  return results.map((r) => ({
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
  }));
}

export async function runCiteCheck(opts: RunCiteCheckOptions): Promise<RunResult> {
  const { matterId, draftText, sourceLabel, documentId = null, modelId = DEFAULT_MODEL_ID, onProgress, signal } = opts;

  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData?.user?.id ?? null;

  // Create the run row.
  const { data: runRow, error: insertErr } = await supabase
    .from('cite_check_runs')
    .insert({
      matterspace_id: matterId,
      document_id: documentId,
      source_label: sourceLabel,
      status: 'running',
      created_by: createdBy,
    })
    .select('id')
    .single();
  if (insertErr || !runRow) throw new Error(`Could not start run: ${insertErr?.message ?? 'unknown'}`);
  const runId = runRow.id as string;

  const fail = async (message: string) => {
    await supabase.from('cite_check_runs').update({ status: 'error', error_message: message.slice(0, 500) }).eq('id', runId);
    onProgress?.({ phase: 'error', message });
  };
  const interrupt = async () => {
    await supabase.from('cite_check_runs').update({ status: 'interrupted' }).eq('id', runId);
  };

  try {
    // 1. Extract citations.
    onProgress?.({ phase: 'extracting-cites', message: 'Reading the brief and pulling every citation…' });
    if (signal?.aborted) { await interrupt(); throw new DOMException('Aborted', 'AbortError'); }
    const cites = await extractCitations(draftText, { modelId, signal });

    // 2. Check each cite.
    const results: CheckResult[] = [];
    for (let i = 0; i < cites.length; i++) {
      if (signal?.aborted) { await interrupt(); throw new DOMException('Aborted', 'AbortError'); }
      const c = cites[i];
      onProgress?.({ phase: 'checking', index: i + 1, total: cites.length, current: c.citation_bluebook ?? c.raw ?? '' });
      results.push(await checkOne(c, { modelId, signal }));
    }

    // 3. Render + tally.
    onProgress?.({ phase: 'persisting', message: 'Linking verified authorities to the matter…' });
    const counts = tally(results);
    const toaMarkdown = renderToa(results);
    const reportMarkdown = renderReport(sourceLabel, results);

    // 4. Link verified authorities to the matter.
    for (const r of results) {
      if (r.authority_id) {
        try {
          await linkAuthorityToMatter({ matter_id: matterId, authority_id: r.authority_id, cited_in_briefs: [sourceLabel] });
        } catch { /* non-fatal — the run still completes */ }
      }
    }

    // 5. Finalize the run row.
    const { error: updateErr } = await supabase
      .from('cite_check_runs')
      .update({
        status: 'complete',
        citations_total: results.length,
        counts,
        report: toReportEntries(results),
        toa_markdown: toaMarkdown,
        report_markdown: reportMarkdown,
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId);
    if (updateErr) throw new Error(`Could not save results: ${updateErr.message}`);

    onProgress?.({ phase: 'done', total: results.length });
    return { runId, results, counts, toaMarkdown, reportMarkdown };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Row already marked 'interrupted' above.
      throw err;
    }
    await fail((err as Error).message ?? 'cite-check failed');
    throw err;
  }
}

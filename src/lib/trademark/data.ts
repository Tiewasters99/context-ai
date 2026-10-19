// Trademark Clearance — the browser's data layer (migration 121).
//
// Every read and write runs under the user's own session (RLS through the
// clearance's matter). The database stamps who signed and when; the browser
// never sends decided_by / done_by. The Record's tm.* kinds are written with
// the user's own client, the comparator's pattern; a Record write never
// blocks the work (record() does not throw).
//
// Before 121 is applied every table read fails with "does not exist": the
// matter tab stays hidden and the Agents-page card says one sentence.

import { supabase } from '@/lib/supabase';
import { sandboxApi } from '@/lib/sandbox-api';
import { parseRefusalBody } from '@/lib/llm/refusals';
import {
  generateQueries, planRegeneration, nextManualSeq, type Decomposition, type GeneratedQuery, type KnownMark,
} from '../../../lib/trademark/queries.mjs';
import { procedureHash } from '../../../lib/trademark/procedure.mjs';
import { collectHits, summarizeRun } from '../../../lib/trademark/triage.mjs';
import type { ParsedRow } from '../../../lib/trademark/parse.mjs';
import { reportFilename, reportHash } from '../../../lib/trademark/report.mjs';
import type { LedgerEventKind } from '../../../lib/ledger.mjs';

export const TM_NOT_READY =
  'Trademark Clearance needs a database update (migration 121) that has not been applied yet. Nothing was created.';

export type StageStatus = 'pending' | 'in_progress' | 'awaiting_review' | 'done' | 'skipped';
export type Bin = 'flag' | 'note' | 'dismiss';

export interface ClassEntry { code: string; reason: string; model?: string }
export interface Applicant {
  legal_name?: string; entity_type?: string; state?: string;
  formation_status?: 'formed' | 'pending' | 'individual' | ''; formation_date?: string;
  domicile_address?: string; mailing_address?: string; address_is_mail_drop?: 'yes' | 'no' | 'unknown' | '';
}
export interface TmDecomposition extends Decomposition { exclusions?: string[] }

export interface Clearance {
  id: string;
  matterspace_id: string;
  mark: string;
  mark_format: 'standard' | 'stylized';
  goods_services: string;
  users: string;
  applicant: Applicant;
  known_marks: KnownMark[];
  search_classes: ClassEntry[];
  filing_classes: ClassEntry[];
  decomposition: TmDecomposition | null;
  foreign_equivalents: string[];
  procedure_hash: string | null;
  self_test_passed: boolean | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
export interface Stage {
  clearance_id: string; stage: number; status: StageStatus; done_by: string | null; initials: string | null;
  done_at: string | null; output_document_id: string | null; note: string | null;
}
export interface TmQuery {
  id: string; clearance_id: string; seq: number; purpose: string; query: string; class_filter: string[];
  live_only: boolean; generator_version: string | null; created_at: string;
}
export interface TmRun {
  id: string; query_id: string; run_at: string; run_by: string | null; source: 'manual' | 'export' | 'failed';
  reported_count: number | null; captured_count: number; gap: boolean; gap_note: string | null;
  export_document_id: string | null; raw: ParsedRow[];
}
export interface Proposal {
  bin: Bin; similarity: { score: number; reason: string }; relatedness: { score: number; reason: string }; model: string; at: string;
}
export interface TmHit {
  id: string; clearance_id: string; serial: string; registration_number: string | null; mark: string | null; owner: string | null;
  status_text: string | null; live: boolean | null; classes: string[]; goods_services: string | null; filing_date: string | null;
  raw: Record<string, string>; query_seqs: number[]; proposed: Proposal | null; bin: Bin | null; bin_reason: string | null;
  decided_by: string | null; initials: string | null; decided_at: string | null;
}
export interface ClearanceBundle {
  clearance: Clearance; stages: Stage[]; queries: TmQuery[]; runs: TmRun[]; hits: TmHit[];
}

export const STAGE_NAMES: Record<number, string> = {
  1: 'Intake', 2: 'Classes', 3: 'Search terms', 4: 'Register search', 5: 'Triage',
  6: 'Deep check (TSDR)', 7: 'Web screen', 8: 'Knockout report', 9: 'Application draft', 10: 'Docket',
};
/** Stages this version does not build; they render as "Not in this version" and may be skipped. */
export const LATER_STAGES = new Set([6, 7, 9, 10]);

export function isTrademarkMissing(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? '');
  if (code === '42P01' || code === 'PGRST205') return true;
  return /tm_(clearances|stages|queries|query_runs|hits)/.test(msg) && /does not exist|schema cache/i.test(msg);
}

function fail(err: unknown, fallback: string): never {
  if (isTrademarkMissing(err)) throw new Error(TM_NOT_READY);
  const msg = (err as { message?: string } | null)?.message;
  throw new Error(msg || fallback);
}

async function userId(): Promise<string> {
  const id = (await supabase.auth.getUser()).data.user?.id;
  if (!id) throw new Error('You are signed out. Sign in again and retry.');
  return id;
}

async function recordTm(kind: LedgerEventKind, matterId: string, payload: Record<string, unknown>) {
  try {
    const { record } = await import('../../../lib/ledger.mjs');
    const uid = (await supabase.auth.getUser()).data.user?.id ?? null;
    await record(supabase, { kind, matterId, actor: { kind: 'user', ref: uid, user_id: uid }, payload });
  } catch (err) {
    console.warn(`[trademark] ${kind} not recorded:`, err);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** How many clearances the matter holds; null when 121 is not applied (or the read failed). */
export async function countClearances(matterId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from('tm_clearances')
    .select('id', { count: 'exact', head: true })
    .eq('matterspace_id', matterId);
  if (error) return null;
  return count ?? 0;
}

export async function listClearances(matterId: string): Promise<Pick<Clearance, 'id' | 'mark' | 'created_at'>[]> {
  const { data, error } = await supabase
    .from('tm_clearances')
    .select('id, mark, created_at')
    .eq('matterspace_id', matterId)
    .order('created_at', { ascending: true });
  if (error) fail(error, 'Could not read the clearances.');
  return (data ?? []) as Pick<Clearance, 'id' | 'mark' | 'created_at'>[];
}

export async function loadClearance(id: string): Promise<ClearanceBundle> {
  const { data: clearance, error } = await supabase.from('tm_clearances').select('*').eq('id', id).maybeSingle();
  if (error) fail(error, 'Could not read the clearance.');
  if (!clearance) throw new Error('That clearance could not be found.');
  const [st, qs, hs] = await Promise.all([
    supabase.from('tm_stages').select('*').eq('clearance_id', id).order('stage'),
    supabase.from('tm_queries').select('*').eq('clearance_id', id).order('seq'),
    supabase.from('tm_hits').select('*').eq('clearance_id', id).order('serial'),
  ]);
  if (st.error) fail(st.error, 'Could not read the stages.');
  if (qs.error) fail(qs.error, 'Could not read the queries.');
  if (hs.error) fail(hs.error, 'Could not read the hits.');
  const queries = (qs.data ?? []) as TmQuery[];
  let runs: TmRun[] = [];
  if (queries.length) {
    const r = await supabase.from('tm_query_runs').select('*').in('query_id', queries.map((q) => q.id)).order('run_at');
    if (r.error) fail(r.error, 'Could not read the runs.');
    runs = (r.data ?? []) as TmRun[];
  }
  return { clearance: clearance as Clearance, stages: (st.data ?? []) as Stage[], queries, runs, hits: (hs.data ?? []) as TmHit[] };
}

// ---------------------------------------------------------------------------
// Stage 1 — intake
// ---------------------------------------------------------------------------

/** Mint the id here and insert without .select() (the createTask pattern). */
export async function createClearance(matterId: string, mark: string): Promise<string> {
  const m = mark.trim();
  if (!m) throw new Error('Type the mark exactly as it will be used.');
  if (m.length > 200) throw new Error('A mark can be at most 200 characters.');
  const created_by = await userId();
  const id = crypto.randomUUID();
  const { error } = await supabase.from('tm_clearances').insert({ id, matterspace_id: matterId, mark: m, created_by });
  if (error) fail(error, 'Could not create the clearance.');
  await recordTm('tm.clearance.created', matterId, { clearance_id: id });
  return id;
}

export type IntakePatch = Partial<Pick<Clearance, 'mark' | 'mark_format' | 'goods_services' | 'users' | 'applicant' | 'known_marks'>>;

export async function saveIntake(c: Clearance, patch: IntakePatch): Promise<void> {
  const { error } = await supabase.from('tm_clearances').update(patch).eq('id', c.id);
  if (error) fail(error, 'Could not save the intake.');
  // Field names only: never the goods text or the applicant's details.
  await recordTm('tm.intake.updated', c.matterspace_id, { clearance_id: c.id, fields: Object.keys(patch).sort() });
}

// ---------------------------------------------------------------------------
// Stage 2 — classes
// ---------------------------------------------------------------------------

export async function saveClasses(c: Clearance, search: ClassEntry[], filing: ClassEntry[]): Promise<void> {
  const norm = (l: ClassEntry[]) => l
    .map((x) => ({ ...x, code: String(x.code).replace(/\D/g, '').padStart(3, '0'), reason: x.reason.trim() }))
    .filter((x) => /^\d{3}$/.test(x.code));
  const s = norm(search);
  const f = norm(filing);
  const codes = new Set(s.map((x) => x.code));
  const outside = f.filter((x) => !codes.has(x.code)).map((x) => x.code);
  if (outside.length) throw new Error(`Filing class ${outside.join(', ')} is not a search class. Filing classes must be a subset of the search classes.`);
  const { error } = await supabase.from('tm_clearances').update({ search_classes: s, filing_classes: f }).eq('id', c.id);
  if (error) fail(error, 'Could not save the classes.');
  await recordTm('tm.classes.set', c.matterspace_id, {
    clearance_id: c.id, search: s.map((x) => x.code), filing: f.map((x) => x.code),
  });
}

// ---------------------------------------------------------------------------
// Stage 3 — decomposition and queries
// ---------------------------------------------------------------------------

export async function saveDecomposition(c: Clearance, d: TmDecomposition, foreign: string[]): Promise<void> {
  const { error } = await supabase.from('tm_clearances')
    .update({ decomposition: d, foreign_equivalents: foreign.map((w) => w.trim()).filter(Boolean).slice(0, 50) })
    .eq('id', c.id);
  if (error) fail(error, 'Could not save the decomposition.');
  await recordTm('tm.intake.updated', c.matterspace_id, { clearance_id: c.id, fields: ['decomposition', 'foreign_equivalents'] });
}

/**
 * Generate (or regenerate) the query list. Queries that have been run are
 * kept with their results; un-run generated ones are replaced; hand-written
 * ones stay.
 */
export async function generateAndStore(b: ClearanceBundle, opts: { rescued?: string[] } = {}): Promise<{ count: number; warnings: string[] }> {
  const c = b.clearance;
  if (!c.decomposition) throw new Error('Confirm the decomposition first.');
  const { queries, warnings } = generateQueries({
    mark: c.mark,
    decomposition: c.decomposition,
    searchClasses: c.search_classes.map((x) => x.code),
    knownMarks: c.known_marks,
    foreignEquivalents: c.foreign_equivalents,
    exclusions: c.decomposition.exclusions?.length ? c.decomposition.exclusions : null,
    rescued: opts.rescued ?? [],
  });
  const runCount = new Map<string, number>();
  for (const r of b.runs) runCount.set(r.query_id, (runCount.get(r.query_id) ?? 0) + 1);
  const plan = planRegeneration(b.queries.map((q) => ({ ...q, run_count: runCount.get(q.id) ?? 0 })), queries);
  if (plan.remove.length) {
    const { error } = await supabase.from('tm_queries').delete().in('id', plan.remove);
    if (error) fail(error, 'Could not replace the un-run queries.');
  }
  if (plan.insert.length) {
    const { error } = await supabase.from('tm_queries').insert(plan.insert.map((q: GeneratedQuery) => ({ ...q, clearance_id: c.id })));
    if (error) fail(error, 'Could not store the queries.');
  }
  const hash = await procedureHash();
  await supabase.from('tm_clearances').update({ procedure_hash: hash }).eq('id', c.id);
  await recordTm('tm.queries.generated', c.matterspace_id, { clearance_id: c.id, count: plan.insert.length, procedure_hash: hash });
  return { count: plan.insert.length, warnings };
}

export async function addManualQuery(b: ClearanceBundle, query: string): Promise<void> {
  const q = query.trim();
  if (!q) throw new Error('Write the query first.');
  const { error } = await supabase.from('tm_queries').insert({
    clearance_id: b.clearance.id, seq: nextManualSeq(b.queries), purpose: 'manual', query: q, class_filter: [], live_only: false,
    generator_version: null,
  });
  if (error) fail(error, 'Could not add the query.');
}

// ---------------------------------------------------------------------------
// Stage 4 — runs
// ---------------------------------------------------------------------------

export interface RunInput {
  source: 'manual' | 'export' | 'failed';
  reported: number | null;
  rows: ParsedRow[];
  exportDocumentId?: string | null;
  gapNote?: string | null;
}

/**
 * Record one run of one query, then fold every current run's rows into the
 * hits table (one row per serial; decisions are never sent, so a re-import
 * cannot erase one; the database merges query_seqs).
 */
export async function recordRun(b: ClearanceBundle, query: TmQuery, input: RunInput): Promise<void> {
  const rows = input.source === 'failed' ? [] : input.rows.slice(0, 500);
  const s = summarizeRun({ source: input.source, reported_count: input.reported, rows });
  const run_by = await userId();
  const runId = crypto.randomUUID();
  const { error } = await supabase.from('tm_query_runs').insert({
    id: runId, query_id: query.id, source: input.source, reported_count: input.reported, raw: rows,
    gap_note: [s.gapNote, input.gapNote].filter(Boolean).join('; ') || null,
    export_document_id: input.exportDocumentId ?? null, run_by,
  });
  if (error) fail(error, 'Could not record the run.');
  // The Record entry goes in as soon as the run row exists: a failure in the
  // hits step below (seen 2026-10-19 on a 1,119-character wordmark) must not
  // leave a recorded run with no event behind it.
  await recordTm('tm.query.run', b.clearance.matterspace_id, {
    clearance_id: b.clearance.id, seq: query.seq, reported: input.reported, captured: s.captured, gap: s.gap, source: input.source,
  });

  const runs: TmRun[] = [...b.runs, {
    id: runId, query_id: query.id, run_at: new Date().toISOString(), run_by, source: input.source,
    reported_count: input.reported, captured_count: s.captured, gap: s.gap, gap_note: s.gapNote,
    export_document_id: input.exportDocumentId ?? null, raw: rows,
  }];
  const hits = collectHits(b.queries, runs);
  for (let i = 0; i < hits.length; i += 500) {
    const chunk = hits.slice(i, i + 500).map((h) => ({ ...h, clearance_id: b.clearance.id }));
    const { error: hitErr } = await supabase.from('tm_hits').upsert(chunk, { onConflict: 'clearance_id,serial' });
    if (hitErr) fail(hitErr, 'The run was recorded, but its rows could not be added to the hits.');
  }
  if (query.purpose === 'selftest') {
    await supabase.from('tm_clearances').update({ self_test_passed: input.source !== 'failed' && s.captured === 1 })
      .eq('id', b.clearance.id);
  }
}

/** File an export into the matter; its document id goes on the run. */
export async function fileExport(matterId: string, file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const out = await sandboxApi<{ document_id?: string }>('file_document', {
    matter: matterId, filename: file.name, content: btoa(bin), encoding: 'base64', doc_type: 'other',
  });
  if (!out.document_id) throw new Error('The export was not filed.');
  return out.document_id;
}

// ---------------------------------------------------------------------------
// Stage 5 — decisions
// ---------------------------------------------------------------------------

export async function decideHit(c: Clearance, hit: TmHit, bin: Bin, reason: string, initials: string): Promise<void> {
  const ini = initials.trim();
  if (ini.length < 1 || ini.length > 4) throw new Error('Initials are needed (1 to 4 characters): the decision records who made it.');
  const { error } = await supabase.from('tm_hits')
    .update({ bin, bin_reason: reason.trim() || null, initials: ini })
    .eq('id', hit.id);
  if (error) fail(error, 'Could not save the decision.');
  await recordTm('tm.hit.decided', c.matterspace_id, { clearance_id: c.id, serial: hit.serial, bin, initials: ini.toUpperCase() });
}

// ---------------------------------------------------------------------------
// Sign-offs
// ---------------------------------------------------------------------------

export async function signStage(c: Clearance, stage: number, status: StageStatus, initials: string, outputDocumentId?: string | null): Promise<void> {
  const ini = initials.trim();
  if ((status === 'done' || status === 'skipped') && (ini.length < 1 || ini.length > 4)) {
    throw new Error('Initials are needed (1 to 4 characters) to sign a stage off.');
  }
  const patch: Record<string, unknown> = { status, initials: status === 'done' || status === 'skipped' ? ini : null };
  if (outputDocumentId !== undefined) patch.output_document_id = outputDocumentId;
  const { error } = await supabase.from('tm_stages').update(patch).eq('clearance_id', c.id).eq('stage', stage);
  if (error) fail(error, 'Could not update the stage.');
  if (status === 'done' || status === 'skipped') {
    await recordTm('tm.stage.done', c.matterspace_id, { clearance_id: c.id, stage, status, initials: ini.toUpperCase() });
  }
}

// ---------------------------------------------------------------------------
// Stage 8 — the report
// ---------------------------------------------------------------------------

export async function fileReport(c: Clearance, md: string, date: string, initials: string): Promise<{ documentId: string; alreadyFiled: boolean }> {
  const out = await sandboxApi<{ document_id?: string; already_filed?: boolean }>('file_document', {
    matter: c.matterspace_id, filename: reportFilename(c.mark, date), content: md, encoding: 'utf8',
    title: `Trademark knockout report — ${c.mark} — ${date}`, doc_type: 'other',
  });
  if (!out.document_id) throw new Error('The report was not filed.');
  if (out.already_filed) return { documentId: out.document_id, alreadyFiled: true };
  await signStage(c, 8, 'done', initials, out.document_id);
  await recordTm('tm.report.filed', c.matterspace_id, { clearance_id: c.id, document_id: out.document_id, sha256: await reportHash(md) });
  return { documentId: out.document_id, alreadyFiled: false };
}

// ---------------------------------------------------------------------------
// The model actions (/api/trademark)
// ---------------------------------------------------------------------------

export async function trademarkApi<T>(action: 'decompose' | 'classes' | 'triage', args: Record<string, unknown>): Promise<T> {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) throw new Error('You are signed out. Sign in again and retry.');
  const res = await fetch('/api/trademark', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, args }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body?.message && typeof body.message === 'string') throw new Error(body.message);
    throw new Error(parseRefusalBody(res.status, body, res.headers.get('retry-after')).message);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Initials, remembered per browser (a convenience; never the record)
// ---------------------------------------------------------------------------

const INITIALS_KEY = 'cs.trademark.initials';
export function savedInitials(): string {
  try { return localStorage.getItem(INITIALS_KEY) ?? ''; } catch { return ''; }
}
export function rememberInitials(v: string) {
  try { localStorage.setItem(INITIALS_KEY, v.trim().slice(0, 4)); } catch { /* private window */ }
}

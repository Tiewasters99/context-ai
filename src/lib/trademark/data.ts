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
import {
  applicationFilename, mergeAnswers, normalizeApplication, reviewedLegend, type Application,
} from '../../../lib/trademark/application.mjs';
import type { LedgerEventKind } from '../../../lib/ledger.mjs';

export const TM_NOT_READY =
  'Trademark Clearance needs a database update (migration 121) that has not been applied yet. Nothing was created.';
export const TM_SLICE2_NOT_READY =
  'This step needs a database update (migration 122, Trademark Clearance slice 2) that has not been applied yet.';

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
  /** Migration 122: the model's proposals, saved PROPOSED (never the confirmed value). */
  proposals?: { classes?: { search: ClassEntry[]; filing: ClassEntry[]; model: string; at?: string }; decompose?: TmDecomposition & { model: string; at?: string } };
  /** Migration 122: the stage-9 answers. */
  application?: Partial<Application>;
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
  id: string; query_id: string; run_at: string; run_by: string | null; source: 'manual' | 'export' | 'failed' | 'register_copy';
  reported_count: number | null; captured_count: number; gap: boolean; gap_note: string | null;
  export_document_id: string | null; raw: ParsedRow[];
  /** Migration 123: a run from Equazia's copy of the register — its as-of date, and whether it was preliminary. */
  register_as_of?: string | null; register_preliminary?: boolean | null;
}
export interface Proposal {
  bin: Bin; similarity: { score: number; reason: string }; relatedness: { score: number; reason: string }; model: string; at: string;
}
export interface TmHit {
  id: string; clearance_id: string; serial: string; registration_number: string | null; mark: string | null; owner: string | null;
  status_text: string | null; live: boolean | null; classes: string[]; goods_services: string | null; filing_date: string | null;
  raw: Record<string, string>; query_seqs: number[]; proposed: Proposal | null; bin: Bin | null; bin_reason: string | null;
  decided_by: string | null; initials: string | null; decided_at: string | null;
  /** Migration 122: the official status from the TSDR API (stage 6). */
  tsdr?: TsdrRecord | null; tsdr_checked_at?: string | null; tsdr_document_id?: string | null; deep_check?: boolean;
}
export interface TsdrRecord {
  error?: string; code?: string; mark?: string | null; status_code?: string | null; status_text?: string | null; status_date?: string | null;
  live?: boolean | null; filing_date?: string | null; registration_number?: string | null; registration_date?: string | null;
  owner?: string | null; classes?: string[]; events?: { date: string | null; code: string | null; description: string | null }[]; fetched_at?: string;
}
export interface ClearanceBundle {
  clearance: Clearance; stages: Stage[]; queries: TmQuery[]; runs: TmRun[]; hits: TmHit[];
}

export const STAGE_NAMES: Record<number, string> = {
  1: 'Intake', 2: 'Classes', 3: 'Search terms', 4: 'Register search', 5: 'Triage',
  6: 'Deep check (TSDR)', 7: 'Web screen', 8: 'Knockout report', 9: 'Application draft', 10: 'Docket',
};
/** Stages this version does not build; they render as "Not in this version" and may be skipped. */
export const LATER_STAGES = new Set([7, 10]);

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
export async function createClearance(matterId: string, mark: string, goods = ''): Promise<string> {
  const m = mark.trim();
  if (!m) throw new Error('Type the mark exactly as it will be used.');
  if (m.length > 200) throw new Error('A mark can be at most 200 characters.');
  const created_by = await userId();
  const id = crypto.randomUUID();
  const g = goods.trim();
  const { error } = await supabase.from('tm_clearances').insert({ id, matterspace_id: matterId, mark: m, created_by, ...(g ? { goods_services: g } : {}) });
  if (error) fail(error, 'Could not create the clearance.');
  await recordTm('tm.clearance.created', matterId, { clearance_id: id });
  if (g) await recordTm('tm.intake.updated', matterId, { clearance_id: id, fields: ['goods_services'] });
  return id;
}

// ---------------------------------------------------------------------------
// Slice 2 — the one-box start
// ---------------------------------------------------------------------------

/** One mark per line; blank lines and repeats dropped (case-insensitive), at most 10. */
export function marksFromText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trim().replace(/\s+/g, ' ');
    if (!m || seen.has(m.toLowerCase())) continue;
    seen.add(m.toLowerCase());
    out.push(m);
  }
  return out;
}

export interface BatchProgress { mark: string; clearanceId: string | null; step: 'creating' | 'classes' | 'decompose' | 'proposed' | 'failed'; error?: string }

/**
 * Create one clearance per mark with the sentence as its goods and services,
 * then ask for the class and decomposition proposals (saved PROPOSED, never
 * confirmed): in parallel across marks, the two steps of one mark in turn
 * (both save into the same row). Stops at the first human step.
 */
export async function startBatch(matterId: string, marks: string[], sentence: string, onProgress: (p: BatchProgress[]) => void): Promise<string[]> {
  if (!marks.length) throw new Error('Type at least one mark, one per line.');
  if (marks.length > 10) throw new Error('At most 10 marks at a time.');
  if (!sentence.trim()) throw new Error('Add one sentence on what the marks are for.');
  const state: BatchProgress[] = marks.map((mark) => ({ mark, clearanceId: null, step: 'creating' }));
  const push = () => onProgress(state.map((x) => ({ ...x })));
  push();
  for (const row of state) {
    row.clearanceId = await createClearance(matterId, row.mark, sentence);
    row.step = 'classes';
    push();
  }
  await Promise.all(state.map(async (row) => {
    try {
      await trademarkApi('classes', { clearance_id: row.clearanceId, save: true });
      row.step = 'decompose'; push();
      await trademarkApi('decompose', { clearance_id: row.clearanceId, save: true });
      row.step = 'proposed'; push();
    } catch (e) {
      row.step = 'failed'; row.error = e instanceof Error ? e.message : String(e); push();
    }
  }));
  return state.map((x) => x.clearanceId!).filter(Boolean);
}

/**
 * The reviewer's one confirmation for one mark: the classes and the
 * decomposition as shown (proposed, or as edited), the queries generated, and
 * stages 1, 2 and 3 signed with the reviewer's initials — each its own row in
 * the Record, as if signed one by one.
 */
export async function confirmMark(id: string, value: { search: ClassEntry[]; filing: ClassEntry[]; decomposition: TmDecomposition; foreign: string[] }, initials: string): Promise<void> {
  const ini = initials.trim();
  if (ini.length < 1 || ini.length > 4) throw new Error('Your initials (1 to 4 characters) confirm the mark.');
  let b = await loadClearance(id);
  await saveClasses(b.clearance, value.search, value.filing);
  await saveDecomposition(b.clearance, value.decomposition, value.foreign);
  b = await loadClearance(id);
  await generateAndStore(b);
  for (const n of [1, 2, 3]) {
    const st = b.stages.find((s) => s.stage === n);
    if (st?.status !== 'done') await signStage(b.clearance, n, 'done', ini);
  }
}

// ---------------------------------------------------------------------------
// Slice 2 — stage 6, the deep check (server side: the key never reaches the browser)
// ---------------------------------------------------------------------------

export interface DeepCheckResult {
  configured: boolean; message?: string; targets: number; checked: number; remaining: number; live?: number; dead?: number; failed?: number; filed?: number;
  stopped?: string; results: { serial: string; ok: boolean; reason?: string; live?: boolean | null; document_id?: string | null; note?: string }[];
}
export async function runDeepCheck(id: string, force = false): Promise<DeepCheckResult> {
  return trademarkApi<DeepCheckResult>('deep_check', { clearance_id: id, force });
}

// ---------------------------------------------------------------------------
// Slice 2 — stage 9, the application draft
// ---------------------------------------------------------------------------

/** Save answers (the same merge the connector uses); field names only in the Record. */
export async function saveApplicationAnswers(c: Clearance, answers: Record<string, unknown>): Promise<string[]> {
  const merged = mergeAnswers({ application: c.application ?? {}, applicant: c.applicant ?? {}, filingClasses: c.filing_classes, answers });
  const touchesApplicant = merged.fields.some((f) => f.startsWith('applicant.'));
  const { error } = await supabase.from('tm_clearances').update({
    application: { ...merged.application, updated_at: new Date().toISOString() },
    ...(touchesApplicant ? { applicant: { ...(c.applicant ?? {}), ...merged.applicant } } : {}),
  }).eq('id', c.id);
  if (error) {
    if (/application|column/.test(error.message ?? '')) throw new Error(TM_SLICE2_NOT_READY);
    fail(error, 'Could not save the answers.');
  }
  if (merged.fields.length) await recordTm('tm.application.answered', c.matterspace_id, { clearance_id: c.id, fields: merged.fields });
  return merged.refused;
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function fileText(matterId: string, filename: string, title: string, content: string): Promise<string> {
  const out = await sandboxApi<{ document_id?: string }>('file_document', {
    matter: matterId, filename, content, encoding: 'utf8', title, doc_type: 'other',
  });
  if (!out.document_id) throw new Error('The document was not filed.');
  return out.document_id;
}

/** File the DRAFT and its annex in the matter; stage 9 awaits review. */
export async function fileApplicationDraft(c: Clearance, draft: string, annex: string, date: string, bases: Record<string, string>): Promise<{ documentId: string; annexId: string }> {
  const sha = await sha256(draft);
  const stamp = `${date} ${sha.slice(0, 8)}`;
  const documentId = await fileText(c.matterspace_id, applicationFilename(c.mark, stamp), `Trademark application draft — ${c.mark} — ${date}`, draft);
  const annexId = await fileText(c.matterspace_id, applicationFilename(c.mark, stamp, 'annex'), `Trademark application cautions — ${c.mark} — ${date}`, annex);
  const application = { ...normalizeApplication(c.application ?? {}), draft: { document_id: documentId, annex_document_id: annexId, sha256: sha, date, via: 'Equazia.ai' } };
  const { error } = await supabase.from('tm_clearances').update({ application }).eq('id', c.id);
  if (error) fail(error, 'The draft was filed but not recorded on the clearance.');
  await supabase.from('tm_stages').update({ status: 'awaiting_review', output_document_id: documentId }).eq('clearance_id', c.id).eq('stage', 9);
  await recordTm('tm.application.drafted', c.matterspace_id, {
    clearance_id: c.id, document_id: documentId, annex_document_id: annexId, sha256: sha, bases: Object.values(bases).filter(Boolean),
  });
  return { documentId, annexId };
}

/**
 * The reviewer's sign-off of stage 9: the reviewed copy (the draft body under
 * a "Reviewed" legend, no DRAFT legend) is filed, and stage 9 is signed with
 * it attached. The database refuses this before stage 8 is done and stage 6
 * is done or skipped (migration 122), and from any connector token.
 */
export async function signApplication(c: Clearance, body: string, initials: string, date: string, doNotFileBefore: string | null): Promise<string> {
  const ini = initials.trim().toUpperCase();
  if (ini.length < 1 || ini.length > 4) throw new Error('Your initials (1 to 4 characters) sign stage 9 off.');
  const md = `${reviewedLegend({ initials: ini, date, doNotFileBefore })}\n${body}`;
  const sha = await sha256(md);
  const id = await fileText(c.matterspace_id, applicationFilename(c.mark, `${date} ${sha.slice(0, 8)}`, 'reviewed'), `Trademark application (reviewed) — ${c.mark} — ${date}`, md);
  await signStage(c, 9, 'done', ini, id);
  await recordTm('tm.application.reviewed', c.matterspace_id, { clearance_id: c.id, document_id: id, sha256: sha, initials: ini });
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
  await recordTm('tm.query.run', b.clearance.matterspace_id, {
    clearance_id: b.clearance.id, seq: query.seq, reported: input.reported, captured: s.captured, gap: s.gap, source: input.source,
  });
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

export async function trademarkApi<T>(action: 'decompose' | 'classes' | 'triage' | 'deep_check' | 'register_status' | 'register_search', args: Record<string, unknown>): Promise<T> {
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
// Stage 4 on Equazia's copy of the register (/api/trademark register_*)
// ---------------------------------------------------------------------------

export interface RegisterStatus {
  configured: boolean; offered: boolean; default: boolean; as_of: string | null; stale: boolean;
  days_behind: number | null; stale_after_days: number | null; gate_passed: boolean; gate: string | null; message: string | null;
}
export interface RegisterSearchResult {
  runs: { query_id: string; seq: number; label: string; reported_count: number | null; captured_count: number; gap: boolean; gap_note: string | null; preliminary: boolean }[];
  not_run: { query_id: string; seq: number; label: string; query: string; reason: string }[];
  out_of_time: string[];
  register: RegisterStatus;
}

let registerStatusPromise: Promise<RegisterStatus> | null = null;
/** The copy's status, asked once per page load (a failure is "not available", never an error on the stage). */
export function registerStatus(refresh = false): Promise<RegisterStatus> {
  if (!registerStatusPromise || refresh) {
    registerStatusPromise = trademarkApi<RegisterStatus>('register_status', {}).catch((e: unknown) => ({
      configured: false, offered: false, default: false, as_of: null, stale: true, days_behind: null, stale_after_days: null,
      gate_passed: false, gate: null, message: e instanceof Error ? e.message : "Equazia's copy of the register is not available.",
    }));
  }
  return registerStatusPromise;
}

export const PRELIMINARY_LABEL = 'preliminary: confirm on tmsearch';

/** Run the clearance's not-yet-run queries (or the named ones) on the copy; the server records each run. */
export function runRegisterSearch(clearanceId: string, queryIds?: string[]): Promise<RegisterSearchResult> {
  return trademarkApi<RegisterSearchResult>('register_search', { clearance_id: clearanceId, ...(queryIds?.length ? { query_ids: queryIds } : {}) });
}

/** The queries whose current run is a preliminary run from the copy (they block stage 4; migration 123). */
export function preliminaryQueries(b: ClearanceBundle): TmQuery[] {
  const latest = new Map<string, TmRun>();
  for (const r of b.runs) { const cur = latest.get(r.query_id); if (!cur || r.run_at > cur.run_at) latest.set(r.query_id, r); }
  return [...b.queries].sort((x, y) => x.seq - y.seq).filter((q) => {
    const r = latest.get(q.id);
    return r?.source === 'register_copy' && r.register_preliminary === true;
  });
}

/** How a run's source reads on the screen. */
export function runSourceLabel(r: TmRun): string {
  if (r.source === 'register_copy') return `Equazia register copy, as of ${String(r.register_as_of ?? '?').slice(0, 10)}${r.register_preliminary ? ` (${PRELIMINARY_LABEL})` : ''}`;
  return r.source;
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

// The Model Comparator, browser side (migration 120; spec MODEL-COMPARATOR-
// SPEC-2026-10-18). Everything here runs under the signed-in user's session,
// so RLS decides what is seen and written. Three rules shape this file:
//
//   * A candidate is ADDED only through /api/sandbox add_comparison_candidate
//     (lib/comparator.mjs), so the blind title, filename and key are enforced
//     in one place. The browser never inserts a candidate or a key itself.
//   * comparison_candidate_keys is never read before the reveal; RLS would
//     return nothing anyway. After the reveal, keysFor() reads it.
//   * The Record: the five comparison.* kinds (lib/ledger.mjs, migration 120)
//     are written with the user's own client, the Brief Desk's recordEvent
//     pattern (src/lib/brief/draft-store.ts). A Record that is not deployed
//     never stops the work.
//
// Before migration 120 is applied, every read here reports "not set up"
// (isComparatorMissing) instead of failing, and the reader shows nothing.

import { supabase } from '@/lib/supabase';
import { fetchPaged } from '@/lib/paged';
import { sandboxApi } from '@/lib/sandbox-api';
import { assembleComparisonNotes, type AssembleNote, type RubricDim } from './assemble';

export type { RubricDim } from './assemble';

export interface ComparisonType {
  key: string;
  label: string;
  default_rubric: RubricDim[];
  sort: number;
}

export interface Comparison {
  id: string;
  box_matter_id: string;
  type: string;
  title: string;
  instructions: string;
  packet_doc_ids: string[];
  packet_hash: string | null;
  rubric: RubricDim[];
  revealed_at: string | null;
  revealed_by: string | null;
  created_by: string;
  created_at: string;
}

export interface Candidate {
  id: string;
  comparison_id: string;
  label: string;
  source: 'upload' | 'model';
  document_id: string | null;
  word_count: number | null;
  created_at: string;
  document?: { id: string; title: string; processing_status: string | null } | null;
}

export interface Grade {
  candidate_id: string;
  scores: Record<string, number>;
  overall: number;
  comment: string;
  initials: string;
  graded_by: string;
  graded_at: string;
}

const CMP_COLS = 'id, box_matter_id, type, title, instructions, packet_doc_ids, packet_hash, rubric, revealed_at, revealed_by, created_by, created_at';
// Named columns, always: slice 2's model/settings/usage stay out of the grader's reads.
const CAND_COLS = 'id, comparison_id, label, source, document_id, word_count, created_at';
// A plain string (not a literal) so supabase-js does not try to type the embed.
const NOTE_COLS: string =
  'id, document_id, page, note, anchor_text, tag, line_start, line_end, text_anchor, created_at, ' +
  'author:profiles!document_annotations_user_id_fkey(display_name, email)';
const GRADE_COLS = 'candidate_id, scores, overall, comment, initials, graded_by, graded_at';

/** The comparator's tables are not in this database yet (migration 120 not applied). */
export function isComparatorMissing(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? '');
  return code === 'PGRST205' || code === '42P01' || code === '42703'
    || /(comparison|candidate_grades|comparison_types).*(does not exist|schema cache|could not find)/i.test(msg)
    || /column .*tag.* does not exist/i.test(msg);
}

export class ComparatorMissingError extends Error {
  constructor() { super('The Model Comparator is not set up in this database yet (migration 120 is not applied).'); }
}

function fail(err: { message: string } | null | unknown): never {
  if (isComparatorMissing(err)) throw new ComparatorMissingError();
  const msg = (err as { message?: string } | null)?.message ?? String(err);
  throw new Error(msg);
}

async function recordComparison(
  kind: 'comparison.created' | 'comparison.graded' | 'comparison.assembled' | 'comparison.revealed',
  matterId: string,
  payload: Record<string, unknown>,
) {
  try {
    const { record } = await import('../../../lib/ledger.mjs');
    const user = (await supabase.auth.getUser()).data.user;
    await record(supabase, {
      kind,
      matterId,
      actor: { kind: 'user', ref: user?.id ?? null, user_id: user?.id ?? null },
      payload,
    });
  } catch (err) {
    console.warn(`[comparator] ${kind} not recorded:`, err);
  }
}

// ---------------------------------------------------------------------------
// Types and comparisons
// ---------------------------------------------------------------------------
export async function listComparisonTypes(): Promise<ComparisonType[]> {
  const { data, error } = await supabase.from('comparison_types').select('key, label, default_rubric, sort').order('sort');
  if (error) fail(error);
  return (data ?? []) as ComparisonType[];
}

export async function listComparisons(boxId: string): Promise<Comparison[]> {
  const { data, error } = await supabase
    .from('comparisons')
    .select(CMP_COLS)
    .eq('box_matter_id', boxId)
    .order('created_at', { ascending: false });
  if (error) fail(error);
  return (data ?? []) as Comparison[];
}

export async function createComparison(args: {
  boxId: string;
  type: string;
  title: string;
  instructions: string;
  packetDocIds: string[];
  rubric: RubricDim[];
}): Promise<Comparison> {
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) throw new Error('You are signed out.');
  const { data, error } = await supabase
    .from('comparisons')
    .insert({
      box_matter_id: args.boxId,
      type: args.type,
      title: args.title.trim(),
      instructions: args.instructions,
      packet_doc_ids: args.packetDocIds,
      rubric: args.rubric,
      created_by: user.id,
    })
    .select(CMP_COLS)
    .single();
  if (error || !data) fail(error);
  const cmp = data as Comparison;
  await recordComparison('comparison.created', cmp.box_matter_id, {
    comparison_id: cmp.id,
    type: cmp.type,
    packet_count: cmp.packet_doc_ids.length,
    packet_hash: cmp.packet_hash,
  });
  return cmp;
}

export async function getComparison(id: string): Promise<Comparison> {
  const { data, error } = await supabase.from('comparisons').select(CMP_COLS).eq('id', id).maybeSingle();
  if (error) fail(error);
  if (!data) throw new Error('This comparison is not in a matter you can open.');
  return data as Comparison;
}

export async function listCandidates(comparisonId: string): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from('comparison_candidates')
    .select(`${CAND_COLS}, document:documents(id, title, processing_status)`)
    .eq('comparison_id', comparisonId);
  if (error) fail(error);
  const rows = (data ?? []) as unknown as Candidate[];
  return rows.sort((a, b) => (a.label.length - b.label.length) || a.label.localeCompare(b.label));
}

export async function listGrades(candidateIds: string[]): Promise<Grade[]> {
  if (!candidateIds.length) return [];
  const { data, error } = await supabase.from('candidate_grades').select(GRADE_COLS).in('candidate_id', candidateIds);
  if (error) fail(error);
  return (data ?? []) as Grade[];
}

/** Who made each candidate — readable only after the reveal (RLS returns nothing before). */
export async function keysFor(candidateIds: string[]): Promise<Record<string, string>> {
  if (!candidateIds.length) return {};
  const { data, error } = await supabase
    .from('comparison_candidate_keys')
    .select('candidate_id, revealed_label')
    .in('candidate_id', candidateIds);
  if (error) fail(error);
  return Object.fromEntries((data ?? []).map((r: { candidate_id: string; revealed_label: string }) => [r.candidate_id, r.revealed_label]));
}

// ---------------------------------------------------------------------------
// Candidates — through the server action only
// ---------------------------------------------------------------------------
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('could not read the file'));
    r.onload = () => {
      const s = String(r.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.readAsDataURL(file);
  });
}

export async function addCandidateFromFile(comparisonId: string, file: File, revealedLabel: string) {
  const content = await fileToBase64(file);
  return sandboxApi<{ candidate_id: string; label: string; document_id: string; title: string; word_count: number | null; key_filed: boolean }>(
    'add_comparison_candidate',
    { comparison_id: comparisonId, filename: file.name, content, encoding: 'base64', revealed_label: revealedLabel.trim() || undefined },
  );
}

// ---------------------------------------------------------------------------
// The reader: is this document a candidate? Its grade card. Its notes' tags.
// ---------------------------------------------------------------------------
export interface CandidateContext {
  candidate: Candidate;
  comparison: Comparison;
}

/** The candidate this document is, or null (also null before migration 120). */
export async function candidateForDocument(documentId: string): Promise<CandidateContext | null> {
  const { data, error } = await supabase
    .from('comparison_candidates')
    .select(CAND_COLS)
    .eq('document_id', documentId)
    .limit(1);
  if (error || !data?.length) return null;
  const candidate = data[0] as Candidate;
  try {
    const comparison = await getComparison(candidate.comparison_id);
    return { candidate, comparison };
  } catch {
    return null;
  }
}

export async function getGrade(candidateId: string): Promise<Grade | null> {
  const { data, error } = await supabase.from('candidate_grades').select(GRADE_COLS).eq('candidate_id', candidateId).maybeSingle();
  if (error) fail(error);
  return (data as Grade | null) ?? null;
}

export async function saveGrade(ctx: CandidateContext, args: {
  scores: Record<string, number>;
  overall: number;
  comment: string;
  initials: string;
}): Promise<Grade> {
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) throw new Error('You are signed out.');
  const initials = args.initials.trim().toUpperCase().slice(0, 6);
  if (!initials) throw new Error('Initials are needed: the grade card records who graded it.');
  const { data, error } = await supabase
    .from('candidate_grades')
    .upsert({
      candidate_id: ctx.candidate.id,
      scores: args.scores,
      overall: args.overall,
      comment: args.comment,
      initials,
      graded_by: user.id,
    }, { onConflict: 'candidate_id' })
    .select(GRADE_COLS)
    .single();
  if (error || !data) fail(error);
  const g = data as Grade;
  await recordComparison('comparison.graded', ctx.comparison.box_matter_id, {
    comparison_id: ctx.comparison.id,
    candidate_id: ctx.candidate.id,
    label: ctx.candidate.label,
    overall: g.overall,
    initials: g.initials,
  });
  return g;
}

/** Tags of the margin notes on one document: {annotation id: tag}. */
export async function annotationTags(documentId: string): Promise<Record<string, string | null>> {
  const { data, error } = await supabase.from('document_annotations').select('id, tag').eq('document_id', documentId);
  if (error) return {};
  return Object.fromEntries((data ?? []).map((r: { id: string; tag: string | null }) => [r.id, r.tag]));
}

export async function setAnnotationTag(annotationId: string, tag: string | null): Promise<boolean> {
  const { error } = await supabase.from('document_annotations').update({ tag }).eq('id', annotationId);
  if (error) {
    console.warn('[comparator] tag not saved:', error.message);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Assembly and reveal
// ---------------------------------------------------------------------------
interface NoteRow {
  id: string;
  document_id: string;
  page: number;
  note: string | null;
  anchor_text: string | null;
  tag: string | null;
  line_start: number | null;
  line_end: number | null;
  text_anchor: { start: number } | null;
  created_at: string;
  author: { display_name: string | null; email: string | null } | null;
}

/** Build the Comparison notes (deterministic) and file them into the box. */
export async function assembleAndFile(comparisonId: string): Promise<{ document_id: string; filename: string; markdown: string }> {
  const cmp = await getComparison(comparisonId);
  const candidates = await listCandidates(comparisonId);
  const grades = await listGrades(candidates.map((c) => c.id));
  const keys = cmp.revealed_at ? await keysFor(candidates.map((c) => c.id)) : {};

  const [{ data: matter }, { data: type }, { data: packet }] = await Promise.all([
    supabase.from('matterspaces').select('name, short_code').eq('id', cmp.box_matter_id).maybeSingle(),
    supabase.from('comparison_types').select('label').eq('key', cmp.type).maybeSingle(),
    cmp.packet_doc_ids.length
      ? supabase.from('documents').select('id, title').in('id', cmp.packet_doc_ids)
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
  ]);

  const docToCandidate = new Map(candidates.filter((c) => c.document_id).map((c) => [c.document_id as string, c.id]));
  const docIds = [...docToCandidate.keys()];
  let notes: AssembleNote[] = [];
  if (docIds.length) {
    const { rows: raw } = await fetchPaged<unknown>(
      (from, to) => supabase
        .from('document_annotations')
        .select(NOTE_COLS)
        .in('document_id', docIds)
        .order('created_at')
        .order('id')
        .range(from, to),
      { label: 'comparison notes' },
    );
    const rows = raw as NoteRow[];
    notes = rows.map((r) => ({
      id: r.id,
      candidate_id: docToCandidate.get(r.document_id) as string,
      note: r.note,
      anchor_text: r.anchor_text,
      tag: r.tag,
      page: r.page,
      line_start: r.line_start,
      line_end: r.line_end,
      text_anchor: r.text_anchor,
      created_at: r.created_at,
      author: r.author?.display_name || r.author?.email?.split('@')[0] || null,
    }));
  }

  const packetById = new Map(((packet ?? []) as { id: string; title: string }[]).map((d) => [d.id, d.title]));
  const now = new Date().toISOString();
  const markdown = assembleComparisonNotes({
    matter: { name: matter?.name ?? 'Sandbox box', short_code: matter?.short_code ?? null },
    comparison: {
      title: cmp.title,
      type: cmp.type,
      type_label: type?.label ?? null,
      instructions: cmp.instructions,
      packet: cmp.packet_doc_ids.map((id) => ({ id, title: packetById.get(id) ?? '(a document you cannot open)' })),
      packet_hash: cmp.packet_hash,
      rubric: cmp.rubric,
      revealed_at: cmp.revealed_at,
    },
    candidates: candidates.map((c) => ({ id: c.id, label: c.label, word_count: c.word_count, revealed_label: keys[c.id] ?? null })),
    grades: grades.map((g) => ({ ...g })),
    notes,
    generated_at: now,
  });

  const typeLabel = (type?.label ?? cmp.type).replace(/[\\/:*?"<>|]+/g, ' ').trim();
  const stamp = now.slice(0, 16).replace('T', ' ').replace(':', '');
  const filename = `Comparison — ${typeLabel} — ${stamp}.md`;
  const out = await sandboxApi<{ document_id: string }>('file_document', {
    matter: cmp.box_matter_id,
    filename,
    title: `Comparison — ${type?.label ?? cmp.type} — ${now.slice(0, 10)} — ${cmp.title}`,
    content: markdown,
    doc_type: 'other',
  });
  await recordComparison('comparison.assembled', cmp.box_matter_id, { comparison_id: cmp.id, document_id: out.document_id });
  return { document_id: out.document_id, filename, markdown };
}

/** Reveal: the database refuses unless every candidate has a grade card. */
export async function revealComparison(cmp: Comparison, candidates: Candidate[]): Promise<{ comparison: Comparison; keys: Record<string, string> }> {
  const { data, error } = await supabase
    .from('comparisons')
    .update({ revealed_at: new Date().toISOString() })
    .eq('id', cmp.id)
    .select(CMP_COLS)
    .single();
  if (error || !data) fail(error);
  const comparison = data as Comparison;
  const keys = await keysFor(candidates.map((c) => c.id));
  await recordComparison('comparison.revealed', comparison.box_matter_id, {
    comparison_id: comparison.id,
    key: candidates.map((c) => ({ label: c.label, revealed_label: keys[c.id] ?? null })),
  });
  return { comparison, keys };
}

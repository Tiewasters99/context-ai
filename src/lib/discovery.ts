// Discovery module data layer — typed helpers over supabase-js for the
// litigation-discovery tables created by migration 030:
//   productions, production_items, document_tag_defs, document_tags,
//   bates_registry, privilege_log_entries, deliveries, processing_jobs
// plus the private 'discovery-files' storage bucket
// (path convention: {matterspace_id}/{production_id}/...).
//
// All heavy work (ZIP intake, normalization, stamping, packaging) happens in
// the discovery worker; the frontend only inserts processing_jobs rows and
// polls their progress.

import { supabase } from './supabase';
import { fetchPaged, type PagedRows } from './paged';
import { storageObjectUrl, isStepUpRequired, type ObjectPurpose } from './vault-object';
// Resumable (TUS) uploads for large intake files (Phase 4) — a production
// zip is the biggest thing anyone uploads to this site.
import { uploadResumable, shouldUploadResumable, storageResumeStore, type UploadProgress } from '../../lib/tus-upload.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Types mirroring the migration's enums + tables
// ─────────────────────────────────────────────────────────────────────────────

export type ProductionDirection = 'incoming' | 'outgoing';

export type ProductionStatus =
  | 'intake'
  | 'processing'
  // Migration 071 (F5). An intake parked by the SecureSpace seal or by the AI
  // pause is not an error and is certainly not still 'processing'. The reason
  // is in `status_reason`.
  | 'held'
  | 'review'
  | 'stamped'
  | 'packaged'
  | 'delivered'
  | 'received'
  | 'error';

export type ProductionItemKind = 'display_pdf' | 'native';

export type DiscoveryJobStatus = 'queued' | 'running' | 'done' | 'error';

export type PrivilegeBasis =
  | 'attorney_client'
  | 'work_product'
  | 'marital'
  | 'physician_patient'
  | 'pastor_parishioner'
  | 'custom';

export type BatesPosition =
  | 'lower_left'
  | 'lower_center'
  | 'lower_right'
  | 'upper_left'
  | 'upper_center'
  | 'upper_right';

export type DiscoveryJobType =
  | 'intake_zip'
  | 'intake_files'
  | 'intake_documents'
  | 'intake_folder'
  | 'normalize_item'
  | 'stamp_production'
  | 'package_production';

export interface Production {
  id: string;
  matterspace_id: string;
  direction: ProductionDirection;
  name: string;
  producing_party: string | null;
  receiving_party: string | null;
  production_date: string | null; // ISO date
  status: ProductionStatus;
  /**
   * The plain sentence behind whatever status the production is in
   * (migration 071). Null on a deployment that has not applied 071 — which
   * reads the same as "nothing to say", so no surface has to special-case it.
   */
  status_reason: string | null;
  bates_prefix: string | null;
  bates_pad: number;
  bates_start: number | null;
  bates_end: number | null;
  bates_position: BatesPosition;
  request_refs: string | null;
  notes: string | null;
  package_storage_path: string | null;
  package_sha256: string | null;
  locked_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductionListEntry extends Production {
  item_count: number;
}

export interface DocumentTagDef {
  id: string;
  matterspace_id: string;
  name: string;
  color: string;
  is_endorsement: boolean;
  endorsement_text: string | null;
  is_preset: boolean;
  behavior: 'privileged' | 'non_responsive' | null;
  created_by: string | null;
  created_at: string;
}

export interface DocumentTag {
  id: string;
  tag_def_id: string;
  production_item_id: string;
  matterspace_id: string;
  created_by: string | null;
  created_at: string;
  tag_def?: DocumentTagDef;
}

export interface ProductionItem {
  id: string;
  production_id: string;
  matterspace_id: string;
  document_id: string | null;
  sort_order: number;
  original_filename: string;
  original_path: string | null;
  sha256: string | null;
  file_size_bytes: number | null;
  kind: ProductionItemKind;
  display_storage_path: string | null;
  native_storage_path: string | null;
  page_count: number | null;
  bates_first: string | null;
  bates_last: string | null;
  /** Where this document's Bates number goes, when it differs from the
   *  production's (migration 111); null = the production's position. */
  stamp_position?: BatesPosition | null;
  source_metadata: Record<string, unknown>;
  /** An exact duplicate of another item in this production (071), or a filed
   *  copy set aside by "Remove duplicates of email attachments". */
  duplicate_of_item_id?: string | null;
  status: string; // pending | ready | error
  error: string | null;
  created_at: string;
  tags: DocumentTag[];
}

export interface BatesRegistryRow {
  id: string;
  matterspace_id: string;
  bates_number: string;
  bates_seq: number;
  production_id: string;
  production_item_id: string;
  page_number: number;
  created_at: string;
}

export interface PrivilegeLogEntry {
  id: string;
  matterspace_id: string;
  production_id: string;
  production_item_id: string;
  doc_date: string | null;
  author: string | null;
  addressee: string | null;
  cc: string | null;
  subject_matter: string | null;
  basis: PrivilegeBasis;
  basis_custom: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface Delivery {
  id: string;
  matterspace_id: string;
  production_id: string;
  recipient_name: string;
  recipient_email: string | null;
  method: 'download' | 'email_link';
  package_storage_path: string | null;
  package_sha256: string | null;
  bates_range: string | null;
  sent_at: string;
  created_by: string | null;
}

export interface ProcessingJob {
  id: string;
  matterspace_id: string;
  production_id: string | null;
  job_type: DiscoveryJobType | string;
  payload: Record<string, unknown>;
  status: DiscoveryJobStatus;
  progress: number;
  progress_note: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  error: string | null;
  created_by: string | null;
  created_at: string;
}

export const PRIVILEGE_BASIS_LABELS: Record<PrivilegeBasis, string> = {
  attorney_client: 'Attorney-Client',
  work_product: 'Attorney Work-Product',
  marital: 'Marital',
  physician_patient: 'Physician/Patient',
  pastor_parishioner: 'Pastor/Parishioner',
  custom: 'Custom…',
};

export const BATES_POSITIONS: BatesPosition[] = [
  'upper_left', 'upper_center', 'upper_right',
  'lower_left', 'lower_center', 'lower_right',
];

export const BATES_POSITION_LABEL: Record<BatesPosition, string> = {
  upper_left: 'Upper left', upper_center: 'Upper center', upper_right: 'Upper right',
  lower_left: 'Lower left', lower_center: 'Lower center', lower_right: 'Lower right',
};

/** Move one document's Bates stamp (null = back to the production's). Only
 *  before stamping: the production lock (030) refuses it afterwards. */
export async function setItemStampPosition(itemId: string, position: BatesPosition | null): Promise<void> {
  const { error } = await supabase.from('production_items').update({ stamp_position: position }).eq('id', itemId);
  if (error) {
    if (/stamp_position/.test(error.message) && /column|schema cache/i.test(error.message)) {
      throw new Error('Per-document stamp position arrives with migration 111 — ask Eden to apply it.');
    }
    throw new Error(`stamp position: ${error.message}`);
  }
}

// Render a Bates number from a config — the same arithmetic the worker
// applies, so the live preview matches what gets stamped.
export function formatBates(prefix: string, pad: number, seq: number): string {
  return `${prefix}${String(seq).padStart(pad, '0')}`;
}

async function currentUserId(): Promise<string | undefined> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Productions
// ─────────────────────────────────────────────────────────────────────────────

export async function listProductions(matterspaceId: string): Promise<ProductionListEntry[]> {
  const { data, error } = await supabase
    .from('productions')
    .select('*, production_items(count)')
    .eq('matterspace_id', matterspaceId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`list productions: ${error.message}`);
  return (data ?? []).map((row: Record<string, unknown>) => {
    const counts = row.production_items as { count: number }[] | null;
    const entry = { ...row } as unknown as ProductionListEntry;
    entry.item_count = counts?.[0]?.count ?? 0;
    delete (entry as unknown as Record<string, unknown>).production_items;
    return entry;
  });
}

export async function getProduction(id: string): Promise<Production | null> {
  const { data, error } = await supabase
    .from('productions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`get production: ${error.message}`);
  return (data as Production | null) ?? null;
}

export interface CreateProductionInput {
  matterspace_id: string;
  direction: ProductionDirection;
  name: string;
  producing_party?: string | null;
  receiving_party?: string | null;
  production_date?: string | null;
  request_refs?: string | null;
  notes?: string | null;
}

export async function createProduction(input: CreateProductionInput): Promise<Production> {
  const { data, error } = await supabase
    .from('productions')
    .insert({ ...input, created_by: await currentUserId() })
    .select('*')
    .single();
  if (error) throw new Error(`create production: ${error.message}`);
  return data as Production;
}

export async function updateProduction(
  id: string,
  patch: Partial<Omit<Production, 'id' | 'created_at' | 'updated_at'>>,
): Promise<Production> {
  const { data, error } = await supabase
    .from('productions')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`update production: ${error.message}`);
  return data as Production;
}

// ─────────────────────────────────────────────────────────────────────────────
// Production items (with their tags)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A production's items.
 *
 * Paged. Unpaged, a production of more than 1,000 items quietly became a
 * production of 1,000: PostgREST caps an unbounded select at `db-max-rows`
 * and returns 200. Everything downstream — the review list, the tag counts,
 * the Bates range, what gets stamped and packaged — ran on the truncated set,
 * so a 2,500-document production would have been produced 1,000 documents
 * short with nothing on screen to say so. For a court-ordered production that
 * is not a display bug.
 *
 * `.order('id')` after `sort_order` is load-bearing: `sort_order` is an int
 * that ties constantly (every item intake-ordered at 0), and unbroken ties
 * let rows move between `.range()` pages — dropping some and duplicating
 * others.
 */
export async function listProductionItems(productionId: string): Promise<PagedRows<ProductionItem>> {
  const page = await fetchPaged<Record<string, unknown>>(
    (from, to) => supabase
      .from('production_items')
      .select('*, document_tags(*, tag_def:document_tag_defs(*))', { count: 'exact' })
      .eq('production_id', productionId)
      .order('sort_order', { ascending: true })
      .order('id')
      .range(from, to),
    { label: 'list production items', ceiling: 50_000 },
  );
  return {
    ...page,
    rows: page.rows.map((row) => {
      const item = { ...row } as unknown as ProductionItem;
      item.tags = ((row.document_tags as DocumentTag[] | null) ?? []);
      delete (item as unknown as Record<string, unknown>).document_tags;
      return item;
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tag defs — CRUD + per-matter preset seeding
// ─────────────────────────────────────────────────────────────────────────────

export async function listTagDefs(matterspaceId: string): Promise<DocumentTagDef[]> {
  const { data, error } = await supabase
    .from('document_tag_defs')
    .select('*')
    .eq('matterspace_id', matterspaceId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`list tag defs: ${error.message}`);
  return (data ?? []) as DocumentTagDef[];
}

export interface CreateTagDefInput {
  matterspace_id: string;
  name: string;
  color: string;
  is_endorsement?: boolean;
  endorsement_text?: string | null;
  is_preset?: boolean;
  behavior?: 'privileged' | 'non_responsive' | null;
}

export async function createTagDef(input: CreateTagDefInput): Promise<DocumentTagDef> {
  const { data, error } = await supabase
    .from('document_tag_defs')
    .insert({ ...input, created_by: await currentUserId() })
    .select('*')
    .single();
  if (error) throw new Error(`create tag: ${error.message}`);
  return data as DocumentTagDef;
}

export async function updateTagDef(
  id: string,
  patch: Partial<Pick<DocumentTagDef, 'name' | 'color' | 'is_endorsement' | 'endorsement_text' | 'behavior'>>,
): Promise<DocumentTagDef> {
  const { data, error } = await supabase
    .from('document_tag_defs')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`update tag: ${error.message}`);
  return data as DocumentTagDef;
}

export async function deleteTagDef(id: string): Promise<void> {
  const { error } = await supabase.from('document_tag_defs').delete().eq('id', id);
  if (error) throw new Error(`delete tag: ${error.message}`);
}

// The preset tags every matter starts with. Seeded app-side on first open of
// Discovery for a matter (the migration leaves seeding to us); a matter that
// already has some gets the missing ones, by name, the next time it opens.
//   * Privileged, Non-Responsive, Irrelevant keep a document OUT of the
//     produced set (behavior), and Privileged sends it to the privilege log;
//   * Confidential and Attorneys' Eyes Only are DESIGNATIONS: burned on every
//     page (is_endorsement) and recorded in the load file's CONFIDENTIALITY;
//   * Hot Doc is for review only and never prints.
export const PRESET_TAGS: Omit<CreateTagDefInput, 'matterspace_id'>[] = [
  {
    name: 'Privileged',
    color: '#f87171',
    is_endorsement: true,
    endorsement_text: 'PRIVILEGED',
    is_preset: true,
    behavior: 'privileged',
  },
  {
    name: 'Hot Doc',
    color: '#fbbf24',
    is_endorsement: false,
    endorsement_text: null,
    is_preset: true,
    behavior: null,
  },
  {
    name: 'Confidential',
    color: '#60a5fa',
    is_endorsement: true,
    endorsement_text: 'CONFIDENTIAL',
    is_preset: true,
    behavior: null,
  },
  {
    name: 'Non-Responsive',
    color: '#9ca3af',
    is_endorsement: false,
    endorsement_text: null,
    is_preset: true,
    behavior: 'non_responsive',
  },
  {
    name: "Attorneys' Eyes Only",
    color: '#c084fc',
    is_endorsement: true,
    endorsement_text: "HIGHLY CONFIDENTIAL - ATTORNEYS' EYES ONLY",
    is_preset: true,
    behavior: null,
  },
  {
    name: 'Irrelevant',
    color: '#78716c',
    is_endorsement: false,
    endorsement_text: null,
    is_preset: true,
    behavior: 'non_responsive',
  },
];

// Idempotent: inserts whichever of the presets the matter is missing
// (by name) and returns the full def list afterwards.
export async function ensurePresetTagDefs(matterspaceId: string): Promise<DocumentTagDef[]> {
  const existing = await listTagDefs(matterspaceId);
  const have = new Set(existing.map((d) => d.name));
  const missing = PRESET_TAGS.filter((p) => !have.has(p.name));
  if (missing.length > 0) {
    const uid = await currentUserId();
    const { error } = await supabase.from('document_tag_defs').insert(
      missing.map((p) => ({ ...p, matterspace_id: matterspaceId, created_by: uid })),
    );
    // A unique-violation race (two tabs seeding at once) is harmless.
    if (error && !/duplicate|unique/i.test(error.message)) {
      throw new Error(`seed preset tags: ${error.message}`);
    }
    return listTagDefs(matterspaceId);
  }
  return existing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document tags — apply / remove
// ─────────────────────────────────────────────────────────────────────────────

export async function applyTag(
  tagDefId: string,
  productionItemId: string,
  matterspaceId: string,
): Promise<DocumentTag> {
  const { data, error } = await supabase
    .from('document_tags')
    .insert({
      tag_def_id: tagDefId,
      production_item_id: productionItemId,
      matterspace_id: matterspaceId,
      created_by: await currentUserId(),
    })
    .select('*, tag_def:document_tag_defs(*)')
    .single();
  if (error) throw new Error(`apply tag: ${error.message}`);
  return data as DocumentTag;
}

export async function removeTag(tagDefId: string, productionItemId: string): Promise<void> {
  const { error } = await supabase
    .from('document_tags')
    .delete()
    .eq('tag_def_id', tagDefId)
    .eq('production_item_id', productionItemId);
  if (error) throw new Error(`remove tag: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Review tags — tags on the matter's DOCUMENTS (migration 113, spec R1).
// One tag, one document, seen in every production built later. Productions
// keep their own document_tags; nothing here is stamped.
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentReviewTag {
  id: string;
  tag_def_id: string;
  document_id: string;
  matterspace_id: string;
  created_by: string | null;
  created_at: string;
}

export type TagKind = 'exclusion' | 'designation' | 'note' | 'issue';

/** What a tag does, for grouping (spec Q2: one list, labelled by kind).
 *  Exclusions keep a document out of a production; designations are burned
 *  on; notes never print; everything else the firm adds is an issue code. */
export function tagKindOf(def: Pick<DocumentTagDef, 'behavior' | 'is_endorsement' | 'name'>): TagKind {
  if (def.behavior) return 'exclusion';
  if (def.is_endorsement) return 'designation';
  if (def.name === 'Hot Doc') return 'note';
  return 'issue';
}

export const TAG_KIND_LABEL: Record<TagKind, string> = {
  exclusion: 'Keeps it out',
  designation: 'Designations',
  note: 'Notes',
  issue: 'Issues',
};

/** True when 113 has not been pasted yet (PostgREST cannot find the table). */
export function isReviewTagsMissing(message: string): boolean {
  return /document_review_tags/.test(message) && /schema cache|does not exist|not find/i.test(message);
}

export async function listReviewTags(matterspaceId: string): Promise<DocumentReviewTag[]> {
  const { rows } = await fetchPaged<DocumentReviewTag>(
    (from, to) => supabase
      .from('document_review_tags')
      .select('*', { count: 'exact' })
      .eq('matterspace_id', matterspaceId)
      .order('id')
      .range(from, to),
    { label: 'review tags', ceiling: 200_000 },
  );
  return rows;
}

const REVIEW_TAG_CHUNK = 200;

/** Tag every listed document (already-tagged ones are left as they are). */
export async function applyReviewTag(
  tagDefId: string,
  documentIds: string[],
  matterspaceId: string,
): Promise<void> {
  const uid = await currentUserId();
  for (let i = 0; i < documentIds.length; i += REVIEW_TAG_CHUNK) {
    const { error } = await supabase
      .from('document_review_tags')
      .upsert(
        documentIds.slice(i, i + REVIEW_TAG_CHUNK).map((document_id) => ({
          tag_def_id: tagDefId, document_id, matterspace_id: matterspaceId, created_by: uid,
        })),
        { onConflict: 'tag_def_id,document_id', ignoreDuplicates: true },
      );
    if (error) throw new Error(`tag documents: ${error.message}`);
  }
}

export async function removeReviewTag(tagDefId: string, documentIds: string[]): Promise<void> {
  for (let i = 0; i < documentIds.length; i += REVIEW_TAG_CHUNK) {
    const { error } = await supabase
      .from('document_review_tags')
      .delete()
      .eq('tag_def_id', tagDefId)
      .in('document_id', documentIds.slice(i, i + REVIEW_TAG_CHUNK));
    if (error) throw new Error(`untag documents: ${error.message}`);
  }
}

export interface ReviewDocument {
  id: string;
  title: string;
  source_filename: string | null;
  /** Lower-case extension of the original file, '' when unknown. */
  ext: string;
  page_count: number | null;
  created_at: string;
  matterspace_id: string;
  /** The folder or sub-matter it is filed in, when not the matter itself. */
  folder: string | null;
  /** The production it arrived in, when it was filed from one. */
  production_id: string | null;
  /** Why it cannot go into a production, or null when it can. */
  blocked: string | null;
}

interface ReviewDocumentRow {
  id: string;
  title: string | null;
  source_filename: string | null;
  page_count: number | null;
  created_at: string;
  matterspace_id: string;
  production_id: string | null;
  storage_path: string | null;
  file_size_bytes: number | null;
}

/**
 * Every document filed in this matter and its folders/sub-matters, for the
 * Review tab. Unlike the "From this matter" picker, documents filed from a
 * production are kept: an incoming volume is reviewed here too.
 */
export async function listReviewDocuments(matterId: string): Promise<{
  docs: ReviewDocument[]; truncated: boolean;
}> {
  const { data: tree } = await supabase.rpc('matterspace_descendants', { p_root: matterId });
  const ids = ((tree ?? []) as { id: string }[]).map((r) => r.id);
  if (!ids.includes(matterId)) ids.push(matterId);
  const { data: names } = await supabase.from('matterspaces').select('id, name').in('id', ids);
  const nameOf = new Map(((names ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]));

  const { rows, truncated } = await fetchPaged<ReviewDocumentRow>(
    (from, to) => supabase
      .from('documents')
      .select('id, title, source_filename, page_count, created_at, matterspace_id, storage_path, file_size_bytes, production_id:metadata->>production_id', { count: 'exact' })
      .in('matterspace_id', ids)
      .order('title')
      .order('id')
      .range(from, to),
    { label: 'review documents', ceiling: 20_000 },
  );

  const docs = rows.map((d): ReviewDocument => {
    const name = d.source_filename || d.title || '';
    const dot = name.lastIndexOf('.');
    return {
      id: d.id,
      title: d.title || d.source_filename || 'Untitled',
      source_filename: d.source_filename,
      ext: dot > 0 && dot > name.length - 7 ? name.slice(dot + 1).toLowerCase() : '',
      page_count: d.page_count,
      created_at: d.created_at,
      matterspace_id: d.matterspace_id,
      folder: d.matterspace_id === matterId ? null : (nameOf.get(d.matterspace_id) ?? 'Sub-matter'),
      production_id: d.production_id,
      blocked: !d.storage_path ? 'Still uploading, or no stored file'
        : (d.file_size_bytes ?? 0) > MAX_MATTER_PICK_BYTES ? `Over ${MAX_MATTER_PICK_BYTES / 1048576} MB`
          : null,
    };
  });
  return { docs, truncated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sets (migration 114, spec R2): a saved question about the matter's
// documents, or a hand-picked list; productions are built from them.
// ─────────────────────────────────────────────────────────────────────────────

export interface FilterRule {
  kind: 'filter';
  tags_has: string[];
  tags_not: string[];
  folder: string;   // '' = any; '(matter)' = the matter itself
  ext: string;      // '' = any
  text: string;
  from: string;     // yyyy-mm-dd filed on or after, '' = any
  to: string;       // yyyy-mm-dd filed on or before, '' = any
}
export interface ListRule { kind: 'list'; document_ids: string[] }
export type SetRule = FilterRule | ListRule;

export interface DiscoverySet {
  id: string;
  matterspace_id: string;
  name: string;
  rule: SetRule;
  created_by: string | null;
  created_at: string;
}

export const EMPTY_FILTER: FilterRule = {
  kind: 'filter', tags_has: [], tags_not: [], folder: '', ext: '', text: '', from: '', to: '',
};

/** One rule, two uses: the Review tab's filters and a saved set. */
export function matchesRule(doc: ReviewDocument, tags: Set<string> | undefined, rule: SetRule): boolean {
  if (rule.kind === 'list') return rule.document_ids.includes(doc.id);
  const q = rule.text.trim().toLowerCase();
  if (q && !doc.title.toLowerCase().includes(q) && !(doc.source_filename ?? '').toLowerCase().includes(q)) return false;
  if (rule.folder && (doc.folder ?? '') !== (rule.folder === '(matter)' ? '' : rule.folder)) return false;
  if (rule.ext && doc.ext !== rule.ext) return false;
  const day = doc.created_at.slice(0, 10);
  if (rule.from && day < rule.from) return false;
  if (rule.to && day > rule.to) return false;
  for (const id of rule.tags_has) if (!tags?.has(id)) return false;
  for (const id of rule.tags_not) if (tags?.has(id)) return false;
  return true;
}

export function isFilterEmpty(rule: FilterRule): boolean {
  return !rule.tags_has.length && !rule.tags_not.length && !rule.folder && !rule.ext
    && !rule.text.trim() && !rule.from && !rule.to;
}

/** True when a rule would mean "every document in the matter" (a filter with
 *  nothing set) or nothing at all (an empty list). Such a set is never saved:
 *  on 2026-10-13 an empty filter saved as a set produced all 2,660 documents
 *  of the Patel matter instead of the 269 the reviewer had filtered to. */
export function isRuleEmpty(rule: SetRule): boolean {
  return rule.kind === 'list' ? rule.document_ids.length === 0 : isFilterEmpty(rule);
}

/** A rule in plain words, for the line that says what is about to be saved. */
export function describeRule(rule: SetRule, defs: DocumentTagDef[]): string {
  if (rule.kind === 'list') {
    return `${rule.document_ids.length} ticked ${rule.document_ids.length === 1 ? 'document' : 'documents'}`;
  }
  const tagName = (id: string) => defs.find((d) => d.id === id)?.name ?? 'a deleted tag';
  const parts: string[] = [];
  if (rule.text.trim()) parts.push(`name contains "${rule.text.trim()}"`);
  for (const id of rule.tags_has) parts.push(`tagged ${tagName(id)}`);
  for (const id of rule.tags_not) parts.push(`not tagged ${tagName(id)}`);
  if (rule.folder) parts.push(rule.folder === '(matter)' ? 'filed in the matter itself' : `folder ${rule.folder}`);
  if (rule.ext) parts.push(`.${rule.ext.replace(/^\./, '')} files`);
  if (rule.from) parts.push(`filed on or after ${rule.from}`);
  if (rule.to) parts.push(`filed on or before ${rule.to}`);
  return parts.length ? parts.join(' · ') : 'no filter (the whole matter)';
}

/** True when 114 has not been pasted yet. */
export function isSetsMissing(message: string): boolean {
  return /discovery_sets|source_set/.test(message) && /schema cache|does not exist|not find/i.test(message);
}

export async function listSets(matterspaceId: string): Promise<DiscoverySet[]> {
  const { data, error } = await supabase
    .from('discovery_sets')
    .select('*')
    .eq('matterspace_id', matterspaceId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`list sets: ${error.message}`);
  return (data ?? []) as DiscoverySet[];
}

export async function createSet(matterspaceId: string, name: string, rule: SetRule): Promise<DiscoverySet> {
  if (isRuleEmpty(rule)) {
    throw new Error(rule.kind === 'list'
      ? 'No documents are ticked, so there is nothing to save. Nothing was saved.'
      : 'A set needs at least one filter (a name, a tag, a folder...). Without one it would be the whole matter. Nothing was saved.');
  }
  const { data, error } = await supabase
    .from('discovery_sets')
    .insert({ matterspace_id: matterspaceId, name: name.trim(), rule, created_by: await currentUserId() })
    .select('*')
    .single();
  if (error) {
    if (/duplicate|unique/i.test(error.message)) throw new Error(`There is already a set called "${name.trim()}".`);
    throw new Error(`save set: ${error.message}`);
  }
  return data as DiscoverySet;
}

export async function deleteSet(id: string): Promise<void> {
  const { error } = await supabase.from('discovery_sets').delete().eq('id', id);
  if (error) throw new Error(`delete set: ${error.message}`);
}

export interface SetSplit {
  /** Go into the production and are stamped. */
  produce: ReviewDocument[];
  /** Tagged Privileged: go into the production, are withheld at stamping and
   *  listed on its privilege log (the tag is copied onto the item, 114). */
  privileged: ReviewDocument[];
  /** Tagged Non-Responsive or Irrelevant (any tag that keeps a document out
   *  other than Privileged): never sent to the production. */
  heldBack: ReviewDocument[];
  /** Cannot be read from the matter (no stored file, too large). */
  blocked: ReviewDocument[];
}

/** Sort a set's documents the way a production built from it treats them.
 *  Exclusion tags win over everything the rule says (spec 3.3). */
export function splitForProduction(
  docs: ReviewDocument[],
  tagsByDoc: Map<string, Set<string>>,
  defs: DocumentTagDef[],
): SetSplit {
  const privileged = new Set(defs.filter((d) => d.behavior === 'privileged').map((d) => d.id));
  const keepOut = new Set(defs.filter((d) => d.behavior && d.behavior !== 'privileged').map((d) => d.id));
  const out: SetSplit = { produce: [], privileged: [], heldBack: [], blocked: [] };
  for (const d of docs) {
    const tags = tagsByDoc.get(d.id);
    const has = (ids: Set<string>) => !!tags && [...ids].some((id) => tags.has(id));
    if (has(keepOut)) out.heldBack.push(d);
    else if (d.blocked) out.blocked.push(d);
    else if (has(privileged)) out.privileged.push(d);
    else out.produce.push(d);
  }
  return out;
}

/**
 * Build an outgoing production from a set: create the production (recording
 * the set and its rule as they stand now), then queue the documents with the
 * same server-side job as "From this matter" (intake_documents, 110). Each
 * document's review tags follow it onto its item (114's trigger).
 */
export async function produceFromSet(args: {
  matterspaceId: string;
  set: Pick<DiscoverySet, 'id' | 'name'> | null;
  rule: SetRule;
  documentIds: string[];
  name: string;
  receivingParty: string | null;
  productionDate: string | null;
  requestRefs: string | null;
}): Promise<Production> {
  if (args.documentIds.length === 0) throw new Error('There is nothing in this set to produce.');
  if (args.documentIds.length > MAX_MATTER_PICK_COUNT) {
    throw new Error(`A production can take ${MAX_MATTER_PICK_COUNT.toLocaleString()} documents at a time; this set has ${args.documentIds.length.toLocaleString()}. Narrow the set and produce it in parts.`);
  }
  const prod = await createProduction({
    matterspace_id: args.matterspaceId,
    direction: 'outgoing',
    name: args.name.trim(),
    receiving_party: args.receivingParty,
    production_date: args.productionDate,
    request_refs: args.requestRefs,
    notes: args.set ? `Built from the set "${args.set.name}".` : 'Built from the Review tab.',
  });
  const { error } = await supabase
    .from('productions')
    .update({
      source_set_id: args.set?.id ?? null,
      source_set_rule: { ...args.rule, set_name: args.set?.name ?? null, frozen_at: new Date().toISOString() },
    })
    .eq('id', prod.id);
  if (error && !isSetsMissing(error.message)) throw new Error(`record the set on the production: ${error.message}`);
  await enqueueJob({
    matterspace_id: args.matterspaceId,
    production_id: prod.id,
    job_type: 'intake_documents',
    payload: { document_ids: args.documentIds, ingest: false },
  });
  return prod;
}

// ─────────────────────────────────────────────────────────────────────────────
// Privilege log
// ─────────────────────────────────────────────────────────────────────────────

export async function listPrivilegeLogEntries(productionId: string): Promise<PrivilegeLogEntry[]> {
  const { data, error } = await supabase
    .from('privilege_log_entries')
    .select('*')
    .eq('production_id', productionId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`list privilege log: ${error.message}`);
  return (data ?? []) as PrivilegeLogEntry[];
}

// Draft an entry when an item is tagged Privileged in an outgoing
// production. ignoreDuplicates keeps an existing (possibly hand-edited)
// entry intact if the reviewer toggles the tag off and on again.
export async function ensurePrivilegeDraft(args: {
  matterspace_id: string;
  production_id: string;
  production_item_id: string;
  source_metadata: Record<string, unknown>;
}): Promise<void> {
  const meta = args.source_metadata ?? {};
  const str = (k: string): string | null => {
    const v = meta[k];
    return typeof v === 'string' && v.trim() ? v : null;
  };
  // Only accept a metadata date that parses; a junk doc_date would fail the
  // insert's date column.
  const rawDate = str('date');
  const doc_date = rawDate && !Number.isNaN(Date.parse(rawDate))
    ? new Date(rawDate).toISOString().slice(0, 10)
    : null;
  const { error } = await supabase
    .from('privilege_log_entries')
    .upsert(
      {
        matterspace_id: args.matterspace_id,
        production_id: args.production_id,
        production_item_id: args.production_item_id,
        doc_date,
        author: str('author'),
        addressee: str('to'),
        cc: str('cc'),
        subject_matter: str('subject'),
      },
      { onConflict: 'production_item_id', ignoreDuplicates: true },
    );
  if (error) throw new Error(`draft privilege log entry: ${error.message}`);
}

export async function updatePrivilegeLogEntry(
  id: string,
  patch: Partial<Pick<PrivilegeLogEntry,
    'doc_date' | 'author' | 'addressee' | 'cc' | 'subject_matter' | 'basis' | 'basis_custom' | 'description'>>,
): Promise<PrivilegeLogEntry> {
  const { data, error } = await supabase
    .from('privilege_log_entries')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`update privilege log entry: ${error.message}`);
  return data as PrivilegeLogEntry;
}

// ─────────────────────────────────────────────────────────────────────────────
// The matter's privilege log (migration 116, spec R3): one entry per document,
// drafted when it is tagged Privileged on the Review tab. Outgoing productions
// copy it; the copy follows it until the production is stamped.
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentPrivilegeEntry {
  id: string;
  matterspace_id: string;
  document_id: string;
  doc_date: string | null;
  author: string | null;
  addressee: string | null;
  cc: string | null;
  subject_matter: string | null;
  basis: PrivilegeBasis;
  basis_custom: string | null;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type DocumentPrivilegePatch = Partial<Pick<DocumentPrivilegeEntry,
  'doc_date' | 'author' | 'addressee' | 'cc' | 'subject_matter' | 'basis' | 'basis_custom' | 'description'>>;

/** True when 116 has not been pasted yet (PostgREST cannot find the table). */
export function isPrivilegeEntriesMissing(message: string): boolean {
  return /document_privilege_entries/.test(message) && /schema cache|does not exist|not find/i.test(message);
}

export async function listDocumentPrivilegeEntries(matterspaceId: string): Promise<DocumentPrivilegeEntry[]> {
  const { rows } = await fetchPaged<DocumentPrivilegeEntry>(
    (from, to) => supabase
      .from('document_privilege_entries')
      .select('*', { count: 'exact' })
      .eq('matterspace_id', matterspaceId)
      .order('id')
      .range(from, to),
    { label: 'privilege log', ceiling: 50_000 },
  );
  return rows;
}

export async function updateDocumentPrivilegeEntry(id: string, patch: DocumentPrivilegePatch): Promise<void> {
  const { error } = await supabase
    .from('document_privilege_entries')
    .update(patch)
    .eq('id', id);
  if (error) throw new Error(`update privilege log entry: ${error.message}`);
}

/** Titles of the listed documents (the log names each document). */
export async function documentTitles(documentIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const chunks: string[][] = [];
  for (let i = 0; i < documentIds.length; i += REVIEW_TAG_CHUNK) chunks.push(documentIds.slice(i, i + REVIEW_TAG_CHUNK));
  const results = await Promise.all(chunks.map((ids) => supabase
    .from('documents').select('id, title, source_filename').in('id', ids)));
  for (const { data, error } of results) {
    if (error) throw new Error(`document names: ${error.message}`);
    for (const d of (data ?? []) as { id: string; title: string | null; source_filename: string | null }[]) {
      out.set(d.id, d.title || d.source_filename || 'Untitled');
    }
  }
  return out;
}

/** The matter's privilege log as CSV (Excel opens it). */
export function privilegeLogCsv(rows: { document: string; entry: DocumentPrivilegeEntry }[]): string {
  const cell = (v: string | null | undefined) => {
    const t = v ?? '';
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const basisOf = (e: DocumentPrivilegeEntry) =>
    e.basis === 'custom' ? (e.basis_custom ?? '') : PRIVILEGE_BASIS_LABELS[e.basis];
  const head = ['No.', 'Document', 'Date', 'Author', 'Recipients', 'Cc', 'Subject matter', 'Basis', 'Description'];
  const lines = rows.map(({ document, entry: e }, i) => [
    String(i + 1), document, e.doc_date ?? '', e.author ?? '', e.addressee ?? '', e.cc ?? '',
    e.subject_matter ?? '', basisOf(e), e.description ?? '',
  ].map(cell).join(','));
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}

/** Read-only review-tag chips for documents listed in the Vault (spec Q1:
 *  tagging stays in Discovery). One query per chunk of the listed documents;
 *  an empty map when 113 is not in yet, so the Vault never fails over it. */
export async function listVaultReviewChips(documentIds: string[]): Promise<Map<string, Pick<DocumentTagDef, 'name' | 'color'>[]>> {
  const out = new Map<string, Pick<DocumentTagDef, 'name' | 'color'>[]>();
  const chunks: string[][] = [];
  for (let i = 0; i < documentIds.length; i += REVIEW_TAG_CHUNK) chunks.push(documentIds.slice(i, i + REVIEW_TAG_CHUNK));
  // Six at a time: a 20,000-document matter must not open 100 requests at once.
  const results: { data: unknown[] | null; error: unknown }[] = [];
  for (let i = 0; i < chunks.length; i += 6) {
    results.push(...await Promise.all(chunks.slice(i, i + 6).map((ids) => supabase
      .from('document_review_tags')
      .select('document_id, def:document_tag_defs(name, color)')
      .in('document_id', ids))));
  }
  for (const { data, error } of results) {
    if (error) return new Map();
    for (const r of (data ?? []) as unknown as { document_id: string; def: { name: string; color: string } | null }[]) {
      if (!r.def) continue;
      const list = out.get(r.document_id) ?? [];
      // A document tagged in its matter's list and in a folder's: one chip a name.
      if (!list.some((c) => c.name === r.def!.name)) list.push(r.def);
      out.set(r.document_id, list);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Processing jobs — enqueue + poll
// ─────────────────────────────────────────────────────────────────────────────

export async function enqueueJob(args: {
  matterspace_id: string;
  production_id?: string | null;
  job_type: DiscoveryJobType;
  payload?: Record<string, unknown>;
}): Promise<ProcessingJob> {
  const { data, error } = await supabase
    .from('processing_jobs')
    .insert({
      matterspace_id: args.matterspace_id,
      production_id: args.production_id ?? null,
      job_type: args.job_type,
      payload: args.payload ?? {},
      created_by: await currentUserId(),
    })
    .select('*')
    .single();
  if (error) throw new Error(`enqueue job: ${error.message}`);
  return data as ProcessingJob;
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents already in the matter — produced without a download/re-upload
// (intake_documents, migration 110). The worker reads each file server-side.
// ─────────────────────────────────────────────────────────────────────────────

/** The same limit the worker holds (MAX_VAULT_PICK_BYTES). */
export const MAX_MATTER_PICK_BYTES = 500 * 1024 * 1024;
/** The same limit 110 and lib/job-scope.mjs hold. */
export const MAX_MATTER_PICK_COUNT = 5000;

/** Documents may be added only before stamping (030's lock refuses after),
 *  and not while another intake is still running. */
export function canAddDocuments(status: ProductionStatus): boolean {
  return status === 'intake' || status === 'review' || status === 'error';
}

/** A production may be deleted only before any Bates number is assigned
 *  (stamping writes bates_registry, which refuses the delete anyway) and
 *  never while the worker is still busy with it. */
export function canDeleteProduction(status: ProductionStatus, jobRunning: boolean): boolean {
  if (jobRunning) return false;
  return status === 'intake' || status === 'review' || status === 'error' || status === 'held';
}

/** Delete a production and, by cascade, its items, tags, privilege-log
 *  drafts and jobs. Copies it already filed in the Vault stay there. */
export async function deleteProduction(id: string): Promise<void> {
  const { data, error } = await supabase
    .from('productions')
    .delete()
    .eq('id', id)
    .select('id');
  if (error) {
    if (/bates_registry|foreign key/i.test(error.message)) {
      throw new Error('This production already has Bates numbers, so it cannot be deleted.');
    }
    if (/locked/i.test(error.message)) {
      throw new Error('This production is stamped and locked, so it cannot be deleted.');
    }
    throw new Error(`delete production: ${error.message}`);
  }
  if (!data || data.length === 0) throw new Error('Not deleted: you may not have access to this matter.');
}

export interface MatterDocumentChoice {
  id: string;
  title: string;
  source_filename: string | null;
  file_size_bytes: number | null;
  matterspace_id: string;
  /** The folder or sub-matter it is filed in, when not the matter itself. */
  folder: string | null;
  /** Why it cannot be added, or null when it can. */
  blocked: string | null;
}

interface MatterDocumentRow {
  id: string;
  title: string | null;
  source_filename: string | null;
  file_size_bytes: number | null;
  matterspace_id: string;
  storage_path: string | null;
  production_item_id: string | null;
}

/**
 * Every document filed in this matter and its folders/sub-matters, for the
 * "From this matter" picker. Copies a production made of its own documents
 * (metadata.production_item_id) are left out: they are the production, not
 * the client's documents. Every other document is listed, with the reason
 * when it cannot be chosen, so nothing seems to be missing.
 */
export async function listMatterDocumentsForProduction(matterId: string): Promise<{
  docs: MatterDocumentChoice[]; truncated: boolean;
}> {
  const { data: tree } = await supabase.rpc('matterspace_descendants', { p_root: matterId });
  const ids = ((tree ?? []) as { id: string }[]).map((r) => r.id);
  if (!ids.includes(matterId)) ids.push(matterId);
  const { data: names } = await supabase.from('matterspaces').select('id, name').in('id', ids);
  const nameOf = new Map(((names ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]));

  const { rows, truncated } = await fetchPaged<MatterDocumentRow>(
    (from, to) => supabase
      .from('documents')
      .select('id, title, source_filename, file_size_bytes, matterspace_id, storage_path, production_item_id:metadata->>production_item_id')
      .in('matterspace_id', ids)
      .order('title')
      .range(from, to),
    { label: 'matter documents', ceiling: 20_000 },
  );

  const docs = rows
    .filter((d) => !d.production_item_id)
    .map((d): MatterDocumentChoice => ({
      id: d.id,
      title: d.title || d.source_filename || 'Untitled',
      source_filename: d.source_filename,
      file_size_bytes: d.file_size_bytes,
      matterspace_id: d.matterspace_id,
      folder: d.matterspace_id === matterId ? null : (nameOf.get(d.matterspace_id) ?? 'Sub-matter'),
      // storage_path is set only once the bytes have landed, so a document
      // still uploading has none. Indexing need not be finished: the worker
      // reads the stored file, not the index.
      blocked: !d.storage_path ? 'Still uploading, or no stored file'
        : (d.file_size_bytes ?? 0) > MAX_MATTER_PICK_BYTES ? `Over ${MAX_MATTER_PICK_BYTES / 1048576} MB`
          : null,
    }));
  return { docs, truncated };
}

export async function listJobsForMatter(matterspaceId: string): Promise<ProcessingJob[]> {
  const { data, error } = await supabase
    .from('processing_jobs')
    .select('*')
    .eq('matterspace_id', matterspaceId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`list jobs: ${error.message}`);
  return (data ?? []) as ProcessingJob[];
}

export async function getLatestFailedJob(productionId: string): Promise<ProcessingJob | null> {
  const { data, error } = await supabase
    .from('processing_jobs')
    .select('*')
    .eq('production_id', productionId)
    .eq('status', 'error')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`load failed job: ${error.message}`);
  return data as ProcessingJob | null;
}

export async function listJobsForProduction(productionId: string): Promise<ProcessingJob[]> {
  const { data, error } = await supabase
    .from('processing_jobs')
    .select('*')
    .eq('production_id', productionId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`list jobs: ${error.message}`);
  return (data ?? []) as ProcessingJob[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Bates registry
// ─────────────────────────────────────────────────────────────────────────────

// Matter-wide high-water mark. Supplemental productions continue from
// max + 1; 0 means no Bates number has ever been assigned in the matter.
export async function maxBatesSeq(matterspaceId: string): Promise<number> {
  const { data, error } = await supabase
    .from('bates_registry')
    .select('bates_seq')
    .eq('matterspace_id', matterspaceId)
    .order('bates_seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`bates high-water mark: ${error.message}`);
  return (data as Pick<BatesRegistryRow, 'bates_seq'> | null)?.bates_seq ?? 0;
}

/**
 * The next free Bates number in a series — this prefix, in this matter
 * (migration 108: a new prefix starts at 1, a repeated one continues).
 * Until 108 is applied the RPC does not exist and the server still numbers
 * matter-wide, so the suggestion falls back to the matter's high-water mark
 * and says so (`perPrefix: false`) rather than suggesting a number the
 * server would refuse.
 */
export async function nextBatesSeq(
  matterspaceId: string,
  prefix: string,
): Promise<{ next: number; perPrefix: boolean }> {
  const { data, error } = await supabase.rpc('bates_next_seq', {
    p_matter: matterspaceId,
    p_prefix: prefix.trim(),
  });
  if (!error && data != null) return { next: Number(data), perPrefix: true };
  const notDeployed = !!error && (error.code === 'PGRST202' || error.code === '42883'
    || /bates_next_seq/.test(error.message ?? ''));
  if (error && !notDeployed) throw new Error(`next Bates number: ${error.message}`);
  return { next: (await maxBatesSeq(matterspaceId)) + 1, perPrefix: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deliveries
// ─────────────────────────────────────────────────────────────────────────────

export async function listDeliveries(productionId: string): Promise<Delivery[]> {
  const { data, error } = await supabase
    .from('deliveries')
    .select('*')
    .eq('production_id', productionId)
    .order('sent_at', { ascending: false });
  if (error) throw new Error(`list deliveries: ${error.message}`);
  return (data ?? []) as Delivery[];
}

export async function createDelivery(args: {
  matterspace_id: string;
  production_id: string;
  recipient_name: string;
  recipient_email?: string | null;
  method: 'download' | 'email_link';
  package_storage_path?: string | null;
  package_sha256?: string | null;
  bates_range?: string | null;
}): Promise<Delivery> {
  const { data, error } = await supabase
    .from('deliveries')
    .insert({ ...args, created_by: await currentUserId() })
    .select('*')
    .single();
  if (error) throw new Error(`record delivery: ${error.message}`);
  return data as Delivery;
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage — discovery-files bucket
// ─────────────────────────────────────────────────────────────────────────────

const DISCOVERY_BUCKET = 'discovery-files' as const;

// On a SEALED matter (migration 096) the bucket refuses the browser, and the
// URL comes from /api/document-url, which records `file.opened` — and, for
// `purpose: 'download'` (a native, a package), `file.exported` — in the
// matter's Record and lasts 900 s. Unsealed matters sign here, as before.
// A step-up refusal is thrown as StepUpRequired (vault-object.ts).
/** One volume of a production packaged in volumes (worker lib/discovery/volumes.mjs). */
export interface PackageVolume {
  name: string;
  storage_path: string;
  sha256: string;
  bytes: number;
  docs: number;
  pages: number;
  bates_first: string;
  bates_last: string;
}

/** A split production's package is its volume list, package/volumes.json. */
export function isVolumeList(packagePath: string | null | undefined): boolean {
  return !!packagePath && packagePath.endsWith('/package/volumes.json');
}

/**
 * The volumes of a production packaged in more than one, or null for a
 * production packaged as one ZIP. `autoSplit`: split for size, not asked.
 */
export async function getPackageVolumes(
  production: Pick<Production, 'package_storage_path'>,
): Promise<{ volumes: PackageVolume[]; autoSplit: boolean } | null> {
  if (!isVolumeList(production.package_storage_path)) return null;
  const url = await getDiscoverySignedUrl(production.package_storage_path as string, 120, 'read');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`volume list: HTTP ${res.status}`);
  const m = await res.json() as { volumes?: PackageVolume[]; auto_split?: boolean };
  return { volumes: m.volumes ?? [], autoSplit: !!m.auto_split };
}

export async function getDiscoverySignedUrl(
  storagePath: string,
  expiresInSeconds = 3600,
  purpose: ObjectPurpose = 'read',
): Promise<string> {
  try {
    const { url } = await storageObjectUrl(storagePath, {
      bucket: DISCOVERY_BUCKET, ttlSeconds: expiresInSeconds, purpose,
    });
    return url;
  } catch (e) {
    if (isStepUpRequired(e)) throw e;
    throw new Error(`signed url: ${e instanceof Error ? e.message : 'no url returned'}`);
  }
}

export function sanitizeDiscoveryFilename(name: string): string {
  return name
    .replace(/[\[\]{}]/g, '')
    .replace(/[^\w/!\-.*'() ]/g, '_')
    .replace(/_+/g, '_');
}

// Upload one intake file to {matterspace_id}/{production_id}/intake/{filename}.
// Returns the storage path for the processing_jobs payload.
export async function uploadIntakeFile(
  matterspaceId: string,
  productionId: string,
  file: File,
  onProgress?: (p: UploadProgress) => void,
): Promise<string> {
  const path = `${matterspaceId}/${productionId}/intake/${sanitizeDiscoveryFilename(file.name)}`;
  const contentType = file.type || 'application/octet-stream';
  if (shouldUploadResumable(file.size)) {
    // Resumable chunks (Phase 4): a dropped connection continues from the
    // last byte the server has instead of starting the production over.
    const session = (await supabase.auth.getSession()).data.session;
    if (!session?.access_token) throw new Error(`upload ${file.name}: not authenticated`);
    try {
      await uploadResumable({
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? '',
        token: session.access_token,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? null,
        bucket: DISCOVERY_BUCKET,
        objectName: path,
        blob: file,
        contentType,
        lastModified: file.lastModified,
        resumeStore: storageResumeStore(typeof localStorage !== 'undefined' ? localStorage : null),
        onProgress,
      });
    } catch (err) {
      throw new Error(`upload ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return path;
  }
  const { error } = await supabase.storage
    .from(DISCOVERY_BUCKET)
    .upload(path, file, { contentType, upsert: true });
  if (error) throw new Error(`upload ${file.name}: ${error.message}`);
  return path;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-matter views — for the standalone Discovery app (/discovery), which
// presents Discovery as its own product rather than a per-matter tab. RLS still
// scopes every row to what the signed-in user may access, so "all" means "all
// the productions/cases this user can see," nothing more.
// ─────────────────────────────────────────────────────────────────────────────

export interface AllProductionsEntry extends ProductionListEntry {
  matter_name: string;        // the "case" the production belongs to
  serverspace_name: string | null;
}

// Every production across all of the user's matters, newest first — the
// standalone dashboard's ledger. The per-matter listProductions() stays the
// source for the in-matter feature; this is the product-level overview.
export async function listAllProductions(): Promise<AllProductionsEntry[]> {
  const { data, error } = await supabase
    .from('productions')
    .select('*, production_items(count), matterspaces(name, serverspaces(name))')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`list all productions: ${error.message}`);
  return (data ?? []).map((row: Record<string, unknown>) => {
    const counts = row.production_items as { count: number }[] | null;
    const matter = row.matterspaces as { name?: string; serverspaces?: { name?: string } | null } | null;
    const entry = { ...row } as unknown as AllProductionsEntry;
    entry.item_count = counts?.[0]?.count ?? 0;
    entry.matter_name = matter?.name ?? 'Unknown case';
    entry.serverspace_name = matter?.serverspaces?.name ?? null;
    delete (entry as unknown as Record<string, unknown>).production_items;
    delete (entry as unknown as Record<string, unknown>).matterspaces;
    return entry;
  });
}

export interface MatterOption {
  id: string;
  name: string;
  serverspace_name: string | null;
}

// The user's matters ("cases"), for the standalone "start discovery in a case"
// picker. RLS scopes to matters the user can access.
export async function listMyMatters(): Promise<MatterOption[]> {
  const { data, error } = await supabase
    .from('matterspaces')
    .select('id, name, serverspaces(name)')
    .order('name', { ascending: true });
  if (error) throw new Error(`list matters: ${error.message}`);
  return (data ?? []).map((m: Record<string, unknown>) => ({
    id: m.id as string,
    name: m.name as string,
    serverspace_name: (m.serverspaces as { name?: string } | null)?.name ?? null,
  }));
}

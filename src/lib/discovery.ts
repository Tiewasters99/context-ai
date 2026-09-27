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
  source_metadata: Record<string, unknown>;
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

// The four preset tags every matter starts with. Seeded app-side on first
// open of Discovery for a matter (the migration leaves seeding to us).
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
];

// Idempotent: inserts whichever of the four presets the matter is missing
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

export async function listJobsForMatter(matterspaceId: string): Promise<ProcessingJob[]> {
  const { data, error } = await supabase
    .from('processing_jobs')
    .select('*')
    .eq('matterspace_id', matterspaceId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`list jobs: ${error.message}`);
  return (data ?? []) as ProcessingJob[];
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

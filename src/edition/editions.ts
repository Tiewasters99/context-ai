import { supabase } from '@/lib/supabase';
import { openStoredPdf } from '@/lib/pdf-source';
import type { MintedUrl } from '@/lib/vault-object';
import type { PdfSource, MarksStore, BenchStore } from '@/components/reader/PdfBook';
import type { Annotation, AnnotationColor, FractionalRect } from '@/lib/document-annotations';
import type { DocumentAnimation, Turn } from '@/lib/document-animations';
import type { WorkshopItem } from '@/lib/document-workshop';
import { uploadResumable, shouldUploadResumable, storageResumeStore } from '../../lib/tus-upload.mjs';

// The Grapheon Reader's data: editions (migration 112) spoken to in the
// shapes PdfBook already understands. The page and the bench were written
// against Contextspaces' tables (020 marks, 062 illustrations, 106 bench)
// and take their data through three interfaces — a source, a marks store, a
// bench store (docs/specs/GRAPHEON-READER-2026-10-10.md, "The reader app").
// This file is those interfaces given an edition. Nothing here knows a
// matter, a serverspace or the Vault.
//
// Two doors. The publisher reads and writes their own rows and files
// directly (112's policies: the bench, the draft's illustrations, the
// `editions` bucket under <edition_id>/). Everything a READER needs that
// the policies hide — the book's path, the clips' paths, a signed URL for
// either — goes through POST /api/editions, which asks 112's own
// `_edition_can_read` as the user before it signs anything. The publisher
// uses the same door for files, so one code path serves both.

export type EditionStatus = 'draft' | 'review' | 'published' | 'withdrawn';
export type EditionRights = 'public_domain' | 'own' | 'licensed';

export type Edition = {
  id: string;
  slug: string;
  title: string;
  author: string | null;
  description: string | null;
  cover_path: string | null;
  publisher_user_id: string;
  price_cents: number;
  currency: string;
  status: EditionStatus;
  rights: EditionRights | null;
  rights_note: string | null;
  version: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EditionAsset = {
  id: string;
  edition_id: string;
  kind: 'book' | 'media' | 'cover';
  storage_path: string;
  bytes: number | null;
  sha256: string | null;
  mime: string | null;
  version_from: number | null;
  created_at: string;
};

const EDITION_SELECT =
  'id, slug, title, author, description, cover_path, publisher_user_id, price_cents, currency, status, rights, rights_note, version, published_at, created_at, updated_at';

export const BUCKET = 'editions';

// ---------------------------------------------------------------------------
// The API door
// ---------------------------------------------------------------------------

async function bearer(): Promise<string> {
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  if (!token) throw new Error('Sign in to open this edition.');
  return token;
}

async function door<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/editions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await bearer()}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string; detail?: string }) | null;
  if (!res.ok || !data || data.error) {
    const why = data?.error ?? `http_${res.status}`;
    throw new Error(
      why === 'not_readable' ? 'This edition is not yours to read.'
        : why === 'not_found' ? 'That file is not in the edition.'
          : why === 'missing_bearer' || why === 'invalid_session' ? 'Sign in to open this edition.'
            : `The edition could not be opened (${why}).`,
    );
  }
  return data;
}

/** A signed URL for the edition's book, in the shape the PDF opener renews. */
async function mintBook(editionId: string): Promise<MintedUrl> {
  const r = await door<{ url: string; expires_in: number }>({ edition_id: editionId, action: 'book' });
  return { url: r.url, expiresAt: Date.now() + r.expires_in * 1000, sealed: false, filename: null };
}

// A signed URL per clip, kept while it is good, asked again when it lapses —
// clipUrl's shape (document-animations.ts), through the edition's door.
const urlCache = new Map<string, Promise<{ url: string; expiresAt: number } | null>>();

function mediaUrlIn(editionId: string) {
  return function mediaUrl(storagePath: string): Promise<string | null> {
    const key = `${editionId}:${storagePath}`;
    let p = urlCache.get(key);
    if (!p) {
      p = door<{ url: string; expires_in: number }>({ edition_id: editionId, action: 'sign', path: storagePath })
        .then((r) => ({ url: r.url, expiresAt: Date.now() + r.expires_in * 1000 }))
        .catch((e: unknown) => {
          console.warn('[edition media url] failed:', e instanceof Error ? e.message : e);
          urlCache.delete(key);
          return null;
        });
      urlCache.set(key, p);
    }
    return p.then((m) => {
      if (m && Date.now() > m.expiresAt - 30_000) {
        urlCache.delete(key);
        return mediaUrl(storagePath);
      }
      return m?.url ?? null;
    });
  };
}

// ---------------------------------------------------------------------------
// Editions: mine, one, new
// ---------------------------------------------------------------------------

export async function listMyEditions(): Promise<Edition[]> {
  const uid = (await supabase.auth.getUser()).data.user?.id;
  if (!uid) return [];
  const { data, error } = await supabase
    .from('editions')
    .select(EDITION_SELECT)
    .eq('publisher_user_id', uid)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Edition[];
}

/** Editions bought (Phase 2 writes the rows); until then, none. */
export async function listOwnedEditions(): Promise<Edition[]> {
  const uid = (await supabase.auth.getUser()).data.user?.id;
  if (!uid) return [];
  const { data, error } = await supabase
    .from('edition_purchases')
    .select(`edition:editions(${EDITION_SELECT})`)
    .eq('user_id', uid)
    .is('refunded_at', null);
  if (error) return [];
  type Row = { edition: Edition | null };
  return ((data ?? []) as unknown as Row[]).map((r) => r.edition).filter((e): e is Edition => !!e);
}

export async function getEdition(id: string): Promise<Edition | null> {
  const { data, error } = await supabase.from('editions').select(EDITION_SELECT).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Edition | null) ?? null;
}

/** The store address, from the title: lower-case words joined by hyphens,
 *  plus four letters so two "Innocents Abroad" drafts never collide. The
 *  maker can rename it until the first publish (Phase 2). */
export function slugFor(title: string): string {
  const words = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const tail = Math.random().toString(36).slice(2, 6).padEnd(4, 'x');
  const head = words.length >= 3 ? words : `edition-${words}`.replace(/-+$/g, '');
  return `${head}-${tail}`;
}

export async function createEdition(args: { title: string; author: string | null }): Promise<Edition> {
  const uid = (await supabase.auth.getUser()).data.user?.id;
  if (!uid) throw new Error('Sign in to make an edition.');
  const title = args.title.trim();
  if (!title) throw new Error('The edition needs a title.');
  const { data, error } = await supabase
    .from('editions')
    .insert({ title, author: args.author?.trim() || null, slug: slugFor(title), publisher_user_id: uid })
    .select(EDITION_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message ?? 'The edition could not be made.');
  return data as Edition;
}

export async function updateEdition(id: string, patch: Partial<Pick<Edition, 'title' | 'author' | 'description' | 'rights' | 'rights_note' | 'price_cents' | 'cover_path'>>): Promise<Edition> {
  const { data, error } = await supabase.from('editions').update(patch).eq('id', id).select(EDITION_SELECT).single();
  if (error || !data) throw new Error(error?.message ?? 'The edition was not changed.');
  return data as Edition;
}

export async function deleteEdition(id: string): Promise<void> {
  // The rows cascade; the files are the publisher's to remove (112's bucket
  // policy), so take them first, while the edition still says they are ours.
  const { data: files } = await supabase.storage.from(BUCKET).list(id, { limit: 1000 });
  const names = (files ?? []).map((f) => `${id}/${f.name}`);
  for (const folder of ['book', 'media']) {
    const { data: inner } = await supabase.storage.from(BUCKET).list(`${id}/${folder}`, { limit: 1000 });
    for (const f of inner ?? []) names.push(`${id}/${folder}/${f.name}`);
  }
  if (names.length) await supabase.storage.from(BUCKET).remove(names);
  const { error } = await supabase.from('editions').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Files: into the bucket, under the edition
// ---------------------------------------------------------------------------

function safeName(name: string): string {
  const printable = Array.from(name).filter((c) => c.charCodeAt(0) >= 32).join('');
  const cleaned = printable.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(-120) || 'file';
}

function mimeFor(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return ({
    pdf: 'application/pdf', mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

/** Put a file in the edition's folder and record it as an asset. A large
 *  file (50 MB and up — a facsimile scan) goes up in resumable chunks, as
 *  the Vault's do. On a failed upload no asset row is written. */
export async function uploadAsset(
  edition: Edition,
  kind: EditionAsset['kind'],
  file: File | Blob,
  opts: { name?: string; onProgress?: (p: { loaded: number; total: number }) => void } = {},
): Promise<EditionAsset> {
  const name = safeName(opts.name ?? (file instanceof File ? file.name : `${kind}.bin`));
  const folder = kind === 'cover' ? '' : `${kind}/`;
  const stamp = kind === 'cover' ? '' : `${Date.now().toString(36)}-`;
  const storagePath = `${edition.id}/${folder}${stamp}${name}`;
  const contentType = file instanceof File ? mimeFor(file) : (file.type || 'application/octet-stream');

  if (shouldUploadResumable(file.size)) {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session?.access_token) throw new Error('Sign in to upload.');
    await uploadResumable({
      supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? '',
      token: session.access_token,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? null,
      bucket: BUCKET,
      objectName: storagePath,
      blob: file,
      contentType,
      lastModified: file instanceof File ? file.lastModified : 0,
      resumeStore: storageResumeStore(typeof localStorage !== 'undefined' ? localStorage : null),
      onProgress: opts.onProgress ? (p) => opts.onProgress?.({ loaded: p.sent, total: p.total }) : undefined,
    });
  } else {
    const { error } = await supabase.storage.from(BUCKET).upload(storagePath, file, { contentType, upsert: kind === 'cover' });
    if (error) throw new Error(`upload: ${error.message}`);
  }

  const { data, error } = await supabase
    .from('edition_assets')
    .upsert({ edition_id: edition.id, kind, storage_path: storagePath, bytes: file.size, mime: contentType }, { onConflict: 'storage_path' })
    .select('id, edition_id, kind, storage_path, bytes, sha256, mime, version_from, created_at')
    .single();
  if (error || !data) {
    await supabase.storage.from(BUCKET).remove([storagePath]);
    throw new Error(error?.message ?? 'The file was not recorded.');
  }
  return data as EditionAsset;
}

/** The publisher's view of the edition's files (readers go through the door). */
export async function listAssets(editionId: string): Promise<EditionAsset[]> {
  const { data, error } = await supabase
    .from('edition_assets')
    .select('id, edition_id, kind, storage_path, bytes, sha256, mime, version_from, created_at')
    .eq('edition_id', editionId)
    .order('created_at', { ascending: true });
  if (error) return [];
  return (data ?? []) as EditionAsset[];
}

/** The jacket, for My Library: the publisher's own cover file, signed. */
export async function coverUrl(edition: Edition): Promise<string | null> {
  if (!edition.cover_path) return null;
  return mediaUrlIn(edition.id)(edition.cover_path);
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/** Freeze a version: 112's publish_edition(). The guard needs an active
 *  publisher account, a rights attestation and a book file; its sentence is
 *  shown as it is. */
export async function publishEdition(editionId: string): Promise<number> {
  const { data, error } = await supabase.rpc('publish_edition', { p_edition: editionId });
  if (error) throw new Error(error.message);
  return Number(data);
}

// ---------------------------------------------------------------------------
// The three interfaces PdfBook reads through
// ---------------------------------------------------------------------------

type MediaShape = { id: string; title: string; storage_path: string | null; source_filename: string | null };

function mediaOfAsset(a: { id: string; storage_path: string | null } | null): MediaShape | null {
  if (!a) return null;
  const name = (a.storage_path ?? '').split('/').pop() || null;
  return { id: a.id, title: name ?? a.id, storage_path: a.storage_path, source_filename: name };
}

/** The file, and what is laid on its pages. `reloadKey` reopens the book.
 *  Taking a clip off the page is offered only to the edition's maker
 *  (112's delete policy is the publisher's; a reader is not offered what
 *  would silently do nothing). */
export function editionSource(edition: Edition, reloadKey = 0, opts: { canEdit?: boolean } = {}): PdfSource {
  const editionId = edition.id;
  const source: PdfSource = {
    key: `${editionId}:${reloadKey}`,
    openPdf: (onProgress) => openStoredPdf(`${editionId}/book`, { onProgress, mint: () => mintBook(editionId) }),
    listIllustrations: async () => {
      const r = await door<{ illustrations: DocumentAnimation[] }>({ edition_id: editionId, action: 'illustrations' });
      return r.illustrations;
    },
    mediaUrl: mediaUrlIn(editionId),
  };
  if (opts.canEdit) {
    source.removeIllustration = async (id) => {
      const { error } = await supabase.from('edition_illustrations').delete().eq('id', id);
      if (error) throw new Error(error.message);
    };
  }
  return source;
}

type MarkRow = {
  id: string; user_id: string; edition_id: string; page: number; rects: FractionalRect[];
  color: AnnotationColor; anchor_text: string | null; note: string | null; created_at: string; updated_at: string;
};

function annotationOf(r: MarkRow): Annotation {
  return {
    id: r.id, document_id: r.edition_id, user_id: r.user_id, page: r.page, color: r.color, note: r.note,
    anchor_text: r.anchor_text, rects: r.rects, visibility: 'private', line_start: null, line_end: null,
    text_anchor: null, created_at: r.created_at, updated_at: r.updated_at, author: null, links: [],
  };
}

const MARK_SELECT = 'id, user_id, edition_id, page, rects, color, anchor_text, note, created_at, updated_at';

/** The reader's own highlights: edition_marks, theirs alone. */
export function editionMarks(edition: Edition): MarksStore {
  const editionId = edition.id;
  return {
    list: async () => {
      const { data, error } = await supabase
        .from('edition_marks').select(MARK_SELECT).eq('edition_id', editionId)
        .order('page', { ascending: true }).order('created_at', { ascending: true });
      if (error) { console.warn('[edition marks] list failed:', error.message); return []; }
      return ((data ?? []) as MarkRow[]).map(annotationOf);
    },
    create: async ({ page, color, rects, anchorText }) => {
      const uid = (await supabase.auth.getUser()).data.user?.id;
      if (!uid) return null;
      const { data, error } = await supabase
        .from('edition_marks')
        .insert({ user_id: uid, edition_id: editionId, page, color, rects, anchor_text: anchorText || null })
        .select(MARK_SELECT).single();
      if (error || !data) { console.warn('[edition marks] create failed:', error?.message); return null; }
      return annotationOf(data as MarkRow);
    },
    update: async (id, patch) => {
      const { error } = await supabase.from('edition_marks').update({ color: patch.color }).eq('id', id);
      return !error;
    },
    remove: async (id) => {
      const { error } = await supabase.from('edition_marks').delete().eq('id', id);
      return !error;
    },
  };
}

type BenchRow = {
  id: string; edition_id: string; user_id: string; page: number; kind: 'snip' | 'snippet' | 'media';
  rect: FractionalRect | null; turn: Turn; text: string | null; asset_id: string | null; parent_id: string | null;
  label: string | null; sort_order: number; created_at: string; updated_at: string;
  asset: { id: string; storage_path: string | null } | null;
};

const BENCH_SELECT =
  'id, edition_id, user_id, page, kind, rect, turn, text, asset_id, parent_id, label, sort_order, created_at, updated_at, ' +
  'asset:edition_assets(id, storage_path)';

function itemOf(r: BenchRow): WorkshopItem {
  return {
    id: r.id, document_id: r.edition_id, user_id: r.user_id, page: r.page, kind: r.kind, rect: r.rect, turn: r.turn,
    text: r.text, media_document_id: r.asset_id, parent_id: r.parent_id, label: r.label, sort_order: r.sort_order,
    created_at: r.created_at, updated_at: r.updated_at, media: mediaOfAsset(r.asset),
  };
}

async function insertBench(row: Record<string, unknown>): Promise<WorkshopItem> {
  const uid = (await supabase.auth.getUser()).data.user?.id;
  if (!uid) throw new Error('Not signed in.');
  const { data, error } = await supabase
    .from('edition_bench_items').insert({ ...row, user_id: uid }).select(BENCH_SELECT).single();
  if (error || !data) throw new Error(error?.message ?? 'The Workshop could not keep that.');
  return itemOf(data as unknown as BenchRow);
}

/** The Workshop bench on a draft: the publisher's alone. */
export function editionBench(edition: Edition, canWrite: boolean): BenchStore {
  const editionId = edition.id;
  return {
    canWrite,
    list: async () => {
      const { data, error } = await supabase
        .from('edition_bench_items').select(BENCH_SELECT).eq('edition_id', editionId)
        .order('page', { ascending: true }).order('sort_order', { ascending: true }).order('created_at', { ascending: true });
      if (error) { console.warn('[edition bench] list failed:', error.message); return []; }
      return ((data ?? []) as unknown as BenchRow[]).map(itemOf);
    },
    createSnip: ({ page, rect }) => insertBench({ edition_id: editionId, page, kind: 'snip', rect, turn: 0 }),
    createSnippet: ({ page, text, rect }) => insertBench({ edition_id: editionId, page, kind: 'snippet', text, rect }),
    update: async (id, patch) => {
      const { data, error } = await supabase
        .from('edition_bench_items').update(patch).eq('id', id).select(BENCH_SELECT).single();
      if (error || !data) throw new Error(error?.message ?? 'The change was not kept.');
      return itemOf(data as unknown as BenchRow);
    },
    remove: async (id) => {
      const { error } = await supabase.from('edition_bench_items').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },
    bringIn: async (parent, file, page) => {
      const asset = await uploadAsset(edition, 'media', file);
      const item = await insertBench({
        edition_id: editionId, page, kind: 'media', asset_id: asset.id, parent_id: parent?.id ?? null,
        label: file.name.replace(/\.[^.]+$/, ''),
      });
      return { item, notice: `"${file.name}" is on the bench and in the edition.` };
    },
    lay: async (media, source) => {
      if (!source.rect || !media.media_document_id) throw new Error('It could not be laid on the page.');
      const uid = (await supabase.auth.getUser()).data.user?.id;
      if (!uid) throw new Error('Not signed in.');
      const { data, error } = await supabase
        .from('edition_illustrations')
        .insert({
          edition_id: editionId, asset_id: media.media_document_id, user_id: uid,
          page: source.page, rect: source.rect, turn: source.turn, loops: true, label: media.label ?? source.label ?? null,
        })
        .select('id, edition_id, asset_id, user_id, page, rect, turn, loops, label, created_at, updated_at, asset:edition_assets(id, storage_path)')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'It could not be laid on the page.');
      type Row = { id: string; edition_id: string; asset_id: string; user_id: string; page: number; rect: FractionalRect; turn: Turn; loops: boolean; label: string | null; created_at: string; updated_at: string; asset: { id: string; storage_path: string | null } | null };
      const r = data as unknown as Row;
      return {
        id: r.id, document_id: r.edition_id, media_document_id: r.asset_id, user_id: r.user_id, page: r.page, rect: r.rect,
        turn: r.turn, loops: r.loops, label: r.label, created_at: r.created_at, updated_at: r.updated_at, media: mediaOfAsset(r.asset),
      };
    },
  };
}

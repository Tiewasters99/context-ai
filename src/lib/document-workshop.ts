import { supabase } from './supabase';
import type { FractionalRect } from './document-annotations';
import type { Turn } from './document-animations';

// The Workshop beside a book (migration 106): what is on the bench.
//
// A snip is a recipe — page, rectangle, quarter turn — re-rendered from the
// PDF whenever it is shown or downloaded, so cropping is a new rectangle and
// rotating is a new turn, and no pixels are stored. A snippet is a passage of
// text. A media item is a file brought back (a document filed in the same
// matter, stored without a transcript) sitting under the snip or snippet it
// was made from. Laying a media item on the page is a document_animations
// row (062), made from the source's page, rect and turn.

export type WorkshopKind = 'snip' | 'snippet' | 'media';

export type WorkshopMedia = {
  id: string;
  title: string;
  storage_path: string | null;
  source_filename: string | null;
};

export type WorkshopItem = {
  id: string;
  document_id: string;
  user_id: string;
  page: number;
  kind: WorkshopKind;
  rect: FractionalRect | null;
  turn: Turn;
  text: string | null;
  media_document_id: string | null;
  parent_id: string | null;
  label: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  media: WorkshopMedia | null;
};

/** A still that can be laid on the page or shown under its source. */
export const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif)$/i;

const ITEM_SELECT =
  'id, document_id, user_id, page, kind, rect, turn, text, media_document_id, parent_id, label, sort_order, created_at, updated_at, ' +
  'media:documents!document_workshop_items_media_document_id_fkey(id, title, storage_path, source_filename)';

/** Everything on the bench for a document, page then bench order. A failure
 *  (the table not applied yet) is an empty bench, so the book always opens. */
export async function listWorkshopItems(documentId: string): Promise<WorkshopItem[]> {
  const { data, error } = await supabase
    .from('document_workshop_items')
    .select(ITEM_SELECT)
    .eq('document_id', documentId)
    .order('page', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    console.warn('[workshop] list failed:', error.message);
    return [];
  }
  return (data ?? []) as unknown as WorkshopItem[];
}

async function insertItem(row: Record<string, unknown>): Promise<WorkshopItem> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Not signed in.');
  const { data, error } = await supabase
    .from('document_workshop_items')
    .insert({ ...row, user_id: userId })
    .select(ITEM_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message ?? 'The Workshop could not keep that.');
  return data as unknown as WorkshopItem;
}

export function createSnip(args: { documentId: string; page: number; rect: FractionalRect; turn?: Turn; label?: string | null }) {
  return insertItem({
    document_id: args.documentId, page: args.page, kind: 'snip',
    rect: args.rect, turn: args.turn ?? 0, label: args.label ?? null,
  });
}

/** A passage. `rect` is where its words sit on the page (the box round the
 *  selection it was taken from), so a clip made from it can be laid there;
 *  a pasted passage has none until one is drawn (updateWorkshopItem). */
export function createSnippet(args: { documentId: string; page: number; text: string; rect?: FractionalRect | null; label?: string | null }) {
  return insertItem({
    document_id: args.documentId, page: args.page, kind: 'snippet',
    text: args.text, rect: args.rect ?? null, label: args.label ?? null,
  });
}

/** The one box round several (the lines of a selection). */
export function unionRect(rects: FractionalRect[]): FractionalRect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

export function addMedia(args: { documentId: string; page: number; parentId: string | null; mediaDocumentId: string; label?: string | null }) {
  return insertItem({
    document_id: args.documentId, page: args.page, kind: 'media',
    parent_id: args.parentId, media_document_id: args.mediaDocumentId, label: args.label ?? null,
  });
}

export async function updateWorkshopItem(
  id: string,
  patch: Partial<Pick<WorkshopItem, 'rect' | 'turn' | 'label' | 'text' | 'page'>>,
): Promise<WorkshopItem> {
  const { data, error } = await supabase
    .from('document_workshop_items')
    .update(patch)
    .eq('id', id)
    .select(ITEM_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message ?? 'The change was not kept.');
  return data as unknown as WorkshopItem;
}

/** Returns an error message, or null. A source takes its media items with it (cascade). */
export async function deleteWorkshopItem(id: string): Promise<string | null> {
  const { error } = await supabase.from('document_workshop_items').delete().eq('id', id);
  return error ? error.message : null;
}

/** The next quarter turn clockwise. */
export function nextTurn(t: Turn): Turn {
  return ((t + 90) % 360) as Turn;
}

export function isImageMedia(m: WorkshopMedia | null): boolean {
  return !!m && IMAGE_FILE_RE.test(m.source_filename || m.storage_path || '');
}

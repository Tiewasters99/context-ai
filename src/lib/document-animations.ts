import { supabase } from './supabase';
import type { FractionalRect } from './document-annotations';

// Living illustrations: a clip that plays on a rectangle of one page, so the
// plate in a scanned book comes alive when it is tapped (migration 062).
//
// The row is a recipe — the clip is an ordinary document filed in the same
// matter, and the rectangle is in fractions of the page box, the same
// convention as a highlight's rects, so it holds at any zoom or page size.
//
// `turn` is the quarter turn that makes the illustration upright. Landscape
// plates are often printed sideways to fit a portrait page; whoever attaches
// the clip records which way is up, once, and the reader just taps.

export type Turn = 0 | 90 | 180 | 270;

export type AnimationMedia = {
  id: string;
  title: string;
  storage_path: string | null;
  source_filename: string | null;
};

export type DocumentAnimation = {
  id: string;
  document_id: string;
  media_document_id: string;
  user_id: string;
  page: number;
  rect: FractionalRect;
  turn: Turn;
  loops: boolean;
  label: string | null;
  created_at: string;
  updated_at: string;
  media: AnimationMedia | null;
};

/** What counts as a clip that can play in the reader. */
export const CLIP_FILE_RE = /\.(mp4|m4v|mov|webm|ogv)$/i;

// documents is referenced twice from document_animations (the book and the
// clip), so the embed must name its FK or PostgREST cannot choose.
const ANIMATION_SELECT =
  'id, document_id, media_document_id, user_id, page, rect, turn, loops, label, created_at, updated_at, ' +
  'media:documents!document_animations_media_document_id_fkey(id, title, storage_path, source_filename)';

/**
 * Every animation on a document, earliest page first. A failure — including
 * the table not existing yet, before migration 062 is applied — is a warning
 * and an empty list: the reader must open regardless.
 */
export async function listAnimations(documentId: string): Promise<DocumentAnimation[]> {
  try {
    const { data, error } = await supabase
      .from('document_animations')
      .select(ANIMATION_SELECT)
      .eq('document_id', documentId)
      .order('page', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as unknown as DocumentAnimation[];
  } catch (err) {
    console.warn('[animations load] failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

export async function createAnimation(args: {
  documentId: string;
  mediaDocumentId: string;
  page: number;
  rect: FractionalRect;
  turn?: Turn;
  loops?: boolean;
  label?: string | null;
}): Promise<{ animation: DocumentAnimation | null; error: string | null }> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return { animation: null, error: 'You are signed out — sign in and try again.' };
  const { data, error } = await supabase
    .from('document_animations')
    .insert({
      document_id: args.documentId,
      media_document_id: args.mediaDocumentId,
      user_id: userId,
      page: args.page,
      rect: args.rect,
      turn: args.turn ?? 0,
      loops: args.loops ?? true,
      label: args.label ?? null,
    })
    .select(ANIMATION_SELECT)
    .single();
  if (error) return { animation: null, error: error.message };
  return { animation: data as unknown as DocumentAnimation, error: null };
}

export async function updateAnimation(
  id: string,
  patch: { turn?: Turn; loops?: boolean; label?: string | null; rect?: FractionalRect },
): Promise<string | null> {
  const { error } = await supabase
    .from('document_animations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  return error ? error.message : null;
}

export async function deleteAnimation(id: string): Promise<string | null> {
  const { error } = await supabase.from('document_animations').delete().eq('id', id);
  return error ? error.message : null;
}

/** The clips filed in a matter, for the picker. */
export async function listMatterClips(matterId: string): Promise<AnimationMedia[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, storage_path, source_filename')
    .eq('matterspace_id', matterId)
    .not('storage_path', 'is', null)
    .order('created_at', { ascending: false });
  if (error) {
    console.warn('[animations clips] failed:', error.message);
    return [];
  }
  return (data ?? []).filter((d) => CLIP_FILE_RE.test(d.source_filename || d.storage_path || ''));
}

// A signed URL per stored clip, kept for the session. The vault bucket is
// private, and these URLs honour HTTP Range, which is what lets <video> seek
// and start before the whole file has arrived (same bucket and TTL as the
// reader's PDF source).
const BUCKET = 'vault-documents';
const URL_TTL_SECONDS = 12 * 60 * 60;
const urlCache = new Map<string, Promise<string | null>>();

export function clipUrl(storagePath: string): Promise<string | null> {
  let p = urlCache.get(storagePath);
  if (!p) {
    p = supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, URL_TTL_SECONDS)
      .then(({ data, error }) => {
        if (error || !data?.signedUrl) {
          console.warn('[animations clip url] failed:', error?.message);
          return null;
        }
        return data.signedUrl;
      });
    urlCache.set(storagePath, p);
    p.catch(() => urlCache.delete(storagePath));
  }
  return p;
}

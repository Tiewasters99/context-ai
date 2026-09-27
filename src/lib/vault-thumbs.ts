// Thumbnails for the Vault's picture grid (step 2 of the image plan,
// 2026-09-26). No server-side thumbnail is stored: Supabase Storage renders a
// resized copy of the original on request (the image-transformation
// endpoint, verified on this project against a 1.5 MB PNG → 181 KB at 320 px),
// so a signed URL with a `transform` is the whole mechanism. Signed, because
// the bucket is private and RLS decides who may see the picture at all; the
// URL lives an hour, comfortably longer than a list stays open.
//
// Browser-drawn formats only. A TIFF has no browser renderer, and Storage will
// not transform it either; its tile shows the label alone.

import { supabase } from '@/lib/supabase';

const BUCKET = 'vault-documents';
const TTL_SECONDS = 3600;
/** The tile is drawn at up to 240 CSS px; 480 covers a 2× display. */
export const THUMB_EDGE = 480;

export const THUMB_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

export function isThumbable(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return THUMB_EXTENSIONS.includes(ext);
}

const cache = new Map<string, { url: string; expires: number }>();

/**
 * A signed, resized URL for one stored image, or null when it cannot be had
 * (no path, the person may not see it, the transform is unavailable). Cached
 * per path until shortly before it expires, so re-renders of a grid of sixty
 * do not sign sixty URLs again.
 */
export async function thumbUrl(storagePath: string | undefined): Promise<string | null> {
  if (!storagePath) return null;
  const hit = cache.get(storagePath);
  if (hit && hit.expires > Date.now()) return hit.url;
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, TTL_SECONDS, {
        transform: { width: THUMB_EDGE, height: THUMB_EDGE, resize: 'contain', quality: 80 },
      });
    if (error || !data?.signedUrl) return null;
    // WebP, asked for on the URL: the render endpoint honours `format=webp`
    // outside the signed transform (measured 2026-09-26 on a 1.5 MB PNG:
    // 471 KB as PNG at 480 px, 57 KB as WebP), and the client's typed
    // transform options do not offer it. Sixty tiles are then ~3.5 MB, not
    // ~29 MB. Every browser this app supports draws WebP.
    const url = `${data.signedUrl}${data.signedUrl.includes('?') ? '&' : '?'}format=webp`;
    cache.set(storagePath, { url, expires: Date.now() + (TTL_SECONDS - 120) * 1000 });
    return url;
  } catch {
    return null;
  }
}

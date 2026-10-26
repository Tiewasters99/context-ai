// A small copy of a cover for a list row: the Library's books in the Vault
// list, the Office picker and the Office shelves show their jacket beside
// the title. A chosen cover is a 1200×1850 PNG of ~2.7 MB (measured on a
// Library book, 2026-10-26); a list of ninety must not fetch ninety of those.
//
// Covers chosen from the account's own uploads live in the PUBLIC
// cover-images bucket, and Supabase Storage renders a resized copy of a
// public object on request (verified on this project: 96×128 → 16 KB).
// Covers from the template library are same-origin files under /templates
// and are served as they are; the browser caches them once.

const PUBLIC_OBJECT = '/storage/v1/object/public/';
const PUBLIC_RENDER = '/storage/v1/render/image/public/';

export interface ThumbSize {
  /** CSS pixels; the URL asks for 2× so a retina screen draws it sharp. */
  width: number;
  height: number;
}

/** The URL to put in an <img> for a small copy of `coverUrl`, or null for none. */
export function coverThumbUrl(coverUrl: string | null | undefined, size: ThumbSize): string | null {
  if (!coverUrl) return null;
  const at = coverUrl.indexOf(PUBLIC_OBJECT);
  if (at < 0) return coverUrl;
  const base = coverUrl.slice(0, at) + PUBLIC_RENDER + coverUrl.slice(at + PUBLIC_OBJECT.length);
  const q = new URLSearchParams({
    width: String(size.width * 2),
    height: String(size.height * 2),
    resize: 'cover',
    quality: '75',
  });
  return `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
}

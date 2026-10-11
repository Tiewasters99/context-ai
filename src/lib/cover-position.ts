// Where a cover image sits inside its banner: horizontal and vertical focus
// (0–100, CSS object-position percentages) and a zoom (1 = fill, up to 4).
//
// Stored in the cover URL's fragment — `…/image.jpg#cs-cover=50,30,1.5` — so
// the position travels with the cover through every existing save path
// (cover_url columns, the default cover, a matter's cover inherited by its
// pages) with no schema change. A fragment is never sent to the server that
// serves the image, so the image itself loads exactly as before.
// Gradients have no position: they are returned untouched.

export interface CoverPosition {
  x: number;
  y: number;
  zoom: number;
}

export const DEFAULT_POSITION: CoverPosition = { x: 50, y: 50, zoom: 1 };
export const MAX_ZOOM = 4;

const KEY = 'cs-cover=';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 10) / 10;

export function normalizePosition(p: Partial<CoverPosition>): CoverPosition {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    x: round(clamp(num(p.x, 50), 0, 100)),
    y: round(clamp(num(p.y, 50), 0, 100)),
    zoom: round(clamp(num(p.zoom, 1), 1, MAX_ZOOM) * 10) / 10,
  };
}

/** The image address without our fragment, and the position it carried. */
export function parseCover(url: string): { src: string; position: CoverPosition } {
  if (!url || url.startsWith('linear-gradient')) return { src: url, position: DEFAULT_POSITION };
  const hash = url.indexOf('#');
  if (hash < 0) return { src: url, position: DEFAULT_POSITION };
  const frag = url.slice(hash + 1);
  if (!frag.startsWith(KEY)) return { src: url, position: DEFAULT_POSITION };
  const [x, y, zoom] = frag.slice(KEY.length).split(',').map((s) => parseFloat(s));
  return { src: url.slice(0, hash), position: normalizePosition({ x, y, zoom }) };
}

/** The cover URL carrying this position (no fragment at the default). */
export function withPosition(url: string, position: Partial<CoverPosition>): string {
  if (!url || url.startsWith('linear-gradient')) return url;
  const { src } = parseCover(url);
  const p = normalizePosition(position);
  if (p.x === 50 && p.y === 50 && p.zoom === 1) return src;
  return `${src}#${KEY}${p.x},${p.y},${p.zoom}`;
}

/** Inline style for an <img> filling its box at this position. */
export function coverImageStyle(p: CoverPosition): { objectPosition: string; transform?: string; transformOrigin?: string } {
  return p.zoom > 1
    ? { objectPosition: `${p.x}% ${p.y}%`, transform: `scale(${p.zoom})`, transformOrigin: `${p.x}% ${p.y}%` }
    : { objectPosition: `${p.x}% ${p.y}%` };
}

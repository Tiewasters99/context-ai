import type { PDFDocumentProxy } from 'pdfjs-dist';

// One renderer for a PDF page as a picture — the page grid's thumbnails, its
// larger view, and every image a page is copied or saved as. Sharing it is
// what keeps a copied page identical to the tile it came from.
//
// Rotation: pdfjs's `getViewport({ rotation })` sets the TOTAL rotation and
// defaults to the page's own /Rotate. A scan filed sideways (/Rotate 90) that
// the user turns another 90° must render at 180, so `rotation` here is the
// user's turn and the page's own is added to it — the same arithmetic the
// server's edit_pdf uses (lib/mcp-core.mjs), so the image and the saved PDF
// agree.

/** Export scale: about 150 dpi for a letter page, sharp enough for an exhibit. */
export const EXPORT_SCALE = 2;
/** Longest edge of an exported image, whatever the page size. */
export const EXPORT_MAX_EDGE = 3000;

export type ImageType = 'image/png' | 'image/jpeg';

export interface RenderOptions {
  /** Pixels per PDF point. Ignored when `width` is given. */
  scale?: number;
  /** Target width in pixels (of the page as it will be shown, after rotation). */
  width?: number;
  /** The user's rotation, clockwise, added to the page's own. */
  rotation?: number;
  /** Cap on the longer edge, in pixels. */
  maxEdge?: number;
}

const norm = (deg: number) => (((Math.round(deg / 90) * 90) % 360) + 360) % 360;

/**
 * Render page `n` (1-based) to a fresh canvas. Uses the print intent, which
 * paces its work with timers rather than animation frames, so it finishes in
 * a background tab too.
 */
export async function renderPageCanvas(
  pdf: PDFDocumentProxy,
  n: number,
  opts: RenderOptions = {},
): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(n);
  const rotation = norm((page.rotate || 0) + (opts.rotation || 0));
  const unit = page.getViewport({ scale: 1, rotation });
  let scale = opts.width ? opts.width / unit.width : (opts.scale ?? 1);
  if (opts.maxEdge) {
    const edge = Math.max(unit.width, unit.height) * scale;
    if (edge > opts.maxEdge) scale *= opts.maxEdge / edge;
  }
  const viewport = page.getViewport({ scale, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not draw the page.');
  await page.render({ canvas, canvasContext: ctx, viewport, intent: 'print' }).promise;
  page.cleanup();
  return canvas;
}

/** A page at export resolution: EXPORT_SCALE, capped at EXPORT_MAX_EDGE. */
export function renderPageForExport(pdf: PDFDocumentProxy, n: number, rotation = 0) {
  return renderPageCanvas(pdf, n, { scale: EXPORT_SCALE, rotation, maxEdge: EXPORT_MAX_EDGE });
}

/**
 * The canvas as a PNG or JPEG blob. JPEG has no transparency, so the canvas
 * is laid on white first — a transparent region would otherwise save black.
 */
export function canvasToBlob(canvas: HTMLCanvasElement, type: ImageType = 'image/png', quality = 0.92): Promise<Blob> {
  let src = canvas;
  if (type === 'image/jpeg') {
    src = document.createElement('canvas');
    src.width = canvas.width;
    src.height = canvas.height;
    const ctx = src.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, src.width, src.height);
      ctx.drawImage(canvas, 0, 0);
    }
  }
  return new Promise((resolve, reject) => {
    src.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The page image could not be made.'))),
      type,
      type === 'image/jpeg' ? quality : undefined,
    );
  });
}

/** A rectangle as fractions (0–1) of the canvas: x, y, width, height. */
export interface FracRect { x: number; y: number; w: number; h: number }

/** A new canvas holding the part of `canvas` inside `rect`. */
export function cropCanvas(canvas: HTMLCanvasElement, rect: FracRect): HTMLCanvasElement {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = Math.round(clamp(rect.x) * canvas.width);
  const y0 = Math.round(clamp(rect.y) * canvas.height);
  const x1 = Math.round(clamp(rect.x + rect.w) * canvas.width);
  const y1 = Math.round(clamp(rect.y + rect.h) * canvas.height);
  const out = document.createElement('canvas');
  out.width = Math.max(1, x1 - x0);
  out.height = Math.max(1, y1 - y0);
  out.getContext('2d')?.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Whether this browser can put an image on the clipboard at all. */
export function canCopyImages(): boolean {
  return typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
}

/**
 * Put a PNG on the clipboard. Call it synchronously inside the click, with
 * the blob still being made: the ClipboardItem takes the promise, so the
 * click's permission is used before the render finishes (Safari refuses a
 * write made after an await). Browsers put only PNG on the clipboard — a
 * JPEG is Save-only. Rejects when the browser refuses; the caller saves the
 * file instead and says so.
 */
export function copyPngToClipboard(png: Promise<Blob>): Promise<void> {
  if (!canCopyImages()) {
    png.catch(() => undefined);
    return Promise.reject(new Error('Copying images is not available in this browser.'));
  }
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

/** Hand the blob to the browser as a download named `filename`. */
export function saveBlobAs(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Save the canvas as a PNG or JPEG file. */
export async function saveCanvasAs(canvas: HTMLCanvasElement, filename: string, type: ImageType = 'image/png') {
  saveBlobAs(await canvasToBlob(canvas, type), filename);
}

/** "Smith Decl.pdf", 12, 'png' → "Smith Decl p.12.png"; a snip adds " (snip)". */
export function pageImageFilename(title: string, page: number, ext: 'png' | 'jpg', opts: { snip?: boolean } = {}) {
  const base = (title || 'document')
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'document';
  return `${base} p.${page}${opts.snip ? ' (snip)' : ''}.${ext}`;
}

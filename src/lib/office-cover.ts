import { supabase } from '@/lib/supabase';
import { PDFJS_DOC_PARAMS } from '@/lib/pdfjs';

// The images a published book shows in the office's Reader.
//
// The office is one-way glass: the public feed serves text, never files.
// Images are what may pass — they are what a bookshop window shows. They
// are captured here, at publish time, from the vault's PDF, and put in the
// public cover-images bucket by convention:
//   <owner uid>/office/<item id>.jpg          the jacket — page one
//   <owner uid>/office/<item id>/0001.jpg …   every page, for a deck
// A deck is a PDF whose pages are wider than they are tall — slides saved
// as PDF; a book keeps its jacket and reads as text. No column records any
// of this: the feed lists the folder. Re-capturing overwrites in place.

const COVER_LONG_EDGE = 1400;
const COVER_QUALITY = 0.86;
const PAGE_LONG_EDGE = 1600;
const PAGE_QUALITY = 0.82;
const VAULT_BUCKET = 'vault-documents';
export const OFFICE_COVER_BUCKET = 'cover-images';

export interface OfficeImages {
  /** Public URL of the jacket, or null when the document is not a PDF. */
  cover: string | null;
  /** How many pages were captured — 0 for a book, the page count for a deck. */
  pages: number;
}

type PdfDoc = Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfjs>>['getDocument']>['promise']>;

async function loadPdfjs() {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  return pdfjsLib;
}

/** One page as a JPEG, its long edge held to `longEdge`. */
async function pageJpeg(pdf: PdfDoc, n: number, longEdge: number, quality: number): Promise<Blob> {
  const page = await pdf.getPage(n);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: longEdge / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    // Annotations stay off the page: a deck exported from PowerPoint carries
    // a comment icon in the corner of every slide, and a jacket is the page,
    // not the notes on it. (pdf.js AnnotationMode.DISABLE is 0 — the enum is
    // not imported so pdf.js itself stays a lazy load.)
    await page.render({ canvas, canvasContext: ctx, viewport, annotationMode: 0 }).promise;
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality);
    });
  } finally {
    page.cleanup();
  }
}

/** Whether a document can give the office a jacket: only a PDF has a page one to show. */
export function canCaptureCover(filename: string | null | undefined): boolean {
  return /\.pdf$/i.test(filename ?? '');
}

async function upload(path: string, blob: Blob): Promise<void> {
  const { error } = await supabase.storage
    .from(OFFICE_COVER_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error(error.message);
}

/**
 * Capture the images for one published item from its vault PDF: the jacket
 * always, and every page when the PDF is a deck. Pages left over from an
 * earlier, longer capture are removed so the feed's count is honest.
 */
export async function captureOfficeImages(
  itemId: string,
  storagePath: string,
  filename: string | null | undefined,
  onProgress?: (done: number, total: number) => void,
): Promise<OfficeImages> {
  if (!canCaptureCover(filename)) return { cover: null, pages: 0 };
  const { data: file, error } = await supabase.storage.from(VAULT_BUCKET).download(storagePath);
  if (error || !file) throw new Error(error?.message ?? 'The document could not be read.');
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error('Not signed in.');

  const pdfjsLib = await loadPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), ...PDFJS_DOC_PARAMS }).promise;
  try {
    const jacketPath = `${uid}/office/${itemId}.jpg`;
    await upload(jacketPath, await pageJpeg(pdf, 1, COVER_LONG_EDGE, COVER_QUALITY));
    const cover = supabase.storage.from(OFFICE_COVER_BUCKET).getPublicUrl(jacketPath).data.publicUrl;

    const first = await pdf.getPage(1);
    const shape = first.getViewport({ scale: 1 });
    first.cleanup();
    const deck = shape.width > shape.height;
    if (!deck) return { cover, pages: 0 };

    const folder = `${uid}/office/${itemId}`;
    for (let n = 1; n <= pdf.numPages; n += 1) {
      await upload(`${folder}/${String(n).padStart(4, '0')}.jpg`, await pageJpeg(pdf, n, PAGE_LONG_EDGE, PAGE_QUALITY));
      onProgress?.(n, pdf.numPages);
    }
    const { data: existing } = await supabase.storage.from(OFFICE_COVER_BUCKET).list(folder, { limit: 1000 });
    const stale = (existing ?? [])
      .filter((o) => /^\d{4}\.jpg$/.test(o.name) && Number(o.name.slice(0, 4)) > pdf.numPages)
      .map((o) => `${folder}/${o.name}`);
    if (stale.length) await supabase.storage.from(OFFICE_COVER_BUCKET).remove(stale);
    return { cover, pages: pdf.numPages };
  } finally {
    await pdf.destroy();
  }
}

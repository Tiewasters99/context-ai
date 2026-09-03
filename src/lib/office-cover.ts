import { supabase } from '@/lib/supabase';
import { PDFJS_DOC_PARAMS } from '@/lib/pdfjs';

// The jacket a published book shows in the office's Reader.
//
// The office is one-way glass: the public feed serves text, never files.
// A cover is the one image that may pass — it is what a bookshop window
// shows — so it is captured here, at publish time, from page one of the
// vault's PDF, and put in the public cover-images bucket by convention at
//   <owner uid>/office/<office item id>.jpg
// No column records it: the feed lists that folder and any item whose id
// has a jacket there gets a `cover` URL. Re-capturing overwrites in place.

const COVER_LONG_EDGE = 1400;
const COVER_QUALITY = 0.86;
const VAULT_BUCKET = 'vault-documents';
export const OFFICE_COVER_BUCKET = 'cover-images';

/** Page one of a PDF as a JPEG, the long edge held to COVER_LONG_EDGE. */
async function firstPageJpeg(data: ArrayBuffer): Promise<Blob> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const pdf = await pdfjsLib.getDocument({ data, ...PDFJS_DOC_PARAMS }).promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: COVER_LONG_EDGE / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', COVER_QUALITY);
    });
    page.cleanup();
    return blob;
  } finally {
    await pdf.destroy();
  }
}

/** Whether a document can give the office a jacket: only a PDF has a page one to show. */
export function canCaptureCover(filename: string | null | undefined): boolean {
  return /\.pdf$/i.test(filename ?? '');
}

/**
 * Capture the jacket for one published item from its vault PDF. Returns the
 * public URL of the jacket, or null when the document is not a PDF.
 */
export async function captureOfficeCover(
  itemId: string,
  storagePath: string,
  filename: string | null | undefined,
): Promise<string | null> {
  if (!canCaptureCover(filename)) return null;
  const { data: file, error } = await supabase.storage.from(VAULT_BUCKET).download(storagePath);
  if (error || !file) throw new Error(error?.message ?? 'The document could not be read.');
  const jacket = await firstPageJpeg(await file.arrayBuffer());
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error('Not signed in.');
  const path = `${uid}/office/${itemId}.jpg`;
  const { error: upErr } = await supabase.storage
    .from(OFFICE_COVER_BUCKET)
    .upload(path, jacket, { contentType: 'image/jpeg', upsert: true });
  if (upErr) throw new Error(upErr.message);
  return supabase.storage.from(OFFICE_COVER_BUCKET).getPublicUrl(path).data.publicUrl;
}

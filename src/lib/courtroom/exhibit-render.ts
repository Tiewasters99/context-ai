// The Courtroom — rendering an exhibit's pixels for the evidence screen.
//
// Client-side only, no new services (spec §2.3): the original bytes come out
// of the vault bucket, PDFs render their chosen page through pdfjs-dist (the
// same machinery DocumentReader ships), images pass through as-is. The result
// is a data URL — the scene's setExhibit/armExhibit loader takes it directly,
// and nothing ever leaves the platform.

import { downloadVaultDocument } from '@/lib/vault-persist';

const TARGET_WIDTH = 1600; // matches the screen texture's useful resolution

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

export function isImageDoc(name: string): boolean {
  return IMAGE_EXT.test(name);
}

export function isPdfDoc(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/** A document the screen can show: a PDF (some page) or an image. */
export function isRenderableDoc(name: string): boolean {
  return isPdfDoc(name) || isImageDoc(name);
}

export async function renderExhibitDataUrl(
  doc: { name: string; storagePath?: string },
  page: number | null,
): Promise<string> {
  if (!doc.storagePath) throw new Error('This document has no stored file to render.');
  const blob = await downloadVaultDocument(doc.storagePath);

  if (isPdfDoc(doc.name)) return renderPdfPage(blob, page ?? 1);
  if (isImageDoc(doc.name)) return blobToDataUrl(blob);
  throw new Error('Only PDF and image documents can go on the screen (v1).');
}

async function renderPdfPage(blob: Blob, pageNo: number): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
  const page = await pdf.getPage(Math.min(Math.max(1, pageNo), pdf.numPages));
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: TARGET_WIDTH / base.width });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; // exhibits print on paper; the screen letterboxes
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.9);
  await pdf.destroy();
  return url;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.readAsDataURL(blob);
  });
}

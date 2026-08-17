/**
 * Manuscript extraction for the Editor's desk.
 *
 * Editor-specific rather than the shared extractText: a manuscript needs
 * paragraph structure (the shared PDF path joins every page into one
 * unbroken line), per-page progress (a brief-sized PDF otherwise looks
 * frozen while pdfjs works), and a yield to the event loop so the
 * "Reading…" note actually paints.
 */

import { PDFJS_DOC_PARAMS } from '@/lib/pdfjs';

const paint = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function extractManuscript(
  file: File,
  onProgress?: (label: string) => void,
): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  await paint();

  if (ext === 'pdf') return extractPdf(file, onProgress);
  if (ext === 'docx') {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  const text = await file.text();
  if (text.includes('\0')) throw new Error('this looks like a binary file, not text');
  return text;
}

async function extractPdf(file: File, onProgress?: (label: string) => void): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, ...PDFJS_DOC_PARAMS }).promise;

  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    if (pdf.numPages > 1) onProgress?.(`Reading page ${i} of ${pdf.numPages}…`);
    await paint();
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();

    // Rebuild lines from the text runs: pdfjs marks line ends with hasEOL.
    let pageText = '';
    for (const item of textContent.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (typeof item.str === 'string') pageText += item.str;
      if (item.hasEOL) pageText += '\n';
    }
    pages.push(pageText.trim());
  }

  return pages.filter(Boolean).join('\n\n');
}

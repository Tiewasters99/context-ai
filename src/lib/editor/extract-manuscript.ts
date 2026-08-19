/**
 * Manuscript extraction for the Editor's desk.
 *
 * Editor-specific rather than the shared extractText: a manuscript needs
 * paragraph structure (the shared PDF path joins every page into one
 * unbroken line), per-page progress (a brief-sized PDF otherwise looks
 * frozen while pdfjs works), and a yield to the event loop so the
 * "Reading…" note actually paints.
 *
 * Every failure here reaches the user verbatim — the messages name the
 * cause and the way out, not the exception.
 */

import { PDFJS_DOC_PARAMS } from '@/lib/pdfjs';

const paint = () => new Promise((resolve) => setTimeout(resolve, 0));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The tab is running a bundle whose hashed chunks a redeploy has deleted —
 * pdfjs can't fetch its worker module. The desk reloads once on this (the
 * vite:preloadError self-heal in main.tsx never sees worker fetches).
 */
export class StaleChunkError extends Error {
  constructor() {
    super('the app updated under this tab — reloading to pick up the new version');
    this.name = 'StaleChunkError';
  }
}

/**
 * Read the file's bytes, riding out cloud-placeholder hiccups. A file in
 * OneDrive that is "online-only" (or mid-sync) makes the browser's read
 * fail with a DOMException; one retry gives hydration a moment, then the
 * error explains the OneDrive fix instead of parroting the exception.
 */
async function readBytes(file: File): Promise<ArrayBuffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await delay(900);
    try {
      const buf = await file.arrayBuffer();
      if (buf.byteLength > 0) return buf;
      lastErr = new Error('empty read');
    } catch (err) {
      lastErr = err;
    }
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `Windows couldn’t hand the browser this file (${detail}). If it lives in OneDrive it may be online-only — ` +
      `open it once, or right-click it and choose “Always keep on this device”, wait for the sync check-mark, then try again.`,
  );
}

export async function extractManuscript(
  file: File,
  onProgress?: (label: string) => void,
): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  await paint();

  if (ext === 'pdf') return extractPdf(file, onProgress);
  if (ext === 'docx') {
    const mammoth = (await import('mammoth')).default;
    const bytes = await readBytes(file);
    try {
      const result = await mammoth.extractRawText({ arrayBuffer: bytes });
      return result.value;
    } catch (err) {
      throw new Error(
        `this .docx could not be opened (${err instanceof Error ? err.message : String(err)}) — ` +
          `an old-format .doc renamed to .docx fails this way; re-save it as .docx from Word`,
      );
    }
  }
  if (ext === 'doc') {
    throw new Error('old-format .doc files can’t be read here — re-save it as .docx from Word, or paste the text');
  }
  const bytes = await readBytes(file);
  const text = new TextDecoder().decode(bytes);
  if (text.includes('\0')) throw new Error('this looks like a binary file, not text');
  return text;
}

function isStaleChunkFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fake worker|dynamically imported module|module script failed|importing a module/i.test(msg);
}

async function extractPdf(file: File, onProgress?: (label: string) => void): Promise<string> {
  let pdfjsLib: typeof import('pdfjs-dist');
  try {
    pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
  } catch (err) {
    if (isStaleChunkFailure(err)) throw new StaleChunkError();
    throw err;
  }

  const arrayBuffer = await readBytes(file);

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: arrayBuffer, ...PDFJS_DOC_PARAMS }).promise;
  } catch (err) {
    if (isStaleChunkFailure(err)) throw new StaleChunkError();
    const name = err instanceof Error ? err.name : '';
    if (name === 'PasswordException') {
      throw new Error('this PDF is password-protected — remove the password (print to PDF works) and try again');
    }
    if (name === 'InvalidPDFException') {
      throw new Error(
        'this file isn’t a readable PDF — a failed download often saves an error page or a partial file under the .pdf name; re-download it and try again',
      );
    }
    throw new Error(`the PDF could not be opened (${err instanceof Error ? err.message : String(err)})`);
  }

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

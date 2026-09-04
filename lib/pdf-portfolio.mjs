// PDF portfolios ("PDF packages" / collections): a one-page cover sheet plus
// a set of embedded files. The Fifth Circuit's Electronic Record on Appeal
// (E-Record_<case>.pdf, built by the AO's iText) is the canonical example —
// 223 MB whose page tree is a single page reading "This document contains a
// collection of PDFs re: Case - 25-20513", with the 1,800-page record living
// in six attachments.
//
// Read as an ordinary PDF that is "one page with 63 characters", so the
// pipeline called it a scan, OCR'd the cover, and would have filed a
// searchable copy of one sentence (2026-09-03). This module detects the
// container and files each attachment as its own document, queued for the
// normal pipeline, inside a folder named after the wrapper.
//
// Provider-agnostic and side-effect free except through the supabase client
// it is handed, so it runs identically on the Fly worker, the Vercel inline
// path, and the MCP file_document path.

import { unpackContainer, stripExt, safeFilename } from './container-unpack.mjs';

const MARKERS = ['/EmbeddedFiles', '/Collection'];

// Cheap byte scan before paying for a pdf.js parse. Object streams could hide
// the markers; a portfolio we miss is handled exactly as before (store the
// wrapper), so the miss is safe, just unimproved.
export function mightBePortfolio(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (const m of MARKERS) {
    if (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(m)) return true;
  }
  return false;
}

// → { pageCount, isCollection, attachments: [{ name, filename, bytes }] } or null.
// `name` is the display key from the EmbeddedFiles name tree (the AO writes
// the human title there, e.g. "Pleadings, vol. 2 - 4:22-CV-4315");
// `filename` is the stored file name (e.g. "vol-685249.pdf").
//
// The marker scan is only a fast path: producers that write object streams
// (pdf-lib, most modern tools) compress the catalog, so the markers never
// appear in the raw bytes. Callers pass `force: true` to go straight to
// pdf.js — ingest-core does that for any PDF whose page tree is two pages or
// fewer, which is what every portfolio looks like after text extraction.
export async function detectPdfPortfolio(buf, { force = false } = {}) {
  if (!force && !mightBePortfolio(buf)) return null;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js takes ownership of (detaches) the array it is given — hand it a
  // copy so the caller's buffer survives for the normal pipeline.
  const src = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const task = pdfjs.getDocument({
    data: new Uint8Array(src),
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  try {
    const att = await doc.getAttachments();
    const names = att ? Object.keys(att) : [];
    if (!names.length) return null;
    let isCollection = false;
    try {
      const { info } = await doc.getMetadata();
      isCollection = info?.IsCollectionPresent === true;
    } catch { /* metadata is advisory */ }
    const pageCount = doc.numPages;
    // A real brief that happens to carry an attached exhibit is still a
    // brief: only a declared collection, or a cover-sheet-sized page tree,
    // counts as a container.
    if (!isCollection && pageCount > 2) return null;
    const attachments = names
      .map((name) => {
        const a = att[name] || {};
        const content = a.content ? Buffer.from(a.content) : Buffer.alloc(0);
        return { name, filename: a.filename || name, bytes: content };
      })
      .filter((a) => a.bytes.length > 0);
    if (!attachments.length) return null;
    return { pageCount, isCollection, attachments };
  } finally {
    try { await doc.destroy(); } catch { /* best effort */ }
  }
}

// Title for a child document: the display key when it looks like a title,
// otherwise the stored filename without its extension.
function titleFor(a) {
  const key = String(a.name || '').trim();
  if (key && key !== a.filename && !/\.[A-Za-z0-9]{1,5}$/.test(key)) return key;
  return stripExt(a.filename || key) || 'Attachment';
}

// Filename the child is stored under: keep the real extension (it drives the
// pipeline's format switch) but carry the display title so a listing of
// vault-documents reads as well as the app does.
function childFilename(a) {
  const ext = (String(a.filename || '').match(/\.[A-Za-z0-9]{1,5}$/) || ['.pdf'])[0].toLowerCase();
  return safeFilename(`${titleFor(a)}${ext}`, 'attachment.pdf');
}

// File each attachment as its own document under a folder named after the
// wrapper, queue each for the pipeline, and move the wrapper into the folder.
// The mechanics live in container-unpack.mjs, shared with .zip archives and
// email attachments (Phase 3); this maps a portfolio's attachments onto its
// entries and keeps the child metadata keys the 2026-09-03 unpack wrote.
export async function unpackPortfolio(supabase, { parent, attachments, onProgress = () => {} }) {
  const entries = attachments.map((a) => ({
    title: titleFor(a),
    filename: childFilename(a),
    bytes: a.bytes,
    entry: a.name,
    metadata: { portfolio_parent: parent?.id, portfolio_attachment: a.name },
  }));
  return unpackContainer(supabase, {
    parent, kind: 'portfolio', entries, folder: true, onProgress,
    describe: `the PDF portfolio "${parent?.source_filename || parent?.title || 'portfolio'}"`,
  });
}

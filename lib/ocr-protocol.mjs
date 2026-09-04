// The OCR wire protocol every model-based OCR route speaks (Phase 4 of the
// ingestion plan, 2026-09-04).
//
// Until today lib/ocr-gemini.mjs was the only OCR provider, and the prompt,
// the page-marker protocol and the PDF windowing lived inside it. Phase 4
// adds a second model route (Anthropic vision, lib/ocr-anthropic.mjs) that
// must produce IDENTICAL per-page output for the same scan — the pipeline
// merges OCR text back by page number, and a route that numbered pages
// differently would put an exhibit's text on the wrong page. So the parts
// that define "what a page of OCR looks like" live here, once, and each
// provider module only knows how to carry them to its own API.
//
// Two things are deliberately NOT here: any provider's endpoint or auth (that
// is the provider's business), and any policy about which route a matter may
// use (lib/ocr-routes.mjs).

import { PDFDocument } from 'pdf-lib';

// Verbatim-transcription instruction. Deliberately strict: no summarizing, no
// normalizing, no skipping — a scanned exhibit must come back as-written.
export const OCR_PROMPT = [
  'You are an OCR engine for scanned legal documents. Transcribe the text of EACH page VERBATIM.',
  'Rules:',
  '- Output the exact text as printed/handwritten, including headers, footers, stamps, Bates numbers, form labels, and handwriting where legible.',
  '- Do NOT summarize, paraphrase, correct spelling, translate, or add commentary.',
  '- Preserve line breaks and reading order. For tables/forms, transcribe label: value pairs line by line.',
  '- If a page is blank or fully illegible, output exactly: [no legible text].',
  '- Before EACH page output a delimiter line on its own: <<<PAGE n>>> where n is the page number I give you.',
  'Return ONLY the delimited transcription, nothing else.',
].join('\n');

/** The user-turn text that accompanies one window of pages. */
export function windowInstruction(absNums) {
  return `${OCR_PROMPT}\n\nTranscribe these ${absNums.length} page(s), numbering them: ${absNums.join(', ')}.`;
}

/** The user-turn text that accompanies a batch of page images. */
export function imagesInstruction(absNums) {
  return `${OCR_PROMPT}\n\nTranscribe these ${absNums.length} page image(s). They are numbered, in order: ${absNums.join(', ')}.`;
}

// Split `buf` into arrays of 0-based page indices of size `window`.
export async function pageWindows(buf, window) {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  const total = src.getPageCount();
  const windows = [];
  for (let start = 0; start < total; start += window) {
    const idx = [];
    for (let i = start; i < Math.min(start + window, total); i++) idx.push(i);
    windows.push(idx);
  }
  return { src, total, windows };
}

// Copy the given 0-based pages of an open pdf-lib document into a new PDF.
// Saved without object streams: pdf-parse (and some OCR services) choke on
// the compressed cross-reference streams pdf-lib writes by default.
export async function subPdfBytes(src, pageIdx) {
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageIdx);
  for (const p of copied) out.addPage(p);
  return out.save({ useObjectStreams: false }); // Uint8Array
}

// Parse a model's delimited output back into per-page text for the given
// absolute page numbers (1-based). Missing pages default to '' (the caller
// filters empties); "[no legible text]" becomes '' too.
export function parseDelimited(text, absPageNumbers) {
  const result = new Map();
  // parts = [pre, n1, body1, n2, body2, ...]
  const parts = String(text || '').split(/<<<\s*PAGE\s+(\d+)\s*>>>/i);
  for (let i = 1; i < parts.length; i += 2) {
    const n = parseInt(parts[i], 10);
    const body = (parts[i + 1] || '').trim();
    if (Number.isFinite(n)) result.set(n, body);
  }
  return absPageNumbers.map((n) => ({
    pageNumber: n,
    text: (result.get(n) || '').replace(/^\[no legible text\]$/i, '').trim(),
  }));
}

/**
 * Run `ocrWindow(bytes, absNums)` over every window of `buf` with bounded
 * concurrency and assemble the per-page result in page order. Shared by the
 * model routes so windowing, ordering and gap-filling cannot drift between
 * them. `ocrWindow` returns [{ pageNumber, text }] for its window (any order).
 */
export async function ocrByWindows(buf, { window = 8, concurrency = 4, onProgress = () => {}, label = 'OCR' }, ocrWindow) {
  const { src, total, windows } = await pageWindows(buf, window);
  // Every progress event carries the pipeline stage: the callers' loggers
  // (the worker's, the smoke's) key on it.
  onProgress({ stage: 'extracting', message: `${label}: ${total} page(s) in ${windows.length} window(s)` });

  const pagesOut = new Array(total);
  let done = 0;
  let wi = 0;
  async function worker() {
    while (wi < windows.length) {
      const myIdx = wi++;
      const pageIdx = windows[myIdx];
      const absNums = pageIdx.map((i) => i + 1);
      const bytes = await subPdfBytes(src, pageIdx);
      const out = await ocrWindow(bytes, absNums);
      for (const { pageNumber, text } of out) {
        if (pageNumber >= 1 && pageNumber <= total) pagesOut[pageNumber - 1] = { pageNumber, text };
      }
      done += pageIdx.length;
      onProgress({ stage: 'extracting', message: `${label} ${done}/${total} pages` });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, windows.length) }, worker));

  // Fill any gaps (a window that failed parse) with empty text so indices align.
  for (let i = 0; i < total; i++) if (!pagesOut[i]) pagesOut[i] = { pageNumber: i + 1, text: '' };
  return pagesOut;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const backoff = (n) => Math.min(1000 * 2 ** n, 30000) + Math.floor(Math.random() * 1000);

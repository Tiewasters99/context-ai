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

/** The page numbers a model's answer actually carries markers for. */
export function pagesWithMarkers(text) {
  const found = new Set();
  for (const m of String(text || '').matchAll(/<<<\s*PAGE\s+(\d+)\s*>>>/gi)) found.add(parseInt(m[1], 10));
  return found;
}

/**
 * A model declined or failed to answer for a window of pages, and said so in
 * a way the route could read (finishReason, stop_reason, a blocked prompt, a
 * truncated answer). `code` is a short machine word the pipeline records on
 * the page — 'recitation', 'safety', 'truncated', 'blocked', 'empty',
 * 'no_answer' — and `pages` names the window it was asked for.
 *
 * Why this exists (2026-10-22): Gemini answers a verbatim-transcription
 * request on text it recognises from its training data — a published OATH
 * decision, a US patent, a public-domain book — with HTTP 200, finishReason
 * RECITATION and no text at all. The Gemini route returned that as '' for
 * every page of the window, and the pipeline recorded eight pages at a time
 * as "no legible text" on a document it then marked ready. The Bushell
 * "Major World" decision lost 61 of 85 pages that way. A refusal is now an
 * error with a code, never a blank page.
 */
export class OcrWindowError extends Error {
  constructor(message, { code = 'error', pages = [] } = {}) {
    super(message);
    this.name = 'OcrWindowError';
    this.code = code;
    this.pages = pages;
  }
}

/**
 * Run `ocrWindow(bytes, absNums)` over every window of `buf` with bounded
 * concurrency and assemble the per-page result in page order. Shared by the
 * model routes so windowing, ordering and gap-filling cannot drift between
 * them. `ocrWindow` returns [{ pageNumber, text }] for its window (any order);
 * a page it could not get an answer for may carry `missing: true`.
 *
 * A window the model declines (the callback throws) or answers without a
 * marker for some of its pages is not lost: those pages are queued again ONE
 * PAGE AT A TIME — a single page of a published decision transcribes where
 * eight together are refused as recitation (measured 2026-10-22). A page
 * that still gets no answer on its own comes back with `failed: <code>` and
 * empty text, so the caller can record it as awaiting OCR instead of blank.
 */
export async function ocrByWindows(buf, { window = 8, concurrency = 4, onProgress = () => {}, label = 'OCR' }, ocrWindow) {
  const { src, total, windows } = await pageWindows(buf, window);
  // Every progress event carries the pipeline stage: the callers' loggers
  // (the worker's, the smoke's) key on it.
  onProgress({ stage: 'extracting', message: `${label}: ${total} page(s) in ${windows.length} window(s)` });

  const pagesOut = new Array(total);
  let done = 0;
  let wi = 0;
  let retried = 0;
  const codeOf = (err) => (err && typeof err.code === 'string' && err.code) || 'error';
  const firstLine = (err) => String(err?.message || err || '').split('\n')[0].slice(0, 160);
  // Pages from a declined or partly answered window go back on the queue as
  // single-page windows; the workers pick them up like any other window.
  const requeueSingly = (pageIdx, why) => {
    for (const i of pageIdx) windows.push([i]);
    retried += pageIdx.length;
    const nums = pageIdx.map((i) => i + 1);
    const span = nums.length === 1 ? `page ${nums[0]}` : `pages ${nums[0]}-${nums[nums.length - 1]}`;
    onProgress({ stage: 'extracting', message: `${label}: ${span} ${why} — retrying one page at a time` });
  };
  async function worker() {
    while (wi < windows.length) {
      const myIdx = wi++;
      const pageIdx = windows[myIdx];
      const absNums = pageIdx.map((i) => i + 1);
      const bytes = await subPdfBytes(src, pageIdx);
      let out;
      try {
        out = await ocrWindow(bytes, absNums);
      } catch (err) {
        // Only a model's own refusal or non-answer (OcrWindowError) is a
        // per-page matter. Anything else — network, auth, a provider that
        // cannot open the file — still fails the run, so the route policy
        // (lib/ocr-routes.mjs) can try the next provider, as before.
        if (!(err instanceof OcrWindowError)) throw err;
        if (pageIdx.length > 1) {
          requeueSingly(pageIdx, `declined (${codeOf(err)})`);
          continue;
        }
        // Declined on its own too: the page is not blank, it is unread.
        pagesOut[pageIdx[0]] = { pageNumber: absNums[0], text: '', failed: codeOf(err), reason: firstLine(err) };
        done += 1;
        onProgress({ stage: 'extracting', message: `${label} ${done}/${total} pages (page ${absNums[0]} not read: ${firstLine(err)})` });
        continue;
      }
      const missing = [];
      for (const p of out || []) {
        const { pageNumber, text } = p;
        if (!(pageNumber >= 1 && pageNumber <= total)) continue;
        if (p.missing && pageIdx.length > 1) { missing.push(pageNumber - 1); continue; }
        pagesOut[pageNumber - 1] = p.missing
          ? { pageNumber, text: '', failed: 'no_answer', reason: 'the model answered without this page' }
          : { pageNumber, text: text || '' };
      }
      if (missing.length) requeueSingly(missing, 'answered without a page marker');
      done += pageIdx.length - missing.length;
      onProgress({ stage: 'extracting', message: `${label} ${done}/${total} pages` });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, windows.length) }, worker));

  // A page nothing answered for at all is unread, not blank.
  for (let i = 0; i < total; i++) if (!pagesOut[i]) pagesOut[i] = { pageNumber: i + 1, text: '', failed: 'no_answer', reason: 'no answer for this page' };
  const failed = pagesOut.filter((p) => p.failed).length;
  if (retried || failed) {
    onProgress({ stage: 'extracting', message: `${label}: ${retried} page(s) retried singly; ${failed} still unread` });
  }
  return pagesOut;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const backoff = (n) => Math.min(1000 * 2 ** n, 30000) + Math.floor(Math.random() * 1000);

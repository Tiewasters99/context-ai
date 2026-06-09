// Gemini OCR for scanned, image-only PDFs (no text layer).
//
// Strategy: split the source PDF into small page-windows with pdf-lib (pure JS,
// no native rendering), send each window to Gemini as inline PDF data, and ask
// for VERBATIM per-page transcription delimited by page markers. We reconstruct
// exact page numbers from the window offset, so passages keep true page
// coordinates (legal citations depend on this — see feedback_deposition_fidelity).
//
// This module is provider-specific by design; the rest of the ingest pipeline
// stays model-agnostic and receives OCR results through an injected hook
// (processDocument's `ocr` option), so nothing in ingest-core depends on Gemini.

import { PDFDocument } from 'pdf-lib';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Verbatim-transcription instruction. We are deliberately strict: no summarizing,
// no normalizing, no skipping — a scanned exhibit must come back as-written.
const OCR_PROMPT = [
  'You are an OCR engine for scanned legal documents. Transcribe the text of EACH page VERBATIM.',
  'Rules:',
  '- Output the exact text as printed/handwritten, including headers, footers, stamps, Bates numbers, form labels, and handwriting where legible.',
  '- Do NOT summarize, paraphrase, correct spelling, translate, or add commentary.',
  '- Preserve line breaks and reading order. For tables/forms, transcribe label: value pairs line by line.',
  '- If a page is blank or fully illegible, output exactly: [no legible text].',
  '- Before EACH page output a delimiter line on its own: <<<PAGE n>>> where n is the page number I give you.',
  'Return ONLY the delimited transcription, nothing else.',
].join('\n');

// Split `buf` into arrays of page indices of size `window`.
async function pageWindows(buf, window) {
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

async function subPdfBytes(src, pageIdx) {
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageIdx);
  for (const p of copied) out.addPage(p);
  return out.save(); // Uint8Array
}

// Parse Gemini's delimited output back into per-page text for the given absolute
// page numbers (1-based). Missing pages default to '' (caller filters empties).
function parseDelimited(text, absPageNumbers) {
  const result = new Map();
  // Split on the page markers, keeping the captured page number.
  const parts = text.split(/<<<\s*PAGE\s+(\d+)\s*>>>/i);
  // parts = [pre, n1, body1, n2, body2, ...]
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

async function callGemini({ apiKey, model, pdfBytes, pageNumbers, maxRetries = 5 }) {
  const b64 = Buffer.from(pdfBytes).toString('base64');
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: `${OCR_PROMPT}\n\nTranscribe these ${pageNumbers.length} page(s), numbering them: ${pageNumbers.join(', ')}.` },
        { inlineData: { mimeType: 'application/pdf', data: b64 } },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 65536 },
  };
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (netErr) {
      if (attempt >= maxRetries) throw new Error(`gemini network error: ${netErr.message}`);
      await sleep(backoff(attempt++)); continue;
    }
    if (res.ok) {
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      return parts.map((p) => p.text || '').join('');
    }
    const errText = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      throw new Error(`gemini ${res.status}: ${errText.slice(0, 300)}`);
    }
    await sleep(backoff(attempt++));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (n) => Math.min(1000 * 2 ** n, 30000) + Math.floor(Math.random() * 1000);

// Public: OCR a whole PDF buffer -> [{ pageNumber, text }] (1-based, in order).
// Pages that come back empty are still returned with text:'' so the caller knows
// the page exists; ingest-core filters empty passages downstream.
export async function ocrPdf(buf, {
  apiKey,
  model = 'gemini-2.5-flash',
  window = 8,
  concurrency = 4,
  onProgress = () => {},
} = {}) {
  if (!apiKey) throw new Error('ocrPdf: apiKey required');
  const { src, total, windows } = await pageWindows(buf, window);
  onProgress({ message: `OCR: ${total} page(s) in ${windows.length} window(s) via ${model}` });

  const pagesOut = new Array(total);
  let done = 0;
  let wi = 0;
  async function worker() {
    while (wi < windows.length) {
      const myIdx = wi++;
      const pageIdx = windows[myIdx];
      const absNums = pageIdx.map((i) => i + 1);
      const bytes = await subPdfBytes(src, pageIdx);
      const raw = await callGemini({ apiKey, model, pdfBytes: bytes, pageNumbers: absNums });
      for (const { pageNumber, text } of parseDelimited(raw, absNums)) {
        pagesOut[pageNumber - 1] = { pageNumber, text };
      }
      done += pageIdx.length;
      onProgress({ message: `OCR ${done}/${total} pages` });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, windows.length) }, worker));

  // Fill any gaps (a window that failed parse) with empty text so indices align.
  for (let i = 0; i < total; i++) if (!pagesOut[i]) pagesOut[i] = { pageNumber: i + 1, text: '' };
  return pagesOut;
}

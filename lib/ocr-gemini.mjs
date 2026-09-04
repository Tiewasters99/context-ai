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
// The prompt, the page-marker protocol and the windowing are shared with the
// other model routes through lib/ocr-protocol.mjs (Phase 4, 2026-09-04), so
// every route returns the same shape for the same scan.

import {
  windowInstruction, imagesInstruction, parseDelimited, ocrByWindows, sleep, backoff,
} from './ocr-protocol.mjs';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini({ apiKey, model, parts, maxRetries = 5 }) {
  const body = {
    contents: [{ role: 'user', parts }],
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
  return ocrByWindows(buf, { window, concurrency, onProgress, label: `OCR via ${model}` }, async (bytes, absNums) => {
    const raw = await callGemini({
      apiKey,
      model,
      parts: [
        { text: windowInstruction(absNums) },
        { inlineData: { mimeType: 'application/pdf', data: Buffer.from(bytes).toString('base64') } },
      ],
    });
    return parseDelimited(raw, absNums);
  });
}

// Public: OCR a batch of page images (already-scanned pages, e.g. vFlat JPEGs)
// in ONE model call -> [{ pageNumber, text }] aligned with the input order.
// Same delimiter protocol as ocrPdf, so page numbers survive round-trip.
export async function ocrImages(images, { apiKey, model = 'gemini-2.5-flash' } = {}) {
  if (!apiKey) throw new Error('ocrImages: apiKey required');
  if (!images?.length) return [];
  const absNums = images.map((im) => im.pageNumber);
  const parts = [
    { text: imagesInstruction(absNums) },
    ...images.map((im) => ({
      inlineData: { mimeType: im.mimeType || 'image/jpeg', data: Buffer.from(im.bytes).toString('base64') },
    })),
  ];
  const raw = await callGemini({ apiKey, model, parts });
  return parseDelimited(raw, absNums);
}

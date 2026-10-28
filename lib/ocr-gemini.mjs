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
//
// A refusal is a refusal (2026-10-22). Gemini answers a verbatim request on
// text it knows from training — a published OATH decision, a US patent, a
// public-domain book — with HTTP 200, finishReason RECITATION and an empty
// answer. Until today callGemini returned that empty string, parseDelimited
// made it '' for every page of the window, and the pipeline recorded eight
// pages at a time as "no legible text" on a document it marked ready (the
// Bushell "Major World" decision: 61 of 85 pages). Now every answer's
// finishReason is read: anything but a complete answer throws an
// OcrWindowError with a code, ocrByWindows retries the window's pages one at
// a time (a single page transcribes where eight are refused), and a page that
// still gets no answer is returned `failed`, never blank.

import { DEFAULT_GEMINI_MODEL } from './gemini-models.mjs';
import {
  windowInstruction, imagesInstruction, parseDelimited, pagesWithMarkers, ocrByWindows, OcrWindowError,
  sleep, backoff,
} from './ocr-protocol.mjs';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// finishReason → the short code recorded on the page. Anything not listed is
// reported under its own lower-cased name so a new reason is never hidden.
const FINISH_CODES = {
  RECITATION: 'recitation',
  SAFETY: 'safety',
  PROHIBITED_CONTENT: 'safety',
  BLOCKLIST: 'safety',
  SPII: 'safety',
  IMAGE_SAFETY: 'safety',
  MAX_TOKENS: 'truncated',
  MALFORMED_FUNCTION_CALL: 'empty',
  OTHER: 'empty',
};

/**
 * One generateContent call. Resolves to the answer's text ONLY when the model
 * finished it (finishReason STOP, or an unstated reason with text); every
 * other outcome — a blocked prompt, no candidate, RECITATION, SAFETY, a
 * MAX_TOKENS cut, an empty answer — is an OcrWindowError with a code and
 * the pages asked for. Network errors, 429 and 5xx retry with backoff as
 * before; a refusal never retries here, because the same window gets the same
 * answer — the caller retries smaller.
 */
export async function callGemini({ apiKey, model, parts, pages = [], maxRetries = 5, fetchImpl = fetch }) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0, maxOutputTokens: 65536 },
  };
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (netErr) {
      if (attempt >= maxRetries) throw new Error(`gemini network error: ${netErr.message}`);
      await sleep(backoff(attempt++)); continue;
    }
    if (res.ok) {
      const data = await res.json();
      return answerText(data, pages);
    }
    const errText = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      throw new Error(`gemini ${res.status}: ${errText.slice(0, 300)}`);
    }
    await sleep(backoff(attempt++));
  }
}

/** The text of a finished answer, or an OcrWindowError saying why there is none. Exported for tests. */
export function answerText(data, pages = []) {
  const span = pages.length ? ` for page(s) ${pages.join(', ')}` : '';
  const blocked = data?.promptFeedback?.blockReason;
  if (blocked) throw new OcrWindowError(`gemini blocked the request${span} (${blocked})`, { code: 'blocked', pages });
  const cand = data?.candidates?.[0];
  if (!cand) throw new OcrWindowError(`gemini returned no answer${span}`, { code: 'empty', pages });
  const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
  const reason = String(cand.finishReason || '').toUpperCase();
  if (reason && reason !== 'STOP') {
    const code = FINISH_CODES[reason] || reason.toLowerCase();
    throw new OcrWindowError(`gemini did not transcribe${span}: finishReason ${reason}`, { code, pages });
  }
  if (!text.trim()) throw new OcrWindowError(`gemini returned an empty answer${span}`, { code: 'empty', pages });
  return text;
}

/**
 * The parsed pages of one window. A multi-page answer with no marker at all is
 * no answer (thrown, so the window is retried singly); a page the answer skips
 * is returned `missing` for the same retry; a single page answered without its
 * marker keeps the text — the model transcribed, it just forgot the label.
 */
export function windowPages(raw, absNums) {
  const markers = pagesWithMarkers(raw);
  if (absNums.length === 1 && markers.size === 0) {
    return [{ pageNumber: absNums[0], text: String(raw).replace(/^\[no legible text\]$/i, '').trim() }];
  }
  if (absNums.length === 1 && markers.size === 1 && !markers.has(absNums[0])) {
    // One page asked, one marker given, wrong number (the model saw a
    // one-page PDF and wrote <<<PAGE 1>>>): the text is this page's.
    const only = parseDelimited(raw, [...markers])[0];
    return [{ pageNumber: absNums[0], text: only.text }];
  }
  if (markers.size === 0) {
    throw new OcrWindowError(`gemini answered without page markers for page(s) ${absNums.join(', ')}`, { code: 'no_answer', pages: absNums });
  }
  return parseDelimited(raw, absNums).map((p) => (markers.has(p.pageNumber) ? p : { ...p, missing: true }));
}

// Public: OCR a whole PDF buffer -> [{ pageNumber, text }] (1-based, in order).
// Pages that come back empty are still returned with text:'' so the caller knows
// the page exists; ingest-core filters empty passages downstream. A page the
// model would not read carries `failed: <code>` (see ocrByWindows).
export async function ocrPdf(buf, {
  apiKey,
  model = DEFAULT_GEMINI_MODEL,
  window = 8,
  concurrency = 4,
  onProgress = () => {},
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('ocrPdf: apiKey required');
  return ocrByWindows(buf, { window, concurrency, onProgress, label: `OCR via ${model}` }, async (bytes, absNums) => {
    const raw = await callGemini({
      apiKey,
      model,
      pages: absNums,
      fetchImpl,
      parts: [
        { text: windowInstruction(absNums) },
        { inlineData: { mimeType: 'application/pdf', data: Buffer.from(bytes).toString('base64') } },
      ],
    });
    return windowPages(raw, absNums);
  });
}

// Public: OCR a batch of page images (already-scanned pages, e.g. vFlat JPEGs)
// in ONE model call -> [{ pageNumber, text }] aligned with the input order.
// Same delimiter protocol as ocrPdf, so page numbers survive round-trip. A
// batch the model declines is retried one image at a time; an image still
// declined on its own comes back `failed: <code>` with empty text (the
// Student Hub writes that as an empty sidecar, as before, with the other
// pages read); a lone image that is declined throws.
export async function ocrImages(images, { apiKey, model = DEFAULT_GEMINI_MODEL, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('ocrImages: apiKey required');
  if (!images?.length) return [];
  const one = async (batch) => {
    const absNums = batch.map((im) => im.pageNumber);
    const parts = [
      { text: imagesInstruction(absNums) },
      ...batch.map((im) => ({
        inlineData: { mimeType: im.mimeType || 'image/jpeg', data: Buffer.from(im.bytes).toString('base64') },
      })),
    ];
    const raw = await callGemini({ apiKey, model, parts, pages: absNums, fetchImpl });
    return windowPages(raw, absNums);
  };
  let out;
  try {
    out = await one(images);
  } catch (err) {
    if (!(err instanceof OcrWindowError) || images.length === 1) throw err;
    out = images.map((im) => ({ pageNumber: im.pageNumber, text: '', missing: true }));
  }
  const result = [];
  for (const p of out) {
    if (!p.missing) { result.push({ pageNumber: p.pageNumber, text: p.text }); continue; }
    const im = images.find((x) => x.pageNumber === p.pageNumber);
    try {
      const [single] = await one([im]);
      result.push({ pageNumber: p.pageNumber, text: single.text });
    } catch (err) {
      if (!(err instanceof OcrWindowError)) throw err;
      result.push({ pageNumber: p.pageNumber, text: '', failed: err.code, reason: String(err.message).split('\n')[0].slice(0, 160) });
    }
  }
  return result;
}

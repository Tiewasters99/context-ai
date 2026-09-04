// Anthropic vision OCR for scanned PDFs (Phase 4 of the ingestion plan,
// 2026-09-04 — Eden's decision 2: Anthropic vision for documents OUTSIDE
// SecureSpaces, as the fidelity route beside Gemini).
//
// Same strategy as lib/ocr-gemini.mjs, same protocol (lib/ocr-protocol.mjs):
// the PDF is split into small page-windows with pdf-lib, each window goes to
// the Messages API as a base64 PDF document, and the model returns VERBATIM
// per-page text behind <<<PAGE n>>> markers that we map back to true page
// numbers. Nothing upstream can tell which route read a page — that is the
// point of the shared protocol.
//
// Provider-specific by design. Policy (which tier may use this) lives in
// lib/ocr-routes.mjs; the pipeline only ever sees a hook.
//
// Cost: this is the expensive route — roughly 5–15× Gemini Flash per page
// depending on the model (Eden's cost note in the plan). The exact token
// usage comes back on every response, and ocrPdfAnthropic returns it so the
// route can record a dollar estimate on the document for a person to see.

import Anthropic from '@anthropic-ai/sdk';

import { windowInstruction, parseDelimited, ocrByWindows } from './ocr-protocol.mjs';

// Opus 5 by default: verbatim transcription of a scanned exhibit is exactly
// where a weaker model's "helpful" normalization costs a citation. Override
// with ANTHROPIC_OCR_MODEL (e.g. claude-sonnet-5 at ~40% of the price).
export const DEFAULT_ANTHROPIC_OCR_MODEL = 'claude-opus-5';

// First-party list prices, $ per million tokens [input, output], as cached
// 2026-06-24. Only used for the estimate a person reads on the document
// (metadata.ocr_route.estimated_usd) — never for billing. An unknown model
// falls back to the Opus rate so an estimate is never silently too low.
export const ANTHROPIC_PRICES_PER_MTOK = Object.freeze({
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
});

export function estimateAnthropicUsd(model, usage) {
  const [inRate, outRate] = ANTHROPIC_PRICES_PER_MTOK[model] || ANTHROPIC_PRICES_PER_MTOK['claude-opus-5'];
  const inTok = (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + 0.1 * (usage?.cache_read_input_tokens || 0);
  const outTok = usage?.output_tokens || 0;
  return (inTok * inRate + outTok * outRate) / 1e6;
}

/** The text content of a response, concatenated. */
export function textOf(message) {
  return (message?.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
}

// Public: OCR a whole PDF buffer -> { pages: [{ pageNumber, text }], usage, model }.
// `pages` has the same shape and guarantees as ocr-gemini's ocrPdf (1-based,
// in order, every page present, empties as '').
export async function ocrPdfAnthropic(buf, {
  apiKey,
  model = DEFAULT_ANTHROPIC_OCR_MODEL,
  window = 8,
  concurrency = 3,
  onProgress = () => {},
  maxRetries = 3,
  client = null,
} = {}) {
  if (!apiKey && !client) throw new Error('ocrPdfAnthropic: apiKey required');
  const anthropic = client || new Anthropic({ apiKey, maxRetries });
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, requests: 0 };

  const pages = await ocrByWindows(buf, { window, concurrency, onProgress, label: `OCR via ${model}` }, async (bytes, absNums) => {
    // Streaming so a dense window (eight pages of small print is well over
    // ten thousand output tokens) never trips the request timeout. Low effort:
    // this is transcription, not reasoning, and thinking only adds cost.
    // Server-side fallbacks: a page the model's safety layer declines to read
    // (graphic evidence photos happen in this practice) is re-run on the
    // fallback model inside the same call instead of coming back empty.
    const stream = anthropic.beta.messages.stream({
      model,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } },
          { type: 'text', text: windowInstruction(absNums) },
        ],
      }],
    });
    const msg = await stream.finalMessage();
    usage.requests++;
    for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
      usage[k] += Number(msg.usage?.[k]) || 0;
    }
    if (msg.stop_reason === 'refusal') {
      const cat = msg.stop_details?.category ? ` (${msg.stop_details.category})` : '';
      throw new Error(`anthropic declined to transcribe page(s) ${absNums.join(', ')}${cat}`);
    }
    if (msg.stop_reason === 'max_tokens') {
      // Truncated mid-window: the pages after the cut would come back empty
      // and be recorded as "no legible text", which is untrue. Fail the
      // window so the route (or the schedule) tries again.
      throw new Error(`anthropic output truncated on page(s) ${absNums.join(', ')} — window too dense for max_tokens`);
    }
    return parseDelimited(textOf(msg), absNums);
  });

  return { pages, usage, model, estimated_usd: estimateAnthropicUsd(model, usage) };
}

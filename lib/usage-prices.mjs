// What a request is about to cost, in cents — the estimating half of the
// usage meter (migration 063).
//
// Why the rates are restated here rather than imported
// ---------------------------------------------------------------------------
// The two existing price tables in this repo are the right numbers and this
// file MUST NOT disagree with them:
//
//   lib/assistant-core.mjs  PENS[*].pricePerM          (the pens, $/Mtok)
//   lib/ocr-anthropic.mjs   ANTHROPIC_PRICES_PER_MTOK  (first-party Claude)
//   lib/ocr-routes.mjs      ROUTES['gemini-flash'].usdPerPage
//
// But both of those modules statically import @anthropic-ai/sdk (and
// assistant-core pulls in lib/mcp-core.mjs behind it), and the meter runs
// first thing inside /api/tts and /api/deepgram-token, which have no business
// paying that cold start. So the rates are mirrored here, in a module with no
// imports at all, and scripts/_test-usage-meter.mjs asserts — by importing the
// real tables in the TEST, not in the request path — that every mirrored rate
// still equals its source. Drift fails the test rather than quietly
// under-billing.
//
// Direction of error: every estimate here is meant to be HIGH. It is charged
// before the provider is called, and corrected downward afterwards where the
// response reports real token counts (usage_record_actual). An estimate that
// is too low is a hole in the cap; one that is too high costs a user a little
// headroom for a few seconds.

// $ per million tokens, [input, output]. Mirrors ANTHROPIC_PRICES_PER_MTOK and
// PENS[*].pricePerM — see the note above.
export const PRICES_PER_MTOK = Object.freeze({
  // lib/ocr-anthropic.mjs
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
  // lib/assistant-core.mjs PENS
  'anthropic.claude-opus-5': [5.5, 27.5],
  'moonshotai.kimi-k2.5': [0.6, 2.5],
  'accounts/fireworks/models/kimi-k3': [3, 15],
});

// The fallback when a model id is not in the table — which is the normal case
// for /api/llm, whose body names any model the caller likes. Deliberately the
// most expensive rate we know for that provider, so an unknown model is never
// cheap by accident.
export const PROVIDER_FALLBACK_PER_MTOK = Object.freeze({
  anthropic: [5, 25],
  openai: [5, 20],
  google: [2.5, 15],
  xai: [3, 15],
  moonshot: [3, 15],
  fireworks: [3, 15],
  'aws-bedrock': [5.5, 27.5],
});

const DEFAULT_RATE = [5, 25];

/** [inputUsdPerMtok, outputUsdPerMtok] for a model id, falling back by provider. */
export function ratePerMtok(model, provider) {
  if (model && PRICES_PER_MTOK[model]) return PRICES_PER_MTOK[model];
  // Bare-name match: 'claude-opus-4-8-20260115' → 'claude-opus-4-8'.
  if (model) {
    for (const key of Object.keys(PRICES_PER_MTOK)) {
      if (model.startsWith(key)) return PRICES_PER_MTOK[key];
    }
  }
  return PROVIDER_FALLBACK_PER_MTOK[provider] || DEFAULT_RATE;
}

const centsUp = (usd) => Math.max(0, Math.ceil(usd * 100));

/** Cents for a known token count. Used to record ACTUALS after a call. */
export function centsForTokens(model, provider, usage) {
  const [inRate, outRate] = ratePerMtok(model, provider);
  const input = Number(usage?.input || usage?.input_tokens || 0);
  const output = Number(usage?.output || usage?.output_tokens || 0);
  return centsUp((input * inRate + output * outRate) / 1e6);
}

// Tokens per byte of request body. The usual rule of thumb is ~4 bytes per
// token for English prose; 3 is used here because the estimate must not come
// in under the truth, and JSON, code and citations tokenise worse than prose.
const BYTES_PER_TOKEN = 3;

/** Conservative token count for a raw request body. */
export function estimateInputTokens(bodyText) {
  const bytes = typeof bodyText === 'string'
    ? Buffer.byteLength(bodyText, 'utf8')
    : Number(bodyText) || 0;
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/**
 * The pre-call estimate for /api/llm and the Assistant: every input byte
 * charged at the input rate, plus the FULL output allowance at the output
 * rate. A turn that stops after two sentences is refunded by
 * usage_record_actual where the response reports usage.
 */
export function estimateLlmCents({ provider, model, bodyText, maxOutputTokens = 4096 }) {
  const [inRate, outRate] = ratePerMtok(model, provider);
  const input = estimateInputTokens(bodyText);
  const output = Math.max(0, Number(maxOutputTokens) || 0);
  return centsUp((input * inRate + output * outRate) / 1e6);
}

// OpenAI list price for the speech models is $15 per million input characters
// (tts-1 and the gpt-4o-mini-tts character equivalent). api/tts.mjs caps text
// at 4,000 characters, so one call is at most ~6 cents.
export const TTS_USD_PER_1K_CHARS = 0.015;

export function estimateTtsCents(chars) {
  return centsUp((Math.max(0, Number(chars) || 0) / 1000) * TTS_USD_PER_1K_CHARS);
}

// OCR, $ per page. Gemini Flash is the measured rate from
// lib/ocr-routes.mjs (ROUTES['gemini-flash'].usdPerPage). The "unknown route"
// rate is the Anthropic-vision end of the range that the same file describes
// as 5–15× Flash — used wherever the pipeline has not yet chosen a route, so
// the estimate is never the cheap one by default.
export const OCR_USD_PER_PAGE_GEMINI = 0.002;
export const OCR_USD_PER_PAGE_MAX = 0.03;
// AWS Textract DetectDocumentText, $1.50 per 1,000 pages (us-east-1, first
// million pages) — the SEALED route. Mirrored from lib/ocr-textract.mjs
// TEXTRACT_USD_PER_PAGE for the same reason the token rates above are
// mirrored: that module pulls in the SigV4 signer, and the estimator runs in
// a browser. scripts/_test-ingest-estimate.mjs imports the real constant and
// fails if the two ever drift.
export const OCR_USD_PER_PAGE_TEXTRACT = 0.0015;

// $ per page by the route that will actually read them. An unrecognised route
// is priced at the dearest rate we know, never the cheapest — the same
// direction of error as everything else in this file.
const OCR_USD_PER_PAGE_BY_ROUTE = Object.freeze({
  gemini: OCR_USD_PER_PAGE_GEMINI,
  'gemini-flash': OCR_USD_PER_PAGE_GEMINI,
  'aws-textract': OCR_USD_PER_PAGE_TEXTRACT,
  textract: OCR_USD_PER_PAGE_TEXTRACT,
  'anthropic-vision': OCR_USD_PER_PAGE_MAX,
});

/** $ per OCR page for a route id, defaulting HIGH for anything unrecognised. */
export function ocrUsdPerPage(route) {
  return OCR_USD_PER_PAGE_BY_ROUTE[route] ?? OCR_USD_PER_PAGE_MAX;
}

export function estimateOcrCents(pages, { route = 'unknown' } = {}) {
  return centsUp(Math.max(0, Number(pages) || 0) * ocrUsdPerPage(route));
}

// Embeddings: text-embedding-3-small is $0.02 per million tokens. A document
// is embedded once, so this is small next to OCR — but a 5,000-page production
// is still 5M+ tokens, and the point of a meter is that nothing is free.
export const EMBED_USD_PER_MTOK = 0.02;

/**
 * What /api/ingest is about to spend INLINE, on this invocation.
 *
 * Deliberately narrow, because the handler's own gate is narrow: a scanned PDF
 * is routed to the Fly worker before any provider is called here, and a
 * document too large for the serverless budget is queued. What the serverless
 * function actually pays for is embedding the extracted text, plus — for a
 * scanned page saved as a JPEG or PNG — exactly one OCR call, since that is
 * one image.
 *
 * An earlier draft guessed a page count from the file size and charged every
 * page at the Anthropic-vision rate. That billed a born-digital 900 KB PDF
 * $8.80 against a $15 month for about a cent of real embedding, while the
 * expensive case it was aimed at had already left for the worker. The honest
 * position is the one the handler states: this is a request-rate and
 * declared-size gate, and the cents should agree with it. Per-page metering
 * belongs where the pages are counted — inside the worker.
 */
export function estimateIngestCents({ bytes = 0, ocrableImage = false } = {}) {
  const tokens = Math.ceil((Number(bytes) || 0) / BYTES_PER_TOKEN);
  const embedUsd = (tokens / 1e6) * EMBED_USD_PER_MTOK;
  const ocrUsd = ocrableImage ? OCR_USD_PER_PAGE_GEMINI : 0;
  return centsUp(embedUsd + ocrUsd);
}

// Deepgram streaming transcription, ~$0.0043 per minute (nova, pay-as-you-go).
// /api/deepgram-token mints a credential rather than doing the work, so the
// charge is for the session the credential opens: a conservative default
// length, not a measurement.
export const DEEPGRAM_USD_PER_MINUTE = 0.0043;
export const DEEPGRAM_ASSUMED_MINUTES = 60;

export function estimateDeepgramSessionCents(minutes = DEEPGRAM_ASSUMED_MINUTES) {
  return centsUp((Number(minutes) || 0) * DEEPGRAM_USD_PER_MINUTE);
}

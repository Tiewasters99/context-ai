// lib/gemini-models.mjs — the Gemini model the first-party paths use when
// nothing says otherwise: PDF OCR (lib/ocr-gemini.mjs, lib/ocr-routes.mjs),
// audio/video transcription (lib/transcribe-gemini.mjs) and the Video Room
// (lib/video-discovery/gemini-video.mjs).
//
// One id, in one place. On 2026-10-19 Google retired the gemini-2.5-* ids for
// Google Cloud projects created after mid-2026: generateContent answers 404
// "no longer available to new users" and names gemini-3.8-flash as the
// successor. The production key moved to such a project that day, so every
// default below it moved with it. The next retirement is one line again.
//
// Per-path overrides, read from the environment where each path starts:
//   GEMINI_OCR_MODEL                        lib/ocr-routes.mjs
//   GEMINI_VIDEO_MODELS / GEMINI_VIDEO_MODEL lib/video-discovery/gemini-video.mjs
//
// Prices live in lib/usage-prices.mjs (PRICES_PER_MTOK); a new default needs a
// row there too, or the meter falls back to the dearest Google rate it knows.
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

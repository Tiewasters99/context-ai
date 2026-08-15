// Shared pdfjs configuration.
//
// Every getDocument() call in the app must pass these, or pdfjs will be
// missing the runtime assets it fetches lazily: character maps, the
// standard-14 font programs, and the WASM image decoders. When they are
// absent, a render can stall indefinitely — the canvas is sized, painting
// stops partway, the render promise never settles and no error is raised.
// The documents that trip it are the ones this app exists to read:
// Courier-set transcripts (standard fonts) and scanned exhibits (JPEG2000
// and JBIG2, decoded in WASM).
//
// The files are served at /pdfjs/* by vite-pdfjs-assets.ts.

const BASE = `${import.meta.env.BASE_URL || '/'}pdfjs/`;

export const PDFJS_DOC_PARAMS = {
  cMapUrl: `${BASE}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${BASE}standard_fonts/`,
  wasmUrl: `${BASE}wasm/`,
  iccUrl: `${BASE}iccs/`,
} as const;

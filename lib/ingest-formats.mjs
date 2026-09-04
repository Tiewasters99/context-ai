// Ingestion formats, limits, and the vocabulary for "stored without text" —
// the one place every surface reads them from.
//
// This module has NO imports on purpose. lib/ingest-core.mjs re-exports the
// extension lists for the Node pipeline (api/ingest, the MCP file_document
// tool, the Fly worker), and the browser bundle imports this file directly
// (src/lib/vault-persist.ts) so the pre-upload checks in the Vault UI can
// never disagree with what the pipeline actually accepts. A .d.mts sibling
// carries the types for the TypeScript side.
//
// Phase 1 of the ingestion plan (2026-09-04): an upload must end in one of
// three honest states — searchable, stored with a reason, or failed with a
// cause — and the reason for "stored without text" is recorded on the row as
// documents.metadata.text_status using the TEXT_STATUS values below.

// -----------------------------------------------------------------------------
// Extensions
// -----------------------------------------------------------------------------

// Extensions the pipeline knows how to extract text from.
export const SUPPORTED_EXTENSIONS = [
  '.pdf', '.txt', '.md', '.docx', '.epub', '.fountain', '.xlsx', '.pptx',
  // Email: headers + decoded MIME body indexed; attachments listed by name
  // only (they usually exist in the vault as their own documents).
  '.eml',
  // Images: JPEG/PNG/TIFF are OCR'd through the injected `ocr` hook (a
  // scanned page saved as a .jpg — vFlat, phone camera — is a document and
  // must come out searchable). Other image formats store-and-display.
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.tif',
  // Audio / video: transcribed to a timestamped transcript via the injected
  // `transcribe` hook (Gemini). Without a hook they store-and-display.
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.aiff', '.wma',
  '.mp4', '.mov', '.mpg', '.mpeg', '.avi', '.webm', '.wmv', '.3gp', '.m4v',
];

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.tif'];

// The subset of image formats the OCR path can read. pdf-lib can embed only
// JPEG and PNG streams, and it does so losslessly, so those two route straight
// through the same `ocr` hook as scanned PDFs. TIFF joins them by way of a
// sharp transcode (see imageToPdf in ingest-core) because a Bates production
// arrives as thousands of .tif pages and a picture of a page is not a page.
export const OCRABLE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.tif', '.tiff'];

export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.aiff', '.wma'];
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mpg', '.mpeg', '.avi', '.webm', '.wmv', '.3gp', '.m4v'];
export const MEDIA_EXTENSIONS = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS];

// Plain-text-shaped formats the pipeline's UTF-8 fallback indexes as one big
// page. Not "supported" in the sense of a structured extractor, but they have
// always come out searchable and the live vault holds them (.csv, .html, .xml,
// .json, .ics as of the 2026-09-04 census), so the upload check must let them
// through.
export const PLAIN_TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm',
  '.log', '.yaml', '.yml', '.ics',
];

// 3D / CAD assets. Stored and displayed, never extracted: .obj is ASCII, so
// without this list it would sail past the binary sniff into the plain-text
// fallback and be embedded as half a million tokens of vertex coordinates
// (observed 2026-08: "Requested ~500000 tokens, max 300000"). The live vault
// holds 42 each of .obj/.fbx/.glb/.usdz from the Courtroom build.
export const BINARY_ASSET_EXTENSIONS = [
  '.obj', '.fbx', '.glb', '.gltf', '.stl', '.3ds', '.blend', '.usdz', '.dae', '.ply',
];

// Everything an upload may carry. .zip is accepted by the web Vault because it
// expands the archive in the browser and files each entry on its own; the
// entries are then checked individually against this same list.
export const ACCEPTED_EXTENSIONS = [
  ...new Set([...SUPPORTED_EXTENSIONS, ...PLAIN_TEXT_EXTENSIONS, ...BINARY_ASSET_EXTENSIONS, '.zip']),
];

// -----------------------------------------------------------------------------
// Limits
// -----------------------------------------------------------------------------

// The vault-documents bucket's file_size_limit, as set in Supabase. Storage
// refuses anything larger AFTER the bytes have been sent, with an error the
// old UI turned into a spinner; the Vault and file_document check this BEFORE
// moving bytes. Keep the two in step: scripts/_set-bucket-cap.mjs changes the
// bucket, then change this. Live cap confirmed 500 MB on 2026-09-04 (the
// 2 GB raise that script describes never took, or was reverted).
export const VAULT_MAX_BYTES = 500 * 1024 * 1024;

// -----------------------------------------------------------------------------
// "Stored without text" — the recorded reason (documents.metadata.text_status)
// -----------------------------------------------------------------------------

export const TEXT_STATUS = Object.freeze({
  IMAGE_ONLY: 'image_only',                 // OCR ran (or could not run) and found no words
  NO_TEXT: 'no_text',                       // a text-bearing format that held no text
  PORTFOLIO: 'portfolio',                   // a PDF wrapper whose attachments were filed as children
  MEDIA_NO_TRANSCRIPT: 'media_no_transcript', // audio/video kept without a transcript
  BINARY_STORED: 'binary_stored',           // a known non-text asset (3D/CAD)
  UNSUPPORTED: 'unsupported',               // unrecognized format, kept as-is
});

const TEXT_STATUS_TEXT = {
  image_only: {
    label: 'Image only — no readable text',
    detail: 'OCR found no words on it. The file is stored and viewable, but nothing in it can be searched.',
  },
  no_text: {
    label: 'No text found',
    detail: 'The file opened but held no text to index. It is stored and viewable.',
  },
  portfolio: {
    label: 'Portfolio wrapper',
    detail: 'A PDF that packages other files. Its attachments were filed as their own documents; this cover is kept for reference.',
  },
  media_no_transcript: {
    label: 'Stored without a transcript',
    detail: 'The recording is kept as-is; transcription was not configured for it.',
  },
  binary_stored: {
    label: '3D / design asset — stored',
    detail: 'Kept to open or download. This format carries no text to index.',
  },
  unsupported: {
    label: 'Unrecognized format — stored as-is',
    detail: 'Kept to download. Its contents could not be read as text.',
  },
};

// Plain-language label + detail for a text_status value. Unknown values get a
// generic line rather than nothing, so a future status never renders blank.
export function describeTextStatus(status) {
  return TEXT_STATUS_TEXT[status] || {
    label: 'Stored without text',
    detail: `The file is stored and viewable; recorded reason: ${status || 'unknown'}.`,
  };
}

// -----------------------------------------------------------------------------
// Pre-upload checks (pure — no I/O). The duplicate check needs the database
// and lives beside each caller (vault-persist.ts, mcp-core.mjs).
// -----------------------------------------------------------------------------

export function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  // "no extension" and a trailing dot both count as none; a dot inside a
  // directory-ish name ("v2.final") would be mis-read either way.
  return i <= 0 || i === s.length - 1 ? '' : s.slice(i).toLowerCase();
}

export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

// The supported list as a person would read it, for refusal messages.
export const SUPPORTED_TYPES_SUMMARY =
  'PDF, Word (.docx), text (.txt, .md, .csv, .html), spreadsheets (.xlsx), ' +
  'slides (.pptx), email (.eml), e-books (.epub), images (JPG, PNG, TIFF, GIF), ' +
  'audio and video, 3D assets (.obj, .glb, .fbx), and .zip archives of those';

// Returns null when the file may be uploaded, else { code, message } with a
// message written for the person who chose the file. `code` is 'too_large'
// or 'unsupported'. A file with no extension at all is allowed through: the
// pipeline sniffs its magic bytes (email attachments often arrive that way).
export function checkUpload({ name, size }) {
  const cap = VAULT_MAX_BYTES;
  const bytes = Number(size) || 0;
  if (bytes > cap) {
    return {
      code: 'too_large',
      message: `"${name}" is ${formatBytes(bytes)}; the Vault accepts files up to ${formatBytes(cap)}. ` +
        'Split it (or compress it) and try again.',
    };
  }
  const ext = extOf(name);
  if (ext && !ACCEPTED_EXTENSIONS.includes(ext)) {
    const hint = ext === '.doc' ? ' Save the legacy Word file as .docx and upload that.'
      : ext === '.pages' || ext === '.numbers' || ext === '.key' ? ' Export it as PDF or .docx and upload that.'
      : '';
    return {
      code: 'unsupported',
      message: `"${name}" is a ${ext} file, which the Vault can't read.${hint} ` +
        `Supported: ${SUPPORTED_TYPES_SUMMARY}.`,
    };
  }
  return null;
}

// Shared ingestion pipeline.
//
// One canonical implementation of: extract → chunk → embed → insert passages.
// Used by:
//   - scripts/ingest.mjs (local CLI, service-role auth)
//   - api/ingest.mjs     (web app, user-scoped session auth)
//
// The pipeline takes an existing documents row (already inserted with the
// file uploaded to vault-documents storage) and walks it through
// processing_status: extracting → chunking → embedding → ready.
// Status updates persist after every phase so the UI can poll progress.

// pdfjs-dist is dynamic-imported inside extractPdfPages — its top-level
// evaluation references DOMMatrix and crashes Vercel serverless at module
// load. Lazy import keeps non-PDF ingestion (txt/md/docx) working there.

import { getEmbedLimiter } from './rate-limit.mjs';
import { SealedPipeError, matterSeal } from './seal-pipes.mjs';
import { ROUTES, resolveRoute } from './embed-routes.mjs';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1024;
export const EMBEDDING_BATCH = 96;
export const MAX_PASSAGE_WORDS = 500;

// Token ceilings for the embeddings API. text-embedding-3-small rejects any
// single input over 8192 tokens, and rejects a request whose inputs total over
// 300000 tokens. We batch under both.
//
// 4 chars/token is a fair *average* for English prose. It is a bad worst case,
// and the hard caps are exactly where the worst case bites: OCR garble, tables,
// citation-dense legal text and long unbroken identifiers all tokenize nearer
// 2-3 chars/token. Estimating on the average therefore re-uses the very
// assumption that overflows.
//
// Per-input: truncating at MAX_INPUT_TOKENS * 4 400'd again, deterministically,
// on 593 documents (2026-08-02).
//
// Per-request: the same optimism, one level up. A batch estimated at 250k
// tokens of minified JavaScript or RTF control words is really ~400-660k, so
// the API returned `maximum request size is 300000 tokens per request` — and
// because parseOversizedInput() only ever matched the *per-input* wording,
// embedBatch threw instead of splitting. Two documents then failed 1,641 times
// each between 2026-08-02 and the 08-22 audit. Estimate pessimistically here
// too, and leave headroom: at 2.5 chars/token a 120k-token batch is at most
// ~300k real tokens even if every character were a token boundary edge case.
const WORST_CASE_CHARS_PER_TOKEN = 2.5;
export const MAX_INPUT_TOKENS = 8000;          // per single passage
export const MAX_REQUEST_TOKENS = 120000;      // per embeddings request
const estimateTokens = (s) => Math.ceil((s || '').length / WORST_CASE_CHARS_PER_TOKEN);

// embedBatch still re-truncates on a 400, so this only has to be close, not
// perfect.
export const MAX_INPUT_CHARS = Math.floor(MAX_INPUT_TOKENS * WORST_CASE_CHARS_PER_TOKEN);

// Strip bytes Postgres / JSON reject so a doc that extracts fine doesn't die at
// insert. The "unsupported Unicode escape sequence" error is specifically
// U+0000 (NUL) embedded in extracted text; we also drop other C0/C1 control
// chars (except tab/newline/CR), lone surrogates, and the U+FFFE/U+FFFF
// non-characters. These carry no readable signal — they're scanner/encoding
// artifacts — so removing them is lossless for search.
export function sanitizeText(s) {
  if (!s) return '';
  // Char-by-char filter (no control chars / escapes in source). Passages are
  // <=500 words, so the loop is cheap. Keeps tab/newline/CR; drops the rest of
  // the C0 (0-31) and C1 (127-159) control ranges, lone UTF-16 surrogates,
  // and the U+FFFE/U+FFFF non-characters.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) continue;
    if (c >= 127 && c <= 159) continue;
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (c === 0xfffe || c === 0xffff) continue;
    out += s[i];
  }
  return out;
}

// Extension lists, the storage cap, and the "stored without text" vocabulary
// live in lib/ingest-formats.mjs (dependency-free, shared with the browser).
// Re-exported here so every existing import from ingest-core keeps working.
import {
  SUPPORTED_EXTENSIONS,
  IMAGE_EXTENSIONS,
  OCRABLE_IMAGE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  BINARY_ASSET_EXTENSIONS,
  TEXT_STATUS,
  describeOcrPending,
  ocrRetryDelayMs,
  OCR_RETRY_DELAYS_MS,
} from './ingest-formats.mjs';
export {
  SUPPORTED_EXTENSIONS,
  IMAGE_EXTENSIONS,
  OCRABLE_IMAGE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  BINARY_ASSET_EXTENSIONS,
  PLAIN_TEXT_EXTENSIONS,
  ACCEPTED_EXTENSIONS,
  VAULT_MAX_BYTES,
  TEXT_STATUS,
  describeTextStatus,
  describeOcrPending,
  ocrRetryDelayMs,
  OCR_RETRY_DELAYS_MS,
  checkUpload,
  extOf,
} from './ingest-formats.mjs';

// Routing rule shared by every ingestion entry point (/api/ingest, MCP
// file_document): files a 60s serverless function cannot finish go to the
// always-on worker via the processing_jobs queue. One definition so the
// thresholds can't drift between surfaces.
//
// TIFF is routed by extension rather than by size, unlike everything else here.
// Two reasons, and the second is the real one:
//
//   * A multi-page TIFF is a whole scanned document in one file. Size is a poor
//     proxy — a 400 KB Group-4 fax-compressed .tif can hold sixty pages, which
//     is sixty OCR round trips, nowhere near a 60s budget.
//   * Transcoding TIFF needs sharp, a native libvips binding. The worker image
//     installs it (`npm ci --omit=dev`) and already runs it for Discovery
//     normalization, so it is proven there. No Vercel function has ever loaded
//     sharp. Making TIFF upload the first thing that does would put an unproven
//     native module in the path of a live production upload.
//
// The cost is queue latency on a small single-page TIFF that serverless could
// have handled inline. That is the right trade for a format that arrives in
// Bates productions of five thousand.
export function needsWorkerIngest(ext, sizeBytes) {
  const MB = 1024 * 1024;
  const size = sizeBytes || 0;
  return ext === '.wma' ||                                  // ffmpeg transcode — serverless has no ffmpeg
    ext === '.zip' ||                                       // unpacked at ingest: N uploads + N jobs (Phase 3)
    (MEDIA_EXTENSIONS.includes(ext) && size > 12 * MB) ||   // long recordings
    (ext === '.pdf' && size > 10 * MB) ||                   // big scans → OCR too slow inline
    ext === '.tif' || ext === '.tiff' ||                    // sharp transcode + OCR — see above
    size > 20 * MB;                                         // anything huge
}

// The second half of the routing rule, for PDFs under the size threshold: a
// small PDF that needs OCR on ANY page also goes to the worker. Size said
// nothing about this — a 2 MB, forty-page scan is sixty seconds of Gemini
// round trips, and one slow window (the client retries 429/5xx with backoff
// up to 30 s a time) is enough to have the serverless function killed
// mid-OCR and the document stranded in 'extracting' until the recovery sweep
// found it. Since 2026-09-04 (Phase 2) the inline callers extract the text
// layer first — pdf-parse on a 10 MB file is a second or two — and enqueue
// when this says any page is waiting on OCR. A born-digital PDF keeps the
// fast inline path; nothing about it changes.
//
// Returns { pageCount, ocrPages } — ocrPages is the 1-based list of pages
// that would be OCR'd (see pagesNeedingOcr). A PDF that cannot be parsed
// returns ocrPages: [] with `error` set, so the caller runs the pipeline
// inline and lets processDocument fail with its usual cause.
export async function planPdfOcr(fileBuf) {
  try {
    const pages = await extractPdfPages(fileBuf);
    const ocrPages = await pagesNeedingOcr(fileBuf, pages);
    return { pageCount: pages.length, ocrPages };
  } catch (err) {
    return { pageCount: 0, ocrPages: [], error: err?.message || String(err) };
  }
}

// Queue priority, as written to processing_jobs.priority (migration 057).
// Higher claims sooner; among equals, oldest first. The interactive paths —
// the web Vault, MCP file_document, /api/ingest — never set this and get
// NORMAL; the queue's own insert trigger demotes a mass upload to BULK after
// ten queued jobs in one matter. Scripts that KNOW they are bulk say so from
// the first job, so even their first ten never jump a stranger's single
// upload. URGENT is reserved for the service role: an authenticated caller
// asking for more than NORMAL is clamped back to NORMAL by the trigger.
export const JOB_PRIORITY = Object.freeze({ URGENT: 10, NORMAL: 0, BULK: -10 });

// Content sniffing for files whose extension is missing or unrecognized —
// common with email attachments saved without one (a JPEG named
// "Outlook-County Att" crashed the text pipeline as UTF-8 garbage). Magic
// bytes are authoritative where the filename isn't. Deliberately small: only
// formats whose downstream handling we trust.
export function sniffExtension(buf) {
  const b = buf instanceof Uint8Array ? Buffer.from(buf) : buf;
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  if (b.slice(0, 4).toString('latin1') === 'GIF8') return '.gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return '.bmp';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return '.tif';
  if (b.slice(0, 4).toString('latin1') === '%PDF') return '.pdf';
  if (b.slice(4, 8).toString('latin1') === 'ftyp') {
    // ISO base media: M4A audio vs MP4/MOV video by brand.
    const brand = b.slice(8, 12).toString('latin1');
    return brand.startsWith('M4A') ? '.m4a' : '.mp4';
  }
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return '.mp3'; // ID3 tag
  // PK: a zip archive (Phase 3). Only reached for an unknown extension —
  // .docx/.xlsx/.pptx/.epub are zips too but are supported by name and never
  // sniffed — and the archive branch checks for an Office package inside
  // before unpacking, so a Word file with no extension still reads as Word.
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return '.zip';
  return null;
}


// -----------------------------------------------------------------------------
// Top-level pipeline
//
// Inputs:
//   supabase    — a Supabase client (any auth scope; RLS is what enforces access)
//   options:
//     documentId    — UUID of the documents row to process
//     fileBuf       — Buffer or Uint8Array containing the file contents
//     ext           — file extension, e.g. '.pdf'
//     witnessName?  — passed through to chunking (for transcript pages)
//     openaiApiKey  — required for embedding calls
//     onProgress?   — optional callback ({ stage, message }) for progress events
//
// Returns: { passageCount }
// Throws on any failure; caller is responsible for marking the document
// as 'error' if they want that — this function only updates status forward.
// -----------------------------------------------------------------------------
export async function processDocument(supabase, options) {
  const {
    documentId,
    fileBuf,
    ext,
    witnessName = null,
    openaiApiKey,
    onProgress = () => {},
    // Optional OCR fallback for scanned, image-only PDFs (no text layer). When
    // provided and a PDF extracts to ~no text, we call this instead of failing
    // with "no passages extracted". Signature: (fileBuf) => [{pageNumber,text}].
    // Kept injectable so ingest-core stays provider-agnostic (the Gemini impl
    // lives in lib/ocr-gemini.mjs and is wired by the caller).
    ocr = null,
    // Optional transcription hook for audio/video. When provided and the file
    // is an A/V type, we transcribe it to a timestamped transcript instead of
    // store-and-display. Signature: (fileBuf, { mimeType, kind, onProgress }) =>
    // [{pageNumber,text}]. The Gemini impl lives in lib/transcribe-gemini.mjs
    // and is wired by the caller, keeping ingest-core provider-agnostic.
    transcribe = null,
  } = options;
  if (!documentId) throw new Error('processDocument: documentId required');
  if (!fileBuf) throw new Error('processDocument: fileBuf required');
  if (!openaiApiKey) throw new Error('processDocument: openaiApiKey required');

  // Look up the doc to get matterspace_id (needed for passages.matterspace_id).
  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .select('id, matterspace_id, witness_name, metadata')
    .eq('id', documentId)
    .single();
  if (docErr) throw new Error(`processDocument lookup: ${docErr.message}`);
  // Handed to the success path so it can drop a stale text_status without a
  // second read on every indexed document (the common case).
  const priorMetadata = doc.metadata || null;

  const matterspace_id = doc.matterspace_id;
  const effectiveWitness = witnessName || doc.witness_name || null;
  let lowerExt = (ext || '').toLowerCase();

  // The SecureSpace seal on the ingest pipes (lib/seal-pipes.mjs). Resolved
  // once here and consulted at each of the three points below that would
  // otherwise put this matter's content on the wire: OCR, transcription, and
  // embeddings. Extraction and chunking are local and run either way, so a
  // sealed matter's text documents still come out searchable — see
  // embedAndInsert's text-only branch.
  const seal = await matterSeal(supabase, matterspace_id);
  const refusePipe = (pipe) => {
    throw new SealedPipeError(pipe, { tier: seal.tier, matterName: seal.name });
  };

  // Unknown or missing extension: trust the file's magic bytes instead of
  // shoving unidentified binary through text extraction.
  if (!SUPPORTED_EXTENSIONS.includes(lowerExt)) {
    const sniffed = sniffExtension(fileBuf);
    if (sniffed) {
      onProgress({ stage: 'extracting', message: `Detected ${sniffed} content by signature` });
      lowerExt = sniffed;
    }
  } else if (lowerExt === '.docx') {
    // Misnamed files happen (a PDF saved with a .docx name). A real .docx is
    // a ZIP (PK\x03\x04); when the magic bytes disagree, trust them.
    const b = fileBuf instanceof Uint8Array ? Buffer.from(fileBuf) : fileBuf;
    if (!(b[0] === 0x50 && b[1] === 0x4b)) {
      const sniffed = sniffExtension(b);
      if (sniffed) {
        onProgress({ stage: 'extracting', message: `File is ${sniffed}, not .docx — extracting by content` });
        lowerExt = sniffed;
      }
    }
  }

  // 3D / CAD assets: stored to open or download, never extracted. Decided by
  // extension BEFORE the image, media and binary checks because .obj is
  // ASCII — it passes looksBinary() and would otherwise be embedded as a few
  // hundred thousand tokens of vertex coordinates.
  if (BINARY_ASSET_EXTENSIONS.includes(lowerExt)) {
    return await markStoredWithoutText(supabase, documentId, TEXT_STATUS.BINARY_STORED, {
      onProgress, message: `${lowerExt} asset stored (no text to index)`,
    });
  }

  // .zip archives (Phase 3, 2026-09-04): a container, like a PDF portfolio.
  // Each entry is filed as its own document in a folder named after the
  // archive and queued for this same pipeline; the archive is moved into the
  // folder and stored with the reason. The web Vault expands archives in the
  // browser and never sends one here; this is the path for the MCP tool, the
  // Discovery intake, a re-run, and the 33 archives filed as blobs before it
  // existed. An Office package that arrived without an extension is a zip
  // too — it is routed to its own extractor instead of being unpacked.
  if (lowerExt === '.zip') {
    const { listZipEntries } = await import('./zip-container.mjs');
    await setStatus(supabase, documentId, 'extracting');
    onProgress({ stage: 'extracting', message: 'Archive — reading its entries' });
    let listing;
    try {
      listing = await listZipEntries(fileBuf);
    } catch (err) {
      const reason = `Archive could not be opened (${firstLine(err.message)}). Re-zip the files and upload again, or file them one at a time.`;
      await supabase.from('documents')
        .update({ processing_status: 'error', processing_error: reason })
        .eq('id', documentId);
      throw new Error(reason);
    }
    if (listing.ooxml) {
      onProgress({ stage: 'extracting', message: `File is ${listing.ooxml}, not an archive — extracting by content` });
      lowerExt = listing.ooxml;
    } else {
      const { unpackContainer, containerSummary } = await import('./container-unpack.mjs');
      const { data: parentRow, error: parentErr } = await supabase
        .from('documents')
        .select('id, matterspace_id, title, source_filename, created_by, doc_type, storage_path, metadata')
        .eq('id', documentId)
        .single();
      if (parentErr) throw new Error(`archive: load row: ${parentErr.message}`);
      let summary;
      if (!listing.entries.length) {
        summary = {
          unpacked_at: new Date().toISOString(), entry_count: 0, folder_id: null, folder_name: null, children: [],
          ...(listing.skipped.length ? { skipped: listing.skipped } : {}),
        };
      } else {
        onProgress({ stage: 'extracting', message: `Archive — filing ${listing.entries.length} file(s)` + (listing.skipped.length ? ` (${listing.skipped.length} skipped)` : '') });
        const result = await unpackContainer(supabase, {
          parent: parentRow, kind: 'zip', entries: listing.entries, folder: true, onProgress,
          describe: `the archive "${parentRow.source_filename || parentRow.title || 'archive'}"`,
        });
        summary = containerSummary(result, { count: listing.entries.length, skipped: listing.skipped });
        if (listing.truncated) summary.truncated = true;
      }
      const stored = await markStoredWithoutText(supabase, documentId, TEXT_STATUS.ARCHIVE, {
        onProgress, metadata: { archive: summary },
        message: summary.children.length
          ? `Archive unpacked: ${summary.children.length} document(s) queued` + (summary.folder_name ? ` in "${summary.folder_name}"` : '') +
            (listing.skipped.length ? `; ${listing.skipped.length} entr${listing.skipped.length === 1 ? 'y' : 'ies'} skipped` : '')
          : `Archive stored — nothing to file (${listing.skipped.length ? listing.skipped.map((s) => s.reason).slice(0, 3).join(', ') : 'empty'})`,
      });
      return { ...stored, archive: summary };
    }
  }

  // Images: OCR when possible, store-and-display otherwise. A scanned page
  // saved as a JPG (vFlat, phone camera) is a document, not a picture — it
  // must come out searchable like any scanned PDF. We wrap the bytes in a PDF
  // (lossless: pdf-lib embeds the JPEG/PNG stream as-is) and
  // run the same injected `ocr` hook as scanned PDFs, so OCR behavior can't
  // drift between the two paths. TIFF joins them by way of a sharp transcode
  // (see imageToPdf). The formats still left out (.gif/.webp/.svg/.bmp),
  // callers with no OCR hook, and images OCR finds no legible text in (photos,
  // logos) all keep store-and-display behavior.
  if (IMAGE_EXTENSIONS.includes(lowerExt)) {
    // Sealed: a scanned page can only be read by sending the image out, and
    // there is no local OCR. Refuse rather than quietly filing it as a picture
    // — a scanned exhibit that silently becomes unsearchable is the failure
    // this whole module exists to stop. Formats we never OCR anyway (.gif,
    // .svg, a photo) fall through to store-and-display exactly as before:
    // nothing was going to leave for those.
    if (seal.sealed && typeof ocr === 'function' && OCRABLE_IMAGE_EXTENSIONS.includes(lowerExt)) {
      refusePipe('ocr');
    }
    if (typeof ocr === 'function' && OCRABLE_IMAGE_EXTENSIONS.includes(lowerExt)) {
      await setStatus(supabase, documentId, 'extracting');
      onProgress({ stage: 'extracting', message: 'Scanned image — running OCR' });
      let pages = null;
      let asPdf = null;
      try {
        asPdf = await imageToPdf(fileBuf, lowerExt);
      } catch (err) {
        // Undecodable/corrupt image: there is nothing OCR could read. Store
        // and display it — a retry would decode it identically.
        onProgress({ stage: 'extracting', message: `Image could not be decoded (${err.message}) — storing as image` });
      }
      if (asPdf) {
        try {
          pages = await ocr(asPdf);
        } catch (err) {
          // The OCR provider failed, not the file. Until 2026-09-04 this fell
          // through to image_only — "OCR found no words" — which was untrue
          // and permanent: a scan uploaded during an outage stayed unsearchable
          // for good. Record it as awaiting OCR instead; the worker's sweep
          // retries on the schedule in ingest-formats.
          const pending = buildOcrPending(priorMetadata, { pages: null, pageCount: null, reason: err.message });
          return await markStoredWithoutText(supabase, documentId, TEXT_STATUS.OCR_PENDING, {
            onProgress,
            metadata: { ocr_pending: pending },
            message: `Image stored — OCR failed (${firstLine(err.message)}); ${retryWording(pending)}`,
          });
        }
      }
      const ocrChars = (pages || []).reduce((s, p) => s + (p.text || '').trim().length, 0);
      if (ocrChars >= 40) {
        await supabase
          .from('documents')
          .update({
            // Was hardcoded to 1, which was true while only single-page JPEG
            // and PNG got here. A multi-page TIFF returns one entry per page
            // and its passages carry those page numbers, so a page_count of 1
            // would contradict its own citations.
            page_count: Math.max(pages.length, 1),
            processing_status: 'chunking',
          })
          .eq('id', documentId);
        onProgress({ stage: 'chunking', message: 'Chunking OCR text' });
        const passages = chunkPages(pages, { witness_name: effectiveWitness });
        return await embedAndInsert(supabase, {
          documentId, matterspace_id, passages, openaiApiKey, onProgress, seal, priorMetadata,
        });
      }
    }
    return await markStoredWithoutText(supabase, documentId, TEXT_STATUS.IMAGE_ONLY, {
      onProgress,
      message: OCRABLE_IMAGE_EXTENSIONS.includes(lowerExt) && typeof ocr === 'function'
        ? 'Image stored — OCR found no readable text'
        : 'Image stored (this format is not OCR\'d)',
    });
  }

  // Audio / video: transcribe with the injected hook (Gemini). Without a hook,
  // store-and-display like images — the file stays viewable in the Vault and,
  // crucially, does NOT get shoved through text extraction (which would read the
  // binary as UTF-8 garbage and blow the embeddings token limit).
  if (MEDIA_EXTENSIONS.includes(lowerExt)) {
    // Sealed: transcription means uploading the recording. Held, not stored-
    // and-forgotten — a deposition recording that looks "ready" with no
    // transcript behind it is worse than one that says why it has none.
    if (seal.sealed && typeof transcribe === 'function') refusePipe('transcription');
    if (typeof transcribe !== 'function') {
      return await markStoredWithoutText(supabase, documentId, TEXT_STATUS.MEDIA_NO_TRANSCRIPT, {
        onProgress, message: 'Media stored (no transcription configured)',
      });
    }
    await setStatus(supabase, documentId, 'extracting');
    const kind = VIDEO_EXTENSIONS.includes(lowerExt) ? 'video' : 'audio';
    onProgress({ stage: 'extracting', message: `Transcribing ${kind}` });
    const segs = await transcribe(fileBuf, { ext: lowerExt, kind, onProgress });
    const pageCount = Math.max(1, (segs || []).length);
    await supabase
      .from('documents')
      .update({ page_count: pageCount, processing_status: 'chunking' })
      .eq('id', documentId);
    onProgress({ stage: 'chunking', message: 'Chunking transcript' });
    const passages = chunkPages(segs || [], { witness_name: effectiveWitness });
    return await embedAndInsert(supabase, {
      documentId, matterspace_id, passages, openaiApiKey, onProgress, seal, priorMetadata,
    });
  }

  // Everything from here down either has a structured extractor or takes the
  // plain-text fallback. A file heading for that fallback with binary content
  // (3D assets, archives, unknown proprietary formats) must NOT be read as
  // UTF-8 — store-and-display like images/media instead of erroring.
  const STRUCTURED_EXTS = ['.pdf', '.docx', '.xlsx', '.pptx', '.eml', '.epub', '.fountain'];
  if (!STRUCTURED_EXTS.includes(lowerExt) && looksBinary(fileBuf)) {
    return await markStoredWithoutText(supabase, documentId, TEXT_STATUS.UNSUPPORTED, {
      onProgress, message: 'Binary file stored (no text extraction for this format)',
    });
  }

  // -- Extract -------------------------------------------------------------
  await setStatus(supabase, documentId, 'extracting');
  onProgress({ stage: 'extracting', message: 'Extracting text' });

  let passages;
  let pageCount;
  // Metadata a format path wants written on the row when it goes ready — an
  // email's filed attachments (Phase 3). Merged by embedAndInsert beside the
  // passages, so it survives the same update that clears a stale reason.
  let metadataPatch = null;
  if (lowerExt === '.epub') {
    // EPUB path: chapters carry their own structure; we don't pretend
    // they're pages. Metadata flows back to the documents row so MCP
    // can cite the book by author/title without re-reading the file.
    const { extractEpub } = await import('./epub-extract.mjs');
    const epub = await extractEpub(fileBuf);
    if (epub.drm) {
      await supabase
        .from('documents')
        .update({
          processing_status: 'error',
          processing_error: 'EPUB is DRM-protected; cannot extract text.',
        })
        .eq('id', documentId);
      throw new Error('EPUB is DRM-protected');
    }
    const meta = epub.metadata || {};
    const docUpdates = { processing_status: 'chunking' };
    if (meta.title)     docUpdates.title = meta.title;
    if (meta.author)    docUpdates.author = meta.author;
    if (meta.publisher) docUpdates.publisher = meta.publisher;
    pageCount = (epub.chapters || []).length;
    docUpdates.page_count = pageCount;
    await supabase.from('documents').update(docUpdates).eq('id', documentId);
    onProgress({
      stage: 'chunking',
      message: `Chunking ${pageCount} chapter(s)`,
    });
    passages = chunkBook(epub);
  } else if (lowerExt === '.fountain') {
    // Fountain path: plain-text screenplay. Use the Fountain parser to
    // emit structured passages (scene headings, action, character
    // dialogue with speaker, parentheticals, transitions) so search /
    // grep / get_outline work on screenplay structure rather than
    // arbitrary paragraph chunks.
    const buf = fileBuf instanceof Uint8Array ? Buffer.from(fileBuf) : fileBuf;
    const fountainText = buf.toString('utf8');
    pageCount = Math.max(1, Math.ceil(fountainText.split('\n').length / 55));
    await supabase
      .from('documents')
      .update({ page_count: pageCount, processing_status: 'chunking' })
      .eq('id', documentId);
    onProgress({ stage: 'chunking', message: 'Parsing screenplay structure' });
    passages = await chunkFountain(fountainText);
  } else {
    // PDF portfolios (a cover sheet wrapping embedded files — the Fifth
    // Circuit's E-Record is one) are containers, not documents: read as a
    // PDF they are "one page, 63 characters", which the scan test below
    // would have OCR'd into a searchable copy of one sentence. File each
    // attachment as its own document, queued for this same pipeline, in a
    // folder named after the wrapper; the wrapper itself is stored as-is.
    //
    // Detection runs twice at most: a byte-marker fast path before text
    // extraction (catches uncompressed producers like the AO's iText without
    // parsing), and a real pdf.js check afterwards for any PDF whose page
    // tree came out at two pages or fewer — producers that write object
    // streams (pdf-lib, most modern tools) hide the markers, and a cover
    // sheet is what a portfolio looks like once extracted.
    let portfolioChecked = false;
    const asPortfolio = async (force) => {
      if (lowerExt !== '.pdf' || portfolioChecked) return null;
      const { detectPdfPortfolio, mightBePortfolio } = await import('./pdf-portfolio.mjs');
      if (!force && !mightBePortfolio(fileBuf)) return null;
      portfolioChecked = true;
      try {
        return await detectPdfPortfolio(fileBuf, { force: true });
      } catch (err) {
        onProgress({ stage: 'extracting', message: `Portfolio check skipped (${err.message})` });
        return null;
      }
    };
    const finishAsPortfolio = async (portfolio) => {
      const { unpackPortfolio } = await import('./pdf-portfolio.mjs');
      onProgress({
        stage: 'extracting',
        message: `PDF portfolio — unpacking ${portfolio.attachments.length} attached file(s)`,
      });
      const { data: parentRow, error: parentErr } = await supabase
        .from('documents')
        .select('id, matterspace_id, title, source_filename, created_by, doc_type, storage_path, metadata')
        .eq('id', documentId)
        .single();
      if (parentErr) throw new Error(`portfolio: load wrapper row: ${parentErr.message}`);
      const result = await unpackPortfolio(supabase, {
        parent: parentRow,
        attachments: portfolio.attachments,
        onProgress,
      });
      const summary = {
        unpacked_at: new Date().toISOString(),
        attachment_count: portfolio.attachments.length,
        folder_id: result.folder?.id ?? null,
        folder_name: result.folder?.name ?? null,
        children: result.children.map((c) => ({ id: c.id, title: c.title })),
        ...(result.notes.length ? { notes: result.notes } : {}),
      };
      // The wrapper is a stored-without-text document like any other; the
      // shared exit records the reason and merges the portfolio summary in.
      const stored = await markStoredWithoutText(supabase, documentId, TEXT_STATUS.PORTFOLIO, {
        pageCount: portfolio.pageCount,
        metadata: { portfolio: summary },
        onProgress,
        message: `Portfolio unpacked: ${result.children.length} document(s) queued` +
          (result.folder ? ` in "${result.folder.name}"` : ''),
      });
      return { ...stored, portfolio: summary };
    };

    const earlyPortfolio = await asPortfolio(false);
    if (earlyPortfolio) return await finishAsPortfolio(earlyPortfolio);

    let pages = await extractPages(fileBuf, lowerExt);

    if (pages.length <= 2) {
      const latePortfolio = await asPortfolio(true);
      if (latePortfolio) return await finishAsPortfolio(latePortfolio);
    }

    // Email attachments (Phase 3, 2026-09-04): the message is indexed as
    // before — headers and body, attachments named in the text — and every
    // real attachment is now filed as its own document beside the email,
    // queued for this pipeline, with the email's row recording which. No
    // folder: an email with one disclosure attached should not become a
    // folder, and a production of five hundred emails must not become five
    // hundred. Inline images (a signature logo) are not attachments. A
    // failure here must not cost the email its text: it is noted and the
    // message goes on to be indexed.
    if (lowerExt === '.eml') {
      try {
        const { extractEmlAttachments } = await import('./eml-attachments.mjs');
        const { attachments, skipped } = await extractEmlAttachments(fileBuf);
        if (attachments.length) {
          const { unpackContainer, containerSummary } = await import('./container-unpack.mjs');
          const { data: parentRow, error: parentErr } = await supabase
            .from('documents')
            .select('id, matterspace_id, title, source_filename, created_by, doc_type, storage_path, metadata')
            .eq('id', documentId)
            .single();
          if (parentErr) throw new Error(`load row: ${parentErr.message}`);
          onProgress({ stage: 'extracting', message: `Email — filing ${attachments.length} attachment(s) beside it` });
          const result = await unpackContainer(supabase, {
            parent: parentRow, kind: 'eml', entries: attachments, folder: false, onProgress,
          });
          metadataPatch = { email_attachments: containerSummary(result, { count: attachments.length, skipped }) };
        }
      } catch (err) {
        onProgress({ stage: 'extracting', message: `Attachments not filed (${firstLine(err.message)}) — indexing the message` });
        metadataPatch = { email_attachments: { unpacked_at: new Date().toISOString(), entry_count: 0, children: [], notes: [`attachments not filed: ${firstLine(err.message).slice(0, 200)}`] } };
      }
    }

    // Scanned pages, page by page (Phase 2, 2026-09-04). A born-digital page
    // yields thousands of characters from pdf-parse; a scanned one yields
    // ~nothing — EXCEPT the CM/ECF header stamp, which the court's filing
    // system overlays as real digital text (~100 chars/page) on top of the
    // scanned image. "Found some text" is therefore NOT "readable page": a
    // scanned verdict form was ingested as stamp-lines only (2026-08-10).
    //
    // Until Phase 2 the test was document-wide (average under ~200 chars a
    // page → OCR everything, else OCR nothing), so a 100-page brief with three
    // scanned exhibit pages indexed the brief and silently lost the exhibits.
    // Now each page under the threshold is OCR'd on its own — only those pages
    // leave the machine, and the born-digital pages keep their exact text —
    // and the results are merged back by page number, so citations still land
    // on the right page. pagesNeedingOcr decides which pages; see it for the
    // slip-sheet rule that keeps an exhibit tab from routing a brief to OCR.
    //
    // And OCR failing is no longer the document failing: the text pages are
    // indexed now, the scanned pages are recorded as awaiting OCR with the
    // reason (metadata.ocr_pending), and the worker retries them on a
    // schedule. A document whose every page is waiting is stored the same
    // way, with text_status 'ocr_pending', so nothing spins and nothing lies.
    const extractedChars = pages.reduce((s, p) => s + (p.text || '').trim().length, 0);
    let pendingOcr = null;
    if (lowerExt === '.pdf') {
      const ocrTargets = await pagesNeedingOcr(fileBuf, pages);
      if (ocrTargets.length) {
        const wholeDoc = ocrTargets.length === pages.length;
        // Nothing indexable without OCR: the old whole-document decisions
        // still apply — the seal refuses (held), a missing hook is a
        // configuration failure with the fix named (triage: ocr_needed).
        if (extractedChars < 40 && seal.sealed && typeof ocr === 'function') refusePipe('ocr');
        if (extractedChars < 40 && typeof ocr !== 'function') {
          const reason = `Scanned PDF — OCR not configured (${pages.length} page(s), ${extractedChars} chars of text). ` +
            'Set GOOGLE_API_KEY where this ingest runs, then Retry.';
          await supabase
            .from('documents')
            .update({ processing_status: 'error', processing_error: reason, page_count: pages.length })
            .eq('id', documentId);
          throw new Error(reason);
        }

        if (seal.sealed && typeof ocr === 'function') {
          // Mixed document in a SecureSpace: the typed pages are read locally
          // and indexed; the scanned pages would have to leave, so they are
          // recorded as not read, and never retried by the sweep — the answer
          // is the same until a sealed OCR route exists (plan: Textract, P4).
          pendingOcr = buildOcrPending(priorMetadata, {
            pages: ocrTargets, pageCount: pages.length, held: true,
            reason: `SecureSpace seal — ${ocrTargets.length} scanned page(s) were not sent out for OCR.`,
          });
          onProgress({ stage: 'extracting', message: `Sealed matter — ${ocrTargets.length} scanned page(s) left unread; indexing the ${pages.length - ocrTargets.length} typed page(s)` });
        } else if (typeof ocr !== 'function') {
          pendingOcr = buildOcrPending(priorMetadata, {
            pages: ocrTargets, pageCount: pages.length,
            reason: 'OCR not configured where this ran (no GOOGLE_API_KEY).',
          });
          onProgress({ stage: 'extracting', message: `${ocrTargets.length} scanned page(s) need OCR, which is not configured here — indexing the typed pages; ${retryWording(pendingOcr)}` });
        } else {
          onProgress({
            stage: 'extracting',
            message: wholeDoc
              ? `No text layer — running OCR on ${pages.length} page(s)`
              : `Running OCR on ${ocrTargets.length} of ${pages.length} page(s) (the rest have a text layer)`,
          });
          try {
            const merged = await ocrPdfPages(fileBuf, pages, ocrTargets, ocr, onProgress);
            pages = merged.pages;
            if (!wholeDoc) {
              onProgress({ stage: 'extracting', message: `OCR read ${merged.filled} of ${ocrTargets.length} page(s)` +
                (merged.stillEmpty.length ? `; ${merged.stillEmpty.length} had no legible text` : '') });
            }
          } catch (err) {
            pendingOcr = buildOcrPending(priorMetadata, { pages: ocrTargets, pageCount: pages.length, reason: err.message });
            if (extractedChars < 40) {
              // Nothing to index yet. Stored, honestly labelled, retried.
              return await markStoredWithoutText(supabase, documentId, TEXT_STATUS.OCR_PENDING, {
                pageCount: pages.length, onProgress,
                metadata: { ocr_pending: pendingOcr },
                message: `Stored — OCR failed on ${ocrTargets.length} page(s) (${firstLine(err.message)}); ${retryWording(pendingOcr)}`,
              });
            }
            onProgress({ stage: 'extracting', message: `OCR failed on ${ocrTargets.length} page(s) (${firstLine(err.message)}) — indexing the ${pages.length - ocrTargets.length} typed page(s); ${retryWording(pendingOcr)}` });
          }
        }
      }

      // OCR ran (or nothing needed it) and there are still ~no words: a
      // photo/diagram-only PDF (injury photos, exhibit images). That's a
      // valid document to view, not a failure — store-and-display like an
      // image instead of erroring. Not when pages are still awaiting OCR:
      // that case was recorded above and is not "OCR found nothing".
      const afterOcrChars = pages.reduce((s, p) => s + (p.text || '').trim().length, 0);
      if (afterOcrChars < 40 && !pendingOcr) {
        return await markStoredWithoutText(supabase, documentId, TEXT_STATUS.IMAGE_ONLY, {
          pageCount: pages.length, onProgress,
          message: `Image-only document stored — OCR found no readable text on ${pages.length} page(s)`,
        });
      }
    }

    // Word docs that are just a wrapped image (photo pasted into a .docx)
    // extract to no text at all. Like photo-only PDFs, that's a viewable
    // document, not a failure.
    const finalChars = pages.reduce((s, p) => s + (p.text || '').trim().length, 0);
    if (lowerExt === '.docx' && finalChars < 20) {
      return await markStoredWithoutText(supabase, documentId, TEXT_STATUS.IMAGE_ONLY, {
        pageCount: pages.length, onProgress,
        message: 'Image-only Word document stored (no readable text)',
      });
    }

    pageCount = pages.length;
    await supabase
      .from('documents')
      .update({ page_count: pageCount, processing_status: 'chunking' })
      .eq('id', documentId);
    onProgress({ stage: 'chunking', message: `Chunking ${pageCount} page(s)` });
    passages = chunkPages(pages, { witness_name: effectiveWitness });
    if (pendingOcr) {
      return await embedAndInsert(supabase, {
        documentId, matterspace_id, passages, openaiApiKey, onProgress, seal, priorMetadata, pendingOcr, metadataPatch,
      });
    }
  }

  return await embedAndInsert(supabase, {
    documentId, matterspace_id, passages, openaiApiKey, onProgress, seal, priorMetadata, metadataPatch,
  });
}


// Shared embed + insert tail. Sanitizes passages, embeds them in token-aware
// batches, inserts them, and marks the document ready. Used by every format
// path (documents, transcripts, media) so the normalize/embed/insert logic
// lives in exactly one place.
async function embedAndInsert(supabase, { documentId, matterspace_id, passages, openaiApiKey, onProgress = () => {}, seal = { sealed: false }, priorMetadata = null, pendingOcr = null, metadataPatch = null }) {
  // Normalize before embed/insert: strip NUL/control chars Postgres rejects,
  // and hard-cap any single passage at the embeddings per-input token limit so
  // one oversized chunk can't 400 the whole batch. Then drop passages that
  // sanitized down to nothing (all-control-char junk).
  for (const p of passages) {
    p.text = sanitizeText(p.text);
    if (p.text.length > MAX_INPUT_CHARS) {
      p.text = p.text.slice(0, MAX_INPUT_CHARS);
    }
  }
  passages = passages.filter((p) => p.text && p.text.trim().length > 0);

  if (passages.length === 0) {
    // The file opened and extracted, and there was simply nothing in it (an
    // empty .txt, a workbook with no cell text, a deck of pictures, a silent
    // recording). That is a document to keep, with its reason recorded — not
    // the old 'error: no passages extracted', which put an empty file in the
    // same bucket as a crashed pipeline. Scanned PDFs never reach here: they
    // either OCR'd, stored as image_only, or failed with an OCR cause above.
    // Unless pages are still awaiting OCR and the typed pages chunked down to
    // nothing (a stamp line each): then the honest reason is the OCR, and
    // the record of which pages must travel with it.
    if (pendingOcr) {
      return await markStoredWithoutText(supabase, documentId, TEXT_STATUS.OCR_PENDING, {
        onProgress, metadata: { ...(metadataPatch || {}), ocr_pending: pendingOcr },
        message: `Stored — ${describeOcrPending(pendingOcr)?.label || 'pages awaiting OCR'}`,
      });
    }
    return await markStoredWithoutText(supabase, documentId, TEXT_STATUS.NO_TEXT, {
      onProgress, metadata: metadataPatch || {},
      message: 'Stored — the file opened but held no text to index',
    });
  }
  onProgress({ stage: 'embedding', message: `Embedding ${passages.length} passages` });
  await setStatus(supabase, documentId, 'embedding');

  // -- Embed (token-aware batches + retry) --------------------------------
  // Batch under BOTH the per-request count (EMBEDDING_BATCH) and the per-request
  // token ceiling (MAX_REQUEST_TOKENS), so large legal PDFs don't blow the
  // 300k-token request limit. embedBatch() retries 429/5xx with backoff, and
  // halves the batch if the estimate was wrong and the API says so anyway.
  //
  // Which provider — if any — this matter's tier permits (lib/embed-routes.mjs).
  // Phase A asked "is it sealed?"; the question is now "what route applies?",
  // which is the same question for a Tier-A matter and a strictly better one
  // for a sealed matter that HAS a zero-retention route: it gets real vectors
  // again, stamped with that route's model so nothing compares them against
  // another space (migration 061).
  //
  // No route still means no embeddings, never a fall back to the unsealed
  // provider. Those passages are inserted with a null embedding, which costs
  // them stage A of search and nothing else — the text, the tsvector, the
  // citations and the page:line coordinates are all produced locally, so the
  // document is searchable the moment it lands, and the backfill finds exactly
  // what it must fix with `where embedding is null`.
  //
  // The caller's key stands in for the environment's, so a script that passes
  // its own OPENAI_API_KEY keeps working exactly as before.
  const { route, key: routeKey, reason: noRouteReason } = resolveRoute(seal.tier ?? 'A', {
    ...process.env,
    ...(openaiApiKey ? { OPENAI_API_KEY: openaiApiKey } : {}),
  });

  let embedded = 0;
  if (route) {
    for (const batch of tokenAwareBatches(passages)) {
      const embeddings = await embedBatch(routeKey, batch.map((p) => p.text), { route });
      batch.forEach((p, idx) => (p.embedding = embeddings[idx]));
      embedded += batch.length;
      onProgress({
        stage: 'embedding',
        message: `Embedded ${embedded}/${passages.length}`,
      });
    }
  } else {
    onProgress({
      stage: 'embedding',
      message: `${noRouteReason} Indexing ${passages.length} passages for text search; nothing sent out.`,
    });
  }

  // -- Insert passages -----------------------------------------------------
  // Keep chunks small: each insert triggers tsvector generation + vector-index
  // maintenance per row, and that per-row cost grows as the passages table
  // grows — a chunk size that clears the 8s authenticated-role statement
  // timeout today won't forever (387pp Coleman SJ memo, 2026-07-16; then the
  // 2,047pp Fleming Sixth Production, 2026-07-22). On a statement timeout,
  // halve the chunk and retry instead of failing the doc; a cancelled
  // statement is rolled back, so re-inserting the same rows is safe.
  const INSERT_CHUNK = 40;
  const insertRows = async (rows, attempt = 0) => {
    const { error: insErr } = await supabase.from('passages').insert(rows);
    if (!insErr) return;
    const isTimeout = /statement timeout/i.test(insErr.message);
    if (isTimeout && rows.length > 1) {
      const mid = Math.ceil(rows.length / 2);
      await insertRows(rows.slice(0, mid));
      await insertRows(rows.slice(mid));
      return;
    }
    if (isTimeout && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return insertRows(rows, attempt + 1);
    }
    throw new Error(`insert passages: ${insErr.message}`);
  };
  for (let i = 0; i < passages.length; i += INSERT_CHUNK) {
    const batch = passages.slice(i, i + INSERT_CHUNK).map((p) => ({
      document_id: documentId,
      matterspace_id,
      sequence_number: p.sequence_number,
      page_start: p.page_start,
      page_end: p.page_end,
      line_start: p.line_start,
      line_end: p.line_end,
      witness_name: p.witness_name,
      examination_type: p.examination_type,
      speaker: p.speaker,
      text: p.text,
      passage_type: p.passage_type,
      // Null when no route was permitted. The model stamp names the space this
      // vector lives in, and after migration 061 it governs one thing only:
      // which vectors may be compared with which. Full-text no longer cares,
      // so an unembedded passage is still found by text whatever it says here.
      embedding: p.embedding ?? null,
      embedding_model: route ? route.model : EMBEDDING_MODEL,
      summary_level: 0,
    }));
    await insertRows(batch);
  }

  // -- Mark ready ----------------------------------------------------------
  // A re-run that now yields text must also drop any text_status a previous
  // run recorded (a scan first filed as image_only, re-OCR'd successfully):
  // a "stored without text" reason beside real passages would be a lie.
  // `priorMetadata` is the row as processDocument loaded it — no second read
  // on the common path; the rewrite below happens only on such a re-run.
  // Likewise a record of pages awaiting OCR: dropped when this run read them
  // all, written (or refreshed) when some are still waiting — a document with
  // passages AND ocr_pending is "searchable, N pages awaiting OCR".
  const prior = { metadata: priorMetadata };
  const readyUpdate = {
    processing_status: 'ready',
    // Clear the record of any earlier failed attempt (e.g. an embed 429
    // that a later retry recovered from) — success must not carry a stale
    // error message. This is the path big worker-retried documents take.
    processing_error: null,
    ingested_at: new Date().toISOString(),
  };
  const hadReason = prior?.metadata &&
    ('text_status' in prior.metadata || 'text_status_at' in prior.metadata || 'ocr_pending' in prior.metadata);
  if (hadReason || pendingOcr || metadataPatch) {
    const { text_status: _ts, text_status_at: _at, ocr_pending: _op, ...rest } = prior?.metadata || {};
    readyUpdate.metadata = { ...rest, ...(metadataPatch || {}), ...(pendingOcr ? { ocr_pending: pendingOcr } : {}) };
  }
  await supabase
    .from('documents')
    .update(readyUpdate)
    .eq('id', documentId);
  const pendingNote = pendingOcr ? ` — ${describeOcrPending(pendingOcr)?.label || 'pages awaiting OCR'}` : '';
  onProgress({
    stage: 'ready',
    message: (route
      ? `${passages.length} passages indexed (${route.model})`
      : `${passages.length} passages indexed for text search — nothing sent out`) + pendingNote,
  });

  return {
    passageCount: passages.length, embedded: Boolean(route), embeddingModel: route?.model ?? null,
    ...(pendingOcr ? { ocrPending: pendingOcr } : {}),
    ...(metadataPatch || {}),
  };
}


async function setStatus(supabase, documentId, status) {
  await supabase
    .from('documents')
    .update({ processing_status: status })
    .eq('id', documentId);
}

// The one exit for "stored, but nothing to search": marks the row ready and
// records WHY there is no text, as documents.metadata.text_status (values in
// TEXT_STATUS). Until 2026-09-04 every store-and-display branch wrote a bare
// 'ready', so a photo, a portfolio cover, a 3D asset and a scanned exhibit
// the OCR could not read all looked identical to a fully indexed brief — and
// the monitor had to guess from the extension. Metadata is merged, never
// replaced: the portfolio summary and any other keys already on the row
// survive. Returns the processDocument result shape.
async function markStoredWithoutText(supabase, documentId, textStatus, { pageCount = null, message, onProgress = () => {}, metadata = {} } = {}) {
  const { data: row } = await supabase
    .from('documents')
    .select('metadata')
    .eq('id', documentId)
    .maybeSingle();
  const merged = {
    ...(row?.metadata || {}),
    ...metadata,
    text_status: textStatus,
    text_status_at: new Date().toISOString(),
  };
  const update = {
    processing_status: 'ready',
    // A successful run must erase the record of any earlier failed attempt —
    // a stale error alongside 'ready' reads as broken.
    processing_error: null,
    ingested_at: new Date().toISOString(),
    metadata: merged,
  };
  if (pageCount != null) update.page_count = pageCount;
  // A run that stores the file for a reason OTHER than pending OCR has, by
  // reaching here, resolved the OCR question (image_only: it ran and found
  // nothing) — a stale ocr_pending must not outlive it.
  if (textStatus !== TEXT_STATUS.OCR_PENDING && !('ocr_pending' in metadata)) delete merged.ocr_pending;
  const { error } = await supabase.from('documents').update(update).eq('id', documentId);
  if (error) throw new Error(`record text_status: ${error.message}`);
  onProgress({ stage: 'ready', message: message || `Stored without text (${textStatus})` });
  return { passageCount: 0, textStatus, ...(merged.ocr_pending ? { ocrPending: merged.ocr_pending } : {}) };
}


// -----------------------------------------------------------------------------
// Per-page OCR (Phase 2) — which pages, how they are sent, how they merge back
// -----------------------------------------------------------------------------

// A page with fewer trimmed characters than this has no usable text layer. A
// born-digital page of legal text runs thousands; the CM/ECF stamp a court
// overlays on a scanned page runs 80–200. Same figure the document-wide test
// used since 2026-08-10, now applied per page.
export const PAGE_TEXT_MIN_CHARS = 200;

// An image XObject at least this many pixels is a page-sized scan, not a logo
// or a signature: a 100 dpi letter page is ~935k px, a 300 dpi one ~8.4M;
// letterhead art is tens of thousands.
const SCAN_IMAGE_MIN_PIXELS = 250_000;

// Which pages of a PDF get OCR'd. `pages` is extractPages' output.
//
//   1. A page is SHORT when its text layer is under PAGE_TEXT_MIN_CHARS.
//   2. If the document as a whole looks scanned (average under the threshold —
//      the pre-Phase-2 rule), every short page is OCR'd. This keeps today's
//      behaviour for scans, including the rare vector-outlined ones that
//      carry no image at all.
//   3. Otherwise — a document that is mostly typed — a short page is OCR'd
//      only if it carries a page-sized image. The exhibit slip sheet
//      ("EXHIBIT 12"), the blank back of a page, the signature-only last
//      page: no image, nothing to read, no OCR — and, since the inline
//      callers route on this answer, no trip to the worker for a brief that
//      merely has tabs. The scanned exhibit behind the tab IS an image, and
//      is OCR'd. When the PDF can't be inspected for images (pdf-lib refused
//      it), every short page is OCR'd: better one needless page than a lost
//      one.
//
// Returns the 1-based page numbers, ascending.
export async function pagesNeedingOcr(fileBuf, pages) {
  if (!pages || !pages.length) return [];
  const short = pages.filter((p) => (p.text || '').trim().length < PAGE_TEXT_MIN_CHARS).map((p) => p.pageNumber);
  if (!short.length) return [];
  const total = pages.reduce((s, p) => s + (p.text || '').trim().length, 0);
  const docLooksScanned = total < Math.max(40, pages.length * PAGE_TEXT_MIN_CHARS);
  if (docLooksScanned) return short;
  const scanLike = await scanLikePages(fileBuf, short);
  if (scanLike === null) return short;
  return short.filter((n) => scanLike.has(n));
}

// Which of the given pages draw a page-sized image (one level of Form
// XObject nesting included, since some producers wrap the scan in a form).
// Reads dictionaries only — no image is decoded. Returns null when the PDF
// cannot be opened by pdf-lib, so the caller can fall back to "OCR them all".
async function scanLikePages(fileBuf, pageNumbers) {
  try {
    const { PDFDocument, PDFName, PDFDict, PDFStream, PDFNumber, PDFRef } = await import('pdf-lib');
    const doc = await PDFDocument.load(fileBuf, { ignoreEncryption: true, updateMetadata: false });
    const count = doc.getPageCount();
    const found = new Set();
    const isScanImage = (stream) => {
      const d = stream?.dict;
      if (!(d instanceof PDFDict)) return false;
      if (d.get(PDFName.of('Subtype')) !== PDFName.of('Image')) return false;
      const w = d.lookup(PDFName.of('Width'));
      const h = d.lookup(PDFName.of('Height'));
      const px = (w instanceof PDFNumber ? w.asNumber() : 0) * (h instanceof PDFNumber ? h.asNumber() : 0);
      return px >= SCAN_IMAGE_MIN_PIXELS;
    };
    const resourcesHaveScan = (resources, depth) => {
      if (!(resources instanceof PDFDict)) return false;
      const xobjects = resources.lookup(PDFName.of('XObject'));
      if (!(xobjects instanceof PDFDict)) return false;
      for (const [, value] of xobjects.entries()) {
        const obj = value instanceof PDFRef ? doc.context.lookup(value) : value;
        if (!(obj instanceof PDFStream)) continue;
        if (isScanImage(obj)) return true;
        if (depth > 0 && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) {
          if (resourcesHaveScan(obj.dict.lookup(PDFName.of('Resources')), depth - 1)) return true;
        }
      }
      return false;
    };
    for (const n of pageNumbers) {
      if (n < 1 || n > count) continue;
      const page = doc.getPage(n - 1);
      if (resourcesHaveScan(page.node.Resources(), 1)) found.add(n);
    }
    return found;
  } catch {
    return null;
  }
}

// OCR only `targets` (1-based page numbers) of a PDF and merge the text back
// into `pages` by page number. The injected `ocr` hook takes PDF bytes and
// returns that PDF's pages 1..k, so the targets are copied into a sub-PDF
// first and k maps back to the original numbering here — the hook never
// learns it saw a subset, and ingest-core stays provider-agnostic. When every
// page is a target the original bytes go as they are (no copy, and no chance
// for pdf-lib to choke on a file pdf-parse managed to read). When pdf-lib
// cannot build the subset, the whole PDF is OCR'd and only the target pages'
// results are taken: correct at the cost of the pages that did not need it.
//
// Merge rule: a target page takes its OCR text when OCR found any, and keeps
// its own (stamp) text when OCR found none — never trade text for nothing.
async function ocrPdfPages(fileBuf, pages, targets, ocr, onProgress = () => {}) {
  const wanted = new Set(targets);
  const ocrByPage = new Map();
  if (targets.length === pages.length) {
    const out = (await ocr(fileBuf)) || [];
    for (const p of out) if (wanted.has(p.pageNumber)) ocrByPage.set(p.pageNumber, p.text || '');
  } else {
    let subset = null;
    try {
      subset = await subsetPdf(fileBuf, targets);
    } catch (err) {
      onProgress({ stage: 'extracting', message: `Could not split out the scanned pages (${firstLine(err.message)}) — OCR'ing the whole file instead` });
    }
    if (subset) {
      const out = (await ocr(subset)) || [];
      out.forEach((p, i) => {
        const original = targets[(p.pageNumber ?? i + 1) - 1];
        if (original != null) ocrByPage.set(original, p.text || '');
      });
    } else {
      const out = (await ocr(fileBuf)) || [];
      for (const p of out) if (wanted.has(p.pageNumber)) ocrByPage.set(p.pageNumber, p.text || '');
    }
  }
  return mergeOcrPages(pages, ocrByPage, targets);
}

// Pure merge, exported for tests. `ocrByPage`: Map<pageNumber, text>.
export function mergeOcrPages(pages, ocrByPage, targets) {
  const wanted = new Set(targets);
  let filled = 0;
  const stillEmpty = [];
  const merged = pages.map((p) => {
    if (!wanted.has(p.pageNumber)) return p;
    const text = (ocrByPage.get(p.pageNumber) || '').trim();
    if (text) { filled++; return { ...p, text }; }
    stillEmpty.push(p.pageNumber);
    return p;
  });
  return { pages: merged, filled, stillEmpty };
}

// Copy the given 1-based pages of a PDF into a new PDF, in the given order.
export async function subsetPdf(fileBuf, pageNumbers) {
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(fileBuf, { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageNumbers.map((n) => n - 1));
  for (const p of copied) out.addPage(p);
  return Buffer.from(await out.save({ useObjectStreams: false }));
}

// The record of pages still awaiting OCR (documents.metadata.ocr_pending —
// shape documented in ingest-formats). `prior` is the row's metadata before
// this run, so the attempt count carries across runs and the retry schedule
// advances instead of restarting. `held` records a seal refusal: not an
// attempt, never retried by the sweep. Exported for tests and callers.
export function buildOcrPending(prior, { pages, pageCount = null, reason, held = false }) {
  const before = prior?.ocr_pending && typeof prior.ocr_pending === 'object' ? prior.ocr_pending : null;
  const attempts = held ? (before?.attempts ?? 0) : (Number(before?.attempts) || 0) + 1;
  const delay = held ? null : ocrRetryDelayMs(attempts);
  const now = new Date();
  return {
    pages: Array.isArray(pages) ? pages : null,
    page_count: pageCount,
    reason: firstLine(reason).slice(0, 300),
    at: now.toISOString(),
    attempts,
    next_retry_at: delay != null ? new Date(now.getTime() + delay).toISOString() : null,
    ...(held ? { held: true } : {}),
    ...(!held && delay == null ? { exhausted: true } : {}),
  };
}

function firstLine(s) {
  return String(s ?? '').split('\n')[0].trim();
}

function retryWording(pending) {
  if (!pending) return '';
  if (pending.held) return 'not retried (sealed)';
  if (pending.exhausted) return `no more automatic retries after ${pending.attempts} attempts — Re-run when the cause is fixed`;
  const mins = Math.round((new Date(pending.next_retry_at).getTime() - Date.now()) / 60_000);
  return `OCR retries automatically in about ${mins < 60 ? `${Math.max(1, mins)} min` : `${Math.round(mins / 60)} h`} (attempt ${pending.attempts} of ${OCR_RETRY_DELAYS_MS.length + 1})`;
}


// -----------------------------------------------------------------------------
// Extract — per-page text from any supported file format
// -----------------------------------------------------------------------------
export async function extractPages(fileBuf, ext) {
  const lower = (ext || '').toLowerCase();
  if (lower === '.pdf') return extractPdfPages(fileBuf);
  if (lower === '.docx') return extractDocxPages(fileBuf);
  if (lower === '.xlsx') {
    // Spreadsheets are an OOXML zip, not text — extract per-worksheet so each
    // sheet is its own page (a two-sheet workbook -> two pages). Without this,
    // the plain-text fallback below would buf.toString('utf8') a binary zip
    // into garbage and the pipeline would die with "no passages extracted".
    const { extractXlsx } = await import('./xlsx-extract.mjs');
    return extractXlsx(fileBuf);
  }
  if (lower === '.pptx') {
    // Slide decks are an OOXML zip like .xlsx; one page per slide (speaker
    // notes included) so citations read as slide numbers.
    const { extractPptx } = await import('./pptx-extract.mjs');
    return extractPptx(fileBuf);
  }
  if (lower === '.eml') {
    const { extractEmlPages } = await import('./eml-extract.mjs');
    return extractEmlPages(fileBuf);
  }
  // Plain text: one big "page". The chunker splits it into passages.
  const buf = fileBuf instanceof Uint8Array ? Buffer.from(fileBuf) : fileBuf;
  return [{ pageNumber: 1, text: buf.toString('utf8') }];
}

// Binary sniff for the plain-text fallback: a NUL byte or a high ratio of
// non-text bytes in the head means raw bytes, not prose. Reading such a file
// as UTF-8 produces garbage "text" that survives sanitizeText() in bulk and
// blows the embeddings API limits (observed with .pptx decks before they were
// supported, and .glb/.fbx/.usdz/.obj 3D assets: "Requested ~500000 tokens,
// max 300000"). UTF-16 text files trip the NUL check too — acceptable: they
// were garbage under a UTF-8 read anyway, and store-and-display beats error.
export function looksBinary(fileBuf) {
  const b = fileBuf instanceof Uint8Array ? Buffer.from(fileBuf) : fileBuf;
  const head = b.slice(0, 8192);
  if (head.length === 0) return false;
  let suspect = 0;
  for (const byte of head) {
    if (byte === 0) return true;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) suspect++;
  }
  return suspect / head.length > 0.1;
}

// Wrap an image in a PDF so the standard `ocr` hook (which takes PDF bytes)
// can read it. pdf-lib embeds a JPEG or PNG stream directly — no re-encode —
// so for those two OCR sees exactly the uploaded pixels.
//
// TIFF cannot be embedded by pdf-lib at all, so it is transcoded to PNG with
// sharp (libvips) first. PNG is lossless, so this still puts the uploaded
// pixels in front of OCR; the cost is a decode/encode round trip, which on a
// 60 KB Group-4 Bates page is milliseconds.
//
// TIFF is also the one format here that is routinely MULTI-PAGE — a scanning
// bureau will hand you one .tif holding an entire document. Emitting only the
// first page would silently truncate it, which is the same class of failure
// this function is being changed to fix, so every page is emitted and the
// caller reads the real page count off the returned PDF. `sharp(buf).metadata()`
// reports `pages` for multi-page TIFF; single-page files report 1 or undefined.
//
// Pages are scaled to letter width (612pt) when wider, preserving aspect ratio,
// so a 300 dpi scan comes out page-sized rather than 2550 points across. This
// mirrors lib/discovery/normalize.mjs's tiffToPdf(), which has been converting
// production TIFFs this way since the discovery module shipped — the same
// approach, applied where ordinary ingestion can reach it.
export async function imageToPdf(fileBuf, ext) {
  const { PDFDocument } = await import('pdf-lib');
  const b = fileBuf instanceof Uint8Array ? Buffer.from(fileBuf) : fileBuf;
  const doc = await PDFDocument.create();

  if (ext === '.tif' || ext === '.tiff') {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(b).metadata();
    const pageCount = meta.pages && meta.pages > 1 ? meta.pages : 1;
    for (let i = 0; i < pageCount; i++) {
      const png = await sharp(b, { page: i }).png().toBuffer();
      const img = await doc.embedPng(png);
      const scale = img.width > 612 ? 612 / img.width : 1;
      const w = img.width * scale;
      const h = img.height * scale;
      const page = doc.addPage([w, h]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    return Buffer.from(await doc.save());
  }

  const img = ext === '.png' ? await doc.embedPng(b) : await doc.embedJpg(b);
  const page = doc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  return Buffer.from(await doc.save());
}

async function extractDocxPages(buf) {
  // mammoth produces a single flow of text from a .docx with no real page
  // breaks (Word's pagination is computed at render time). Treat as one page;
  // the chunker handles the rest.
  const mammoth = await import('mammoth');
  const buffer = buf instanceof Uint8Array ? Buffer.from(buf) : buf;
  const { value } = await mammoth.extractRawText({ buffer });
  return [{ pageNumber: 1, text: value }];
}

// pdf-parse@1.1.1 bundles an older pdfjs that doesn't reference DOMMatrix
// at module load, so it works in Vercel's serverless runtime where
// pdfjs-dist 5.x crashes. Importing the inner module (not the package
// root) skips pdf-parse's built-in debug script that tries to read a
// non-existent test fixture.
//
// Why pagerender instead of pdf-parse's default text join: depositions
// (and most professionally rendered transcripts) don't emit form-feed
// characters between pages, so the default joined text comes back as
// one giant blob. The downstream transcript parser then sees a 400 KB
// "page 1" instead of 166 ~2 KB pages, fails its size guard, and falls
// through to prose chunking — leaving every passage citing "p. 1". By
// using pdf-parse's per-page callback, we get one entry per real PDF
// page with the correct page number, and parseTranscriptPage can do
// its job. Line breaks are reconstructed from Y-coordinate changes
// inside the text items so line-number heuristics still work.
async function extractPdfPages(buf) {
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
  const buffer = buf instanceof Uint8Array ? Buffer.from(buf) : buf;
  const pages = [];
  const options = {
    pagerender: async (pageData) => {
      const textContent = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      let lastY;
      let text = '';
      for (const item of textContent.items) {
        const y = item.transform[5];
        if (lastY !== undefined && Math.abs(lastY - y) > 0.1) {
          text += '\n';
        }
        text += item.str;
        lastY = y;
      }
      pages.push(text);
      return text;
    },
  };
  try {
    await pdfParse(buffer, options);
  } catch (err) {
    // pdf-parse's 2017 pdf.js rejects a share of perfectly good files —
    // reproduced 2026-09-04 on pdf-lib output saved WITHOUT object streams:
    // 1 in 12 fails "bad XRef entry" / "Illegal character", and the same
    // bytes read cleanly in pdfjs-dist. That was the "portfolio child bad
    // XRef" failure on the deployed worker at the Phase 1 handoff, and with
    // containers (Phase 3) filing many pdf-lib / iText children it would be
    // routine. Modern pdfjs is already a dependency (pdf-portfolio.mjs);
    // read with it before calling the file corrupt. A file both reject
    // fails with pdf-parse's message, as before.
    const modern = await extractPdfPagesModern(buffer).catch(() => null);
    if (modern) return modern;
    throw err;
  }
  // Guard: if pagerender didn't fire for some reason (very old or
  // structurally odd PDFs), fall back to the legacy form-feed split so
  // we at least return something instead of an empty array.
  if (pages.length === 0) {
    const result = await pdfParse(buffer);
    const raw = result.text || '';
    const parts = raw.includes('\f') ? raw.split('\f') : [raw];
    return parts.map((text, i) => ({ pageNumber: i + 1, text }));
  }
  return pages.map((text, i) => ({ pageNumber: i + 1, text }));
}

// The same per-page text join as extractPdfPages, through pdfjs-dist's
// legacy build (no DOM needed). Used only when pdf-parse throws.
async function extractPdfPagesModern(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
  }).promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      let lastY;
      let text = '';
      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        const y = item.transform?.[5];
        if (lastY !== undefined && y !== undefined && Math.abs(lastY - y) > 0.1) text += '\n';
        text += item.str;
        if (item.hasEOL) text += '\n';
        lastY = y;
      }
      pages.push({ pageNumber: i, text });
      page.cleanup?.();
    }
    return pages;
  } finally {
    try { await doc.destroy(); } catch { /* best effort */ }
  }
}


// -----------------------------------------------------------------------------
// Chunk — pages → passages
// -----------------------------------------------------------------------------
export function chunkPages(pages, opts = {}) {
  const passages = [];
  let seq = 0;
  let activeWitness = opts.witness_name || null;
  let activeExamType = null;

  for (const { pageNumber, text } of pages) {
    const transcript = parseTranscriptPage(text);
    if (transcript) {
      for (const c of transcript.chunks) {
        if (c.witness_name) activeWitness = c.witness_name;
        if (c.examination_type) activeExamType = c.examination_type;
        passages.push({
          sequence_number: seq++,
          page_start: pageNumber,
          page_end: pageNumber,
          line_start: c.line_start,
          line_end: c.line_end,
          witness_name: activeWitness,
          examination_type: activeExamType,
          speaker: c.speaker || null,
          text: c.text,
          passage_type: c.passage_type,
        });
      }
    } else {
      for (const block of paragraphChunks(text, MAX_PASSAGE_WORDS)) {
        passages.push({
          sequence_number: seq++,
          page_start: pageNumber,
          page_end: pageNumber,
          line_start: null,
          line_end: null,
          witness_name: activeWitness,
          examination_type: null,
          speaker: null,
          text: block,
          passage_type: 'monologue',
        });
      }
    }
  }
  return passages;
}

// -----------------------------------------------------------------------------
// Chunk — EPUB chapters → passages
//
// One pass over chapters in OPF spine order. For each chapter:
//   1. A chapter_heading passage with the chapter title (so MCP can cite by
//      heading and search by chapter name).
//   2. Body paragraphs split via the same paragraphChunks() used elsewhere,
//      so the embeddings API doesn't see anything > MAX_PASSAGE_WORDS.
//   3. Footnotes for that chapter, each as its own footnote passage.
//
// page_start/page_end is the chapter_number — books have no real page numbers
// (EPUB pagination is reflowable), so chapter_number is the canonical
// citable coordinate. formatCitation() in mcp-core renders this as "Ch. N".
// -----------------------------------------------------------------------------
export function chunkBook(epub) {
  const passages = [];
  let seq = 0;

  const footnotesByChapter = new Map();
  for (const fn of epub.footnotes || []) {
    if (typeof fn.chapter_number !== 'number') continue;
    if (!footnotesByChapter.has(fn.chapter_number)) {
      footnotesByChapter.set(fn.chapter_number, []);
    }
    footnotesByChapter.get(fn.chapter_number).push(fn);
  }

  for (const ch of epub.chapters || []) {
    const chapterNum = ch.chapter_number;
    const title = (ch.chapter_title || '').trim();
    if (title) {
      passages.push({
        sequence_number: seq++,
        page_start: chapterNum,
        page_end: chapterNum,
        line_start: null,
        line_end: null,
        witness_name: null,
        examination_type: null,
        speaker: null,
        text: title,
        passage_type: 'chapter_heading',
      });
    }

    const body = ch.text || '';
    if (body.trim()) {
      for (const block of paragraphChunks(body, MAX_PASSAGE_WORDS)) {
        passages.push({
          sequence_number: seq++,
          page_start: chapterNum,
          page_end: chapterNum,
          line_start: null,
          line_end: null,
          witness_name: null,
          examination_type: null,
          speaker: null,
          text: block,
          passage_type: 'monologue',
        });
      }
    }

    const fns = footnotesByChapter.get(chapterNum) || [];
    for (const fn of fns) {
      const text = fn.text?.trim();
      if (!text) continue;
      passages.push({
        sequence_number: seq++,
        page_start: chapterNum,
        page_end: chapterNum,
        line_start: null,
        line_end: null,
        witness_name: null,
        examination_type: null,
        speaker: null,
        text: `[fn ${fn.footnote_number}] ${text}`,
        passage_type: 'footnote',
      });
    }
  }

  return passages;
}


// -----------------------------------------------------------------------------
// Chunk — Fountain screenplay → passages
//
// Walk the fountain-js token stream and emit one structured passage per
// semantic element: scene headings, action blocks, character speeches
// (each a single passage with speaker + parentheticals + dialogue
// merged), transitions, section breaks. Mirrors the deposition-transcript
// parser: structured passage_type + speaker so the existing MCP tools
// work natively — search(witnesses=['LUTHIER']) returns every Luthier
// speech; get_outline returns the scene breakdown; grep verifies wording
// across the whole script. Character names go into BOTH `speaker` and
// `witness_name` so the search RPC's witness filter works without
// schema changes.
//
// Page coordinates: screenplays page at the well-known ~55-line / ~1
// minute convention; we approximate page_start by counting source lines
// up to each passage. Not exact (real screenplay pagination depends on
// dialogue density), but close enough for citation purposes.
// -----------------------------------------------------------------------------
export async function chunkFountain(text) {
  const { Fountain } = await import('fountain-js');
  const parsed = new Fountain().parse(text, true);
  const tokens = parsed.tokens || [];

  const passages = [];
  let seq = 0;
  let currentLine = 1;
  let pendingSpeaker = null;
  let pendingSpeakerLine = 1;
  let pendingDialogue = [];

  function pageForLine(line) {
    return Math.max(1, Math.floor((line - 1) / 55) + 1);
  }
  function estimateLines(s) {
    if (!s) return 1;
    const wraps = Math.max(1, Math.ceil(s.length / 60));
    const breaks = (s.match(/\n/g) || []).length + 1;
    return Math.max(wraps, breaks);
  }

  function flushSpeech() {
    if (!pendingSpeaker || pendingDialogue.length === 0) {
      pendingSpeaker = null;
      pendingDialogue = [];
      return;
    }
    const speechText = pendingDialogue.join('\n');
    const lineEnd = pendingSpeakerLine + estimateLines(speechText) - 1;
    passages.push({
      sequence_number: seq++,
      page_start: pageForLine(pendingSpeakerLine),
      page_end: pageForLine(lineEnd),
      line_start: pendingSpeakerLine,
      line_end: lineEnd,
      witness_name: pendingSpeaker,
      examination_type: null,
      speaker: pendingSpeaker,
      text: `${pendingSpeaker}\n${speechText}`,
      passage_type: 'character_dialogue',
    });
    pendingSpeaker = null;
    pendingDialogue = [];
  }

  for (const token of tokens) {
    const type = token.type;
    if (type === 'title' || type === 'author' || type === 'credit' ||
        type === 'source' || type === 'notes' || type === 'draft_date' ||
        type === 'date' || type === 'contact' || type === 'copyright') {
      // Title-page elements — emit each as its own short passage so
      // search hits "Title: Luthier's Daughter" naturally.
      passages.push({
        sequence_number: seq++,
        page_start: 1,
        page_end: 1,
        line_start: currentLine,
        line_end: currentLine,
        witness_name: null,
        examination_type: null,
        speaker: null,
        text: `${type}: ${token.text}`,
        passage_type: 'title_page',
      });
      currentLine += 1;
      continue;
    }

    if (type === 'scene_heading') {
      flushSpeech();
      passages.push({
        sequence_number: seq++,
        page_start: pageForLine(currentLine),
        page_end: pageForLine(currentLine),
        line_start: currentLine,
        line_end: currentLine,
        witness_name: null,
        examination_type: null,
        speaker: null,
        text: token.text,
        passage_type: 'scene_heading',
      });
      currentLine += 2;
      continue;
    }

    if (type === 'action') {
      flushSpeech();
      const lines = estimateLines(token.text);
      passages.push({
        sequence_number: seq++,
        page_start: pageForLine(currentLine),
        page_end: pageForLine(currentLine + lines - 1),
        line_start: currentLine,
        line_end: currentLine + lines - 1,
        witness_name: null,
        examination_type: null,
        speaker: null,
        text: token.text,
        passage_type: 'action',
      });
      currentLine += lines + 1;
      continue;
    }

    if (type === 'character') {
      flushSpeech();
      pendingSpeaker = token.text;
      pendingSpeakerLine = currentLine;
      pendingDialogue = [];
      currentLine += 1;
      continue;
    }

    if (type === 'dialogue') {
      if (pendingSpeaker) {
        pendingDialogue.push(token.text);
        currentLine += estimateLines(token.text);
      }
      continue;
    }

    if (type === 'parenthetical') {
      if (pendingSpeaker) {
        pendingDialogue.push(`(${token.text.replace(/^\(|\)$/g, '')})`);
        currentLine += 1;
      }
      continue;
    }

    if (type === 'dialogue_begin' || type === 'dialogue_end' || type === 'dual_dialogue_begin' || type === 'dual_dialogue_end') {
      // Structural markers — handled implicitly via pendingSpeaker.
      continue;
    }

    if (type === 'transition') {
      flushSpeech();
      passages.push({
        sequence_number: seq++,
        page_start: pageForLine(currentLine),
        page_end: pageForLine(currentLine),
        line_start: currentLine,
        line_end: currentLine,
        witness_name: null,
        examination_type: null,
        speaker: null,
        text: token.text,
        passage_type: 'transition',
      });
      currentLine += 2;
      continue;
    }

    if (type === 'section') {
      // # Act, ## Sequence, ### Beat — outline structure
      flushSpeech();
      passages.push({
        sequence_number: seq++,
        page_start: pageForLine(currentLine),
        page_end: pageForLine(currentLine),
        line_start: currentLine,
        line_end: currentLine,
        witness_name: null,
        examination_type: null,
        speaker: null,
        text: `${'#'.repeat(token.depth || 1)} ${token.text}`,
        passage_type: 'section_heading',
      });
      currentLine += 1;
      continue;
    }

    if (type === 'synopsis') {
      // = Synopsis line — outline annotation
      flushSpeech();
      passages.push({
        sequence_number: seq++,
        page_start: pageForLine(currentLine),
        page_end: pageForLine(currentLine),
        line_start: currentLine,
        line_end: currentLine,
        witness_name: null,
        examination_type: null,
        speaker: null,
        text: `= ${token.text}`,
        passage_type: 'synopsis',
      });
      currentLine += 1;
      continue;
    }

    if (type === 'centered') {
      flushSpeech();
      passages.push({
        sequence_number: seq++,
        page_start: pageForLine(currentLine),
        page_end: pageForLine(currentLine),
        line_start: currentLine,
        line_end: currentLine,
        witness_name: null,
        examination_type: null,
        speaker: null,
        text: token.text,
        passage_type: 'centered',
      });
      currentLine += 1;
      continue;
    }

    if (type === 'note') {
      // [[ author note ]] — preserve as an inline-comment passage
      flushSpeech();
      passages.push({
        sequence_number: seq++,
        page_start: pageForLine(currentLine),
        page_end: pageForLine(currentLine),
        line_start: currentLine,
        line_end: currentLine,
        witness_name: null,
        examination_type: null,
        speaker: null,
        text: `[[ ${token.text} ]]`,
        passage_type: 'note',
      });
      currentLine += 1;
      continue;
    }

    // Unknown / page_break / line_break — skip, but advance the line
    // counter so page estimates stay close to truth.
    if (token.text) currentLine += 1;
  }
  flushSpeech();

  return passages;
}


function parseTranscriptPage(pageText) {
  // Size guard: transcript pages are ~1.5-3K chars each. When pdf-parse
  // doesn't emit form-feeds and the whole document arrives as one giant
  // blob, every line-number heuristic in the file produces enough false
  // positives to flip transcript mode on for a doc that has nothing to do
  // with transcripts. Anything well above per-page size is almost certainly
  // a concatenated case-law / contract / brief blob — let paragraphChunks
  // handle it as prose.
  if (pageText.length > 8000) return null;

  const lineRE = /^(?:\s{0,6})(\d{1,2})\s{1,6}(.*)$/gm;
  const lines = [];
  let m;
  while ((m = lineRE.exec(pageText)) !== null) {
    const n = parseInt(m[1], 10);
    if (n < 1 || n > 40) continue;
    lines.push({ lineNum: n, text: m[2].trim() });
  }
  if (lines.length < 8) return null;

  const headerRE = /\b(DIRECT|CROSS|REDIRECT|RECROSS|VOIR DIRE)\s+EXAMINATION\b/i;
  const witnessCallRE = /\b([A-Z][A-Z'\- ]+),\s+(?:having been|was)\b/;

  // Numbered-line detection alone is too eager — case-law PDFs (Westlaw,
  // FindLaw, vLex, etc.) contain plenty of 1-2 digit prefixes from footnote
  // markers, star-page markers (**1, **2), numbered list items, and citation
  // page numbers that satisfy lineRE without being transcripts. Require at
  // least one real transcript marker (Q./A./EXAMINATION header / witness
  // call / "BY MR.") before committing to transcript mode; otherwise return
  // null so paragraphChunks handles the text as prose. Without this guard,
  // the loop below would collect only the post-digit-prefix fragments and
  // concatenate them into a single ~1-2K-char passage of stitched-together
  // citation cruft, leaving the real opinion text un-indexed.
  const looksLikeTranscript = lines.some(({ text }) =>
    /^Q\.\s/.test(text) ||
    /^A\.\s/.test(text) ||
    /^BY\s+(MR\.|MRS\.|MS\.|DR\.)/.test(text) ||
    headerRE.test(text) ||
    witnessCallRE.test(text)
  );
  if (!looksLikeTranscript) return null;

  const chunks = [];
  let cur = null;
  function flush() {
    if (cur && cur.text.trim()) chunks.push(cur);
    cur = null;
  }

  for (const { lineNum, text } of lines) {
    const header = headerRE.exec(text);
    const witnessCall = witnessCallRE.exec(text);
    const isQ = /^Q\.\s/.test(text);
    const isA = /^A\.\s/.test(text);
    const isExamBy = /^BY\s+(MR\.|MRS\.|MS\.|DR\.)/.test(text);

    if (header || witnessCall || isExamBy) {
      flush();
      chunks.push({
        line_start: lineNum,
        line_end: lineNum,
        text,
        passage_type: 'section_heading',
        witness_name: witnessCall ? witnessCall[1].trim() : null,
        examination_type: header ? normalizeExamType(header[1]) : null,
        speaker: null,
      });
      continue;
    }

    if (isQ && cur && cur.hasAnswer) flush();
    if (isA && cur) cur.hasAnswer = true;

    if (!cur) {
      cur = {
        line_start: lineNum,
        line_end: lineNum,
        text,
        passage_type: 'qa_pair',
        speaker: isQ ? 'Q' : isA ? 'A' : null,
        hasAnswer: isA,
      };
    } else {
      cur.line_end = lineNum;
      cur.text += '\n' + text;
    }
  }
  flush();

  const merged = [];
  for (const c of chunks) {
    const last = merged[merged.length - 1];
    if (last && last.passage_type === c.passage_type && last.text.length < 300) {
      last.line_end = c.line_end;
      last.text += '\n' + c.text;
    } else {
      merged.push(c);
    }
  }
  return { chunks: merged };
}

function normalizeExamType(s) {
  const u = s.toUpperCase();
  if (u.startsWith('DIRECT')) return 'direct';
  if (u.startsWith('CROSS')) return 'cross';
  if (u.startsWith('REDIRECT')) return 'redirect';
  if (u.startsWith('RECROSS')) return 'recross';
  if (u.startsWith('VOIR')) return 'voir_dire';
  return null;
}

export function paragraphChunks(text, maxWords) {
  // Step 1: split on paragraph breaks (double newlines).
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  // Step 2: any paragraph that is itself longer than maxWords gets recursively
  // broken down — first on single newlines, then on sentence boundaries, then
  // by raw word count as a last resort. Without this, screenplays and other
  // text where paragraphs are sparse can produce one giant 7000-word chunk
  // that blows past the embeddings API's 8k-token input limit.
  const wc = (s) => s.split(/\s+/).filter(Boolean).length;
  const expanded = [];
  for (const p of paras) {
    if (wc(p) <= maxWords) { expanded.push(p); continue; }
    const lines = p.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (wc(line) <= maxWords) { expanded.push(line); continue; }
      const sents = line.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
      for (const s of sents) {
        if (wc(s) <= maxWords) { expanded.push(s); continue; }
        const words = s.split(/\s+/);
        for (let i = 0; i < words.length; i += maxWords) {
          expanded.push(words.slice(i, i + maxWords).join(' '));
        }
      }
    }
  }

  // Step 3: group into ~maxWords chunks.
  const out = [];
  let buf = '';
  let bufWords = 0;
  for (const p of expanded) {
    const w = wc(p);
    if (buf && bufWords + w > maxWords) {
      out.push(buf);
      buf = '';
      bufWords = 0;
    }
    buf = buf ? buf + '\n\n' + p : p;
    bufWords += w;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}


// -----------------------------------------------------------------------------
// Embed
// -----------------------------------------------------------------------------
// Split passages into requests that respect BOTH the count cap and the
// per-request token ceiling. A single passage is already capped at
// MAX_INPUT_TOKENS upstream, so it always fits in a request by itself.
export function* tokenAwareBatches(passages) {
  let batch = [];
  let tokens = 0;
  for (const p of passages) {
    const t = estimateTokens(p.text);
    if (batch.length > 0 && (batch.length >= EMBEDDING_BATCH || tokens + t > MAX_REQUEST_TOKENS)) {
      yield batch;
      batch = [];
      tokens = 0;
    }
    batch.push(p);
    tokens += t;
  }
  if (batch.length > 0) yield batch;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Embed one request worth of texts, retrying transient failures. 429 (rate
// limit) and 5xx are retried with exponential backoff + jitter, honoring a
// Retry-After header when present. 4xx other than 429 are non-retryable (a
// bad input won't fix itself) and throw immediately.
export async function embedBatch(
  apiKey,
  texts,
  { maxRetries = 6, limiter = undefined, route = ROUTES['openai-3-small'] } = {},
) {
  // Reserve budget before spending it. Passing `limiter: null` opts out (used by
  // the limiter's own tests); anything else gets the shared process bucket.
  const bucket = limiter === undefined ? getEmbedLimiter() : limiter;
  const cost = texts.reduce((s, t) => s + estimateTokens(t), 0);
  let attempt = 0;
  // Shrinks are cheap individually but must not become their own runaway: each
  // one costs a round trip, and a batch of 96 could otherwise trade a failure
  // for hundreds of calls. Well above what any real batch needs.
  let shrinks = 0;
  const maxShrinks = 40;
  for (;;) {
    if (bucket) await bucket.reserve(cost);
    let res;
    try {
      // Built fresh on every attempt, inside the retry loop, on purpose: a
      // SigV4 route signs the timestamp and the exact body bytes, so a
      // shrunken batch or a long backoff needs a fresh signature. These are
      // document embeddings — routes with asymmetric encoding (Voyage) encode
      // them differently from queries, into the same space.
      const req = route.buildRequest
        ? route.buildRequest(texts, { inputType: 'document' })
        : {
          url: route.url,
          headers: route.headers(apiKey),
          body: JSON.stringify(route.body(texts)),
        };
      res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
    } catch (netErr) {
      // Network/transport error — treat as transient.
      if (attempt >= maxRetries) throw new Error(`embed network error after ${attempt} retries: ${netErr.message}`);
      await sleep(backoffMs(attempt++, null));
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      return route.parse(data);
    }

    const body = await res.text();

    // "Invalid 'input[8]': maximum input length is 8192 tokens." A character
    // budget can only ever approximate the tokenizer, so the API's own verdict
    // is the authority: shrink the input it named and try again. Only the
    // offending input is cut, and only ever by a quarter at a time, so a
    // passage that is marginally over loses a tail rather than three quarters
    // of itself. Without this, one dense chunk failed its whole document.
    const tooLong = parseOversizedInput(res.status, body);
    if (tooLong !== null && texts[tooLong] && texts[tooLong].length > 500 && shrinks < maxShrinks) {
      shrinks += 1;
      texts = texts.slice();
      texts[tooLong] = texts[tooLong].slice(0, Math.floor(texts[tooLong].length * 0.75));
      continue;
    }

    // The *other* over-length 400: the whole request, not one input.
    //   Invalid 'input': maximum request size is 300000 tokens per request
    // Our batching is estimate-driven and the estimate can only ever be an
    // estimate, so the API's verdict is again the authority — halve the batch
    // and embed each half. Two halves cost two round trips instead of one;
    // throwing here cost 1,641 futile retries on a single document. Recursion
    // terminates at one input, where the only remaining move is to shrink that
    // input, which is what the per-input path above already does.
    if (parseOversizedRequest(res.status, body)) {
      if (texts.length > 1) {
        const mid = Math.ceil(texts.length / 2);
        const head = await embedBatch(apiKey, texts.slice(0, mid), { maxRetries, limiter, route });
        const tail = await embedBatch(apiKey, texts.slice(mid), { maxRetries, limiter, route });
        return head.concat(tail);
      }
      if (texts[0] && texts[0].length > 500 && shrinks < maxShrinks) {
        shrinks += 1;
        texts = [texts[0].slice(0, Math.floor(texts[0].length * 0.75))];
        continue;
      }
    }

    const retryable = res.status === 429 || res.status >= 500;
    const retryAfter = parseFloat(res.headers.get('retry-after')) * 1000;
    // A 429 means the shared budget is tighter than our accounting knew. Stall
    // the whole bucket so every concurrent worker backs off together — retrying
    // only this caller is what let the July import pin the org at its ceiling.
    if (res.status === 429 && bucket) {
      bucket.penalize(Number.isFinite(retryAfter) ? retryAfter : backoffMs(attempt, null));
    }
    if (!retryable || attempt >= maxRetries) {
      throw new Error(`embed ${res.status}${attempt ? ` after ${attempt} retries` : ''}: ${body.slice(0, 400)}`);
    }
    await sleep(backoffMs(attempt++, Number.isFinite(retryAfter) ? retryAfter : null));
  }
}

// Pick the offending index out of an over-length 400 so the caller can shrink
// exactly that input. The API phrases it as:
//   Invalid 'input[8]': maximum input length is 8192 tokens.
// Returns null for any other 400 — a genuinely bad input must still fail fast
// rather than be whittled down until it happens to be accepted.
export function parseOversizedInput(status, body) {
  if (status !== 400 || !body) return null;
  if (!/maximum input length/i.test(body)) return null;
  const m = /input\[(\d+)\]/.exec(body);
  return m ? Number(m[1]) : null;
}

// The per-REQUEST sibling of the above. Same status, same 'input' param, a
// different sentence — and until 2026-08-22 nothing matched it, so a batch
// that was merely too big as a batch died as if it were a malformed request.
// OpenAI has phrased this at least three ways over time:
//   Invalid 'input': maximum request size is 300000 tokens per request
//   Requested 943140 tokens, max 300000 tokens per request
//   ... "code": "max_tokens_per_request"
// All three, and only these, mean "send fewer inputs". Deliberately narrow:
// anything else stays a fail-fast 400 rather than being whittled down until it
// happens to be accepted.
export function parseOversizedRequest(status, body) {
  if (status !== 400 || !body) return false;
  return /max(?:imum)?[ _]tokens[ _]per[ _]request/i.test(body)
      || /tokens\s+per\s+request/i.test(body)
      || /maximum\s+request\s+size/i.test(body);
}

// Exponential backoff with jitter. Honors an explicit retry-after hint when the
// API supplies one. Caps individual waits at 60s.
function backoffMs(attempt, retryAfterMs) {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 60000);
  const base = Math.min(1000 * 2 ** attempt, 60000);
  return base + Math.floor(Math.random() * 1000);
}

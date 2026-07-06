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

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1024;
export const EMBEDDING_BATCH = 96;
export const MAX_PASSAGE_WORDS = 500;

// Token ceilings for the embeddings API. text-embedding-3-small rejects any
// single input over 8192 tokens, and rejects a request whose inputs total over
// 300000 tokens. We batch under both. Token counts are estimated at ~4 chars/
// token (conservative for English; legal text runs a bit denser, so we keep
// healthy margins below the hard limits).
export const MAX_INPUT_TOKENS = 8000;          // per single passage
export const MAX_REQUEST_TOKENS = 250000;      // per embeddings request
const CHARS_PER_TOKEN = 4;
const estimateTokens = (s) => Math.ceil((s || '').length / CHARS_PER_TOKEN);

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

// Extensions we know how to extract text from.
export const SUPPORTED_EXTENSIONS = [
  '.pdf', '.txt', '.md', '.docx', '.epub', '.fountain', '.xlsx',
  // Images: stored as-is, no text extraction. Vault renders them as files.
  // Vision-model captioning / OCR is a future opt-in; for now images are
  // store-and-display only.
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.tif',
  // Audio / video: transcribed to a timestamped transcript via the injected
  // `transcribe` hook (Gemini). Without a hook they store-and-display.
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.aiff', '.wma',
  '.mp4', '.mov', '.mpg', '.mpeg', '.avi', '.webm', '.wmv', '.3gp', '.m4v',
];

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.tif'];

export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.aiff', '.wma'];
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mpg', '.mpeg', '.avi', '.webm', '.wmv', '.3gp', '.m4v'];
export const MEDIA_EXTENSIONS = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS];


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
    .select('id, matterspace_id, witness_name')
    .eq('id', documentId)
    .single();
  if (docErr) throw new Error(`processDocument lookup: ${docErr.message}`);

  const matterspace_id = doc.matterspace_id;
  const effectiveWitness = witnessName || doc.witness_name || null;
  const lowerExt = (ext || '').toLowerCase();

  // Images: store-and-display. The file is already in vault-documents
  // storage; we just flip the row to ready with no passages. Skips the
  // extract → chunk → embed pipeline entirely.
  if (IMAGE_EXTENSIONS.includes(lowerExt)) {
    await supabase
      .from('documents')
      .update({
        processing_status: 'ready',
        ingested_at: new Date().toISOString(),
      })
      .eq('id', documentId);
    onProgress({ stage: 'ready', message: 'Image stored' });
    return { passageCount: 0 };
  }

  // Audio / video: transcribe with the injected hook (Gemini). Without a hook,
  // store-and-display like images — the file stays viewable in the Vault and,
  // crucially, does NOT get shoved through text extraction (which would read the
  // binary as UTF-8 garbage and blow the embeddings token limit).
  if (MEDIA_EXTENSIONS.includes(lowerExt)) {
    if (typeof transcribe !== 'function') {
      await supabase
        .from('documents')
        .update({ processing_status: 'ready', ingested_at: new Date().toISOString() })
        .eq('id', documentId);
      onProgress({ stage: 'ready', message: 'Media stored (no transcription configured)' });
      return { passageCount: 0 };
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
      documentId, matterspace_id, passages, openaiApiKey, onProgress,
    });
  }

  // -- Extract -------------------------------------------------------------
  await setStatus(supabase, documentId, 'extracting');
  onProgress({ stage: 'extracting', message: 'Extracting text' });

  let passages;
  let pageCount;
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
    let pages = await extractPages(fileBuf, lowerExt);

    // Scanned/image-only PDF detection: a born-digital PDF yields plenty of
    // text; a scanned one yields ~nothing from pdf-parse. If the whole document
    // extracted to near-zero characters and an OCR hook is available, OCR it
    // instead of failing with "no passages extracted".
    const extractedChars = pages.reduce((s, p) => s + (p.text || '').trim().length, 0);
    const looksScanned = lowerExt === '.pdf' && extractedChars < Math.max(40, pages.length * 2);
    if (looksScanned && typeof ocr === 'function') {
      onProgress({ stage: 'extracting', message: `No text layer — running OCR on ${pages.length} page(s)` });
      const ocrPages = await ocr(fileBuf);
      if (ocrPages && ocrPages.length) pages = ocrPages;
    }

    pageCount = pages.length;
    await supabase
      .from('documents')
      .update({ page_count: pageCount, processing_status: 'chunking' })
      .eq('id', documentId);
    onProgress({ stage: 'chunking', message: `Chunking ${pageCount} page(s)` });
    passages = chunkPages(pages, { witness_name: effectiveWitness });
  }

  return await embedAndInsert(supabase, {
    documentId, matterspace_id, passages, openaiApiKey, onProgress,
  });
}


// Shared embed + insert tail. Sanitizes passages, embeds them in token-aware
// batches, inserts them, and marks the document ready. Used by every format
// path (documents, transcripts, media) so the normalize/embed/insert logic
// lives in exactly one place.
async function embedAndInsert(supabase, { documentId, matterspace_id, passages, openaiApiKey, onProgress = () => {} }) {
  // Normalize before embed/insert: strip NUL/control chars Postgres rejects,
  // and hard-cap any single passage at the embeddings per-input token limit so
  // one oversized chunk can't 400 the whole batch. Then drop passages that
  // sanitized down to nothing (all-control-char junk).
  for (const p of passages) {
    p.text = sanitizeText(p.text);
    if (estimateTokens(p.text) > MAX_INPUT_TOKENS) {
      p.text = p.text.slice(0, MAX_INPUT_TOKENS * CHARS_PER_TOKEN);
    }
  }
  passages = passages.filter((p) => p.text && p.text.trim().length > 0);

  if (passages.length === 0) {
    await supabase
      .from('documents')
      .update({
        processing_status: 'error',
        processing_error: 'no passages extracted',
      })
      .eq('id', documentId);
    throw new Error('no passages extracted');
  }
  onProgress({ stage: 'embedding', message: `Embedding ${passages.length} passages` });
  await setStatus(supabase, documentId, 'embedding');

  // -- Embed (token-aware batches + retry) --------------------------------
  // Batch under BOTH the per-request count (EMBEDDING_BATCH) and the per-request
  // token ceiling (MAX_REQUEST_TOKENS), so large legal PDFs don't blow the
  // 300k-token request limit. embedBatch() retries 429/5xx with backoff.
  let embedded = 0;
  for (const batch of tokenAwareBatches(passages)) {
    const embeddings = await embedBatch(openaiApiKey, batch.map((p) => p.text));
    batch.forEach((p, idx) => (p.embedding = embeddings[idx]));
    embedded += batch.length;
    onProgress({
      stage: 'embedding',
      message: `Embedded ${embedded}/${passages.length}`,
    });
  }

  // -- Insert passages -----------------------------------------------------
  // Keep chunks small: each insert triggers tsvector generation + vector-index
  // maintenance per row, and text-dense scanned pages (e.g. arrest narratives)
  // can blow the Postgres statement timeout at 200/chunk. 40 stays well under.
  const INSERT_CHUNK = 40;
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
      embedding: p.embedding,
      summary_level: 0,
    }));
    const { error: insErr } = await supabase.from('passages').insert(batch);
    if (insErr) throw new Error(`insert passages: ${insErr.message}`);
  }

  // -- Mark ready ----------------------------------------------------------
  await supabase
    .from('documents')
    .update({
      processing_status: 'ready',
      ingested_at: new Date().toISOString(),
    })
    .eq('id', documentId);
  onProgress({ stage: 'ready', message: `${passages.length} passages indexed` });

  return { passageCount: passages.length };
}


async function setStatus(supabase, documentId, status) {
  await supabase
    .from('documents')
    .update({ processing_status: status })
    .eq('id', documentId);
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
  // Plain text: one big "page". The chunker splits it into passages.
  const buf = fileBuf instanceof Uint8Array ? Buffer.from(fileBuf) : fileBuf;
  return [{ pageNumber: 1, text: buf.toString('utf8') }];
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
  await pdfParse(buffer, options);
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
export async function embedBatch(apiKey, texts, { maxRetries = 6 } = {}) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIM,
          input: texts,
        }),
      });
    } catch (netErr) {
      // Network/transport error — treat as transient.
      if (attempt >= maxRetries) throw new Error(`embed network error after ${attempt} retries: ${netErr.message}`);
      await sleep(backoffMs(attempt++, null));
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      return data.data.map((d) => d.embedding);
    }

    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      throw new Error(`embed ${res.status}${attempt ? ` after ${attempt} retries` : ''}: ${body.slice(0, 400)}`);
    }
    const retryAfter = parseFloat(res.headers.get('retry-after')) * 1000;
    await sleep(backoffMs(attempt++, Number.isFinite(retryAfter) ? retryAfter : null));
  }
}

// Exponential backoff with jitter. Honors an explicit retry-after hint when the
// API supplies one. Caps individual waits at 60s.
function backoffMs(attempt, retryAfterMs) {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 60000);
  const base = Math.min(1000 * 2 ** attempt, 60000);
  return base + Math.floor(Math.random() * 1000);
}

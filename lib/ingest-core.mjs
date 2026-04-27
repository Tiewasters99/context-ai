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

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1024;
export const EMBEDDING_BATCH = 96;
export const MAX_PASSAGE_WORDS = 500;

// Extensions we know how to extract text from.
export const SUPPORTED_EXTENSIONS = ['.pdf', '.txt', '.md', '.docx'];


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

  // -- Extract -------------------------------------------------------------
  await setStatus(supabase, documentId, 'extracting');
  onProgress({ stage: 'extracting', message: 'Extracting text' });

  const pages = await extractPages(fileBuf, ext);
  await supabase
    .from('documents')
    .update({ page_count: pages.length, processing_status: 'chunking' })
    .eq('id', documentId);
  onProgress({ stage: 'chunking', message: `Chunking ${pages.length} page(s)` });

  // -- Chunk ---------------------------------------------------------------
  const passages = chunkPages(pages, { witness_name: effectiveWitness });
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

  // -- Embed ---------------------------------------------------------------
  for (let i = 0; i < passages.length; i += EMBEDDING_BATCH) {
    const batch = passages.slice(i, i + EMBEDDING_BATCH);
    const embeddings = await embedBatch(openaiApiKey, batch.map((p) => p.text));
    batch.forEach((p, idx) => (p.embedding = embeddings[idx]));
    onProgress({
      stage: 'embedding',
      message: `Embedded ${i + batch.length}/${passages.length}`,
    });
  }

  // -- Insert passages -----------------------------------------------------
  const INSERT_CHUNK = 200;
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

async function extractPdfPages(buf) {
  // pdfjs expects a plain Uint8Array and detaches the buffer; feed a fresh copy.
  const data = new Uint8Array(buf);
  const pdf = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const lines = groupItemsIntoLines(content.items);
    pages.push({ pageNumber: i, text: lines.join('\n') });
  }
  return pages;
}

function groupItemsIntoLines(items) {
  const rows = new Map();
  for (const it of items) {
    if (!it.str || !it.transform) continue;
    const y = Math.round(it.transform[5]);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x: it.transform[4], s: it.str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // top-to-bottom
    .map(([_, items]) =>
      items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.s)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
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

function parseTranscriptPage(pageText) {
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
export async function embedBatch(apiKey, texts) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
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
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embed ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

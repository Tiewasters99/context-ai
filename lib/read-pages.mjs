// read_pages — the Orchestrator reads a stored PDF for itself, page by page.
//
// Why (2026-10-27, Eden): a 318-page S-1 dropped into Equazia was unreadable
// to the Orchestrator for as long as indexing took, because every reading
// tool it had (search, get_passage, get_outline) reads the INDEX. ChatGPT and
// Claude in the browser answer about an upload within seconds because the
// model reads the pages directly. This tool gives the in-app Orchestrator the
// same move: cut the pages asked for out of the stored PDF with pdf-lib and
// hand them to the pen as a `document` content block inside the tool result
// (the Messages API accepts text, image, document and search_result blocks
// there — verified against the docs and the SDK's ToolResultBlockParam,
// 2026-10-27). No transcription gate, no OCR, no wait: a scan is read as
// pictures of pages by the pen's own vision, a born-digital page by its text.
//
// What it is NOT: it does not reach the connector (MCP tool results have no
// Anthropic document block), it does not replace the index (search over a
// matter still needs passages), and it is not for a pen that cannot take a
// document block (the Kimi chat route) — the menu does not offer it there.
//
// Budget. A request to the Messages API is capped at 32 MB (Bedrock: 20 MB),
// and every document block sent this turn stays in the request for the rest
// of the turn, so the budget is PER TURN and counts bytes and pages across
// calls. Base64 inflates by 4/3; a page of the S-1 weighs ~250–350 KB
// (fonts embedded per page), so 40 of its pages are 10–14 MB — the plan sizes
// an excerpt by bytes first and trims pages to fit, and says what it left out.
//
// Page numbers: an excerpt is a new PDF whose pages start at 1. The text
// block and the document's title both carry the mapping back to the document's
// own PDF page indices (not printed page numbers — a brief's printed "12" may
// be PDF page 18; the pen is told which it is looking at).

import { resolveDocumentRef } from './mcp-core.mjs';
import { sealedMatterIds } from './ai-tier-policy.mjs';
import { assertPathInMatter } from './storage-path.mjs';

const MB = 1024 * 1024;

/** Pages one call may ask for. More than this is trimmed and said so. */
export const READ_PAGES_MAX_PAGES_PER_CALL = 40;
/** Bytes one call may send, before base64. */
export const READ_PAGES_MAX_BYTES_PER_CALL = 10 * MB;
/** What the rest of the request (history, tools, text results) is allowed. */
export const READ_PAGES_REQUEST_HEADROOM = 4 * MB;
/** Pages per request the API allows: 600, or 100 under a 1M-token window. */
export const READ_PAGES_PAGES_PER_REQUEST = { wide: 600, narrow: 100 };

export const READ_PAGES_TOOL = {
  name: 'read_pages',
  description:
    'Read pages of a stored PDF directly — the pages themselves, as the pen sees them, not the ' +
    'index. Use it when a document is still being indexed ("pending" / "being read now") and the ' +
    'user wants an answer now, when a search cannot find what a page plainly shows (a table, a chart, ' +
    'a signature block, a scan whose OCR is doubtful), or when the user asks you to read specific ' +
    'pages. For an indexed document, search and get_passage are cheaper and cite by page:line — ' +
    'prefer them for a targeted question. One call reads at most ' + READ_PAGES_MAX_PAGES_PER_CALL +
    ' pages and about ' + Math.round(READ_PAGES_MAX_BYTES_PER_CALL / MB) + ' MB; a turn has a total ' +
    'budget, and the result says how much is left. Pages are PDF page indices (page 1 is the first page ' +
    'of the file), not the numbers printed on the pages. The result tells you how the excerpt\'s pages ' +
    'map back to the document, so cite the DOCUMENT\'s page numbers. Only PDFs; for anything else use ' +
    'get_document_text once it is indexed.',
  input_schema: {
    type: 'object',
    properties: {
      document: {
        type: 'string',
        description: 'The document: its UUID (from list_matter_contents, search or check_ingest_status), or its exact title.',
      },
      pages: {
        type: 'string',
        description: 'Which PDF pages, e.g. "1-20", "35", or "5, 9-12". Omit for the first ' + READ_PAGES_MAX_PAGES_PER_CALL + ' pages.',
      },
    },
    required: ['document'],
    additionalProperties: false,
  },
};

/**
 * The turn's document budget for `pen`, or null when the pen cannot take a
 * document block. Mutable: runReadPages draws it down.
 */
export function penDocumentBudget(pen) {
  const max = Number(pen?.documents?.maxRequestBytes);
  if (!Number.isFinite(max) || max <= 0) return null;
  const turnBytes = Math.max(MB, Math.floor((max - READ_PAGES_REQUEST_HEADROOM) * 3 / 4));
  const narrow = Number.isFinite(pen.contextWindow) && pen.contextWindow < 1_000_000;
  return {
    bytesLeft: turnBytes,
    pagesLeft: narrow ? READ_PAGES_PAGES_PER_REQUEST.narrow : READ_PAGES_PAGES_PER_REQUEST.wide,
    callBytes: Math.min(READ_PAGES_MAX_BYTES_PER_CALL, turnBytes),
    callPages: READ_PAGES_MAX_PAGES_PER_CALL,
  };
}

/**
 * "1-20", "35", "5, 9-12", a number, or {from, to} → sorted unique PDF page
 * numbers within 1..pageCount. Throws on nothing usable. More than
 * `cap` pages is trimmed to the first `cap` (the caller says so).
 */
export function parsePageSpec(spec, pageCount, cap = READ_PAGES_MAX_PAGES_PER_CALL) {
  const total = Math.max(1, Math.trunc(Number(pageCount) || 0));
  const want = new Set();
  const add = (a, b) => {
    const lo = Math.max(1, Math.min(a, b));
    const hi = Math.min(total, Math.max(a, b));
    for (let n = lo; n <= hi; n++) want.add(n);
  };
  if (spec == null || spec === '') add(1, Math.min(total, cap));
  else if (typeof spec === 'number') add(spec, spec);
  else if (typeof spec === 'object') {
    const from = Math.trunc(Number(spec.from ?? spec.start ?? 1));
    const to = Math.trunc(Number(spec.to ?? spec.end ?? from));
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('pages: from/to must be numbers');
    add(from, to);
  } else {
    const text = String(spec).replace(/\s+/g, '');
    if (!text) add(1, Math.min(total, cap));
    for (const part of text.split(/[,;]/).filter(Boolean)) {
      const m = part.match(/^(\d+)(?:[-–—](\d+))?$/);
      if (!m) throw new Error(`pages: "${part}" is not a page or a range like 5-12`);
      add(Number(m[1]), m[2] ? Number(m[2]) : Number(m[1]));
    }
  }
  const pages = [...want].sort((a, b) => a - b);
  if (!pages.length) throw new Error(`pages: nothing in 1–${total}`);
  const trimmed = pages.length > cap ? pages.length - cap : 0;
  return { pages: pages.slice(0, cap), trimmed };
}

/**
 * The prefix of `pages` that fits `maxBytes`, by the file's average bytes per
 * page. Always at least one page: a single page over budget is the excerpt
 * step's problem (it measures the real thing).
 */
export function planPages(pages, { fileBytes, pageCount, maxBytes }) {
  const perPage = fileBytes > 0 && pageCount > 0 ? fileBytes / pageCount : 0;
  if (perPage <= 0) return pages;
  const fit = Math.max(1, Math.floor(maxBytes / perPage));
  return pages.slice(0, fit);
}

/** Load a PDF once. */
export async function loadPdf(buf) {
  const { PDFDocument } = await import('pdf-lib');
  return PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
}

/**
 * The excerpt: `pages` (1-based) of `src` as a new PDF, trimmed by halving
 * from the end until it weighs no more than `maxBytes` (a page over budget
 * on its own throws). Returns { bytes, pages } — the pages actually sent.
 */
export async function excerptPdf(src, pages, { maxBytes = READ_PAGES_MAX_BYTES_PER_CALL } = {}) {
  const { PDFDocument } = await import('pdf-lib');
  let keep = pages.slice();
  for (let attempt = 0; attempt < 6; attempt++) {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, keep.map((n) => n - 1));
    for (const p of copied) out.addPage(p);
    const bytes = Buffer.from(await out.save({ useObjectStreams: false }));
    if (bytes.length <= maxBytes) return { bytes, pages: keep };
    if (keep.length === 1) {
      throw new Error(`page ${keep[0]} alone is ${(bytes.length / MB).toFixed(1)} MB, over the ${Math.round(maxBytes / MB)} MB a call may send`);
    }
    keep = keep.slice(0, Math.max(1, Math.ceil(keep.length / 2)));
  }
  throw new Error('could not fit the excerpt inside the budget');
}

/** "1–20" or "5, 9–12": a human reading of a sorted page list. */
export function pageRangesText(pages) {
  const runs = [];
  for (const n of pages) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ');
}

/**
 * The tool result's content: a text block the pen reads first (ids, counts,
 * the page mapping, what was left out, what budget remains) and the document
 * block itself. Pure; `bytes` is the excerpt PDF.
 */
export function excerptBlocks({ document, title, pageCount, pagesSent, pagesAsked, trimmed = 0, bytes, budget }) {
  const sent = pageRangesText(pagesSent);
  const contiguous = pagesSent.every((n, i) => i === 0 || n === pagesSent[i - 1] + 1);
  const mapping = contiguous
    ? `excerpt page k = document page ${pagesSent[0]} + k − 1 (excerpt page 1 is document page ${pagesSent[0]})`
    : `excerpt pages 1…${pagesSent.length} are document pages ${sent}, in that order`;
  const leftOut = pagesAsked.filter((n) => !pagesSent.includes(n));
  const meta = {
    document,
    title,
    page_count: pageCount,
    pages_sent: sent,
    pages_in_excerpt: pagesSent.length,
    mapping,
    page_numbers_are: 'PDF page indices of the stored file, not the numbers printed on the pages',
    ...(leftOut.length ? { not_sent: pageRangesText(leftOut), why: 'over the size budget for one call — call again for them' } : {}),
    ...(trimmed ? { trimmed: `${trimmed} more pages were asked for than one call reads; call again for them` } : {}),
    ...(budget ? { budget_left_this_turn: { pages: budget.pagesLeft, mb: Math.floor(budget.bytesLeft / MB * 10) / 10 } } : {}),
    note: 'Cite the DOCUMENT page numbers, never the excerpt\'s. The attached PDF is the excerpt.',
  };
  return [
    { type: 'text', text: JSON.stringify(meta) },
    {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
      title: `${title} — pages ${sent} (excerpt page 1 = document page ${pagesSent[0]})`,
    },
  ];
}

const PDF_RE = /\.pdf$/i;

/**
 * Find the document `ref` names, within what this turn may read. `matterId`
 * bound → the document must be in that matter's tree. Not the sealed pen →
 * sealed matters are excluded (as callTool's sealOutsidePen does). Returns
 * { doc } or { answer } (the candidates / "none" text to hand back).
 */
export async function locateDocumentForRead(supabase, ref, { matterId = null, sealOutsidePen = true } = {}) {
  const raw = String(ref || '').trim();
  if (!raw) throw new Error('document is required');
  let within = null;
  if (matterId) {
    const { data, error } = await supabase.rpc('matterspace_descendants', { p_root: matterId });
    if (error) throw new Error(`read_pages: ${error.message}`);
    within = new Set([matterId, ...((data ?? []).map((r) => (typeof r === 'string' ? r : r.id ?? r.matterspace_id)).filter(Boolean))]);
  }
  const sealed = sealOutsidePen ? await sealedMatterIds(supabase) : new Set();
  const found = await resolveDocumentRef(supabase, raw, { sealed, within });
  if (!found.id) return { answer: found.answer };

  const { data: doc, error } = await supabase
    .from('documents')
    .select('id, title, doc_type, source_filename, storage_path, file_size_bytes, page_count, matterspace_id, processing_status')
    .eq('id', found.id)
    .maybeSingle();
  if (error) throw new Error(`read_pages: ${error.message}`);
  if (!doc) return { answer: { document: null, ref: raw, note: 'No such document is visible to you.' } };
  // The same two refusals a UUID would otherwise slip past: the tree and the seal.
  if (within && !within.has(doc.matterspace_id)) {
    return { answer: { document: null, ref: raw, note: 'That document is not in this matter. Open its matter to read it there.' } };
  }
  if (sealed.has(doc.matterspace_id)) {
    return { answer: { document: null, ref: raw, note: 'That document is inside a sealed matter, which this turn does not reach.' } };
  }
  if (!doc.storage_path) return { answer: { document: doc.id, ref: raw, note: 'This document has no stored file to read.' } };
  return { doc };
}

/**
 * Download the stored file. 097: the path must live under the document's own
 * matter before any service-role read.
 */
export async function downloadDocumentFile(supabase, doc) {
  assertPathInMatter(doc.storage_path, doc.matterspace_id);
  const { data, error } = await supabase.storage.from('vault-documents').download(doc.storage_path);
  if (error) throw new Error(`read_pages: download "${doc.title}": ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

/**
 * The tool, end to end. Returns { content, is_error } — `content` is the
 * block array on success, a string on refusal. `budget` (penDocumentBudget)
 * is drawn down in place. `deps` lets the harness stub the slow parts.
 */
export async function runReadPages(supabase, args, { matterId = null, sealOutsidePen = true, budget = null, deps = {} } = {}) {
  const locate = deps.locate ?? locateDocumentForRead;
  const download = deps.download ?? downloadDocumentFile;
  const load = deps.load ?? loadPdf;
  const refuse = (text) => ({ content: `Error: ${text}`, is_error: true });

  if (!budget) return refuse('this pen cannot be handed pages directly. Use search, get_passage or get_document_text instead.');
  if (budget.pagesLeft <= 0 || budget.bytesLeft < MB) {
    return refuse(`the page budget for this turn is spent (${budget.pagesLeft} pages, ${(budget.bytesLeft / MB).toFixed(1)} MB left). Answer from what you have read, or ask the user to continue in a new message.`);
  }

  let located;
  try {
    located = await locate(supabase, args?.document, { matterId, sealOutsidePen });
  } catch (err) {
    return refuse(err.message);
  }
  if (!located.doc) return { content: JSON.stringify(located.answer), is_error: false };
  const doc = located.doc;
  const isPdf = PDF_RE.test(String(doc.source_filename || '')) || PDF_RE.test(String(doc.title || '')) || doc.doc_type === 'pdf';
  if (!isPdf) {
    return refuse(`"${doc.title}" is not a PDF. read_pages reads stored PDFs only; for this file use get_document_text or search once it is indexed (check_ingest_status says when).`);
  }

  let buf;
  try {
    buf = await download(supabase, doc);
  } catch (err) {
    return refuse(err.message);
  }
  let src;
  try {
    src = await load(buf);
  } catch (err) {
    return refuse(`"${doc.title}" could not be opened as a PDF (${err.message}). If it is encrypted or damaged, the index is the only way in.`);
  }
  const pageCount = src.getPageCount();
  if (!pageCount) return refuse(`"${doc.title}" has no pages.`);

  let asked;
  try {
    asked = parsePageSpec(args?.pages, pageCount, Math.min(budget.callPages, budget.pagesLeft));
  } catch (err) {
    return refuse(`${err.message} ("${doc.title}" has ${pageCount} pages).`);
  }
  const callBytes = Math.min(budget.callBytes, budget.bytesLeft);
  const planned = planPages(asked.pages, { fileBytes: buf.length, pageCount, maxBytes: callBytes });
  let excerpt;
  try {
    excerpt = await (deps.excerpt ?? excerptPdf)(src, planned, { maxBytes: callBytes });
  } catch (err) {
    return refuse(`${err.message}. Ask for fewer pages.`);
  }
  budget.bytesLeft -= excerpt.bytes.length;
  budget.pagesLeft -= excerpt.pages.length;
  return {
    content: excerptBlocks({
      document: doc.id,
      title: doc.title || doc.source_filename || doc.id,
      pageCount,
      pagesSent: excerpt.pages,
      pagesAsked: asked.pages,
      trimmed: asked.trimmed,
      bytes: excerpt.bytes,
      budget,
    }),
    is_error: false,
  };
}

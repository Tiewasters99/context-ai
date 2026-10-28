// How far the pipeline has got with one document, as a number for a bar and a
// sentence for the row beside it — read from what the worker already writes.
//
// The worker records two things while it works (worker/discovery-worker.mjs
// progress()): an integer, processing_jobs.progress, that is only the STAGE
// (20 for the whole of extraction, however long the OCR pass runs), and a
// sentence, processing_jobs.progress_note, in which the OCR loop counts pages
// as it goes (lib/ocr-protocol.mjs: "OCR via AWS Textract (us-east-1)
// 120/318 pages"). The page count is the one number a person waiting on a
// 300-page scan wants, so this module reads it out of the sentence and lays
// the stages end to end on a 0–100 bar. The integer is kept as a floor.
//
// Pure: no database, no clock. The browser (src/components/vault/IngestProgress
// .tsx) and the harness (scripts/_test-ingest-progress.mjs) share it.

/** The reason it takes time at all, in the words the row shows on hover. */
export const INGEST_WHY =
  'Every page is read, OCR’d where it is a scan, and indexed so the AI can search it and cite it by page. ' +
  'A plain file store does none of this, which is why a drop into OneDrive is instant and this is not. ' +
  'A PDF can be opened and read while that work finishes.';

/** The same, in the few words that fit beside the bar. */
export const INGEST_WHY_SHORT = 'read, OCR’d and indexed so the AI can cite it';

// Where each stage sits on the bar. Extraction is the long one: on a scan it
// is the OCR pass, and the page fraction moves the bar across its span.
const SPAN = Object.freeze({
  pending: [0, 3],
  downloading: [3, 6],
  extracting: [6, 72],
  chunking: [72, 82],
  embedding: [82, 99],
  ready: [100, 100],
});

const STAGES = Object.keys(SPAN);

const str = (v) => (typeof v === 'string' ? v : '');
const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null);

/**
 * The numbers in a progress note. Null when the sentence counts nothing.
 *   { done, total }          — "… 120/318 pages", "OCR read 120 of 318 page(s)"
 *   { done: 0, total }       — "…: 318 page(s) in 40 window(s)" (the pass is starting)
 *   { done: 0, total, pageCount } — "Running OCR on 40 of 318 page(s) (the rest …)"
 *   { pageCount }            — "Chunking 318 page(s)"
 *   { passages }             — "Embedding 711 passages"
 * A retry note ("Attempt 1 of 3 failed — …") is not a page count and is
 * never read as one.
 */
export function parseProgressNote(note) {
  const s = str(note);
  if (!s || /\battempt\b/i.test(s)) return null;
  let m = s.match(/(\d+)\s*\/\s*(\d+)\s*pages?\b/i);
  if (m) return { done: +m[1], total: +m[2] };
  m = s.match(/OCR read (\d+) of (\d+) page/i);
  if (m) return { done: +m[1], total: +m[2] };
  m = s.match(/Running OCR on (\d+) of (\d+) page/i);
  if (m) return { done: 0, total: +m[1], pageCount: +m[2] };
  m = s.match(/:\s*(\d+) page\(s\) in \d+ window/i);
  if (m) return { done: 0, total: +m[1] };
  m = s.match(/Chunking (\d+) page/i);
  if (m) return { pageCount: +m[1] };
  m = s.match(/Embedding (\d+) passages?/i);
  if (m) return { passages: +m[1] };
  return null;
}

// documents.processing_status is the stage; the note refines the first one
// (the download happens inside 'pending', before the pipeline sets a stage).
function stageOf(stage, note) {
  const s = str(stage).toLowerCase();
  if (s === 'ready') return 'ready';
  if (STAGES.includes(s)) {
    if (s === 'pending' && /^Downloading\b/i.test(str(note))) return 'downloading';
    return s;
  }
  // A pipeline newer than this table, or no stage yet: the long middle.
  return s ? 'extracting' : 'pending';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One reading for one document.
 *   stage     documents.processing_status (pending / extracting / chunking /
 *             embedding / ready); anything else counts as the long middle.
 *   progress  processing_jobs.progress — the worker's integer, a floor only.
 *   note      processing_jobs.progress_note — the worker's sentence.
 *   pageCount documents.page_count, once the pipeline has read the page tree.
 *   attempts  processing_jobs.attempts; above 1 the row is a retry.
 * Returns { pct, label, detail, pages, indeterminate, retrying }: pct is the
 * bar (0–100, 100 only at ready); label the words beside it; detail the
 * worker's own sentence for hover; pages the fraction when one is known;
 * indeterminate when nothing counts yet (the bar pulses rather than lies).
 */
export function readIngestProgress({ stage, progress, note, pageCount, attempts } = {}) {
  const st = stageOf(stage, note);
  const span = SPAN[st];
  const counted = parseProgressNote(note);
  const docPages = int(pageCount) ?? int(counted?.pageCount) ?? null;
  const retrying = (int(attempts) ?? 0) > 1;
  const detail = str(note).trim() || null;

  if (st === 'ready') {
    return { pct: 100, label: 'Ready', detail, pages: null, indeterminate: false, retrying: false };
  }

  let pct = span[0];
  let pages = null;
  if (counted && Number.isFinite(counted.total) && counted.total > 0 && Number.isFinite(counted.done)) {
    pages = { done: Math.min(counted.done, counted.total), total: counted.total };
    pct = span[0] + (span[1] - span[0]) * (pages.done / pages.total);
  }
  // The worker's integer is the stage's own floor — never a ceiling, since
  // it sits at 20 for the whole of a 300-page OCR pass.
  const floor = int(progress);
  if (floor != null) pct = Math.max(pct, Math.min(99, floor));
  pct = Math.max(0, Math.min(99, Math.round(pct)));

  let label;
  switch (st) {
    case 'pending': label = 'Queued'; break;
    case 'downloading': label = 'Fetching the file'; break;
    case 'extracting':
      if (pages && pages.done > 0) label = `OCR: ${pages.done} of ${plural(pages.total, 'page')} read`;
      else if (pages) label = `Reading ${plural(pages.total, 'scanned page')}`;
      else if (/\bOCR\b/.test(str(note))) label = 'Running OCR';
      else label = 'Extracting text';
      break;
    case 'chunking':
      label = docPages ? `Splitting ${plural(docPages, 'page')} into passages` : 'Splitting into passages';
      break;
    case 'embedding': {
      const n = int(counted?.passages);
      label = n ? `Indexing ${plural(n, 'passage')} for search` : 'Indexing for search';
      break;
    }
    default: label = 'Working';
  }
  if (retrying) label = `Retrying — ${label.charAt(0).toLowerCase()}${label.slice(1)}`;

  return { pct, label, detail, pages, indeterminate: !pages, retrying };
}

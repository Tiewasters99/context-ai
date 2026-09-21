// What an upload is about to cost, before a byte moves — and the server's
// check that the browser did the same arithmetic.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The Bucketizer quotes a bulk classify before it runs (src/lib/bucketizer/
// estimate.ts, PR #168). Ingestion did not: a 900-page scanned production, a
// folder of four hundred exhibits or three hours of deposition video drew on
// the month's allowance with nothing said in advance. Eden asked the obvious
// question — "the cost estimate is only in the Bucketizer flow? What if you
// are just ingesting large documents" — and the answer is yes, but only above
// a threshold. An ordinary upload must stay one gesture with no dialog in it;
// a big one has to say what it will cost first.
//
// RULES THIS MODULE KEEPS
// ---------------------------------------------------------------------------
// 1. NO PRICE IS INVENTED. Every rate comes from lib/usage-prices.mjs, which
//    is the table the meter (migration 063) charges from. What this file adds
//    is counting — pages, minutes, passages — and the arithmetic over them.
// 2. Everything is deterministic. No model is asked what a file might cost
//    (feedback: agent-economics-deterministic-first).
// 3. It errs HIGH, in the same direction the meter's own pre-charge does, and
//    it says on what basis. Where the truth cannot be known before the file is
//    read — a PDF is born-digital text or a scan, and nothing outside the file
//    can tell you which — it gives a RANGE rather than a number.
// 4. It runs in both places. The browser imports it to draw the dialog; the
//    handler imports it to check that an above-threshold request was actually
//    confirmed, and to recompute the figure rather than believe the client's.
//    So: no Node built-ins, no `process`, no imports that reach for either.
//    (lib/ocr-routes.mjs is safe — its provider imports are all inside run().)
//
// WHAT IT DOES NOT CLAIM
// ---------------------------------------------------------------------------
// The meter does not yet charge per OCR page or per minute of audio: PR #161
// deferred that to the Fly worker, where the pages are counted, and /api/ingest
// pre-charges only the INLINE slice (embedding, plus one OCR call for a scanned
// JPEG/PNG). This estimate prices pages and minutes anyway, because those are
// the costs a person is about to incur on the workspace's provider keys whether
// or not a counter has caught up with them. That is why the dialog says
// "estimated cost" and shows the wallet beside it, and never says "you will be
// charged $X".

import {
  estimateIngestCents,
  estimateOcrCents,
  EMBED_USD_PER_MTOK,
  DEEPGRAM_USD_PER_MINUTE,
} from './usage-prices.mjs';
import {
  MEDIA_EXTENSIONS,
  AUDIO_EXTENSIONS,
  OCRABLE_IMAGE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  BINARY_ASSET_EXTENSIONS,
  extOf,
} from './ingest-formats.mjs';
import { tierRouteIds } from './ocr-routes.mjs';

// ---------------------------------------------------------------------------
// THE THRESHOLD. One object, four independent triggers, and nothing below it.
//
// Four rather than one because each catches something the others cannot:
//
//   cents        The money. $1.00 is the smallest figure worth interrupting a
//                person for — below it the dialog costs more than the upload
//                does. It is also about a fifteenth of the free tier's whole
//                monthly allowance ($15.00, migration 063), so one drop at
//                this line is a visible share of the month.
//
//   files        The gesture. A drop of 25 files is already past the point
//                where the Vault can name what is happening — its refusal
//                notice shows three files and then "…and N more" — and it is
//                a fifth of the free tier's 120-documents-an-hour ingest
//                window (063) spent in one movement.
//
//   mediaMinutes A recording. 20 minutes is a third of the 60-minute session
//                usage-prices already assumes for a transcription credential,
//                and the point at which "this is a voice memo" stops being
//                true. Under it the metered per-minute rate is under 9 cents,
//                so the money trigger alone would never fire on a recording.
//
//   pdfPages     A document nobody reads in one sitting. At the unsealed
//                tier's own OCR rate ($0.002/page) 200 scanned pages is 40
//                cents — UNDER the money line. So without a page trigger the
//                largest single thing anyone uploads would be the one thing
//                never quoted.
//
// Remembered nowhere. Every drop is judged on its own.
// ---------------------------------------------------------------------------
export const UPLOAD_ESTIMATE_THRESHOLDS = Object.freeze({
  cents: 100,
  files: 25,
  mediaMinutes: 20,
  pdfPages: 200,
});

// ---------------------------------------------------------------------------
// Size heuristics. NOT prices — these turn bytes into pages, minutes and
// characters when the real figure could not be measured, and every one of them
// is labelled in the dialog wherever it was used.
// ---------------------------------------------------------------------------

/**
 * Characters of extracted text per page. Same number, and the same reasoning,
 * as ASSUMED_CHARS_PER_PAGE in src/lib/bucketizer/estimate.ts: a deposition
 * page is ~1,100 characters, a dense brief ~2,000, and the estimate must not
 * come in under the truth.
 */
export const ASSUMED_CHARS_PER_PAGE = 2_400;

/**
 * Characters of transcript per minute of speech. 180 words a minute at ~6
 * characters a word — the fast end of dictation, so the transcript's indexing
 * cost is over-stated rather than under-stated.
 */
export const ASSUMED_TRANSCRIPT_CHARS_PER_MINUTE = 1_100;

/**
 * Bytes per page when a PDF's page count could not be read (too large to parse
 * in the tab, encrypted, or the parse ran past the measuring budget). 60 KB is
 * beneath a 300-dpi scanned page and above a born-digital one, so the page
 * count it produces is high rather than low.
 */
export const ASSUMED_BYTES_PER_PAGE = 60 * 1024;

/**
 * The SERVER's fallback bytes-per-page, used only when a request declares no
 * page count at all — and deliberately the opposite bias.
 *
 * The browser's figure errs high because a quote that comes in under the truth
 * is the failure that matters. The handler's errs LOW, because its figure
 * decides whether an upload is refused, and refusing an honest upload is worse
 * than letting a big one through to the meter. 250 KB is a colour-scanned
 * page at 300 dpi: a 13 MB PDF of 50 photographed pages resolves to about 52
 * pages here rather than the 222 the browser's number would give — which is
 * the case where the two biases would otherwise disagree and a perfectly
 * ordinary upload would be told to go and confirm a dialog nobody showed it.
 * A file large enough to matter with nothing declared (a 500 MB PDF, 2,000
 * pages at this rate) is still caught.
 */
export const FLOOR_BYTES_PER_PAGE = 250 * 1024;

/**
 * Bytes per minute when a recording's duration could not be read. Two numbers,
 * because the same 20 MB is 40 minutes of podcast audio or 2 minutes of phone
 * video, and which way to err depends on which end of the range is being
 * computed:
 *   SPARSE — a low bitrate, so MORE minutes: the upper bound, and the floor
 *            the dialog quotes.
 *   DENSE  — a high bitrate, so FEWER minutes: the lower bound, and the only
 *            figure the server will hold a caller to when they declare nothing.
 */
export const ASSUMED_AUDIO_BYTES_PER_MINUTE_SPARSE = 512 * 1024;   // ~68 kbps
export const ASSUMED_AUDIO_BYTES_PER_MINUTE_DENSE = 3 * 1024 * 1024; // ~400 kbps
export const ASSUMED_VIDEO_BYTES_PER_MINUTE_SPARSE = 8 * 1024 * 1024;  // ~1 Mbps
export const ASSUMED_VIDEO_BYTES_PER_MINUTE_DENSE = 60 * 1024 * 1024;  // ~8 Mbps

/**
 * How much more text a zip-compressed container holds than its bytes suggest.
 * PR #169 put the fact plainly when it cut the worker-routing ceiling for
 * these types to 1 MB: "1 MB of prose unzips to several MB, and nothing can
 * measure that before the download."
 */
export const CONTAINER_TEXT_FACTOR = 4;
const CONTAINER_EXTENSIONS = ['.docx', '.pptx', '.xlsx', '.epub'];

/** Extensions that are stored and displayed, never read — so never charged. */
const STORED_ONLY_EXTENSIONS = [
  ...BINARY_ASSET_EXTENSIONS,
  ...IMAGE_EXTENSIONS.filter((e) => !OCRABLE_IMAGE_EXTENSIONS.includes(e)),
];

// ---------------------------------------------------------------------------
// Which OCR route reads this matter's pages, and what it charges.
// ---------------------------------------------------------------------------

/**
 * The route id the tier's POLICY names first — the one that will read the
 * pages unless it is down. Tier A is gemini-flash by default and is
 * overridable with OCR_TIER_A_ROUTES; Tier B is AWS Textract and takes no
 * override; Tier C has no cloud route at all, so its scans cost nothing here
 * because they are never sent.
 *
 * `env` defaults to an EMPTY object rather than process.env: this module is in
 * the browser bundle, where `process` does not exist. The handler passes its
 * own env, which is what makes the server's recomputation follow an
 * OCR_TIER_A_ROUTES flip that the browser could not have known about.
 */
export function ocrRouteForTier(tier, env = {}) {
  const ids = tierRouteIds(tier ?? 'A', env);
  return ids[0] ?? null;
}

/** True when this tier's pages stay inside the seal (and so does its price). */
export function isSealedTier(tier) {
  return tier === 'B' || tier === 'C';
}

// ---------------------------------------------------------------------------
// One file.
// ---------------------------------------------------------------------------

const centsUp = (usd) => Math.max(0, Math.ceil(usd * 100));
const embedCentsForChars = (chars) =>
  centsUp(((Math.max(0, chars) / 3) / 1e6) * EMBED_USD_PER_MTOK);

/**
 * @typedef {object} UploadItem
 * @property {string} name        the file's name, as the person will read it
 * @property {number} bytes       its size
 * @property {number} [pages]     PDF pages, when they were read from the file
 * @property {number} [minutes]   duration, when it was read from the file
 * @property {string} [ext]       overrides the extension taken from `name`
 */

/**
 * What one file costs, as a range.
 *
 * The range exists because of one thing that cannot be known before the file
 * is read: whether a PDF's pages carry a text layer or are pictures of pages.
 * The low bound is the born-digital reading (index the text, embed it); the
 * high bound is every page a scan (OCR each page, then embed what came back).
 * Nothing else in the pipeline has that ambiguity, so for every other type the
 * two bounds are the same number unless the page count or duration itself had
 * to be guessed from the bytes.
 */
export function estimateUploadItem(item, { tier = 'A', env = {} } = {}) {
  const name = String(item?.name ?? '');
  const ext = String(item?.ext ?? extOf(name)).toLowerCase();
  const bytes = Math.max(0, Number(item?.bytes) || 0);
  const route = ocrRouteForTier(tier, env);
  const basis = [];

  const declaredPages = positive(item?.pages);
  const declaredMinutes = positive(item?.minutes);

  // --- audio / video -------------------------------------------------------
  if (MEDIA_EXTENSIONS.includes(ext)) {
    const audio = AUDIO_EXTENSIONS.includes(ext);
    const sparse = audio ? ASSUMED_AUDIO_BYTES_PER_MINUTE_SPARSE : ASSUMED_VIDEO_BYTES_PER_MINUTE_SPARSE;
    const dense = audio ? ASSUMED_AUDIO_BYTES_PER_MINUTE_DENSE : ASSUMED_VIDEO_BYTES_PER_MINUTE_DENSE;
    const minutesKnown = declaredMinutes !== null;
    const highMinutes = declaredMinutes ?? ceilTo(bytes / sparse);
    const lowMinutes = declaredMinutes ?? ceilTo(bytes / dense);
    if (!minutesKnown) basis.push('length estimated from the file size');
    return {
      name, ext, kind: 'media', bytes,
      pages: 0, pagesKnown: true,
      minutes: highMinutes, minutesKnown,
      lowCents: transcribeCents(lowMinutes),
      highCents: transcribeCents(highMinutes),
      basis,
    };
  }

  // --- a scanned page saved as a picture -----------------------------------
  if (OCRABLE_IMAGE_EXTENSIONS.includes(ext)) {
    // One image is one page. A multi-page .tif is the exception and is worth
    // more than this says; the pipeline reads its pages, this counts the file.
    const cents = estimateOcrCents(1, { route: route ?? 'unknown' })
      + embedCentsForChars(ASSUMED_CHARS_PER_PAGE);
    basis.push('one page, read by OCR');
    return {
      name, ext, kind: 'image', bytes,
      pages: 1, pagesKnown: true, minutes: 0, minutesKnown: true,
      lowCents: route ? cents : 0,
      highCents: route ? cents : 0,
      basis,
    };
  }

  // --- stored and displayed, never read ------------------------------------
  if (STORED_ONLY_EXTENSIONS.includes(ext)) {
    return {
      name, ext, kind: 'stored', bytes,
      pages: 0, pagesKnown: true, minutes: 0, minutesKnown: true,
      lowCents: 0, highCents: 0,
      basis: ['stored to view or download — nothing is read from it'],
    };
  }

  // --- PDF -----------------------------------------------------------------
  if (ext === '.pdf') {
    const pagesKnown = declaredPages !== null;
    const pages = declaredPages ?? Math.max(1, ceilTo(bytes / ASSUMED_BYTES_PER_PAGE));
    if (!pagesKnown) basis.push('page count estimated from the file size');
    const textChars = pages * ASSUMED_CHARS_PER_PAGE;
    const low = embedCentsForChars(textChars);
    const ocr = route ? estimateOcrCents(pages, { route }) : 0;
    const high = ocr + embedCentsForChars(textChars);
    basis.push(route
      ? 'the upper figure assumes every page is a scan'
      : 'this matter sends no page to an OCR provider, so a scan is stored unread');
    return {
      name, ext, kind: 'pdf', bytes,
      pages, pagesKnown, minutes: 0, minutesKnown: true,
      lowCents: low, highCents: high,
      basis,
    };
  }

  // --- everything else: text, and the containers that hold more than they
  //     weigh ------------------------------------------------------------
  const container = CONTAINER_EXTENSIONS.includes(ext);
  const low = estimateIngestCents({ bytes });
  const high = container ? estimateIngestCents({ bytes: bytes * CONTAINER_TEXT_FACTOR }) : low;
  if (container) basis.push('a compressed document holds more text than it weighs');
  return {
    name, ext, kind: 'text', bytes,
    pages: 0, pagesKnown: true, minutes: 0, minutesKnown: true,
    lowCents: low, highCents: high,
    basis,
  };
}

function transcribeCents(minutes) {
  const m = Math.max(0, minutes);
  return centsUp(m * DEEPGRAM_USD_PER_MINUTE)
    + embedCentsForChars(m * ASSUMED_TRANSCRIPT_CHARS_PER_MINUTE);
}

function positive(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function ceilTo(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.ceil(v) : 0;
}

// ---------------------------------------------------------------------------
// A whole drop.
// ---------------------------------------------------------------------------

/**
 * Price every file in one gesture, and count what the threshold is about to be
 * judged on. Order is preserved: "what would fit" walks this list.
 */
export function estimateUpload(items, { tier = 'A', env = {} } = {}) {
  const list = (Array.isArray(items) ? items : []).map((it) => estimateUploadItem(it, { tier, env }));
  let lowCents = 0;
  let highCents = 0;
  let pdfPages = 0;
  let mediaMinutes = 0;
  let largestPdfPages = 0;
  let longestMediaMinutes = 0;
  let unknownPages = 0;
  let unknownMinutes = 0;
  for (const it of list) {
    lowCents += it.lowCents;
    highCents += it.highCents;
    if (it.kind === 'pdf') {
      pdfPages += it.pages;
      if (it.pages > largestPdfPages) largestPdfPages = it.pages;
      if (!it.pagesKnown) unknownPages += 1;
    }
    if (it.kind === 'image') pdfPages += it.pages;
    if (it.kind === 'media') {
      mediaMinutes += it.minutes;
      if (it.minutes > longestMediaMinutes) longestMediaMinutes = it.minutes;
      if (!it.minutesKnown) unknownMinutes += 1;
    }
  }
  return {
    items: list,
    files: list.length,
    lowCents,
    highCents,
    pdfPages,
    mediaMinutes,
    largestPdfPages,
    longestMediaMinutes,
    unknownPages,
    unknownMinutes,
    tier,
    sealed: isSealedTier(tier),
    ocrRoute: ocrRouteForTier(tier, env),
  };
}

/**
 * Is this drop big enough to be worth stopping for, and — in words — why.
 * Below it there is no dialog and the request flow is untouched.
 */
export function thresholdVerdict(estimate, thresholds = UPLOAD_ESTIMATE_THRESHOLDS) {
  const t = { ...UPLOAD_ESTIMATE_THRESHOLDS, ...(thresholds || {}) };
  const reasons = [];
  if (estimate.highCents >= t.cents) {
    reasons.push(`the estimate reaches ${formatCents(estimate.highCents)}`);
  }
  if (estimate.files >= t.files) {
    reasons.push(`${estimate.files.toLocaleString()} files at once`);
  }
  if (estimate.longestMediaMinutes > t.mediaMinutes) {
    reasons.push(`a recording of about ${Math.round(estimate.longestMediaMinutes)} minutes`);
  }
  if (estimate.largestPdfPages > t.pdfPages) {
    reasons.push(`a document of about ${estimate.largestPdfPages.toLocaleString()} pages`);
  }
  return { over: reasons.length > 0, reasons };
}

/**
 * How much of this drop fits in what is left.
 *
 * Walks the files IN ORDER, accumulating upper bounds, and stops at the first
 * one that would not fit. The point is the sentence it makes possible: not
 * "this may fail", but "the first 36 of these 400 fit; the rest would not" —
 * said before anything is uploaded rather than discovered at file 37.
 *
 * `remainingCents` null means unlimited or unknown; then everything fits and
 * nothing is blocked.
 */
export function whatFits(estimate, remainingCents) {
  if (remainingCents === null || remainingCents === undefined) {
    return { exceeds: false, fitsCount: estimate.files, fitsCents: estimate.highCents };
  }
  const left = Math.max(0, Number(remainingCents) || 0);
  let spent = 0;
  let count = 0;
  for (const it of estimate.items) {
    if (spent + it.highCents > left) break;
    spent += it.highCents;
    count += 1;
  }
  return {
    exceeds: estimate.highCents > left,
    fitsCount: count,
    fitsCents: spent,
    remainingCents: left,
  };
}

// ---------------------------------------------------------------------------
// The declaration: what the browser tells the server it measured.
// ---------------------------------------------------------------------------

/**
 * The per-document half of an above-threshold confirmation. Sent ONLY for a
 * drop that showed the dialog; below the threshold the request body is the
 * same `{ documentId }` it has always been (see ingestRequestBody).
 */
export function declarationFor(item, { confirmed = true } = {}) {
  return {
    confirmed: Boolean(confirmed),
    pages: item.pages || 0,
    minutes: item.minutes || 0,
    ack_cents: item.highCents || 0,
  };
}

/**
 * The exact body of a POST to /api/ingest.
 *
 * Exported so that "an ordinary upload's request is byte-identical to what it
 * was before this change" is a thing a test can assert rather than a thing a
 * reviewer has to believe.
 */
export function ingestRequestBody(documentId, declaration) {
  if (!declaration) return JSON.stringify({ documentId });
  return JSON.stringify({ documentId, estimate: declaration });
}

// ---------------------------------------------------------------------------
// The server's half.
// ---------------------------------------------------------------------------

/**
 * Cents this ONE document could cost, recomputed from what the server can see,
 * never from what the client says it costs.
 *
 * Three rules:
 *   1. the BYTES are the storage row's own `file_size_bytes` and the name is
 *      the row's own `source_filename` — neither is a number in the request
 *      body, so the file's class and scale cannot be misdescribed;
 *   2. a page count or duration that was actually MEASURED wins — the largest
 *      of what the client declared and what the row already records. The
 *      browser opened the file; the handler has not;
 *   3. only when nothing at all was measured does the size decide, and then
 *      at FLOOR_BYTES_PER_PAGE / the dense-bitrate rate — the cautious end, so
 *      this never refuses an upload the browser correctly judged small.
 *
 * What it does NOT do is believe the client's ARITHMETIC. The cents are
 * recomputed here from the price table; `ack_cents` is only ever compared
 * against them.
 */
export function recomputeDocumentEstimate(doc, declared, { tier = 'A', env = {} } = {}) {
  const bytes = Math.max(0, Number(doc?.file_size_bytes) || 0);
  const name = String(doc?.source_filename || '');
  const ext = extOf(name);
  const audio = AUDIO_EXTENSIONS.includes(ext);

  const measuredPages = Math.max(positive(declared?.pages) ?? 0, positive(doc?.page_count) ?? 0);
  const measuredMinutes = positive(declared?.minutes) ?? 0;

  const pages = measuredPages || (ext === '.pdf'
    ? Math.max(1, ceilTo(bytes / FLOOR_BYTES_PER_PAGE))
    : 0);
  const minutes = measuredMinutes || (MEDIA_EXTENSIONS.includes(ext)
    ? ceilTo(bytes / (audio ? ASSUMED_AUDIO_BYTES_PER_MINUTE_DENSE : ASSUMED_VIDEO_BYTES_PER_MINUTE_DENSE))
    : 0);

  return estimateUploadItem(
    { name, ext, bytes, pages: pages || undefined, minutes: minutes || undefined },
    { tier, env },
  );
}

/** Does this one document, on its own, owe the person a quote first? */
export function documentNeedsConfirmation(item, thresholds = UPLOAD_ESTIMATE_THRESHOLDS) {
  const t = { ...UPLOAD_ESTIMATE_THRESHOLDS, ...(thresholds || {}) };
  return item.highCents >= t.cents
    || (item.kind === 'pdf' && item.pages > t.pdfPages)
    || (item.kind === 'media' && item.minutes > t.mediaMinutes);
}

/**
 * How far below the server's own figure a client's acknowledged number may sit
 * before it counts as a forgery rather than a rounding difference. The browser
 * measures the real page count and the server may be estimating from bytes, so
 * the two legitimately differ; half is generous to an honest client and
 * useless to a dishonest one, which cannot get under the threshold without
 * failing the pages/minutes test above as well.
 */
const ACK_TOLERANCE = 0.5;

/**
 * The handler's whole check, in one call.
 *
 * Returns null when the request may proceed, or `{ status, error, message }`
 * to answer with. The message is written for a person: src/lib/llm/refusals.ts
 * renders any 4xx body carrying `message` verbatim into the banner PR #171
 * added, so this reaches the screen as a sentence rather than a code.
 *
 * Called BEFORE consumeUsage, so a refusal costs nothing.
 */
export function verifyIngestConfirmation({ doc, body, tier = 'A', env = {}, thresholds } = {}) {
  const declared = body && typeof body === 'object' ? body.estimate : null;
  const item = recomputeDocumentEstimate(doc, declared, { tier, env });
  if (!documentNeedsConfirmation(item, thresholds)) return null;

  const what = describeItem(item);
  if (!declared || declared.confirmed !== true) {
    return {
      status: 400,
      error: 'estimate_confirmation_required',
      message: `"${item.name}" is large enough to be quoted before it is read — ${what}, ` +
        `an estimated ${formatCents(item.lowCents)}–${formatCents(item.highCents)}. ` +
        'Upload it from the Vault, where that estimate is shown and confirmed, rather than re-sending this request.',
      estimate: { pages: item.pages, minutes: item.minutes, low_cents: item.lowCents, high_cents: item.highCents },
    };
  }

  const ack = Math.max(0, Number(declared.ack_cents) || 0);
  if (ack < item.highCents * ACK_TOLERANCE) {
    return {
      status: 400,
      error: 'estimate_mismatch',
      message: `The estimate confirmed for "${item.name}" (${formatCents(ack)}) is lower than this file ` +
        `can cost (${what}, up to ${formatCents(item.highCents)}). Nothing was read. ` +
        'Start the upload again from the Vault so the figure you confirm is the figure for this file.',
      estimate: { pages: item.pages, minutes: item.minutes, low_cents: item.lowCents, high_cents: item.highCents },
    };
  }
  return null;
}

function describeItem(item) {
  if (item.kind === 'media') {
    return `about ${Math.round(item.minutes).toLocaleString()} minute${Math.round(item.minutes) === 1 ? '' : 's'} of recording`;
  }
  if (item.kind === 'pdf') {
    return `about ${item.pages.toLocaleString()} page${item.pages === 1 ? '' : 's'}`;
  }
  return `${Math.round(item.bytes / 1048576)} MB`;
}

// ---------------------------------------------------------------------------
// Words and money.
// ---------------------------------------------------------------------------

/** `$1.42`, `42¢`, or `under 1¢` — the Bucketizer dialog's own vocabulary. */
export function formatCents(cents) {
  const n = Number(cents) || 0;
  if (n <= 0) return 'under 1¢';
  if (n < 100) return `${Math.round(n)}¢`;
  return `$${(n / 100).toFixed(2)}`;
}

/** A range, collapsed to one figure when both ends round to the same thing. */
export function formatCentsRange(lowCents, highCents) {
  const low = formatCents(lowCents);
  const high = formatCents(highCents);
  return low === high ? high : `${low} – ${high}`;
}

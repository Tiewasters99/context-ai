// The upload estimate: arithmetic, threshold, the wallet check, and the
// handler's refusal to take the browser's word for it.
//
// Offline, and deliberately so: no network, no .env, no database, no provider,
// no file parsed. Everything here is a pure function over a price table.
//
//   node --test scripts/_test-ingest-estimate.mjs
//
// The first suite is the one that matters most over time. Every figure the
// dialog shows is arithmetic over lib/usage-prices.mjs, and that table is
// itself a MIRROR of rates that live elsewhere (the pens, the Anthropic vision
// prices, Gemini's per page, Textract's per page). So this file imports the
// real sources and fails on drift rather than letting a quote quietly become
// wrong — the same discipline scripts/_test-usage-meter.mjs applies to the
// meter's own estimates.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OCR_USD_PER_PAGE_GEMINI,
  OCR_USD_PER_PAGE_TEXTRACT,
  OCR_USD_PER_PAGE_MAX,
  EMBED_USD_PER_MTOK,
  DEEPGRAM_USD_PER_MINUTE,
  ocrUsdPerPage,
} from '../lib/usage-prices.mjs';
import { ROUTES } from '../lib/ocr-routes.mjs';
import { TEXTRACT_USD_PER_PAGE } from '../lib/ocr-textract.mjs';
import {
  UPLOAD_ESTIMATE_THRESHOLDS,
  ASSUMED_CHARS_PER_PAGE,
  ASSUMED_TRANSCRIPT_CHARS_PER_MINUTE,
  ASSUMED_BYTES_PER_PAGE,
  FLOOR_BYTES_PER_PAGE,
  CONTAINER_TEXT_FACTOR,
  estimateUploadItem,
  estimateUpload,
  thresholdVerdict,
  whatFits,
  chooseDeclaration,
  declarationFor,
  documentNeedsConfirmation,
  recomputeDocumentEstimate,
  verifyIngestConfirmation,
  ingestRequestBody,
  formatCents,
  formatCentsRange,
  ocrRouteForTier,
} from '../lib/ingest-estimate.mjs';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(REPO, p), 'utf8');

const KB = 1024;
const MB = 1024 * 1024;

// The two arithmetic primitives, written out here independently of the module
// so that a change to either is a test failure rather than a silent agreement.
const centsUp = (usd) => Math.max(0, Math.ceil(usd * 100));
const embedCents = (chars) => centsUp(((chars / 3) / 1e6) * EMBED_USD_PER_MTOK);

// ---------------------------------------------------------------------------

test('prices are the real ones, and have not drifted from their sources', async (t) => {
  await t.test('Gemini per page mirrors lib/ocr-routes.mjs', () => {
    assert.equal(OCR_USD_PER_PAGE_GEMINI, ROUTES['gemini-flash'].usdPerPage);
  });

  await t.test('Textract per page mirrors lib/ocr-textract.mjs', () => {
    assert.equal(OCR_USD_PER_PAGE_TEXTRACT, TEXTRACT_USD_PER_PAGE);
  });

  await t.test('the sealed route is cheaper per page than the unsealed one', () => {
    // Not a preference — it is why the handler may recompute at Tier A
    // without a tier lookup and still be the conservative side.
    assert.ok(OCR_USD_PER_PAGE_TEXTRACT < OCR_USD_PER_PAGE_GEMINI);
    assert.ok(OCR_USD_PER_PAGE_GEMINI < OCR_USD_PER_PAGE_MAX);
  });

  await t.test('an unknown route is priced HIGH, never cheap by accident', () => {
    assert.equal(ocrUsdPerPage('something-new'), OCR_USD_PER_PAGE_MAX);
    assert.equal(ocrUsdPerPage(undefined), OCR_USD_PER_PAGE_MAX);
  });

  await t.test('no rate in this module is a literal — every one comes from the table', () => {
    // Comments are stripped first: the file EXPLAINS the rates in prose, and
    // it is the code that must not restate one.
    const text = src('lib/ingest-estimate.mjs')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    // A price would look like a decimal with three or more places (0.002,
    // 0.0043, 0.0015). Sizes are written as `n * 1024` and page/char counts as
    // integers, so neither trips this.
    const decimals = text.match(/[^\w.]0\.\d{3,}/g) ?? [];
    assert.deepEqual(decimals, [], `a rate appears to be hard-coded: ${decimals.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------

test('one file, priced against the real table', async (t) => {
  await t.test('a 300-page PDF: text at the low end, every page a scan at the high end', () => {
    const it = estimateUploadItem({ name: 'Volume I.pdf', bytes: 40 * MB, pages: 300 });
    assert.equal(it.kind, 'pdf');
    assert.equal(it.pages, 300);
    assert.equal(it.pagesKnown, true);
    assert.equal(it.lowCents, embedCents(300 * ASSUMED_CHARS_PER_PAGE));
    assert.equal(
      it.highCents,
      centsUp(300 * OCR_USD_PER_PAGE_GEMINI) + embedCents(300 * ASSUMED_CHARS_PER_PAGE),
    );
    assert.ok(it.highCents > it.lowCents, 'a scan must cost more than the same pages of text');
    assert.ok(it.basis.some((b) => /every page is a scan/.test(b)));
  });

  await t.test('a 90-minute recording: minutes at the metered rate, plus its transcript', () => {
    const it = estimateUploadItem({ name: 'Depo 2026-09-29.mp4', bytes: 900 * MB, minutes: 90 });
    assert.equal(it.kind, 'media');
    assert.equal(it.minutesKnown, true);
    const expected = centsUp(90 * DEEPGRAM_USD_PER_MINUTE)
      + embedCents(90 * ASSUMED_TRANSCRIPT_CHARS_PER_MINUTE);
    assert.equal(it.highCents, expected);
    assert.equal(it.lowCents, expected, 'a measured duration has no range to give');
  });

  await t.test('an unmeasured recording gives a RANGE, and says the length was estimated', () => {
    const it = estimateUploadItem({ name: 'hearing.mp4', bytes: 600 * MB });
    assert.equal(it.minutesKnown, false);
    assert.ok(it.highCents > it.lowCents);
    assert.ok(it.basis.some((b) => /estimated from the file size/.test(b)));
  });

  await t.test('a PDF whose pages could not be counted falls back to size, and says so', () => {
    const it = estimateUploadItem({ name: 'huge.pdf', bytes: 300 * MB });
    assert.equal(it.pagesKnown, false);
    assert.equal(it.pages, Math.ceil((300 * MB) / ASSUMED_BYTES_PER_PAGE));
    assert.ok(it.basis.some((b) => /page count estimated from the file size/.test(b)));
  });

  await t.test('a scanned page saved as a photograph is one OCR page', () => {
    const it = estimateUploadItem({ name: 'IMG_0042.jpg', bytes: 3 * MB });
    assert.equal(it.kind, 'image');
    assert.equal(it.pages, 1);
    assert.equal(
      it.highCents,
      centsUp(1 * OCR_USD_PER_PAGE_GEMINI) + embedCents(ASSUMED_CHARS_PER_PAGE),
    );
  });

  await t.test('a 3D asset is stored, never read, and costs nothing', () => {
    const it = estimateUploadItem({ name: 'scene.glb', bytes: 18 * MB });
    assert.equal(it.kind, 'stored');
    assert.equal(it.highCents, 0);
    assert.equal(it.lowCents, 0);
  });

  await t.test('a compressed document is priced for more text than it weighs', () => {
    const docx = estimateUploadItem({ name: 'Brief.docx', bytes: 2 * MB });
    const txt = estimateUploadItem({ name: 'Brief.txt', bytes: 2 * MB });
    assert.equal(txt.highCents, txt.lowCents);
    assert.ok(docx.highCents >= docx.lowCents);
    assert.equal(docx.lowCents, txt.lowCents);
    assert.ok(CONTAINER_TEXT_FACTOR > 1);
  });
});

// ---------------------------------------------------------------------------

test('sealed and unsealed are priced at their own routes', async (t) => {
  const file = { name: 'Production Vol 3.pdf', bytes: 60 * MB, pages: 400 };

  await t.test('Tier A is read by the unsealed route', () => {
    assert.equal(ocrRouteForTier('A'), 'gemini-flash');
    const it = estimateUploadItem(file, { tier: 'A' });
    assert.equal(
      it.highCents,
      centsUp(400 * OCR_USD_PER_PAGE_GEMINI) + embedCents(400 * ASSUMED_CHARS_PER_PAGE),
    );
  });

  await t.test('Tier B is read by Textract, inside the seal, and costs less', () => {
    assert.equal(ocrRouteForTier('B'), 'aws-textract');
    const sealed = estimateUploadItem(file, { tier: 'B' });
    const open = estimateUploadItem(file, { tier: 'A' });
    assert.equal(
      sealed.highCents,
      centsUp(400 * OCR_USD_PER_PAGE_TEXTRACT) + embedCents(400 * ASSUMED_CHARS_PER_PAGE),
    );
    assert.ok(sealed.highCents < open.highCents);
    assert.equal(estimateUpload([file], { tier: 'B' }).sealed, true);
  });

  await t.test('Tier C sends no page anywhere, so a scan costs nothing to store', () => {
    assert.equal(ocrRouteForTier('C'), null);
    const it = estimateUploadItem(file, { tier: 'C' });
    assert.equal(it.highCents, it.lowCents);
    assert.ok(it.basis.some((b) => /no page to an OCR provider/.test(b)));
  });

  await t.test('OCR_TIER_A_ROUTES moves Tier A, and the price follows it', () => {
    const env = { OCR_TIER_A_ROUTES: 'anthropic-vision,gemini-flash' };
    assert.equal(ocrRouteForTier('A', env), 'anthropic-vision');
    const it = estimateUploadItem(file, { tier: 'A', env });
    assert.equal(
      it.highCents,
      centsUp(400 * OCR_USD_PER_PAGE_MAX) + embedCents(400 * ASSUMED_CHARS_PER_PAGE),
    );
  });
});

// ---------------------------------------------------------------------------

test('the threshold: four independent triggers, and silence below all of them', async (t) => {
  const t0 = UPLOAD_ESTIMATE_THRESHOLDS;

  await t.test('an ordinary drop says nothing', () => {
    const e = estimateUpload([
      { name: 'Letter.docx', bytes: 200 * KB },
      { name: 'Exhibit A.pdf', bytes: 900 * KB, pages: 40 },
      { name: 'voicemail.mp3', bytes: 2 * MB, minutes: 5 },
    ]);
    assert.equal(thresholdVerdict(e).over, false, 'three small files must not open a dialog');
    assert.ok(e.highCents < t0.cents);
  });

  await t.test('money alone: four medium PDFs, no other trigger', () => {
    const files = Array.from({ length: 4 }, (_, i) => ({ name: `Vol ${i}.pdf`, bytes: 8 * MB, pages: 150 }));
    const e = estimateUpload(files);
    assert.ok(e.files < t0.files);
    assert.ok(e.largestPdfPages < t0.pdfPages);
    assert.equal(e.mediaMinutes, 0);
    assert.ok(e.highCents >= t0.cents);
    const v = thresholdVerdict(e);
    assert.equal(v.over, true);
    assert.equal(v.reasons.length, 1);
    assert.match(v.reasons[0], /the estimate reaches/);
  });

  await t.test('count alone: 25 tiny files', () => {
    const files = Array.from({ length: t0.files }, (_, i) => ({ name: `note-${i}.txt`, bytes: 4 * KB }));
    const e = estimateUpload(files);
    assert.ok(e.highCents < t0.cents);
    const v = thresholdVerdict(e);
    assert.equal(v.over, true);
    assert.match(v.reasons.join(' '), /files at once/);
  });

  await t.test('one file under the count trigger is not a bulk drop', () => {
    const files = Array.from({ length: t0.files - 1 }, (_, i) => ({ name: `note-${i}.txt`, bytes: 4 * KB }));
    assert.equal(thresholdVerdict(estimateUpload(files)).over, false);
  });

  await t.test('minutes alone: one recording past the line', () => {
    const e = estimateUpload([{ name: 'meeting.m4a', bytes: 30 * MB, minutes: t0.mediaMinutes + 1 }]);
    assert.ok(e.highCents < t0.cents, 'the money trigger must not be what fires here');
    const v = thresholdVerdict(e);
    assert.equal(v.over, true);
    assert.match(v.reasons.join(' '), /a recording of about/);
  });

  await t.test('a recording exactly at the line does not fire', () => {
    const e = estimateUpload([{ name: 'meeting.m4a', bytes: 30 * MB, minutes: t0.mediaMinutes }]);
    assert.equal(thresholdVerdict(e).over, false);
  });

  await t.test('pages alone: one long document, under the money line', () => {
    const e = estimateUpload([{ name: 'Deposition.pdf', bytes: 9 * MB, pages: t0.pdfPages + 1 }]);
    assert.ok(e.highCents < t0.cents, '201 pages at the tier rate is well under a dollar');
    const v = thresholdVerdict(e);
    assert.equal(v.over, true);
    assert.match(v.reasons.join(' '), /a document of about/);
  });

  await t.test('a document exactly at the page line does not fire', () => {
    const e = estimateUpload([{ name: 'Deposition.pdf', bytes: 9 * MB, pages: t0.pdfPages }]);
    assert.equal(thresholdVerdict(e).over, false);
  });

  await t.test('a drop that trips several says all of them', () => {
    const files = [
      ...Array.from({ length: 40 }, (_, i) => ({ name: `Ex ${i}.pdf`, bytes: 8 * MB, pages: 300 })),
      { name: 'video.mp4', bytes: 900 * MB, minutes: 120 },
    ];
    const v = thresholdVerdict(estimateUpload(files));
    assert.equal(v.over, true);
    assert.equal(v.reasons.length, 4);
  });
});

// ---------------------------------------------------------------------------

test('what is left, and what would fit', async (t) => {
  const files = Array.from({ length: 4 }, (_, i) => ({ name: `Vol ${i}.pdf`, bytes: 8 * MB, pages: 150 }));
  const e = estimateUpload(files);
  const per = e.items[0].highCents;

  await t.test('the leading run that fits is counted, not guessed', () => {
    const fits = whatFits(e, per + 1);
    assert.equal(fits.exceeds, true);
    assert.equal(fits.fitsCount, 1);
    assert.equal(fits.fitsCents, per);
  });

  await t.test('nothing fits when nothing is left', () => {
    const fits = whatFits(e, 0);
    assert.equal(fits.exceeds, true);
    assert.equal(fits.fitsCount, 0);
    assert.equal(fits.fitsCents, 0);
  });

  await t.test('everything fits when the allowance covers it', () => {
    const fits = whatFits(e, e.highCents);
    assert.equal(fits.exceeds, false);
    assert.equal(fits.fitsCount, e.files);
  });

  await t.test('an unlimited (workshop) or unknown allowance never blocks', () => {
    for (const remaining of [null, undefined]) {
      const fits = whatFits(e, remaining);
      assert.equal(fits.exceeds, false, 'a workshop account is informed, never stopped');
      assert.equal(fits.fitsCount, e.files);
    }
  });

  await t.test('the browser reads an uncapped plan as "no figure to block on"', () => {
    // The wallet read is in the .ts half (it needs supabase); this is the one
    // line of it that decides whether anyone is ever blocked.
    const text = src('src/lib/ingest-estimate.ts');
    assert.match(text, /if \(wallet\.unlimited\) return null;/);
    assert.match(text, /monthly_cents === null\) unlimited = true/);
    // A missing billing table must produce silence, not a zero.
    assert.match(text, /creditRes\.error \? null :/);
    assert.match(text, /monthRes\.error \? null :/);
  });
});

// ---------------------------------------------------------------------------

test('the handler does not take the browser’s word for it', async (t) => {
  const bigPdf = { source_filename: 'Production.pdf', file_size_bytes: 80 * MB, page_count: null };
  const smallDoc = { source_filename: 'Letter.docx', file_size_bytes: 200 * KB, page_count: null };

  await t.test('an ordinary document needs nothing at all', () => {
    assert.equal(verifyIngestConfirmation({ doc: smallDoc, body: { documentId: 'x' } }), null);
  });

  await t.test('a big one with no estimate at all is refused, in a sentence', () => {
    const v = verifyIngestConfirmation({ doc: bigPdf, body: { documentId: 'x' } });
    assert.ok(v, 'an 80 MB PDF must not be read on an unconfirmed request');
    assert.equal(v.status, 400);
    assert.equal(v.error, 'estimate_confirmation_required');
    assert.match(v.message, /Production\.pdf/);
    assert.match(v.message, /pages/);
    // src/lib/llm/refusals.ts renders any 4xx body carrying `message` verbatim,
    // so this reaches the banner as English rather than as a code.
    assert.equal(typeof v.message, 'string');
    assert.ok(v.message.length > 40);
  });

  await t.test('an unconfirmed estimate is not a confirmation', () => {
    const v = verifyIngestConfirmation({
      doc: bigPdf,
      body: { estimate: { confirmed: false, pages: 900, minutes: 0, ack_cents: 200 } },
    });
    assert.equal(v?.error, 'estimate_confirmation_required');
  });

  await t.test('an honest confirmation goes through', () => {
    const item = recomputeDocumentEstimate(bigPdf, { pages: 900 });
    const v = verifyIngestConfirmation({
      doc: bigPdf,
      body: { estimate: declarationFor(item) },
    });
    assert.equal(v, null);
  });

  await t.test('a forged low estimate is rejected, and nothing is read', () => {
    const v = verifyIngestConfirmation({
      doc: bigPdf,
      body: { estimate: { confirmed: true, pages: 900, minutes: 0, ack_cents: 1 } },
    });
    assert.ok(v);
    assert.equal(v.error, 'estimate_mismatch');
    assert.match(v.message, /lower than this file/);
    assert.ok(v.estimate.high_cents > 1);
  });

  await t.test('the cents are recomputed here, never read out of the body', () => {
    const honest = recomputeDocumentEstimate(bigPdf, { pages: 900 });
    const lying = recomputeDocumentEstimate(bigPdf, { pages: 900, ack_cents: 1, high_cents: 1 });
    assert.equal(honest.highCents, lying.highCents);
  });

  await t.test('a measured page count beats the size, so an image-heavy PDF is not refused', () => {
    // 13 MB of photographed pages is 50 pages, not the 200+ a bytes-only
    // reading would give. The browser measured it, saw it was small, showed no
    // dialog and sent no estimate — and the handler must agree.
    const doc = { source_filename: 'Photos.pdf', file_size_bytes: 13 * MB, page_count: null };
    assert.equal(verifyIngestConfirmation({ doc, body: { documentId: 'x' } }), null);
    const item = recomputeDocumentEstimate(doc, null);
    assert.equal(item.pages, Math.ceil((13 * MB) / FLOOR_BYTES_PER_PAGE));
    assert.ok(item.pages <= UPLOAD_ESTIMATE_THRESHOLDS.pdfPages);
  });

  await t.test('a page count already on the row is used when the body declares none', () => {
    const doc = { source_filename: 'Deposition.pdf', file_size_bytes: 4 * MB, page_count: 900 };
    const v = verifyIngestConfirmation({ doc, body: { documentId: 'x' } });
    assert.equal(v?.error, 'estimate_confirmation_required');
  });

  await t.test('a long recording is asked for too', () => {
    const doc = { source_filename: 'Hearing.mp4', file_size_bytes: 40 * MB, page_count: null };
    const v = verifyIngestConfirmation({
      doc,
      body: { estimate: { confirmed: false, pages: 0, minutes: 180, ack_cents: 90 } },
    });
    assert.equal(v?.error, 'estimate_confirmation_required');
    assert.match(v.message, /minutes of recording/);
  });

  await t.test('the handler’s Tier A recomputation is the conservative side of a sealed upload', () => {
    const doc = { source_filename: 'Sealed.pdf', file_size_bytes: 20 * MB, page_count: 400 };
    const asServer = recomputeDocumentEstimate(doc, { pages: 400 }, { tier: 'A' });
    const asSealedClient = estimateUploadItem(
      { name: 'Sealed.pdf', bytes: 20 * MB, pages: 400 }, { tier: 'B' },
    );
    assert.ok(asSealedClient.highCents < asServer.highCents);
    // …and the client's own (lower, correct) figure still clears the check.
    assert.equal(
      verifyIngestConfirmation({ doc, body: { estimate: declarationFor(asSealedClient) }, tier: 'A' }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------

test('below the threshold the request is the one it has always been', async (t) => {
  await t.test('no declaration, no new field — byte for byte', () => {
    assert.equal(ingestRequestBody('7e1c-doc'), '{"documentId":"7e1c-doc"}');
    assert.equal(ingestRequestBody('7e1c-doc', null), '{"documentId":"7e1c-doc"}');
    assert.equal(ingestRequestBody('7e1c-doc', undefined), '{"documentId":"7e1c-doc"}');
  });

  await t.test('a confirmed upload adds exactly one field', () => {
    const item = estimateUploadItem({ name: 'Big.pdf', bytes: 60 * MB, pages: 900 });
    const body = JSON.parse(ingestRequestBody('7e1c-doc', declarationFor(item)));
    assert.deepEqual(Object.keys(body).sort(), ['documentId', 'estimate']);
    assert.equal(body.estimate.confirmed, true);
    assert.equal(body.estimate.pages, 900);
  });

  await t.test('"measured and small" sends nothing; "never measured" is the only auto case', () => {
    // The distinction requirement 5 actually rests on. A 13 MB PDF of fifty
    // photographed pages measures at fifty and needs no quote — but its SIZE
    // alone reads as 222 pages, because the browser's fallback errs high on
    // purpose. If the two collapsed, an ordinary upload would carry a page
    // count the browser had already measured as wrong.
    const photos = { name: 'Photos.pdf', bytes: 13 * MB };
    assert.equal(chooseDeclaration(null, photos), null, 'measured, no quote owed → send nothing');
    assert.equal(
      ingestRequestBody('d', chooseDeclaration(null, photos)),
      '{"documentId":"d"}',
      'and the body is the one this endpoint has always taken',
    );
    // Never measured — an app-generated document, which has no dialog to show
    // and would otherwise be refused by the handler.
    const auto = chooseDeclaration(undefined, photos);
    assert.ok(auto && auto.confirmed === true);
    assert.equal(auto.pages, Math.ceil((13 * MB) / ASSUMED_BYTES_PER_PAGE));
    // Never measured and small → still nothing.
    assert.equal(chooseDeclaration(undefined, { name: 'Letter.docx', bytes: 200 * KB }), null);
    // A confirmed quote is passed through untouched.
    const shown = declarationFor(estimateUploadItem({ name: 'Big.pdf', bytes: 60 * MB, pages: 900 }));
    assert.equal(chooseDeclaration(shown, { name: 'Big.pdf', bytes: 60 * MB }), shown);
  });

  await t.test('the Vault sends that body, and only that body', () => {
    const text = src('src/lib/vault-persist.ts');
    assert.match(text, /body: ingestRequestBody\(documentId, declaration\)/);
    assert.match(text, /chooseDeclaration\(opts\.ingestDeclaration, \{ name: file\.name, bytes: file\.size \}\)/);
    const gate = src('src/components/vault/UploadEstimateGate.tsx');
    assert.match(gate, /declarations: files\.map\(\(\) => null\)/,
      'the below-threshold branch must send null, never undefined');
  });

  await t.test('the Vault gates its drop, and the sealed matter card gates its own', () => {
    const vault = src('src/pages/Vault.tsx');
    assert.match(vault, /const gated = await gateUpload\(candidates, matter\.id\)/);
    assert.match(vault, /ingestDeclaration,/);
    assert.match(vault, /\{uploadEstimateDialog\}/);
    const sealed = src('src/components/securespace/SecureSpacesSection.tsx');
    assert.match(sealed, /await gateUpload\(dropped, row\.matter\.id\)/);
    assert.match(sealed, /ingestDeclaration: gated\.declarations\[i\]/);
  });

  await t.test('the handler checks before it charges — a refusal costs nothing', () => {
    const handler = src('api/ingest.mjs');
    const check = handler.indexOf('verifyIngestConfirmation({');
    // Like for like with the browser, which has no process.env: passing this
    // deployment's env would make an OCR_TIER_A_ROUTES flip reject every
    // honest confirmation of a big scan at fifteen times the price.
    assert.match(handler, /verifyIngestConfirmation\(\{ doc, body, tier: 'A', env: \{\} \}\)/);
    const meter = handler.indexOf('const ingestMeter = await consumeUsage(');
    const ready = handler.indexOf('alreadyReady: true');
    assert.ok(check > 0 && meter > 0 && ready > 0);
    assert.ok(ready < check, 'polling a ready document must not be gated');
    assert.ok(check < meter, 'the confirmation check must run before the meter');
    // PR #169's routing and #161's guard are both still downstream of it.
    assert.ok(meter < handler.indexOf('needsWorkerIngest(ext0'));
  });
});

// ---------------------------------------------------------------------------

test('money, in words', async (t) => {
  await t.test('the Bucketizer dialog’s own vocabulary', () => {
    assert.equal(formatCents(0), 'under 1¢');
    assert.equal(formatCents(42), '42¢');
    assert.equal(formatCents(142), '$1.42');
  });

  await t.test('a range collapses when both ends read the same', () => {
    assert.equal(formatCentsRange(40, 40), '40¢');
    assert.equal(formatCentsRange(1, 640), '1¢ – $6.40');
  });

  await t.test('a document needing confirmation is the same test on both sides', () => {
    const item = estimateUploadItem({ name: 'Deposition.pdf', bytes: 9 * MB, pages: 900 });
    assert.equal(documentNeedsConfirmation(item), true);
    assert.equal(thresholdVerdict(estimateUpload([
      { name: 'Deposition.pdf', bytes: 9 * MB, pages: 900 },
    ])).over, true);
  });
});

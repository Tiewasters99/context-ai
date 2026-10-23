// A refusal is a refusal, not a blank page (2026-10-22).
//
// Gemini answers a verbatim-OCR request on text it knows from training (a
// published OATH decision, a US patent, a public-domain book) with HTTP 200,
// finishReason RECITATION and no text. Until today that came back as '' for
// every page of the 8-page window and was recorded as "no legible text" on a
// READY document — the Bushell "Major World" decision lost 61 of 85 pages.
// These checks pin the new behaviour end to end, with no network and no
// database: the Gemini route reads finishReason, ocrByWindows retries a
// declined window one page at a time, a page still declined comes back
// `failed`, the merge keeps it apart from pages read as blank, and the
// outcome record names it. Run: node scripts/_test-ocr-refusals.mjs
import assert from 'node:assert';
import { ocrByWindows, OcrWindowError, pagesWithMarkers, parseDelimited } from '../lib/ocr-protocol.mjs';
import { answerText, windowPages, ocrPdf } from '../lib/ocr-gemini.mjs';
import { mergeOcrPages, ingestOutcome, describeRefused } from '../lib/ingest-core.mjs';
import { buildPdf } from './_fixtures-ingest.mjs';

let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };
const scanned = (count) => buildPdf(Array.from({ length: count }, (_, i) => ({ scan: [`Scanned page ${i + 1} of the decision.`] })));

// --- the Gemini answer -----------------------------------------------------------------
{
  const pages = [1, 2, 3];
  const stop = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '<<<PAGE 1>>>\none' }] } }] };
  assert.strictEqual(answerText(stop, pages), '<<<PAGE 1>>>\none');
  for (const [reason, code] of [['RECITATION', 'recitation'], ['SAFETY', 'safety'], ['PROHIBITED_CONTENT', 'safety'], ['MAX_TOKENS', 'truncated'], ['NEW_REASON', 'new_reason']]) {
    const data = { candidates: [{ finishReason: reason, content: { parts: [] } }] };
    assert.throws(() => answerText(data, pages), (e) => e instanceof OcrWindowError && e.code === code && e.pages === pages && /finishReason/.test(e.message));
  }
  assert.throws(() => answerText({ promptFeedback: { blockReason: 'OTHER' } }, pages), (e) => e.code === 'blocked');
  assert.throws(() => answerText({ candidates: [] }, pages), (e) => e.code === 'empty');
  assert.throws(() => answerText({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '  ' }] } }] }, pages), (e) => e.code === 'empty');
  ok('answerText: STOP with text is the answer; RECITATION/SAFETY/MAX_TOKENS/blocked/no candidate/empty throw an OcrWindowError with a code');
}

{
  assert.deepStrictEqual([...pagesWithMarkers('<<<PAGE 4>>>\nx\n<<< page 6 >>>\ny')], [4, 6]);
  const w = windowPages('<<<PAGE 4>>>\nfour\n<<<PAGE 6>>>\nsix', [4, 5, 6]);
  assert.deepStrictEqual(w, [{ pageNumber: 4, text: 'four' }, { pageNumber: 5, text: '', missing: true }, { pageNumber: 6, text: 'six' }]);
  assert.deepStrictEqual(windowPages('just the text, no marker', [9]), [{ pageNumber: 9, text: 'just the text, no marker' }]);
  assert.deepStrictEqual(windowPages('[no legible text]', [9]), [{ pageNumber: 9, text: '' }]);
  assert.deepStrictEqual(windowPages('<<<PAGE 1>>>\nrenumbered by the model', [9]), [{ pageNumber: 9, text: 'renumbered by the model' }], 'a lone page answered under the wrong number keeps its text');
  assert.throws(() => windowPages('prose with no markers at all', [1, 2]), (e) => e instanceof OcrWindowError && e.code === 'no_answer');
  assert.deepStrictEqual(parseDelimited('<<<PAGE 4>>>\nfour', [4, 5]), [{ pageNumber: 4, text: 'four' }, { pageNumber: 5, text: '' }], 'parseDelimited itself is unchanged');
  ok('windowPages: a skipped page is `missing`, a lone page without its marker keeps the text, a multi-page answer with no markers is no answer');
}

// --- ocrByWindows retries a declined window one page at a time ------------------------
{
  const pdf = await scanned(12);
  const calls = [];
  const pages = await ocrByWindows(pdf, { window: 8, concurrency: 2 }, async (bytes, absNums) => {
    calls.push(absNums);
    assert(bytes.length > 0);
    if (absNums.length > 1 && absNums[0] === 1) throw new OcrWindowError('finishReason RECITATION', { code: 'recitation', pages: absNums });
    if (absNums.length === 1 && absNums[0] === 3) throw new OcrWindowError('finishReason RECITATION', { code: 'recitation', pages: absNums });
    if (absNums.length > 1 && absNums[0] === 9) {
      // window 9-12 answers but skips page 11
      return absNums.map((p) => (p === 11 ? { pageNumber: p, text: '', missing: true } : { pageNumber: p, text: `text ${p}` }));
    }
    return absNums.map((p) => ({ pageNumber: p, text: `text ${p}` }));
  });
  assert.strictEqual(pages.length, 12);
  for (const p of [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    assert.deepStrictEqual(pages[p - 1], { pageNumber: p, text: `text ${p}` }, `page ${p} recovered`);
  }
  assert.strictEqual(pages[2].text, '');
  assert.strictEqual(pages[2].failed, 'recitation');
  assert.match(pages[2].reason, /RECITATION/);
  const singles = calls.filter((c) => c.length === 1).map((c) => c[0]).sort((a, b) => a - b);
  assert.deepStrictEqual(singles, [1, 2, 3, 4, 5, 6, 7, 8, 11], 'exactly the declined window and the skipped page were retried singly');
  assert.strictEqual(calls.filter((c) => c.length > 1).length, 2, 'two windows of 8 and 4');
  ok('ocrByWindows: a declined 8-page window is retried page by page; 7 recover, the one still declined is `failed`, a page skipped by the model is retried too');
}

// --- the Gemini route end to end, fetch stubbed -----------------------------------------
{
  const pdf = await scanned(10);
  const asked = [];
  const fetchImpl = async (url, { body }) => {
    const text = JSON.parse(body).contents[0].parts[0].text;
    const m = text.match(/numbering them: ([\d, ]+)\./);
    const nums = m[1].split(',').map((s) => parseInt(s.trim(), 10));
    asked.push(nums);
    const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (nums.length > 1 && nums[0] === 1) return json({ candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }], usageMetadata: {} });
    if (nums.length === 1 && nums[0] === 5) return json({ candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }] });
    const out = nums.map((p) => `<<<PAGE ${p}>>>\nGemini read page ${p}.`).join('\n');
    return json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: out }] } }] });
  };
  const pages = await ocrPdf(pdf, { apiKey: 'k', model: 'stub', window: 8, concurrency: 3, fetchImpl });
  assert.strictEqual(pages.length, 10);
  assert.strictEqual(pages[0].text, 'Gemini read page 1.');
  assert.strictEqual(pages[9].text, 'Gemini read page 10.');
  assert.strictEqual(pages[4].failed, 'recitation');
  assert.strictEqual(pages.filter((p) => p.failed).length, 1);
  assert.strictEqual(asked.filter((a) => a.length === 1).length, 8, 'eight single-page retries after the refused window');
  ok('ocrPdf (Gemini) with a RECITATION window: 9 of 10 pages read after single-page retries; page 5 comes back failed, not blank');
}

// --- ocrImages (Student Hub photographed pages) retries a declined batch singly ------------
{
  const { ocrImages } = await import('../lib/ocr-gemini.mjs');
  const images = [1, 2, 3].map((n) => ({ pageNumber: n, bytes: Buffer.from(`img${n}`), mimeType: 'image/jpeg' }));
  const asked = [];
  const fetchImpl = async (url, { body }) => {
    const text = JSON.parse(body).contents[0].parts[0].text;
    const nums = text.match(/in order: ([\d, ]+)\./)[1].split(',').map((s) => parseInt(s.trim(), 10));
    asked.push(nums);
    const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => '' });
    if (nums.length > 1 || nums[0] === 2) return json({ candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }] });
    return json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: `<<<PAGE ${nums[0]}>>>\nphoto page ${nums[0]}` }] } }] });
  };
  const out = await ocrImages(images, { apiKey: 'k', model: 'stub', fetchImpl });
  assert.deepStrictEqual(asked, [[1, 2, 3], [1], [2], [3]]);
  assert.strictEqual(out[0].text, 'photo page 1');
  assert.strictEqual(out[2].text, 'photo page 3');
  assert.strictEqual(out[1].text, '');
  assert.strictEqual(out[1].failed, 'recitation');
  await assert.rejects(() => ocrImages([images[1]], { apiKey: 'k', model: 'stub', fetchImpl }), (e) => e instanceof OcrWindowError && e.code === 'recitation');
  ok('ocrImages: a declined batch is retried image by image; the one still declined is failed, a lone declined image throws');
}

// --- merge keeps refused apart from blank; the outcome names them --------------------
{
  const pages = [
    { pageNumber: 1, text: 'typed one' },
    { pageNumber: 2, text: '' },
    { pageNumber: 3, text: 'Case 1:23 Document 45 Page 3 of 4' },
    { pageNumber: 4, text: '' },
  ];
  const ocr = new Map([
    [2, 'Scanned two.'],
    [3, { text: '', failed: 'recitation', reason: 'finishReason RECITATION' }],
    [4, ''],
  ]);
  const r = mergeOcrPages(pages, ocr, [2, 3, 4]);
  assert.strictEqual(r.filled, 1);
  assert.deepStrictEqual(r.stillEmpty, [4], 'only the page the model READ as blank is stillEmpty');
  assert.deepStrictEqual(r.refused, [{ page: 3, code: 'recitation', reason: 'finishReason RECITATION' }]);
  assert.strictEqual(r.pages[2].text, 'Case 1:23 Document 45 Page 3 of 4', 'a refused page keeps its own (stamp) text');
  assert.match(describeRefused(r.refused), /declined 1 page\(s\).*recitation 1.*not blank/);
  ok('mergeOcrPages: refused pages are reported separately from blank pages and keep their own text');

  const legacy = mergeOcrPages(pages, new Map([[2, 'two'], [3, ''], [4, '']]), [2, 3, 4]);
  assert.deepStrictEqual(legacy.stillEmpty, [3, 4]);
  assert.deepStrictEqual(legacy.refused, []);
  ok('mergeOcrPages: a plain Map<page, string> (every older caller and test) behaves exactly as before');

  const o = ingestOutcome(pages, [2, 3, 4], 'read', { noText: [4], refused: [3] });
  assert.strictEqual(o.ocr, 'read');
  assert.strictEqual(o.text_source, 'mixed');
  assert.strictEqual(o.ocr_pages, '2-4');
  assert.strictEqual(o.ocr_no_text, '4');
  assert.strictEqual(o.ocr_refused, '3');
  const allRefused = ingestOutcome([{ pageNumber: 1, text: '' }, { pageNumber: 2, text: '' }], [1, 2], 'failed', { refused: [1, 2] });
  assert.strictEqual(allRefused.text_source, 'none');
  assert.strictEqual(allRefused.ocr_refused, '1-2');
  assert(!('ocr_refused' in ingestOutcome(pages, [2], 'read', { noText: [] })), 'no key when nothing was refused');
  ok('ingestOutcome: ocr_refused lists the declined pages, ocr_no_text only the blank ones; a run with nothing refused keeps its old shape');
}

// --- the provider sends declined pages to the next route --------------------------------
{
  const { makeOcrProvider } = await import('../lib/ocr-routes.mjs');
  const { extractPages } = await import('../lib/ingest-core.mjs');
  const pdf = await scanned(5);
  const seen = [];
  const routes = {
    'gemini-flash': { id: 'gemini-flash', provider: 'google', label: 'G', zdr: false, requiredEnv: [], model: () => 'g-1',
      async run(buf) {
        seen.push(['g', (await extractPages(buf, '.pdf')).length]);
        return { pages: [1, 2, 3, 4, 5].map((p) => (p === 2 || p === 4
          ? { pageNumber: p, text: '', failed: 'recitation', reason: 'finishReason RECITATION' }
          : { pageNumber: p, text: `g page ${p}` })), model: 'g-1', estimated_usd: 0.015 };
      } },
    'anthropic-vision': { id: 'anthropic-vision', provider: 'anthropic', label: 'A', zdr: false, requiredEnv: [], model: () => 'a-1',
      async run(buf) {
        const n = (await extractPages(buf, '.pdf')).length;
        seen.push(['a', n]);
        // reads the first of the two declined pages, declines the other
        return { pages: [{ pageNumber: 1, text: 'a read it' }, { pageNumber: 2, text: '', failed: 'refusal', reason: 'graphic' }], model: 'a-1', estimated_usd: 0.1 };
      } },
    'aws-textract': { id: 'aws-textract', provider: 'aws-textract', label: 'T', zdr: true, requiredEnv: [], model: () => 't',
      async run(buf) { seen.push(['t', (await extractPages(buf, '.pdf')).length]); return { pages: [{ pageNumber: 1, text: 't read it' }], model: 't', estimated_usd: 0.0015 }; } },
  };
  // stubs carry the catalogue's own ids: the policy only admits ids it knows
  const provider = makeOcrProvider({ OCR_TIER_A_ROUTES: 'gemini-flash,anthropic-vision,aws-textract' }, { routes });
  const out = await provider.run(pdf, { tier: 'A' });
  assert.deepStrictEqual(seen, [['g', 5], ['a', 2], ['t', 1]], 'G reads all 5; A gets the 2 declined as a sub-PDF; T gets the 1 A declined');
  assert.deepStrictEqual(out.pages.map((p) => p.text), ['g page 1', 'a read it', 'g page 3', 't read it', 'g page 5']);
  assert(out.pages.every((p) => !p.failed), 'every page read in the end');
  assert.deepStrictEqual(out.route.fallback_pages, [
    { id: 'anthropic-vision', model: 'a-1', pages: [2, 4], read: 1, estimated_usd: 0.1 },
    { id: 'aws-textract', model: 't', pages: [4], read: 1, estimated_usd: 0.0015 },
  ]);
  assert.strictEqual(out.route.estimated_usd, 0.1165, 'the record carries the whole cost');
  assert.strictEqual(out.route.id, 'gemini-flash');
  ok('makeOcrProvider: pages the first route declined go to the next route as a sub-PDF, then the next; the record names what each read and the total cost');

  const alone = makeOcrProvider({ OCR_TIER_A_ROUTES: 'gemini-flash' }, { routes });
  const only = await alone.run(pdf, { tier: 'A' });
  assert.deepStrictEqual(only.pages.filter((p) => p.failed).map((p) => p.pageNumber), [2, 4]);
  assert(!only.route.fallback_pages, 'no other route: the declined pages stay failed for the pipeline to record');
  ok('makeOcrProvider: with one route, declined pages come back failed (awaiting OCR), never blank');
}

console.log(`\nPASS (${n} checks)`);

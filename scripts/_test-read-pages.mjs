// read_pages — the Orchestrator reads a stored PDF's pages directly.
//
// Offline: pdf-lib builds the fixtures, the slow parts (locate, download) are
// stubbed, and the menu is read from assistant-core without a database.
//
//   node --test scripts/_test-read-pages.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import {
  READ_PAGES_TOOL,
  READ_PAGES_MAX_PAGES_PER_CALL,
  READ_PAGES_MAX_BYTES_PER_CALL,
  READ_PAGES_REQUEST_HEADROOM,
  penDocumentBudget,
  parsePageSpec,
  planPages,
  excerptPdf,
  excerptBlocks,
  pageRangesText,
  runReadPages,
} from '../lib/read-pages.mjs';
import { PENS, orchestratorMenu } from '../lib/assistant-core.mjs';

const MB = 1024 * 1024;

/** A PDF of `n` pages, each saying its own number (so a page is identifiable). */
async function makePdf(n, { padBytes = 0 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const page = doc.addPage([400, 500]);
    page.drawText(`Page ${i} of ${n}`, { x: 40, y: 440, size: 18, font });
    if (padBytes) {
      // Weight, so size budgets have something to bite on: a long text run.
      page.drawText('x'.repeat(Math.min(padBytes, 20_000)), { x: 10, y: 20, size: 1, font, maxWidth: 380, lineHeight: 1 });
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// ---------------------------------------------------------------------------

test('page specs', async (t) => {
  await t.test('a range, a list, a single page', () => {
    assert.deepEqual(parsePageSpec('1-20', 318).pages.length, 20);
    assert.deepEqual(parsePageSpec('5, 9-12', 318).pages, [5, 9, 10, 11, 12]);
    assert.deepEqual(parsePageSpec('35', 318).pages, [35]);
    assert.deepEqual(parsePageSpec(7, 318).pages, [7]);
    assert.deepEqual(parsePageSpec({ from: 3, to: 5 }, 318).pages, [3, 4, 5]);
  });

  await t.test('omitted → the first pages up to the cap; clamped to the document', () => {
    assert.equal(parsePageSpec(undefined, 318).pages.length, READ_PAGES_MAX_PAGES_PER_CALL);
    assert.deepEqual(parsePageSpec('', 3).pages, [1, 2, 3]);
    assert.deepEqual(parsePageSpec('310-400', 318).pages, [310, 311, 312, 313, 314, 315, 316, 317, 318]);
  });

  await t.test('more than one call reads is trimmed, and counted', () => {
    const r = parsePageSpec('1-100', 318);
    assert.equal(r.pages.length, READ_PAGES_MAX_PAGES_PER_CALL);
    assert.equal(r.trimmed, 60);
    assert.equal(parsePageSpec('1-100', 318, 10).pages.length, 10);
  });

  await t.test('nonsense is refused with the part named', () => {
    assert.throws(() => parsePageSpec('ten', 318), /"ten"/);
    assert.throws(() => parsePageSpec('0', 318), /nothing/);
    assert.throws(() => parsePageSpec('400', 318), /nothing/);
  });

  await t.test('ranges read back as a person would write them', () => {
    assert.equal(pageRangesText([1, 2, 3, 4]), '1–4');
    assert.equal(pageRangesText([5, 9, 10, 11, 12]), '5, 9–12');
    assert.equal(pageRangesText([7]), '7');
  });
});

// ---------------------------------------------------------------------------

test('the budget', async (t) => {
  await t.test('comes from the pen: Opus 5.5 on the Messages API', () => {
    const b = penDocumentBudget(PENS.anthropic);
    assert.equal(b.bytesLeft, Math.floor((32 * MB - READ_PAGES_REQUEST_HEADROOM) * 3 / 4));
    assert.equal(b.pagesLeft, 600, 'a 1M window takes 600 PDF pages a request');
    assert.equal(b.callBytes, READ_PAGES_MAX_BYTES_PER_CALL);
    assert.equal(b.callPages, READ_PAGES_MAX_PAGES_PER_CALL);
  });

  await t.test('the sealed pens: Bedrock caps a request at 20 MB; a 200k window takes 100 pages', () => {
    const runtime = penDocumentBudget(PENS.bedrockRuntime);
    assert.equal(runtime.bytesLeft, Math.floor((20 * MB - READ_PAGES_REQUEST_HEADROOM) * 3 / 4));
    assert.equal(runtime.pagesLeft, 100);
    const mantle = penDocumentBudget(PENS.bedrock);
    assert.equal(mantle.pagesLeft, 600);
    assert.ok(mantle.bytesLeft < penDocumentBudget(PENS.anthropic).bytesLeft);
  });

  await t.test('the Kimi chat route cannot take a document block', () => {
    assert.equal(penDocumentBudget(PENS.bedrockOpen), null);
    assert.equal(penDocumentBudget({}), null);
  });

  await t.test('planPages trims to what the file\'s average page weighs', () => {
    // 50 MB over 318 pages ≈ 157 KB a page: 10 MB holds 63 of them.
    const asked = Array.from({ length: 40 }, (_, i) => i + 1);
    assert.deepEqual(planPages(asked, { fileBytes: 50_136_508, pageCount: 318, maxBytes: 10 * MB }), asked);
    const heavy = planPages(asked, { fileBytes: 50_136_508, pageCount: 318, maxBytes: 2 * MB });
    assert.equal(heavy.length, 13);
    assert.deepEqual(planPages([200, 201], { fileBytes: 0, pageCount: 0, maxBytes: 1 }), [200, 201], 'no size known → nothing trimmed here');
    assert.equal(planPages([1], { fileBytes: 10 * MB, pageCount: 1, maxBytes: 1 }).length, 1, 'never fewer than one page');
  });
});

// ---------------------------------------------------------------------------

test('the excerpt', async (t) => {
  const six = await makePdf(6);
  const src = await PDFDocument.load(six);

  await t.test('is the pages asked for, in order, as a PDF of its own', async () => {
    const { bytes, pages } = await excerptPdf(src, [2, 3, 4]);
    assert.deepEqual(pages, [2, 3, 4]);
    const out = await PDFDocument.load(bytes);
    assert.equal(out.getPageCount(), 3);
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  });

  await t.test('too heavy for the budget → fewer pages, from the front, and the list says which', async () => {
    const two = (await excerptPdf(src, [1, 2])).bytes.length;
    const r = await excerptPdf(src, [1, 2, 3, 4, 5, 6], { maxBytes: two + 50 });
    assert.ok(r.pages.length < 6 && r.pages.length >= 1);
    assert.deepEqual(r.pages, Array.from({ length: r.pages.length }, (_, i) => i + 1));
    assert.ok(r.bytes.length <= two + 50);
  });

  await t.test('one page over the budget on its own is refused, with its weight', async () => {
    await assert.rejects(() => excerptPdf(src, [3], { maxBytes: 10 }), /page 3 alone is .* MB, over/);
  });
});

// ---------------------------------------------------------------------------

test('the tool result', async (t) => {
  const bytes = await makePdf(3);
  const budget = { bytesLeft: 20 * MB, pagesLeft: 590 };
  const blocks = excerptBlocks({
    document: 'doc-1', title: 'Anthropic, PBC - S-1 (Q2)', pageCount: 318,
    pagesSent: [41, 42, 43], pagesAsked: [41, 42, 43, 44, 45], trimmed: 0, bytes, budget,
  });

  await t.test('is a text block the pen reads first, then the document block', () => {
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[1].type, 'document');
    assert.equal(blocks[1].source.type, 'base64');
    assert.equal(blocks[1].source.media_type, 'application/pdf');
    assert.ok(!/\r|\n/.test(blocks[1].source.data), 'base64 carries no line breaks');
    assert.equal(Buffer.from(blocks[1].source.data, 'base64').length, bytes.length);
  });

  await t.test('says how the excerpt maps back to the document, and that these are PDF indices', () => {
    const meta = JSON.parse(blocks[0].text);
    assert.equal(meta.document, 'doc-1');
    assert.equal(meta.page_count, 318);
    assert.equal(meta.pages_sent, '41–43');
    assert.equal(meta.pages_in_excerpt, 3);
    assert.match(meta.mapping, /excerpt page 1 is document page 41/);
    assert.match(meta.page_numbers_are, /PDF page indices/);
    assert.match(meta.note, /DOCUMENT page numbers/);
    assert.match(blocks[1].title, /pages 41–43 \(excerpt page 1 = document page 41\)/);
  });

  await t.test('names what it left out, and the budget that remains', () => {
    const meta = JSON.parse(blocks[0].text);
    assert.equal(meta.not_sent, '44–45');
    assert.match(meta.why, /size budget/);
    assert.deepEqual(meta.budget_left_this_turn, { pages: 590, mb: 20 });
  });

  await t.test('a non-contiguous excerpt lists its pages in order', () => {
    const b = excerptBlocks({ document: 'd', title: 'T', pageCount: 9, pagesSent: [2, 5, 7], pagesAsked: [2, 5, 7], bytes });
    const meta = JSON.parse(b[0].text);
    assert.match(meta.mapping, /document pages 2, 5, 7, in that order/);
    assert.equal(meta.not_sent, undefined);
  });
});

// ---------------------------------------------------------------------------

test('runReadPages, with the slow parts stubbed', async (t) => {
  const pdf = await makePdf(12);
  const doc = {
    id: '11111111-1111-4111-8111-111111111111', title: 'Volume I', doc_type: 'pdf', source_filename: 'vol1.pdf',
    storage_path: 'm/doc/vol1.pdf', file_size_bytes: pdf.length, page_count: 12, matterspace_id: 'm', processing_status: 'pending',
  };
  const deps = {
    locate: async () => ({ doc }),
    download: async () => pdf,
  };

  await t.test('a pending document is readable now, and the budget is drawn down', async () => {
    const budget = penDocumentBudget(PENS.anthropic);
    const before = { ...budget };
    const out = await runReadPages(null, { document: doc.id, pages: '1-5' }, { budget, deps });
    assert.equal(out.is_error, false);
    assert.equal(out.content[1].type, 'document');
    const meta = JSON.parse(out.content[0].text);
    assert.equal(meta.pages_sent, '1–5');
    assert.equal(meta.page_count, 12);
    assert.equal(budget.pagesLeft, before.pagesLeft - 5);
    assert.ok(budget.bytesLeft < before.bytesLeft);
  });

  await t.test('a spent budget refuses, and says to answer from what was read', async () => {
    const budget = { ...penDocumentBudget(PENS.anthropic), pagesLeft: 0 };
    const out = await runReadPages(null, { document: doc.id }, { budget, deps });
    assert.equal(out.is_error, true);
    assert.match(out.content, /budget for this turn is spent/);
  });

  await t.test('the 100-page ceiling of a 200k pen bounds one call too', async () => {
    const budget = { ...penDocumentBudget(PENS.bedrockRuntime), pagesLeft: 3 };
    const out = await runReadPages(null, { document: doc.id, pages: '1-12' }, { budget, deps });
    const meta = JSON.parse(out.content[0].text);
    assert.equal(meta.pages_in_excerpt, 3);
    assert.match(meta.trimmed, /9 more pages/);
    assert.equal(budget.pagesLeft, 0);
  });

  await t.test('no document budget (the chat pen) → refused, pointing at the index', async () => {
    const out = await runReadPages(null, { document: doc.id }, { budget: null, deps });
    assert.equal(out.is_error, true);
    assert.match(out.content, /get_document_text/);
  });

  await t.test('a title that matches several, or none, hands back the candidates text', async () => {
    const answer = { document: null, ref: 'brief', candidates: [{ id: 'a' }, { id: 'b' }], note: '2 documents match "brief".' };
    const out = await runReadPages(null, { document: 'brief' }, {
      budget: penDocumentBudget(PENS.anthropic), deps: { ...deps, locate: async () => ({ answer }) },
    });
    assert.equal(out.is_error, false);
    assert.deepEqual(JSON.parse(out.content), answer);
  });

  await t.test('not a PDF → refused with the alternative', async () => {
    const word = { ...doc, source_filename: 'brief.docx', title: 'Brief', doc_type: 'docx' };
    const out = await runReadPages(null, { document: word.id }, {
      budget: penDocumentBudget(PENS.anthropic), deps: { ...deps, locate: async () => ({ doc: word }) },
    });
    assert.equal(out.is_error, true);
    assert.match(out.content, /not a PDF/);
  });

  await t.test('a bad page spec names the document\'s page count', async () => {
    const out = await runReadPages(null, { document: doc.id, pages: 'ten' }, { budget: penDocumentBudget(PENS.anthropic), deps });
    assert.equal(out.is_error, true);
    assert.match(out.content, /has 12 pages/);
  });

  await t.test('the seal and the bound matter are asked of locate, as callTool asks them', async () => {
    const seen = [];
    await runReadPages(null, { document: doc.id }, {
      matterId: 'matter-9', sealOutsidePen: false, budget: penDocumentBudget(PENS.anthropic),
      deps: { ...deps, locate: async (_sb, ref, opts) => { seen.push({ ref, ...opts }); return { doc }; } },
    });
    assert.deepEqual(seen, [{ ref: doc.id, matterId: 'matter-9', sealOutsidePen: false }]);
  });
});

// ---------------------------------------------------------------------------

test('the menu', async (t) => {
  const names = (menu) => new Set(menu.tools.map((x) => x.name));

  await t.test('offers read_pages only to a pen that can take a document block', () => {
    assert.ok(names(orchestratorMenu({ documents: true })).has('read_pages'));
    assert.ok(!names(orchestratorMenu()).has('read_pages'));
    assert.ok(!names(orchestratorMenu({ documents: false })).has('read_pages'));
  });

  await t.test('inside a seal it stays — reading a sealed matter\'s own pages on the sealed pen leaves nothing', () => {
    assert.ok(names(orchestratorMenu({ documents: true, sealed: true })).has('read_pages'));
  });

  await t.test('not in a chartered run; a narrowed run only if named', () => {
    assert.ok(!names(orchestratorMenu({ documents: true, charter: { allowed_tools: ['search'] } })).has('read_pages'));
    assert.ok(!names(orchestratorMenu({ documents: true, narrow: new Set(['search']) })).has('read_pages'));
    assert.ok(names(orchestratorMenu({ documents: true, narrow: new Set(['search', 'read_pages']) })).has('read_pages'));
  });

  await t.test('is never a server-run (callTool) tool, and its schema is strict', () => {
    const menu = orchestratorMenu({ documents: true });
    assert.ok(!menu.runTools.has('read_pages'));
    const t0 = menu.tools.find((x) => x.name === READ_PAGES_TOOL.name);
    assert.equal(t0.input_schema.additionalProperties, false);
    assert.deepEqual(t0.input_schema.required, ['document']);
  });
});

// Step 2 of the image plan (2026-09-26): a picture with no words on it is
// described so it can be found. What must hold:
//   - the four-line reply protocol parses strictly, and junk is refused;
//   - a 'picture' becomes ONE passage prefixed "[AI description]", passage_type
//     'summary', summary_level 0 (search looks only there), the row records
//     text_status 'image_described' + metadata.image_description, and OCR is
//     NOT called for it;
//   - a 'page' keeps the tier's OCR route for its words and keeps its label;
//   - a hook that throws leaves the image exactly as before (image_only) with
//     the reason recorded, never a lost document;
//   - a sealed matter never calls the hook;
//   - no hook (no key where it ran) is today's behaviour, untouched.
// No network, no database. Run: node scripts/_verify-describe-images.mjs
import assert from 'node:assert';
import { processDocument } from '../lib/ingest-core.mjs';
import { TEXT_STATUS, describeTextStatus } from '../lib/ingest-formats.mjs';
import { parseDescription, DESCRIBE_SYSTEM } from '../lib/describe-image-anthropic.mjs';
import { scannedPagePng } from './_fixtures-ingest.mjs';
import { fakeSupabase, stubEmbeddings } from './_fake-supabase.mjs';

let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };
const restoreFetch = stubEmbeddings();

const MATTER = '00000000-0000-4000-8000-000000000001';
const DOC = '00000000-0000-4000-8000-0000000000d1';
const seed = (row = {}, matter = {}) => fakeSupabase({
  matterspaces: [{ id: MATTER, parent_matterspace_id: null, ai_tier: 'A', name: 'Test', ...matter }],
  documents: [{ id: DOC, matterspace_id: MATTER, source_filename: 'render.png', witness_name: null, metadata: {}, processing_status: 'pending', storage_path: `${MATTER}/${DOC}/render.png`, ...row }],
  passages: [],
});
const passagesOf = (db) => db.tables.passages.filter((p) => p.document_id === DOC);
const docOf = (db) => db.tables.documents.find((d) => d.id === DOC);
const run = (db, fileBuf, { ocr, describe } = {}) => processDocument(db, { documentId: DOC, fileBuf, ext: '.png', openaiApiKey: 'sk-test', ocr, describe });

const PICTURE = { kind: 'picture', label: 'Luthiers workshop dusk snow falling', line: 'Luthier\'s workshop Cremona, dusk, snow falling, violins hanging, fire in hearth', text: '', model: 'claude-opus-5-5', estimated_usd: 0.0128 };
const PAGE = { kind: 'page', label: 'Typed letter Smith to Jones', line: 'Typed business letter, letterhead, signature in blue ink', text: 'Dear Mr Jones, the shipment arrived.', model: 'claude-opus-5-5', estimated_usd: 0.02 };

// --- the protocol ------------------------------------------------------------
console.log('\n[1] the four-line protocol');
{
  const p = parseDescription('KIND: picture\nLABEL: Luthiers workshop dusk snow falling\nLINE: Luthier\'s workshop Cremona, dusk, snow falling, violins hanging, fire in hearth\nTEXT: [none]\n');
  assert.deepStrictEqual(p, { kind: 'picture', label: 'Luthiers workshop dusk snow falling', line: 'Luthier\'s workshop Cremona, dusk, snow falling, violins hanging, fire in hearth', text: '' });
  const q = parseDescription('kind: Page\r\nLABEL: "Typed letter"\r\nLINE: Letter, one page.\r\nTEXT: Dear Mr Jones,\nthe shipment arrived.\nYours, Smith');
  assert.strictEqual(q.kind, 'page');
  assert.strictEqual(q.label, 'Typed letter');
  assert.strictEqual(q.line, 'Letter, one page');
  assert.strictEqual(q.text, 'Dear Mr Jones,\nthe shipment arrived.\nYours, Smith');
  assert.throws(() => parseDescription('A cosy workshop at dusk with snow.'), /protocol/);
  assert.throws(() => parseDescription('KIND: painting\nLABEL: x\nLINE: y\nTEXT: [none]'), /protocol/);
  assert.throws(() => parseDescription(''), /protocol/);
  assert(DESCRIBE_SYSTEM.includes('KIND: picture | page') && DESCRIBE_SYSTEM.includes('Luthiers workshop dusk snow falling'), 'the prompt carries the protocol and Eden\'s example');
  ok('KIND/LABEL/LINE/TEXT parses (case, CRLF, quotes, multi-line TEXT, [none] → empty); prose, an unknown KIND and an empty reply are refused');
}

// --- a picture --------------------------------------------------------------------
console.log('\n[2] a picture with no words: one [AI description] passage, findable');
{
  const png = await scannedPagePng(['']);
  const db = seed();
  let ocrCalls = 0;
  const ocr = async () => { ocrCalls++; return [{ pageNumber: 1, text: '' }]; };
  let describeCalls = 0;
  const describe = async (buf, ext) => { describeCalls++; assert.strictEqual(ext, '.png'); assert(Buffer.isBuffer(buf)); return PICTURE; };
  await run(db, png, { ocr, describe });
  const d = docOf(db);
  const ps = passagesOf(db);
  assert.strictEqual(describeCalls, 1);
  assert.strictEqual(ocrCalls, 0, 'a picture has nothing to OCR');
  assert.strictEqual(d.processing_status, 'ready');
  assert.strictEqual(d.page_count, 1);
  assert.strictEqual(ps.length, 1, 'exactly one passage');
  assert(ps[0].text.startsWith('[AI description] Luthier\'s workshop Cremona'), `prefixed: ${ps[0].text}`);
  assert(!ps[0].text.includes('Words in the picture'), 'no words, no words heading');
  assert.strictEqual(ps[0].passage_type, 'summary');
  assert.strictEqual(ps[0].summary_level, 0, 'search reads level 0 only');
  assert.strictEqual(ps[0].metadata.kind, 'image_description');
  assert.strictEqual(ps[0].metadata.label, PICTURE.label);
  assert.strictEqual(d.metadata.text_status, TEXT_STATUS.IMAGE_DESCRIBED);
  assert.strictEqual(d.metadata.image_description.label, PICTURE.label);
  assert.strictEqual(d.metadata.image_description.line, PICTURE.line);
  assert.strictEqual(d.metadata.image_description.model, 'claude-opus-5-5');
  assert.strictEqual(d.metadata.image_description.estimated_usd, 0.0128);
  assert.strictEqual(describeTextStatus(d.metadata.text_status).label, 'Picture, described');
  ok('picture → one "[AI description] …" passage (summary, level 0, labelled in metadata), row says image_described with label/line/model/cost, OCR never called');
}

// --- a picture with a sign in it ------------------------------------------------------
console.log('\n[3] words printed in a picture ride along verbatim, under their own heading');
{
  const png = await scannedPagePng(['']);
  const db = seed();
  await run(db, png, { ocr: async () => [{ pageNumber: 1, text: '' }], describe: async () => ({ ...PICTURE, text: 'CREMONA 1737' }) });
  const ps = passagesOf(db);
  assert.strictEqual(ps.length, 1);
  assert(ps[0].text.includes('\nWords in the picture: CREMONA 1737'), ps[0].text);
  assert.strictEqual(docOf(db).metadata.image_description.text, 'CREMONA 1737');
  ok('a sign in the picture is kept verbatim after "Words in the picture:", never blended into the description');
}

// --- a page ---------------------------------------------------------------------------
console.log('\n[4] a photographed page: OCR still reads the words; the label is kept');
{
  const png = await scannedPagePng(['']);
  const db = seed();
  let ocrCalls = 0;
  const ocr = async () => { ocrCalls++; return [{ pageNumber: 1, text: 'Dear Mr Jones, the shipment arrived on the fourth and the crates were intact. Yours faithfully, Smith.' }]; };
  await run(db, png, { ocr, describe: async () => PAGE });
  const d = docOf(db);
  const ps = passagesOf(db);
  assert.strictEqual(ocrCalls, 1, 'a page goes to the OCR route');
  assert(ps.length >= 1 && ps.every((p) => !p.text.startsWith('[AI description]')), 'the words are the OCR passages, not a description');
  assert(!d.metadata.text_status, 'indexed from OCR: not stored-without-text');
  assert.strictEqual(d.metadata.image_description.kind, 'page');
  assert.strictEqual(d.metadata.image_description.label, PAGE.label);
  ok('page → OCR passages as before, plus metadata.image_description for the tile');
}

// --- the hook fails ---------------------------------------------------------------------
console.log('\n[5] a description that fails, or is declined, costs nothing');
{
  const png = await scannedPagePng(['']);
  const db = seed();
  let ocrCalls = 0;
  await run(db, png, { ocr: async () => { ocrCalls++; return [{ pageNumber: 1, text: '' }]; }, describe: async () => { throw new Error('529 overloaded\nmore detail'); } });
  const d = docOf(db);
  assert.strictEqual(d.processing_status, 'ready');
  assert.strictEqual(d.metadata.text_status, TEXT_STATUS.IMAGE_ONLY, 'exactly today\'s outcome');
  assert.strictEqual(d.metadata.image_description.error, '529 overloaded', 'first line of the reason, for the backfill to find');
  assert.strictEqual(ocrCalls, 1, 'with no verdict, OCR runs as before');
  assert.strictEqual(passagesOf(db).length, 0);

  const db2 = seed();
  await run(db2, png, { ocr: async () => [{ pageNumber: 1, text: '' }], describe: async () => ({ kind: 'refused', label: '', line: '', text: '' }) });
  assert.strictEqual(docOf(db2).metadata.text_status, TEXT_STATUS.IMAGE_ONLY);
  assert.match(docOf(db2).metadata.image_description.error, /declined/);
  ok('hook throws → image_only + the reason; model declines → image_only + "declined"; OCR unchanged in both');
}

// --- sealed ------------------------------------------------------------------------------
console.log('\n[6] a sealed matter never sends a picture to the describer');
{
  const png = await scannedPagePng(['']);
  const db = seed({}, { ai_tier: 'C' });
  let describeCalls = 0;
  let outcome = 'ran';
  try {
    await run(db, png, { ocr: null, describe: async () => { describeCalls++; return PICTURE; } });
  } catch (err) {
    outcome = err.name || err.message;
  }
  assert.strictEqual(describeCalls, 0, 'not called');
  ok(`sealed (tier C) → describe never called (${outcome}); the picture keeps today\'s sealed path`);
}

// --- no hook ---------------------------------------------------------------------------------
console.log('\n[7] no hook where it ran: untouched behaviour');
{
  const png = await scannedPagePng(['']);
  const db = seed();
  await run(db, png, { ocr: async () => [{ pageNumber: 1, text: '' }] });
  const d = docOf(db);
  assert.strictEqual(d.metadata.text_status, TEXT_STATUS.IMAGE_ONLY);
  assert.strictEqual(d.metadata.image_description, undefined);
  ok('no describe hook → image_only exactly as before, nothing recorded');
}

restoreFetch();
console.log(`\nPASS — ${n} checks`);

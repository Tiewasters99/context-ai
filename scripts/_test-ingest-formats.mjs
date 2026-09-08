// Unit checks for lib/ingest-formats.mjs — the shared accepted-types list,
// storage cap, pre-upload refusals and the text_status vocabulary — plus the
// triage mapping of recorded reasons. No network. Run: node scripts/_test-ingest-formats.mjs
import assert from 'node:assert';
import {
  ACCEPTED_EXTENSIONS, SUPPORTED_EXTENSIONS, BINARY_ASSET_EXTENSIONS, PLAIN_TEXT_EXTENSIONS,
  VAULT_MAX_BYTES, TEXT_STATUS, describeTextStatus, checkUpload, extOf, formatBytes,
} from '../lib/ingest-formats.mjs';
import * as core from '../lib/ingest-core.mjs';
import { classifyTextStatus, classifyError, describe, TEXT_STATUS_CLASSES } from '../lib/ingest-triage.mjs';

let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };

// --- extension helpers ------------------------------------------------------
assert.strictEqual(extOf('Brief.PDF'), '.pdf');
assert.strictEqual(extOf('archive.tar.gz'), '.gz');
assert.strictEqual(extOf('README'), '');
assert.strictEqual(extOf('.env'), '');
assert.strictEqual(extOf('trailing.'), '');
ok('extOf: lower-cases, last dot wins, no-extension and dotfiles are empty');

// --- lists ------------------------------------------------------------------
for (const e of SUPPORTED_EXTENSIONS) assert(ACCEPTED_EXTENSIONS.includes(e), `${e} accepted`);
for (const e of BINARY_ASSET_EXTENSIONS) assert(ACCEPTED_EXTENSIONS.includes(e), `${e} accepted`);
for (const e of PLAIN_TEXT_EXTENSIONS) assert(ACCEPTED_EXTENSIONS.includes(e), `${e} accepted`);
assert(ACCEPTED_EXTENSIONS.includes('.zip'));
for (const e of ['.obj', '.fbx', '.glb', '.gltf', '.stl', '.3ds', '.blend']) assert(BINARY_ASSET_EXTENSIONS.includes(e), `${e} is a 3D asset`);
for (const e of ['.exe', '.lnk', '.sys', '.download', '.doc']) assert(!ACCEPTED_EXTENSIONS.includes(e), `${e} refused`);
assert(SUPPORTED_EXTENSIONS.includes('.rtf'), '.rtf is read (lib/rtf-text.mjs, 2026-09-07)');
ok('accepted list = supported + plain-text + 3D + zip; exe/lnk/doc are not on it; rtf is');

// ingest-core re-exports the same arrays (identity, not copies), so no surface
// can drift from the pipeline.
assert.strictEqual(core.SUPPORTED_EXTENSIONS, SUPPORTED_EXTENSIONS);
assert.strictEqual(core.BINARY_ASSET_EXTENSIONS, BINARY_ASSET_EXTENSIONS);
assert.strictEqual(core.VAULT_MAX_BYTES, VAULT_MAX_BYTES);
assert.strictEqual(core.TEXT_STATUS, TEXT_STATUS);
ok('ingest-core re-exports the very same objects');

// --- storage cap --------------------------------------------------------------
assert.strictEqual(VAULT_MAX_BYTES, 500 * 1024 * 1024, 'cap matches the live vault-documents bucket (500 MB, 2026-09-04)');
assert.strictEqual(formatBytes(VAULT_MAX_BYTES), '500 MB');
assert.strictEqual(formatBytes(2 * 1024 * 1024 * 1024), '2.0 GB');
assert.strictEqual(formatBytes(512), '1 KB');
ok('VAULT_MAX_BYTES = 500 MB and formats as a person reads it');

// --- checkUpload ------------------------------------------------------------
assert.strictEqual(checkUpload({ name: 'brief.pdf', size: 1024 }), null);
assert.strictEqual(checkUpload({ name: 'brief.pdf', size: VAULT_MAX_BYTES }), null, 'exactly the cap is allowed');
assert.strictEqual(checkUpload({ name: 'model.obj', size: 1024 }), null, '3D assets pass the type check');
assert.strictEqual(checkUpload({ name: 'data.csv', size: 1024 }), null, 'plain-text family passes');
assert.strictEqual(checkUpload({ name: 'production.zip', size: 1024 }), null, 'zip passes (expanded client-side)');
assert.strictEqual(checkUpload({ name: 'Outlook-County Att', size: 1024 }), null, 'no extension → let the pipeline sniff it');

const big = checkUpload({ name: 'record.pdf', size: VAULT_MAX_BYTES + 1 });
assert.strictEqual(big.code, 'too_large');
assert.match(big.message, /"record\.pdf" is 500 MB; the Vault accepts files up to 500 MB/);
assert.match(big.message, /Split it/);
const huge = checkUpload({ name: 'record.pdf', size: 1.5 * 1024 * 1024 * 1024 });
assert.match(huge.message, /is 1\.5 GB/);
ok('too_large: names the file, its size, and the cap, and says what to do');

const exe = checkUpload({ name: 'setup.exe', size: 10 });
assert.strictEqual(exe.code, 'unsupported');
assert.match(exe.message, /"setup\.exe" is a \.exe file, which the Vault can't read/);
assert.match(exe.message, /Supported: PDF, Word \(\.docx, \.rtf\)/);
const doc = checkUpload({ name: 'memo.DOC', size: 10 });
assert.strictEqual(doc.code, 'unsupported');
assert.match(doc.message, /Save the legacy Word file as \.docx/);
ok('unsupported: names the extension, lists the supported types, hints for .doc');

const lock = checkUpload({ name: '~$tersburg Timeline.docx', size: 162 });
assert.strictEqual(lock.code, 'lock_file');
assert.match(lock.message, /temporary Office lock file, not a document/);
assert.strictEqual(checkUpload({ name: 'C:\\Users\\eq\\~$brief.docx', size: 162 }).code, 'lock_file', 'a path still names the lock file');
assert.strictEqual(checkUpload({ name: 'Notes ~$ draft.docx', size: 162 }), null, 'only the ~$ PREFIX marks a lock file');
const empty = checkUpload({ name: 'create.md', size: 0 });
assert.strictEqual(empty.code, 'empty');
assert.match(empty.message, /is empty \(0 bytes\)/);
assert.strictEqual(checkUpload({ name: 'create.md' }), null, 'an unknown size is not "empty"');
ok('lock_file and empty: refused at selection with the reason (P6, 2026-09-07)');

// Size is checked before type: an oversize unsupported file is refused for
// size (the more expensive mistake to let through).
assert.strictEqual(checkUpload({ name: 'x.exe', size: VAULT_MAX_BYTES + 1 }).code, 'too_large');
ok('size outranks type');

// .zip is accepted on every path since Phase 3: the web Vault expands it in
// the browser, everything else unpacks it at ingest. The old zip:false
// option is tolerated and changes nothing.
assert.strictEqual(checkUpload({ name: 'production.zip', size: 10 }), null);
assert.strictEqual(checkUpload({ name: 'production.zip', size: 10 }, { zip: false }), null);
assert.match(checkUpload({ name: 'x.exe', size: 10 }, { zip: false }).message, /zip archives of those/);
ok('zip: accepted everywhere (unpacked at ingest where the browser did not)');

// --- text_status vocabulary ---------------------------------------------------
assert.deepStrictEqual(Object.values(TEXT_STATUS).sort(),
  ['archive', 'binary_stored', 'generated', 'image_only', 'media_no_transcript', 'no_text', 'ocr_pending', 'portfolio', 'unsupported']);
for (const s of Object.values(TEXT_STATUS)) {
  const d = describeTextStatus(s);
  assert(d.label && d.label.length > 8, `${s} label`);
  assert(d.detail && d.detail.length > 30, `${s} detail`);
  assert(!/text_status|metadata|null|undefined/i.test(d.label + d.detail), `${s} reads as prose, not developer-speak`);
}
const unknown = describeTextStatus('something_new');
assert.strictEqual(unknown.label, 'Stored without text');
assert.match(unknown.detail, /something_new/);
ok('every text_status has a plain label + detail; unknown values still render');

// --- triage mapping -----------------------------------------------------------
// Every stored-with-a-reason status is a benign, muted stored_* class — except
// ocr_pending (Phase 2), which is transient and must surface: it is checked
// on its own below.
for (const s of Object.values(TEXT_STATUS)) {
  if (s === TEXT_STATUS.OCR_PENDING) continue;
  const cls = classifyTextStatus(s);
  assert(TEXT_STATUS_CLASSES.includes(cls), `${s} → ${cls} is a listed class`);
  assert.strictEqual(describe(cls).severity, 'benign', `${cls} is benign`);
  assert.strictEqual(describe(cls).retryable, false, `${cls} is not retryable`);
  assert(describe(cls).action.length > 30, `${cls} has an action`);
}
assert.strictEqual(classifyTextStatus(null), null);
assert.strictEqual(classifyTextStatus(TEXT_STATUS.OCR_PENDING), 'ocr_pending');
assert(!TEXT_STATUS_CLASSES.includes('ocr_pending'), 'ocr_pending is not a muted stored_* class');
assert.strictEqual(describe('ocr_pending').severity, 'transient', 'a scan awaiting OCR is transient, not benign');
assert.strictEqual(classifyTextStatus(''), null);
assert.strictEqual(classifyTextStatus('future_value'), 'stored_without_text');
ok('classifyTextStatus: six benign classes, null for none, generic for unknown');

// The scanned-without-OCR failure ingest-core now writes must escalate as
// ocr_needed (blocking), not as a benign photo.
assert.strictEqual(
  classifyError('Scanned PDF — OCR not configured (12 page(s), 31 chars of text). Set GOOGLE_API_KEY where this ingest runs, then Retry.'),
  'ocr_needed');
assert.strictEqual(describe('ocr_needed').severity, 'blocking');
assert.strictEqual(classifyError('no passages extracted'), 'no_text', 'legacy rows keep their class');
ok('"OCR not configured" → ocr_needed (blocking); legacy "no passages extracted" unchanged');

// --- Phase 6 (2026-09-07): the extractors behind the new G0 fixtures -------------
const { rtfToText } = await import('../lib/rtf-text.mjs');
const rtf = '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}}{\\colortbl;\\red0\\green0\\blue0;}' +
  '\\f0\\fs24 Memorandum\\par The memo mentions a heliotrope ledger, caf\\\'e9 and a \\u8220?quoted\\u8221? phrase.\\par{\\*\\generator Fixture 1.0}}';
const rtfText = rtfToText(Buffer.from(rtf, 'latin1'));
assert.match(rtfText, /^Memorandum\nThe memo mentions a heliotrope ledger, café and a “quoted” phrase\.$/);
assert(!/Times New Roman|generator|\\par/.test(rtfText), 'font table, generator and control words are not text');
const [rtfPage] = await core.extractPages(Buffer.from(rtf, 'latin1'), '.rtf');
assert.strictEqual(rtfPage.pageNumber, 1);
assert.match(rtfPage.text, /heliotrope ledger/);
ok('rtf: control words, tables and \\* destinations dropped; \\\'hh and \\uN decoded; extractPages routes .rtf');

const ALLOWED_PASSAGE_TYPES = new Set(['qa_pair', 'monologue', 'colloquy', 'exhibit_reference', 'section_heading', 'chapter_heading', 'footnote', 'summary']);
const screenplay = 'Title: Test\nAuthor: Fixture\n\nINT. ROOM - DAY\n\nA clerk lifts a verdigris ledger.\n\nCLERK\nFile it.\n\nCUT TO:\n\nEXT. STEPS - CONTINUOUS\n\nShe leaves.\n';
const fountainPassages = await core.chunkFountain(screenplay);
assert(fountainPassages.length >= 5, `screenplay yields passages (${fountainPassages.length})`);
for (const p of fountainPassages) assert(ALLOWED_PASSAGE_TYPES.has(p.passage_type), `passage_type "${p.passage_type}" is inside the check constraint (migration 007)`);
assert(fountainPassages.some((p) => p.metadata?.element === 'scene_heading' && p.passage_type === 'section_heading'), 'scene headings are section headings, and remember they are scene headings');
assert(fountainPassages.some((p) => p.metadata?.element === 'character_dialogue' && p.speaker === 'CLERK'), 'dialogue keeps its speaker');
ok('fountain: every passage_type satisfies the passages check constraint; the screenplay element is kept in metadata');

const loginPage = '<html><head><title>Case Search</title></head><body><a>Case Search</a> <a>Calendar</a> <a>Logout</a> <div>PACER Service Center</div><div>Change Client</div></body></html>';
await assert.rejects(() => core.extractPages(Buffer.from(loginPage), '.html'), /court website page \("Case Search"\), not the filing/);
const [htmlPage] = await core.extractPages(Buffer.from('<html><body><h1>Opinion</h1><p>The court held &amp; ordered.</p><script>x()</script></body></html>'), '.html');
assert.strictEqual(htmlPage.text, 'Opinion\nThe court held & ordered.');
assert(core.isPdfStructureError(new Error('bad XRef entry')) && core.isPdfStructureError(new Error('Invalid PDF structure')) && !core.isPdfStructureError(new Error('embed 429')));
ok('html: tags stripped, a CM/ECF screen refused with the reason; isPdfStructureError names the parser rejections');

console.log(`\nPASS (${n} checks)`);

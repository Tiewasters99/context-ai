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
for (const e of ['.exe', '.lnk', '.sys', '.download', '.doc', '.rtf']) assert(!ACCEPTED_EXTENSIONS.includes(e), `${e} refused`);
ok('accepted list = supported + plain-text + 3D + zip; exe/lnk/doc/rtf are not on it');

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
assert.match(exe.message, /Supported: PDF, Word \(\.docx\)/);
const doc = checkUpload({ name: 'memo.DOC', size: 10 });
assert.strictEqual(doc.code, 'unsupported');
assert.match(doc.message, /Save the legacy Word file as \.docx/);
ok('unsupported: names the extension, lists the supported types, hints for .doc');

// Size is checked before type: an oversize unsupported file is refused for
// size (the more expensive mistake to let through).
assert.strictEqual(checkUpload({ name: 'x.exe', size: VAULT_MAX_BYTES + 1 }).code, 'too_large');
ok('size outranks type');

// .zip is accepted only where archives get expanded (the web Vault). The MCP
// file_document path passes zip:false and gets a refusal that says why, and
// its supported-types list no longer advertises archives.
assert.strictEqual(checkUpload({ name: 'production.zip', size: 10 }, { zip: true }), null);
const z = checkUpload({ name: 'production.zip', size: 10 }, { zip: false });
assert.strictEqual(z.code, 'unsupported');
assert.match(z.message, /\.zip archive, which this path does not unpack/);
assert.doesNotMatch(z.message, /zip archives of those/);
assert.doesNotMatch(checkUpload({ name: 'x.exe', size: 10 }, { zip: false }).message, /zip archives/);
ok('zip: accepted with expansion, refused with a reason without it');

// --- text_status vocabulary ---------------------------------------------------
assert.deepStrictEqual(Object.values(TEXT_STATUS).sort(),
  ['binary_stored', 'image_only', 'media_no_transcript', 'no_text', 'ocr_pending', 'portfolio', 'unsupported']);
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

console.log(`\nPASS (${n} checks)`);

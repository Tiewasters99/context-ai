// What a new paying user hits on day one — asserted offline.
//
//   node scripts/_verify-ingest-day-one.mjs
//
// No network, no database, no provider key, no paid call. Four things are
// checked, each of them a defect found in the 2026-09-19 ingestion audit:
//
//   1. The file types a lawyer actually has. .heic (an iPhone photo), .doc,
//      .msg were refused with a message that named no way forward. Every one
//      of them is now refused at SELECTION with the alternative in it — and
//      the check is that the alternative is really there, in words, not that
//      a code came back.
//   2. The inline/worker routing decision, over a matrix of (extension, size)
//      plus the page-count half of the rule that size cannot see.
//   3. The nightly suite's deadlines, driven with a gate that never returns.
//   4. The monitor digest's tenant privacy, with two owners in the same run.
//
// and then scripts/_verify-ocr-routes.mjs is run as a child process, because
// its own offline assertions are the fifth thing and CI carries one step.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  checkUpload, ACCEPTED_EXTENSIONS, SUPPORTED_EXTENSIONS, UNSUPPORTED_HINTS, unsupportedHint,
  VAULT_MAX_BYTES,
} from '../lib/ingest-formats.mjs';
import { needsWorkerIngest, inlineBudgetClass, INLINE_MAX_BYTES, planPdfOcr, sniffExtension } from '../lib/ingest-core.mjs';
import { withDeadline, writeCheckpoint, readCheckpoint, startOverallDeadline } from './_suite-deadline.mjs';
import { render, describeRow, ownerCounts, parseFilenameOwners, shortOwner } from './ingest-monitor.mjs';
import { summarize } from '../lib/ingest-triage.mjs';
import { mixedPdf, textPdf, proseLines } from './_fixtures-ingest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MB = 1024 * 1024;
let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };

// =============================================================================
// 1. The types a lawyer has on day one
// =============================================================================
console.log('\n[1] file types: accepted, or refused with the alternative named');
{
  // The table. Each refused type must name a way forward that a person could
  // act on without asking anyone — which is why the expectation is a phrase
  // from the alternative, not a code.
  const REFUSED = [
    ['IMG_4021.HEIC', /Most Compatible/i, 'iPhone photo (High Efficiency)'],
    ['IMG_4021.heic', /JPEG/i, 'iPhone photo, lower case'],
    ['scan.heif', /JPEG or PNG/i, 'HEIF image'],
    ['Motion to Dismiss.doc', /Save the legacy Word file as \.docx/i, 'pre-2007 Word'],
    ['Damages model.xls', /\.xlsx/i, 'pre-2007 Excel'],
    ['Opening.ppt', /\.pptx/i, 'pre-2007 PowerPoint'],
    ['RE Discovery schedule.msg', /\.eml/i, 'Outlook message'],
    ['RE Discovery schedule.msg', /print it to PDF/i, 'Outlook message — the PDF route'],
    ['archive.pst', /Export the messages/i, 'Outlook mailbox'],
    ['Brief.pages', /Export it as PDF/i, 'Pages'],
    ['Exhibits.key', /\.pptx/i, 'Keynote'],
    ['Old memo.wpd', /WordPerfect/i, 'WordPerfect'],
  ];
  for (const [name, expect, what] of REFUSED) {
    const r = checkUpload({ name, size: 2_000_000 });
    assert(r && r.code === 'unsupported', `${what}: expected an 'unsupported' refusal, got ${JSON.stringify(r)}`);
    assert(expect.test(r.message), `${what}: the refusal does not name the alternative — "${r.message}"`);
    // The shape the suite's G4 asserts on must survive: the sentence, then
    // the hint, then the supported list.
    assert(/which the Vault can't read\./.test(r.message), `${what}: refusal lost its opening sentence`);
    assert(/Supported: PDF/.test(r.message), `${what}: refusal lost the supported list`);
  }
  ok(`${REFUSED.length} day-one formats are refused at selection, each naming what to do instead (HEIC → Most Compatible/JPEG, .doc/.xls/.ppt → Save As, .msg/.pst → .eml or PDF)`);

  // None of them may be quietly accepted: a half-accepted type that ingests
  // to zero passages is worse than a refusal, because nothing says so.
  for (const ext of ['.heic', '.heif', '.doc', '.msg', '.pst', '.xls', '.ppt']) {
    assert(!ACCEPTED_EXTENSIONS.includes(ext), `${ext} is refused by message but present in ACCEPTED_EXTENSIONS`);
    assert(!SUPPORTED_EXTENSIONS.includes(ext), `${ext} claims a text extractor it does not have`);
    assert(unsupportedHint(ext).length > 20, `${ext} has no named alternative`);
  }
  ok('and none of them is in ACCEPTED_EXTENSIONS or SUPPORTED_EXTENSIONS — refused at selection, never half-accepted');

  // Every hint is written to be appended to a sentence, and every hinted type
  // really is one the pipeline refuses (a hint for an accepted type would be
  // dead text that nobody ever sees).
  for (const [ext, hint] of Object.entries(UNSUPPORTED_HINTS)) {
    assert(hint.startsWith(' '), `hint for ${ext} does not start with a space`);
    assert(/[.!]\)?$/.test(hint.trim()), `hint for ${ext} is not a sentence`);
    assert(!ACCEPTED_EXTENSIONS.includes(ext), `${ext} has a refusal hint but is accepted`);
  }
  ok(`all ${Object.keys(UNSUPPORTED_HINTS).length} hints are sentences, and every hinted extension is one the Vault really refuses`);

  // What still works, unchanged. A refusal table is only safe if it cannot
  // creep over the formats people upload every day.
  for (const name of ['Brief.docx', 'scan.pdf', 'page.jpg', 'page.JPEG', 'production.tif', 'notes.md', 'book.epub', 'thread.eml', 'memo.rtf', 'workbook.xlsx', 'deck.pptx', 'hearing.mp4', 'exhibits.zip', 'model.obj', 'index.csv']) {
    assert.strictEqual(checkUpload({ name, size: 1_000 }), null, `${name} must still be accepted`);
  }
  assert.strictEqual(checkUpload({ name: 'no-extension-attachment', size: 1_000 }), null);
  ok('the everyday formats are untouched, and a file with no extension is still let through for the magic-byte sniff');

  // The other half of "a lawyer has an iPhone": the same photo saved without
  // an extension. Its ftyp box used to read as .mp4 and be sent to the A/V
  // transcriber — a paid call on a still picture.
  const heicHeader = Buffer.concat([
    Buffer.alloc(4), Buffer.from('ftypheic', 'latin1'), Buffer.from('mif1MiHB', 'latin1'), Buffer.alloc(16),
  ]);
  heicHeader.writeUInt32BE(24, 0);
  assert.strictEqual(sniffExtension(heicHeader), null, 'a HEIC with no extension must not sniff as video');
  const mp4Header = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(16)]);
  assert.strictEqual(sniffExtension(mp4Header), '.mp4');
  const m4aHeader = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ', 'latin1'), Buffer.alloc(16)]);
  assert.strictEqual(sniffExtension(m4aHeader), '.m4a');
  ok('magic bytes: a HEIC/AVIF ftyp brand no longer sniffs as .mp4 (no transcription call on a photograph); real mp4 and m4a still do');

  // The refusals that were already right stay right.
  assert.strictEqual(checkUpload({ name: '~$Brief.docx', size: 162 })?.code, 'lock_file');
  assert.strictEqual(checkUpload({ name: 'export.md', size: 0 })?.code, 'empty');
  assert.strictEqual(checkUpload({ name: 'record.pdf', size: VAULT_MAX_BYTES + 1 })?.code, 'too_large');
  ok('lock file, zero bytes and over-cap are still refused before any byte moves');
}

// =============================================================================
// 2. Inline or worker: the routing decision
// =============================================================================
console.log('\n[2] routing: what a 60 s serverless budget may attempt');
{
  // (ext, bytes) → expected route. The audit's case is the first row.
  const CASES = [
    ['.docx', 15 * MB, true, 'the audit\'s stranded document: a 15 MB Word file used to run inline'],
    ['.pptx', 15 * MB, true, 'a 15 MB deck, likewise'],
    ['.docx', 400 * 1024, false, 'an ordinary brief still takes the fast inline path'],
    ['.pptx', 900 * 1024, false, 'an ordinary deck too'],
    ['.xlsx', 2 * MB, true, 'a 2 MB workbook is past the packed-container ceiling'],
    ['.epub', 5 * MB, true, 'a 5 MB e-book is a book'],
    ['.txt', 1.5 * MB, false, '1.5 MB of plain text is ~600 passages — inside the budget'],
    ['.txt', 8 * MB, true, '8 MB of plain text is thousands of embedding requests'],
    ['.rtf', 6 * MB, true, 'a 6 MB Westlaw export, likewise'],
    ['.md', 100 * 1024, false, 'notes stay inline'],
    ['.pdf', 9 * MB, false, 'a born-digital PDF under 10 MB is unchanged'],
    ['.pdf', 12 * MB, true, 'a big PDF is unchanged too'],
    ['.jpg', 3 * MB, false, 'one photographed page is one OCR call'],
    ['.jpg', 12 * MB, true, 'a 12 MB photo is not'],
    ['.tif', 400 * 1024, true, 'TIFF always: sharp has never run on a Vercel function'],
    ['.tiff', 10, true, 'TIFF always, however small'],
    ['.zip', 1_000, true, 'an archive fans out into N uploads and N jobs'],
    ['.wma', 1_000, true, 'ffmpeg transcode'],
    ['.mp3', 8 * MB, false, 'a short recording transcribes inline'],
    ['.mp4', 40 * MB, true, 'a long one does not'],
    ['.obj', 15 * MB, false, 'a 3D asset is stored, never extracted'],
    ['.obj', 60 * MB, true, 'but the download alone would spend the budget'],
    ['.xyz', 3 * MB, true, 'an unknown extension is priced as the worst thing it could turn out to be'],
    ['.pdf', 400 * MB, true, 'anything huge, whatever it is'],
  ];
  for (const [ext, size, want, why] of CASES) {
    assert.strictEqual(needsWorkerIngest(ext, size), want,
      `${ext} at ${(size / MB).toFixed(1)} MB should go ${want ? 'to the worker' : 'inline'} — ${why}`);
  }
  ok(`${CASES.length} (extension, size) cases route as intended; the 15 MB .docx that used to run inline on a 60 s budget now goes to the queue`);

  // Case sensitivity and missing sizes: a filename from Windows is .DOCX, and
  // an MCP caller may not know the size yet.
  assert.strictEqual(needsWorkerIngest('.DOCX', 15 * MB), true);
  assert.strictEqual(needsWorkerIngest('.TIFF', 10), true);
  assert.strictEqual(needsWorkerIngest('.docx', null), false);
  assert.strictEqual(needsWorkerIngest('.docx', undefined), false);
  ok('an upper-case extension routes the same way; a null size falls back to the inline path, as before');

  // The ceilings themselves must stay ordered and inside the budget.
  assert(INLINE_MAX_BYTES.packed < INLINE_MAX_BYTES.text, 'a compressed container must have a LOWER ceiling than raw text');
  assert(INLINE_MAX_BYTES.text <= 4 * MB, '4 MB of text is already 30–60 s of embedding — never raise this to it');
  for (const v of Object.values(INLINE_MAX_BYTES)) assert(v > 0 && v <= 20 * MB);
  assert.strictEqual(inlineBudgetClass('.docx'), 'packed');
  assert.strictEqual(inlineBudgetClass('.md'), 'text');
  assert.strictEqual(inlineBudgetClass('.csv'), 'text');
  assert.strictEqual(inlineBudgetClass('.pdf'), 'pdf');
  assert.strictEqual(inlineBudgetClass('.mov'), 'media');
  assert.strictEqual(inlineBudgetClass('.png'), 'image');
  assert.strictEqual(inlineBudgetClass('.glb'), 'binary');
  assert.strictEqual(inlineBudgetClass('.nonsense'), 'other');
  ok('the ceilings are ordered (packed < text), none exceeds the 20 MB hard stop, and every extension lands in the class it belongs to');

  // The half of the rule size cannot see: page count. A PDF small enough to
  // run inline still goes to the worker when any page needs OCR.
  const mixed = await mixedPdf();
  const plan = await planPdfOcr(mixed);
  assert.strictEqual(plan.pageCount, 5);
  assert.deepStrictEqual(plan.ocrPages, [4, 5]);
  assert.strictEqual(needsWorkerIngest('.pdf', mixed.length), false, 'the fixture is small — size alone says inline');
  const typed = await textPdf(proseLines('typed', 12));
  const typedPlan = await planPdfOcr(typed);
  assert.strictEqual(typedPlan.ocrPages.length, 0);
  const garbage = await planPdfOcr(Buffer.from('not a pdf'));
  assert.deepStrictEqual(garbage.ocrPages, []);
  assert(garbage.error, 'an unparseable PDF must say so rather than claim zero OCR pages');
  ok('page count decides what size cannot: a small mixed PDF reports pages 4 and 5 awaiting OCR (so the caller queues it), a born-digital one reports none, and an unparseable one says it could not be read');
}

// =============================================================================
// 3. The nightly suite cannot hang the night any more
// =============================================================================
console.log('\n[3] suite deadlines, driven with a gate that never returns');
{
  const t0 = Date.now();
  const hung = await withDeadline(() => new Promise(() => {}), 120);
  assert.strictEqual(hung.timedOut, true);
  assert(Date.now() - t0 >= 100 && Date.now() - t0 < 5_000, 'the deadline did not fire when it should have');
  ok('a gate that never returns is abandoned at its budget instead of hanging the run (the 2026-09-18 failure)');

  const fine = await withDeadline(async () => 'done', 5_000);
  assert.deepStrictEqual({ timedOut: fine.timedOut, value: fine.value }, { timedOut: false, value: 'done' });
  await assert.rejects(() => withDeadline(async () => { throw new Error('a real failure'); }, 5_000), /a real failure/);
  ok('a gate that finishes returns its value; a gate that throws still throws — a deadline is not a way to swallow failures');

  // The trap that turns a timeout into a crash: the abandoned gate rejects
  // later, and an unhandled rejection kills Node before the report is
  // written. It must be caught, and reported, without taking the process out.
  let abandonedErr = null;
  const late = await withDeadline(
    () => new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 60)),
    20,
    { onAbandon: (e) => { abandonedErr = e; } },
  );
  assert.strictEqual(late.timedOut, true);
  await new Promise((r) => setTimeout(r, 200));
  assert(abandonedErr && /late failure/.test(abandonedErr.message), 'the abandoned gate\'s later failure was not reported');
  ok('an abandoned gate that fails a moment later is reported, not thrown: the run survives to write its record');

  // The checkpoint: what a TerminateProcess kill (Task Scheduler's own
  // timeout, exit 0xC000013A) leaves behind, since no handler runs for it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-cp-'));
  const file = path.join(dir, 'nested', 'ingest-suite-checkpoint.json');
  assert.strictEqual(writeCheckpoint(file, { run: 'abc', phase: 'G8 bulk vs a single upload', pass: false, gates: { G0: 'pass', G8: 'none' } }), true);
  const back = readCheckpoint(file);
  assert.strictEqual(back.phase, 'G8 bulk vs a single upload');
  assert.strictEqual(back.pass, false, 'a partial record must never read as a pass — the streak has to reset');
  assert.strictEqual(back.gates.G8, 'none');
  writeCheckpoint(file, { run: 'abc', phase: 'cleanup', pass: false });
  assert.strictEqual(readCheckpoint(file).phase, 'cleanup', 'the checkpoint must be rewritten, not appended');
  assert(!fs.existsSync(`${file}.tmp`), 'the temp file must be renamed away, so a reader never sees half a record');
  assert.strictEqual(readCheckpoint(path.join(dir, 'does-not-exist.json')), null);
  fs.writeFileSync(file, '{ truncated');
  assert.strictEqual(readCheckpoint(file), null, 'an unreadable checkpoint reads as absent, not as a crash');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('the checkpoint survives a kill no handler sees: written atomically after every gate, rewritten in place, says pass:false, and reads back as null rather than throwing when it is damaged');

  let fired = false;
  const alarm = startOverallDeadline(50, () => { fired = true; });
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(fired, true, 'the whole-run deadline never fired');
  const cancelled = startOverallDeadline(50, () => { throw new Error('a cancelled alarm must not fire'); });
  cancelled.cancel();
  alarm.cancel();
  await new Promise((r) => setTimeout(r, 120));
  ok('the whole-run alarm fires once and can be cancelled when the suite finishes on its own');
}

// =============================================================================
// 4. The digest may not mail one tenant's filenames to another account
// =============================================================================
console.log('\n[4] monitor digest: counts and ids, filenames only for the operator');
{
  const EDEN = '11111111-1111-4111-8111-111111111111';
  const CLIENT = '22222222-2222-4222-8222-222222222222';
  const rows = [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Quainton — engagement letter.docx', matter: 'm1', owner: EDEN, error: 'ready with zero passages', cls: 'ready_but_empty' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Doe v. Archdiocese — settlement terms.pdf', matter: 'm2', owner: CLIENT, error: 'ready with zero passages', cls: 'ready_but_empty' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000003', name: 'Doe v. Archdiocese — therapy records.pdf', matter: 'm2', owner: CLIENT, error: 'ready with zero passages', cls: 'ready_but_empty' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000004', name: 'Roe medical chronology.docx', matter: 'm2', owner: CLIENT, error: "stuck in 'extracting' since …", cls: 'stuck' },
  ];
  const report = summarize(rows);
  const escalate = report.groups;
  const secrets = /Archdiocese|therapy|chronology|engagement/;

  // Default: nothing named. This is the state a fresh install is in.
  const shut = render({ report, escalate, escalatedRows: rows, jobs: [], staleMin: 45, allowed: parseFilenameOwners({}) });
  assert(!secrets.test(shut), `a filename reached the default digest:\n${shut}`);
  for (const r of rows) assert(shut.includes(r.id.slice(0, 20)) || shut.includes(r.id), 'the digest must still name the documents by id');
  assert(/By owner: /.test(shut));
  assert(new RegExp(`${shortOwner(CLIENT)} ×3`).test(shut), `owner counts missing:\n${shut}`);
  assert(new RegExp(`${shortOwner(EDEN)} ×1`).test(shut), `owner counts missing:\n${shut}`);
  ok('with INGEST_MONITOR_FILENAME_OWNERS unset, two owners\' documents are reported as counts and ids and not one filename appears');

  // Opted in for the operator only: his own filenames come back, the other
  // tenant's do not — which is the whole point.
  const opened = render({ report, escalate, escalatedRows: rows, jobs: [], staleMin: 45, allowed: parseFilenameOwners({ INGEST_MONITOR_FILENAME_OWNERS: EDEN }) });
  assert(/engagement letter/.test(opened), 'the operator opted in and still cannot see his own filenames');
  assert(!/Archdiocese|therapy|chronology/.test(opened), `the other tenant's filenames leaked:\n${opened}`);
  ok('naming the operator\'s own user id shows HIS filenames and still hides the other tenant\'s');

  // Case and whitespace in the env var must not silently disable the opt-in.
  assert(/engagement letter/.test(render({ report, escalate, escalatedRows: rows, jobs: [], staleMin: 45, allowed: parseFilenameOwners({ INGEST_MONITOR_FILENAME_OWNERS: ` ${EDEN.toUpperCase()} , ` }) })));
  assert.strictEqual(parseFilenameOwners({}).size, 0);
  assert.strictEqual(parseFilenameOwners({ INGEST_MONITOR_FILENAME_OWNERS: '' }).size, 0);
  assert.strictEqual(parseFilenameOwners({ INGEST_MONITOR_FILENAME_OWNERS: ` ${EDEN} ,${CLIENT}` }).size, 2);
  ok('the allow-list tolerates spacing and case, and is empty for an unset or blank value');

  // The row line itself, and a document whose owner was never recorded.
  const allowed = parseFilenameOwners({ INGEST_MONITOR_FILENAME_OWNERS: EDEN });
  assert.strictEqual(describeRow(rows[1], allowed), `${rows[1].id}  (owner ${shortOwner(CLIENT)})`);
  assert(describeRow(rows[0], allowed).endsWith('Quainton — engagement letter.docx'));
  assert.strictEqual(describeRow({ id: 'x', name: 'secret.pdf' }, allowed), 'x  (owner unknown)');
  assert.strictEqual(describeRow({ id: 'x', name: 'secret.pdf' }, parseFilenameOwners({ INGEST_MONITOR_FILENAME_OWNERS: 'unknown' })), 'x  (owner unknown)');
  ok('a document with no recorded owner is never named, and "unknown" in the allow-list does not become a wildcard for them');

  assert.deepStrictEqual(ownerCounts(rows), [
    { owner: shortOwner(CLIENT), count: 3 },
    { owner: shortOwner(EDEN), count: 1 },
  ]);
  ok('owner counts are over every escalated row, not over the five kept as examples');

  // The monitor is importable (this file just imported it) because a guard
  // stops main() running on import. If that guard were ever wrong the other
  // way, the script would exit 0 printing nothing — and the suite's G9 reads
  // exit 0 as "nothing needs attention", so the health check would go dark
  // and report itself healthy. Prove it still RUNS when run. A deliberately
  // invalid URL and a PASTE_ key make it refuse before it opens a client, so
  // this reaches no network and works the same in a checkout that has a real
  // .env (loadEnv never overrides a variable that is already set).
  const child = spawnSync(process.execPath, [path.join(__dirname, 'ingest-monitor.mjs')], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, VITE_SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'PASTE_NEW_KEY_HERE' },
  });
  const childOut = `${child.stdout || ''}${child.stderr || ''}`;
  assert.strictEqual(child.status, 2, `ingest-monitor.mjs did not run as a script (exit ${child.status}) — a silent exit 0 would make G9 read "healthy":\n${childOut.slice(0, 400)}`);
  assert(/PASTE_NEW/.test(childOut), `ingest-monitor.mjs ran but not far enough to check its credentials:\n${childOut.slice(0, 400)}`);
  ok('ingest-monitor.mjs still runs its sweep when invoked as a script (exit 2 on a placeholder key) — the import guard did not turn the health check into a silent exit 0');

  // What the nightly suite's G9 gate parses out of this text must survive.
  const blockingRe = /\[BLOCKING\] ([^—\n]+) — (\d+) document/g;
  assert([...shut.matchAll(blockingRe)].length > 0, `G9 can no longer find the [BLOCKING] lines:\n${shut}`);
  assert(/(\d+) need a decision from you/.test(shut), 'G9 can no longer count the decisions line');
  ok('the two lines the suite\'s G9 gate regex-parses are unchanged, so redaction cannot silently zero the monitor gate');
}

// =============================================================================
// 5. The OCR route policy (its own file, so --live stays available there)
// =============================================================================
console.log('\n[5] OCR route policy — scripts/_verify-ocr-routes.mjs');
{
  const r = spawnSync(process.execPath, [path.join(__dirname, '_verify-ocr-routes.mjs')], { encoding: 'utf8', timeout: 120_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.strictEqual(r.status, 0, `_verify-ocr-routes.mjs failed (exit ${r.status}):\n${out.slice(-2000)}`);
  assert(/PASS — \d+ offline checks/.test(out), `_verify-ocr-routes.mjs no longer asserts anything:\n${out.slice(0, 500)}`);
  const claimed = Number(/PASS — (\d+) offline checks/.exec(out)[1]);
  assert(claimed >= 4, `expected at least 4 offline checks there, got ${claimed}`);
  n += claimed;
  ok(`route selection per tier and "a sealed route never picks a non-sealed provider" assert ${claimed} checks of their own (it used to print a table and exit 0 whatever it printed)`);
}

console.log(`\nPASS — ${n} checks`);

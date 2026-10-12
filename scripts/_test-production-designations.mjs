// Designations, the two new preset tags, and per-document stamp position.
//
//   node scripts/_test-production-designations.mjs
//
// Offline (PGlite for migration 111). Pins, one at a time:
//   * the load file's CONFIDENTIALITY carries the designation's own words,
//     the most restrictive when a document carries two, and nothing for an
//     endorsement that is not a designation (DRAFT, PRIVILEGED);
//   * the AEO endorsement is drawable and fits a letter page in every corner;
//   * the presets include Attorneys' Eyes Only (prints) and Irrelevant
//     (withheld, like Non-Responsive);
//   * migration 111 adds production_items.stamp_position, refuses an unknown
//     corner, is re-runnable; the worker stamps each document at its own
//     position and falls back to the production's for null or junk.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { confidentialityOf, designationRank } from '../lib/discovery/designations.mjs';
import { packageDocument } from '../lib/discovery/package-docs.mjs';
import { emitDat, parseDat } from '../lib/discovery/loadfile.mjs';
import { stampPdf, undrawableChars, BATES_POSITIONS } from '../lib/discovery/bates-stamp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (m) => { n++; console.log(`  PASS  ${m}`); };
const AEO = "HIGHLY CONFIDENTIAL - ATTORNEYS' EYES ONLY";

// 1. CONFIDENTIALITY values.
assert.equal(confidentialityOf([]), '');
assert.equal(confidentialityOf(['CONFIDENTIAL']), 'CONFIDENTIAL');
assert.equal(confidentialityOf([AEO]), AEO);
assert.equal(confidentialityOf(["ATTORNEYS' EYES ONLY"]), "ATTORNEYS' EYES ONLY");
assert.equal(confidentialityOf(['ATTORNEYS’ EYES ONLY']), 'ATTORNEYS’ EYES ONLY');
assert.equal(confidentialityOf(['AEO']), 'AEO');
assert.equal(confidentialityOf(['CONFIDENTIAL', AEO]), AEO);
assert.equal(confidentialityOf([AEO, 'CONFIDENTIAL']), AEO);
assert.equal(confidentialityOf(['DRAFT']), '');
assert.equal(confidentialityOf(['PRIVILEGED']), '');
assert.equal(confidentialityOf(['DRAFT', 'CONFIDENTIAL']), 'CONFIDENTIAL');
assert.equal(designationRank('Subject to Protective Order - CONFIDENTIAL'), 1);
ok("CONFIDENTIALITY carries the designation's words, the most restrictive of two; DRAFT and PRIVILEGED are not designations");

// 2. The worker no longer decides by the word "confidential" alone.
const w = fs.readFileSync(path.join(ROOT, 'worker', 'discovery-worker.mjs'), 'utf8');
assert.ok(!/\/confidential\/i\.test\(def\.endorsement_text\)/.test(w), 'the old regex is gone');
assert.match(w, /confidentialityOf\(list\)/);
assert.match(w, /confidential: confidentialityByItem\.get\(item\.id\) \?\? '',/);
assert.match(w, /confidentialCount: produced\.filter\(\(i\) => confidentialityByItem\.has\(i\.id\)\)\.length,/);
ok('the worker passes each document\'s designation to the load file, and the letter counts only produced documents');

// 3. packageDocument → DAT, round trip.
{
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const pdf = Buffer.from(await doc.save());
  const files = new Map();
  const base = {
    kind: 'display_pdf', original_filename: 'memo.pdf', page_count: 1,
    display_storage_path: 's/d.pdf', native_storage_path: 's/d.pdf', sha256: 'c'.repeat(64), file_size_bytes: pdf.length,
  };
  const pkg = (item, confidential) => packageDocument({
    item, volumeName: 'VOL001', confidential, stampedPath: 's/stamped.pdf',
    read: async () => pdf, append: (b, name) => files.set(name, b), corpusPages: async () => null,
  });
  const a = await pkg({ ...base, bates_first: 'X_0000001', bates_last: 'X_0000001' }, AEO);
  const b = await pkg({ ...base, bates_first: 'X_0000002', bates_last: 'X_0000002' }, true);
  const c = await pkg({ ...base, bates_first: 'X_0000003', bates_last: 'X_0000003' }, '');
  const { records } = parseDat(emitDat([a.datRow, b.datRow, c.datRow]));
  assert.equal(records[0].confidentiality, AEO);
  assert.equal(records[1].confidentiality, 'CONFIDENTIAL');
  assert.equal(records[2].confidentiality, '');
  ok("the DAT's CONFIDENTIALITY round-trips the AEO words (apostrophe included); true still means CONFIDENTIAL");
}

// 4. The AEO endorsement prints in every corner of a letter page.
{
  assert.deepEqual(undrawableChars(AEO), []);
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const pdf = Buffer.from(await doc.save());
  for (const position of BATES_POSITIONS) {
    const out = await stampPdf(pdf, { prefix: 'X_', pad: 7, startSeq: 1, position, endorsements: [AEO] });
    assert.equal(out.pageCount, 1);
  }
  ok("the AEO endorsement is drawable and stamps with the Bates number in all six positions");
}

// 5. The presets.
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'discovery.ts'), 'utf8');
  const presets = src.slice(src.indexOf('export const PRESET_TAGS'), src.indexOf('export async function ensurePresetTagDefs'));
  const block = (name) => presets.slice(presets.indexOf(`name: ${name}`), presets.indexOf('}', presets.indexOf(`name: ${name}`)));
  for (const name of ["'Privileged'", "'Hot Doc'", "'Confidential'", "'Non-Responsive'", '"Attorneys\' Eyes Only"', "'Irrelevant'"]) {
    assert.ok(presets.includes(`name: ${name}`), `preset ${name}`);
  }
  assert.match(block('"Attorneys\' Eyes Only"'), /is_endorsement: true/);
  assert.match(block('"Attorneys\' Eyes Only"'), /endorsement_text: "HIGHLY CONFIDENTIAL - ATTORNEYS' EYES ONLY"/);
  assert.match(block('"Attorneys\' Eyes Only"'), /behavior: null/);
  assert.match(block("'Irrelevant'"), /is_endorsement: false/);
  assert.match(block("'Irrelevant'"), /behavior: 'non_responsive'/);
  ok("presets: Attorneys' Eyes Only prints on the page and is produced; Irrelevant is withheld like Non-Responsive");
}

// 6. Migration 111 and the worker's per-document position.
{
  let PGlite;
  try { ({ PGlite } = await import('@electric-sql/pglite')); } catch {
    console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
    process.exit(2);
  }
  const db = new PGlite();
  await db.exec('create table public.production_items (id int primary key);');
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '111_item_stamp_position.sql'), 'utf8');
  await db.exec(sql);
  await db.exec(sql);
  await db.query('insert into public.production_items (id, stamp_position) values (1, null), (2, $1)', ['upper_left']);
  let bad = null;
  try { await db.query("insert into public.production_items (id, stamp_position) values (3, 'middle')"); } catch (e) { bad = e; }
  assert.ok(bad, 'an unknown corner is refused');
  await db.close();
  ok('migration 111 adds stamp_position, re-runs cleanly, accepts null and the six corners, refuses anything else');

  const fn = w.slice(w.indexOf('function stampPositionOf('), w.indexOf('async function partitionItems('));
  assert.match(fn, /BATES_POSITIONS\.includes\(item\.stamp_position\) \? item\.stamp_position : prod\.bates_position/);
  const stamp = w.slice(w.indexOf('async function stampProduction(job)'), w.indexOf('async function preflightStamp('));
  assert.equal((stamp.match(/position: stampPositionOf\(item, prod\)/g) ?? []).length, 2);
  assert.ok(!/position: prod\.bates_position/.test(stamp));
  ok("the worker stamps each document (page and slip sheet) at its own position, else the production's");
}

console.log(`\nDesignations and stamp position verified offline: ${n} checks passed.`);

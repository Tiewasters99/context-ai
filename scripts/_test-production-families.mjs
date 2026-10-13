// Email families in a production, and MD5 on the load file.
//
//   node scripts/_test-production-families.mjs
//
// Offline. An email's attachments become their own produced documents right
// behind it (worker intakeOneFile), and lib/discovery/families.mjs decides:
//   * BEGATTACH/ENDATTACH: every produced family member carries the range from
//     the email's first Bates number to the last attachment's last;
//   * a withheld email withholds its attachments, and the privilege log and
//     RECONCILIATION.txt both say so;
//   * an attachment withheld on its own leaves its email produced, and the
//     range spans what was produced.
// The DAT gains BEGATTACH, ENDATTACH and MD5HASH, and ALLCUSTODIANS and
// DUPLICATEPATHS for "Remove duplicates of email attachments" (24 columns):
//   * off (the default): every document is produced, a loose copy of an
//     attachment included;
//   * on: a loose copy byte-identical to a produced family member is set
//     aside, and the DAT and RECONCILIATION.txt say where it was found;
//   * a loose copy of a WITHHELD member, or one with a different hash, is
//     produced as usual.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractEmlAttachments } from '../lib/eml-attachments.mjs';
import { extractEmlPages } from '../lib/eml-extract.mjs';
import { normalizeFile } from '../lib/discovery/normalize.mjs';
import {
  withholdFamilies, familyRanges, privilegeEntriesWithFamilies, attachmentDuplicates, duplicateColumns, setAsideLines,
} from '../lib/discovery/families.mjs';
import { emitDat, parseDat } from '../lib/discovery/loadfile.mjs';
import { packageDocument } from '../lib/discovery/package-docs.mjs';
import { reconciliationText } from '../lib/discovery/manifest.mjs';
import { md5 } from '../lib/discovery/util.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  PASS  ${m}`); };

async function pdf(text) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText(text, { x: 72, y: 700, size: 12, font });
  return Buffer.from(await doc.save());
}

// ---- The fixture: an email with a Word file and a PDF attached.
const docxBytes = Buffer.from('PK\u0003\u0004 not really a word file, only its bytes matter here');
const pdfBytes = await pdf('Exhibit A: the signed term sheet');
const b64 = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
const eml = Buffer.from([
  'From: Priya Patel <ppatel@example.test>',
  'To: Counsel <counsel@example.test>',
  'Subject: Term sheet and memo',
  'Date: Tue, 6 Feb 2024 10:00:00 -0800',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="XYZ"',
  '',
  '--XYZ',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Attached are the memo and the signed term sheet.',
  '--XYZ',
  'Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document; name="Memo.docx"',
  'Content-Disposition: attachment; filename="Memo.docx"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(docxBytes),
  '--XYZ',
  'Content-Type: application/pdf; name="TermSheet.pdf"',
  'Content-Disposition: attachment; filename="TermSheet.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(pdfBytes),
  '--XYZ--',
  '',
].join('\r\n'), 'utf8');

{
  const { attachments } = await extractEmlAttachments(eml);
  assert.deepEqual(attachments.map((a) => a.filename), ['Memo.docx', 'TermSheet.pdf']);
  assert.ok(attachments[0].bytes.equals(docxBytes));
  assert.ok(attachments[1].bytes.equals(pdfBytes));
  ok('an email\'s two attachments are read out byte for byte, in order');

  // The email's own text (what its image and TEXT/ file are made from) names
  // the attachments and carries none of their bytes.
  const text = (extractEmlPages(eml) ?? []).map((p) => p.text).join('\n');
  assert.match(text, /Attached are the memo/);
  assert.match(text, /Memo\.docx/);
  assert.ok(!text.includes(pdfBytes.toString('base64').slice(0, 40)), 'no attachment bytes in the email text');
  ok('the email\'s text names its attachments and holds none of their bytes');

  // Each attachment goes through the same normalization as any file.
  const imaging = { available: false };
  assert.equal((await normalizeFile(attachments[0].bytes, 'Memo.docx', { imaging })).kind, 'native');
  const pdfNorm = await normalizeFile(attachments[1].bytes, 'TermSheet.pdf', { imaging });
  assert.equal(pdfNorm.kind, 'display_pdf');
  assert.equal(pdfNorm.pageCount, 1);
  ok('attachments are normalized like any intake file (PDF imaged, Word native when imaging is off)');
}

// ---- Families on the load file.
const meta = (o) => ({ source_metadata: o });
const email = { id: 'E', original_filename: 'mail.eml', bates_first: 'P_001', bates_last: 'P_002', ...meta({ family: true, attachment_count: 2 }) };
const memo = { id: 'M', original_filename: 'Memo.docx', bates_first: 'P_003', bates_last: 'P_003', ...meta({ parent_item_id: 'E', attachment_index: 1 }) };
const sheet = { id: 'S', original_filename: 'TermSheet.pdf', bates_first: 'P_004', bates_last: 'P_005', ...meta({ parent_item_id: 'E', attachment_index: 2 }) };
const loose = { id: 'L', original_filename: 'loose.pdf', bates_first: 'P_006', bates_last: 'P_006', ...meta({}) };
const lonely = { id: 'Q', original_filename: 'plain.eml', bates_first: 'P_007', bates_last: 'P_007', ...meta({}) };

{
  const r = familyRanges([email, memo, sheet, loose, lonely]);
  for (const id of ['E', 'M', 'S']) assert.deepEqual(r.get(id), { beg_attach: 'P_001', end_attach: 'P_005' });
  assert.equal(r.has('L'), false);
  assert.equal(r.has('Q'), false);
  ok('every family member carries BEGATTACH = the email\'s first number, ENDATTACH = the last attachment\'s last');
  ok('a loose document and an email without attachments have no family range');

  // The memo withheld on its own: the email and the term sheet are produced,
  // and the range spans them.
  const r2 = familyRanges([email, sheet]);
  assert.deepEqual(r2.get('E'), { beg_attach: 'P_001', end_attach: 'P_005' });
  ok('an attachment withheld on its own leaves the family range over what was produced');
}

{
  const items = [email, memo, sheet, loose];
  const own = new Set(['E']);
  const { excludedIds, withParent } = withholdFamilies(items, own);
  assert.deepEqual([...excludedIds].sort(), ['E', 'M', 'S']);
  assert.deepEqual(withParent.map((w) => w.item.id).sort(), ['M', 'S']);
  ok('a withheld email withholds its attachments, and says which were withheld with it');

  const { excludedIds: onlyMemo, withParent: none } = withholdFamilies(items, new Set(['M']));
  assert.deepEqual([...onlyMemo], ['M']);
  assert.equal(none.length, 0);
  ok('an attachment withheld on its own does not withhold its email');

  // The memo is tagged Privileged too, so it has its own entry; the term sheet
  // gets one drawn from the email's, right after it.
  const entries = [
    { production_item_id: 'X', doc_date: '2024-01-01', basis: 'work_product', subject_matter: 'other' },
    { production_item_id: 'E', doc_date: '2024-02-06', author: 'Priya Patel', addressee: 'Counsel', basis: 'attorney_client', subject_matter: 'legal advice' },
    { production_item_id: 'M', doc_date: '2024-02-06', basis: 'attorney_client', subject_matter: 'memo' },
  ];
  const log = privilegeEntriesWithFamilies(entries, withParent);
  assert.deepEqual(log.map((e) => e.production_item_id), ['X', 'E', 'S', 'M']);
  assert.equal(log[2].basis, 'attorney_client');
  assert.equal(log[2].author, 'Priya Patel');
  assert.match(log[2].subject_matter, /TermSheet\.pdf/);
  assert.match(log[2].description, /Withheld with its parent email/);
  ok('the privilege log lists an attachment withheld with its email, after the email, with the email\'s basis');

  const rec = reconciliationText(
    { received: 4, produced: 1, withheld: 3, duplicates: 0, exceptions: 0, unnumbered: 0, producedPages: 1, registeredPages: 1 },
    { matterName: 'M', productionName: 'P', withheldWithParent: withParent.map((w) => ({ filename: w.item.original_filename, parentFilename: 'mail.eml' })) },
  ).toString('utf8');
  assert.match(rec, /These figures reconcile\./);
  assert.match(rec, /Attachments withheld with their email \.+ 2/);
  assert.match(rec, /TermSheet\.pdf {2}\(attached to mail\.eml\)/);
  ok('RECONCILIATION.txt names each attachment withheld with its email');
}

// ---- MD5 on the load file.
{
  const stamped = await pdf('P_003');
  const files = new Map();
  const base = {
    kind: 'native', original_filename: 'Memo.docx', bates_first: 'P_003', bates_last: 'P_003',
    native_storage_path: 's/native.docx', sha256: crypto.createHash('sha256').update(docxBytes).digest('hex'),
    file_size_bytes: docxBytes.length,
  };
  const reads = [];
  const read = async (p) => { reads.push(p); return ({ 's/slip.pdf': stamped, 's/native.docx': docxBytes })[p]; };
  const args = { volumeName: 'VOL', confidential: '', stampedPath: 's/slip.pdf', read, append: (b, name) => files.set(name, b) };

  const recorded = await packageDocument({ ...args, item: { ...base, source_metadata: { md5: 'f'.repeat(32) } } });
  assert.equal(recorded.datRow.md5, 'f'.repeat(32));
  ok('MD5HASH is the hash recorded at intake');

  const older = await packageDocument({ ...args, item: { ...base, source_metadata: {} } });
  assert.equal(older.datRow.md5, md5(docxBytes));
  assert.equal(older.datRow.md5, crypto.createHash('md5').update(docxBytes).digest('hex'));
  ok('an item taken in before MD5 was recorded is hashed from its stored native');

  const dat = emitDat([
    { ...recorded.datRow, beg_attach: 'P_001', end_attach: 'P_005' },
    older.datRow,
  ]);
  const { fields, records } = parseDat(dat);
  assert.equal(fields.length, 24);
  assert.deepEqual(fields.slice(-2), ['allcustodians', 'duplicatepaths']);
  assert.equal(records[0].allcustodians, '');
  assert.equal(records[0].duplicatepaths, '');
  assert.deepEqual(fields.slice(0, 4), ['begbates', 'endbates', 'begattach', 'endattach']);
  assert.equal(fields[fields.indexOf('sha256') - 1], 'md5hash');
  assert.equal(records[0].begattach, 'P_001');
  assert.equal(records[0].endattach, 'P_005');
  assert.equal(records[1].begattach, '');
  assert.equal(records[1].md5hash, md5(docxBytes));
  ok('the DAT carries 24 columns: BEGATTACH/ENDATTACH after the Bates range, MD5HASH beside SHA256, '
    + 'ALLCUSTODIANS/DUPLICATEPATHS last and empty when nothing was set aside');
}

// ---- "Remove duplicates of email attachments".
{
  const H = (c) => c.repeat(64);
  const mail = { id: 'E', original_filename: 'mail.eml', sha256: H('e'), bates_first: 'P_001', bates_last: 'P_002',
    source_metadata: { family: true, attachment_count: 1, custodian: 'Patel' } };
  const att = { id: 'A', original_filename: 'TermSheet.pdf', sha256: H('a'), bates_first: 'P_003', bates_last: 'P_004',
    source_metadata: { parent_item_id: 'E', attachment_index: 1, custodian: 'Patel' } };
  const filed = { id: 'F', original_filename: 'TermSheet.pdf', original_path: 'Deals/2024/TermSheet.pdf', sha256: H('a'),
    source_metadata: { custodian: 'Iyer' } };
  const other = { id: 'O', original_filename: 'TermSheet-v2.pdf', original_path: 'Deals/TermSheet-v2.pdf', sha256: H('b'),
    source_metadata: { custodian: 'Iyer' } };
  const twin = { id: 'T', original_filename: 'copy.pdf', sha256: H('a'), source_metadata: { custodian: 'Patel' } };
  const items = [mail, att, filed, other];
  // What the worker does at stamp time: decide over what would be produced.
  const decide = (list, on, withheldIds = new Set()) => {
    const ex = withholdFamilies(list, withheldIds).excludedIds;
    return on ? attachmentDuplicates(list.filter((i) => !ex.has(i.id))) : [];
  };

  assert.equal(decide(items, false).length, 0);
  ok('switch off (the default): the filed copy of an attachment is produced like any document');

  const on = decide(items, true);
  assert.deepEqual(on.map((d) => [d.item.id, d.of.id]), [['F', 'A']]);
  ok('switch on: a filed copy byte-identical to a produced attachment is set aside; the family stays whole');
  ok('a copy with a different hash is produced (TermSheet-v2.pdf is not set aside)');

  const cols = duplicateColumns(on);
  assert.deepEqual(cols.get('A'), { all_custodians: 'Patel; Iyer', duplicate_paths: 'Deals/2024/TermSheet.pdf' });
  assert.equal(cols.has('E'), false);
  const { records } = parseDat(emitDat([{ bates_first: 'P_003', ...cols.get('A') }, { bates_first: 'P_005' }]));
  assert.equal(records[0].allcustodians, 'Patel; Iyer');
  assert.equal(records[0].duplicatepaths, 'Deals/2024/TermSheet.pdf');
  assert.equal(records[1].allcustodians, '');
  ok('the attachment DAT row names both custodians (ALLCUSTODIANS) and where the copy was filed (DUPLICATEPATHS)');

  const lines = setAsideLines(on, new Map(items.map((i) => [i.id, i])));
  assert.deepEqual(lines, ['TermSheet.pdf (filed copy): not produced; identical to P_003, produced as an attachment to P_001']);
  const rec = reconciliationText(
    { received: 4, produced: 3, withheld: 0, duplicates: 1, exceptions: 0, unnumbered: 0, producedPages: 5, registeredPages: 5 },
    { matterName: 'M', productionName: 'P', setAside: lines },
  ).toString('utf8');
  assert.match(rec, /These figures reconcile\./);
  assert.match(rec, /Filed copies of email attachments, set aside \.+ 1/);
  assert.match(rec, /TermSheet\.pdf \(filed copy\): not produced; identical to P_003, produced as an attachment to P_001/);
  ok('RECONCILIATION.txt lists the copy set aside, the Bates number it duplicates and the email number');

  // The email is withheld, so its attachment is too: the filed copy stands on
  // its own tags and is produced.
  assert.equal(decide(items, true, new Set(['E'])).length, 0);
  assert.equal(decide(items, true, new Set(['A'])).length, 0);
  ok('a filed copy of a WITHHELD attachment is produced, never set aside');

  // Never a family member set aside; two identical loose copies both produced.
  assert.deepEqual(decide([filed, twin], true), []);
  const twoFamilies = decide([mail, att, { ...att, id: 'A2', source_metadata: { parent_item_id: 'E2' } }], true);
  assert.deepEqual(twoFamilies, []);
  ok('two identical loose documents are both produced, and a family member is never set aside');
}

// ---- The worker: attachments follow their email in Bates order.
{
  const src = fs.readFileSync(new URL('../worker/discovery-worker.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function intakeOneFile('));
  assert.match(body, /const slots = 1 \+ attachments\.length;/);
  assert.match(body, /sortOrder: sortOrder \+ k \+ 1,/);
  assert.match(body, /md5: md5\(buf\)/);
  assert.match(body, /parent_item_id: parent\.id/);
  // Every caller advances by what the file used, not by one.
  for (const caller of ['fileIndex += await intakeOneFile(', 'next += await intakeOneFile(']) {
    assert.ok(src.includes(caller), caller);
  }
  assert.ok(!/sortOrder: base \+ i \+ 1/.test(src), 'no caller numbers files by their index any more');
  // intakeOneFile's every return reports its slots.
  const fn = body.slice(0, body.indexOf('\nasync function emailAttachmentsOf('));
  assert.ok(!/\breturn;/.test(fn), 'intakeOneFile never returns without its slot count');
  ok('the worker numbers an email\'s attachments right behind it, and the next file after them');

  assert.match(src, /const family = withholdFamilies\(items, excludedIds\);/);
  assert.match(src, /privilegeEntriesWithFamilies\(entries, withheldWithParent\)/);
  assert.match(src, /families\.get\(item\.id\)/);
  ok('stamping and packaging withhold whole families and write the family range');

  // The switch: read from the stamp job, decided before any number is spent,
  // recorded on each copy (no migration), cleared on an unstamped re-run.
  assert.match(src, /if \(!locked\) await setAsideAttachmentDuplicates\(prod, job\.payload\?\.remove_attachment_duplicates === true\);/);
  const fn2 = src.slice(src.indexOf('async function setAsideAttachmentDuplicates('));
  assert.match(fn2, /if \(it\.source_metadata\?\.set_aside_duplicate\) await write\(it, null, false\);[\s\S]*if \(!on\) return;/);
  assert.match(src, /dupColumns\.get\(item\.id\)/);
  assert.match(src, /setAside: setAsideLines\(setAside, byId\)/);
  ok('the worker sets copies aside only when the stamp job asks, and clears the choice of an earlier run');
}

console.log(`\nEmail families and MD5 verified offline: ${n} checks passed.`);

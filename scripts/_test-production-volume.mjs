// Discovery at volume: concurrency, volumes, resume, streamed upload, and the
// two intake fixes found on the 2,660-document run (2026-10-13).
//
//   node scripts/_test-production-volume.mjs
//
// Offline. Drives the worker's own packaging loop (lib/discovery/volumes.mjs)
// and per-document code (lib/discovery/package-docs.mjs) over a synthetic
// stamped production with storage stubbed:
//   * several documents at once give the SAME package as one at a time:
//     same entries, same order, same bytes, same load file;
//   * "Split into volumes of about N pages": no document and no email family
//     is split, Bates numbers run on across volumes, each volume has its own
//     IMAGES/TEXT/DATA and load files, the production's own papers are in the
//     last volume and its reconciliation lists every volume;
//   * a production too big for one object is split without being asked;
//   * a job cut off after volume 1 resumes at volume 2 and does not package
//     volume 1 again; a cut-off package is never marked complete;
//   * the TUS upload sends 6 MB chunks, recovers from a lost answer by asking
//     the server, and hashes exactly the bytes stored;
//   * a PDF filed under a Word name is a rendition, not a Word file; a JPEG
//     named .png becomes a page, and a broken image says why.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import StreamZip from 'node-stream-zip';
import { runOrdered, mapLimit, discoveryConcurrency } from '../lib/discovery/pool.mjs';
import {
  planUnits, planVolumes, packageVolumes, openZipArchive, volumeNameFor, estimatePackageBytes,
} from '../lib/discovery/volumes.mjs';
import { packageDocument } from '../lib/discovery/package-docs.mjs';
import { parseDat } from '../lib/discovery/loadfile.mjs';
import { reconciliationText } from '../lib/discovery/manifest.mjs';
import { uploadFileResumable, TUS_CHUNK_BYTES } from '../lib/discovery/resumable-upload.mjs';
import { vaultSourcePlan, isPdfBytes } from '../lib/discovery/vault-source.mjs';
import { normalizeFile, sniffImage, errorText } from '../lib/discovery/normalize.mjs';
import { formatBates } from '../lib/discovery/util.mjs';
import { extractPages } from '../lib/ingest-core.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  PASS  ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'disc-vol-'));

// ---------------------------------------------------------------------------
// 1. The pool
// ---------------------------------------------------------------------------
{
  const items = Array.from({ length: 40 }, (_, i) => i);
  let running = 0;
  let peak = 0;
  const released = [];
  await runOrdered(items, { concurrency: 5 }, async (x) => {
    running += 1; peak = Math.max(peak, running);
    await sleep(Math.floor(Math.random() * 8));
    running -= 1;
    return x * 2;
  }, async (r, x) => { released.push([x, r]); await sleep(1); });
  assert.deepEqual(released.map(([x]) => x), items);
  assert.ok(released.every(([x, r]) => r === x * 2));
  assert.ok(peak <= 5 && peak > 1, `peak ${peak}`);
  ok('runOrdered: results are released strictly in input order, with at most N in flight');

  let buffered = 0;
  let maxBuffered = 0;
  const finished = new Set();
  await runOrdered(items, { concurrency: 4, window: 6 }, async (x) => {
    await sleep(x === 0 ? 40 : 1);   // the first is slow: everything behind it must wait in the window
    finished.add(x);
    buffered = finished.size; maxBuffered = Math.max(maxBuffered, buffered);
    return x;
  }, async (_r, x) => { finished.delete(x); });
  assert.ok(maxBuffered <= 6, `buffered ${maxBuffered}`);
  ok('runOrdered: a slow document holds back at most the window, not the whole production');

  const started = [];
  await assert.rejects(runOrdered(items, { concurrency: 3 }, async (x) => {
    started.push(x);
    await sleep(2);
    if (x === 7) throw new Error('boom at 7');
    return x;
  }, () => {}), /boom at 7/);
  assert.ok(Math.max(...started) < 7 + 3 * 2 + 1, `kept starting after the failure: ${Math.max(...started)}`);
  ok('runOrdered: a failure stops new work, lets work in flight settle, and is thrown');

  assert.deepEqual(await mapLimit([3, 1, 2], 3, async (x) => { await sleep(x * 3); return x * 10; }), [30, 10, 20]);
  assert.equal(discoveryConcurrency({}), 6);
  assert.equal(discoveryConcurrency({ DISCOVERY_CONCURRENCY: '12' }), 12);
  assert.equal(discoveryConcurrency({ DISCOVERY_CONCURRENCY: '0' }), 6);
  assert.equal(discoveryConcurrency({ DISCOVERY_CONCURRENCY: '500' }), 32);
  ok('mapLimit keeps input order; DISCOVERY_CONCURRENCY defaults to 6 and is bounded 1–32');
}

// ---------------------------------------------------------------------------
// 1b. A small PDF's text is its own (lib/ingest-core.mjs pdfParseBytes)
// ---------------------------------------------------------------------------
{
  async function small(label, pages) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`${label} page ${i + 1}`, { x: 60, y: 700, size: 11, font });
    return Buffer.from(await doc.save());   // under 4 KB: a view into Node's shared Buffer pool
  }
  let wrong = 0;
  for (let round = 0; round < 3; round++) {
    const bufs = await Promise.all(Array.from({ length: 12 }, (_, i) => small(`DOC${i}`, 1 + (i % 3))));
    assert.ok(bufs.some((b) => b.byteOffset !== 0), 'the fixture no longer exercises pooled Buffers');
    const one = [];
    for (const b of bufs) one.push(await extractPages(b, '.pdf'));
    const many = await Promise.all(bufs.map((b) => extractPages(b, '.pdf')));
    for (const res of [one, many]) {
      res.forEach((pages, i) => {
        const want = Array.from({ length: 1 + (i % 3) }, (_, k) => `DOC${i} page ${k + 1}`);
        if (JSON.stringify(pages.map((p) => p.text)) !== JSON.stringify(want)) wrong += 1;
      });
    }
  }
  assert.equal(wrong, 0, `${wrong} small PDF(s) came back with another document's text`);
  ok("a small PDF's text is its own, read one at a time or several at once (pdf-parse no longer reads the Buffer pool)");
}

// ---------------------------------------------------------------------------
// 2. A synthetic stamped production
// ---------------------------------------------------------------------------
const PREFIX = 'VOLT_';
const PAD = 7;
const store = new Map();
const MATTER = 'm1';
const PROD = 'p1';

async function stampedPdf(first, pages, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const pg = doc.addPage([612, 792]);
    pg.drawText(`${label} page ${i + 1} of ${pages}: the quick brown fox jumps over the lazy dog`, { x: 60, y: 700, size: 11, font });
    pg.drawText(formatBates(PREFIX, PAD, first + i), { x: 480, y: 30, size: 9, font });
  }
  return Buffer.from(await doc.save());
}

// 14 documents: loose PDFs of 1–5 pages, one native, and an email family of
// three (email + two attachments) that must never be split.
const spec = [
  [3], [1], [5], [2], [4], ['native'], [2], ['family', 2], ['family', 1], ['family', 3], [1], [5], [2], [3],
];
const produced = [];
let seq = 1;
let familyRoot = null;
for (const [k, s] of spec.entries()) {
  const id = `item-${String(k).padStart(2, '0')}`;
  const native = s[0] === 'native';
  const pages = native ? 1 : (s[0] === 'family' ? s[1] : s[0]);
  const base = `${MATTER}/${PROD}/${id}`;
  const it = {
    id, matterspace_id: MATTER, production_id: PROD, sort_order: k + 1,
    original_filename: native ? `sheet-${k}.xlsx` : `doc-${k}.pdf`,
    kind: native ? 'native' : 'display_pdf',
    page_count: native ? null : pages,
    bates_first: formatBates(PREFIX, PAD, seq),
    bates_last: formatBates(PREFIX, PAD, seq + pages - 1),
    file_size_bytes: 1000,
    sha256: crypto.createHash('sha256').update(id).digest('hex'),
    native_storage_path: `${base}/native/${native ? 'sheet.xlsx' : 'doc.pdf'}`,
    display_storage_path: native ? null : `${base}/native/doc.pdf`,
    source_metadata: { custodian: 'Patel', md5: 'x'.repeat(32) },
  };
  if (s[0] === 'family') {
    if (!familyRoot) { familyRoot = id; it.source_metadata.family = true; }
    else it.source_metadata.parent_item_id = familyRoot;
  }
  const stamped = await stampedPdf(seq, pages, id);
  store.set(`${base}/stamped.pdf`, stamped);
  if (native) store.set(it.native_storage_path, Buffer.from('a,b,c\n1,2,3\n'));
  else store.set(it.native_storage_path, stamped);
  seq += pages;
  produced.push(it);
}
const totalPagesExpected = seq - 1;

{
  const units = planUnits(produced);
  assert.equal(units.length, 12);
  const fam = units.find((u) => u.start === 7);
  assert.deepEqual([fam.start, fam.end, fam.pages], [7, 10, 6]);
  const vols = planVolumes(produced, { maxPages: 10 });
  for (const v of vols) assert.ok(!(v.start > 7 && v.start < 10), 'a volume starts inside the family');
  assert.equal(vols.reduce((s, v) => s + v.pages, 0), totalPagesExpected);
  assert.ok(vols.every((v) => v.pages <= 10 || v.end - v.start === 1 || (v.start === 7 && v.end === 10)));
  assert.equal(planVolumes(produced, {}).length, 1);
  assert.equal(planVolumes(produced, { maxPages: 2 }).find((v) => v.start === 7).end, 10);
  ok('volumes are planned in whole documents and whole email families; one bigger than the limit stands alone');
}

const reads = new Map();
const packageOneFor = (imageFormat = 'pdf', delays = false) => async (item) => {
  reads.set(item.id, (reads.get(item.id) ?? 0) + 1);
  if (delays) await sleep(Math.floor(Math.random() * 12));
  const files = [];
  const doc = await packageDocument({
    item, volumeName: '', confidential: '',
    stampedPath: `${MATTER}/${PROD}/${item.id}/stamped.pdf`,
    read: async (p) => { const b = store.get(p); if (!b) throw new Error(`missing ${p}`); return b; },
    append: (buf, name) => files.push({ buf, name }),
    corpusPages: null,
    imageFormat,
  });
  return { files, datRow: doc.datRow, pages: doc.pages, textChars: doc.textChars, textSource: doc.textSource };
};

function makeRun({ maxPages = null, concurrency = 1, delays = false, maxBytes, hardLimitBytes, failStoreAt = null, storage = new Map() } = {}) {
  let storeCalls = 0;
  return {
    storage,
    run: () => packageVolumes({
      produced, imageFormat: 'pdf', baseName: 'TEST_VOL', maxPages, concurrency, maxBytes, hardLimitBytes,
      packageOne: packageOneFor('pdf', delays),
      productionFiles: async ({ append, volumes, textless, totalPages }) => {
        assert.equal(totalPages, totalPagesExpected);
        append(Buffer.from('exceptions'), 'DATA/EXCEPTIONS.csv');
        append(reconciliationText({
          received: produced.length, produced: produced.length, withheld: 0, duplicates: 0, exceptions: 0,
          unnumbered: 0, producedPages: totalPages, registeredPages: totalPages,
        }, { matterName: 'M', productionName: 'TEST VOL', batesFirst: produced[0].bates_first,
          batesLast: produced.at(-1).bates_last, dateStr: '2026-10-13', textless, imageFormat: 'pdf', volumes }),
        'DATA/RECONCILIATION.txt');
        append(Buffer.from('%PDF-letter'), 'ProductionLetter.pdf');
      },
      storeVolume: async ({ name, file }) => {
        storeCalls += 1;
        if (failStoreAt && storeCalls === failStoreAt) throw new Error('machine restarted mid-upload');
        const buf = await fsp.readFile(file);
        const p = `${MATTER}/${PROD}/package/${name}.zip`;
        storage.set(p, buf);
        return { storage_path: p, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
      },
      exists: async (p) => storage.has(p),
      checkpoint: {
        load: async () => (storage.has('manifest') ? JSON.parse(storage.get('manifest')) : null),
        save: async (m) => { storage.set('manifest', JSON.stringify(m)); },
      },
      openArchive: () => openZipArchive({ dir: tmp }),
    }),
  };
}

async function zipEntries(buf) {
  const f = path.join(tmp, `${crypto.randomUUID()}.zip`);
  await fsp.writeFile(f, buf);
  const zip = new StreamZip.async({ file: f });
  const out = [];
  for (const e of Object.values(await zip.entries())) {
    out.push({ name: e.name, sha: crypto.createHash('sha256').update(await zip.entryData(e.name)).digest('hex'), method: e.method, size: e.size });
  }
  await zip.close();
  return out;
}

// ---------------------------------------------------------------------------
// 3. One at a time vs several at once: the same package
// ---------------------------------------------------------------------------
{
  const a = makeRun({ concurrency: 1 });
  const ra = await a.run();
  const b = makeRun({ concurrency: 6, delays: true });
  const rb = await b.run();
  assert.equal(ra.volumes.length, 1);
  assert.equal(ra.split, false);
  const ea = await zipEntries(a.storage.get(ra.volumes[0].storage_path));
  const eb = await zipEntries(b.storage.get(rb.volumes[0].storage_path));
  assert.deepEqual(eb, ea);
  ok('six at once (finishing in random order) writes the same entries, in the same order, with the same bytes, as one at a time');

  const names = ea.map((e) => e.name);
  assert.ok(names.every((x) => x.startsWith('TEST_VOL/')));
  assert.ok(names.includes('TEST_VOL/DATA/loadfile.dat') && names.includes('TEST_VOL/DATA/RECONCILIATION.txt'));
  assert.ok(!names.some((x) => x.endsWith('VOLUME.txt')));
  assert.equal(names.filter((x) => x.startsWith('TEST_VOL/IMAGES/')).length, produced.length);
  assert.equal(a.storage.has('manifest'), false);
  const stored = ea.filter((e) => /\.pdf$/.test(e.name)).every((e) => e.method === 0);
  const deflated = ea.filter((e) => /\.(txt|dat|opt)$/.test(e.name) && e.size > 0).every((e) => e.method === 8);
  assert.ok(stored && deflated);
  ok('an unsplit production is one folder and one ZIP as before (no volume files); images are stored, text deflated');
}

// ---------------------------------------------------------------------------
// 4. Split into volumes
// ---------------------------------------------------------------------------
{
  const r = makeRun({ maxPages: 10, concurrency: 4, delays: true });
  const res = await r.run();
  assert.ok(res.split && !res.autoSplit && res.volumes.length >= 3);
  assert.deepEqual(res.volumes.map((v) => v.name), res.volumes.map((_, i) => volumeNameFor('TEST_VOL', i, true)));
  assert.equal(res.volumes[0].name, 'TEST_VOL_VOL001');
  let expectNext = 1;
  const allRows = [];
  for (const [i, v] of res.volumes.entries()) {
    const entries = await zipEntries(r.storage.get(v.storage_path));
    const names = entries.map((e) => e.name);
    assert.ok(names.every((x) => x.startsWith(`${v.name}/`)), `${v.name} holds another volume's files`);
    for (const need of ['DATA/loadfile.dat', 'DATA/loadfile.opt', 'DATA/VOLUME.txt']) assert.ok(names.includes(`${v.name}/${need}`), `${v.name} lacks ${need}`);
    const isLast = i === res.volumes.length - 1;
    assert.equal(names.includes(`${v.name}/DATA/RECONCILIATION.txt`), isLast);
    assert.equal(names.includes(`${v.name}/ProductionLetter.pdf`), isLast);
    const zipPath = path.join(tmp, `v${i}.zip`);
    await fsp.writeFile(zipPath, r.storage.get(v.storage_path));
    const zip = new StreamZip.async({ file: zipPath });
    const rows = parseDat(await zip.entryData(`${v.name}/DATA/loadfile.dat`)).records;
    const opt = (await zip.entryData(`${v.name}/DATA/loadfile.opt`)).toString('utf8');
    await zip.close();
    assert.ok(rows.every((x) => x.prodvol === v.name), `${v.name} DAT names another volume`);
    assert.ok(opt.trim().split(/\r?\n/).every((l) => l.split(',')[1] === v.name));
    assert.equal(rows[0].begbates, formatBates(PREFIX, PAD, expectNext));
    const lastSeq = Number(rows.at(-1).endbates.slice(PREFIX.length));
    expectNext = lastSeq + 1;
    assert.ok(v.pages <= 10 || v.docs === 3 || v.docs === 1);
    allRows.push(...rows);
  }
  assert.equal(expectNext - 1, totalPagesExpected);
  assert.equal(allRows.length, produced.length);
  const famVol = new Set(allRows.filter((x) => ['doc-7.pdf', 'doc-8.pdf', 'doc-9.pdf'].includes(x.filename)).map((x) => x.prodvol));
  assert.equal(famVol.size, 1);
  ok('split at 10 pages: NAME_VOL001…, each its own folder, DAT and OPT naming it; Bates run on across volumes; the family stays in one volume');

  const lastVol = res.volumes.at(-1);
  const zp = path.join(tmp, 'last.zip');
  await fsp.writeFile(zp, r.storage.get(lastVol.storage_path));
  const z = new StreamZip.async({ file: zp });
  const rec = (await z.entryData(`${lastVol.name}/DATA/RECONCILIATION.txt`)).toString('utf8');
  await z.close();
  assert.match(rec, new RegExp(`Volumes \\.+ ${res.volumes.length}`));
  for (const v of res.volumes) assert.ok(rec.includes(`${v.name}  ${v.bates_first} - ${v.bates_last}`));
  assert.match(rec, new RegExp(`produced \\(IMAGES/, DATA/loadfile.dat\\) \\.+ ${produced.length}`));
  const manifest = JSON.parse(r.storage.get('manifest'));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.volumes.length, res.volumes.length);
  assert.ok(manifest.volumes.every((v) => /^[0-9a-f]{64}$/.test(v.sha256) && v.storage_path.endsWith(`${v.name}.zip`)));
  ok("the production's own papers are in the last volume, whose reconciliation lists every volume; the checkpoint records each volume's path and SHA-256");
}

// ---------------------------------------------------------------------------
// 5. Split for size, asked or not
// ---------------------------------------------------------------------------
{
  const r = makeRun({ maxBytes: 3000, concurrency: 3 });
  const res = await r.run();
  assert.ok(res.split && res.autoSplit && res.volumes.length > 1);
  ok('a production estimated past the size limit is split without being asked, and says so (autoSplit)');

  const estimate = estimatePackageBytes(produced, 'pdf');
  const r2 = makeRun({ maxBytes: estimate * 10, hardLimitBytes: 4000, concurrency: 3 });
  const res2 = await r2.run();
  assert.ok(res2.split && res2.autoSplit && res2.volumes.length > 1);
  const total = res2.volumes.reduce((s, v) => s + v.docs, 0);
  assert.equal(total, produced.length);
  ok('an unsplit package that grows past the hard limit after all is redone as volumes, complete');
}

// ---------------------------------------------------------------------------
// 6. Resume after a cut-off
// ---------------------------------------------------------------------------
{
  const storage = new Map();
  reads.clear();
  const first = makeRun({ maxPages: 10, concurrency: 4, failStoreAt: 2, storage });
  await assert.rejects(first.run(), /machine restarted/);
  const cut = JSON.parse(storage.get('manifest'));
  assert.equal(cut.complete, false);
  assert.equal(cut.volumes.length, 1);
  const vol1Docs = cut.volumes[0].docs;
  const vol1Ids = produced.slice(0, vol1Docs).map((x) => x.id);
  const vol1Sha = cut.volumes[0].sha256;
  ok('a job cut off during volume 2 leaves volume 1 checkpointed and the package NOT marked complete');

  reads.clear();
  const second = makeRun({ maxPages: 10, concurrency: 4, storage });
  const res = await second.run();
  assert.equal(res.resumed, 1);
  assert.ok(vol1Ids.every((id) => !reads.has(id)), 'volume 1 was packaged again');
  assert.equal(res.volumes[0].sha256, vol1Sha);
  const fresh = await makeRun({ maxPages: 10, concurrency: 1 }).run();
  assert.deepEqual(res.volumes.map((v) => [v.name, v.start, v.end, v.bates_first, v.bates_last]),
    fresh.volumes.map((v) => [v.name, v.start, v.end, v.bates_first, v.bates_last]));
  assert.equal(JSON.parse(storage.get('manifest')).complete, true);
  ok('the retry resumes at volume 2 without touching volume 1, and ends with the same volumes as an uninterrupted run');

  storage.delete(res.volumes[0].storage_path);
  reads.clear();
  const third = await makeRun({ maxPages: 10, concurrency: 4, storage }).run();
  assert.equal(third.resumed, 0);
  assert.ok(reads.size === produced.length);
  ok('a checkpointed volume whose ZIP has gone missing is made again, never assumed');
}

// ---------------------------------------------------------------------------
// 7. The streamed (TUS) upload
// ---------------------------------------------------------------------------
{
  const size = TUS_CHUNK_BYTES * 2 + 12345;
  const file = path.join(tmp, 'big.bin');
  const big = crypto.randomBytes(size);
  await fsp.writeFile(file, big);
  const server = { created: null, data: Buffer.alloc(0), patches: [], loseAnswerOnce: true };
  const hdr = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
  const fakeFetch = async (url, init) => {
    if (init.method === 'POST') {
      server.created = init.headers;
      return { status: 201, headers: hdr({ location: '/storage/v1/upload/resumable/abc' }), text: async () => '' };
    }
    if (init.method === 'HEAD') return { status: 200, headers: hdr({ 'upload-offset': String(server.data.length) }), text: async () => '' };
    const off = Number(init.headers['upload-offset']);
    assert.equal(off, server.data.length);
    server.patches.push(init.body.length);
    server.data = Buffer.concat([server.data, init.body]);
    if (server.patches.length === 2 && server.loseAnswerOnce) {
      server.loseAnswerOnce = false;
      throw new Error('socket hang up');   // stored, but the answer was lost
    }
    return { status: 204, headers: hdr({ 'upload-offset': String(server.data.length) }), text: async () => '' };
  };
  const out = await uploadFileResumable({
    supabaseUrl: 'https://x.supabase.co/', serviceKey: 'k', bucket: 'discovery-files', objectName: 'm/p/package/V.zip',
    filePath: file, fetchImpl: fakeFetch, sleep: async () => {},
  });
  assert.equal(server.data.length, size);
  assert.ok(server.data.equals(big));
  assert.deepEqual(server.patches, [TUS_CHUNK_BYTES, TUS_CHUNK_BYTES, 12345]);
  assert.equal(out.sha256, crypto.createHash('sha256').update(big).digest('hex'));
  assert.equal(server.created['upload-length'], String(size));
  assert.equal(server.created['x-upsert'], 'true');
  assert.match(server.created['upload-metadata'], new RegExp(`objectName ${Buffer.from('m/p/package/V.zip').toString('base64')}`));
  ok('the TUS upload sends 6 MB chunks, learns from the server that a chunk landed when the answer was lost, and hashes exactly what was stored');

  const refuse = async () => ({ status: 413, headers: hdr({}), text: async () => 'Payload too large' });
  await assert.rejects(uploadFileResumable({
    supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', bucket: 'b', objectName: 'o', filePath: file, fetchImpl: refuse,
  }), /refused: HTTP 413 Payload too large/);
  ok('a refused upload fails with the server\'s own reason');
}

// ---------------------------------------------------------------------------
// 8. The two intake fixes
// ---------------------------------------------------------------------------
{
  const pdfBuf = await stampedPdf(1, 1, 'rendition');
  assert.ok(isPdfBytes(pdfBuf));
  assert.deepEqual(vaultSourcePlan({ source_filename: 'VOL-SM-BD-000110.docx', metadata: { production_item_id: 'it-1' } }, pdfBuf),
    { kind: 'rendition', productionItemId: 'it-1', nameExt: '.docx' });
  assert.deepEqual(vaultSourcePlan({ source_filename: 'Clinic-Letter.docx', metadata: {} }, pdfBuf),
    { kind: 'rendition', productionItemId: null, nameExt: '.docx' });
  assert.deepEqual(vaultSourcePlan({ source_filename: 'Letter.docx' }, Buffer.from('PK\u0003\u0004word')), { kind: 'as-stored' });
  assert.deepEqual(vaultSourcePlan({ source_filename: 'Scan.pdf' }, pdfBuf), { kind: 'as-stored' });
  assert.deepEqual(vaultSourcePlan({ source_filename: 'note.eml', metadata: { production_item_id: 'it-2' } }, pdfBuf).kind, 'rendition');
  const asPdf = await normalizeFile(pdfBuf, 'VOL-SM-BD-000110.docx.pdf');
  assert.equal(asPdf.kind, 'display_pdf');
  assert.equal(asPdf.pageCount, 1);
  ok('a PDF filed under a Word or email name is a rendition (its original is sought, else it is produced as the PDF), never sent to LibreOffice');

  const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } }).jpeg().toBuffer();
  assert.equal(sniffImage(jpeg), 'jpeg');
  const n1 = await normalizeFile(jpeg, 'Competition 1.png');
  assert.equal(n1.kind, 'display_pdf');
  assert.equal(n1.pageCount, 1);
  const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#0000' } }).png().toBuffer();
  assert.equal(sniffImage(png), 'png');
  await assert.rejects(normalizeFile(Buffer.from('this is not an image at all'), 'broken.png'),
    (e) => e instanceof Error && /could not be turned into a page/.test(e.message) && !/undefined/.test(e.message));
  assert.equal(errorText('The input is not a PNG file!'), 'The input is not a PNG file!');
  assert.equal(errorText(new Error('x')), 'x');
  assert.notEqual(errorText(undefined), '');
  ok('a JPEG named .png becomes a page; an unreadable image says why, never "normalize: undefined"');
}

// ---------------------------------------------------------------------------
// 9. A rough local benchmark (informational): storage stubbed with a delay
//    standing in for the network round trip that dominated on the live worker.
// ---------------------------------------------------------------------------
if (process.env.VOLUME_BENCH) {
  const latency = Number(process.env.VOLUME_BENCH_LATENCY_MS ?? 120);
  const slow = (fn) => async (item) => { await sleep(latency * 2); return fn(item); };
  for (const c of [1, 6]) {
    const t0 = Date.now();
    await packageVolumes({
      produced, imageFormat: 'pdf', baseName: 'B', concurrency: c,
      packageOne: slow(packageOneFor('pdf')),
      productionFiles: async () => {},
      storeVolume: async ({ file }) => ({ storage_path: file, sha256: '' }),
      openArchive: () => openZipArchive({ dir: tmp }),
    });
    const ms = Date.now() - t0;
    console.log(`  BENCH concurrency ${c}: ${ms} ms for ${totalPagesExpected} pages (${(ms / totalPagesExpected).toFixed(0)} ms/page)`);
  }
}

await fsp.rm(tmp, { recursive: true, force: true });
assert.ok(fs.existsSync(path.resolve('lib/discovery/volumes.mjs')));
console.log(`\nDiscovery at volume verified offline: ${n} checks passed.`);

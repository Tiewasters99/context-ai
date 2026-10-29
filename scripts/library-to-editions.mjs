// The Library → editions: mirror Contextspaces' Library serverspace into
// Grapheon Reader editions (Phase 2S; docs/specs/GRAPHEON-READER-2026-10-10.md,
// "The Library in the Store — mirroring 376 books"; D13, D17, D18, D19).
//
// Service role, run from a clean clone with `.env` beside it, idempotent:
// keyed by editions.source_document_id, a book already mirrored is skipped
// (or repaired with --repair). Nothing is PUBLISHED here; every edition is
// made as a draft with access = 'library'. Launch day publishes them.
//
//   node scripts/library-to-editions.mjs                    dry run: the plan, and the CSV
//   node scripts/library-to-editions.mjs --write            make the editions, copy the
//                                                           books, cut the samples, covers
//   node scripts/library-to-editions.mjs --write --repair   also fill in missing assets on
//                                                           editions mirrored earlier
//   --limit N          stop after N new editions (try --write --limit 3 first)
//   --only <text>      only documents whose filename contains <text> (case-insensitive)
//   --publisher <uuid> the publisher of record (D19). Default: the account that
//                      filed the Library's documents (one uploader today)
//   --queue --release-from YYYY-MM-DD
//                      also set release_on, 3 a day (D17), sets together.
//                      Without it release_on stays null (launch publishes all)
//   --csv <path>       the authors file (default scripts/library-authors.csv)
//   --no-covers        skip cover work        --no-samples   skip the sample cut
//
// Per document, in write mode:
//   1. insert the edition (draft, access library, rights public_domain,
//      price 0, title and author from the CSV when Eden filled them, else
//      from the filename grammar and the PDF's own metadata);
//   2. copy the PDF server-side, vault-documents → editions/<edition>/book/…,
//      and record the book asset (bytes, sha256);
//   3. download the PDF once; cut the first N pages (D13) with pdf-lib into
//      edition-samples/<edition>/0.pdf (public) and record the sample asset;
//   4. the cover: the document's chosen cover (cover_url) copied into the
//      editions bucket as <edition>/cover.<ext>; with no chosen cover, page
//      one rendered to a JPEG (pdfjs + @napi-rs/canvas) — the jacket the
//      Office would have captured. cover_path set, cover asset recorded.
// A failure in 2–4 leaves the edition in place and is listed at the end;
// --repair on a later run fills what is missing. A document in a sealed
// matter is never copied (the Library's shelves are open; checked anyway).
//
// The CSV (D18): scripts/library-authors.csv, one row per document, columns
// document_id, filename, title, author. Written on every run (new rows
// appended, filled rows kept). Eden fills author (and fixes a title); the
// next run applies them to new editions, and --repair re-applies title and
// author to editions already mirrored.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';
import {
  parseLibraryName, displayTitle, assignVolumes, sampleLength, slugFor, queueDays,
  parseAuthorsCsv, renderAuthorsCsv,
} from '../lib/library-mirror.mjs';

const LIBRARY_SERVERSPACE = 'c7117b5e-ae55-48dc-a444-c01f30df27ca';
const VAULT_BUCKET = 'vault-documents';
const EDITIONS_BUCKET = 'editions';
const SAMPLES_BUCKET = 'edition-samples';

// ---------------------------------------------------------------------------
// arguments and environment
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };
const WRITE = flag('write');
const REPAIR = flag('repair');
const LIMIT = Number(opt('limit', '0')) || 0;
const ONLY = (opt('only') || '').toLowerCase();
const QUEUE = flag('queue');
const RELEASE_FROM = opt('release-from');
const CSV_PATH = path.resolve(opt('csv', 'scripts/library-authors.csv'));
const DO_COVERS = !flag('no-covers');
const DO_SAMPLES = !flag('no-samples');
if (QUEUE && !RELEASE_FROM) { console.error('--queue needs --release-from YYYY-MM-DD'); process.exit(2); }

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);
const SUPABASE_URL = (env.VITE_SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_URL || !SERVICE_KEY || /PASTE/.test(SERVICE_KEY)) { console.error('.env needs VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(2); }
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const log = (...a) => console.log(...a);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const safeName = (name) => Array.from(String(name ?? '')).filter((c) => c.charCodeAt(0) >= 32).join('')
  .replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(-120) || 'book.pdf';

// ---------------------------------------------------------------------------
// 1. read the Library and what is already mirrored
// ---------------------------------------------------------------------------

const { data: shelves, error: shelvesErr } = await sb.from('matterspaces').select('id, name, ai_tier').eq('serverspace_id', LIBRARY_SERVERSPACE);
if (shelvesErr) throw new Error(`shelves: ${shelvesErr.message}`);
const shelfById = new Map(shelves.map((s) => [s.id, s]));
const openShelves = shelves.filter((s) => !['B', 'C'].includes(String(s.ai_tier || 'A')));
if (openShelves.length !== shelves.length) log(`! ${shelves.length - openShelves.length} shelf/shelves sealed — skipped`);

const docs = [];
for (const shelf of openShelves) {
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from('documents')
      .select('id, title, source_filename, storage_path, file_size_bytes, page_count, author, cover_url, matterspace_id, created_by, created_at')
      .eq('matterspace_id', shelf.id).eq('processing_status', 'ready')
      .order('created_at', { ascending: true }).range(from, from + 499);
    if (error) throw new Error(`documents: ${error.message}`);
    docs.push(...(data ?? []));
    if (!data || data.length < 500) break;
    from += 500;
  }
}
const pdfs = docs.filter((d) => /\.pdf$/i.test(d.source_filename || '') || /\.pdf$/i.test(d.storage_path || ''));
const skippedNonPdf = docs.length - pdfs.length;

// 112's columns only, so the plan can be read before 126 is applied; the
// write path needs 126 (access, collection_key, volume, release_on, the
// sample kind, the samples bucket) and refuses without it.
const { data: mirrored, error: mirroredErr } = await sb.from('editions')
  .select('id, slug, title, author, source_document_id, status, cover_path')
  .not('source_document_id', 'is', null);
if (mirroredErr) throw new Error(`editions: ${mirroredErr.message}`);
const probe126 = await sb.from('editions').select('access, release_on').limit(1);
const HAS_126 = !probe126.error;
if (!HAS_126) log('! migration 126 is not applied on this database (editions.access missing) — the plan is shown; --write is refused until it is');
const { data: allSlugs } = await sb.from('editions').select('slug');
const taken = new Set((allSlugs ?? []).map((r) => r.slug));
const mirroredByDoc = new Map((mirrored ?? []).map((e) => [e.source_document_id, e]));

const uploaders = [...new Set(pdfs.map((d) => d.created_by).filter(Boolean))];
const PUBLISHER = opt('publisher') || (uploaders.length === 1 ? uploaders[0] : null);
if (!PUBLISHER) { console.error(`the Library has ${uploaders.length} uploaders; say --publisher <uuid>`); process.exit(2); }

// ---------------------------------------------------------------------------
// 2. the plan: parse, group, number, name
// ---------------------------------------------------------------------------

const csvRows = fs.existsSync(CSV_PATH) ? parseAuthorsCsv(fs.readFileSync(CSV_PATH, 'utf8')) : new Map();

const items = pdfs
  .filter((d) => !ONLY || String(d.source_filename || '').toLowerCase().includes(ONLY))
  .map((d) => {
    const csv = csvRows.get(d.id);
    const parsed = parseLibraryName(d.source_filename || path.basename(d.storage_path || ''), d.title);
    if (csv?.title) parsed.cleanTitle = csv.title;
    return { doc: d, parsed, csv, shelf: shelfById.get(d.matterspace_id)?.name ?? '?', existing: mirroredByDoc.get(d.id) ?? null };
  });
assignVolumes(items);
// Volumes are numbered within the WHOLE collection (filtered items only see
// their own; with --only the numbering may differ — say so).
if (ONLY) log('! --only in effect: volume numbers are relative to the filtered set');

const releaseDays = QUEUE ? queueDays(items.filter((i) => !i.existing), RELEASE_FROM, 3) : new Map();

for (const it of items) {
  it.title = displayTitle(it.parsed);
  it.author = it.csv?.author || it.doc.author || null;
  it.sampleN = sampleLength(it.doc.page_count);
  it.releaseOn = releaseDays.get(it) ?? null;
}

// the CSV: every document, Eden's filled rows kept
const csvOut = items
  .slice()
  .sort((a, b) => a.shelf.localeCompare(b.shelf) || a.parsed.cleanTitle.localeCompare(b.parsed.cleanTitle) || (a.volume ?? 0) - (b.volume ?? 0))
  .map((it) => ({
    document_id: it.doc.id,
    filename: it.doc.source_filename,
    title: it.csv?.title ?? (it.parsed.needsTitle ? '' : it.parsed.cleanTitle),
    author: it.csv?.author ?? '',
  }));
fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
fs.writeFileSync(CSV_PATH, renderAuthorsCsv(csvOut), 'utf8');

const fresh = items.filter((i) => !i.existing);
const needTitle = items.filter((i) => i.parsed.needsTitle && !i.csv?.title);
const noPages = items.filter((i) => !i.doc.page_count);
const collections = new Set(items.filter((i) => i.parsed.collectionKey).map((i) => i.parsed.collectionKey.toLowerCase()));

log(`Library: ${shelves.length} shelves, ${docs.length} ready documents, ${pdfs.length} PDFs (${skippedNonPdf} non-PDF skipped)`);
log(`Plan: ${fresh.length} new editions, ${items.length - fresh.length} already mirrored; ${collections.size} volume sets; ` +
    `${items.filter((i) => i.doc.cover_url).length} with a chosen cover, ${items.filter((i) => !i.doc.cover_url).length} get page one; ` +
    `${items.filter((i) => i.author).length} with an author`);
log(`Publisher of record: ${PUBLISHER}${uploaders.length === 1 && !opt('publisher') ? ' (the Library\'s uploader)' : ''}`);
log(`CSV: ${path.relative(process.cwd(), CSV_PATH)} (${csvOut.length} rows; ${csvOut.filter((r) => r.author).length} authors filled)`);
if (needTitle.length) log(`! ${needTitle.length} filename(s) look raw — give them a title in the CSV: ${needTitle.map((i) => i.doc.source_filename).join(' · ')}`);
if (noPages.length) log(`! ${noPages.length} document(s) have no page_count; the sample length is taken from the PDF itself: ${noPages.map((i) => i.doc.source_filename).join(' · ')}`);

const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
log('\n' + pad('shelf', 10) + pad('title', 62) + pad('vol', 4) + pad('pages', 6) + pad('smp', 4) + pad('cover', 6) + pad('author', 24) + 'state');
for (const it of items.slice().sort((a, b) => a.shelf.localeCompare(b.shelf) || a.parsed.cleanTitle.localeCompare(b.parsed.cleanTitle) || (a.volume ?? 0) - (b.volume ?? 0))) {
  log(pad(it.shelf, 10) + pad(it.title, 62) + pad(it.volume ?? '', 4) + pad(it.doc.page_count ?? '?', 6) + pad(it.sampleN || '?', 4) +
      pad(it.doc.cover_url ? 'yes' : 'p.1', 6) + pad(it.author ?? '', 24) + (it.existing ? `mirrored (${it.existing.status})` : it.releaseOn ? `new → ${it.releaseOn}` : 'new'));
}

if (!WRITE) {
  log(`\nDry run. Nothing written to Supabase. Run again with --write${fresh.length > 3 ? ' --limit 3' : ''} to begin.`);
  process.exit(0);
}
if (!HAS_126) { console.error('Apply supabase/migrations/126_reader_membership.sql first (Eden applies), then run --write.'); process.exit(2); }

// ---------------------------------------------------------------------------
// 3. write
// ---------------------------------------------------------------------------

async function copyObject(fromBucket, fromKey, toBucket, toKey) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/copy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ bucketId: fromBucket, sourceKey: fromKey, destinationBucket: toBucket, destinationKey: toKey }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`copy ${res.status}: ${t.slice(0, 200)}`); }
}

async function download(bucket, key) {
  const { data, error } = await sb.storage.from(bucket).download(key);
  if (error || !data) throw new Error(`download ${bucket}/${key}: ${error?.message ?? 'empty'}`);
  return Buffer.from(await data.arrayBuffer());
}

async function upload(bucket, key, buf, contentType) {
  const { error } = await sb.storage.from(bucket).upload(key, buf, { contentType, upsert: true, cacheControl: bucket === SAMPLES_BUCKET ? '31536000' : '3600' });
  if (error) throw new Error(`upload ${bucket}/${key}: ${error.message}`);
}

async function assetRow(editionId, kind, storagePath, bytes, mime, hash) {
  // one book / one sample per edition: replace the row if one exists
  if (kind === 'book' || kind === 'sample' || kind === 'cover') {
    await sb.from('edition_assets').delete().eq('edition_id', editionId).eq('kind', kind);
  }
  const { data, error } = await sb.from('edition_assets')
    .insert({ edition_id: editionId, kind, storage_path: storagePath, bytes, mime, sha256: hash ?? null })
    .select('id').single();
  if (error) throw new Error(`edition_assets ${kind}: ${error.message}`);
  return data.id;
}

let pdfjs = null;
let canvasMod = null;
async function renderPageOne(pdfBuf) {
  if (!pdfjs) {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    canvasMod = await import('@napi-rs/canvas');
  }
  const fonts = pathToFileURL(path.resolve('node_modules/pdfjs-dist/standard_fonts/')).href + '/';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf), useSystemFonts: false, isEvalSupported: false, standardFontDataUrl: fonts }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, 1200 / base.width);
    const vp = page.getViewport({ scale });
    const canvas = canvasMod.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    return canvas.toBuffer('image/jpeg', 85);
  } finally {
    await doc.destroy().catch(() => {});
  }
}

async function cutSample(pdfBuf, n) {
  const src = await PDFDocument.load(pdfBuf, { ignoreEncryption: true, updateMetadata: false });
  const total = src.getPageCount();
  const take = Math.min(n || sampleLength(total), total);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, Array.from({ length: take }, (_, i) => i));
  pages.forEach((p) => out.addPage(p));
  out.setTitle(src.getTitle() ? `${src.getTitle()} — sample` : 'Sample');
  out.setProducer('Grapheon Reader');
  const bytes = await out.save({ useObjectStreams: true });
  return { buf: Buffer.from(bytes), pages: take, total, author: (src.getAuthor() || '').trim() || null };
}

const report = { made: 0, repaired: 0, books: 0, samples: 0, covers: 0, failures: [] };
let made = 0;

for (const it of items) {
  if (it.existing && !REPAIR) continue;
  if (!it.existing && LIMIT && made >= LIMIT) break;
  const d = it.doc;
  const label = `${it.shelf} · ${it.title}`;
  try {
    let edition = it.existing;
    if (!edition) {
      const slug = slugFor(it.parsed.cleanTitle, it.volume, taken);
      taken.add(slug);
      const rightsNote = `Public domain. Source file: ${d.source_filename}; a cleaned scan filed in the Library (${it.shelf}) on ${String(d.created_at).slice(0, 10)}.`;
      const { data, error } = await sb.from('editions').insert({
        slug, title: it.title, author: it.author, publisher_user_id: PUBLISHER, source_document_id: d.id,
        access: 'library', rights: 'public_domain', rights_note: rightsNote, price_cents: 0, status: 'draft',
        collection_key: it.parsed.collectionKey, volume: it.volume, release_on: it.releaseOn,
      }).select('id, slug, title, author, cover_path, status').single();
      if (error) throw new Error(`editions insert: ${error.message}`);
      edition = data;
      made += 1;
      report.made += 1;
      log(`+ ${label} → ${edition.slug}`);
    } else {
      // --repair: title and author follow the CSV; everything else is filled where missing
      const patch = {};
      if (it.csv?.title && edition.title !== it.title) patch.title = it.title;
      if (it.author && edition.author !== it.author) patch.author = it.author;
      if (Object.keys(patch).length) await sb.from('editions').update(patch).eq('id', edition.id);
      report.repaired += 1;
      log(`~ ${label} (${edition.slug})`);
    }

    const { data: have } = await sb.from('edition_assets').select('kind, storage_path').eq('edition_id', edition.id);
    const haveKind = new Set((have ?? []).map((a) => a.kind));

    if (!haveKind.has('book')) {
      const toKey = `${edition.id}/book/${Date.now().toString(36)}-${safeName(d.source_filename || 'book.pdf')}`;
      await copyObject(VAULT_BUCKET, d.storage_path, EDITIONS_BUCKET, toKey);
      it.bookKey = toKey;
      report.books += 1;
      log(`  book copied (${((d.file_size_bytes ?? 0) / 1048576).toFixed(1)} MB)`);
    } else {
      it.bookKey = (have ?? []).find((a) => a.kind === 'book')?.storage_path ?? null;
    }

    const needSample = DO_SAMPLES && !haveKind.has('sample');
    const needCover = DO_COVERS && (!haveKind.has('cover') || !edition.cover_path);
    let pdfBuf = null;
    if (needSample || (needCover && !d.cover_url) || !haveKind.has('book') || !it.author) {
      pdfBuf = await download(VAULT_BUCKET, d.storage_path);
    }
    if (!haveKind.has('book') && it.bookKey) {
      await assetRow(edition.id, 'book', it.bookKey, pdfBuf?.length ?? d.file_size_bytes ?? null, 'application/pdf', pdfBuf ? sha256(pdfBuf) : null);
    }

    if (needSample && pdfBuf) {
      const cut = await cutSample(pdfBuf, it.sampleN);
      const key = `${edition.id}/0.pdf`;
      await upload(SAMPLES_BUCKET, key, cut.buf, 'application/pdf');
      await assetRow(edition.id, 'sample', key, cut.buf.length, 'application/pdf', sha256(cut.buf));
      report.samples += 1;
      log(`  sample: ${cut.pages} of ${cut.total} pages, ${(cut.buf.length / 1024).toFixed(0)} KB`);
      if (!it.author && cut.author && !/unknown|^\W*$/i.test(cut.author) && cut.author.length < 120) {
        await sb.from('editions').update({ author: cut.author }).eq('id', edition.id);
        log(`  author from the PDF: ${cut.author}`);
      }
    }

    if (needCover) {
      let coverBuf = null;
      let ext = 'jpg';
      let mime = 'image/jpeg';
      if (d.cover_url) {
        const res = await fetch(d.cover_url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`cover ${res.status}`);
        coverBuf = Buffer.from(await res.arrayBuffer());
        mime = res.headers.get('content-type')?.split(';')[0] || 'image/png';
        ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      } else if (pdfBuf) {
        coverBuf = await renderPageOne(pdfBuf);
      }
      if (coverBuf) {
        const key = `${edition.id}/cover.${ext}`;
        await upload(EDITIONS_BUCKET, key, coverBuf, mime);
        await assetRow(edition.id, 'cover', key, coverBuf.length, mime, sha256(coverBuf));
        await sb.from('editions').update({ cover_path: key }).eq('id', edition.id);
        report.covers += 1;
        log(`  cover: ${d.cover_url ? 'the chosen cover' : 'page one'} (${(coverBuf.length / 1024).toFixed(0)} KB)`);
      }
    }
  } catch (err) {
    report.failures.push({ title: it.title, error: err?.message || String(err) });
    log(`! ${label}: ${err?.message || err}`);
  }
}

log(`\nDone. ${report.made} editions made, ${report.repaired} revisited; ${report.books} books copied, ${report.samples} samples cut, ${report.covers} covers set.`);
if (report.failures.length) {
  log(`${report.failures.length} failure(s) — run again with --write --repair to fill what is missing:`);
  for (const f of report.failures) log(`  ${f.title}: ${f.error}`);
  process.exit(1);
}

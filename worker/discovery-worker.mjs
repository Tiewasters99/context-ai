// Grapheon Discovery worker — heavy processing for document productions.
//
// Claims jobs from the processing_jobs queue (atomic claim_discovery_job RPC,
// FOR UPDATE SKIP LOCKED) and executes them with the service role. Runs
// locally OR as a hosted long-running service (Railway/Fly) — config is
// entirely env-driven.
//
// Usage:
//   node worker/discovery-worker.mjs                  # poll loop (default)
//   node worker/discovery-worker.mjs --once           # drain queue, then exit
//   node worker/discovery-worker.mjs --intake <folder> --production <id>
//                                                     # direct local-disk intake
//                                                     # (bypasses browser upload
//                                                     #  limits for huge productions)
//
// Required env (read from ./.env at repo root):
//   VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   OPENAI_API_KEY   - enables full-text ingestion of display PDFs
//   GOOGLE_API_KEY   - enables Gemini OCR fallback for scanned PDFs
//   WORKER_ID        - identifier recorded on claimed jobs
//
// Job types: intake_zip | intake_files | intake_folder | stamp_production |
//            package_production

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { processDocument } from '../lib/ingest-core.mjs';
import {
  sha256, formatBates, sanitizeStorageName, mimeFor, isJunkPath, extOf, loadEnv,
} from '../lib/discovery/util.mjs';
import { normalizeFile } from '../lib/discovery/normalize.mjs';
import {
  parseDat, datLookupByFilename, emitDat, emitOpt,
} from '../lib/discovery/loadfile.mjs';
import {
  stampPdf, makeSlipSheet, makeProductionLetter, makePrivilegeLogPdf,
} from '../lib/discovery/bates-stamp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
const WORKER_ID = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
const BUCKET = 'discovery-files';
const POLL_MS = 5000;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const args = parseArgs(process.argv.slice(2));

if (args.intake) {
  await directFolderIntake(args.intake, args.production);
  process.exit(0);
}

log(`Discovery worker ${WORKER_ID} started (poll ${POLL_MS}ms${args.once ? ', --once' : ''})`);
for (;;) {
  const job = await claimJob();
  if (!job) {
    if (args.once) break;
    await sleep(POLL_MS);
    continue;
  }
  log(`[job ${job.id}] ${job.job_type} (production ${job.production_id ?? '—'})`);
  try {
    await dispatch(job);
    await supabase.from('processing_jobs')
      .update({ status: 'done', progress: 100, finished_at: new Date().toISOString() })
      .eq('id', job.id);
    log(`[job ${job.id}] done`);
  } catch (err) {
    log(`[job ${job.id}] ERROR: ${err.message}`);
    await supabase.from('processing_jobs')
      .update({ status: 'error', error: String(err.message ?? err), finished_at: new Date().toISOString() })
      .eq('id', job.id);
    if (job.production_id && job.job_type.startsWith('intake')) {
      await supabase.from('productions').update({ status: 'error' }).eq('id', job.production_id);
    }
  }
}
log('Queue drained; exiting.');

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
async function dispatch(job) {
  switch (job.job_type) {
    case 'intake_zip': return intakeZip(job);
    case 'intake_files': return intakeFiles(job);
    case 'intake_folder': return intakeFolder(job);
    case 'stamp_production': return stampProduction(job);
    case 'package_production': return packageProduction(job);
    default: throw new Error(`Unknown job_type '${job.job_type}'`);
  }
}

async function claimJob() {
  const { data, error } = await supabase.rpc('claim_discovery_job', { p_worker: WORKER_ID });
  if (error) {
    log(`claim error: ${error.message}`);
    return null;
  }
  return Array.isArray(data) ? data[0] ?? null : data ?? null;
}

async function progress(job, pct, note) {
  await supabase.from('processing_jobs')
    .update({ progress: Math.min(99, Math.round(pct)), progress_note: note ?? null })
    .eq('id', job.id);
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------
async function intakeZip(job) {
  const prod = await getProduction(job.production_id);
  await setProductionStatus(prod.id, 'processing');
  const paths = job.payload?.storage_paths ?? [];
  if (paths.length === 0) throw new Error('intake_zip: payload.storage_paths is empty');

  const StreamZip = (await import('node-stream-zip')).default;
  let fileIndex = 0;

  for (const storagePath of paths) {
    await progress(job, 1, `Downloading ${path.basename(storagePath)}…`);
    const zipBuf = await downloadFromStorage(storagePath);
    const tmp = path.join(os.tmpdir(), `disc-intake-${crypto.randomUUID()}.zip`);
    await fs.writeFile(tmp, zipBuf);

    try {
      const zip = new StreamZip.async({ file: tmp });
      const entries = Object.values(await zip.entries())
        .filter((e) => !e.isDirectory && !isJunkPath(e.name));

      // Pass 1: load files. Opposing counsel's own Bates numbers and document
      // breaks are trusted over filename guessing.
      let datLookup = new Map();
      for (const e of entries.filter((e) => /\.dat$/i.test(e.name))) {
        const { records } = parseDat(await zip.entryData(e.name));
        datLookup = new Map([...datLookup, ...datLookupByFilename(records)]);
        await uploadToStorage(
          `${prod.matterspace_id}/${prod.id}/loadfiles/${sanitizeStorageName(path.basename(e.name))}`,
          await zip.entryData(e.name), 'application/octet-stream',
        );
      }

      const contentEntries = entries
        .filter((e) => !/\.(dat|opt|lfp)$/i.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const e of contentEntries) {
        fileIndex += 1;
        await progress(job, (fileIndex / contentEntries.length) * 100, e.name);
        const buf = await zip.entryData(e.name);
        await intakeOneFile(prod, job, {
          buf, originalPath: e.name, sortOrder: fileIndex, datLookup,
        });
      }
      await zip.close();
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  await setProductionStatus(prod.id, 'review');
}

async function intakeFiles(job) {
  const prod = await getProduction(job.production_id);
  await setProductionStatus(prod.id, 'processing');
  const paths = job.payload?.storage_paths ?? [];
  if (paths.length === 0) throw new Error('intake_files: payload.storage_paths is empty');

  for (const [i, storagePath] of paths.entries()) {
    const filename = path.basename(storagePath);
    await progress(job, ((i + 1) / paths.length) * 100, filename);
    const buf = await downloadFromStorage(storagePath);
    await intakeOneFile(prod, job, {
      buf, originalPath: filename, sortOrder: i + 1, datLookup: new Map(),
    });
  }
  await setProductionStatus(prod.id, 'review');
}

async function intakeFolder(job) {
  const prod = await getProduction(job.production_id);
  await setProductionStatus(prod.id, 'processing');
  const root = job.payload?.local_path;
  if (!root) throw new Error('intake_folder: payload.local_path missing');

  const files = [];
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const parent = e.parentPath || e.path || root;
    const full = path.join(parent, e.name);
    const rel = path.relative(root, full).replaceAll('\\', '/');
    if (isJunkPath(rel)) continue;
    files.push({ full, rel });
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  // Load files first.
  let datLookup = new Map();
  for (const f of files.filter((f) => /\.dat$/i.test(f.rel))) {
    const buf = await fs.readFile(f.full);
    const { records } = parseDat(buf);
    datLookup = new Map([...datLookup, ...datLookupByFilename(records)]);
    await uploadToStorage(
      `${prod.matterspace_id}/${prod.id}/loadfiles/${sanitizeStorageName(path.basename(f.rel))}`,
      buf, 'application/octet-stream',
    );
  }

  const content = files.filter((f) => !/\.(dat|opt|lfp)$/i.test(f.rel));
  for (const [i, f] of content.entries()) {
    await progress(job, ((i + 1) / content.length) * 100, f.rel);
    const buf = await fs.readFile(f.full);
    await intakeOneFile(prod, job, {
      buf, originalPath: f.rel, sortOrder: i + 1, datLookup,
    });
  }
  await setProductionStatus(prod.id, 'review');
}

/**
 * Normalize one file into the image/native/metadata triplet, store it,
 * record the production_items row, and (optionally) ingest the display PDF
 * into the matter's searchable corpus.
 */
async function intakeOneFile(prod, job, { buf, originalPath, sortOrder, datLookup }) {
  const filename = path.basename(originalPath);
  const hash = sha256(buf);

  let norm;
  try {
    norm = await normalizeFile(buf, filename);
  } catch (err) {
    await supabase.from('production_items').insert({
      production_id: prod.id, matterspace_id: prod.matterspace_id,
      sort_order: sortOrder, original_filename: filename, original_path: originalPath,
      sha256: hash, file_size_bytes: buf.length, kind: 'native',
      status: 'error', error: `normalize: ${err.message}`,
    });
    return;
  }

  // Attach load-file metadata when the production's DAT references this file.
  const datRec = datLookup.get(filename.toLowerCase());
  const metadata = { ...norm.metadata, ...(datRec ?? {}) };

  const { data: item, error: itemErr } = await supabase.from('production_items').insert({
    production_id: prod.id,
    matterspace_id: prod.matterspace_id,
    sort_order: sortOrder,
    original_filename: filename,
    original_path: originalPath,
    sha256: hash,
    file_size_bytes: buf.length,
    kind: norm.kind,
    page_count: norm.pageCount,
    bates_first: datRec?.bates_first ?? null,
    bates_last: datRec?.bates_last ?? null,
    source_metadata: metadata,
    status: 'pending',
  }).select().single();
  if (itemErr) throw new Error(`insert production_item (${filename}): ${itemErr.message}`);

  try {
    const base = `${prod.matterspace_id}/${prod.id}/${item.id}`;
    const ext = extOf(filename);

    // Native: the original bytes, always retained.
    const nativePath = `${base}/native/${sanitizeStorageName(filename)}`;
    await uploadToStorage(nativePath, buf, mimeFor(ext));

    // Display PDF: passthrough PDFs reuse the native object; conversions
    // (TIFF/image -> PDF) get their own object.
    let displayPath = null;
    if (norm.kind === 'display_pdf') {
      if (norm.displayPdf === buf) {
        displayPath = nativePath;
      } else {
        displayPath = `${base}/display.pdf`;
        await uploadToStorage(displayPath, norm.displayPdf, 'application/pdf');
      }
    }

    await supabase.from('production_items').update({
      native_storage_path: nativePath,
      display_storage_path: displayPath,
      status: 'ready',
    }).eq('id', item.id);

    // Full-text ingestion into the matter corpus (per-page extraction, OCR
    // fallback, embeddings) — the production becomes searchable matter-wide.
    if (norm.kind === 'display_pdf' && OPENAI_API_KEY && job.payload?.ingest !== false) {
      await ingestDisplayPdf(prod, item, norm.displayPdf, filename);
    }
  } catch (err) {
    await supabase.from('production_items')
      .update({ status: 'error', error: err.message })
      .eq('id', item.id);
  }
}

async function ingestDisplayPdf(prod, item, pdfBuf, filename) {
  const { data: docRow, error } = await supabase.from('documents').insert({
    matterspace_id: prod.matterspace_id,
    title: filename,
    doc_type: 'other',
    source_filename: filename,
    file_size_bytes: pdfBuf.length,
    processing_status: 'pending',
    created_by: prod.created_by,
    metadata: { production_id: prod.id, production_item_id: item.id },
  }).select().single();
  if (error) throw new Error(`insert document: ${error.message}`);

  // Mirror into vault-documents so DocumentReader and the MCP tools see it
  // through the standard path convention.
  const storagePath = `${prod.matterspace_id}/${docRow.id}/${sanitizeStorageName(filename.replace(/\.[^.]+$/, ''))}.pdf`;
  await supabase.storage.from('vault-documents')
    .upload(storagePath, pdfBuf, { contentType: 'application/pdf', upsert: true });
  await supabase.from('documents').update({ storage_path: storagePath }).eq('id', docRow.id);

  try {
    let ocr = null;
    if (GOOGLE_API_KEY) {
      const { ocrPdf } = await import('../lib/ocr-gemini.mjs');
      ocr = (b) => ocrPdf(b, { apiKey: GOOGLE_API_KEY });
    }
    await processDocument(supabase, {
      documentId: docRow.id,
      fileBuf: pdfBuf,
      ext: '.pdf',
      openaiApiKey: OPENAI_API_KEY,
      ocr,
    });
  } catch (err) {
    await supabase.from('documents')
      .update({ processing_status: 'error', processing_error: err.message })
      .eq('id', docRow.id);
    // Ingestion failure is non-fatal: the item is still reviewable.
  }
  await supabase.from('production_items').update({ document_id: docRow.id }).eq('id', item.id);
}

// ---------------------------------------------------------------------------
// Stamping
// ---------------------------------------------------------------------------
async function stampProduction(job) {
  const prod = await getProduction(job.production_id);
  if (['stamped', 'packaged', 'delivered'].includes(prod.status)) {
    throw new Error(`Production already ${prod.status}; create a supplemental production instead`);
  }
  if (!prod.bates_prefix && prod.bates_prefix !== '') {
    throw new Error('stamp_production: bates_prefix not configured on the production');
  }

  const { included, excluded, endorsementsByItem } = await partitionItems(prod);
  if (included.length === 0) throw new Error('No documents to stamp (all excluded?)');

  // Total pages -> preflight the Bates range against the matter registry.
  const totalPages = included.reduce(
    (sum, it) => sum + (it.kind === 'native' ? 1 : (it.page_count ?? 1)), 0);
  const startSeq = prod.bates_start ?? (await registryHighWaterMark(prod.matterspace_id)) + 1;
  const endSeq = startSeq + totalPages - 1;

  const { count: collisions } = await supabase.from('bates_registry')
    .select('id', { count: 'exact', head: true })
    .eq('matterspace_id', prod.matterspace_id)
    .gte('bates_seq', startSeq)
    .lte('bates_seq', endSeq);
  if (collisions > 0) {
    throw new Error(
      `Bates collision: ${collisions} number(s) in ${formatBates(prod.bates_prefix, prod.bates_pad, startSeq)}–` +
      `${formatBates(prod.bates_prefix, prod.bates_pad, endSeq)} already assigned in this matter`);
  }

  let seq = startSeq;
  for (const [i, item] of included.entries()) {
    await progress(job, (i / included.length) * 100,
      `Stamping ${item.original_filename} (${formatBates(prod.bates_prefix, prod.bates_pad, seq)})`);
    const endorsements = endorsementsByItem.get(item.id) ?? [];
    const base = `${prod.matterspace_id}/${prod.id}/${item.id}`;

    let pageCount;
    if (item.kind === 'native') {
      const bates = formatBates(prod.bates_prefix, prod.bates_pad, seq);
      const sheet = await makeSlipSheet({
        batesNumber: bates, filename: item.original_filename,
        endorsements, position: prod.bates_position,
      });
      await uploadToStorage(`${base}/stamped.pdf`, sheet, 'application/pdf');
      pageCount = 1;
      await supabase.from('production_items')
        .update({ bates_first: bates, bates_last: bates })
        .eq('id', item.id);
    } else {
      const pdfBuf = await downloadFromStorage(item.display_storage_path);
      const stamped = await stampPdf(pdfBuf, {
        prefix: prod.bates_prefix, pad: prod.bates_pad, startSeq: seq,
        position: prod.bates_position, endorsements,
      });
      await uploadToStorage(`${base}/stamped.pdf`, stamped.buf, 'application/pdf');
      pageCount = stamped.pageCount;
      await supabase.from('production_items')
        .update({ bates_first: stamped.batesFirst, bates_last: stamped.batesLast, page_count: pageCount })
        .eq('id', item.id);
    }

    // Registry rows: one per page, batched. The unique constraint on
    // (matterspace_id, bates_number) is the final authority.
    const rows = [];
    for (let p = 0; p < pageCount; p++) {
      rows.push({
        matterspace_id: prod.matterspace_id,
        bates_number: formatBates(prod.bates_prefix, prod.bates_pad, seq + p),
        bates_seq: seq + p,
        production_id: prod.id,
        production_item_id: item.id,
        page_number: p + 1,
      });
    }
    for (let off = 0; off < rows.length; off += 1000) {
      const { error } = await supabase.from('bates_registry').insert(rows.slice(off, off + 1000));
      if (error) throw new Error(`bates_registry insert: ${error.message}`);
    }
    seq += pageCount;
  }

  await supabase.from('productions').update({
    bates_start: startSeq,
    bates_end: seq - 1,
    status: 'stamped',
    locked_at: new Date().toISOString(),
  }).eq('id', prod.id);

  log(`  stamped ${included.length} docs / ${seq - startSeq} pages ` +
    `(${formatBates(prod.bates_prefix, prod.bates_pad, startSeq)}–${formatBates(prod.bates_prefix, prod.bates_pad, seq - 1)}); ` +
    `${excluded.length} withheld`);
}

// Split production items into produced vs withheld, and collect endorsement
// text per item. behavior 'privileged' and 'non_responsive' exclude.
async function partitionItems(prod) {
  const { data: items, error: itemsErr } = await supabase.from('production_items')
    .select('*').eq('production_id', prod.id).eq('status', 'ready')
    .order('sort_order');
  if (itemsErr) throw new Error(itemsErr.message);

  const { data: tags, error: tagsErr } = await supabase.from('document_tags')
    .select('production_item_id, document_tag_defs(name, behavior, is_endorsement, endorsement_text)')
    .eq('matterspace_id', prod.matterspace_id)
    .in('production_item_id', items.map((i) => i.id));
  if (tagsErr) throw new Error(tagsErr.message);

  const excludedIds = new Set();
  const endorsementsByItem = new Map();
  const confidentialIds = new Set();
  for (const t of tags ?? []) {
    const def = t.document_tag_defs;
    if (!def) continue;
    if (def.behavior === 'privileged' || def.behavior === 'non_responsive') {
      excludedIds.add(t.production_item_id);
    }
    if (def.is_endorsement && def.endorsement_text) {
      const list = endorsementsByItem.get(t.production_item_id) ?? [];
      list.push(def.endorsement_text);
      endorsementsByItem.set(t.production_item_id, list);
      if (/confidential/i.test(def.endorsement_text)) confidentialIds.add(t.production_item_id);
    }
  }

  return {
    included: items.filter((i) => !excludedIds.has(i.id)),
    excluded: items.filter((i) => excludedIds.has(i.id)),
    endorsementsByItem,
    confidentialIds,
  };
}

async function registryHighWaterMark(matterspaceId) {
  const { data } = await supabase.from('bates_registry')
    .select('bates_seq')
    .eq('matterspace_id', matterspaceId)
    .order('bates_seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.bates_seq ?? 0;
}

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------
async function packageProduction(job) {
  const prod = await getProduction(job.production_id);
  if (prod.status !== 'stamped' && prod.status !== 'packaged') {
    throw new Error(`package_production: production must be stamped first (status: ${prod.status})`);
  }

  const { included, endorsementsByItem, confidentialIds } = await partitionItems(prod);
  const produced = included.filter((i) => i.bates_first);
  if (produced.length === 0) throw new Error('Nothing stamped to package');

  const matterName = await matterNameOf(prod.matterspace_id);
  const volumeName = sanitizeStorageName(prod.name.replace(/\s+/g, '_')) || 'PRODUCTION';

  const archiver = (await import('archiver')).default;
  const tmpZip = path.join(os.tmpdir(), `disc-pkg-${crypto.randomUUID()}.zip`);
  const out = createWriteStream(tmpZip);
  const archive = archiver('zip', { zlib: { level: 6 } });
  const archiveDone = new Promise((resolve, reject) => {
    out.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(out);

  const datRows = [];
  let totalPages = 0;
  for (const [i, item] of produced.entries()) {
    await progress(job, (i / produced.length) * 80, `Packaging ${item.bates_first}`);
    const base = `${prod.matterspace_id}/${prod.id}/${item.id}`;
    const stamped = await downloadFromStorage(`${base}/stamped.pdf`);
    const imagePath = `IMAGES/${item.bates_first}.pdf`;
    archive.append(stamped, { name: `${volumeName}/${imagePath}` });

    let nativeLink = '';
    if (item.kind === 'native') {
      const ext = extOf(item.original_filename);
      const nativeBuf = await downloadFromStorage(item.native_storage_path);
      nativeLink = `NATIVES/${item.bates_first}${ext}`;
      archive.append(nativeBuf, { name: `${volumeName}/${nativeLink}` });
    }

    const m = item.source_metadata ?? {};
    const pages = item.kind === 'native' ? 1 : (item.page_count ?? 1);
    totalPages += pages;
    datRows.push({
      bates_first: item.bates_first,
      bates_last: item.bates_last,
      pages,
      custodian: m.custodian ?? '',
      author: m.author ?? '',
      to: m.to ?? '',
      cc: m.cc ?? '',
      subject: m.subject ?? '',
      date: m.date ?? '',
      filename: item.original_filename,
      native_link: nativeLink,
      confidentiality: confidentialIds.has(item.id) ? 'CONFIDENTIAL' : '',
      image_path: imagePath,
    });
  }

  await progress(job, 85, 'Writing load files and cover documents…');
  archive.append(emitDat(datRows), { name: `${volumeName}/DATA/loadfile.dat` });
  archive.append(emitOpt(datRows, volumeName), { name: `${volumeName}/DATA/loadfile.opt` });

  if (job.payload?.include_privilege_log) {
    const { data: entries } = await supabase.from('privilege_log_entries')
      .select('*').eq('production_id', prod.id).order('doc_date', { ascending: true, nullsFirst: false });
    if (entries?.length) {
      const privLog = await makePrivilegeLogPdf({ matterName, productionName: prod.name, entries });
      archive.append(privLog, { name: `${volumeName}/PrivilegeLog.pdf` });
    }
  }

  const letter = await makeProductionLetter({
    productionName: prod.name,
    matterName,
    receivingParty: prod.receiving_party,
    batesFirst: formatBates(prod.bates_prefix, prod.bates_pad, prod.bates_start),
    batesLast: formatBates(prod.bates_prefix, prod.bates_pad, prod.bates_end),
    docCount: produced.length,
    pageCount: totalPages,
    nativeCount: produced.filter((i) => i.kind === 'native').length,
    confidentialCount: confidentialIds.size,
    requestRefs: prod.request_refs,
    dateStr: new Date().toISOString().slice(0, 10),
  });
  archive.append(letter, { name: `${volumeName}/ProductionLetter.pdf` });

  await archive.finalize();
  await archiveDone;

  await progress(job, 92, 'Hashing and uploading package…');
  const pkgSha = await sha256File(tmpZip);
  const pkgStoragePath = `${prod.matterspace_id}/${prod.id}/package/${volumeName}.zip`;
  const zipBuf = await fs.readFile(tmpZip);
  await uploadToStorage(pkgStoragePath, zipBuf, 'application/zip');
  await fs.unlink(tmpZip).catch(() => {});

  await supabase.from('productions').update({
    package_storage_path: pkgStoragePath,
    package_sha256: pkgSha,
    status: 'packaged',
  }).eq('id', prod.id);

  log(`  packaged ${produced.length} docs -> ${pkgStoragePath} (sha256 ${pkgSha.slice(0, 12)}…)`);
}

// ---------------------------------------------------------------------------
// Direct local-disk intake (CLI mode for very large productions)
// ---------------------------------------------------------------------------
async function directFolderIntake(folder, productionId) {
  if (!productionId) die('--intake requires --production <production uuid>');
  const root = path.resolve(folder);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) die(`Not a folder: ${root}`);

  const prod = await getProduction(productionId);
  const { data: job, error } = await supabase.from('processing_jobs').insert({
    matterspace_id: prod.matterspace_id,
    production_id: prod.id,
    job_type: 'intake_folder',
    payload: { local_path: root, ingest: true },
    status: 'running',
    claimed_by: WORKER_ID,
    claimed_at: new Date().toISOString(),
  }).select().single();
  if (error) die(`create job: ${error.message}`);

  log(`Direct intake of ${root} into production "${prod.name}"`);
  try {
    await intakeFolder(job);
    await supabase.from('processing_jobs')
      .update({ status: 'done', progress: 100, finished_at: new Date().toISOString() })
      .eq('id', job.id);
    log('Done.');
  } catch (err) {
    await supabase.from('processing_jobs')
      .update({ status: 'error', error: String(err.message ?? err), finished_at: new Date().toISOString() })
      .eq('id', job.id);
    die(err.message);
  }
}

// ---------------------------------------------------------------------------
// Storage + misc helpers
// ---------------------------------------------------------------------------
async function getProduction(id) {
  if (!id) throw new Error('job has no production_id');
  const { data, error } = await supabase.from('productions').select('*').eq('id', id).single();
  if (error) throw new Error(`production ${id}: ${error.message}`);
  return data;
}

async function setProductionStatus(id, status) {
  await supabase.from('productions').update({ status }).eq('id', id);
}

async function matterNameOf(matterspaceId) {
  const { data } = await supabase.from('matterspaces').select('name').eq('id', matterspaceId).single();
  return data?.name ?? '';
}

async function downloadFromStorage(storagePath, attempts = 3) {
  for (let i = 1; ; i++) {
    const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
    if (!error) return Buffer.from(await data.arrayBuffer());
    if (i >= attempts) throw new Error(`storage download ${storagePath}: ${error.message}`);
    await sleep(1000 * i);
  }
}

async function uploadToStorage(storagePath, buf, contentType, attempts = 3) {
  for (let i = 1; ; i++) {
    const { error } = await supabase.storage.from(BUCKET)
      .upload(storagePath, buf, { contentType, upsert: true });
    if (!error) return;
    if (i >= attempts) throw new Error(`storage upload ${storagePath}: ${error.message}`);
    await sleep(1000 * i);
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    createReadStream(filePath)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) die(`Missing env: ${name}`);
  return v;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(msg) { process.stdout.write(`${msg}\n`); }
function die(msg) { process.stderr.write(`discovery-worker: ${msg}\n`); process.exit(1); }

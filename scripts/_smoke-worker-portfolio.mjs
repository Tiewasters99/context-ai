// Smoke-test the DEPLOYED worker (not local code) on the two 2026-09-03 fixes:
//   1. a synthetic PDF portfolio (cover + two attached PDFs) must be unpacked
//      into a folder with two indexed children;
//   2. a corrupt PDF must leave the document 'pending' with an
//      "Attempt 1 of 3 failed — …" note (not silently 'extracting').
// Runs against prod with the service role inside one scratch matter and
// deletes everything it made. Usage:
//   node scripts/_smoke-worker-portfolio.mjs <scratch matter short_code|uuid>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const CREATED_BY = process.env.SMOKE_CREATED_BY || null;

const matterArg = process.argv[2];
if (!matterArg) { console.error('usage: <scratch matter short_code|uuid>'); process.exit(2); }
const isUuid = /^[0-9a-f-]{36}$/i.test(matterArg);
const { data: matter, error: mErr } = await supabase.from('matterspaces')
  .select('id, name, short_code').eq(isUuid ? 'id' : 'short_code', matterArg).single();
if (mErr) throw new Error(`matter: ${mErr.message}`);
console.log(`scratch matter: ${matter.name} (${matter.short_code}, ${matter.id})`);

// Children are saved WITHOUT object streams: pdf-parse 1.1.1 (the pipeline's
// text extractor, bundling a 2017 pdf.js) reports "Invalid PDF structure" on
// pdf-lib's default output, so an object-stream child would fail for a reason
// unrelated to the unpack. The cover keeps pdf-lib's default (object streams)
// on purpose — that is the case the marker fast path cannot see.
async function textPdf(lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  let y = 720;
  for (const l of lines) { page.drawText(l, { x: 72, y, size: 12, font }); y -= 18; }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function fileAndQueue({ title, filename, bytes }) {
  const { data: row, error } = await supabase.from('documents').insert({
    matterspace_id: matter.id, title, doc_type: 'other', source_filename: filename,
    file_size_bytes: bytes.length, processing_status: 'pending', created_by: CREATED_BY,
  }).select('id').single();
  if (error) throw new Error(`insert ${title}: ${error.message}`);
  const storagePath = `${matter.id}/${row.id}/${filename}`;
  const { error: upErr } = await supabase.storage.from('vault-documents')
    .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: true });
  if (upErr) throw new Error(`upload ${title}: ${upErr.message}`);
  await supabase.from('documents').update({ storage_path: storagePath }).eq('id', row.id);
  const { error: qErr } = await supabase.from('processing_jobs').insert({
    matterspace_id: matter.id, job_type: 'ingest_document', payload: { document_id: row.id },
  });
  if (qErr) throw new Error(`enqueue ${title}: ${qErr.message}`);
  return { id: row.id, storagePath };
}

async function waitFor(id, pred, ms = 8 * 60_000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < ms) {
    const { data } = await supabase.from('documents')
      .select('id, processing_status, processing_error, page_count, matterspace_id, metadata').eq('id', id).maybeSingle();
    const line = data ? `${data.processing_status} ${data.processing_error ? '| ' + data.processing_error.slice(0, 110) : ''}` : 'gone';
    if (line !== last) { console.log(`  ${new Date().toISOString().slice(11, 19)} ${line}`); last = line; }
    if (data && pred(data)) return data;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`timeout waiting on ${id}`);
}

const made = { docs: [], folders: [] };
let failures = 0;
try {
  // ---- 1. Portfolio ---------------------------------------------------------
  const tag = crypto.randomUUID().slice(0, 8);
  const alpha = await textPdf(['ALPHA EXHIBIT', `Smoke test ${tag}: the alpha attachment says quartz.`]);
  const beta = await textPdf(['BETA EXHIBIT', `Smoke test ${tag}: the beta attachment says feldspar.`]);
  const cover = await PDFDocument.create();
  const font = await cover.embedFont(StandardFonts.Helvetica);
  cover.addPage([612, 792]).drawText('This document contains a collection of PDFs (smoke test)', { x: 72, y: 720, size: 12, font });
  await cover.attach(alpha, 'Alpha Exhibit.pdf', { mimeType: 'application/pdf', description: 'Alpha Exhibit' });
  await cover.attach(beta, 'Beta Exhibit.pdf', { mimeType: 'application/pdf', description: 'Beta Exhibit' });
  const wrapperBytes = Buffer.from(await cover.save());
  const wrapperTitle = `Portfolio smoke ${tag}`;
  console.log(`\n[1] portfolio wrapper ${(wrapperBytes.length / 1024).toFixed(1)} KB → queue`);
  const w = await fileAndQueue({ title: wrapperTitle, filename: `portfolio-smoke-${tag}.pdf`, bytes: wrapperBytes });
  made.docs.push(w.id);
  const wDone = await waitFor(w.id, (d) => d.processing_status === 'ready' || d.processing_status === 'error');
  const pf = wDone.metadata?.portfolio;
  if (wDone.processing_status !== 'ready' || !pf) { failures++; console.log('  FAIL wrapper not unpacked', JSON.stringify(wDone).slice(0, 300)); }
  else {
    console.log(`  wrapper ready; folder "${pf.folder_name}" (${pf.folder_id}); children ${pf.children.length}; moved into folder: ${wDone.matterspace_id === pf.folder_id}`);
    if (pf.folder_id) made.folders.push(pf.folder_id);
    for (const c of pf.children) {
      made.docs.push(c.id);
      const cd = await waitFor(c.id, (d) => d.processing_status === 'ready' || d.processing_status === 'error');
      const { count } = await supabase.from('passages').select('id', { count: 'exact', head: true }).eq('document_id', c.id);
      const { data: hit } = await supabase.from('passages').select('text').eq('document_id', c.id).limit(1);
      const ok = cd.processing_status === 'ready' && (count || 0) > 0;
      if (!ok) failures++;
      console.log(`  ${ok ? 'ok ' : 'FAIL'} child "${c.title}": ${cd.processing_status}, ${count} passage(s) — ${(hit?.[0]?.text || '').slice(0, 60)}`);
    }
    if (wDone.matterspace_id !== pf.folder_id) { failures++; console.log('  FAIL wrapper was not moved into the folder'); }
  }

  // ---- 2. Corrupt PDF → visible first-attempt failure -----------------------
  const junk = Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(4096)]);
  console.log(`\n[2] corrupt pdf → queue`);
  const c = await fileAndQueue({ title: `Corrupt smoke ${tag}`, filename: `corrupt-smoke-${tag}.pdf`, bytes: junk });
  made.docs.push(c.id);
  const cDone = await waitFor(c.id, (d) => !!d.processing_error || d.processing_status === 'error' || d.processing_status === 'ready');
  const okNote = cDone.processing_status === 'pending' && /^Attempt 1 of 3 failed — /.test(cDone.processing_error || '');
  if (!okNote) failures++;
  console.log(`  ${okNote ? 'ok ' : 'FAIL'} status=${cDone.processing_status} note="${(cDone.processing_error || '').slice(0, 160)}"`);
} finally {
  // ---- cleanup ---------------------------------------------------------------
  console.log('\ncleanup');
  const { data: rows } = await supabase.from('documents').select('id, storage_path').in('id', made.docs);
  const paths = (rows || []).map((r) => r.storage_path).filter(Boolean);
  if (paths.length) await supabase.storage.from('vault-documents').remove(paths);
  if (made.docs.length) await supabase.from('documents').delete().in('id', made.docs);
  for (const f of made.folders) {
    const { count } = await supabase.from('documents').select('id', { count: 'exact', head: true }).eq('matterspace_id', f);
    if (count === 0) await supabase.from('matterspaces').delete().eq('id', f);
    else console.log(`  folder ${f} kept (${count} docs)`);
  }
  console.log(`  removed ${made.docs.length} doc(s), ${made.folders.length} folder(s)`);
}
console.log(failures ? `\n${failures} FAILED` : '\nPASS');
process.exit(failures ? 1 : 0);

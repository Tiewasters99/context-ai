// Ingestion Phase 6 — the data-repair steps that are a query and an update,
// not a judgement (plan: ingestion "100% ready", 2026-09-04; this session
// 2026-09-07). Each step is idempotent and reports before it writes.
//
//   node scripts/_p6-repair.mjs status                      what is left, by class
//   node scripts/_p6-repair.mjs ready-empty    [--dry-run]  PDFs filed 'ready' with no passages and no recorded reason (assembled
//                                                          exhibits before 2026-09-07) → re-run on the worker
//   node scripts/_p6-repair.mjs binary-assets  [--dry-run]  3D assets that hold vertex-text passages → re-run on the worker (→ binary_stored)
//   node scripts/_p6-repair.mjs relabel        [--dry-run]  unclassified error rows whose cause is plain from the row (no bytes; a
//                                                          "~$" lock file) → the wording triage classifies
//   node scripts/_p6-repair.mjs web-captures   [--dry-run]  saved court web pages indexed as HTML → error with the reason, passages dropped
//   node scripts/_p6-repair.mjs delete --ids a,b [--dry-run] remove rows (and their bytes) Eden has ruled junk
//
// Re-runs go through processing_jobs so the DEPLOYED worker does the work;
// the row is set back to 'pending' first because the worker skips a fully
// indexed 'ready' row. Deletion is the only destructive step and takes ids
// explicitly — it is for zero-byte exports, lock files and downloaded junk,
// never for a client document without Eden's word.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { JOB_PRIORITY, BINARY_ASSET_EXTENSIONS, htmlToText, looksLikeCourtWebPage } from '../lib/ingest-core.mjs';
import { isOfficeLockFile } from '../lib/ingest-formats.mjs';
import { classifyError } from '../lib/ingest-triage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(`${ROOT}/.env`, 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const step = process.argv[2] || 'status';
const DRY = process.argv.includes('--dry-run');
const idsArg = process.argv[process.argv.indexOf('--ids') + 1];
const IDS = process.argv.includes('--ids') && idsArg ? idsArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
const EMPTY_WORDING = 'The upload did not finish, so there is no file to process. Please upload it again from the original.';

const { data: matters } = await sb.from('matterspaces').select('id, short_code');
const code = Object.fromEntries((matters || []).map((m) => [m.id, m.short_code]));
const passageCount = async (id) => (await sb.from('passages').select('id', { count: 'exact', head: true }).eq('document_id', id)).count || 0;
const say = (s) => console.log(s);
if (DRY) say('DRY RUN — nothing is written');

async function openJobIds() {
  const { data } = await sb.from('processing_jobs').select('payload').eq('job_type', 'ingest_document').in('status', ['queued', 'running']);
  return new Set((data || []).map((j) => j.payload?.document_id));
}
async function requeue(rows, priority, reason) {
  const open = await openJobIds();
  let n = 0;
  for (const d of rows) {
    if (open.has(d.id)) { say(`   already queued: ${d.source_filename}`); continue; }
    if (DRY) { n++; continue; }
    await sb.from('documents').update({ processing_status: 'pending', processing_error: null }).eq('id', d.id);
    const { error } = await sb.from('processing_jobs').insert({ matterspace_id: d.matterspace_id, job_type: 'ingest_document', payload: { document_id: d.id, reason }, priority });
    if (error) say(`   enqueue ERR ${d.source_filename}: ${error.message}`); else n++;
  }
  say(`${DRY ? 'would queue' : 'queued'} ${n} at priority ${priority}`);
}

if (step === 'status') {
  const { data: errs } = await sb.from('documents').select('id, matterspace_id, source_filename, processing_error, file_size_bytes, storage_path').eq('processing_status', 'error');
  const groups = {};
  for (const d of errs || []) (groups[(d.processing_error || '').slice(0, 40)] ||= []).push(d);
  say(`error rows: ${(errs || []).length}`);
  for (const [k, rows] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
    say(`  [${String(rows.length).padStart(3)}] ${k}`);
    if (rows.length <= 12) for (const d of rows) say(`        ${d.id} ${code[d.matterspace_id]} ${d.file_size_bytes} B ${d.source_filename}`);
  }
  const { data: asm } = await sb.from('documents').select('id, source_filename, metadata').eq('processing_status', 'ready').ilike('source_filename', '%(assembled).pdf');
  let emptyAsm = 0; for (const d of asm || []) if (!d.metadata?.text_status && (await passageCount(d.id)) === 0) emptyAsm++;
  say(`assembled exhibits ready with no passages and no reason: ${emptyAsm}`);
}

if (step === 'ready-empty') {
  // The monitor's "marked ready but not searchable" class, for PDFs: rows the
  // MCP's assemble_documents filed store-and-display before 2026-09-07, and
  // anything else that claimed success with nothing to search. Found through
  // the monitor's own RPC so the list is the digest's list.
  const rbe = [];
  for (let from = 0; ; from += 1000) { // PostgREST caps a page at 1,000 rows; walk like the monitor does
    const { data, error } = await sb.rpc('ready_but_empty').order('document_id').range(from, from + 999);
    if (error) { say(`ready_but_empty: ${error.message}`); process.exit(2); }
    rbe.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const rows = [];
  for (const r of rbe) {
    if (!/\.pdf$/i.test(r.source_filename || '')) continue;
    const { data: d } = await sb.from('documents').select('id, matterspace_id, source_filename, metadata, storage_path').eq('id', r.document_id).single();
    if (d && !d.metadata?.text_status && d.storage_path) rows.push(d);
  }
  say(`PDFs ready with no passages and no recorded reason: ${rows.length}`);
  for (const d of rows) say(`   ${d.id} ${code[d.matterspace_id]} ${d.source_filename}`);
  await requeue(rows, JOB_PRIORITY.NORMAL, 'p6-ready-empty-reingest');
}

if (step === 'binary-assets') {
  const { data: bins } = await sb.from('documents').select('id, matterspace_id, source_filename, storage_path')
    .or(BINARY_ASSET_EXTENSIONS.map((e) => `source_filename.ilike.%${e}`).join(','));
  const rows = [];
  for (const d of bins || []) if (d.storage_path && (await passageCount(d.id)) > 0) rows.push(d);
  say(`3D assets holding passages: ${rows.length} of ${(bins || []).length}`);
  for (const d of rows.slice(0, 10)) say(`   ${d.id} ${code[d.matterspace_id]} ${d.source_filename}`);
  if (rows.length > 10) say(`   … and ${rows.length - 10} more`);
  await requeue(rows, JOB_PRIORITY.BULK, 'p6-binary-asset-repair');
}

if (step === 'relabel') {
  // Only rows triage cannot place. A row already in a class — even a benign
  // one — keeps its wording; relabelling a benign row would escalate it.
  const { data: errs } = await sb.from('documents').select('id, matterspace_id, source_filename, processing_error, file_size_bytes, storage_path').eq('processing_status', 'error');
  const rows = [];
  for (const d of errs || []) {
    if (classifyError(d.processing_error) !== 'other') continue;
    const base = String(d.source_filename || '').split(/[\\/]/).pop() || '';
    if (isOfficeLockFile(base)) {
      rows.push({ ...d, why: 'Office lock file', wording: `"${base}" is a temporary Office lock file, not a document — Word writes it beside an open file and it holds no content. Delete it and upload the real document.` });
    } else if (!d.storage_path || Number(d.file_size_bytes) === 0) {
      rows.push({ ...d, why: d.storage_path ? 'file_size_bytes = 0' : 'no storage_path', wording: EMPTY_WORDING });
    }
  }
  say(`unclassified error rows whose cause is plain from the row: ${rows.length}`);
  for (const d of rows) {
    say(`   ${d.id} ${code[d.matterspace_id]} (${d.why}) ${d.source_filename} — was: ${(d.processing_error || '').slice(0, 50)}`);
    if (!DRY) await sb.from('documents').update({ processing_error: d.wording }).eq('id', d.id);
  }
}

if (step === 'web-captures') {
  // Candidates: passages carrying the CM/ECF screen's own words (found
  // through the full-text index, which drops tags — so the HTML markup itself
  // is not searchable, but "PACER Service Center … Logout" is). Each document
  // is read back in full and tested with the pipeline's guard.
  const { data: firsts, error: fErr } = await sb.from('passages').select('document_id').textSearch('tsv', "'pacer' & 'logout'", { config: 'english' }).limit(1000);
  if (fErr) { say(`passage search: ${fErr.message}`); process.exit(2); }
  const ids = [...new Set((firsts || []).map((p) => p.document_id))];
  say(`documents holding HTML: ${ids.length}`);
  const rows = [];
  for (const id of ids) {
    const { data: ps } = await sb.from('passages').select('text').eq('document_id', id).order('sequence_number');
    const html = (ps || []).map((p) => p.text).join('\n');
    const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
    if (!looksLikeCourtWebPage(htmlToText(html), title)) continue;
    const { data: d } = await sb.from('documents').select('id, matterspace_id, source_filename, title, processing_status').eq('id', id).single();
    rows.push({ ...d, pageTitle: title });
  }
  say(`saved court web pages indexed as documents: ${rows.length}`);
  for (const d of rows) {
    say(`   ${d.id} ${code[d.matterspace_id]} "${d.title}" (${d.source_filename}) — page title "${d.pageTitle}"`);
    if (DRY) continue;
    const reason = `This is a court website page ("${d.pageTitle}"), not the filing — CM/ECF saves its search and login screens as HTML when the document itself needs a PACER login. Download the filing from PACER as a PDF and upload that.`;
    await sb.from('passages').delete().eq('document_id', d.id);
    await sb.from('documents').update({ processing_status: 'error', processing_error: reason }).eq('id', d.id);
  }
}

if (step === 'delete') {
  if (!IDS.length) { say('delete needs --ids a,b,c'); process.exit(1); }
  const { data: rows } = await sb.from('documents').select('id, matterspace_id, source_filename, storage_path, file_size_bytes, processing_status').in('id', IDS);
  for (const d of rows || []) {
    const n = await passageCount(d.id);
    say(`   ${DRY ? 'would delete' : 'deleting'} ${d.id} ${code[d.matterspace_id]} ${d.processing_status} ${d.file_size_bytes} B, ${n} passage(s), ${d.storage_path ? 'bytes in storage' : 'no bytes'}: ${d.source_filename}`);
    if (DRY) continue;
    if (d.storage_path) { const { error } = await sb.storage.from('vault-documents').remove([d.storage_path]); if (error) say(`      storage: ${error.message}`); }
    await sb.from('passages').delete().eq('document_id', d.id);
    const { error } = await sb.from('documents').delete().eq('id', d.id);
    say(error ? `      row: ERR ${error.message}` : '      row removed');
  }
  const missing = IDS.filter((id) => !(rows || []).some((r) => r.id === id));
  if (missing.length) say(`   not found: ${missing.join(', ')}`);
}

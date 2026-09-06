// Re-run stored containers through the DEPLOYED worker (Phase 3 data step):
//   node rerun-containers.mjs pilot            one small DeCamara zip (files.zip)
//   node rerun-containers.mjs zips             every DeCamara .zip not yet unpacked
//   node rerun-containers.mjs emails           the Atkinson .eml files
//   node rerun-containers.mjs watch <ids...>   just watch the given document ids
// Each target is set back to 'pending' and one ingest_document job is queued
// at BULK priority (below any interactive upload). Then the queue is watched
// until every target and every child it filed is terminal.
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(`${ROOT}/.env`, 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { JOB_PRIORITY } = await import('../lib/ingest-core.mjs');

const mode = process.argv[2] || 'pilot';
const DECAMARA = 'decamara-v-bryn-mawr';
const ATKINSON = 'atkinson';

async function matterId(code) {
  const { data, error } = await sb.from('matterspaces').select('id, name').eq('short_code', code).single();
  if (error) throw new Error(`matter ${code}: ${error.message}`);
  return data;
}

async function targets() {
  if (mode === 'watch') return process.argv.slice(3).map((id) => ({ id }));
  if (mode === 'emails') {
    const m = await matterId(ATKINSON);
    const { data } = await sb.from('documents').select('id, source_filename, file_size_bytes, processing_status, email_attachments:metadata->email_attachments')
      .eq('matterspace_id', m.id).ilike('source_filename', '%.eml').order('source_filename');
    return (data || []).filter((d) => !d.email_attachments);
  }
  const m = await matterId(DECAMARA);
  const { data } = await sb.from('documents').select('id, source_filename, file_size_bytes, processing_status, archive:metadata->archive')
    .eq('matterspace_id', m.id).ilike('source_filename', '%.zip').order('file_size_bytes');
  let rows = (data || []).filter((d) => !d.archive);
  if (mode === 'pilot') rows = rows.filter((d) => d.source_filename === 'files.zip');
  return rows;
}

async function enqueue(d) {
  const { data: inflight } = await sb.from('processing_jobs').select('id').eq('job_type', 'ingest_document')
    .in('status', ['queued', 'running']).contains('payload', { document_id: d.id }).limit(1);
  if (inflight?.length) { console.log(`  already queued: ${d.source_filename}`); return; }
  const { data: row } = await sb.from('documents').select('matterspace_id').eq('id', d.id).single();
  const { error: qErr } = await sb.from('processing_jobs').insert({
    matterspace_id: row.matterspace_id, job_type: 'ingest_document', payload: { document_id: d.id, rerun: 'phase3-containers' }, priority: JOB_PRIORITY.BULK,
  });
  if (qErr) { console.log(`  enqueue FAILED ${d.source_filename}: ${qErr.message}`); return; }
  await sb.from('documents').update({ processing_status: 'pending', processing_error: null }).eq('id', d.id);
  console.log(`  queued: ${d.source_filename} (${Math.round((d.file_size_bytes || 0) / 1024)} KB)`);
}

async function snapshot(ids) {
  const { data: parents } = await sb.from('documents').select('id, source_filename, processing_status, processing_error, matterspace_id, archive:metadata->archive, email_attachments:metadata->email_attachments').in('id', ids);
  const childIds = [];
  for (const p of parents || []) for (const c of (p.archive?.children || p.email_attachments?.children || [])) childIds.push(c.id);
  let children = [];
  if (childIds.length) {
    for (let i = 0; i < childIds.length; i += 200) {
      const { data } = await sb.from('documents').select('id, source_filename, processing_status, processing_error, text_status:metadata->>text_status').in('id', childIds.slice(i, i + 200));
      children.push(...(data || []));
    }
  }
  const { data: jobs } = await sb.from('processing_jobs').select('id, status').eq('job_type', 'ingest_document').in('status', ['queued', 'running']);
  return { parents: parents || [], children, openJobs: (jobs || []).length };
}

const count = (rows, key = 'processing_status') => {
  const by = {}; for (const r of rows) { const k = r[key] || '-'; by[k] = (by[k] || 0) + 1; } return by;
};

const rows = await targets();
console.log(`${mode}: ${rows.length} target(s)`);
if (mode !== 'watch') for (const d of rows) await enqueue(d);
const ids = rows.map((d) => d.id);
if (!ids.length) process.exit(0);

const t0 = Date.now();
const LIMIT = Number(process.env.WATCH_MINUTES || 90) * 60_000;
let last = '';
for (;;) {
  const s = await snapshot(ids);
  const terminalParents = s.parents.filter((p) => ['ready', 'error'].includes(p.processing_status)).length;
  const terminalChildren = s.children.filter((c) => ['ready', 'error'].includes(c.processing_status)).length;
  const line = `parents ${JSON.stringify(count(s.parents))} | children ${s.children.length} ${JSON.stringify(count(s.children))} | open jobs ${s.openJobs}`;
  if (line !== last) { console.log(`  ${new Date().toISOString().slice(11, 19)} ${line}`); last = line; }
  const done = terminalParents === s.parents.length && terminalChildren === s.children.length && s.openJobs === 0;
  if (done || Date.now() - t0 > LIMIT) {
    console.log(done ? '\nall terminal' : '\nwatch limit reached');
    for (const p of s.parents) {
      const sum = p.archive || p.email_attachments;
      console.log(`  ${p.processing_status.padEnd(7)} ${p.source_filename}${p.processing_error ? ' | ' + p.processing_error.slice(0, 90) : ''}` +
        (sum ? ` → ${sum.children?.length ?? 0} child(ren)${sum.folder_name ? ` in "${sum.folder_name}"` : ''}${sum.skipped?.length ? `, ${sum.skipped.length} skipped` : ''}${sum.notes?.length ? ` | notes: ${sum.notes.join('; ').slice(0, 120)}` : ''}` : ''));
    }
    const childBy = count(s.children, 'text_status');
    console.log(`  children by status ${JSON.stringify(count(s.children))}; by text_status ${JSON.stringify(childBy)}`);
    for (const c of s.children.filter((c) => c.processing_status === 'error')) console.log(`    ERROR child ${c.source_filename}: ${(c.processing_error || '').slice(0, 120)}`);
    process.exit(done ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}

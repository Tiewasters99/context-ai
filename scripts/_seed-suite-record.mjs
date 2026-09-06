// Seed the nightly suite's 200 MB record into storage — ONCE.
//
// The suite (scripts/ingest-suite.mjs) does not upload the big record every
// night: the machine that runs it may sit on a slow uplink (2026-09-06: about
// 50 KB/s, so 200 MB would take an hour and the run was killed twice), and
// upload bandwidth is not what the suite measures. Instead this script
// builds the record (scripts/_fixtures-suite.mjs → logs/fixtures/, cached),
// uploads it resumably to a fixed object outside any matter's path, and the
// suite copies that object server-side into the night's document in a
// second. The browser's resumable path itself is proved by
// scripts/_smoke-resumable-upload.mjs.
//
//   node scripts/_seed-suite-record.mjs            # idempotent: exits 0 at once if the object is already there
//   node scripts/_seed-suite-record.mjs --force    # re-upload
//
// The upload resumes across interruptions: the TUS bookmark lives in
// logs/fixtures/resume.json, so a killed run picks up where it stopped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { uploadResumable, TUS_URL_TTL_MS } from '../lib/tus-upload.mjs';
import { bigRecordPdfFile } from './_fixtures-suite.mjs';

export const SUITE_BUCKET = 'vault-documents';
export const SUITE_RECORD_OBJECT = '_fixtures/suite-record-400p.pdf';
export const SUITE_RECORD_PAGES = 400;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const force = process.argv.includes('--force');

/** { size } when the seeded object exists, else null. */
export async function seededRecord(sb = supabase) {
  const dir = path.posix.dirname(SUITE_RECORD_OBJECT);
  const name = path.posix.basename(SUITE_RECORD_OBJECT);
  const { data, error } = await sb.storage.from(SUITE_BUCKET).list(dir, { search: name });
  if (error) return null;
  const hit = (data || []).find((o) => o.name === name);
  return hit ? { size: Number(hit.metadata?.size) || 0 } : null;
}

// A resume store over a JSON file, same contract as the browser's
// storageResumeStore: get / set / delete, never throws.
function fileResumeStore(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const write = (o) => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(o)); } catch { /* best effort */ } };
  return {
    get(k) { const rec = read()[k]; if (!rec?.url || !rec?.at || Date.now() - rec.at > TUS_URL_TTL_MS) return null; return rec; },
    set(k, v) { const o = read(); o[k] = v; write(o); },
    delete(k) { const o = read(); delete o[k]; write(o); },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const existing = await seededRecord();
  if (existing && !force) {
    console.log(`already seeded: ${SUITE_BUCKET}/${SUITE_RECORD_OBJECT} (${(existing.size / 1048576).toFixed(0)} MB). Use --force to re-upload.`);
    process.exit(0);
  }
  const local = path.join(ROOT, 'logs', 'fixtures', `suite-record-${SUITE_RECORD_PAGES}p.pdf`);
  const rec = await bigRecordPdfFile(local, { pages: SUITE_RECORD_PAGES });
  console.log(`record: ${(rec.size / 1048576).toFixed(0)} MB ${rec.cached ? '(cached)' : '(built)'} → uploading resumably to ${SUITE_BUCKET}/${SUITE_RECORD_OBJECT}`);
  const t0 = Date.now();
  let lastPct = -5;
  const res = await uploadResumable({
    supabaseUrl: env.VITE_SUPABASE_URL, token: env.SUPABASE_SERVICE_ROLE_KEY, apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: SUITE_BUCKET, objectName: SUITE_RECORD_OBJECT, blob: await fs.openAsBlob(local), contentType: 'application/pdf',
    resumeStore: fileResumeStore(path.join(ROOT, 'logs', 'fixtures', 'resume.json')),
    onProgress: (p) => {
      if (p.pct >= lastPct + 5) {
        lastPct = p.pct;
        const secs = (Date.now() - t0) / 1000;
        console.log(`  ${new Date().toISOString().slice(11, 19)} ${String(p.pct).padStart(3)}%  ${(p.sent / 1048576).toFixed(0)} MB  ${secs > 1 ? ((p.sent / 1024) / secs).toFixed(0) : '?'} KB/s`);
      }
    },
  });
  const secs = (Date.now() - t0) / 1000;
  console.log(`seeded in ${(secs / 60).toFixed(1)} min${res?.resumedFrom ? ` (resumed from ${(res.resumedFrom / 1048576).toFixed(0)} MB)` : ''}`);
  const check = await seededRecord();
  console.log(check ? `verified: ${(check.size / 1048576).toFixed(0)} MB in storage` : 'WARNING: object not listed after upload');
  process.exit(check ? 0 : 1);
}

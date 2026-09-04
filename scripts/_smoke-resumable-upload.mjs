// Resumable uploads against the REAL vault-documents bucket (Phase 4 of the
// ingestion plan, 2026-09-04). The browser's upload path (lib/tus-upload.mjs,
// used by src/lib/vault-persist.ts for files of 50 MB and up) is exercised
// here from Node with the service role, interruption included:
//
//   1. a 13 MB random blob in three chunks (6 + 6 + 1 MB) — the connection is
//      cut once mid-upload; the client asks the server where it got to and
//      continues; the stored object is byte-identical (sha256);
//   2. the same upload aborted after the first chunk (a closed tab), then
//      started again with the same bookmark — it resumes at 6 MB, creates no
//      second upload, and finishes.
//
//   node scripts/_smoke-resumable-upload.mjs <scratch matter short_code|uuid>
//
// Everything it stores is removed at the end.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { uploadResumable, memoryResumeStore, TUS_CHUNK_BYTES } from '../lib/tus-upload.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const matterArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!matterArg) { console.error('usage: <scratch matter short_code|uuid>'); process.exit(2); }
const isUuid = /^[0-9a-f-]{36}$/i.test(matterArg);
const { data: matter, error: mErr } = await supabase.from('matterspaces').select('id, name, short_code').eq(isUuid ? 'id' : 'short_code', matterArg).single();
if (mErr) throw new Error(`matter: ${mErr.message}`);
console.log(`scratch matter: ${matter.name} (${matter.short_code})`);

const tag = crypto.randomUUID().slice(0, 8);
const dir = `${matter.id}/_smoke-tus-${tag}`;
const size = 2 * TUS_CHUNK_BYTES + 1024 * 1024; // 13 MB → 6 + 6 + 1
const data = crypto.randomBytes(size);
const sha = crypto.createHash('sha256').update(data).digest('hex');
let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL ${m}`); };
const common = {
  supabaseUrl: env.VITE_SUPABASE_URL,
  token: env.SUPABASE_SERVICE_ROLE_KEY,
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  bucket: 'vault-documents',
  contentType: 'application/octet-stream',
};

async function storedSha(objectName) {
  const { data: blob, error } = await supabase.storage.from('vault-documents').download(objectName);
  if (error) throw new Error(`download: ${error.message}`);
  const buf = Buffer.from(await blob.arrayBuffer());
  return { size: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex') };
}

const made = [];
try {
  console.log(`\n[U1] ${(size / 1048576).toFixed(0)} MB in 3 chunks, connection cut once mid-upload`);
  {
    const objectName = `${dir}/interrupted.bin`;
    made.push(objectName);
    const log = [];
    let cut = false;
    const fetchImpl = async (url, init) => {
      const m = (init?.method || 'GET').toUpperCase();
      log.push(m);
      if (m === 'PATCH' && !cut && Number(init.headers['upload-offset']) === TUS_CHUNK_BYTES) {
        // Send the bytes, then pretend the reply never arrived.
        cut = true;
        await fetch(url, init);
        throw new TypeError('fetch failed: simulated drop after chunk 2 was sent');
      }
      return fetch(url, init);
    };
    const t0 = Date.now();
    const res = await uploadResumable({ ...common, objectName, blob: new Blob([data]), fetchImpl, sleepImpl: async () => {}, onProgress: (p) => process.stdout.write(`\r       ${p.pct}%   `) });
    console.log(`\n       ${(Date.now() - t0) / 1000}s, requests: ${log.join(' ')}`);
    const st = await storedSha(objectName);
    if (st.size === size && st.sha === sha) pass(`U1: stored object is ${st.size} bytes, sha256 matches`);
    else fail(`U1: size=${st.size} (want ${size}) sha match=${st.sha === sha}`);
    if (log.includes('HEAD') && log.filter((m) => m === 'POST').length === 1 && res.resumedFrom === 0) pass('U1: the drop was answered with a HEAD (server offset) and one continued upload — no restart');
    else fail(`U1: log=${log.join(' ')} resumedFrom=${res.resumedFrom}`);
  }

  console.log('\n[U2] aborted after the first chunk (tab closed), then resumed from the bookmark');
  {
    const objectName = `${dir}/resumed.bin`;
    made.push(objectName);
    const store = memoryResumeStore();
    const ac = new AbortController();
    let posts = 0;
    const counting = async (url, init) => { if ((init?.method || '').toUpperCase() === 'POST') posts++; return fetch(url, init); };
    try {
      await uploadResumable({ ...common, objectName, blob: new Blob([data]), resumeStore: store, signal: ac.signal, fetchImpl: counting,
        onProgress: (p) => { if (p.sent >= TUS_CHUNK_BYTES) ac.abort(new Error('tab closed')); } });
      fail('U2: the abort did not stop the upload');
    } catch (err) {
      if (/tab closed/.test(err.message)) pass('U2: upload stopped at the abort');
      else fail(`U2: unexpected error ${err.message}`);
    }
    const t0 = Date.now();
    const res = await uploadResumable({ ...common, objectName, blob: new Blob([data]), resumeStore: store, fetchImpl: counting, onProgress: (p) => process.stdout.write(`\r       ${p.pct}%   `) });
    console.log(`\n       ${(Date.now() - t0) / 1000}s`);
    if (res.resumedFrom >= TUS_CHUNK_BYTES && posts === 1) pass(`U2: resumed at ${(res.resumedFrom / 1048576).toFixed(0)} MB from the remembered URL; no second upload was created`);
    else fail(`U2: resumedFrom=${res.resumedFrom} posts=${posts}`);
    const st = await storedSha(objectName);
    if (st.size === size && st.sha === sha) pass('U2: stored object is byte-identical');
    else fail(`U2: size=${st.size} sha match=${st.sha === sha}`);
  }
} finally {
  console.log('\ncleanup');
  const { error } = await supabase.storage.from('vault-documents').remove(made);
  console.log(error ? `  remove failed: ${error.message}` : `  removed ${made.length} object(s)`);
}
console.log(failures ? `\n${failures} FAILED` : '\nPASS');
process.exit(failures ? 1 : 0);

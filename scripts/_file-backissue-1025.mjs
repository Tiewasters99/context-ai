// Files the back issue's unfiled books into the Library the way the Vault does:
// a documents row (pending) → the PDF into vault-documents at <shelf>/<doc>/<name>
// → storage_path set → an ingest_document job for the worker. Service role.
//
//   node scripts/_file-backissue-1025.mjs            plan only
//   node scripts/_file-backissue-1025.mjs --write    file them
//
// Run from C:\Users\equai\cs-2s-member (its .env). Idempotent: a PDF whose
// name + size is already in the Library is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const WRITE = process.argv.includes('--write');
const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const sb = createClient((env.VITE_SUPABASE_URL || env.SUPABASE_URL).replace(/\/$/, ''), env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const LIBRARY_SERVERSPACE = 'c7117b5e-ae55-48dc-a444-c01f30df27ca';
const EDEN = '4ac2bcd9-be25-4c4a-9687-356ba470dbad';
const DOWNLOADS = 'C:/Users/equai/Downloads';
const LETTER = `${DOWNLOADS}/backissue-2026-10-25.md`;

// The 25 titles the letter lists that are not in the Library (checked 11-02), by
// the first words of their file names in Downloads.
const MISSING = ['The Struggle for Law', 'Freedom of Speech', 'Francis Dana', 'The Paradoxes of Legal Science', 'Russo-American Relations', 'Theory of Legislation', 'The Empire of Russia', 'Across Russia', 'Russia in Upheaval', 'Russia and Its Crisis', 'Ten Days That Shook the World', "The Tourist's Russia", 'Marie', 'Dead Souls', 'The Alhambra', 'Uncle Remus', 'A Connecticut Yankee', 'Memoirs of a Sportsman', 'Walden', "Mendel's Principles", 'The Physical Geography of the Sea', 'The Planetary and Stellar Worlds', 'The Old Red Sandstone', 'The New Chemistry', 'Humphry Davy'];

// The Vault's storage-name rule (src/lib/vault-persist.ts sanitizeStorageName).
const sanitizeStorageName = (name) => name
  .replace(/[\[\]{}]/g, '')
  .replace(/[^\w/!\-.*'() ]/g, '_')
  .replace(/_+/g, '_')
  .trim();

// Which shelf: the letter's "### Law (15)" … sections name the category each title sits under.
const letter = fs.readFileSync(LETTER, 'utf8');
const shelfOfTitle = new Map();
let current = null;
for (const line of letter.split(/\r?\n/)) {
  const h = /^### (Law|History|Literature|Science)\b/.exec(line);
  if (h) { current = h[1]; continue; }
  if (/^## /.test(line)) current = null;
  if (current && line.startsWith('- **')) {
    const m = line.slice(4).match(/\*([^*]+)\*/);
    if (m) shelfOfTitle.set(m[1], current);
  }
}
const norm = (s) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const { data: shelves } = await sb.from('matterspaces').select('id,name').eq('serverspace_id', LIBRARY_SERVERSPACE);
const shelfId = new Map(shelves.map((s) => [s.name, s.id]));

const cleaned = fs.readdirSync(DOWNLOADS).filter((f) => /Cleaned.*\.pdf$/i.test(f));
const plan = [];
for (const t of MISSING) {
  const words = norm(t).split(' ').slice(0, 3);
  const files = cleaned.filter((f) => words.every((w) => norm(f).includes(w))).sort();
  const letterTitle = [...shelfOfTitle.keys()].find((k) => words.every((w) => norm(k).includes(w)));
  const shelf = letterTitle ? shelfOfTitle.get(letterTitle) : null;
  if (!files.length || !shelf) { console.log(`! ${t}: ${files.length ? 'no shelf in the letter' : 'no PDF in Downloads'}`); continue; }
  for (const f of files) plan.push({ title: t, shelf, file: f, size: fs.statSync(path.join(DOWNLOADS, f)).size });
}

// Already filed? (same name + size, with bytes on disk)
const { data: have } = await sb.from('documents').select('source_filename,file_size_bytes').in('matterspace_id', [...shelfId.values()]).not('storage_path', 'is', null).range(0, 1999);
const haveKey = new Set((have ?? []).map((d) => `${d.source_filename}|${d.file_size_bytes}`));

let n = 0, skipped = 0;
for (const p of plan) {
  if (haveKey.has(`${p.file}|${p.size}`)) { skipped++; console.log(`= ${p.shelf.padEnd(10)} ${p.file} (already filed)`); continue; }
  console.log(`${WRITE ? '+' : '·'} ${p.shelf.padEnd(10)} ${p.file}  ${(p.size / 1048576).toFixed(1)} MB`);
  if (!WRITE) continue;
  const matter = shelfId.get(p.shelf);
  const { data: doc, error: insErr } = await sb.from('documents').insert({
    matterspace_id: matter,
    title: p.file.replace(/\.[^.]+$/, ''),
    doc_type: 'other',
    source_filename: p.file,
    file_size_bytes: p.size,
    processing_status: 'pending',
    created_by: EDEN,
  }).select('id').single();
  if (insErr) { console.log(`  ! row: ${insErr.message}`); continue; }
  const storagePath = `${matter}/${doc.id}/${sanitizeStorageName(p.file)}`;
  const buf = fs.readFileSync(path.join(DOWNLOADS, p.file));
  const { error: upErr } = await sb.storage.from('vault-documents').upload(storagePath, buf, { contentType: 'application/pdf', upsert: true });
  if (upErr) { console.log(`  ! upload: ${upErr.message}`); await sb.from('documents').delete().eq('id', doc.id); continue; }
  await sb.from('documents').update({ storage_path: storagePath }).eq('id', doc.id);
  const { error: jobErr } = await sb.from('processing_jobs').insert({ matterspace_id: matter, serverspace_id: LIBRARY_SERVERSPACE, job_type: 'ingest_document', payload: { document_id: doc.id } });
  if (jobErr) console.log(`  ! job: ${jobErr.message}`); else n++;
  console.log(`  filed ${doc.id}`);
}
console.log(`\n${WRITE ? `${n} filed` : `${plan.length - skipped} to file`}, ${skipped} already there.`);

// Discovery, end to end, OFFLINE — the stand-in for worker/e2e-live-test.mjs.
//
// Why this exists
// ---------------------------------------------------------------------------
// lib/discovery/ has one commit (4a37deb, 2026-06-11) and worker/e2e-live-test.mjs
// is unchanged since. In the three months after that the queue underneath
// Discovery was rewritten for ingestion: 044/045 (heartbeats, attempt budgets, a
// reaper), 055/058 (the bounded recovery sweep), 057 (job priority + a BEFORE
// INSERT trigger), 059 (ready-but-empty), 060 (the 'held' status). Nobody
// re-verified that a PRODUCTION still survives that queue, and the only test
// that could say so runs against the production database with the service role.
//
// This harness answers the same question without touching prod:
//
//   * the REAL migration files Discovery rides on, executed in order inside
//     PGlite (Postgres compiled to WASM) — 030 first, then every queue
//     migration that landed after it;
//   * the REAL lib/discovery/* engine (normalize, bates-stamp, loadfile, util)
//     driven end to end over a synthetic production;
//   * a stubbed storage layer (an in-memory Map) standing in for the
//     discovery-files bucket;
//   * the worker's orchestration TRANSCRIBED, not imported — worker/discovery-
//     worker.mjs is a top-level script that demands VITE_SUPABASE_URL and a
//     service-role key at import time and then enters a poll loop, so it cannot
//     be imported. Section 9 therefore greps the worker source for the
//     invariants this file models, so the transcription cannot drift silently.
//
// What it does NOT prove
// ---------------------------------------------------------------------------
//   * RLS. PGlite runs as superuser/table owner, so every policy 030/032
//     declares is bypassed. Constraints, triggers and functions ARE exercised.
//   * The network legs: Supabase Storage itself, OpenAI/Gemini/Textract, and
//     lib/ingest-core.mjs's processDocument (which needs an API key and is
//     covered by its own harnesses).
//   * Concurrency. PGlite is a single connection, so FOR UPDATE SKIP LOCKED is
//     never contended here — that path is byte-identical to 045.
//
//   npm i --no-save @electric-sql/pglite     # once; never a repo dependency
//   node scripts/_verify-discovery-pipeline.mjs
//
// No network, no .env, no prod. Everything it writes lives in this process and
// one temp folder it removes on the way out.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import {
  sha256, formatBates, sanitizeStorageName, mimeFor, isJunkPath, extOf,
} from '../lib/discovery/util.mjs';
import { normalizeFile } from '../lib/discovery/normalize.mjs';
import { parseDat, parseOpt, datLookupByFilename, emitDat, emitOpt, canonicalizeDatRecord } from '../lib/discovery/loadfile.mjs';
import {
  stampPdf, makeSlipSheet, makeProductionLetter, makePrivilegeLogPdf, safeText, undrawableChars,
} from '../lib/discovery/bates-stamp.mjs';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
let checks = 0;
const check = (ok, label, detail = '') => {
  checks += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};
const section = (title) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(2, 62 - title.length))}`);

// PGlite prints its whole bundled source on an uncaught error, which buries the
// one line that matters. Report the message and the SQL context, nothing else.
const bail = (err) => {
  console.error(`\n  HARNESS ERROR: ${err?.message ?? err}`);
  if (err?.query) console.error(`  while running: ${String(err.query).replace(/\s+/g, ' ').slice(0, 200)}`);
  process.exit(1);
};
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

// ---------------------------------------------------------------------------
// The stubbed storage layer. Path convention from 030:
//   {matterspace_id}/{production_id}/{item_id}/...
// ---------------------------------------------------------------------------
const storage = new Map();
const putObject = (p, buf, contentType) => {
  storage.set(p, { buf: Buffer.from(buf), contentType });
  return p;
};
const getObject = (p) => {
  const o = storage.get(p);
  if (!o) throw new Error(`storage download ${p}: Object not found`);
  return o.buf;
};

// ---------------------------------------------------------------------------
// 1. Schema + the real migration chain
// ---------------------------------------------------------------------------
section('migration chain (the real files, in the order prod received them)');

const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0] ?? null;

const migration = (name) => {
  const p = path.resolve(ROOT, 'supabase', 'migrations', name);
  console.log(`  executing supabase/migrations/${name}`);
  return fs.readFileSync(p, 'utf8');
};

// Everything 030 assumes already exists. documents carries 002's real CHECK
// constraint with an implicit name, which is what 060 has to find and replace.
await db.exec(`
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;

  create schema if not exists auth;
  create schema if not exists storage;

  -- There is no JWT in a PGlite session, so the signed-in user is whatever the
  -- harness sets. Section 9 switches to the 'authenticated' role to prove 057's
  -- priority clamp, and that path runs 030's RLS wrapper for real.
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('harness.uid', true), '')::uuid
  $$;

  create table public.serverspaces (
    id uuid primary key default gen_random_uuid(),
    name text
  );
  create table public.matterspaces (
    id uuid primary key default gen_random_uuid(),
    serverspace_id uuid not null references public.serverspaces(id) on delete cascade,
    parent_matterspace_id uuid references public.matterspaces(id) on delete cascade,
    name text,
    short_code text,
    ai_tier text
  );
  create table public.serverspace_members (
    serverspace_id uuid not null references public.serverspaces(id) on delete cascade,
    user_id uuid not null,
    role text not null default 'member'
  );
  create table public.profiles (id uuid primary key default gen_random_uuid());
  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid references public.matterspaces(id) on delete cascade,
    title text,
    doc_type text,
    source_filename text,
    storage_path text,
    file_size_bytes bigint,
    page_count int,
    processing_status text not null default 'pending'
      check (processing_status in (
        'pending','extracting','chunking','embedding','ready','error'
      )),
    processing_error text,
    ingested_at timestamptz,
    created_by uuid,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now()
  );
  create table public.passages (
    id uuid primary key default gen_random_uuid(),
    document_id uuid references public.documents(id) on delete cascade,
    matterspace_id uuid,
    sequence_number int
  );

  -- The SECURITY DEFINER access helper 030's invoker wrapper delegates to.
  create or replace function public._mtspc_select_check(p_matter uuid, p_ss uuid, p_parent uuid)
    returns boolean language sql stable as $$ select true $$;

  -- The slice of Supabase Storage 030's bucket policies reference.
  create table storage.buckets (id text primary key, name text, public boolean default false);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id),
    name text
  );
  create or replace function storage.foldername(name text) returns text[]
    language sql immutable as $$
      select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
    $$;

  grant usage on schema public, storage, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant all on all tables in schema public to authenticated, service_role;
`);
console.log('  stub schema built (auth.uid, storage.*, _mtspc_select_check)');

for (const f of [
  '030_discovery_productions.sql',
  '032_processing_jobs_rls.sql',
  '044_ingest_reliability.sql',
  '045_fix_claim_job_enum_cast.sql',
  '055_bounded_document_recovery.sql',
  '057_processing_jobs_priority.sql',
  '058_recovery_sweep_scale.sql',
  '059_ready_but_empty.sql',
  '060_held_sealed_status.sql',
]) {
  await db.exec(migration(f));
}
await db.exec('grant all on all tables in schema public to authenticated, service_role');
check(true, '030 + 032 + 044 + 045 + 055 + 057 + 058 + 059 + 060 all execute against a real Postgres');

const cols = (await q(`select column_name from information_schema.columns
  where table_schema='public' and table_name='processing_jobs'`)).map((r) => r.column_name);
for (const c of ['priority', 'serverspace_id', 'attempts', 'max_attempts', 'heartbeat_at']) {
  check(cols.includes(c), `processing_jobs.${c} exists after the chain (030's table, grown by 044/057)`);
}
const jobStatuses = (await q(
  `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'discovery_job_status' order by e.enumsortorder`,
)).map((r) => r.enumlabel);
check(jobStatuses.join(',') === 'queued,running,done,error,held',
  "discovery_job_status vocabulary is queued/running/done/error/held", jobStatuses.join(','));

// ---------------------------------------------------------------------------
// 2. A matter, a production, and a synthetic ZIP
// ---------------------------------------------------------------------------
section('synthetic production (a ZIP the intake path would receive)');

const ss = await one(`insert into public.serverspaces (name) values ('Quainton Law') returning id`);
const owner = crypto.randomUUID();
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1, $2, 'owner')`, [ss.id, owner]);
const prof = await one(`insert into public.profiles (id) values ($1) returning id`, [owner]);
const matter = await one(
  `insert into public.matterspaces (serverspace_id, name, short_code) values ($1, 'Acme v. Webster', 'acme-webster') returning id`,
  [ss.id],
);

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'disc-offline-'));

async function buildPdf(title, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(title, { x: 72, y: 710, size: 14, font });
    p.drawText(`Page ${i + 1} of ${pages}. Widget supply agreement, delivery schedules, indemnification.`,
      { x: 72, y: 680, size: 10, font, maxWidth: 460, lineHeight: 14 });
  }
  return Buffer.from(await doc.save());
}

const supplyPdf = await buildPdf('WIDGET SUPPLY AGREEMENT', 3);
const sharp = (await import('sharp')).default;
const photoPng = await sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 240, g: 238, b: 232 } } })
  .png().toBuffer();

// One non-Latin filename, because email productions carry them routinely.
const CYRILLIC_NAME = '010_Договор.xlsx';

const datBuf = (() => {
  const SEP = String.fromCharCode(0x14);
  const Q = 'þ';
  const wrap = (v) => `${Q}${v}${Q}`;
  const head = ['BEGBATES', 'ENDBATES', 'CUSTODIAN', 'FROM', 'TO', 'SUBJECT', 'DATE SENT', 'FILENAME'].map(wrap).join(SEP);
  const row = ['DEF_0000001', 'DEF_0000003', 'D. Director', 'ops@acmecorp.example', 'dan@websterind.example',
    'Supply agreement execution copy', '2025-02-03', '001_Supply_Agreement.pdf'].map(wrap).join(SEP);
  return Buffer.from([head, row].join('\r\n') + '\r\n', 'utf8');
})();

const SOURCE_FILES = [
  ['001_Supply_Agreement.pdf', supplyPdf],
  ['002_Board_Minutes.pdf', await buildPdf('BOARD MINUTES - Q3', 2)],
  ['003_Counsel_Memo.pdf', await buildPdf('MEMO RE LITIGATION RISK', 2)],
  ['004_Warehouse_Photo.png', photoPng],
  ['005_Damages_Model.docx', Buffer.from('PK\x03\x04 not a real docx, native by design')],
  ['006_Privileged_Email.eml', Buffer.from(
    'From: Alice Counsel <acounsel@firmllp.example>\r\n'
    + 'To: Dan Director <dan@websterind.example>\r\n'
    + 'Cc: Carol GC <carol@websterind.example>\r\n'
    + 'Subject: Legal advice re indemnification exposure\r\n'
    + 'Date: Tue, 4 Mar 2025 10:00:00 -0500\r\n\r\n'
    + 'Privileged and confidential legal advice follows.\r\n')],
  ['007_Supply_Agreement_COPY.pdf', supplyPdf],          // byte-identical duplicate
  ['008_Corrupt_Empty.pdf', Buffer.alloc(0)],            // zero-byte: normalize must fail
  ['009_Empty_Notes.txt', Buffer.alloc(0)],              // zero-byte native
  [CYRILLIC_NAME, Buffer.from('PK\x03\x04 spreadsheet, non-Latin filename')],
  ['loadfile.dat', datBuf],
  ['__MACOSX/._001_Supply_Agreement.pdf', Buffer.from('junk')],
  ['.DS_Store', Buffer.from('junk')],
];

const zipPath = path.join(tmp, 'DEF_PROD_001.zip');
await (async () => {
  const archiver = (await import('archiver')).default;
  const out = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise((res, rej) => { out.on('close', res); archive.on('error', rej); });
  archive.pipe(out);
  for (const [name, buf] of SOURCE_FILES) archive.append(buf, { name });
  await archive.finalize();
  await done;
})();
check(fs.existsSync(zipPath), `synthetic ZIP built: ${SOURCE_FILES.length} entries, ${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB`);

const prod = await one(
  `insert into public.productions (matterspace_id, direction, name, receiving_party, request_refs, bates_position, created_by)
   values ($1, 'outgoing', 'Plaintiff Production Vol. 1', 'Smith & Jones LLP', 'RFP Nos. 1-12', 'lower_right', $2)
   returning *`, [matter.id, prof.id],
);

// ---------------------------------------------------------------------------
// 3. Intake — transcribed from worker/discovery-worker.mjs intakeZip():372-423
//    and intakeOneFile():488-562. Real node-stream-zip, real normalizeFile,
//    real loadfile parsing, stubbed storage.
// ---------------------------------------------------------------------------
section('intake (real normalizeFile + node-stream-zip, stubbed storage)');

await q(`update public.productions set status = 'processing' where id = $1`, [prod.id]);

const StreamZip = (await import('node-stream-zip')).default;
const zip = new StreamZip.async({ file: zipPath });
const entries = Object.values(await zip.entries()).filter((e) => !e.isDirectory && !isJunkPath(e.name));
check(entries.length === SOURCE_FILES.length - 2,
  'isJunkPath filtered __MACOSX and .DS_Store out of the ZIP', `${entries.length} kept`);

let datLookup = new Map();
for (const e of entries.filter((e) => /\.dat$/i.test(e.name))) {
  const { records } = parseDat(await zip.entryData(e.name));
  datLookup = new Map([...datLookup, ...datLookupByFilename(records)]);
  putObject(`${matter.id}/${prod.id}/loadfiles/${sanitizeStorageName(path.basename(e.name))}`,
    await zip.entryData(e.name), 'application/octet-stream');
}
check(datLookup.size > 0, 'opposing counsel\'s DAT parsed into a filename lookup', `${datLookup.size} keys`);

const contentEntries = entries
  .filter((e) => !/\.(dat|opt|lfp)$/i.test(e.name))
  .sort((a, b) => a.name.localeCompare(b.name));

let sortOrder = 0;
for (const e of contentEntries) {
  sortOrder += 1;
  const buf = await zip.entryData(e.name);
  const filename = path.basename(e.name);
  const hash = sha256(buf);

  let norm;
  try {
    norm = await normalizeFile(buf, filename);
  } catch (err) {
    await q(
      `insert into public.production_items
         (production_id, matterspace_id, sort_order, original_filename, original_path,
          sha256, file_size_bytes, kind, status, error)
       values ($1,$2,$3,$4,$5,$6,$7,'native','error',$8)`,
      [prod.id, matter.id, sortOrder, filename, e.name, hash, buf.length, `normalize: ${err.message}`],
    );
    continue;
  }

  const datRec = datLookup.get(filename.toLowerCase());
  const metadata = { ...norm.metadata, ...(datRec ?? {}) };
  const item = await one(
    `insert into public.production_items
       (production_id, matterspace_id, sort_order, original_filename, original_path, sha256,
        file_size_bytes, kind, page_count, bates_first, bates_last, source_metadata, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending') returning *`,
    [prod.id, matter.id, sortOrder, filename, e.name, hash, buf.length, norm.kind,
      norm.pageCount, datRec?.bates_first ?? null, datRec?.bates_last ?? null, JSON.stringify(metadata)],
  );

  const base = `${matter.id}/${prod.id}/${item.id}`;
  const nativePath = putObject(`${base}/native/${sanitizeStorageName(filename)}`, buf, mimeFor(extOf(filename)));
  let displayPath = null;
  if (norm.kind === 'display_pdf') {
    displayPath = norm.displayPdf === buf ? nativePath : putObject(`${base}/display.pdf`, norm.displayPdf, 'application/pdf');
  }
  await q(`update public.production_items set native_storage_path=$1, display_storage_path=$2, status='ready' where id=$3`,
    [nativePath, displayPath, item.id]);
}
await zip.close();
await q(`update public.productions set status = 'review' where id = $1`, [prod.id]);

const items = await q(`select * from public.production_items where production_id = $1 order by sort_order`, [prod.id]);
const byName = Object.fromEntries(items.map((i) => [i.original_filename, i]));

check(items.length === 10, 'every content entry produced a production_items row', `${items.length}`);
check(items.every((i) => /^[0-9a-f]{64}$/.test(i.sha256 ?? '')), 'sha256 recorded on every item, including the failures');
check(byName['001_Supply_Agreement.pdf'].kind === 'display_pdf' && byName['001_Supply_Agreement.pdf'].page_count === 3,
  'PDF passthrough: kind=display_pdf, page_count from the file');
check(byName['004_Warehouse_Photo.png'].kind === 'display_pdf' && byName['004_Warehouse_Photo.png'].page_count === 1,
  'image -> single-page display PDF');
check(byName['005_Damages_Model.docx'].kind === 'native' && byName['005_Damages_Model.docx'].display_storage_path === null,
  'Office document stays native — no display PDF (normalize.mjs:67-69)');
check(byName['006_Privileged_Email.eml'].source_metadata?.author?.includes('acounsel@firmllp.example'),
  '.eml headers parsed into source_metadata for the privilege log');
check(byName['001_Supply_Agreement.pdf'].source_metadata?.custodian === 'D. Director',
  "the DAT's custodian rode onto the item it names");
check(byName['008_Corrupt_Empty.pdf'].status === 'error' && /normalize:/.test(byName['008_Corrupt_Empty.pdf'].error ?? ''),
  'a zero-byte PDF fails normalization and is recorded as an error item, not dropped silently');
check(byName['009_Empty_Notes.txt'].status === 'ready' && byName['009_Empty_Notes.txt'].kind === 'native',
  'a zero-byte .txt is a perfectly valid native item (it will get a Bates number)');
check(byName['007_Supply_Agreement_COPY.pdf'].sha256 === byName['001_Supply_Agreement.pdf'].sha256,
  'the duplicate has the same sha256 as its original');
check(byName['007_Supply_Agreement_COPY.pdf'].status === 'ready',
  'FINDING: intake does not dedupe on sha256 — both copies become produced items '
  + '(the idx_production_items_sha index at 030:122 is never queried)');
const prodAfterIntake = await one(`select status from public.productions where id = $1`, [prod.id]);
check(prodAfterIntake.status === 'review', "production status reached 'review'", prodAfterIntake.status);

// ---------------------------------------------------------------------------
// 4. Tags + privilege log
// ---------------------------------------------------------------------------
section('review: preset tags, exclusions, privilege log entries');

const PRESETS = [
  ['Privileged', '#b91c1c', true, 'PRIVILEGED', 'privileged'],
  ['Hot Doc', '#d97706', false, null, null],
  ['Confidential', '#1d4ed8', true, 'CONFIDENTIAL', null],
  ['Non-Responsive', '#6b7280', false, null, 'non_responsive'],
];
const defByName = {};
for (const [name, color, isEnd, endText, behavior] of PRESETS) {
  defByName[name] = await one(
    `insert into public.document_tag_defs (matterspace_id, name, color, is_endorsement, endorsement_text, is_preset, behavior)
     values ($1,$2,$3,$4,$5,true,$6) returning *`, [matter.id, name, color, isEnd, endText, behavior],
  );
}
const tagItem = (item, defName) => q(
  `insert into public.document_tags (tag_def_id, production_item_id, matterspace_id) values ($1,$2,$3)`,
  [defByName[defName].id, item.id, matter.id],
);
await tagItem(byName['003_Counsel_Memo.pdf'], 'Privileged');
await tagItem(byName['006_Privileged_Email.eml'], 'Privileged');
await tagItem(byName['002_Board_Minutes.pdf'], 'Confidential');
await tagItem(byName['001_Supply_Agreement.pdf'], 'Hot Doc');

for (const it of [byName['003_Counsel_Memo.pdf'], byName['006_Privileged_Email.eml']]) {
  const m = it.source_metadata ?? {};
  await q(
    `insert into public.privilege_log_entries
       (matterspace_id, production_id, production_item_id, author, addressee, cc, subject_matter, basis, description)
     values ($1,$2,$3,$4,$5,$6,$7,'attorney_client',$8)`,
    [matter.id, prod.id, it.id, m.author ?? 'Alice Counsel', m.to ?? 'Dan Director', m.cc ?? '',
      m.subject ?? 'Legal advice regarding litigation risk', 'Communication seeking/providing legal advice.'],
  );
}
const privCount = Number((await one(`select count(*)::int c from public.privilege_log_entries where production_id = $1`, [prod.id])).c);
check(privCount === 2, 'one privilege-log entry per withheld item', `${privCount}`);

let dupPrivRejected = false;
try {
  await q(`insert into public.privilege_log_entries (matterspace_id, production_id, production_item_id)
           values ($1,$2,$3)`, [matter.id, prod.id, byName['003_Counsel_Memo.pdf'].id]);
} catch { dupPrivRejected = true; }
check(dupPrivRejected, 'unique(production_item_id) stops a second log entry for the same document');

// partitionItems — transcribed from worker/discovery-worker.mjs:835-870
async function partitionItems(productionId, matterId) {
  const rows = await q(
    `select * from public.production_items where production_id = $1 and status = 'ready' order by sort_order`,
    [productionId],
  );
  const tags = await q(
    `select t.production_item_id, d.name, d.behavior, d.is_endorsement, d.endorsement_text
       from public.document_tags t join public.document_tag_defs d on d.id = t.tag_def_id
      where t.matterspace_id = $1`, [matterId],
  );
  const excludedIds = new Set();
  const endorsementsByItem = new Map();
  const confidentialIds = new Set();
  for (const t of tags) {
    if (t.behavior === 'privileged' || t.behavior === 'non_responsive') excludedIds.add(t.production_item_id);
    if (t.is_endorsement && t.endorsement_text) {
      const list = endorsementsByItem.get(t.production_item_id) ?? [];
      list.push(t.endorsement_text);
      endorsementsByItem.set(t.production_item_id, list);
      if (/confidential/i.test(t.endorsement_text)) confidentialIds.add(t.production_item_id);
    }
  }
  return {
    included: rows.filter((r) => !excludedIds.has(r.id)),
    excluded: rows.filter((r) => excludedIds.has(r.id)),
    endorsementsByItem, confidentialIds,
  };
}

const part = await partitionItems(prod.id, matter.id);
check(part.excluded.length === 2, 'both Privileged items are withheld from the produced set', `${part.excluded.length}`);
check(part.included.length === 7, 'seven items remain to be produced', `${part.included.length}`);
check(!part.included.some((i) => i.original_filename === '008_Corrupt_Empty.pdf'),
  'FINDING: the failed item is dropped from the produced set silently — partitionItems filters '
  + "status='ready' (worker:838) and nothing ever lists what was left out (worker/discovery-worker.mjs:835-870)");

// ---------------------------------------------------------------------------
// 5. Stamping — transcribed from stampProduction():740-831, real stampPdf
// ---------------------------------------------------------------------------
section('Bates stamping (real stampPdf + makeSlipSheet, real bates_registry)');

async function highWaterMark(matterId) {
  const r = await one(`select bates_seq from public.bates_registry where matterspace_id=$1 order by bates_seq desc limit 1`, [matterId]);
  return r ? Number(r.bates_seq) : 0;
}

async function stampProduction(productionId, { prefix, pad, start, position = 'lower_right' }) {
  const p = await one(`select * from public.productions where id = $1`, [productionId]);
  if (['stamped', 'packaged', 'delivered'].includes(p.status)) {
    throw new Error(`Production already ${p.status}; create a supplemental production instead`);
  }
  const { included, excluded, endorsementsByItem } = await partitionItems(productionId, p.matterspace_id);
  if (included.length === 0) throw new Error('No documents to stamp (all excluded?)');

  const totalPages = included.reduce((s, it) => s + (it.kind === 'native' ? 1 : (it.page_count ?? 1)), 0);
  const startSeq = start ?? (await highWaterMark(p.matterspace_id)) + 1;
  const endSeq = startSeq + totalPages - 1;
  const collisions = Number((await one(
    `select count(*)::int c from public.bates_registry where matterspace_id=$1 and bates_seq between $2 and $3`,
    [p.matterspace_id, startSeq, endSeq],
  )).c);
  if (collisions > 0) {
    throw new Error(`Bates collision: ${collisions} number(s) in ${formatBates(prefix, pad, startSeq)}-`
      + `${formatBates(prefix, pad, endSeq)} already assigned in this matter`);
  }

  let seq = startSeq;
  for (const item of included) {
    const endorsements = endorsementsByItem.get(item.id) ?? [];
    const base = `${p.matterspace_id}/${p.id}/${item.id}`;
    let pageCount;
    if (item.kind === 'native') {
      const bates = formatBates(prefix, pad, seq);
      const sheet = await makeSlipSheet({ batesNumber: bates, filename: item.original_filename, endorsements, position });
      putObject(`${base}/stamped.pdf`, sheet, 'application/pdf');
      pageCount = 1;
      await q(`update public.production_items set bates_first=$1, bates_last=$1 where id=$2`, [bates, item.id]);
    } else {
      const stamped = await stampPdf(getObject(item.display_storage_path), {
        prefix, pad, startSeq: seq, position, endorsements,
      });
      putObject(`${base}/stamped.pdf`, stamped.buf, 'application/pdf');
      pageCount = stamped.pageCount;
      await q(`update public.production_items set bates_first=$1, bates_last=$2, page_count=$3 where id=$4`,
        [stamped.batesFirst, stamped.batesLast, pageCount, item.id]);
    }
    for (let pg = 0; pg < pageCount; pg++) {
      await q(
        `insert into public.bates_registry (matterspace_id, bates_number, bates_seq, production_id, production_item_id, page_number)
         values ($1,$2,$3,$4,$5,$6)`,
        [p.matterspace_id, formatBates(prefix, pad, seq + pg), seq + pg, p.id, item.id, pg + 1],
      );
    }
    seq += pageCount;
  }
  await q(`update public.productions set bates_start=$1, bates_end=$2, status='stamped', locked_at=now(),
             bates_prefix=$3, bates_pad=$4, bates_position=$5 where id=$6`,
  [startSeq, seq - 1, prefix, pad, position, p.id]);
  return { startSeq, endSeq: seq - 1, included, excluded };
}

// The non-Latin filename is the interesting one: the slip sheet has to render
// it with a StandardFont, which is WinAnsi.
let stampResult = null;
let stampError = null;
try {
  stampResult = await stampProduction(prod.id, { prefix: 'ACME_', pad: 7, start: 1 });
} catch (err) {
  stampError = err;
}
check(!stampError, 'stamp_production completes over a production containing a non-Latin filename',
  stampError ? `${stampError.message}` : '');

if (stampError) {
  console.log('\n  Stamping threw; the rest of the pipeline cannot be checked. Aborting.');
  await fsp.rm(tmp, { recursive: true, force: true });
  process.exit(1);
}

const registry = await q(
  `select bates_number, bates_seq, page_number, production_item_id from public.bates_registry
    where production_id = $1 order by bates_seq`, [prod.id],
);
check(registry.length === 12, 'one registry row per produced page (3+2+1+1+3+1+1)', `${registry.length}`);
const seqs = registry.map((r) => Number(r.bates_seq));
check(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), 'the numbering is gapless across documents',
  `${seqs[0]}..${seqs[seqs.length - 1]}`);
check(registry[0].bates_number === 'ACME_0000001' && registry[11].bates_number === 'ACME_0000012',
  'formatBates produced the expected first and last numbers',
  `${registry[0].bates_number}..${registry[11].bates_number}`);

const stampedItems = await q(
  `select original_filename, kind, bates_first, bates_last, page_count from public.production_items
    where production_id=$1 order by sort_order`, [prod.id],
);
const stampedBy = Object.fromEntries(stampedItems.map((i) => [i.original_filename, i]));
check(stampedBy['003_Counsel_Memo.pdf'].bates_first === null && stampedBy['006_Privileged_Email.eml'].bates_first === null,
  'withheld documents were never given a Bates number');
check(stampedBy['005_Damages_Model.docx'].bates_first === stampedBy['005_Damages_Model.docx'].bates_last,
  'a native gets exactly one Bates number (its slip sheet)');
check(stampedBy[CYRILLIC_NAME].bates_first !== null, 'the non-Latin-filename native got its slip sheet and number');

// the stamped PDF still opens with the repo's PDF library
const firstStampedPath = `${matter.id}/${prod.id}/${stampedBy['001_Supply_Agreement.pdf'] ? byName['001_Supply_Agreement.pdf'].id : ''}/stamped.pdf`;
const reopened = await PDFDocument.load(getObject(firstStampedPath));
check(reopened.getPageCount() === 3, 'the stamped PDF re-opens with pdf-lib and kept its 3 pages', `${reopened.getPageCount()}`);
const slip = await PDFDocument.load(getObject(`${matter.id}/${prod.id}/${byName[CYRILLIC_NAME].id}/stamped.pdf`));
check(slip.getPageCount() === 1, 'the slip sheet is a single US-letter page');

// The fix this harness forced (lib/discovery/bates-stamp.mjs): a standard PDF
// font is WinAnsi, and pdf-lib throws rather than substituting.
section('non-Latin text: descriptive folds, load-bearing refuses');
check(safeText('010_Договор.xlsx') === '010_???????.xlsx',
  'safeText folds an un-drawable filename instead of throwing', safeText('010_Договор.xlsx'));
check(safeText('cafē naïve — Q3 “report”') === 'cafe naïve — Q3 “report”',
  'accents outside CP1252 fold to their base letter; Latin-1 and CP1252 punctuation are left alone',
  safeText('cafē naïve — Q3 “report”'));
check(undrawableChars('ACME_').length === 0 && undrawableChars('Д_').length === 1,
  'undrawableChars reports exactly what a standard font cannot draw');
const slipRoundTrip = await PDFDocument.load(await makeSlipSheet({
  batesNumber: 'ACME_9999999', filename: '供給契約書.msg 📎', endorsements: ['CONFIDENTIAL'],
}));
check(slipRoundTrip.getPageCount() === 1, 'a slip sheet for a CJK + emoji filename renders and re-opens');
const refusedPrefix = await (async () => {
  try { await stampPdf(supplyPdf, { prefix: 'Д_', pad: 7, startSeq: 1, position: 'lower_right' }); return null; }
  catch (e) { return e; }
})();
check(/Bates prefix contains/.test(refusedPrefix?.message ?? ''),
  'a Bates PREFIX that cannot be drawn is refused before the document is opened — the page must '
  + 'read exactly what bates_registry records', refusedPrefix?.message?.slice(0, 90));
const refusedEndorse = await (async () => {
  try { await makeSlipSheet({ batesNumber: 'ACME_9999998', filename: 'x.docx', endorsements: ['КОНФИДЕНЦИАЛЬНО'] }); return null; }
  catch (e) { return e; }
})();
check(/endorsement/.test(refusedEndorse?.message ?? ''),
  'an endorsement that cannot be drawn is refused rather than silently rendered as "????????"');
const letterNonLatin = await makeProductionLetter({
  productionName: 'Том 1', matterName: 'Акме против Вебстер',
  receivingParty: 'Smith & Jones', batesFirst: 'ACME_0000001', batesLast: 'ACME_0000012',
  docCount: 7, pageCount: 12, nativeCount: 3, confidentialCount: 1, requestRefs: 'RFP 1–12', dateStr: '2026-09-20',
});
check((await PDFDocument.load(letterNonLatin)).getPageCount() === 1, 'a cover letter for a non-Latin matter name renders');
const privLogNonLatin = await makePrivilegeLogPdf({
  matterName: 'Акме', productionName: 'Vol. 1',
  entries: [{ author: 'Алиса Каунсел', addressee: 'Dan', cc: '', subject_matter: 'совет', basis: 'attorney_client', description: 'Конфиденциально.' }],
});
check((await PDFDocument.load(privLogNonLatin)).getPageCount() >= 1,
  'a privilege log whose author and subject matter are non-Latin renders');

// Locked: the trigger from 030:359-380 must now refuse every write to items.
section('the production lock (_production_lock_guard, migration 030:359-380)');
const refuses = async (sql, params) => {
  try { await q(sql, params); return false; } catch { return true; }
};
check(await refuses(
  `insert into public.production_items (production_id, matterspace_id, sort_order, original_filename)
   values ($1,$2,99,'late_addition.pdf')`, [prod.id, matter.id]),
'INSERT of a late addition is refused once the production is stamped');
check(await refuses(`update public.production_items set sort_order = 42 where id = $1`, [byName['001_Supply_Agreement.pdf'].id]),
  'UPDATE (a re-order) is refused once the production is stamped');
check(await refuses(`delete from public.production_items where id = $1`, [byName['009_Empty_Notes.txt'].id]),
  'DELETE is refused once the production is stamped');
check(await refuses(`select 1 from public.productions where id=$1 and (select 1/0) = 1`, [prod.id]) === true, 'harness sanity: refuses() detects an error');

let reStampErr = null;
try { await stampProduction(prod.id, { prefix: 'ACME_', pad: 7, start: 1 }); } catch (e) { reStampErr = e; }
check(/already stamped/i.test(reStampErr?.message ?? ''), 'a second stamp of the same production is refused', reStampErr?.message);

// ---------------------------------------------------------------------------
// 6. Numbering is stable across a re-run, and continues gaplessly
// ---------------------------------------------------------------------------
section('numbering: stable across a re-run, continuous across productions');

// Same inputs, a fresh matter, the same start -> byte-for-byte the same numbers.
const matter2 = await one(
  `insert into public.matterspaces (serverspace_id, name, short_code) values ($1,'Acme v. Webster (replay)','acme-replay') returning id`, [ss.id],
);
const prod2 = await one(
  `insert into public.productions (matterspace_id, direction, name, bates_position, created_by)
   values ($1,'outgoing','Replay', 'lower_right', $2) returning *`, [matter2.id, prof.id],
);
for (const it of items) {
  const copy = await one(
    `insert into public.production_items
       (production_id, matterspace_id, sort_order, original_filename, original_path, sha256, file_size_bytes,
        kind, page_count, source_metadata, status, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [prod2.id, matter2.id, it.sort_order, it.original_filename, it.original_path, it.sha256, it.file_size_bytes,
      it.kind, it.page_count, JSON.stringify(it.source_metadata), it.status, it.error],
  );
  if (it.display_storage_path) {
    const dest = `${matter2.id}/${prod2.id}/${copy.id}/display.pdf`;
    putObject(dest, getObject(it.display_storage_path), 'application/pdf');
    await q(`update public.production_items set display_storage_path=$1 where id=$2`, [dest, copy.id]);
  }
  const src = items.find((x) => x.id === it.id);
  if (src) {
    const tagRows = await q(`select tag_def_id from public.document_tags where production_item_id=$1`, [it.id]);
    for (const t of tagRows) {
      const def = await one(`select name from public.document_tag_defs where id=$1`, [t.tag_def_id]);
      const def2 = await one(
        `insert into public.document_tag_defs (matterspace_id,name,color,is_endorsement,endorsement_text,is_preset,behavior)
         select $1, name, color, is_endorsement, endorsement_text, is_preset, behavior from public.document_tag_defs where id=$2
         on conflict (matterspace_id, name) do update set color = excluded.color returning id`, [matter2.id, t.tag_def_id],
      );
      await q(`insert into public.document_tags (tag_def_id, production_item_id, matterspace_id) values ($1,$2,$3)`,
        [def2.id, copy.id, matter2.id]);
      void def;
    }
  }
}
await q(`update public.productions set status='review' where id=$1`, [prod2.id]);
await stampProduction(prod2.id, { prefix: 'ACME_', pad: 7, start: 1 });
const replay = await q(
  `select i.original_filename, i.bates_first, i.bates_last from public.production_items i
    where i.production_id=$1 order by i.sort_order`, [prod2.id],
);
const original = await q(
  `select i.original_filename, i.bates_first, i.bates_last from public.production_items i
    where i.production_id=$1 order by i.sort_order`, [prod.id],
);
check(JSON.stringify(replay) === JSON.stringify(original),
  'a re-run over the same inputs assigns exactly the same numbers to the same files');

// A supplemental production in the SAME matter continues from the high-water mark.
const prod3 = await one(
  `insert into public.productions (matterspace_id, direction, name, bates_position, created_by)
   values ($1,'outgoing','Supplemental Vol. 2','lower_right',$2) returning *`, [matter.id, prof.id],
);
const supp = await one(
  `insert into public.production_items (production_id, matterspace_id, sort_order, original_filename, sha256,
     file_size_bytes, kind, page_count, display_storage_path, status)
   values ($1,$2,1,'011_Late_Invoice.pdf',$3,$4,'display_pdf',2,$5,'ready') returning *`,
  [prod3.id, matter.id, sha256(await buildPdf('LATE INVOICE', 2)), 4096,
    putObject(`${matter.id}/${prod3.id}/late/display.pdf`, await buildPdf('LATE INVOICE', 2), 'application/pdf')],
);
void supp;
const hw = await highWaterMark(matter.id);
const suppResult = await stampProduction(prod3.id, { prefix: 'ACME_', pad: 7, start: hw + 1 });
check(suppResult.startSeq === 13 && suppResult.endSeq === 14,
  'the supplemental production continues gaplessly from the matter high-water mark',
  `${suppResult.startSeq}-${suppResult.endSeq}`);

// Re-using a range already assigned in the matter must be refused before a row moves.
const prod4 = await one(
  `insert into public.productions (matterspace_id, direction, name, bates_position, created_by)
   values ($1,'outgoing','Overlapping Vol. 3','lower_right',$2) returning *`, [matter.id, prof.id],
);
await q(`insert into public.production_items (production_id, matterspace_id, sort_order, original_filename, sha256,
           file_size_bytes, kind, page_count, display_storage_path, status)
         values ($1,$2,1,'012_Overlap.pdf',$3,$4,'display_pdf',1,$5,'ready')`,
[prod4.id, matter.id, sha256(Buffer.from('x')), 10, putObject(`${matter.id}/${prod4.id}/o/display.pdf`, await buildPdf('OVERLAP', 1), 'application/pdf')]);
const registryBefore = Number((await one(`select count(*)::int c from public.bates_registry where matterspace_id=$1`, [matter.id])).c);
let collideErr = null;
try { await stampProduction(prod4.id, { prefix: 'ACME_', pad: 7, start: 5 }); } catch (e) { collideErr = e; }
const registryAfter = Number((await one(`select count(*)::int c from public.bates_registry where matterspace_id=$1`, [matter.id])).c);
check(/Bates collision/.test(collideErr?.message ?? ''), 'a start number inside an assigned range is refused', collideErr?.message);
check(registryBefore === registryAfter, 'the refusal happened before any registry row was written');

// And the registry itself is immutable: the same number cannot be minted twice.
check(await refuses(
  `insert into public.bates_registry (matterspace_id, bates_number, bates_seq, production_id, production_item_id, page_number)
   values ($1,'ACME_0000001',1,$2,$3,1)`, [matter.id, prod.id, byName['001_Supply_Agreement.pdf'].id]),
'unique(matterspace_id, bates_number) makes reuse a database error');

// ---------------------------------------------------------------------------
// 7. Packaging — transcribed from packageProduction():885-990, real emitters
// ---------------------------------------------------------------------------
section('packaging (real emitDat/emitOpt/letter/privilege log + archiver)');

async function packageProduction(productionId, { includePrivilegeLog = true } = {}) {
  const p = await one(`select * from public.productions where id=$1`, [productionId]);
  if (p.status !== 'stamped' && p.status !== 'packaged') {
    throw new Error(`package_production: production must be stamped first (status: ${p.status})`);
  }
  const { included, confidentialIds } = await partitionItems(productionId, p.matterspace_id);
  const produced = included.filter((i) => i.bates_first);
  if (produced.length === 0) throw new Error('Nothing stamped to package');

  const matterName = (await one(`select name from public.matterspaces where id=$1`, [p.matterspace_id]))?.name ?? '';
  const volumeName = sanitizeStorageName(p.name.replace(/\s+/g, '_')) || 'PRODUCTION';
  const archiver = (await import('archiver')).default;
  const tmpZip = path.join(tmp, `pkg-${crypto.randomUUID().slice(0, 8)}.zip`);
  const out = fs.createWriteStream(tmpZip);
  const archive = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise((res, rej) => { out.on('close', res); archive.on('error', rej); });
  archive.pipe(out);

  const datRows = [];
  let totalPages = 0;
  for (const item of produced) {
    const base = `${p.matterspace_id}/${p.id}/${item.id}`;
    archive.append(getObject(`${base}/stamped.pdf`), { name: `${volumeName}/IMAGES/${item.bates_first}.pdf` });
    let nativeLink = '';
    if (item.kind === 'native') {
      const ext = extOf(item.original_filename);
      nativeLink = `NATIVES/${item.bates_first}${ext}`;
      archive.append(getObject(item.native_storage_path), { name: `${volumeName}/${nativeLink}` });
    }
    const m = item.source_metadata ?? {};
    const pages = item.kind === 'native' ? 1 : (item.page_count ?? 1);
    totalPages += pages;
    datRows.push({
      bates_first: item.bates_first, bates_last: item.bates_last, pages,
      custodian: m.custodian ?? '', author: m.author ?? '', to: m.to ?? '', cc: m.cc ?? '',
      subject: m.subject ?? '', date: m.date ?? '', filename: item.original_filename,
      native_link: nativeLink, confidentiality: confidentialIds.has(item.id) ? 'CONFIDENTIAL' : '',
      image_path: `IMAGES/${item.bates_first}.pdf`,
    });
  }
  archive.append(emitDat(datRows), { name: `${volumeName}/DATA/loadfile.dat` });
  archive.append(emitOpt(datRows, volumeName), { name: `${volumeName}/DATA/loadfile.opt` });

  if (includePrivilegeLog) {
    const entries = await q(`select * from public.privilege_log_entries where production_id=$1 order by doc_date nulls last`, [productionId]);
    if (entries.length) {
      archive.append(await makePrivilegeLogPdf({ matterName, productionName: p.name, entries }),
        { name: `${volumeName}/PrivilegeLog.pdf` });
    }
  }
  archive.append(await makeProductionLetter({
    productionName: p.name, matterName, receivingParty: p.receiving_party,
    batesFirst: formatBates(p.bates_prefix, p.bates_pad, p.bates_start),
    batesLast: formatBates(p.bates_prefix, p.bates_pad, p.bates_end),
    docCount: produced.length, pageCount: totalPages,
    nativeCount: produced.filter((i) => i.kind === 'native').length,
    confidentialCount: confidentialIds.size, requestRefs: p.request_refs,
    dateStr: new Date().toISOString().slice(0, 10),
  }), { name: `${volumeName}/ProductionLetter.pdf` });

  await archive.finalize();
  await done;

  const bytes = await fsp.readFile(tmpZip);
  const pkgSha = crypto.createHash('sha256').update(bytes).digest('hex');
  const pkgPath = putObject(`${p.matterspace_id}/${p.id}/package/${volumeName}.zip`, bytes, 'application/zip');
  await q(`update public.productions set package_storage_path=$1, package_sha256=$2, status='packaged' where id=$3`,
    [pkgPath, pkgSha, p.id]);
  await fsp.unlink(tmpZip).catch(() => {});
  return { pkgPath, pkgSha, produced, totalPages };
}

const pkg = await packageProduction(prod.id, { includePrivilegeLog: true });
const packed = await one(`select * from public.productions where id=$1`, [prod.id]);
check(packed.status === 'packaged', 'production reached status packaged');
check(/^[0-9a-f]{64}$/.test(packed.package_sha256 ?? ''), 'package_sha256 recorded');
check(crypto.createHash('sha256').update(getObject(packed.package_storage_path)).digest('hex') === packed.package_sha256,
  'package_sha256 matches the bytes actually stored — the delivery record can be trusted');

const pkgZip = path.join(tmp, 'audit.zip');
await fsp.writeFile(pkgZip, getObject(packed.package_storage_path));
const azip = new StreamZip.async({ file: pkgZip });
const names = Object.keys(await azip.entries());
const images = names.filter((n) => /\/IMAGES\//.test(n));
const natives = names.filter((n) => /\/NATIVES\//.test(n));
check(images.length === 7, 'IMAGES holds one stamped PDF per produced document', `${images.length}`);
check(natives.length === 3, 'NATIVES holds the three natively-produced files (docx, txt, xlsx)', natives.length + ': ' + natives.join(', '));
check(!names.some((n) => /Counsel_Memo|Privileged_Email/i.test(n)),
  'no withheld document appears anywhere in the package');
check(names.some((n) => n.endsWith('DATA/loadfile.dat')) && names.some((n) => n.endsWith('DATA/loadfile.opt')),
  'both load files are in DATA/');
check(names.some((n) => n.endsWith('PrivilegeLog.pdf')), 'the privilege log is in the package');
check(names.some((n) => n.endsWith('ProductionLetter.pdf')), 'the production letter is in the package');

const { records: datOut } = parseDat(await azip.entryData(names.find((n) => n.endsWith('loadfile.dat'))));
check(datOut.length === 7, 'the DAT manifest lists every produced document exactly once', `${datOut.length}`);
const datNames = datOut.map((r) => r.filename);
check(new Set(datNames).size === datNames.length, 'no document is listed twice in the manifest');
check(datNames.includes('001_Supply_Agreement.pdf') && datNames.includes('007_Supply_Agreement_COPY.pdf'),
  'FINDING: the duplicate is produced and manifested as a separate document with its own Bates range');
const confRec = datOut.map(canonicalizeDatRecord).find((r) => r.filename === '002_Board_Minutes.pdf');
check(confRec?.dat?.confidentiality === 'CONFIDENTIAL', 'the CONFIDENTIAL designation reached the DAT');
const optRows = parseOpt(await azip.entryData(names.find((n) => n.endsWith('loadfile.opt'))));
check(optRows.length === 7, 'the OPT cross-reference has one line per produced document', `${optRows.length}`);
check(optRows.every((r) => images.some((n) => n.endsWith(r.path.split('/').pop()))),
  'every OPT line points at an image that is actually in the ZIP');

const privLogPdf = await PDFDocument.load(await azip.entryData(names.find((n) => n.endsWith('PrivilegeLog.pdf'))));
check(privLogPdf.getPageCount() >= 1, 'the privilege log PDF opens');
const anImage = await PDFDocument.load(await azip.entryData(images.sort()[0]));
check(anImage.getPageCount() >= 1, 'a stamped image in the package opens with pdf-lib');
await azip.close();

// Every produced item is in the package, and every withheld item is in the log.
const loggedItems = (await q(`select production_item_id from public.privilege_log_entries where production_id=$1`, [prod.id]))
  .map((r) => r.production_item_id);
check(part.excluded.every((i) => loggedItems.includes(i.id)),
  'every withheld document has a privilege-log entry (nothing disappears unlogged)');

// ---------------------------------------------------------------------------
// 8. Delivery record
// ---------------------------------------------------------------------------
section('delivery record');
const delivery = await one(
  `insert into public.deliveries (matterspace_id, production_id, recipient_name, recipient_email, method,
     package_storage_path, package_sha256, bates_range, created_by)
   values ($1,$2,'Smith & Jones LLP','discovery@smithjones.example','download',$3,$4,$5,$6) returning *`,
  [matter.id, prod.id, packed.package_storage_path, packed.package_sha256,
    `${formatBates('ACME_', 7, packed.bates_start)}-${formatBates('ACME_', 7, packed.bates_end)}`, prof.id],
);
check(delivery.package_sha256 === packed.package_sha256,
  'the delivery record carries the sha256 of exactly what was handed over');
check(delivery.bates_range === 'ACME_0000001-ACME_0000012', 'the delivery record carries the Bates range', delivery.bates_range);

// ---------------------------------------------------------------------------
// 9. The queue Discovery rides on, as the last three months left it
// ---------------------------------------------------------------------------
section('queue contract: 057 priority, 058 sweep, 059 monitor, 060 held');

const matterQ = await one(
  `insert into public.matterspaces (serverspace_id, name, short_code) values ($1,'Queue Fixture','queue-fix') returning id`, [ss.id],
);
const prodQ = await one(
  `insert into public.productions (matterspace_id, direction, name, status) values ($1,'incoming','Queue Fixture Prod','processing') returning *`, [matterQ.id],
);

const enqueue = (matterId, productionId, jobType, payload = {}, status = 'queued') => one(
  `insert into public.processing_jobs (matterspace_id, production_id, job_type, payload, status)
   values ($1,$2,$3,$4::jsonb,$5) returning *`,
  [matterId, productionId, jobType, JSON.stringify(payload), status],
);

const intakeJob = await enqueue(matterQ.id, prodQ.id, 'intake_zip', { storage_paths: ['a/b.zip'], ingest: true });
check(intakeJob.serverspace_id === ss.id,
  "057's BEFORE INSERT trigger stamps serverspace_id on a Discovery job too", String(intakeJob.serverspace_id));
check(Number(intakeJob.priority) === 0, 'a Discovery intake job enqueues at normal priority', String(intakeJob.priority));

const claimed = await q(`select * from public.claim_discovery_job('offline-harness')`);
check(claimed.length === 1 && claimed[0].job_type === 'intake_zip',
  'claim_discovery_job still hands a Discovery job to the worker after 044/045/057',
  claimed[0]?.job_type);
check(Number(claimed[0].attempts) === 1 && claimed[0].heartbeat_at !== null,
  "the claim charges one attempt and opens a heartbeat — the worker's withHeartbeat must keep it alive");
await q(`update public.processing_jobs set status='done', finished_at=now() where id=$1`, [intakeJob.id]);

// The reaper does not touch a Discovery job that is heartbeating.
const liveJob = await enqueue(matterQ.id, prodQ.id, 'stamp_production', {});
await q(`select * from public.claim_discovery_job('offline-harness')`);
await q(`update public.processing_jobs set heartbeat_at = now() where id=$1`, [liveJob.id]);
await q(`select * from public.claim_discovery_job('offline-harness-2')`);
const liveAfter = await one(`select status, attempts from public.processing_jobs where id=$1`, [liveJob.id]);
check(liveAfter.status === 'running' && Number(liveAfter.attempts) === 1,
  'a stamp job that heartbeats is left alone by the reaper');

// A stamp job that STOPS heartbeating is requeued — which for stamping means a
// second run over a half-written Bates range.
await q(`update public.processing_jobs set heartbeat_at = now() - interval '10 minutes' where id=$1`, [liveJob.id]);
await q(`select * from public.claim_discovery_job('offline-harness-3')`);
const reaped = await one(`select status, attempts, claimed_by from public.processing_jobs where id=$1`, [liveJob.id]);
check(reaped.status === 'running' && Number(reaped.attempts) === 2,
  "FINDING: 044's reaper requeues a dead stamp_production and a later claim re-runs it — "
  + 'the re-run hits its own half-written registry rows and dies on "Bates collision" '
  + '(worker/discovery-worker.mjs:758-767); the matter keeps the burned numbers because '
  + 'bates_registry has no DELETE policy (030:330-335)',
  `status=${reaped.status} attempts=${reaped.attempts}`);
await q(`update public.processing_jobs set status='done' where id=$1`, [liveJob.id]);

// Burst demotion reaches Discovery's interactive buttons.
for (let i = 0; i < 10; i++) await enqueue(matterQ.id, null, 'ingest_document', { document_id: crypto.randomUUID() });
const demoted = await enqueue(matterQ.id, prodQ.id, 'package_production', { include_privilege_log: true });
check(Number(demoted.priority) === -10,
  "FINDING: 057's burst rule demotes an interactive Stamp/Package click to bulk priority "
  + 'whenever ten jobs are already queued in that matter (057:130-138) — the lawyer waiting on a '
  + 'package goes behind every other tenant\'s normal work',
  `priority=${demoted.priority}`);

// The clamp: an authenticated caller cannot jump the queue. This is the one
// section that runs as a non-superuser, so 032's RLS policy and 030's
// _disc_matter_access wrapper are both live for it.
// A matter of its own, so the burst rule above does not also fire and mask
// what the clamp did.
const matterC = await one(
  `insert into public.matterspaces (serverspace_id, name, short_code) values ($1,'Clamp Fixture','clamp-fix') returning id`, [ss.id],
);
const prodC = await one(
  `insert into public.productions (matterspace_id, direction, name, status) values ($1,'outgoing','Clamp Prod','review') returning *`, [matterC.id]);
await db.exec(`set harness.uid = '${owner}'`);
await db.exec('set role authenticated');
const clamped = await one(
  `insert into public.processing_jobs (matterspace_id, production_id, job_type, payload, status, priority)
   values ($1,$2,'stamp_production','{}'::jsonb,'queued',100) returning *`, [matterC.id, prodC.id],
);
await db.exec('reset role');
const raised = await one(
  `insert into public.processing_jobs (matterspace_id, production_id, job_type, payload, status, priority)
   values ($1,$2,'package_production','{}'::jsonb,'queued',5) returning *`, [matterC.id, prodC.id],
);
check(Number(raised.priority) === 5, 'the service role may still raise a job above 0 (the worker\'s own door)', String(raised.priority));
check(Number(clamped.priority) === 0,
  'an authenticated caller asking for priority 100 is clamped to 0 (057:126-128) — one tenant '
  + "cannot put its own production in front of everyone else's", String(clamped.priority));
check(clamped.serverspace_id === ss.id,
  "the tenant stamp survives the RLS-enforced path too (030's _disc_matter_access allowed the lookup)");

// 058's recovery sweep must not see Discovery's non-ingest jobs.
const before058 = await q(`select id, status from public.processing_jobs where job_type <> 'ingest_document' order by created_at`);
await q(`update public.processing_jobs set status='error', finished_at=now()-interval '2 days' where job_type='intake_zip'`);
const swept = await one(`select public.recover_stranded_documents(15, 5) as n`);
const after058 = await q(`select id, status from public.processing_jobs where job_type <> 'ingest_document' order by created_at`);
check(JSON.stringify(before058.map((r) => r.id)) === JSON.stringify(after058.map((r) => r.id)),
  "058's recovery sweep mints nothing for Discovery's intake/stamp/package jobs — it only knows ingest_document",
  `returned ${swept.n}`);

// A Discovery-ingested display PDF stranded mid-pipeline IS recovered (correctly).
const strandedDoc = await one(
  `insert into public.documents (matterspace_id, title, source_filename, storage_path, processing_status, metadata, created_at)
   values ($1,'001_Supply_Agreement.pdf','001_Supply_Agreement.pdf','vault/x.pdf','embedding',
           jsonb_build_object('production_id',$2::text,'production_item_id',$3::text), now() - interval '2 hours')
   returning id`, [matterQ.id, prodQ.id, byName['001_Supply_Agreement.pdf'].id],
);
const n2 = await one(`select public.recover_stranded_documents(15, 5) as n`);
const recovered = await one(`select processing_status from public.documents where id=$1`, [strandedDoc.id]);
const newJob = await one(`select job_type, payload from public.processing_jobs where payload->>'document_id' = $1`, [strandedDoc.id]);
check(Number(n2.n) === 1 && recovered.processing_status === 'pending' && newJob?.job_type === 'ingest_document',
  'a production document stranded mid-ingest is picked back up by the sweep as an ingest_document job',
  `n=${n2.n} status=${recovered.processing_status}`);

// 059 sees the production's un-indexed documents, and folds the duplicate pair.
await q(`update public.documents set processing_status='ready' where id=$1`, [strandedDoc.id]);
const twinA = await one(
  `insert into public.documents (matterspace_id, title, source_filename, file_size_bytes, storage_path, processing_status)
   values ($1,'dup','007_Supply_Agreement_COPY.pdf',4242,'vault/a.pdf','ready') returning id`, [matterQ.id]);
const twinB = await one(
  `insert into public.documents (matterspace_id, title, source_filename, file_size_bytes, storage_path, processing_status)
   values ($1,'dup','007_Supply_Agreement_COPY.pdf',4242,'vault/b.pdf','ready') returning id`, [matterQ.id]);
await q(`insert into public.passages (document_id, matterspace_id, sequence_number) values ($1,$2,1)`, [twinA.id, matterQ.id]);
const empty = await q(`select * from public.ready_but_empty()`);
const emptyIds = empty.map((r) => r.document_id);
check(emptyIds.includes(strandedDoc.id),
  "059's monitor reports a production document that is 'ready' with no text behind it");
check(empty.find((r) => r.document_id === twinB.id)?.has_indexed_twin === true,
  '059 folds the produced duplicate into has_indexed_twin instead of flagging it twice');

// 060: a held Discovery job is inert — and that is also where a production can stick.
const heldProd = await one(
  `insert into public.productions (matterspace_id, direction, name, status) values ($1,'outgoing','Sealed Matter Prod','processing') returning *`, [matterQ.id]);
await enqueue(matterQ.id, heldProd.id, 'intake_zip', { storage_paths: ['s/x.zip'] }, 'held');
const claimAttempts = [];
for (let i = 0; i < 3; i++) {
  const r = await q(`select * from public.claim_discovery_job('held-probe')`);
  if (r.length) { claimAttempts.push(r[0].job_type); await q(`update public.processing_jobs set status='done' where id=$1`, [r[0].id]); }
}
check(!claimAttempts.includes('intake_zip') || claimAttempts.filter((t) => t === 'intake_zip').length === 0,
  "a held intake_zip is never claimed (claim_discovery_job takes only 'queued')");
const heldProdRow = await one(`select status from public.productions where id=$1`, [heldProd.id]);
check(heldProdRow.status === 'processing',
  'FINDING: holdJob (worker/discovery-worker.mjs:244-256) parks the job but writes nothing to '
  + "productions, so a held intake leaves the production at 'processing' with no worker, no error "
  + 'and no way for the UI to say what happened. Latent today — ingestDisplayPdf (worker:592-603) '
  + 'swallows the seal — but it is the behaviour if any intake step ever refuses.',
  heldProdRow.status);

// ---------------------------------------------------------------------------
// 10. Drift guards over the worker source
// ---------------------------------------------------------------------------
section('drift guards: the worker still matches what section 3-7 transcribes');
const workerSrc = fs.readFileSync(path.resolve(ROOT, 'worker', 'discovery-worker.mjs'), 'utf8');
const dispatched = [...workerSrc.matchAll(/case '([a-z_]+)': return \w+\(job\);/g)].map((m) => m[1]);
check(dispatched.join(',') === 'intake_zip,intake_files,intake_folder,stamp_production,package_production,ingest_document',
  'dispatch() still routes exactly the six job types this harness models', dispatched.join(','));
check((workerSrc.match(/setProductionStatus\(prod\.id, 'review'\)/g) || []).length === 3,
  "all three intake paths still end at production status 'review'");
check(/order by priority desc, created_at/.test(fs.readFileSync(path.resolve(ROOT, 'supabase/migrations/057_processing_jobs_priority.sql'), 'utf8')),
  'the claim order this harness asserts is the one 057 installs');
check(/claim_discovery_job/.test(workerSrc) && /p_worker: WORKER_ID/.test(workerSrc),
  'the worker still claims through claim_discovery_job(p_worker)');
check(/from\('bates_registry'\)\.insert\(rows\.slice/.test(workerSrc),
  'stamping still writes bates_registry rows in batches, one row per page');
// Known gap, asserted so the check flips the day someone fixes it.
const cliBlock = workerSrc.slice(workerSrc.indexOf('async function directFolderIntake'));
check(/status: 'running'/.test(cliBlock) && !/withHeartbeat/.test(cliBlock.slice(0, 1200)),
  'KNOWN GAP (still present): directFolderIntake inserts its job as running and calls intakeFolder '
  + 'outside withHeartbeat (worker:1002-1015) — only per-file progress() refreshes heartbeat_at, so a '
  + "single slow file lets 044's reaper requeue it and a Fly worker then claims an intake_folder job "
  + 'whose local_path exists only on the operator\'s laptop. Flip this check when it is fixed.');

// ---------------------------------------------------------------------------
await fsp.rm(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0
  ? `Discovery pipeline verified offline: ${checks} checks passed.`
  : `${failures} FAILURE(S) of ${checks} checks`}\n`);
process.exit(failures === 0 ? 0 : 1);

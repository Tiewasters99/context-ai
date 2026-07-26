// Grapheon Discovery — LIVE end-to-end test against the real Supabase project.
//
// Creates (or reuses) a sandbox matter "Discovery Sandbox" (short_code
// disc-sandbox), builds sample discovery files in a temp folder, then drives
// the full pipeline exactly as production would:
//
//   intake (worker --intake) -> preset tags + Privileged/Confidential tagging
//   -> privilege log entry -> stamp_production -> package_production
//   -> download the package and audit its contents.
//
// Everything lands in the sandbox matter only. Run: node worker/e2e-live-test.mjs

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { loadEnv } from '../lib/discovery/util.mjs';
import { parseDat, canonicalizeDatRecord } from '../lib/discovery/loadfile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : `  <- ${detail}`}`);
  if (!cond) failures++;
};
const die = (msg) => { console.error(`e2e: ${msg}`); process.exit(1); };

// ---------------------------------------------------------------------------
// 0. Schema sanity
// ---------------------------------------------------------------------------
for (const table of ['productions', 'production_items', 'document_tag_defs',
  'document_tags', 'bates_registry', 'privilege_log_entries', 'deliveries', 'processing_jobs']) {
  const { error } = await supabase.from(table).select('id', { head: true, count: 'exact' }).limit(1);
  check(`table ${table} exists`, !error, error?.message);
}
if (failures) die('schema missing — was migration 030 applied?');

// ---------------------------------------------------------------------------
// 1. Sandbox matter
// ---------------------------------------------------------------------------
let { data: matter } = await supabase.from('matterspaces')
  .select('id, name, serverspace_id').eq('short_code', 'disc-sandbox').maybeSingle();
if (!matter) {
  const { data: ss, error: ssErr } = await supabase.from('serverspaces').select('id, name').limit(1).single();
  if (ssErr) die(`no serverspace found: ${ssErr.message}`);
  const { data: created, error: mErr } = await supabase.from('matterspaces').insert({
    serverspace_id: ss.id,
    name: 'Discovery Sandbox',
    description: 'Test matter for the Grapheon Discovery module (safe to delete).',
    short_code: 'disc-sandbox',
  }).select('id, name, serverspace_id').single();
  if (mErr) die(`create sandbox matter: ${mErr.message}`);
  matter = created;
}
console.log(`     sandbox matter: ${matter.name} (${matter.id})`);

const { data: owner } = await supabase.from('serverspace_members')
  .select('user_id').eq('serverspace_id', matter.serverspace_id).eq('role', 'owner').limit(1).single();

// ---------------------------------------------------------------------------
// 2. Sample discovery files
// ---------------------------------------------------------------------------
const fixtures = path.join(os.tmpdir(), `disc-e2e-${crypto.randomUUID().slice(0, 8)}`);
await fs.mkdir(fixtures, { recursive: true });

async function makePdf(file, title, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(title, { x: 72, y: 710, size: 14, font });
    p.drawText(`Page ${i + 1} of ${pages}. This document concerns the widget supply `
      + `agreement between Acme Corp and Webster Industries, including delivery `
      + `schedules and indemnification obligations.`, { x: 72, y: 680, size: 10, font, maxWidth: 470, lineHeight: 14 });
  }
  await fs.writeFile(path.join(fixtures, file), await doc.save());
}
await makePdf('001_Supply_Agreement.pdf', 'WIDGET SUPPLY AGREEMENT', 3);
await makePdf('002_Board_Minutes.pdf', 'BOARD MINUTES - Q3', 2);
await makePdf('003_Counsel_Memo.pdf', 'MEMO FROM OUTSIDE COUNSEL RE LITIGATION RISK', 2);

const sharp = (await import('sharp')).default;
await fs.writeFile(path.join(fixtures, '004_Warehouse_Scan.tif'),
  await sharp({ create: { width: 850, height: 1100, channels: 3, background: { r: 248, g: 246, b: 240 } } })
    .tiff().toBuffer());

await fs.writeFile(path.join(fixtures, '005_Damages_Model.xlsx'),
  Buffer.from('PK\x03\x04 fake xlsx for e2e'));

await fs.writeFile(path.join(fixtures, '006_Privileged_Email.eml'), Buffer.from(
  'From: Alice Counsel <acounsel@firmllp.com>\r\n'
  + 'To: Dan Director <dan@websterind.com>\r\n'
  + 'Cc: Carol GC <carol@websterind.com>\r\n'
  + 'Subject: Legal advice re indemnification exposure\r\n'
  + 'Date: Tue, 4 Mar 2025 10:00:00 -0500\r\n\r\n'
  + 'Privileged and confidential legal advice follows.\r\n'));
console.log(`     fixtures: ${fixtures}`);

// ---------------------------------------------------------------------------
// 3. Production + intake via the real worker CLI
// ---------------------------------------------------------------------------
const { data: prod, error: prodErr } = await supabase.from('productions').insert({
  matterspace_id: matter.id,
  direction: 'outgoing',
  name: `E2E Test Production ${new Date().toISOString().slice(0, 16)}`,
  receiving_party: 'Smith & Jones LLP',
  request_refs: 'RFP Nos. 1-12',
  bates_position: 'lower_right',
  created_by: owner?.user_id ?? null,
}).select().single();
if (prodErr) die(`create production: ${prodErr.message}`);
console.log(`     production: ${prod.id}`);

function runWorker(args) {
  const r = spawnSync(process.execPath, ['worker/discovery-worker.mjs', ...args], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 600000,
  });
  if (r.stdout) process.stdout.write(r.stdout.split('\n').map((l) => `       ${l}`).join('\n') + '\n');
  if (r.status !== 0) {
    process.stderr.write(r.stderr ?? '');
    die(`worker exited ${r.status}`);
  }
}

console.log('     -- intake (worker --intake) --');
runWorker(['--intake', fixtures, '--production', prod.id]);

const { data: items } = await supabase.from('production_items')
  .select('*').eq('production_id', prod.id).order('sort_order');
check('6 items intaken', items.length === 6, `got ${items.length}`);
check('all items ready', items.every((i) => i.status === 'ready'),
  items.filter((i) => i.status !== 'ready').map((i) => `${i.original_filename}: ${i.error}`).join('; '));
const byName = Object.fromEntries(items.map((i) => [i.original_filename, i]));
check('PDF item has display path', !!byName['001_Supply_Agreement.pdf']?.display_storage_path);
check('PDF page_count', byName['001_Supply_Agreement.pdf']?.page_count === 3);
check('TIFF converted to display PDF',
  byName['004_Warehouse_Scan.tif']?.kind === 'display_pdf' && !!byName['004_Warehouse_Scan.tif']?.display_storage_path);
check('xlsx stayed native', byName['005_Damages_Model.xlsx']?.kind === 'native');
check('eml metadata extracted', byName['006_Privileged_Email.eml']?.source_metadata?.author?.includes('acounsel@firmllp.com'));
check('sha256 recorded on all items', items.every((i) => /^[0-9a-f]{64}$/.test(i.sha256 ?? '')));

const { data: prodAfterIntake } = await supabase.from('productions').select('status').eq('id', prod.id).single();
check('production status -> review', prodAfterIntake.status === 'review', prodAfterIntake.status);

const docIds = items.map((i) => i.document_id).filter(Boolean);
check('display PDFs ingested into corpus', docIds.length >= 4, `${docIds.length} documents linked`);

// ---------------------------------------------------------------------------
// 4. Tags (presets seeded like the frontend does) + privilege log
// ---------------------------------------------------------------------------
const PRESETS = [
  { name: 'Privileged', color: '#b91c1c', is_endorsement: true, endorsement_text: 'PRIVILEGED', behavior: 'privileged', is_preset: true },
  { name: 'Hot Doc', color: '#d97706', is_endorsement: false, behavior: null, is_preset: true },
  { name: 'Confidential', color: '#1d4ed8', is_endorsement: true, endorsement_text: 'CONFIDENTIAL', behavior: null, is_preset: true },
  { name: 'Non-Responsive', color: '#6b7280', is_endorsement: false, behavior: 'non_responsive', is_preset: true },
];
for (const p of PRESETS) {
  await supabase.from('document_tag_defs')
    .upsert({ ...p, matterspace_id: matter.id }, { onConflict: 'matterspace_id,name', ignoreDuplicates: true });
}
const { data: defs } = await supabase.from('document_tag_defs')
  .select('*').eq('matterspace_id', matter.id);
const defByName = Object.fromEntries(defs.map((d) => [d.name, d]));
check('preset tag defs seeded', ['Privileged', 'Hot Doc', 'Confidential', 'Non-Responsive'].every((n) => defByName[n]));

async function tag(item, defName) {
  const { error } = await supabase.from('document_tags').insert({
    tag_def_id: defByName[defName].id, production_item_id: item.id, matterspace_id: matter.id,
  });
  if (error && !/duplicate/i.test(error.message)) die(`tag ${defName}: ${error.message}`);
}
await tag(byName['003_Counsel_Memo.pdf'], 'Privileged');        // withheld
await tag(byName['006_Privileged_Email.eml'], 'Privileged');    // withheld (native)
await tag(byName['002_Board_Minutes.pdf'], 'Confidential');     // endorsed
await tag(byName['001_Supply_Agreement.pdf'], 'Hot Doc');       // internal only

for (const it of [byName['003_Counsel_Memo.pdf'], byName['006_Privileged_Email.eml']]) {
  const m = it.source_metadata ?? {};
  await supabase.from('privilege_log_entries').upsert({
    matterspace_id: matter.id, production_id: prod.id, production_item_id: it.id,
    author: m.author ?? 'Alice Counsel', addressee: m.to ?? 'Dan Director', cc: m.cc ?? '',
    subject_matter: m.subject ?? 'Legal advice regarding litigation risk',
    basis: 'attorney_client',
    description: 'Communication seeking/providing legal advice.',
  }, { onConflict: 'production_item_id' });
}

// ---------------------------------------------------------------------------
// 5. Stamp
// ---------------------------------------------------------------------------
await supabase.from('productions').update({ bates_prefix: 'SBX_', bates_pad: 7 }).eq('id', prod.id);
const { data: stampJob } = await supabase.from('processing_jobs').insert({
  matterspace_id: matter.id, production_id: prod.id, job_type: 'stamp_production', payload: {},
}).select().single();
console.log('     -- stamp (worker --once) --');
runWorker(['--once']);

const { data: stampJobAfter } = await supabase.from('processing_jobs').select('status, error').eq('id', stampJob.id).single();
check('stamp job done', stampJobAfter.status === 'done', stampJobAfter.error);

const { data: prodStamped } = await supabase.from('productions').select('*').eq('id', prod.id).single();
check('production stamped + locked', prodStamped.status === 'stamped' && !!prodStamped.locked_at);
// Included: 001 (3pp) + 002 (2pp) + 004 tif (1p) + 005 xlsx slip (1p) = 7 pages
const { data: registry } = await supabase.from('bates_registry')
  .select('bates_number, bates_seq, page_number').eq('production_id', prod.id).order('bates_seq');
check('registry rows = 7 pages', registry.length === 7, `got ${registry.length}`);
check('bates range recorded', prodStamped.bates_end - prodStamped.bates_start === 6,
  `${prodStamped.bates_start}-${prodStamped.bates_end}`);

const { data: itemsStamped } = await supabase.from('production_items')
  .select('original_filename, bates_first, bates_last').eq('production_id', prod.id).order('sort_order');
const stampedByName = Object.fromEntries(itemsStamped.map((i) => [i.original_filename, i]));
check('privileged PDF NOT stamped', stampedByName['003_Counsel_Memo.pdf'].bates_first === null);
check('privileged eml NOT stamped', stampedByName['006_Privileged_Email.eml'].bates_first === null);
check('native xlsx got one bates number',
  stampedByName['005_Damages_Model.xlsx'].bates_first === stampedByName['005_Damages_Model.xlsx'].bates_last
  && stampedByName['005_Damages_Model.xlsx'].bates_first !== null);

// Lock guard: adding an item to a stamped production must fail.
const { error: lockErr } = await supabase.from('production_items').insert({
  production_id: prod.id, matterspace_id: matter.id, sort_order: 99,
  original_filename: 'late_addition.pdf',
});
check('lock guard blocks late additions', !!lockErr, 'insert unexpectedly succeeded');

// Registry immutability: a second stamp over the same range must collide.
const { data: collideJob } = await supabase.from('processing_jobs').insert({
  matterspace_id: matter.id, production_id: prod.id, job_type: 'stamp_production', payload: {},
}).select().single();
runWorker(['--once']);
const { data: collideAfter } = await supabase.from('processing_jobs').select('status, error').eq('id', collideJob.id).single();
check('re-stamp rejected (already stamped)', collideAfter.status === 'error', collideAfter.error);

// ---------------------------------------------------------------------------
// 6. Package + audit the ZIP
// ---------------------------------------------------------------------------
const { data: pkgJob } = await supabase.from('processing_jobs').insert({
  matterspace_id: matter.id, production_id: prod.id, job_type: 'package_production',
  payload: { include_privilege_log: true },
}).select().single();
console.log('     -- package (worker --once) --');
runWorker(['--once']);
const { data: pkgJobAfter } = await supabase.from('processing_jobs').select('status, error').eq('id', pkgJob.id).single();
check('package job done', pkgJobAfter.status === 'done', pkgJobAfter.error);

const { data: prodPkg } = await supabase.from('productions').select('*').eq('id', prod.id).single();
check('production packaged', prodPkg.status === 'packaged');
check('package sha256 recorded', /^[0-9a-f]{64}$/.test(prodPkg.package_sha256 ?? ''));

const { data: pkgBlob, error: dlErr } = await supabase.storage.from('discovery-files').download(prodPkg.package_storage_path);
check('package downloads', !dlErr, dlErr?.message);
const pkgBuf = Buffer.from(await pkgBlob.arrayBuffer());
check('package sha256 matches download',
  crypto.createHash('sha256').update(pkgBuf).digest('hex') === prodPkg.package_sha256);

const tmpPkg = path.join(os.tmpdir(), `disc-e2e-pkg-${crypto.randomUUID().slice(0, 8)}.zip`);
await fs.writeFile(tmpPkg, pkgBuf);
const StreamZip = (await import('node-stream-zip')).default;
const zip = new StreamZip.async({ file: tmpPkg });
const names = Object.keys(await zip.entries());
const images = names.filter((n) => /\/IMAGES\//.test(n));
const natives = names.filter((n) => /\/NATIVES\//.test(n));
check('IMAGES has 4 stamped PDFs', images.length === 4, images.join(', '));
check('NATIVES has the xlsx', natives.length === 1 && natives[0].endsWith('.xlsx'), natives.join(', '));
check('privileged docs NOT in package',
  !names.some((n) => /Counsel_Memo|Privileged_Email/i.test(n)));
check('load file present', names.some((n) => n.endsWith('DATA/loadfile.dat')));
check('privilege log present', names.some((n) => n.endsWith('PrivilegeLog.pdf')));
check('production letter present', names.some((n) => n.endsWith('ProductionLetter.pdf')));

const datEntry = names.find((n) => n.endsWith('DATA/loadfile.dat'));
const { records } = parseDat(await zip.entryData(datEntry));
check('DAT has 4 records', records.length === 4, `got ${records.length}`);
const confRec = records.map(canonicalizeDatRecord)
  .find((r) => r.filename === '002_Board_Minutes.pdf');
check('CONFIDENTIAL designation in DAT', confRec?.dat?.confidentiality === 'CONFIDENTIAL');

// Stamped PDF spot check: first image loads and has the right page count.
const firstImg = await zip.entryData(images.sort()[0]);
check('first stamped PDF loads (3pp)', (await PDFDocument.load(firstImg)).getPageCount() === 3);
await zip.close();
await fs.unlink(tmpPkg).catch(() => {});

// ---------------------------------------------------------------------------
// 7. Delivery record
// ---------------------------------------------------------------------------
const { error: delErr } = await supabase.from('deliveries').insert({
  matterspace_id: matter.id, production_id: prod.id,
  recipient_name: 'Smith & Jones LLP', recipient_email: 'discovery@smithjones.example',
  method: 'download', package_storage_path: prodPkg.package_storage_path,
  package_sha256: prodPkg.package_sha256,
  bates_range: `SBX_${String(prodPkg.bates_start).padStart(7, '0')}-SBX_${String(prodPkg.bates_end).padStart(7, '0')}`,
});
check('delivery recorded', !delErr, delErr?.message);

await fs.rm(fixtures, { recursive: true, force: true });
console.log(failures === 0
  ? `\nAll live E2E checks passed. Sandbox production: ${prod.id} in matter 'Discovery Sandbox'.`
  : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

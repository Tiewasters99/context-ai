// Volume limits (migration 107): the fair-use meter on SCANNED pages, OCR
// packs, and the storage ceiling — proved twice over.
//
//   1. The pipeline (lib/ingest-core.mjs), against the in-memory fake
//      Supabase the other ingest tests use: the meter is asked exactly when
//      OCR is about to be spent and with the right page count; a refusal
//      stores the document as waiting (typed pages indexed, scanned pages
//      recorded with over_allowance and a sentence that names the OCR pack);
//      a text-layer document never asks at all; the hook fails open.
//   2. The database (migration 107 EXECUTED on PGlite, after 062/063/067,
//      twice): seeds; the storage total and ceiling; ocr_pages_reserve's
//      allowance → pack → one-document overshoot → refusal; retry is free;
//      ocr_pack_grant's idempotency and its wake-up of waiting documents;
//      an unknown tier is 'free', 'workshop' is unlimited; a signed-in user
//      reads their own rows, writes none and cannot call the reserve RPC.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-volume-limits.mjs
//
// No network, no .env, no prod, no Stripe.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processDocument, buildOcrPending } from '../lib/ingest-core.mjs';
import { describeOcrPending } from '../lib/ingest-formats.mjs';
import { makeOcrAllowance, overAllowanceReason } from '../lib/ocr-allowance.mjs';
import { buildPdf, proseLines, stampedScanPdf } from './_fixtures-ingest.mjs';
import { fakeSupabase, stubEmbeddings } from './_fake-supabase.mjs';

let failures = 0;
let passes = 0;
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (cond) passes += 1; else failures += 1;
};

// =============================================================================
// 1. The pipeline
// =============================================================================
console.log('\n[1] pipeline: the meter is asked before OCR, and a refusal waits honestly');
{
  const restoreFetch = stubEmbeddings();
  const MATTER = '00000000-0000-4000-8000-000000000001';
  const DOC = '00000000-0000-4000-8000-0000000000d0';
  const seed = (name = 'Order.pdf') => fakeSupabase({
    matterspaces: [{ id: MATTER, parent_matterspace_id: null, ai_tier: 'A', name: 'Test' }],
    documents: [{ id: DOC, matterspace_id: MATTER, source_filename: name, witness_name: null, metadata: {}, processing_status: 'pending', storage_path: `${MATTER}/${DOC}/${name}` }],
    passages: [],
  });
  const docOf = (db) => db.tables.documents.find((d) => d.id === DOC);
  const passagesOf = (db) => db.tables.passages.filter((p) => p.document_id === DOC);
  const ocrReads = async (buf) => [{ pageNumber: 1, text: 'ORDER\nThe tamarind motion is granted.\nSO ORDERED.' }, { pageNumber: 2, text: 'The bergamot schedule follows.\nSO ORDERED.' }];
  const scan = await stampedScanPdf({ words: ['tamarind', 'bergamot'] });

  // a) refused: an all-scanned PDF is stored waiting, OCR never called.
  {
    const asked = [];
    let ocrCalled = false;
    const db = seed();
    await processDocument(db, {
      documentId: DOC, fileBuf: scan, ext: '.pdf', openaiApiKey: 'sk-test',
      ocr: async (b) => { ocrCalled = true; return ocrReads(b); },
      ocrAllowance: async (q) => { asked.push(q); return { allowed: false, reason: 'ocr_allowance_exhausted', need: q.pages }; },
    });
    const d = docOf(db);
    check(asked.length === 1 && asked[0].documentId === DOC && asked[0].pages === 2, 'the meter is asked once, for the 2 scanned pages of this document', JSON.stringify(asked));
    check(!ocrCalled, 'OCR is not spent when the meter refuses');
    check(d.processing_status === 'ready' && d.metadata.text_status === 'ocr_pending', 'stored (ready, ocr_pending) — not an error');
    const p = d.metadata.ocr_pending;
    check(p?.over_allowance === true && p.next_retry_at === null && /^\d{4}-\d{2}$/.test(p.month || ''), 'ocr_pending marks over_allowance, no timer, the month', JSON.stringify(p));
    check(Array.isArray(p?.pages) && p.pages.join() === '1,2', 'the waiting pages are recorded');
    check(/OCR pack/.test(p?.reason || '') && /Settings › Billing/.test(p?.reason || ''), 'the reason names the OCR pack and where to buy it');
    check(d.metadata.ingest_outcome?.ocr === 'over_allowance', 'ingest_outcome.ocr = over_allowance');
    check(passagesOf(db).length === 0, 'nothing indexed from a stamp-only scan');
  }

  // b) allowed: OCR runs as before.
  {
    const db = seed();
    await processDocument(db, {
      documentId: DOC, fileBuf: scan, ext: '.pdf', openaiApiKey: 'sk-test', ocr: ocrReads,
      ocrAllowance: async () => ({ allowed: true, charged: 2 }),
    });
    const d = docOf(db);
    check(d.metadata.ingest_outcome?.ocr === 'read' && !d.metadata.ocr_pending, 'allowed → OCR reads the pages, nothing waiting');
    check(passagesOf(db).some((x) => /tamarind/.test(x.text)), 'the OCR text is indexed');
  }

  // c) mixed document refused: typed pages indexed, scanned page waits.
  {
    const mixed = await buildPdf([
      { text: proseLines(1) },
      { scan: ['EXHIBIT A', 'The juniper invoice is attached.'] },
    ]);
    const asked = [];
    const db = seed('Brief.pdf');
    await processDocument(db, {
      documentId: DOC, fileBuf: mixed, ext: '.pdf', openaiApiKey: 'sk-test',
      ocr: async () => { throw new Error('OCR must not run'); },
      ocrAllowance: async (q) => { asked.push(q.pages); return { allowed: false }; },
    });
    const d = docOf(db);
    check(asked.join() === '1', 'mixed brief: the meter is asked for the 1 scanned page only', JSON.stringify(asked));
    check(!d.metadata.text_status && passagesOf(db).length > 0, 'the typed page is indexed and searchable');
    check(d.metadata.ocr_pending?.over_allowance === true && d.metadata.ocr_pending.pages.join() === '2', 'the scanned page 2 waits on the allowance');
  }

  // d) a text-layer document never asks.
  {
    const typed = await buildPdf([{ text: proseLines(1) }, { text: proseLines(2) }]);
    let asked = 0;
    const db = seed('Westlaw.pdf');
    await processDocument(db, {
      documentId: DOC, fileBuf: typed, ext: '.pdf', openaiApiKey: 'sk-test', ocr: ocrReads,
      ocrAllowance: async () => { asked++; return { allowed: false }; },
    });
    check(asked === 0 && passagesOf(db).length > 0, 'a born-digital PDF (a Westlaw opinion) never touches the meter');
  }

  // e) a JPEG is one scanned page.
  {
    const { default: sharp } = await import('sharp');
    const jpg = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const asked = [];
    const db = seed('page.jpg');
    await processDocument(db, {
      documentId: DOC, fileBuf: jpg, ext: '.jpg', openaiApiKey: 'sk-test',
      ocr: async () => { throw new Error('OCR must not run'); },
      ocrAllowance: async (q) => { asked.push(q.pages); return { allowed: false }; },
    });
    const d = docOf(db);
    check(asked.join() === '1', 'a photographed page is metered as 1 page', JSON.stringify(asked));
    check(d.metadata.text_status === 'ocr_pending' && d.metadata.ocr_pending?.over_allowance === true, 'and waits on the allowance when refused');
  }

  restoreFetch();

  // f) the record and its wording.
  const prior = { ocr_pending: { attempts: 3, pages: [1] } };
  const rec = buildOcrPending(prior, { pages: [4, 5], pageCount: 9, overAllowance: true, reason: overAllowanceReason({ need: 2 }, 2) });
  check(rec.attempts === 3 && !rec.exhausted && rec.next_retry_at === null, 'waiting on money is not an attempt and never exhausts');
  const said = describeOcrPending(rec);
  check(/OCR allowance used up/.test(said.label) && /2 scanned pages are waiting/.test(said.detail), 'the Vault label and detail say what is happening', said.label);

  // g) fail open.
  const down = makeOcrAllowance({ SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' },
    { fetchImpl: async () => new Response('boom', { status: 500 }) });
  const r1 = await down({ documentId: 'd', pages: 3 });
  const thrown = makeOcrAllowance({ SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' },
    { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  const r2 = await thrown({ documentId: 'd', pages: 3 });
  check(r1.allowed && r2.allowed, 'a 500 or a network error allows the OCR (fail open)');
  check(makeOcrAllowance({}) === null, 'no service key → no meter at all');
  let sent = null;
  const live = makeOcrAllowance({ SUPABASE_URL: 'https://x.test/', SUPABASE_SERVICE_ROLE_KEY: 'svc' },
    { fetchImpl: async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ allowed: false, need: 3 }), { status: 200 }); } });
  const r3 = await live({ documentId: 'doc-1', pages: 3 });
  check(!r3.allowed && sent.url === 'https://x.test/rest/v1/rpc/ocr_pages_reserve'
    && JSON.parse(sent.init.body).p_pages === 3 && sent.init.headers.authorization === 'Bearer svc',
  'the hook calls ocr_pages_reserve with the service key and passes a refusal through');
}

// =============================================================================
// 2. The database
// =============================================================================
console.log('\n[2] database: migration 107 on a real Postgres');
let PGlite, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(path.resolve(__dirname, '..'), 'supabase', 'migrations');
const migration = (name) => fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');

async function refused(db, sql, params = []) {
  try { await db.query(sql, params); return null; } catch (err) { return err?.code || 'error'; }
}

// The same chain scripts/_verify-billing.mjs builds, with documents carrying
// the columns 107 reads (metadata, processing_status).
const db = new PGlite({ extensions: { uuid_ossp } });
await db.exec(`
  do $$ begin create role anon;                     exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated;            exception when duplicate_object then null; end $$;
  do $$ begin create role service_role bypassrls;   exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create schema if not exists storage;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid
  $$;
  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid,
    created_by uuid,
    page_count int,
    file_size_bytes bigint,
    metadata jsonb,
    processing_status text default 'pending',
    ingested_at timestamptz,
    created_at timestamptz not null default now()
  );
  create table public.passages (id uuid primary key default gen_random_uuid(), matterspace_id uuid);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create or replace function storage.foldername(p_name text)
  returns text[] language sql immutable as $$ select string_to_array(p_name, '/') $$;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
`);
for (const m of ['001_initial_schema.sql', '005_fix_rls_recursion.sql', '008_submatters.sql',
                 '016_matterspace_members.sql', '022_matterspaces_rls_invoker_wrappers.sql', '051_securespace.sql']) {
  await db.exec(migration(m));
}
await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;`);
await db.exec(`alter table public.documents enable row level security;`);
await db.exec(migration('062_profiles_rls_plan.sql'));
await db.exec(migration('063_usage_budgets.sql'));
await db.exec(migration('067_billing_and_credits.sql'));

// Documents that exist BEFORE 107 — the backfill must count them.
const asOwner = () => db.exec(`reset role; set request.jwt.claim.sub = '';`);
const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claim.sub = '${id}';`);
async function makeUser(tier = 'free') {
  await asOwner();
  const { rows } = await db.query(`insert into auth.users (email) values ($1) returning id`, [`u${Math.random().toString(36).slice(2, 10)}@example.test`]);
  const id = rows[0].id;
  await db.query(`insert into public.profiles (id, email) values ($1, $2) on conflict (id) do nothing`, [id, `${id}@example.test`]);
  if (tier !== 'free') await db.query(`update public.profiles set pricing_tier = $2 where id = $1`, [id, tier]);
  return id;
}
const early = await makeUser('basic');
await db.query(`insert into public.documents (created_by, file_size_bytes) values ($1, 1000), ($1, 2500)`, [early]);

let applied = true;
try {
  await db.exec(migration('107_volume_limits_and_ocr_packs.sql'));
  await db.exec(`update public.volume_limits set note = 'edited by Eden' where pricing_tier = 'pro';`);
  await db.exec(migration('107_volume_limits_and_ocr_packs.sql'));
} catch (err) {
  applied = false;
  console.error(err);
}
await db.exec(`grant all on all tables in schema public to service_role;`);
check(applied, '107 applies after 062/063/067, and re-applies cleanly');

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
await asOwner();
const limits = (await db.query(`select pricing_tier, monthly_ocr_pages, storage_bytes from public.volume_limits order by pricing_tier`)).rows;
const byTier = Object.fromEntries(limits.map((r) => [r.pricing_tier, r]));
check(byTier.free?.monthly_ocr_pages === 500 && byTier.basic?.monthly_ocr_pages === 10000
  && byTier.pro?.monthly_ocr_pages === 30000 && byTier.max?.monthly_ocr_pages === 75000
  && byTier.workshop?.monthly_ocr_pages === null && byTier.workshop?.storage_bytes === null,
'seeds: 500 / 10,000 / 30,000 / 75,000 scanned pages, workshop unlimited');
check((await one(`select note from public.volume_limits where pricing_tier = 'pro'`)).note === 'edited by Eden', 'a re-paste does not clobber an edited row');
const pack = await one(`select * from public.billing_ocr_packs where pack_key = 'ocr_10k'`);
check(pack && pack.active === false && pack.pages === 10000, 'the OCR pack ships inactive (10,000 pages) until Eden sets the price');
check(Number((await one(`select bytes from public.storage_usage where user_id = $1`, [early])).bytes) === 3500, 'backfill: storage_usage counts documents that predate 107');

// --- storage ---------------------------------------------------------------
{
  const u = await makeUser('free');
  await db.exec(`update public.volume_limits set storage_bytes = 10000 where pricing_tier = 'free';`);
  const ins = (bytes) => db.query(`insert into public.documents (created_by, file_size_bytes) values ($1, $2) returning id`, [u, bytes]);
  const d1 = (await ins(6000)).rows[0].id;
  const code = await refused(db, `insert into public.documents (created_by, file_size_bytes) values ($1, 6000)`, [u]);
  check(code === '53400', 'storage: an insert past the ceiling is refused with 53400', code);
  let msg = '';
  try { await ins(6000); } catch (e) { msg = e.message; }
  check(/storage limit/.test(msg), 'and the refusal is a sentence a person can read', msg.slice(0, 80));
  await db.query(`delete from public.documents where id = $1`, [d1]);
  check(Number((await one(`select bytes from public.storage_usage where user_id = $1`, [u])).bytes) === 0, 'deleting a document gives its bytes back');
  const d2 = (await ins(6000)).rows[0].id;
  await db.query(`update public.documents set file_size_bytes = 9000 where id = $1`, [d2]);
  check(Number((await one(`select bytes from public.storage_usage where user_id = $1`, [u])).bytes) === 9000, 'a size correction moves the total');
  const w = await makeUser('workshop');
  check(await refused(db, `insert into public.documents (created_by, file_size_bytes) values ($1, 999999999999)`, [w]) === null, 'workshop has no storage ceiling');
  await db.exec(`update public.volume_limits set storage_bytes = 5368709120 where pricing_tier = 'free';`);
}

// --- the scanned-page meter ------------------------------------------------
const reserve = async (doc, pages) => (await one(`select public.ocr_pages_reserve($1, $2) as r`, [doc, pages])).r;
const newDoc = async (user) => (await one(`insert into public.documents (created_by, file_size_bytes) values ($1, 10) returning id`, [user])).id;
let grantSeq = 1;
const grant = async (user, pages, o = {}) => (await one(
  `select public.ocr_pack_grant($1, $2, $3, $4, $5) as r`,
  [o.event ?? `evt_ocr_${grantSeq++}`, user, pages, 'ocr_10k', o.session ?? null])).r;
{
  const u = await makeUser('free');            // 500 scanned pages
  const a = await newDoc(u); const b = await newDoc(u); const c = await newDoc(u);

  const r1 = await reserve(a, 300);
  check(r1.allowed && Number(r1.charged) === 300 && Number(r1.from_allowance) === 300, 'reserve: 300 of 500 from the allowance');
  const r2 = await reserve(a, 300);
  check(r2.allowed && Number(r2.charged) === 0, 'the same document again (a retry) is charged nothing');
  const r3 = await reserve(a, 400);
  check(r3.allowed && Number(r3.charged) === 100, 'a re-run that reads more pages pays only the difference');
  const r4 = await reserve(b, 300);
  check(r4.allowed && Number(r4.from_allowance) === 100 && Number(r4.over) === 200, 'a document that starts with 100 left is read in full; 200 recorded as overshoot');
  const r5 = await reserve(c, 10);
  check(!r5.allowed && r5.reason === 'ocr_allowance_exhausted' && Number(r5.monthly_ocr_pages) === 500, 'the next document is refused: allowance exhausted, no pack');
  check(Number((await one(`select pages_charged from public.ocr_document_charges where document_id = $1`, [c]))?.pages_charged ?? 0) === 0, 'a refusal charges nothing');

  // A document waiting on the allowance, as ingest-core records it.
  await db.query(`update public.documents set processing_status = 'ready', metadata = $2 where id = $1`,
    [c, JSON.stringify({ text_status: 'ocr_pending', ocr_pending: { pages: [1], over_allowance: true, next_retry_at: null, month: '2026-10' } })]);

  const g1 = await grant(u, 1000, { event: 'evt_pack_A', session: 'cs_A' });
  check(g1.ok && Number(g1.balance_pages) === 1000 && Number(g1.documents_woken) === 1, 'ocr_pack_grant: 1,000 pages, and the waiting document is woken');
  const woke = await one(`select metadata -> 'ocr_pending' ->> 'next_retry_at' as t from public.documents where id = $1`, [c]);
  check(Boolean(woke.t), 'woken = ocr_pending.next_retry_at set, which the worker sweep acts on');
  const g2 = await grant(u, 1000, { event: 'evt_pack_A', session: 'cs_A' });
  const g3 = await grant(u, 1000, { event: 'evt_pack_A2', session: 'cs_A' });
  check(g2.replay && g3.replay && g3.reason === 'session_already_granted', 'a resent event, or the same session under a new event id, grants nothing more');
  const r6 = await reserve(c, 10);
  check(r6.allowed && Number(r6.from_pack) === 10, 'after the purchase the waiting document draws from the pack');
  const bal = await one(`select pages_available from public.ocr_pack_balance where user_id = $1`, [u]);
  check(Number(bal.pages_available) === 990, 'pack balance 990');
  const draw = await one(`select delta_pages from public.ocr_page_ledger where user_id = $1 and entry_kind = 'draw'`, [u]);
  check(Number(draw?.delta_pages) === -10, 'the draw is on the ledger');
  const d = await newDoc(u);
  const r7 = await reserve(d, 5000);
  check(r7.allowed && Number(r7.from_pack) === 990 && Number(r7.over) === 4010, 'the pack never goes negative: 990 drawn, the rest is this document\'s overshoot');
  check(Number((await one(`select pages_available from public.ocr_pack_balance where user_id = $1`, [u])).pages_available) === 0, 'balance 0, not negative');
  check(await refused(db, `update public.ocr_page_ledger set delta_pages = 0 where user_id = $1`, [u]) === '42501', 'the ledger is append-only');

  // Unknown tier → free; workshop → unlimited.
  const odd = await makeUser('free');
  await db.exec(`alter table public.profiles disable trigger user;`);
  await db.query(`update public.profiles set pricing_tier = 'mystery' where id = $1`, [odd]).catch(() => {});
  await db.exec(`alter table public.profiles enable trigger user;`);
  const oddR = await reserve(await newDoc(odd), 600);
  check(oddR.allowed && Number(oddR.from_allowance) === 500 && Number(oddR.over) === 100, 'an unknown tier is metered as free, never unlimited');
  const w = await makeUser('workshop');
  const wr = await reserve(await newDoc(w), 1000000);
  check(wr.allowed && Number(wr.from_allowance) === 1000000, 'workshop is unlimited');

  // RLS and privileges.
  await asUser(u);
  const mine = (await db.query(`select * from public.ocr_month`)).rows;
  check(mine.length === 1 && mine[0].user_id === u, 'a signed-in user reads their own OCR month, and only that');
  check(await refused(db, `insert into public.ocr_pack_balance (user_id, pages_available) values ($1, 999999)`, [u]) !== null, 'and cannot write a pack balance');
  check(await refused(db, `select public.ocr_pages_reserve($1, 1)`, [d]) === '42501', 'and cannot call ocr_pages_reserve');
  check(await refused(db, `select public.ocr_pack_grant('evt_x', $1, 1000)`, [u]) === '42501', 'or ocr_pack_grant');
  check((await db.query(`select * from public.ocr_document_charges`).catch(() => ({ rows: [] }))).rows.length === 0, 'ocr_document_charges is invisible to users');
  const vs = (await one(`select public.volume_status() as s`)).s;
  check(vs && vs.tier === 'free' && Number(vs.monthly_ocr_pages) === 500 && Number(vs.ocr_pages_used) > 500 && Number(vs.ocr_pack_pages) === 0
    && Number(vs.storage_bytes_used) === 40, 'volume_status() reports the caller\'s own allowance, use, pack and storage', JSON.stringify(vs));
  await asOwner();
}

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} checks${failures ? `, ${failures} failed` : ''}`);
process.exit(failures ? 1 : 0);

// A document's stored file lives under the document's own matter — proven in
// the database (migration 097) and at every route that reads bytes with the
// service role after a user-scoped row lookup (lib/storage-path.mjs).
//
// The attack (adversarial review of PR #247): a member of an OPEN matter — or
// an ex-member who kept a path — writes a documents row there whose
// storage_path names an object in a SEALED matter or another firm's matter.
// The export routes read that object with the service role, lib/export-gate
// judges the seal by the POINTER row's matter (open), and the raw bytes leave.
//
//   A. 097 against a real Postgres, twice: a cross-matter path is refused on
//      INSERT and on UPDATE; a same-matter path, a null path, and a MOVE that
//      rewrites matterspace_id and storage_path in one UPDATE are accepted; a
//      move of the matter alone, leaving the path behind, is refused.
//   B. the six call sites, each driven with `fetch` answering as Supabase and
//      the outside services, and handed a POINTER row: /api/cloud-export
//      (OneDrive and Dropbox), /api/drive-export, /api/ext/push-to-drive,
//      /api/gmail-send, /api/ingest, and get_media. Each refuses with ZERO
//      storage requests and nothing sent outside. And each, handed the same
//      row filed correctly, does reach storage (or its own next step) — so
//      the refusal is the check, not a broken stub.
//   C. the helper itself, and a scan: every service-role storage read in
//      api/ that follows a user-scoped documents lookup is preceded by it.
//
// ROUND 2 (adversarial review of #249): a first-segment test is bypassable —
// Storage is reached by URL, and "OPEN/../SEALED/doc/file" starts with OPEN.
// So A also refuses ../, ..\, %2e%2e, a lone ".", "//", four segments and an
// upper-case matter uuid, accepts a real filename, and holds production_items
// paths to "<matter>/<production>/…"; B hands every site those traversal rows
// too, and drives mcp-core's move_document / copy_document /
// assemble_documents / edit_pdf with a SERVICE-ROLE client (the stdio
// server's) — none may reach storage; C holds the discovery worker to its
// source (job paths and production_items paths checked before any download,
// a queued intake_folder refused) and the operator scripts to the helper.
//
// ROUND 3 (the class): D. jobs — a queued job may name only its own matter's
// things. 097's trigger on processing_jobs, as `authenticated`, refuses a
// cross-matter Bucketizer / stamp / package / ingest / intake job and accepts
// the same-matter one of each; lib/job-scope.mjs, as the service role, refuses
// the same set; runBucketizerDocumentJob refuses before a passage is read or
// the model is called; the worker is held to its source (dispatch asks first,
// a refused job touches nothing else). A also refuses whitespace-edged segments.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-storage-path.mjs
//
// Offline and secret-free: every key here is a fake string; no .env, no
// network, no production.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const SUPABASE_URL = 'https://stub.supabase.test';
const SUPA_HOST = 'stub.supabase.test';
const SERVICE_KEY = 'service-role-stub-not-a-key';
process.env.VITE_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.VITE_SUPABASE_ANON_KEY = 'anon-stub-not-a-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
process.env.OPENAI_API_KEY = 'sk-stub-not-a-key';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'stub-client-id.apps.googleusercontent.test';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'stub-client-secret';
process.env.CONNECTIONS_ENC_KEY = 'stub-connections-encryption-key-not-a-secret';
process.env.MS_OAUTH_CLIENT_ID = 'stub-ms-client-id';
process.env.MS_OAUTH_CLIENT_SECRET = 'stub-ms-client-secret';
process.env.MS_OAUTH_TENANT = 'common';
process.env.DROPBOX_APP_KEY = 'stub-dropbox-app-key';
process.env.DROPBOX_APP_SECRET = 'stub-dropbox-app-secret';
{
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.MCP_SIGNING_KEY_JWK_B64 = Buffer.from(JSON.stringify(privateKey.export({ format: 'jwk' }))).toString('base64');
  process.env.MCP_SIGNING_KEY_ID = 'stub-kid';
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  if (!ok) failures += 1;
};

const OPEN = '0a0a0a0a-0000-4000-8000-000000000001';
const SEALED = '5e5e5e5e-0000-4000-8000-000000000002';
const DOC_ID = 'd0c0d0c0-0000-4000-8000-000000000003';

// ---------------------------------------------------------------------------
// A. The constraint
// ---------------------------------------------------------------------------
console.log('\n--- A. migration 097 ---------------------------------------------------');
{
  const db = new PGlite();
  await db.exec(`
    -- 097 grants its job-scope helpers to these (round 3).
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
    create table public.documents (
      id uuid primary key,
      matterspace_id uuid not null,
      title text,
      storage_path text
    );`);
  const sql097 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '097_storage_path_matter.sql'), 'utf8');
  await db.exec(sql097);
  let rerun = null;
  try { await db.exec(sql097); } catch (e) { rerun = e; }
  check(!rerun, '097 executes twice (re-runnable)', rerun?.message);

  const attempt = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e; } };
  const id = () => crypto.randomUUID();

  const own = await attempt(`insert into public.documents values ($1, $2, 'ok', $3)`, [id(), OPEN, `${OPEN}/x/brief.pdf`]);
  check(!own, 'INSERT with a path under the row\'s own matter is accepted', own?.message);
  const nul = await attempt(`insert into public.documents values ($1, $2, 'no file yet', null)`, [id(), OPEN]);
  check(!nul, 'INSERT with no path (a stub before its upload) is accepted', nul?.message);
  const ptr = await attempt(`insert into public.documents values ($1, $2, 'pointer', $3)`, [id(), OPEN, `${SEALED}/y/advice.pdf`]);
  check(Boolean(ptr) && /documents_storage_path_in_matter/.test(ptr.message),
    'INSERT of a POINTER row (open matter, sealed object) is refused', ptr?.message);
  const bare = await attempt(`insert into public.documents values ($1, $2, 'bare', 'advice.pdf')`, [id(), OPEN]);
  check(Boolean(bare), 'INSERT of a path with no matter segment is refused');

  const rowId = id();
  await db.query(`insert into public.documents values ($1, $2, 'mine', $3)`, [rowId, OPEN, `${OPEN}/${rowId}/memo.pdf`]);
  const upd = await attempt(`update public.documents set storage_path = $2 where id = $1`, [rowId, `${SEALED}/y/advice.pdf`]);
  check(Boolean(upd), 'UPDATE that points an existing row at another matter\'s object is refused', upd?.message);
  const half = await attempt(`update public.documents set matterspace_id = $2 where id = $1`, [rowId, SEALED]);
  check(Boolean(half), 'a MOVE of the matter alone, leaving the path behind, is refused');
  const move = await attempt(`update public.documents set matterspace_id = $2, storage_path = $3 where id = $1`,
    [rowId, SEALED, `${SEALED}/${rowId}/memo.pdf`]);
  check(!move, 'a MOVE that rewrites matterspace_id and storage_path in ONE update is accepted (move-document, move_document, unpack)', move?.message);

  // ROUND 2 — the shape, not the prefix. Each of these begins with OPEN, and
  // each would reach another key once a URL resolved it.
  const TRAVERSALS = [
    [`${OPEN}/../${SEALED}/x/advice.pdf`, 'a ../ segment (and five segments)'],
    [`${OPEN}/..\\x/advice.pdf`, 'a ..\\ segment (backslash)'],
    [`${OPEN}/%2e%2e/advice.pdf`, 'a %2e%2e segment (percent-encoded dots)'],
    [`${OPEN}/x/..`, 'a trailing .. segment'],
    [`${OPEN}/./advice.pdf`, 'a . segment'],
    [`${OPEN}//advice.pdf`, 'an empty segment (//)'],
    [`${OPEN}/a/b/advice.pdf`, 'four segments'],
    [`${OPEN.toUpperCase()}/x/advice.pdf`, 'an upper-case matter uuid (the CHECK is case-sensitive)'],
    [`${OPEN}/x/advice.pdf `, 'a trailing space (round 3: a URL parser trims it)'],
    [`${OPEN}/ x/advice.pdf`, 'a segment starting with a space (round 3)'],
  ];
  for (const [bad, what] of TRAVERSALS) {
    const e = await attempt(`insert into public.documents values ($1, $2, 't', $3)`, [id(), OPEN, bad]);
    check(Boolean(e) && /documents_storage_path_in_matter/.test(e.message), `INSERT refused: ${what}`, e ? '' : bad);
  }
  const spaced = await attempt(`insert into public.documents values ($1, $2, 's', $3)`,
    [id(), OPEN, `${OPEN}/${id()}/Deposition of A. Smith (vol. 2) – final.pdf`]);
  check(!spaced, 'a real filename (spaces, parentheses, a dash, dots inside the name) is accepted', spaced?.message);

  // production_items (030's columns that matter here).
  await db.exec(`
    create table public.production_items (
      id uuid primary key default gen_random_uuid(),
      production_id uuid not null,
      matterspace_id uuid not null,
      native_storage_path text,
      display_storage_path text
    );`);
  await db.exec(sql097);
  const PROD = 'b0b0b0b0-0000-4000-8000-000000000004';
  const OTHER_PROD = 'b1b1b1b1-0000-4000-8000-000000000005';
  const pi = (native, display) => attempt(
    `insert into public.production_items (production_id, matterspace_id, native_storage_path, display_storage_path)
     values ($1, $2, $3, $4)`, [PROD, OPEN, native, display]);
  const good = await pi(`${OPEN}/${PROD}/${id()}/native/ORM-000001.msg`, `${OPEN}/${PROD}/${id()}/display.pdf`);
  check(!good, 'production_items: paths inside the row\'s own production are accepted', good?.message);
  for (const [bad, what] of [
    [`${SEALED}/${PROD}/i/native/x.msg`, 'another matter'],
    [`${OPEN}/${OTHER_PROD}/i/native/x.msg`, 'another production'],
    [`${OPEN}/${PROD}/../../${SEALED}/p/x.msg`, 'a ../ traversal'],
    [`${OPEN}/${PROD}/i/%2e%2e/x.msg`, 'a percent-encoded segment'],
    [`${OPEN}/${PROD}/i\\..\\x.msg`, 'a backslash'],
  ]) {
    const e1 = await pi(bad, null);
    const e2 = await pi(null, bad);
    check(Boolean(e1) && Boolean(e2) && /production_items_paths_in_production/.test(e1.message),
      `production_items: native AND display path refused — ${what}`);
  }
  await db.close();
}

// ---------------------------------------------------------------------------
// B. The six call sites
// ---------------------------------------------------------------------------
console.log('\n--- B. the call sites ---------------------------------------------------');
const { encrypt } = await import('../lib/connections-crypto.mjs');
const { default: cloudExport } = await import('../api/cloud-export.mjs');
const { default: driveExport } = await import('../api/drive-export.mjs');
const { default: pushToDrive } = await import('../api/ext/push-to-drive.mjs');
const { default: gmailSend } = await import('../api/gmail-send.mjs');
const { default: ingest } = await import('../api/ingest.mjs');
const { handleGetMedia } = await import('../lib/mcp-core.mjs');
const { createClient } = await import('@supabase/supabase-js');

const jsonRes = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u); } };
let requests = [];
let row = null;

function supabaseAnswer(url, init) {
  if (url.includes('/auth/v1/user')) {
    return jsonRes(200, { id: 'user-1', aud: 'authenticated', role: 'authenticated', email: 'stub@example.test', app_metadata: {}, user_metadata: {} });
  }
  if (url.includes('/storage/v1/object/sign/')) return jsonRes(200, { signedURL: '/object/sign/vault-documents/x?token=t' });
  if (url.includes('/storage/v1/')) return new Response(Buffer.from('CONFIDENTIAL-PAYLOAD!'), { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (url.includes('/rest/v1/connector_tokens')) {
    if ((init.method || 'GET').toUpperCase() === 'PATCH') return jsonRes(200, []);
    return jsonRes(200, [{ id: 'tok-1', user_id: 'user-1', expires_at: null, revoked_at: null }]);
  }
  if (url.includes('/rest/v1/connections')) {
    if ((init.method || 'GET').toUpperCase() === 'PATCH') return jsonRes(200, []);
    return jsonRes(200, [{ encrypted_refresh_token: encrypt('refresh-token-stub'), status: 'connected', scopes: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.compose', account_email: 'a@example.test' }]);
  }
  const wantsObject = /vnd\.pgrst\.object/.test(new Headers(init.headers ?? {}).get('accept') || '');
  if (url.includes('/rest/v1/documents')) {
    if ((init.method || 'GET').toUpperCase() !== 'GET') return jsonRes(200, []);
    // `id=in.(a,b)`: the same row once per id asked for.
    const inIds = /id=in\.\(([^)]*)\)/.exec(decodeURIComponent(url))?.[1];
    const rows = inIds ? inIds.split(',').map((x) => ({ ...row, id: x.replace(/"/g, '') })) : [row];
    return jsonRes(200, wantsObject ? rows[0] : rows);
  }
  if (url.includes('/rest/v1/matterspaces')) {
    if (url.includes('ai_tier=in.')) return jsonRes(200, []);
    const id = /id=eq\.([^&]+)/.exec(url)?.[1];
    const m = { id: decodeURIComponent(id ?? ''), name: 'Vashti v. Ormsby', short_code: 'VAS', serverspace_id: 'ss-1', parent_matterspace_id: null, ai_tier: 'A' };
    return jsonRes(200, wantsObject ? m : (id ? [m] : []));
  }
  // Nothing in this world is sealed (the attack is a pointer in an OPEN matter).
  if (url.includes('/rest/v1/rpc/effective_tier_is_sealed')) return jsonRes(200, false);
  if (url.includes('/rest/v1/rpc/')) return jsonRes(200, null);
  return jsonRes(200, []);
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  const host = hostOf(url);
  requests.push({ url, host, method: (init.method || 'GET').toUpperCase() });
  if (host === SUPA_HOST) return supabaseAnswer(url, init);
  // Every outside service: an agreeable answer. What matters here is whether
  // a request was made at all.
  return jsonRes(200, {
    access_token: 'stub-access', refresh_token: 'stub-refresh', expires_in: 3600,
    id: 'x', files: [], uploadUrl: 'https://upload.onedrive.test/s', session_id: 's',
  });
};
const storageReads = () => requests.filter((r) => r.host === SUPA_HOST && r.url.includes('/storage/v1/'));
const outside = () => requests.filter((r) => r.host !== SUPA_HOST);

function fakeRes() {
  const chunks = [];
  return {
    statusCode: 200, headers: {},
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    write(s) { chunks.push(String(s)); return true; },
    end(s) { if (s !== undefined) chunks.push(String(s)); return this; },
    get json() { try { return JSON.parse(chunks.join('')); } catch { return null; } },
  };
}
const post = async (handler, body, token = 'stub-session-jwt') => {
  const res = fakeRes();
  await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body }, res);
  return res;
};

const POINTER = { id: DOC_ID, title: 'Innocent-looking row', source_filename: 'advice.pdf', storage_path: `${SEALED}/9e9e9e9e-0000-4000-8000-000000000009/advice.pdf`, file_size_bytes: 21, matterspace_id: OPEN, processing_status: 'ready' };
const FILED = { ...POINTER, storage_path: `${OPEN}/${DOC_ID}/advice.pdf` };

const SITES = [
  { name: '/api/cloud-export (onedrive)', run: () => post(cloudExport, { service: 'onedrive', documentId: DOC_ID }) },
  { name: '/api/cloud-export (dropbox)', run: () => post(cloudExport, { service: 'dropbox', documentId: DOC_ID }) },
  { name: '/api/drive-export', run: () => post(driveExport, { documentId: DOC_ID, folderName: 'Contextspaces' }) },
  { name: '/api/ext/push-to-drive', run: () => post(pushToDrive, { documentId: DOC_ID }, `csp_${'a1B2c3D4e5F6g7H8i9J0'}`) },
  { name: '/api/gmail-send', run: () => post(gmailSend, { documentId: DOC_ID }) },
  // A 'ready' row: with the path filed correctly, ingest answers alreadyReady
  // straight after the check, which is the control; it never needs storage.
  { name: '/api/ingest', run: () => post(ingest, { documentId: DOC_ID }), controlOk: (r) => r.statusCode === 200 && r.json?.alreadyReady === true },
];

for (const site of SITES) {
  requests = []; row = POINTER;
  const r = await site.run();
  check(r.statusCode === 409 && r.json?.error === 'storage_path_mismatch' && storageReads().length === 0 && outside().length === 0,
    `${site.name}: a POINTER row is refused — zero storage reads, nothing sent outside`,
    { status: r.statusCode, body: r.json, storage: storageReads().length, outside: outside().length });

  requests = []; row = FILED;
  const c = await site.run();
  const ok = site.controlOk ? site.controlOk(c) : storageReads().length >= 1;
  check(ok, `${site.name}: control — the same row filed correctly gets past the check`,
    { status: c.statusCode, body: c.json?.error ?? null, storage: storageReads().length });
}

// ROUND 2: the same six sites, handed rows that START with the row's own
// matter and traverse out of it.
const TRAVERSAL_ROWS = [
  `${OPEN}/../${SEALED}/9e9e9e9e-0000-4000-8000-000000000009/advice.pdf`,
  `${OPEN}/../../discovery-files/${SEALED}/p/x.pdf`,
  `${OPEN}/%2e%2e/advice.pdf`,
  `${OPEN}/..\\advice.pdf`,
  `${OPEN}//advice.pdf`,
  `${OPEN}/a/b/advice.pdf`,
  `${OPEN.toUpperCase()}/${DOC_ID}/advice.pdf`,
];
for (const site of SITES) {
  const leaks = [];
  for (const p of TRAVERSAL_ROWS) {
    requests = []; row = { ...POINTER, storage_path: p };
    const r = await site.run();
    if (!(r.statusCode === 409 && storageReads().length === 0 && outside().length === 0)) leaks.push(`${p} → ${r.statusCode}/${storageReads().length}`);
  }
  check(leaks.length === 0, `${site.name}: every traversal row is refused — zero storage reads`, leaks.join(' | '));
}

{
  const client = createClient(SUPABASE_URL, 'anon-stub-not-a-key', {
    global: { headers: { Authorization: 'Bearer stub-session-jwt' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  requests = []; row = POINTER;
  let err = null;
  try { await handleGetMedia(client, { document_id: DOC_ID }); } catch (e) { err = e; }
  check(Boolean(err) && /different matter/.test(err.message) && storageReads().length === 0,
    'get_media: a POINTER row is refused before the mint', err?.message);
  requests = []; row = FILED;
  let out = null; err = null;
  try { out = await handleGetMedia(client, { document_id: DOC_ID }); } catch (e) { err = e; }
  check(!err && typeof out?.stream_url === 'string' && storageReads().length === 1,
    'get_media: control — filed correctly, it mints', err?.message);

  const leaks = [];
  for (const p of TRAVERSAL_ROWS) {
    requests = []; row = { ...POINTER, storage_path: p };
    let e = null;
    try { await handleGetMedia(client, { document_id: DOC_ID }); } catch (x) { e = x; }
    if (!e || storageReads().length) leaks.push(p);
  }
  check(leaks.length === 0, 'get_media: every traversal row is refused before the mint', leaks.join(' | '));
}

// ROUND 2, item 3: the stdio MCP server runs mcp-core with the SERVICE ROLE,
// which acts on any key it is handed. Each of these must refuse a pointer or
// traversal row before it asks storage for anything.
{
  const { handleMoveDocument, handleCopyDocument, handleAssembleDocuments, handleEditPdf } = await import('../lib/mcp-core.mjs');
  const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const OTHER = '0c0c0c0c-0000-4000-8000-000000000006';
  const TOOLS = [
    ['move_document', () => handleMoveDocument(service, { document_ids: [DOC_ID], to_matter: OTHER })],
    ['copy_document', () => handleCopyDocument(service, { document_ids: [DOC_ID], to_matter: OTHER })],
    ['assemble_documents', () => handleAssembleDocuments(service, { matter: OPEN, document_ids: [DOC_ID, 'd0c0d0c0-0000-4000-8000-000000000033'] })],
    ['edit_pdf', () => handleEditPdf(service, { document_id: DOC_ID, pages: 'all' })],
  ];
  for (const [name, run] of TOOLS) {
    const leaks = [];
    for (const p of [POINTER.storage_path, ...TRAVERSAL_ROWS]) {
      requests = []; row = { ...POINTER, storage_path: p };
      let e = null;
      try { await run(); } catch (x) { e = x; }
      const ours = e && (e.code === 'storage_path_mismatch' || /not filed under its own matter/.test(String(e.message)));
      if (!ours || storageReads().length) leaks.push(`${p.slice(0, 60)} → ${e?.message?.slice(0, 60) ?? 'no error'} / ${storageReads().length}`);
    }
    check(leaks.length === 0, `mcp-core ${name} (service role): pointer and traversal rows refused before any storage call`, leaks.join(' | '));
  }
}

// ---------------------------------------------------------------------------
// C. The helper, and the source
// ---------------------------------------------------------------------------
console.log('\n--- C. the helper and the source ----------------------------------------');
const { pathInMatter, assertPathInMatter, isStoragePathMismatch } = await import('../lib/storage-path.mjs');
check(pathInMatter(`${OPEN}/a/b.pdf`, OPEN) && pathInMatter(`${OPEN}/a/My file (2) – é.pdf`, OPEN),
  'pathInMatter: a canonical path under its matter belongs (real filenames included)');
check(!pathInMatter(`${OPEN.toUpperCase()}/a/b.pdf`, OPEN) && !pathInMatter(`${OPEN}/a/b.pdf`, OPEN.toUpperCase()),
  'pathInMatter: the matter segment is compared exactly — a case mismatch is refused, as the CHECK refuses it');
check(!pathInMatter(`${OPEN}/a/x.pdf `, OPEN) && !pathInMatter(`${OPEN}/a /x.pdf`, OPEN) && !pathInMatter(`${OPEN}/a/	x.pdf`, OPEN),
  'pathInMatter: a segment that starts or ends with whitespace is refused, as the CHECK refuses it (round 3)');
check(!pathInMatter(`${OPEN}/a/x?y.pdf`, OPEN) && !pathInMatter(`${OPEN}/a/x#y.pdf`, OPEN),
  'pathInMatter: anything a URL parser would rewrite (? #) is refused');
check(!pathInMatter(`${SEALED}/a/b.pdf`, OPEN) && !pathInMatter('b.pdf', OPEN) && !pathInMatter(`${OPEN}/a`, null),
  'pathInMatter: another matter, no matter segment, or no matter at all does not');
check(pathInMatter(null, OPEN), 'pathInMatter: no stored file is nothing to refuse');
{
  let e = null;
  try { assertPathInMatter(`${SEALED}/a/b.pdf`, OPEN); } catch (x) { e = x; }
  check(isStoragePathMismatch(e), 'assertPathInMatter throws the storage_path_mismatch error');
}
{
  const files = ['api/cloud-export.mjs', 'api/drive-export.mjs', 'api/ext/push-to-drive.mjs', 'api/gmail-send.mjs', 'api/ingest.mjs', 'lib/mcp-core.mjs', 'worker/discovery-worker.mjs'];
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (!/pathInMatter\(|assertPathInMatter\(/.test(src)) bad.push(f);
  }
  check(bad.length === 0, 'the five routes, get_media and the worker\'s ingest all ask the helper', bad.join(', '));
}
{
  const { pathInProduction } = await import('../lib/storage-path.mjs');
  const P = 'b0b0b0b0-0000-4000-8000-000000000004';
  check(pathInProduction(`${OPEN}/${P}/intake/box 1.zip`, OPEN, P) && pathInProduction(`${OPEN}/${P}/i/native/a.msg`, OPEN, P),
    'pathInProduction: an intake file and an item file inside the production belong');
  check(!pathInProduction(`${OPEN}/b1b1b1b1-0000-4000-8000-000000000005/intake/x.zip`, OPEN, P)
    && !pathInProduction(`${SEALED}/${P}/intake/x.zip`, OPEN, P)
    && !pathInProduction(`${OPEN}/${P}/../../${SEALED}/p/x.zip`, OPEN, P)
    && !pathInProduction(`${OPEN}/${P}/%2e%2e/x.zip`, OPEN, P)
    && !pathInProduction(`${OPEN}/${P}`, OPEN, P),
  'pathInProduction: another production, another matter, traversal, encoding, or the production folder itself is refused');

  // The worker is a long-running script, so it is held to its source here;
  // the helper it calls is exercised above.
  const w = fs.readFileSync(path.join(ROOT, 'worker', 'discovery-worker.mjs'), 'utf8');
  const fn = (name) => w.slice(w.indexOf(`async function ${name}(`), w.indexOf('\n}\n', w.indexOf(`async function ${name}(`)));
  const beforeDownload = (body, needle) => body.indexOf(needle) > -1 && body.indexOf(needle) < body.indexOf('downloadFromStorage(');
  check(beforeDownload(fn('intakeZip'), 'assertJobPaths(job, prod, paths') && beforeDownload(fn('intakeFiles'), 'assertJobPaths(job, prod, paths'),
    'worker: intake_zip and intake_files check every job path (and the job\'s matter) BEFORE the first download');
  check(/job\.matterspace_id !== prod\.matterspace_id/.test(fn('assertJobPaths').concat(w.slice(w.indexOf('function assertJobPaths'), w.indexOf('function assertJobPaths') + 600))),
    'worker: a job whose matter is not its production\'s matter is refused');
  const stamp = w.slice(w.indexOf('async function stampProduction'), w.indexOf('async function packageProduction'));
  const pkg = w.slice(w.indexOf('async function packageProduction'), w.indexOf('async function packageProduction') + 6000);
  check((stamp.match(/assertPathInProduction\(item\.display_storage_path/g) || []).length >= 2
    && /assertPathInProduction\(item\.native_storage_path/.test(pkg),
  'worker: every production_items path is checked before the service role reads it (stamp, preflight, package)');
  check(/case 'intake_folder': return refuseQueuedFolderIntake\(job\)/.test(w) && /never from the queue/.test(w),
    'worker: a QUEUED intake_folder job (a member-writable row naming a local path) is refused');

  const scripts = ['scripts/reingest.mjs', 'scripts/ocr-scanned.mjs', 'scripts/reprocess-failed.mjs'];
  const unguarded = scripts.filter((f) => !/pathInMatter\(|assertPathInMatter\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check(unguarded.length === 0, 'the service-role operator scripts ask the helper too', unguarded.join(', '));
  const mcp = fs.readFileSync(path.join(ROOT, 'lib', 'mcp-core.mjs'), 'utf8');
  const sign = mcp.slice(mcp.indexOf('async function signDownloadUrl'), mcp.indexOf('async function signDownloadUrl') + 600);
  check(/assertPathInMatter\(doc\.storage_path, doc\.matterspace_id\)/.test(sign) && sign.indexOf('assertPathInMatter') < sign.indexOf('createSignedUrl'),
    'mcp-core signDownloadUrl checks the path before it signs');
}

// ---------------------------------------------------------------------------
// D. Jobs (round 3): a queued job may name only its own matter's things
// ---------------------------------------------------------------------------
console.log('\n--- D. jobs: the database trigger and the worker assert ----------------');
{
  const { BUCKETIZER_JOB_TYPE } = await import('../lib/bucketizer-run-queue.mjs');
  const { assertJobBelongsToMatter, isJobScopeError } = await import('../lib/job-scope.mjs');
  const { runBucketizerDocumentJob } = await import('../lib/bucketizer-run.mjs');
  const u = () => crypto.randomUUID();
  const A = u(); const B = u();
  // Round 4: a tree under A — a folder, a folder inside it, and a sealed sub-matter.
  const A_CHILD = u(); const A_GRAND = u(); const A_SEALED = u();
  const docGrand = u(); const docSealedKid = u(); const docMoved = u(); const docAway = u();
  const parentOf = { [A]: null, [B]: null, [A_CHILD]: A, [A_GRAND]: A_CHILD, [A_SEALED]: A };
  const docA = u(); const docA2 = u(); const docB = u();
  const prodA = u(); const prodB = u();
  const runA = u(); const runB = u();

  // D1. The trigger, against a real Postgres, as the roles PostgREST uses.
  const db = new PGlite();
  await db.exec(`
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
    create table public.matterspaces (id uuid primary key, parent_matterspace_id uuid, ai_tier text not null default 'A');
    -- 016's definer walk, word for word.
    create or replace function public.matter_ancestry(p_matter_id uuid)
    returns table (id uuid) language sql stable security definer set search_path = public as $f$
      with recursive a(id, parent_matterspace_id) as (
        select id, parent_matterspace_id from public.matterspaces where id = p_matter_id
        union all
        select m.id, m.parent_matterspace_id from public.matterspaces m join a on m.id = a.parent_matterspace_id
      )
      select id from a
    $f$;
    create table public.documents (id uuid primary key, matterspace_id uuid not null, title text, storage_path text);
    create table public.productions (id uuid primary key, matterspace_id uuid not null);
    create table public.bucketizer_runs (id uuid primary key, matterspace_id uuid not null);
    create table public.bucketizer_run_documents (run_id uuid, document_id uuid);
    create table public.processing_jobs (
      id uuid primary key default gen_random_uuid(), matterspace_id uuid not null,
      production_id uuid, job_type text not null, payload jsonb not null default '{}');
    grant usage on schema public to authenticated, anon, service_role;
    grant select, insert, update on public.processing_jobs to authenticated, service_role;
  `);
  await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '097_storage_path_matter.sql'), 'utf8'));
  for (const [id, parent] of Object.entries(parentOf)) {
    await db.query(`insert into public.matterspaces values ($1, $2, $3)`, [id, parent, id === A_SEALED ? 'B' : 'A']);
  }
  await db.query(`insert into public.documents values ($1,$2,'a',null), ($3,$2,'a2',null), ($4,$5,'sealed b',null)`, [docA, A, docA2, docB, B]);
  await db.query(`insert into public.documents values ($1,$2,'in a folder of a folder',null), ($3,$4,'in a sealed sub-matter',null),
    ($5,$6,'filed into a folder after upload',null), ($7,$8,'filed into another tree after upload',null)`,
    [docGrand, A_GRAND, docSealedKid, A_SEALED, docMoved, A_CHILD, docAway, B]);
  await db.query(`insert into public.productions values ($1,$2), ($3,$4)`, [prodA, A, prodB, B]);
  await db.query(`insert into public.bucketizer_runs values ($1,$2), ($3,$4)`, [runA, A, runB, B]);
  await db.query(`insert into public.bucketizer_run_documents values ($1,$2), ($3,$4), ($1,$5), ($1,$6), ($1,$4)`,
    [runA, docA, runB, docB, docGrand, docSealedKid]);   // runA also (wrongly) lists docB: the tree check must still refuse it

  const asRole = async (role, sql, params) => {
    await db.exec(`set role ${role}`);
    try { await db.query(sql, params); return null; } catch (e) { return e; } finally { await db.exec('reset role'); }
  };
  const job = (role, matter, jobType, prod, payload) => asRole(role,
    `insert into public.processing_jobs (matterspace_id, job_type, production_id, payload) values ($1,$2,$3,$4::jsonb)`,
    [matter, jobType, prod, JSON.stringify(payload)]);

  const CASES = [
    // [label, job type, production, payload, ok?]
    ['Bucketizer: own run, a SEALED document of another matter', BUCKETIZER_JOB_TYPE, null, { run_id: runA, document_id: docB }, false],
    ['Bucketizer: another matter\'s run', BUCKETIZER_JOB_TYPE, null, { run_id: runB, document_id: docA }, false],
    ['Bucketizer: own run, own document the run does not list', BUCKETIZER_JOB_TYPE, null, { run_id: runA, document_id: docA2 }, false],
    ['Bucketizer: own run, its own document', BUCKETIZER_JOB_TYPE, null, { run_id: runA, document_id: docA }, true],
    ['stamp_production: another matter\'s production', 'stamp_production', prodB, {}, false],
    ['stamp_production: own production', 'stamp_production', prodA, {}, true],
    ['package_production: another matter\'s production', 'package_production', prodB, {}, false],
    ['package_production: own production', 'package_production', prodA, { include_privilege_log: true }, true],
    ['ingest_document: another matter\'s document', 'ingest_document', null, { document_id: docB }, false],
    ['ingest_document: a non-canonical spelling of its own document', 'ingest_document', null, { document_id: docA.toUpperCase() }, false],
    ['ingest_document: own document', 'ingest_document', null, { document_id: docA }, true],
    ['intake_zip: a path in another production', 'intake_zip', prodA, { storage_paths: [`${A}/${prodB}/intake/x.zip`] }, false],
    ['intake_zip: a traversal path', 'intake_zip', prodA, { storage_paths: [`${A}/${prodA}/../../${B}/${prodB}/intake/x.zip`] }, false],
    ['intake_zip: own production\'s intake file', 'intake_zip', prodA, { storage_paths: [`${A}/${prodA}/intake/box 1.zip`] }, true],
    ['intake_folder from a signed-in caller', 'intake_folder', prodA, { local_path: '/proc/self' }, false],
    // Round 4 — trees.
    ['Bucketizer: run in A, a document in a folder of a folder of A (listed)', BUCKETIZER_JOB_TYPE, null, { run_id: runA, document_id: docGrand }, true],
    ['Bucketizer: run in A, a document in an unrelated matter even though the run lists it', BUCKETIZER_JOB_TYPE, null, { run_id: runA, document_id: docB }, false],
    // The seal is not this check's rule (lib/bucketizer-run judges it by the RUN's matter);
    // a sealed sub-matter's document inside the run's tree is IN SCOPE here.
    ['Bucketizer: run in open A, a document in A\'s sealed sub-matter (listed) — scope accepts; the seal rule is unchanged', BUCKETIZER_JOB_TYPE, null, { run_id: runA, document_id: docSealedKid }, true],
    ['ingest_document queued in A for a document since filed into A/folder', 'ingest_document', null, { document_id: docMoved }, true],
    ['ingest_document queued in A for a document now in another tree (never re-pointed)', 'ingest_document', null, { document_id: docAway }, false],
  ];
  for (const [label, type, prod, payload, ok] of CASES) {
    const e = await job('authenticated', A, type, prod, payload);
    check(ok ? !e : (Boolean(e) && e.code === '42501'),
      `trigger, as authenticated — ${label}: ${ok ? 'accepted' : 'refused'}`, e ? e.message : '');
  }
  {
    await db.query(`insert into public.processing_jobs (matterspace_id, job_type, payload) values ($1,'ingest_document',$2::jsonb)`,
      [A, JSON.stringify({ document_id: docA })]);
    const e = await asRole('authenticated',
      `update public.processing_jobs set payload = $1::jsonb where job_type = 'ingest_document' and matterspace_id = $2`,
      [JSON.stringify({ document_id: docB }), A]);
    check(Boolean(e) && e.code === '42501', 'trigger, as authenticated — an UPDATE re-pointing a job at another matter\'s document: refused');
    const svc = await job('service_role', A, BUCKETIZER_JOB_TYPE, null, { run_id: runA, document_id: docB });
    check(!svc, 'trigger, as the service role — passes (the worker\'s own assert is the layer for it, below)');
  }
  await db.close();

  // D2. The worker's assert, as the service role, over an in-memory client.
  const tables = {
    documents: [{ id: docA, matterspace_id: A }, { id: docA2, matterspace_id: A }, { id: docB, matterspace_id: B },
      { id: docGrand, matterspace_id: A_GRAND }, { id: docSealedKid, matterspace_id: A_SEALED },
      { id: docMoved, matterspace_id: A_CHILD }, { id: docAway, matterspace_id: B }],
    productions: [{ id: prodA, matterspace_id: A }, { id: prodB, matterspace_id: B }],
    bucketizer_runs: [{ id: runA, matterspace_id: A, status: 'running', kind: 'classify', model_id: 'm' }, { id: runB, matterspace_id: B, status: 'running', kind: 'classify', model_id: 'm' }],
    bucketizer_run_documents: [{ id: u(), run_id: runA, document_id: docA }, { id: u(), run_id: runB, document_id: docB },
      { id: u(), run_id: runA, document_id: docGrand }, { id: u(), run_id: runA, document_id: docSealedKid },
      { id: u(), run_id: runA, document_id: docB }],
  };
  const touched = [];
  const ancestryOf = (m) => { const out = []; for (let x = m; x; x = parentOf[x]) out.push({ id: x }); return out; };
  const fake = {
    async rpc(fn, args) {
      if (fn === 'matter_ancestry') return { data: ancestryOf(args.p_matter_id), error: null };
      return { data: null, error: { message: `no rpc ${fn}` } };
    },
    from(t) {
      touched.push(t);
      const filters = [];
      const rows = () => (tables[t] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
      const api = {
        select() { return api; }, order() { return api; }, in() { return api; },
        eq(k, v) { filters.push([k, v]); return api; },
        update() { touched.push(`${t}:update`); return api; },
        async maybeSingle() { return { data: rows()[0] ?? null, error: null }; },
        then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
      };
      return api;
    },
  };
  const W = [
    ['bucketizer, sealed document of another matter', { matterspace_id: A, payload: { run_id: runA, document_id: docB } }, { runId: runA, documentId: docB }, false],
    ['bucketizer, another matter\'s run', { matterspace_id: A, payload: { run_id: runB, document_id: docA } }, { runId: runB, documentId: docA }, false],
    ['bucketizer, a document the run does not list', { matterspace_id: A, payload: { run_id: runA, document_id: docA2 } }, { runId: runA, documentId: docA2 }, false],
    ['bucketizer, own', { matterspace_id: A, payload: { run_id: runA, document_id: docA } }, { runId: runA, documentId: docA }, true],
    ['stamp/package, another matter\'s production', { matterspace_id: A, production_id: prodB }, { productionId: prodB }, false],
    ['stamp/package, own', { matterspace_id: A, production_id: prodA }, { productionId: prodA }, true],
    ['ingest_document, another matter\'s document', { matterspace_id: A }, { documentId: docB }, false],
    ['ingest_document, own', { matterspace_id: A }, { documentId: docA }, true],
    ['intake, a path outside the production', { matterspace_id: A }, { productionId: prodA, storagePaths: [`${A}/${prodB}/intake/x.zip`] }, false],
    ['a job with no matter', { matterspace_id: null }, { documentId: docA }, false],
    // Round 4 — trees, as the worker's dispatch asks them.
    ['bucketizer, a document in a folder of a folder of the run\'s matter', { matterspace_id: A }, { runId: runA, documentId: docGrand, documentScope: 'subtree' }, true],
    ['bucketizer, a document in an unrelated matter the run lists', { matterspace_id: A }, { runId: runA, documentId: docB, documentScope: 'subtree' }, false],
    ['bucketizer, a document in the run matter\'s sealed sub-matter (scope accepts; seal rule unchanged)', { matterspace_id: A }, { runId: runA, documentId: docSealedKid, documentScope: 'subtree' }, true],
    ['ingest_document queued in A, document since filed into A/folder', { matterspace_id: A }, { documentId: docMoved, documentScope: 'tree' }, true],
    ['ingest_document queued in A, document moved to another tree and never re-pointed', { matterspace_id: A }, { documentId: docAway, documentScope: 'tree' }, false],
    ['ingest_document re-pointed by the move to the document\'s new tree', { matterspace_id: B }, { documentId: docAway, documentScope: 'tree' }, true],
  ];
  for (const [label, j, refs, ok] of W) {
    let e = null;
    try { await assertJobBelongsToMatter(fake, j, refs); } catch (x) { e = x; }
    check(ok ? !e : isJobScopeError(e), `worker assert, service role — ${label}: ${ok ? 'passes' : 'refused'}`, e?.message ?? '');
  }
  for (const [label, payload] of [['own run, sealed document of another matter', { run_id: runA, document_id: docB }], ['another matter\'s run', { run_id: runB, document_id: docA }]]) {
    touched.length = 0;
    let modelCalls = 0;
    let e = null;
    try {
      await runBucketizerDocumentJob({ supabase: fake, job: { id: 'j', matterspace_id: A, payload }, callModel: async () => { modelCalls += 1; return {}; } });
    } catch (x) { e = x; }
    check(isJobScopeError(e) && modelCalls === 0 && !touched.includes('passages') && !touched.some((t) => t.endsWith(':update')),
      `runBucketizerDocumentJob — ${label}: refused before any passage is read, any row is written or the model is called`,
      `${e?.message ?? 'no error'} | touched ${[...new Set(touched)].join(',')}`);
  }

  // D2b. The move carries the queued job with it, with the SERVICE ROLE.
  {
    const { repointDocumentJobs } = await import('../lib/job-scope.mjs');
    const jobs = [
      { id: 'j1', job_type: 'ingest_document', status: 'queued', matterspace_id: A, payload: { document_id: docAway } },
      { id: 'j2', job_type: 'ingest_document', status: 'done', matterspace_id: A, payload: { document_id: docAway } },
      { id: 'j3', job_type: 'ingest_document', status: 'queued', matterspace_id: A, payload: { document_id: docA } },
    ];
    const svc = {
      from(t) {
        const f = [];
        let patch = null;
        const api = {
          update(p) { patch = p; return api; },
          eq(k, v) { f.push((r) => (k === 'job_type' ? r.job_type === v : r[k] === v)); return api; },
          in(k, vs) {
            f.push((r) => (k === 'payload->>document_id' ? vs.includes(r.payload.document_id) : vs.includes(r[k])));
            return api;
          },
          then(res, rej) {
            if (t === 'processing_jobs' && patch) for (const r of jobs) if (f.every((g) => g(r))) Object.assign(r, patch);
            return Promise.resolve({ data: null, error: null }).then(res, rej);
          },
        };
        return api;
      },
    };
    await repointDocumentJobs(svc, [docAway], B);
    check(jobs[0].matterspace_id === B && jobs[1].matterspace_id === A && jobs[2].matterspace_id === A,
      'repointDocumentJobs: the moved document\'s QUEUED job follows it to the new matter; a finished job and another document\'s job stay put');
    let e = null;
    try { await assertJobBelongsToMatter(fake, jobs[0], { documentId: docAway, documentScope: 'tree' }); } catch (x) { e = x; }
    check(!e, 'the re-pointed job is accepted by the worker', e?.message ?? '');
    const md = fs.readFileSync(path.join(ROOT, 'api', 'move-document.mjs'), 'utf8');
    const mc = fs.readFileSync(path.join(ROOT, 'lib', 'mcp-core.mjs'), 'utf8');
    const sbx = fs.readFileSync(path.join(ROOT, 'api', 'sandbox.mjs'), 'utf8');
    const mcp = fs.readFileSync(path.join(ROOT, 'api', 'mcp.mjs'), 'utf8');
    check(/repointDocumentJobs\(\s*createClient\(SUPABASE_URL, SERVICE_KEY/.test(md)
      && /repointDocumentJobs\(opts\.jobClient \?\? supabase, moved\.map/.test(mc)
      && /jobClient: createClient\(SUPABASE_URL, SERVICE_KEY/.test(sbx)
      && /name === 'move_document' \? \{ jobClient: adminClient\(\) \}/.test(mcp),
    'every move re-points with the service role: /api/move-document, and move_document via /api/sandbox and /api/mcp (the stdio client is the service role)');
  }
  {
    // Round 4, LOW: the trigger reaches the lookups through ONE definer wrapper.
    const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '097_storage_path_matter.sql'), 'utf8');
    const trig = sql.slice(sql.indexOf('create or replace function public._processing_jobs_scope_check'));
    check(/jobs_internal\.job_refusal\(/.test(trig) && !/jobs_internal\.matter_of_/.test(trig.slice(0, trig.indexOf('end $$')))
      && ['matter_of_document(uuid)', 'matter_of_production(uuid)', 'matter_of_run(uuid)', 'run_lists_document(uuid, uuid)']
        .every((f) => sql.includes(`revoke all on function jobs_internal.${f} from public, anon, authenticated;`))
      && !/grant execute on function jobs_internal\.(matter_of|run_lists)/.test(sql),
    'the trigger calls one definer wrapper (job_refusal); the lookup helpers are revoked from authenticated and anon');
  }

  // D3. The worker is a long-running script: held to its source.
  const w = fs.readFileSync(path.join(ROOT, 'worker', 'discovery-worker.mjs'), 'utf8');
  const dispatchSrc = w.slice(w.indexOf('async function dispatch(job)'), w.indexOf('async function claimJob'));
  check(/^\s*async function dispatch\(job\) \{\s*await assertJobScope\(job\);/m.test(dispatchSrc),
    'worker: dispatch() asks assertJobScope(job) before any handler runs');
  const scopeSrc = w.slice(w.indexOf('async function assertJobScope'), w.indexOf('async function dispatch(job)'));
  check(['intake_zip', 'intake_files', 'stamp_production', 'package_production', 'ingest_document', 'BUCKETIZER_JOB_TYPE'].every((t) => scopeSrc.includes(t)),
    'worker: assertJobScope covers every job type that names something');
  const catchSrc = w.slice(w.indexOf('if (isJobScopeError(err))'), w.indexOf('if (isJobScopeError(err))') + 600);
  check(catchSrc.includes('continue;') && catchSrc.indexOf('continue;') < (catchSrc.indexOf('recordDocumentFailure') === -1 ? Infinity : catchSrc.indexOf('recordDocumentFailure')),
    'worker: a refused job marks only itself — no document or production status is touched');
  check(/async function stampProduction\(job\) \{\s*const prod = await getProduction\(job\.production_id\);\s*assertJobPaths\(job, prod, \[\]/.test(w)
    && /async function packageProduction\(job\) \{\s*const prod = await getProduction\(job\.production_id\);\s*assertJobPaths\(job, prod, \[\]/.test(w),
    'worker: stamp and package also check the job\'s matter against the production\'s in place');
  check(/sameMatterTree\(supabase, doc\.matterspace_id, job\.matterspace_id\)\)\) throw new JobScopeError/.test(w),
    'worker: ingest_document also checks the document\'s tree in place');
  const b = fs.readFileSync(path.join(ROOT, 'lib', 'bucketizer-run.mjs'), 'utf8');
  const runFn = b.slice(b.indexOf('export async function runBucketizerDocumentJob'));
  check(runFn.indexOf('assertJobBelongsToMatter(') > -1 && runFn.indexOf('assertJobBelongsToMatter(') < runFn.indexOf(".from('bucketizer_runs')"),
    'lib/bucketizer-run.mjs: the handler refuses on its own account before its first read');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

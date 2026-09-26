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
  if (url.includes('/rest/v1/documents')) {
    if ((init.method || 'GET').toUpperCase() !== 'GET') return jsonRes(200, []);
    return jsonRes(200, [row]);
  }
  if (url.includes('/rest/v1/matterspaces')) {
    if (url.includes('ai_tier=in.')) return jsonRes(200, []);
    const id = /id=eq\.([^&]+)/.exec(url)?.[1];
    return jsonRes(200, id ? [{ id: decodeURIComponent(id), name: 'Vashti v. Ormsby', parent_matterspace_id: null, ai_tier: 'A' }] : []);
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
}

// ---------------------------------------------------------------------------
// C. The helper, and the source
// ---------------------------------------------------------------------------
console.log('\n--- C. the helper and the source ----------------------------------------');
const { pathInMatter, assertPathInMatter, isStoragePathMismatch } = await import('../lib/storage-path.mjs');
check(pathInMatter(`${OPEN}/a/b.pdf`, OPEN) && pathInMatter(`${OPEN.toUpperCase()}/a/b.pdf`, OPEN),
  'pathInMatter: a path under its matter (any case) belongs');
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

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

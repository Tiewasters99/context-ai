// A sealed matter's document does not leave for an outside service without
// the user being told — and, once there is a record to write, without it being
// written down. (SecureSpace; Eden's decision of 2026-09-20: warn and record.)
//
//   node scripts/_verify-export-gate.mjs
//
// Entirely OFFLINE and secret-free: no .env is read, every key in this file is
// a fake string, `fetch` is replaced by a witness that answers as Supabase (so
// the real supabase-js client and the real tier walk run unmodified) and as
// Google, and the handlers are driven directly with a fake req/res. CI-ready —
// exits non-zero on failure.
//
// The finding under test: three server routes handed a document's BYTES to
// Google with no tier check at all. None of the three files contained the
// string "tier" or "seal".
//
//   api/drive-export.mjs       the reader's Save to Google Drive
//   api/ext/push-to-drive.mjs  the browser extension's push
//   api/gmail-send.mjs         the document attached to a Gmail draft
//
// What is asserted, for each of the three:
//
//   1. Sealed + not confirmed → 409 with a stable code, ZERO storage reads and
//      ZERO requests to anything outside Supabase. "Nothing was sent" is a
//      fact about the process, not a sentence in the prose.
//   2. confirm_leave_seal must be literally `true` — PR #159's rule, so a
//      truthy string does not leave the seal.
//   3. Sealed + confirmed → the export proceeds and recordExport runs exactly
//      once, with METADATA ONLY: no bytes, no storage path, no file content,
//      no full email address.
//   4. Ledger absent → will_record:false, and the wording follows the flag
//      rather than assuming a record exists. Ledger present → the opposite.
//   5. Tier unresolvable → refused (fail closed), including the case where the
//      seal is INHERITED from a parent matter the caller cannot see under RLS.
//   6. Unsealed → the request to Google is byte-identical to main's, and the
//      response body has no extra key.
//   7. NEGATIVE CONTROL: the same handlers with the gate block deleted — which
//      this file asserts is byte-for-byte main's file — do leak on case 1.
//      Without it, every PASS above could be vacuous.
//   8. The extension's listing endpoints expose names, never content, and mark
//      the seal instead of hiding the user's own matters from their own tool.

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── env, BEFORE the handlers are imported ────────────────────────────────
// The handlers read these at module scope. Set here so the harness is
// deterministic wherever it runs, and so a real key that happens to be in the
// environment is overwritten rather than used.
const SUPABASE_URL = 'https://stub.supabase.test';
const SUPA_HOST = 'stub.supabase.test';
const SERVICE_KEY = 'service-role-stub-not-a-key';
process.env.VITE_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.VITE_SUPABASE_ANON_KEY = 'anon-stub-not-a-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
process.env.GOOGLE_OAUTH_CLIENT_ID = 'stub-client-id.apps.googleusercontent.test';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'stub-client-secret';
process.env.CONNECTIONS_ENC_KEY = 'stub-connections-encryption-key-not-a-secret';
// The two drives added in the OneDrive/Dropbox lane. Fake values, present only
// so the handler is CONFIGURED and reaches the gate — an unconfigured service
// answers 503 before the gate runs, which would make every assertion below
// vacuous for those two paths. (scripts/_verify-cloud-drives.mjs owns the
// unconfigured case.)
process.env.MS_OAUTH_CLIENT_ID = 'stub-ms-client-id';
process.env.MS_OAUTH_CLIENT_SECRET = 'stub-ms-client-secret';
process.env.MS_OAUTH_TENANT = 'common';
process.env.DROPBOX_APP_KEY = 'stub-dropbox-app-key';
process.env.DROPBOX_APP_SECRET = 'stub-dropbox-app-secret';

// The extension endpoints mint a short-lived user JWT (ES256). Signing is
// local; this key is generated fresh for the run and never leaves the process.
{
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.MCP_SIGNING_KEY_JWK_B64 = Buffer.from(
    JSON.stringify(privateKey.export({ format: 'jwk' })),
  ).toString('base64');
  process.env.MCP_SIGNING_KEY_ID = 'stub-kid';
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { default: driveExport } = await import('../api/drive-export.mjs');
const { default: cloudExport } = await import('../api/cloud-export.mjs');
const { default: pushToDrive } = await import('../api/ext/push-to-drive.mjs');
const { default: gmailSend } = await import('../api/gmail-send.mjs');
const { default: extDocuments } = await import('../api/ext/documents.mjs');
const { default: extMatters } = await import('../api/ext/matters.mjs');
const { encrypt } = await import('../lib/connections-crypto.mjs');
const {
  checkExport, exportsAreRecorded, exportEventKind, recordExport, exportedNote,
  exportConfirmMessage, EXPORT_SERVICES, __setLedgerForTests, __setLedgerImporterForTests,
} = await import('../lib/export-gate.mjs');
const { createClient } = await import('@supabase/supabase-js');
const { matterTierWithClient } = await import('../lib/ai-tier-policy.mjs');

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d)?.slice(0, 500)}` : ''}`);
  failures++;
};
const check = (cond, m, d) => (cond ? pass(m) : fail(m, d));
const skip = (m, why) => console.log(`  SKIP  ${m} — ${why}`);

// ── the world ────────────────────────────────────────────────────────────
// One document, in a sub-matter whose PARENT carries the tier. The parent is
// invisible to the user's own client on purpose: that is the inherited-seal
// case a user-scoped tier walk gets wrong (walkEffectiveTier stops at an
// ancestor it cannot see and keeps the tier it has), and the reason this gate
// reads the tier with the service role.
const DOC = Object.freeze({
  id: 'doc-1',
  title: 'Calder v. Atlas — settlement memo',
  source_filename: 'settlement-memo.pdf',
  // The tail of the stored path; the row served below puts it under its own
  // matter, as migration 097 requires ("<matter>/<doc>/<file>").
  storage_path: 'doc-1/settlement-memo.pdf',
  file_size_bytes: 21,
});
const FILE_BYTES = Buffer.from('CONFIDENTIAL-PAYLOAD!', 'utf8'); // 21 bytes
const CSP_TOKEN = `csp_${'a1B2c3D4e5F6g7H8i9J0'}`;

const realFetch = globalThis.fetch;
const realRandom = Math.random;
let requests = [];
let world = {};

function install(w = {}) {
  world = {
    tier: 'B',            // the PARENT matter's tier: 'A' | 'B' | 'C' | 'error'
    docMatter: 'matter-child',
    hideParent: true,     // RLS hides the parent from the user-scoped client
    sealRoots: 'ok',      // for /api/ext/matters
    ledger: 'ok',         // ledger_append: 'ok' | 'fail' | 'absent'
    ...w,
  };
  requests = [];
  // The multipart boundary is Math.random(): pin it so a gated run and a
  // main-code run produce comparable request bodies.
  let seed = 0;
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const host = hostOf(url);
    requests.push({ url, host, method: (init.method || 'GET').toUpperCase(), body: init.body, init });
    if (host === SUPA_HOST) return supabaseAnswer(url, init);
    if (host === 'oauth2.googleapis.com') return jsonRes(200, { access_token: 'stub-access-token', expires_in: 3600 });
    if (host === 'www.googleapis.com') return driveAnswer(url);
    if (host === 'gmail.googleapis.com') return jsonRes(200, { id: 'draft-1', message: { id: 'msg-1' } });
    if (host === 'login.microsoftonline.com') return jsonRes(200, { access_token: 'stub-ms-access-token', refresh_token: 'stub-ms-refresh-2', expires_in: 3600 });
    if (host === 'graph.microsoft.com') return graphAnswer(url, init);
    if (host === MS_UPLOAD_HOST) return jsonRes(200, { id: 'onedrive-file-1', name: DOC.source_filename, webUrl: 'https://onedrive.test/f/onedrive-file-1' });
    if (host === 'api.dropboxapi.com') return dropboxApiAnswer(url);
    if (host === 'content.dropboxapi.com') return dropboxContentAnswer(url);
    return jsonRes(500, { error: 'unexpected_host', host });
  };
}
const restore = () => { globalThis.fetch = realFetch; Math.random = realRandom; };

const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u); } };
const hosts = () => [...new Set(requests.map((r) => r.host))];
const outside = () => requests.filter((r) => r.host !== SUPA_HOST);
const outsideHosts = () => [...new Set(outside().map((r) => r.host))];
const storageReads = () => requests.filter((r) => r.url.includes('/storage/v1/'));
// What counts as "the bytes left the building", per provider. Google and Gmail
// put /upload/ in the path; OneDrive sends them to a pre-authenticated session
// URL on its own host; Dropbox posts them to a content endpoint. The session
// START calls are deliberately not counted — the file arrives on the chunk PUT
// (OneDrive) or the finish (Dropbox), and "exactly one upload" should mean one
// file, not one HTTP call.
const MS_UPLOAD_HOST = 'upload.onedrive.test';
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return String(u); } };
const uploads = () => requests.filter((r) =>
  r.url.includes('/upload/')
  || r.host === MS_UPLOAD_HOST
  || pathOf(r.url) === '/2/files/upload'
  || pathOf(r.url) === '/2/files/upload_session/finish');
// What actually reached the Record, as PostgREST would have received it.
const ledgerCalls = () => requests.filter((r) => r.host === SUPA_HOST && r.url.includes('/rpc/ledger_append'));
const ledgerBody = (i = 0) => { try { return JSON.parse(ledgerCalls()[i].body); } catch { return null; } };
// A user-scoped client for the few checks that drive lib/export-gate directly
// rather than through a handler. Same anon key and bearer the handlers use.
const userClient = () => createClient(SUPABASE_URL, 'anon-stub-not-a-key', {
  global: { headers: { Authorization: 'Bearer stub-session-jwt' } },
  auth: { persistSession: false, autoRefreshToken: false },
});

const jsonRes = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});

function headerOf(init, name) {
  const h = init?.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v;
  return null;
}
const isServiceRole = (init) =>
  headerOf(init, 'apikey') === SERVICE_KEY || headerOf(init, 'authorization') === `Bearer ${SERVICE_KEY}`;

const MATTERS = () => ({
  'matter-child': { id: 'matter-child', name: 'Calder v. Atlas', short_code: 'CAL', parent_matterspace_id: 'matter-parent', ai_tier: 'A', hidden: false },
  'matter-parent': { id: 'matter-parent', name: 'Atlas portfolio', short_code: 'ATL', parent_matterspace_id: null, ai_tier: world.tier, hidden: world.hideParent },
  'matter-open': { id: 'matter-open', name: 'Firm admin', short_code: 'ADM', parent_matterspace_id: null, ai_tier: 'A', hidden: false },
});

function supabaseAnswer(url, init) {
  if (url.includes('/auth/v1/user')) {
    return jsonRes(200, {
      id: 'user-1', aud: 'authenticated', role: 'authenticated', email: 'stub@example.test',
      app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z',
    });
  }
  if (url.includes('/storage/v1/object/')) {
    return new Response(FILE_BYTES, { status: 200, headers: { 'content-type': 'application/pdf' } });
  }
  if (url.includes('/rest/v1/connector_tokens')) {
    if ((init.method || 'GET').toUpperCase() === 'PATCH') return jsonRes(200, []);
    return jsonRes(200, [{ id: 'tok-1', user_id: 'user-1', expires_at: null, revoked_at: null }]);
  }
  if (url.includes('/rest/v1/connections')) {
    if ((init.method || 'GET').toUpperCase() === 'PATCH') return jsonRes(200, []);
    return jsonRes(200, [{
      encrypted_refresh_token: encrypt('refresh-token-stub'),
      status: 'connected',
      scopes: 'https://www.googleapis.com/auth/gmail.compose',
    }]);
  }
  if (url.includes('/rest/v1/documents')) {
    return jsonRes(200, [{ ...DOC, matterspace_id: world.docMatter, storage_path: `${world.docMatter}/${DOC.storage_path}` }]);
  }
  if (url.includes('/rest/v1/rpc/matterspace_descendants')) {
    return jsonRes(200, [{ id: 'matter-child' }]);
  }
  // The matter's Record (migration 064). Reachable here because the gate now
  // calls the REAL lib/ledger.mjs, which goes through the real supabase-js
  // client — so what this harness inspects is the RPC that would reach the
  // database, not an assertion about a fake.
  if (url.includes('/rest/v1/rpc/ledger_append')) {
    if (world.ledger === 'fail') {
      return jsonRes(403, { code: '42501', message: 'matter matter-child is not accessible', details: null, hint: null });
    }
    if (world.ledger === 'absent') {
      return jsonRes(404, {
        code: 'PGRST202',
        message: 'Could not find the function public.ledger_append(...) in the schema cache',
        details: null, hint: null,
      });
    }
    return jsonRes(200, { id: 'event-1', seq: 1, hash: 'f'.repeat(64), chain_key: 'matter-child' });
  }
  if (url.includes('/rest/v1/matterspaces')) {
    // 'error' breaks the TIER WALK only (its select is the giveaway), so the
    // case under test is a seal that cannot be read — not a database that is
    // down, which every one of these endpoints already handled its own way.
    if (world.tier === 'error' && url.includes('parent_matterspace_id') && isServiceRole(init)) {
      return jsonRes(500, { message: 'tier lookup failed (stub)', code: 'XX000' });
    }
    const all = MATTERS();
    // sealedMatterIds(): the sealed ROOTS.
    if (url.includes('ai_tier=in.')) {
      if (world.sealRoots === 'error') return jsonRes(500, { message: 'seal lookup failed (stub)', code: 'XX000' });
      return jsonRes(200, Object.values(all).filter((m) => m.ai_tier === 'B' || m.ai_tier === 'C').map((m) => ({ id: m.id })));
    }
    // The extension's matter picker: everything the user can see.
    if (url.includes('order=')) {
      return jsonRes(200, Object.values(all).filter((m) => !m.hidden).map((m) => ({
        id: m.id, name: m.name, short_code: m.short_code,
        parent_matterspace_id: m.parent_matterspace_id, serverspace: { name: 'Quainton Law' },
      })));
    }
    const id = /id=eq\.([^&]+)/.exec(url)?.[1];
    const row = all[decodeURIComponent(id ?? '')];
    if (!row) return jsonRes(200, []);
    if (row.hidden && !isServiceRole(init)) return jsonRes(200, []); // RLS
    // `name` is here for /api/cloud-export, which reads it (user-scoped) to
    // decide the folder the copy lands in. The tier walk ignores it.
    return jsonRes(200, [{ id: row.id, name: row.name, parent_matterspace_id: row.parent_matterspace_id, ai_tier: row.ai_tier }]);
  }
  return jsonRes(404, { message: 'no stub route', url });
}

// ── the two other drives, faked ──────────────────────────────────────────────
// Deterministic answers only: section 9 compares the outbound requests of the
// gated handler and main's byte for byte, so nothing here may vary per call.

function graphAnswer(url, init) {
  if (url.includes('/createUploadSession')) {
    return jsonRes(200, { uploadUrl: `https://${MS_UPLOAD_HOST}/session/abc`, expirationDateTime: '2030-01-01T00:00:00Z' });
  }
  if (url.endsWith('/me/drive/special/approot')) return jsonRes(200, { id: 'approot-id' });
  // A folder lookup: `…/items/{id}:/{name}`. The first export finds nothing
  // and creates it; the POST to /children answers with the new folder.
  if ((init.method || 'GET').toUpperCase() === 'POST' && url.endsWith('/children')) {
    let name = null;
    try { name = JSON.parse(String(init.body)).name; } catch { /* not ours */ }
    return jsonRes(201, { id: `folder-${name}` });
  }
  return jsonRes(404, { error: { code: 'itemNotFound', message: 'not found (stub)' } });
}

function dropboxApiAnswer(url) {
  if (url.includes('/oauth2/token')) return jsonRes(200, { access_token: 'stub-dbx-access-token', expires_in: 14400 });
  if (url.includes('/2/files/create_folder_v2')) return jsonRes(200, { metadata: { id: 'dbx-folder' } });
  if (url.includes('/2/auth/token/revoke')) return jsonRes(200, {});
  return jsonRes(404, { error_summary: 'no stub route' });
}

function dropboxContentAnswer(url) {
  if (url.includes('/2/files/upload_session/start')) return jsonRes(200, { session_id: 'dbx-session-1' });
  return jsonRes(200, { id: 'id:dbx-file-1', name: DOC.source_filename, path_display: `/Contextspaces/Calder v. Atlas/${DOC.source_filename}` });
}

function driveAnswer(url) {
  if (url.includes('/upload/drive/v3/files')) {
    return jsonRes(200, { id: 'drive-file-1', webViewLink: 'https://drive.google.test/file/d/drive-file-1', name: DOC.source_filename });
  }
  return jsonRes(200, { files: [{ id: 'folder-1', name: 'Contextspaces' }] });
}

// ── the HTTP layer, faked ────────────────────────────────────────────────
function fakeRes() {
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    write(s) { chunks.push(String(s)); return true; },
    end(s) { if (s !== undefined) chunks.push(String(s)); return this; },
    get text() { return chunks.join(''); },
    get json() { try { return JSON.parse(chunks.join('')); } catch { return null; } },
  };
}

async function post(handler, body, { token = 'stub-session-jwt' } = {}) {
  const res = fakeRes();
  await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body }, res);
  return res;
}
async function get(handler, query, { token = CSP_TOKEN } = {}) {
  const res = fakeRes();
  await handler({ method: 'GET', headers: { authorization: `Bearer ${token}` }, query }, res);
  return res;
}

// ── the negative control: main's handlers, reconstructed ─────────────────
// The gate is wired into each handler as an import line and one marked block,
// so deleting those lines reproduces the file as it stood on main. That is
// asserted two ways: the strip must remove something, and — when the base ref
// is reachable — the result is compared to `git show origin/main:<path>`.
const CONTROL_DIR = join(ROOT, 'node_modules', '.cache', 'export-gate-control');

function stripGate(src) {
  const out = [];
  let inBlock = false;
  let removed = 0;
  for (const line of src.split('\n')) {
    if (line.includes('gate:start')) { inBlock = true; removed++; continue; }
    if (line.includes('gate:end')) { inBlock = false; removed++; continue; }
    if (inBlock) { removed++; continue; }
    if (line.includes('// gate:import') || line.includes('// gate:line')) { removed++; continue; }
    out.push(line);
  }
  return { stripped: out.join('\n'), removed };
}

// One handler can serve two destinations (/api/cloud-export takes the service
// in its body), so the same file appears twice in PATHS. Reconstruct it once.
const mainCopies = new Map();

async function loadMainCopy(rel) {
  if (mainCopies.has(rel)) return mainCopies.get(rel);
  const loaded = await buildMainCopy(rel);
  mainCopies.set(rel, loaded);
  return loaded;
}

async function buildMainCopy(rel) {
  const current = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const { stripped, removed } = stripGate(current);
  check(removed > 0, `${rel}: the gate is wired in with removable markers`, { removed });
  check(!stripped.includes('export-gate'), `${rel}: stripping it leaves no trace of the gate`);
  try {
    const onMain = execFileSync('git', ['show', `origin/main:${rel}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .replace(/\r\n/g, '\n');
    // Once this lands, main carries the gate too and there is nothing left to
    // compare against — the identity claim belongs to the PR that introduced
    // it. The control below still runs; it is simply no longer also a proof
    // that the stripped file is what shipped before.
    if (onMain.includes('gate:start')) {
      skip(`${rel}: compare the stripped file to origin/main`, 'main carries the gate now');
    } else {
      check(stripped === onMain, `${rel}: the stripped file IS main's file, byte for byte`);
    }
  } catch {
    skip(`${rel}: compare the stripped file to origin/main`, 'the base ref is not fetched here');
  }
  // Bare specifiers still resolve from inside node_modules/.cache; the repo's
  // own lib/ does not, so those imports are rewritten to absolute file URLs.
  const libUrl = pathToFileURL(join(ROOT, 'lib')).href;
  const runnable = stripped.replace(/from '(?:\.\.\/)+lib\//g, `from '${libUrl}/`);
  mkdirSync(CONTROL_DIR, { recursive: true });
  const file = join(CONTROL_DIR, `${rel.replace(/[\\/]/g, '_')}.main.mjs`);
  writeFileSync(file, runnable, 'utf8');
  const mod = await import(pathToFileURL(file).href);
  return mod.default;
}

// What a request to an outside service looked like, for A/B comparison. The
// Supabase traffic is deliberately excluded: the gate adds two reads there,
// and the claim being tested is about what reaches Google.
const bodySig = (b) => {
  if (b == null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('base64');
  return String(b);
};
const outsideSignature = () => outside().map((r) => `${r.method} ${r.url}\n${bodySig(r.body)}`).join('\n--\n');

// A warning a lawyer would accept: a sentence, not a code; it names the seal,
// says the copy leaves, says nothing has gone yet, and is straight about
// whether anything is writing it down.
function readsLikeAWarning(msg) {
  if (typeof msg !== 'string' || msg.length < 120) return false;
  const m = msg.toLowerCase();
  return (m.includes('sealed') || m.includes('silo'))
    && m.includes('outside contextspaces')
    && m.includes('nothing has been sent yet')
    && (m.includes('record') || m.includes('logging'));
}

const PATHS = [
  { name: '/api/drive-export', rel: 'api/drive-export.mjs', handler: driveExport, service: 'google_drive', party: 'Google', body: (x) => ({ documentId: 'doc-1', folderName: 'Contextspaces', ...x }), call: post },
  { name: '/api/ext/push-to-drive', rel: 'api/ext/push-to-drive.mjs', handler: pushToDrive, service: 'google_drive', party: 'Google', body: (x) => ({ documentId: 'doc-1', ...x }), call: (h, b) => post(h, b, { token: CSP_TOKEN }) },
  { name: '/api/gmail-send', rel: 'api/gmail-send.mjs', handler: gmailSend, service: 'gmail', party: 'Google', body: (x) => ({ documentId: 'doc-1', ...x }), call: post },
  // The same handler, twice. /api/cloud-export takes the service in its body,
  // so both drives run the WHOLE table below — every assertion the three
  // Google routes get, OneDrive and Dropbox get too, including the egress
  // witness and the negative control.
  { name: '/api/cloud-export (onedrive)', rel: 'api/cloud-export.mjs', handler: cloudExport, service: 'onedrive', party: 'Microsoft', body: (x) => ({ service: 'onedrive', documentId: 'doc-1', ...x }), call: post },
  { name: '/api/cloud-export (dropbox)', rel: 'api/cloud-export.mjs', handler: cloudExport, service: 'dropbox', party: 'Dropbox', body: (x) => ({ service: 'dropbox', documentId: 'doc-1', ...x }), call: post },
];

try {
  // ── 1. Sealed and not yet confirmed: nothing moves ──────────────────────
  console.log('\nA sealed matter, and the user has not been asked yet');
  for (const p of PATHS) {
    install({ tier: 'B' });
    __setLedgerForTests(null);
    const res = await p.call(p.handler, p.body());
    check(res.statusCode === 409, `${p.name}: 409, not an export`, { status: res.statusCode, body: res.text });
    check(res.json?.error === 'export_needs_confirmation' && res.json?.code === 'export_needs_confirmation',
      `${p.name}: a stable code the client recognises`, res.json);
    check(res.json?.sealed === true && res.json?.tier === 'B', `${p.name}: it names the seal`, res.json);
    check(readsLikeAWarning(res.json?.message), `${p.name}: a plain-language warning, not a bare code`, res.json?.message);
    check(res.json?.confirm_field === 'confirm_leave_seal',
      `${p.name}: it names the field a client with no UI of ours must send`, res.json);
    check(storageReads().length === 0, `${p.name}: egress witness — ZERO storage reads, the bytes were never fetched`, requests.map((r) => r.url));
    check(outside().length === 0, `${p.name}: egress witness — ZERO requests outside Supabase`, outsideHosts());
  }

  // ── 2. The confirmation must be literal `true` ──────────────────────────
  console.log('\nThe confirmation is explicit, per request, and never remembered');
  for (const p of PATHS) {
    install({ tier: 'B' });
    __setLedgerForTests(null);
    const res = await p.call(p.handler, p.body({ confirm_leave_seal: 'true' }));
    check(res.statusCode === 409, `${p.name}: a truthy STRING does not leave the seal (PR #159's rule)`, { status: res.statusCode });
    check(outside().length === 0, `${p.name}: and nothing was sent while it was refused`, outsideHosts());
  }
  {
    install({ tier: 'B' });
    __setLedgerForTests(null);
    await post(driveExport, { documentId: 'doc-1', confirm_leave_seal: true });
    const first = uploads().length;
    const res = await post(driveExport, { documentId: 'doc-1' });
    check(first === 1 && res.statusCode === 409,
      'a confirmed export does not authorise the NEXT one — the server remembers nothing', { first, second: res.statusCode });
  }

  // ── 3. Sealed and confirmed, with no ledger on this server ──────────────
  console.log('\nSealed, confirmed, and the ledger is not built yet');
  for (const p of PATHS) {
    install({ tier: 'B' });
    __setLedgerForTests(null);
    const warned = await p.call(p.handler, p.body());
    check(warned.json?.will_record === false, `${p.name}: will_record is false`, warned.json);
    check(/not written to any record yet/i.test(warned.json?.message ?? ''),
      `${p.name}: and the warning says so — no claim of a record that does not exist`, warned.json?.message);

    install({ tier: 'B' });
    const res = await p.call(p.handler, p.body({ confirm_leave_seal: true }));
    check(res.statusCode === 200 && res.json?.ok === true, `${p.name}: the export proceeds`, { status: res.statusCode, body: res.text.slice(0, 200) });
    check(uploads().length === 1, `${p.name}: exactly one upload`, requests.map((r) => r.url));
    check(res.json?.seal?.sealed === true && res.json?.seal?.recorded === false,
      `${p.name}: the answer admits the copy left and that nothing recorded it`, res.json?.seal);
    check(/not written to any record/i.test(res.json?.seal?.note ?? ''), `${p.name}: in words the banner can show`, res.json?.seal?.note);
  }

  // ── 4. Sealed and confirmed, with the ledger present ────────────────────
  // The REAL lib/ledger.mjs (W1, migration 064), reached through the real
  // supabase-js client, so what is inspected below is the RPC that would hit
  // the database. A hand-written fake used to stand here, and it hid a defect
  // it could not have caught: record() is `record(client, opts = {})`, whose
  // Function.length is 1, so this module's arity guess called `record(event)`
  // — the event where the client belongs. record() then returned
  // {ok:false,'no supabase client'} WITHOUT throwing, and the gate answered
  // `recorded: true`. A lawyer would have been told a sealed export was in
  // the matter's Record while nothing had been written.
  console.log('\nSealed, confirmed, and the ledger IS present (the real lib/ledger.mjs)');
  __setLedgerForTests(undefined);
  __setLedgerImporterForTests();   // the real dynamic import
  for (const p of PATHS) {
    install({ tier: 'B' });
    const warned = await p.call(p.handler, p.body());
    check(warned.json?.will_record === true, `${p.name}: will_record is true`, warned.json);
    check(/written to this matter/i.test(warned.json?.message ?? ''),
      `${p.name}: and the SAME dialog now says it is recorded`, warned.json?.message);

    install({ tier: 'B' });
    const res = await p.call(p.handler, p.body({ confirm_leave_seal: true }));
    check(res.statusCode === 200 && ledgerCalls().length === 1,
      `${p.name}: exactly one event is appended`, { status: res.statusCode, writes: ledgerCalls().length });
    const ev = ledgerBody() ?? {};
    check(ev.p_kind === 'file.exported', `${p.name}: recorded as a file.exported`, ev.p_kind);
    check(ev.p_payload?.document_id === 'doc-1' && ev.p_payload?.title === DOC.title,
      `${p.name}: the record says what left`, ev.p_payload);
    check(ev.p_actor_kind === 'user' && ev.p_actor_ref === 'user-1',
      `${p.name}: and from whom — the WHEN is 064's own server clock, not a client timestamp`, { kind: ev.p_actor_kind, ref: ev.p_actor_ref });
    check(ev.p_matter === 'matter-child' && ev.p_payload?.tier === 'B',
      `${p.name}: and which matter it left, on that matter's chain`, { matter: ev.p_matter, tier: ev.p_payload?.tier });
    check(ev.p_payload?.destination?.service === p.service
      && ev.p_payload?.destination?.party === p.party,
      `${p.name}: and who received it`, ev.p_payload?.destination);
    const payload = JSON.stringify(ev);
    check(!payload.includes('CONFIDENTIAL-PAYLOAD') && !payload.includes(DOC.storage_path) && !/refresh|access_token|Bearer/i.test(payload),
      `${p.name}: METADATA ONLY — no content, no storage path, no token`, payload.slice(0, 300));
    check(ev.p_payload?.destination?.recipient_domain === null, `${p.name}: no recipient address is kept`, ev.p_payload?.destination);
    check(res.json?.seal?.recorded === true && /recorded in the matter/i.test(res.json?.seal?.note ?? ''),
      `${p.name}: and the user is told it was recorded`, res.json?.seal);
  }

  // The write is REFUSED by the database — the gate must not claim a record.
  // This is the case the old arity guess turned into a silent `recorded:true`.
  console.log('\nSealed, confirmed, and the Record REFUSES the write');
  {
    install({ tier: 'B', ledger: 'fail' });
    const res = await post(driveExport, { documentId: 'doc-1', confirm_leave_seal: true });
    check(res.statusCode === 200 && uploads().length === 1,
      'warn and record, never warn and refuse: the export still happens', { status: res.statusCode, uploads: uploads().length });
    check(res.json?.seal?.recorded === false, 'but it is NOT reported as recorded', res.json?.seal);
    check(/could not be written/i.test(res.json?.seal?.note ?? ''),
      'and the banner says the record FAILED, not that records do not exist yet', res.json?.seal?.note);
  }
  // 064 merged but not yet pasted: absent, not failed — the honest sentence.
  {
    install({ tier: 'B', ledger: 'absent' });
    const res = await post(driveExport, { documentId: 'doc-1', confirm_leave_seal: true });
    check(res.json?.seal?.recorded === false && /not written to any record yet/i.test(res.json?.seal?.note ?? ''),
      'ledger_append NOT DEPLOYED (PGRST202) reads as absent, not as a failure', res.json?.seal);
  }

  // ── 5. The seam itself: absent, present, present-but-broken ─────────────
  // None of the three depends on the filesystem any more. lib/ledger.mjs now
  // EXISTS, so "with lib/ledger.mjs absent…" was asserting nothing about the
  // sentence it printed; the absent case is modelled by an IMPORT that
  // rejects the way Node rejects a missing module.
  console.log('\nThe ledger seam — all three states, none of them the filesystem');
  const moduleNotFound = () => {
    const err = new Error("Cannot find module './ledger.mjs' imported from lib/export-gate.mjs");
    err.code = 'ERR_MODULE_NOT_FOUND';
    return Promise.reject(err);
  };

  __setLedgerForTests(undefined);
  __setLedgerImporterForTests(moduleNotFound);
  check((await exportsAreRecorded()) === false,
    'ABSENT: an import that rejects with ERR_MODULE_NOT_FOUND answers false instead of throwing');
  {
    install({ tier: 'B' });
    const out = await recordExport({
      supabase: userClient(), userId: 'user-1', tier: 'B', matterId: 'matter-child',
      documentId: 'doc-1', title: DOC.title, destination: { service: 'google_drive' },
    });
    check(out.recorded === false && out.reason === 'ledger_absent' && ledgerCalls().length === 0,
      'ABSENT: nothing is written, and nothing is attempted', { out: out.reason, calls: ledgerCalls().length });
    const note = exportedNote({ destination: { service: 'google_drive' }, recorded: false, reason: 'ledger_absent' });
    check(/not written to any record yet/i.test(note) && !/could not be written/i.test(note),
      'ABSENT: the wording is the truthful one — no record exists to have failed', note);
    const msg = exportConfirmMessage({ tier: 'B', destination: { service: 'google_drive' }, title: 't', willRecord: false });
    check(/nothing logging that it did/i.test(msg) && !/written to this matter/i.test(msg),
      'ABSENT: and the dialog promises no record it cannot keep', msg);
  }

  __setLedgerImporterForTests();   // restore the real import
  check((await exportsAreRecorded()) === true,
    'PRESENT: the real lib/ledger.mjs is found, and the probe says so');
  {
    install({ tier: 'B' });
    const out = await recordExport({
      supabase: userClient(), userId: 'user-1', tier: 'B', matterId: 'matter-child',
      documentId: 'doc-1', title: DOC.title, destination: { service: 'google_drive' },
    });
    check(out.recorded === true && ledgerCalls().length === 1,
      'PRESENT: record() is called exactly once, and reports the write', { out: out.recorded, calls: ledgerCalls().length });
    const ev = ledgerBody() ?? {};
    check(ev.p_kind === 'file.exported' && ev.p_matter === 'matter-child' && ev.p_payload?.title === DOC.title,
      'PRESENT: with the metadata, on the right chain', ev);
    check(!JSON.stringify(ev).includes('CONFIDENTIAL-PAYLOAD') && !JSON.stringify(ev).includes(DOC.storage_path),
      'PRESENT: and metadata ONLY');
    const note = exportedNote({ destination: { service: 'google_drive' }, recorded: true });
    check(/recorded in the matter/i.test(note), 'PRESENT: the banner says it is recorded', note);
  }

  __setLedgerForTests({ record: async () => { throw new Error('ledger exploded'); } });
  {
    install({ tier: 'B' });
    const out = await recordExport({
      supabase: userClient(), userId: 'user-1', tier: 'B', matterId: 'matter-child',
      documentId: 'doc-1', title: DOC.title, destination: { service: 'google_drive' },
    });
    check(out.recorded === false && out.reason === 'ledger_error',
      'THROWS: a ledger that throws does not blow up the export — it degrades to a log line and says recorded:false');
    const note = exportedNote({ destination: { service: 'google_drive' }, recorded: false, reason: 'ledger_error' });
    check(/could not be written/i.test(note) && !/not written to any record yet/i.test(note),
      'THROWS: and the user is told the record FAILED, not that records do not exist yet', note);
  }
  __setLedgerForTests(null);
  check(exportEventKind({ service: 'gmail', delivery: 'draft' }) === 'file.exported',
    "a Gmail DRAFT is recorded as file.exported — nothing was sent to anyone, and the record says only what is true");
  check(exportEventKind({ service: 'gmail', recipient: 'opposing@counsel.test' }) === 'file.sent',
    'a mail with a recipient is a file.sent');
  {
    const out = await recordExport({ userId: 'u', tier: 'B', matterId: 'm', documentId: 'd', title: 't', destination: { service: 'gmail', recipient: 'Opposing.Counsel@Firm.TEST' } });
    check(out.event.destination.recipient_domain === 'firm.test' && !JSON.stringify(out.event).toLowerCase().includes('opposing'),
      'for mail, the DOMAIN is recorded and the address is not');
  }

  // ── 6. Fail closed ──────────────────────────────────────────────────────
  console.log('\nWhen the seal cannot be read, nothing leaves');
  for (const p of PATHS) {
    install({ tier: 'error' });
    const res = await p.call(p.handler, p.body({ confirm_leave_seal: true }));
    check(res.statusCode === 403 && res.json?.error === 'export_seal_unresolved',
      `${p.name}: an unreadable tier is a refusal, even WITH a confirmation`, { status: res.statusCode, body: res.json });
    check(storageReads().length === 0 && outside().length === 0, `${p.name}: and nothing was fetched or sent`, outsideHosts());
  }
  {
    const thrower = { from: () => { throw new Error('client exploded'); } };
    const out = await checkExport({ supabase: thrower, userId: 'u', documentId: 'doc-1', destination: { service: 'google_drive' }, confirmed: true });
    check(out.ok === false && out.status === 403, 'a supabase client that throws never returns "send it"', out);
  }

  // ── 7. The inherited seal, and why the tier is read with the service role ─
  console.log('\nThe seal is inherited — including from a parent the caller cannot see');
  {
    install({ tier: 'B', hideParent: true });
    const userClient = createClient(SUPABASE_URL, 'anon-stub-not-a-key', { auth: { persistSession: false, autoRefreshToken: false } });
    const userWalk = await matterTierWithClient(userClient, 'matter-child');
    check(userWalk === 'A', 'a USER-scoped walk stops at the hidden parent and reports Tier A — the fail-open this avoids', userWalk);

    install({ tier: 'B', hideParent: true });
    const res = await post(driveExport, { documentId: 'doc-1' });
    check(res.statusCode === 409 && res.json?.tier === 'B',
      'the gate reads the tier with the service role and sees the parent’s seal', { status: res.statusCode, body: res.json });
    check(outside().length === 0, 'and the copy stays put', outsideHosts());
  }

  // ── 8. Tier C ───────────────────────────────────────────────────────────
  console.log('\nA Silo matter (Tier C)');
  {
    install({ tier: 'C' });
    __setLedgerForTests(null);
    const res = await post(driveExport, { documentId: 'doc-1' });
    check(res.statusCode === 409 && res.json?.tier === 'C', 'warned, like Tier B — Eden’s decision was warn and record, not block', res.json);
    check(/silo/i.test(res.json?.message ?? ''), 'and told a different, truer thing than a Tier-B matter is', res.json?.message);
    check(outside().length === 0, 'nothing sent while it waits for an answer', outsideHosts());
  }

  // ── 9. Unsealed: identical to main, to the byte ─────────────────────────
  console.log('\nAn unsealed matter behaves exactly as it did before the gate existed');
  const MAIN = {};
  for (const p of PATHS) MAIN[p.name] = await loadMainCopy(p.rel);
  for (const p of PATHS) {
    install({ tier: 'A' });
    const gated = await p.call(p.handler, p.body());
    const gatedSig = outsideSignature();
    install({ tier: 'A' });
    const control = await p.call(MAIN[p.name], p.body());
    const controlSig = outsideSignature();
    check(gated.statusCode === 200 && control.statusCode === 200, `${p.name}: both export`, { gated: gated.statusCode, main: control.statusCode });
    check(gatedSig === controlSig, `${p.name}: the requests to ${p.party} are byte-identical to the ungated file's`, { gated: gatedSig.slice(0, 200), main: controlSig.slice(0, 200) });
    check(JSON.stringify(gated.json) === JSON.stringify(control.json), `${p.name}: and so is the response body`, { gated: gated.json, main: control.json });
    check(gated.json?.seal === undefined, `${p.name}: no 'seal' key on an unsealed export`, gated.json);
  }
  {
    // Until 097 this row exported, as /api/llm treats an unbound draft. A
    // stored file in NO matter cannot exist in the database
    // (documents.matterspace_id is NOT NULL since 002), and since 097 every
    // route refuses a file not filed under its row's own matter before the
    // service role reads a byte (lib/storage-path.mjs) — fail closed.
    install({ tier: 'B', docMatter: null });
    const res = await post(driveExport, { documentId: 'doc-1' });
    check(res.statusCode === 409 && res.json?.error === 'storage_path_mismatch' && storageReads().length === 0,
      'a stored file in no matter is refused before any read (097), not exported', { status: res.statusCode, body: res.json });
  }

  // ── 10. NEGATIVE CONTROL ────────────────────────────────────────────────
  console.log('\nNegative control — main’s handlers, on the same sealed matter');
  for (const p of PATHS) {
    install({ tier: 'B' });
    const res = await p.call(MAIN[p.name], p.body());
    check(res.statusCode === 200, `${p.name} on main: exports a SEALED matter's document without asking`, { status: res.statusCode });
    check(storageReads().length === 1 && uploads().length === 1,
      `${p.name} on main: the bytes are read from storage and uploaded to ${p.party}`, { storage: storageReads().length, uploads: uploads().length });
    const sentBytes = requests.some((r) => bodySig(r.body).includes(FILE_BYTES.toString('base64')) || String(r.body ?? '').includes('CONFIDENTIAL-PAYLOAD'));
    check(sentBytes, `${p.name} on main: the document's own bytes leave the building — the checks above are not vacuous`);
  }

  // ── 11. The extension's listing endpoints ───────────────────────────────
  console.log('\nThe extension’s listings: names, never content — and the seal is marked');
  {
    install({ tier: 'B' });
    const res = await get(extMatters, {});
    const body = res.json;
    const child = body?.matters?.find((m) => m.id === 'matter-child');
    const open = body?.matters?.find((m) => m.id === 'matter-open');
    check(res.statusCode === 200 && body?.seal_status === 'ok', '/api/ext/matters answers', body);
    check(child?.sealed === true, 'a matter sealed by an ancestor the user cannot see is marked sealed', child);
    check(open?.sealed === false, 'an open matter is not', open);
    check(Boolean(child?.name), 'the user’s own tool still sees their own matters — names are not content');
    check(!/passage|storage_path|signed|token|CONFIDENTIAL/i.test(res.text), 'nothing in the answer is document content', res.text.slice(0, 200));
    check(outside().length === 0, 'and the listing contacts nothing outside Supabase', outsideHosts());

    install({ tier: 'B', sealRoots: 'error' });
    const failed = await get(extMatters, {});
    check(failed.json?.seal_status === 'unknown' && failed.json?.matters?.every((m) => m.sealed === true),
      'a seal lookup that fails marks everything sealed — over-warning, never under-warning', failed.json);
  }
  {
    install({ tier: 'B' });
    const res = await get(extDocuments, { matter: 'matter-child' });
    check(res.statusCode === 200 && res.json?.sealed === true && res.json?.ai_tier === 'B',
      '/api/ext/documents marks the matter sealed (service-role tier, so an unseen parent still counts)', res.json);
    check(res.json?.documents?.[0]?.sealed === true && res.json.documents[0].title === DOC.title,
      'each document carries the flag beside its title', res.json?.documents?.[0]);
    check(!/storage_path|signed|CONFIDENTIAL|passage/i.test(res.text),
      'titles and sizes only — no storage path, no signed URL, no text of the document', res.text.slice(0, 300));

    install({ tier: 'error' });
    const failed = await get(extDocuments, { matter: 'matter-child' });
    check(failed.json?.seal_status === 'unknown' && failed.json?.sealed === true,
      'an unreadable tier reports sealed, not open', failed.json);
  }

  // ── 12. One gate, and the shape a future connector passes through ───────
  console.log('\nOne gate for every destination, present and future');
  for (const service of ['google_drive', 'gmail', 'onedrive', 'dropbox']) {
    check(Boolean(EXPORT_SERVICES[service]), `${service} is registered as a destination`);
  }
  {
    const msg = exportConfirmMessage({ tier: 'B', destination: { service: 'onedrive' }, title: 'x', willRecord: true });
    check(msg.includes('OneDrive') && msg.includes('Microsoft'),
      'an unbuilt destination already gets a true warning naming who receives the copy — no code change at the gate', msg);
  }
  {
    install({ tier: 'B' });
    __setLedgerForTests(null);
    const out = await checkExport({
      supabase: createClient(SUPABASE_URL, 'anon-stub-not-a-key', { auth: { persistSession: false, autoRefreshToken: false } }),
      userId: 'user-1', documentId: 'doc-1', destination: { service: 'dropbox' }, confirmed: false,
    });
    check(out.ok === false && out.status === 409 && out.body.destination.service === 'dropbox',
      'and the same function answers for it unchanged', out.body);
  }
} finally {
  restore();
  try { rmSync(CONTROL_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

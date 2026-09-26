// OneDrive and Dropbox: the OAuth flow, the least-privilege scopes, the
// app-folder upload, and migration 075 — all of it offline.
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//   node scripts/_verify-cloud-drives.mjs
//
// OFFLINE AND SECRET-FREE BY CONSTRUCTION. No .env is read, every key here is
// a fake string, `fetch` is replaced by a witness that answers as Supabase, as
// Microsoft and as Dropbox, and migration 075 runs inside PGlite (Postgres
// compiled to WASM, in this process). **No request reaches Microsoft or
// Dropbox** — there are no app registrations yet, and this harness must keep
// working on the day there are.
//
// The seal is NOT re-proved here. scripts/_verify-export-gate.mjs now runs its
// whole table against both new destinations — the egress witness on a 409, the
// literal-`true` confirmation, the metadata-only record, fail-closed, and the
// negative control that watches an ungated handler leak. This file is about
// everything else, in this order:
//
//   1. Migration 075 — applied, idempotent, and correct from any drift state.
//   2. The authorize URL: the least-privilege scope and nothing wider, PKCE
//      S256, and a signed state.
//   3. The callback: a state minted for the other drive is refused, a forged
//      state is refused, and a code with no PKCE cookie is refused. The happy
//      path stores an ENCRYPTED refresh token on the right `kind`.
//   4. Refresh: Microsoft rotates and the new token is written back; Dropbox
//      does not rotate and nothing is written.
//   5. The upload: into the app folder, at Contextspaces/<matter>/<file>,
//      with names sanitized, never overwriting, and — for a large file — over
//      the provider's own upload-session API.
//   6. Dormancy: with the keys absent every endpoint answers 503
//      not_configured and the Connections probe says so, rather than offering
//      a button that cannot work.
//   7. Disconnect: Dropbox is revoked at Dropbox; Microsoft, which publishes
//      no equivalent, is deleted locally and the user is told where to finish.
//   8. NEGATIVE CONTROL: api/drive-export.mjs is byte-for-byte origin/main's.
//      Google's path is not what this lane was allowed to touch.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── env, BEFORE the modules are imported ─────────────────────────────────
const SUPABASE_URL = 'https://stub.supabase.test';
const SUPA_HOST = 'stub.supabase.test';
const SERVICE_KEY = 'service-role-stub-not-a-key';
process.env.VITE_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.VITE_SUPABASE_ANON_KEY = 'anon-stub-not-a-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
process.env.CONNECTIONS_ENC_KEY = 'stub-connections-encryption-key-not-a-secret';
process.env.MCP_OAUTH_SECRET = 'harness-oauth-secret-that-is-long-enough-32+';
process.env.MS_OAUTH_CLIENT_ID = 'stub-ms-client-id';
process.env.MS_OAUTH_CLIENT_SECRET = 'stub-ms-client-secret';
process.env.MS_OAUTH_TENANT = 'common';
process.env.DROPBOX_APP_KEY = 'stub-dropbox-app-key';
process.env.DROPBOX_APP_SECRET = 'stub-dropbox-app-secret';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const migrationSql = (name) => readFileSync(path.join(ROOT, 'supabase', 'migrations', name), 'utf8');

const { onedrive } = await import('../lib/cloud-drives/onedrive.mjs');
const { dropbox, asciiJson } = await import('../lib/cloud-drives/dropbox.mjs');
const { challengeFor, verifierCookieName } = await import('../lib/cloud-drives/index.mjs');
const { sanitizeSegment, sanitizeFilename, exportPath } = await import('../lib/cloud-drives/paths.mjs');
const { signJwt } = await import('../lib/oauth-jwt.mjs');
const { decrypt } = await import('../lib/connections-crypto.mjs');
const { default: msConnect } = await import('../api/microsoft-connect.mjs');
const { default: msCallback } = await import('../api/microsoft-callback.mjs');
const { default: dbxConnect } = await import('../api/dropbox-connect.mjs');
const { default: dbxCallback } = await import('../api/dropbox-callback.mjs');
const { default: cloudExport } = await import('../api/cloud-export.mjs');

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${String(JSON.stringify(d)).slice(0, 400)}` : ''}`);
  failures++;
};
const check = (cond, m, d) => (cond ? pass(m) : fail(m, d));
const skip = (m, why) => console.log(`  SKIP  ${m} — ${why}`);
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

// ── the world ────────────────────────────────────────────────────────────
const DOC = Object.freeze({
  id: 'doc-1',
  title: 'Calder v. Atlas — settlement memo',
  source_filename: 'settlement:memo?.pdf',
  // Filed under its own matter, as migration 097 requires (<matter>/<doc>/<file>).
  storage_path: 'matter-1/doc-1/settlement-memo.pdf',
  file_size_bytes: 21,
});
const MATTER_NAME = 'Calder v. Atlas — 7/12 "hearing"';
const FILE_BYTES = Buffer.from('CONFIDENTIAL-PAYLOAD!', 'utf8');
const MS_UPLOAD_HOST = 'upload.onedrive.test';

const realFetch = globalThis.fetch;
let requests = [];
let connectionsRows = [];

function install({ msRefresh = 'stub-ms-refresh-2', dbxRevokeOk = true } = {}) {
  requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const host = hostOf(url);
    requests.push({ url, host, method: (init.method || 'GET').toUpperCase(), body: init.body, headers: init.headers || {} });
    if (host === SUPA_HOST) return supabaseAnswer(url, init);
    if (host === 'login.microsoftonline.com') {
      return jsonRes(200, {
        access_token: 'stub-ms-access', expires_in: 3600,
        ...(msRefresh ? { refresh_token: msRefresh } : {}),
        id_token: fakeIdToken('eden@quaintonlaw.test'),
        scope: onedrive.scopeString(),
      });
    }
    if (host === 'graph.microsoft.com') return graphAnswer(url, init);
    if (host === MS_UPLOAD_HOST) {
      return jsonRes(200, { id: 'onedrive-file-1', name: 'settlement memo.pdf', webUrl: 'https://onedrive.test/f/1' });
    }
    if (host === 'api.dropboxapi.com') {
      if (url.includes('/oauth2/token')) {
        return jsonRes(200, { access_token: 'stub-dbx-access', expires_in: 14400, refresh_token: 'stub-dbx-refresh', scope: 'files.content.write' });
      }
      if (url.includes('/2/auth/token/revoke')) return dbxRevokeOk ? jsonRes(200, {}) : jsonRes(401, { error_summary: 'expired_access_token/' });
      if (url.includes('/2/files/create_folder_v2')) return jsonRes(200, { metadata: { id: 'dbx-folder' } });
      return jsonRes(404, { error_summary: 'no stub route' });
    }
    if (host === 'content.dropboxapi.com') {
      if (url.includes('/upload_session/start')) return jsonRes(200, { session_id: 'dbx-session-1' });
      if (url.includes('/upload_session/append_v2')) return jsonRes(200, {});
      return jsonRes(200, { id: 'id:dbx-1', name: 'settlement memo.pdf', path_display: '/Contextspaces/m/settlement memo.pdf' });
    }
    return jsonRes(500, { error: 'unexpected_host', host });
  };
}
const restore = () => { globalThis.fetch = realFetch; };

const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u); } };
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return String(u); } };
const outside = () => requests.filter((r) => r.host !== SUPA_HOST);
const to = (host) => requests.filter((r) => r.host === host);
const jsonRes = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function fakeIdToken(email) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b({ email })}.sig`;
}

function supabaseAnswer(url, init) {
  const method = (init.method || 'GET').toUpperCase();
  if (url.includes('/auth/v1/user')) {
    return jsonRes(200, {
      id: 'user-1', aud: 'authenticated', role: 'authenticated', email: 'stub@example.test',
      app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z',
    });
  }
  if (url.includes('/storage/v1/object/')) {
    return new Response(FILE_BYTES, { status: 200, headers: { 'content-type': 'application/pdf' } });
  }
  if (url.includes('/rest/v1/connections')) {
    if (method === 'POST') {
      let rows = [];
      try { rows = JSON.parse(String(init.body)); } catch { rows = []; }
      for (const row of [].concat(rows)) {
        const i = connectionsRows.findIndex((r) => r.user_id === row.user_id && r.kind === row.kind);
        if (i >= 0) connectionsRows[i] = { ...connectionsRows[i], ...row };
        else connectionsRows.push({ ...row });
      }
      return jsonRes(201, []);
    }
    if (method === 'PATCH') {
      let patch = {};
      try { patch = JSON.parse(String(init.body)); } catch { patch = {}; }
      const kind = /kind=eq\.([^&]+)/.exec(url)?.[1];
      for (const row of connectionsRows) {
        if (!kind || row.kind === decodeURIComponent(kind)) Object.assign(row, patch);
      }
      return jsonRes(200, []);
    }
    if (method === 'DELETE') {
      const kind = decodeURIComponent(/kind=eq\.([^&]+)/.exec(url)?.[1] ?? '');
      connectionsRows = connectionsRows.filter((r) => r.kind !== kind);
      return jsonRes(200, []);
    }
    const kind = decodeURIComponent(/kind=eq\.([^&]+)/.exec(url)?.[1] ?? '');
    return jsonRes(200, connectionsRows.filter((r) => !kind || r.kind === kind));
  }
  if (url.includes('/rest/v1/documents')) return jsonRes(200, [{ ...DOC, matterspace_id: 'matter-1' }]);
  if (url.includes('/rest/v1/matterspaces')) {
    return jsonRes(200, [{ id: 'matter-1', name: MATTER_NAME, parent_matterspace_id: null, ai_tier: 'A' }]);
  }
  return jsonRes(404, { message: 'no stub route', url });
}

function graphAnswer(url, init) {
  if (url.includes('/createUploadSession')) {
    return jsonRes(200, { uploadUrl: `https://${MS_UPLOAD_HOST}/session/abc` });
  }
  if (url.endsWith('/me/drive/special/approot')) return jsonRes(200, { id: 'approot-id' });
  if ((init.method || 'GET').toUpperCase() === 'POST' && url.endsWith('/children')) {
    let name = null;
    try { name = JSON.parse(String(init.body)).name; } catch { /* not ours */ }
    return jsonRes(201, { id: `folder:${name}` });
  }
  return jsonRes(404, { error: { code: 'itemNotFound', message: 'not found (stub)' } });
}

// ── the HTTP layer, faked ────────────────────────────────────────────────
function fakeRes() {
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    end(s) { if (s !== undefined) chunks.push(String(s)); return this; },
    get text() { return chunks.join(''); },
    get json() { try { return JSON.parse(chunks.join('')); } catch { return null; } },
    get setCookie() { return [].concat(this.headers['set-cookie'] ?? []); },
    get location() { return this.headers.location ?? null; },
  };
}

async function call(handler, { method = 'POST', body, query, cookie, token = 'stub-session-jwt' } = {}) {
  const res = fakeRes();
  const headers = { authorization: `Bearer ${token}` };
  if (cookie) headers.cookie = cookie;
  await handler({ method, headers, body, query: query ?? {} }, res);
  return res;
}

const headerOf = (h, name) => {
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v;
  return null;
};
const formOf = (body) => Object.fromEntries(new URLSearchParams(String(body ?? '')));

const DRIVES = [
  { drive: onedrive, connect: msConnect, callback: msCallback, authHost: 'login.microsoftonline.com' },
  { drive: dropbox, connect: dbxConnect, callback: dbxCallback, authHost: 'www.dropbox.com' },
];

try {
  // =========================================================================
  section('1. migration 075 — from every drift state the folder allows');
  // =========================================================================
  let PGlite;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch {
    PGlite = null;
  }
  if (!PGlite) {
    skip('migration 075 in PGlite', 'PGlite is not installed (npm i --no-save @electric-sql/pglite)');
  } else {
    const bootstrap = async () => {
      const db = new PGlite();
      await db.exec(`
        do $$ begin create role anon;                   exception when duplicate_object then null; end $$;
        do $$ begin create role authenticated;          exception when duplicate_object then null; end $$;
        do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
        grant usage on schema public to anon, authenticated, service_role;
        create schema if not exists auth;
        create or replace function auth.uid() returns uuid language sql stable as $fn$
          select nullif(coalesce(
            nullif(current_setting('request.jwt.claim.sub', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
          ), '')::uuid
        $fn$;
        create table if not exists public.profiles (id uuid primary key, email text);
        insert into public.profiles (id, email)
          values ('11111111-1111-4111-8111-111111111111', 'a@example.test')
          on conflict (id) do nothing;
      `);
      return db;
    };
    const insertKind = async (db, kind) => {
      try {
        await db.query(
          `insert into public.connections (user_id, kind, encrypted_refresh_token)
           values ('11111111-1111-4111-8111-111111111111', $1, 'iv:tag:ct')`, [kind],
        );
        return null;
      } catch (e) {
        return e?.code ?? e?.cause?.code ?? 'error';
      }
    };

    // (a) the ordinary history: 026 → 029 → 075, and 075 twice.
    {
      const db = await bootstrap();
      await db.exec(migrationSql('026_connections.sql'));
      await db.exec(migrationSql('029_connections_google_drive_kind.sql'));
      await db.exec(migrationSql('075_connections_cloud_drive_kinds.sql'));
      await db.exec(migrationSql('075_connections_cloud_drive_kinds.sql')); // idempotent
      check((await insertKind(db, 'onedrive')) === null, '026→029→075: an onedrive row is accepted');
      check((await insertKind(db, 'dropbox')) === null, '026→029→075: a dropbox row is accepted');
      check((await insertKind(db, 'gmail')) === null, 'and gmail still is');
      check((await insertKind(db, 'microsoft_365')) === null,
        "microsoft_365 is kept — 029 allowed it, and a migration must not orphan a row that exists");
      check((await insertKind(db, 'sharepoint')) === '23514',
        'a kind nobody registered is still refused — the constraint was replaced, not dropped');
      const n = (await db.query(`
        select count(*)::int as n from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
         where rel.relname = 'connections' and con.contype = 'c'
           and pg_get_constraintdef(con.oid) ilike '%kind%'`)).rows[0].n;
      check(n === 1, 'exactly ONE kind check survives two runs — the DO block converges', { constraints: n });
      await db.close();
    }

    // (b) the drift the project has actually seen: 029 was never applied.
    {
      const db = await bootstrap();
      await db.exec(migrationSql('026_connections.sql'));
      await db.exec(migrationSql('075_connections_cloud_drive_kinds.sql'));
      check((await insertKind(db, 'onedrive')) === null,
        '026→075 with 029 NEVER APPLIED: still accepted (the live database is not the migrations folder)');
      check((await insertKind(db, 'google_drive')) === null, 'and 029\'s own values are put back');
      await db.close();
    }

    // (c) the table does not exist at all — 075 builds it.
    {
      const db = await bootstrap();
      await db.exec(migrationSql('075_connections_cloud_drive_kinds.sql'));
      check((await insertKind(db, 'dropbox')) === null, '075 on a database with no connections table at all: it creates one');
      const rls = (await db.query(`select relrowsecurity from pg_class where relname='connections'`)).rows[0];
      check(rls?.relrowsecurity === true, 'and RLS is on, with 026\'s two policies — never a table the browser can write');
      const policies = (await db.query(`select cmd from pg_policies where tablename='connections'`)).rows.map((r) => r.cmd).sort();
      check(JSON.stringify(policies) === JSON.stringify(['DELETE', 'SELECT']),
        'SELECT and DELETE only — no INSERT or UPDATE policy, exactly as 026 intended', policies);
      await db.close();
    }
  }

  // =========================================================================
  section('2. the authorize URL — least privilege, and PKCE');
  // =========================================================================
  for (const { drive, connect } of DRIVES) {
    install();
    const res = await call(connect);
    check(res.statusCode === 200 && typeof res.json?.url === 'string', `${drive.label}: a URL is returned`, res.json);
    const u = new URL(res.json.url);
    const q = u.searchParams;

    const scopes = (q.get('scope') ?? '').split(' ').filter(Boolean);
    if (drive.service === 'onedrive') {
      check(scopes.includes('Files.ReadWrite.AppFolder'), 'OneDrive asks for the APP FOLDER permission');
      check(!scopes.some((s) => /^Files\.ReadWrite(\.All)?$/.test(s)) && !scopes.includes('Files.Read.All'),
        'OneDrive never asks for the whole drive', scopes);
      check(scopes.includes('offline_access'), 'and for offline_access, or there is no refresh token');
      check(u.host === 'login.microsoftonline.com' && u.pathname === '/common/oauth2/v2.0/authorize',
        'at the documented v2.0 authorize endpoint', u.href);
    } else {
      check(scopes.length === 1 && scopes[0] === 'files.content.write',
        'Dropbox asks for ONE scope: files.content.write — it cannot even list the folder', scopes);
      check(q.get('token_access_type') === 'offline',
        'and token_access_type=offline, which is what makes Dropbox issue a refresh token');
      check(u.host === 'www.dropbox.com' && u.pathname === '/oauth2/authorize', 'at the documented authorize endpoint', u.href);
    }

    check(q.get('code_challenge_method') === 'S256', `${drive.label}: PKCE, and S256 rather than plain`);
    check((q.get('code_challenge') ?? '').length >= 43, `${drive.label}: a challenge is present`, q.get('code_challenge'));
    check(q.get('redirect_uri') === `https://www.contextspaces.ai${drive.redirectPath}`,
      `${drive.label}: the redirect URI is the registered production one, not a header-derived guess`, q.get('redirect_uri'));

    const cookie = res.setCookie.find((c) => c.startsWith(verifierCookieName(drive.service)));
    check(Boolean(cookie), `${drive.label}: the verifier is set as a cookie`, res.setCookie);
    check(/HttpOnly/i.test(cookie ?? '') && /Secure/i.test(cookie ?? '') && /SameSite=Lax/i.test(cookie ?? ''),
      `${drive.label}: HttpOnly, Secure, SameSite=Lax — script cannot read it, and the provider's redirect still sends it`, cookie);
    check((cookie ?? '').includes(`Path=${drive.redirectPath}`), `${drive.label}: scoped to its own callback`, cookie);

    const verifier = (cookie ?? '').split(';')[0].split('=')[1];
    check(challengeFor(verifier) === q.get('code_challenge'),
      `${drive.label}: the challenge really is S256 of the verifier the browser was given`);
    check(!res.json.url.includes(verifier),
      `${drive.label}: and the VERIFIER IS NOT IN THE URL — a state that carried it would defeat PKCE entirely`);

    check(outside().length === 0, `${drive.label}: starting a connection contacts nobody`, outside().map((r) => r.host));
  }

  // =========================================================================
  section('3. the callback — three ways in that are refused, and one that works');
  // =========================================================================
  for (const { drive, connect, callback } of DRIVES) {
    const other = drive.service === 'onedrive' ? dropbox : onedrive;

    // A state minted for the OTHER drive.
    install();
    const crossState = signJwt({ sub: 'user-1', kind: other.kind, svc: other.service }, process.env.MCP_OAUTH_SECRET, 600);
    let res = await call(callback, { method: 'GET', query: { code: 'c', state: crossState }, cookie: `${verifierCookieName(drive.service)}=v` });
    check(res.location?.includes('error=bad_state'),
      `${drive.label}: a state minted for ${other.label} is refused at this callback`, res.location);
    check(outside().length === 0, `${drive.label}: and no code is exchanged`, outside().map((r) => r.host));

    // A forged state (right shape, wrong signature).
    install();
    const forged = signJwt({ sub: 'user-1', kind: drive.kind, svc: drive.service }, 'not-the-real-secret-but-long-enough-32', 600);
    res = await call(callback, { method: 'GET', query: { code: 'c', state: forged }, cookie: `${verifierCookieName(drive.service)}=v` });
    check(res.location?.includes('error=bad_state'), `${drive.label}: a state we did not sign is refused`, res.location);
    check(outside().length === 0, `${drive.label}: and nothing is exchanged for it`);

    // A good state, but no PKCE cookie — i.e. a code redeemed in another browser.
    install();
    const good = signJwt({ sub: 'user-1', kind: drive.kind, svc: drive.service }, process.env.MCP_OAUTH_SECRET, 600);
    res = await call(callback, { method: 'GET', query: { code: 'c', state: good } });
    check(res.location?.includes('error=pkce_missing'),
      `${drive.label}: a code arriving without the verifier cookie is refused — PKCE binds it to one browser`, res.location);
    check(outside().length === 0, `${drive.label}: still nothing exchanged`);

    // The real round trip: connect, then callback with what connect issued.
    install();
    connectionsRows = [];
    const started = await call(connect);
    const startedUrl = new URL(started.json.url);
    const cookieHeader = started.setCookie[0].split(';')[0];
    const verifier = cookieHeader.split('=')[1];
    res = await call(callback, {
      method: 'GET',
      query: { code: 'auth-code-1', state: startedUrl.searchParams.get('state') },
      cookie: cookieHeader,
    });
    check(res.location?.includes(`connected=${drive.service}`), `${drive.label}: the happy path connects`, res.location);
    const exchange = outside().find((r) => String(r.url).includes('token'));
    const form = formOf(exchange?.body);
    check(form.code_verifier === verifier,
      `${drive.label}: the exchange carries the verifier from THAT browser's cookie`, Object.keys(form));
    check(form.grant_type === 'authorization_code' && form.redirect_uri === `https://www.contextspaces.ai${drive.redirectPath}`,
      `${drive.label}: with the same redirect URI the authorize call used`);
    const row = connectionsRows.find((r) => r.kind === drive.kind);
    check(Boolean(row), `${drive.label}: a connections row is written on kind '${drive.kind}'`, connectionsRows.map((r) => r.kind));
    check(row && !String(row.encrypted_refresh_token).includes('refresh'),
      `${drive.label}: the refresh token is stored ENCRYPTED, not in the clear`, row?.encrypted_refresh_token?.slice(0, 24));
    check(row && decrypt(row.encrypted_refresh_token).length > 0,
      `${drive.label}: and it decrypts back with the server's key`);
    const cleared = res.setCookie.find((c) => c.startsWith(verifierCookieName(drive.service)));
    check((cleared ?? '').includes('Max-Age=0'), `${drive.label}: the verifier cookie does not outlive the flow`, cleared);
  }
  {
    install();
    const res = await call(msCallback, { method: 'GET', query: { error: 'access_denied' } });
    check(res.location?.includes('error=access_denied') && outside().length === 0,
      'a user who says no is taken back with the provider\'s own reason, and nothing is exchanged', res.location);
  }

  // =========================================================================
  section('4. refresh — Microsoft rotates, Dropbox does not');
  // =========================================================================
  {
    install({ msRefresh: 'stub-ms-refresh-2' });
    const out = await onedrive.refresh({ refreshToken: 'stub-ms-refresh-1' });
    check(out.ok && out.accessToken === 'stub-ms-access', 'OneDrive: an access token comes back');
    check(out.refreshToken === 'stub-ms-refresh-2',
      'OneDrive: and a NEW refresh token — Microsoft rotates, and the old one is spent', out.refreshToken);

    install();
    const dbx = await dropbox.refresh({ refreshToken: 'stub-dbx-refresh-1' });
    check(dbx.ok && dbx.refreshToken === null,
      'Dropbox: no new refresh token, because Dropbox documents that it does not rotate');
    const form = formOf(to('api.dropboxapi.com')[0]?.body);
    check(form.grant_type === 'refresh_token' && form.client_id === 'stub-dropbox-app-key',
      'Dropbox: refreshed as a confidential client', Object.keys(form));
  }
  {
    // The rotated token must reach the database, or the connection dies later
    // with nothing to explain it. Driven through the real handler.
    install({ msRefresh: 'stub-ms-refresh-ROTATED' });
    connectionsRows = [{ user_id: 'user-1', kind: 'onedrive', status: 'connected', encrypted_refresh_token: (await import('../lib/connections-crypto.mjs')).encrypt('stub-ms-refresh-1') }];
    const res = await call(cloudExport, { body: { service: 'onedrive', documentId: 'doc-1' } });
    check(res.statusCode === 200, 'an unsealed OneDrive export succeeds', res.json);
    check(decrypt(connectionsRows[0].encrypted_refresh_token) === 'stub-ms-refresh-ROTATED',
      'and the ROTATED refresh token is written back, encrypted — the bug that would surface a week later');
  }
  {
    install();
    connectionsRows = [{ user_id: 'user-1', kind: 'dropbox', status: 'connected', encrypted_refresh_token: (await import('../lib/connections-crypto.mjs')).encrypt('stub-dbx-refresh-1') }];
    const before = connectionsRows[0].encrypted_refresh_token;
    await call(cloudExport, { body: { service: 'dropbox', documentId: 'doc-1' } });
    check(connectionsRows[0].encrypted_refresh_token === before,
      'Dropbox: nothing is rewritten, because nothing rotated');
  }

  // =========================================================================
  section('5. the upload — app folder, sanitized names, never overwriting');
  // =========================================================================
  check(sanitizeSegment('Calder v. Atlas — 7/12 "hearing"?') === 'Calder v. Atlas — 7 12 hearing',
    'a matter name keeps its em dash and loses only what a drive cannot take', sanitizeSegment(MATTER_NAME + '?'));
  check(sanitizeFilename('settlement:memo?.pdf') === 'settlement memo.pdf',
    'a file name keeps its extension', sanitizeFilename('settlement:memo?.pdf'));
  check(sanitizeSegment('Exhibit A.') === 'Exhibit A',
    'a trailing dot goes here, not silently on the provider after the name was chosen');
  check(sanitizeSegment('   ') === '' && exportPath({ matterName: '   ', filename: 'a.pdf' }).folders.length === 1,
    'a matter with no usable name puts the copy one level up, under Contextspaces/, rather than in a folder called nothing');

  {
    install();
    connectionsRows = [{ user_id: 'user-1', kind: 'onedrive', status: 'connected', encrypted_refresh_token: (await import('../lib/connections-crypto.mjs')).encrypt('r') }];
    const res = await call(cloudExport, { body: { service: 'onedrive', documentId: 'doc-1' } });
    check(res.statusCode === 200 && res.json?.ok === true, 'OneDrive: the export completes', res.json);

    const graph = to('graph.microsoft.com');
    check(graph.some((r) => r.url.endsWith('/me/drive/special/approot')),
      'OneDrive: the app folder is addressed as special/approot — the only place this token reaches');
    const folderNames = graph
      .filter((r) => r.method === 'POST' && r.url.endsWith('/children'))
      .map((r) => { try { return JSON.parse(String(r.body)); } catch { return {}; } });
    check(folderNames.some((f) => f.name === 'Contextspaces') && folderNames.some((f) => f.name === 'Calder v. Atlas — 7 12 hearing'),
      'OneDrive: Contextspaces/<matter> is created, with the sanitized name', folderNames.map((f) => f.name));
    check(folderNames.every((f) => f['@microsoft.graph.conflictBehavior'] === 'fail'),
      'OneDrive: folders are created with conflictBehavior FAIL — a second export joins the folder, it does not make "Contextspaces 1"');

    const session = graph.find((r) => r.url.includes('/createUploadSession'));
    check(Boolean(session), 'OneDrive: every upload goes through an upload session');
    check(decodeURIComponent(session.url).includes('settlement memo.pdf'),
      'OneDrive: at the sanitized file name', session && decodeURIComponent(session.url));
    const sessionBody = JSON.parse(String(session.body));
    check(sessionBody.item?.['@microsoft.graph.conflictBehavior'] === 'rename',
      'OneDrive: asking for RENAME — the documented way to never overwrite', sessionBody);

    const chunks = to(MS_UPLOAD_HOST);
    check(chunks.length === 1 && chunks[0].method === 'PUT', 'OneDrive: one chunk for a small file', chunks.length);
    check(headerOf(chunks[0].headers, 'authorization') == null,
      'OneDrive: and NO Authorization header on it — Graph answers 401 if you send one to a session URL');
    check(headerOf(chunks[0].headers, 'content-range') === `bytes 0-${FILE_BYTES.length - 1}/${FILE_BYTES.length}`,
      'OneDrive: with the documented Content-Range', headerOf(chunks[0].headers, 'content-range'));
    check(res.json?.name === 'settlement memo.pdf' && res.json?.link === 'https://onedrive.test/f/1',
      "OneDrive: the banner shows the provider's own answer, including any rename it applied", res.json);
  }

  {
    install();
    connectionsRows = [{ user_id: 'user-1', kind: 'dropbox', status: 'connected', encrypted_refresh_token: (await import('../lib/connections-crypto.mjs')).encrypt('r') }];
    const res = await call(cloudExport, { body: { service: 'dropbox', documentId: 'doc-1' } });
    check(res.statusCode === 200 && res.json?.ok === true, 'Dropbox: the export completes', res.json);

    const up = to('content.dropboxapi.com').find((r) => pathOf(r.url) === '/2/files/upload');
    check(Boolean(up), 'Dropbox: one shot for a small file, on the content host');
    const argHeader = headerOf(up.headers, 'dropbox-api-arg');
    const arg = JSON.parse(argHeader);
    check(arg.path === '/Contextspaces/Calder v. Atlas — 7 12 hearing/settlement memo.pdf',
      'Dropbox: Contextspaces/<matter>/<file>, inside the App folder', arg.path);
    check(arg.mode === 'add' && arg.autorename === true,
      'Dropbox: mode add + autorename — the only "never overwrite" available without a listing scope', arg);
    check(/^[\x00-\x7e]*$/.test(argHeader),
      'Dropbox-API-Arg IS PURE ASCII although the matter name has an em dash — an unescaped header is an invalid request',
      argHeader);
    check(argHeader.includes('\\u2014'), 'the em dash travelled as the documented \\uXXXX escape', argHeader);
    check(res.json?.link === null,
      'Dropbox: no link is offered, because one write-only scope cannot mint one — no dead button in the banner');
  }
  check(asciiJson({ n: 'Peña — “quoted”\u007f' }) === '{"n":"Pe\\u00f1a \\u2014 \\u201cquoted\\u201d\\u007f"}',
    'asciiJson escapes 0x7F and every non-ASCII character, as the Dropbox docs require', asciiJson({ n: 'Peña — “quoted”\u007f' }));

  {
    // A file past each provider's threshold takes the upload-session path.
    const big = Buffer.alloc(40 * 1024 * 1024, 7);
    install();
    const ms = await onedrive.upload({ accessToken: 'a', matterName: 'M', filename: 'big.bin', bytes: big });
    const chunks = to(MS_UPLOAD_HOST);
    check(ms.ok && chunks.length === 4, 'OneDrive: a 40 MiB file goes up in four 10 MiB chunks', chunks.length);
    check(chunks.slice(0, -1).every((c) => {
      const [range] = [headerOf(c.headers, 'content-range')];
      const m = /bytes (\d+)-(\d+)\//.exec(range ?? '');
      return m && (Number(m[2]) - Number(m[1]) + 1) % 327680 === 0;
    }), 'OneDrive: and every chunk but the last is a multiple of 320 KiB, as Graph requires');

    install();
    const dbx = await dropbox.upload({ accessToken: 'a', matterName: 'M', filename: 'big.bin', bytes: big });
    const calls = to('content.dropboxapi.com').map((r) => pathOf(r.url));
    check(dbx.ok && calls[0] === '/2/files/upload_session/start'
      && calls.includes('/2/files/upload_session/append_v2')
      && calls[calls.length - 1] === '/2/files/upload_session/finish',
      'Dropbox: a 40 MiB file goes through start → append_v2 → finish', calls);
    check(!calls.includes('/2/files/upload'), 'Dropbox: and never through the single-shot endpoint');
  }

  // =========================================================================
  section('6. dormant until Eden registers the two applications');
  // =========================================================================
  {
    const saved = {
      MS_OAUTH_CLIENT_ID: process.env.MS_OAUTH_CLIENT_ID,
      MS_OAUTH_CLIENT_SECRET: process.env.MS_OAUTH_CLIENT_SECRET,
      DROPBOX_APP_KEY: process.env.DROPBOX_APP_KEY,
      DROPBOX_APP_SECRET: process.env.DROPBOX_APP_SECRET,
    };
    for (const k of Object.keys(saved)) delete process.env[k];
    try {
      for (const { drive, connect, callback } of DRIVES) {
        install();
        const probe = await call(connect, { method: 'GET' });
        check(probe.statusCode === 200 && probe.json?.configured === false,
          `${drive.label}: the Connections probe says it is not available yet`, probe.json);
        check(Array.isArray(probe.json?.missing_env) && probe.json.missing_env.length === 2,
          `${drive.label}: and names the two variables that are missing`, probe.json?.missing_env);

        const started = await call(connect);
        check(started.statusCode === 503 && started.json?.error === 'not_configured',
          `${drive.label}: connecting answers 503 not_configured, never a 500`, started.json);
        check(started.setCookie.length === 0, `${drive.label}: and no PKCE cookie is minted for a flow that cannot run`);

        const cb = await call(callback, { method: 'GET', query: { code: 'c', state: 's' } });
        check(cb.location?.includes('error=not_configured'), `${drive.label}: the callback says the same`, cb.location);

        install();
        connectionsRows = [];
        const exp = await call(cloudExport, { body: { service: drive.service, documentId: 'doc-1' } });
        check(exp.statusCode === 503 && exp.json?.error === 'not_configured',
          `${drive.label}: and an export attempt answers 503 before the session is even read`, exp.json);
        check(requests.length === 0,
          `${drive.label}: NOTHING is contacted — not Supabase, not the provider`, requests.map((r) => r.host));
      }
    } finally {
      Object.assign(process.env, saved);
    }
  }
  {
    install();
    const res = await call(cloudExport, { body: { service: 'icloud', documentId: 'doc-1' } });
    check(res.statusCode === 400 && res.json?.error === 'unknown_service',
      'a service nobody built is a 400, not a crash', res.json);
  }
  {
    install();
    connectionsRows = [];
    const res = await call(cloudExport, { body: { service: 'dropbox', documentId: 'doc-1' } });
    check(res.statusCode === 412 && res.json?.error === 'cloud_not_connected',
      'configured but not connected is a 412 the reader turns into "Connect Dropbox in Connections first"', res.json);
  }

  // =========================================================================
  section('7. disconnect — revoked where a revoke exists, said plainly where not');
  // =========================================================================
  {
    install();
    connectionsRows = [{ user_id: 'user-1', kind: 'dropbox', status: 'connected', encrypted_refresh_token: (await import('../lib/connections-crypto.mjs')).encrypt('r') }];
    const res = await call(dbxConnect, { method: 'DELETE' });
    check(res.statusCode === 200 && res.json?.revoked_at_provider === true,
      'Dropbox: the token is revoked AT DROPBOX, which also kills the refresh token behind it', res.json);
    const revoke = to('api.dropboxapi.com').find((r) => r.url.includes('/2/auth/token/revoke'));
    check(Boolean(revoke) && headerOf(revoke.headers, 'authorization') === 'Bearer stub-dbx-access',
      'Dropbox: with a freshly minted access token, because the stored one is a refresh token');
    check(connectionsRows.length === 0, 'Dropbox: and only then is the row deleted');
  }
  {
    install();
    connectionsRows = [{ user_id: 'user-1', kind: 'onedrive', status: 'connected', encrypted_refresh_token: (await import('../lib/connections-crypto.mjs')).encrypt('r') }];
    const res = await call(msConnect, { method: 'DELETE' });
    check(res.statusCode === 200 && res.json?.revoked_at_provider === false,
      'OneDrive: no claim of a revoke Microsoft does not publish for one app\'s delegated tokens', res.json);
    check(res.json?.manage_url === 'https://myapps.microsoft.com',
      'OneDrive: instead the user is told where the grant itself is removed', res.json);
    check(connectionsRows.length === 0, 'OneDrive: and our copy is gone either way');
  }
  {
    install({ dbxRevokeOk: false });
    connectionsRows = [{ user_id: 'user-1', kind: 'dropbox', status: 'connected', encrypted_refresh_token: (await import('../lib/connections-crypto.mjs')).encrypt('r') }];
    const res = await call(dbxConnect, { method: 'DELETE' });
    check(res.statusCode === 200 && connectionsRows.length === 0 && res.json?.revoked_at_provider === false,
      'a provider that refuses the revoke does not strand the row — the delete still happens, and the answer does not pretend', res.json);
  }

  // =========================================================================
  section('8. negative control — Google Drive was not this lane\'s to touch');
  // =========================================================================
  {
    const rel = 'api/drive-export.mjs';
    const here = readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
    try {
      const onMain = execFileSync('git', ['show', `origin/main:${rel}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .replace(/\r\n/g, '\n');
      // Migration 097 (a separate lane) adds one import and one check to every
      // byte-reading route. Those lines are taken out before comparing, so this
      // still proves the cloud-drives lane never touched Google's path.
      const without097 = here
        .replace(/^import \{ pathInMatter \} from '[^']+';\n/m, '')
        .replace(/ {2}\/\/ 097: [\s\S]*?storage_path_mismatch' \}\);\n/, '')
        .replace("file_size_bytes, matterspace_id')", "file_size_bytes')");
      if (onMain.includes('pathInMatter')) {
        skip(`${rel} vs origin/main`, 'main carries 097 now');
      } else {
        check(without097 === onMain, `${rel} is byte-for-byte origin/main's (097's check aside) — Google's export is untouched by this PR`);
      }
    } catch {
      skip(`${rel} vs origin/main`, 'the base ref is not fetched here');
    }
    check(!here.includes('cloud-drives') && !here.includes('cloud-export'),
      `${rel} does not so much as import this lane's code`);
    const gateHarness = readFileSync(path.join(ROOT, 'scripts', '_verify-export-gate.mjs'), 'utf8');
    check(gateHarness.includes("service: 'onedrive'") && gateHarness.includes("service: 'dropbox'"),
      'and the seal harness runs its whole table against both new destinations (the egress witness lives there, not here)');
  }
} finally {
  restore();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

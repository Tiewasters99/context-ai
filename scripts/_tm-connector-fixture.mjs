// The shared fixture for the Trademark Clearance connector harnesses
// (scripts/_verify-trademark-connector.mjs, scripts/_e2e-trademark-mcp.mjs).
//
// A real Postgres (PGlite) running the REAL migrations 121, 122 and 124 — their tables,
// triggers and RLS — on a small stub of what 121 needs (matterspaces with a
// membership table behind can_access_matter / can_write_matter, documents,
// matterspace_descendants, the events vocabulary, ledger_append), and a stub
// PostgREST + Storage + Anthropic over globalThis.fetch so the app's own
// supabase-js clients, serverLlmCall and api/mcp.mjs run unmodified:
//
//   * a request carrying the service key runs as service_role;
//   * a request carrying a user JWT (lib/supabase-user-jwt.mjs, signed here
//     with a throwaway P-256 key) runs as `authenticated` with that `sub`;
//   * anything else is refused, and any outbound call that is not to the
//     stub Supabase, the stub Anthropic or 127.0.0.1 throws — nothing leaves
//     this process, and nothing ever reaches tmsearch.uspto.gov.
//
// IMPORT THIS FIRST, statically, before any app module: it sets the env the
// app reads at module load (supabase-user-jwt reads its key then). App modules
// must be imported dynamically after it.
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//
// Offline and secret-free.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite@0.5.8');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Env, before any app module is imported
// ---------------------------------------------------------------------------
export const SB_URL = 'https://stub.supabase.test';
export const SERVICE = 'stub-service-role-key';
export const ANON = 'stub-anon-key';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
process.env.VITE_SUPABASE_URL = SB_URL;
process.env.VITE_SUPABASE_ANON_KEY = ANON;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
process.env.MCP_SIGNING_KEY_JWK_B64 = Buffer.from(JSON.stringify(privateKey.export({ format: 'jwk' }))).toString('base64');
process.env.MCP_SIGNING_KEY_ID = 'harness-kid';
process.env.ANTHROPIC_API_KEY = 'stub-anthropic-key';
for (const k of ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'MCP_OAUTH_SECRET']) delete process.env[k];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mig = (name) => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', name), 'utf8');

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
export function harness() {
  const state = { failures: 0, passes: 0 };
  const check = (ok, label, detail = '') => {
    if (ok) state.passes++; else state.failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${(!ok || process.env.VERBOSE) && detail ? '  — ' + String(detail).slice(0, 400) : ''}`);
  };
  const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);
  const done = () => {
    console.log(`\n${state.passes} passed, ${state.failures} failed`);
    process.exit(state.failures ? 1 : 0);
  };
  return { check, section, done, state };
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------
export const u = () => crypto.randomUUID();

export const ADA = u();      // owns OPEN and SEALED; reads READONLY
export const BOB = u();      // owns BOBS
export const OPEN = u();
export const OPEN_CHILD = u();
export const BOBS = u();
export const SEALED = u();
export const READONLY = u();
export const PAUSED = u();

const STUBS = `
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $f$
    select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
  $f$;
  -- Supabase's auth.jwt(): the whole claim set (122 reads cs_via from it).
  create or replace function auth.jwt() returns jsonb language sql stable as $f$
    select nullif(current_setting('request.jwt.claims', true), '')::jsonb
  $f$;
  create table public.profiles (id uuid primary key);
  create table public.matterspaces (
    id uuid primary key, name text not null, short_code text unique, description text,
    serverspace_id uuid, parent_matterspace_id uuid references public.matterspaces(id),
    ai_tier text not null default 'A',
    ai_paused boolean not null default false, ai_paused_at timestamptz, ai_paused_by uuid,
    ai_paused_by_name text, ai_pause_note text);
  create table public.matter_members (matter_id uuid not null, user_id uuid not null, can_write boolean not null default false,
    primary key (matter_id, user_id));
  create table public.documents (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid not null references public.matterspaces(id),
    title text, source_filename text, storage_path text, file_size_bytes bigint,
    -- what lib/mcp-core.mjs file_document writes (slice 2 files status records and drafts)
    doc_type text, processing_status text, processing_error text, created_by uuid, created_at timestamptz not null default now());
  create table public.connector_tokens (
    id uuid primary key default gen_random_uuid(), user_id uuid not null, token_hash text not null unique,
    name text, kind text not null default 'user', matter_scope uuid[] not null default '{}',
    scope_all boolean not null default false, agent_provider text,
    revoked_at timestamptz, expires_at timestamptz, last_used_at timestamptz, token_prefix text);

  -- 098's two functions, answered from the membership table, inherited down the
  -- tree. (DEFINER here only so matterspaces' own policy can call them without
  -- recursing through itself; 098's real ones are INVOKER wrappers.)
  create or replace function public.can_access_matter(p_matter_id uuid) returns boolean
    language sql stable security definer set search_path = public as $f$
      with recursive up as (
        select id, parent_matterspace_id from public.matterspaces where id = p_matter_id
        union all select m.id, m.parent_matterspace_id from public.matterspaces m join up on m.id = up.parent_matterspace_id)
      select auth.uid() is not null and exists (select 1 from public.matter_members mm join up on mm.matter_id = up.id where mm.user_id = auth.uid()) $f$;
  create or replace function public.can_write_matter(p_matter_id uuid) returns boolean
    language sql stable security definer set search_path = public as $f$
      with recursive up as (
        select id, parent_matterspace_id from public.matterspaces where id = p_matter_id
        union all select m.id, m.parent_matterspace_id from public.matterspaces m join up on m.id = up.parent_matterspace_id)
      select auth.uid() is not null and exists (select 1 from public.matter_members mm join up on mm.matter_id = up.id where mm.user_id = auth.uid() and mm.can_write) $f$;
  create or replace function public.matterspace_descendants(p_root uuid)
  returns table (id uuid) language sql stable as $f$
    with recursive tree as (
      select m.id from public.matterspaces m where m.parent_matterspace_id = p_root
      union all
      select c.id from public.matterspaces c join tree t on c.parent_matterspace_id = t.id
    ) select id from tree $f$;

  alter table public.matterspaces enable row level security;
  create policy ms_read on public.matterspaces for select using (public.can_access_matter(id));
  alter table public.documents enable row level security;
  create policy doc_read on public.documents for select using (public.can_access_matter(matterspace_id));
  create policy doc_write on public.documents for insert with check (public.can_write_matter(matterspace_id));
  create policy doc_update on public.documents for update using (public.can_write_matter(matterspace_id));
  create policy doc_delete on public.documents for delete using (public.can_write_matter(matterspace_id));
  alter table public.matter_members enable row level security;
  create policy mm_read on public.matter_members for select using (user_id = auth.uid());

  -- The Record: 064's vocabulary column (121 widens it) and a ledger_append
  -- that keeps what lib/ledger.mjs sent, plus auth.uid() as the database saw it.
  create table public.events (
    id bigserial primary key, kind text not null, matter_id uuid, actor_kind text, actor_ref text,
    actor_label text, actor_user uuid, payload jsonb,
    constraint events_kind_check check (kind in ('tool.invoked')));
  create or replace function public.ledger_append(
    p_kind text, p_matter uuid, p_serverspace uuid, p_session uuid,
    p_actor_kind text, p_actor_ref text, p_actor_label text, p_payload jsonb)
  returns jsonb language plpgsql security definer set search_path = public as $f$
  declare v_id bigint;
  begin
    if auth.uid() is null and coalesce(p_actor_kind, 'user') <> 'system' then
      raise exception 'ledger_append requires an authenticated caller' using errcode = '42501';
    end if;
    if p_matter is not null and auth.uid() is not null and not public.can_access_matter(p_matter) then
      raise exception 'matter % is not accessible', p_matter using errcode = '42501';
    end if;
    insert into public.events (kind, matter_id, actor_kind, actor_ref, actor_label, actor_user, payload)
    values (p_kind, p_matter, p_actor_kind, p_actor_ref, p_actor_label, auth.uid(), p_payload) returning id into v_id;
    return jsonb_build_object('id', v_id, 'seq', v_id, 'hash', md5(v_id::text));
  end $f$;

  -- 063's meter: always allows, and remembers what it was asked.
  create table public.usage_calls (id bigserial primary key, p_user uuid, p_kind text, cents int, at timestamptz default now());
  create or replace function public.usage_consume(p_user uuid, p_kind text, p_cents_estimate int, p_window_key text)
  returns jsonb language plpgsql as $f$
  begin
    insert into public.usage_calls (p_user, p_kind, cents) values (p_user, p_kind, p_cents_estimate);
    return jsonb_build_object('allowed', true, 'event_id', gen_random_uuid(), 'tier', 'pro');
  end $f$;

  create or replace function public.usage_record_actual(p_event_id uuid, p_cents_actual int, p_model text, p_meta jsonb)
  returns jsonb language sql as $f$ select jsonb_build_object('ok', true) $f$;
  -- 086's rate ceiling: always admits, and counts the calls it was asked about.
  create table public.rate_calls (id bigserial primary key, p_user uuid, p_agent_token uuid, at timestamptz default now());
  create or replace function public.connector_rate_consume(p_user uuid, p_agent_token uuid)
  returns jsonb language plpgsql as $f$
  begin
    insert into public.rate_calls (p_user, p_agent_token) values (p_user, p_agent_token);
    return jsonb_build_object('allowed', true, 'tier', 'pro');
  end $f$;
  -- 072's account chain, for a call that names no matter.
  create or replace function public.ledger_append_account(
    p_kind text, p_session uuid, p_actor_kind text, p_actor_ref text, p_actor_label text, p_payload jsonb)
  returns jsonb language plpgsql security definer set search_path = public as $f$
  declare v_id bigint;
  begin
    insert into public.events (kind, matter_id, actor_kind, actor_ref, actor_label, actor_user, payload)
    values (p_kind, null, p_actor_kind, p_actor_ref, p_actor_label, auth.uid(), p_payload) returning id into v_id;
    return jsonb_build_object('id', v_id, 'seq', v_id, 'hash', md5(v_id::text));
  end $f$;

  grant usage on schema public, auth to authenticated, anon, service_role;
  grant select on public.matterspaces, public.documents, public.profiles, public.matter_members to authenticated;
  grant insert, update, delete on public.documents to authenticated;
  grant execute on all functions in schema public to authenticated;
  grant all on all tables in schema public to service_role;
  grant all on all sequences in schema public to service_role;
`;

export async function makeDb() {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(mig('121_trademark_clearance.sql'));
  await db.exec(mig('122_trademark_slice2.sql'));
  await db.exec(mig('124_trademark_run_rows.sql'));
  await db.exec(`
    grant all on all tables in schema public to service_role;
    insert into public.profiles values ('${ADA}'), ('${BOB}');
    insert into public.matterspaces (id, name, short_code) values
      ('${OPEN}', 'Equazia trademarks', 'eqz-tm'),
      ('${BOBS}', 'Bob private', 'bob-private'),
      ('${SEALED}', 'Sealed brand work', 'sealed-tm'),
      ('${READONLY}', 'Shared, read only', 'shared-ro'),
      ('${PAUSED}', 'Paused brand work', 'paused-tm');
    insert into public.matterspaces (id, name, short_code, parent_matterspace_id) values
      ('${OPEN_CHILD}', 'Equazia sub-matter', 'eqz-sub', '${OPEN}');
    update public.matterspaces set ai_tier = 'B' where id = '${SEALED}';
    update public.matterspaces set ai_paused = true, ai_paused_at = now(), ai_paused_by_name = 'Eden' where id = '${PAUSED}';
    insert into public.matter_members values
      ('${OPEN}', '${ADA}', true), ('${SEALED}', '${ADA}', true), ('${READONLY}', '${ADA}', false),
      ('${PAUSED}', '${ADA}', true), ('${BOBS}', '${BOB}', true);
  `);
  return db;
}

// ---------------------------------------------------------------------------
// The stub PostgREST / Storage / Anthropic
// ---------------------------------------------------------------------------
const COL = /^[a-z_][a-z0-9_]*$/;
const jsonResponse = (status, obj, headers = {}) => new Response(obj === undefined ? null : JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const headerOf = (init, name) => {
  const h = init?.headers;
  if (!h) return '';
  if (typeof h.get === 'function') return h.get(name) || '';
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? h[k] : '';
};
const jwtClaimsOf = (tok) => {
  try {
    const p = JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString('utf8'));
    return p?.role === 'authenticated' && typeof p.sub === 'string' ? p : null;
  } catch { return null; }
};

function parseSelect(sel) {
  if (!sel || sel === '*') return '*';
  return sel.split(',').map((c) => {
    const t = c.trim().replace(/^"|"$/g, '');
    if (t === '*') return '*';
    if (!COL.test(t)) throw new Error(`stub: unsupported select "${sel}"`);
    return t;
  }).join(', ');
}

function parseFilters(searchParams, params) {
  const where = [];
  let order = '';
  let limit = '';
  for (const [k, v] of searchParams) {
    if (['select', 'columns', 'on_conflict'].includes(k)) continue;
    if (k === 'order') {
      order = ' order by ' + v.split(',').map((o) => {
        const [col, dir = 'asc'] = o.split('.');
        if (!COL.test(col)) throw new Error(`stub: bad order ${v}`);
        return `${col} ${dir === 'desc' ? 'desc' : 'asc'}`;
      }).join(', ');
      continue;
    }
    if (k === 'limit') { limit = ` limit ${Number(v) | 0}`; continue; }
    if (!COL.test(k)) throw new Error(`stub: bad column ${k}`);
    if (v.startsWith('eq.')) { params.push(v.slice(3)); where.push(`${k}::text = $${params.length}`); }
    else if (v.startsWith('neq.')) { params.push(v.slice(4)); where.push(`${k}::text <> $${params.length}`); }
    else if (v.startsWith('in.(')) {
      const list = v.slice(4, -1).split(',').filter(Boolean).map((s) => s.replace(/^"|"$/g, ''));
      params.push(`{${list.map((s) => `"${s}"`).join(',')}}`);
      where.push(`${k}::text = any($${params.length}::text[])`);
    } else if (v === 'is.null') where.push(`${k} is null`);
    else if (v === 'not.is.null') where.push(`${k} is not null`);
    else throw new Error(`stub: unsupported filter ${k}=${v}`);
  }
  return { where: where.length ? ` where ${where.join(' and ')}` : '', order, limit };
}

/**
 * @param {object} db  PGlite
 * @param {object} o
 * @param {(body:object)=>object} [o.anthropic]  the stub model: request body → Messages API response
 * @param {Map<string, Uint8Array>} [o.storage]   vault-documents objects by path
 */
export const TSDR_HOST = 'https://tsdrapi.uspto.gov';
export const OPENAI_HOST = 'https://api.openai.com';

/**
 * @param {(url:URL, init:object) => Response|Promise<Response>} [o.tsdr]  the stub TSDR API (never the real one)
 * @param {boolean} [o.openaiDown]  answer api.openai.com with 503 (file_document's embedding then fails
 *                                  softly, as it is built to), instead of refusing the call
 */
export function installFetch(db, { anthropic, storage = new Map(), tsdr, openaiDown = false } = {}) {
  const realFetch = globalThis.fetch;
  const log = { anthropic: [], refusedOutbound: [], rest: [], tsdr: [], openai: 0 };
  // One request at a time: PGlite is one connection, and role / claims are session state.
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  const as = async (bearer, fn) => {
    const tok = String(bearer || '').replace(/^Bearer\s+/i, '');
    let role; let claims = null;
    if (tok === SERVICE) role = 'service_role';
    else if ((claims = jwtClaimsOf(tok))) role = 'authenticated';
    else return jsonResponse(401, { message: 'stub: no valid bearer' });
    return serial(async () => {
      await db.exec('reset role');
      // The whole claim set, as PostgREST sets it: sub, role, and cs_via on a connector's token.
      await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
      await db.exec(`set role ${role}`);
      try { return await fn(); }
      catch (err) {
        return jsonResponse(err?.code === '42501' ? 403 : 400, { code: err?.code || 'XX000', message: String(err?.message || err) });
      } finally { await db.exec('reset role').catch(() => {}); }
    });
  };

  globalThis.fetch = async (input, init = {}) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    if (url.href.startsWith(ANTHROPIC_URL)) {
      const body = JSON.parse(init.body || '{}');
      log.anthropic.push(body);
      if (!anthropic) return jsonResponse(500, { error: 'no stub model' });
      return jsonResponse(200, anthropic(body));
    }
    if (tsdr && url.href.startsWith(TSDR_HOST)) {
      log.tsdr.push({ url: url.href, key: headerOf(init, 'uspto-api-key') });
      return tsdr(url, init);
    }
    if (openaiDown && url.href.startsWith(OPENAI_HOST)) {
      log.openai++;
      return jsonResponse(503, { error: { message: 'stub: the embedding provider is down' } });
    }
    if (!url.href.startsWith(SB_URL)) {
      log.refusedOutbound.push(url.href);
      throw new Error(`harness: outbound call refused: ${url.href}`);
    }
    const bearer = headerOf(init, 'authorization');
    const method = String(init.method || 'GET').toUpperCase();
    log.rest.push(`${method} ${url.pathname}`);

    const st = url.pathname.match(/^\/storage\/v1\/object\/(?:authenticated\/)?vault-documents\/(.+)$/);
    if (st && (method === 'POST' || method === 'PUT')) {
      // An upload (file_document): the caller must be able to write the matter the path starts with.
      const key = decodeURIComponent(st[1]);
      const body = init.body;
      let bytes;
      if (body instanceof Uint8Array) bytes = body;
      else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
      else if (body && typeof body.arrayBuffer === 'function') bytes = new Uint8Array(await body.arrayBuffer());
      else bytes = new TextEncoder().encode(String(body ?? ''));
      return as(bearer, async () => {
        const { rows } = await db.query('select public.can_write_matter($1::uuid) ok', [key.split('/')[0]]);
        if (!rows[0]?.ok) return jsonResponse(403, { error: 'Unauthorized', message: 'new row violates row-level security policy' });
        storage.set(key, bytes);
        return jsonResponse(200, { Key: `vault-documents/${key}` });
      });
    }
    if (st) {
      const key = decodeURIComponent(st[1]);
      // Storage's own check, approximated: the object's document must be readable by the caller.
      return as(bearer, async () => {
        const { rows } = await db.query('select 1 from public.documents where storage_path = $1', [key]);
        if (!rows.length || !storage.has(key)) return jsonResponse(400, { error: 'not_found', message: 'Object not found' });
        return new Response(storage.get(key), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      });
    }

    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z0-9_]+)$/);
    if (rpc) {
      const fn = rpc[1];
      const body = JSON.parse(init.body || '{}');
      const keys = Object.keys(body);
      return as(bearer, async () => {
        const exists = await db.query(`select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn]);
        if (!exists.rows.length) return jsonResponse(404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
        const vals = keys.map((k) => {
          const v = body[k];
          if (v === null || v === undefined) return null;
          if (typeof v === 'object') return JSON.stringify(v);
          return String(v);
        });
        const { rows, fields } = await db.query(`select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, vals);
        if (fields.length === 1 && fields[0].name === fn) return jsonResponse(200, rows[0]?.[fn] ?? null);
        return jsonResponse(200, rows);
      });
    }

    const tbl = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!tbl) throw new Error(`harness: unexpected call ${method} ${url.href}`);
    const table = tbl[1];
    const accept = headerOf(init, 'accept');
    const prefer = headerOf(init, 'prefer');
    const object = /vnd\.pgrst\.object/.test(accept);
    const wantsRows = /return=representation/.test(prefer) || method === 'GET';
    const params = [];
    const { where, order, limit } = parseFilters(url.searchParams, params);
    const cols = parseSelect(url.searchParams.get('select'));
    const shape = (rows, status = 200) => {
      if (object) {
        if (rows.length !== 1) return jsonResponse(406, { code: 'PGRST116', message: `JSON object requested, multiple (or no) rows returned`, details: `The result contains ${rows.length} rows` });
        return jsonResponse(status, rows[0]);
      }
      return wantsRows ? jsonResponse(status, rows) : new Response(null, { status: status === 200 ? 204 : status });
    };
    return as(bearer, async () => {
      if (method === 'GET' || method === 'HEAD') {
        const { rows } = await db.query(`select ${cols} from public.${table}${where}${order}${limit}`, params);
        if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `0-${rows.length - 1}/${rows.length}` } });
        return shape(rows);
      }
      if (method === 'POST') {
        const raw = JSON.parse(init.body || '[]');
        const list = Array.isArray(raw) ? raw : [raw];
        if (!list.length) return shape([], 201);
        const keys = [...new Set(list.flatMap((r) => Object.keys(r)))];
        for (const k of keys) if (!COL.test(k)) throw new Error(`stub: bad insert column ${k}`);
        const n = params.length + 1;
        let sql = `insert into public.${table} (${keys.join(', ')}) select ${keys.join(', ')} from jsonb_populate_recordset(null::public.${table}, $${n}::jsonb)`;
        const onConflict = url.searchParams.get('on_conflict');
        if (onConflict) {
          const conflict = onConflict.split(',').map((c) => c.trim());
          for (const c of conflict) if (!COL.test(c)) throw new Error(`stub: bad on_conflict ${onConflict}`);
          const set = keys.filter((k) => !conflict.includes(k));
          sql += /resolution=ignore-duplicates/.test(prefer) || !set.length
            ? ` on conflict (${conflict.join(', ')}) do nothing`
            : ` on conflict (${conflict.join(', ')}) do update set ${set.map((k) => `${k} = excluded.${k}`).join(', ')}`;
        }
        sql += ` returning ${cols}`;
        const { rows } = await db.query(sql, [...params, JSON.stringify(list)]);
        return shape(rows, 201);
      }
      if (method === 'PATCH') {
        const patch = JSON.parse(init.body || '{}');
        const keys = Object.keys(patch);
        for (const k of keys) if (!COL.test(k)) throw new Error(`stub: bad update column ${k}`);
        const n = params.length + 1;
        const { rows } = await db.query(
          `update public.${table} t set (${keys.join(', ')}) = (select ${keys.map((k) => `r.${k}`).join(', ')} from jsonb_populate_record(null::public.${table}, $${n}::jsonb) r)${where} returning ${cols === '*' ? 't.*' : cols}`,
          [...params, JSON.stringify(patch)]);
        return shape(rows);
      }
      if (method === 'DELETE') {
        const { rows } = await db.query(`delete from public.${table}${where} returning ${cols}`, params);
        return shape(rows);
      }
      throw new Error(`stub: ${method}`);
    });
  };
  return { log, restore: () => { globalThis.fetch = realFetch; } };
}

// ---------------------------------------------------------------------------
// The stub model: an Anthropic Messages response with one tool_use block
// ---------------------------------------------------------------------------
export const toolAnswer = (name, input) => ({
  id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'toolu_stub', name, input }],
  usage: { input_tokens: 900, output_tokens: 300 },
});

/** Proposals the way the recipe's model would make them, for the marks in these harnesses. */
export function stubModel(body) {
  const tool = body?.tools?.[0]?.name ?? body?.tool_choice?.name;
  const user = JSON.stringify(body?.messages ?? '');
  const mark = /Mark: ([A-Z]+)/.exec(user)?.[1] ?? 'QUALLET';
  if (tool === 'propose_classes') {
    return toolAnswer(tool, {
      search: [{ code: '009', reason: 'downloadable wallet software' }, { code: '036', reason: 'financial services' }, { code: '042', reason: 'SaaS' }],
      filing: [{ code: '009', reason: 'a dated product plan for the app' }],
    });
  }
  if (tool === 'propose_decompose') {
    const w = mark.toLowerCase();
    return toolAnswer(tool, { opening: w.slice(0, 3), hinge: w.slice(3, 4), ending: w.slice(4), reason: 'the vowel after qu is where a respelling would differ', foreign: [] });
  }
  if (tool === 'propose_triage') {
    const serials = [...user.matchAll(/\\"serial\\":\\"(\d+)\\"/g)].map((m) => m[1]);
    return toolAnswer(tool, {
      hits: serials.map((s, i) => ({
        serial: s, similarity: { score: 4 - (i % 3), reason: 'shares the qu- opening' },
        relatedness: { score: 3, reason: 'software in class 9' }, bin: i % 3 === 0 ? 'flag' : i % 3 === 1 ? 'note' : 'dismiss',
      })),
    });
  }
  throw new Error(`stub model: unexpected tool ${tool}`);
}

/** A connector_tokens row (as Connections › Grok makes one) — plaintext returned once. */
export async function makeToken(db, userId, { name = 'Grok bot', kind = 'user', matterScope = [], scopeAll = false } = {}) {
  const token = `csp_${crypto.randomBytes(24).toString('base64url')}`;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows } = await db.query(
    `insert into public.connector_tokens (user_id, token_hash, name, kind, matter_scope, scope_all, token_prefix)
     values ($1, $2, $3, $4, $5::uuid[], $6, $7) returning id`,
    [userId, hash, name, kind, `{${matterScope.join(',')}}`, scopeAll, token.slice(0, 8)]);
  return { token, id: rows[0].id };
}

/** Superuser reads, outside any role. */
export async function su(db, sql, params = []) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  return (await db.query(sql, params)).rows;
}

/** Register rows a person might paste back from tmsearch. */
export const FIXTURE_ROWS = [
  { serial: '90562533', mark: 'EQUASITE', owner: 'Equasite Inc.', status: 'LIVE REGISTERED', classes: '042', goods: 'Software as a service' },
];
export const Q7_ROWS = [
  { serial: '97111111', mark: 'QUALLETTA', owner: 'Quall Co', status: 'LIVE', classes: ['009', '036'], goods: 'Mobile wallet software' },
  { serial: '97222222', mark: 'QUALITY WALLET', owner: 'QW LLC', status: 'LIVE REGISTERED', classes: '009', goods: 'Downloadable payment software' },
  { serial: '97333333', mark: 'QUALLEX', owner: 'Quallex GmbH', status: 'DEAD ABANDONED', classes: '042', goods: 'Cloud hosting' },
];

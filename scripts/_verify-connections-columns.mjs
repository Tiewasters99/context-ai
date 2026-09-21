// Migration 080 — a connection's stored token is server-only.
//
// The claim under test is not "our hook does not ask for the token". It is
// "Postgres refuses to give it to a browser". A harness running as the
// superuser cannot tell those apart, so this one creates `anon`,
// `authenticated` and a BYPASSRLS `service_role` for real, installs
// Supabase's own blanket default grant (ALL on the table to all three, which
// is the state 080 has to undo), runs the REAL migration files, and then does
// every assertion from inside `SET ROLE` with `request.jwt.claims` set the way
// PostgREST sets it.
//
// In this order:
//
//   1. THE LEAK, before 080. As `authenticated`, `select
//      encrypted_refresh_token` and `select *` both succeed. This is the
//      negative control: if these ever stop passing, the rest of the file is
//      proving nothing.
//   2. AFTER 080. The token column is refused (42501). `select *` is refused
//      — loudly, and documented, because it means every browser read of this
//      table must name its columns. The safe columns succeed, RLS still cuts
//      them to the caller's own rows, and another user's rows stay invisible.
//      The token cannot be used as an oracle either: naming it in WHERE or
//      ORDER BY is refused too.
//   3. THE SERVICE ROLE IS UNAFFECTED. `select *`, the token included, for
//      every user's row — the /api handlers keep working.
//   4. THE BROWSER'S ONE WRITE. Disconnect (DELETE by id) still works, still
//      only on the caller's own row; INSERT and UPDATE are refused.
//   5. IDEMPOTENT. 080 runs twice; the column ACLs are byte-identical and
//      every assertion in 2–4 still holds.
//   6. DRIFT. 080 also applies to 026→075 with 029 never pasted, and to a
//      database with no connections table at all.
//   7. STATIC. No file under src/ asks this table for `*` or names a column
//      080 does not grant, and the hook's exported constant is a subset of
//      the migration's own safe list. This is the part that fails CI when
//      somebody reintroduces a star a year from now.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-connections-columns.mjs
//
// No .env, no network, no prod.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const migrationPath = (name) => path.join(repo, 'supabase', 'migrations', name);
const migration = (name) => fs.readFileSync(migrationPath(name), 'utf8');

// PGlite attaches its whole bundled module source to a thrown error, which
// turns one bad statement into a megabyte of unreadable CI log.
process.on('uncaughtException', (e) => {
  console.error(`\n  SQL ERROR: ${String(e?.message ?? e).split('\n')[0]}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`\n  SQL ERROR: ${String(e?.message ?? e).split('\n')[0]}\n`);
  process.exit(1);
});

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

// The safe list, transcribed from the migration and then checked against it
// below — so this file cannot drift away from the thing it is verifying.
const SAFE_COLUMNS = [
  'id', 'user_id', 'kind', 'status', 'connected_email', 'scopes',
  'last_verified_at', 'last_error', 'created_at', 'updated_at',
];
const SECRET_COLUMNS = ['encrypted_refresh_token'];

// ---------------------------------------------------------------------------
// Database plumbing
// ---------------------------------------------------------------------------

/**
 * A database with Supabase's roles, Supabase's auth.uid(), and profiles.
 * Nothing else: the migrations build the rest.
 */
async function bootstrap() {
  const db = new PGlite();
  await db.exec(`
    do $$ begin create role anon;                   exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated;          exception when duplicate_object then null; end $$;
    do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth;
    grant usage on schema auth to anon, authenticated, service_role;
    create or replace function auth.uid() returns uuid language sql stable as $fn$
      select nullif(coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      ), '')::uuid
    $fn$;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    create table if not exists public.profiles (id uuid primary key, email text);
    insert into public.profiles (id, email) values
      ('${USER_A}', 'a@example.test'),
      ('${USER_B}', 'b@example.test')
      on conflict (id) do nothing;
  `);
  return db;
}

/**
 * Supabase's own default: `grant all on all tables in schema public to anon,
 * authenticated, service_role`, applied after the table exists. This is the
 * state the live database is in — and the state 080 exists to undo. Without
 * it the harness would "pass" on a table nobody could read in the first place.
 */
const supabaseBlanketGrant = (db) =>
  db.exec(`grant all on table public.connections to anon, authenticated, service_role;`);

const asRole = (db, role, sub) =>
  db.exec(
    `set role none; set role ${role}; ` +
    `select set_config('request.jwt.claims', ` +
    (sub ? `'{"sub":"${sub}","role":"${role}"}'` : `'{"role":"${role}"}'`) +
    `, false);`,
  );
const asOwner = (db) => db.exec(`set role none; select set_config('request.jwt.claims', '', false);`);

/** Run a statement and report either its rows or its SQLSTATE. */
async function attempt(db, sql, params) {
  try {
    const r = await db.query(sql, params);
    return { ok: true, rows: r.rows };
  } catch (e) {
    return { ok: false, code: e?.code ?? e?.cause?.code ?? '?', message: String(e?.message ?? e).split('\n')[0] };
  }
}

const seed = (db) => db.exec(`
  insert into public.connections (user_id, kind, connected_email, scopes, encrypted_refresh_token)
  values
    ('${USER_A}', 'gmail',        'a@example.test', 'gmail.send',  'iv:tag:CIPHERTEXT-A'),
    ('${USER_A}', 'google_drive', 'a@example.test', 'drive.file',  'iv:tag:CIPHERTEXT-A2'),
    ('${USER_B}', 'gmail',        'b@example.test', 'gmail.send',  'iv:tag:CIPHERTEXT-B')
  on conflict (user_id, kind) do nothing;
`);

const columnAcls = async (db) =>
  JSON.stringify((await db.query(`
    select a.attname, a.attacl::text
      from pg_attribute a
     where a.attrelid = 'public.connections'::regclass and a.attnum > 0 and not a.attisdropped
     order by a.attnum`)).rows);

// ===========================================================================
section('1. the leak, before 080 — the negative control');
// ===========================================================================
const db = await bootstrap();
await db.exec(migration('026_connections.sql'));
await db.exec(migration('029_connections_google_drive_kind.sql'));
await db.exec(migration('075_connections_cloud_drive_kinds.sql'));
await supabaseBlanketGrant(db);
await seed(db);

await asRole(db, 'authenticated', USER_A);
{
  const tok = await attempt(db, 'select encrypted_refresh_token from public.connections');
  check(tok.ok && tok.rows.some((r) => String(r.encrypted_refresh_token).includes('CIPHERTEXT-A')),
    'BEFORE 080: a signed-in browser can read its own encrypted_refresh_token',
    tok.ok ? `${tok.rows.length} row(s)` : tok.code);
  const star = await attempt(db, 'select * from public.connections');
  check(star.ok && 'encrypted_refresh_token' in (star.rows[0] ?? {}),
    "BEFORE 080: `select=*` hands the ciphertext over too — this is what PR #199's review found");
}
await asOwner(db);

// ===========================================================================
section('2. after 080 — Postgres refuses, not our code');
// ===========================================================================
await db.exec(migration('080_connections_token_columns_server_only.sql'));
console.log('  executed supabase/migrations/080_connections_token_columns_server_only.sql');

const assertBrowserIsShutOut = async (label) => {
  await asRole(db, 'authenticated', USER_A);

  for (const col of SECRET_COLUMNS) {
    const r = await attempt(db, `select ${col} from public.connections`);
    check(!r.ok && r.code === '42501', `${label}the token column is refused: select ${col} → 42501`,
      r.ok ? `LEAKED ${JSON.stringify(r.rows[0])}` : `${r.code} ${r.message}`);
  }

  const star = await attempt(db, 'select * from public.connections');
  check(!star.ok && star.code === '42501',
    `${label}\`select *\` fails LOUDLY (42501 permission denied for table connections) — every browser read must name its columns`,
    star.ok ? 'IT SUCCEEDED' : star.message);

  const safe = await attempt(db,
    'select id, kind, status, connected_email, last_error from public.connections order by kind');
  check(safe.ok && safe.rows.length === 2,
    `${label}the safe columns succeed, and RLS still cuts them to the caller's own rows`,
    safe.ok ? `${safe.rows.length} row(s): ${safe.rows.map((r) => r.kind).join(', ')}` : safe.code);
  check(safe.ok && safe.rows.every((r) => r.connected_email === 'a@example.test'),
    `${label}another user's rows stay invisible`);

  // The token must not be usable as an oracle either: a caller who cannot
  // SELECT a column also cannot filter or sort on it.
  const whereOnToken = await attempt(db,
    "select id from public.connections where encrypted_refresh_token like 'iv:%'");
  check(!whereOnToken.ok && whereOnToken.code === '42501',
    `${label}the token cannot be probed through WHERE either`, whereOnToken.code);
  const orderOnToken = await attempt(db,
    'select id from public.connections order by encrypted_refresh_token');
  check(!orderOnToken.ok && orderOnToken.code === '42501',
    `${label}nor through ORDER BY`, orderOnToken.code);

  // Every column the browser IS allowed is actually allowed — a grant that
  // over-tightened would break the Connections page just as surely.
  for (const col of SAFE_COLUMNS) {
    const r = await attempt(db, `select ${col} from public.connections limit 1`);
    if (!r.ok) check(false, `${label}safe column ${col} is readable`, `${r.code} ${r.message}`);
  }
  check(true, `${label}all ${SAFE_COLUMNS.length} non-credential columns remain readable`);

  // And anon, which can never pass the policy, gets no row and no secret.
  await asRole(db, 'anon', null);
  const anonSafe = await attempt(db, 'select id, kind from public.connections');
  check(anonSafe.ok && anonSafe.rows.length === 0,
    `${label}anon reads the safe columns and finds nothing — RLS, unchanged`,
    anonSafe.ok ? `${anonSafe.rows.length} row(s)` : anonSafe.code);
  const anonTok = await attempt(db, 'select encrypted_refresh_token from public.connections');
  check(!anonTok.ok && anonTok.code === '42501', `${label}and anon is refused the token column`, anonTok.code);

  await asOwner(db);
};

await assertBrowserIsShutOut('');

// ===========================================================================
section('3. the service role is unaffected — the /api handlers keep working');
// ===========================================================================
{
  await db.exec('set role none; set role service_role;');
  const star = await attempt(db, 'select * from public.connections order by connected_email, kind');
  check(star.ok && star.rows.length === 3,
    'service_role still reads EVERY row of the table', star.ok ? `${star.rows.length} rows` : star.code);
  check(star.ok && star.rows.every((r) => String(r.encrypted_refresh_token).startsWith('iv:')),
    'including the encrypted_refresh_token on every one — this is the column api/gmail-send, api/drive-export, api/cloud-export, api/calendar-import, api/ext/push-to-drive and lib/cloud-drives/routes read');
  const upd = await attempt(db,
    `update public.connections set encrypted_refresh_token = 'iv:tag:ROTATED'
      where connected_email = 'a@example.test' and kind = 'gmail'`);
  check(upd.ok, 'and it can still WRITE the token back — Microsoft rotates its refresh token on every use', upd.code);
  await asOwner(db);
}

// ===========================================================================
section("4. the browser's one write: disconnect");
// ===========================================================================
{
  await asRole(db, 'authenticated', USER_A);
  const ins = await attempt(db,
    `insert into public.connections (user_id, kind, encrypted_refresh_token)
     values ('${USER_A}', 'dropbox', 'iv:tag:FORGED')`);
  check(!ins.ok, 'a browser cannot INSERT a connection', ins.ok ? 'IT SUCCEEDED' : `${ins.code}`);
  const upd = await attempt(db,
    `update public.connections set last_error = 'x' where kind = 'gmail'`);
  check(!upd.ok && upd.code === '42501',
    'a browser cannot UPDATE one either — which closes UPDATE ... RETURNING as a read path',
    upd.ok ? 'IT SUCCEEDED' : upd.code);

  const ids = await attempt(db, "select id from public.connections where kind = 'google_drive'");
  const delOwn = await attempt(db, 'delete from public.connections where id = $1', [ids.rows[0].id]);
  check(delOwn.ok, 'but Disconnect still works: DELETE by id, on its own row', delOwn.code);

  const foreign = await (async () => {
    await asOwner(db);
    const r = await db.query(`select id from public.connections where user_id = '${USER_B}'`);
    await asRole(db, 'authenticated', USER_A);
    return r.rows[0].id;
  })();
  const delOther = await attempt(db, 'delete from public.connections where id = $1', [foreign]);
  await asOwner(db);
  const left = await db.query(`select count(*)::int as n from public.connections where user_id = '${USER_B}'`);
  check(delOther.ok && left.rows[0].n === 1,
    "and it cannot reach another user's row — the DELETE policy is untouched",
    `user B still has ${left.rows[0].n} connection(s)`);
}

// ===========================================================================
section('5. idempotent — run it twice');
// ===========================================================================
{
  const before = await columnAcls(db);
  await db.exec(migration('080_connections_token_columns_server_only.sql'));
  const after = await columnAcls(db);
  check(before === after, 'a second run leaves the column ACLs byte-identical');

  const tokenAcl = JSON.parse(after).find((r) => r.attname === 'encrypted_refresh_token');
  check(!tokenAcl.attacl || !/\b(anon|authenticated)=[^/]*r/.test(tokenAcl.attacl),
    'and no browser role holds SELECT on encrypted_refresh_token', tokenAcl.attacl ?? 'no ACL at all');

  await seed(db);
  await assertBrowserIsShutOut('[applied twice] ');
}

// ===========================================================================
section('6. drift — the live database is not the migrations folder');
// ===========================================================================
{
  // (a) 029 was never pasted. This has actually happened here.
  const d2 = await bootstrap();
  await d2.exec(migration('026_connections.sql'));
  await d2.exec(migration('075_connections_cloud_drive_kinds.sql'));
  await supabaseBlanketGrant(d2);
  await d2.exec(migration('080_connections_token_columns_server_only.sql'));
  await seed(d2);
  await asRole(d2, 'authenticated', USER_A);
  const r2 = await attempt(d2, 'select encrypted_refresh_token from public.connections');
  const s2 = await attempt(d2, 'select id, kind from public.connections');
  check(!r2.ok && r2.code === '42501' && s2.ok && s2.rows.length === 2,
    '026→075→080 with 029 never applied: token refused, safe columns fine');
  await asOwner(d2);
  await d2.close();

  // (b) no connections table at all — 080 builds one, and builds it shut.
  const d3 = await bootstrap();
  await d3.exec(migration('080_connections_token_columns_server_only.sql'));
  const rls = (await d3.query(`select relrowsecurity from pg_class where relname = 'connections'`)).rows[0];
  check(rls?.relrowsecurity === true, '080 on a database with no connections table: it creates one, with RLS on');
  const policies = (await d3.query(`select cmd from pg_policies where tablename = 'connections'`)).rows
    .map((r) => r.cmd).sort();
  check(JSON.stringify(policies) === JSON.stringify(['DELETE', 'SELECT']),
    'still SELECT and DELETE only — no INSERT or UPDATE policy', policies.join('/'));
  await d3.exec(`insert into public.connections (user_id, kind, encrypted_refresh_token)
                 values ('${USER_A}', 'gmail', 'iv:tag:X')`);
  await asRole(d3, 'authenticated', USER_A);
  const r3 = await attempt(d3, 'select encrypted_refresh_token from public.connections');
  check(!r3.ok && r3.code === '42501', 'and the token is closed there too, without a prior blanket grant to undo');
  await asOwner(d3);
  await d3.close();

  // (c) the drift that would actually bite: someone granted the column by hand.
  const d4 = await bootstrap();
  await d4.exec(migration('026_connections.sql'));
  await d4.exec(migration('075_connections_cloud_drive_kinds.sql'));
  await d4.exec(`
    revoke select on table public.connections from authenticated;
    grant select (id, kind, encrypted_refresh_token) on table public.connections to authenticated;
  `);
  await d4.exec(migration('080_connections_token_columns_server_only.sql'));
  await seed(d4);
  await asRole(d4, 'authenticated', USER_A);
  const r4 = await attempt(d4, 'select encrypted_refresh_token from public.connections');
  check(!r4.ok && r4.code === '42501',
    'a hand-made COLUMN grant on the token is revoked too — 080 converges from that state as well', r4.code);
  await asOwner(d4);
  await d4.close();
}

// ===========================================================================
section('7. static — nothing in src/ may ask for the token, or for `*`');
// ===========================================================================
{
  // The migration's own safe list, read out of the file, so the constant at
  // the top of THIS file cannot quietly disagree with the migration.
  const sql = migration('080_connections_token_columns_server_only.sql');
  const block = sql.match(/safe_columns\s+constant\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/);
  const fromMigration = (block?.[1] ?? '').match(/'([a-z_]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
  check(JSON.stringify(fromMigration) === JSON.stringify(SAFE_COLUMNS),
    "this harness's safe list IS the migration's safe list", fromMigration.join(', '));
  check(!fromMigration.some((c) => SECRET_COLUMNS.includes(c)),
    'and no credential column is on it');

  // Every source file that touches the table.
  const srcFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) srcFiles.push(p);
    }
  })(path.join(repo, 'src'));

  const offenders = [];
  const touching = [];
  for (const file of srcFiles) {
    const text = fs.readFileSync(file, 'utf8');
    // `.from('connections')` and everything chained onto it up to the `;`.
    const re = /\.from\(\s*['"`]connections['"`]\s*\)([\s\S]*?);/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const chain = m[1];
      const rel = path.relative(repo, file).replace(/\\/g, '/');
      touching.push(rel);
      const sel = chain.match(/\.select\(\s*(['"`])([\s\S]*?)\1\s*\)/);
      if (/\.select\(\s*\)/.test(chain) || (sel && sel[2].includes('*'))) {
        offenders.push(`${rel}: selects '*' (or an empty select) from connections`);
      }
      for (const secret of SECRET_COLUMNS) {
        if (chain.includes(secret)) offenders.push(`${rel}: names ${secret}`);
      }
    }
    // The column name must not appear in browser CODE at all, chained onto a
    // `.from('connections')` or not — a raw `.rpc()`, a PostgREST URL built by
    // hand, a type definition. Prose about it is fine, so whole-line comments
    // are dropped first (line-based on purpose: stripping `//` anywhere would
    // swallow the tail of any line holding a URL, and a guard must not miss).
    const code = text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join('\n');
    for (const secret of SECRET_COLUMNS) {
      if (code.includes(secret)) {
        const rel = path.relative(repo, file).replace(/\\/g, '/');
        const note = `${rel}: mentions ${secret} in code`;
        if (!offenders.includes(note)) offenders.push(note);
      }
    }
  }
  check(touching.length > 0, 'the scanner found the browser readers it is meant to police',
    [...new Set(touching)].join(', '));
  check(offenders.length === 0,
    'no file under src/ selects `*` from connections, or names a credential column',
    offenders.join(' | '));

  // The exported constant exists, is used, and is a subset of what 080 grants.
  const hook = fs.readFileSync(path.join(repo, 'src', 'hooks', 'useConnections.ts'), 'utf8');
  const constant = hook.match(/export const CONNECTIONS_SAFE_SELECT\s*=\s*\n?\s*['"`]([^'"`]+)['"`]/);
  check(!!constant, 'src/hooks/useConnections.ts exports CONNECTIONS_SAFE_SELECT');
  const browserColumns = (constant?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  check(browserColumns.length > 0 && browserColumns.every((c) => SAFE_COLUMNS.includes(c)),
    'and every column it names is one migration 080 grants', browserColumns.join(', '));
  check(/\.select\(CONNECTIONS_SAFE_SELECT\)/.test(hook),
    'and the hook selects through the constant, not a hand-written list');

  // Those columns really are servable — the last link in the chain.
  await asRole(db, 'authenticated', USER_A);
  const real = await attempt(db, `select ${browserColumns.join(', ')} from public.connections`);
  check(real.ok, "the constant's own column list is one Postgres serves to `authenticated`",
    real.ok ? `${real.rows.length} row(s)` : `${real.code} ${real.message}`);
  await asOwner(db);
}

await db.close();

console.log(`\n${failures === 0
  ? '080 verified: the browser cannot read a connection\'s stored token, the service role still can, and src/ cannot ask for it.'
  : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);

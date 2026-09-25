// The hosted MCP connector's meter — migration 086 §2–3 EXECUTED in PGlite,
// and lib/connector-meter.mjs (the code api/mcp.mjs runs around every tool
// call) driven against it.
//
// The PostgREST calls the meter makes (connector_rate_consume, usage_consume,
// usage_record_actual, the profiles read) are bridged straight into the PGlite
// database as `service_role`, so every counter and every meter row below is a
// real row written by the real migration functions — not a stub's idea of one.
//
//   1. 086 applies over 063/067/085, twice, and Eden's edited number survives.
//   2. A USER token hits the account ceiling and gets a readable sentence
//      ("… resets at HH:MM UTC"), never JSON; the tool is not run.
//   3. An AGENT token hits its own ceiling first; a second agent of the same
//      account is unaffected; the account ceiling counts every connection.
//   4. WORKSHOP is never refused, even with its rows set to 1.
//   5. COSTED tools charge the same wallet under kind 'ingest', estimated the
//      way /api/ingest estimates; FREE reads write no usage_events row.
//      The charge is reconciled: to 0 when the call failed, to the OCR
//      route's cost when one ran.
//   6. ATTRIBUTION: the charged event names agent:<token id> / token:<id>.
//   7. NO CONTENT in any meter row: the query, the filename, the document
//      text never appear in usage_events / usage_windows / usage_month.
//   8. The monthly budget refusal reaches the agent as a sentence; reads go on.
//   9. OUTAGE: connector_rate_consume erroring → reads always admitted, other
//      calls get the degraded ceiling, workshop (by env) is never refused.
//  10. BEFORE 086 (function missing): no ceiling, costed calls still charged.
//  11. api/mcp.mjs routes its CallTool handler through runMeteredToolCall.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-connector-meter.mjs
//
// No .env, no network, no prod.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

process.on('uncaughtException', (e) => {
  console.error(`\n  ERROR: ${String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`\n  ERROR: ${String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')}\n`);
  process.exit(1);
});

// The meter logs every degraded admission loudly, as it should in
// production; here that is hundreds of expected lines, so they are muted.
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { if (!/^\[(usage|connector)-meter\]/.test(String(a[0]))) orig(...a); };
}

const { runMeteredToolCall, toolClass, READ_TOOLS, COSTED_TOOLS } = await import('../lib/connector-meter.mjs');
const { resetDegradedCeiling, DEGRADED_CEILING } = await import('../lib/usage-meter.mjs');
const { estimateIngestCents } = await import('../lib/usage-prices.mjs');
const { TOOLS } = await import('../lib/mcp-core.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const migration = (name) => fs.readFileSync(path.join(repo, 'supabase', 'migrations', name), 'utf8');
const M086 = '086_connector_metering_and_token_lock.sql';

let failures = 0;
let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (ok) passes += 1; else failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

// ===========================================================================
section('1. the chain, and 086 over it (twice)');
// ===========================================================================
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
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ), '')::uuid
  $$;
  create table public.documents (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid,
    page_count int, file_size_bytes bigint, source_filename text,
    ingested_at timestamptz, created_at timestamptz not null default now());
  create table public.passages (id uuid primary key default gen_random_uuid(), matterspace_id uuid);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create or replace function storage.foldername(p_name text)
  returns text[] language sql immutable as $$ select string_to_array(p_name, '/') $$;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
`);
for (const f of [
  '001_initial_schema.sql', '003_connector_tokens.sql', '005_fix_rls_recursion.sql',
  '008_submatters.sql', '016_matterspace_members.sql', '022_matterspaces_rls_invoker_wrappers.sql',
]) await db.exec(migration(f));
await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;`);
await db.exec(migration('062_profiles_rls_plan.sql'));
await db.exec(migration('063_usage_budgets.sql'));
await db.exec(migration('067_billing_and_credits.sql'));
await db.exec(migration('085_agent_tokens_and_tasks.sql'));
await db.exec(migration(M086));
await db.exec(`grant all on all tables in schema public to service_role;`);
check(true, '001 → 022, 062, 063, 067, 085 and 086 applied');

{
  const rows = (await db.query(`select pricing_tier, kind, window_seconds, window_max_requests from public.usage_budgets
     where kind in ('connector','connector_agent') order by pricing_tier, kind`)).rows;
  const get = (t, k) => rows.find((r) => r.pricing_tier === t && r.kind === k);
  check(rows.length === 10, 'ten ceiling rows: five plans × (account, agent)', `${rows.length}`);
  check(get('free', 'connector')?.window_max_requests === 600 && get('free', 'connector_agent')?.window_max_requests === 240
    && get('pro', 'connector')?.window_max_requests === 1500 && get('max', 'connector_agent')?.window_max_requests === 1200,
    'the stated defaults (free 600/240, pro 1500/600, max 3000/1200 per hour)');
  check(get('workshop', 'connector')?.window_max_requests === null && get('workshop', 'connector_agent')?.window_max_requests === null,
    'workshop rows are unlimited (null)');
  check(rows.every((r) => r.window_seconds === 3600), 'every window is one hour');
  await db.exec(`update public.usage_budgets set window_max_requests = 777 where pricing_tier = 'basic' and kind = 'connector'`);
  await db.exec(migration(M086));
  const [again] = (await db.query(`select window_max_requests from public.usage_budgets where pricing_tier='basic' and kind='connector'`)).rows;
  check(again.window_max_requests === 777, 'a second paste changes nothing — Eden\'s edited number survives');
  const grants = (await db.query(`select has_function_privilege('authenticated', 'public.connector_rate_consume(uuid, uuid)', 'EXECUTE') as a,
                                         has_function_privilege('service_role', 'public.connector_rate_consume(uuid, uuid)', 'EXECUTE') as s`)).rows[0];
  check(!grants.a && grants.s, 'connector_rate_consume is service_role only');
}

// Small ceilings for the rest of the run — set by UPDATE, which is also how
// Eden changes them.
await db.exec(`
  update public.usage_budgets set window_max_requests = 5  where pricing_tier = 'free' and kind = 'connector';
  update public.usage_budgets set window_max_requests = 3  where pricing_tier = 'pro'  and kind = 'connector_agent';
  update public.usage_budgets set window_max_requests = 50 where pricing_tier = 'pro'  and kind = 'connector';
  update public.usage_budgets set window_max_requests = 1  where pricing_tier = 'workshop' and kind in ('connector','connector_agent');
`);

const makeUser = async (tier, email) => {
  await db.exec('reset role');
  const [{ id }] = (await db.query(`insert into auth.users (email) values ($1) returning id`, [email])).rows;
  await db.query(`insert into public.profiles (id, email) values ($1, $2) on conflict (id) do nothing`, [id, email]);
  if (tier !== 'free') await db.query(`update public.profiles set pricing_tier = $2 where id = $1`, [id, tier]);
  return id;
};
const makeToken = async (userId, kind, name) => {
  const [{ id }] = (await db.query(
    `insert into public.connector_tokens (user_id, token_hash, token_prefix, name, kind, matter_scope)
     values ($1, $2, 'csp_x', $3, $4, $5) returning id`,
    [userId, `h-${Math.random()}`, name, kind, kind === 'agent' ? [] : null])).rows;
  return id;
};
const FREE = await makeUser('free', 'free@example.test');
const PRO = await makeUser('pro', 'pro@example.test');
const EDEN = await makeUser('workshop', 'eden@example.test');
const FREE_TOK = await makeToken(FREE, 'user', 'Claude Desktop');
const PRO_TOK = await makeToken(PRO, 'user', 'ChatGPT');
const AGENT_1 = await makeToken(PRO, 'agent', 'Grok bot');
const AGENT_2 = await makeToken(PRO, 'agent', 'Docket bot');
const EDEN_AGENT = await makeToken(EDEN, 'agent', 'Eden bot');

// ---------------------------------------------------------------------------
// The PostgREST bridge: every RPC the meter makes runs in PGlite as service_role.
// ---------------------------------------------------------------------------
const RPC_TYPES = {
  connector_rate_consume: { p_user: 'uuid', p_agent_token: 'uuid' },
  usage_consume: { p_user: 'uuid', p_kind: 'text', p_cents_estimate: 'integer', p_window_key: 'text' },
  usage_record_actual: { p_event_id: 'uuid', p_cents_actual: 'integer', p_model: 'text', p_meta: 'jsonb' },
};
const bridge = { mode: 'up', calls: [] };
const respond = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const fetchImpl = async (url, init = {}) => {
  const u = new URL(url);
  const rpc = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(u.pathname);
  bridge.calls.push(rpc ? rpc[1] : u.pathname);
  if (rpc && rpc[1] === 'connector_rate_consume') {
    if (bridge.mode === 'down') throw new Error('ECONNRESET');
    if (bridge.mode === 'missing') return respond(404, { code: 'PGRST202', message: 'Could not find the function public.connector_rate_consume' });
  }
  if (bridge.mode === 'down-all') throw new Error('ECONNRESET');
  await db.exec('reset role; set role service_role;');
  try {
    if (rpc) {
      const types = RPC_TYPES[rpc[1]];
      const args = JSON.parse(init.body || '{}');
      const names = Object.keys(args).filter((k) => types[k]);
      const sql = `select public.${rpc[1]}(${names.map((k, i) => `${k} => $${i + 1}::${types[k]}`).join(', ')}) as r`;
      const params = names.map((k) => (types[k] === 'jsonb' ? JSON.stringify(args[k]) : args[k]));
      const { rows } = await db.query(sql, params);
      return respond(200, rows[0].r);
    }
    if (u.pathname === '/rest/v1/profiles') {
      const id = (u.searchParams.get('id') || '').replace(/^eq\./, '');
      const { rows } = await db.query(`select pricing_tier from public.profiles where id = $1`, [id]);
      return respond(200, rows);
    }
    return respond(404, { message: 'no route' });
  } finally {
    await db.exec('reset role');
  }
};
const ENV = { VITE_SUPABASE_URL: 'https://db.example.test', VITE_SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };

const identityFor = (userId, tokenId, kind, name) => ({ userId, tokenId, kind, name, matterScope: kind === 'agent' ? [] : null });
let invoked = 0;
const call = (identity, name, args = {}, { result = { ok: true }, throws = null, env = ENV, sb = null } = {}) =>
  runMeteredToolCall({
    identity, name, args, sb, env, fetchImpl,
    invoke: async () => { invoked += 1; if (throws) throw throws; return result; },
  });
const refusedText = (r) => (r?.isError ? r.content?.[0]?.text : null);
const looksLikeSentence = (t) => typeof t === 'string' && !/^[\s]*[{[]/.test(t) && !/\bat\s+\S+\s+\(|\n\s+at\s/.test(t) && /\.$/.test(t.trim());
const rows = async (sql, p) => { await db.exec('reset role'); return (await db.query(sql, p)).rows; };
const eventsOf = (uid) => rows(`select kind, cents_estimated, cents_actual, model, meta from public.usage_events where user_id = $1 order by created_at`, [uid]);

// ===========================================================================
section('2. a USER token hits the account ceiling');
// ===========================================================================
{
  const who = identityFor(FREE, FREE_TOK, 'user', 'Claude Desktop');
  const before = invoked;
  for (let i = 0; i < 5; i += 1) {
    const r = await call(who, 'search', { q: 'PRIVILEGED-QUERY-TEXT' });
    if (r.isError) check(false, `call ${i + 1} should be admitted`, refusedText(r));
  }
  check(invoked - before === 5, 'five calls on a ceiling of five are admitted and run');
  const r = await call(who, 'search', { q: 'PRIVILEGED-QUERY-TEXT' });
  const t = refusedText(r);
  check(r.isError === true && invoked - before === 5, 'the sixth is refused, and the tool does not run');
  check(/has reached its limit of 5 connector calls per hour/.test(t || ''), 'the refusal names the limit', t);
  check(/resets at \d\d:\d\d UTC\./.test(t || ''), 'and when it resets (HH:MM UTC)');
  check(looksLikeSentence(t), 'as a sentence — not JSON, not a stack');
  const oauth = await call(identityFor(FREE, undefined, 'user'), 'list_matters');
  check(oauth.isError === true, 'the ceiling is per ACCOUNT: an OAuth connection on the same account is refused too');
}

// ===========================================================================
section('3. an AGENT token hits its own ceiling');
// ===========================================================================
{
  const bot = identityFor(PRO, AGENT_1, 'agent', 'Grok bot');
  for (let i = 0; i < 3; i += 1) {
    const r = await call(bot, 'my_tasks');
    if (r.isError) check(false, `agent call ${i + 1} should be admitted`, refusedText(r));
  }
  const r = await call(bot, 'my_tasks');
  const t = refusedText(r);
  check(r.isError === true && /This agent connection \("Grok bot"\) has reached its limit of 3 Contextspaces calls per hour/.test(t || ''),
    'the fourth call from this agent is refused, naming the agent and its limit', t);
  check(/resets at \d\d:\d\d UTC\./.test(t || '') && looksLikeSentence(t), 'with the reset time, as a sentence');
  const other = await call(identityFor(PRO, AGENT_2, 'agent', 'Docket bot'), 'my_tasks');
  check(!other.isError, 'a second agent on the same account is unaffected (the ceiling is per token)');
  const user = await call(identityFor(PRO, PRO_TOK, 'user', 'ChatGPT'), 'list_matters');
  check(!user.isError, 'and so is the account owner\'s own connection');
  const [w] = await rows(`select requests from public.usage_windows where user_id = $1 and kind = 'connector'`, [PRO]);
  check(w?.requests === 5, 'the ACCOUNT window counted every admitted call from every connection (3 + 1 + 1)', `${w?.requests}`);
}

// ===========================================================================
section('4. workshop is never refused');
// ===========================================================================
{
  let refused = 0;
  for (let i = 0; i < 12; i += 1) {
    const r = await call(identityFor(EDEN, EDEN_AGENT, 'agent', 'Eden bot'), i % 2 ? 'search' : 'edit_pdf', { q: 'x' });
    if (r.isError) refused += 1;
  }
  check(refused === 0, 'twelve calls from a workshop agent with its rows set to 1 — none refused');
  const [n] = await rows(`select count(*)::int as n from public.usage_windows where user_id = $1`, [EDEN]);
  check(n.n === 0, 'and nothing was even counted');
}

// ===========================================================================
section('5–7. costed tools charge; free reads do not; attribution; no content');
// ===========================================================================
{
  const bot = identityFor(PRO, AGENT_2, 'agent', 'Docket bot');
  const content = 'CONFIDENTIAL-DOCUMENT-TEXT '.repeat(4000);   // ~108 KB
  const beforeEvents = (await eventsOf(PRO)).length;
  const reads = await call(identityFor(PRO, PRO_TOK, 'user', 'ChatGPT'), 'get_passage', { id: 'x' });
  check(!reads.isError && (await eventsOf(PRO)).length === beforeEvents, 'a free read writes no usage_events row');

  const filed = await call(bot, 'file_document',
    { matter: 'vashti', filename: 'SECRET-FILENAME-Memo.txt', content },
    { result: { document_id: 'd1', status: 'ready', passages: 12 } });
  check(!filed.isError, 'file_document is admitted and runs');
  const ev = (await eventsOf(PRO)).slice(beforeEvents);
  const expected = estimateIngestCents({ bytes: Buffer.byteLength(content, 'utf8') });
  check(ev.length === 1 && ev[0].kind === 'ingest', 'it is charged ONE usage_events row under kind ingest — the app\'s own kind, the same wallet');
  check(ev[0]?.cents_estimated === expected && expected >= 1,
    'estimated the way /api/ingest estimates (estimateIngestCents on the decoded bytes)', `${ev[0]?.cents_estimated}c = ${expected}c`);
  check(ev[0]?.cents_actual === expected, 'and reconciled to the same when no OCR ran');
  check(ev[0]?.meta?.via === 'connector' && ev[0]?.meta?.tool === 'file_document' && ev[0]?.meta?.actor === `agent:${AGENT_2}`,
    'attributed: via connector, tool file_document, actor agent:<token id>', JSON.stringify(ev[0]?.meta));
  const allowedKeys = new Set(['via', 'tool', 'actor', 'wallet_cents', 'credit_cents']);
  check(Object.keys(ev[0]?.meta ?? {}).every((k) => allowedKeys.has(k)) && ev[0]?.model === null,
    'the meta carries only via/tool/actor (+ the wallet split); model is null', Object.keys(ev[0]?.meta ?? {}).join(','));

  // OCR ran inline: reconciled up to the route's reported cost.
  await call(identityFor(PRO, PRO_TOK, 'user', 'ChatGPT'), 'file_document',
    { matter: 'vashti', filename: 'scan.png', content: Buffer.from('x'.repeat(3000)).toString('base64'), encoding: 'base64' },
    { result: { status: 'ready', ocr_route: { id: 'anthropic', pages: 4, estimated_usd: 0.12 } } });
  const ocr = (await eventsOf(PRO)).at(-1);
  check(ocr.cents_estimated >= 1 && ocr.cents_actual === 13 && ocr.meta?.actor === `token:${PRO_TOK}`,
    'an inline OCR run is reconciled to its reported cost (12¢ + embedding → 13¢), attributed to the user token',
    `${ocr.cents_estimated}c → ${ocr.cents_actual}c ${ocr.meta?.actor}`);

  // A failed call is refunded to 0.
  await call(identityFor(PRO, PRO_TOK, 'user', 'ChatGPT'), 'file_document',
    { matter: 'nope', filename: 'a.txt', content: 'hello world' }, { throws: new Error('matter not found') });
  const failed = (await eventsOf(PRO)).at(-1);
  check(failed.cents_actual === 0, 'a call that threw is reconciled to 0');

  // ingest_document reads the stored size through the caller's own client.
  const sb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { file_size_bytes: 3_000_000, source_filename: 'SECRET-FILENAME-2.pdf' } }) }) }) }) };
  await call(identityFor(PRO, PRO_TOK, 'user', 'ChatGPT'), 'ingest_document', { document_id: '00000000-0000-4000-8000-000000000001' },
    { sb, result: { status: 'queued', job_id: 'j' } });
  const ing = (await eventsOf(PRO)).at(-1);
  check(ing.kind === 'ingest' && ing.cents_estimated === estimateIngestCents({ bytes: 3_000_000 }),
    'ingest_document is charged on the stored file\'s size', `${ing.cents_estimated}c`);
  await call(identityFor(PRO, PRO_TOK, 'user', 'ChatGPT'), 'ingest_document', { document_id: '00000000-0000-4000-8000-000000000001' },
    { sb, result: { status: 'ready', note: 'Already ingested' } });
  check((await eventsOf(PRO)).at(-1).cents_actual === 0, 'and refunded to 0 when there was nothing to do');

  // 7. No content anywhere in the meter's tables.
  const dump = JSON.stringify(await rows(`
    select (select coalesce(json_agg(e), '[]') from public.usage_events e) as events,
           (select coalesce(json_agg(w), '[]') from public.usage_windows w) as windows,
           (select coalesce(json_agg(m), '[]') from public.usage_month m) as months`));
  for (const marker of ['PRIVILEGED-QUERY-TEXT', 'CONFIDENTIAL-DOCUMENT-TEXT', 'SECRET-FILENAME', 'vashti', 'hello world']) {
    check(!dump.includes(marker), `no meter row contains "${marker}"`);
  }
}

// ===========================================================================
section('8. the monthly budget refusal reaches the agent as a sentence');
// ===========================================================================
{
  await db.exec(`update public.usage_budgets set monthly_cents = 0 where pricing_tier = 'pro' and kind = '*'`);
  const before = invoked;
  const r = await call(identityFor(PRO, AGENT_2, 'agent', 'Docket bot'), 'file_document',
    { matter: 'vashti', filename: 'b.txt', content: 'x'.repeat(10_000) });
  const t = refusedText(r);
  check(r.isError && invoked === before, 'a costed call with the allowance and credits spent is refused, and does not run');
  check(/included AI usage/.test(t || '') && /Nothing was done for this call\./.test(t || '') && looksLikeSentence(t),
    'with the meter\'s own sentence', t);
  const read = await call(identityFor(PRO, PRO_TOK, 'user', 'ChatGPT'), 'search', { q: 'x' });
  check(!read.isError, 'reads go on — a spent month never locks anyone out of their documents');
  await db.exec(`update public.usage_budgets set monthly_cents = 5000 where pricing_tier = 'pro' and kind = '*'`);
}

// ===========================================================================
section('9. meter outage: reads admitted, a degraded ceiling for the rest');
// ===========================================================================
{
  resetDegradedCeiling();
  bridge.mode = 'down-all';
  const OUT = await makeUser('free', 'outage@example.test');
  const who = identityFor(OUT, null, 'user');
  let readRefused = 0;
  for (let i = 0; i < DEGRADED_CEILING.maxRequests * 2; i += 1) {
    if ((await call(who, 'search', { q: 'x' })).isError) readRefused += 1;
  }
  check(readRefused === 0, `${DEGRADED_CEILING.maxRequests * 2} reads during an outage — none refused`);
  let admitted = 0;
  let last = null;
  for (let i = 0; i < DEGRADED_CEILING.maxRequests + 3; i += 1) {
    last = await call(who, 'edit_pdf', { document_id: 'x' });
    if (!last.isError) admitted += 1;
  }
  check(admitted === DEGRADED_CEILING.maxRequests, `other calls are admitted up to the outage ceiling (${DEGRADED_CEILING.maxRequests}) — not unlimited`, `${admitted}`);
  const t = refusedText(last);
  check(/briefly unavailable/.test(t || '') && /resets at \d\d:\d\d UTC/.test(t || '') && looksLikeSentence(t),
    'then refused with a sentence', t);
  let edenRefused = 0;
  for (let i = 0; i < DEGRADED_CEILING.maxRequests + 3; i += 1) {
    const r = await call(identityFor(EDEN, EDEN_AGENT, 'agent'), 'create_deck', {},
      { env: { ...ENV, METER_UNLIMITED_USER_IDS: EDEN } });
    if (r.isError) edenRefused += 1;
  }
  check(edenRefused === 0, 'workshop (METER_UNLIMITED_USER_IDS) is never refused during an outage');
  bridge.mode = 'up';
  resetDegradedCeiling();
}

// ===========================================================================
section('10. before 086 is pasted: no ceiling, costed calls still charged');
// ===========================================================================
{
  bridge.mode = 'missing';
  const PRE = await makeUser('free', 'pre086@example.test');
  const who = identityFor(PRE, null, 'user');
  let refused = 0;
  for (let i = 0; i < 8; i += 1) if ((await call(who, 'list_matters')).isError) refused += 1;
  check(refused === 0, 'eight calls on a ceiling of five: none refused while the function is missing');
  await call(who, 'file_document', { matter: 'm', filename: 'a.txt', content: 'x'.repeat(5000) });
  check((await eventsOf(PRE)).length === 1, 'a costed call is still charged through usage_consume');
  bridge.mode = 'up';
}

// ===========================================================================
section('11. every tool is classified; api/mcp.mjs goes through the meter');
// ===========================================================================
{
  const names = TOOLS.map((t) => t.name);
  const cls = Object.fromEntries(names.map((n) => [n, toolClass(n)]));
  check([...READ_TOOLS, ...COSTED_TOOLS].every((n) => names.includes(n)), 'every listed read/costed tool is a real tool');
  check(cls.file_document === 'costed' && cls.ingest_document === 'costed' && cls.search === 'read' && cls.edit_pdf === 'work',
    'file_document/ingest_document costed, search a read, edit_pdf work');
  check(toolClass('some_future_tool') === 'work', 'an unknown tool is counted as work, never silently free');
  const src = fs.readFileSync(path.join(repo, 'api', 'mcp.mjs'), 'utf8');
  const handler = src.slice(src.indexOf('CallToolRequestSchema, async'), src.indexOf('const transport'));
  check(/return runMeteredToolCall\(\{/.test(handler) && /invoke: \(\) => callTool\(sb, name, args/.test(handler),
    'api/mcp.mjs: the CallTool handler returns runMeteredToolCall({... invoke: () => callTool(...)})');
  check((handler.match(/callTool\(/g) || []).length === 1, 'and callTool is reached only through it');
}

console.log(`\n${failures === 0
  ? `CONNECTOR METER HOLDS — ${passes} checks: ceilings per account and per agent, workshop never refused, costed calls charged on the same wallet, no content in a meter row.`
  : `${failures} FAILURE(S) of ${passes + failures}`}\n`);
process.exit(failures === 0 ? 0 : 1);

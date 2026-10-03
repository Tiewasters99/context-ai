// A sealed sub-matter's documents never go to an unsealed model — proved, not
// asserted.
//
// THE HOLE THIS CLOSES
// ---------------------------------------------------------------------------
// A Bucketizer run belongs to one matter, and since 097 round 4 its documents
// may sit anywhere in that matter's SUBTREE. Every model call the run makes is
// judged by the RUN's matter. So a run on an OPEN parent that named a document
// filed in a SEALED sub-matter read that document's passages and sent them to
// the parent's unsealed model. The same was true of the browser loop through
// /api/llm, which trusted the matter id the browser named.
//
// WHAT THIS COVERS
// ---------------------------------------------------------------------------
// A. The rule itself (lib/ai-tier-policy.mjs documentHeldBySeal), walked over
//    a real matter tree in PGlite: open parent, sealed child, an open
//    grandchild that inherits the child's seal, an open child.
// B. The server runner (lib/bucketizer-run.mjs), against PGlite, with global
//    fetch replaced by a witness that counts every provider request:
//      * a run on the open parent naming the sealed child's document → HELD,
//        with the sentence, zero provider calls, zero passages read;
//      * the same for the grandchild that only INHERITS the seal;
//      * a tier lookup that fails → held (fail closed);
//      * an OPEN sub-matter's document still classifies — the 09-26 regression
//        once refused every sub-folder document, so this is the one that
//        matters most for nobody noticing the fix;
//      * the run's own matter still classifies;
//      * a run INSIDE the sealed child still works, via the sealed pen only;
//      * a mixed run holds one document and finishes the other.
// C. The /api/llm gate (gateMatterForUser with documentIds, and the real
//    api/llm.mjs handler): a call bound to the open parent that names a sealed
//    child's document is refused with its own code — never `tier_violation`,
//    so the sealed route is never substituted — and nothing is sent anywhere.
// D. The chooser: a sealed sub-matter's document is shown with the reason and
//    is not choosable, not swept up by "everything new" or "whole folder".
//
// Offline by construction: PGlite in this process, a witnessed fetch. No .env,
// no network, no production.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node --import ./scripts/_node-src-loader.mjs scripts/_verify-bucketizer-sealed-descendants.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = (name) => fs.readFileSync(path.resolve(__dirname, '..', 'supabase', 'migrations', name), 'utf8');

const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;

let failures = 0;
let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (ok) passes += 1; else failures += 1;
};

// ===========================================================================
console.log('\n--- setup: schema, migrations, a matter tree -------------------');
// ===========================================================================
await db.exec(`
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable
    as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
  create or replace function public.update_updated_at() returns trigger
    language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

  create table public.serverspaces (id uuid primary key default gen_random_uuid(), name text);
  create table public.matterspaces (
    id uuid primary key default gen_random_uuid(),
    serverspace_id uuid not null references public.serverspaces(id) on delete cascade,
    parent_matterspace_id uuid references public.matterspaces(id) on delete cascade,
    name text,
    ai_tier text not null default 'A',
    ai_paused boolean not null default false,
    ai_paused_at timestamptz, ai_paused_by uuid, ai_paused_by_name text, ai_pause_note text
  );
  create table public.profiles (id uuid primary key default gen_random_uuid());
  create table public.productions (id uuid primary key default gen_random_uuid(), matterspace_id uuid, status text);
  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid references public.matterspaces(id) on delete cascade,
    title text, doc_type text, page_count int,
    processing_status text not null default 'ready',
    processing_error text, storage_path text,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now()
  );
  create table public.passages (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.documents(id) on delete cascade,
    matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
    sequence_number int not null,
    page_start int, page_end int, line_start int, line_end int,
    witness_name text, text text not null,
    metadata jsonb not null default '{}'
  );
  create type discovery_job_status as enum ('queued', 'running', 'done', 'error');
  create table public.processing_jobs (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
    production_id uuid references public.productions(id) on delete cascade,
    job_type text not null,
    payload jsonb not null default '{}',
    status discovery_job_status not null default 'queued',
    progress int not null default 0, progress_note text,
    claimed_by text, claimed_at timestamptz, finished_at timestamptz, error text,
    created_by uuid references public.profiles(id),
    created_at timestamptz not null default now()
  );
  create or replace function public._mtspc_select_check(p_matter uuid, p_serverspace uuid, p_parent uuid)
    returns boolean language sql security invoker stable as $$ select true $$;

  -- Migration 016's definer walk (self + ancestors), as the scope check reads it.
  create or replace function public.matter_ancestry(p_matter_id uuid)
    returns table (id uuid) language sql stable as $$
      with recursive up as (
        select m.id, m.parent_matterspace_id from public.matterspaces m where m.id = p_matter_id
        union all
        select m.id, m.parent_matterspace_id from public.matterspaces m join up on m.id = up.parent_matterspace_id
      )
      select up.id from up $$;

  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to authenticated, service_role;
`);
for (const m of ['036_bucketizer.sql', '044_ingest_reliability.sql', '045_fix_claim_job_enum_cast.sql',
  '057_processing_jobs_priority.sql', '079_bucketizer_server_runs.sql']) {
  await db.exec(migration(m));
}
await db.exec(`
  create table if not exists public.ledger_calls (
    id bigserial primary key, kind text, matter uuid, payload jsonb, at timestamptz not null default now());
  create or replace function public.ledger_append(
    p_kind text, p_matter uuid default null, p_serverspace uuid default null,
    p_session uuid default null, p_actor_kind text default 'user',
    p_actor_ref text default null, p_actor_label text default null,
    p_payload jsonb default '{}'
  ) returns jsonb language plpgsql as $$
  declare v_id bigint;
  begin
    insert into public.ledger_calls (kind, matter, payload) values (p_kind, p_matter, p_payload) returning id into v_id;
    return jsonb_build_object('id', v_id, 'seq', v_id, 'hash', 'x');
  end $$;
`);
check(true, '036 + the queue chain + 079 applied, with matter_ancestry and a ledger stand-in');

const [ss] = await q(`insert into public.serverspaces (name) values ('Firm') returning id`);
const [user] = await q(`insert into public.profiles default values returning id`);
const matter = async (name, tier, parent = null) => (await q(
  `insert into public.matterspaces (serverspace_id, parent_matterspace_id, name, ai_tier)
   values ($1, $2, $3, $4) returning id`, [ss.id, parent, name, tier]))[0].id;

const P = await matter('Fleming v. AMKC', 'A');               // the run's matter — OPEN
const S = await matter('Medical (sealed)', 'B', P);           // sealed sub-matter
const G = await matter('Psychiatric', 'A', S);                // open on its own, sealed by inheritance
const O = await matter('Depositions', 'A', P);                // open sub-matter
const STRANGER = await matter('Somebody else', 'A');          // another tree entirely

const doc = async (m, title, text) => {
  const [d] = await q(`insert into public.documents (matterspace_id, title, doc_type, page_count)
                       values ($1, $2, 'exhibit', 2) returning id`, [m, title]);
  await q(`insert into public.passages (document_id, matterspace_id, sequence_number, page_start, page_end, text)
           values ($1, $2, 0, 1, 2, $3)`, [d.id, m, text]);
  return d.id;
};
const dP = await doc(P, 'Complaint', 'PARENT_TEXT the officer struck the plaintiff');
const dS = await doc(S, 'Hospital chart', 'SEALED_CHILD_TEXT diagnosis and treatment');
const dG = await doc(G, 'Psych evaluation', 'SEALED_GRANDCHILD_TEXT evaluation notes');
const dO = await doc(O, 'Desmond deposition', 'OPEN_CHILD_TEXT the witness describes the strike');

for (const m of [P, S]) {
  for (const [i, label] of ['Excessive force', 'Damages'].entries()) {
    await q(`insert into public.bucketizer_nodes (matterspace_id, kind, label, description, position)
             values ($1, 'theme', $2, 'routing criteria', $3)`, [m, label, i]);
  }
}
check(true, 'open parent P · sealed child S (B) · grandchild G (A, under S) · open child O');

// ---------------------------------------------------------------------------
// A supabase-js-shaped client over PGlite — the calls the runner makes, plus
// a witness of every table read and a switch that breaks the tier lookup.
// ---------------------------------------------------------------------------
const touched = [];
let breakMatterspaces = false;
function pgliteSupabase() {
  const sql = async (text, params) => (await db.query(text, params)).rows;
  const col = (c) => `"${String(c).replace(/"/g, '')}"`;
  const ARRAY_COLUMNS = new Set(['passage_ids', 'document_ids']);
  const json = (v, c = null) => {
    if (v === null || v === undefined) return v;
    if (ARRAY_COLUMNS.has(c) && Array.isArray(v)) return `{${v.map((x) => `"${x}"`).join(',')}}`;
    return typeof v === 'object' ? JSON.stringify(v) : v;
  };
  class Q {
    constructor(table) {
      this.table = table; this.op = 'select';
      this.where = []; this.params = []; this.orderBy = []; this.rangeTo = null; this.one = null;
    }
    #p(v) { this.params.push(v); return `$${this.params.length}`; }
    select() { return this; }
    insert(rows) { this.op = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows, opts = {}) { this.op = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; this.conflict = opts.onConflict ?? null; return this; }
    update(patch) { this.op = 'update'; this.patch = patch; return this; }
    delete() { this.op = 'delete'; return this; }
    // Ids are compared as the column's own type (uuid), never as text: a
    // malformed id is a Postgres error here, exactly as it is live.
    eq(c, v) { this.where.push(`${col(c)} = ${this.#p(v)}`); return this; }
    neq(c, v) { this.where.push(`${col(c)} is distinct from ${this.#p(v)}`); return this; }
    in(c, vs) { this.where.push(`${col(c)} = any(${this.#p(vs)})`); return this; }
    filter(c, op, v) { if (op === 'eq') this.where.push(`${col(c)} = ${this.#p(v)}`); return this; }
    order(c, { ascending = true } = {}) { this.orderBy.push(`${col(c)} ${ascending ? 'asc' : 'desc'}`); return this; }
    limit(n) { this.rangeTo = [0, n - 1]; return this; }
    range(from, to) { this.rangeTo = [from, to]; return this; }
    single() { this.one = 'single'; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    then(resolve, reject) { return this.exec().then(resolve, reject); }
    async exec() {
      touched.push(`${this.op}:${this.table}`);
      if (breakMatterspaces && this.table === 'matterspaces') {
        return { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } };
      }
      try {
        const w = this.where.length ? ` where ${this.where.join(' and ')}` : '';
        if (this.op === 'insert') {
          const keys = [...new Set(this.rows.flatMap((r) => Object.keys(r)))];
          const values = this.rows.map((r) => `(${keys.map((k) => this.#p(json(r[k], k))).join(', ')})`).join(', ');
          const conflict = this.conflict
            ? ` on conflict (${this.conflict.split(',').map((c) => col(c.trim())).join(', ')}) do nothing` : '';
          const rows = await sql(`insert into public.${this.table} (${keys.map(col).join(', ')}) values ${values}${conflict} returning *`, this.params);
          return { data: this.one ? rows[0] ?? null : rows, error: null };
        }
        if (this.op === 'update') {
          const sets = Object.entries(this.patch).map(([k, v]) => `${col(k)} = ${this.#p(json(v, k))}`);
          const where = this.where.length ? ` where ${this.where.join(' and ')}` : '';
          const rows = await sql(`update public.${this.table} set ${sets.join(', ')}${where} returning *`, this.params);
          return { data: this.one ? rows[0] ?? null : rows, error: null };
        }
        if (this.op === 'delete') {
          await sql(`delete from public.${this.table}${w}`, this.params);
          return { data: null, error: null };
        }
        const order = this.orderBy.length ? ` order by ${this.orderBy.join(', ')}` : '';
        const lim = this.rangeTo ? ` limit ${this.rangeTo[1] - this.rangeTo[0] + 1} offset ${this.rangeTo[0]}` : '';
        const rows = await sql(`select * from public.${this.table}${w}${order}${lim}`, this.params);
        return { data: this.one ? rows[0] ?? null : rows, error: null };
      } catch (e) {
        return { data: null, error: { message: e?.message ?? String(e), code: e?.code } };
      }
    }
  }
  return {
    from: (t) => new Q(t),
    async rpc(fn, args = {}) {
      touched.push(`rpc:${fn}`);
      const keys = Object.keys(args);
      const params = keys.map((k) => json(args[k]));
      const named = keys.map((k, i) => `${k} := $${i + 1}`).join(', ');
      try {
        if (fn === 'matter_ancestry') {
          return { data: await sql(`select * from public.${fn}(${named})`, params), error: null };
        }
        const rows = await sql(`select public.${fn}(${named}) as out`, params);
        return { data: rows[0]?.out ?? null, error: null };
      } catch (e) {
        return { data: null, error: { message: e?.message ?? String(e), code: e?.code } };
      }
    },
  };
}
const sb = pgliteSupabase();

// ===========================================================================
console.log('\n--- A. the rule: a document is judged by its own matter ---------');
// ===========================================================================
const tier = await import('../lib/ai-tier-policy.mjs');
const { documentHeldBySeal, matterTierRows, SEALED_DOCUMENT_MESSAGE, gateMatterForUser } = tier;
const rows = () => matterTierRows(sb);

check(await documentHeldBySeal(rows(), P, S) === true, 'open parent, sealed child → held');
check(await documentHeldBySeal(rows(), P, G) === true, 'open parent, grandchild that only INHERITS the seal → held');
check(await documentHeldBySeal(rows(), P, O) === false, 'open parent, open child → not held (sub-folders still run)');
check(await documentHeldBySeal(rows(), P, P) === false, 'the run\'s own matter → not held');
check(await documentHeldBySeal(rows(), S, G) === false, 'a SEALED run over its own sealed subtree → not held here (the sealed route judges it)');
check(await documentHeldBySeal(rows(), P, P.toUpperCase()) === true, 'a non-canonical (upper-case) matter id → held, never skipped');
check(await documentHeldBySeal(rows(), P, 'not-a-uuid') === true, 'a malformed matter id → held');
check(await documentHeldBySeal(rows(), P, null) === true, 'no matter at all → held');
check(await documentHeldBySeal(rows(), P, '00000000-0000-4000-8000-000000000000') === true, 'a matter that does not exist → held');
check(await documentHeldBySeal(async () => { throw new Error('boom'); }, P, O) === true, 'a lookup that throws → held (fail closed)');
breakMatterspaces = true;
check(await documentHeldBySeal(rows(), P, O) === true, 'a database error on the tier read → held');
breakMatterspaces = false;
let reads = 0;
const counted = matterTierRows({ from: (t) => { reads += 1; return sb.from(t); } });
await documentHeldBySeal(counted, P, S);
await documentHeldBySeal(counted, P, G);
check(reads === 3, 'shared ancestors are read once per request, not once per document', `reads=${reads}`);

// ===========================================================================
console.log('\n--- B. the server runner --------------------------------------');
// ===========================================================================
const { runBucketizerDocumentJob } = await import('../lib/bucketizer-run.mjs');
const { haltRun } = await import('../lib/bucketizer-run-queue.mjs');

const ENV = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  VITE_SUPABASE_ANON_KEY: 'anon-key',
  ANTHROPIC_API_KEY: 'anthropic-key',
  // The sealed pen IS provisioned in this harness, on purpose: the hole is
  // only interesting if a pen exists that could have been substituted.
  BEDROCK_AWS_ACCESS_KEY_ID: 'AKIDTEST',
  BEDROCK_AWS_SECRET_ACCESS_KEY: 'testsecret',
  BEDROCK_REGION: 'us-east-1',
};
Object.assign(process.env, ENV);

// The witness. Every outbound request goes through it.
const realFetch = globalThis.fetch;
const seen = { anthropic: [], bedrock: [], docLookups: 0 };
let breakDocumentsRest = false;
const resetWitness = () => { seen.anthropic = []; seen.bedrock = []; seen.docLookups = 0; touched.length = 0; };
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const anthropicAnswer = () => ({
  content: [{ type: 'tool_use', name: 'submit_classifications',
    input: { assignments: [{ ref: 'N1', confidence: 0.8, rationale: 'the record supports it', passageRefs: ['P1'] }] } }],
  usage: { input_tokens: 1200, output_tokens: 80 },
});
const bedrockAnswer = () => {
  const args = JSON.stringify({ assignments: [{ ref: 'N1', confidence: 0.8, rationale: 'the record supports it', passageRefs: ['P1'] }] });
  const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
  return new Response(
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'submit_classifications', arguments: args } }] } }] })
    + ev({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1200, completion_tokens: 80 } })
    + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/auth/v1/user')) return jsonRes({ id: user.id });
  if (u.includes('/rest/v1/matterspaces')) {
    const id = decodeURIComponent(u.match(/id=eq\.([^&]+)/)?.[1] ?? '');
    const found = await q(`select * from public.matterspaces where id::text = $1`, [id]);
    return jsonRes(found.map((m) => ({
      id: m.id, parent_matterspace_id: m.parent_matterspace_id, ai_tier: m.ai_tier, name: m.name,
      ai_paused: m.ai_paused, ai_paused_at: null, ai_paused_by: null, ai_paused_by_name: null, ai_pause_note: null,
    })));
  }
  if (u.includes('/rest/v1/documents')) {
    seen.docLookups += 1;
    if (breakDocumentsRest) return jsonRes({ message: 'upstream timeout' }, 504);
    const ids = decodeURIComponent(u.match(/id=in\.\(([^)]*)\)/)?.[1] ?? '').split(',').filter(Boolean);
    // Compared as uuid, as PostgREST would: a malformed id is an error there.
    const found = await q(`select id, matterspace_id from public.documents where id = any($1::uuid[])`, [ids]);
    return jsonRes(found);
  }
  if (u.includes('/rpc/usage_consume')) return jsonRes({ allowed: true, status: 200, reason: 'ok', event_id: 'ev-1', max_output_tokens: 8192 });
  if (u.includes('/rpc/usage_record_actual')) return jsonRes({ ok: true });
  if (u.includes('/rpc/ledger_append')) return jsonRes({ id: 1, seq: 1, hash: 'x' });
  if (u.includes('api.anthropic.com')) { seen.anthropic.push(String(init.body ?? '')); return jsonRes(anthropicAnswer()); }
  if (u.includes('bedrock-mantle.')) { seen.bedrock.push(String(init.body ?? '')); return bedrockAnswer(); }
  throw new Error(`unexpected request in an offline harness: ${u}`);
};

async function newRun(matterId, documentIds) {
  const [r] = await q(`insert into public.bucketizer_runs
      (matterspace_id, kind, requested_by, model_id, document_ids, estimate_cents, documents_total, status)
    values ($1, 'classify', $2, 'claude-opus-4-8', $3::uuid[], 100, $4, 'running') returning id`,
  [matterId, user.id, documentIds, documentIds.length]);
  for (const d of documentIds) {
    await q(`insert into public.bucketizer_run_documents (run_id, matterspace_id, document_id, title)
             values ($1, $2, $3, 'x')`, [r.id, matterId, d]);
  }
  return r.id;
}
const runJob = (runId, matterId, documentId) => runBucketizerDocumentJob({
  supabase: sb, env: ENV,
  job: { id: 'job-1', matterspace_id: matterId, payload: { run_id: runId, document_id: documentId } },
});
const docRow = async (runId, documentId) => (await q(
  `select status, note, attempts from public.bucketizer_run_documents where run_id = $1 and document_id = $2`, [runId, documentId]))[0];
const proposals = async (documentId) => (await q(
  `select count(*)::int as n from public.bucketizer_classifications where document_id = $1`, [documentId]))[0].n;
const sentText = () => [...seen.anthropic, ...seen.bedrock].join('\n');
const finishRun = (runId) => haltRun(sb, runId, 'cancelled', 'harness', null, null);

// B1 — the hole.
resetWitness();
let runId = await newRun(P, [dS]);
let out = await runJob(runId, P, dS);
let row = await docRow(runId, dS);
check(seen.anthropic.length === 0 && seen.bedrock.length === 0,
  'B1 a run on the open parent naming the SEALED child\'s document makes ZERO provider calls',
  `anthropic=${seen.anthropic.length} bedrock=${seen.bedrock.length}`);
check(!touched.includes('select:passages'), 'B1 and not one passage of it was read');
check(row?.status === 'held', 'B1 the document is HELD (an existing run-document status)', row?.status);
check((row?.note ?? '').includes(SEALED_DOCUMENT_MESSAGE) && /^Hospital chart: /.test(row?.note ?? ''),
  'B1 with the product\'s sentence, naming the document', String(row?.note ?? '').slice(0, 90));
check(Number(row?.attempts ?? 0) === 0, 'B1 and no attempt is counted — it was never started');
check(out?.held === 'sealed_document', 'B1 the handler reports the hold', JSON.stringify(out));
check(await proposals(dS) === 0, 'B1 and nothing was written into the parent\'s tree');
let [run] = await q(`select status, documents_failed from public.bucketizer_runs where id = $1`, [runId]);
check(run.status === 'done' && run.documents_failed === 1,
  'B1 the RUN is not halted — one document is held, the run finishes and counts it', `${run.status} failed=${run.documents_failed}`);

// B2 — the seal inherited from an ancestor.
resetWitness();
runId = await newRun(P, [dG]);
await runJob(runId, P, dG);
row = await docRow(runId, dG);
check(row?.status === 'held' && seen.anthropic.length + seen.bedrock.length === 0,
  'B2 a grandchild that is open on its own but under the sealed child → held, zero calls', row?.status);

// B3 — fail closed.
resetWitness();
runId = await newRun(P, [dO]);
breakMatterspaces = true;
await runJob(runId, P, dO);
breakMatterspaces = false;
row = await docRow(runId, dO);
check(row?.status === 'held' && seen.anthropic.length + seen.bedrock.length === 0 && !touched.includes('select:passages'),
  'B3 the tier lookup fails → the (open) document is HELD, nothing read, nothing sent', row?.status);

// B4 — no regression: an OPEN sub-matter's document still classifies.
resetWitness();
runId = await newRun(P, [dO]);
await runJob(runId, P, dO);
row = await docRow(runId, dO);
check(row?.status === 'done', 'B4 an OPEN sub-matter\'s document still classifies (the 09-26 regression stays fixed)', `${row?.status} ${row?.note ?? ''}`);
check(seen.anthropic.length >= 1 && seen.bedrock.length === 0, 'B4 through the ordinary (unsealed) route', `anthropic=${seen.anthropic.length}`);
check(sentText().includes('OPEN_CHILD_TEXT'), 'B4 and it is the open child\'s text that was sent');
check(await proposals(dO) >= 1, 'B4 and its proposal is written');

// B5 — the run's own matter.
resetWitness();
runId = await newRun(P, [dP]);
await runJob(runId, P, dP);
row = await docRow(runId, dP);
check(row?.status === 'done' && seen.anthropic.length >= 1, 'B5 the run\'s own matter\'s document classifies as before', row?.status);
check(!touched.some((t) => t === 'select:matterspaces'), 'B5 and costs no tier walk at all — same matter, same tier');

// B6 — a run INSIDE the sealed child keeps the sealed route.
resetWitness();
runId = await newRun(S, [dG]);
await runJob(runId, S, dG);
row = await docRow(runId, dG);
check(row?.status === 'done', 'B6 a run inside the sealed child still classifies its sealed grandchild', `${row?.status} ${row?.note ?? ''}`);
check(seen.bedrock.length >= 1 && seen.anthropic.length === 0,
  'B6 via the sealed pen ONLY — zero unsealed provider calls', `bedrock=${seen.bedrock.length} anthropic=${seen.anthropic.length}`);

// B7 — a mixed run holds one document and finishes the other.
resetWitness();
await q(`delete from public.bucketizer_run_windows`);
await q(`update public.documents set metadata = '{}'`);
runId = await newRun(P, [dO, dS]);
await runJob(runId, P, dO);
await runJob(runId, P, dS);
const mixed = await q(`select document_id, status from public.bucketizer_run_documents where run_id = $1`, [runId]);
check(mixed.find((r) => r.document_id === dO)?.status === 'done' && mixed.find((r) => r.document_id === dS)?.status === 'held',
  'B7 a mixed run: the open child\'s document done, the sealed child\'s held', JSON.stringify(mixed.map((r) => r.status)));
check(!sentText().includes('SEALED_CHILD_TEXT') && !sentText().includes('SEALED_GRANDCHILD_TEXT'),
  'B7 and no sealed text appears in anything sent to the unsealed model');

// B8 — the scope check still refuses another tree outright (unchanged).
const dX = await doc(STRANGER, 'Their exhibit', 'STRANGER_TEXT');
runId = await newRun(P, [dO]);
await q(`insert into public.bucketizer_run_documents (run_id, matterspace_id, document_id, title) values ($1, $2, $3, 'x')`, [runId, P, dX]);
let refused = null;
try { await runJob(runId, P, dX); } catch (e) { refused = e; }
check(refused?.code === 'job_scope', 'B8 a document from ANOTHER tree is still refused by the scope check, before any of this', refused?.message ?? '');
await finishRun(runId);

// ===========================================================================
console.log('\n--- C. the /api/llm gate: the server re-derives each document\'s matter');
// ===========================================================================
const gate = (matterId, documentIds, provider = 'anthropic') => gateMatterForUser({
  supabaseUrl: ENV.VITE_SUPABASE_URL, serviceKey: ENV.SUPABASE_SERVICE_ROLE_KEY,
  provider, matterId, userId: user.id, documentIds,
});
const { sealedRouteFor } = await import('../lib/llm-sealed-route.mjs');

let g = await gate(P, [dS]);
check(!g.ok && g.status === 403 && g.error === 'document_sealed', 'C1 bound to the open parent, naming the sealed child\'s document → refused', JSON.stringify({ s: g.status, e: g.error }));
check(g.message === SEALED_DOCUMENT_MESSAGE, 'C1 with the same sentence the worker writes');
check(sealedRouteFor({ gate: g, provider: 'anthropic', model: 'claude-opus-4-8', body: '{}', env: ENV }) === null,
  'C1 and it is NOT a tier_violation, so the sealed route is never substituted (nothing is answered from anywhere)');
g = await gate(P, [dG]);
check(!g.ok && g.error === 'document_sealed', 'C2 the inherited seal is refused the same way');
g = await gate(P, [dO, dP]);
check(g.ok === true, 'C3 open child + own matter → allowed (no regression)', JSON.stringify(g));
g = await gate(P, [dO, dS]);
check(!g.ok && g.error === 'document_sealed', 'C4 one sealed document among open ones → the whole call refused');
g = await gate(P, ['not-a-uuid']);
check(!g.ok && g.status === 400 && g.error === 'invalid_document_ids', 'C5 a non-canonical document id → refused, not skipped');
g = await gate(P, [dO.toUpperCase()]);
check(!g.ok && g.error === 'invalid_document_ids', 'C6 an upper-case uuid is non-canonical too → refused');
g = await gate(P, ['00000000-0000-4000-8000-000000000000']);
check(!g.ok && g.status === 503 && g.error === 'document_seal_unknown', 'C7 a document that is not there → refused (fail closed)');
breakDocumentsRest = true;
g = await gate(P, [dO]);
breakDocumentsRest = false;
check(!g.ok && g.error === 'document_seal_unknown', 'C8 the documents lookup fails → refused (fail closed)');
resetWitness();
g = await gate(P, null);
check(g.ok === true && seen.docLookups === 0, 'C9 a call that names no documents is judged by its matter alone, as before — no extra read');
g = await gate(S, [dG]);
check(!g.ok && g.error === 'tier_violation' && seen.docLookups === 0,
  'C10 a call bound to the SEALED child is untouched: tier_violation, which the sealed route then serves', g.error);
check(sealedRouteFor({ gate: g, provider: 'anthropic', model: 'claude-opus-4-8', body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] }), env: ENV })?.provider === 'aws-bedrock',
  'C10 …and the sealed route does substitute the pen there, exactly as before');

// The real handler, end to end.
const { default: llmHandler } = await import('../api/llm.mjs');
const fakeRes = () => {
  const chunks = [];
  return {
    statusCode: 200, headers: {},
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    write(b) { chunks.push(Buffer.from(b)); return true; },
    end(b) { if (b) chunks.push(Buffer.from(b)); return this; },
    json() { try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; } },
  };
};
const llmCall = async (matterId, documentIds) => {
  const res = fakeRes();
  await llmHandler({
    method: 'POST', headers: { authorization: 'Bearer user-token' },
    body: {
      provider: 'anthropic', model: 'claude-opus-4-8', matterId, feature: 'bucketizer.classify', documentIds,
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 200, messages: [{ role: 'user', content: 'SEALED_CHILD_TEXT' }] }),
    },
  }, res);
  return res;
};
resetWitness();
let res = await llmCall(P, [dS]);
check(res.statusCode === 403 && res.json()?.error === 'document_sealed',
  'C11 api/llm.mjs: the browser loop\'s call for a sealed child\'s document is refused', `${res.statusCode} ${res.json()?.error}`);
check(res.json()?.message === SEALED_DOCUMENT_MESSAGE, 'C11 the person reads the sentence, not a code');
check(seen.anthropic.length === 0 && seen.bedrock.length === 0, 'C11 and NOTHING left — not to Anthropic, not to the pen');
resetWitness();
res = await llmCall(P, [dO]);
check(res.statusCode === 200 && seen.anthropic.length === 1, 'C12 the same call for an open child\'s document goes through as before', `${res.statusCode}`);

// ===========================================================================
console.log('\n--- D. the chooser: shown with the reason, never choosable ------');
// ===========================================================================
let chooser = null;
try {
  chooser = await import('../src/lib/bucketizer/chooser.ts');
} catch (e) {
  check(false, 'chooser.ts imports (run with --import ./scripts/_node-src-loader.mjs)', e?.message ?? '');
}
if (chooser) {
  const docs = [
    { id: dP, title: 'Complaint', matterspace_id: P, processing_status: 'ready' },
    { id: dS, title: 'Hospital chart', matterspace_id: S, processing_status: 'ready' },
    { id: dG, title: 'Psych evaluation', matterspace_id: G, processing_status: 'held' },
    { id: dO, title: 'Desmond deposition', matterspace_id: O, processing_status: 'ready' },
  ];
  // The inventory's own computation: every tree matter through the same rule.
  const sealedMatterIds = new Set();
  const fr = matterTierRows(sb);
  for (const m of [P, S, G, O]) if (m !== P && await documentHeldBySeal(fr, P, m)) sealedMatterIds.add(m);
  check(sealedMatterIds.size === 2 && sealedMatterIds.has(S) && sealedMatterIds.has(G),
    'D1 the tree\'s sealed sub-matters, as the inventory computes them: the child and its grandchild');
  const built = chooser.buildChooserRows({ matterIds: [P, S, G, O], documents: docs, classifications: [], sealedMatterIds });
  const byId = new Map(built.map((r) => [r.id, r]));
  check(byId.get(dS)?.state === 'sealed' && !chooser.isChoosable(byId.get(dS)), 'D2 the sealed child\'s document is shown, as sealed, and is not choosable');
  check(/sealed sub-matter/.test(byId.get(dS)?.blockedReason ?? ''), 'D2 with the reason beside it', byId.get(dS)?.blockedReason?.slice(0, 60));
  check(byId.get(dG)?.state === 'sealed', 'D3 a sealed grandchild that is ALSO held for OCR shows the seal, the reason that will not go away by waiting');
  check(chooser.isChoosable(byId.get(dO)) && chooser.isChoosable(byId.get(dP)), 'D4 open-child and own-matter documents stay choosable');
  const fresh = chooser.freshCandidates(built).map((d) => d.id);
  check(fresh.includes(dO) && fresh.includes(dP) && !fresh.includes(dS) && !fresh.includes(dG),
    'D5 "everything not yet classified" never sweeps up a sealed document');
  const folder = chooser.choosableIn(built, [P, S, G, O]).map((r) => r.id);
  check(!folder.includes(dS) && !folder.includes(dG) && folder.includes(dO), 'D6 "whole folder" selection leaves them out');
  const forRun = chooser.docRowsForRun(built, [dS, dO]).map((d) => d.id);
  check(forRun.length === 1 && forRun[0] === dO, 'D7 a stale selection naming one is dropped before the run is asked for');
  const insideSealed = chooser.buildChooserRows({ matterIds: [S, G], documents: docs, classifications: [], sealedMatterIds: new Set() });
  check(insideSealed.find((r) => r.id === dS)?.state !== 'sealed', 'D8 inside the sealed matter itself, nothing is marked — its runs take the sealed route');
}

// ===========================================================================
console.log('\n--- E. run start refuses them too (source) ---------------------');
// ===========================================================================
// The endpoint needs a live Supabase session to drive; the rule it calls is
// the one exercised in A. These pin the wiring.
const api = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'bucketizer-run.mjs'), 'utf8');
check(/documentHeldBySeal\(tierRows, matterId, d\.matterspace_id\)/.test(api), 'E1 start asks documentHeldBySeal of every document outside the run\'s own matter');
check(/error: 'documents_sealed'/.test(api) && /nothing was started/.test(api), 'E2 and refuses the whole start, saying nothing was started');
check(/matterTierRows\(svc\)/.test(api), 'E3 reading the tier with the service role (policy, not content)');

globalThis.fetch = realFetch;
console.log(`\n${failures === 0 ? `ALL CHECKS PASSED (${passes})` : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

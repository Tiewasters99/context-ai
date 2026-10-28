// Verification of migration 125 (no agent work in a sealed matter) on a real
// Postgres (PGlite) — node scripts/_verify-sealed-125.mjs
//
// The tables and helpers 125 builds on are stood in for, column for column
// where 125 reads them: matterspaces (ai_tier, parent), 094's
// stepup_internal.effective_tier_is_sealed, 085/089's agent_tasks and its
// two policy helpers, 121's tm_clearances. Then 125 itself, twice (it is
// re-runnable), and:
//   * a task in an open matter is accepted; in a sealed matter, or a matter
//     under a sealed parent, it is refused by the policy
//   * a clearance in an open matter is accepted; in a sealed or sealed-parent
//     matter it is refused by the trigger, with the plain sentence

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + String(detail).slice(0, 300) : ''}`);
};

const db = new PGlite();
const USER = '00000000-0000-4000-8000-0000000000aa';
const OPEN = '00000000-0000-4000-8000-000000000001';
const SEALED = '00000000-0000-4000-8000-000000000002';
const UNDER = '00000000-0000-4000-8000-000000000003';
const TOKEN = '00000000-0000-4000-8000-0000000000bb';

await db.exec(`
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
  create table public.matterspaces (id uuid primary key, parent_matterspace_id uuid references public.matterspaces(id), ai_tier text not null default 'A');
  insert into public.matterspaces values ('${OPEN}', null, 'A'), ('${SEALED}', null, 'B'), ('${UNDER}', '${SEALED}', 'A');
  create schema stepup_internal;
  create function stepup_internal.effective_tier_is_sealed(p_matter uuid) returns boolean
    language sql stable security definer set search_path = public as $f$
      with recursive up as (
        select id, parent_matterspace_id, ai_tier from public.matterspaces where id = p_matter
        union all select m.id, m.parent_matterspace_id, m.ai_tier from public.matterspaces m join up on m.id = up.parent_matterspace_id)
      select exists (select 1 from up where ai_tier in ('B', 'C')) $f$;
  create table public.agent_tasks (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid not null references public.matterspaces(id),
    created_by uuid not null, assigned_token_id uuid, assigned_grant_id uuid, title text);
  alter table public.agent_tasks enable row level security;
  create function public._agent_task_matter_access(p uuid) returns boolean language sql stable as $f$ select true $f$;
  create function public._agent_task_recipient_is_mine(t uuid, g uuid) returns boolean language sql stable as $f$ select true $f$;
  create policy agent_tasks_select on public.agent_tasks for select to authenticated using (true);
  create table public.tm_clearances (id uuid primary key default gen_random_uuid(), matterspace_id uuid not null references public.matterspaces(id), mark text);
  grant usage on schema public, auth, stepup_internal to authenticated;
  grant select, insert on public.agent_tasks, public.tm_clearances to authenticated;
  grant select on public.matterspaces to authenticated;
  grant execute on all functions in schema stepup_internal to authenticated;
`);

const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '125_sealed_no_agent_work.sql'), 'utf8');
for (const pass of [1, 2]) {
  try { await db.exec(sql); check(true, `125 applies (pass ${pass})`); } catch (e) { check(false, `125 applies (pass ${pass})`, e.message); }
}

const asUser = async (q) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${USER}', false);`);
  try { await db.query(q); return null; } catch (e) { return e; } finally { await db.exec('reset role;'); }
};

const task = (m) => asUser(`insert into public.agent_tasks (matterspace_id, created_by, assigned_token_id, title) values ('${m}', '${USER}', '${TOKEN}', 't')`);
check((await task(OPEN)) === null, 'a task in an open matter is accepted');
const t1 = await task(SEALED);
check(/row-level security/i.test(t1?.message ?? ''), 'a task in a sealed matter is refused by the policy', t1?.message ?? 'accepted');
const t2 = await task(UNDER);
check(/row-level security/i.test(t2?.message ?? ''), 'a task in a matter under a sealed parent is refused', t2?.message ?? 'accepted');

const clearance = (m) => asUser(`insert into public.tm_clearances (matterspace_id, mark) values ('${m}', 'QUALLET')`);
check((await clearance(OPEN)) === null, 'a clearance in an open matter is accepted');
const c1 = await clearance(SEALED);
check(/does not run in a sealed matter/.test(c1?.message ?? ''), 'a clearance in a sealed matter is refused, in plain words', c1?.message ?? 'accepted');
const c2 = await clearance(UNDER);
check(/does not run in a sealed matter/.test(c2?.message ?? ''), 'a clearance under a sealed parent is refused', c2?.message ?? 'accepted');

const { rows } = await db.query(`select (select count(*) from public.agent_tasks)::int t, (select count(*) from public.tm_clearances)::int c`);
check(rows[0].t === 1 && rows[0].c === 1, 'only the open-matter rows were written', JSON.stringify(rows[0]));

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);

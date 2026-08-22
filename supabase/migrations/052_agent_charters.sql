-- 052_agent_charters.sql — Agents: a charter is a page the user wrote
--
-- An agent in Contextspaces is three things and nothing more:
--   a CHARTER   — who it is and what its job is, in the user's own prose;
--   a TOOLSET   — the named tools it may use, chosen from the sanctioned
--                 set the Orchestrator already allows (lib/assistant-core
--                 ALLOWED_TOOLS ∩ lib/mcp-core TOOLS). A charter may only
--                 NARROW that set — never widen it. The intersection is
--                 done server-side at run time; this table only records
--                 what the user asked for;
--   a TRIGGER   — 'on_demand' (v1: fully implemented), 'schedule' or
--                 'on_document' (v1: STORED AND SHOWN AS NOT RUNNING —
--                 there is no scheduler and no document-landed hook in
--                 this codebase yet; the UI says so plainly).
--
-- The PEN is deliberately NOT on this table. Which model answers is
-- governed by the matter's SecureSpace tier (migration 051) and is never
-- a client choice — see lib/ai-tier-policy.mjs. A charter that could pick
-- its own model would be a hole in the seal.
--
-- Runs are not recorded here either: a charter run IS an Orchestrator run,
-- so it lands in ai_sessions / ai_messages (051) like every other exchange,
-- with the charter id written into the message content JSON so the run is
-- attributable. One ledger, not two.
--
-- RLS is modelled on 051: an author clause (owner_id = auth.uid()) so
-- INSERT..RETURNING passes the SELECT policy (the 047 lesson), and matter
-- visibility through the SECURITY INVOKER helper public._mtspc_select_check
-- (022). matterspace_id is NULLABLE — an unscoped charter is visible to its
-- owner only.
--
-- `create table if not exists` throughout: prod is hand-applied and the
-- migrations folder is not the live database.

create table if not exists public.agent_charters (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid()
                    references auth.users(id) on delete cascade,
  -- The matter this agent works in. NULL = not scoped to a matter yet;
  -- the agent can still be edited, but a run without a matter falls back
  -- to the Orchestrator's ordinary "ask which matter" behaviour.
  matterspace_id  uuid references public.matterspaces(id) on delete cascade,
  name            text not null,
  -- The charter, in two parts, both plain prose. `purpose` is the one-line
  -- answer to "what is this agent for"; `instructions` is the page — the
  -- job explained the way you would explain it to a colleague. Explained,
  -- not rule-stacked (see the agentic-design note: a charter that reads as
  -- a list of prohibitions produces a worse agent than one that reads as a
  -- description of the work).
  purpose         text not null default '',
  instructions    text not null default '',
  -- Tool names, exactly as they appear in lib/mcp-core.mjs TOOLS. An empty
  -- array means the agent gets NO research tools and answers from the
  -- conversation alone — that is a legitimate charter, and the editor says
  -- so rather than silently granting a default.
  allowed_tools   text[] not null default '{}',
  trigger_kind    text not null default 'on_demand'
                    check (trigger_kind in ('on_demand', 'schedule', 'on_document')),
  -- Shape depends on trigger_kind: {} for on_demand;
  -- { "cadence": "daily" | "weekdays" | "weekly", "at": "07:30" } for schedule;
  -- { "scope": "matter" } for on_document. Stored, not yet acted on.
  trigger_config  jsonb not null default '{}',
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists agent_charters_owner_idx
  on public.agent_charters (owner_id, updated_at desc);
create index if not exists agent_charters_matter_idx
  on public.agent_charters (matterspace_id, updated_at desc);

alter table public.agent_charters enable row level security;

-- Visible to its owner, or to anyone who can see the matter it is scoped
-- to (a co-counsel who can read the matter can read the agents working in
-- it — an agent nobody else can see is an agent nobody can audit).
drop policy if exists "Charters visible to owner or matter members" on public.agent_charters;
create policy "Charters visible to owner or matter members"
on public.agent_charters for select
using (
  owner_id = auth.uid()
  or (
    matterspace_id is not null
    and exists (
      select 1 from public.matterspaces m
      where m.id = matterspace_id
        and public._mtspc_select_check(m.id, m.serverspace_id, m.parent_matterspace_id)
    )
  )
);

-- Only the owner writes, and only into a matter they can already see.
drop policy if exists "Users create their own charters" on public.agent_charters;
create policy "Users create their own charters"
on public.agent_charters for insert
with check (
  owner_id = auth.uid()
  and (
    matterspace_id is null
    or exists (
      select 1 from public.matterspaces m
      where m.id = matterspace_id
        and public._mtspc_select_check(m.id, m.serverspace_id, m.parent_matterspace_id)
    )
  )
);

drop policy if exists "Owners update their charters" on public.agent_charters;
create policy "Owners update their charters"
on public.agent_charters for update
using (owner_id = auth.uid())
with check (
  owner_id = auth.uid()
  and (
    matterspace_id is null
    or exists (
      select 1 from public.matterspaces m
      where m.id = matterspace_id
        and public._mtspc_select_check(m.id, m.serverspace_id, m.parent_matterspace_id)
    )
  )
);

drop policy if exists "Owners delete their charters" on public.agent_charters;
create policy "Owners delete their charters"
on public.agent_charters for delete
using (owner_id = auth.uid());

notify pgrst, 'reload schema';

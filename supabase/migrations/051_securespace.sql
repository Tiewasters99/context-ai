-- 051_securespace.sql — The seal: per-matter AI tier + privileged AI sessions
--
-- SecureSpace is a state a Contextspaces matter can be in, not a separate
-- product. This migration adds:
--
--   1. matterspaces.ai_tier — 'A' (US frontier), 'B' (sealed: US-hosted
--      zero-retention pens only), 'C' (silo: local only). Default 'A'
--      preserves today's behavior for every existing matter — the seal now
--      governs the MCP connectors too, so a B default would cut existing
--      workflows off from their own matters. Sealing is a deliberate act.
--
--   2. ai_sessions / ai_messages — the privileged record and the egress
--      ledger in one: every assistant message carries model, provider,
--      tokens, cost, and a within-policy stamp.
--
-- Retention posture (Eden, 2026-08-21): sessions persist as privileged
-- attorney work product and are EXCLUDED from client-file export flows.
--
-- RLS follows the house pattern (048): an author clause (owner_id =
-- auth.uid()) guarantees INSERT..RETURNING passes the SELECT policy (the
-- 047 lesson); matter visibility goes through the INVOKER helper
-- public._mtspc_select_check (022). Tier ENFORCEMENT is server-side in the
-- API layer — these tables record; the proxy refuses.

-- 1 ── the tier ─────────────────────────────────────────────────────────
alter table public.matterspaces
  add column if not exists ai_tier text not null default 'A'
  check (ai_tier in ('A', 'B', 'C'));

-- 2 ── sessions ─────────────────────────────────────────────────────────
create table if not exists public.ai_sessions (
  id              uuid primary key default gen_random_uuid(),
  matterspace_id  uuid not null references public.matterspaces(id) on delete cascade,
  owner_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title           text not null default 'New session',
  -- the matter's tier stamped at creation, so the record shows what policy
  -- governed the session even if the matter is re-tiered later
  tier            text not null check (tier in ('A', 'B', 'C')),
  status          text not null default 'open' check (status in ('open', 'closed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists ai_sessions_matter_idx
  on public.ai_sessions (matterspace_id, updated_at desc);
create index if not exists ai_sessions_owner_idx
  on public.ai_sessions (owner_id, updated_at desc);

-- 3 ── messages: the record and the ledger in one row ───────────────────
create table if not exists public.ai_messages (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.ai_sessions(id) on delete cascade,
  seq             int  not null,
  role            text not null check (role in ('user', 'assistant', 'tool')),
  -- content blocks as JSON: [{type:'text',text}, {type:'tool_use',...}, ...]
  content         jsonb not null,
  -- the ledger line (assistant rows; null on user rows)
  model           text,
  provider        text,
  input_tokens    int,
  output_tokens   int,
  estimated_cost  numeric(10, 4),
  within_policy   boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (session_id, seq)
);

create index if not exists ai_messages_session_idx
  on public.ai_messages (session_id, seq);

-- 4 ── RLS ──────────────────────────────────────────────────────────────
alter table public.ai_sessions enable row level security;
alter table public.ai_messages enable row level security;

drop policy if exists "Sessions visible to owner or matter members" on public.ai_sessions;
create policy "Sessions visible to owner or matter members"
on public.ai_sessions for select
using (
  owner_id = auth.uid()
  or exists (
    select 1 from public.matterspaces m
    where m.id = matterspace_id
      and public._mtspc_select_check(m.id, m.serverspace_id, m.parent_matterspace_id)
  )
);

drop policy if exists "Users create sessions in matters they can see" on public.ai_sessions;
create policy "Users create sessions in matters they can see"
on public.ai_sessions for insert
with check (
  owner_id = auth.uid()
  and exists (
    select 1 from public.matterspaces m
    where m.id = matterspace_id
      and public._mtspc_select_check(m.id, m.serverspace_id, m.parent_matterspace_id)
  )
);

drop policy if exists "Owners update their sessions" on public.ai_sessions;
create policy "Owners update their sessions"
on public.ai_sessions for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "Owners delete their sessions" on public.ai_sessions;
create policy "Owners delete their sessions"
on public.ai_sessions for delete
using (owner_id = auth.uid());

-- Messages inherit the session's visibility; only the session owner writes.
drop policy if exists "Messages visible with their session" on public.ai_messages;
create policy "Messages visible with their session"
on public.ai_messages for select
using (
  exists (select 1 from public.ai_sessions s where s.id = session_id)
);

drop policy if exists "Session owners append messages" on public.ai_messages;
create policy "Session owners append messages"
on public.ai_messages for insert
with check (
  exists (
    select 1 from public.ai_sessions s
    where s.id = session_id and s.owner_id = auth.uid()
  )
);

drop policy if exists "Session owners delete messages" on public.ai_messages;
create policy "Session owners delete messages"
on public.ai_messages for delete
using (
  exists (
    select 1 from public.ai_sessions s
    where s.id = session_id and s.owner_id = auth.uid()
  )
);

-- Moot Bench: oral-argument prep sessions.
--
-- A session belongs to one lawyer (owner-only RLS — prep is private work
-- product until the owner explicitly shares the transcript into a matter
-- thread). Sources are extracted client-side and stored inline as jsonb;
-- the bench memo and the Q&A transcript live here too.

create table if not exists public.argument_prep_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  matterspace_id uuid references public.matterspaces(id) on delete set null,
  title text not null,
  model_id text not null,
  -- [{ name, content }] — text extracted from the uploaded briefs/orders.
  sources jsonb not null default '[]'::jsonb,
  bench_memo text,
  status text not null default 'memo' check (status in ('memo', 'prepping', 'ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.argument_prep_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.argument_prep_sessions(id) on delete cascade,
  role text not null check (role in ('bench', 'counsel')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists argument_prep_messages_session_idx
  on public.argument_prep_messages(session_id, created_at);

alter table public.argument_prep_sessions enable row level security;
alter table public.argument_prep_messages enable row level security;

create policy "prep_sessions_owner_select" on public.argument_prep_sessions
  for select using (owner_id = auth.uid());
create policy "prep_sessions_owner_insert" on public.argument_prep_sessions
  for insert with check (owner_id = auth.uid());
create policy "prep_sessions_owner_update" on public.argument_prep_sessions
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "prep_sessions_owner_delete" on public.argument_prep_sessions
  for delete using (owner_id = auth.uid());

create policy "prep_messages_owner_select" on public.argument_prep_messages
  for select using (
    exists (select 1 from public.argument_prep_sessions s
            where s.id = session_id and s.owner_id = auth.uid()));
create policy "prep_messages_owner_insert" on public.argument_prep_messages
  for insert with check (
    exists (select 1 from public.argument_prep_sessions s
            where s.id = session_id and s.owner_id = auth.uid()));
create policy "prep_messages_owner_delete" on public.argument_prep_messages
  for delete using (
    exists (select 1 from public.argument_prep_sessions s
            where s.id = session_id and s.owner_id = auth.uid()));

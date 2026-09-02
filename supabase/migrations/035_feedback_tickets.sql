-- Feedback tickets: bug reports, complaints, and suggestions left by users.
-- Swept periodically into a Claude Code triage session together with
-- Grapheon's tickets (same schema there, app='grapheon').
--
-- Access model:
--   INSERT: anon + authenticated (the API route validates and caps payloads;
--           feedback must never require jumping through hoops).
--   SELECT/UPDATE: no public policies — reading and sweeping are
--           service-role only.

create table if not exists public.feedback_tickets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  app text not null default 'contextspaces',
  user_id uuid null,
  email text null,
  category text not null check (category in ('bug', 'complaint', 'suggestion')),
  page text null,
  message text not null check (char_length(message) between 1 and 4000),
  context jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'swept', 'triaged', 'resolved', 'wontfix')),
  swept_at timestamptz null,
  resolution_note text null
);

create index if not exists feedback_tickets_status_idx
  on public.feedback_tickets (status, created_at desc);

alter table public.feedback_tickets enable row level security;

drop policy if exists feedback_tickets_insert on public.feedback_tickets;
create policy feedback_tickets_insert
  on public.feedback_tickets
  for insert
  to anon, authenticated
  with check (
    status = 'open'
    and swept_at is null
    and resolution_note is null
  );

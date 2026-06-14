-- Context.ai Migration 031: orchestrator_feedback — early-adopter feedback queue
--
-- The Orchestrator (the in-app assistant) captures product feedback here the
-- moment a user voices it: a wish, a frustration, a point of confusion, or
-- praise about Contextspaces itself — distinct from a question about their
-- documents. The assistant calls its relay_feedback tool, which inserts one row
-- through the user-scoped client, so RLS applies and the row is attributed to
-- the signed-in user automatically (user_id defaults to auth.uid()).
--
-- Context is snapshotted as plain text (route, tab, matter name) so a row stays
-- self-contained and durable even if the matter is later deleted — that's why
-- matterspace_id is a bare uuid, NOT a cascading FK. This is a dev/triage queue,
-- not matter content, so it is deliberately outside the matter-isolation model.
--
-- RLS:
--   insert → user_id defaults to auth.uid(); with-check enforces it
--   select → own rows only (auth.uid())
-- The owner sweeps and triages the full queue with the service role
-- (scripts/orchestrator-feedback.mjs), which bypasses RLS. There is no UPDATE or
-- DELETE policy by design: status changes are an owner (service-role) operation.
--
-- Depends only on public.profiles. Apply order: after 030.

create table if not exists public.orchestrator_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body text not null check (length(trim(body)) > 0 and length(body) <= 5000),
  category text not null default 'other'
    check (category in ('idea', 'bug', 'confusion', 'praise', 'other')),
  route text,
  tab text,
  matterspace_id uuid,
  matter_name text,
  status text not null default 'new'
    check (status in ('new', 'triaged', 'shipped', 'declined')),
  created_at timestamptz not null default now()
);

create index if not exists idx_orchestrator_feedback_status_created
  on public.orchestrator_feedback(status, created_at desc);

alter table public.orchestrator_feedback enable row level security;

drop policy if exists "Users insert own feedback" on public.orchestrator_feedback;
create policy "Users insert own feedback"
  on public.orchestrator_feedback for insert
  with check (user_id = auth.uid());

drop policy if exists "Users read own feedback" on public.orchestrator_feedback;
create policy "Users read own feedback"
  on public.orchestrator_feedback for select
  using (user_id = auth.uid());

notify pgrst, 'reload schema';

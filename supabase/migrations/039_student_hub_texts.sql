-- Student Hub: texts (scanned casebooks/chapters) as the organizing level.
--
-- The hub flows from the student's library down: My texts -> a text ->
-- Readings / Outlines / Case briefs / Cold calls -> one case or material
-- (a student_hub_sessions row, now positioned inside the text by chapter,
-- section, and sort order). Sessions with no text_id are loose readings
-- filed from the shelf.

create table if not exists public.student_hub_texts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.student_hub_sessions
  add column if not exists text_id uuid references public.student_hub_texts(id) on delete cascade,
  add column if not exists chapter text not null default '',
  add column if not exists section text not null default '',
  add column if not exists kind text not null default 'case',
  add column if not exists sort integer not null default 0;

alter table public.student_hub_sessions
  drop constraint if exists student_hub_sessions_kind_check;
alter table public.student_hub_sessions
  add constraint student_hub_sessions_kind_check check (kind in ('case', 'material'));

create index if not exists student_hub_sessions_text_idx
  on public.student_hub_sessions(text_id, sort);

alter table public.student_hub_texts enable row level security;

create policy "student_hub_texts_owner_select" on public.student_hub_texts
  for select using (owner_id = auth.uid());
create policy "student_hub_texts_owner_insert" on public.student_hub_texts
  for insert with check (owner_id = auth.uid());
create policy "student_hub_texts_owner_update" on public.student_hub_texts
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "student_hub_texts_owner_delete" on public.student_hub_texts
  for delete using (owner_id = auth.uid());

notify pgrst, 'reload schema';

-- Student Hub: a voice-enabled Socratic study companion for law students.
--
-- A reading session belongs to one student (owner-only RLS — the reading
-- text comes from the student's own scanned casebook and stays locked to
-- their account; see docs/student-hub/student-hub-design.md "Guardrails").
-- The generated brief and outline are stored inline as jsonb; the cold-call
-- transcript is persisted per exchange, like Moot Bench (034).

create table if not exists public.student_hub_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  citation text not null default '',
  -- Where the reading came from, shown under the caption
  -- (e.g. "scanned from your casebook, ch. 1 § 1").
  source_label text not null default '',
  reading text not null,
  -- [{ label, content }] — classic case-brief fields.
  brief jsonb,
  -- [{ heading, items: [] }] — section outline.
  outline jsonb,
  model_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.student_hub_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.student_hub_sessions(id) on delete cascade,
  role text not null check (role in ('professor', 'student')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists student_hub_messages_session_idx
  on public.student_hub_messages(session_id, created_at);

alter table public.student_hub_sessions enable row level security;
alter table public.student_hub_messages enable row level security;

create policy "student_hub_sessions_owner_select" on public.student_hub_sessions
  for select using (owner_id = auth.uid());
create policy "student_hub_sessions_owner_insert" on public.student_hub_sessions
  for insert with check (owner_id = auth.uid());
create policy "student_hub_sessions_owner_update" on public.student_hub_sessions
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "student_hub_sessions_owner_delete" on public.student_hub_sessions
  for delete using (owner_id = auth.uid());

create policy "student_hub_messages_owner_select" on public.student_hub_messages
  for select using (
    exists (select 1 from public.student_hub_sessions s
            where s.id = session_id and s.owner_id = auth.uid()));
create policy "student_hub_messages_owner_insert" on public.student_hub_messages
  for insert with check (
    exists (select 1 from public.student_hub_sessions s
            where s.id = session_id and s.owner_id = auth.uid()));
create policy "student_hub_messages_owner_delete" on public.student_hub_messages
  for delete using (
    exists (select 1 from public.student_hub_sessions s
            where s.id = session_id and s.owner_id = auth.uid()));

notify pgrst, 'reload schema';

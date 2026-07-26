-- Student Hub: the student's own layer on the reading — freeform notes,
-- page highlights, interactive-outline annotations (own points, notes,
-- cross-references), and outside resources (links, videos) — plus a second
-- message thread for the study aide: direct answers at the student's
-- elbow, distinct from the Socratic cold call.

alter table public.student_hub_sessions
  add column if not exists notes text not null default '',
  add column if not exists highlights jsonb not null default '[]'::jsonb,
  add column if not exists annotations jsonb not null default '{}'::jsonb,
  add column if not exists resources jsonb not null default '[]'::jsonb;

alter table public.student_hub_messages
  add column if not exists thread text not null default 'coldcall';
alter table public.student_hub_messages
  drop constraint if exists student_hub_messages_thread_check;
alter table public.student_hub_messages
  add constraint student_hub_messages_thread_check check (thread in ('coldcall', 'ask'));

create index if not exists student_hub_messages_thread_idx
  on public.student_hub_messages(session_id, thread, created_at);

notify pgrst, 'reload schema';

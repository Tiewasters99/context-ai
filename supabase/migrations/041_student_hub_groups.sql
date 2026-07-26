-- Student Hub: study groups. A group lives on one text; up to five
-- members, each of whom attests to owning a lawful copy of the underlying
-- work (docs/student-hub/student-hub-design.md "Guardrails" — the ≤5 cap
-- is enforced in the app and warranted in the TOS). Messages may anchor to
-- a highlighted passage. The scan itself stays in the owner's storage
-- folder; group messages carry only the student's own notes and words.

create table if not exists public.student_hub_groups (
  id uuid primary key default gen_random_uuid(),
  text_id uuid not null references public.student_hub_texts(id) on delete cascade,
  name text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.student_hub_group_members (
  group_id uuid not null references public.student_hub_groups(id) on delete cascade,
  email text not null,
  user_id uuid references auth.users(id) on delete cascade,
  -- Set when this member affirms they own a lawful copy of the text.
  attested_at timestamptz,
  added_at timestamptz not null default now(),
  primary key (group_id, email)
);

create table if not exists public.student_hub_group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.student_hub_groups(id) on delete cascade,
  session_id uuid references public.student_hub_sessions(id) on delete set null,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_email text not null default '',
  -- { page, note, reading_title } — the passage the message hangs on.
  anchor jsonb,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists shg_messages_group_idx
  on public.student_hub_group_messages(group_id, created_at);

-- Membership check. Inner SECURITY DEFINER reads the members table without
-- RLS (avoids policy recursion: members/groups/messages policies all need
-- membership); outer SECURITY INVOKER wrapper captures auth.uid()/email at
-- entry, per the 022 convention.
create or replace function public._shg_member_definer(p_group uuid, p_uid uuid, p_email text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.student_hub_group_members m
    where m.group_id = p_group
      and (m.user_id = p_uid or lower(m.email) = lower(p_email))
  );
$$;

create or replace function public._shg_member(p_group uuid)
returns boolean
language plpgsql
security invoker
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := coalesce(auth.jwt() ->> 'email', '');
begin
  return public._shg_member_definer(p_group, v_uid, v_email);
end;
$$;

grant execute on function public._shg_member_definer(uuid, uuid, text) to authenticated, service_role;
grant execute on function public._shg_member(uuid) to authenticated, service_role;

alter table public.student_hub_groups enable row level security;
alter table public.student_hub_group_members enable row level security;
alter table public.student_hub_group_messages enable row level security;

create policy "shg_groups_select" on public.student_hub_groups
  for select using (created_by = auth.uid() or public._shg_member(id));
create policy "shg_groups_insert" on public.student_hub_groups
  for insert with check (created_by = auth.uid());
create policy "shg_groups_delete" on public.student_hub_groups
  for delete using (created_by = auth.uid());

create policy "shg_members_select" on public.student_hub_group_members
  for select using (public._shg_member(group_id));
create policy "shg_members_insert" on public.student_hub_group_members
  for insert with check (
    exists (select 1 from public.student_hub_groups g
            where g.id = group_id and g.created_by = auth.uid()));
-- A member claims their row (user_id) and attests; only their own row.
create policy "shg_members_update" on public.student_hub_group_members
  for update using (
    user_id = auth.uid()
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
  with check (
    user_id = auth.uid()
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
create policy "shg_members_delete" on public.student_hub_group_members
  for delete using (
    user_id = auth.uid()
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    or exists (select 1 from public.student_hub_groups g
               where g.id = group_id and g.created_by = auth.uid()));

create policy "shg_messages_select" on public.student_hub_group_messages
  for select using (public._shg_member(group_id));
create policy "shg_messages_insert" on public.student_hub_group_messages
  for insert with check (public._shg_member(group_id) and author_id = auth.uid());
create policy "shg_messages_delete" on public.student_hub_group_messages
  for delete using (author_id = auth.uid());

-- Live chat: stream inserts to group members.
do $$ begin
  alter publication supabase_realtime add table public.student_hub_group_messages;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';

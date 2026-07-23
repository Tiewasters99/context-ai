-- Student Hub: the reading as actual scanned casebook pages.
--
-- Page images live in a private storage bucket, under a folder named by the
-- owner's auth uid — the scan is hard-locked to the owner's account and
-- never shareable (docs/student-hub/student-hub-design.md "Guardrails").
-- A session's `pages` is the ordered list of object paths backing its
-- reading; sessions without pages fall back to their pasted text.

alter table public.student_hub_sessions
  add column if not exists pages jsonb;

insert into storage.buckets (id, name, public)
values ('student-hub-scans', 'student-hub-scans', false)
on conflict (id) do nothing;

drop policy if exists "student_hub_scans_owner_select" on storage.objects;
create policy "student_hub_scans_owner_select" on storage.objects
  for select using (
    bucket_id = 'student-hub-scans'
    and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "student_hub_scans_owner_insert" on storage.objects;
create policy "student_hub_scans_owner_insert" on storage.objects
  for insert with check (
    bucket_id = 'student-hub-scans'
    and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "student_hub_scans_owner_delete" on storage.objects;
create policy "student_hub_scans_owner_delete" on storage.objects
  for delete using (
    bucket_id = 'student-hub-scans'
    and (storage.foldername(name))[1] = auth.uid()::text);

notify pgrst, 'reload schema';

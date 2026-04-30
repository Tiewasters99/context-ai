-- Context.ai Migration 010: cover-images storage bucket
--
-- Backs the file-upload path in CoverImage.tsx. Public bucket so the
-- saved cover_url can be embedded as a plain <img src> without signed
-- URLs. Uploads are scoped per-user: each authenticated user can only
-- write/delete under a folder named with their auth.uid().

-- Create the bucket (idempotent)
insert into storage.buckets (id, name, public)
values ('cover-images', 'cover-images', true)
on conflict (id) do nothing;

-- Drop any prior policies of the same name (idempotent re-runs)
drop policy if exists "Anyone can read cover-images"            on storage.objects;
drop policy if exists "Users upload covers under their own uid" on storage.objects;
drop policy if exists "Users delete their own covers"           on storage.objects;
drop policy if exists "Users update their own covers"           on storage.objects;

-- SELECT: anyone (the bucket is public, but explicit is better)
create policy "Anyone can read cover-images"
  on storage.objects for select
  using (bucket_id = 'cover-images');

-- INSERT: authenticated users into a folder named with their uid
create policy "Users upload covers under their own uid"
  on storage.objects for insert
  with check (
    bucket_id = 'cover-images'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- UPDATE: same scope (in case upsert ever needs to overwrite)
create policy "Users update their own covers"
  on storage.objects for update
  using (
    bucket_id = 'cover-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- DELETE: same scope
create policy "Users delete their own covers"
  on storage.objects for delete
  using (
    bucket_id = 'cover-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

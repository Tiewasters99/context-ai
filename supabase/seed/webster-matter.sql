-- Creates the Webster matterspace (and the "Legal" serverspace holding it)
-- for user equainton@gmail.com. Idempotent — safe to rerun; existing rows
-- are left alone and missing ones are filled in.
--
-- After this runs successfully you should see a raise-notice line at the
-- bottom of the Supabase SQL editor output showing the new serverspace_id
-- and matterspace_id.

do $$
declare
  v_user_id uuid;
  v_clientspace_id uuid;
  v_serverspace_id uuid;
  v_matterspace_id uuid;
begin
  -- Find the auth user by email
  select id into v_user_id
  from auth.users
  where email = 'equainton@gmail.com';

  if v_user_id is null then
    raise exception
      'No auth.users row for equainton@gmail.com. Sign into Contextspaces.ai once so the signup trigger creates your profile, then re-run this.';
  end if;

  -- Your clientspace was auto-created by the handle_new_user trigger on signup
  select id into v_clientspace_id
  from public.clientspaces
  where user_id = v_user_id;

  if v_clientspace_id is null then
    raise exception
      'No clientspace for user %. The signup trigger should have created one; check auth flow.', v_user_id;
  end if;

  -- Find or create the "Legal" serverspace
  select id into v_serverspace_id
  from public.serverspaces
  where clientspace_id = v_clientspace_id
    and name = 'Legal';

  if v_serverspace_id is null then
    insert into public.serverspaces (clientspace_id, name, description)
    values (v_clientspace_id, 'Legal', 'Legal matters')
    returning id into v_serverspace_id;
  end if;

  -- Owner membership (ensure it exists; harmless if already present)
  insert into public.serverspace_members (serverspace_id, user_id, role)
  values (v_serverspace_id, v_user_id, 'owner')
  on conflict (serverspace_id, user_id) do nothing;

  -- Find or create the Webster matterspace
  select id into v_matterspace_id
  from public.matterspaces
  where serverspace_id = v_serverspace_id
    and short_code = 'webster';

  if v_matterspace_id is null then
    insert into public.matterspaces
      (serverspace_id, name, description, short_code)
    values
      (v_serverspace_id,
       'Peloso v. Webster/Ortega',
       'AAA arbitration — hearing transcripts and briefs',
       'webster')
    returning id into v_matterspace_id;
  end if;

  raise notice 'serverspace_id: %, matterspace_id: %',
    v_serverspace_id, v_matterspace_id;
end $$;

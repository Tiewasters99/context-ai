-- Context.ai Migration 006: Auto-create owner membership on serverspace insert
--
-- Problem: when an authenticated user inserts a new serverspaces row, RLS
-- on serverspace_members requires the caller to already be owner/admin of
-- the serverspace to add themselves — a chicken-and-egg cycle that makes
-- self-service serverspace creation impossible from the client.
--
-- Fix: a SECURITY DEFINER trigger on serverspaces that, immediately after
-- insert, adds the creator (auth.uid()) as 'owner' in serverspace_members.
-- Running as the function owner (postgres) bypasses the RLS check without
-- exposing any general-purpose insert path.

create or replace function public.handle_new_serverspace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    insert into public.serverspace_members (serverspace_id, user_id, role)
    values (new.id, auth.uid(), 'owner')
    on conflict (serverspace_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_serverspace_created on public.serverspaces;

create trigger on_serverspace_created
  after insert on public.serverspaces
  for each row
  execute function public.handle_new_serverspace();

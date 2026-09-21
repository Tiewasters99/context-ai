-- Context.ai Migration 075: connections.kind admits 'onedrive' and 'dropbox'
--
-- WHY THIS IS NEEDED. Migration 026 created public.connections with an inline
-- `check (kind in ('gmail','google_calendar'))`, which Postgres named
-- connections_kind_check. Migration 029 replaced it with
-- ('gmail','google_calendar','microsoft_365','google_drive'). Neither list
-- contains 'onedrive' or 'dropbox', so the OAuth callback's upsert for either
-- new drive would be refused by the database with a constraint violation —
-- and the user would see "save failed" after approving at the provider, with
-- nothing to say why. (api/cloud-drives' callback names this case explicitly:
-- a kind-check violation redirects with error=migration_075_missing.)
--
-- 'microsoft_365' is kept even though nothing writes it. It has been in the
-- allowed list since 029; dropping a value a live row might hold is how a
-- migration turns a working account into a broken one.
--
-- WRITTEN AGAINST DRIFT. The live database is not the migrations folder (026's
-- own note, and 047's): 029 may or may not have been applied here, and the
-- constraint may carry either list or neither. So instead of dropping one
-- constraint by name, the DO block below drops EVERY check constraint on
-- public.connections whose definition mentions `kind` and then adds the
-- current one. That is idempotent — running this file twice leaves exactly one
-- kind check — and it converges from any of the three states above.
--
-- Apply order: after 073. Safe to run on a database that has never seen 029.

-- The base table, so this file also applies to a database where 026 was never
-- pasted (the class of drift the project has hit before). On a database that
-- has it, this is a no-op and the column list below is not consulted.
create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  status text not null default 'connected'
    check (status in ('connected', 'needs_attention')),
  connected_email text,
  scopes text,
  encrypted_refresh_token text not null,
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, kind)
);

create index if not exists idx_connections_user on public.connections(user_id);

alter table public.connections enable row level security;

drop policy if exists "View own connections" on public.connections;
create policy "View own connections"
  on public.connections for select
  using (user_id = auth.uid());

drop policy if exists "Delete own connections" on public.connections;
create policy "Delete own connections"
  on public.connections for delete
  using (user_id = auth.uid());

-- No INSERT / UPDATE policy, unchanged from 026: connections are written only
-- by the server-side OAuth callbacks via the service role.

do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'connections'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%kind%'
  loop
    execute format('alter table public.connections drop constraint %I', c.conname);
  end loop;
end
$$;

alter table public.connections
  add constraint connections_kind_check
  check (kind in (
    'gmail',
    'google_calendar',
    'google_drive',
    'microsoft_365',
    'onedrive',
    'dropbox'
  ));

notify pgrst, 'reload schema';

-- Context.ai Migration 026: connections — stored external integrations
--
-- Holds one row per (user, integration) for inbound OAuth integrations
-- (Gmail first, Google Calendar next). The durable credential — the
-- OAuth refresh token — is stored encrypted (AES-256-GCM, app-layer,
-- key in the CONNECTIONS_ENC_KEY env var; see lib/connections-crypto.mjs).
-- The plaintext token never touches the database.
--
-- Writes happen only in the server-side OAuth callback
-- (api/google-callback.mjs) using the service role, which bypasses RLS.
-- Authenticated users may read and delete their own rows — nothing else.
-- That's why there is no INSERT or UPDATE policy.
--
-- Apply order: after 025.

create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('gmail', 'google_calendar')),
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

-- No INSERT / UPDATE policy by design: connections are written only by
-- the server-side OAuth callback via the service role.

notify pgrst, 'reload schema';

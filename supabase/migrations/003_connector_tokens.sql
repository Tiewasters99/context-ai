-- Context.ai Migration 003: Connector tokens
--
-- Long-lived opaque tokens used by external MCP clients (Claude Desktop,
-- Claude for Chrome, etc.) to authenticate against the hosted MCP server.
-- A single user may have multiple active tokens (e.g. one per device or
-- per client). Tokens are stored hashed (SHA-256, hex) so a database dump
-- does not compromise the live tokens.
--
-- The HTTP MCP handler resolves Authorization: Bearer <opaque_token> by:
--   1. sha256 hash the opaque token
--   2. look up connector_tokens where token_hash = hash, revoked_at is null
--   3. update last_used_at
--   4. load the associated user_id and run queries as that user (RLS
--      enforces matter scoping via the existing matterspaces / serverspaces
--      / serverspace_members policies)

create table public.connector_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  token_hash text not null unique,     -- SHA-256 hex of the opaque token
  token_prefix text not null,          -- first 12 chars of the opaque token for display
                                       -- (e.g. "csp_a1b2c3d4...") — never the full token
  name text,                           -- user-assigned label, e.g. "Claude Desktop on laptop"
  scopes text[] not null default array['read']::text[],
                                       -- future: 'write' etc.; for now read-only
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz               -- null = never expires
);

create index idx_connector_tokens_user on public.connector_tokens(user_id);
create index idx_connector_tokens_active on public.connector_tokens(token_hash)
  where revoked_at is null;

alter table public.connector_tokens enable row level security;

-- Users can see and revoke their own tokens. Nobody can read token_hash
-- back out through the API; the hash column exists for the server-side
-- auth handler which authenticates via service_role.
create policy "Users can view their own connector tokens"
  on public.connector_tokens for select
  using (user_id = auth.uid());

create policy "Users can insert their own connector tokens"
  on public.connector_tokens for insert
  with check (user_id = auth.uid());

create policy "Users can update their own connector tokens"
  on public.connector_tokens for update
  using (user_id = auth.uid());

create policy "Users can delete their own connector tokens"
  on public.connector_tokens for delete
  using (user_id = auth.uid());

-- 118_agent_provider_meta.sql
--
-- Adds 'meta' (Meta's Muse, Instinct, Llama-based bots) to the agent
-- providers. agent_provider is a label only (085): what an agent can see is
-- its matter_scope / scope_all, never its provider. So this changes the badge
-- on Connections › Agents and nothing about access.
--
-- Two places in the database hold the list:
--   1. connector_tokens_agent_provider_chk (085) — the rule on the column.
--   2. oauth_grant_approve (088) — the consent write, which turns any
--      provider it does not know into 'other'.
--
-- The function is patched in place from its live definition rather than
-- re-created from 088's text, so nothing that differs between prod and the
-- migrations folder is overwritten. If the provider list is not found exactly
-- once the migration stops and changes nothing. CREATE OR REPLACE with the same
-- signature keeps the owner and the service_role-only grants.
--
-- Rollback: put the two lists back without 'meta' (first move any 'meta' rows
-- to 'other').

-- 1. The column rule -----------------------------------------------------------
alter table public.connector_tokens
  drop constraint if exists connector_tokens_agent_provider_chk;

alter table public.connector_tokens
  add constraint connector_tokens_agent_provider_chk
  check (agent_provider is null
         or agent_provider in ('grok', 'chatgpt', 'claude', 'gemini', 'meta', 'other'));

-- 2. The consent write -------------------------------------------------------
do $$
declare
  f    regprocedure := 'public.oauth_grant_approve(uuid, text, text, text[], text, text, text, uuid[], text, boolean)'::regprocedure;
  old  text := $q$in ('grok', 'chatgpt', 'claude', 'gemini', 'other')$q$;
  new  text := $q$in ('grok', 'chatgpt', 'claude', 'gemini', 'meta', 'other')$q$;
  def  text := pg_get_functiondef(f);
  hits int  := (length(def) - length(replace(def, old, ''))) / length(old);
begin
  if position(new in def) > 0 then
    raise notice 'migration 118: oauth_grant_approve already lists meta — nothing to do';
    return;
  end if;
  if hits <> 1 then
    raise exception 'migration 118: expected the provider list once in oauth_grant_approve, found % — not patched', hits;
  end if;
  execute replace(def, old, new);
end $$;

notify pgrst, 'reload schema';

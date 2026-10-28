-- 125_sealed_no_agent_work.sql — no agent work inside a sealed matter.
--
-- WHY
-- Eden (2026-10-28): agents, assistants and the Orchestrator do not work in a
-- sealed matter (SecureSpace, effective tier B or C); to do that work, unseal
-- the matter. Inside a sealed matter only a model approved on Amazon Bedrock
-- works (the in-app Orchestrator's sealed pen). Two holes in the database:
--
--   1. agent_tasks: the insert policy (089) checked matter access and the
--      recipient, not the seal. The screens refuse a sealed matter and
--      /api/mcp hides such a task from every recipient, but a direct API call
--      at 2FA could still create one. Now the database refuses it.
--   2. tm_clearances: the Trademark Agent should not run in a sealed matter.
--      api/trademark.mjs and the connector refuse its actions there; the
--      database now refuses to open a clearance in one.
--
-- WHAT
--   * agent_tasks_insert: 089's check, word for word, plus "not sealed".
--   * tm_clearances: a BEFORE INSERT trigger that refuses a sealed matter.
-- Both use stepup_internal.effective_tier_is_sealed (094), the definer walk
-- policies use (096): the seal is inherited from any ancestor, including one
-- the caller cannot see. NULL is treated as sealed (fail closed).
-- No row changes: on 2026-10-28 no task and no clearance is in a sealed matter.
-- Re-runnable.
--
-- NOT CHANGED
--   * A matter sealed AFTER a task or clearance exists: /api/mcp already hides
--     the task, and the trademark actions are refused on the server.
--
-- ROLLBACK
--   drop trigger if exists tm_clearances_not_sealed on public.tm_clearances;
--   drop function if exists public._tm_clearances_not_sealed();
--   and re-create 089 §6's agent_tasks_insert policy.

do $$
begin
  if to_regclass('public.agent_tasks') is null then
    raise exception 'needs migration 085 (agent tasks) first';
  end if;
  if to_regclass('public.tm_clearances') is null then
    raise exception 'needs migration 121 (Trademark Clearance) first';
  end if;
  if to_regprocedure('stepup_internal.effective_tier_is_sealed(uuid)') is null then
    raise exception 'needs migration 094 (step-up and the seal) first';
  end if;
end $$;

drop policy if exists agent_tasks_insert on public.agent_tasks;
create policy agent_tasks_insert on public.agent_tasks
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public._agent_task_matter_access(matterspace_id)
    and public._agent_task_recipient_is_mine(assigned_token_id, assigned_grant_id)
    and not coalesce(stepup_internal.effective_tier_is_sealed(matterspace_id), true)
  );

create or replace function public._tm_clearances_not_sealed()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if coalesce(stepup_internal.effective_tier_is_sealed(new.matterspace_id), true) then
    raise exception 'Trademark Clearance does not run in a sealed matter (SecureSpace). Unseal the matter to use it.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

revoke all on function public._tm_clearances_not_sealed() from public, anon;

drop trigger if exists tm_clearances_not_sealed on public.tm_clearances;
create trigger tm_clearances_not_sealed
  before insert on public.tm_clearances
  for each row execute function public._tm_clearances_not_sealed();

notify pgrst, 'reload schema';

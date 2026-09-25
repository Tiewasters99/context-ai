-- Contextspaces Migration 092: take EXECUTE on the conversation functions away
-- from `anon` explicitly (2026-09-25, applied the same day as 091).
--
-- 091 revoked these functions from PUBLIC and granted them to authenticated
-- and service_role only. Supabase's default privileges on the public schema
-- also grant every new function to `anon` directly, and a revoke FROM PUBLIC
-- does not remove that direct grant. The functions were never usable by a
-- signed-out caller (each hands its work to schema conversations_internal,
-- which anon cannot use: a live call returned 42501 "permission denied for
-- schema conversations_internal"), but safety should not rest on that second
-- layer alone. Tightening only; safe to run twice.
--
-- Result on production: the 7 functions that RETURN conversation data are no
-- longer executable by anon. The 8 `_mconv_*` policy helpers keep EXECUTE for
-- PUBLIC on purpose, as every RLS helper in this schema does: the policies on
-- matter_comments etc. call them for whoever queries the table, they are
-- SECURITY INVOKER, and they answer false when auth.uid() is null.
--
-- Rollback: none needed (re-granting to anon would only widen access).

do $$
declare f text;
begin
  for f in
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like '%conversation%' or p.proname like '\_mconv\_%')
  loop
    execute format('revoke execute on function %s from anon', f);
  end loop;
end $$;

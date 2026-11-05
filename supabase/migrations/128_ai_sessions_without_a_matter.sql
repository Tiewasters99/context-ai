-- 128 — An Orchestrator conversation with no matter is recorded too.
--
-- Eden, 2026-11-05: three Orchestrator turns on the Fleming matter were asked
-- from a panel that was not bound to a matter. The server recorded nothing,
-- because ai_sessions could only be opened inside a matter, and the
-- conversation died with the browser tab. "Every conversation needs to be
-- saved in the sidebar, just as with Claude."
--
-- 064 already made ai_sessions.matterspace_id nullable, and 064/098's
-- _ledger_visible already shows a row to its own owner whatever its matter
-- (`p_actor_user = auth.uid()` returns true before any matter check). The
-- one thing that still refuses a matter-less session is 051's INSERT policy,
-- whose EXISTS over matterspaces is false on a null matterspace_id. This
-- migration widens that policy by exactly that case:
--
--   * a session WITH a matter: unchanged — the owner must be able to see
--     the matter (_mtspc_select_check);
--   * a session WITHOUT a matter: the owner is the caller, and the tier is
--     'A'. There is no seal without a matter, so a matter-less row can never
--     claim a sealed tier.
--
-- Nothing else moves. ai_messages' insert policy already keys on the
-- session's owner only, so messages append to a matter-less session as they
-- do to any other; 072's immutability trigger and ai_session_touch are
-- indifferent to the matter. Visibility of a matter-less row: its owner, and
-- nobody else (no matter, no serverspace → _ledger_visible returns false for
-- everyone but the owner).

drop policy if exists "Users create sessions in matters they can see" on public.ai_sessions;
create policy "Users create sessions in matters they can see"
on public.ai_sessions for insert
with check (
  owner_id = auth.uid()
  and (
    (
      matterspace_id is not null
      and exists (
        select 1 from public.matterspaces m
        where m.id = matterspace_id
          and public._mtspc_select_check(m.id, m.serverspace_id, m.parent_matterspace_id)
      )
    )
    or (
      matterspace_id is null
      and serverspace_id is null
      and tier = 'A'
    )
  )
);

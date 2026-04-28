-- Context.ai Migration 008: nested matterspaces (sub-matters)
--
-- Adds a self-referential parent_matterspace_id so a matter can hold child
-- matters (e.g. Creative > TikTok > Africa | Italy | Mirrors | Doors).
-- Top-level matters keep parent_matterspace_id null and remain anchored
-- to their serverspace via serverspace_id; children inherit the same
-- serverspace_id. We deliberately keep serverspace_id NOT NULL on every
-- row so RLS (migration 005, helper-based) keeps working unchanged —
-- access still flows through serverspace membership, no recursive lookup.
--
-- on delete cascade: deleting a parent matter deletes its descendants
-- (and via existing FKs, their documents and passages). Matches the
-- principle that the matter tree is a single owned subtree.

alter table public.matterspaces
  add column if not exists parent_matterspace_id uuid
    references public.matterspaces(id) on delete cascade;

create index if not exists idx_matterspaces_parent
  on public.matterspaces(parent_matterspace_id)
  where parent_matterspace_id is not null;

-- A child matter must live in the same serverspace as its parent.
-- Without this, descendant access could diverge from parent access and
-- the RLS model (rooted at serverspace_id) would no longer reflect the
-- intended access semantics.
create or replace function public.matterspaces_check_parent_serverspace()
returns trigger
language plpgsql
as $$
declare
  parent_serverspace uuid;
begin
  if new.parent_matterspace_id is null then
    return new;
  end if;
  select serverspace_id into parent_serverspace
    from public.matterspaces
    where id = new.parent_matterspace_id;
  if parent_serverspace is null then
    raise exception 'parent matterspace % not found', new.parent_matterspace_id;
  end if;
  if parent_serverspace <> new.serverspace_id then
    raise exception
      'child matterspace serverspace_id (%) must equal parent serverspace_id (%)',
      new.serverspace_id, parent_serverspace;
  end if;
  return new;
end;
$$;

drop trigger if exists matterspaces_parent_serverspace_check on public.matterspaces;
create trigger matterspaces_parent_serverspace_check
  before insert or update of parent_matterspace_id, serverspace_id
  on public.matterspaces
  for each row execute function public.matterspaces_check_parent_serverspace();

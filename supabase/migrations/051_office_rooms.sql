-- Context.ai Migration 051: The Office — room assignment
--
-- Rooms are themed by practice function — a filing system, not a stage set
-- (2026-08-17). A section can be assigned to one room of the walkable
-- office; the front end then shows that section on the room's shelf
-- hotspot. '' = unassigned: the section appears in the general Library,
-- exactly as before this migration.
--
-- The value is a room slug ('reception', 'boardroom-b', 'salon', ...). No
-- CHECK constraint by design: the room roster lives with the front end and
-- is still being whittled; a constraint here would turn every roster change
-- into a migration. The admin UI (src/lib/office-rooms.ts) offers the
-- current roster.

alter table public.office_sections
  add column if not exists room text not null default '';

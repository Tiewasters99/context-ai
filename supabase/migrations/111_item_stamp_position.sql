-- 111_item_stamp_position.sql
--
-- Discovery: move one document's Bates stamp (Eden, 2026-10-11).
--
-- A production stamps every page in one position (productions.bates_position,
-- 030). Some documents put their own text in that corner — a footer, a form
-- number, a signature block — and a uniform lower right buries the Bates
-- number. Adobe lets the reviewer move it per document; so does this:
--
--   production_items.stamp_position  null  = the production's position
--                                    'upper_left' | 'upper_center' |
--                                    'upper_right' | 'lower_left' |
--                                    'lower_center' | 'lower_right'
--
-- Set from the Review Room while the production is in review. The existing
-- lock (030's production_items_lock_guard) already refuses any change once
-- the production is stamped, so a stamped document's recorded position is the
-- one burned on its pages. The worker falls back to the production's position
-- for null or any value it does not know (worker/discovery-worker.mjs
-- stampPositionOf). The endorsement (CONFIDENTIAL, ...) follows the Bates
-- number to the opposite edge, as it always has (lib/discovery/bates-stamp.mjs).
--
-- Idempotent: safe to paste twice. Additive only: no existing row changes.
-- Needs 030. Re-pasting an older migration does not undo it.
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

alter table public.production_items
  add column if not exists stamp_position text;

alter table public.production_items drop constraint if exists production_items_stamp_position_known;
alter table public.production_items add constraint production_items_stamp_position_known
  check (stamp_position is null or stamp_position in (
    'upper_left', 'upper_center', 'upper_right', 'lower_left', 'lower_center', 'lower_right'
  ));

comment on column public.production_items.stamp_position is
  'Where this document''s Bates number is stamped, when it differs from productions.bates_position; null = the production''s.';

notify pgrst, 'reload schema';

-- Moot Bench: two prep modes.
--
-- 'bench'     — the hot bench: one question at a time, adversarial.
-- 'colleague' — argument prep with a brilliant colleague who knows the
--               record cold: enumerate the motions, lay out each side's
--               arguments, then work through them until counsel has
--               internalized the material.

alter table public.argument_prep_sessions
  add column if not exists mode text not null default 'bench'
  check (mode in ('bench', 'colleague'));

-- Contextspaces Migration 014: structured fields for the case analyzer's
-- value-add pass. The analyze-case workflow produces (per proposition):
--
--   supporting_quote          — the verbatim passage in the opinion that
--                               supports the cited proposition; null when
--                               the citation is oblique.
--   supporting_quote_location — page or section reference for the quote.
--   oblique                   — true when no quotable passage directly
--                               supports the proposition; the cite is
--                               doing analogical/reasoning work.
--   oblique_explanation       — why the proposition is supported by the
--                               opinion's reasoning rather than its words.
--
-- These were previously stored as free-form editorial_notes but they're
-- structured enough to deserve their own columns: queryability ("find my
-- obliquely-cited propositions"), report rendering, and uniformity.
--
-- Idempotent — safe to re-run.

alter table public.authority_propositions
  add column if not exists supporting_quote text,
  add column if not exists supporting_quote_location text,
  add column if not exists oblique boolean default false,
  add column if not exists oblique_explanation text;

create index if not exists idx_propositions_oblique
  on public.authority_propositions (oblique)
  where oblique = true;

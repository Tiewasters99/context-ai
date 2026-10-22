-- db/tm-register/schema.sql — Equazia's copy of the USPTO federal trademark
-- register (the Trademark Agent's register copy).
--
-- A SEPARATE DATABASE. Not Equazia's production database and not part of
-- supabase/migrations: nothing here is applied to Supabase by this PR. Where
-- it is hosted is Eden's decision after phase 0 (docs/specs/TRADEMARK-
-- CLEARANCE-2026-10-18.md §11). Built and tested locally on PGlite
-- (Postgres 18 compiled to WASM) with the pg_trgm and fuzzystrmatch
-- extensions; it is plain Postgres and runs the same on a hosted Postgres.
--
-- Public data only (USPTO bulk XML, public domain per data.gov's catalog
-- entry): no client data, no matter data, no user data ever enters this
-- database. The clearance's runs are recorded in Equazia's own database.
--
-- Re-runnable (every statement is IF NOT EXISTS / OR REPLACE).
--
-- Tables
--   register_records  one row per serial number (upsert by serial)
--   register_files    one row per loaded file: name, sha256, version, counts;
--                     a file already loaded with the same hash is skipped
--   register_meta     key/value: as_of (the copy's as-of date), stale_after_days
--   register_gate     the recall-gate runs (append-only): test-set hash, as-of,
--                     marks, misses, passed

create extension if not exists pg_trgm;
create extension if not exists fuzzystrmatch;

create table if not exists register_records (
  serial              text primary key check (serial ~ '^[0-9]{8}$'),
  registration_number text,
  mark                text,                 -- mark-identification, as filed
  mark_norm           text not null default '',  -- normalized words (lib/trademark/register/normalize.mjs)
  mark_joined         text not null default '',  -- normalized, run together
  pseudo_marks        text[] not null default '{}',
  cm_text             text not null default '',  -- every CM: variant: ' v1 | v2 | … '
  dm_codes            text[] not null default '{}', -- Double Metaphone (primary + alternate) of the joined mark and each word
  owner               text,                 -- the latest owner of record (highest party type)
  owner_text          text not null default '',  -- every owner name, normalized: ' n1 | n2 '
  owners              jsonb not null default '[]'::jsonb,
  attorney_name       text,
  status_code         text,
  status_date         date,
  live                boolean not null,
  filing_date         date,
  registration_date   date,
  abandonment_date    date,
  cancellation_date   date,
  mark_drawing_code   text,
  int_classes         text[] not null default '{}', -- '009', '042', 'A', 'B', '200'
  us_classes          text[] not null default '{}',
  goods               jsonb not null default '[]'::jsonb, -- [{class, qualifier, text}]
  gs_text             text not null default '',  -- all goods text, normalized words, for GS:
  design_codes        text[] not null default '{}',
  translations        text[] not null default '{}',
  transaction_date    date,
  source_file         text not null,
  source_version      text,
  as_of               date not null,         -- the as-of date of the file this row came from
  loaded_at           timestamptz not null default now()
);

-- Trigram indexes: the CM: regular expressions (exact words, *x*, x*, *x, x?y)
-- and the closeness ranking.
create index if not exists register_records_cm_trgm on register_records using gin (cm_text gin_trgm_ops);
create index if not exists register_records_joined_trgm on register_records using gin (mark_joined gin_trgm_ops);
create index if not exists register_records_owner_trgm on register_records using gin (owner_text gin_trgm_ops);
-- Prefix and suffix stems on the run-together mark (equa*, *azia).
create index if not exists register_records_joined_prefix on register_records (mark_joined text_pattern_ops);
create index if not exists register_records_joined_suffix on register_records (reverse(mark_joined) text_pattern_ops);
-- Sound-alike (Double Metaphone) and classes.
create index if not exists register_records_dm on register_records using gin (dm_codes);
create index if not exists register_records_classes on register_records using gin (int_classes);
create index if not exists register_records_live on register_records (live);
-- GS: (goods text) is searchable but is the slowest field; trigram on it is
-- the largest index, so it is created by the loader only with --gs-index.

create table if not exists register_files (
  file_name     text primary key,
  sha256        text not null,
  kind          text not null check (kind in ('daily', 'backfile', 'fixture')),
  file_as_of    date not null,
  version_no    text,
  version_date  text,
  data_available boolean not null default true,
  records       int not null default 0,
  inserted      int not null default 0,
  updated       int not null default 0,
  loaded_at     timestamptz not null default now(),
  parser        text not null
);

create table if not exists register_meta (
  key    text primary key,
  value  text not null,
  updated_at timestamptz not null default now()
);

insert into register_meta (key, value) values ('stale_after_days', '3') on conflict (key) do nothing;

create table if not exists register_gate (
  id              bigserial primary key,
  run_at          timestamptz not null default now(),
  test_set_sha256 text not null,
  test_set_marks  int not null,
  min_marks       int not null,
  engine_version  text not null,
  as_of           date,
  conflicts       int not null,
  misses          int not null,
  passed          boolean not null,
  report          jsonb not null default '{}'::jsonb
);

-- The gate is append-only: a record of every run, passed or not.
create or replace function register_gate_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'register_gate is append-only';
end $$;
drop trigger if exists register_gate_no_update on register_gate;
create trigger register_gate_no_update before update or delete on register_gate
  for each row execute function register_gate_append_only();

-- Double Metaphone codes of a mark: the run-together mark and each word,
-- primary and alternate, deduplicated (fuzzystrmatch). Used for the
-- sound-alike closeness of a hit; computed by the loader on every upsert.
create or replace function register_dm(p_norm text, p_joined text)
returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct c order by c) filter (where c is not null and c <> ''), '{}')
    from (
      select dmetaphone(p_joined) as c
      union all select dmetaphone_alt(p_joined)
      union all select dmetaphone(w) from unnest(string_to_array(p_norm, ' ')) w
      union all select dmetaphone_alt(w) from unnest(string_to_array(p_norm, ' ')) w
    ) s
$$;

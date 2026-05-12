-- Contextspaces Migration 015: cite_check_runs
--
-- One row per cite-check pass over a brief. The run loop itself executes
-- client-side (a 100-page brief is dozens of LLM calls — far past the
-- serverless timeout), so this table is how a run survives a page reload
-- and how the matter's Cite-Check tab lists prior runs.
--
-- A run can target an uploaded vault document (document_id set) or ad-hoc
-- pasted/dropped text (document_id null, source_label carries the name).
-- The per-cite findings and the rendered TOA are stored inline so the
-- results view and the .md downloads don't have to recompute anything.
--
-- Verified authorities discovered during a run are persisted to the
-- existing authorities / authority_propositions / matter_authorities
-- tables (migrations 013/014) — this table only holds the run record.
--
-- RLS: mirrors matter_authorities — any serverspace member can read and
-- create/update runs for matters in that serverspace; only owners/admins
-- can delete.

create table if not exists public.cite_check_runs (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  -- The uploaded brief this run analyzed, if it came from the vault.
  -- Null for ad-hoc paste/drop runs.
  document_id uuid references public.documents(id) on delete set null,
  -- Human label for the source — filename for uploads/drops, or a short
  -- description for pasted text. Always set, even when document_id is.
  source_label text not null,
  status text not null default 'running' check (status in (
    'running', 'complete', 'interrupted', 'error'
  )),
  error_message text,
  citations_total int not null default 0,
  -- Tally by flag: { "green": n, "lean_green": n, "lean_red": n, "red": n, "blue": n }
  counts jsonb not null default '{}'::jsonb,
  -- The per-cite findings array — one object per citation with citation,
  -- proposition, pin, signal, flag, status, confidence, source, note,
  -- draft snippet, authority_id (when persisted). Drives the results view.
  report jsonb not null default '[]'::jsonb,
  -- Rendered Table of Authorities markdown (same output the CLI writes),
  -- cached so the "Download TOA" button is a no-op.
  toa_markdown text,
  -- Rendered per-cite report markdown (the .cite-report.md the CLI writes),
  -- cached for the "Download report" button.
  report_markdown text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  completed_at timestamptz
);

create index if not exists idx_cite_check_runs_matter
  on public.cite_check_runs (matterspace_id, created_at desc);
create index if not exists idx_cite_check_runs_document
  on public.cite_check_runs (document_id);
create index if not exists idx_cite_check_runs_creator
  on public.cite_check_runs (created_by);

alter table public.cite_check_runs enable row level security;

drop policy if exists "See cite-check runs for own matters" on public.cite_check_runs;
drop policy if exists "Create cite-check runs with member access" on public.cite_check_runs;
drop policy if exists "Update cite-check runs with member access" on public.cite_check_runs;
drop policy if exists "Delete cite-check runs with admin access" on public.cite_check_runs;

create policy "See cite-check runs for own matters"
  on public.cite_check_runs for select
  using (
    matterspace_id in (
      select m.id from public.matterspaces m
      where public.is_serverspace_member(m.serverspace_id)
    )
  );

create policy "Create cite-check runs with member access"
  on public.cite_check_runs for insert
  with check (
    matterspace_id in (
      select m.id from public.matterspaces m
      where public.has_serverspace_role(m.serverspace_id, array['owner','admin','member'])
    )
  );

create policy "Update cite-check runs with member access"
  on public.cite_check_runs for update
  using (
    matterspace_id in (
      select m.id from public.matterspaces m
      where public.has_serverspace_role(m.serverspace_id, array['owner','admin','member'])
    )
  )
  with check (
    matterspace_id in (
      select m.id from public.matterspaces m
      where public.has_serverspace_role(m.serverspace_id, array['owner','admin','member'])
    )
  );

create policy "Delete cite-check runs with admin access"
  on public.cite_check_runs for delete
  using (
    matterspace_id in (
      select m.id from public.matterspaces m
      where public.has_serverspace_role(m.serverspace_id, array['owner','admin'])
    )
  );

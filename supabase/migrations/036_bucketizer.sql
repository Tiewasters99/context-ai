-- 036: Bucketizer — the living case-theory tree.
--
-- Two tables:
--
--   * bucketizer_nodes — the per-matter case-theory tree (claims → elements
--     to prove → themes → subissues). Self-referential parent_id; position
--     orders siblings. `description` doubles as the classification criteria
--     the AI reads when routing evidence to this bucket, so an attorney
--     editing a description immediately changes how future documents are
--     classified.
--
--   * bucketizer_classifications — one row per (document, node) assignment.
--     Rows are born status='proposed' by the AI and become 'confirmed' or
--     'rejected' only by an attorney decision (decided_by/decided_at). The
--     proposal's confidence, rationale, and supporting passage ids are kept
--     so every bucket assignment is inspectable and defensible.
--
-- RLS follows the migration-030/022 pattern: a single SECURITY INVOKER
-- wrapper per feature (_bktz_matter_access) delegating to
-- _mtspc_select_check — never call SECURITY DEFINER helpers directly from
-- policy expressions.
--
-- Apply order: after 035.

-- ============================================================================
-- Tables
-- ============================================================================

create table public.bucketizer_nodes (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  parent_id uuid references public.bucketizer_nodes(id) on delete cascade,
  kind text not null default 'subissue'
    check (kind in ('claim', 'element', 'theme', 'subissue')),
  label text not null,
  -- What belongs in this bucket, in the attorney's words. Read verbatim by
  -- the classifier as routing criteria.
  description text,
  position integer not null default 0,
  -- 'generated' nodes came from the pleadings pass; 'manual' were added or
  -- materially edited by the attorney. Purely informational.
  origin text not null default 'manual' check (origin in ('generated', 'manual')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bucketizer_nodes_matter_idx on public.bucketizer_nodes (matterspace_id);
create index bucketizer_nodes_parent_idx on public.bucketizer_nodes (parent_id);

create trigger bucketizer_nodes_updated_at
  before update on public.bucketizer_nodes
  for each row execute function public.update_updated_at();

create table public.bucketizer_classifications (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  node_id uuid not null references public.bucketizer_nodes(id) on delete cascade,
  status text not null default 'proposed'
    check (status in ('proposed', 'confirmed', 'rejected')),
  -- 0..1 from the proposing model; null for classifications an attorney
  -- created by hand.
  confidence real check (confidence >= 0 and confidence <= 1),
  rationale text,
  -- Supporting passages the model pointed to. Not a FK array (Postgres has
  -- none); ids resolve against public.passages.
  passage_ids uuid[] not null default '{}',
  model_id text,
  proposed_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  unique (document_id, node_id)
);

create index bucketizer_classifications_matter_idx
  on public.bucketizer_classifications (matterspace_id);
create index bucketizer_classifications_node_idx
  on public.bucketizer_classifications (node_id, status);
create index bucketizer_classifications_doc_idx
  on public.bucketizer_classifications (document_id);

-- ============================================================================
-- RLS — single SECURITY INVOKER access wrapper (migration-030/022 pattern)
-- ============================================================================

create or replace function public._bktz_matter_access(p_matter uuid)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
  v_ss uuid;
  v_parent uuid;
begin
  if v_uid is null then return false; end if;
  select serverspace_id, parent_matterspace_id
    into v_ss, v_parent
    from public.matterspaces where id = p_matter;
  if v_ss is null then return false; end if;
  return public._mtspc_select_check(p_matter, v_ss, v_parent);
end;
$$;

alter table public.bucketizer_nodes enable row level security;

create policy bucketizer_nodes_select on public.bucketizer_nodes
  for select to authenticated
  using (public._bktz_matter_access(matterspace_id));

create policy bucketizer_nodes_insert on public.bucketizer_nodes
  for insert to authenticated
  with check (public._bktz_matter_access(matterspace_id));

create policy bucketizer_nodes_update on public.bucketizer_nodes
  for update to authenticated
  using (public._bktz_matter_access(matterspace_id))
  with check (public._bktz_matter_access(matterspace_id));

create policy bucketizer_nodes_delete on public.bucketizer_nodes
  for delete to authenticated
  using (public._bktz_matter_access(matterspace_id));

alter table public.bucketizer_classifications enable row level security;

create policy bucketizer_classifications_select on public.bucketizer_classifications
  for select to authenticated
  using (public._bktz_matter_access(matterspace_id));

create policy bucketizer_classifications_insert on public.bucketizer_classifications
  for insert to authenticated
  with check (public._bktz_matter_access(matterspace_id));

create policy bucketizer_classifications_update on public.bucketizer_classifications
  for update to authenticated
  using (public._bktz_matter_access(matterspace_id))
  with check (public._bktz_matter_access(matterspace_id));

create policy bucketizer_classifications_delete on public.bucketizer_classifications
  for delete to authenticated
  using (public._bktz_matter_access(matterspace_id));

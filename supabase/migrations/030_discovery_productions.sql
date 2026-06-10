-- Context.ai Migration 030: Grapheon Discovery — document productions
--
-- End-to-end discovery module: intake of incoming productions from opposing
-- counsel, normalization of client files for outgoing production (display-PDF /
-- native / metadata triplet), review tagging, Bates stamping, privilege log,
-- packaging, and delivery tracking.
--
-- Design notes:
--   * Every table carries matterspace_id and is RLS-guarded through a single
--     SECURITY INVOKER wrapper (_disc_matter_access) per the migration-022
--     lesson: never call SECURITY DEFINER helpers directly from policy
--     expressions.
--   * bates_registry is the legally load-bearing table: one row per Bates
--     number ever assigned in a matter, unique on (matterspace_id,
--     bates_number). No UPDATE/DELETE policies exist on purpose — once
--     assigned, a number is immutable for authenticated users.
--   * processing_jobs is the queue for the discovery worker (heavy work:
--     ZIP intake, TIFF->PDF normalization, stamping, packaging). The worker
--     runs with the service role and claims jobs atomically.
--
-- Apply order: after 029.

-- ============================================================================
-- Enums
-- ============================================================================
do $$ begin
  create type production_direction as enum ('incoming', 'outgoing');
exception when duplicate_object then null; end $$;

do $$ begin
  create type production_status as enum
    ('intake', 'processing', 'review', 'stamped', 'packaged', 'delivered', 'received', 'error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type production_item_kind as enum ('display_pdf', 'native');
exception when duplicate_object then null; end $$;

do $$ begin
  create type discovery_job_status as enum ('queued', 'running', 'done', 'error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type privilege_basis as enum
    ('attorney_client', 'work_product', 'marital', 'physician_patient', 'pastor_parishioner', 'custom');
exception when duplicate_object then null; end $$;

-- ============================================================================
-- productions — one row per production volume, incoming or outgoing
-- ============================================================================
create table if not exists public.productions (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  direction production_direction not null,
  name text not null,
  producing_party text,
  receiving_party text,
  production_date date,
  status production_status not null default 'intake',
  -- Bates configuration (set at stamp time for outgoing; recorded as
  -- observed for incoming)
  bates_prefix text,
  bates_pad int not null default 7,
  bates_start bigint,
  bates_end bigint,
  -- which corner the stamp goes in: lower_right | lower_center | lower_left |
  -- upper_right | upper_center | upper_left
  bates_position text not null default 'lower_right',
  -- discovery requests this production responds to (e.g. "RFP Nos. 1-24")
  request_refs text,
  notes text,
  -- set when packaged
  package_storage_path text,
  package_sha256 text,
  locked_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_productions_matter
  on public.productions (matterspace_id, created_at desc);

-- ============================================================================
-- production_items — one row per document in a production.
-- The image/native/metadata triplet:
--   display_storage_path  -> the click-through display PDF (when renderable)
--   native_storage_path   -> the original/native file
--   source_metadata       -> extracted + load-file metadata
-- document_id links to the documents table once the item has been ingested
-- into the matter's searchable corpus.
-- ============================================================================
create table if not exists public.production_items (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  sort_order int not null default 0,
  original_filename text not null,
  -- path of the file inside the produced ZIP / source folder
  original_path text,
  sha256 text,
  file_size_bytes bigint,
  kind production_item_kind not null default 'display_pdf',
  display_storage_path text,
  native_storage_path text,
  page_count int,
  -- assigned at stamp time (outgoing) or parsed from load file (incoming)
  bates_first text,
  bates_last text,
  -- doc date / author / recipients / email headers / office props / DAT fields
  source_metadata jsonb not null default '{}',
  status text not null default 'pending', -- pending | ready | error
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_production_items_production
  on public.production_items (production_id, sort_order);
create index if not exists idx_production_items_matter
  on public.production_items (matterspace_id);
create index if not exists idx_production_items_sha
  on public.production_items (matterspace_id, sha256);

-- ============================================================================
-- document_tag_defs + document_tags — review tagging.
-- is_endorsement = true means the tag burns onto produced pages
-- (PRIVILEGED, CONFIDENTIAL); false means internal annotation only
-- (Hot Doc, Non-Responsive, custom work-product notes).
-- Presets (Privileged, Hot Doc, Confidential, Non-Responsive) are seeded
-- app-side per matter on first use, with is_preset = true.
-- ============================================================================
create table if not exists public.document_tag_defs (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  name text not null,
  color text not null default '#b58900',
  is_endorsement boolean not null default false,
  endorsement_text text,
  is_preset boolean not null default false,
  -- preset behavior keys the app recognizes: 'privileged' excludes from
  -- production + drafts a privilege log entry; 'non_responsive' excludes.
  behavior text, -- privileged | non_responsive | null
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (matterspace_id, name)
);

create table if not exists public.document_tags (
  id uuid primary key default gen_random_uuid(),
  tag_def_id uuid not null references public.document_tag_defs(id) on delete cascade,
  production_item_id uuid not null references public.production_items(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (tag_def_id, production_item_id)
);

create index if not exists idx_document_tags_item
  on public.document_tags (production_item_id);

-- ============================================================================
-- bates_registry — one row per Bates number ever assigned in a matter.
-- The unique constraint makes reuse a database error, not a malpractice
-- problem. Supplemental productions continue from the matter high-water mark.
-- ============================================================================
create table if not exists public.bates_registry (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  bates_number text not null,
  bates_seq bigint not null, -- numeric part, for fast max() queries
  production_id uuid not null references public.productions(id) on delete restrict,
  production_item_id uuid not null references public.production_items(id) on delete restrict,
  page_number int not null,
  created_at timestamptz not null default now(),
  unique (matterspace_id, bates_number)
);

create index if not exists idx_bates_registry_matter_seq
  on public.bates_registry (matterspace_id, bates_seq desc);

-- ============================================================================
-- privilege_log_entries — auto-drafted when an item is tagged Privileged
-- in an outgoing production; finished by the reviewer.
-- Fields per Eden 2026-06-10: author, addressee, cc's, subject matter,
-- reason for withholding (preset bases + custom).
-- ============================================================================
create table if not exists public.privilege_log_entries (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  production_id uuid not null references public.productions(id) on delete cascade,
  production_item_id uuid not null references public.production_items(id) on delete cascade,
  doc_date date,
  author text,
  addressee text,
  cc text,
  subject_matter text,
  basis privilege_basis not null default 'attorney_client',
  basis_custom text, -- used when basis = 'custom'
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (production_item_id)
);

-- ============================================================================
-- deliveries — service-of-production record: who got what, when, how,
-- and the sha256 of exactly what they got.
-- ============================================================================
create table if not exists public.deliveries (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  production_id uuid not null references public.productions(id) on delete cascade,
  recipient_name text not null,
  recipient_email text,
  method text not null default 'download', -- download | email_link
  package_storage_path text,
  package_sha256 text,
  bates_range text,
  sent_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);

-- ============================================================================
-- processing_jobs — queue for the discovery worker.
-- job_type: intake_zip | intake_folder | normalize_item | stamp_production |
--           package_production
-- ============================================================================
create table if not exists public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  production_id uuid references public.productions(id) on delete cascade,
  job_type text not null,
  payload jsonb not null default '{}',
  status discovery_job_status not null default 'queued',
  progress int not null default 0,
  progress_note text,
  claimed_by text,
  claimed_at timestamptz,
  finished_at timestamptz,
  error text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_processing_jobs_status
  on public.processing_jobs (status, created_at);
create index if not exists idx_processing_jobs_production
  on public.processing_jobs (production_id, created_at desc);

-- Atomic job claim for the worker (service role; SECURITY DEFINER is fine
-- here because the worker is not subject to RLS and this is not called from
-- a policy expression).
create or replace function public.claim_discovery_job(p_worker text)
returns setof public.processing_jobs
language sql
security definer
set search_path = public
as $$
  update public.processing_jobs
  set status = 'running', claimed_by = p_worker, claimed_at = now()
  where id = (
    select id from public.processing_jobs
    where status = 'queued'
    order by created_at
    limit 1
    for update skip locked
  )
  returning *;
$$;

revoke execute on function public.claim_discovery_job(text) from public, anon, authenticated;
grant execute on function public.claim_discovery_job(text) to service_role;

-- ============================================================================
-- RLS — single SECURITY INVOKER access wrapper (migration-022 pattern),
-- delegating to _mtspc_select_check after resolving the matter row.
-- ============================================================================
create or replace function public._disc_matter_access(p_matter uuid)
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
end $$;

grant execute on function public._disc_matter_access(uuid)
  to authenticated, service_role;

alter table public.productions enable row level security;
alter table public.production_items enable row level security;
alter table public.document_tag_defs enable row level security;
alter table public.document_tags enable row level security;
alter table public.bates_registry enable row level security;
alter table public.privilege_log_entries enable row level security;
alter table public.deliveries enable row level security;
alter table public.processing_jobs enable row level security;

-- productions: full CRUD for matter members
create policy "Matter members manage productions" on public.productions
  for all
  using (public._disc_matter_access(matterspace_id))
  with check (public._disc_matter_access(matterspace_id));

create policy "Matter members manage production items" on public.production_items
  for all
  using (public._disc_matter_access(matterspace_id))
  with check (public._disc_matter_access(matterspace_id));

create policy "Matter members manage tag defs" on public.document_tag_defs
  for all
  using (public._disc_matter_access(matterspace_id))
  with check (public._disc_matter_access(matterspace_id));

create policy "Matter members manage document tags" on public.document_tags
  for all
  using (public._disc_matter_access(matterspace_id))
  with check (public._disc_matter_access(matterspace_id));

-- bates_registry: SELECT + INSERT only. No UPDATE/DELETE policies on purpose —
-- assigned Bates numbers are immutable for authenticated users.
create policy "Matter members view bates registry" on public.bates_registry
  for select using (public._disc_matter_access(matterspace_id));
create policy "Matter members insert bates registry" on public.bates_registry
  for insert with check (public._disc_matter_access(matterspace_id));

create policy "Matter members manage privilege log" on public.privilege_log_entries
  for all
  using (public._disc_matter_access(matterspace_id))
  with check (public._disc_matter_access(matterspace_id));

create policy "Matter members manage deliveries" on public.deliveries
  for all
  using (public._disc_matter_access(matterspace_id))
  with check (public._disc_matter_access(matterspace_id));

-- processing_jobs: members can enqueue and watch; only the worker
-- (service role, bypasses RLS) transitions status.
create policy "Matter members view jobs" on public.processing_jobs
  for select using (public._disc_matter_access(matterspace_id));
create policy "Matter members enqueue jobs" on public.processing_jobs
  for insert with check (public._disc_matter_access(matterspace_id));

-- ============================================================================
-- Lock enforcement: once a production is stamped/packaged/delivered, its
-- items cannot be added, removed, or reordered. Supplemental productions are
-- the vehicle for late additions.
-- ============================================================================
create or replace function public._production_lock_guard()
returns trigger
language plpgsql
security invoker
as $$
declare
  v_status production_status;
  v_prod uuid;
begin
  v_prod := coalesce(new.production_id, old.production_id);
  select status into v_status from public.productions where id = v_prod;
  if v_status in ('stamped', 'packaged', 'delivered') then
    raise exception 'Production is locked (status %); create a supplemental production instead', v_status;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists production_items_lock_guard on public.production_items;
create trigger production_items_lock_guard
  before insert or update or delete on public.production_items
  for each row execute function public._production_lock_guard();

-- ============================================================================
-- updated_at maintenance
-- ============================================================================
create or replace function public._disc_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists productions_touch on public.productions;
create trigger productions_touch before update on public.productions
  for each row execute function public._disc_touch_updated_at();

drop trigger if exists privlog_touch on public.privilege_log_entries;
create trigger privlog_touch before update on public.privilege_log_entries
  for each row execute function public._disc_touch_updated_at();

-- ============================================================================
-- Storage: discovery-files bucket
-- Path convention: {matterspace_id}/{production_id}/{item_id}/{filename}
--                  {matterspace_id}/{production_id}/package/{filename}
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('discovery-files', 'discovery-files', false)
on conflict (id) do nothing;

create policy "Members read discovery files in their matterspaces"
  on storage.objects for select
  using (
    bucket_id = 'discovery-files'
    and exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id::text = (storage.foldername(storage.objects.name))[1]
        and sm.user_id = auth.uid()
    )
  );

create policy "Members upload discovery files to their matterspaces"
  on storage.objects for insert
  with check (
    bucket_id = 'discovery-files'
    and exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id::text = (storage.foldername(storage.objects.name))[1]
        and sm.user_id = auth.uid()
        and sm.role in ('owner','admin','member')
    )
  );

create policy "Admins delete discovery files"
  on storage.objects for delete
  using (
    bucket_id = 'discovery-files'
    and exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id::text = (storage.foldername(storage.objects.name))[1]
        and sm.user_id = auth.uid()
        and sm.role in ('owner','admin')
    )
  );

notify pgrst, 'reload schema';

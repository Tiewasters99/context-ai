-- Context.ai Migration 002: Documents + Passages + Hybrid Retrieval
--
-- Adds the document ingestion and retrieval backend on top of the existing
-- matterspaces hierarchy. Documents belong to a matterspace; passages are
-- the atomic retrieval units carrying citation coordinates (page/line/witness)
-- plus both pgvector embeddings and tsvector full-text for hybrid search.

-- =============================================================================
-- Extensions
-- =============================================================================
create extension if not exists vector;
create extension if not exists pg_trgm;

-- =============================================================================
-- Matter short codes
-- Human-readable identifier for a matterspace so users (and the search SQL)
-- can refer to matters by name instead of UUID.
-- =============================================================================
alter table public.matterspaces
  add column if not exists short_code text;

create unique index if not exists idx_matterspaces_short_code
  on public.matterspaces(short_code)
  where short_code is not null;

-- =============================================================================
-- Documents
-- A single logical document: one deposition, one transcript volume, one brief,
-- one exhibit, one expert report, etc. Scoped to a matterspace.
-- =============================================================================
create table public.documents (
  id uuid primary key default uuid_generate_v4(),
  matterspace_id uuid references public.matterspaces(id) on delete cascade not null,

  title text not null,
  doc_type text not null check (doc_type in (
    'transcript', 'deposition', 'exhibit', 'brief',
    'expert_report', 'contract', 'correspondence', 'other'
  )),
  source_filename text,
  file_size_bytes bigint,
  page_count int,

  -- transcript / deposition specific
  witness_name text,
  deposition_date date,
  volume_number int,

  -- exhibit specific
  exhibit_number text,
  bates_prefix text,
  bates_start int,
  bates_end int,

  -- storage + processing state
  storage_path text,  -- key in the vault-documents bucket
  processing_status text not null default 'pending'
    check (processing_status in (
      'pending','extracting','chunking','embedding','ready','error'
    )),
  processing_error text,
  ingested_at timestamptz,

  metadata jsonb not null default '{}',

  created_by uuid references public.profiles(id) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_documents_matterspace on public.documents(matterspace_id);
create index idx_documents_type on public.documents(matterspace_id, doc_type);
create index idx_documents_witness on public.documents(witness_name)
  where witness_name is not null;
create index idx_documents_processing on public.documents(processing_status)
  where processing_status <> 'ready';

alter table public.documents enable row level security;

create policy "Members can view documents in their matterspaces"
  on public.documents for select using (
    exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id = documents.matterspace_id
        and sm.user_id = auth.uid()
    )
  );

create policy "Members can insert documents in their matterspaces"
  on public.documents for insert with check (
    created_by = auth.uid()
    and exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id = documents.matterspace_id
        and sm.user_id = auth.uid()
        and sm.role in ('owner','admin','member')
    )
  );

create policy "Members can update documents in their matterspaces"
  on public.documents for update using (
    exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id = documents.matterspace_id
        and sm.user_id = auth.uid()
        and sm.role in ('owner','admin','member')
    )
  );

create policy "Owners and admins can delete documents"
  on public.documents for delete using (
    exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id = documents.matterspace_id
        and sm.user_id = auth.uid()
        and sm.role in ('owner','admin')
    )
  );

create trigger update_documents_updated_at
  before update on public.documents
  for each row execute function public.update_updated_at();

-- =============================================================================
-- Passages
-- The atomic retrievable unit. One passage = one Q/A pair, one monologue
-- block, one exhibit reference, one section heading. Every passage carries
-- citation coordinates as typed columns (not JSON) so they can be filtered,
-- indexed, and returned on every retrieval call.
-- =============================================================================
create table public.passages (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid references public.documents(id) on delete cascade not null,
  matterspace_id uuid references public.matterspaces(id) on delete cascade not null,
  sequence_number int not null,

  -- citation coordinates — first-class, queryable, returned on every search
  page_start int,
  page_end int,
  line_start int,
  line_end int,

  -- transcript coordinates
  witness_name text,
  examination_type text check (examination_type in (
    'direct','cross','redirect','recross','voir_dire',
    'colloquy','opening','closing','statement'
  )),
  speaker text,

  -- content
  text text not null,
  text_length int generated always as (length(text)) stored,
  passage_type text not null default 'monologue' check (passage_type in (
    'qa_pair','monologue','colloquy','exhibit_reference',
    'section_heading','summary'
  )),

  -- retrieval
  -- embedding dimension 1024 matches Voyage voyage-3 / voyage-law-2.
  -- If switching providers with a different native dim, truncate or
  -- re-embed; do not change the column dim without re-embedding all rows.
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('english', text)) stored,

  -- hierarchical summary tree
  -- summary_level 0 = raw passage from the source document
  -- summary_level 1+ = model-generated summaries pointing at children
  parent_passage_id uuid references public.passages(id) on delete set null,
  summary_level int not null default 0 check (summary_level >= 0),

  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index idx_passages_matterspace_level
  on public.passages(matterspace_id, summary_level);
create index idx_passages_document_seq
  on public.passages(document_id, sequence_number);
create index idx_passages_witness
  on public.passages(matterspace_id, witness_name)
  where witness_name is not null;
create index idx_passages_parent
  on public.passages(parent_passage_id)
  where parent_passage_id is not null;
create index idx_passages_tsv on public.passages using gin(tsv);
create index idx_passages_embedding_hnsw
  on public.passages using hnsw (embedding vector_cosine_ops);

alter table public.passages enable row level security;

create policy "Members can view passages in their matterspaces"
  on public.passages for select using (
    exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id = passages.matterspace_id
        and sm.user_id = auth.uid()
    )
  );

create policy "Members can insert passages in their matterspaces"
  on public.passages for insert with check (
    exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id = passages.matterspace_id
        and sm.user_id = auth.uid()
        and sm.role in ('owner','admin','member')
    )
  );

create policy "Members can update passages in their matterspaces"
  on public.passages for update using (
    exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id = passages.matterspace_id
        and sm.user_id = auth.uid()
        and sm.role in ('owner','admin','member')
    )
  );

-- =============================================================================
-- Hybrid retrieval
-- One SQL function fuses full-text rank (tsvector) with vector cosine
-- similarity (pgvector) and applies metadata filters. Returned rows carry
-- citation coordinates so the caller can render verifiable cites.
--
-- Scoring: weighted sum of normalized components. text_rank from
-- ts_rank is roughly (0..1] but usually small for long docs; vector_score
-- is (1 - cosine_distance) in [-1, 1] but for normalized embeddings
-- effectively [0, 1]. The 0.4 / 0.6 split favors semantic similarity
-- while keeping exact-term matches visible. Revisit if one signal
-- dominates in practice.
-- =============================================================================
create or replace function public.search_passages(
  p_matterspace_id uuid,
  p_query_text text,
  p_query_embedding vector(1024),
  p_doc_types text[] default null,
  p_witness_names text[] default null,
  p_document_ids uuid[] default null,
  p_summary_level int default 0,
  p_limit int default 20
)
returns table (
  passage_id uuid,
  document_id uuid,
  document_title text,
  doc_type text,
  page_start int,
  page_end int,
  line_start int,
  line_end int,
  witness_name text,
  examination_type text,
  passage_type text,
  text text,
  hybrid_score real,
  text_rank real,
  vector_score real
)
language sql stable as $$
  with q as (
    select websearch_to_tsquery('english', coalesce(p_query_text, '')) as tsq
  ),
  candidates as (
    select
      p.id          as passage_id,
      p.document_id,
      d.title       as document_title,
      d.doc_type,
      p.page_start,
      p.page_end,
      p.line_start,
      p.line_end,
      p.witness_name,
      p.examination_type,
      p.passage_type,
      p.text,
      case
        when q.tsq is null then 0::real
        else ts_rank(p.tsv, q.tsq)
      end as text_rank,
      case
        when p_query_embedding is null or p.embedding is null then 0::real
        else (1 - (p.embedding <=> p_query_embedding))::real
      end as vector_score
    from public.passages p
    join public.documents d on d.id = p.document_id
    cross join q
    where p.matterspace_id = p_matterspace_id
      and p.summary_level  = p_summary_level
      and (p_doc_types     is null or d.doc_type      = any(p_doc_types))
      and (p_witness_names is null or p.witness_name  = any(p_witness_names))
      and (p_document_ids  is null or p.document_id   = any(p_document_ids))
      and (
        p.tsv @@ q.tsq
        or p_query_embedding is not null
      )
  )
  select
    passage_id,
    document_id,
    document_title,
    doc_type,
    page_start,
    page_end,
    line_start,
    line_end,
    witness_name,
    examination_type,
    passage_type,
    text,
    (0.4 * text_rank + 0.6 * vector_score)::real as hybrid_score,
    text_rank,
    vector_score
  from candidates
  order by hybrid_score desc
  limit p_limit;
$$;

-- =============================================================================
-- Supabase Storage: vault-documents bucket
-- Path convention: {matterspace_id}/{document_id}/{filename}
-- =============================================================================
insert into storage.buckets (id, name, public)
values ('vault-documents', 'vault-documents', false)
on conflict (id) do nothing;

create policy "Members can read vault-documents files in their matterspaces"
  on storage.objects for select
  using (
    bucket_id = 'vault-documents'
    and exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id::text = (storage.foldername(name))[1]
        and sm.user_id = auth.uid()
    )
  );

create policy "Members can upload vault-documents files to their matterspaces"
  on storage.objects for insert
  with check (
    bucket_id = 'vault-documents'
    and exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id::text = (storage.foldername(name))[1]
        and sm.user_id = auth.uid()
        and sm.role in ('owner','admin','member')
    )
  );

create policy "Admins can delete vault-documents files"
  on storage.objects for delete
  using (
    bucket_id = 'vault-documents'
    and exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id::text = (storage.foldername(name))[1]
        and sm.user_id = auth.uid()
        and sm.role in ('owner','admin')
    )
  );

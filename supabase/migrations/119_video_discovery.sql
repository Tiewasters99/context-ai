-- 119_video_discovery.sql — the Video Room: what a model saw in a stored recording,
-- what a lawyer asked it, and whether a person has read the answer.
--
-- A video in the Vault is a document like any other (documents + the
-- vault-documents bucket). What this migration adds is the layer a litigator
-- needs on top of the bytes: a structured account of the recording — who is on
-- screen, what happens when, where the camera could and could not see, how the
-- subject is positioned — and a log of every question put to the model about
-- it. Nothing here is a finding. The model reports what is visible and audible;
-- the lawyer draws the conclusions, and says so in the reviews table.
--
-- Three tables:
--
--   video_analyses       one row per analysis pass over one document. Written by
--                        the discovery worker (service role) as the job runs:
--                        status, progress, the event graph, and the provider's
--                        media handle while it lasts (Gemini keeps an uploaded
--                        file for 48 hours; media_expires_at says when the
--                        interrogation path must re-upload before asking).
--                        A member who can write the matter may INSERT the row
--                        that starts a pass (as themselves); nobody but the
--                        service role updates it.
--   video_interrogations append-only. One row per question asked in the Video
--                        Room: the question, the time window, the claims the
--                        asker put beside it, and the structured answer. This is
--                        the AI Use Record's raw material for the matter.
--   video_analysis_reviews append-only, 103's pattern. A person who has watched
--                        the footage against the analysis presses Reviewed (or
--                        Problem, with a word on what is wrong), with initials.
--                        The latest row is what the room shows beside the legend.
--
-- RLS: read = anyone who can see the document (RLS on documents decides, as 103);
-- writes by members are as themselves and only where can_write_matter (016) says
-- so. No authenticated update or delete anywhere here, on purpose.
--
-- Nothing in this migration touches an existing table.

create table if not exists public.video_analyses (
  id                 uuid primary key default gen_random_uuid(),
  document_id        uuid not null references public.documents(id) on delete cascade,
  matterspace_id     uuid not null references public.matterspaces(id) on delete cascade,
  status             text not null default 'queued'
                     check (status in ('queued', 'running', 'ready', 'error', 'held')),
  progress           integer not null default 0 check (progress between 0 and 100),
  progress_note      text,
  error              text,
  provider           text,                       -- 'google' today; the adapter's name, never a model's
  model              text,                       -- the model id that produced event_graph
  event_graph        jsonb,                      -- lib/video-discovery/schemas.mjs EVENT_GRAPH_SCHEMA
  duration_sec       numeric,
  windows            integer,                    -- how many passes the recording was analysed in
  media_provider_ref text,                       -- provider's handle for the uploaded media (Gemini: files/…)
  media_uri          text,
  media_expires_at   timestamptz,                -- after this the handle is gone; refresh before asking
  job_id             uuid,                       -- the processing_jobs row running this pass
  created_by         uuid not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_video_analyses_document on public.video_analyses (document_id, created_at desc);
create index if not exists idx_video_analyses_matter   on public.video_analyses (matterspace_id, created_at desc);
-- One pass in flight per document: a second Analyze while one runs is a no-op,
-- not a second upload of a gigabyte.
create unique index if not exists uq_video_analyses_inflight
  on public.video_analyses (document_id) where status in ('queued', 'running');

create table if not exists public.video_interrogations (
  id             uuid primary key default gen_random_uuid(),
  analysis_id    uuid references public.video_analyses(id) on delete set null,
  document_id    uuid not null references public.documents(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  user_id        uuid not null,
  question       text not null check (char_length(question) between 1 and 4000),
  start_sec      numeric,
  end_sec        numeric,
  claims         jsonb not null default '[]'::jsonb,
  provider       text,
  model          text,
  result         jsonb,                          -- lib/video-discovery/schemas.mjs INTERROGATION_SCHEMA
  outcome        text not null default 'ok' check (outcome in ('ok', 'provider_error', 'media_expired', 'refused')),
  ms             integer,
  created_at     timestamptz not null default now()
);

create index if not exists idx_video_interrogations_document on public.video_interrogations (document_id, created_at desc);

create table if not exists public.video_analysis_reviews (
  id           uuid primary key default gen_random_uuid(),
  analysis_id  uuid not null references public.video_analyses(id) on delete cascade,
  document_id  uuid not null references public.documents(id) on delete cascade,
  status       text not null check (status in ('reviewed', 'problem')),
  note         text not null default '' check (char_length(note) <= 1000),
  initials     text not null check (char_length(initials) between 1 and 6),
  user_id      uuid not null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_video_analysis_reviews_analysis on public.video_analysis_reviews (analysis_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.video_analyses        enable row level security;
alter table public.video_interrogations  enable row level security;
alter table public.video_analysis_reviews enable row level security;

drop policy if exists "Video analyses visible with their document" on public.video_analyses;
create policy "Video analyses visible with their document"
  on public.video_analyses for select
  using (exists (select 1 from public.documents d where d.id = video_analyses.document_id));

drop policy if exists "Matter writers start a video analysis as themselves" on public.video_analyses;
create policy "Matter writers start a video analysis as themselves"
  on public.video_analyses for insert
  with check (
    created_by = auth.uid()
    and status = 'queued'
    and exists (select 1 from public.documents d
                 where d.id = video_analyses.document_id
                   and d.matterspace_id = video_analyses.matterspace_id
                   and public.can_write_matter(d.matterspace_id)));

drop policy if exists "Video interrogations visible with their document" on public.video_interrogations;
create policy "Video interrogations visible with their document"
  on public.video_interrogations for select
  using (exists (select 1 from public.documents d where d.id = video_interrogations.document_id));

drop policy if exists "Matter members ask about a video as themselves" on public.video_interrogations;
create policy "Matter members ask about a video as themselves"
  on public.video_interrogations for insert
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.documents d
                 where d.id = video_interrogations.document_id
                   and d.matterspace_id = video_interrogations.matterspace_id));

drop policy if exists "Video reviews visible with their document" on public.video_analysis_reviews;
create policy "Video reviews visible with their document"
  on public.video_analysis_reviews for select
  using (exists (select 1 from public.documents d where d.id = video_analysis_reviews.document_id));

drop policy if exists "Matter writers review a video analysis as themselves" on public.video_analysis_reviews;
create policy "Matter writers review a video analysis as themselves"
  on public.video_analysis_reviews for insert
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.documents d
                 where d.id = video_analysis_reviews.document_id
                   and public.can_write_matter(d.matterspace_id))
    and exists (select 1 from public.video_analyses a
                 where a.id = video_analysis_reviews.analysis_id
                   and a.document_id = video_analysis_reviews.document_id));

grant select, insert on public.video_analyses         to authenticated;
grant select, insert on public.video_interrogations   to authenticated;
grant select, insert on public.video_analysis_reviews to authenticated;

comment on table public.video_analyses is
  'One analysis pass over a stored video: status, the structured event graph a multimodal model produced '
  '(actors, events, camera coverage, subject position, transcript), and the provider''s media handle while it lasts. '
  'Members start a pass as themselves; only the worker updates it. Not a finding — see video_analysis_reviews.';
comment on table public.video_interrogations is
  'Append-only log of every question put to the model about a video in the Video Room: question, time window, '
  'claims, structured answer, outcome. The AI Use Record''s raw material.';
comment on table public.video_analysis_reviews is
  'A person''s own reading of a video analysis against the footage: Reviewed or Problem, with initials and a note. '
  'Append-only; the latest row is what the room shows.';

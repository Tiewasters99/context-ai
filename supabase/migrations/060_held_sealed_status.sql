-- Contextspaces Migration 060: a HELD state, so the SecureSpace seal can stop
-- work without pretending it broke.
--
-- Why
-- ---------------------------------------------------------------------------
-- Phase A of the seal-the-pipes work (lib/seal-pipes.mjs) refuses to send a
-- sealed matter's content to an outside provider. Most of ingestion survives
-- that intact — extraction, chunking and Postgres's own tsvector are local, so
-- a sealed matter's text documents are still fully searchable. Two steps
-- cannot survive it, because there is no offline substitute in this stack:
--
--   * OCR of a scan (lib/ocr-gemini.mjs)
--   * transcription of a recording (lib/transcribe-gemini.mjs)
--
-- Those documents are stored and viewable but not readable, and the pipeline
-- needs somewhere honest to put them. The two existing options are both lies:
--
--   'ready' — the 2026-08-22 audit's exact failure. 99.3% of documents said
--             ready while 60.5% had any text behind them, and 5,782 TIFFs sat
--             green-lit and unsearchable for weeks. Never again by choice.
--
--   'error' — retried. 055/058's recovery sweep revives any document sitting
--             in pending/extracting/chunking/embedding, and a refusal that
--             gets retried is a refusal that gets retried forever: two
--             documents, 1,641 failed jobs each, twenty days.
--
-- 'held' is neither. It is terminal by construction:
--
--   * claim_discovery_job claims `where status = 'queued'` — a held job is
--     never handed to a worker.
--   * recover_stranded_documents (055, rewritten by 058) only looks at
--     documents in ('pending','extracting','chunking','embedding') — a held
--     document is not stranded, it is parked.
--
-- So this migration adds a value to each of the two status vocabularies and
-- changes no behavior on its own. Nothing in the existing queue moves.
--
-- Phase B (US-hosted zero-retention OCR / transcription / embeddings) releases
-- them deliberately, with one statement each:
--
--   update public.processing_jobs set status = 'queued'
--    where status = 'held';
--   update public.documents set processing_status = 'pending', processing_error = null
--    where processing_status = 'held';
--
-- Transaction note
-- ---------------------------------------------------------------------------
-- ALTER TYPE ... ADD VALUE may run inside a transaction block on PG 12+, but
-- the new label may NOT be *used* by a statement in that same transaction.
-- Nothing below uses it — no function is created or altered here, and the
-- CHECK constraint names it only as a string literal in a list, which is not a
-- use of the enum. This file is therefore safe to paste whole into the
-- Supabase SQL editor.

-- 1. The job queue's status vocabulary (enum, from 030).
alter type public.discovery_job_status add value if not exists 'held';

-- 2. The document's status vocabulary (a CHECK constraint, from 002).
--    Dropped and recreated by name rather than ALTERed: a CHECK constraint has
--    no in-place edit, and 002 named it implicitly, so find the real name
--    rather than guessing at documents_processing_status_check.
do $$
declare
  v_con text;
begin
  select con.conname into v_con
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'documents'
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) ilike '%processing_status%'
   limit 1;

  if v_con is not null then
    execute format('alter table public.documents drop constraint %I', v_con);
  end if;

  alter table public.documents
    add constraint documents_processing_status_check
    check (processing_status in (
      'pending','extracting','chunking','embedding','ready','error','held'
    ));
end $$;

-- 3. Finding held work later is a one-column question, but it is asked against
--    a table that is mostly 'ready' — so index the exception, not the rule.
create index if not exists idx_documents_held
  on public.documents (matterspace_id)
  where processing_status = 'held';

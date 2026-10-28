-- 123_brief_notes.sql — notes on a brief, in the desk's log (Eden, 10-21).
--
-- "A place to put a note on the brief … note to self / message to other team
-- members." A note is a third kind of row in cite_confirmations, beside
-- Confirmed and Problem: the same words-in-a-sentence-at-a-place anchor, the
-- same paint, the same carry to the next version — but never a reading. The
-- desk keeps notes apart from the readings everywhere (counts, flags, carry,
-- the CSV a court can read).
--
-- Still append-only: a reply is another note row at the same place, and
-- "Done" is a note row with no words. No update or delete policy, as in 103.
--
-- Also: the words a row holds go to 4,000 characters (a block quotation can
-- be flagged red, 10-21), its paragraph to 8,000, a note to 2,000.
--
-- audience: 'team' = everyone who can open the brief (as every row before);
-- 'me' = only its writer. Readings are always 'team'.

alter table public.cite_confirmations drop constraint if exists cite_confirmations_status_check;
alter table public.cite_confirmations add constraint cite_confirmations_status_check
  check (status in ('confirmed', 'problem', 'note'));

alter table public.cite_confirmations drop constraint if exists cite_confirmations_cite_raw_check;
alter table public.cite_confirmations add constraint cite_confirmations_cite_raw_check
  check (char_length(cite_raw) between 1 and 4000);

alter table public.cite_confirmations drop constraint if exists cite_confirmations_context_check;
alter table public.cite_confirmations add constraint cite_confirmations_context_check
  check (char_length(context) <= 8000);

alter table public.cite_confirmations drop constraint if exists cite_confirmations_note_check;
alter table public.cite_confirmations add constraint cite_confirmations_note_check
  check (char_length(note) <= 2000);

alter table public.cite_confirmations add column if not exists audience text not null default 'team';
alter table public.cite_confirmations drop constraint if exists cite_confirmations_audience_check;
alter table public.cite_confirmations add constraint cite_confirmations_audience_check
  check (audience in ('team', 'me') and (audience = 'team' or status = 'note'));

drop policy if exists "Cite confirmations visible with their document" on public.cite_confirmations;
create policy "Cite confirmations visible with their document"
  on public.cite_confirmations for select
  using (
    (audience = 'team' or user_id = auth.uid())
    and exists (select 1 from public.documents d where d.id = cite_confirmations.document_id));

comment on column public.cite_confirmations.audience is
  'team = everyone who can open the brief; me = its writer only (notes only).';
comment on table public.cite_confirmations is
  'The lawyer''s own check of a brief''s citations on the Brief Desk: one append-only row per Confirm/Problem press '
  '(cite as written, its sentence, the authority and page open, initials, time), and notes on the brief (status note; '
  'a reply is another row, "Done" an empty one). Never updated or deleted by the app.';

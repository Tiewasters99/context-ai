// The human check of a brief's cites (migration 103): one append-only row per
// Confirm / Problem press on the desk. The machine's pass (confirm.ts) finds
// the page; this is the lawyer reading it and saying so, with initials.
// The pure rules live in confirmations-core.ts (harness-loadable).

import { supabase } from '@/lib/supabase';
import {
  carryPlan, carryNote, openFlagNote, rewordedNote, noteThreads, NOTE_MAX, NOTE_MAX_123, LOG_WORDS_MAX, LOG_WORDS_MAX_123,
  type CarryPlan, type ChangedReading, type CiteConfirmation, type ConfirmationStatus, type BriefNote, type NoteAudience,
} from './confirmations-core';

export * from './confirmations-core';

const COLS = 'id, document_id, cite_raw, context, pm_from, authority_document_id, authority_title, authority_page, status, note, initials, user_id, created_at';

/**
 * Whether migration 123 (notes, longer words) is applied: the `audience`
 * column answers. Asked once per page; before it, the desk works as it did,
 * without notes and at the old lengths.
 */
let notesReadyAsk: Promise<boolean> | null = null;
export function notesReady(): Promise<boolean> {
  notesReadyAsk ??= (async () => {
    const { error } = await supabase.from('cite_confirmations').select('audience').limit(1);
    return !error;
  })();
  return notesReadyAsk;
}

/** The longest words and note a row takes, before and after migration 123. */
export const logLimits = (ready: boolean) => ({ words: ready ? LOG_WORDS_MAX_123 : LOG_WORDS_MAX, note: ready ? NOTE_MAX_123 : NOTE_MAX });

/** The readings (Confirmed, Problem) of a brief, oldest first. Notes are never among them. */
export async function loadConfirmations(documentId: string): Promise<CiteConfirmation[]> {
  const { data, error } = await supabase
    .from('cite_confirmations')
    .select(COLS)
    .eq('document_id', documentId)
    .neq('status', 'note')
    .order('created_at', { ascending: true });
  if (error) {
    // Before migration 103 is applied the table is missing: the desk still works, without a log.
    if (/cite_confirmations/.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as CiteConfirmation[];
}

export async function addConfirmation(row: {
  document_id: string;
  cite_raw: string;
  context: string;
  pm_from: number | null;
  authority_document_id: string | null;
  authority_title: string | null;
  authority_page: number | null;
  status: ConfirmationStatus;
  note?: string;
  initials: string;
}): Promise<CiteConfirmation> {
  const { data: u } = await supabase.auth.getUser();
  const me = u.user?.id;
  if (!me) throw new Error('You are signed out.');
  const initials = row.initials.trim().toUpperCase().slice(0, 6);
  if (!initials) throw new Error('Initials are needed: the log records who read the page.');
  const limits = logLimits(await notesReady());
  const { data, error } = await supabase
    .from('cite_confirmations')
    .insert({
      document_id: row.document_id,
      cite_raw: row.cite_raw.slice(0, limits.words),
      context: (row.context ?? '').slice(0, limits.words === LOG_WORDS_MAX ? 2000 : 8000),
      pm_from: row.pm_from,
      authority_document_id: row.authority_document_id,
      authority_title: row.authority_title,
      authority_page: row.authority_page,
      status: row.status,
      note: (row.note ?? '').trim().slice(0, limits.note),
      initials,
      user_id: me,
    })
    .select(COLS)
    .single();
  if (error) {
    if (/cite_confirmations/.test(error.message) && /not find|does not exist|schema cache/i.test(error.message)) {
      throw new Error('The confirmation log is not set up yet (migration 103). Ask Eden to apply it.');
    }
    throw new Error(error.message);
  }
  return data as CiteConfirmation;
}

/** The notes on a brief that this person can see (the team's, and their own), oldest first. Empty before migration 123. */
export async function loadBriefNotes(documentId: string): Promise<BriefNote[]> {
  if (!(await notesReady())) return [];
  const { data, error } = await supabase
    .from('cite_confirmations')
    .select(`${COLS}, audience`)
    .eq('document_id', documentId)
    .eq('status', 'note')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as BriefNote[];
}

/** One note (or reply, or "Done" when `note` is empty) at a place in the brief. */
export async function addNote(row: {
  document_id: string; cite_raw: string; context: string; pm_from: number | null;
  note: string; initials: string; audience: NoteAudience;
}): Promise<BriefNote> {
  if (!(await notesReady())) throw new Error('Notes are not set up yet (migration 123). Ask Eden to apply it.');
  const { data: u } = await supabase.auth.getUser();
  const me = u.user?.id;
  if (!me) throw new Error('You are signed out.');
  const initials = row.initials.trim().toUpperCase().slice(0, 6);
  if (!initials) throw new Error('Initials are needed: a note says who wrote it.');
  const { data, error } = await supabase
    .from('cite_confirmations')
    .insert({
      document_id: row.document_id,
      cite_raw: row.cite_raw.slice(0, LOG_WORDS_MAX_123),
      context: row.context.slice(0, 8000),
      pm_from: row.pm_from,
      authority_document_id: null, authority_title: null, authority_page: null,
      status: 'note',
      note: row.note.trim().slice(0, NOTE_MAX_123),
      initials,
      user_id: me,
      audience: row.audience,
    })
    .select(`${COLS}, audience`)
    .single();
  if (error) throw new Error(error.message);
  return data as BriefNote;
}

async function insertRows(rows: Omit<CiteConfirmation, 'id' | 'created_at'>[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabase.from('cite_confirmations').insert(batch);
    if (error) throw new Error(error.message);
    n += batch.length;
  }
  return n;
}

/**
 * Carry an earlier version's readings onto this one: one new row per reading
 * whose words and sentence are unchanged in the new version (`paragraphs`,
 * from briefParagraphs), written in the new version's words and saying where
 * it came from and who read it; then every problem nobody answered, carried
 * open. Readings already here are skipped. Returns the plan and the counts.
 */
export async function carryConfirmations(fromDocumentId: string, fromTitle: string, toDocumentId: string, paragraphs: string[]): Promise<CarryPlan & { inserted: number; flagsInserted: number; notesCarried: number }> {
  const { data: u } = await supabase.auth.getUser();
  const me = u.user?.id;
  if (!me) throw new Error('You are signed out.');
  const [old, here] = await Promise.all([loadConfirmations(fromDocumentId), loadConfirmations(toDocumentId)]);
  const plan = carryPlan(old, paragraphs, here);
  const inserted = await insertRows(plan.carry.map(({ row, cite_raw, context, differs }) => ({
    document_id: toDocumentId,
    cite_raw,
    context: context.slice(0, 2000),
    pm_from: null,
    authority_document_id: row.authority_document_id,
    authority_title: row.authority_title,
    authority_page: row.authority_page,
    status: row.status,
    note: carryNote(row, fromTitle, differs).slice(0, NOTE_MAX),
    initials: row.initials,
    user_id: me,
  })));
  // Open flags go in a second insert, so they are later than anything above
  // and nothing carried green can be taken for their answer.
  const flagsInserted = await insertRows(plan.openFlags.map((row) => ({
    document_id: toDocumentId,
    cite_raw: row.cite_raw,
    context: row.context,
    pm_from: null,
    authority_document_id: row.authority_document_id,
    authority_title: row.authority_title,
    authority_page: row.authority_page,
    status: 'problem' as const,
    note: openFlagNote(row, fromTitle).slice(0, NOTE_MAX),
    initials: row.initials,
    user_id: me,
  })));
  const notesCarried = await carryNotes(fromDocumentId, toDocumentId, paragraphs);
  return { ...plan, inserted, flagsInserted, notesCarried };
}

/**
 * The open notes go across too, each thread whole and in its order, in the
 * new version's words, so long as its words and sentence are there unchanged
 * (the rule readings carry by). Each row keeps its words, its writer's
 * initials and its audience. A thread marked Done stays behind.
 */
async function carryNotes(fromDocumentId: string, toDocumentId: string, paragraphs: string[]): Promise<number> {
  const [old, here] = await Promise.all([loadBriefNotes(fromDocumentId), loadBriefNotes(toDocumentId)]);
  let n = 0;
  for (const t of noteThreads(old).filter((x) => x.open)) {
    const last = t.rows[t.rows.length - 1] as unknown as CiteConfirmation;
    const plan = carryPlan([{ ...last, status: 'confirmed' }], paragraphs, here.map((h) => ({ ...h, status: 'confirmed' }) as CiteConfirmation));
    const to = plan.carry[0];
    if (!to) continue;
    // one at a time: each its own time, so the thread keeps its order
    for (const r of t.rows) {
      await addNote({ document_id: toDocumentId, cite_raw: to.cite_raw, context: to.context, pm_from: null, note: r.note, initials: r.initials, audience: r.audience ?? 'team' });
      n++;
    }
  }
  return n;
}

/**
 * Record the person's own review of a reading whose sentence was reworded
 * since it was read: one confirmed row, in the new sentence, signed with
 * THEIR initials and the time they pressed, its note naming the earlier
 * reading. Only ever one reading per press (Eden, 10-13).
 */
export async function recordRewordedReview(toDocumentId: string, c: ChangedReading, fromTitle: string, initials: string, pmFrom: number | null): Promise<CiteConfirmation> {
  return addConfirmation({
    document_id: toDocumentId,
    cite_raw: c.cite_raw,
    context: c.paragraph,
    pm_from: pmFrom,
    authority_document_id: c.row.authority_document_id,
    authority_title: c.row.authority_title,
    authority_page: c.row.authority_page,
    status: 'confirmed',
    note: rewordedNote(c.row, fromTitle).slice(0, NOTE_MAX),
    initials,
  });
}

const INITIALS_KEY = 'cs.brief.initials';

/** The initials the log signs with: remembered per browser; first guess from the profile name or email. */
export function rememberedInitials(): string | null {
  try { return localStorage.getItem(INITIALS_KEY); } catch { return null; }
}
export function rememberInitials(v: string) {
  try { localStorage.setItem(INITIALS_KEY, v.trim().toUpperCase().slice(0, 6)); } catch { /* private window */ }
}

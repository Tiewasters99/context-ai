// The human check of a brief's cites (migration 103): one append-only row per
// Confirm / Problem press on the desk. The machine's pass (confirm.ts) finds
// the page; this is the lawyer reading it and saying so, with initials.
// The pure rules live in confirmations-core.ts (harness-loadable).

import { supabase } from '@/lib/supabase';
import {
  carryPlan, carryNote, openFlagNote, rewordedNote, NOTE_MAX,
  type CarryPlan, type ChangedReading, type CiteConfirmation, type ConfirmationStatus,
} from './confirmations-core';

export * from './confirmations-core';

const COLS = 'id, document_id, cite_raw, context, pm_from, authority_document_id, authority_title, authority_page, status, note, initials, user_id, created_at';

export async function loadConfirmations(documentId: string): Promise<CiteConfirmation[]> {
  const { data, error } = await supabase
    .from('cite_confirmations')
    .select(COLS)
    .eq('document_id', documentId)
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
  const { data, error } = await supabase
    .from('cite_confirmations')
    .insert({
      document_id: row.document_id,
      cite_raw: row.cite_raw.slice(0, 400),
      context: (row.context ?? '').slice(0, 2000),
      pm_from: row.pm_from,
      authority_document_id: row.authority_document_id,
      authority_title: row.authority_title,
      authority_page: row.authority_page,
      status: row.status,
      note: (row.note ?? '').trim().slice(0, 400),
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
export async function carryConfirmations(fromDocumentId: string, fromTitle: string, toDocumentId: string, paragraphs: string[]): Promise<CarryPlan & { inserted: number; flagsInserted: number }> {
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
  return { ...plan, inserted, flagsInserted };
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

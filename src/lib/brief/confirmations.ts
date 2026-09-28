// The human check of a brief's cites (migration 103): one append-only row per
// Confirm / Problem press on the desk. The machine's pass (confirm.ts) finds
// the page; this is the lawyer reading it and saying so, with initials.

import { supabase } from '@/lib/supabase';

export type ConfirmationStatus = 'confirmed' | 'problem';

export interface CiteConfirmation {
  id: string;
  document_id: string;
  cite_raw: string;
  context: string;
  pm_from: number | null;
  authority_document_id: string | null;
  authority_title: string | null;
  authority_page: number | null;
  status: ConfirmationStatus;
  note: string;
  initials: string;
  user_id: string;
  created_at: string;
}

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

/** The latest row for a cite: same words, same sentence (or the same words when the sentence is unknown). */
export function latestFor(rows: CiteConfirmation[], raw: string, context: string | null): CiteConfirmation | null {
  const r = raw.trim();
  const c = (context ?? '').trim();
  let best: CiteConfirmation | null = null;
  for (const row of rows) {
    if (row.cite_raw.trim() !== r) continue;
    if (c && row.context && row.context.trim() !== c) continue;
    if (!best || row.created_at > best.created_at) best = row;
  }
  return best;
}

/** Latest status per (cite, sentence): what the brief's highlights and the count show. */
export function latestByCite(rows: CiteConfirmation[]): CiteConfirmation[] {
  const m = new Map<string, CiteConfirmation>();
  for (const row of rows) {
    const k = `${row.cite_raw.trim()}\u0000${row.context.trim()}`;
    const cur = m.get(k);
    if (!cur || row.created_at > cur.created_at) m.set(k, row);
  }
  return [...m.values()];
}

const INITIALS_KEY = 'cs.brief.initials';

/** The initials the log signs with: remembered per browser; first guess from the profile name or email. */
export function rememberedInitials(): string | null {
  try { return localStorage.getItem(INITIALS_KEY); } catch { return null; }
}
export function rememberInitials(v: string) {
  try { localStorage.setItem(INITIALS_KEY, v.trim().toUpperCase().slice(0, 6)); } catch { /* private window */ }
}
export function guessInitials(displayName: string | null | undefined, email: string | null | undefined): string {
  const name = (displayName ?? '').trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const ini = parts.map((p) => p[0]).join('').toUpperCase();
    if (ini.length >= 2) return ini.slice(0, 3);
  }
  const local = (email ?? '').split('@')[0];
  if (local) return local.slice(0, 2).toUpperCase();
  return '';
}

/** The log as CSV, newest first — the record a court or a colleague can read without the app. */
export function confirmationsCsv(rows: CiteConfirmation[], briefTitle: string): string {
  const esc = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['brief', 'when', 'initials', 'status', 'cite as written', 'sentence', 'authority', 'page', 'note'];
  const lines = [head.map(esc).join(',')];
  for (const r of [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    lines.push([briefTitle, r.created_at, r.initials, r.status, r.cite_raw, r.context, r.authority_title ?? '', r.authority_page ?? '', r.note].map(esc).join(','));
  }
  return lines.join('\n');
}

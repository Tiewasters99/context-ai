// The pure half of the confirmation log (no Supabase import, so harnesses can
// load it under plain node): identity of an occurrence, latest-row rules,
// initials, CSV.

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

/** Two presses are the same occurrence when their positions in the brief are this close (a cite is a few dozen characters). */
export const SAME_SPOT = 24;

/**
 * The latest row for THIS occurrence of a cite: same words, same sentence, and
 * — when the same words appear twice in one paragraph ("A-1315 (SMF ¶ 10)…
 * A-1315 (SMF ¶ 11)", 09-28) — the same place in the text, by pm_from.
 */
export function latestFor(rows: CiteConfirmation[], raw: string, context: string | null, from: number | null = null): CiteConfirmation | null {
  const r = raw.trim();
  const c = (context ?? '').trim();
  const same = rows.filter((row) => row.cite_raw.trim() === r && !(c && row.context && row.context.trim() !== c));
  if (!same.length) return null;
  let pool = same;
  if (from !== null && same.some((row) => row.pm_from !== null)) {
    const here = same.filter((row) => row.pm_from !== null && Math.abs((row.pm_from as number) - from) <= SAME_SPOT);
    // rows placed elsewhere in the paragraph belong to another occurrence; legacy rows with no place count for any
    pool = here.length ? here : same.filter((row) => row.pm_from === null);
  }
  let best: CiteConfirmation | null = null;
  for (const row of pool) if (!best || row.created_at > best.created_at) best = row;
  return best;
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface CarryPlan {
  /** Same words, same sentence in the new text: carried, as a new row that says so. */
  carry: CiteConfirmation[];
  /** The cite's words are in the new text but its sentence changed: read again. */
  changed: CiteConfirmation[];
  /** The cite is no longer in the new text. */
  gone: CiteConfirmation[];
}

/**
 * Which of an earlier brief's latest readings hold for a new text (v8 → v9,
 * Eden 09-28: "a cite green in v.8 should stay green in v.9"). A reading is
 * of WORDS IN A SENTENCE, so it carries only when both appear unchanged; a
 * changed sentence can change the proposition, so that cite is read again.
 * Deterministic: text matching on collapsed whitespace, nothing else.
 */
export function carryPlan(oldRows: CiteConfirmation[], newText: string): CarryPlan {
  const text = flat(newText);
  const plan: CarryPlan = { carry: [], changed: [], gone: [] };
  // one reading per occurrence, on collapsed whitespace, the newest
  const newest = new Map<string, CiteConfirmation>();
  for (const row of latestByCite(oldRows)) {
    const k = `${flat(row.cite_raw)}\u0000${flat(row.context)}`;
    const prev = newest.get(k);
    if (!prev || row.created_at > prev.created_at) newest.set(k, row);
  }
  for (const row of newest.values()) {
    const raw = flat(row.cite_raw);
    if (!raw || !text.includes(raw)) { plan.gone.push(row); continue; }
    const ctx = flat(row.context);
    if (ctx && text.includes(ctx)) plan.carry.push(row);
    else if (!ctx) plan.carry.push(row);           // logged without a sentence (an older row): the words are enough
    else plan.changed.push(row);
  }
  return plan;
}

/** The note a carried row carries: where it came from, who read it, when. */
export function carryNote(row: CiteConfirmation, fromTitle: string): string {
  const when = new Date(row.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const base = `carried from “${fromTitle}” — ${row.status === 'confirmed' ? 'confirmed' : 'problem noted'} by ${row.initials} ${when}; same words, same sentence`;
  return row.note ? `${base}. ${row.note}` : base;
}

/** Latest status per occurrence (cite, sentence, place): what the brief's highlights and the count show. */
export function latestByCite(rows: CiteConfirmation[]): CiteConfirmation[] {
  const groups = new Map<string, CiteConfirmation[]>();
  for (const row of rows) {
    const k = `${row.cite_raw.trim()}\u0000${row.context.trim()}`;
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  const out: CiteConfirmation[] = [];
  for (const g of groups.values()) {
    // cluster by place: rows within SAME_SPOT of each other are one occurrence
    const sorted = [...g].sort((a, b) => (a.pm_from ?? -1) - (b.pm_from ?? -1));
    let cluster: CiteConfirmation[] = [];
    const flush = () => { if (cluster.length) out.push(cluster.reduce((b, r) => (r.created_at > b.created_at ? r : b))); cluster = []; };
    for (const row of sorted) {
      const last = cluster[cluster.length - 1];
      if (last && (row.pm_from === null || last.pm_from === null || (row.pm_from - (last.pm_from as number)) > SAME_SPOT)) flush();
      cluster.push(row);
    }
    flush();
  }
  return out;
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

/** What the log says about where the reading was done. */
export function whereRead(r: Pick<CiteConfirmation, 'authority_title' | 'authority_page'>): string {
  if (!r.authority_title && !r.authority_page) return 'checked outside the desk (hard copy or another source)';
  return `${r.authority_title ?? 'document'}${r.authority_page ? `, p. ${r.authority_page}` : ''}`;
}

/** The log as CSV, newest first — the record a court or a colleague can read without the app. */
export function confirmationsCsv(rows: CiteConfirmation[], briefTitle: string): string {
  const esc = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['brief', 'when', 'initials', 'status', 'cite as written', 'sentence', 'authority', 'page', 'note'];
  const lines = [head.map(esc).join(',')];
  for (const r of [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    lines.push([briefTitle, r.created_at, r.initials, r.status, r.cite_raw, r.context, r.authority_title ?? (r.authority_page ? '' : 'checked outside the desk'), r.authority_page ?? '', r.note].map(esc).join(','));
  }
  return lines.join('\n');
}

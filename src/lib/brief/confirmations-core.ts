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

/**
 * Text as the carry compares it: whitespace collapsed, curly quotes made
 * straight, every dash a hyphen, no-break spaces plain. Each replacement is
 * one character for one, so an index found in the result is an index in the
 * (collapsed) original. Word swaps "--" and "–" between drafts; a reading is
 * of the words, not of the typography (Bushell, 10-13).
 */
export function matchText(s: string): string {
  return flat(s)
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2007\u202F]/g, ' ');
}

/** A numbered paragraph's own number ("90. ", "¶ 90. ") at its start: renumbering is not rewording. */
const LEAD_NUMBER = /^(?:\u00B6\s?)?\d{1,4}\.\s/;
const sentenceKey = (s: string) => matchText(s).replace(LEAD_NUMBER, '');

type PmNode = { type: string; text?: string; content?: PmNode[] };

/**
 * Every paragraph of a brief the way the desk names a cite's sentence when it
 * is pressed (BriefDesk paragraphContextAt): the text of one paragraph,
 * heading or footnote, a footnote's words left out of the paragraph it sits
 * in, whitespace collapsed. Carried rows are written in these words so the
 * cite turns green in the new version.
 */
export function briefParagraphs(doc: unknown): string[] {
  const out: string[] = [];
  const textOf = (n: PmNode): string => (n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(textOf).join(''));
  const walk = (n: PmNode) => {
    const kids = n.content ?? [];
    if (n.type === 'paragraph' || n.type === 'heading' || kids.some((k) => k.type === 'text')) {
      const t = flat(kids.filter((k) => k.type !== 'footnote').map(textOf).join(''));
      if (t) out.push(t);
    }
    for (const k of kids) if (k.type !== 'text') walk(k);
  };
  if (doc && typeof doc === 'object') walk(doc as PmNode);
  return out;
}

/** A reading moved onto the new version, in the new version's words. */
export interface CarriedReading {
  row: CiteConfirmation;
  /** The cite as the new version spells it. */
  cite_raw: string;
  /** The new version's paragraph it sits in ('' for an old row logged without one). */
  context: string;
  /** How the new paragraph differs, for the note: nothing, its number, or quote marks and dashes. */
  differs: 'none' | 'number' | 'typography';
}

/** A reading whose words are in the new version but whose sentence was reworded. */
export interface ChangedReading {
  row: CiteConfirmation;
  /** The new paragraph most like the old one, and the cite as it is spelled there. */
  paragraph: string;
  cite_raw: string;
}

export interface CarryPlan {
  /** Same words, same sentence in the new version: carried, as a new row that says so. */
  carry: CarriedReading[];
  /** The cite's words are in the new version but its sentence was reworded: for the lawyer to look at. */
  changed: ChangedReading[];
  /** The cite is no longer in the new version. */
  gone: CiteConfirmation[];
  /** Problems nobody answered whose sentence did not survive: they go across open, to be resolved with a note. */
  openFlags: CiteConfirmation[];
  /** Readings the new version already has: left alone. */
  already: number;
}

const wordSet = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9§¶]+/g) ?? []);
function likeness(a: string, b: string): number {
  const x = wordSet(a), y = wordSet(b);
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.max(1, x.size, y.size);
}

/**
 * Which of an earlier version's latest readings hold for a new one (v8 → v9,
 * Eden 09-28: "a cite green in v.8 should stay green in v.9"). A reading is
 * of WORDS IN A SENTENCE, so it carries only when both appear unchanged; a
 * reworded sentence can change the proposition, so that cite is listed for a
 * fresh look. "Unchanged" ignores the paragraph's own number, whitespace,
 * quote marks and dashes, and nothing else (10-13: 40 of Bushell's readings
 * failed on those alone). Readings already on the new version are skipped,
 * so running it twice adds nothing. A problem nobody answered always goes
 * across, open.
 *
 * `newText` is the new version's paragraphs (briefParagraphs); a single
 * string is taken as one paragraph.
 */
export function carryPlan(oldRows: CiteConfirmation[], newText: string | string[], targetRows: CiteConfirmation[] = []): CarryPlan {
  const paras = (typeof newText === 'string' ? [newText] : newText).map(flat).filter(Boolean);
  const norm = paras.map(matchText);
  const keys = paras.map(sentenceKey);
  const plan: CarryPlan = { carry: [], changed: [], gone: [], openFlags: [], already: 0 };
  const have = new Set(latestByCite(targetRows).map((r) => `${matchText(r.cite_raw)}\u0000${sentenceKey(r.context)}`));

  // one reading per occurrence, the newest
  const newest = new Map<string, CiteConfirmation>();
  for (const row of latestByCite(oldRows)) {
    const k = `${matchText(row.cite_raw)}\u0000${sentenceKey(row.context)}`;
    const prev = newest.get(k);
    if (!prev || row.created_at > prev.created_at) newest.set(k, row);
  }
  for (const row of newest.values()) {
    const raw = matchText(row.cite_raw);
    const open = row.status === 'problem' && openProblemForWords(oldRows, row.cite_raw)?.id === row.id;
    // a flag answered by a later reading of the same words elsewhere is not carried red
    if (row.status === 'problem' && !open) continue;
    if (!raw || !norm.some((p) => p.includes(raw))) {
      plan.gone.push(row);
      if (open) plan.openFlags.push(row);
      continue;
    }
    const ctx = sentenceKey(row.context);
    // the same sentence in the new version, still with the cite (an old row logged without a sentence: the words are enough)
    // (a row logged with one sentence of a longer paragraph: that sentence, unchanged, in a paragraph with the cite)
    let same = ctx ? keys.findIndex((k, i) => k === ctx && norm[i].includes(raw)) : norm.findIndex((p) => p.includes(raw));
    if (same < 0 && ctx) same = keys.findIndex((k, i) => k.includes(ctx) && norm[i].includes(raw));
    if (same >= 0) {
      const p = paras[same];
      const at = norm[same].indexOf(raw);
      const k = `${raw}\u0000${ctx ? keys[same] : ''}`;
      if (have.has(k)) { plan.already++; continue; }
      have.add(k);
      plan.carry.push({
        row,
        cite_raw: p.slice(at, at + raw.length),
        context: ctx ? p : '',
        differs: !ctx || flat(row.context) === p ? 'none' : matchText(row.context) === norm[same] ? 'typography' : 'number',
      });
      continue;
    }
    // reworded: the paragraph with the cite most like the old sentence
    let best = -1;
    let score = -1;
    norm.forEach((p, i) => {
      if (!p.includes(raw)) return;
      const s = likeness(ctx, keys[i]);
      if (s > score) { score = s; best = i; }
    });
    const at = norm[best].indexOf(raw);
    if (have.has(`${raw}\u0000${keys[best]}`)) plan.already++;
    else plan.changed.push({ row, paragraph: paras[best], cite_raw: paras[best].slice(at, at + raw.length) });
    if (open) plan.openFlags.push(row);
  }
  // a flag already carried (or answered) on the new version does not go twice
  const flagged = new Set(targetRows.map((r) => `${matchText(r.cite_raw)}\u0000${sentenceKey(r.context)}`));
  plan.openFlags = plan.openFlags.filter((r) => !flagged.has(`${matchText(r.cite_raw)}\u0000${sentenceKey(r.context)}`));
  return plan;
}

/**
 * The newest reading of these cite WORDS anywhere in the brief, whatever
 * sentence they sat in. A rewritten paragraph makes a new occurrence, but the
 * flag on the words is still the flag (Eden, 09-28: swapped in a new
 * paragraph, confirmed, and the red-to-green note was never asked for).
 */
export function lastReadingOfWords(rows: CiteConfirmation[], raw: string): CiteConfirmation | null {
  const r = flat(raw);
  if (!r) return null;
  let best: CiteConfirmation | null = null;
  for (const row of rows) if (flat(row.cite_raw) === r && (!best || row.created_at > best.created_at)) best = row;
  return best;
}

/** The problem on these words that no later confirmation has answered; null when none is open. */
export function openProblemForWords(rows: CiteConfirmation[], raw: string): CiteConfirmation | null {
  const last = lastReadingOfWords(rows, raw);
  return last && last.status === 'problem' ? last : null;
}

/**
 * The problems still open (no later reading of the same words), newest first,
 * each with whether its words are still in the brief. A flag whose words were
 * redrafted away is otherwise stranded: confirming the NEW wording is a
 * different set of words, so nothing asks how the old flag was answered
 * (Eden, 10-02: ¶ 90 of Bushell v18). The Log resolves these by hand.
 */
export function openProblems(rows: CiteConfirmation[], briefText: string): { row: CiteConfirmation; inBrief: boolean }[] {
  const text = flat(briefText);
  return rows
    .filter((r) => r.status === 'problem' && openProblemForWords(rows, r.cite_raw)?.id === r.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((row) => ({ row, inBrief: text.includes(flat(row.cite_raw)) }));
}

/** Longest note the log takes (migration 103: char_length(note) <= 400). */
export const NOTE_MAX = 400;

const stamp = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The note a carried row carries: where it came from, who read it, when, and what (if anything) differs. */
export function carryNote(row: CiteConfirmation, fromTitle: string, differs: CarriedReading['differs'] = 'none'): string {
  const same = differs === 'number' ? 'same words, same sentence; paragraph renumbered'
    : differs === 'typography' ? 'same words, same sentence; quote marks or dashes differ'
    : 'same words, same sentence';
  const base = `carried from “${fromTitle}” — ${row.status === 'confirmed' ? 'confirmed' : 'problem noted'} by ${row.initials} ${stamp(row.created_at)}; ${same}`;
  return row.note ? `${base}. ${row.note}` : base;
}

/** The note on a problem carried across open: the flag, who raised it, and that nobody has answered it. */
export function openFlagNote(row: CiteConfirmation, fromTitle: string): string {
  return `carried open from “${fromTitle}” — problem noted by ${row.initials} ${stamp(row.created_at)}, not yet resolved${row.note ? `. ${row.note}` : ''}`;
}

/**
 * The note on a reading recorded after its sentence was reworded: the earlier
 * reading, and that the change was reviewed against it. The row's own
 * initials and time say who reviewed it and when (Eden, 10-13: the record
 * must show that he reviewed it, not that it was done for him).
 */
export function rewordedNote(row: CiteConfirmation, fromTitle: string): string {
  const where = row.authority_title || row.authority_page ? ` (${whereRead(row)})` : '';
  return `read on “${fromTitle}” by ${row.initials} ${stamp(row.created_at)}${where}; the sentence was reworded since, and the change was reviewed against that reading`;
}

/** A confirmed row answers a problem when an earlier row on the same words was one (the Log labels its note "Resolved"). */
export function answersProblem(rows: CiteConfirmation[], row: CiteConfirmation): boolean {
  if (row.status !== 'confirmed' || /^(carried |read on “)/.test(row.note)) return false;
  const w = matchText(row.cite_raw);
  return rows.some((r) => r.status === 'problem' && r.created_at < row.created_at && matchText(r.cite_raw) === w);
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

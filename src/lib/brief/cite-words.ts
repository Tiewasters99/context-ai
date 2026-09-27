// The cite table's words (src/pages/brief/CiteTable.tsx): what a row says
// about its flag, the corpus and the pin. Pure, so the harness can read them.

import type { CiteFlag } from '@/lib/cite-check/types';
import type { StoredResolution, TableRow } from './anchor';

/** What the row's flag says: a stale cite is not checked, whatever it was. */
export function rowFlag(r: TableRow): CiteFlag {
  if (r.stale || !r.entry) return 'unchecked';
  return r.entry.flag;
}

/** "in corpus": the case's title, or why there is none. */
export function corpusText(res: StoredResolution | null | undefined): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (!res) return { text: 'not looked up yet', tone: 'muted' };
  switch (res.status) {
    case 'resolved': return { text: res.hits[0]?.title || 'in the matter', tone: 'ok' };
    case 'two_copies': return { text: `${new Set(res.hits.map((h) => h.document_id)).size} copies — pick one`, tone: 'warn' };
    case 'not_in_corpus': return { text: 'not in corpus', tone: 'warn' };
    case 'not_a_case': return { text: 'not a reported case', tone: 'muted' };
    default: return { text: 'the lookup failed', tone: 'warn' };
  }
}

/** The pin column, in words: resolved to its page, or why not. */
export function pinText(res: StoredResolution | null | undefined): { text: string; caveat: string | null } {
  if (!res || res.status !== 'resolved') return { text: res?.pin != null ? `p. ${res.pin}` : '—', caveat: null };
  const p = res.passage;
  const hit = res.hits[0];
  if (hit?.how === 'reporter' && hit.star_level === null) {
    return { text: res.pin != null ? `p. ${res.pin} — this copy does not mark it` : 'first page', caveat: p?.caveat ?? null };
  }
  if (!p) return { text: 'no text indexed', caveat: null };
  if (res.pin == null) return { text: 'first page', caveat: p.caveat };
  switch (p.basis) {
    case 'printed': return { text: `p. ${res.pin}`, caveat: p.caveat };
    case 'parallel': return { text: `p. ${res.pin} (parallel reporter)`, caveat: p.caveat };
    case 'pin_not_found': return { text: 'pin not found', caveat: p.caveat };
    default: return { text: 'first page — no star pages', caveat: p.caveat };
  }
}

/** A row's identity in the table (and in the pane that it opened). */
export function rowKey(r: TableRow): string {
  return `${r.from ?? 'x'}:${r.entryIndex ?? 'm'}`;
}

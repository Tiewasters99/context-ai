// How the Vault's file list is grouped, and the vocabulary of shelves.
//
// The rule this module exists to keep: THE SERVER DOES THE SORTING. A matter
// here holds 7,600 documents; sorting that in the browser on every keystroke,
// or on every status tick from the ingest pipeline, is a tab that stops
// answering. So `buildVaultGroups` never sorts. It walks rows that arrived in
// the order they are meant to be read (`vault-documents.ts` asks PostgREST for
// `sort_key` or `category_rank, sort_key`, both index-backed) and cuts them
// into groups in ONE pass, putting a header wherever the key changes.
//
// Rows are keyed through a Map rather than compared with the previous row, so
// a row that arrives out of order — a file uploaded a moment ago, which the
// panel prepends — joins its own group instead of opening a second header with
// the same name.

/** How the list is cut. 'date' is what the Vault has always done. */
export type VaultGrouping = 'date' | 'name' | 'category';

/**
 * Table-of-Authorities order, and the order migration 081's `category_rank`
 * sorts by. Not alphabetical: this is the order a brief's authorities are read
 * in, which is the order a reviewing attorney looks for them in.
 */
export const CATEGORY_ORDER = [
  'case', 'statute', 'rule', 'secondary', 'pleading', 'supporting', 'other',
] as const;

export type DocumentCategory = (typeof CATEGORY_ORDER)[number];

export const CATEGORY_LABEL: Record<DocumentCategory, string> = {
  case: 'Cases',
  statute: 'Statutes',
  rule: 'Rules',
  secondary: 'Secondary authorities',
  pleading: 'Pleadings',
  supporting: 'Supporting material',
  other: 'Other',
};

/** What a row that nobody has filed yet is called. */
export const UNCATEGORISED_LABEL = 'Not yet organized';

export function isDocumentCategory(v: unknown): v is DocumentCategory {
  return typeof v === 'string' && (CATEGORY_ORDER as readonly string[]).includes(v);
}

/** The least a row must carry to be grouped. */
export interface GroupableFile {
  id: string;
  name: string;
  matterspace_id?: string;
  matterspace_name?: string;
  /** documents.sort_key (migration 081) — the A–Z key for the displayed name. */
  sortKey?: string;
  /** documents.category (migration 081); null/undefined = not yet organized. */
  category?: string | null;
}

export interface VaultGroup<T> {
  /** Stable key for React and for the collapsed-groups set. */
  id: string;
  name: string;
  files: T[];
}

/**
 * The A–Z heading a row belongs under. Anything that does not start with a
 * letter goes under '#' — a filing night produces "2291 IMG.jpg" as readily as
 * "Watson", and a list with twenty-six headings plus one is easier to scan
 * than one with a heading per digit.
 *
 * `sortKey` is preferred over the displayed name because it is what the server
 * ordered by: the name "2026-09-08 04 - Watson v Long Island RCo.pdf" sorts,
 * and must therefore be filed, under W.
 */
export function groupLetter(file: Pick<GroupableFile, 'sortKey' | 'name'>): string {
  const basis = (file.sortKey || file.name || '').trimStart();
  const first = basis.charAt(0).toUpperCase();
  return first >= 'A' && first <= 'Z' ? first : '#';
}

/**
 * Cut the (already ordered) rows into groups.
 *
 * Returns `null` for "no grouping is worth showing" — which for 'date' means a
 * list that is all one matter, exactly as the panel behaved before this
 * module existed. The caller then renders the flat list.
 */
export function buildVaultGroups<T extends GroupableFile>(
  files: T[],
  mode: VaultGrouping,
): VaultGroup<T>[] | null {
  if (files.length === 0) return null;

  if (mode === 'date') {
    // Unchanged behaviour: group by matter, and only when there is more than
    // one matter in the list to tell apart.
    const tagged = files.filter((f) => f.matterspace_id);
    if (tagged.length === 0) return null;
    if (new Set(tagged.map((f) => f.matterspace_id)).size <= 1) return null;
    return collect(files, (f) => ({
      key: f.matterspace_id ?? '__untagged__',
      label: f.matterspace_name ?? '(unknown matter)',
    }));
  }

  if (mode === 'name') {
    return collect(files, (f) => {
      const letter = groupLetter(f);
      return { key: `az:${letter}`, label: letter };
    });
  }

  return collect(files, (f) => {
    const c = f.category;
    if (isDocumentCategory(c)) return { key: `cat:${c}`, label: CATEGORY_LABEL[c] };
    return { key: 'cat:__none__', label: UNCATEGORISED_LABEL };
  });
}

function collect<T>(
  files: T[],
  keyOf: (f: T) => { key: string; label: string },
): VaultGroup<T>[] {
  const map = new Map<string, VaultGroup<T>>();
  for (const f of files) {
    const { key, label } = keyOf(f);
    let g = map.get(key);
    if (!g) {
      g = { id: key, name: label, files: [] };
      map.set(key, g);
    }
    g.files.push(f);
  }
  return Array.from(map.values());
}

/**
 * How many rows each group may draw out of ONE shared budget, in group order.
 * Every group keeps its header and its true count; only the rows inside are
 * windowed, so no shelf ever vanishes from the list.
 */
export function shareRenderBudget<T>(
  groups: VaultGroup<T>[],
  budget: number,
  collapsed: ReadonlySet<string>,
): Map<string, number> {
  let left = budget;
  const take = new Map<string, number>();
  for (const g of groups) {
    if (collapsed.has(g.id)) { take.set(g.id, 0); continue; }
    const n = Math.min(g.files.length, Math.max(0, left));
    take.set(g.id, n);
    left -= n;
  }
  return take;
}

/** The per-matter memory of how somebody likes to read their own matter. */
export function groupingStorageKey(matterId: string | undefined): string | null {
  return matterId ? `cs.vault.grouping.${matterId}` : null;
}

export function readGrouping(matterId: string | undefined): VaultGrouping {
  const key = groupingStorageKey(matterId);
  if (!key) return 'date';
  try {
    const raw = localStorage.getItem(key);
    return raw === 'name' || raw === 'category' ? raw : 'date';
  } catch {
    // Private windows, blocked site data: the list still has to render.
    return 'date';
  }
}

export function writeGrouping(matterId: string | undefined, mode: VaultGrouping): void {
  const key = groupingStorageKey(matterId);
  if (!key) return;
  try { localStorage.setItem(key, mode); } catch { /* not worth a notice */ }
}

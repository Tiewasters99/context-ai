// The Library → editions: the pure parts of the mirror (Grapheon Reader
// Phase 2S; docs/specs/GRAPHEON-READER-2026-10-10.md, "The Library in the
// Store — mirroring 376 books", D13, D18). No network here, so
// scripts/_test-library-to-editions.mjs can drive every rule offline;
// scripts/library-to-editions.mjs does the reading and writing.
//
// The filename grammar Eden already uses is the contract (D18):
//
//   Title - Cleaned.pdf
//   Title - Cleaned, Vol II.pdf
//   Title Vol I - Cleaned.pdf
//   Title Vol I Part 1 - Cleaned.pdf
//   Title Vol I - Cleaned, Part 2.pdf
//   Title Part I - Cleaned, Section 1.pdf
//
// " - Cleaned" is a marker, not part of the title. Vol / Part / Section /
// Book tokens (roman or arabic) may stand before or after the marker; they
// are read in that order of rank, so "Vol I Part 2" sorts after "Vol I Part
// 1" and before "Vol II". Everything left is the title, and that title is
// the collection key the volumes share. A book with no tokens is a single:
// collection_key and volume null.

const TOKEN_RE = /\b(Vol(?:ume)?\.?|Part|Section|Book|Tome)\s+([IVXLC]+|\d+)\b\.?/gi;
const RANK = { vol: 0, volume: 0, book: 0, tome: 0, part: 1, section: 2 };
const LABEL = { vol: 'Vol.', volume: 'Vol.', book: 'Book', tome: 'Tome', part: 'Part', section: 'Section' };

export function romanToInt(s) {
  const v = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  const up = String(s).toUpperCase();
  if (!/^[IVXLC]+$/.test(up)) return null;
  let total = 0;
  for (let i = 0; i < up.length; i++) {
    const cur = v[up[i]];
    const next = v[up[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

function numeral(s) {
  return /^\d+$/.test(s) ? Number(s) : romanToInt(s);
}

function tidy(s) {
  return String(s)
    .replace(/\s*,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, '')
    .trim();
}

/** Parse one Library file. `title` is the document's own title (what Eden
 *  curated in Contextspaces); it is preferred over the filename for the
 *  words, the filename for the volume tokens when the title has none. */
export function parseLibraryName(filename, title = null) {
  const stem = String(filename ?? '').replace(/\.pdf$/i, '');
  const base = tidy((title && title.trim()) || stem);
  const read = (text) => {
    const tokens = [];
    const stripped = text.replace(TOKEN_RE, (_m, kind, num) => {
      const key = kind.toLowerCase().replace(/\.$/, '');
      const n = numeral(num);
      if (n == null) return _m;
      tokens.push({ kind: key, rank: RANK[key], n, raw: num, label: `${LABEL[key]} ${num}` });
      return ' ';
    });
    return { tokens, rest: tidy(stripped.replace(/\s*-\s*Cleaned\b/i, ' ')) };
  };
  let { tokens, rest } = read(base);
  if (tokens.length === 0 && title) {
    // The title carried no tokens (perhaps Eden shortened it); the filename may.
    const fromFile = read(stem);
    if (fromFile.tokens.length) { tokens = fromFile.tokens; rest = rest || fromFile.rest; }
  }
  tokens.sort((a, b) => a.rank - b.rank);
  const cleanTitle = rest || tidy(stem.replace(/\s*-\s*Cleaned\b/i, ' ')) || stem;
  const rawLooking = !/\s/.test(cleanTitle) && /\d/.test(cleanTitle); // "treasureisland00steviala"
  return {
    filename: String(filename ?? ''),
    cleanTitle,
    collectionKey: tokens.length ? cleanTitle : null,
    tokens,
    sortKey: tokens.map((t) => t.n),
    partLabel: tokens.length ? tokens.map((t) => t.label).join(', ') : null,
    needsTitle: rawLooking,
  };
}

/** Eden's title from the CSV replaces the parsed words — and the collection
 *  key with them, so a set whose filename lost an apostrophe ("Russias
 *  Message") groups under the corrected title. The tokens stay. */
export function applyTitleOverride(parsed, title) {
  const t = title && String(title).trim();
  if (!t) return parsed;
  parsed.cleanTitle = t;
  if (parsed.tokens.length) parsed.collectionKey = t;
  parsed.needsTitle = false;
  return parsed;
}

/** The edition's display title: "Leaves of Grass, Vol. II" / "Farthest North, Vol. I, Part 2". */
export function displayTitle(parsed) {
  return parsed.partLabel ? `${parsed.cleanTitle}, ${parsed.partLabel}` : parsed.cleanTitle;
}

function compareKeys(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Group parsed items by collection and number the volumes 1..n in reading
 *  order ("a Vol with Parts counts Parts within the Vol"). Items are
 *  returned in place with `volume` set (null for a single). A collection of
 *  one (its sibling not yet filed) still gets volume 1 so the sibling can
 *  take 2 later. */
export function assignVolumes(items) {
  const groups = new Map();
  for (const it of items) {
    if (!it.parsed.collectionKey) { it.volume = null; continue; }
    const key = it.parsed.collectionKey.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const members of groups.values()) {
    members.sort((a, b) => compareKeys(a.parsed.sortKey, b.parsed.sortKey) || a.parsed.filename.localeCompare(b.parsed.filename));
    members.forEach((m, i) => { m.volume = i + 1; });
  }
  return items;
}

/** The same title filed twice — the raw scan and its " - Cleaned" copy
 *  (three such pairs on 2026-10-29). The cleaned copy is the edition; the
 *  raw sibling is marked `skip = 'raw duplicate of <cleaned filename>'`.
 *  Two cleaned copies (or two raw) of one title are left alone — both are
 *  mirrored, the second with a -2 slug — and reported by the caller. */
export function dropRawDuplicates(items) {
  const byKey = new Map();
  for (const it of items) {
    const k = `${it.parsed.cleanTitle.toLowerCase()}|${it.volume ?? ''}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(it);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const cleaned = group.filter((g) => /\s-\s*Cleaned\b/i.test(g.parsed.filename));
    const raw = group.filter((g) => !/\s-\s*Cleaned\b/i.test(g.parsed.filename));
    if (cleaned.length >= 1 && raw.length >= 1) {
      for (const r of raw) r.skip = `raw duplicate of ${cleaned[0].parsed.filename}`;
    }
    // The very same file filed twice (one double upload on 2026-10-29): the
    // first filed is the edition, the later copies are skipped.
    const byFile = new Map();
    for (const g of group.filter((x) => !x.skip)) {
      const f = g.parsed.filename.toLowerCase();
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(g);
    }
    for (const same of byFile.values()) {
      if (same.length < 2) continue;
      same.sort((a, b) => String(a.filedAt ?? '').localeCompare(String(b.filedAt ?? '')));
      for (const later of same.slice(1)) later.skip = `the same file filed again (first filed ${String(same[0].filedAt ?? '').slice(0, 10) || 'earlier'})`;
    }
  }
  return items;
}

/** D13: the sample is 10% of the pages, floor 8, ceiling 30, never more
 *  than the book has. */
export function sampleLength(pageCount) {
  const n = Math.max(0, Number(pageCount) || 0);
  if (n === 0) return 0;
  const tenth = Math.round(n / 10);
  return Math.min(n, Math.max(8, Math.min(30, tenth)));
}

/** 112's slug rule: lower-case words and digits joined by single hyphens,
 *  3–80 characters. `taken` is the set of slugs already in use; a collision
 *  takes -2, -3, … */
export function slugFor(title, volume, taken = new Set()) {
  let words = String(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (volume) words = `${words}-vol-${volume}`;
  words = words.slice(0, 72).replace(/-+$/g, '');
  if (words.length < 3) words = `edition-${words}`.replace(/-+$/g, '');
  let slug = words;
  let i = 2;
  while (taken.has(slug)) { slug = `${words}-${i}`; i += 1; }
  return slug;
}

/** The release queue (D17): up to `perDay` editions a day from `from`, in
 *  the order given, a collection kept together on one day (it may push that
 *  day over the limit rather than split a set). Returns a Map id → ISO date. */
export function queueDays(items, from, perDay = 3) {
  const out = new Map();
  const start = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`release-from is not a date: ${from}`);
  let day = 0;
  let used = 0;
  const dateOf = (d) => new Date(start.getTime() + d * 86_400_000).toISOString().slice(0, 10);
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it)) continue;
    const set = it.parsed.collectionKey
      ? items.filter((o) => o.parsed.collectionKey && o.parsed.collectionKey.toLowerCase() === it.parsed.collectionKey.toLowerCase())
      : [it];
    if (used > 0 && used + set.length > perDay) { day += 1; used = 0; }
    for (const m of set) { out.set(m, dateOf(day)); seen.add(m); }
    used += set.length;
    if (used >= perDay) { day += 1; used = 0; }
  }
  return out;
}

/** The CSV Eden fills once (D18): one row per document, author and title
 *  editable. Quoted the plain way; a double quote inside is doubled. */
export const AUTHORS_CSV_HEADER = 'document_id,filename,title,author';

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function parseAuthorsCsv(text) {
  const rows = new Map();
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines.slice(1)) {
    const cells = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') { inQ = false; } else { cur += c; }
      } else if (c === '"') { inQ = true; } else if (c === ',') { cells.push(cur); cur = ''; } else { cur += c; }
    }
    cells.push(cur);
    const [document_id, filename, title, author] = cells.map((c) => c.trim());
    if (document_id) rows.set(document_id, { filename, title: title || null, author: author || null });
  }
  return rows;
}

export function renderAuthorsCsv(rows) {
  const lines = [AUTHORS_CSV_HEADER];
  for (const r of rows) lines.push([r.document_id, r.filename, r.title, r.author].map(csvEscape).join(','));
  return lines.join('\n') + '\n';
}

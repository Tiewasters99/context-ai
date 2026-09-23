// Westlaw star pages → the reporter page every passage of an opinion sits on.
//
// A Westlaw download (PDF, .docx, .rtf, or .doc) does not paginate like the
// book. It marks, inline, the point where each reporter page begins:
//
//     … statutes designed to prevent *561 very different kinds of harm …
//
// "*561" means: from here on, 45 N.Y.2d page 561. A second and third
// reporter, when the case has parallel cites, are "**" and "***". Before
// 2026-09-23 the index ignored all of this: a .docx opinion was one "page",
// so every cite read "p. 1", and a PDF opinion cited the PDF's sheet. This
// module reads the markers so a passage can cite the page a lawyer would
// write ("…, 562"). Eden, 2026-09-23: "pincites should work for every
// Westlaw document in the vault".
//
// WHAT IS A MARKER AND WHAT IS NOT
// ---------------------------------------------------------------------------
// The text also CITES other cases' star pages, and those look the same:
//     "2019 WL 1234567, at *3"      "2019 WL 1234567, *3"      "id. at *4"
// Measured on 251 Westlaw documents in the Vault: excluding "at *N" and
// "<number>, *N" leaves 220 whose markers only ever go up. So a candidate is
// accepted only if it CONTINUES the run — greater than the page we are on,
// and at most MAX_STEP ahead of it. Anything else is a cite in the text and is
// skipped. The run is the evidence; a single regex is not.
//
// WHAT IS NOT CLAIMED (a printed page never appears beside a doubt)
// ---------------------------------------------------------------------------
//   - the footnotes. Westlaw prints them after the opinion, under a
//     "Footnotes" heading, and their text sits on whichever page the
//     footnote was called from — which this order does not say. Passages
//     there get no page.
//   - text before the first marker, unless the header's own citation names
//     the page it starts on ("45 N.Y.2d 560" before "*561"). No guessing
//     "first marker minus one".
//   - a document whose markers restart (a second opinion paginated on its
//     own, detected as a rejected run of consecutive pages): declined whole.
//
// Pure: no I/O. Input is the passages of ONE document in reading order.

export const METHOD = 'westlaw_star';

// "© 2026 Thomson Reuters. No claim to original U.S. Government Works." is
// on every Westlaw delivery, whatever the format; a brief that merely cites
// Westlaw does not carry it.
const WESTLAW_FOOTER = /no claim to original u\.\s?s\.\s?government works/i;

// How far ahead of the current page the next marker may be. Westlaw skips a
// page number only when a reporter page held nothing but a headnote or a
// table; three covers that without letting an unrelated cite hop the run.
export const MAX_STEP = 3;

const MARKER = /(\*{1,3})(\d{1,5})(?=\s|$)/g;
const FOOTNOTES_HEADING = /(^|\n)[ \t]*footnotes[ \t]*(\r?\n|$)/i;

/** True when the text carries Westlaw's delivery footer. */
export function isWestlawText(text) {
  return WESTLAW_FOOTER.test(String(text || ''));
}

// Is the marker at `index` in `text` a citation of someone else's star page?
function isCiteNotMarker(text, index, stars) {
  // A marker stands on its own: whitespace (or the start) before the stars.
  if (index > 0 && !/\s/.test(text[index - 1])) return true;
  const before = text.slice(Math.max(0, index - 40), index);
  if (/\bat\s*$/i.test(before)) return true;           // "… at *3", "at\n*3"
  if (/\d,\s*$/.test(before)) return true;             // "2019 WL 1234567, *3"
  if (/\b(n|nn|fn)\.?\s*$/i.test(before)) return true; // "n. *3" (rare)
  if (stars.length > 1 && /\*\s*$/.test(before)) return true;
  return false;
}

// The header's own cite: "45 N.Y.2d 560" whose page is just before `firstPage`.
function headerStartPage(headText, firstPage) {
  const re = /\b(\d{1,4})\s+([A-Z][A-Za-z0-9.&'’ ]{0,24}?)\s+(\d{1,5})\b/g;
  let m;
  while ((m = re.exec(headText))) {
    const start = Number(m[3]);
    if (start < firstPage && firstPage - start <= MAX_STEP && /[A-Za-z]/.test(m[2])) return start;
  }
  return null;
}

/**
 * Reporter pages for each passage of one Westlaw document.
 *
 * @param {{ text: string }[]} passages one document's passages, reading order.
 * @returns {{
 *   claimed: boolean,
 *   reason: string,
 *   first: number|null, last: number|null, markers: number, rejected: number, skipped?: number,
 *   pages: ({ printed_page: number, printed_page_end: number,
 *             star_pages?: Record<string, [number, number]> } | null)[],
 * }} `pages[i]` is for `passages[i]`; null where nothing is claimed.
 */
export function westlawStarPages(passages) {
  const list = Array.isArray(passages) ? passages : [];
  const none = (reason, extra = {}) => ({
    claimed: false, reason, first: null, last: null, markers: 0, rejected: 0,
    pages: list.map(() => null), ...extra,
  });
  if (list.length === 0) return none('no passages');
  if (!list.some((p) => isWestlawText(p?.text))) return none('not a Westlaw delivery (no Thomson Reuters footer)');

  // Where the footnotes start: [passage index, offset in its text].
  let fnAt = null;
  for (let i = 0; i < list.length && !fnAt; i++) {
    const m = FOOTNOTES_HEADING.exec(String(list[i]?.text || ''));
    if (m) fnAt = [i, m.index];
  }

  // Walk every marker once, per level, in reading order.
  const cur = { 1: null, 2: null, 3: null };
  const accepted = { 1: 0, 2: 0, 3: 0 };
  const rejectedRun = { 1: [], 2: [], 3: [] };   // rejected level-N values, in order
  const firstSeen = {};
  const firstAt = {};   // passage index of each level's first marker
  // per passage: pages at its start and end, per level
  const spans = list.map(() => ({ start: { ...cur }, end: null, hasMarker: false }));
  let restart = false;
  let skipped = 0;   // level-1 "*N" that read as a cite of another case

  for (let i = 0; i < list.length; i++) {
    spans[i].start = { ...cur };
    const text = String(list[i]?.text || '');
    const stop = fnAt && fnAt[0] === i ? fnAt[1] : (fnAt && i > fnAt[0] ? 0 : text.length);
    MARKER.lastIndex = 0;
    let m;
    while ((m = MARKER.exec(text))) {
      if (m.index >= stop) break;
      const stars = m[1];
      const level = stars.length;
      const n = Number(m[2]);
      if (isCiteNotMarker(text, m.index, stars)) { if (level === 1) skipped++; continue; }
      const c = cur[level];
      if (c === null ? n > 0 : n > c && n - c <= MAX_STEP) {
        if (c === null) { firstSeen[level] = n; firstAt[level] = i; }
        cur[level] = n;
        accepted[level]++;
        spans[i].hasMarker = true;
      } else {
        const r = rejectedRun[level];
        r.push(n);
        // Three rejected values in a row, each one more than the last, is a
        // second pagination (an appended opinion), not stray cites.
        const k = r.length;
        if (k >= 3 && r[k - 1] === r[k - 2] + 1 && r[k - 2] === r[k - 3] + 1) restart = true;
      }
    }
    spans[i].end = { ...cur };
  }

  const markers = accepted[1];
  const rejected = rejectedRun[1].length;
  if (markers === 0) return none('Westlaw delivery with no star pages (unpaginated, or pages not marked)');
  if (restart) return none('star pages restart part-way (a second opinion paginated on its own) — not claimed', { markers, rejected });
  if (rejected > markers) return none('more stray star numbers than page markers — not claimed', { markers, rejected });

  // The page the text before each level's first marker is on, from the
  // header's own cite for that reporter — or unknown.
  const headFor = (idx) => list.slice(0, idx + 1).map((p) => String(p?.text || '')).join('\n').slice(0, 4000);
  const startOf = {};
  for (const level of [1, 2, 3]) {
    if (accepted[level]) startOf[level] = headerStartPage(headFor(firstAt[level]), firstSeen[level]);
  }
  const startPage = startOf[1] ?? null;
  const pageAt = (s, i, level) => {
    const a = s.start[level] ?? (i <= firstAt[level] ? startOf[level] ?? null : null);
    const b = s.end[level] ?? a;
    return a === null || b === null ? null : [a, b];
  };

  const pages = spans.map((s, i) => {
    if (fnAt && (i > fnAt[0] || (i === fnAt[0] && fnAt[1] === 0))) return null;
    const main = pageAt(s, i, 1);
    if (!main) return null;
    const out = { printed_page: main[0], printed_page_end: main[1] };
    const par = {};
    for (const level of [2, 3]) {
      if (!accepted[level]) continue;
      const r = pageAt(s, i, level);
      if (r) par[String(level)] = r;
    }
    if (Object.keys(par).length) out.star_pages = par;
    return out;
  });

  return {
    claimed: true,
    reason: `${markers} star page${markers === 1 ? '' : 's'}, ${firstSeen[1]}–${cur[1]}` +
      (startPage !== null ? `; opens on ${startPage} (header cite)` : '') +
      (rejected + skipped ? `; ${rejected + skipped} cite${rejected + skipped === 1 ? '' : 's'} in the text skipped` : '') +
      (fnAt ? '; footnotes not paged' : ''),
    first: startPage ?? firstSeen[1],
    last: cur[1],
    markers,
    rejected,
    skipped,
    // Where each star level's run starts and ends, so a caller can tell which
    // header reporter a level belongs to (lib/bluebook.mjs matches them by
    // page, not by position: New York Official Reports use "**" for other
    // things).
    levels: Object.fromEntries([1, 2, 3].filter((l) => accepted[l])
      .map((l) => [l, { first: startOf[l] ?? firstSeen[l], last: cur[l] }])),
    pages,
  };
}

/**
 * The `passages.metadata` keys lib/cite-page.mjs reads, for one passage.
 * `pdfPage` is the passage's own page_start — what the Reader opens.
 */
export function westlawPageMeta(page, pdfPage) {
  if (!page) return null;
  return {
    printed_page: page.printed_page,
    printed_page_end: page.printed_page_end,
    pdf_page: pdfPage ?? null,
    page_source: 'printed',
    printed_page_confidence: 'high',
    printed_page_method: METHOD,
    ...(page.star_pages ? { star_pages: page.star_pages } : {}),
  };
}

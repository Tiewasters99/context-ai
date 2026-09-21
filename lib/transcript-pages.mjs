// -----------------------------------------------------------------------------
// The reporter's printed page, per PDF page.
//
// THE BUG THIS EXISTS FOR (recorded 2026-09-19, system-wide since 2026-05-29)
// -----------------------------------------------------------------------------
// A full-size transcript's `page_start` has always been the PDF's page INDEX.
// Only a condensed 4-up sheet ever read the reporter's own "Page N" marker.
// So:
//
//   * a clean transcript PDF — index and printed page happen to agree, and the
//     cite is right by luck;
//   * the same transcript wrapped as an exhibit — one slip sheet in front, and
//     every cite in the document is one page high (PDF p. 16 = transcript
//     p. 15);
//   * volume 2 of a multi-volume deposition — printed page 214 sits on PDF
//     page 1, and every cite is off by 213;
//   * a transcript printed to a text file — no correspondence at all.
//
// A citation that is off by one is far more dangerous than one that is
// obviously broken: "Blake Dep. 16:4" reads like a real cite, gets typed into
// a brief, and points at the wrong answer. So this module reads the number the
// reporter PRINTED, and when it cannot read it with confidence it says so and
// claims nothing.
//
// METHOD
// -----------------------------------------------------------------------------
//   1. CANDIDATES. On each transcript page, look only where a page number is
//      printed — above the line-number column (the header zone) and below it
//      (the footer zone) — and take every 1-4 digit token there, scored by how
//      page-number-shaped it is ("Page 15" > "15" alone on a line > digits at
//      the end of a header line > an OCR-mangled "l5").
//   2. FIT. Reporter pages step by exactly +1, so printed = pdf_index + offset
//      over a contiguous run. Pick the offset each page's evidence agrees on
//      (globally popular offsets outvote one-off noise), cut the document into
//      runs of constant offset, and keep only runs with real evidence behind
//      them. Front matter changes the offset once; an exhibit slip sheet makes
//      it -1 for the whole document; volume 2 makes it +213.
//   3. VERDICT. A page with no readable number INSIDE a kept run is recovered
//      from the run (that is how an OCR page that reads "I5" or nothing at all
//      is cited correctly). A page outside every run — the caption, the index,
//      the errata, a slip sheet — gets nothing. Coverage, evidence count, the
//      number of runs and a line-numbering cross-check set the confidence, and
//      only `high` is ever allowed to claim a printed page.
//
// Nothing here is a guess dressed as a fact. Low confidence means the passage
// keeps the PDF index and is marked as carrying the PDF index.
// -----------------------------------------------------------------------------

/** Confidence levels, most to least. Only `high` claims a printed page. */
export const CONFIDENCE = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  NONE: 'none',
});

/** How the printed page was arrived at. */
export const METHOD = Object.freeze({
  CONDENSED: 'condensed_marker',
  SEQUENCE: 'sequence_fit',
  NONE: 'none',
});

// A run needs this much before it is believed at all.
const MIN_RUN_EVIDENCE = 3;
const MIN_RUN_SPAN = 3;
// ...and the document needs this much before `high` is available.
const HIGH_MIN_EVIDENCE = 6;
const HIGH_MIN_COVERAGE = 0.7;
const HIGH_MAX_RUNS = 3;
const MEDIUM_MIN_EVIDENCE = 3;
const MEDIUM_MIN_COVERAGE = 0.5;
// Line numbers that keep climbing across a page boundary mean the "pages" are
// not the reporter's pages. A quarter of the boundaries is already too many.
const LINE_CONFLICT_RATIO = 0.25;

const MAX_PAGE_NUMBER = 9999;
// How many lines above / below the line-number column can hold the page
// number. Reporters use one; OCR sometimes splits a header in two.
const ZONE_LINES = 4;

// A line of the reporter's line-number column: "12   Q.  Where were you" — or
// a bare "12" on a blank numbered line. Mirrors parseTranscriptPage's regex.
const NUMBERED_LINE_RE = /^[ \t]{0,6}(\d{1,2})(?:[ \t]{1,6}(.*))?$/;

/**
 * OCR reads "15" as "l5", "I5", "1S" and "l5" again. Map the four letters that
 * are actually confusable with digits, and only accept the result when the
 * token already held at least one real digit — "IS" and "OS" are words.
 */
function readNoisyNumber(token) {
  if (!/[0-9]/.test(token)) return null;
  const mapped = token
    .replace(/[lI|i]/g, '1')
    .replace(/[OoQ]/g, '0')
    .replace(/[Ss]/g, '5')
    .replace(/B/g, '8');
  if (!/^\d{1,4}$/.test(mapped)) return null;
  const n = parseInt(mapped, 10);
  return n >= 1 && n <= MAX_PAGE_NUMBER ? n : null;
}

function plainNumber(token) {
  if (!/^0*\d{1,5}$/.test(token)) return null;
  const n = parseInt(token, 10);
  return n >= 1 && n <= MAX_PAGE_NUMBER ? n : null;
}

/**
 * The header and footer zones of one page: the lines that sit outside the
 * reporter's line-number column, which is the only place a page number is
 * printed. A page with no numbers in its text layer (Veritext) has no column
 * to bound the zones, so the first and last couple of lines stand in.
 */
export function pageZones(pageText) {
  const raw = String(pageText || '').replace(/[· ]/g, ' ').split('\n');
  let firstNum = -1;
  let lastNum = -1;
  for (let i = 0; i < raw.length; i++) {
    const m = NUMBERED_LINE_RE.exec(raw[i]);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n < 1 || n > 40) continue;
    if (firstNum < 0 && n <= 2) firstNum = i;
    lastNum = i;
  }
  const nonEmpty = (from, to) => {
    const out = [];
    for (let i = from; i <= to && i < raw.length; i++) {
      if (i < 0) continue;
      const t = raw[i].trim();
      if (t) out.push(t);
    }
    return out;
  };
  if (firstNum < 0 || lastNum < 0 || lastNum <= firstNum) {
    // No line-number column. Take the first and last two non-empty lines.
    const all = raw.map((l) => l.trim()).filter(Boolean);
    return { header: all.slice(0, 2), footer: all.slice(-2) };
  }
  return {
    header: nonEmpty(Math.max(0, firstNum - ZONE_LINES), firstNum - 1),
    footer: nonEmpty(lastNum + 1, lastNum + ZONE_LINES),
  };
}

/**
 * Every page-number-shaped token in one page's zones, with a score for how
 * page-number-shaped it is. Liberal on purpose: the sequence fit in step 2 is
 * what rejects an exhibit sticker, a phone number in the reporter's footer and
 * an OCR misread. A strict candidate rule would instead throw away the one
 * page that breaks a tie.
 */
export function pageNumberCandidates(pageText) {
  const { header, footer } = pageZones(pageText);
  const byValue = new Map();
  const add = (value, score) => {
    if (value == null) return;
    if (!byValue.has(value) || byValue.get(value) < score) byValue.set(value, score);
  };
  for (const line of [...header, ...footer]) {
    // "Page 15", "Page 15 of 240", "PAGE 15" — the reporter saying it outright.
    const labelled = /\bpages?\s+(\d{1,4})\b/i.exec(line);
    if (labelled) add(plainNumber(labelled[1]), 3);
    // "15" or "00015" alone on its own line.
    const alone = /^0*(\d{1,4})$/.exec(line);
    if (alone) add(plainNumber(alone[1]), 2);
    // A running header with the number set to the right: the PDF text layer
    // joins the baseline into one line, so it arrives as "DESMOND BLAKE   15".
    const trailing = /([A-Za-z0-9|]{1,5})\s*$/.exec(line);
    if (trailing && !alone) {
      const exact = plainNumber(trailing[1]);
      if (exact != null) add(exact, 1);
      else add(readNoisyNumber(trailing[1]), 1);
    }
    if (alone) add(readNoisyNumber(line), 1);
  }
  return [...byValue.entries()].map(([value, score]) => ({ value, score }));
}

/**
 * Cut the document into runs of constant offset.
 *
 * Each page votes with its candidates; a candidate's offset is weighted by how
 * often that same offset appears anywhere in the document, so one page whose
 * best-looking token is noise is outvoted by the twelve pages that agree. A
 * run is then a maximal stretch of pages choosing the same offset; pages with
 * no candidate at all do not break a run, they are simply carried by it.
 */
function fitRuns(facts) {
  const weight = new Map();
  for (const f of facts) {
    for (const c of f.candidates) {
      const off = c.value - f.pdfPage;
      weight.set(off, (weight.get(off) || 0) + c.score);
    }
  }
  const chosen = facts.map((f) => {
    let best = null;
    for (const c of f.candidates) {
      const off = c.value - f.pdfPage;
      // A printed page number is never zero or negative.
      if (f.pdfPage + off < 1) continue;
      const rank = (weight.get(off) || 0) * 10 + c.score;
      if (!best || rank > best.rank) best = { offset: off, score: c.score, rank };
    }
    return best;
  });

  const runs = [];
  let cur = null;
  for (let i = 0; i < facts.length; i++) {
    const c = chosen[i];
    if (!c) continue;                       // a gap does not end a run
    if (cur && cur.offset === c.offset) {
      cur.lastEvidence = i;
      cur.evidence += 1;
    } else {
      if (cur) runs.push(cur);
      cur = { offset: c.offset, firstEvidence: i, lastEvidence: i, evidence: 1 };
    }
  }
  if (cur) runs.push(cur);
  // Trim to the evidence: pages beyond the outermost page that actually showed
  // a number belong to no run, however tempting the extrapolation.
  return runs.filter((r) =>
    r.evidence >= MIN_RUN_EVIDENCE &&
    (r.lastEvidence - r.firstEvidence + 1) >= MIN_RUN_SPAN);
}

/**
 * Do the line numbers reset at each page boundary?
 *
 * They must: line 1 of the reporter's page 16 follows line 25 of page 15. If
 * they keep climbing, whatever produced these "pages" was not the reporter and
 * the page numbers above them cannot be trusted either. Pages numbered BY
 * POSITION (PR #138's `line_numbers: 'inferred'`) always start at 1 by
 * construction, so checking them would only manufacture reassurance — they are
 * skipped.
 */
function lineNumbersReset(facts) {
  const checkable = facts.filter((f) => f.isTranscript && !f.inferred && f.minLine != null && f.maxLine != null);
  let pairs = 0;
  let violations = 0;
  for (let i = 1; i < checkable.length; i++) {
    const prev = checkable[i - 1];
    const next = checkable[i];
    if (next.pdfPage !== prev.pdfPage + 1) continue;
    pairs += 1;
    if (next.minLine > prev.maxLine) violations += 1;
  }
  return { pairs, violations, conflict: pairs >= 4 && violations / pairs > LINE_CONFLICT_RATIO };
}

/**
 * Read the reporter's printed page for every page of a document.
 *
 * @param {{pageNumber:number, text:string}[]} pages   as extractPages returns them
 * @param {(null|{chunks:object[], condensed:boolean})[]} parsed  parseTranscriptPage per page
 * @returns {object} the verdict — see METHOD/CONFIDENCE above
 */
export function detectPrintedPages(pages, parsed = []) {
  const facts = pages.map((p, i) => {
    const t = parsed[i] || null;
    const chunks = t?.chunks || [];
    const lineNums = chunks.map((c) => c.line_start).filter((n) => typeof n === 'number' && n > 0);
    const lineEnds = chunks.map((c) => c.line_end).filter((n) => typeof n === 'number' && n > 0);
    return {
      index: i,
      pdfPage: p.pageNumber,
      isTranscript: !!t,
      condensed: !!t?.condensed,
      inferred: chunks.some((c) => c.metadata?.line_numbers === 'inferred'),
      minLine: lineNums.length ? Math.min(...lineNums) : null,
      maxLine: lineEnds.length ? Math.max(...lineEnds) : null,
      candidates: [],
    };
  });

  const transcriptFacts = facts.filter((f) => f.isTranscript);
  const base = {
    is_transcript: transcriptFacts.length > 0,
    method: METHOD.NONE,
    confidence: CONFIDENCE.NONE,
    claimed: false,
    pages_total: pages.length,
    transcript_pages: transcriptFacts.length,
    evidence_pages: 0,
    mapped_pages: 0,
    segments: [],
    conflicts: [],
    map: new Map(),
  };

  if (transcriptFacts.length === 0) {
    return { ...base, reason: 'not a transcript — no page of this document parsed as one' };
  }

  // ---- Condensed sheets: the reporter already printed it on every panel ----
  // Four transcript pages per sheet, each panel headed "Page 34". There is no
  // pdf → printed function to fit here, and parseTranscriptPage has carried
  // the panel's own page since PR #140. Do not touch it.
  const condensedCount = transcriptFacts.filter((f) => f.condensed).length;
  if (condensedCount * 2 >= transcriptFacts.length) {
    return {
      ...base,
      method: METHOD.CONDENSED,
      confidence: CONFIDENCE.HIGH,
      claimed: true,
      evidence_pages: condensedCount,
      mapped_pages: condensedCount,
      reason: `condensed 4-up sheets — the reporter's printed page is marked on each panel of ${condensedCount} of ${transcriptFacts.length} transcript page(s)`,
    };
  }

  // ---- Candidates, then the fit -------------------------------------------
  for (const f of transcriptFacts) f.candidates = pageNumberCandidates(pages[f.index].text);
  const runs = fitRuns(transcriptFacts);

  if (runs.length === 0) {
    const sawAny = transcriptFacts.some((f) => f.candidates.length > 0);
    return {
      ...base,
      reason: sawAny
        ? `no page number ran +1 across ${MIN_RUN_SPAN} or more pages — the tokens found do not form a sequence`
        : 'no page number is printed outside the line-number column on any page',
    };
  }

  const map = new Map();
  const segments = [];
  let evidencePages = 0;
  for (const r of runs) {
    const from = transcriptFacts[r.firstEvidence];
    const to = transcriptFacts[r.lastEvidence];
    for (let i = r.firstEvidence; i <= r.lastEvidence; i++) {
      const f = transcriptFacts[i];
      map.set(f.pdfPage, f.pdfPage + r.offset);
    }
    evidencePages += r.evidence;
    segments.push({
      from_pdf: from.pdfPage,
      to_pdf: to.pdfPage,
      offset: r.offset,
      printed_from: from.pdfPage + r.offset,
      printed_to: to.pdfPage + r.offset,
      evidence: r.evidence,
    });
  }

  // ---- Cross-checks --------------------------------------------------------
  const conflicts = [];
  const lines = lineNumbersReset(transcriptFacts);
  if (lines.conflict) {
    conflicts.push(`line numbers do not reset at ${lines.violations} of ${lines.pairs} page boundaries`);
  }
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].printed_from <= segments[i - 1].printed_to) {
      conflicts.push(`printed pages run backwards between PDF p. ${segments[i - 1].to_pdf} and p. ${segments[i].from_pdf}`);
    }
  }

  const mapped = map.size;
  const coverage = mapped / transcriptFacts.length;
  let confidence = CONFIDENCE.LOW;
  if (
    conflicts.length === 0 &&
    evidencePages >= HIGH_MIN_EVIDENCE &&
    coverage >= HIGH_MIN_COVERAGE &&
    segments.length <= HIGH_MAX_RUNS
  ) confidence = CONFIDENCE.HIGH;
  else if (evidencePages >= MEDIUM_MIN_EVIDENCE && coverage >= MEDIUM_MIN_COVERAGE) confidence = CONFIDENCE.MEDIUM;

  const shape = segments
    .map((s) => `PDF ${s.from_pdf}–${s.to_pdf} → printed ${s.printed_from}–${s.printed_to} (offset ${s.offset >= 0 ? '+' : ''}${s.offset})`)
    .join('; ');
  const reason = `printed page read on ${evidencePages} of ${transcriptFacts.length} transcript page(s); ${shape}`
    + (conflicts.length ? ` — ${conflicts.join('; ')}` : '');

  return {
    ...base,
    method: METHOD.SEQUENCE,
    confidence,
    claimed: confidence === CONFIDENCE.HIGH,
    evidence_pages: evidencePages,
    mapped_pages: mapped,
    segments,
    conflicts,
    map,
    reason,
  };
}

/**
 * The verdict as it is written to `documents.metadata.transcript_pages` — the
 * Map dropped, so a later audit can list every transcript still cited by the
 * PDF index without re-parsing a single file.
 */
export function verdictForDocument(verdict) {
  const { map: _map, ...rest } = verdict;
  return { ...rest, detected_at: new Date().toISOString() };
}

/** The printed page for one PDF page, or null when nothing is claimed. */
export function printedPageFor(verdict, pdfPage) {
  if (!verdict?.claimed) return null;
  const n = verdict.map?.get(pdfPage);
  return typeof n === 'number' && n > 0 ? n : null;
}

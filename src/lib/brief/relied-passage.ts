// The language a brief relies on, found at the pincite (Ty via Eden, 10-16).
//
// When the desk opens a cite beside the brief, the Reader goes to the pinned
// page; this module chooses WHICH words on that page to light. It is pure —
// strings in, strings out — so the same rules run in the Reader and in the
// tests.
//
//   claimFor(context, cite)      the brief's side: the words before the cite
//                                 (its sentence, or the sentence before when
//                                 the cite stands alone) and any quotes in them
//   pickRelied(claim, passages)  the source's side: a quote found verbatim
//                                 ('quote'), else the sentence sharing the
//                                 most words, above a cutoff ('closest'), else
//                                 nothing ('none') — a guess is never shown as
//                                 a match
//   depoLines(passages, cite)    a deposition cite's lines, page:line to
//                                 page:line ('lines')
//   locatePhrase(text, phrase)   where a chosen phrase sits in the rendered
//                                 text (a PDF page's text layer, a Word file),
//                                 tolerant of punctuation, line numbers and
//                                 words hyphenated across a line
//
// Deterministic: no model. Paraphrase is fuzzy, so the cutoff decides.

export type ReliedBasis = 'quote' | 'closest' | 'lines' | 'none';

/** What the desk asks the Reader to light: the brief's side of the match. */
export interface ReliedAsk {
  /** The words the brief says (the proposition), without the cite. */
  claim: string;
  /** Quoted spans in the claim, as the brief has them. */
  quotes: string[];
  /** A deposition cite's lines (page:line to page:line). */
  depo?: { page: number; line: number | null; endPage: number | null; endLine: number | null } | null;
  /**
   * The document IS the authority (a rule or statute filed under its own
   * name, opened at its first page): look for the brief's quotes through the
   * whole document, not a pinned page. Quotes only — a "closest sentence"
   * anywhere in a document would be a guess, so `claim` is sent empty.
   */
  anywhere?: boolean;
}

export interface ReliedPassage {
  id: string;
  text: string;
  /** The page the passage sits on, for the painter (a PDF's physical page). */
  page?: number | null;
  /** Transcript coordinates, when the passage carries them. */
  page_start?: number | null;
  line_start?: number | null;
  line_end?: number | null;
}

export interface ReliedPick {
  basis: ReliedBasis;
  /** The words to light, each a substring of one passage's text, in reading order. */
  phrases: { passageId: string; page: number | null; text: string }[];
  /** For the caveat: how much of the claim the pick shares (closest), or the lines (depo). */
  detail: string | null;
}

// ── Tokens ───────────────────────────────────────────────────────────────

interface Tok { w: string; start: number; end: number }

/** Words with their offsets: runs of letters and digits, lower-cased. */
export function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

// A token the rendered text carries but a phrase does not: a transcript's
// line number, a star page ("*259"), a footnote call. Skipped while aligning.
const skippable = (w: string) => /^\d{1,3}$/.test(w);

/**
 * Where `phrase` sits in `text`, as offsets into `text`, or null. Words are
 * compared without case or punctuation; between two of the phrase's words the
 * text may carry short numbers (line numbers, star pages); a word broken
 * across a line ("con- tract") matches whole. A long phrase that will not
 * align whole is found by its first and last words, when both are found in
 * order within a reasonable distance. `from` starts the search at an offset.
 */
export function locatePhrase(text: string, phrase: string, from = 0): { start: number; end: number } | null {
  const need = tokens(normalizeQuote(phrase)).map((t) => t.w);
  if (!need.length) return null;
  const hay = tokens(text).filter((t) => t.start >= from);
  const whole = align(hay, need, 0, need.length);
  if (whole) return whole;
  // Ends: the first and last few words, in order, not too far apart.
  if (need.length >= 8) {
    const k = Math.min(5, Math.floor(need.length / 3));
    const head = align(hay, need, 0, k);
    if (head) {
      const after = hay.filter((t) => t.start >= head.end);
      const tail = align(after, need, need.length - k, need.length);
      if (tail) {
        const span = hay.filter((t) => t.start >= head.start && t.end <= tail.end).length;
        if (span <= need.length * 1.6 + 6) return { start: head.start, end: tail.end };
      }
    }
  }
  return null;
}

// need[a..b) aligned at the first place in hay it fits.
function align(hay: Tok[], need: string[], a: number, b: number): { start: number; end: number } | null {
  for (let i = 0; i < hay.length; i++) {
    const end = alignAt(hay, i, need, a, b);
    if (end !== null) return { start: hay[i].start, end };
  }
  return null;
}
function alignAt(hay: Tok[], i: number, need: string[], a: number, b: number): number | null {
  let h = i;
  let n = a;
  let last = -1;
  while (n < b) {
    if (h >= hay.length) return null;
    const w = hay[h].w;
    if (w === need[n]) { last = hay[h].end; h++; n++; continue; }
    // "con- tract": two pieces of the text make one word of the phrase.
    if (h + 1 < hay.length && need[n].startsWith(w) && w + hay[h + 1].w === need[n]) { last = hay[h + 1].end; h += 2; n++; continue; }
    // "contract" in the text, "con tract" in the phrase: the reverse.
    if (n + 1 < b && w === need[n] + need[n + 1]) { last = hay[h].end; h++; n += 2; continue; }
    // A line number or star page between two words (never before the first).
    if (n > a && skippable(w) && !skippable(need[n])) { h++; continue; }
    return null;
  }
  return last;
}

// ── The brief's side ─────────────────────────────────────────────────────

// Curly quotes and dashes to plain; "[t]he" to "the" (an alteration of one
// letter is the source's own word). A longer bracket stays: it is the brief's
// words, not the source's, and quoteSegments splits there.
export function normalizeQuote(s: string): string {
  return s
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\[(\p{L})\]/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A quote's pieces the source must carry: split at ellipses and at the brief's own bracketed words. */
export function quoteSegments(quote: string): string[] {
  return normalizeQuote(quote)
    .split(/\s*(?:\.\s*\.\s*\.|…|\[[^\]]*\])\s*/)
    .map((s) => s.replace(/^[\s.,;:'"]+|[\s,;:'"]+$/g, '').trim())
    .filter((s) => tokens(s).length >= 3);
}

// Words that end in a period without ending a sentence.
const ABBREV = new Set([
  'v', 'vs', 'id', 'ibid', 'cir', 'inc', 'co', 'corp', 'ltd', 'llc', 'no', 'nos', 'dr', 'mr', 'ms', 'mrs', 'op', 'br',
  'dep', 'pet', 'compl', 'e.g', 'i.e', 'eg', 'ie', 'cf', 'app', 'supp', 'ct', 'st', 'dist', 'dept', 'div', 'sec', 'art',
  'ch', 'pl', 'para', 'ex', 'exh', 'tr', 'vol', 'ed', 'rev', 'stat', 'ann', 'u.s', 'u.s.c', 'f', 'cal', 'n.y', 'misc',
  'ad', 'jr', 'sr', 'bros', 'assn', "ass'n", 'gov', 'govt', 'univ', 'sch', 'hosp', 'comm', 'miss', 'ala', 'tex', 'fla',
  'pa', 'mass', 'conn', 'mich', 'ill', 'ohio', 'wash', 'colo', 'nev', 'ariz', 'tenn', 'va', 'ga', 'la', 'md', 'mo', 'nj',
  'roa', 'aff', 'decl', 'mem', 'mot', 'opp', 'reply', 'resp', 'add', 'appx', 'r', 'fed', 'civ', 'crim', 'evid', 'p',
]);

/** Offsets in `text` where a sentence ends (just past its closing mark and quote). */
export function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  // A footnote call may follow the mark: "(denial of a land use permit).5 In light …".
  const re = /[.?!]["'”’)\]]*(?:\d{1,2}(?=\s+\p{Lu}))?(?=\s+["'“‘(]?[\p{Lu}\d])/gu;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0][0] === '.') {
      // The word before the period: an abbreviation does not end a sentence.
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      const word = /([\p{L}.'’]+)$/u.exec(before)?.[1] ?? '';
      const bare = word.toLowerCase().replace(/’/g, "'").replace(/^\.+/, '');
      if (ABBREV.has(bare) || ABBREV.has(bare.replace(/\./g, ''))) continue;
      // A single capital ("J. Smith", "F. Supp.") or a short capitalised word
      // ("Miss.", "Comm.") reads as part of a name or a reporter.
      if (/^\p{Lu}[\p{Ll}]{0,4}$/u.test(word) || /^\p{L}$/u.test(word)) continue;
      // "F.3d." / "U.S." — dotted letters.
      if (/\p{L}\.\p{L}/u.test(word)) continue;
    }
    ends.push(m.index + m[0].length);
  }
  return ends;
}

const SIGNAL = /^\s*[([]?\s*(?:see\s+also|see\s+generally|see,\s*e\.g\.,|see|cf\.|but\s+see|accord|compare|e\.g\.,|citing|quoting)\b[\s,]*/i;

/** Quoted spans of `text`, curly or straight, as the brief has them. */
export function quotedSpans(text: string): string[] {
  const out: string[] = [];
  const re = /“([^”]{3,}?)”|"([^"]{3,}?)"/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push((m[1] ?? m[2]).trim());
  return out;
}

// Short cites inside a claim are not the claim's words: "290 F.3d at 258",
// "Op. 6", "ROA.1526–27", "TAC ¶ 87", "Id.".
function stripCites(s: string): string {
  return s
    .replace(/\b\d+\s+[A-Z][\w.]*(?:\s+[\w.]+)?\s+(?:at\s+)?\d+(?:[–-]\d+)?(?:,\s*\d+(?:[–-]\d+)?)*(?:\s*\([^)]*\d{4}\))?/g, ' ')
    .replace(/\b(?:Id|Ibid)\.(?:\s+at\s+\d+(?:[–-]\d+)?)?/g, ' ')
    .replace(/\b(?:ROA|Op|App|Br|Pet|Compl|TAC|SAC|FAC|Dep)\.?\s*[¶§]*\s*[\d.,–:-]+/g, ' ')
    .replace(/[¶§]+\s*[\d.,–-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The brief's side of the match, from the paragraph a cite sits in. The claim
 * is the cite's own sentence up to the cite; when that is only a signal or
 * nothing (a citation sentence: "Id. at 259 (collecting cases)."), it is the
 * sentence before. A parenthetical right after the cite ("(holding that …)")
 * is the brief's account of the source too, and joins it.
 */
export function claimFor(context: string, cite: string): ReliedAsk {
  const ctx = context.replace(/\s+/g, ' ');
  const at = findLoose(ctx, cite);
  const pos = at ? at.start : ctx.length;
  const citeEnd = at ? at.end : ctx.length;
  const ends = [0, ...sentenceEnds(ctx).filter((e) => e <= pos)];
  const sStart = ends[ends.length - 1];
  let claim = ctx.slice(sStart, pos).replace(SIGNAL, '');
  if (wordCount(stripCites(claim)) < 5 && ends.length >= 2) {
    claim = ctx.slice(ends[ends.length - 2], sStart);
  }
  const after = ctx.slice(citeEnd, citeEnd + 400);
  const paren = /^[^()]{0,80}?\(\s*((?:holding|finding|explaining|noting|stating|concluding|recognizing|reasoning|observing|describing|affirming|rejecting|declining|quoting|emphasizing)\b[^()]*(?:\([^()]*\)[^()]*)*)\)/i.exec(after);
  const words = [claim.trim(), paren ? paren[1] : ''].filter(Boolean).join(' ');
  return { claim: words, quotes: quotedSpans(words) };
}

const wordCount = (s: string) => tokens(s).length;

// The cite in the paragraph, matched on its words (curly quotes, spacing and
// section signs vary between the mark and the paragraph text).
function findLoose(text: string, needle: string): { start: number; end: number } | null {
  const n = needle.trim();
  if (!n) return null;
  const i = text.indexOf(n);
  if (i >= 0) return { start: i, end: i + n.length };
  const hit = locatePhrase(text, n);
  return hit;
}

// ── The source's side ────────────────────────────────────────────────────

const STOP = new Set(('a an and are as at be been but by for from had has have he her his i in into is it its may '
  + 'not of on or our she so such that the their them then there these they this those to was we were what when '
  + 'which while who will with would you your also any both can could did does each more most must other over '
  + 'shall should than upon under only same some very because about after before between through during against '
  + 'court courts held holding case claim claims plaintiff plaintiffs defendant defendants').split(' '));

// A light stem: the word without a plural or tense ending, so "decisions" and
// "decision", "sustained" and "sustain" meet.
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
function content(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokens(text)) {
    if (t.w.length < 3 || STOP.has(t.w) || /^\d+$/.test(t.w)) continue;
    out.add(stem(t.w));
  }
  return out;
}

/** The sentences of a passage, as offsets into it. */
function sentencesOf(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let s = 0;
  for (const e of [...sentenceEnds(text), text.length]) {
    // A blank line ends a sentence too (a heading, a block quote).
    let from = s;
    for (const part of text.slice(s, e).split(/\n\s*\n/)) {
      const a = text.indexOf(part, from);
      if (part.trim()) out.push({ start: a + (part.length - part.trimStart().length), end: a + part.trimEnd().length });
      from = a + part.length;
    }
    s = e;
  }
  return out;
}

/** The cutoff for a paraphrase: this many shared words, and this share of the claim's. */
export const CLOSEST_MIN_SHARED = 4;
export const CLOSEST_MIN_SHARE = 0.25;
const MAX_LIT_WORDS = 90;

/**
 * Which words of the pinned page the brief relies on. `passages` are the pin
 * passage first, then the ones after it on the same page (never before: the
 * page before is another page, and "Id. at 259" must not light page 258).
 */
export function pickRelied(ask: ReliedAsk, passages: ReliedPassage[]): ReliedPick {
  if (!passages.length) return { basis: 'none', phrases: [], detail: null };

  // 1. A quote, verbatim (piece by piece across ellipses), in one passage.
  for (const q of ask.quotes) {
    const segs = quoteSegments(q);
    if (!segs.length) continue;
    for (const p of passages) {
      const found: string[] = [];
      let from = 0;
      for (const seg of segs) {
        const at = locatePhrase(p.text, seg, from);
        if (!at) break;
        found.push(p.text.slice(at.start, at.end));
        from = at.end;
      }
      if (found.length === segs.length) {
        // Every quote the claim makes that this passage holds, in order.
        const more = ask.quotes.filter((o) => o !== q).flatMap((o) => quoteSegments(o)).flatMap((seg) => {
          const at = locatePhrase(p.text, seg);
          return at ? [{ at: at.start, text: p.text.slice(at.start, at.end) }] : [];
        });
        const firstAt = locatePhrase(p.text, segs[0])!.start;
        const all = [...found.map((text, i) => ({ at: i === 0 ? firstAt : p.text.indexOf(text, firstAt), text })), ...more]
          .sort((a, b) => a.at - b.at)
          .filter((x, i, arr) => i === 0 || x.text !== arr[i - 1].text);
        return { basis: 'quote', phrases: all.map((x) => ({ passageId: p.id, page: p.page ?? null, text: x.text })), detail: null };
      }
    }
  }

  // 2. The sentence that shares the most of the claim's words.
  const want = content(stripCites(ask.claim));
  if (want.size < CLOSEST_MIN_SHARED) return { basis: 'none', phrases: [], detail: null };
  let best: { p: ReliedPassage; start: number; end: number; shared: number; score: number } | null = null;
  for (const p of passages) {
    const sents = sentencesOf(p.text);
    for (let i = 0; i < sents.length; i++) {
      const s = sents[i];
      const have = content(p.text.slice(s.start, s.end));
      if (!have.size) continue;
      let shared = 0;
      for (const w of have) if (want.has(w)) shared++;
      // Shared words, discounted for a long sentence that shares them by bulk.
      const score = shared / Math.sqrt(have.size);
      // A citation sentence ("See, e.g., …") reads with the sentence it supports.
      const start = i > 0 && SIGNAL.test(p.text.slice(s.start, s.end)) ? sents[i - 1].start : s.start;
      if (!best || score > best.score) best = { p, start, end: s.end, shared, score };
    }
  }
  if (!best || best.shared < CLOSEST_MIN_SHARED || best.shared / want.size < CLOSEST_MIN_SHARE) {
    return { basis: 'none', phrases: [], detail: best ? `${best.shared} of ${want.size} words` : null };
  }
  let { start, end } = best;
  // A sentence too long to read as one highlight: from its first shared word to its last.
  const toks = tokens(best.p.text.slice(start, end));
  if (toks.length > MAX_LIT_WORDS) {
    const hits = toks.filter((t) => want.has(stem(t.w)));
    if (hits.length) { end = start + hits[hits.length - 1].end; start = start + hits[0].start; }
  }
  return {
    basis: 'closest',
    phrases: [{ passageId: best.p.id, page: best.p.page ?? null, text: best.p.text.slice(start, end) }],
    detail: `${best.shared} of ${want.size} words`,
  };
}

// ── Depositions ──────────────────────────────────────────────────────────

/** One transcript line: its page, its number, its words. */
export interface DepoLine { page: number; line: number; text: string; passageId: string; physical: number | null }

/**
 * The transcript lines a sheet's passages carry, in order. Two shapes:
 *   - a condensed sheet's text (the appendix): "Page 62" heads a page, "·3·"
 *     opens line 3, and a line 1 after a line 25 is the next page;
 *   - a full-size transcript's Q/A passage: page_start + line_start…line_end,
 *     one text line per transcript line.
 */
export function transcriptLines(passages: ReliedPassage[]): DepoLine[] {
  const out: DepoLine[] = [];
  // A sheet's passages split mid-page: the page and line run on across them.
  let page: number | null = null;
  let prevLine = 0;
  for (const p of passages) {
    if (/·\s*\d{1,2}\s*·/.test(p.text) || /\bPage\s+\d{1,4}\b/.test(p.text)) {
      // "·3·" opens line 3; "10·" (no leading dot) opens line 10.
      const re = /\bPage\s+(\d{1,4})\b|(?<=^|[\s·])(\d{1,2})\s?·/g;
      let open: { line: number; from: number } | null = null;
      const close = (to: number) => {
        if (open && page !== null) {
          const words = p.text.slice(open.from, to).replace(/[·\s]+/g, ' ').trim();
          out.push({ page, line: open.line, text: words, passageId: p.id, physical: p.page ?? null });
        }
        open = null;
      };
      for (let m = re.exec(p.text); m; m = re.exec(p.text)) {
        if (m[1]) { close(m.index); page = Number(m[1]); prevLine = 0; continue; }
        const n = Number(m[2]);
        if (n < 1 || n > 30) continue;
        close(m.index);
        // Line 1 after a later line, with no "Page" header between: the next page.
        if (n <= prevLine && page !== null) page += 1;
        prevLine = n;
        open = { line: n, from: m.index + m[0].length };
      }
      // The last line runs to the sheet's footer, or to the passage's end.
      const tail = open ? p.text.slice((open as { from: number }).from) : '';
      const foot = /\n\s*\n|U\.S\. Legal Support|www\./.exec(tail);
      close(open ? (open as { from: number }).from + (foot ? foot.index : tail.length) : 0);
    } else if (p.page_start != null && p.line_start != null && p.line_end != null) {
      const lines = p.text.split('\n').map((l) => l.trim()).filter(Boolean);
      const n = p.line_end - p.line_start + 1;
      // Only when the text has exactly one line per transcript line; otherwise
      // the numbers would be positions, not the reporter's.
      if (lines.length !== n) continue;
      lines.forEach((text, i) => out.push({ page: p.page_start!, line: p.line_start! + i, text, passageId: p.id, physical: p.page ?? null }));
    }
  }
  return out;
}

/** A deposition cite's lines, page:line to page:line, as phrases to light. */
export function depoLines(passages: ReliedPassage[], cite: NonNullable<ReliedAsk['depo']>): ReliedPick {
  const all = transcriptLines(passages);
  const from = { page: cite.page, line: cite.line ?? 1 };
  const to = cite.endPage !== null
    ? { page: cite.endPage, line: cite.endLine ?? 99 }
    : { page: cite.page, line: cite.endLine ?? cite.line ?? 99 };
  const key = (x: { page: number; line: number }) => x.page * 1000 + x.line;
  const hit = all.filter((l) => key(l) >= key(from) && key(l) <= key(to) && tokens(l.text).length > 0);
  if (!hit.length) return { basis: 'none', phrases: [], detail: null };
  const span = `${from.page}:${cite.line ?? 1}–${to.page !== from.page ? `${to.page}:` : ''}${hit[hit.length - 1].line}`;
  return {
    basis: 'lines',
    phrases: hit.map((l) => ({ passageId: l.passageId, page: l.physical, text: l.text })),
    detail: cite.line === null ? `page ${cite.page}` : span,
  };
}

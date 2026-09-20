// Verbatim quotation, verified against the stored passage — never repaired.
//
// A deposition quote in a trial outline is the one thing in this product that
// a lawyer will read aloud in a courtroom. The rule
// (feedback: deposition-fidelity) is that the reporter's characters stand: not
// the model's re-typing of them, not a straightened curly quote, not a
// corrected spelling. "Heyman" stays "Heyman".
//
// So the model is never trusted to produce the quote. It is asked to POINT at
// a span, and this module then finds that span in the passage the database
// holds and returns THE PASSAGE'S OWN CHARACTERS from it. If the span cannot
// be found, the item is DROPPED. It is never trimmed to fit, never
// fuzzy-matched, and never stored as the model wrote it. A quotation that
// nearly matches is the most dangerous output this feature could produce,
// because it reads as verbatim and is not.
//
// The one liberty taken is whitespace. A PDF text layer wraps lines wherever
// the page broke, so the stored passage carries newlines and runs of spaces
// (and, on Veritext transcripts, non-breaking spaces) in places no human would
// re-type them. Matching on a whitespace-normalized view of both sides — and
// then slicing the ORIGINAL — means a model that re-flowed the line still
// yields the reporter's exact characters, while a model that changed a WORD
// matches nothing and is dropped.

/**
 * Longest quotation accepted, in characters of the original passage.
 *
 * Over this, the item is dropped rather than truncated: a truncated quotation
 * is not the span that was validated, and cutting it here would be exactly the
 * silent "fixing" this module exists to refuse.
 */
export const MAX_QUOTE_CHARS = 900;

/**
 * Shortest quotation accepted. Three words of a transcript is not evidence of
 * anything, and a very short string matches somewhere in almost any passage.
 */
export const MIN_QUOTE_CHARS = 16;

export type QuoteRejection =
  | 'empty'
  | 'too_short'
  | 'too_long'
  | 'not_found';

export interface QuoteMatch {
  /** The PASSAGE's characters for the matched span — never the model's. */
  quote: string;
  /** Character offset of the span in the original passage text. */
  offset: number;
}

export type QuoteCheck =
  | { ok: true; match: QuoteMatch }
  | { ok: false; reason: QuoteRejection };

/** Why an item was dropped, in words an attorney can act on. */
export function describeQuoteRejection(reason: QuoteRejection): string {
  switch (reason) {
    case 'empty': return 'no quotation was given';
    case 'too_short': return `the quotation was shorter than ${MIN_QUOTE_CHARS} characters`;
    case 'too_long': return `the quotation was longer than ${MAX_QUOTE_CHARS} characters`;
    case 'not_found':
      return 'the quotation is not present in the stored passage word for word';
  }
}

interface Normalized {
  text: string;
  /** For each index in `text`, the index in the source string it came from. */
  map: number[];
}

/**
 * Collapse every run of whitespace to a single space and trim, keeping a map
 * back to the source so a match can be sliced out of the original.
 *
 * `\s` covers the tab, the newline, the form feed and — the one that matters
 * on real transcript PDFs — U+00A0, the non-breaking space a text layer emits
 * between a line number and the testimony.
 */
function normalizeWithMap(input: string): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      if (out.length) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out.push(' ');
      map.push(i);
      pendingSpace = false;
    }
    out.push(ch);
    map.push(i);
  }
  return { text: out.join(''), map };
}

/** The whitespace-normalized view of a string, without the index map. */
export function normalizeQuoteText(input: string): string {
  return normalizeWithMap(input).text;
}

/**
 * Find `candidate` in `passageText`, verbatim up to whitespace.
 *
 * Case is NOT normalized. A transcript distinguishes "Q." from "q.", names are
 * capitalised as the reporter typed them, and a model that changed the case of
 * a word changed the text.
 */
export function findVerbatim(passageText: string, candidate: string): QuoteCheck {
  const raw = typeof candidate === 'string' ? candidate : '';
  if (!raw.trim()) return { ok: false, reason: 'empty' };

  const wanted = normalizeWithMap(raw).text;
  if (wanted.length < MIN_QUOTE_CHARS) return { ok: false, reason: 'too_short' };
  if (wanted.length > MAX_QUOTE_CHARS) return { ok: false, reason: 'too_long' };

  const source = normalizeWithMap(passageText ?? '');
  const at = source.text.indexOf(wanted);
  if (at < 0) return { ok: false, reason: 'not_found' };

  const startInSource = source.map[at];
  // The map holds the source index of each normalized character; the span ends
  // one past the source index of the LAST matched character. A normalized
  // space stands in for a whole run, so this can never over-reach.
  const lastIndex = source.map[at + wanted.length - 1];
  const quote = (passageText ?? '').slice(startInSource, lastIndex + 1);

  // Belt and braces: the slice, re-normalized, must be exactly what was asked
  // for. If this ever fails the map is wrong, and the honest answer is to drop
  // the item rather than emit a span nobody verified.
  if (normalizeWithMap(quote).text !== wanted) return { ok: false, reason: 'not_found' };

  if (quote.length > MAX_QUOTE_CHARS) return { ok: false, reason: 'too_long' };
  return { ok: true, match: { quote, offset: startInSource } };
}

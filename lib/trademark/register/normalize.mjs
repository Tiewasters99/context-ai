// lib/trademark/register/normalize.mjs — how a register record's mark is
// turned into the text the register copy searches.
//
// The query set (lib/trademark/queries.mjs) matches a CM: term against "any
// word of the mark, or all of it run together" (termMatchesMark). The copy
// stores, per record, every VARIANT the CM: field covers — the word mark, the
// pseudo mark(s), the translation and transliteration words — each as its
// words, and each also run together, so one regular expression per term,
// anchored at word boundaries, reproduces termMatchesMark in SQL.
//
// Normalization (unit-tested in scripts/_test-tm-register.mjs):
//   1. Unicode NFKD, combining marks dropped (É → e), lower case.
//   2. Apostrophes (' ’ `) are removed without a space: MCDONALD'S → mcdonalds.
//   3. "&" becomes the word "and"; "+" becomes "plus"; "@" becomes "at".
//   4. Every other character that is not a letter or a digit is a word break.
//   5. Runs of spaces collapse; empty words are dropped.
//   6. Numerals to words: when a mark has digits and NO pseudo mark (the
//      USPTO's own spelled-out variant, statement type PM), a numeral-words
//      variant is added (4U → "four u", 21ST → "twenty one st"; each digit
//      run 0 to 9999 becomes words, a longer run or one with a leading zero
//      stays digits; ordinals are not spelled). A pseudo mark, when
//      present, already carries the USPTO's reading, so nothing is guessed.
//
// Nothing here is a model or a network call.

const APOSTROPHES = /['’‘`´]/g;

/** One string → its normalized words. */
export function words(s) {
  const t = String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/@/g, ' at ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return t ? t.split(' ') : [];
}

/** One string → normalized words joined by single spaces. */
export function normalizeMark(s) {
  return words(s).join(' ');
}

/** One string → normalized words run together (no spaces). */
export function joinedMark(s) {
  return words(s).join('');
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0..9999 → English words (no "and"); a larger number → null (left as digits). */
export function numberWords(n) {
  if (!Number.isInteger(n) || n < 0 || n > 9999) return null;
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
  return `${ONES[Math.floor(n / 1000)]} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ''}`;
}

/**
 * The numeral-words reading of a mark, or null when it has no digit run that
 * converts. Digit runs are split from letters first: 4U → "4 u" → "four u".
 */
export function numeralVariant(s) {
  const split = String(s ?? '').replace(/(\d+)/g, ' $1 ');
  const ws = words(split);
  let changed = false;
  const out = ws.map((w) => {
    if (!/^\d+$/.test(w)) return w;
    const nw = numberWords(Number(w));
    if (nw == null || w.length > 1 && w.startsWith('0')) return w;
    changed = true;
    return nw;
  });
  return changed ? out.join(' ') : null;
}

/** The quoted words of a translation / transliteration statement: 'The English translation of "X" in the mark is "Y".' */
export function quotedSegments(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/["“”]([^"“”]{1,200})["“”]/g)) {
    const n = normalizeMark(m[1]);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Every CM: variant of a record, normalized, deduplicated, in a stable order:
 * the word mark, the pseudo marks, the numeral reading (only without a pseudo
 * mark), the translation and transliteration segments. Each variant that has
 * more than one word is followed by its run-together form.
 *
 * @param {{mark?:string|null, pseudoMarks?:string[], translations?:string[], transliterations?:string[]}} r
 * @returns {string[]}
 */
export function cmVariants({ mark, pseudoMarks = [], translations = [], transliterations = [] }) {
  const list = [];
  const push = (s) => {
    const n = normalizeMark(s);
    if (!n) return;
    list.push(n);
    if (n.includes(' ')) list.push(n.replace(/ /g, ''));
  };
  push(mark);
  for (const p of pseudoMarks) push(p);
  if (!pseudoMarks.some((p) => normalizeMark(p))) {
    const nv = numeralVariant(mark);
    if (nv) push(nv);
  }
  for (const t of translations) for (const q of quotedSegments(t)) push(q);
  for (const t of transliterations) for (const q of quotedSegments(t)) push(q);
  return [...new Set(list)];
}

/**
 * The searchable CM text: variants separated by " | ", wrapped in spaces, so
 * a term regex anchored on (^|[ |]) … ([ |]|$) matches a whole word of any
 * variant or a whole run-together variant, never across two variants.
 */
export function cmText(variants) {
  return variants.length ? ` ${variants.join(' | ')} ` : '';
}

/** Owner names → " name one | name two " (phrase-searchable like cmText). */
export function ownerText(names) {
  const v = [...new Set((names ?? []).map(normalizeMark).filter(Boolean))];
  return v.length ? ` ${v.join(' | ')} ` : '';
}

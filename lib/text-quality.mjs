// Is a page's text layer readable, or glyph codes?
//
// A PDF can carry a text layer that is not text. The common case: a web
// page printed to PDF through a Windows print driver (PScript5 → Acrobat
// Distiller) turns every font into a Type 3 font with no map back to
// characters, and every extractor — pdf.js, Poppler, MuPDF — returns the
// glyph codes in order of first use: "\u0000\u0001\u0001\u0003…",
// "!\"#$%&'()*+,-./0…", "DE==FCG". Before 2026-09-24 such a page was long
// enough to count as typed, so it was indexed as noise and the document went
// "ready" — Cornell LII's Fed. R. Civ. P. 56, printed from the browser, was
// the case that found it (DeCamara appeal, reported 2026-09-24). Search and
// cite-check then reported "not found" for text that is there.
//
// The test is deliberately about SHAPE, not language: real text in any
// Latin-script language is mostly letters, carries almost no control
// characters, and its words carry vowels; glyph-code text fails all three.
// Pure: no I/O.

const STOPWORDS = new Set([
  // English, then the other languages a record realistically holds.
  'the', 'of', 'and', 'to', 'a', 'in', 'is', 'that', 'for', 'on', 'or', 'by', 'be', 'as', 'with', 'this',
  'it', 'not', 'any', 'an', 'are', 'was', 'at', 'from', 'shall', 'may', 'court', 'which', 'if',
  'de', 'la', 'el', 'que', 'y', 'en', 'los', 'del', 'le', 'les', 'des', 'et', 'der', 'die', 'und', 'das',
]);

/**
 * Character statistics of a text, for the verdict and for a report.
 * `nonSpace` excludes whitespace; the ratios are over it.
 */
export function textStats(text) {
  const s = String(text || '');
  let nonSpace = 0, letters = 0, controls = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || c === 0xa0) continue;
    nonSpace++;
    if (c < 0x20 || (c >= 0x7f && c < 0xa0) || c === 0xfffd) controls++;
    else if (/\p{L}/u.test(ch)) letters++;
  }
  const words = s.toLowerCase().match(/\p{L}{1,}/gu) || [];
  // The vowel test only means something for Latin-script text: Hebrew, Greek
  // or Chinese words have no Latin vowels and are perfectly readable.
  const latin = words.filter((w) => /^[a-zà-ÿ]+$/.test(w));
  const longWords = latin.filter((w) => w.length >= 3);
  const withVowel = longWords.filter((w) => /[aeiouyàáâäèéêëìíîïòóôöùúûü]/.test(w)).length;
  // Common words as prose writes them — in lower case. Glyph codes come out
  // mostly in capitals, and "A" or "DE" there is not the word "a" or "de".
  const stop = (s.match(/\p{L}+/gu) || []).filter((w) => w === w.toLowerCase() && STOPWORDS.has(w)).length;
  // Whitespace tokens with a character prose does not put inside a word
  // (= @ \ ^ ` < > { } |): "DE==FCG", "HEIJ=KA?", "`b:_S". Not "_" (a
  // form's blanks, "________") and not "~" (OCR noise in an old scan that is
  // otherwise readable) — both measured as false alarms 2026-09-24.
  const tokens = s.split(/\s+/).filter((t) => t.length >= 2);
  const weird = tokens.filter((t) => /[=@\\^`<>{}|]/.test(t)).length;
  return {
    nonSpace,
    letterRatio: nonSpace ? letters / nonSpace : 0,
    controlRatio: nonSpace ? controls / nonSpace : 0,
    vowelWordRatio: longWords.length ? withVowel / longWords.length : 0,
    stopRatio: words.length ? stop / words.length : 0,
    weirdTokenRatio: tokens.length ? weird / tokens.length : 0,
    words: words.length,
    latinShare: words.length ? latin.length / words.length : 0,
  };
}

// Below this many non-space characters there is too little to judge; the
// short-page rule (PAGE_TEXT_MIN_CHARS) already sends such a page to OCR.
const MIN_TO_JUDGE = 80;

/**
 * True when a page's text is glyph codes rather than text. Conservative: it
 * takes two independent signs (or one overwhelming one) to call it, because
 * a false positive costs an OCR call while a false negative costs nothing
 * worse than today.
 */
export function isUnreadableText(text) {
  const st = textStats(text);
  if (st.nonSpace < MIN_TO_JUDGE) return false;
  // Overwhelming: control characters are never a real share of a page.
  if (st.controlRatio > 0.1) return true;
  // Words without vowels: glyph codes that happen to land on letters
  // ("DE==FCG HEIJ=KA"). Real prose in any Latin-script language is ~95%
  // vowelled words; a table of figures has few words but they are real ones.
  // (Latin script only, and with almost none of the words any text uses.)
  if (st.words >= 20 && st.latinShare > 0.8 && st.vowelWordRatio < 0.35 && st.stopRatio < 0.02) return true;
  // Glyph codes mapped onto printable ASCII: a fifth of the "words" carry
  // characters prose never puts inside one. Real text full of "=" and ">"
  // (quoted email, a form) still has its "the"s and "of"s.
  if (st.words >= 20 && st.weirdTokenRatio > 0.2 && st.stopRatio < 0.02) return true;
  // A little of both.
  return st.controlRatio > 0.01 && (st.vowelWordRatio < 0.6 || st.letterRatio < 0.5);
  // Deliberately NOT a sign on its own: few letters, or few common words.
  // Measured 2026-09-24 on a sample of the Vault, that is what a financial
  // statement or a docket table looks like — numbers and short labels — and
  // it read as "unreadable" 13 times in 1,323 PDF passages.
}

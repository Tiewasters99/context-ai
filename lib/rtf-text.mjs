// Rich Text Format → plain text, dependency-free.
//
// RTF is what Westlaw and Lexis hand out and what older Word exports; a
// litigator's folder has a few. Until 2026-09-07 an .rtf fell to the
// plain-text path and indexed its markup — one 2.5 MB Fleming opinion
// (Metropolitan Opera v. Local 100) failed embedding 1,782 times that way.
//
// This reads the format the way a lenient reader does: groups nest with
// braces, control words are a backslash plus letters plus an optional
// number, `\'hh` is a code-page byte, `\uN` is a Unicode code point followed
// by `\ucN` fallback bytes to drop, and a handful of destinations (font
// table, colour table, pictures, document info, `\*\…` extensions) carry no
// prose and are skipped whole. Everything else that is not a control word
// is text. Paragraph and line controls become newlines; tabs and cells
// become tabs; the common typographic symbols become their characters.
//
// It is not a renderer: fonts, sizes and colours are dropped, tables become
// tab-separated lines, footnotes appear inline where they are anchored.
// For search and citation that is the right shape.

const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr',
  'headerf', 'footerl', 'footerr', 'footerf', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl',
  'generator', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'fldinst', 'bkmkstart',
  'bkmkend', 'shpinst', 'atnid', 'atnauthor', 'annotation', 'revtbl', 'userprops', 'docvar', 'ftnsep',
  'ftnsepc', 'aftnsep', 'aftnsepc', 'pgdsctbl', 'listpicture', 'template', 'operator', 'author', 'company',
  'title', 'subject', 'keywords', 'doccomm', 'txe', 'xe', 'tc', 'pntxta', 'pntxtb', 'wgrffmtfilter',
]);
// `\*\dest` groups are ignorable by definition; the one whose text a reader
// sees is a field's result (a hyperlink's label, a page reference).
const VISIBLE_STARRED = new Set(['fldrslt']);
const SYMBOLS = {
  par: '\n', line: '\n', sect: '\n', page: '\n', row: '\n', tab: '\t', cell: '\t', nestcell: '\t', nestrow: '\n',
  emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”',
  bullet: '•', enspace: ' ', emspace: ' ', qmspace: ' ',
};
const BACKSLASH = String.fromCharCode(92);

// Returns the visible text of an RTF document. Accepts a Buffer or a string;
// bytes are read as latin1 so `\'hh` escapes map one-to-one (the common
// code page is 1252, whose printable range agrees with latin1 for prose).
export function rtfToText(input) {
  const s = typeof input === 'string' ? input : Buffer.from(input).toString('latin1');
  const out = [];
  const savedUc = [];
  let skipDepth = 0;   // depth at which a skipped destination began; 0 = emitting
  let uc = 1;          // \ucN — fallback bytes that follow a \uN and must be dropped
  let pendingSkip = 0; // fallback bytes still to drop after a \uN
  let depth = 0;
  let i = 0;
  const n = s.length;
  const emit = (t) => { if (!skipDepth) out.push(t); };
  while (i < n) {
    const c = s[i];
    if (c === '{') { depth++; savedUc.push(uc); i++; continue; }
    if (c === '}') {
      if (savedUc.length) uc = savedUc.pop();
      if (skipDepth && depth <= skipDepth) skipDepth = 0;
      depth--; i++; continue;
    }
    if (c === BACKSLASH) {
      const nx = s[i + 1];
      if (nx === "'") {
        const code = parseInt(s.slice(i + 2, i + 4), 16); i += 4;
        if (pendingSkip > 0) { pendingSkip--; continue; }
        if (!Number.isNaN(code)) emit(String.fromCharCode(code));
        continue;
      }
      if (nx === '*') {
        i += 2;
        const m = /^\\([a-zA-Z]+)/.exec(s.slice(i, i + 40));
        if (m && !VISIBLE_STARRED.has(m[1]) && !skipDepth) skipDepth = depth;
        continue;
      }
      if (nx === BACKSLASH || nx === '{' || nx === '}') { emit(nx); i += 2; continue; }
      if (nx === '~') { emit(' '); i += 2; continue; }          // non-breaking space
      if (nx === '-' || nx === '_') { i += 2; continue; }       // optional / non-breaking hyphen
      if (nx === '\n' || nx === '\r') { emit('\n'); i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(s.slice(i, i + 40));
      if (!m) { i += 2; continue; }
      i += m[0].length;
      const word = m[1];
      const param = m[2] === undefined ? null : parseInt(m[2], 10);
      if (word === 'u' && param !== null) {
        emit(String.fromCharCode(param < 0 ? param + 65536 : param));
        pendingSkip = uc;
        continue;
      }
      if (word === 'uc') { uc = param ?? 1; continue; }
      if (SKIP_DESTINATIONS.has(word) && !skipDepth) { skipDepth = depth; continue; }
      if (Object.prototype.hasOwnProperty.call(SYMBOLS, word)) { emit(SYMBOLS[word]); continue; }
      continue;
    }
    if (c === '\r' || c === '\n') { i++; continue; }
    if (pendingSkip > 0) { pendingSkip--; i++; continue; }
    emit(c); i++;
  }
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function looksLikeRtf(buf) {
  const head = (buf instanceof Uint8Array ? Buffer.from(buf) : Buffer.from(String(buf))).subarray(0, 8).toString('latin1');
  return head.startsWith('{' + BACKSLASH + 'rtf');
}

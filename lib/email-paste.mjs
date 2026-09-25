// "Paste an email" (matter conversations, migration 091): turn text copied out
// of a mail client into a header — From / To / Cc / Date / Subject — a body,
// and, kept apart, the quoted history underneath it.
//
// Dependency-free so the browser (the Thread tab's Paste an email card) and
// node --test (scripts/_test-email-paste.mjs) run the same code, like
// lib/ingest-formats.mjs. It never guesses silently: every field it cannot
// read comes back null, and the card shows the fields for the person to
// correct before anything is saved.
//
// Formats it reads, in the order it tries them:
//   * a header block anywhere near the top — Gmail's
//     "---------- Forwarded message ---------", Outlook's
//     "-----Original Message-----" and "From: … Sent: … To: … Subject:",
//     Apple Mail's "Begin forwarded message:", or a bare block of headers
//     (bold "*From:*" as Gmail's plain-text copy writes it included);
//   * Gmail's web view copied as text: "Name <address>", a date line, and
//     "to me, James".
// Quoted history starts at the first of: "On … wrote:", an Outlook or Gmail
// forward/original separator, a second header block, a line of underscores
// before a From:, or a line beginning with ">".
//
// Mojibake: text that went through a UTF-8 → Windows-1252 mix-up on its way
// to the clipboard ("donâ€™t", "Ã©", "Â ") is repaired, run by run, and only
// where the repaired bytes are valid UTF-8 — so a real "café" or "naïve" is
// never touched.

// Windows-1252's 0x80–0x9F, as the characters a mis-decoder turns them into.
const CP1252_TO_BYTE = new Map([
  ['\u20AC', 0x80], ['\u201A', 0x82], ['\u0192', 0x83], ['\u201E', 0x84], ['\u2026', 0x85],
  ['\u2020', 0x86], ['\u2021', 0x87], ['\u02C6', 0x88], ['\u2030', 0x89], ['\u0160', 0x8A],
  ['\u2039', 0x8B], ['\u0152', 0x8C], ['\u017D', 0x8E], ['\u2018', 0x91], ['\u2019', 0x92],
  ['\u201C', 0x93], ['\u201D', 0x94], ['\u2022', 0x95], ['\u2013', 0x96], ['\u2014', 0x97],
  ['\u02DC', 0x98], ['\u2122', 0x99], ['\u0161', 0x9A], ['\u203A', 0x9B], ['\u0153', 0x9C],
  ['\u017E', 0x9E], ['\u0178', 0x9F],
]);
const CONT = `[\\u0080-\\u00BF${[...CP1252_TO_BYTE.keys()].join('')}]`;
const MOJIBAKE_RUN = new RegExp(
  `(?:[\\u00C2-\\u00DF]${CONT}|[\\u00E0-\\u00EF]${CONT}{2}|[\\u00F0-\\u00F4]${CONT}{3})+`, 'g');

function byteOf(ch) {
  const code = ch.charCodeAt(0);
  if (code <= 0xFF) return code;
  return CP1252_TO_BYTE.get(ch) ?? -1;
}

/** Repair UTF-8-read-as-Windows-1252 runs. Returns the text unchanged where a
 *  run does not decode as valid UTF-8. Two passes cover double encoding. */
export function repairMojibake(text) {
  if (typeof text !== 'string' || !text) return text ?? '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let out = text;
  for (let pass = 0; pass < 2; pass++) {
    const next = out.replace(MOJIBAKE_RUN, (run) => {
      const bytes = [];
      for (const ch of run) {
        const b = byteOf(ch);
        if (b < 0) return run;
        bytes.push(b);
      }
      try { return decoder.decode(new Uint8Array(bytes)); } catch { return run; }
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Line endings, non-breaking and zero-width spaces, trailing blanks. */
export function normalizePaste(text) {
  return repairMojibake(String(text ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+$/gm, '');
}

const HEADER_KEYS = {
  from: 'from', sent: 'date', date: 'date', to: 'to', cc: 'cc', subject: 'subject',
  'reply-to': null, bcc: null, importance: null, attachments: null,
};
const HEADER_LINE = /^\s*\**\s*(from|sent|date|to|cc|subject|reply-to|bcc|importance|attachments)\s*:\**\s*(.*)$/i;
const FORWARD_MARKER = /^\s*(-{2,}\s*(forwarded message|original message)\s*-{2,}|begin forwarded message:?)\s*$/i;
const UNDERSCORES = /^\s*_{10,}\s*$/;
const WROTE_ONE_LINE = /^\s*on\s.+\bwrote:\s*$/i;

function headerKey(line) {
  const m = line.match(HEADER_LINE);
  if (!m) return null;
  const key = m[1].toLowerCase();
  return { key, field: HEADER_KEYS[key], value: m[2].replace(/\*+$/, '').trim() };
}

/**
 * Read a header block starting at lines[i]. Returns null unless it holds a
 * From and at least one of Date/Sent, To or Subject. A line that starts with
 * whitespace, or does not look like a header but follows To/Cc before the
 * block ends, continues the previous value (wrapped recipient lists).
 */
function readHeaderBlock(lines, i) {
  const first = headerKey(lines[i] ?? '');
  if (!first) return null;
  const fields = {};
  let last = null;
  let j = i;
  for (; j < lines.length; j++) {
    const line = lines[j];
    if (!line.trim()) break;
    const h = headerKey(line);
    if (h) {
      if (h.field && fields[h.field] === undefined) fields[h.field] = h.value;
      last = h.field;
      continue;
    }
    if (last && (/^\s/.test(line) || last === 'to' || last === 'cc')) {
      fields[last] = `${fields[last] ?? ''} ${line.trim()}`.trim();
      continue;
    }
    break;
  }
  const count = ['date', 'to', 'subject'].filter((k) => fields[k] !== undefined).length;
  if (fields.from === undefined || count === 0) return null;
  return { fields, end: j };
}

function isHeaderBlockStart(lines, i) {
  const h = headerKey(lines[i] ?? '');
  return !!(h && h.field === 'from' && readHeaderBlock(lines, i));
}

/** Where the quoted history begins in lines[from…], or lines.length. */
function quoteBoundary(lines, from) {
  for (let k = from; k < lines.length; k++) {
    const line = lines[k];
    if (FORWARD_MARKER.test(line)) return k;
    if (WROTE_ONE_LINE.test(line)) return k;
    // "On Thu, Sep 24, 2026 at 3:12 PM Eden Quainton <" + "eden@firm.com> wrote:"
    if (/^\s*on\s/i.test(line) && k + 1 < lines.length && /\bwrote:\s*$/i.test(lines[k + 1])
        && `${line} ${lines[k + 1]}`.length < 300) return k;
    if (UNDERSCORES.test(line) && isHeaderBlockStart(lines, k + 1)) return k;
    if (isHeaderBlockStart(lines, k)) return k;
    if (/^\s*>/.test(line)) return k;
  }
  return lines.length;
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
const GMAIL_WEB_DATE = new RegExp(
  `^\\s*((mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s+)?((${MONTHS})[a-z]*\\.?\\s+\\d{1,2}(,\\s*\\d{4})?|\\d{1,2}\\s+(${MONTHS})[a-z]*\\.?(\\s+\\d{4})?)` +
  `(,?\\s*(at\\s+)?\\d{1,2}:\\d{2}(\\s*[ap]\\.?m\\.?)?)?(\\s*\\([^)]*\\))?\\s*$`, 'i');

/**
 * An email date as a mail client prints it → ISO 8601, or null when it
 * cannot be read with confidence. "Thu, Sep 24, 2026 at 3:12 PM",
 * "Thursday, September 24, 2026 3:12 PM", "Thu, 24 Sep 2026 15:12:00 -0400",
 * "9/24/2026 3:12 PM". A date with no year is not guessed.
 */
export function parseEmailDate(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim()
    .replace(/\([^)]*\)\s*$/, '')          // "(1 day ago)"
    .replace(/\s+at\s+/i, ' ')             // Gmail's "at"
    .replace(/\bsept\b\.?/i, 'Sep')
    .replace(/(\d)\s*([ap])\.?m\.?\b/i, (_, d, ap) => `${d} ${ap.toUpperCase()}M`)
    .trim();
  if (!s || !/\d{4}/.test(s)) return null;
  // Drop a leading weekday: V8 reads "Thursday, September 24, 2026" but not
  // every engine does.
  s = s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, '');
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  if (d.getUTCFullYear() < 1990 || d.getUTCFullYear() > 2100) return null;
  return d.toISOString();
}

function trimBlock(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b).join('\n');
}

/**
 * @param {string} raw     what was pasted
 * @param {{ separateQuoted?: boolean }} [opts]
 *        separateQuoted (default true): move the quoted history out of the
 *        body into `quoted`, to be shown collapsed. false: keep it in the body.
 * @returns {{
 *   from: string|null, to: string|null, cc: string|null,
 *   date: string|null, dateText: string|null, subject: string|null,
 *   body: string, quoted: string|null,
 *   format: 'forward'|'header-block'|'gmail-web'|'none', repaired: boolean,
 * }}
 */
export function parsePastedEmail(raw, opts = {}) {
  const separateQuoted = opts.separateQuoted !== false;
  const original = String(raw ?? '');
  const text = normalizePaste(original);
  const repaired = repairMojibake(original) !== original;
  const lines = text.split('\n');
  const out = {
    from: null, to: null, cc: null, date: null, dateText: null, subject: null,
    body: '', quoted: null, format: 'none', repaired,
  };

  // 1. Whose headers are these? Two shapes give the pasted message's own
  //    header block:
  //    a. the block is the first thing pasted (optionally under a separator
  //       line) — an Outlook copy, a "Show original" copy, a bare block;
  //    b. a "Forwarded message" / "Begin forwarded message" marker with the
  //       block under it — a forward, and whatever is above the marker is the
  //       forwarder's note.
  //    A block that merely FOLLOWS some text with no forward marker is the
  //    quoted earlier email of a reply, not this one's header — it is left to
  //    the quote boundary below, and the fields stay empty for the person.
  const nextFilled = (k) => { while (k < lines.length && !lines[k].trim()) k++; return k; };
  const first = nextFilled(0);
  let blockAt = -1;
  let block = null;
  let preface = '';
  let forwarded = false;
  const afterSeparator = FORWARD_MARKER.test(lines[first] ?? '') || UNDERSCORES.test(lines[first] ?? '');
  const topAt = afterSeparator ? nextFilled(first + 1) : first;
  if (isHeaderBlockStart(lines, topAt)) {
    blockAt = topAt;
    forwarded = afterSeparator && /forward/i.test(lines[first]);
  } else {
    for (let m = first; m < Math.min(lines.length, 60); m++) {
      if (/^\s*>/.test(lines[m])) break;
      if (/forwarded message|begin forwarded message/i.test(lines[m]) && FORWARD_MARKER.test(lines[m])) {
        const at = nextFilled(m + 1);
        if (isHeaderBlockStart(lines, at)) {
          blockAt = at;
          forwarded = true;
          preface = trimBlock(lines.slice(0, m));
        }
        break;
      }
    }
  }
  if (blockAt >= 0) block = readHeaderBlock(lines, blockAt);

  let bodyStart = 0;
  if (block) {
    out.format = forwarded ? 'forward' : 'header-block';
    Object.assign(out, {
      from: block.fields.from || null,
      to: block.fields.to || null,
      cc: block.fields.cc || null,
      subject: block.fields.subject || null,
      dateText: block.fields.date || null,
    });
    bodyStart = block.end;
  } else {
    // 2. Gmail's web view, copied: "Name <addr>" / date line / "to me, James".
    const firstIdx = lines.findIndex((l) => l.trim());
    const l0 = lines[firstIdx] ?? '';
    const l1 = lines[firstIdx + 1] ?? '';
    const l2 = lines[firstIdx + 2] ?? '';
    if (firstIdx >= 0 && /^[^<>\n]{0,120}<[^<>\s@]+@[^<>\s]+>\s*$/.test(l0) && GMAIL_WEB_DATE.test(l1)) {
      out.format = 'gmail-web';
      out.from = l0.trim();
      out.dateText = l1.trim();
      bodyStart = firstIdx + 2;
      const toLine = l2.match(/^\s*to\s+(.+)$/i);
      if (toLine) { out.to = toLine[1].trim(); bodyStart += 1; }
    }
  }
  if (out.dateText) out.date = parseEmailDate(out.dateText);

  const boundary = quoteBoundary(lines, bodyStart);
  const own = trimBlock(lines.slice(bodyStart, separateQuoted ? boundary : lines.length));
  const quoted = separateQuoted ? trimBlock(lines.slice(boundary)) : '';
  out.body = [preface, own].filter(Boolean).join('\n\n');
  out.quoted = quoted || null;
  if (!out.body && out.quoted) {
    // Nothing above the quote: the quote IS the message.
    out.body = out.quoted;
    out.quoted = null;
  }
  return out;
}

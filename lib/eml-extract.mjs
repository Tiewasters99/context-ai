// RFC-822 / MIME (.eml) extraction — dependency-free.
//
// Why no mailparser: the ingest pipeline runs in a Vercel serverless function
// deployed from main, and adding a runtime dependency means touching the
// committed package.json + lockfile (which we treat carefully post-incident).
// Legal-evidence emails need headers + readable body text, not full MIME
// fidelity; ~150 lines below covers multipart, base64, quoted-printable, and
// RFC 2047 encoded-word headers. Attachments are intentionally NOT extracted —
// they're listed by name so the email cites them, and typically exist in the
// vault as their own documents anyway.
//
// Output: pipeline "pages" — [{ pageNumber: 1, text }] where text is a header
// block (From/To/CC/Date/Subject) followed by the message body. The shared
// chunker/embedder indexes it like any other document.

// ---- header utilities -------------------------------------------------------

// Unfold continuation lines (RFC 5322 §2.2.3) and split into name/value pairs.
function parseHeaders(raw) {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) {
      const key = m[1].toLowerCase();
      // First occurrence wins for singletons; Received etc. we don't need.
      if (!(key in headers)) headers[key] = m[2];
    }
  }
  return headers;
}

// One RFC 2047 encoded-word: =?charset?B?...?= / =?charset?Q?...?=. It carries
// its OWN charset and is decoded once, from its own bytes — never through the
// message's charset as well. Double-decoding is how "—" becomes "â€".
function decodeEncodedWord(charset, enc, data) {
  try {
    const bytes = enc.toUpperCase() === 'B'
      ? Buffer.from(data, 'base64')
      // Q-encoding: underscore = space, =XX = byte
      : decodeQuotedPrintableToBuffer(data.replace(/_/g, ' '));
    return decodeCharset(bytes, charset);
  } catch {
    return data;
  }
}

// The bytes of a header that are NOT an encoded word.
//
// The file is read latin1 so every byte survives 1:1 (see extractEmlPages), and
// the body is re-read through its declared charset — but a header was only ever
// run through the encoded-word pass, so raw 8-bit bytes stayed latin1 and a
// UTF-8 em dash surfaced as "â€" in the header block while the same em dash
// read correctly three lines lower in the body. Headers carry 8-bit bytes all
// the time (RFC 6532, and every mail client that ever sent an em dash in a
// Subject:), so they are re-read exactly like the body: UTF-8 when the bytes
// are valid UTF-8 — which an 8-bit header almost always is — the declared
// charset when they are not. Pure ASCII decodes to itself either way, so no
// header that was right changes.
function decodeEightBit(run, charset) {
  if (!run || !/[\u0080-ÿ]/.test(run)) return run;
  const bytes = Buffer.from(run, 'latin1');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 */ }
  const cs = (charset || '').toLowerCase();
  if (cs && cs !== 'utf-8' && cs !== 'utf8') {
    try { return new TextDecoder(cs, { fatal: true }).decode(bytes); } catch { /* nor that */ }
  }
  // Windows-1252 is the honest last resort for a stray 8-bit header: it is what
  // Outlook sends, and it maps every byte, so nothing is dropped.
  return decodeCharset(bytes, 'windows-1252');
}

/**
 * One header value, as the sender meant it to read: encoded words decoded from
 * their own charset, raw 8-bit runs decoded like the body.
 *
 * @param {string} value    the folded-and-joined header value, latin1-decoded
 * @param {string} [charset] the message's declared charset, for 8-bit runs
 */
export function decodeHeaderValue(value, charset) {
  if (!value) return '';
  const encodedWord = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let out = '';
  let last = 0;
  let prevWasEncoded = false;
  let m;
  while ((m = encodedWord.exec(value)) !== null) {
    let between = value.slice(last, m.index);
    // RFC 2047 §6.2: whitespace between two adjacent encoded words is there to
    // let the header fold, and is not part of the text.
    if (prevWasEncoded && /^[ \t]*$/.test(between)) between = '';
    out += decodeEightBit(between, charset);
    out += decodeEncodedWord(m[1], m[2], m[3]);
    last = m.index + m[0].length;
    prevWasEncoded = true;
  }
  return out + decodeEightBit(value.slice(last), charset);
}

function decodeCharset(bytes, charset) {
  const cs = (charset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

// ---- body decoding ----------------------------------------------------------

function decodeQuotedPrintableToBuffer(text) {
  // Soft line breaks (=\r?\n) vanish; =XX becomes the raw byte.
  const cleaned = text.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      out.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(cleaned.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

function decodeBody(bodyText, encoding, charset) {
  const enc = (encoding || '').toLowerCase().trim();
  if (enc === 'base64') {
    return decodeCharset(Buffer.from(bodyText.replace(/\s+/g, ''), 'base64'), charset);
  }
  if (enc === 'quoted-printable') {
    return decodeCharset(decodeQuotedPrintableToBuffer(bodyText), charset);
  }
  // 7bit / 8bit / binary / unset — bodyText is already latin1-decoded raw
  // bytes; re-decode through the declared charset.
  return decodeCharset(Buffer.from(bodyText, 'latin1'), charset);
}

// Minimal HTML → text for emails whose only body is text/html.
function htmlToText(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- MIME tree walk ---------------------------------------------------------

function contentTypeOf(headers) {
  const ct = headers['content-type'] || 'text/plain';
  const mime = (ct.split(';')[0] || '').trim().toLowerCase();
  const charsetMatch = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  const boundaryMatch = ct.match(/boundary\s*=\s*"?([^";]+)"?/i);
  return { mime, charset: charsetMatch?.[1], boundary: boundaryMatch?.[1] };
}

function isAttachment(headers) {
  return /^\s*attachment/i.test(headers['content-disposition'] || '');
}

function attachmentName(headers, charset) {
  const src = (headers['content-disposition'] || '') + ';' + (headers['content-type'] || '');
  const m = src.match(/(?:file)?name\s*=\s*"?([^";]+)"?/i);
  return m ? decodeHeaderValue(m[1], charset).trim() : '(unnamed)';
}

// Walk one MIME part (headers + raw body). Accumulates plain text, html text,
// and attachment names into `acc`.
function walkPart(rawPart, acc, depth = 0) {
  if (depth > 8) return; // pathological nesting guard
  const sep = rawPart.search(/\r?\n\r?\n/);
  const headRaw = sep === -1 ? rawPart : rawPart.slice(0, sep);
  const body = sep === -1 ? '' : rawPart.slice(sep).replace(/^\r?\n\r?\n/, '');
  const headers = parseHeaders(headRaw);
  const { mime, charset, boundary } = contentTypeOf(headers);

  if (mime.startsWith('multipart/') && boundary) {
    // (?:^|\r?\n) — the first delimiter may open the body with no preceding
    // newline. [ \t]* not \s* — \s would swallow the next line's content.
    const parts = body.split(new RegExp(`(?:^|\\r?\\n)--${escapeRe(boundary)}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    // First split chunk is the multipart preamble — skip it.
    for (const part of parts.slice(1)) {
      if (part.trim()) walkPart(part, acc, depth + 1);
    }
    return;
  }
  if (mime === 'message/rfc822') {
    walkPart(body, acc, depth + 1);
    return;
  }
  if (isAttachment(headers)) {
    acc.attachments.push(attachmentName(headers, charset));
    return;
  }
  if (mime === 'text/plain') {
    acc.charset ??= charset;
    acc.plain.push(decodeBody(body, headers['content-transfer-encoding'], charset));
  } else if (mime === 'text/html') {
    acc.charset ??= charset;
    acc.html.push(decodeBody(body, headers['content-transfer-encoding'], charset));
  } else if (mime.startsWith('image/') || mime.startsWith('application/') || mime.startsWith('audio/') || mime.startsWith('video/')) {
    // Inline non-text content without an attachment disposition — still list it.
    acc.attachments.push(attachmentName(headers, charset));
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- entry point ------------------------------------------------------------

export function extractEmlPages(fileBuf) {
  const buf = fileBuf instanceof Uint8Array ? Buffer.from(fileBuf) : fileBuf;
  // latin1 keeps a 1:1 byte↔char mapping so base64/QP bodies survive the
  // string round-trip; each part re-decodes through its declared charset.
  const raw = buf.toString('latin1');

  const sep = raw.search(/\r?\n\r?\n/);
  const topHeaders = parseHeaders(sep === -1 ? raw : raw.slice(0, sep));

  const acc = { plain: [], html: [], attachments: [], charset: undefined };
  walkPart(raw, acc);

  // Headers and body go through the same charset handling. A multipart message
  // declares no charset at the top, so the first text part's is the message's.
  const headerCharset = contentTypeOf(topHeaders).charset || acc.charset;
  const headerLines = [];
  for (const [label, key] of [
    ['From', 'from'], ['To', 'to'], ['CC', 'cc'],
    ['Date', 'date'], ['Subject', 'subject'],
  ]) {
    if (topHeaders[key]) headerLines.push(`${label}: ${decodeHeaderValue(topHeaders[key], headerCharset)}`);
  }

  let bodyText = acc.plain.join('\n\n').trim();
  if (!bodyText && acc.html.length) bodyText = htmlToText(acc.html.join('\n\n'));

  const sections = [headerLines.join('\n')];
  if (acc.attachments.length) {
    sections.push(`Attachments: ${[...new Set(acc.attachments)].join(', ')}`);
  }
  if (bodyText) sections.push(bodyText);

  const text = sections.filter(Boolean).join('\n\n').trim();
  return text ? [{ pageNumber: 1, text }] : [];
}

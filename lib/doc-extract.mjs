// Legacy Word (.doc) — what Westlaw hands out as "Word" and what every
// pre-2007 file in a practice's archive is.
//
// A file named .doc is one of several things, and only the bytes say which:
//   - a real Word 97–2003 binary (an OLE compound file, D0 CF 11 E0 …),
//     read here with word-extractor: body, then footnotes and endnotes —
//     in a court opinion the footnotes carry half the law;
//   - Rich Text with a .doc name ({\rtf …), which lib/rtf-text.mjs reads;
//   - a .docx, a PDF or a web page saved under a .doc name.
// docFormat() names which, so the pipeline routes the file to the reader
// that fits instead of refusing it (the refusal was lifted 2026-09-23 at
// Eden's request: "there should not be a block on plain .doc documents").

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function toBuffer(buf) {
  return buf instanceof Uint8Array && !Buffer.isBuffer(buf) ? Buffer.from(buf) : buf;
}

/**
 * What a file named .doc really is, as the extension the pipeline should
 * read it as: '.doc' (Word binary), '.rtf', '.docx', '.pdf', '.html', or
 * '.txt'. Null when it is none of those (binary of some other kind).
 */
export function docFormat(fileBuf) {
  const b = toBuffer(fileBuf);
  if (!b || b.length < 8) return null;
  if (OLE_MAGIC.every((v, i) => b[i] === v)) return '.doc';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return '.docx';
  // Text-shaped signatures, after a UTF-8 byte-order mark and leading space.
  const head = b.subarray(0, 4096).toString('latin1').replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
  if (head.startsWith('{\\rtf')) return '.rtf';
  if (head.startsWith('%PDF')) return '.pdf';
  const lower = head.slice(0, 2048).toLowerCase();
  if (lower.startsWith('<') && /<(html|body|!doctype html)|xmlns:w=|urn:schemas-microsoft-com:office/.test(lower)) return '.html';
  // Word's "Single File Web Page" (MHTML): MIME around an HTML body.
  if (/^mime-version:/i.test(head) && /text\/html/i.test(lower)) return '.html';
  // Plain text with a .doc name. No NUL bytes in the first few KB.
  if (!b.subarray(0, 4096).includes(0)) return '.txt';
  return null;
}

/** Per-page text from a Word 97–2003 binary. One page: the format has none. */
export async function extractDocPages(fileBuf) {
  const { default: WordExtractor } = await import('word-extractor');
  let doc;
  try {
    doc = await new WordExtractor().extract(toBuffer(fileBuf));
  } catch (err) {
    // The message is what the person sees on the row: what happened and
    // what to do. The parser's own words go to the log, not to them.
    console.warn('[doc-extract] word-extractor failed:', err instanceof Error ? err.message : err);
    throw new Error(
      'could not read this Word 97–2003 file — it may be damaged or password-protected. ' +
      'Open it in Word and Save As .docx, then upload that.',
    );
  }
  const clean = (s) => String(s || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  const parts = [clean(doc.getBody())];
  const footnotes = clean(doc.getFootnotes());
  const endnotes = clean(doc.getEndnotes());
  if (footnotes) parts.push(`Footnotes\n\n${footnotes}`);
  if (endnotes) parts.push(`Endnotes\n\n${endnotes}`);
  return [{ pageNumber: 1, text: parts.filter(Boolean).join('\n\n') }];
}

// Email attachments as their own documents (Phase 3 of the ingestion plan,
// 2026-09-04).
//
// eml-extract.mjs reads the email itself — headers and body — without a
// dependency, and only LISTS its attachments by name. That was the right
// call for the text; it left the attached disclosures, responses and
// exhibits unsearchable unless someone filed them separately (four of the
// five emails in the vault carry PDFs that nobody did). This module pulls
// the attachment bytes out with mailparser (a production dependency the
// worker image already installs) so the container unpacker can file each
// one beside the email, queued for the normal pipeline.
//
// What counts as an attachment: anything the sender attached on purpose.
// Inline images — the signature logo, the tracking pixel, a pasted
// screenshot referenced by cid: from the HTML body — are part of the message,
// not documents, and are skipped. An attached email (message/rfc822) is
// filed as a .eml child, whose own attachments are filed when it is
// processed in turn.

import { safeFilename, stripExt } from './container-unpack.mjs';

const EXT_FOR_MIME = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/csv': '.csv',
  'message/rfc822': '.eml',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/tiff': '.tif',
  'application/zip': '.zip',
};

// The Subject: of a raw RFC-822 message (an attached message's bytes), from
// its header block only; encoded words are left as they are — this names a
// file, it does not index anything.
function nestedSubject(bytes) {
  const head = bytes.subarray(0, 64 * 1024).toString('latin1');
  const end = head.search(/\r?\n\r?\n/);
  const block = (end === -1 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  const m = block.match(/^Subject:[ \t]*(.*)$/mi);
  return m ? m[1].trim().slice(0, 120) : '';
}

// → { attachments: [{ title, filename, bytes, entry }], skipped: [{ entry, reason }], subject }
export async function extractEmlAttachments(fileBuf) {
  const { simpleParser } = await import('mailparser');
  const buf = fileBuf instanceof Uint8Array ? Buffer.from(fileBuf) : fileBuf;
  const mail = await simpleParser(buf, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const subject = String(mail.subject || '').trim();
  const attachments = [];
  const skipped = [];
  const used = new Set();
  let n = 0;
  for (const a of mail.attachments || []) {
    n += 1;
    const mime = String(a.contentType || '').toLowerCase().split(';')[0].trim();
    const given = String(a.filename || '').trim();
    const label = given || `(unnamed ${mime || 'part'})`;
    const bytes = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content || []);
    if (!bytes.length) { skipped.push({ entry: label, reason: 'empty' }); continue; }
    // Inline images referenced from the body (cid:) and anything mailparser
    // marks as related to the HTML are decoration, not documents.
    const inlineImage = mime.startsWith('image/') && (a.related === true || String(a.contentDisposition || '').toLowerCase() === 'inline' || (!given && a.cid));
    if (inlineImage) { skipped.push({ entry: label, reason: 'inline image' }); continue; }
    let filename = given;
    if (!filename) {
      const ext = EXT_FOR_MIME[mime] || '';
      // An attached message rarely carries a filename; its own subject is
      // the natural one.
      const own = mime === 'message/rfc822' ? nestedSubject(bytes) : '';
      filename = own ? `${own}.eml` : `attachment-${n}${ext}`;
    } else if (mime === 'message/rfc822' && !/\.eml$/i.test(filename)) {
      filename = `${filename}.eml`;
    }
    let safe = safeFilename(filename, `attachment-${n}.bin`);
    if (used.has(safe.toLowerCase())) {
      const stem = stripExt(safe); const ext = safe.slice(stem.length);
      for (let k = 2; ; k++) { const cand = `${stem}-${k}${ext}`; if (!used.has(cand.toLowerCase())) { safe = cand; break; } }
    }
    used.add(safe.toLowerCase());
    attachments.push({ title: stripExt(filename) || filename, filename: safe, bytes, entry: label });
  }
  return { attachments, skipped, subject };
}

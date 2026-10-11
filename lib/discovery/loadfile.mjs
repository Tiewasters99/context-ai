// Grapheon Discovery — Concordance/Relativity load-file support.
//
// DAT format: records separated by newlines, fields separated by 
// (displayed as ¶ in Concordance), values qualified by þ (þ).
// First record is the header row. OPT (Opticon) is a simple CSV of
// page-level image cross-references.
//
// On intake we PARSE these (opposing counsel's own Bates numbers and document
// breaks are trusted over filename guessing); on export we EMIT them so the
// receiving side's Relativity/Concordance can ingest our production.

const FIELD_SEP = String.fromCharCode(0x14); // DC4, rendered as ¶ in Concordance viewers
const QUOTE = 'þ';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Concordance .dat buffer into an array of records keyed by
 * lowercased header names. Handles UTF-8 (default), UTF-16LE BOM, UTF-8 BOM.
 */
export function parseDat(buf) {
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.toString('utf16le', 2);
  } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.toString('utf8', 3);
  } else {
    text = buf.toString('utf8');
  }

  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return { fields: [], records: [] };

  const splitLine = (line) =>
    line.split(FIELD_SEP).map((f) => f.replace(new RegExp(`^${QUOTE}|${QUOTE}$`, 'g'), '').trim());

  const fields = splitLine(lines[0]).map((f) => f.toLowerCase());
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitLine(lines[i]);
    const rec = {};
    fields.forEach((f, idx) => { rec[f] = vals[idx] ?? ''; });
    records.push(rec);
  }
  return { fields, records };
}

// Common header aliases seen in the wild -> our canonical keys.
const DAT_ALIASES = {
  bates_first: ['begbates', 'begdoc', 'beg bates', 'bates begin', 'startbates', 'prodbeg'],
  bates_last: ['endbates', 'enddoc', 'end bates', 'bates end', 'prodend'],
  custodian: ['custodian'],
  author: ['from', 'author'],
  to: ['to'],
  cc: ['cc'],
  subject: ['subject', 'email subject'],
  date: ['date sent', 'datesent', 'date', 'date created'],
  filename: ['filename', 'file name', 'original filename'],
  native_link: ['nativelink', 'native link', 'native path', 'nativefile'],
  text_link: ['textlink', 'text link', 'text path', 'fulltext'],
  pages: ['pages', 'pgcount', 'page count'],
};

/**
 * Map a parsed DAT record to canonical metadata keys, preserving every
 * original field under `dat` so nothing opposing counsel sent is lost.
 */
export function canonicalizeDatRecord(rec) {
  const out = { dat: rec };
  for (const [canon, aliases] of Object.entries(DAT_ALIASES)) {
    for (const a of aliases) {
      if (rec[a]) { out[canon] = rec[a]; break; }
    }
  }
  return out;
}

/**
 * Build a lookup from produced filename (basename, lowercased) -> canonical
 * record, so intake can attach load-file metadata to the files in the ZIP.
 */
export function datLookupByFilename(records) {
  const lookup = new Map();
  for (const rec of records) {
    const canon = canonicalizeDatRecord(rec);
    for (const key of ['native_link', 'text_link', 'filename']) {
      if (!canon[key]) continue;
      const base = canon[key].split(/[\\/]/).pop().toLowerCase();
      if (base && !lookup.has(base)) lookup.set(base, canon);
    }
    // Bates-named images: BEGBATES.pdf / BEGBATES.tif
    if (canon.bates_first) {
      lookup.set(`${canon.bates_first.toLowerCase()}.pdf`, canon);
      lookup.set(`${canon.bates_first.toLowerCase()}.tif`, canon);
      lookup.set(`${canon.bates_first.toLowerCase()}.tiff`, canon);
    }
  }
  return lookup;
}

/**
 * Parse an Opticon .opt buffer. Format per line:
 *   BatesNumber,Volume,RelativePath,DocBreak(Y|),FolderBreak,BoxBreak,PageCount
 */
export function parseOpt(buf) {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const pages = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [bates, volume, path, docBreak, , , pageCount] = line.split(',');
    pages.push({
      bates: (bates ?? '').trim(),
      volume: (volume ?? '').trim(),
      path: (path ?? '').trim(),
      docBreak: (docBreak ?? '').trim().toUpperCase() === 'Y',
      pageCount: pageCount ? parseInt(pageCount, 10) : null,
    });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

// Column order follows common ESI-protocol practice: numbering, then people
// and dates, then the file itself, then where its parts are in the volume.
// PRODUCEDAS says how the document was produced: IMAGE = stamped pages in
// IMAGES/; NATIVE = the original in NATIVES/ behind a Bates slip sheet.
const EXPORT_COLUMNS = [
  ['BEGBATES', 'bates_first'], ['ENDBATES', 'bates_last'], ['PAGES', 'pages'],
  ['CUSTODIAN', 'custodian'], ['FROM', 'author'], ['TO', 'to'], ['CC', 'cc'], ['BCC', 'bcc'],
  ['SUBJECT', 'subject'], ['DATE', 'date'],
  ['FILENAME', 'filename'], ['FILEEXT', 'file_ext'], ['FILESIZE', 'file_size'], ['SHA256', 'sha256'],
  ['PRODVOL', 'volume'], ['PRODUCEDAS', 'produced_as'],
  ['NATIVELINK', 'native_link'], ['TEXTLINK', 'text_link'],
  ['CONFIDENTIALITY', 'confidentiality'],
];

/**
 * Emit a Concordance .dat for an outgoing production. Every row has every
 * column; a missing value is an empty field.
 * @param {Array<{
 *   bates_first: string, bates_last: string, pages: number|null,
 *   custodian?: string, author?: string, to?: string, cc?: string, bcc?: string,
 *   subject?: string, date?: string, filename: string, file_ext?: string,
 *   file_size?: number|string, sha256?: string, volume?: string,
 *   produced_as?: 'IMAGE'|'NATIVE', native_link?: string, text_link?: string,
 *   confidentiality?: string,
 * }>} rows
 */
export function emitDat(rows) {
  // A field separator or a line break inside a value would split the record.
  const wrap = (v) => `${QUOTE}${String(v ?? '')
    .replace(new RegExp(QUOTE, 'g'), '')
    .replace(new RegExp(FIELD_SEP, 'g'), ' ')
    .replace(/\r?\n/g, ' ')}${QUOTE}`;
  const lines = [EXPORT_COLUMNS.map(([h]) => wrap(h)).join(FIELD_SEP)];
  for (const r of rows) {
    lines.push(EXPORT_COLUMNS.map(([, k]) => wrap(r[k])).join(FIELD_SEP));
  }
  return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
}

/**
 * Emit an Opticon .opt: one line per document (doc-level breaks; our
 * produced images are one PDF per document, not single-page TIFFs).
 */
export function emitOpt(rows, volumeName) {
  const lines = rows
    .filter((r) => r.image_path)
    .map((r) =>
      `${r.bates_first},${volumeName},${r.image_path},Y,,,${r.pages ?? ''}`);
  return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
}

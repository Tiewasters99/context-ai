// lib/trademark/parse.mjs — turning what tmsearch showed into rows.
//
// Two input paths for a recorded run (spec §2, stage 4):
//
//   1. MANUAL (primary; always works): rows keyed or pasted one per line,
//        serial | mark | owner | status | classes | goods/services
//      serial required, the rest optional.
//   2. EXPORT: a CSV or XLSX from tmsearch's "Export". The format was VERIFIED
//      2026-10-19 against two real files (Eden's 2026-10-18 EQUAZIA run; a
//      trimmed copy is scripts/fixtures/trademark/tmsearch-export-2026-10-18-
//      page1.xlsx): three preamble rows, then a header row, then records. The
//      mapper reads HEADER NAMES, ignoring case and punctuation, with synonyms,
//      and never column positions. A column it does not know goes into the
//      row's `raw`; a file with no recognisable serial column is an error,
//      never a silent zero-row run.
//
// Both produce the same row shape:
//   {serial, registration_number, mark, owner, status, live, classes[], goods, filing_date, raw}

/** Words in a status that mean the record is dead (spec §2, stage 5). */
const DEAD_RE = /\b(dead|abandon(ed)?|cancel+ed|expired|withdrawn|invalidated)\b/i;
const LIVE_RE = /\b(live|registered|pending|published|allowed|filed|new application)\b/i;

/** live: true / false from a status line, or null when it does not say. */
export function liveFromStatus(status) {
  const s = String(status ?? '').trim();
  if (!s) return null;
  if (/^(false|no|n)$/i.test(s)) return false;
  if (/^(true|yes|y)$/i.test(s)) return true;
  if (DEAD_RE.test(s)) return false;
  if (LIVE_RE.test(s)) return true;
  return null;
}

/** Digits only, 6 to 9 of them, or null. "SN 90562533" and "90,562,533" both read. */
export function normalizeSerial(s) {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 6 && d.length <= 9 ? d : null;
}

/** "9, 42 / 045" → ['009', '042', '045']; A, B and 200 (coordinated) kept as they are. */
export function parseClasses(s) {
  if (Array.isArray(s)) return parseClasses(s.join(' '));
  const out = [];
  // A real export writes "200." and "... 045 200 A B." — trailing punctuation
  // on the last token (seen in tmSearchResults2026-10-18.xlsx).
  for (const t of String(s ?? '').split(/[\s,;/|]+/).map((x) => x.replace(/^(ic|class)[:.]?/i, '').replace(/[.:]+$/, '')).filter(Boolean)) {
    if (/^\d{1,3}$/.test(t)) out.push(t === '200' ? '200' : t.padStart(3, '0'));
    else if (/^[ab]$/i.test(t)) out.push(t.toUpperCase());
  }
  return [...new Set(out)];
}

/** A date as YYYY-MM-DD, or null. Accepts 2023-07-01, 07/01/2023, 20230701. */
export function normalizeDate(s) {
  const t = String(s ?? '').trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function row({ serial, registration_number = null, mark = null, owner = null, status = null, live, classes = [], goods = null, filing_date = null, raw = {} }) {
  const st = status ? String(status).trim() : null;
  return {
    serial,
    registration_number: registration_number ? String(registration_number).trim() || null : null,
    mark: mark ? String(mark).trim() || null : null,
    owner: owner ? String(owner).trim() || null : null,
    status: st || null,
    live: typeof live === 'boolean' ? live : liveFromStatus(st),
    classes: parseClasses(classes),
    goods: goods ? String(goods).trim() || null : null,
    filing_date: normalizeDate(filing_date),
    raw,
  };
}

/**
 * The manual path: one row per non-blank line,
 *   serial | mark | owner | status | classes | goods/services
 * A line that has no readable serial is an error (with its line number);
 * the good lines still parse.
 * @returns {{rows: object[], errors: {line:number, text:string, message:string}[]}}
 */
export function parseManualRows(text) {
  const rows = [];
  const errors = [];
  String(text ?? '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const cells = line.split('|').map((c) => c.trim());
    const serial = normalizeSerial(cells[0]);
    if (!serial) {
      errors.push({ line: i + 1, text: line.slice(0, 120), message: 'No serial number (6 to 9 digits) at the start of the line.' });
      return;
    }
    rows.push(row({
      serial, mark: cells[1], owner: cells[2], status: cells[3], classes: cells[4] ?? '',
      goods: cells.slice(5).join(' | '), raw: {},
    }));
  });
  return { rows, errors };
}

/**
 * Header synonyms (handoff §1). Matching ignores case, spaces and punctuation,
 * so "Serial Number", "SerialNumber" and "serial_number" are one name.
 *
 * The real tmsearch export (VERIFIED 2026-10-19 from tmSearchResults2026-10-18.xlsx,
 * sheet "tmSearch") has these columns: SerialNumber, Wordmark, Image, Status,
 * GoodsAndServicesTruncated, Basis, FiledDate, InternationalClass, OwnerFullText,
 * PriorityDate, RegistrationDate, RegistrationNumber, RegistrationType,
 * SupplementalRegistrationDate — preceded by three preamble rows:
 *   "Search results from 1 to N" | "Search term", "", "<the query>" | blank.
 * Status there is only "Live"/"Dead"; RegistrationNumber is the registered-vs-
 * pending signal. The columns not listed below are kept in `raw`.
 */
export const HEADER_SYNONYMS = Object.freeze({
  serial: ['serial', 'serial number', 'serial no', 'serial no.', 'sn'],
  registration_number: ['registration number', 'registration', 'reg number', 'reg no', 'reg no.', 'rn'],
  mark: ['mark', 'wordmark', 'word mark', 'mark text'],
  owner: ['owner', 'owner name', 'owner(s)', 'owner full text', 'registrant', 'applicant'],
  status: ['status', 'live/dead', 'ld', 'live dead', 'live or dead', 'status description'],
  classes: ['class', 'classes', 'international class', 'international classes', 'ic'],
  goods: ['goods', 'goods and services', 'goods & services', 'goods and services truncated', 'gs', 'goods/services'],
  filing_date: ['filing date', 'fd', 'filed', 'filed date', 'application filing date'],
});

const headerKey = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const SYNONYM_KEYS = Object.fromEntries(Object.entries(HEADER_SYNONYMS).map(([f, names]) => [f, names.map(headerKey)]));

/** Which field each header names, or null. */
export function mapHeaders(headers) {
  return headers.map((h) => {
    const k = headerKey(h);
    if (!k) return null;
    for (const [field, names] of Object.entries(SYNONYM_KEYS)) if (names.includes(k)) return field;
    return null;
  });
}

/**
 * The rows above the header row, as tmsearch writes them:
 *   "Search results from 1 to 50"            → {from: 1, to: 50}
 *   "Search term" | "" | "CM:equa* AND …"    → {searchTerm}
 * `to` is the last row EXPORTED, not the count tmsearch reported: a
 * "Results on page" export of a 392-result search says "1 to 50". The
 * reviewer still types the reported count.
 * @returns {{searchTerm: string|null, from: number|null, to: number|null, lines: string[]}}
 */
export function parsePreamble(rowsAbove) {
  const out = { searchTerm: null, from: null, to: null, lines: [] };
  for (const cells of rowsAbove) {
    const texts = cells.map((c) => String(c ?? '').trim()).filter(Boolean);
    if (!texts.length) continue;
    out.lines.push(texts.join(' | '));
    const m = /^search results from\s+(\d+)\s+to\s+(\d+)/i.exec(texts[0]);
    if (m) { out.from = Number(m[1]); out.to = Number(m[2]); continue; }
    if (/^search term/i.test(texts[0])) out.searchTerm = texts.slice(1).join(' ').trim() || null;
  }
  return out;
}

export class ExportFormatError extends Error {
  constructor(message) { super(message); this.name = 'ExportFormatError'; }
}

/** How many rows down the header may sit; tmsearch uses three preamble rows. */
const MAX_PREAMBLE_ROWS = 10;

/**
 * An export as a table → rows. The header row is the first row (within the
 * first few) that names a serial-number column; the rows above it are the
 * preamble (tmsearch's "Search results from 1 to N" and "Search term" lines).
 * @param {unknown[][]} table
 * @returns {{rows: object[], errors: {line:number, message:string}[], unknownHeaders: string[], mapped: Record<string,string>, preamble: {searchTerm: string|null, from: number|null, to: number|null, lines: string[]}}}
 * @throws {ExportFormatError} when no header names a serial number.
 */
export function mapExportTable(table) {
  const rowsIn = (table ?? []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim()));
  if (!rowsIn.length) throw new ExportFormatError('The file is empty: no header row and no records.');
  let headerAt = -1;
  let headers = [];
  let fields = [];
  for (let i = 0; i < Math.min(rowsIn.length, MAX_PREAMBLE_ROWS + 1); i++) {
    const hs = rowsIn[i].map((h) => String(h ?? '').trim());
    const fs = mapHeaders(hs);
    if (fs.includes('serial')) { headerAt = i; headers = hs; fields = fs; break; }
  }
  if (headerAt === -1) {
    const first = rowsIn[0].map((h) => String(h ?? '').trim());
    throw new ExportFormatError(
      `No serial-number column was recognised in the header row (${first.filter(Boolean).slice(0, 12).join(', ') || 'blank'}). `
      + 'Expected a column named Serial, Serial Number or SN. Nothing was recorded; key the rows by hand instead, or send the file to be added to the mapper.',
    );
  }
  const preamble = parsePreamble(rowsIn.slice(0, headerAt));
  const mapped = {};
  headers.forEach((h, i) => { if (fields[i]) mapped[fields[i]] ??= h; });
  const unknownHeaders = headers.filter((h, i) => h && !fields[i]);
  const rows = [];
  const errors = [];
  rowsIn.slice(headerAt + 1).forEach((cells, i) => {
    const get = (field) => {
      const idx = fields.indexOf(field);
      return idx === -1 ? null : cells[idx];
    };
    const serial = normalizeSerial(get('serial'));
    if (!serial) { errors.push({ line: i + 2, message: 'No serial number in this row.' }); return; }
    const raw = {};
    headers.forEach((h, j) => { if (h && !fields[j] && cells[j] != null && String(cells[j]).trim()) raw[h] = String(cells[j]).slice(0, 500); });
    rows.push(row({
      serial,
      registration_number: get('registration_number'),
      mark: get('mark'), owner: get('owner'), status: get('status'),
      classes: get('classes') ?? '', goods: get('goods'), filing_date: get('filing_date'), raw,
    }));
  });
  return { rows, errors, unknownHeaders, mapped, preamble };
}

/**
 * A CSV or XLSX file's bytes → mapExportTable(). `xlsx` is loaded only here,
 * only when a file is actually read.
 */
export async function readExportFile(bytes, filename = '') {
  const XLSX = await import('xlsx');
  const lib = XLSX.read ? XLSX : XLSX.default;
  const isCsv = /\.csv$/i.test(filename);
  const wb = isCsv
    ? lib.read(new TextDecoder('utf-8').decode(bytes), { type: 'string', raw: true })
    : lib.read(bytes, { type: 'array', raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new ExportFormatError('The file has no sheet to read.');
  const table = lib.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  return mapExportTable(table);
}

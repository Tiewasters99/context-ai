// lib/trademark/parse.mjs — turning what tmsearch showed into rows.
//
// Two input paths for a recorded run (spec §2, stage 4):
//
//   1. MANUAL (primary; always works): rows keyed or pasted one per line,
//        serial | mark | owner | status | classes | goods/services
//      serial required, the rest optional.
//   2. EXPORT: a CSV or XLSX from tmsearch's "Export". The export format is
//      UNVERIFIED — no real file exists yet — so the mapper reads HEADER NAMES,
//      case-insensitively, with synonyms, and never column positions. A column
//      it does not know goes into the row's `raw`; a file with no recognisable
//      serial column is an error, never a silent zero-row run.
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
  for (const t of String(s ?? '').split(/[\s,;/|]+/).map((x) => x.replace(/^(ic|class)[:.]?/i, '')).filter(Boolean)) {
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

/** Header synonyms (handoff §1), lower case, spaces collapsed. */
export const HEADER_SYNONYMS = Object.freeze({
  serial: ['serial', 'serial number', 'serial no', 'serial no.', 'sn'],
  registration_number: ['registration number', 'registration', 'reg number', 'reg no', 'reg no.', 'rn'],
  mark: ['mark', 'wordmark', 'word mark', 'mark text'],
  owner: ['owner', 'owner name', 'owner(s)', 'registrant', 'applicant'],
  status: ['status', 'live/dead', 'ld', 'live dead', 'live or dead', 'status description'],
  classes: ['class', 'classes', 'international class', 'international classes', 'ic'],
  goods: ['goods', 'goods and services', 'goods & services', 'gs', 'goods/services'],
  filing_date: ['filing date', 'fd', 'filed', 'application filing date'],
});

const headerKey = (h) => String(h ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Which field each header names, or null. */
export function mapHeaders(headers) {
  return headers.map((h) => {
    const k = headerKey(h);
    for (const [field, names] of Object.entries(HEADER_SYNONYMS)) if (names.includes(k)) return field;
    return null;
  });
}

export class ExportFormatError extends Error {
  constructor(message) { super(message); this.name = 'ExportFormatError'; }
}

/**
 * An export as a table (first row = headers) → rows.
 * @param {unknown[][]} table
 * @returns {{rows: object[], errors: {line:number, message:string}[], unknownHeaders: string[], mapped: Record<string,string>}}
 * @throws {ExportFormatError} when no header names a serial number.
 */
export function mapExportTable(table) {
  const rowsIn = (table ?? []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim()));
  if (!rowsIn.length) throw new ExportFormatError('The file is empty: no header row and no records.');
  const headers = rowsIn[0].map((h) => String(h ?? '').trim());
  const fields = mapHeaders(headers);
  if (!fields.includes('serial')) {
    throw new ExportFormatError(
      `No serial-number column was recognised in the header row (${headers.filter(Boolean).slice(0, 12).join(', ') || 'blank'}). `
      + 'Expected a column named Serial, Serial Number or SN. Nothing was recorded; key the rows by hand instead, or send the file to be added to the mapper.',
    );
  }
  const mapped = {};
  headers.forEach((h, i) => { if (fields[i]) mapped[fields[i]] ??= h; });
  const unknownHeaders = headers.filter((h, i) => h && !fields[i]);
  const rows = [];
  const errors = [];
  rowsIn.slice(1).forEach((cells, i) => {
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
  return { rows, errors, unknownHeaders, mapped };
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

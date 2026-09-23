// Spreadsheets in and out of Contextspaces Tables.
//
// A Table is a small JSON grid on a content_items row (see TableView). This
// module is the one place that converts between that grid and the files
// people actually carry around: Excel (.xlsx, .xlsm, .xls), OpenDocument
// (.ods), CSV and TSV, and whatever a spreadsheet app puts on the clipboard.
// Google Sheets arrives by either door: File → Download → Microsoft Excel, or
// select the cells and paste them into a table.
//
// SheetJS is loaded on demand (`import('xlsx')`), never in the main bundle.
//
// Formulas come in as the value Excel last calculated; the formula itself is
// not kept. Formatting (colours, widths, merged cells) is not kept either.
// What is kept is the grid: every sheet, every header, every value, with
// each column typed as text, number, date or checkbox.

export type ColumnType = 'text' | 'number' | 'date' | 'checkbox';
export type CellValue = string | number | boolean | null;

export interface TableColumn {
  id: string;
  name: string;
  type: ColumnType;
}

export interface TableRow {
  id: string;
  cells: Record<string, CellValue>;
}

export interface TableContent {
  columns: TableColumn[];
  rows: TableRow[];
}

/** One sheet of a workbook, ready to become a table. */
export interface ImportedSheet {
  /** The sheet's own name ("Sheet1", "Leads"); the file name for CSV. */
  name: string;
  content: TableContent;
  /** Rows in the sheet below its header, before any cap. */
  sourceRows: number;
  sourceColumns: number;
  /** True when the sheet was larger than a table holds and was cut. */
  truncated: boolean;
}

// A table saves its whole grid on every edit, so its size is the size of
// every save. These caps keep one save under a few megabytes. A Sales
// Navigator export (a few thousand leads, twenty-odd columns) fits.
export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 100;
export const MAX_CELLS = 150_000;

export const SPREADSHEET_EXTENSIONS = ['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv'] as const;

/** For <input type="file" accept>. */
export const SPREADSHEET_ACCEPT =
  '.xlsx,.xlsm,.xls,.ods,.csv,.tsv,' +
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
  'application/vnd.ms-excel,application/vnd.oasis.opendocument.spreadsheet,' +
  'text/csv,text/tab-separated-values';

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isSpreadsheetName(name: string): boolean {
  return (SPREADSHEET_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

/** "Q3 leads.xlsx" → "Q3 leads". */
export function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).trim() || 'Imported table';
}

type SheetJS = typeof import('xlsx');
let sheetjs: Promise<SheetJS> | null = null;
function loadSheetJS(): Promise<SheetJS> {
  sheetjs ??= import('xlsx');
  return sheetjs;
}

// ─── Reading ──────────────────────────────────────────────────────────────

/** Every non-empty sheet of a spreadsheet file, as tables. */
export async function readSpreadsheet(file: Blob, fileName: string): Promise<ImportedSheet[]> {
  const XLSX = await loadSheetJS();
  const ext = fileExtension(fileName);
  // Text formats are read as text, so a UTF-8 file without a byte-order mark
  // keeps its accents, and `raw` stops SheetJS from guessing: "00123" stays
  // a zip code instead of becoming 123. The column types are decided below.
  const workbook = ext === 'csv' || ext === 'tsv'
    ? XLSX.read(await file.text(), { type: 'string', raw: true, dense: true, FS: ext === 'tsv' ? '\t' : undefined })
    : XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, dense: true });

  const out: ImportedSheet[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    const imported = gridToTable(grid);
    if (!imported) continue;
    const onlySheet = workbook.SheetNames.length === 1;
    out.push({
      ...imported,
      name: onlySheet || ext === 'csv' || ext === 'tsv' ? baseName(fileName) : sheetName,
    });
  }
  return out;
}

/**
 * A rectangle of values (first row = headers) → a typed table.
 * Null when there is nothing in it.
 */
export function gridToTable(grid: unknown[][]): Omit<ImportedSheet, 'name'> | null {
  const rowsWithData = grid.filter((r) => Array.isArray(r) && r.some((v) => !isBlank(v)));
  if (rowsWithData.length === 0) return null;

  const [header, ...body] = rowsWithData;
  const sourceColumns = Math.max(...rowsWithData.map((r) => lastFilledIndex(r) + 1));
  const width = Math.min(sourceColumns, MAX_COLUMNS);
  const rowCap = Math.min(MAX_ROWS, Math.floor(MAX_CELLS / Math.max(1, width)));
  const kept = body.slice(0, rowCap);

  // Short ids: they are repeated in every cell of every row, and the table is
  // saved whole. They only need to be unique inside this table; columns added
  // later by hand get UUIDs, which cannot collide with these.
  const columns: TableColumn[] = [];
  for (let c = 0; c < width; c++) {
    const raw = header[c];
    const name = isBlank(raw) ? `Column ${c + 1}` : displayText(raw);
    const type = inferType(kept.map((r) => r[c]));
    columns.push({ id: `c${c + 1}`, name, type });
  }

  const rows: TableRow[] = kept.map((r) => {
    const cells: Record<string, CellValue> = {};
    columns.forEach((col, c) => {
      const v = coerce(r[c], col.type);
      if (v !== null && v !== '') cells[col.id] = v;
    });
    return { id: crypto.randomUUID(), cells };
  });

  return {
    content: { columns, rows },
    sourceRows: body.length,
    sourceColumns,
    truncated: body.length > kept.length || sourceColumns > width,
  };
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function lastFilledIndex(r: unknown[]): number {
  for (let i = r.length - 1; i >= 0; i--) if (!isBlank(r[i])) return i;
  return -1;
}

// A plain number as a spreadsheet writes one. A leading zero ("00123", a
// zip code, an account number) is text, and so is anything with a thousands
// separator or a currency sign — the cell keeps exactly what was typed.
const NUMBER_TEXT = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/;
const ISO_DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const BOOLEAN_TEXT = /^(true|false)$/i;

function inferType(values: unknown[]): ColumnType {
  const present = values.filter((v) => !isBlank(v));
  if (present.length === 0) return 'text';
  if (present.every((v) => typeof v === 'boolean' || (typeof v === 'string' && BOOLEAN_TEXT.test(v.trim())))) {
    return 'checkbox';
  }
  if (present.every((v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && NUMBER_TEXT.test(v.trim())))) {
    return 'number';
  }
  // A date column holds calendar days. One timestamp with a time of day in
  // it makes the column text, so the time is shown rather than dropped.
  if (present.every((v) => (v instanceof Date && isMidnight(v)) || (typeof v === 'string' && ISO_DATE_TEXT.test(v.trim())))) {
    return 'date';
  }
  return 'text';
}

function isMidnight(d: Date): boolean {
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function displayText(v: unknown): string {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return isMidnight(v) ? isoDay(v) : `${isoDay(v)} ${pad(v.getHours())}:${pad(v.getMinutes())}`;
  }
  return String(v).trim();
}

/** A value from a file or the clipboard, as a cell of this column's type. */
export function coerce(v: unknown, type: ColumnType): CellValue {
  if (isBlank(v)) return null;
  switch (type) {
    case 'checkbox':
      if (typeof v === 'boolean') return v;
      return /^(true|yes|y|1|x|✓)$/i.test(String(v).trim());
    case 'number': {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      const n = Number(String(v).trim().replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'date': {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : isoDay(v);
      const s = String(v).trim();
      if (ISO_DATE_TEXT.test(s)) return s;
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : isoDay(d);
    }
    default:
      return displayText(v);
  }
}

// ─── The clipboard ────────────────────────────────────────────────────────

/**
 * What Excel, Google Sheets and Numbers put on the clipboard for a block of
 * cells: rows on lines, cells split by tabs, and a cell holding a tab, a
 * newline or a quote wrapped in double quotes (a quote inside doubled).
 */
export function parseClipboardGrid(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  let atCellStart = true;
  while (i < text.length) {
    const ch = text[i];
    if (atCellStart && ch === '"') {
      // Quoted cell: runs to the closing quote.
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          i++;
          break;
        }
        cell += text[i++];
      }
      atCellStart = false;
      continue;
    }
    if (ch === '\t') { row.push(cell); cell = ''; atCellStart = true; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; atCellStart = true;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch;
    atCellStart = false;
    i++;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** True when pasted text is a block of cells rather than a single value. */
export function isMultiCellPaste(text: string): boolean {
  return /[\t\n]/.test(text.replace(/\r?\n$/, ''));
}

// ─── Writing ──────────────────────────────────────────────────────────────

function exportValue(v: CellValue | undefined, type: ColumnType): string | number | boolean | Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'number') { const n = Number(v); return Number.isFinite(n) ? n : String(v); }
  if (type === 'checkbox') return !!v;
  if (type === 'date' && typeof v === 'string' && ISO_DATE_TEXT.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return String(v);
}

function tableToAoa(content: TableContent): unknown[][] {
  return [
    content.columns.map((c) => c.name),
    ...content.rows.map((r) => content.columns.map((c) => exportValue(r.cells[c.id], c.type))),
  ];
}

// Excel refuses sheet names longer than 31 characters or holding : \ / ? * [ ]
function sheetNameFor(title: string): string {
  return (title.replace(/[:\\/?*[\]]/g, ' ').trim() || 'Table').slice(0, 31);
}

/** The table as an .xlsx workbook (one sheet) or a UTF-8 .csv file. */
export async function exportTable(content: TableContent, title: string, format: 'xlsx' | 'csv'): Promise<Blob> {
  const XLSX = await loadSheetJS();
  const sheet = XLSX.utils.aoa_to_sheet(tableToAoa(content), { cellDates: true, dateNF: 'yyyy-mm-dd' });
  if (format === 'csv') {
    // The byte-order mark is what makes Excel open a UTF-8 CSV as UTF-8.
    const csv = XLSX.utils.sheet_to_csv(sheet, { dateNF: 'yyyy-mm-dd' });
    return new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetNameFor(title));
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true });
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** One line for the person, after an import: what came in, and what did not. */
export function importSummary(sheets: ImportedSheet[]): string {
  if (sheets.length === 0) return 'That file has no cells with anything in them.';
  const cut = sheets.filter((s) => s.truncated);
  const made = sheets.length === 1 ? '1 table' : `${sheets.length} tables (one per sheet)`;
  if (cut.length === 0) return `Imported ${made}.`;
  const which = cut.map((s) => `“${s.name}” (${s.sourceRows.toLocaleString()} rows × ${s.sourceColumns} columns)`).join(', ');
  return `Imported ${made}. Too large to bring in whole: ${which}. A table holds up to ` +
    `${MAX_ROWS.toLocaleString()} rows, ${MAX_COLUMNS} columns and ${MAX_CELLS.toLocaleString()} cells; ` +
    `the first rows and columns were kept.`;
}

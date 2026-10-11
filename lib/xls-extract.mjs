// Legacy Excel (.xls) — the Excel 97–2003 workbook every practice archive and
// half of the spreadsheets a client emails still arrive as.
//
// Refused at selection until 2026-10-10, with "Save as .xlsx" as the advice; a
// user asked why they had to convert by hand, and there was no good answer:
// SheetJS — already a dependency, already reading .xls for Tables' "Import
// spreadsheet" (src/lib/table-sheets.ts) — reads the BIFF binary natively.
//
// A file named .xls is one of several things, and SheetJS sniffs which:
//   - a real BIFF2–BIFF8 workbook (an OLE compound file, D0 CF 11 E0 …);
//   - an HTML table or tab-separated text that a web app exported under an
//     .xls name so Excel would open it (common for court, bank and
//     e-discovery exports);
//   - a modern .xlsx under the old name. That one goes to lib/xlsx-extract.mjs
//     instead, whose streaming reader survives the runaway used-range that a
//     full in-memory parse does not.
//
// Returns the shape extractPages() expects, matching extractXlsx exactly:
//   [{ pageNumber, text, sheetName }]
// one page per non-empty worksheet, in tab order, the sheet name as a heading
// line and one tab-separated line per non-empty row — so a passage cites the
// sheet it came from, exactly as it does for .xlsx.
//
// Memory: a BIFF file is read whole (it is not a zip; there is nothing to
// stream). That is bounded by the ingest routing — an .xls past the inline
// text ceiling goes to the worker — and the runaway-tail and row caps below
// bound the TEXT the same way xlsx-extract.mjs does.

import * as XLSX from 'xlsx';

// Same guards as lib/xlsx-extract.mjs, for the same reason: a fill-down tail of
// identical rows is an artifact, not data, and must not reach the embedder.
const RUN_STOP = 50;
const MAX_ROWS = 200000;

function isZip(b) {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** The non-empty rows of one sheet as tab-separated lines, tail-trimmed. */
function sheetLines(sheet) {
  // Formatted text (what the cell SHOWS — "$1,250.00", "03/14/2019"), not raw
  // values: a lawyer searches for what they saw in Excel.
  const csv = XLSX.utils.sheet_to_csv(sheet, { FS: '\t', RS: '\n', blankrows: false, strip: true });
  const lines = [];
  let lastLine = null;
  let runLen = 0;
  for (const raw of csv.split('\n')) {
    const line = raw.replace(/\t+$/, '');
    if (!line.trim()) continue;
    if (line === lastLine) {
      runLen++;
      if (runLen >= RUN_STOP) {
        lines.length -= runLen - 2; // runLen-1 copies are in; keep the first
        break;
      }
    } else {
      runLen = 1;
      lastLine = line;
    }
    lines.push(line);
    if (lines.length >= MAX_ROWS) break;
  }
  return lines;
}

export async function extractXls(buf) {
  const data = buf instanceof Uint8Array && !Buffer.isBuffer(buf) ? Buffer.from(buf) : buf;

  if (isZip(data)) {
    const { extractXlsx } = await import('./xlsx-extract.mjs');
    return extractXlsx(data);
  }

  let book;
  try {
    // cellFormula/cellHTML/cellStyles off: text is all the index wants, and
    // skipping the rest keeps a large workbook's footprint down.
    book = XLSX.read(data, {
      type: 'buffer', dense: true, cellFormula: false, cellHTML: false, cellStyles: false,
    });
  } catch (err) {
    throw new Error(`Not a readable .xls workbook: ${err.message}`);
  }

  const pages = [];
  for (const name of book.SheetNames || []) {
    const sheet = book.Sheets[name];
    if (!sheet) continue;
    const lines = sheetLines(sheet);
    if (lines.length === 0) continue;
    pages.push({ pageNumber: pages.length + 1, text: [`# ${name}`, ...lines].join('\n'), sheetName: name });
  }

  if (pages.length === 0) throw new Error('No worksheets with any content found in .xls');
  return pages;
}

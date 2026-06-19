// XLSX extraction: zip -> sharedStrings + per-sheet cell grids -> tab-separated
// text, one "page" per worksheet.
//
// An .xlsx is an OOXML package (a ZIP) — the same shape as .docx and .epub,
// which is why we reuse the JSZip + @xmldom/xmldom pair already used by
// lib/epub-extract.mjs (both are declared dependencies; no new package).
//
// Returns the shape extractPages() expects from every other format:
//   [{ pageNumber, text, sheetName }]
// one entry per worksheet, in workbook (tab) order. The chunker then treats
// each sheet as a page, so a passage cites the sheet it came from (page N) and
// a two-sheet workbook produces two pages, not one undifferentiated blob.
//
// Why a real parser instead of the plain-text fallback: extractPages()' default
// branch does buf.toString('utf8'), which on a binary ZIP yields PK-header
// garbage. sanitizeText() then strips it to near-nothing and the pipeline dies
// with "no passages extracted" (or embeds noise). A spreadsheet of any size
// hit this; the parser below makes the cell *values* searchable instead.

import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

function parseXml(xml) {
  // Swallow non-fatal warnings so a stray namespace quirk in a workbook from
  // Excel/LibreOffice/Google Sheets doesn't spam logs. @xmldom/xmldom >=0.9
  // replaced the `errorHandler` object with a single `onError(level,msg)`
  // callback (passing the old shape now throws on construction); match the
  // approach used by lib/epub-extract.mjs.
  const onError = () => {};
  return new DOMParser({ onError }).parseFromString(xml, 'application/xml');
}

// Excel column letters (A, B, ... Z, AA, AB, ...) -> zero-based index.
function colToIndex(ref) {
  const letters = (ref || '').replace(/[0-9]+$/, '');
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64); // 'A' === 65
  }
  return n - 1;
}

// Concatenate all text under an element (handles inline strings / rich text
// runs, where the value is split across multiple <t> nodes).
function textOf(el) {
  if (!el) return '';
  const ts = el.getElementsByTagName('t');
  if (ts.length === 0) return el.textContent || '';
  let s = '';
  for (let i = 0; i < ts.length; i++) s += ts[i].textContent || '';
  return s;
}

export async function extractXlsx(buf) {
  const data = buf instanceof Uint8Array ? buf : Buffer.from(buf);
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch (err) {
    throw new Error(`Not a valid .xlsx (could not open as zip): ${err.message}`);
  }

  // -- Shared strings table -------------------------------------------------
  // Most string cells store an index into this table rather than the literal
  // text. Missing for a workbook with only numbers/inline strings.
  const shared = [];
  const sstEntry = zip.file('xl/sharedStrings.xml');
  if (sstEntry) {
    const sstDoc = parseXml(await sstEntry.async('string'));
    const sis = sstDoc.getElementsByTagName('si');
    for (let i = 0; i < sis.length; i++) shared.push(textOf(sis[i]));
  }

  // -- Sheet order + names --------------------------------------------------
  // workbook.xml lists <sheet name r:id> in tab order; the r:id maps to a
  // target path via workbook.xml.rels. Fall back to filesystem order if the
  // rels can't be resolved.
  const sheetTargets = []; // { name, path }
  const wbEntry = zip.file('xl/workbook.xml');
  const relsEntry = zip.file('xl/_rels/workbook.xml.rels');
  if (wbEntry && relsEntry) {
    const wbDoc = parseXml(await wbEntry.async('string'));
    const relsDoc = parseXml(await relsEntry.async('string'));
    const relById = new Map();
    const rels = relsDoc.getElementsByTagName('Relationship');
    for (let i = 0; i < rels.length; i++) {
      const id = rels[i].getAttribute('Id');
      let target = rels[i].getAttribute('Target') || '';
      target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
      if (id) relById.set(id, target);
    }
    const sheets = wbDoc.getElementsByTagName('sheet');
    for (let i = 0; i < sheets.length; i++) {
      const name = sheets[i].getAttribute('name') || `Sheet${i + 1}`;
      // r:id attribute — getAttribute is namespace-agnostic in xmldom.
      const rid =
        sheets[i].getAttribute('r:id') ||
        sheets[i].getAttribute('id') ||
        '';
      const rel = relById.get(rid);
      const path = rel ? `xl/${rel}` : null;
      sheetTargets.push({ name, path });
    }
  }

  // If we couldn't resolve via rels, fall back to numerically-sorted sheetN.xml.
  if (sheetTargets.every((s) => !s.path)) {
    const sheetFiles = Object.keys(zip.files)
      .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p))
      .sort((a, b) => {
        const na = parseInt(a.match(/(\d+)\.xml$/i)[1], 10);
        const nb = parseInt(b.match(/(\d+)\.xml$/i)[1], 10);
        return na - nb;
      });
    sheetTargets.length = 0;
    sheetFiles.forEach((p, i) => sheetTargets.push({ name: `Sheet${i + 1}`, path: p }));
  }

  // -- Extract each sheet to text -------------------------------------------
  const pages = [];
  let pageNumber = 0;
  for (const { name, path } of sheetTargets) {
    if (!path) continue;
    const entry = zip.file(path);
    if (!entry) continue;
    pageNumber++;
    const sheetDoc = parseXml(await entry.async('string'));
    const rowEls = sheetDoc.getElementsByTagName('row');

    const lines = [`# ${name}`]; // sheet title as a heading so it's searchable
    for (let r = 0; r < rowEls.length; r++) {
      const cellEls = rowEls[r].getElementsByTagName('c');
      const cells = [];
      let maxCol = -1;
      for (let c = 0; c < cellEls.length; c++) {
        const cell = cellEls[c];
        const ref = cell.getAttribute('r') || '';
        const colIdx = ref ? colToIndex(ref) : c;
        const t = cell.getAttribute('t'); // 's' shared, 'inlineStr', 'str', 'b', else number
        let value = '';
        if (t === 's') {
          const vEl = cell.getElementsByTagName('v')[0];
          const idx = vEl ? parseInt(vEl.textContent, 10) : NaN;
          value = Number.isFinite(idx) ? (shared[idx] ?? '') : '';
        } else if (t === 'inlineStr') {
          value = textOf(cell.getElementsByTagName('is')[0]);
        } else {
          const vEl = cell.getElementsByTagName('v')[0];
          value = vEl ? (vEl.textContent || '') : '';
        }
        if (colIdx > maxCol) maxCol = colIdx;
        cells[colIdx] = value;
      }
      if (maxCol < 0) continue; // empty row
      // Tab-separated so column structure survives into search; trim a fully
      // empty row out (privilege logs have plenty of spacer rows).
      const row = [];
      for (let i = 0; i <= maxCol; i++) row.push((cells[i] ?? '').replace(/[\t\r\n]+/g, ' ').trim());
      if (row.some((v) => v.length > 0)) lines.push(row.join('\t'));
    }

    pages.push({ pageNumber, text: lines.join('\n'), sheetName: name });
  }

  if (pages.length === 0) {
    throw new Error('No worksheets found in .xlsx');
  }
  return pages;
}

// XLSX extraction: zip -> sharedStrings + per-sheet cell grids -> tab-separated
// text, one "page" per worksheet.
//
// An .xlsx is an OOXML package (a ZIP) — the same shape as .docx and .epub.
// We reuse the JSZip dependency already used by lib/epub-extract.mjs (no new
// package).
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
//
// ── Why NOT a full DOM parse (the bug this file used to have) ─────────────────
// The previous implementation did `new DOMParser().parseFromString(sheetXml)`
// on each worksheet. Real-world spreadsheets — especially exported privilege
// logs — routinely carry a *runaway used-range*: a couple thousand rows of real
// data followed by ~1,000,000 rows that Excel materialized (often identical
// filler) but which carry no information. A 2-sheet, 12 MB workbook seen in
// production decompressed to a 140 MB worksheet XML with 1,043,311 <row>
// elements. Building a full DOM of that:
//   • OOM'd at the default heap (only completed at --max-old-space-size=8192),
//   • emitted ~1,043,310 lines / ~73 MB of mostly-duplicate rows, which then
//   • blew the embeddings API's 300k-token per-request limit downstream.
//
// So we DON'T build a DOM and we DON'T hold the whole worksheet string in
// memory. Instead we consume each worksheet as a *stream* of decompressed
// chunks (JSZip.nodeStream) and scan for complete <row>…</row> segments
// incrementally. We emit only rows with ≥1 non-empty cell, and we stop at the
// runaway tail: once we've emitted RUN_STOP identical consecutive rows we treat
// the rest of the sheet as filler and bail. A hard MAX_ROWS cap is a final
// backstop. This runs the 140 MB worksheet in well under a 1.5 GB heap.

import JSZip from 'jszip';
import { StringDecoder } from 'string_decoder';

// Stop emitting a sheet once this many *identical* consecutive non-empty rows
// have been seen — the signature of a runaway used-range / fill-down tail.
const RUN_STOP = 50;
// Absolute backstop on emitted data rows per sheet, in case a tail is padded
// with non-identical junk. Real human-authored sheets don't approach this.
const MAX_ROWS = 200000;

// -- Tiny XML helpers (no DOM) -----------------------------------------------

// Decode the five predefined XML entities + numeric character references.
// Spreadsheet cell text is escaped (e.g. "C&amp;D letter"); we must restore it.
function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default:
        if (e[0] === '#') {
          const code = e[1] === 'x' || e[1] === 'X'
            ? parseInt(e.slice(2), 16)
            : parseInt(e.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return m;
    }
  });
}

// Concatenate the text of every <t>…</t> under a fragment (handles inline
// strings and rich-text runs, where the value is split across several <t>s).
function concatTextNodes(fragment) {
  const tRe = /<t\b[^>]*?>([\s\S]*?)<\/t>/g;
  let out = '';
  let m;
  while ((m = tRe.exec(fragment)) !== null) out += m[1];
  // <t/> self-closing carries no text; nothing to add.
  return decodeEntities(out);
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

// -- Shared strings (streamed) -----------------------------------------------
// Most string cells store an index into this table. sharedStrings.xml can
// itself be large, so we stream it and pull <si>…</si> entries incrementally
// rather than loading the whole file + a DOM.
async function readSharedStrings(entry) {
  const shared = [];
  if (!entry) return shared;
  await scanStream(entry, /<si\b[^>]*?>([\s\S]*?)<\/si>|<si\b[^>]*?\/>/g, (m) => {
    shared.push(m[1] != null ? concatTextNodes(m[1]) : '');
  });
  return shared;
}

// Pump a JSZip entry through its decompression stream, keeping only a small
// tail buffer, and invoke `onMatch` for every complete match of `re` (which
// MUST be a sticky-safe global regex matching a self-contained element). The
// buffer is trimmed past the last match each chunk so memory stays bounded
// regardless of total decompressed size.
function scanStream(entry, re, onMatch) {
  return new Promise((resolve, reject) => {
    let buf = '';
    // JSZip's nodeStream only emits binary chunks ('nodebuffer'); decode UTF-8
    // incrementally so a multibyte char split across a chunk boundary is held
    // back rather than corrupted.
    const decoder = new StringDecoder('utf8');
    const stream = entry.nodeStream('nodebuffer');
    stream.on('data', (chunk) => {
      buf += decoder.write(chunk);
      re.lastIndex = 0;
      let m;
      let lastEnd = 0;
      while ((m = re.exec(buf)) !== null) {
        try {
          onMatch(m);
        } catch (err) {
          stream.destroy();
          reject(err);
          return;
        }
        lastEnd = re.lastIndex;
      }
      // Keep only the unconsumed tail (a partial element split across chunks).
      if (lastEnd > 0) buf = buf.slice(lastEnd);
      // Guard against pathological growth if a single element is enormous:
      // cap the retained buffer; a real <row>/<si> is never multi-MB.
      if (buf.length > 8 * 1024 * 1024) buf = buf.slice(-8 * 1024 * 1024);
    });
    stream.on('end', () => {
      buf += decoder.end();
      re.lastIndex = 0;
      let m;
      try {
        while ((m = re.exec(buf)) !== null) onMatch(m);
      } catch (err) {
        reject(err);
        return;
      }
      resolve();
    });
    stream.on('error', reject);
  });
}

// -- Row parsing -------------------------------------------------------------
// Parse one <row>…</row> fragment into a tab-joined string, resolving shared /
// inline / numeric cells. Returns '' if the row has no non-empty cell.
const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const V_RE = /<v\b[^>]*?>([\s\S]*?)<\/v>/;
const T_ATTR_RE = /\bt="([^"]*)"/;
const R_ATTR_RE = /\br="([^"]*)"/;

function rowToLine(rowInner, shared) {
  const cells = [];
  let maxCol = -1;
  let cellSeq = 0;
  let hasValue = false;
  CELL_RE.lastIndex = 0;
  let cm;
  while ((cm = CELL_RE.exec(rowInner)) !== null) {
    const attrs = cm[1] || '';
    const body = cm[2] || '';
    const ref = (R_ATTR_RE.exec(attrs) || [])[1] || '';
    const colIdx = ref ? colToIndex(ref) : cellSeq;
    cellSeq++;
    const t = (T_ATTR_RE.exec(attrs) || [])[1]; // 's', 'inlineStr', 'str', 'b', else number
    let value = '';
    if (t === 's') {
      const raw = (V_RE.exec(body) || [])[1];
      const idx = raw != null ? parseInt(raw, 10) : NaN;
      value = Number.isFinite(idx) ? (shared[idx] ?? '') : '';
    } else if (t === 'inlineStr') {
      value = concatTextNodes(body);
    } else {
      const raw = (V_RE.exec(body) || [])[1];
      value = raw != null ? decodeEntities(raw) : '';
    }
    if (colIdx > maxCol) maxCol = colIdx;
    if (colIdx >= 0) cells[colIdx] = value;
    if (!hasValue && value && value.trim().length > 0) hasValue = true;
  }
  if (!hasValue || maxCol < 0) return '';
  const out = [];
  for (let i = 0; i <= maxCol; i++) {
    out.push((cells[i] ?? '').replace(/[\t\r\n]+/g, ' ').trim());
  }
  return out.join('\t');
}

// -- Sheet order + names -----------------------------------------------------
// workbook.xml lists <sheet name r:id> in tab order; r:id maps to a target path
// via workbook.xml.rels. These two files are tiny, so a regex scan is fine and
// lets us drop the xmldom dependency entirely. Fall back to numerically-sorted
// sheetN.xml if rels can't be resolved.
function resolveSheetOrder(workbookXml, relsXml, zip) {
  const targets = [];
  if (workbookXml && relsXml) {
    const relById = new Map();
    const relRe = /<Relationship\b([^>]*?)\/?>/g;
    let rm;
    while ((rm = relRe.exec(relsXml)) !== null) {
      const attrs = rm[1];
      const id = (/(?:^|\s)Id="([^"]*)"/.exec(attrs) || [])[1];
      let target = (/(?:^|\s)Target="([^"]*)"/.exec(attrs) || [])[1] || '';
      target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
      if (id) relById.set(id, target);
    }
    const sheetRe = /<sheet\b([^>]*?)\/?>/g;
    let sm;
    let i = 0;
    while ((sm = sheetRe.exec(workbookXml)) !== null) {
      const attrs = sm[1];
      i++;
      const name = decodeEntities((/(?:^|\s)name="([^"]*)"/.exec(attrs) || [])[1] || `Sheet${i}`);
      const rid =
        (/(?:^|\s)r:id="([^"]*)"/.exec(attrs) || [])[1] ||
        (/(?:^|\s)id="([^"]*)"/.exec(attrs) || [])[1] ||
        '';
      const rel = relById.get(rid);
      targets.push({ name, path: rel ? `xl/${rel}` : null });
    }
  }
  if (targets.length === 0 || targets.every((t) => !t.path)) {
    const sheetFiles = Object.keys(zip.files)
      .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p))
      .sort((a, b) => {
        const na = parseInt(a.match(/(\d+)\.xml$/i)[1], 10);
        const nb = parseInt(b.match(/(\d+)\.xml$/i)[1], 10);
        return na - nb;
      });
    targets.length = 0;
    sheetFiles.forEach((p, i) => targets.push({ name: `Sheet${i + 1}`, path: p }));
  }
  return targets;
}

export async function extractXlsx(buf) {
  const data = buf instanceof Uint8Array ? buf : Buffer.from(buf);
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch (err) {
    throw new Error(`Not a valid .xlsx (could not open as zip): ${err.message}`);
  }

  const shared = await readSharedStrings(zip.file('xl/sharedStrings.xml'));

  const wbEntry = zip.file('xl/workbook.xml');
  const relsEntry = zip.file('xl/_rels/workbook.xml.rels');
  const workbookXml = wbEntry ? await wbEntry.async('string') : '';
  const relsXml = relsEntry ? await relsEntry.async('string') : '';
  const sheetTargets = resolveSheetOrder(workbookXml, relsXml, zip);

  const pages = [];
  let pageNumber = 0;
  for (const { name, path } of sheetTargets) {
    if (!path) continue;
    const entry = zip.file(path);
    if (!entry) continue;
    pageNumber++;

    const lines = [`# ${name}`]; // sheet title as a heading so it's searchable
    let emitted = 0;
    let lastLine = null;
    let runLen = 0;
    let stopped = false;

    const rowRe = /<row\b[^>]*?>([\s\S]*?)<\/row>|<row\b[^>]*?\/>/g;
    await scanStream(entry, rowRe, (m) => {
      if (stopped) return;
      const inner = m[1];
      if (inner == null) return; // self-closing <row/> — no cells
      const line = rowToLine(inner, shared);
      if (!line) return; // empty row — skip (spacer rows, blank used-range)

      // Runaway-tail detection: a long run of identical rows is a fill-down
      // artifact, not data. Roll back the run we already emitted and stop.
      if (line === lastLine) {
        runLen++;
        if (runLen >= RUN_STOP) {
          lines.length -= runLen - 1; // drop the duplicates (keep the first)
          emitted -= runLen - 1;
          stopped = true;
          return;
        }
      } else {
        runLen = 1;
        lastLine = line;
      }

      lines.push(line);
      emitted++;
      if (emitted >= MAX_ROWS) stopped = true; // hard backstop
    });

    pages.push({ pageNumber, text: lines.join('\n'), sheetName: name });
  }

  if (pages.length === 0) {
    throw new Error('No worksheets found in .xlsx');
  }
  return pages;
}

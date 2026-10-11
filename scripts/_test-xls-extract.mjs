// Legacy Excel (.xls) is read, not refused (2026-10-10).
//
// Builds real workbooks with SheetJS — a BIFF8 binary, an HTML table and a
// tab-separated export saved under an .xls name, and an .xlsx under the old
// name — and drives them through extractPages(), the one entry the inline
// path and the Fly worker share. No network, no fixtures on disk.
//
//   node scripts/_test-xls-extract.mjs

import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { extractPages } from '../lib/ingest-core.mjs';

const ok = (m) => console.log(`  ok  ${m}`);

function book(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return wb;
}

// 1. A real Excel 97–2003 binary, two sheets, one empty sheet between them.
{
  const wb = book([
    ['Damages', [['Item', 'Amount'], ['Lost profits', 125000], [], ['Interest', 9400.5]]],
    ['Blank', []],
    ['Witnesses', [['Name', 'Role'], ['J. Smith', 'CFO']]],
  ]);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });
  assert.deepEqual([...buf.subarray(0, 4)], [0xd0, 0xcf, 0x11, 0xe0], 'fixture is an OLE compound file');
  const pages = await extractPages(buf, '.xls');
  assert.equal(pages.length, 2, 'the empty sheet is skipped');
  assert.deepEqual(pages.map((p) => p.pageNumber), [1, 2]);
  assert.deepEqual(pages.map((p) => p.sheetName), ['Damages', 'Witnesses']);
  assert.match(pages[0].text, /^# Damages\n/);
  assert.match(pages[0].text, /Lost profits\t125000/);
  assert.match(pages[0].text, /Interest\t9400\.5/);
  assert(!/\n\n/.test(pages[0].text), 'blank rows are dropped');
  assert.match(pages[1].text, /J\. Smith\tCFO/);
  ok('BIFF8 workbook: one page per non-empty sheet, sheet name as heading, cells tab-separated');
}

// 2. The upper-case extension a Windows export carries.
{
  const buf = XLSX.write(book([['S', [['a', 'b']]]]), { type: 'buffer', bookType: 'biff8' });
  const pages = await extractPages(buf, '.XLS');
  assert.equal(pages.length, 1);
  ok('.XLS routes the same as .xls');
}

// 3. "Excel" exports that are really HTML or tab-separated text.
{
  const html = Buffer.from('<html><body><table><tr><td>Docket</td><td>Filed</td></tr><tr><td>ECF 42</td><td>2019-03-14</td></tr></table></body></html>');
  const p1 = await extractPages(html, '.xls');
  assert.match(p1[0].text, /ECF 42/);
  const tsv = Buffer.from('Bates\tDescription\nABC0001\tEngagement letter\n');
  const p2 = await extractPages(tsv, '.xls');
  assert.match(p2[0].text, /ABC0001\tEngagement letter/);
  ok('an HTML table or TSV saved as .xls is read by content');
}

// 4. A modern workbook under the old name goes to the streaming .xlsx reader.
{
  const buf = XLSX.write(book([['Log', [['Priv', 'Basis'], ['DOC-1', 'AC']]]]), { type: 'buffer', bookType: 'xlsx' });
  const pages = await extractPages(buf, '.xls');
  assert.equal(pages.length, 1);
  assert.match(pages[0].text, /DOC-1\tAC/);
  ok('an .xlsx renamed .xls is read by the .xlsx extractor');
}

// 5. A fill-down tail is trimmed, as it is for .xlsx.
{
  const rows = [['Header', 'X'], ['real', 1]];
  for (let i = 0; i < 5000; i++) rows.push(['filler', 0]);
  const buf = XLSX.write(book([['Tail', rows]]), { type: 'buffer', bookType: 'biff8' });
  const pages = await extractPages(buf, '.xls');
  const lines = pages[0].text.split('\n');
  assert.equal(lines.filter((l) => l === 'filler\t0').length, 1, 'the run collapses to one row');
  assert(lines.length < 10);
  ok('a runaway identical-row tail collapses instead of reaching the embedder');
}

// 6. Garbage under an .xls name fails with a cause, not an empty document.
{
  const junk = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3, 4]);
  await assert.rejects(() => extractPages(junk, '.xls'), /\.xls/);
  ok('an unreadable .xls throws a named error');
}

console.log('\nxls extract: all checks passed');

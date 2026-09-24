// A transcript filed as an exhibit: the court's "Page N of M" stamp is not the
// reporter's page — offline. node scripts/_test-ecf-page-stamp.mjs
//
// DeCamara ECF 66-7 (2026-09-24): the detector read "Case … Document 66-7
// Filed … Page 90 of 157" as the reporter's page and cited 89:17–25 as
// 90:17–25, "high" confidence. The reporter's own numbers were in Watermark
// annotations (Acrobat Header & Footer), invisible to pdf.js.
import assert from 'node:assert/strict';
import { analyzeTranscriptPages } from '../lib/ingest-core.mjs';
import { printedPageFor, pageNumberCandidates, overlayCandidates } from '../lib/transcript-pages.mjs';
import { contentStreamStrings } from '../lib/pdf-overlay-text.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

// A cover sheet, then transcript sheets: PDF page p holds reporter page p-1.
const stamp = (p) => `Case 2:25-cv-02287-MAK     Document 66-7     Filed 03/23/26     Page ${p} of 40`;
const body = () => Array.from({ length: 25 }, (_, i) => `${String(i + 1).padStart(2)}   Q.  Did you speak with the dean about it?  A.  Yes, I did.`).join('\n');
const pages = [{ pageNumber: 1, text: `${stamp(1)}\nEXHIBIT 7` }];
for (let p = 2; p <= 40; p++) pages.push({ pageNumber: p, text: `${body()}\nBack to top\n${stamp(p)}`, overlayText: `Richards-Cordell Deposition\n${p - 1}` });

// 1. The stamp is not a candidate on a stamped page; a reporter's "Page 15" still is.
{
  const c = pageNumberCandidates(`${body()}\n${stamp(12)}`).map((x) => x.value);
  assert(!c.includes(12), `the court's "Page 12 of 40" read as a candidate: ${c}`);
  const unstamped = pageNumberCandidates(`Page 15\n${body()}`).map((x) => x.value);
  assert(unstamped.includes(15), 'an unstamped reporter "Page 15" is still read');
  assert.deepEqual(overlayCandidates('Richards-Cordell Deposition\n89').map((x) => x.value), [89]);
  assert.deepEqual(overlayCandidates(stamp(90)), [], 'the stamp is ignored in an overlay too');
  ok('the court stamp is never a page candidate; the reporter\'s own number is');
}

// 2. With the reporter's numbers in the overlay: offset -1, page 90 reads 89.
{
  const v = analyzeTranscriptPages(pages);
  assert.equal(v.claimed, true, v.reason);
  assert.equal(v.segments[0].offset, -1, v.reason);
  assert.equal(printedPageFor(v, 30), 29);
  ok(`reporter numbers from the overlay fit at offset -1 (${v.reason})`);
}

// 3. With no reporter numbers anywhere: decline — never fit the court's count.
{
  const bare = pages.map(({ overlayText, ...p }) => p);
  const v = analyzeTranscriptPages(bare);
  assert.equal(v.claimed, false, `claimed a page from the court stamp: ${v.reason}`);
  ok(`no reporter numbers → not claimed, the cite carries the PDF-page caveat (${v.reason})`);
}

// 4. The overlay reader pulls strings out of an appearance stream.
{
  const content = 'BT /F1 9 Tf 1 0 0 1 36 760 Tm (Richards-Cordell Deposition) Tj ET BT 1 0 0 1 540 760 Tm (89 ) Tj ET BT [(Pa) -20 (ge) ] TJ ET';
  assert.deepEqual(contentStreamStrings(content), ['Richards-Cordell Deposition', '89', 'Page']);
  ok('Tj and TJ strings are read from a Watermark appearance stream');
}

console.log(`\nPASS (${n} checks)`);

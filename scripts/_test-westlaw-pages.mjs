// Westlaw star pages — offline. node scripts/_test-westlaw-pages.mjs
//
// Every fixture is fictional and Westlaw-SHAPED: the footer, a header cite,
// inline "*N" markers, and the decoys a real opinion carries (other cases'
// "at *3" and "WL …, *3" cites, a parallel reporter, a footnotes section, a
// second opinion paginated on its own).
import assert from 'node:assert/strict';
import { westlawStarPages, westlawPageMeta, isWestlawText, METHOD } from '../lib/westlaw-pages.mjs';
import { citePage, CITE_PAGE_STATE } from '../lib/cite-page.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const FOOT = '© 2026 Thomson Reuters. No claim to original U.S. Government Works.';

// 1. A reporter case: header cite 45 N.Y.2d 560, markers 561–563, a parallel
//    reporter (**), decoy cites, footnotes after the opinion.
{
  const passages = [
    { text: `People v. Doe (fictional)\n45 N.Y.2d 560, 400 N.E.2d 1100\nCourt of Appeals of New York.\n${FOOT}` },
    { text: 'The statutes at issue are designed to prevent *561 very different kinds of harm. See Roe v. Poe, 2019 WL 1234567, at *3; Moe v. Zoe, 2018 WL 7654321, *4.' },
    { text: 'The defendant argues otherwise. **1101 We disagree. *562\n\nThe Criminal Procedure Law does not bar the second prosecution.' },
    { text: 'Nor does id. at *9 help him, because the offenses differ. *563 Order affirmed.' },
    { text: 'Footnotes\n\nFN1 The record shows *562 that the indictments were separate.' },
  ];
  const r = westlawStarPages(passages);
  assert.equal(r.claimed, true, r.reason);
  assert.equal(r.first, 560);
  assert.equal(r.last, 563);
  assert.equal(r.rejected + r.skipped, 1, "\"id. at *9\" is skipped; \"at *3;\" and \"*4.\" never qualify (punctuation follows)");
  assert.deepEqual(r.pages[0], { printed_page: 560, printed_page_end: 560, star_pages: { 2: [1100, 1100] } });
  assert.deepEqual(r.pages[1], { printed_page: 560, printed_page_end: 561, star_pages: { 2: [1100, 1100] } });
  assert.deepEqual(r.pages[2], { printed_page: 561, printed_page_end: 562, star_pages: { 2: [1100, 1101] } });
  assert.deepEqual(r.pages[3], { printed_page: 562, printed_page_end: 563, star_pages: { 2: [1101, 1101] } });
  assert.equal(r.pages[4], null, 'footnotes get no page');
  ok(`reporter case: 560 from the header cite, 561–563 from the markers, "at *3"/"WL …, *4"/"id. at *9" skipped, parallel ** kept, footnotes unpaged (${r.reason})`);

  // What the connector and the outline cite with it.
  const row = { page_start: 1, page_end: 1, metadata: westlawPageMeta(r.pages[2], 1) };
  const c = citePage(row);
  assert.equal(c.state, CITE_PAGE_STATE.PRINTED);
  assert.equal(c.pageStart, 561);
  assert.equal(c.pageEnd, 562);
  assert.equal(c.readerPage, 1, 'the Reader still opens the file page');
  assert.equal(c.caveat, null);
  assert.equal(row.metadata.printed_page_method, METHOD);
  ok('citePage reads it as the printed page 561–62, no caveat, Reader page unchanged');
}

// 2. An unreported (WL) decision: *1, *2, *3 — nothing before *1 is claimed.
{
  const r = westlawStarPages([
    { text: `Smith v. Jones (fictional)\n2021 WL 9999999\n${FOOT}\nSynopsis: West editorial summary.` },
    { text: 'MEMORANDUM AND ORDER\n\n*1 Plaintiff moves to dismiss. *2 The motion is granted in part.' },
    { text: 'Plaintiff relies on Doe, 2020 WL 1111111, at *5. *3 That reliance is misplaced.' },
  ]);
  assert.equal(r.claimed, true, r.reason);
  assert.equal(r.pages[0], null, 'the caption and synopsis are on no page');
  assert.equal(r.pages[1], null, 'the passage that opens before *1 starts on no page, so it claims none');
  assert.deepEqual(r.pages[2], { printed_page: 2, printed_page_end: 3 });
  ok(`WL decision: star pages 1–3, caption/synopsis unpaged, no guessed start page (${r.reason})`);
}

// 3. A second opinion paginated on its own: declined whole.
{
  const r = westlawStarPages([
    { text: `A v. B (fictional) 10 F.4th 100 ${FOOT}` },
    { text: '*101 The first opinion. *102 continues. *103 ends.' },
    { text: 'SMITH, J., dissenting.\n*1 A separately paginated dissent. *2 more. *3 more.' },
  ]);
  assert.equal(r.claimed, false);
  assert.match(r.reason, /restart/);
  assert(r.pages.every((p) => p === null));
  ok(`a restarting pagination is declined for the whole document (${r.reason})`);
}

// 4. Not Westlaw, or Westlaw with no markers: nothing claimed, nothing written.
{
  assert.equal(westlawStarPages([{ text: 'A brief citing Doe, 2020 WL 1111111, at *5.' }]).claimed, false);
  assert.equal(isWestlawText(FOOT), true);
  const r = westlawStarPages([{ text: `A statute printout. ${FOOT}` }]);
  assert.equal(r.claimed, false);
  assert.match(r.reason, /no star pages/);
  assert.equal(westlawPageMeta(null, 1), null);
  ok('a brief that cites Westlaw, and a Westlaw delivery with no star pages, claim nothing');
}

console.log(`\nPASS (${n} checks)`);

// Bluebook cites for Westlaw opinions — offline. node scripts/_test-bluebook.mjs
//
// Fixtures are fictional cases laid out the way Westlaw lays out a download
// (the header shapes measured on the Vault's 983 paged Westlaw documents,
// 2026-09-23).
import assert from 'node:assert/strict';
import {
  parseWestlawCase, bluebookCite, bluebookCitesFor, normalizeReporter, courtFromWestlaw,
  pinRange, usVolumeFits, caseNameFromFilename, levelsForReporters,
} from '../lib/bluebook.mjs';
import { westlawStarPages } from '../lib/westlaw-pages.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const FOOT = '© 2026 Thomson Reuters. No claim to original U.S. Government Works.';

// Reporter spelling, pin ranges, courts, the U.S. volume check.
{
  assert.equal(normalizeReporter('F.Supp.2d'), 'F. Supp. 2d');
  assert.equal(normalizeReporter('Fed.Appx.'), "F. App'x");
  assert.equal(normalizeReporter('S.Ct.'), 'S. Ct.');
  assert.equal(normalizeReporter('N.Y.S.2d'), 'N.Y.S.2d');
  assert.equal(normalizeReporter('Misc.3d'), 'Misc. 3d');
  assert.equal(normalizeReporter('A.D.3d'), 'A.D.3d');
  assert.equal(pinRange(1221, 1222), '1221–22');
  assert.equal(pinRange(99, 101), '99–101');
  assert.equal(pinRange(560, 560), '560');
  assert.equal(courtFromWestlaw('United States District Court, S.D. New York').abbrev, 'S.D.N.Y.');
  assert.equal(courtFromWestlaw('United States District Court, E.D. Pennsylvania').abbrev, 'E.D. Pa.');
  assert.equal(courtFromWestlaw('United States District Court, District of Columbia').abbrev, 'D.D.C.');
  assert.equal(courtFromWestlaw('United States Court of Appeals, Second Circuit').abbrev, '2d Cir.');
  assert.equal(courtFromWestlaw('Court of Appeals of New York').level, 'high');
  assert.equal(courtFromWestlaw('Supreme Court, Appellate Division, First Department, New York').abbrev, 'N.Y. App. Div.');
  assert.equal(courtFromWestlaw('Superior Court of Pennsylvania').abbrev, 'Pa. Super. Ct.');
  assert.equal(courtFromWestlaw('Court of Chancery of Delaware').abbrev, 'Del. Ch.');
  assert.equal(courtFromWestlaw('Court of Oyer and Terminer of Nowhere'), null);
  assert.equal(usVolumeFits(550, 2007), true);
  assert.equal(usVolumeFits(401, 1972), false, 'a U.S. volume the year does not allow');
  ok('reporter spelling (R6.1), pin ranges (R3.2(a)), T1/T7 courts, and the U.S. volume check');
}

// Case names: Westlaw file names, T6, "Matter of", "Co., Inc.".
{
  assert.equal(caseNameFromFilename('Matthews v Unisource Worldwide Inc.pdf'), 'Matthews v. Unisource Worldwide, Inc.');
  assert.equal(caseNameFromFilename('Matter of Formica Constr Inc v Mintz.docx'), 'Formica Constr., Inc. v. Mintz');
  assert.equal(caseNameFromFilename('Degen v US.docx'), 'Degen v. United States');
  assert.equal(caseNameFromFilename('Borough of Duryea Pa v Guarnieri.docx'), 'Borough of Duryea v. Guarnieri');
  assert.equal(caseNameFromFilename('1 - Doe v Roe Corporation.docx'), 'Doe v. Roe Corp.');
  assert.equal(caseNameFromFilename('Much Ado About Nothing.docx'), null, 'not a case name');
  ok('case names from Westlaw file names: periods restored, T6, "Matter of X v. Y", "US", numbered downloads');
}

// A federal appeal, laid out as a Word download.
{
  const passages = [
    { text: `143 F.3d 1219\nUnited States Court of Appeals, Ninth Circuit.\nJohn DOE, Plaintiff–Appellant,\nv.\nRichard ROE, Defendant–Appellee.\nNo. 97–15559\n|\nArgued Feb. 1, 1998.\n|\nDecided May 20, 1998.\nSynopsis\nA fictional synopsis.\n${FOOT}` },
    { text: 'OPINION\n\nThe district court dismissed. *1221 We reverse. See Poe v. Moe, 2019 WL 1234567, at *3.' },
    { text: 'The statute is plain. *1222 Reversed.' },
  ];
  const wp = westlawStarPages(passages);
  const { info, cites } = bluebookCitesFor(passages, wp, 'Doe v Roe.docx');
  assert.equal(info.kind, 'case');
  assert.equal(info.court.abbrev, '9th Cir.');
  assert.equal(info.date.year, 1998, 'the decision date, not the argument date');
  assert.equal(cites[2], 'Doe v. Roe, 143 F.3d 1219, 1221–22 (9th Cir. 1998)');
  ok(`federal appeal: "${cites[2]}"`);
}

// A Supreme Court Word download: opens with S. Ct., star pages are the U.S. Reports'.
{
  const passages = [
    { text: `127 S.Ct. 1955\nSupreme Court of the United States\nALPHA CORPORATION, Petitioner,\nv.\nBeta BRAVO.\nNo. 05–1126\n|\nArgued Nov. 27, 2006.\n|\nDecided May 21, 2007.\nSynopsis\nFictional. ${FOOT}` },
    { text: '*544 JUSTICE SOUTER delivered the opinion of the Court. **1960 The question is fictional. *545 And so on.' },
    { text: 'We hold as follows. *546 Reversed. Compare Gamma v. Delta, 550 U.S. 544 (cited below).' },
  ];
  const wp = westlawStarPages(passages);
  const { cites } = bluebookCitesFor(passages, wp, 'Alpha Corp v Bravo.docx');
  assert.equal(cites[2], 'Alpha Corp. v. Bravo, 550 U.S. 544, 545–46 (2007)');
  ok(`Supreme Court: the U.S. cite, confirmed by its first page and the year: "${cites[2]}"`);
}

// A New York Court of Appeals case with the regional reporter's pages marked.
{
  const passages = [
    { text: `45 N.Y.2d 560, 400 N.E.2d 1100\nCourt of Appeals of New York.\nThe PEOPLE, Respondent,\nv.\nJohn DOE, Appellant.\nJune 12, 1978.\n${FOOT}` },
    { text: 'OPINION OF THE COURT\n\nWe affirm. *561 **1101 The statutes differ. *562 **1102 Order affirmed.' },
  ];
  const wp = westlawStarPages(passages);
  const { cites } = bluebookCitesFor(passages, wp, 'People v Doe.docx');
  assert.equal(cites[1], 'People v. Doe, 400 N.E.2d 1100, 1100–02 (N.Y. 1978)', 'R10.3.1: the regional reporter, with the court');
  ok(`New York, regional reporter preferred and matched by page: "${cites[1]}"`);
}

// A Westlaw-only decision: docket, WL cite, "at *N", exact date.
{
  const passages = [
    { text: `2021 WL 9999999\nOnly the Westlaw citation is currently available.\nUnited States District Court, S.D. New York.\nJane SMITH, Plaintiff,\nv.\nACME CORPORATION, Defendant.\n19 Civ. 1234 (ABC)\n|\nSigned 03/01/2021\n${FOOT}` },
    { text: 'OPINION AND ORDER\n\n*1 Defendant moves to dismiss (ECF No. 40). *2 The motion is granted.' },
    { text: '*3 So ordered.' },
  ];
  const wp = westlawStarPages(passages);
  const { info, cites } = bluebookCitesFor(passages, wp, 'Smith v Acme Corp.docx');
  assert.equal(info.docket, null, '"ECF No. 40" is not a docket number, and the caption has no "No."');
  assert.equal(cites[1], null, 'the passage opens before *1, so it claims no page');
  assert.equal(cites[2], 'Smith v. Acme Corp., 2021 WL 9999999, at *2–3 (S.D.N.Y. Mar. 1, 2021)');
  ok(`WL-only decision, numeric "Signed" date: "${cites[2]}"`);
}

// Never another case's U.S. cite: a 2002 Supreme Court download whose
// synopsis cites Bivens (403 U.S. 388), with its own star run from *403.
{
  const passages = [
    { text: `122 S.Ct. 2179\nSupreme Court of the United States\nChristopher DOE, Petitioner,\nv.\nJennifer ROE.\nNo. 01–394.\n|\nDecided June 20, 2002.\nSynopsis\nFictional; relies on Bivens v. Six Unknown Named Agents, 403 U.S. 388. ${FOOT}` },
    { text: '*403 JUSTICE SOUTER delivered the opinion of the Court. **2182 Fictional. *404 More.' },
    { text: 'And so. *405 **2183 Reversed.' },
  ];
  const wp = westlawStarPages(passages);
  const { cites } = bluebookCitesFor(passages, wp, 'Doe v Roe.docx');
  assert(!/403 U\.S\. 388/.test(String(cites[2])), `took the synopsis's Bivens cite: ${cites[2]}`);
  assert.equal(cites[2], 'Doe v. Roe, 122 S. Ct. 2179, 2182–83 (2002)', 'no U.S. cite it can confirm, so S. Ct.');
  ok(`a U.S. cite in the synopsis is never taken for the case's own: "${cites[2]}"`);
}

// A name Westlaw cut or mangled builds no cite.
{
  const info = parseWestlawCase({
    headText: `103 S.Ct. 2177\nSupreme Court of the United States\nW.R. GRACE AND COMPANY, Petitioner v. LOCAL UNION 759.\nDecided May 31, 1983.\n${FOOT}`,
    sourceFilename: 'WR Grace and Co v Local Union 759 Intern Union of United Rubber Cork Linoleum and Plastic Workers of.docx',
  });
  const r = bluebookCite(info, { 1: [2184, 2185] }, { 1: { first: 2178, last: 2190 } });
  assert.equal(r.cite, null);
  assert.match(r.reason, /case name looks truncated/);
  ok(`a truncated file-name case name builds no cite (${r.reason})`);
}

// Nothing is guessed: an unknown court, or no date, builds no cite.
{
  const info = parseWestlawCase({ headText: `10 Foo. 5\nCourt of Oyer and Terminer of Nowhere.\nA v. B.\n${FOOT}`, sourceFilename: 'A v B.docx' });
  const r = bluebookCite(info, { 1: [6, 6] }, { 1: { first: 6, last: 6 } });
  assert.equal(r.cite, null);
  assert.match(r.reason, /court/);
  assert.deepEqual(levelsForReporters([{ volume: 1, reporter: 'U.S.', page: 1 }], { 2: { first: 900, last: 950 } }), {},
    'a star run is never tied to a reporter whose pages it does not continue');
  ok('an unrecognised court builds no cite (the passage keeps "Title, p. N"); a level is tied to a reporter only by page');
}

console.log(`\nPASS (${n} checks)`);

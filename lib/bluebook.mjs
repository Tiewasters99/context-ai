// Bluebook citations for Westlaw opinions.
//
// Eden, 2026-09-23: pincites in Bluebook form ("Delew v. Wagner, 143 F.3d
// 1219, 1221 (9th Cir. 1998)"), not "Delew v Wagner, p. 1221".
//
// Everything a cite needs is on the Westlaw delivery itself:
//   - the reporter cite(s), first thing in the document ("143 F.3d 1219",
//     or "65 A.D.3d 686, 885 N.Y.S.2d 298");
//   - the court, on the next line ("United States Court of Appeals, Ninth
//     Circuit.");
//   - the decision date ("Decided Aug. 1, 2007");
//   - the case name: Westlaw's own short title — punctuated in a PDF's
//     running header ("Matthews v. Unisource Worldwide, Inc., 748 A.2d 219
//     (2000)"), in "CITE TITLE AS:" on New York Official Reports, and with the
//     punctuation stripped in the file name Westlaw gives the download
//     ("Matthews v Unisource Worldwide Inc").
//
// parseWestlawCase() reads those once per document; bluebookCite() builds the
// cite for a pinpoint. Rules applied (The Bluebook, 21st ed.):
//   R10.3.1  reporter: U.S. for the Supreme Court; for a state case the
//            regional reporter where there is one, else West's state
//            reporter, else the official one; federal reporters as they come.
//   R10.4    court + year parenthetical; the court is left out when the
//            reporter says it (U.S.; a state's official high-court reporter;
//            a state's own intermediate reporter drops the state).
//   R10.2.1  "Matter of X" → "In re X"; T6 words keep their abbreviation.
//   R3.2(a)  pin ranges drop repeated digits: 1221–22.
//   R10.8.1  a Westlaw-only decision: docket number, WL cite, "at *N", and
//            the exact date.
// Where a part cannot be read with confidence the cite is NOT built — the
// caller falls back to "Title, p. N" — and the reason is recorded. A Bluebook
// cite with a wrong court in it is worse than an honest page.
//
// Pure: no I/O.

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

// T10 — states and territories.
export const STATE_ABBREV = Object.freeze({
  Alabama: 'Ala.', Alaska: 'Alaska', Arizona: 'Ariz.', Arkansas: 'Ark.', California: 'Cal.',
  Colorado: 'Colo.', Connecticut: 'Conn.', Delaware: 'Del.', Florida: 'Fla.', Georgia: 'Ga.',
  Hawaii: 'Haw.', Idaho: 'Idaho', Illinois: 'Ill.', Indiana: 'Ind.', Iowa: 'Iowa', Kansas: 'Kan.',
  Kentucky: 'Ky.', Louisiana: 'La.', Maine: 'Me.', Maryland: 'Md.', Massachusetts: 'Mass.',
  Michigan: 'Mich.', Minnesota: 'Minn.', Mississippi: 'Miss.', Missouri: 'Mo.', Montana: 'Mont.',
  Nebraska: 'Neb.', Nevada: 'Nev.', 'New Hampshire': 'N.H.', 'New Jersey': 'N.J.',
  'New Mexico': 'N.M.', 'New York': 'N.Y.', 'North Carolina': 'N.C.', 'North Dakota': 'N.D.',
  Ohio: 'Ohio', Oklahoma: 'Okla.', Oregon: 'Or.', Pennsylvania: 'Pa.', 'Rhode Island': 'R.I.',
  'South Carolina': 'S.C.', 'South Dakota': 'S.D.', Tennessee: 'Tenn.', Texas: 'Tex.', Utah: 'Utah',
  Vermont: 'Vt.', Virginia: 'Va.', Washington: 'Wash.', 'West Virginia': 'W. Va.', Wisconsin: 'Wis.',
  Wyoming: 'Wyo.', 'District of Columbia': 'D.C.', 'Puerto Rico': 'P.R.',
});
const STATE_NAMES = Object.keys(STATE_ABBREV).sort((a, b) => b.length - a.length);

// Every court name the header can open with, for finding it in running text.
const STATES_ALT = STATE_NAMES.map((n) => n.replace(/ /g, '\\s')).join('|');
const COURT_NAME_RE = new RegExp([
  String.raw`Supreme Court of the United States`,
  String.raw`United States Court of Appeals,? (?:for the )?(?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|District of Columbia|Federal) Circuit`,
  String.raw`United States (?:District|Bankruptcy) Court,? (?:for the )?(?:[NSEWCM]\. ?D\.|D\.|(?:Northern|Southern|Eastern|Western|Central|Middle) District of|District of) ?(?:${STATES_ALT})`,
  String.raw`United States Court of Federal Claims`,
  String.raw`Court of Appeals of New York`,
  String.raw`Supreme Court,? Appellate (?:Division|Term),? [\w ]{3,30}?(?:Department|Dept\.?|District)(?:,? New York)?`,
  String.raw`Supreme Court,? [A-Z][\w.]*(?: [A-Z][\w.]*){0,3} County(?:,? New York)?`,
  String.raw`(?:Court of Claims|Civil Court|Criminal Court|Surrogate's Court|Family Court|County Court|District Court|City Court)(?:,? (?:of|City of) )?[\w ,]{0,40}?New York`,
  String.raw`(?:Supreme Judicial|Supreme|Superior|Commonwealth|Appellate|Appeals) Court of (?:${STATES_ALT})(?:, Appellate Division)?`,
  String.raw`Court of (?:Appeals|Criminal Appeals|Civil Appeals|Special Appeals|Chancery|Appeal) of (?:${STATES_ALT})`,
  String.raw`Circuit Court of Appeals,? (?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth) Circuit`,
  String.raw`Court of Appeal,? [\w ,]{3,40}?California`,
  String.raw`District Court of Appeal of Florida`,
  String.raw`Intermediate Court of Appeals of Hawai.?i`,
].join('|'));

const CIRCUITS = Object.freeze({
  first: '1st Cir.', second: '2d Cir.', third: '3d Cir.', fourth: '4th Cir.', fifth: '5th Cir.',
  sixth: '6th Cir.', seventh: '7th Cir.', eighth: '8th Cir.', ninth: '9th Cir.', tenth: '10th Cir.',
  eleventh: '11th Cir.', 'district of columbia': 'D.C. Cir.', federal: 'Fed. Cir.',
});

const MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';

// Reporters, by family. Westlaw writes them closed up ("F.Supp.2d",
// "Fed.Appx.", "S.Ct.", "Misc.3d"); normalizeReporter() gives the Bluebook
// spacing (R6.1(a): adjacent single capitals close up, an ordinal closes up
// after them, and anything after a longer abbreviation takes a space).
const REPORTER_RE = [
  String.raw`U\.S\.|S\. ?Ct\.|L\. ?Ed\.(?: ?2d)?`,
  String.raw`F\. ?Supp\.(?: ?[23]d)?|F\. ?App'x|Fed\. ?Appx\.|F\.(?: ?[234]d| ?4th)?|B\.R\.|Fed\. ?Cl\.|F\.R\.D\.`,
  String.raw`A\.(?:[23]d)?|N\.E\.(?:[23]d)?|N\.W\.(?:2d)?|P\.(?:[23]d)?|S\.E\.(?:2d)?|S\.W\.(?:[23]d)?|So\.(?: ?[23]d)?`,
  String.raw`N\.Y\.S\.(?:[23]d)?|Cal\. ?Rptr\.(?: ?[23]d)?|Ill\. ?Dec\.`,
  String.raw`N\.Y\.(?:[23]d)?|A\.D\.(?:[23]d)?|Misc\.(?: ?[23]d)?`,
  // State official reporters: "<State abbrev>[ App.| Super.| …][ series]".
  String.raw`(?:[A-Z][a-z]{0,5}\.|[A-Z]\.[A-Z]\.|Ohio|Iowa|Utah|Idaho|Alaska)(?: ?(?:App|Super|Commw|Ct|St|Dist|Div|Misc|Ch)\.){0,2}(?: ?(?:[23]d|[4-9]th))?`,
].join('|');

/** Westlaw's spelling of a reporter → the Bluebook's. */
export function normalizeReporter(r) {
  let s = String(r || '').replace(/\s+/g, '');
  if (/^Fed\.Appx\.$/i.test(s)) return "F. App'x";
  // Split into abbreviation tokens ("F." "Supp." "2d").
  const toks = s.match(/[A-Z][a-z']*\.|\d+(?:d|th)|[A-Z][a-z]+/g) || [s];
  let out = '';
  toks.forEach((t, i) => {
    if (i === 0) { out = t; return; }
    const prev = toks[i - 1];
    const singleCap = (x) => /^[A-Z]\.$/.test(x);
    const ordinal = /^\d+(d|th)$/.test(t);
    // Close up: single capital after single capital(s); an ordinal after a
    // run that ends in a single capital (F.3d, N.E.2d, A.D.3d, N.Y.S.2d).
    const close = (singleCap(t) && singleCap(prev)) || (ordinal && singleCap(prev));
    out += close ? t : ` ${t}`;
  });
  return out;
}

const SCOTUS = /^(U\.S\.|S\. ?Ct\.|L\. ?Ed\.)/;
const REGIONAL = /^(A\.|N\.E\.|N\.W\.|P\.|S\.E\.|S\.W\.|So\.)/;
const WEST_STATE = /^(N\.Y\.S\.|Cal\. ?Rptr\.|Ill\. ?Dec\.)/;
const FEDERAL = /^(F\.|F\. ?Supp\.|F\. ?App'x|Fed\. ?Appx\.|B\.R\.|Fed\. ?Cl\.|F\.R\.D\.)/;

// ---------------------------------------------------------------------------
// Courts (T1 / T7)
// ---------------------------------------------------------------------------

function stateIn(s) {
  for (const name of STATE_NAMES) if (new RegExp(`\\b${name}\\b`, 'i').test(s)) return name;
  return null;
}

// "S.D." + "N.Y." → "S.D.N.Y."; "E.D." + "Pa." → "E.D. Pa.".
function joinDistrict(prefix, stateAbbr) {
  return /^([A-Z]\.)+$/.test(stateAbbr) ? `${prefix}${stateAbbr}` : `${prefix} ${stateAbbr}`;
}

/**
 * Westlaw's court line → { abbrev, state, level }. `abbrev` is the T1 form
 * with the state; `level` is 'scotus' | 'federal' | 'high' | 'intermediate' |
 * 'trial'. Null when the court is not one this table knows.
 */
export function courtFromWestlaw(line) {
  const s = String(line || '').replace(/\s+/g, ' ').replace(/\.$/, '').trim();
  if (!s) return null;
  if (/^Supreme Court of the United States$/i.test(s)) return { abbrev: '', state: null, level: 'scotus' };
  let m = /^(?:United States )?Circuit Court of Appeals,? (.+?) Circuit$/i.exec(s)
    || /^United States Court of Appeals,? (?:for the )?(.+?) Circuit$/i.exec(s);
  if (m && CIRCUITS[m[1].toLowerCase()]) return { abbrev: CIRCUITS[m[1].toLowerCase()], state: null, level: 'federal' };
  m = /^United States (District|Bankruptcy) Court,? (?:for the )?([NSEWCM]\. ?D\.|D\.|(?:Northern|Southern|Eastern|Western|Central|Middle) District of|District of) ?(.+)$/i.exec(s);
  if (m) {
    const state = /^Columbia\b/i.test(m[3]) && /district of/i.test(m[2]) ? 'District of Columbia' : stateIn(m[3]);
    if (!state) return null;
    const pre = /^D\.$|^District of$/i.test(m[2]) ? 'D.' : `${m[2].trim()[0].toUpperCase()}.D.`;
    const base = state === 'District of Columbia' ? 'D.D.C.' : joinDistrict(pre, STATE_ABBREV[state]);
    return { abbrev: m[1].toLowerCase() === 'bankruptcy' ? `Bankr. ${base}` : base, state: null, level: 'federal' };
  }
  if (/^United States Court of Federal Claims$/i.test(s)) return { abbrev: 'Fed. Cl.', state: null, level: 'federal' };

  const state = stateIn(s);
  if (!state) return null;
  const st = STATE_ABBREV[state];
  // New York is the one state whose "Supreme Court" is a trial court and whose
  // "Court of Appeals" is the highest.
  if (state === 'New York') {
    if (/^Court of Appeals of New York$/i.test(s)) return { abbrev: 'N.Y.', state, level: 'high' };
    if (/Appellate Division/i.test(s)) return { abbrev: 'N.Y. App. Div.', state, level: 'intermediate' };
    if (/Appellate Term/i.test(s)) return { abbrev: 'N.Y. App. Term', state, level: 'intermediate' };
    if (/^Supreme Court\b/i.test(s)) return { abbrev: 'N.Y. Sup. Ct.', state, level: 'trial' };
    if (/Court of Claims/i.test(s)) return { abbrev: 'N.Y. Ct. Cl.', state, level: 'trial' };
    if (/Civil Court/i.test(s)) return { abbrev: 'N.Y. Civ. Ct.', state, level: 'trial' };
    if (/Surrogate/i.test(s)) return { abbrev: 'N.Y. Sur. Ct.', state, level: 'trial' };
    if (/Family Court/i.test(s)) return { abbrev: 'N.Y. Fam. Ct.', state, level: 'trial' };
    if (/^County Court/i.test(s)) return { abbrev: 'N.Y. Cnty. Ct.', state, level: 'trial' };
    if (/^District Court/i.test(s)) return { abbrev: 'N.Y. Dist. Ct.', state, level: 'trial' };
    if (/^Criminal Court/i.test(s)) return { abbrev: 'N.Y. Crim. Ct.', state, level: 'trial' };
    if (/^City Court/i.test(s)) return { abbrev: 'N.Y. City Ct.', state, level: 'trial' };
    return null;
  }
  if (/^Supreme (Judicial )?Court of /i.test(s)) return { abbrev: st, state, level: 'high' };
  if (state === 'Maryland' && /^Court of Appeals of Maryland$/i.test(s)) return { abbrev: st, state, level: 'high' };
  if (/^Court of Criminal Appeals of Texas$/i.test(s)) return { abbrev: 'Tex. Crim. App.', state, level: 'high' };
  if (/^Court of Chancery of Delaware/i.test(s)) return { abbrev: 'Del. Ch.', state, level: 'trial' };
  if (/^Court of Appeals of Texas/i.test(s)) return { abbrev: 'Tex. App.', state, level: 'intermediate' };
  if (/^Superior Court of Pennsylvania$/i.test(s)) return { abbrev: 'Pa. Super. Ct.', state, level: 'intermediate' };
  if (/^Commonwealth Court of Pennsylvania$/i.test(s)) return { abbrev: 'Pa. Commw. Ct.', state, level: 'intermediate' };
  if (/^Superior Court of New Jersey, Appellate Division$/i.test(s)) return { abbrev: 'N.J. Super. Ct. App. Div.', state, level: 'intermediate' };
  if (/^Appellate Court of /i.test(s)) return { abbrev: `${st} App. Ct.`, state, level: 'intermediate' };
  if (/^Court of Civil Appeals of Texas/i.test(s)) return { abbrev: 'Tex. Civ. App.', state, level: 'intermediate' };
  if (/^Court of Appeal,.*California$/i.test(s)) return { abbrev: 'Cal. Ct. App.', state, level: 'intermediate' };
  if (/^District Court of Appeal of Florida/i.test(s)) return { abbrev: 'Fla. Dist. Ct. App.', state, level: 'intermediate' };
  if (/^(Court of Appeals|Appeals Court|Court of Special Appeals|Intermediate Court of Appeals) of /i.test(s)) {
    if (/^Appeals Court of Massachusetts$/i.test(s)) return { abbrev: 'Mass. App. Ct.', state, level: 'intermediate' };
    if (/^Court of Special Appeals of Maryland$/i.test(s)) return { abbrev: 'Md. Ct. Spec. App.', state, level: 'intermediate' };
    return { abbrev: `${st} Ct. App.`, state, level: 'intermediate' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Case names (R10.2 / T6)
// ---------------------------------------------------------------------------

// Westlaw strips punctuation from the file name ("Matter of Formica Constr Inc
// v Mintz"). These are the T6 abbreviations whose period or apostrophe went.
const T6_RESTORE = Object.freeze({
  v: 'v.', Inc: 'Inc.', Co: 'Co.', Corp: 'Corp.', Ltd: 'Ltd.', Constr: 'Constr.', Assn: "Ass'n",
  Assns: "Ass'ns", Dept: "Dep't", Intl: "Int'l", Natl: "Nat'l", Govt: "Gov't", Commn: "Comm'n",
  Commr: "Comm'r", Bd: 'Bd.', Ctr: 'Ctr.', Mfg: 'Mfg.', Mgmt: 'Mgmt.', Sys: 'Sys.', Servs: 'Servs.',
  Serv: 'Serv.', Prods: 'Prods.', Prod: 'Prod.', Indus: 'Indus.', Ins: 'Ins.', Fin: 'Fin.', Grp: 'Grp.',
  Hosp: 'Hosp.', Univ: 'Univ.', Bros: 'Bros.', Elec: 'Elec.', Educ: 'Educ.', Transp: 'Transp.',
  Tel: 'Tel.', Tech: 'Tech.', Sec: 'Sec.', Invs: 'Invs.', Inv: 'Inv.', Mut: 'Mut.', Admin: 'Admin.',
  Admr: "Adm'r", Cnty: 'Cnty.', Dist: 'Dist.', Auth: 'Auth.', Ry: 'Ry.', Sch: 'Sch.', Socy: "Soc'y",
  Cmty: 'Cmty.', Assocs: 'Assocs.', Assoc: 'Assoc.', Bldg: 'Bldg.', Cas: 'Cas.', Chem: 'Chem.',
  Commc: 'Commc', Contl: "Cont'l", Distrib: 'Distrib.', Dev: 'Dev.', Emps: 'Emps.', Emp: 'Emp.',
  Engg: "Eng'g", Enters: 'Enters.', Envtl: "Env't", Equip: 'Equip.', Fed: 'Fed.', Gen: 'Gen.',
  Hous: 'Hous.', Info: 'Info.', Invest: 'Inv.', Litig: 'Litig.', Mktg: 'Mktg.', Med: 'Med.',
  Pharm: 'Pharm.', Pub: 'Pub.', Rsch: 'Rsch.', Ret: 'Ret.', Sav: 'Sav.', Tr: 'Tr.', Twp: 'Twp.',
  Util: 'Util.', Vill: 'Vill.', Acc: 'Acc.', Comn: "Comm'n", Intern: "Int'l", Intl: "Int'l", Wkrs: 'Workers', LLC: 'LLC', LLP: 'LLP', LP: 'LP', PC: 'P.C.',
  NA: 'N.A.', RR: 'R.R.', Am: 'Am.', Ams: 'Ams.', Nw: 'Nw.', Ne: 'Ne.', Sw: 'Sw.', Se: 'Se.',
});

// New York Official Reports abbreviate their own way ("Assn.", "Natl.");
// these are the Bluebook forms (T6).
const NY_TO_T6 = Object.freeze({
  'Assn.': "Ass'n", 'Assns.': "Ass'ns", 'Natl.': "Nat'l", 'Dept.': "Dep't", 'Govt.': "Gov't",
  'Commn.': "Comm'n", 'Commr.': "Comm'r", 'Intl.': "Int'l", 'Contl.': "Cont'l", 'Socy.': "Soc'y",
  'Engg.': "Eng'g", 'Envtl.': "Env't", 'Admr.': "Adm'r", 'Admx.': "Adm'x", 'Bros.': 'Bros.',
});

// T6: words abbreviated in a case name in a citation (R10.2.2).
const T6_WORDS = Object.freeze({
  Administration: 'Admin.', Administrative: 'Admin.', Administrator: "Adm'r", America: 'Am.',
  American: 'Am.', Association: "Ass'n", Associates: 'Assocs.', Authority: 'Auth.', Board: 'Bd.',
  Brothers: 'Bros.', Building: 'Bldg.', Center: 'Ctr.', Chemical: 'Chem.', Commission: "Comm'n",
  Commissioner: "Comm'r", Communications: "Commc'ns", Community: 'Cmty.', Company: 'Co.',
  Consolidated: 'Consol.', Construction: 'Constr.', Continental: "Cont'l", Corporation: 'Corp.',
  Corrections: 'Corr.', County: 'Cnty.', Department: "Dep't", Development: 'Dev.', Distribution: 'Distrib.',
  District: 'Dist.', Education: 'Educ.', Electric: 'Elec.', Electronic: 'Elec.', Engineering: "Eng'g",
  Enterprise: 'Enter.', Enterprises: 'Enters.', Environment: "Env't", Environmental: "Env't",
  Equipment: 'Equip.', Federal: 'Fed.', Financial: 'Fin.', Finance: 'Fin.', General: 'Gen.',
  Government: "Gov't", Group: 'Grp.', Hospital: 'Hosp.', Hospitals: 'Hosps.', Housing: 'Hous.',
  Incorporated: 'Inc.', Industries: 'Indus.', Industry: 'Indus.', Information: 'Info.',
  Insurance: 'Ins.', International: "Int'l", Investment: 'Inv.', Investments: 'Invs.',
  Liability: 'Liab.', Limited: 'Ltd.', Management: 'Mgmt.', Manufacturing: 'Mfg.', Marketing: 'Mktg.',
  Medical: 'Med.', Municipal: 'Mun.', Mutual: 'Mut.', National: "Nat'l", Pharmaceutical: 'Pharm.',
  Pharmaceuticals: 'Pharms.', Products: 'Prods.', Public: 'Pub.', Railroad: 'R.R.', Railway: 'Ry.',
  Savings: 'Sav.', School: 'Sch.', Securities: 'Sec.', Services: 'Servs.', Service: 'Serv.',
  Society: "Soc'y", System: 'Sys.', Systems: 'Sys.', Technology: 'Tech.', Technologies: 'Techs.',
  Telephone: 'Tel.', Transportation: 'Transp.', Transport: 'Transp.', University: 'Univ.', Accident: 'Acc.',
  Partnership: "P'ship", Schools: 'Schs.', Village: 'Vill.', Americas: 'Ams.', Automobile: 'Auto.',
  Casualty: 'Cas.', Surety: 'Sur.', Company: 'Co.', Companies: 'Cos.', Holdings: 'Holdings',
});

function tidyCaseName(name) {
  let s = String(name || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // New York's style ("People v Doe") and a stripped file name both lack the period.
  s = s.replace(/ v (?=\S)/g, ' v. ');
  // R10.2.1(b): a procedural phrase goes when adverse parties are named
  // ("Matter of Formica Constr. v. Mintz" → "Formica Constr. v. Mintz");
  // without them, "Matter of X" is "In re X".
  if (/ v\. /.test(s)) s = s.replace(/^(?:In the Matter of|Matter of|In re) /i, '');
  else s = s.replace(/^(?:In the )?Matter of /i, 'In re ');
  s = s.split(' ').map((w) => NY_TO_T6[w] ?? w).join(' ');
  // A stripped file name writes the United States as "US".
  s = s.replace(/(^|\bv\. )US\b(?!\.)/g, '$1United States');
  // R10.2.1(c): "and" joining names is "&".
  s = s.replace(/ [Aa]nd (?=[A-Z])/g, ' & ');
  // T6 words, keeping any punctuation stuck to them ("Corporation," → "Corp.,").
  s = s.replace(/\b([A-Z][a-z]+)\b/g, (w) => T6_WORDS[w] ?? w);
  // A business designation takes a comma before it (R10.2.1(h))…
  s = s.replace(/([A-Za-z.)'])\s+(Inc\.|Ltd\.|L\.L\.C\.|LLC|LLP|L\.P\.|N\.A\.|P\.C\.)(?=$|[\s,])/g, '$1, $2');
  // …and is dropped when the name already says it is a business.
  s = s.replace(/\b(Co\.|Corp\.|Ass'n|R\.R\.|Ry\.|Bros\.),? (?:Inc\.|Ltd\.|L\.L\.C\.|LLC)(?=$|[\s,])/g, '$1');
  return s.replace(/\s+,/g, ',').trim();
}

// "Matthews v Unisource Worldwide Inc" → "Matthews v. Unisource Worldwide, Inc."
export function caseNameFromFilename(filename) {
  let base = String(filename || '').replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/\s*\(\d+\)$/, '')
    .replace(/^\d{1,3}\s*[-–.]\s*/, '').trim();   // "1 - Trireme …" (a numbered download)
  if (!/ v\.? /.test(base) && !/^(In re|Matter of|In the Matter of|Ex parte|Ex rel\.?) /i.test(base)) return null;
  base = base.replace(/\b((?:Borough|Town|City|Village|County|Township|Twp) of [A-Z][\w'-]*(?: [A-Z][\w'-]*)?) (?:Pa|Pennsylvania|Colo|Colorado|NY|NJ|Tex|Texas|Cal|Calif|Ill|Ohio|Mass|Conn|Mich|Fla|Ga|Va|Md|Minn|Wis|Wash|Or|Ariz|Nev|Mo|Ind|Ky|Tenn|La|Ala|Okla|Kan|Neb|Iowa|Utah)\b/g, '$1');
  base = base.split(' ').map((w) => T6_RESTORE[w] ?? w).join(' ');
  return tidyCaseName(base);
}

// ---------------------------------------------------------------------------
// Parse one Westlaw delivery
// ---------------------------------------------------------------------------

function pad(n) { return String(n); }

/**
 * @param {{ headText: string, sourceFilename?: string|null }} input
 *   headText: the document's opening text (its first passages, in order).
 * @returns {{ kind: 'case', case_name: string|null, case_name_source: string|null,
 *   reporters: { level: number, volume: number, reporter: string, page: number }[],
 *   wl: { year: number, number: string }|null, docket: string|null,
 *   court: { line: string, abbrev: string, state: string|null, level: string }|null,
 *   court_line: string|null, date: { year: number, month?: number, day?: number }|null,
 *   problems: string[] } | { kind: 'other', reason: string }}
 */
export function parseWestlawCase({ headText, sourceFilename = null, bodyText = '' }) {
  const raw = String(headText || '');
  const flat = raw.replace(/\s+/g, ' ').trim();
  const problems = [];

  // PDF running header: "Name, 748 A.2d 219 (2000)" (sometimes several cites).
  let caseName = null;
  let caseNameSource = null;
  let headerYear = null;
  const run = new RegExp(`^(.{3,200}?), (\\d{1,4} (?:${REPORTER_RE}) \\d{1,5}(?:, \\d{1,4} (?:${REPORTER_RE}) \\d{1,5})*|\\d{4} WL \\d+) \\((?:[^()]*? )?(\\d{4})\\)`).exec(flat);
  if (run) {
    caseName = tidyCaseName(run[1]);
    caseNameSource = 'westlaw running header';
    headerYear = Number(run[3]);
  }
  if (!caseName) {
    const nyTitle = /CITE TITLE AS: (.+?)(?= HEADNOTE| SUMMARY| Supreme Court| Court of| APPEARANCES|$)/.exec(flat);
    if (nyTitle) { caseName = tidyCaseName(nyTitle[1]); caseNameSource = 'NY Official Reports cite title'; }
  }
  if (!caseName && sourceFilename) {
    caseName = caseNameFromFilename(sourceFilename);
    if (caseName) caseNameSource = 'Westlaw file name';
  }

  // The reporter block: the cites that open the document (after a running
  // header, the block repeats after the page number).
  const afterRun = run ? flat.slice(run[0].length) : flat;
  const zone = afterRun.slice(0, 400);
  const reporters = [];
  const citeRe = new RegExp(`(?:^|[\\s,])(\\d{1,4}) (${REPORTER_RE}) (\\d{1,5})(?=[\\s,]|$)`, 'g');
  let m;
  const pushCite = (mm) => {
    const r = { volume: Number(mm[1]), reporter: normalizeReporter(mm[2]), page: Number(mm[3]) };
    if (!reporters.some((x) => x.volume === r.volume && x.reporter === r.reporter && x.page === r.page)) reporters.push(r);
  };
  // A PDF's running header carries the case's cites ("…, 556 U.S. 49, 129
  // S.Ct. 1262 (2009)"); the block after it may repeat only some of them.
  if (run) {
    const runRe = new RegExp(citeRe.source, 'g');
    let rm;
    while ((rm = runRe.exec(` ${run[2]}`)) && reporters.length < 3) pushCite(rm);
  }
  while ((m = citeRe.exec(zone)) && reporters.length < 3) {
    if (m.index > 120 && reporters.length === 0) break;   // not an opening block
    pushCite(m);
  }
  // Every cite in the header, for a star level the opening block does not
  // name (bluebookCite matches them by page before using one).
  const allRe = new RegExp(citeRe.source, 'g');
  const all_cites = [];
  let am;
  // Only the header: everything before the opinion's first star page. A case
  // the synopsis cites is not this case.
  const firstStar = flat.search(/(?:^|\s)\*{1,3}\d{1,5}(?=\s)/);
  while ((am = allRe.exec(flat.slice(0, Math.min(3000, firstStar > 0 ? firstStar : 3000))))) {
    const c = { volume: Number(am[1]), reporter: normalizeReporter(am[2]), page: Number(am[3]) };
    if (!all_cites.some((x) => x.volume === c.volume && x.reporter === c.reporter && x.page === c.page)) all_cites.push(c);
  }
  // The document's OWN WL cite opens it (or its running header); a WL cite
  // further in is a case it cites.
  const wlM = /^(?:\S+\s){0,3}?(\d{4}) WL (\d{3,9})\b/.exec(afterRun) || (run && /(\d{4}) WL (\d{3,9})/.exec(run[2]));
  const wl = wlM ? { year: Number(wlM[1]), number: wlM[2] } : null;
  if (!reporters.length && !wl) return { kind: 'other', reason: 'no reporter or WL cite opens the document (not a case)' };

  // The court: the FIRST court name in the opening text. (Searching, not
  // splitting on periods — "S.D. New York." has periods inside it. And the
  // first one, because a lower court named later is the court below.)
  let court = null;
  let courtLine = null;
  const opening = afterRun.slice(0, 3000);
  const cm = COURT_NAME_RE.exec(opening);
  if (cm) {
    courtLine = cm[0].replace(/[.,]$/, '');
    court = courtFromWestlaw(courtLine);
  }
  if (!court) problems.push('court not recognised');

  // The date: "Decided Aug. 1, 2007" / "Filed …" / NY "August 25, 2009".
  let date = null;
  // "Decided …"/"Filed …" first; else the date that follows the court line
  // (New York's layout); else the running header's year. Never simply the
  // first date in the text — a synopsis names the dates of the case below.
  const dateAfter = (text) => new RegExp(`\\b${MONTH_RE} (\\d{1,2}),? (\\d{4})\\b`).exec(text);
  // Westlaw's header labels, capitalised, in order of authority. A WL-only
  // decision dates itself numerically ("Signed 09/27/2019").
  const headZone = flat.slice(0, 8000);
  let dm = null;
  for (const kw of ['Decided', 'DECIDED', 'Opinion Filed', 'Filed', 'FILED', 'Signed', 'Dated', 'Entered']) {
    const t = new RegExp(`\\b${kw}:? ${MONTH_RE} (\\d{1,2}),? (\\d{4})`).exec(headZone);
    if (t) { dm = { month: MONTHS.findIndex((mm) => t[1].toLowerCase().startsWith(mm.slice(0, 3).toLowerCase())) + 1, day: Number(t[2]), year: Number(t[3]) }; break; }
    const n = new RegExp(`\\b${kw}:? (\\d{1,2})/(\\d{1,2})/(\\d{4})`).exec(headZone);
    if (n) { dm = { month: Number(n[1]), day: Number(n[2]), year: Number(n[3]) }; break; }
  }
  // Westlaw's usual layout has no label at all: "No. 02–21182 | Jan. 25,
  // 2005. Synopsis …". An unlabelled date after a "|" in the header (before
  // the synopsis) is the decision date; an "Argued"/"Submitted" one is not.
  if (!dm) {
    const endOfHeader = flat.search(/\b(Synopsis|West Headnotes|Attorneys and Law Firms|Opinion)\b/);
    const header = flat.slice(0, endOfHeader > 0 ? Math.min(endOfHeader, 6000) : 4000);
    const re = new RegExp(`\\|\\s*(?:([A-Z][A-Za-z ]{2,20}?):?\\s+)?${MONTH_RE} (\\d{1,2}),? (\\d{4})`, 'g');
    let t;
    while ((t = re.exec(header))) {
      if (t[1] && /Argued|Submitted|Heard|Rehearing|Reargued|Considered/i.test(t[1])) continue;
      dm = { month: MONTHS.findIndex((mm) => t[2].toLowerCase().startsWith(mm.slice(0, 3).toLowerCase())) + 1, day: Number(t[3]), year: Number(t[4]) };
      break;
    }
  }
  if (!dm && courtLine) {
    const at = flat.indexOf(courtLine);
    const t = at >= 0 ? dateAfter(flat.slice(at + courtLine.length, at + courtLine.length + 160)) : null;
    if (t) dm = { month: MONTHS.findIndex((mm) => t[1].toLowerCase().startsWith(mm.slice(0, 3).toLowerCase())) + 1, day: Number(t[2]), year: Number(t[3]) };
  }
  if (dm && dm.year >= 1700 && dm.year <= 2100) {
    date = { year: dm.year, month: dm.month >= 1 && dm.month <= 12 ? dm.month : undefined, day: dm.day || undefined };
  } else if (headerYear) {
    date = { year: headerYear };
  }
  if (!date) problems.push('decision date not found');
  if (!caseName) problems.push('case name not found');

  // Docket, for a WL-only cite: "No. 19-cv-123" / "Nos. 09–07–135 CR, …".
  let docket = null;
  const dkRe = /\bNos?\. ((?:[A-Z0-9][\w:()\-–]*(?:\.(?= [\w(]))?(?: (?=[\w(]))?){1,8})/g;
  let dk;
  while ((dk = dkRe.exec(flat.slice(0, 1500)))) {
    const before = flat.slice(Math.max(0, dk.index - 12), dk.index);
    if (/(ECF|Dkt\.?|Doc\.?|Document|Index|Docket Entry)\s*$/i.test(before)) continue;
    const v = dk[1].replace(/–/g, '-').trim();
    if (/\d[-:]\d|\b(Civ|cv|CV|CR|Cr|MD|md|mc|MC)\b|[A-Z]{2,}-?\d|\d{2,}-[A-Z]/.test(v)) { docket = v.replace(/[,.]$/, ''); break; }
  }

  return {
    // A Supreme Court download in Word opens with the S. Ct. cite; its U.S.
    // volume turns up only later in the text. Collected here, used only on an
    // exact first-page match (bluebookCite).
    us_cites: court?.level === 'scotus'
      ? [...String(bodyText || '').matchAll(/\b(\d{1,3}) U\.\s?S\. (\d{1,4})\b/g)].map((u) => ({ volume: Number(u[1]), reporter: 'U.S.', page: Number(u[2]) }))
      : [],
    kind: 'case', case_name: caseName, case_name_source: caseNameSource, reporters, all_cites, wl, docket,
    court: court ? { line: courtLine, ...court } : null, court_line: courtLine, date, problems,
  };
}

// ---------------------------------------------------------------------------
// Build the cite
// ---------------------------------------------------------------------------

// U.S. Reports volume by year (start of the October Term), for checking a
// volume against a decision date. Interpolated between these points; a
// volume within 4 of the estimate fits (the Reports run four or five a year).
const US_VOLUME_BY_YEAR = [[1880, 102], [1900, 177], [1920, 251], [1940, 309], [1950, 339], [1960, 361],
  [1970, 397], [1980, 444], [1990, 494], [2000, 528], [2010, 559], [2020, 590], [2026, 608]];
export function usVolumeFits(volume, year) {
  if (!year || !volume) return false;
  const pts = US_VOLUME_BY_YEAR;
  if (year < pts[0][0] || year > pts[pts.length - 1][0] + 2) return false;
  let est = pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    if (year <= pts[i][0]) {
      const [y0, v0] = pts[i - 1]; const [y1, v1] = pts[i];
      est = v0 + ((year - y0) * (v1 - v0)) / (y1 - y0);
      break;
    }
  }
  return Math.abs(volume - est) <= 4;
}

/** R3.2(a): 1221–1222 → 1221–22; 99–101 stays. */
export function pinRange(a, b) {
  if (b == null || b === a) return String(a);
  const sa = String(a); const sb = String(b);
  if (sa.length !== sb.length) return `${sa}–${sb}`;
  let i = 0;
  while (i < sa.length - 2 && sa[i] === sb[i]) i++;
  return `${sa}–${sb.slice(i)}`;
}

// Which of the case's reporters to cite (R10.3.1), as an index into reporters.
function chooseReporter(info) {
  const rs = info.reporters;
  if (!rs.length) return -1;
  const find = (re) => rs.findIndex((r) => re.test(r.reporter));
  if (info.court?.level === 'scotus') {
    for (const re of [/^U\.S\./, /^S\. ?Ct\./, /^L\. ?Ed\./]) { const i = find(re); if (i >= 0) return i; }
  }
  const fed = find(FEDERAL);
  if (fed >= 0) return fed;
  for (const re of [REGIONAL, WEST_STATE]) { const i = find(re); if (i >= 0) return i; }
  return 0;
}

// The court as it goes in the parenthetical, given the reporter cited.
function courtForParenthetical(info, reporter) {
  const c = info.court;
  if (!c) return null;
  if (c.level === 'scotus') return '';
  if (c.level === 'federal') return c.abbrev;
  const st = c.state ? STATE_ABBREV[c.state] : null;
  const officialOfState = st && (reporter.startsWith(st.replace(/ /g, '')) || reporter.startsWith(st)
    || (c.state === 'New York' && /^(N\.Y\.|A\.D\.|Misc\.)/.test(reporter)));
  if (officialOfState) {
    if (c.level === 'high') return '';
    // The reporter names the state; the court keeps what is left ("App. Div.").
    return c.abbrev.startsWith(`${st} `) ? c.abbrev.slice(st.length + 1) : c.abbrev;
  }
  return c.abbrev;
}

function dateText(date, exact) {
  if (!date) return null;
  if (exact && date.month && date.day) return `${MONTHS[date.month - 1]} ${pad(date.day)}, ${date.year}`;
  return String(date.year);
}

/**
 * Which star level carries which header reporter, by page: a level's run
 * starts at (or just after) that reporter's first page. Position is not
 * trusted — New York Official Reports use "**" for pages of a slip opinion.
 *
 * @param reporters parseWestlawCase().reporters
 * @param levels    westlawStarPages().levels — { 1: { first, last }, … }
 * @returns reporter index → star level
 */
export function levelsForReporters(reporters, levels, maxGap = 15) {
  const out = {};
  const taken = new Set();
  const entries = Object.entries(levels || {}).map(([l, v]) => [Number(l), v]);
  reporters.forEach((r, i) => {
    let best = null;
    for (const [level, run] of entries) {
      if (taken.has(level) || run?.first == null) continue;
      const gap = run.first - r.page;
      // A run belongs to a reporter whose first page it starts on or just
      // after, and whose case could plausibly be that long.
      // Westlaw's star paging begins where the opinion text does, which can
      // be several pages in (syllabus, headnotes): 15 pages of slack.
      if (gap >= 0 && gap <= maxGap && run.last >= r.page && run.last - r.page <= 600 && (best === null || gap < best.gap)) {
        best = { level, gap };
      }
    }
    if (best) { out[i] = best.level; taken.add(best.level); }
  });
  return out;
}

/**
 * The Bluebook cite for a passage, or null (with the reason) when a part is
 * missing — the caller then keeps "Title, p. N".
 *
 * @param info   parseWestlawCase() output
 * @param pages  { 1: [start, end], 2: [...], 3: [...] } reporter pages by star level
 * @param levels westlawStarPages().levels, to tie each level to its reporter
 */
export function bluebookCite(info, pages, levels) {
  if (!info || info.kind !== 'case') return { cite: null, reason: 'not a case' };
  if (!info.case_name) return { cite: null, reason: 'case name not found' };
  if (!info.court) return { cite: null, reason: 'court not recognised' };
  if (!info.date) return { cite: null, reason: 'decision date not found' };
  const name = info.case_name;

  // A reported case: pin to the chosen reporter's star pages, else fall back
  // through the others in the case's own order.
  if (info.reporters.length) {
    // A star level no opening cite claims may still be named elsewhere in the
    // header — a Supreme Court download opens with the S. Ct. cite while its
    // single-star pages are the U.S. Reports'. Take a header cite whose first
    // page that level's run starts from, and nothing looser.
    const claimed = new Set(Object.values(levelsForReporters(info.reporters, levels)));
    const spare = Object.fromEntries(Object.entries(levels || {}).filter(([l]) => !claimed.has(Number(l))));
    if (Object.keys(spare).length && info.all_cites?.length) {
      const extra = info.all_cites.filter((c) => !info.reporters.some((r) => r.volume === c.volume && r.reporter === c.reporter));
      const fit = levelsForReporters(extra, spare, 8);
      info = { ...info, reporters: [...info.reporters, ...Object.keys(fit).map((i) => extra[Number(i)])] };
    }
    // The U.S. Reports for a Supreme Court case whose header named only S. Ct.:
    // a U.S. cite from the text whose first page is exactly where a spare star
    // run begins. Nothing looser — the opinion cites other U.S. cases.
    if (info.court?.level === 'scotus' && !info.reporters.some((r) => r.reporter === 'U.S.') && info.us_cites?.length) {
      const taken = new Set(Object.values(levelsForReporters(info.reporters, levels)));
      for (const [l, run] of Object.entries(levels || {})) {
        if (taken.has(Number(l))) continue;
        // Exact first page AND a volume the decision year allows: page 1 is
        // every term's first case, so the page alone does not pick one.
        const hits = info.us_cites.filter((u) => u.page === run.first && usVolumeFits(u.volume, info.date?.year));
        const vols = new Set(hits.map((u) => u.volume));
        const hit = vols.size === 1 ? hits[0] : null;
        if (hit) { info = { ...info, reporters: [...info.reporters, hit] }; break; }
      }
    }
    const levelOf = levelsForReporters(info.reporters, levels);
    const first = chooseReporter(info);
    const order = [first, ...info.reporters.map((_, i) => i).filter((i) => i !== first)];
    for (const i of order) {
      const r = info.reporters[i];
      const lvl = levelOf[i];
      const pin = lvl ? pages?.[lvl] : null;
      if (!pin) continue;
      const court = courtForParenthetical(info, r.reporter);
      if (court === null) return { cite: null, reason: 'court not recognised' };
      const paren = `(${court ? `${court} ` : ''}${dateText(info.date, false)})`;
      return { cite: `${name}, ${r.volume} ${r.reporter} ${r.page}, ${pinRange(pin[0], pin[1])} ${paren}`, reason: null };
    }
    return { cite: null, reason: 'no page for this passage in any reporter' };
  }

  // Westlaw-only (R10.8.1): name, docket, WL cite, "at *N", court and exact date.
  const pin = pages?.[1];
  if (!pin) return { cite: null, reason: 'no star page for this passage' };
  const when = dateText(info.date, true);
  const court = info.court.level === 'scotus' ? '' : info.court.abbrev;
  return {
    cite: `${name}, ${info.docket ? `No. ${info.docket}, ` : ''}${info.wl.year} WL ${info.wl.number}, at *${pinRange(pin[0], pin[1])} (${court ? `${court} ` : ''}${when})`,
    reason: null,
  };
}

/**
 * The Bluebook cite for every passage of one Westlaw document, given what
 * lib/westlaw-pages.mjs found. `info` is the parsed header (stored on the
 * document for audit); `cites[i]` is passage i's cite, or null.
 */
export function bluebookCitesFor(passages, westlaw, sourceFilename) {
  const list = Array.isArray(passages) ? passages : [];
  if (!westlaw?.claimed) return { info: null, cites: list.map(() => null) };
  const texts = list.map((p) => String(p?.text || ''));
  const info = parseWestlawCase({
    headText: texts.slice(0, 8).join(' ').slice(0, 9000),
    sourceFilename,
    bodyText: texts.join(' '),
  });
  const cites = westlaw.pages.map((pg) => {
    if (!pg || info.kind !== 'case') return null;
    const pages = { 1: [pg.printed_page, pg.printed_page_end], ...(pg.star_pages || {}) };
    return bluebookCite(info, pages, westlaw.levels).cite;
  });
  return { info, cites };
}

/** What is kept on documents.metadata.westlaw_case: the parse, without the text lists. */
export function westlawCaseSummary(info) {
  if (!info) return null;
  if (info.kind !== 'case') return { kind: info.kind, reason: info.reason };
  return {
    kind: 'case', case_name: info.case_name, case_name_source: info.case_name_source,
    reporters: info.reporters, wl: info.wl, docket: info.docket,
    court: info.court ? { line: info.court.line, abbrev: info.court.abbrev, level: info.court.level } : null,
    date: info.date, problems: info.problems,
  };
}

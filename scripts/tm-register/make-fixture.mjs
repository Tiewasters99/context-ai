// scripts/tm-register/make-fixture.mjs — writes the register copy's committed
// test fixtures (scripts/fixtures/tm-register/). Run once by hand; CI only
// reads the files it wrote.
//
//   node scripts/tm-register/make-fixture.mjs "<path to tmSearchResults2026-10-18 (1).xlsx>"
//
// SYNTHETIC FILES IN THE DOCUMENTED SHAPE. No USPTO bulk file was available
// (the ODP download needs an API key Eden does not have yet), so the XML is
// written here in the shape of the "Trademark Applications Daily XML DTD
// Element Documentation (V 2.0)". What is real and what is not:
//
//   REAL (copied from Eden's tmsearch export of 2026-10-18, query
//   CM:equa* AND LD:true AND IC:(009 042 045 a b 200), 392 rows): serial,
//   word mark, owner, goods and services (tmsearch truncates them), filing
//   date, international classes, registration number and date. Also real,
//   from Eden's 10-19 notes of the same run: the serials and marks of
//   YUEQUAZELL, EQUAZEN x2, EQUALL COPILOT, EQUALL (025) and WORLD OF EQUALL.
//   NOT KNOWN, so left out (never invented on a real serial): status codes,
//   pseudo marks, translations, design codes, attorney, US classes.
//   INVENTED, and named so (serials in the 76999xxx block): a handful of
//   records that exercise the parser and the search (pseudo mark, numeral,
//   translation, dead, design code). They are not register records.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'scripts', 'fixtures', 'tm-register');
fs.mkdirSync(OUT, { recursive: true });

const xlsxPath = process.argv[2];
if (!xlsxPath) { console.error('usage: node scripts/tm-register/make-fixture.mjs <tmSearchResults xlsx>'); process.exit(2); }
const XLSX = (await import('xlsx')).default;
const wb = XLSX.read(fs.readFileSync(xlsxPath));
const table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
const query = table[1][2];
const hi = table.findIndex((r) => r[0] === 'SerialNumber');
const hdr = table[hi];
const exportRows = table.slice(hi + 1).filter((r) => /^\d{8}$/.test(String(r[0]))).map((r) => Object.fromEntries(hdr.map((h, i) => [h, String(r[i] ?? '')])));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const d8 = (iso) => (iso ? iso.replace(/-/g, '') : '00000000');
const classesOf = (s) => [...String(s).matchAll(/(?:IC|US)?\s*(\d{3}|A|B)\b/g)].map((m) => m[1]).filter((c, i, a) => a.indexOf(c) === i);
const ownerName = (s) => String(s).split(' (')[0].trim();
function goodsOf(s) {
  const out = [];
  for (const part of String(s).split(/;\s*(?=(?:IC|US) [0-9A-B]{1,3}:)/)) {
    const m = /^(?:IC|US) ([0-9A-B]{1,3}):\s*(.*)$/s.exec(part.trim());
    if (m) out.push({ cls: m[1].padStart(3, '0'), text: m[2].trim() });
  }
  return out;
}

function caseFile(r) {
  const st = [];
  for (const g of r.goods ?? []) st.push(`<case-file-statement><type-code>GS${g.cls}1</type-code><text>${esc(g.text)}</text></case-file-statement>`);
  for (const [i, p] of (r.pseudo ?? []).entries()) st.push(`<case-file-statement><type-code>PM${String(i + 1).padStart(4, '0')}</type-code><text>${esc(p)}</text></case-file-statement>`);
  for (const t of r.translations ?? []) st.push(`<case-file-statement><type-code>TR0010</type-code><text>${esc(t)}</text></case-file-statement>`);
  const cls = (r.classes ?? []).map((c) => `<classification><international-code-total-no>1</international-code-total-no><us-code-total-no>0</us-code-total-no><international-code>${c}</international-code><status-code>6</status-code><primary-code>${c}</primary-code></classification>`).join('');
  const design = (r.design ?? []).length ? `<design-searches>${r.design.map((c) => `<design-search><code>${c}</code></design-search>`).join('')}</design-searches>` : '<design-searches/>';
  return [
    '<case-file>',
    `<serial-number>${r.serial}</serial-number>`,
    `<registration-number>${String(r.reg ?? '').replace(/\D/g, '').padStart(7, '0') || '0000000'}</registration-number>`,
    `<transaction-date>${d8(r.tx)}</transaction-date>`,
    '<case-file-header>',
    `<filing-date>${d8(r.filed)}</filing-date>`,
    `<registration-date>${d8(r.regDate)}</registration-date>`,
    r.status ? `<status-code>${r.status}</status-code>` : '<status-code/>',
    `<status-date>${d8(r.statusDate)}</status-date>`,
    `<mark-identification>${esc(r.mark)}</mark-identification>`,
    `<mark-drawing-code>${r.drawing ?? '4000'}</mark-drawing-code>`,
    `<abandonment-date>${d8(r.abandoned)}</abandonment-date>`,
    `<cancellation-date>${d8(r.cancelled)}</cancellation-date>`,
    '</case-file-header>',
    st.length ? `<case-file-statements>${st.join('')}</case-file-statements>` : '<case-file-statements/>',
    cls ? `<classifications>${cls}</classifications>` : '<classifications/>',
    `<case-file-owners><case-file-owner><entry-number>01</entry-number><party-type>10</party-type><legal-entity-type-code>${r.entity ?? '03'}</legal-entity-type-code><party-name>${esc(r.owner)}</party-name></case-file-owner></case-file-owners>`,
    design,
    '</case-file>',
  ].join('');
}

function file({ versionNo = '2.0-synthetic', versionDate = '20261021', records, actionKey = 'NA', noData = false, comment }) {
  const body = noData
    ? '<application-information><data-available-code>N</data-available-code></application-information>'
    : `<application-information><file-segments><file-segment>TRMK</file-segment><action-keys><action-key>${actionKey}</action-key>\n${records.map(caseFile).join('\n')}\n</action-keys></file-segments></application-information>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${comment} -->\n<trademark-applications-daily><version><version-no>${versionNo}</version-no><version-date>${versionDate}</version-date></version>\n${body}\n</trademark-applications-daily>\n`;
}

const SYNTH = 'SYNTHETIC TEST FIXTURE in the shape of the USPTO Trademark Applications Daily XML (DTD documentation V 2.0). NOT a USPTO file.';

// The 392 real rows of the 10-18 Q7 export.
const real = exportRows.map((r) => ({
  serial: r.SerialNumber, mark: r.Wordmark, owner: ownerName(r.OwnerFullText), filed: r.FiledDate || null,
  regDate: r.RegistrationDate || null, reg: r.RegistrationNumber || null, classes: classesOf(r.InternationalClass),
  goods: goodsOf(r.GoodsAndServicesTruncated), tx: '2026-10-18',
}));
// From Eden's 10-19 notes (real serials and marks; goods text and dates not known: left out or marked).
const fromNotes = [
  { serial: '99887921', mark: 'YUEQUAZELL', owner: 'Xin Yang', classes: ['014'], goods: [{ cls: '014', text: 'Jewelry [goods text not in the notes]' }] },
  { serial: '97272405', mark: 'EQUAZEN FOR EVERY MIND.', owner: 'SOHO FLORDIS UK LIMITED', classes: ['005'], goods: [{ cls: '005', text: 'Supplements [goods text not in the notes]' }] },
  { serial: '85889029', mark: 'EQUAZEN', owner: 'SOHO FLORDIS UK LIMITED', classes: ['005'], goods: [{ cls: '005', text: 'Supplements [goods text not in the notes]' }] },
  { serial: '98137417', mark: 'EQUALL COPILOT', owner: 'Equall Inc.', classes: ['009', '042'], abandoned: '2025-01-01', goods: [] },
  { serial: '88129739', mark: 'EQUALL', owner: 'Demosthene, Clebens', classes: ['025'], abandoned: '2020-01-01', goods: [] },
  { serial: '88634323', mark: 'WORLD OF EQUALL', owner: 'Demosthene, Clebens', classes: ['025'], goods: [] },
].map((r) => ({ ...r, tx: '2026-10-18', note: 'notes' }));
// Invented: not register records.
const invented = [
  { serial: '76999901', mark: 'EQUAZYA', pseudo: ['EQUAZIA'], owner: 'Invented Fixture Co.', classes: ['042'], status: '630', goods: [{ cls: '042', text: 'Software as a service (INVENTED record: a pseudo mark)' }] },
  { serial: '76999902', mark: '4U LEGAL', owner: 'Invented Fixture Co.', classes: ['045'], status: '700', goods: [{ cls: '045', text: 'Legal services (INVENTED record: a numeral, no pseudo mark)' }] },
  { serial: '76999903', mark: 'LA EQUAZIONE', translations: ['The English translation of "LA EQUAZIONE" in the mark is "THE EQUATION".'], owner: 'Invented Fixture S.r.l.', classes: ['009'], status: '700', goods: [{ cls: '009', text: 'Downloadable software (INVENTED record: a translation)' }] },
  { serial: '76999904', mark: 'EQUAZIO', owner: 'Invented Fixture Co.', classes: ['042'], status: '602', abandoned: '2024-05-01', goods: [{ cls: '042', text: 'Software (INVENTED record: dead, abandoned)' }] },
  { serial: '76999905', mark: 'EKWAZIA', owner: 'Invented Fixture Co.', classes: ['042'], status: '630', drawing: '3000', design: ['260101', '261121'], goods: [{ cls: '042', text: 'Platform as a service (INVENTED record: a sound-alike with design codes)' }] },
  { serial: '76999906', mark: 'MCQUAZIA\'S & CO', owner: 'Invented Fixture Co.', classes: ['035'], status: '700', goods: [{ cls: '035', text: 'Retail (INVENTED record: punctuation; class outside the search)' }] },
].map((r) => ({ ...r, tx: '2026-10-18', entity: '16' }));

const backfile = [...real, ...fromNotes, ...invented].sort((a, b) => a.serial.localeCompare(b.serial));
fs.writeFileSync(path.join(OUT, 'apc-synthetic-backfile-20261018.xml'), file({
  records: backfile,
  comment: `${SYNTH} ${real.length} rows carry the real serial, mark, owner, goods (truncated), classes, filing and registration data of Eden's tmsearch export of 2026-10-18 (${query}); ${fromNotes.length} rows come from Eden's 10-19 notes; ${invented.length} rows (serials 76999901-76999906) are INVENTED. Status codes, pseudo marks, translations and design codes of real rows are not known and are left out.`,
}));

// A "daily" update: one changed record (EQUALL: an invented status change), one new invented filing.
const equall = real.find((r) => r.serial === '98137428');
const daily = [
  { ...equall, status: '730', statusDate: '2026-10-19', tx: '2026-10-19', note: 'INVENTED status change for the upsert test' },
  { serial: '76999907', mark: 'EQUASIA', owner: 'Invented Fixture Co.', classes: ['009'], status: '630', filed: '2026-10-19', tx: '2026-10-19', entity: '16', goods: [{ cls: '009', text: 'Downloadable software (INVENTED record: a new filing in a daily file)' }] },
];
fs.writeFileSync(path.join(OUT, 'apc-synthetic-daily-20261019.xml'), file({
  records: daily, actionKey: 'TX',
  comment: `${SYNTH} A daily update: EQUALL 98137428 with an INVENTED status code (730) to test the upsert, and an INVENTED new filing 76999907 EQUASIA.`,
}));
fs.writeFileSync(path.join(OUT, 'apc-synthetic-daily-20261020-nodata.xml'), file({ records: [], noData: true, comment: `${SYNTH} A day with no data (data-available-code N).` }));
// Broken on purpose: a well-formed start, then a truncated record (the atomicity test).
const broken = file({ records: [{ ...invented[0], serial: '76999908', mark: 'SHOULD NOT LOAD' }], comment: `${SYNTH} Broken on purpose (truncated) for the atomicity test.` });
fs.writeFileSync(path.join(OUT, 'apc-synthetic-daily-20261021-broken.xml'), broken.slice(0, broken.indexOf('</case-file-owners>')));

// The recall seed: what tmsearch found on 10-18 (Eden's export and notes).
const seed = {
  format: 'equazia-tm-recall/1',
  name: 'Seed set from the EQUAZIA knockout of 2026-10-18 (Eden, tmsearch)',
  notes: [
    'A SEED, not the gate set: one real mark. The gate needs about 50 marks run on tmsearch by Eden or a paralegal (docs/specs/TRADEMARK-CLEARANCE-2026-10-18.md §11.6).',
    'live_conflicts are the two records Opus proposed to WATCH on 10-18 (EQUALL 98137428, EQUASITE 90562533); they are proposals, not Eden\'s decided bins.',
    'Coverage: the committed register fixture was built FROM these same tmsearch rows, so on it the seed tests the query translation and the matching rule, not the completeness of a real copy.',
  ],
  marks: [
    {
      mark: 'EQUAZIA', real: true,
      decomposition: { opening: 'equa', hinge: 'z', ending: 'ia' },
      search_classes: ['009', '042', '045'],
      known_marks: [{ name: 'EQUALL', owner: 'Equall Inc' }],
      foreign_equivalents: ['equazione', 'equacion'],
      tmsearch: {
        run_on: '2026-10-18', by: 'Eden Quainton (tmsearch.uspto.gov)',
        queries: [
          { query: 'CM:*equaz* AND LD:true', reported_count: 3, serials: ['99887921', '97272405', '85889029'], source: '10-19 notes' },
          { query, reported_count: exportRows.length, serials: exportRows.map((r) => r.SerialNumber), source: 'export tmSearchResults2026-10-18 (1).xlsx' },
          { query: 'CM:(equasia ekwazia equazzia) AND LD:true', reported_count: 0, serials: [], source: '10-19 notes' },
          { query: 'CM:equall', reported_count: 4, serials: ['98137428', '98137417', '88129739', '88634323'], source: '10-19 notes' },
        ],
        live_conflicts: [
          { serial: '98137428', mark: 'EQUALL', why: 'Opus 10-18: watch (examiner citation / opposition risk)' },
          { serial: '90562533', mark: 'EQUASITE', why: 'Opus 10-18: watch (examiner citation risk); found only by the broad sweep' },
        ],
      },
    },
  ],
};
fs.writeFileSync(path.join(OUT, 'recall-seed-2026-10-21.json'), `${JSON.stringify(seed, null, 2)}\n`);
console.log(`wrote ${OUT}: backfile ${backfile.length} records (${real.length} real export rows, ${fromNotes.length} from notes, ${invented.length} invented)`);

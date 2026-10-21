// Trademark Clearance, slice 2 — the application draft's pure logic
// (lib/trademark/application.mjs) and the TSDR mapping (lib/trademark/tsdr.mjs).
//
//   node --test scripts/_test-trademark-application.mjs
//
// Offline: no database, no network, no model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES, specimenCheck, recommendBasis, entityCautions, applicationQuestions, assembleApplication, feeEstimate,
  mergeAnswers, normalizeApplication, cite,
} from '../lib/trademark/application.mjs';
import { mapTrademark, parseMultiStatus, makeTsdrClient } from '../lib/trademark/tsdr.mjs';
import { forbiddenPhrases } from '../lib/trademark/lint.mjs';

const TODAY = '2026-10-21';
const SPEC = '11111111-1111-4111-8111-111111111111';
const formed = {
  legal_name: 'Grapheon.ai, LLC', entity_type: 'limited liability company', state: 'New Jersey', formation_status: 'formed',
  formation_date: '2024-02-01', domicile_address: '1 Example Street, Princeton, NJ 08540', address_is_mail_drop: 'no', email: 'tm@example.com',
};
const cleanWebpage = (code) => ({
  code, in_use: true, first_use_anywhere: '2026-03-01', first_use_in_commerce: '2026-04-01', identification: 'x', id_source: 'id_manual',
  specimen: {
    document_id: SPEC, kind: 'webpage', description: 'The product page with the mark, the price and an order button', url: 'https://example.com', access_date: '2026-10-20',
    shows_mark: 'yes', mark_as_brand: 'yes', goods_sold: 'yes', means_of_ordering: 'yes', services_available: 'yes', shows_services: 'yes', mockup: 'no',
  },
});

test('rules.json: every rule has text and a source; a verified one has a date; none uses a forbidden phrase', () => {
  for (const [id, r] of Object.entries(RULES.rules)) {
    assert.ok(r.text && r.source, id);
    assert.ok(r.verified === null || /^\d{4}-\d{2}-\d{2}$/.test(r.verified), id);
    assert.deepEqual(forbiddenPhrases(r.text), [], id);
  }
  assert.match(cite('itu_assignment_bar'), /^\[V 2026-10-21, 15 U\.S\.C\. § 1060\(a\)\(1\)/);
  assert.match(cite('bona_fide_intent_evidence'), /^\[M/);
  assert.equal(cite('no_such_rule'), '[M]');
  assert.equal(RULES.fees.base.amount, 350);
});

test('basis both ways: not in use → 1(b); in use with dates and a clean specimen → 1(a); unanswered → ask', () => {
  assert.equal(recommendBasis({ code: '009', in_use: false }, TODAY).basis, '1b');
  assert.equal(recommendBasis(cleanWebpage('009'), TODAY).basis, '1a');
  assert.equal(recommendBasis(cleanWebpage('042'), TODAY).basis, '1a');
  assert.equal(recommendBasis({ code: '009' }, TODAY).basis, null);
  const noDates = { ...cleanWebpage('009'), first_use_in_commerce: '' };
  const r = recommendBasis(noDates, TODAY);
  assert.equal(r.basis, '1b');
  assert.match(r.reason, /first use in commerce/);
  const future = { ...cleanWebpage('009'), first_use_in_commerce: '2027-01-01' };
  assert.equal(recommendBasis(future, TODAY).basis, '1b');
  const backwards = { ...cleanWebpage('009'), first_use_anywhere: '2026-05-01' };
  assert.match(recommendBasis(backwards, TODAY).reason, /dates in order/);
});

test('specimen check, services: "coming soon", a feature name, a mockup, a webpage without URL/date', () => {
  const s = cleanWebpage('042');
  assert.deepEqual(specimenCheck(s).filter((f) => f.severity === 'flag'), []);
  const soon = { ...s, specimen: { ...s.specimen, description: 'Coming soon — join the waitlist', services_available: '' } };
  assert.ok(specimenCheck(soon).some((f) => f.id === 'not_rendered'));
  const feature = { ...s, specimen: { ...s.specimen, description: 'QUIDDIT credits shown inside the app', mark_as_brand: '' } };
  assert.ok(specimenCheck(feature).some((f) => f.id === 'feature_name' && /TMEP §§ 1301\.01\(a\)\(i\), 1301\.02\(e\)-\(f\)/.test(f.text)));
  const mock = { ...s, specimen: { ...s.specimen, mockup: 'yes' } };
  assert.ok(specimenCheck(mock).some((f) => f.id === 'mockup' && /2\.56\(c\)/.test(f.text)));
  const noUrl = { ...s, specimen: { ...s.specimen, url: '', access_date: '' } };
  assert.ok(specimenCheck(noUrl).some((f) => f.id === 'webpage_url_date'));
  const reserve = { ...s, specimen: { ...s.specimen, description: 'A placeholder site to reserve the name' } };
  assert.ok(specimenCheck(reserve).some((f) => f.id === 'token_use'));
  const noAssoc = { ...s, specimen: { ...s.specimen, shows_services: 'no' } };
  assert.ok(specimenCheck(noAssoc).some((f) => f.id === 'no_association'));
});

test('specimen check, goods: advertising is not a goods specimen; a webpage needs a means of ordering', () => {
  const g = cleanWebpage('009');
  const ad = { ...g, specimen: { ...g.specimen, kind: 'advertising' } };
  assert.ok(specimenCheck(ad).some((f) => f.id === 'goods_advertising'));
  const noOrder = { ...g, specimen: { ...g.specimen, means_of_ordering: 'no' } };
  assert.ok(specimenCheck(noOrder).some((f) => f.id === 'webpage_no_ordering' && /904\.03\(i\)/.test(f.text)));
  const notSold = { ...g, specimen: { ...g.specimen, goods_sold: 'no' } };
  assert.ok(specimenCheck(notSold).some((f) => f.id === 'goods_not_sold'));
  assert.deepEqual(specimenCheck({ code: '009', in_use: false }), [], 'no check for an intent-to-use class');
});

test('entity: not formed → the rule, and "do not file before" the formation date; a mail drop blocks', () => {
  const pending = { ...formed, formation_status: 'pending', formation_date: '2026-12-01' };
  const r = entityCautions({ applicant: pending, application: { classes: [{ code: '009', in_use: false }] }, today: TODAY });
  assert.equal(r.doNotFileBefore, '2026-12-01');
  assert.ok(r.cautions.some((c) => c.id === 'applicant_not_formed' && c.severity === 'block' && /1201\.02\(b\)/.test(c.text) && /1201\.02\(c\)\(7\)/.test(c.text)));
  const drop = entityCautions({ applicant: { ...formed, address_is_mail_drop: 'yes' }, application: {}, today: TODAY });
  assert.ok(drop.cautions.some((c) => c.id === 'domicile_mail_drop' && c.severity === 'block' && /601\.01\(c\)\(i\)/.test(c.text)));
});

test('the marks move to an entity not yet formed: the three options; § 1060(a)(1) only for 1(b); goodwill for 1(a)', () => {
  const app = { classes: [{ code: '009', in_use: false, basis: '1b' }], transfer: { planned: 'yes', entity_name: 'Quorium, LLC', entity_formed: false, choice: 'wait', wait_until: '2026-12-15' } };
  const r = entityCautions({ applicant: formed, application: app, today: TODAY });
  const t = r.cautions.find((c) => c.id === 'transfer_options').text;
  assert.match(t, /\(1\) Wait[\s\S]*\(2\) File now as Grapheon\.ai, LLC[\s\S]*\(3\) File now and assign/);
  assert.match(t, /successor to the applicant's business/);
  assert.doesNotMatch(t, /no such bar/);
  assert.equal(r.doNotFileBefore, '2026-12-15');
  const used = entityCautions({ applicant: formed, application: { ...app, classes: [{ ...cleanWebpage('009'), basis: '1a' }], transfer: { ...app.transfer, choice: '' } }, today: TODAY });
  const u = used.cautions.find((c) => c.id === 'transfer_options').text;
  assert.match(u, /no such bar/);
  assert.doesNotMatch(u, /except to a successor/);
  assert.ok(used.cautions.some((c) => c.id === 'transfer_choose'));
});

test('fees: base per class; free-form per class; excess characters per 1,000 beyond the first 1,000; later fees for 1(b)', () => {
  const f = feeEstimate({ classes: [
    { code: '009', id_source: 'free_form', identification: 'x'.repeat(2500), basis: '1b' },
    { code: '042', id_source: 'id_manual', identification: 'y', basis: '1a' },
  ] });
  assert.equal(f.dueAtFiling, 350 * 2 + 200 + 200 * 2);
  assert.ok(f.later.some((l) => /\$150 per class/.test(l.amount)));
  assert.equal(feeEstimate({ classes: [{ code: '009', id_source: 'id_manual', basis: '1a' }], applicantComplete: false }).dueAtFiling, 450);
});

test('questions: the applicant and "in use?" first; a use-based class asks dates and a specimen; an ITU class asks for evidence', () => {
  const c = { mark: 'QUALLET', applicant: {}, filing_classes: [{ code: '009' }, { code: '042' }], application: { classes: [{ code: '042', in_use: true }] } };
  const q = applicationQuestions({ clearance: c, today: TODAY });
  const ids = q.map((x) => x.id);
  assert.ok(ids.indexOf('applicant.legal_name') < ids.indexOf('classes.009.in_use'));
  assert.ok(q.find((x) => x.id === 'classes.009.in_use').blocking);
  assert.ok(ids.includes('classes.042.first_use_in_commerce') && ids.includes('classes.042.specimen.document_id'));
  const itu = applicationQuestions({ clearance: { ...c, application: { classes: [{ code: '009', in_use: false }, { code: '042', in_use: false }] } }, today: TODAY });
  assert.ok(itu.some((x) => x.id === 'classes.009.intent_evidence'));
});

test('mergeAnswers: an allowlist; a class outside the filing classes is refused; the applicant is data', () => {
  const evil = JSON.parse('{"code":"009","in_use":true,"__proto__":{"x":1},"constructor":"y","bogus":"z"}');
  const m = mergeAnswers({ application: {}, applicant: {}, filingClasses: [{ code: '009' }], answers: {
    applicant: { legal_name: 'Grapheon.ai, LLC', hacked: 'no' }, classes: [evil, { code: '025', in_use: true }],
  } });
  assert.equal(m.application.classes.length, 1);
  assert.equal(m.application.classes[0].in_use, true);
  assert.ok(!('bogus' in m.application.classes[0]) && !('x' in m.application.classes[0]));
  assert.equal(m.applicant.legal_name, 'Grapheon.ai, LLC');
  assert.ok(!('hacked' in m.applicant));
  assert.ok(m.refused.some((r) => /025/.test(r)));
  assert.deepEqual(normalizeApplication({ classes: 'nope', transfer: 7 }).classes, []);
});

test('the draft: TEAS order; the annex separate; both lint-clean; deterministic', () => {
  const c = {
    mark: 'QUALLET', mark_format: 'standard', applicant: formed, filing_classes: [{ code: '009' }, { code: '042' }],
    application: { classes: [
      { code: '009', identification: 'Downloadable software', id_source: 'free_form', in_use: false, intent_evidence: [{ date: '2026-09-01', description: 'plan' }] },
      cleanWebpage('042'),
    ], transfer: { planned: 'no' } },
  };
  const a = assembleApplication({ clearance: c, hits: [{ serial: '97111111', mark: 'QUALLETTA', tsdr: { live: false, status_text: 'DEAD/APPLICATION/Abandoned' } }], today: TODAY });
  const b = assembleApplication({ clearance: c, hits: [{ serial: '97111111', mark: 'QUALLETTA', tsdr: { live: false, status_text: 'DEAD/APPLICATION/Abandoned' } }], today: TODAY });
  assert.equal(a.draft, b.draft);
  assert.equal(a.annex, b.annex);
  const order = ['## 1. Applicant', '## 2. Mark', '## 3. Classes and identifications', '## 4. Basis and dates', '## 5. Specimens', '## 6. Declaration', '## 7. Fees'];
  let at = -1;
  for (const h of order) { const i = a.draft.indexOf(h); assert.ok(i > at, h); at = i; }
  assert.deepEqual(a.lint, []);
  assert.deepEqual(a.bases, { '009': '1b', '042': '1a' });
  assert.doesNotMatch(a.draft, /cautions|Specimen check/i);
  assert.match(a.annex, /dead \(noted, not dropped\)/);
  assert.match(a.annex, /## Sources/);
});

test('TSDR mapping: live from the TM5 text or an abandoned date; null when the record says nothing', () => {
  const live = mapTrademark({ status: { serialNumber: 90562533, markElement: 'EQUASITE', status: 800, tm5StatusDesc: 'LIVE/REGISTRATION/Issued and Active', usRegistrationNumber: '6900001', filingDate: '2021-01-01' },
    parties: { currentOwners: [{ name: 'Equasite Inc.' }] }, gsList: [{ description: 'SaaS', internationalClasses: [{ code: '42' }] }] });
  assert.equal(live.live, true);
  assert.equal(live.owner, 'Equasite Inc.');
  assert.deepEqual(live.classes, ['042']);
  assert.equal(mapTrademark({ status: { serialNumber: 1, dateAbandoned: '2023-01-01' } }).live, false);
  assert.equal(mapTrademark({ status: { serialNumber: 1 } }).live, null);
  assert.equal(parseMultiStatus({ nope: true }).size, 0);
});

test('TSDR client: no key → not configured, no request; the key goes only in the header', async () => {
  let n = 0;
  const none = makeTsdrClient({ apiKey: '', fetchImpl: async () => { n++; return new Response('{}'); } });
  assert.equal(none.configured, false);
  const r = await none.status('97111111');
  assert.equal(r.code, 'not_configured');
  assert.equal(n, 0);
  let seen;
  const k = makeTsdrClient({ apiKey: ' abc ', fetchImpl: async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ transactionList: [] })); }, sleep: async () => {}, now: () => 0 });
  await k.status('97111111');
  assert.equal(seen.init.headers['USPTO-API-KEY'], 'abc');
  assert.doesNotMatch(String(seen.url), /abc/);
});

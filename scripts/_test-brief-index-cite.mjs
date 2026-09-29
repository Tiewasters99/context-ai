// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-index-cite.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIndexCite, indexCiteFromBrief, definingText } from '../src/lib/brief/index-cite.ts';

test('a caption highlighted without its number takes the number the brief gives after it', () => {
  const brief = "In *Matter of DiSanto v. New York City Dep’t of Health & Mental Hygiene*, Index No. 508835/2024 (Sup. Ct., Kings County), the court signed an order to show cause.";
  const c = indexCiteFromBrief("Matter of DiSanto v. New York City Dep’t of Health & Mental Hygiene", brief);
  assert.equal(c?.number, '508835');
  assert.equal(c?.year, '2024');
  assert.equal(indexCiteFromBrief('Matter of Trump v. Engoron', brief), null);
});

test('a New York index number: the NYSCEF filename forms, the caption forms, the first party', () => {
  const c = parseIndexCite("Matter of DiSanto v. New York City Dep’t of Health & Mental Hygiene, Index No. 508835/2024 (Sup. Ct., Kings County)");
  assert.equal(c.number, '508835');
  assert.equal(c.year, '2024');
  assert.deepEqual(c.titleNeedles, ['508835_2024', '508835-2024', '508835/2024', '508835']);
  assert.ok(c.textNeedles.includes('508835/2024') && c.textNeedles.includes('508835/24'));
  assert.equal(c.surname, 'DiSanto');
});

test('a federal docket number', () => {
  const c = parseIndexCite('Smith v. Acme Corp., No. 1:23-cv-04567-JMF (S.D.N.Y. Mar. 3, 2024)');
  assert.equal(c.number, '1:23-cv-04567-JMF');
  assert.ok(c.titleNeedles.includes('23-cv-04567') && c.titleNeedles.includes('23_cv_04567'));
  assert.equal(c.year, null);
  assert.equal(c.surname, 'Smith');
});

test('not an index cite', () => {
  assert.equal(parseIndexCite('Morgan v. Allison Crane & Rigging LLC, 114 F.4th 214 (3d Cir. 2024)'), null);
  assert.equal(parseIndexCite('A-1601'), null);
  assert.equal(parseIndexCite('No. 26-2098, Doc. 5'), null);
});

test("an agency's own index number, and a term the brief defines", () => {
  const c = parseIndexCite('OATH Index No. 26-1305');
  assert.equal(c.number, '26-1305');
  assert.ok(c.titleNeedles.includes('26-1305') && c.textNeedles.includes('26-1305'));
  const brief = 'Radiant at OATH, DCWP v. Radiant Solar, Inc. and William James Bushell, OATH Index No. 26-1305, assigned to ALJ Christine Stecura (the “OATH Petition”). A copy of the OATH Petition is annexed as Exhibit A.';
  const d = definingText('OATH Pet.', brief);
  assert.ok(d && d.includes('26-1305'), 'the definition is the words before "(the “OATH Petition”)"');
  assert.equal(parseIndexCite(d).number, '26-1305');
  assert.equal(definingText('Holder Rule', brief), null);
});

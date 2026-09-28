// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-index-cite.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIndexCite } from '../src/lib/brief/index-cite.ts';

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

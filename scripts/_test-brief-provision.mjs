// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-provision.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionNumber, provisionQuery, numberFromBrief, looksLikeProvision } from '../src/lib/brief/provision-core.ts';

const BRIEF = `The Federal Trade Commission's Holder Rule, 16 C.F.R. § 433.2, makes every consumer credit contract subject to
all claims and defenses. Mr. Bushell seeks declaratory relief under CPLR 3001, a judgment of prohibition under CPLR 7803(2),
and a stay under CPLR 7805. Administrative Code § 20-393(4) and Charter § 2203(h)(1) control; see also 6 RCNY § 6-02.`;

test('section numbers: subdivisions dropped, forms the petition uses', () => {
  assert.equal(sectionNumber('Administrative Code § 20-393(4)'), '20-393');
  assert.equal(sectionNumber('Charter § 2203(h)(1)'), '2203');
  assert.equal(sectionNumber('6 RCNY § 6-02'), '6-02');
  assert.equal(sectionNumber('CPLR 7803(2)'), '7803');
  assert.equal(sectionNumber('a stay under CPLR 7805'), '7805');
  assert.equal(sectionNumber('16 C.F.R. § 433.2'), '433.2');
  assert.equal(sectionNumber('16 C.F.R. 433.2'), '433.2');
  assert.equal(sectionNumber('GBL § 771'), '771');
  assert.equal(sectionNumber('Fed. R. Civ. P. 56(a)'), '56');
  assert.equal(sectionNumber('Morgan v. Allison Crane, 114 F.4th 214'), null);
});

test('a named provision takes its number from the brief itself', () => {
  assert.equal(numberFromBrief("the Federal Trade Commission's Holder Rule", BRIEF), '433.2');
  const q = provisionQuery("the Federal Trade Commission’s Holder Rule", BRIEF);
  assert.equal(q.from, 'brief');
  assert.equal(q.number, '433.2');
  assert.ok(q.patterns.includes('§ 433.2') && q.patterns.includes('433.2'));
});

test('a numbered cite searches with its sign and body, never the bare number', () => {
  const q = provisionQuery('CPLR 7803(2)', BRIEF);
  assert.equal(q.number, '7803');
  assert.ok(q.patterns.includes('CPLR 7803') && q.patterns.includes('§ 7803'));
  assert.ok(!q.patterns.includes('7803'), 'a bare four-digit number would match years and pages');
  const c = provisionQuery('Charter § 2203(h)(1)', BRIEF);
  assert.deepEqual(c.patterns.slice(0, 2), ['§ 2203', '§2203']);
  const r = provisionQuery('6 RCNY § 6-02', BRIEF);
  assert.ok(r.patterns.includes('6-02'));
});

test('a session law or local law is a year and a chapter, never a section', () => {
  const q = provisionQuery('L. 2020, ch. 205, §§ 1, 3', BRIEF);
  assert.equal(q.number, '205');
  assert.deepEqual(q.nameWords[0], ['2020']);
  assert.ok(q.nameWords[1].includes('chapter 205') && q.nameWords[1].includes('ch. 205'));
  assert.ok(q.patterns.includes('ch. 205') && !q.patterns.some((p) => /§ 1\b/.test(p)));
  const l = provisionQuery('Local Law No. 24 of 2019', BRIEF);
  assert.equal(l.number, '24');
  assert.deepEqual(l.nameWords[0], ['2019']);
  assert.ok(l.nameWords[1].includes('Local Law 24'));
  const ll = provisionQuery('L.L. 2019/024', BRIEF);
  assert.equal(ll.number, '24');
  assert.equal(provisionQuery('Laws of 2020, chapter 205', BRIEF).number, '205');
});

test('a case caption is not a provision; a bare name with no number in the brief searches its words', () => {
  assert.equal(provisionQuery('Morgan v. Allison Crane & Rigging LLC, 114 F.4th 214', BRIEF), null);
  assert.ok(!looksLikeProvision('Taylor v. Phoenixville Sch. Dist.'));
  const q = provisionQuery('the Truth in Lending Act', 'nothing here');
  assert.equal(q.number, '');
  assert.deepEqual(q.patterns, ['Truth in Lending Act']);
});

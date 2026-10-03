// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-depo-cite.mjs
// Deposition cites → the appendix sheet, through the builder's page map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDepoCite, parsePageMap, findDepoPage, coversPage, depoLabel, romanToInt } from '../src/lib/brief/depo-cite.ts';

const MAP = `a_page,volume,pdf_page_in_volume,deponent,version,tr_pages
1418,V,343,Hope Richards-Cordell,certified,89
1600,VI,146,"Lauren De Camara, Vol. I",certified,58-61
1601,VI,147,"Lauren De Camara, Vol. I",certified,62-65
1681,VI,227,"Lauren De Camara, Vol. III",certified,62-65
1765,VI,311,"Lauren De Camara, Vol. IV",rough,63
3511,XI,207,"Lauren De Camara, Vol. IV",final,62-65
2725,IX,201,Richie Gebauer,rough,1-4
3639,XI,335,Richie Gebauer,final,58-61
1900,VII,79,"Natalie Zaparzynski, 30(b)(6)",certified,42-45
1500,VI,46,"Natalie Zaparzynski, individual (3/5/26)",certified text,42-45
1850,VII,29,Deborah Alder,certified,134-137
`;
const map = parsePageMap(MAP);

test('parse: the forms the brief uses', () => {
  assert.deepEqual(parseDepoCite('De Camara Dep. Vol. I 63:21–64:2'), { deponent: 'De Camara', volume: 1, page: 63, line: 21, endPage: 64, endLine: 2, date: null });
  assert.deepEqual(parseDepoCite('(citing De Camara Dep. Vol. I 60:4–24)'), { deponent: 'De Camara', volume: 1, page: 60, line: 4, endPage: null, endLine: 24, date: null });
  assert.deepEqual(parseDepoCite('citing Alder Dep. 135:1–10'), { deponent: 'Alder', volume: null, page: 135, line: 1, endPage: null, endLine: 10, date: null });
  assert.deepEqual(parseDepoCite('Gebauer Dep. 61:14–16'), { deponent: 'Gebauer', volume: null, page: 61, line: 14, endPage: null, endLine: 16, date: null });
  assert.deepEqual(parseDepoCite('Alder Dep. 124–25'), { deponent: 'Alder', volume: null, page: 124, line: null, endPage: 125, endLine: null, date: null });
  assert.deepEqual(parseDepoCite('Walters Dep. 22.'), { deponent: 'Walters', volume: null, page: 22, line: null, endPage: null, endLine: null, date: null });
  assert.deepEqual(parseDepoCite('Zaparzynski 30(b)(6) Dep. 45:3–9'), { deponent: 'Zaparzynski 30(b)(6)', volume: null, page: 45, line: 3, endPage: null, endLine: 9, date: null });
  assert.deepEqual(parseDepoCite('De Camara Dep. (Mar. 4, 2026) 13:5–17'), { deponent: 'De Camara', volume: null, page: 13, line: 5, endPage: null, endLine: 17, date: 'Mar. 4, 2026' });
  assert.deepEqual(parseDepoCite('Richards-Cordell Dep. at 89:2'), { deponent: 'Richards-Cordell', volume: null, page: 89, line: 2, endPage: null, endLine: null, date: null });
  assert.equal(parseDepoCite('A-1601')?.page, undefined);
  assert.equal(parseDepoCite('Taylor v. Phoenixville Sch. Dist., 184 F.3d 296'), null);
  assert.equal(parseDepoCite('Op. 12'), null);
  assert.equal(romanToInt('IV'), 4);
  assert.equal(romanToInt('xii'), 12);
});

test('page map: CSV parses, quoted labels survive', () => {
  assert.equal(map.length, 11);
  assert.equal(map[2].deponent, 'Lauren De Camara, Vol. I');
  assert.equal(map[2].pdf_page, 147);
  assert.ok(coversPage('62-65', 63));
  assert.ok(!coversPage('62-65', 66));
  assert.ok(coversPage('63', 63));
});

test('lookup: De Camara Vol. I 63 → A-1601 only (not Vol. III / IV)', () => {
  const hits = findDepoPage(map, parseDepoCite('De Camara Dep. Vol. I 63:21–64:2'));
  assert.deepEqual(hits.map((h) => h.a_page), [1601]);
  assert.equal(hits[0].volume, 'VI');
  assert.equal(hits[0].pdf_page, 147);
});

test('lookup: no volume in the cite → every volume that carries the page, certified first', () => {
  const hits = findDepoPage(map, parseDepoCite('De Camara Dep. 63:2'));
  assert.deepEqual(hits.map((h) => h.a_page), [1601, 1681, 3511, 1765]);
});

test('lookup: two copies of one transcript → final/certified before rough', () => {
  const hits = findDepoPage(map, parseDepoCite('Gebauer Dep. 61:14–16'));
  assert.deepEqual(hits.map((h) => h.a_page), [3639]);
  const rough = findDepoPage(map, parseDepoCite('Gebauer Dep. 2:1'));
  assert.deepEqual(rough.map((h) => h.a_page), [2725]);
});

test('lookup: 30(b)(6) picks the corporate label; a plain cite the individual', () => {
  assert.deepEqual(findDepoPage(map, parseDepoCite('Zaparzynski 30(b)(6) Dep. 43:1')).map((h) => h.a_page), [1900]);
  assert.deepEqual(findDepoPage(map, parseDepoCite('Zaparzynski Dep. 43:1')).map((h) => h.a_page), [1500]);
});

test('lookup: hyphenated surname; a page no sheet carries → nothing', () => {
  assert.deepEqual(findDepoPage(map, parseDepoCite('Richards-Cordell Dep. 89:2')).map((h) => h.a_page), [1418]);
  assert.deepEqual(findDepoPage(map, parseDepoCite('Richards-Cordell Dep. 90:2')), []);
  assert.deepEqual(findDepoPage(map, parseDepoCite('Alder Dep. 135:1–10')).map((h) => h.a_page), [1850]);
});

test('label', () => {
  assert.equal(depoLabel(parseDepoCite('De Camara Dep. Vol. I 63:21–64:2')), 'De Camara Dep. Vol. 1 63:21–64:2');
  assert.equal(depoLabel(parseDepoCite('Alder Dep. 124–25')), 'Alder Dep. 124–125');
});

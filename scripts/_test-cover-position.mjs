// Cover position stored in the cover URL's fragment (src/lib/cover-position.ts).
//
//   node scripts/_test-cover-position.mjs
//
// Offline. The banner's Reposition (2026-10-11) saves where the image sits and
// how far it is zoomed as `#cs-cover=x,y,zoom` on the cover URL, so it travels
// through every existing save path with no schema change.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const out = ts.transpileModule(readFileSync('src/lib/cover-position.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(out, { exports: mod.exports, module: mod });
const { parseCover, withPosition, coverImageStyle, DEFAULT_POSITION } = mod.exports;

let n = 0;
// Objects from the vm realm have another Object prototype; compare by value.
const same = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const ok = (m) => { n++; console.log(`  PASS  ${m}`); };

const URL0 = 'https://x.supabase.co/storage/v1/object/public/cover-images/u/abc.jpg';
same(parseCover(URL0), { src: URL0, position: DEFAULT_POSITION });
ok('a plain cover URL is centred, unzoomed, unchanged');

const saved = withPosition(URL0, { x: 30, y: 12.34, zoom: 1.8 });
assert.equal(saved, `${URL0}#cs-cover=30,12.3,1.8`);
same(parseCover(saved), { src: URL0, position: { x: 30, y: 12.3, zoom: 1.8 } });
ok('position round-trips through the URL fragment; the image address is untouched');

assert.equal(withPosition(saved, { x: 50, y: 50, zoom: 1 }), URL0);
ok('saving the default position removes the fragment');

assert.equal(withPosition(saved, { x: 0, y: 100, zoom: 1 }), `${URL0}#cs-cover=0,100,1`);
ok('re-positioning replaces the old fragment rather than stacking');

same(parseCover(`${URL0}#cs-cover=-20,140,9`).position, { x: 0, y: 100, zoom: 4 });
same(parseCover(`${URL0}#cs-cover=junk`).position, DEFAULT_POSITION);
ok('out-of-range and malformed values are clamped or ignored');

const other = `${URL0}#page=2`;
same(parseCover(other), { src: other, position: DEFAULT_POSITION });
ok('someone else\'s fragment is left alone');

const g = 'linear-gradient(135deg, #111, #333)';
assert.equal(withPosition(g, { y: 10 }), g);
same(parseCover(g), { src: g, position: DEFAULT_POSITION });
ok('gradients have no position and are never modified');

same(coverImageStyle({ x: 50, y: 20, zoom: 1 }), { objectPosition: '50% 20%' });
same(coverImageStyle({ x: 10, y: 20, zoom: 2 }),
  { objectPosition: '10% 20%', transform: 'scale(2)', transformOrigin: '10% 20%' });
ok('the <img> style: object-position, plus a scale about the same point when zoomed');

same(parseCover(withPosition(URL0, { zoom: 1.013 })).position, { x: 50, y: 50, zoom: 1.01 });
ok('a small zoom step (trackpad) survives rounding');

console.log(`\nALL ${n} CHECKS PASSED`);

// Zoom and pan arithmetic for the illustration player (src/lib/picture-zoom.ts).
//
//   node scripts/_test-picture-zoom.mjs
//
// Offline. A map imported into a book (2026-10-13) came through small; the
// player now zooms by wheel, pinch, buttons and double-tap, and pans by drag.
// These are the invariants: the picture never leaves a gap over the stage,
// the point under the cursor stays put while zooming, a pinch follows the
// fingers, and the scale stays within [1, ZOOM_MAX].
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const out = ts.transpileModule(readFileSync('src/lib/picture-zoom.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(out, { exports: mod.exports, module: mod });
const {
  FIT, ZOOM_MAX, ZOOM_MIN, fitSize, clampView, zoomAbout, panBy, pinchStep, wheelFactor, fromCentre, isDoubleTap, isZoomed,
} = mod.exports;

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok', name); };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} expected ${b}, got ${a}`);

const stage = { w: 800, h: 600 };

test('a wide map fits the stage width and is letterboxed in height', () => {
  const f = fitSize(stage, { w: 2000, h: 1000 });
  near(f.w, 800); near(f.h, 400);
});

test('a tall plate fits the stage height', () => {
  const f = fitSize(stage, { w: 600, h: 1200 });
  near(f.w, 300); near(f.h, 600);
});

test('no natural size yet: the fit is the stage itself', () => {
  const a = fitSize(stage, null); near(a.w, 800); near(a.h, 600);
  const b = fitSize(stage, { w: 0, h: 0 }); near(b.w, 800); near(b.h, 600);
});

test('at scale 1 the picture is centred and cannot be panned', () => {
  const fit = fitSize(stage, { w: 2000, h: 1000 });
  const v = panBy(FIT, 150, -90, stage, fit);
  assert.deepEqual(v, FIT);
  assert.equal(isZoomed(v), false);
});

test('scale is clamped to [ZOOM_MIN, ZOOM_MAX]', () => {
  const fit = fitSize(stage, { w: 2000, h: 1000 });
  assert.equal(zoomAbout(FIT, 0.2, 0, 0, stage, fit).s, ZOOM_MIN);
  assert.equal(zoomAbout(FIT, 1000, 0, 0, stage, fit).s, ZOOM_MAX);
  assert.equal(clampView({ s: 99, x: 0, y: 0 }, stage, fit).s, ZOOM_MAX);
});

test('zooming about a point keeps the picture under that point still', () => {
  const fit = fitSize(stage, { w: 2000, h: 1000 });
  // The point p (stage px from the centre) maps to picture coordinate
  // (p - t) / s. After zooming about p it must map to the same place.
  const v0 = { s: 1.5, x: 40, y: -20 };
  const p = { x: 120, y: 80 };
  const before = { x: (p.x - v0.x) / v0.s, y: (p.y - v0.y) / v0.s };
  const v1 = zoomAbout(v0, 1.6, p.x, p.y, stage, fit);
  near(v1.s, 2.4);
  const after = { x: (p.x - v1.x) / v1.s, y: (p.y - v1.y) / v1.s };
  near(after.x, before.x, 'x'); near(after.y, before.y, 'y');
});

test('panning stops at the picture edge: no gap opens over the stage', () => {
  const fit = fitSize(stage, { w: 2000, h: 1000 }); // 800 x 400 fitted
  const v = zoomAbout(FIT, 2, 0, 0, stage, fit);    // 1600 x 800 drawn
  // Allowed: |x| <= (1600-800)/2 = 400, |y| <= (800-600)/2 = 100.
  const far = panBy(v, 5000, 5000, stage, fit);
  near(far.x, 400); near(far.y, 100);
  const back = panBy(far, -9000, -9000, stage, fit);
  near(back.x, -400); near(back.y, -100);
});

test('an axis where the zoomed picture is still smaller than the stage stays centred', () => {
  const fit = fitSize(stage, { w: 2000, h: 1000 }); // 800 x 400
  const v = zoomAbout(FIT, 1.2, 0, 0, stage, fit);  // 960 x 480: taller than nothing
  const moved = panBy(v, 30, 30, stage, fit);
  near(moved.y, 0, 'y stays centred');
  near(moved.x, 30, 'x may move a little');
});

test('a pinch that spreads the fingers zooms in, and follows the midpoint', () => {
  const fit = fitSize(stage, { w: 1000, h: 1000 }); // 600 x 600
  const a0 = { x: -50, y: 0 }, b0 = { x: 50, y: 0 };
  const a1 = { x: -100, y: 10 }, b1 = { x: 100, y: 10 };
  const v = pinchStep(FIT, a0, b0, a1, b1, stage, fit);
  near(v.s, 2, 'distance doubled');
  // The picture point that was between the fingers (stage centre at s=1)
  // must now sit at the new midpoint (0, 10) - clamped: 1200 tall, room 300.
  near(v.x, 0); near(v.y, 10);
});

test('a pinch that closes the fingers zooms out and stops at 1', () => {
  const fit = fitSize(stage, { w: 1000, h: 1000 });
  const v = pinchStep({ s: 1.5, x: 20, y: 20 }, { x: -100, y: 0 }, { x: 100, y: 0 }, { x: -10, y: 0 }, { x: 10, y: 0 }, stage, fit);
  assert.deepEqual(v, FIT);
});

test('wheel: scrolling up zooms in, down zooms out, ctrl (trackpad pinch) is gentler per pixel', () => {
  assert.ok(wheelFactor(-100, 0, false) > 1);
  assert.ok(wheelFactor(100, 0, false) < 1);
  near(wheelFactor(-100, 0, false) * wheelFactor(100, 0, false), 1, 'symmetric');
  assert.ok(wheelFactor(-3, 1, false) > 1, 'line mode counts');
  assert.ok(wheelFactor(-10, 0, true) > wheelFactor(-10, 0, false), 'ctrl gain is higher for the tiny deltas a trackpad sends');
  assert.ok(wheelFactor(-100000, 0, false) < 2, 'a runaway delta is capped');
});

test('fromCentre measures from the stage centre', () => {
  const p = fromCentre(500, 400, { left: 100, top: 100, width: 800, height: 600 });
  near(p.x, 0); near(p.y, 0);
  const q = fromCentre(100, 100, { left: 100, top: 100, width: 800, height: 600 });
  near(q.x, -400); near(q.y, -300);
});

test('double tap: close in time and place; not after 320 ms or a finger-width away', () => {
  assert.equal(isDoubleTap(null, { t: 1000, x: 0, y: 0 }), false);
  assert.equal(isDoubleTap({ t: 800, x: 5, y: 5 }, { t: 1000, x: 0, y: 0 }), true);
  assert.equal(isDoubleTap({ t: 600, x: 0, y: 0 }, { t: 1000, x: 0, y: 0 }), false);
  assert.equal(isDoubleTap({ t: 900, x: 40, y: 0 }, { t: 1000, x: 0, y: 0 }), false);
});

console.log(`picture-zoom: ${n} tests passed`);

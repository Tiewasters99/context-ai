// The cover-picker gating rule, exercised directly against src/lib/covers.ts.
// Run:  node --test scripts/_test-cover-gating.mjs
// (Node 22.18+ strips the types out of the .ts import on its own; covers.ts
// deliberately has no '@/' imports and no React so it needs no loader.)
//
// Untracked by convention — scripts/_*.mjs are probes, not code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  coversForPlan,
  showsFullCoverLibrary,
  isCoreCover,
  defaultCoverFor,
  hashName,
} from '../src/lib/covers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ALL = [
  { id: 'good-1', name: 'Good 1', file: '/templates/good-1.webp', category: 'Architecture' },
  { id: 'good-2', name: 'Good 2', file: '/templates/good-2.webp', category: 'Landscapes' },
  { id: 'bikini', name: 'Bikini', file: '/templates/a-beautiful-woman-in-a-bikini.webp', category: 'People & Life' },
];
const CORE = new Set(['/templates/good-1.webp', '/templates/good-2.webp']);

test('a free account is offered the core set only', () => {
  const offered = coversForPlan(ALL, CORE, 'free', false);
  assert.equal(offered.length, 2);
  assert.ok(!offered.some((t) => t.id === 'bikini'));
});

test('pro and max are core too — only workshop is different', () => {
  for (const plan of ['pro', 'max']) {
    assert.equal(coversForPlan(ALL, CORE, plan, false).length, 2, plan);
  }
});

test('workshop is offered the whole library', () => {
  const offered = coversForPlan(ALL, CORE, 'workshop', false);
  assert.equal(offered.length, 3);
  assert.ok(offered.some((t) => t.id === 'bikini'));
});

test('while the plan is loading, core — never a flash of the full library', () => {
  // The dangerous case: the row says workshop but has not arrived yet.
  assert.equal(showsFullCoverLibrary('workshop', true), false);
  assert.equal(coversForPlan(ALL, CORE, 'workshop', true).length, 2);
  // And the ordinary one: no plan at all yet.
  assert.equal(coversForPlan(ALL, CORE, null, true).length, 2);
});

test('an unknown plan is treated as core, not as workshop', () => {
  assert.equal(showsFullCoverLibrary(null, false), false);
  assert.equal(coversForPlan(ALL, CORE, null, false).length, 2);
});

test('fail closed: no core list offers nothing, never everything', () => {
  assert.deepEqual(coversForPlan(ALL, null, 'free', false), []);
  assert.deepEqual(coversForPlan(ALL, null, null, false), []);
  // Workshop is unaffected — it never consults the list.
  assert.equal(coversForPlan(ALL, null, 'workshop', false).length, 3);
});

test('gating decides what is OFFERED; a saved cover is never touched', () => {
  // A free account whose matter already points at a non-core image. Nothing
  // in this module can change that value, and the renderer is given the URL
  // directly — isCoreCover is only ever a question, never a filter on display.
  const saved = '/templates/a-beautiful-woman-in-a-bikini.webp';
  assert.equal(isCoreCover(saved, CORE), false);
  assert.equal(isCoreCover('/templates/good-1.webp', CORE), true);
  // The picker still refuses to offer it again.
  assert.ok(!coversForPlan(ALL, CORE, 'free', false).some((t) => t.file === saved));
});

test('coversForPlan never mutates or aliases the caller list', () => {
  const offered = coversForPlan(ALL, CORE, 'workshop', false);
  offered.pop();
  assert.equal(ALL.length, 3);
});

test('the default cover for a name is stable, core, and spread', () => {
  const files = ['/a.webp', '/b.webp', '/c.webp'];
  assert.equal(defaultCoverFor('Smith v. Jones', files), defaultCoverFor('smith v. jones ', files));
  assert.ok(files.includes(defaultCoverFor('Anything', files)));
  assert.equal(defaultCoverFor('Anything', null), null);
  assert.equal(defaultCoverFor('Anything', []), null);
  // Different names should not all land on the same plate.
  const landed = new Set(['Acme', 'Brown', 'Costas', 'Delta', 'Everest'].map((n) => defaultCoverFor(n, files)));
  assert.ok(landed.size > 1);
  assert.equal(typeof hashName('x'), 'number');
});

// ── the shipped data, not a fixture ───────────────────────────────────────

test('the real core-covers.json gates the real manifest to the core set', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public/templates/manifest.json'), 'utf8'));
  const core = JSON.parse(readFileSync(join(ROOT, 'public/templates/core-covers.json'), 'utf8'));
  const set = new Set(core.core);

  const free = coversForPlan(manifest, set, 'free', false);
  const workshop = coversForPlan(manifest, set, 'workshop', false);
  assert.equal(free.length, core.core.length);
  assert.equal(workshop.length, manifest.length);
  assert.ok(free.length < workshop.length, 'the core set must actually be smaller');

  // The image the ship-readiness audit named, by path: not offered to a
  // stranger, still offered to workshop, still on disk.
  const named = '/templates/a-beautiful-woman-in-a-bikini.webp';
  assert.ok(manifest.some((t) => t.file === named), 'fixture path no longer in the manifest');
  assert.ok(!free.some((t) => t.file === named));
  assert.ok(workshop.some((t) => t.file === named));

  // Every featured cover is offered to a free account.
  for (const f of core.featured) {
    assert.ok(free.some((t) => t.file === f.file), `featured not offered: ${f.file}`);
  }
});

test('the dashboard default and the plate categories are inside the core set', () => {
  const core = JSON.parse(readFileSync(join(ROOT, 'public/templates/core-covers.json'), 'utf8'));
  const dash = readFileSync(join(ROOT, 'src/pages/Dashboard.tsx'), 'utf8');
  const m = dash.match(/DEFAULT_DASHBOARD_COVER\s*=\s*'([^']+)'/);
  assert.ok(m, 'Dashboard no longer declares DEFAULT_DASHBOARD_COVER');
  assert.ok(core.core.includes(m[1]), `dashboard default is not a core cover: ${m[1]}`);
});

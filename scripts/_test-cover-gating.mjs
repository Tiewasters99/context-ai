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

import {
  SURFACES,
  asPlan,
  canOpenPath,
  canOpenSurface,
  isWorkshop,
  surfacePresentation,
} from '../src/lib/plan.ts';

const SURFACE_IDS = Object.keys(SURFACES);

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

// ── the plan behind the gate ──────────────────────────────────────────────
//
// covers.ts is one reader of src/lib/plan.ts; <PlanRoute>, the Dashboard's
// quick actions and the Productivity Suite are the others. The tier list is
// the single place a paid customer's surfaces are decided, and migration 067
// added a third paid price point (`basic`). Until PR #178 added it here,
// asPlan() narrowed a paying Basic customer to 'free' and Settings showed
// them the wrong plan name. These assertions exist so the next tier added to
// the database cannot be added to only half of the app.

test('every paid tier sees the core product, and only workshop sees more', () => {
  const coreSurfaces = SURFACE_IDS.filter((id) => SURFACES[id].tier === 'core');
  const frozen = SURFACE_IDS.filter((id) => SURFACES[id].tier === 'frozen');
  const beta = SURFACE_IDS.filter((id) => SURFACES[id].tier === 'beta');
  assert.ok(frozen.length > 0 && beta.length > 0, 'the fixture needs something closed to test');

  for (const plan of ['free', 'basic', 'pro', 'max']) {
    for (const id of coreSurfaces) {
      assert.equal(canOpenSurface(id, plan), true, `${plan} cannot open core surface ${id}`);
      assert.equal(surfacePresentation(id, plan), 'open');
    }
    for (const id of frozen) {
      assert.equal(canOpenSurface(id, plan), false, `${plan} can open frozen surface ${id}`);
      assert.equal(surfacePresentation(id, plan), 'hidden');
    }
    for (const id of beta) {
      assert.equal(canOpenSurface(id, plan), false);
      assert.equal(surfacePresentation(id, plan), 'beta', `${plan} does not see ${id} as beta`);
    }
    assert.equal(isWorkshop(plan), false);
  }

  for (const id of SURFACE_IDS) {
    assert.equal(canOpenSurface(id, 'workshop'), true, `workshop cannot open ${id}`);
    assert.equal(surfacePresentation(id, 'workshop'), 'open');
  }
  assert.equal(isWorkshop('workshop'), true);
});

test('a paying Basic customer is not narrowed to free', () => {
  // Migration 067's tier key, and the row Settings reads its name from.
  assert.equal(asPlan('basic'), 'basic');
  for (const plan of ['free', 'basic', 'pro', 'max', 'workshop']) {
    assert.equal(asPlan(plan), plan, `${plan} does not survive asPlan()`);
  }
  // And anything the database has never heard of still reads as free, which
  // is the conservative direction: a surface is never opened by accident.
  for (const odd of ['enterprise', '', 'WORKSHOP', null, 7, undefined, {}]) {
    assert.equal(asPlan(odd), 'free', `asPlan(${JSON.stringify(odd)}) is not free`);
  }
});

test('the tier keys in the app are the tier keys in the migration', () => {
  // billing_plans is seeded by 067; plan.ts is the browser's copy of that
  // vocabulary. If they drift, an account lands on a plan the app cannot name.
  const sql = readFileSync(join(ROOT, 'supabase/migrations/067_billing_and_credits.sql'), 'utf8');
  const seeded = new Set([...sql.matchAll(/\('(free|basic|pro|max|workshop)'/g)].map((m) => m[1]));
  for (const key of ['free', 'basic', 'pro', 'max', 'workshop']) {
    assert.ok(seeded.has(key), `migration 067 does not seed the tier key '${key}'`);
    assert.equal(asPlan(key), key);
  }
  // The path guard reads the same list: a route no surface claims is open to
  // every plan, and a frozen one is closed to all four paid tiers.
  for (const plan of ['free', 'basic', 'pro', 'max']) {
    assert.equal(canOpenPath('/app', plan), true);
    assert.equal(canOpenPath('/app/vault', plan), true);
    assert.equal(canOpenPath('/app/agents', plan), false);
  }
  assert.equal(canOpenPath('/app/agents', 'workshop'), true);
});

test('the dashboard default and the plate categories are inside the core set', () => {
  const core = JSON.parse(readFileSync(join(ROOT, 'public/templates/core-covers.json'), 'utf8'));
  const dash = readFileSync(join(ROOT, 'src/pages/Dashboard.tsx'), 'utf8');
  const m = dash.match(/DEFAULT_DASHBOARD_COVER\s*=\s*'([^']+)'/);
  assert.ok(m, 'Dashboard no longer declares DEFAULT_DASHBOARD_COVER');
  assert.ok(core.core.includes(m[1]), `dashboard default is not a core cover: ${m[1]}`);
});

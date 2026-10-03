// node --test scripts/_test-orchestrator-map.mjs
//
// The Orchestrator's map is drawn for the account's plan (Fable's review,
// 10-02, P0): it never sends an account to a room the router refuses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapForPlan, buildOrchestratorSystem } from '../lib/orchestrator-system.mjs';
import { PLANS, canOpenPathname } from '../lib/surfaces.mjs';

const routesIn = (text) => [...text.matchAll(/\((\/[a-z0-9\-/]+?)(?:\/<[^>]+>)?\)/gi)].map((m) => m[1]);

test('for every plan, every room the map points to is one the plan can open', () => {
  for (const plan of PLANS) {
    const map = mapForPlan(plan);
    const refused = routesIn(map).filter((r) => !canOpenPathname(r, plan));
    assert.deepEqual(refused, [], `${plan}: the map sends them to ${refused.join(', ')}`);
  }
});

test('a free account hears that the closed rooms are not in its plan, and is never pointed at them', () => {
  const map = mapForPlan('free');
  assert.match(map, /Not part of this account's plan: .*Moot Bench/);
  assert.doesNotMatch(map, /in Moot Bench with/, 'the paths paragraph no longer routes prep through Moot Bench');
  assert.doesNotMatch(map, /with the Editor for the polish/);
  assert.match(map, /Cite-Check for the citations/, 'core paths stay');
  assert.match(map, /productions in Discovery/);
});

test('workshop, and no plan at all, get the whole map as before', () => {
  const full = mapForPlan(undefined);
  assert.equal(mapForPlan('workshop'), full);
  assert.doesNotMatch(full, /Not part of this account's plan/);
  assert.match(full, /Drafting happens in a matter's Pages with the Editor for the polish and Cite-Check for the citations; trial and argument prep in Moot Bench with the Bucketizer holding the theory;/);
});

test('the system prompt carries the plan\'s map; an unknown plan is no plan', () => {
  assert.ok(buildOrchestratorSystem({ plan: 'free' }).includes(mapForPlan('free')));
  assert.ok(buildOrchestratorSystem({ plan: 'nonsense' }).includes(mapForPlan(undefined)));
  assert.ok(buildOrchestratorSystem({}).includes(mapForPlan(undefined)));
});

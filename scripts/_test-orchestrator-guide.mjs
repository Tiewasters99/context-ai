// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-orchestrator-guide.mjs
//
// The Orchestrator's field guide (lib/orchestrator-guide.mjs, 2026-11-04):
// every route it names is a real room, no plan is told about a room it cannot
// open, the questions people ask find their entries, and the tool is on the
// menu everywhere a person is talking to the Orchestrator — including inside a
// seal, since a lookup leaves nothing behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUIDE, GUIDE_TOOL, guideForPlan, guideIndex, lookupGuide, renderGuide, guidePromptBlock,
} from '../lib/orchestrator-guide.mjs';
import { PLANS, canOpenPathname, surfaceForPathname } from '../lib/surfaces.mjs';
import { orchestratorMenu } from '../lib/assistant-core.mjs';

const concrete = (r) => r.replace(/<[^>]+>/g, 'x');

test('every entry is whole: id, title, asks, text, and unique ids', () => {
  const ids = new Set();
  for (const e of GUIDE) {
    assert.match(e.id, /^[a-z0-9-]+$/, `${e.id}: slug`);
    assert.ok(!ids.has(e.id), `${e.id}: duplicate id`);
    ids.add(e.id);
    assert.ok(e.title.length > 8, `${e.id}: title`);
    assert.ok(Array.isArray(e.asks) && e.asks.length >= 3, `${e.id}: at least three phrasings`);
    assert.ok(e.text.length > 120 && e.text.length < 2000, `${e.id}: text ${e.text.length} chars`);
    assert.ok(Array.isArray(e.routes), `${e.id}: routes`);
  }
});

test('every route an entry names is a room the router knows', () => {
  for (const e of GUIDE) {
    for (const r of e.routes) {
      assert.ok(surfaceForPathname(concrete(r)), `${e.id}: ${r} is not a known surface`);
    }
  }
});

test('for every plan, no entry returned names a room the plan cannot open', () => {
  for (const plan of PLANS) {
    for (const e of guideForPlan(plan)) {
      for (const r of e.routes) assert.ok(canOpenPathname(concrete(r), plan), `${plan}: ${e.id} via ${r}`);
    }
    assert.equal(guideIndex(plan).length, guideForPlan(plan).length);
  }
  assert.equal(guideForPlan(undefined).length, GUIDE.length, 'no plan = the whole guide');
  assert.equal(guideForPlan('workshop').length, GUIDE.length, 'workshop sees everything');
});

test("Eden's question finds the moving entry first, and the lookup never invents", () => {
  const hits = lookupGuide('how do I move a group of documents from a matter to a submatter?');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, 'move-documents-sub-matter');
  assert.match(renderGuide(hits), /Select all/);
  assert.match(renderGuide(hits), /move_document proposes ONE document/);
  assert.deepEqual(lookupGuide('quantum chromodynamics'), [], 'nothing shared, nothing returned');
  assert.deepEqual(lookupGuide(''), []);
  assert.ok(lookupGuide('dark mode').some((e) => e.id === 'reader-light-dark'));
  assert.ok(lookupGuide('why is it asking me for a two factor code')[0].id === 'second-factor-sealed-only');
  assert.ok(lookupGuide('open this docx in Word and save a version')[0].id === 'work-in-word-import');
  assert.ok(lookupGuide('anything at all', undefined, 3).length <= 3);
});

test('the prompt block names the tool and lists what the guide covers', () => {
  const block = guidePromptBlock('free');
  assert.match(block, /app_guide/);
  assert.match(block, /relay_feedback/);
  for (const t of guideIndex('free')) assert.ok(block.includes(t), `lists "${t}"`);
});

test('app_guide is on the menu for a person, sealed or not, and not for a chartered agent', () => {
  const names = (m) => new Set(m.tools.map((t) => t.name));
  assert.ok(names(orchestratorMenu()).has(GUIDE_TOOL.name));
  assert.ok(names(orchestratorMenu({ sealed: true })).has(GUIDE_TOOL.name), 'a lookup leaves nothing behind');
  const charter = { allowed_tools: ['search'], id: 'c', name: 'c' };
  assert.ok(!names(orchestratorMenu({ charter })).has(GUIDE_TOOL.name));
  assert.ok(!orchestratorMenu().runTools.has(GUIDE_TOOL.name), 'not an mcp-core tool');
});

// The agents task board, browser side (A3 UI, B5 client, B7), asserted.
//
// Run:  node --test scripts/_test-agent-ui.mjs
//
// Offline: no network, no database, no React. The scope rule and the
// "migration 085 is not applied" test are pure modules and are driven
// directly; the wiring a Node harness cannot mount is asserted against the
// source text, each assertion naming the expression that would have to change
// for the behaviour to regress. The server half (what /api/mcp lets an agent
// see) is the backend PR's harness; this one checks that the interface tells
// the same story.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ancestorsInclusive,
  coveredMatterIds,
  isEffectivelySealed,
  normalizeScope,
  scopeCoversMatter,
} from '../src/lib/agent-scope.ts';
import { AGENTS_MIGRATION_MESSAGE, isMissingSchema } from '../src/lib/agents-schema.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

// A:  A1 (open), A2 (sealed B), A2x (under the seal, own tier A)
// B:  B1
// S:  sealed at the top (C), S1 beneath it
const M = [
  { id: 'A', parent_matterspace_id: null, ai_tier: 'A' },
  { id: 'A1', parent_matterspace_id: 'A', ai_tier: 'A' },
  { id: 'A2', parent_matterspace_id: 'A', ai_tier: 'B' },
  { id: 'A2x', parent_matterspace_id: 'A2', ai_tier: 'A' },
  { id: 'B', parent_matterspace_id: null, ai_tier: 'A' },
  { id: 'B1', parent_matterspace_id: 'B', ai_tier: 'A' },
  { id: 'S', parent_matterspace_id: null, ai_tier: 'C' },
  { id: 'S1', parent_matterspace_id: 'S', ai_tier: 'A' },
];

// ---------------------------------------------------------------------------
// 1. The scope rule
// ---------------------------------------------------------------------------

test('a grant covers the matter and what is beneath it, and nothing else', () => {
  assert.equal(scopeCoversMatter(M, ['A'], 'A'), true);
  assert.equal(scopeCoversMatter(M, ['A'], 'A1'), true);
  assert.equal(scopeCoversMatter(M, ['A'], 'B'), false);
  assert.equal(scopeCoversMatter(M, ['A'], 'B1'), false);
  // A sub-matter grant does not reach up to its parent.
  assert.equal(scopeCoversMatter(M, ['B1'], 'B'), false);
  assert.equal(scopeCoversMatter(M, ['B1'], 'B1'), true);
});

test('the seal wins: a sealed child of a granted matter is never covered', () => {
  assert.equal(scopeCoversMatter(M, ['A'], 'A2'), false);
  // Inherited: A2x has tier A of its own but sits under the seal.
  assert.equal(isEffectivelySealed(M, 'A2x'), true);
  assert.equal(scopeCoversMatter(M, ['A'], 'A2x'), false);
  // Granting the sealed matter itself does nothing either.
  assert.equal(scopeCoversMatter(M, ['S'], 'S'), false);
  assert.equal(scopeCoversMatter(M, ['S'], 'S1'), false);
  assert.deepEqual([...coveredMatterIds(M, ['A'])].sort(), ['A', 'A1']);
});

test('privilege default OFF: an empty or missing scope sees nothing', () => {
  for (const scope of [[], null, undefined]) {
    for (const m of M) assert.equal(scopeCoversMatter(M, scope, m.id), false);
    assert.equal(coveredMatterIds(M, scope).size, 0);
  }
});

test('what is stored: no sealed matter, no matter already carried by its parent', () => {
  assert.deepEqual(normalizeScope(M, ['A1', 'A', 'S', 'B1', 'A2x', 'A']), ['A', 'B1']);
  assert.deepEqual(normalizeScope(M, []), []);
});

test('the ancestor walk survives a loop in bad data', () => {
  const loop = [
    { id: 'x', parent_matterspace_id: 'y', ai_tier: 'A' },
    { id: 'y', parent_matterspace_id: 'x', ai_tier: 'A' },
  ];
  assert.deepEqual(ancestorsInclusive(loop, 'x'), ['x', 'y']);
});

// ---------------------------------------------------------------------------
// 2. Before migration 085: one sentence, never a crash
// ---------------------------------------------------------------------------

test('a missing table or column reads as "migration 085", anything else does not', () => {
  assert.equal(
    AGENTS_MIGRATION_MESSAGE,
    'Agents need a database update (migration 085) before they can be used.',
  );
  for (const code of ['PGRST205', 'PGRST204', '42P01', '42703']) {
    assert.equal(isMissingSchema({ code, message: 'x' }), true, code);
  }
  assert.equal(isMissingSchema({ message: "Could not find the 'kind' column of 'connector_tokens' in the schema cache" }), true);
  assert.equal(isMissingSchema({ message: 'relation "public.agent_tasks" does not exist' }), true);
  assert.equal(isMissingSchema({ code: '42501', message: 'new row violates row-level security policy' }), false);
  assert.equal(isMissingSchema(null), false);
});

test('every surface routes a missing schema to that sentence', () => {
  const lib = src('src/lib/agentTasks.ts');
  assert.match(lib, /if \(isMissingSchema\(err\)\) throw new AgentsNotReadyError\(\);/);
  assert.match(src('src/lib/agentTokens.ts'), /raise\(error, /);
  for (const f of [
    'src/components/agents/AgentsSection.tsx',
    'src/components/agents/DelegateCard.tsx',
    'src/components/agents/MatterTasks.tsx',
  ]) {
    assert.match(src(f), /AGENTS_MIGRATION_MESSAGE/, `${f} does not show the 085 sentence`);
    assert.match(src(f), /isAgentsNotReady\(/, `${f} does not recognise the 085 failure`);
  }
});

// ---------------------------------------------------------------------------
// 3. The copy the spec requires, verbatim
// ---------------------------------------------------------------------------

test('the Agents section says what an agent sees', () => {
  const s = src('src/components/agents/AgentsSection.tsx');
  assert.ok(s.includes("'This agent sees only the matters you tick. Nothing else, and never a SecureSpace.'"));
  assert.match(s, /<section id="agents"/);
  const page = src('src/pages/Connections.tsx');
  assert.match(page, /<AgentsSection \/>/);
  assert.match(src('src/pages/GrokConnect.tsx'), /to="\/app\/connections#agents"/);
});

test('an agent token is a connector token with kind agent, and never lights the Claude badge', () => {
  const t = src('src/lib/agentTokens.ts');
  assert.match(t, /generateConnectorToken\(\)/);
  assert.match(t, /kind: 'agent',\s*agent_provider: input\.provider,\s*matter_scope: input\.scope,/);
  assert.doesNotMatch(t, /token_hash[^:]/, 'the browser never reads token_hash back');
  assert.match(src('src/pages/Connections.tsx'), /t\.kind !== 'agent' &&/);
});

test('the Delegate card lists only agents that can see the matter, and says so when none can', () => {
  const d = src('src/components/agents/DelegateCard.tsx');
  assert.ok(d.includes("'No agent can see this matter — grant one under Connections → Agents.'"));
  // The rendered sentence (with its link) must read the same as the constant.
  assert.match(d, /No agent can see this matter — grant one under\{' '\}/);
  assert.match(d, />\s*Connections → Agents\s*<\/Link>\s*\.\s*<\/p>/);
  const hook = src('src/hooks/useAgentTokens.ts');
  assert.match(hook, /all\.filter\(\(a\) => scopeCoversMatter\(matters, a\.matter_scope, matterId\)\)/);
});

// ---------------------------------------------------------------------------
// 4. Every human write is logged, and none reads back through RLS
// ---------------------------------------------------------------------------

test('create, answer, cancel and reassign each append a human event', () => {
  const lib = src('src/lib/agentTasks.ts');
  for (const [fn, kind] of [
    ['createTask', 'created'],
    ['answerQuestion', 'answered'],
    ['cancelTask', 'cancelled'],
    ['reassignTask', 'reassigned'],
  ]) {
    const start = lib.indexOf(`export async function ${fn}(`);
    assert.ok(start >= 0, `${fn} is gone`);
    const next = lib.indexOf('\nexport ', start + 10);
    const body = lib.slice(start, next < 0 ? undefined : next);
    assert.match(body, new RegExp(`logHumanEvent\\([^)]*'${kind}'`), `${fn} does not log '${kind}'`);
  }
  assert.match(lib, /actor_kind: 'human',/);
  // The id is minted in the browser so no INSERT … RETURNING is needed.
  assert.match(lib, /const id = crypto\.randomUUID\(\);/);
  assert.doesNotMatch(lib, /\.insert\([^;]*\)\s*\.select\(/, 'an insert reads back through RLS');
  assert.doesNotMatch(lib, /\.update\([^;]*\)\s*\.select\(/, 'an update reads back through RLS');
  assert.doesNotMatch(lib, /\.delete\(/, 'tasks are cancelled, never deleted');
});

// ---------------------------------------------------------------------------
// 5. Where Delegate… and Tasks live
// ---------------------------------------------------------------------------

test('Delegate… is on the Reader, lists, pages, tables and calendar entries', () => {
  const reader = src('src/pages/DocumentReader.tsx');
  assert.match(reader, /attachment=\{\{ kind: 'document', id: doc\.id,/);
  assert.match(reader, /label: 'Delegate…', run: \(\) => setDelegateOpen\(true\)/, 'phone menu');
  for (const f of ['src/pages/ListView.tsx', 'src/pages/PageView.tsx', 'src/pages/TableView.tsx']) {
    const s = src(f);
    assert.match(s, /matterId=\{item\?\.space_type === 'matterspace' \? item\.space_id : null\}/, f);
    assert.match(s, /kind: 'content_item', id: item\.id/, f);
  }
  const cal = src('src/components/calendar/ContextspacesCalendar.tsx');
  assert.match(cal, /draft\.id && draft\.kind === 'calendar' && \(\s*<DelegateButton/);
  assert.match(cal, /kind: 'calendar_event', id: draft\.id/);
});

test('the matter has a Tasks tab, rendered by MatterTasks', () => {
  const view = src('src/pages/MatterspaceView.tsx');
  assert.match(view, /const tabs = \[[^\]]*'Calendar', 'Tasks'/);
  assert.match(view, /activeTab === 'Tasks' && matter && \(\s*<MatterTasks matterId=\{matter\.id\} \/>/);
  // …and is not also handed to the content surface.
  assert.match(view, /activeTab !== 'Tasks' && matter && \(\s*<ContentSurface/);
});

test('every agents card is draggable, resizable and pinnable', () => {
  const card = src('src/components/agents/AgentCard.tsx');
  assert.match(card, /useDraggableResizable\(storageKey\)/);
  assert.match(card, /\{!isMobile && <PinToggle pinned=\{pinned\} onToggle=\{togglePin\} \/>\}/);
  assert.match(card, /ref=\{cardRef\}/);
  for (const f of ['AgentsSection.tsx', 'DelegateCard.tsx']) {
    assert.match(src(`src/components/agents/${f}`), /<AgentCard\b/, f);
    assert.doesNotMatch(src(`src/components/agents/${f}`), /fixed inset-0/, `${f} builds its own modal`);
  }
});

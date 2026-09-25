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
  agentCoversMatter,
  ancestorsInclusive,
  coveredMatterIds,
  isEffectivelySealed,
  normalizeScope,
  scopeCoversMatter,
} from '../src/lib/agent-scope.ts';
import {
  AGENTS_MIGRATION_MESSAGE,
  isMissingSchema,
  isUserToken,
  readUserTokens,
} from '../src/lib/agents-schema.ts';
import {
  AGENTS_PAGE_PATH,
  CHAT_ASSISTANT_NOTE,
  GROUP_LABEL,
  buildRecipients,
  recipientsForMatter,
  taskRecipientRef,
} from '../src/lib/task-recipients.ts';

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
  assert.match(page, /<AgentsSection( refreshKey=\{agentsRefresh\})? \/>/);
  assert.match(src('src/pages/GrokConnect.tsx'), /to="\/app\/connections#agents"/);
});

test('an agent token is a connector token with kind agent, and never lights the Claude badge', () => {
  const t = src('src/lib/agentTokens.ts');
  assert.match(t, /generateConnectorToken\(\)/);
  assert.match(t, /kind: 'agent',\s*agent_provider: input\.provider,\s*matter_scope: all \? \[\] : input\.scope,/);
  assert.doesNotMatch(t, /token_hash[^:]/, 'the browser never reads token_hash back');
});

test('the Delegate card lists every connection that can see the matter, grouped, and says so when none can', () => {
  const d = src('src/components/agents/DelegateCard.tsx');
  assert.ok(d.includes("'No connected AI can see this matter — connect one, or grant an agent, under Connections.'"));
  // The rendered sentence (with its link) must read the same as the constant.
  assert.match(d, /No connected AI can see this matter — connect one, or grant an agent, under\{' '\}/);
  assert.match(d, />\s*Connections\s*<\/Link>\s*\.\s*<\/p>/);
  assert.match(d, /useRecipientsForMatter\(matterId \|\| null\)/, 'agents AND assistants, per matter');
  assert.match(d, /<optgroup label=\{GROUP_LABEL\.agents\}>/);
  assert.match(d, /<optgroup label=\{GROUP_LABEL\.assistants\}>/);
  assert.match(d, /chosen\.kind !== 'agent' && \(\s*<p[^>]*>\{CHAT_ASSISTANT_NOTE\}<\/p>/, 'the quiet note for a chat assistant');
  assert.match(d, /\{OPEN_IN_AGENTS\}/, 'the card says where tasks live');
  assert.match(d, /recipient: refOf\(chosen\)/);
  const hook = src('src/hooks/useAgentTokens.ts');
  // Only the caller's OWN live agents: connector_tokens RLS returns only
  // the caller's rows, and revoked or expired ones are dropped first.
  assert.match(hook, /const live = own\.filter\(\(a\) => isLiveAgent\(a\)\);/);
  assert.match(hook, /live\.filter\(\(a\) => agentCoversMatter\(matters, a, matterId\)\)/);
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

// ---------------------------------------------------------------------------
// 6. Agent tokens stay out of the user-token surfaces (SCHEMA-NOTES 085)
// ---------------------------------------------------------------------------

test('readUserTokens drops agent tokens, and before 085 counts every row as a user token', async () => {
  assert.equal(isUserToken({ kind: 'agent' }), false);
  assert.equal(isUserToken({ kind: 'user' }), true);
  assert.equal(isUserToken({}), true, 'no kind = a user token');

  // After 085: the kind column is there.
  const asked = [];
  let r = await readUserTokens(async (cols) => {
    asked.push(cols);
    return { data: [{ id: 1, kind: 'user' }, { id: 2, kind: 'agent' }, { id: 3, kind: null }], error: null };
  }, 'id');
  assert.deepEqual(asked, ['id, kind']);
  assert.deepEqual(r.data.map((x) => x.id), [1, 3]);

  // Before 085: the first read fails on the missing column, the second answers.
  asked.length = 0;
  r = await readUserTokens(async (cols) => {
    asked.push(cols);
    return cols.includes('kind')
      ? { data: null, error: { code: '42703', message: 'column connector_tokens.kind does not exist' } }
      : { data: [{ id: 1 }, { id: 2 }], error: null };
  }, 'id');
  assert.deepEqual(asked, ['id, kind', 'id']);
  assert.deepEqual(r.data.map((x) => x.id), [1, 2]);
  assert.equal(r.error, null);

  // Any other failure is passed through, not retried.
  asked.length = 0;
  r = await readUserTokens(async (cols) => {
    asked.push(cols);
    return { data: null, error: { code: '42501', message: 'permission denied' } };
  }, 'id');
  assert.deepEqual(asked, ['id, kind']);
  assert.equal(r.data, null);
  assert.equal(r.error.code, '42501');
});

test('every user-token read goes through readUserTokens, and none filters on kind', () => {
  for (const f of [
    'src/pages/ClaudeConnect.tsx',
    'src/pages/ChatGPTConnect.tsx',
    'src/pages/GeminiConnect.tsx',
    'src/pages/GrokConnect.tsx',
    'src/pages/Connections.tsx',
    'src/hooks/useFirstRun.ts',
  ]) {
    const s = src(f);
    assert.match(s, /readUserTokens</, `${f} reads tokens without dropping agent tokens`);
    assert.doesNotMatch(s, /\.eq\('kind'/, `${f} filters on kind, which fails before 085`);
    // Each select of connector_tokens is inside a readUserTokens builder.
    const direct = s.match(/from\('connector_tokens'\)\s*\.select\('/g) ?? [];
    assert.equal(direct.length, 0, `${f} selects connector_tokens directly`);
  }
});

// ---------------------------------------------------------------------------
// 7. Ownership (085: only the agent token's owner may create or update a task)
// ---------------------------------------------------------------------------

test('a task on someone else\'s connection is read-only, and says whose it is', () => {
  const t = src('src/components/agents/MatterTasks.tsx');
  assert.match(t, /mine=\{byKey\.has\(taskKey\(t\) \?\? ''\)\}/, 'mine = the recipient is one of the caller\'s own connections');
  assert.match(t, /This task is assigned to \{ownerName\}'s connected AI\. Only \{ownerName\} can answer, cancel or/);
  assert.match(t, /\{mine && \(<>\s*<textarea/, 'the Answer box is only for the owner');
  assert.match(t, /\{live && mine && \(/, 'Cancel and Reassign are only for the owner');
  assert.match(t, /const reassignable = useMemo\(\(\) => \[\.\.\.agents, \.\.\.assistants\], \[agents, assistants\]\)/,
    'reassign offers the same list as the Delegate card');
  assert.match(t, /\{OPEN_IN_AGENTS\}/, 'the tab says where every task lives');
});

test('the limits 085 enforces are enforced before the request', () => {
  const lib = src('src/lib/agentTasks.ts');
  assert.match(lib, /export const TITLE_MAX = 500;/);
  assert.match(lib, /export const INSTRUCTIONS_MAX = 20_000;/);
  assert.match(lib, /export const ANSWER_MAX = 4_000;/);
  assert.match(lib, /title\.length > TITLE_MAX/);
  assert.match(lib, /instructions\.length > INSTRUCTIONS_MAX/);
  assert.match(lib, /text\.length > ANSWER_MAX/);
  const d = src('src/components/agents/DelegateCard.tsx');
  assert.match(d, /maxLength=\{TITLE_MAX\}/);
  assert.match(d, /maxLength=\{INSTRUCTIONS_MAX\}/);
  assert.match(src('src/components/agents/MatterTasks.tsx'), /maxLength=\{ANSWER_MAX\}/);
});

test('every human event names the signed-in user', () => {
  const lib = src('src/lib/agentTasks.ts');
  assert.match(lib, /task_id: taskId,\s*actor_kind: 'human',\s*actor_user: userId,\s*actor_token_id: null,\s*kind,\s*body,/);
  assert.match(lib, /const uid = session\?\.user\?\.id;/);
});

// ---------------------------------------------------------------------------
// 9. Connect as an agent over OAuth (migration 087)
// ---------------------------------------------------------------------------

test('the OAuth consent screen offers both ways to connect, full assistant by default', () => {
  const s = src('src/pages/OAuthAuthorize.tsx');
  assert.match(s, /useState<'assistant' \| 'agent'>\('assistant'\)/, 'full assistant stays the default');
  assert.match(s, /FULL_ASSISTANT_COPY = 'Sees every matter you can see, except SecureSpaces\.'/);
  assert.match(s, /import \{ AGENT_SCOPE_COPY \} from '@\/components\/agents\/AgentsSection'/,
    'the agent wording is the Agents section\'s own constant, not a retyped copy');
  assert.match(s, /<AgentMatterPicker\s+value=\{agentScope\}\s+onChange=\{setAgentScope\}/, 'the same matter picker');
  assert.match(s, /connect_as: 'agent'/);
  assert.match(s, /matter_scope: agentScopeAll \? \[\] : normalizeScope\(allMatters, agentScope\)/, 'sealed and covered matters dropped before sending');
  assert.doesNotMatch(s, /from\('connector_tokens'\)\s*\.select\('\*'/, 'never select * on connector_tokens (086)');
});

test('an OAuth-backed agent says how it connected, and offers no token to copy', () => {
  const a = src('src/components/agents/AgentsSection.tsx');
  assert.match(a, /Connected by sign-in \(OAuth\) from \$\{link\.clientName\}\./);
  assert.match(a, /if \(link\) await revokeOauthGrant\(link\.grantId\)/, 'revoking the agent ends its sign-in too');
  const c = src('src/pages/Connections.tsx');
  assert.match(c, /Connected as agent \$\{grant\.agent_name \|\| 'an agent'\}/);
  assert.match(c, /from\('oauth_grants'\)\s*\.select\('\*'\)/, 'oauth_grants read with * so a database without 087 still lists grants');
  const t = src('src/lib/agentTokens.ts');
  assert.match(t, /return t\.token_prefix === 'oauth';/);
});

// ---------------------------------------------------------------------------
// 10. "All my matters (except SecureSpaces)" (migration 088)
// ---------------------------------------------------------------------------

test('an agent with scope_all covers every matter except a sealed one, including one it never listed', () => {
  const all = { matter_scope: [], scope_all: true };
  for (const id of ['A', 'A1', 'B', 'B1']) assert.equal(agentCoversMatter(M, all, id), true, id);
  for (const id of ['A2', 'A2x', 'S', 'S1']) assert.equal(agentCoversMatter(M, all, id), false, id);
  // A matter created later, not in the tree the grant was made from.
  const later = [...M, { id: 'N', parent_matterspace_id: null, ai_tier: 'A' }];
  assert.equal(agentCoversMatter(later, all, 'N'), true);
  // Without it, the list rules exactly as before; only a literal true is "all".
  assert.equal(agentCoversMatter(M, { matter_scope: ['A'], scope_all: false }, 'B'), false);
  assert.equal(agentCoversMatter(M, { matter_scope: ['A'] }, 'A1'), true);
  assert.equal(agentCoversMatter(M, { matter_scope: [], scope_all: 'true' }, 'A'), false);
});

test('the picker offers "All my matters", greys the tree, and keeps the ticks underneath', () => {
  const p = src('src/components/agents/AgentMatterPicker.tsx');
  assert.ok(p.includes("SCOPE_ALL_LABEL = 'All my matters (except SecureSpaces)'"));
  assert.ok(p.includes("SCOPE_ALL_HINT = 'Includes matters you create later. You can narrow it any time.'"));
  assert.match(p, /const disabled = allOn \|\| sealed \|\| parentTicked;/, 'every box in the tree is disabled while "all" is on');
  assert.match(p, /if \(allOn\) return;/, 'and a click cannot change the ticks');
  assert.match(p, /\$\{allOn \? 'opacity-40' : ''\}/, 'the tree is greyed');
  assert.doesNotMatch(p, /onScopeAllChange\([^)]*\);\s*onChange\(/, 'ticking "all" does not clear the ticks (unticking restores them)');
  // Both callers pass it through: Connections › Agents add/edit and the consent page.
  const a = src('src/components/agents/AgentsSection.tsx');
  assert.equal((a.match(/scopeAll=\{scopeAll\} onScopeAllChange=\{setScopeAll\}/g) ?? []).length, 2, 'Add and Edit both offer it');
  assert.match(a, /scope: normalizeScope\(all, scope\),\s*scopeAll,/);
  assert.match(a, /updateAgentScope\(agent\.id, normalizeScope\(all, scope\), \{ scopeAll, wasAll: agent\.scope_all === true \}\)/);
  assert.ok(a.includes("ALL_MATTERS_LABEL = 'All matters (except SecureSpaces)'"));
  assert.match(a, /a\.scope_all\s*\?\s*`Sees: \$\{ALL_MATTERS_LABEL\}\.`/, 'the list says "All matters (except SecureSpaces)" instead of a list');
  const o = src('src/pages/OAuthAuthorize.tsx');
  assert.match(o, /scopeAll=\{agentScopeAll\}\s+onScopeAllChange=\{setAgentScopeAll\}/);
  assert.match(o, /\.\.\.\(agentScopeAll \? \{ scope_all: true \} : \{\}\)/, 'the consent POST carries scope_all only when ticked');
  assert.match(o, /useState<'assistant' \| 'agent'>\('assistant'\)/, 'the default is still "a full assistant"');
  assert.match(o, /setAgentScopeAll\(a\.scope_all === true\)/, 're-consent starts from the agent as it is');
});

test('scope_all never breaks a database without 088, and never widens a write', () => {
  const t = src('src/lib/agentTokens.ts');
  // Reads name it (086 forbids *) and fall back without it.
  assert.match(t, /read\(`\$\{AGENT_COLUMNS\}, scope_all`\)/);
  assert.match(t, /if \(error && isScopeAllUnreadable\(error\)\) \(\{ data, error \} = await read\(AGENT_COLUMNS\)\);/);
  assert.match(t, /scope_all: t\.scope_all === true,/);
  // Writes name it only when it is (or was) true.
  assert.match(t, /\.\.\.\(all \? \{ scope_all: true \} : \{\}\),/);
  assert.match(t, /if \(all \|\| opts\.wasAll === true\) patch\.scope_all = all;/);
  assert.match(t, /matter_scope: all \? \[\] : scope/);
  assert.doesNotMatch(t, /select\('\*'\)[\s\S]{0,40}connector_tokens|from\('connector_tokens'\)\s*\.select\('\*'/);
});

// ---------------------------------------------------------------------------
// 11. Any connected AI takes a task, and the Agents page (migration 089)
// ---------------------------------------------------------------------------

const CONNECTIONS = {
  agents: [
    { id: 'ag-a', name: 'Grok bot', agent_provider: 'grok', matter_scope: ['A'], scope_all: false, last_used_at: null, revoked_at: null },
    { id: 'ag-all', name: '', agent_provider: 'claude', matter_scope: [], scope_all: true, last_used_at: null, revoked_at: null },
    { id: 'ag-gone', name: 'Old bot', agent_provider: 'other', matter_scope: ['A'], last_used_at: null, revoked_at: '2026-09-01' },
    { id: 'ag-linked', name: 'Grok (sign-in)', token_prefix: 'oauth', agent_provider: 'grok', matter_scope: ['B'], last_used_at: null, revoked_at: null },
  ],
  userTokens: [
    { id: 'tok-1', name: 'Claude Desktop', last_used_at: '2026-09-20', revoked_at: null },
    { id: 'tok-x', name: 'Expired CLI', last_used_at: null, revoked_at: null, expires_at: '2020-01-01' },
  ],
  grants: [
    { id: 'gr-1', client_name: 'ChatGPT', last_used_at: null, revoked_at: null, agent_token_id: null },
    { id: 'gr-link', client_name: 'Grok', last_used_at: null, revoked_at: null, agent_token_id: 'ag-linked' },
    { id: 'gr-gone', client_name: 'Claude', last_used_at: null, revoked_at: '2026-09-02', agent_token_id: null },
  ],
};

test('every connection is a recipient: agents, full-access tokens and full-assistant sign-ins', () => {
  const all = buildRecipients(CONNECTIONS);
  const byKey = new Map(all.map((r) => [r.key, r]));
  // All three kinds, each keyed the way a task's columns name it.
  assert.equal(byKey.get('token:ag-a').kind, 'agent');
  assert.equal(byKey.get('token:tok-1').kind, 'token');
  assert.equal(byKey.get('grant:gr-1').kind, 'grant');
  assert.equal(byKey.get('grant:gr-1').provider, 'ChatGPT');
  assert.equal(byKey.get('token:tok-1').provider, 'Claude');
  assert.equal(byKey.get('token:ag-all').name, 'Claude agent', 'an unnamed agent is named for its provider');
  assert.equal(byKey.get('token:ag-linked').how, 'Agent (sign-in)');
  // An agent-linked sign-in IS its agent: it is not a second recipient.
  assert.equal(byKey.has('grant:gr-link'), false);
  // Revoked and expired ones stay (an old task names them) but are not live.
  assert.equal(byKey.get('token:ag-gone').live, false);
  assert.equal(byKey.get('token:tok-x').live, false);
  assert.equal(byKey.get('grant:gr-gone').live, false);
  assert.deepEqual(all.filter((r) => r.group === 'assistants').map((r) => r.key).sort(),
    ['grant:gr-1', 'grant:gr-gone', 'token:tok-1', 'token:tok-x']);
  assert.equal(GROUP_LABEL.agents, 'Agents');
  assert.equal(GROUP_LABEL.assistants, 'Assistants you chat with');
  assert.equal(CHAT_ASSISTANT_NOTE, 'Waits until you ask it to check its tasks.');
});

test('the recipient list for a matter includes chat assistants; a sealed matter has nobody', () => {
  const all = buildRecipients(CONNECTIONS);
  const inA = recipientsForMatter(M, all, 'A1');
  assert.deepEqual(inA.agents.map((r) => r.id).sort(), ['ag-a', 'ag-all'], 'agents whose scope covers it (incl. scope_all)');
  assert.deepEqual(inA.assistants.map((r) => r.key).sort(), ['grant:gr-1', 'token:tok-1'], 'live assistants only');
  const inB = recipientsForMatter(M, all, 'B1');
  assert.deepEqual(inB.agents.map((r) => r.id).sort(), ['ag-all', 'ag-linked']);
  assert.equal(inB.assistants.length, 2, 'an assistant sees every unsealed matter');
  for (const sealed of ['A2', 'A2x', 'S', 'S1']) {
    const r = recipientsForMatter(M, all, sealed);
    assert.equal(r.sealed, true, sealed);
    assert.equal(r.agents.length + r.assistants.length, 0, `${sealed}: the seal hides it from every connector`);
  }
  assert.deepEqual(taskRecipientRef({ assigned_token_id: null, assigned_grant_id: 'g' }), { kind: 'grant', id: 'g' });
  assert.deepEqual(taskRecipientRef({ assigned_token_id: 't' }), { kind: 'token', id: 't' }, 'a pre-089 row has no grant column');
});

test('the browser writes the right recipient column, and survives a database without 089', () => {
  const lib = src('src/lib/agentTasks.ts');
  assert.match(lib, /if \(to\.kind === 'grant'\) return \{ assigned_token_id: null, assigned_grant_id: to\.id \};/);
  assert.match(lib, /return clearGrant \? \{ assigned_token_id: to\.id, assigned_grant_id: null \} : \{ assigned_token_id: to\.id \};/,
    'a token write names the grant column only when it has to clear it');
  assert.match(lib, /read089\(build, TASK_COLUMNS, 'assigned_grant_id'\)/, 'task reads retry without the 089 column');
  assert.match(lib, /read089\(build, EVENT_COLUMNS, 'actor_grant_id'\)/, 'event reads too');
  assert.ok(lib.includes("'Handing tasks to an assistant you chat with needs a database update (migration 089). Agents work now.'"));
  const hook = src('src/hooks/useTaskRecipients.ts');
  assert.match(hook, /readUserTokens<UserTokenRow>\(/, 'user tokens through readUserTokens (never select *, never token_hash)');
  assert.match(hook, /from\('oauth_grants'\)\s*\.select\('\*'\)/, 'grants with * so a database without 087 still reads');
});

test('the Agents page is the front door: every connection, all tasks, New task', () => {
  assert.equal(AGENTS_PAGE_PATH, '/app/agent-tasks');
  const p = src('src/pages/AgentTasks.tsx');
  assert.match(p, /const \{ all, byKey, loading, notReady, error: recipientsError \} = useTaskRecipients\(\);/,
    'it lists every connection (agents, tokens, grants)');
  assert.match(p, /const groups: RecipientGroup\[\] = \['agents', 'assistants'\];/);
  assert.match(p, /\{GROUP_LABEL\[g\]\}/);
  assert.match(p, /listTasks\(\{ all: true \}, \{ limit: 500 \}\)/, 'all tasks, across every matter');
  assert.match(p, /section\('Waiting for you', waiting,/);
  assert.match(p, /section\('Open', open,/);
  assert.match(p, /'Recently done'/);
  assert.match(p, /<DelegateCard\s+matterId=\{null\}\s+attachment=\{null\}\s+defaultTitle=""\s+pickMatter\s+recipientKey=\{selectedKey\}/,
    'New task: one card, matter chosen there, recipient preselected');
  assert.match(p, /r\.kind === 'agent' \? \(/, 'Edit matters / Revoke for an agent');
  assert.match(p, /<Link to="\/app\/connections"/, 'Connections for the others');
  assert.match(src('src/components/agents/MatterSelect.tsx'), /disabled=\{sealed\}/, 'a SecureSpace cannot be chosen');
  // Registered as its own core surface; the frozen charters surface is untouched.
  const surfaces = src('lib/surfaces.mjs');
  assert.match(surfaces, /agentTasks: \{\s*tier: 'core',\s*paths: \['\/app\/agent-tasks'\]/);
  assert.match(surfaces, /agents: \{\s*tier: 'frozen',\s*paths: \['\/app\/agents'\]/);
  assert.match(src('src/App.tsx'), /<Route path="agent-tasks" element=\{<AgentTasks \/>\} \/>/);
  assert.match(src('src/components/layout/Sidebar.tsx'), /to="\/app\/agent-tasks"[\s\S]{0,600}<span>Agents<\/span>/);
  assert.match(src('src/components/layout/MainLayout.tsx'), /<NavLink to="\/app\/agent-tasks"/, 'on the phone tab bar too');
  const dash = src('src/pages/Dashboard.tsx');
  assert.match(dash, /\{ label: 'Agents', icon: Bot, action: 'agents', surface: 'agentTasks' \}/);
  assert.match(dash, /navigate\('\/app\/agent-tasks'\)/);
});

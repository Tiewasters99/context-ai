// What a drag in the sidebar changes. Every move is asked about first (Gap 5;
// Eden 10-02: moving is for fixing a misfiled matter).
//
// Run:  node --test scripts/_test-matter-move.mjs
//
// Offline: no network, no database, no React. lib/matter-move.ts is pure and
// is driven directly; the sidebar wiring a Node harness cannot mount is
// asserted against the source text.
//
// The tree (one serverspace, "Legal"):
//
//   Teman            shared with ann; Grok is granted it
//     Amazon         (sub-matter)
//     Privilege      (sub-matter)
//   UKC              shared with bob and cat
//     UKC-Exhibits
//   Bushell          shared with ann
//   Vault            SecureSpace (tier B), shared with dee
//     Sealed-Child   own tier A, sealed by inheritance
//   Lone             no one shared on it
//   Other            no one shared on it
//
// Everyone on the serverspace: me, sam.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ancestorsAbove,
  computeMoveImpact,
  movedText,
  moveWords,
  subtreeIds,
  whatMoves,
  withParent,
} from '../src/lib/matter-move.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

const M = [
  { id: 'teman', name: 'Teman', parent_matterspace_id: null, ai_tier: 'A' },
  { id: 'amazon', name: 'Amazon', parent_matterspace_id: 'teman', ai_tier: 'A' },
  { id: 'priv', name: 'Privilege', parent_matterspace_id: 'teman', ai_tier: 'A' },
  { id: 'ukc', name: 'UKC', parent_matterspace_id: null, ai_tier: 'A' },
  { id: 'ukcx', name: 'UKC-Exhibits', parent_matterspace_id: 'ukc', ai_tier: 'A' },
  { id: 'bushell', name: 'Bushell', parent_matterspace_id: null, ai_tier: 'A' },
  { id: 'vault', name: 'Vault', parent_matterspace_id: null, ai_tier: 'B' },
  { id: 'sealedkid', name: 'Sealed-Child', parent_matterspace_id: 'vault', ai_tier: 'A' },
  { id: 'lone', name: 'Lone', parent_matterspace_id: null, ai_tier: 'A' },
  { id: 'other', name: 'Other', parent_matterspace_id: null, ai_tier: 'A' },
];
const MEMBERS = {
  teman: ['ann'], amazon: [], priv: [], ukc: ['bob', 'cat'], ukcx: [],
  bushell: ['ann'], vault: ['dee'], sealedkid: [], lone: [], other: [],
};
const NAMES = { ann: 'Ann Lee', bob: 'bob@x.com', cat: 'Cat Ng', dee: 'Dee', me: 'Me', sam: 'Sam' };
const nameOf = (id) => M.find((m) => m.id === id)?.name ?? 'a matter above it that you cannot open';
const labelOf = (u) => NAMES[u] ?? 'someone';

const allMembers = (over = {}) => new Map(Object.entries({ ...MEMBERS, ...over }));
const GROK = { id: 'g', label: 'Grok', matter_scope: ['teman'], scope_all: false };
const UKC_BOT = { id: 'u', label: 'UKC bot', matter_scope: ['ukc'], scope_all: false };
const EVERYTHING = { id: 'e', label: 'Everything bot', matter_scope: [], scope_all: true };

function impact(matterId, newParentId, opts = {}) {
  return computeMoveImpact({
    matters: opts.matters ?? M,
    matterId,
    newParentId,
    membersOf: opts.membersOf ?? allMembers(),
    serverspaceMembers: 'serverspaceMembers' in opts ? opts.serverspaceMembers : ['me', 'sam'],
    me: opts.me ?? 'me',
    agents: 'agents' in opts ? opts.agents : [],
  });
}

// ── the tree helpers ─────────────────────────────────────────────────

test('the tree helpers: subtree, re-parent, ancestors and a parent this account cannot see', () => {
  assert.deepEqual(subtreeIds(M, 'teman').sort(), ['amazon', 'priv', 'teman']);
  const moved = withParent(M, 'teman', 'ukc');
  assert.equal(moved.find((m) => m.id === 'teman').parent_matterspace_id, 'ukc');
  assert.equal(M.find((m) => m.id === 'teman').parent_matterspace_id, null, 'the input is not mutated');
  assert.deepEqual(ancestorsAbove(moved, 'amazon'), { ids: ['teman', 'ukc'], hiddenParent: null });
  const partial = [{ id: 'x', name: 'X', parent_matterspace_id: 'hidden', ai_tier: 'A' }];
  assert.deepEqual(ancestorsAbove(partial, 'x'), { ids: [], hiddenParent: 'hidden' });
  assert.equal(whatMoves('Teman', 0), 'Teman');
  assert.equal(whatMoves('Teman', 1), 'Teman and its sub-matter');
  assert.equal(whatMoves('Teman', 20), 'Teman and its 20 sub-matters');
});

// ── people ───────────────────────────────────────────────────────────

const texts = (w) => w.lines.map((l) => l.text);
const lineMatching = (w, re) => w.lines.find((l) => re.test(l.text));

test('people gaining access: those on the new parent who do not already reach the matter', () => {
  const i = impact('teman', 'ukc');
  assert.deepEqual(i.gain.userIds.sort(), ['bob', 'cat']);
  assert.deepEqual(i.gain.via, ['ukc']);
  assert.equal(i.gain.certain, true);
  assert.deepEqual(i.lose.userIds, [], 'ann is on Teman itself and keeps it');
  assert.equal(i.descendantCount, 2);
  assert.equal(i.accessChanged, true);
  const w = moveWords(i, nameOf, labelOf, 'Legal');
  assert.equal(w.title, 'Move Teman?');
  assert.equal(w.framing, 'Moving is for fixing a misfiled matter.');
  assert.equal(w.from, 'Legal');
  assert.equal(w.to, 'Legal › UKC');
  assert.equal(w.action, 'Move into UKC');
  assert.equal(w.blocked, false);
  assert.deepEqual(texts(w), [
    'Its 2 sub-matters go with it.',
    'Teman will become part of UKC, a different matter.',
    '2 people on UKC will be able to see Teman and its 2 sub-matters: bob@x.com and Cat Ng.',
  ]);
  assert.equal(w.lines[1].tone, 'warn', 'the different-matter line is amber');
});

test('serverspace members, people on the matter itself and the mover are never counted', () => {
  const i = impact('teman', 'ukc', { membersOf: allMembers({ ukc: ['bob', 'sam', 'ann', 'me'] }) });
  assert.deepEqual(i.gain.userIds, ['bob']);
});

test('people losing access: those on the old parent who do not reach it on the new path', () => {
  // Amazon sits under Teman (ann). Moving it to the top of Legal: ann loses it.
  const i = impact('amazon', null);
  assert.deepEqual(i.lose.userIds, ['ann']);
  assert.deepEqual(i.lose.via, ['teman']);
  assert.deepEqual(i.gain.userIds, []);
  const w = moveWords(i, nameOf, labelOf, 'Legal');
  assert.equal(w.title, 'Move Amazon?');
  assert.equal(w.from, 'Legal › Teman');
  assert.equal(w.to, 'Legal');
  assert.equal(w.action, 'Move to the top of Legal');
  assert.deepEqual(texts(w), [
    'Amazon will leave Teman and become a matter of its own at the top of Legal.',
    '1 person on Teman will no longer see Amazon: Ann Lee.',
  ]);
});

test('someone on both the old and the new path keeps it: no access change, still a card', () => {
  // Amazon (under Teman, ann) into Bushell (ann): ann loses Teman's path but gains Bushell's.
  const i = impact('amazon', 'bushell');
  assert.deepEqual(i.gain.userIds, []);
  assert.deepEqual(i.lose.userIds, []);
  assert.equal(i.accessChanged, false);
  const w = moveWords(i, nameOf, labelOf, 'Legal');
  assert.deepEqual(texts(w), ['Amazon will leave Teman and become part of Bushell, a different matter.']);
});

test('a sharing list that could not be read is named, never counted as nobody', () => {
  // The read failed for UKC: say "anyone shared on UKC".
  const i = impact('lone', 'ukc', { membersOf: allMembers({ ukc: null }) });
  assert.deepEqual(i.gain.userIds, []);
  assert.deepEqual(i.gain.unreadable, ['ukc']);
  assert.equal(i.accessChanged, true);
  const w = moveWords(i, nameOf, labelOf, 'Legal');
  assert.ok(lineMatching(w, /^Anyone shared on UKC will be able to see Lone\. That sharing list is not visible to you/));
  assert.doesNotMatch(texts(w).join(' '), /\b0 people\b/);
});

test('a parent this account cannot open is unknown, and so is everything above it', () => {
  const partial = [
    { id: 'kid', name: 'Kid', parent_matterspace_id: 'hidden', ai_tier: 'A' },
    { id: 'lone', name: 'Lone', parent_matterspace_id: null, ai_tier: 'A' },
  ];
  const i = impact('kid', 'lone', {
    matters: partial,
    membersOf: new Map([['kid', []], ['lone', []]]),
  });
  assert.deepEqual(i.lose.unreadable, ['hidden']);
  assert.equal(i.accessChanged, true);
  assert.deepEqual(i.fromPath, { ids: [], hidden: true });
  const w = moveWords(i, (id) => partial.find((m) => m.id === id)?.name ?? 'a matter above it that you cannot open', labelOf, 'Legal');
  assert.equal(w.from, 'Legal › …');
  assert.equal(w.to, 'Legal › Lone');
  assert.ok(lineMatching(w, /^Anyone shared on a matter above it that you cannot open will no longer see Kid\./));
});

test('a list that would rule someone out was not read: the count says "up to"', () => {
  const i = impact('teman', 'ukc', { serverspaceMembers: null });
  assert.equal(i.gain.certain, false);
  const w = moveWords(i, nameOf, labelOf, 'Legal');
  assert.ok(lineMatching(w, /^Up to 2 people on UKC will be able to see Teman/));
});

test('the mover would lose the matter themselves: the move is not offered', () => {
  // "me" is not on the serverspace; reaches Amazon only through Teman.
  const i = impact('amazon', null, {
    serverspaceMembers: ['sam'],
    membersOf: allMembers({ teman: ['ann', 'me'] }),
  });
  assert.equal(i.selfLoses, true);
  const w = moveWords(i, nameOf, labelOf, 'Legal');
  assert.equal(w.blocked, true);
  assert.equal(w.from, 'Legal › Teman', 'the route is still shown');
  assert.equal(w.lines[0].tone, 'warn');
  assert.match(w.lines[0].text, /You would lose access to Amazon yourself/);
});

// ── agents ───────────────────────────────────────────────────────────

test('agents gaining and losing: grants on the new vs the old ancestry', () => {
  // Teman into UKC: the UKC bot now sees Teman; Grok, granted Teman itself, keeps it.
  const i = impact('teman', 'ukc', { agents: [GROK, UKC_BOT, EVERYTHING] });
  assert.deepEqual(i.agentsGain.map((a) => a.label), ['UKC bot']);
  assert.deepEqual(i.agentsLose, []);
  const w = moveWords(i, nameOf, labelOf, 'Legal');
  assert.ok(texts(w).includes('1 agent (UKC bot) will be able to see it.'));

  // Amazon out of Teman: Grok (granted Teman) loses it.
  const j = impact('amazon', null, { agents: [GROK, EVERYTHING] });
  assert.deepEqual(j.agentsLose.map((a) => a.label), ['Grok']);
  assert.deepEqual(j.agentsGain, []);
  assert.ok(texts(moveWords(j, nameOf, labelOf, 'Legal')).includes('1 agent (Grok) will no longer see it.'));
});

test('an "All my matters" agent is unaffected by a move between open matters', () => {
  const i = impact('lone', 'other', { agents: [EVERYTHING] });
  assert.deepEqual(i.agentsGain, []);
  assert.deepEqual(i.agentsLose, []);
  assert.equal(i.accessChanged, false);
});

test('agents that could not be read: say so', () => {
  const i = impact('lone', 'other', { agents: null });
  assert.equal(i.accessChanged, true);
  const w = moveWords(i, nameOf, labelOf, 'Legal');
  assert.ok(lineMatching(w, /Your agents could not be checked/));
});

// ── the seal ─────────────────────────────────────────────────────────

test('into a SecureSpace: sealed, and every agent that saw it loses it', () => {
  const i = impact('teman', 'vault', { agents: [GROK, EVERYTHING] });
  assert.equal(i.sealedBefore, false);
  assert.equal(i.sealedAfter, true);
  assert.equal(i.sealAfterId, 'vault');
  assert.deepEqual(i.agentsLose.map((a) => a.label).sort(), ['Everything bot', 'Grok']);
  const w = moveWords(i, nameOf, labelOf, 'Legal');
  const t = texts(w);
  const seal = t.indexOf('It will be sealed inside the SecureSpace Vault: no outside AI will be able to see it.');
  const person = t.findIndex((x) => /1 person on Vault will be able to see Teman and its 2 sub-matters: Dee\./.test(x));
  const agent = t.findIndex((x) => /^2 agents/.test(x));
  assert.ok(seal >= 0 && person > seal && agent > seal, 'the seal line comes before people and agents');
  assert.equal(w.lines[seal].tone, 'seal');
});

test('out of a SecureSpace: unsealed, a warning, and agents granted the new parent see it', () => {
  const i = impact('sealedkid', 'ukc', { agents: [UKC_BOT, EVERYTHING] });
  assert.equal(i.sealedBefore, true);
  assert.equal(i.sealedAfter, false);
  assert.equal(i.sealBeforeId, 'vault');
  assert.deepEqual(i.agentsGain.map((a) => a.label).sort(), ['Everything bot', 'UKC bot']);
  const w = moveWords(i, nameOf, labelOf, 'Legal');
  const line = lineMatching(w, /^It will leave its SecureSpace/);
  assert.equal(line.tone, 'warn');
  assert.equal(line.text, 'It will leave its SecureSpace (Vault): outside AI will be able to see Sealed-Child.');
});

test('a matter sealed in its own right stays sealed wherever it goes', () => {
  const i = impact('vault', 'lone', { agents: [EVERYTHING] });
  assert.equal(i.sealedBefore, true);
  assert.equal(i.sealedAfter, true);
  assert.deepEqual(i.agentsGain, []);
  assert.equal(i.accessChanged, false);
});

// ── a different matter (client) ──────────────────────────────────────

test('different-matter detection, both directions and the top-level edges', () => {
  // A top-level matter into another top-level matter.
  assert.deepEqual(impact('teman', 'ukc').crossMatter, { kind: 'join', fromTopId: null, toTopId: 'ukc' });
  // A sub-matter of one client into another client's matter (and back).
  assert.deepEqual(impact('amazon', 'ukc').crossMatter, { kind: 'join', fromTopId: 'teman', toTopId: 'ukc' });
  assert.deepEqual(impact('ukcx', 'priv').crossMatter, { kind: 'join', fromTopId: 'ukc', toTopId: 'teman' });
  // A sub-matter out to the top level.
  assert.deepEqual(impact('ukcx', null).crossMatter, { kind: 'leave', fromTopId: 'ukc' });
  // Inside one top-level matter: not a different matter.
  assert.deepEqual(impact('amazon', 'priv').crossMatter, { kind: 'none' });
  // Deeper: Privilege's own child back up to Teman.
  const deeper = M.concat([{ id: 'pkid', name: 'P-Kid', parent_matterspace_id: 'priv', ai_tier: 'A' }]);
  assert.deepEqual(
    impact('pkid', 'teman', { matters: deeper, membersOf: allMembers({ pkid: [] }) }).crossMatter,
    { kind: 'none' },
  );
  // A top-level matter staying top-level is not a different matter.
  assert.deepEqual(impact('lone', null).crossMatter, { kind: 'none' });

  const words = (id, to) => texts(moveWords(impact(id, to), nameOf, labelOf, 'Legal'));
  assert.ok(words('ukcx', 'priv').includes('UKC-Exhibits will leave UKC and become part of Teman, a different matter.'));
  assert.ok(words('ukcx', null).includes('UKC-Exhibits will leave UKC and become a matter of its own at the top of Legal.'));
  assert.ok(!words('amazon', 'priv').some((x) => /different matter|matter of its own/.test(x)));
});

test('the route is the full breadcrumb, top first', () => {
  const deeper = M.concat([{ id: 'pkid', name: 'P-Kid', parent_matterspace_id: 'priv', ai_tier: 'A' }]);
  const i = impact('pkid', 'ukcx', { matters: deeper, membersOf: allMembers({ pkid: [] }) });
  const w = moveWords(i, (id) => deeper.find((m) => m.id === id)?.name ?? '?', labelOf, 'Legal');
  assert.equal(w.from, 'Legal › Teman › Privilege');
  assert.equal(w.to, 'Legal › UKC › UKC-Exhibits');
  assert.equal(w.action, 'Move into UKC-Exhibits');
});

// ── nothing changes ──────────────────────────────────────────────────

test('nothing about access changes: still a card, with the route and no access lines', () => {
  const i = impact('amazon', 'priv', { agents: [GROK, UKC_BOT, EVERYTHING] });
  assert.equal(i.accessChanged, false);
  assert.deepEqual(i.gain, { userIds: [], via: [], unreadable: [], certain: true });
  assert.deepEqual(i.lose, { userIds: [], via: [], unreadable: [], certain: true });
  const w = moveWords(i, nameOf, labelOf, 'Legal');
  assert.equal(w.title, 'Move Amazon?');
  assert.equal(w.from, 'Legal › Teman');
  assert.equal(w.to, 'Legal › Teman › Privilege');
  assert.equal(w.blocked, false);
  assert.deepEqual(w.lines, []);
});

test('the Undo toast text', () => {
  assert.equal(movedText('Teman', 'UKC', false), 'Moved Teman into UKC');
  assert.equal(movedText('Amazon', 'Legal', true), 'Moved Amazon to the top of Legal');
});

// ── the sidebar wiring (source assertions) ───────────────────────────

test('the sidebar asks before EVERY move, and offers Undo after every move', () => {
  const s = src('src/components/layout/Sidebar.tsx');
  assert.match(s, /activationConstraint: \{ delay: 250, tolerance: 5 \}/, 'press and hold to drag');
  assert.doesNotMatch(s, /activationConstraint: \{ distance: 5 \}/);
  assert.match(s, /computeMoveImpact\(/);
  assert.doesNotMatch(s, /impact\.changed|impact\.accessChanged/, 'no path skips the card');
  assert.match(s, /setPendingMove\(\{ move, words \}\)/);
  assert.match(s, /<MoveMatterConfirm/);
  assert.match(s, /<MovedToast/);
  assert.match(s, /applyMove\(movedToast, movedToast\.oldParentId\)/, 'Undo restores the previous parent');
  // The only forward write is the card's confirm.
  const writes = s.match(/applyMove\([^)]*newParentId\)/g) ?? [];
  assert.deepEqual(writes, ['applyMove(pendingMove.move, pendingMove.move.newParentId)']);
});

test('the dialog: framing, from and to, Cancel has the focus, Enter does not move, the toast is portalled', () => {
  const s = src('src/components/matter/MoveMatterConfirm.tsx');
  assert.match(s, /\{words\.framing\}/);
  assert.match(s, /\{words\.from\}/);
  assert.match(s, /\{words\.to\}/);
  assert.match(s, /cancelRef\.current\?\.focus\(\)/);
  assert.match(s, /if \(e\.key === 'Enter'\) e\.preventDefault\(\)/);
  assert.match(s, /<CardDialog/);
  assert.match(s, /<ModalPortal>/);
  assert.match(s, /MOVED_TOAST_MS = 10_000/);
});

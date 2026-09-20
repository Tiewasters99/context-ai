// The Assistant panel on a sealed matter: what it SAYS, and what it remembers.
//
// Run:  node --test scripts/_test-sealed-assistant-scope.mjs
// (Node 22.18+ strips the types out of the .ts imports on its own. The two
// modules under test import nothing at runtime — assistant-scope's only import
// is `import type`, which stripping erases — so no '@/' loader is needed.)
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. Every sentence the panel renders is
// decided by pure functions, and those are exercised here directly: the strip's
// wording, the model named before the first message, the correction when the
// server disagrees, the pause, the starters, the door's command payload, and
// the pin's persistence. What a Node harness cannot do in this repo is MOUNT
// the React tree — there is no jsdom and no renderer in devDependencies — so
// the wiring (that Assistant.tsx renders the strip whenever it is scoped, that
// the input is gated on the pause, that the door dispatches the command) is
// asserted against the source text at the bottom of this file. Those
// assertions are deliberately narrow: they name the one expression that would
// have to change for the behaviour to regress.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeScope,
  penLabel,
  isSealedTier,
  sealedPenSentence,
  openPenSentence,
  unscopedStripText,
  SEALED_SEARCH_NOTE,
  SEALED_STARTERS,
  SEALED_PEN_DEFAULT_LABEL,
  askAssistantCommand,
  askAssistantLabel,
} from '../src/components/ai/assistant-scope.ts';

import {
  readPanelState,
  writePanelState,
  PANEL_STATE_KEY,
} from '../src/components/ai/assistant-panel-state.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
// Comments quote the bug they replaced, so a check for the bug itself has to
// look at the code. Crude but sufficient for these files: no regex literals
// with `//` in them, and no URLs outside comments.
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

// The model ids the server actually emits — PENS, lib/assistant-core.mjs.
const SEALED_MODEL = 'moonshotai.kimi-k2.5';
const TIER_A_MODEL = 'claude-opus-4-8';

// ── 1. The pen's name ─────────────────────────────────────────────────────

test('the sealed pen is Kimi K2.5, never Kimi K3', () => {
  assert.equal(penLabel(SEALED_MODEL), 'Kimi K2.5');
  // The bug this replaces: `model.includes('kimi') → 'Kimi K3'` labelled every
  // sealed answer with a model that PR #159 deleted.
  assert.notEqual(penLabel(SEALED_MODEL), 'Kimi K3');
});

test('an id the map does not know is shown verbatim, never guessed at', () => {
  for (const id of ['moonshotai.kimi-k9', 'kimi-something', 'meta.llama-4', '']) {
    assert.equal(penLabel(id), id.trim());
  }
  // In particular: no version is inferred from a substring.
  assert.equal(penLabel('moonshotai.kimi-k2.7'), 'moonshotai.kimi-k2.7');
});

test('the Tier-A ids map to the names the product already uses', () => {
  assert.equal(penLabel(TIER_A_MODEL), 'Opus 4.8');
  assert.equal(penLabel('anthropic.claude-opus-5'), 'Opus 5');
});

test('the strip and the header agree with penLabel about the sealed pen', () => {
  const d = describeScope({ name: 'Teman', tier: 'B' });
  assert.equal(d.penChip, SEALED_PEN_DEFAULT_LABEL);
  assert.equal(SEALED_PEN_DEFAULT_LABEL, penLabel(SEALED_MODEL));
  assert.ok(d.penNote.includes('Kimi K2.5'));
  assert.ok(!d.penNote.includes('K3'));
  // Never "Claude": AWS gates that generation for this account (audit
  // 2026-09-19, external blockers).
  assert.ok(!/claude/i.test(d.penNote));
});

// ── 2. The scope strip, before a single message ───────────────────────────

test('a route-bound sealed matter gets the whole strip before any message', () => {
  const d = describeScope({ name: 'Protegera', tier: 'B' });
  assert.equal(d.sealed, true);
  assert.equal(d.unknown, false);
  assert.equal(`${d.lead}${d.name}${d.tail}`,
    'Sealed room — Protegera · no training · zero data retention');
  assert.equal(d.penNote, sealedPenSentence());
  assert.equal(d.searchNote, SEALED_SEARCH_NOTE);
  assert.equal(d.starters.length, 3);
  // Nothing here needed a reply to arrive.
  assert.equal(d.corrected, false);
});

test('the sealed sentence says the three things that may be claimed', () => {
  const s = sealedPenSentence();
  assert.ok(s.includes('the firm’s own AWS account') || s.includes("the firm's own AWS account"));
  assert.ok(s.includes('Zero data retention'));
  assert.ok(s.includes('Nothing reaches an outside provider'));
});

test('the word-search note is the one tip, and it is true of a sealed matter', () => {
  assert.equal(
    SEALED_SEARCH_NOTE,
    'Inside a sealed matter the assistant finds passages by their words, not by meaning — use the document’s own terms.',
  );
  // Only sealed scopes get it.
  assert.equal(describeScope({ name: 'Open matter', tier: 'A' }).searchNote, '');
});

test('an unsealed matter is unchanged: name, the Tier-A pen, no seal', () => {
  const d = describeScope({ name: 'Anlauf', tier: 'A' });
  assert.equal(d.sealed, false);
  assert.equal(`${d.lead}${d.name}${d.tail}`, 'In Anlauf');
  assert.equal(d.penNote, openPenSentence());
  assert.equal(d.penChip, 'Opus 4.8');
  assert.deepEqual(d.starters, []);
  assert.equal(d.searchNote, '');
});

test('an unknown tier claims NOTHING — the name and silence', () => {
  for (const tier of [null, undefined]) {
    const d = describeScope({ name: 'Unread', tier });
    assert.equal(d.unknown, true);
    assert.equal(d.sealed, false, 'must not claim sealed');
    assert.equal(d.penNote, '', 'must not claim a model');
    assert.equal(d.penChip, '', 'must not name a model in the header');
    assert.equal(`${d.lead}${d.name}${d.tail}`, 'In Unread');
  }
});

test('Tier C says it refuses, rather than naming a pen that will not answer', () => {
  const d = describeScope({ name: 'Silo matter', tier: 'C' });
  assert.equal(d.sealed, true);
  assert.equal(d.penChip, '');
  assert.match(d.penNote, /Tier C — Silo/);
  assert.match(d.penNote, /refused/);
});

test('a matter with no name still reads as a sentence', () => {
  assert.equal(describeScope({ tier: 'B' }).name, 'this matter');
  assert.equal(describeScope({ name: '   ', tier: 'A' }).name, 'this matter');
});

// ── 3. The pause ──────────────────────────────────────────────────────────

const PAUSE_SENTENCE =
  'AI is paused on this matter by Eden Quainton since 2026-09-20. Nothing is being sent to any model.';

test('a paused matter shows the pause sentence, verbatim from the server’s wording', () => {
  const d = describeScope({ name: 'Teman', tier: 'B', paused: true, pausedSentence: PAUSE_SENTENCE });
  assert.equal(d.paused, true);
  assert.equal(d.pauseNote, PAUSE_SENTENCE);
});

test('a pause with no sentence still says something true', () => {
  const d = describeScope({ name: 'Teman', tier: 'A', paused: true });
  assert.equal(d.paused, true);
  assert.match(d.pauseNote, /paused/i);
  assert.match(d.pauseNote, /Nothing is being sent/);
});

test('not paused is not a pause note', () => {
  assert.equal(describeScope({ name: 'Teman', tier: 'B' }).pauseNote, '');
});

// ── 4. The server is the authority ────────────────────────────────────────

test('the strip corrects itself when the server names another pen', () => {
  // Predicted sealed/Kimi; the server answered from Tier A with Opus.
  const d = describeScope({
    name: 'Protegera',
    tier: 'B',
    livePen: { tier: 'A', provider: 'anthropic', model: TIER_A_MODEL },
  });
  assert.equal(d.corrected, true);
  assert.equal(d.sealed, false, 'the server’s answer wins outright');
  assert.equal(d.penNote, openPenSentence('Opus 4.8'));
  assert.equal(d.penChip, 'Opus 4.8');
});

test('the strip corrects itself the other way too — unsealed page, sealed answer', () => {
  const d = describeScope({
    name: 'Kaya',
    tier: 'A',
    livePen: { tier: 'B', provider: 'aws-bedrock', model: SEALED_MODEL },
  });
  assert.equal(d.corrected, true);
  assert.equal(d.sealed, true);
  assert.equal(d.penNote, sealedPenSentence('Kimi K2.5'));
});

test('a server answer that MATCHES the prediction is not a correction', () => {
  const d = describeScope({
    name: 'Protegera',
    tier: 'B',
    livePen: { tier: 'B', provider: 'aws-bedrock', model: SEALED_MODEL },
  });
  assert.equal(d.corrected, false);
  assert.equal(d.sealed, true);
  assert.equal(d.penNote, sealedPenSentence('Kimi K2.5'));
});

test('a reply on a matter whose tier was UNREADABLE is news, not a correction', () => {
  // The strip had said only the matter's name, so there is nothing to correct
  // — but the pen is now known and worth showing.
  const d = describeScope({
    name: 'Unread',
    tier: null,
    livePen: { tier: 'B', provider: 'aws-bedrock', model: SEALED_MODEL },
  });
  assert.equal(d.corrected, false, 'nothing was claimed, so nothing was wrong');
  assert.equal(d.named, true);
  assert.equal(d.sealed, true);
  assert.equal(d.penNote, sealedPenSentence('Kimi K2.5'));
});

test('where a prediction WAS made, the reply is a correction and not merely news', () => {
  const d = describeScope({
    name: 'Protegera',
    tier: 'B',
    livePen: { tier: 'A', provider: 'anthropic', model: TIER_A_MODEL },
  });
  assert.equal(d.named, false);
  assert.equal(d.corrected, true);
});

test('a different sealed model on Bedrock is named, and is a correction', () => {
  // BEDROCK_MODEL can select another pen; the strip must not keep saying K2.5.
  const d = describeScope({
    name: 'Protegera',
    tier: 'B',
    livePen: { tier: 'B', provider: 'aws-bedrock', model: 'anthropic.claude-opus-5' },
  });
  assert.equal(d.penChip, 'Opus 5');
  assert.equal(d.penNote, sealedPenSentence('Opus 5'));
  assert.equal(d.corrected, true);
});

test('a sealed tier served from somewhere that is NOT Bedrock gets no seal claim', () => {
  const d = describeScope({
    name: 'Protegera',
    tier: 'B',
    livePen: { tier: 'B', provider: 'fireworks', model: 'kimi-k3' },
  });
  assert.equal(d.sealed, true, 'the tier is still sealed');
  assert.ok(!/AWS account/.test(d.penNote), 'must not lend the AWS claim to another host');
  assert.ok(!/Zero data retention/.test(d.penNote));
  assert.match(d.penNote, /Answered by kimi-k3 \(fireworks\)/);
});

test('the tier hint alone, with no read yet, still opens the sealed strip', () => {
  // SecureChat's door passes `sealed: true`; the panel seeds tier B with it and
  // the RLS read settles it a round trip later.
  const d = describeScope({ name: 'SecureChat', tier: 'B' });
  assert.equal(d.sealed, true);
  assert.equal(d.penNote, sealedPenSentence());
});

// ── 5. Starters written for word search ───────────────────────────────────

test('three starters, and each one works against a word index', () => {
  assert.equal(SEALED_STARTERS.length, 3);
  const labels = SEALED_STARTERS.map((s) => s.label);
  assert.ok(labels.some((l) => /List the documents in this matter/.test(l)));
  assert.ok(labels.some((l) => /appears and quote the passages with page numbers/.test(l)));
  assert.ok(labels.some((l) => /Summarize the most recent order in this matter, with page cites/.test(l)));
  // No claim about the model's talents anywhere in them.
  for (const s of SEALED_STARTERS) {
    assert.ok(!/\b(best|great|excellent|powerful|smart)\b/i.test(s.text), s.text);
  }
});

test('the fill-in starter selects exactly the placeholder, nothing else', () => {
  const s = SEALED_STARTERS.find((x) => x.select);
  assert.ok(s, 'one starter leaves the term for the user to type');
  const [from, to] = s.select;
  assert.equal(s.text.slice(from, to), 'term');
  assert.ok(s.text.startsWith('Find where the word'));
  assert.ok(s.text.endsWith('appears and quote the passages with page numbers.'));
  // The label advertises the blank rather than a literal word.
  assert.ok(s.label.includes('…'));
  assert.ok(!s.label.includes('term'));
});

test('the other two starters send as they read', () => {
  for (const s of SEALED_STARTERS.filter((x) => !x.select)) {
    assert.equal(s.label, s.text);
  }
});

// ── 6. The door on the matter page ────────────────────────────────────────

test('the door is labelled for what it is', () => {
  assert.equal(askAssistantLabel(true), 'Ask the sealed assistant');
  assert.equal(askAssistantLabel(false), 'Ask the assistant');
});

test('B and C are both sealed to the user; A is not', () => {
  assert.equal(isSealedTier('B'), true);
  assert.equal(isSealedTier('C'), true);
  assert.equal(isSealedTier('A'), false);
  assert.equal(isSealedTier(null), false);
  assert.equal(isSealedTier(undefined), false);
});

test('the door dispatches the matter AND the sealed flag, end to end', async () => {
  // runInAssistant is a DOM CustomEvent; Node 22 has EventTarget and
  // CustomEvent, so the real bus can be driven here.
  globalThis.window = new EventTarget();
  const { runInAssistant, ASSISTANT_COMMAND_EVENT } =
    await import('../src/lib/assistant-bus.ts');

  const seen = [];
  globalThis.window.addEventListener(ASSISTANT_COMMAND_EVENT, (e) => seen.push(e.detail));

  runInAssistant(askAssistantCommand({ id: 'm-1', name: 'Protegera', sealed: true }));
  runInAssistant(askAssistantCommand({ id: 'm-2', name: 'Anlauf', sealed: false }));

  assert.deepEqual(seen, [
    { matterId: 'm-1', matterName: 'Protegera', sealed: true },
    { matterId: 'm-2', matterName: 'Anlauf', sealed: false },
  ]);
  // No prompt: the door scopes and opens the panel without spending a call.
  assert.ok(!('prompt' in seen[0]));
});

// ── 7. "Ask without a matter" ─────────────────────────────────────────────

test('clearing a page-bound scope says plainly what it did', () => {
  assert.equal(unscopedStripText('Protegera'), 'Asking without a matter — not scoped to Protegera.');
  assert.equal(unscopedStripText(undefined), 'Asking without a matter.');
});

// ── 8. The pin, and the rect it must never lose ───────────────────────────

function fakeStore(seed) {
  const map = new Map(Object.entries(seed ?? {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

const RECT = { left: 240, top: 120, width: 520, height: 600 };

test('pin, reload, still pinned at the same rect', () => {
  const store = fakeStore();
  writePanelState(store, { box: RECT, pinned: true });
  const reloaded = readPanelState(store);        // a fresh page is just a fresh read
  assert.equal(reloaded.pinned, true);
  assert.deepEqual(reloaded.box, RECT);
});

test('unpinning keeps the rect — the lock comes off, the panel does not move', () => {
  const store = fakeStore();
  writePanelState(store, { box: RECT, pinned: true });
  writePanelState(store, { box: readPanelState(store).box, pinned: false });
  const after = readPanelState(store);
  assert.equal(after.pinned, false);
  assert.deepEqual(after.box, RECT, 'the position survived the unpin');
});

test('moving a pinned-then-unpinned panel keeps the pin flag it was left with', () => {
  const store = fakeStore();
  writePanelState(store, { box: RECT, pinned: true });
  const moved = { ...RECT, left: 40, top: 40 };
  writePanelState(store, { box: moved, pinned: true });
  assert.deepEqual(readPanelState(store), { box: moved, pinned: true });
});

test('the LEGACY record — a bare box — still restores the position', () => {
  // Every browser that has opened this panel before today has one of these.
  const store = fakeStore({ [PANEL_STATE_KEY]: JSON.stringify(RECT) });
  const state = readPanelState(store);
  assert.deepEqual(state.box, RECT);
  assert.equal(state.pinned, false);
});

test('docked and unpinned stores nothing at all', () => {
  const store = fakeStore({ [PANEL_STATE_KEY]: JSON.stringify({ box: RECT, pinned: true }) });
  writePanelState(store, { box: null, pinned: false });
  assert.equal(store.getItem(PANEL_STATE_KEY), null);
  assert.deepEqual(readPanelState(store), { box: null, pinned: false });
});

test('a blocked or absent store is docked and unpinned, never a crash', () => {
  const hostile = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  assert.deepEqual(readPanelState(hostile), { box: null, pinned: false });
  writePanelState(hostile, { box: RECT, pinned: true }); // must not throw
  assert.deepEqual(readPanelState(null), { box: null, pinned: false });
  assert.deepEqual(readPanelState(fakeStore({ [PANEL_STATE_KEY]: 'not json' })),
    { box: null, pinned: false });
});

// ── 9. The wiring, asserted against the source ────────────────────────────
//
// Narrow on purpose: each assertion names the single expression that would
// have to change for the behaviour above to stop reaching the screen.

test('Assistant.tsx renders the strip whenever it is SCOPED, not only on a command', () => {
  const src = read('src/components/ai/Assistant.tsx');
  assert.match(src, /const scoped = Boolean\(bound\.id\) && !unscoped;/);
  assert.match(src, /\{scoped && \(/, 'the strip is gated on `scoped`');
  assert.match(src, /const describe = describeScope\(facts\);/);
  // The old gate — a command-only `scope` state — is gone.
  assert.ok(!/\{scope && \(/.test(src), 'the command-only strip gate must be gone');
});

test('Assistant.tsx binds the wire and the strip through ONE resolver', () => {
  const src = read('src/components/ai/Assistant.tsx');
  const calls = src.match(/resolveBound\(\)/g) ?? [];
  assert.ok(calls.length >= 3, `expected render + send + sub-matter, saw ${calls.length}`);
  assert.match(src, /const here = resolveBound\(\);/, 'send() resolves through it too');
  assert.ok(
    !/commandMatterRef\.current\?\.id \?\? routeMatterId/.test(src),
    'the second, divergent copy of the binding rule must be gone',
  );
});

test('Assistant.tsx reads the tier under RLS rather than assuming Tier A', () => {
  const src = read('src/components/ai/Assistant.tsx');
  assert.match(src, /useMatterAiState\(bound\.id/);
  assert.ok(!/livePen \? penLabel\(livePen\.model\) : 'Opus 4\.8'/.test(src),
    'the hardcoded pre-reply pen label must be gone');
  const hook = read('src/components/ai/useMatterAiState.ts');
  assert.match(hook, /effectiveTier/, 'the effective (inherited) tier, not the row’s own');
  assert.match(hook, /readAiPause/);
  assert.ok(!/service_role|SERVICE_ROLE/.test(hook), 'no service-role path');
});

test('Assistant.tsx shows the pause sentence INSTEAD of an input', () => {
  const src = read('src/components/ai/Assistant.tsx');
  assert.match(src, /\{describe\.paused \? \(/);
  assert.match(src, /\{describe\.pauseNote\}/);
});

test('Assistant.tsx wires the pin to PinToggle, and a pinned card does not move', () => {
  const src = read('src/components/ai/Assistant.tsx');
  assert.match(src, /<PinToggle pinned=\{pinned\} onToggle=\{togglePin\} \/>/);
  assert.match(src, /if \(isMobile \|\| pinned \|\|/, 'drag is refused while pinned');
  assert.match(src, /resize: pinned \? 'none' : 'both'/);
  assert.match(src, /if \(pinned\) return;/, 'double-click-to-dock is refused while pinned');
  assert.match(src, /\{!isMobile && <PinToggle/, 'no pin on a phone');
  // The panel keeps its own z-50: it must stay above the route card (z-12).
  assert.ok(src.includes('fixed z-50 flex flex-col'), 'floating panel stays at z-50');
});

test('the door is on the matter header and dispatches the scoped command', () => {
  const btn = read('src/components/ai/AskAssistantButton.tsx');
  assert.match(btn, /runInAssistant\(askAssistantCommand\(\{ id: matterId, name: matterName, sealed \}\)\)/);
  assert.match(btn, /askAssistantLabel\(sealed\)/);
  assert.match(btn, /readAiPause\(matterId\)/, 'a paused matter is re-checked at click time');
  const view = read('src/pages/MatterspaceView.tsx');
  assert.match(view, /<AskAssistantButton matterId=\{matter\.id\} matterName=\{matter\.name\} \/>/);
});

test('no substring model-name guessing is left in the assistant lane', () => {
  for (const f of [
    'src/components/ai/Assistant.tsx',
    'src/components/ai/assistant-scope.ts',
    'src/components/ai/AskAssistantButton.tsx',
  ]) {
    const src = code(f);
    assert.ok(!/includes\('kimi'\)/.test(src), `${f} still guesses a Kimi version`);
    assert.ok(!/'Kimi K3'/.test(src), `${f} still names the deleted Fireworks pen`);
  }
});

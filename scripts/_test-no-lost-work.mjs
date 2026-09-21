// A lawyer must not lose typed work to a refresh, a closed tab, or a
// navigation.
//
//   node --import ./scripts/_node-src-loader.mjs --test scripts/_test-no-lost-work.mjs
//   (jsdom is installed --no-save, as it is for _test-card-pin.mjs: a harness
//   dependency, never a repo one.)
//
// Three parts, in the order the work travels:
//
//   A  the saver and the store, driven with injected timers and a fake
//      storage — no DOM, no network, no React. Every decision this change
//      makes is made here, which is why it is testable at all.
//   B  the real useAutosave hook and the real guard, in a real DOM: the
//      mirror lands under the right key, pagehide flushes, a second user's
//      draft is invisible to the first, and `beforeunload` is attached only
//      while something is actually unsaved.
//   C  narrow assertions against the surfaces themselves, so a later edit
//      that quietly takes the wiring back out turns this red.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// A DOM, installed as globals BEFORE react-dom is imported (it reads them at
// module init, so the order is not negotiable). Part A does not need it; the
// module under test reads `localStorage` through a passed-in store.
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://contextspaces.test/app/page/abc',
  pretendToBeVisual: true,
});
const { window } = dom;

const force = (key, value) => {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
};

for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue;
  const descriptor = Object.getOwnPropertyDescriptor(window, key);
  if (!descriptor) continue;
  try {
    Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
  } catch {
    /* a handful of window properties refuse to be copied; none are used here */
  }
}
for (const key of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage',
                   'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent',
                   'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver']) {
  if (window[key] === undefined) continue;
  force(
    key,
    /^(requestAnimationFrame|cancelAnimationFrame)$/.test(key) ? window[key].bind(window) : window[key],
  );
}

const {
  AUTOSAVE_DELAY_MS,
  CHAT_PREFIX,
  DRAFT_PREFIX,
  MAX_DRAFT_CHARS,
  NO_MATTER_SCOPE,
  chatKey,
  clearAllDrafts,
  clearConversation,
  clearDraft,
  createAutosaver,
  draftKey,
  flushAllUnsaved,
  isWorkUnsaved,
  notifyUnsaved,
  readConversation,
  readDraft,
  registerUnsavedSource,
  resetUnsavedRegistry,
  restoreOfferLine,
  saveStatusLine,
  writeConversation,
  writeDraft,
} = await import('../src/lib/draft-store.ts');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A KeyStore that lives in a Map and can be told to refuse. */
function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    refuse: false,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      if (this.refuse) throw new Error('QuotaExceededError');
      map.set(k, v);
    },
    removeItem: (k) => { map.delete(k); },
    all: () => Object.fromEntries(map),
  };
}

/** Timers under our thumb — the debounce and the backoff are both time. */
function fakeClock() {
  let now = 0;
  let seq = 1;
  const timers = new Map();
  return {
    now: () => now,
    schedule(fn, ms) {
      const id = seq++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

const settle = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };

/** A save that records what it was given and can be told to fail. */
function recordingSave() {
  const calls = [];
  let fail = 0;
  let inFlight = 0;
  let maxConcurrent = 0;
  const fn = async (value) => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    calls.push(value);
    await Promise.resolve();
    inFlight -= 1;
    if (fail > 0) {
      fail -= 1;
      throw new Error('the network is not there');
    }
  };
  return {
    fn,
    calls,
    get count() { return calls.length; },
    get last() { return calls[calls.length - 1]; },
    get maxConcurrent() { return maxConcurrent; },
    failNext(n) { fail = n; },
  };
}

function makeSaver(overrides = {}) {
  const clock = fakeClock();
  const save = recordingSave();
  const mirrored = [];
  let cleared = 0;
  const saver = createAutosaver({
    save: save.fn,
    mirror: (value) => mirrored.push(value),
    clearMirror: () => { cleared += 1; },
    delayMs: 1_000,
    // Exactly what useAutosave does with onState: tell the registry, so the
    // guard hears about it. Asserted against the hook's source in part C.
    onState: () => notifyUnsaved(),
    now: clock.now,
    schedule: clock.schedule.bind(clock),
    cancel: clock.cancel.bind(clock),
    ...overrides,
  });
  return { saver, clock, save, mirrored, clearedCount: () => cleared };
}

// ---------------------------------------------------------------------------
// A. The saver
// ---------------------------------------------------------------------------

test('typing does not write; a pause does', async () => {
  const { saver, clock, save } = makeSaver();
  saver.change({ body: 'a' });
  saver.change({ body: 'ab' });
  saver.change({ body: 'abc' });
  assert.equal(save.count, 0, 'nothing on the wire while the keys are still moving');
  assert.equal(saver.state().dirty, true);

  await clock.advance(1_000);
  assert.equal(save.count, 1, 'three keystrokes, one write');
  assert.deepEqual(save.last, { body: 'abc' });
  assert.equal(saver.state().dirty, false);
  assert.equal(saver.state().savedAt !== null, true);
});

test('a document that did not change is never written', async () => {
  const { saver, clock, save } = makeSaver();
  saver.adopt({ body: 'hello' });          // this IS the server's copy
  saver.change({ body: 'hello' });         // clicked in, clicked out
  await clock.advance(5_000);
  assert.equal(save.count, 0);
  assert.equal(saver.state().dirty, false);
});

test('blur saves now, without waiting for the debounce', async () => {
  const { saver, save } = makeSaver();
  saver.change({ body: 'typed' });
  const ok = await saver.flush();
  assert.equal(save.count, 1);
  assert.equal(ok, true);
});

test('flush with nothing pending writes nothing and still answers true', async () => {
  const { saver, save } = makeSaver();
  assert.equal(await saver.flush(), true);
  assert.equal(save.count, 0);
});

test('two writes never overlap — a change mid-flight goes out after it', async () => {
  const { saver, clock, save } = makeSaver();
  saver.change({ body: 'one' });
  const flushing = saver.flush();
  saver.change({ body: 'two' });          // arrives while the first is on the wire
  await flushing;
  await clock.advance(0);
  assert.equal(save.maxConcurrent, 1, 'the writer is serial');
  assert.equal(save.count, 2);
  assert.deepEqual(save.last, { body: 'two' }, 'last write wins');
  assert.equal(saver.state().dirty, false);
});

test('a failed save keeps the work dirty, says so, and retries', async () => {
  const { saver, clock, save } = makeSaver();
  save.failNext(1);
  saver.change({ body: 'important' });
  await clock.advance(1_000);

  assert.equal(save.count, 1);
  assert.equal(saver.state().dirty, true, 'the work is still unsaved');
  assert.equal(saver.state().saving, false);
  assert.equal(typeof saver.state().error, 'string');
  assert.equal(saver.state().attempts, 1);
  assert.match(saveStatusLine(saver.state()), /Not saved/);

  await clock.advance(2_000);              // the first backoff
  assert.equal(save.count, 2);
  assert.deepEqual(save.last, { body: 'important' }, 'the same work, not a stub');
  assert.equal(saver.state().dirty, false);
  assert.equal(saver.state().error, null);
});

test('the backoff lengthens, and never gives the work away', async () => {
  const { saver, clock, save } = makeSaver();
  save.failNext(3);
  saver.change({ body: 'keep me' });
  await clock.advance(1_000);   // attempt 1
  await clock.advance(2_000);   // attempt 2
  await clock.advance(1_999);
  assert.equal(save.count, 2, 'the third attempt waits longer than the second');
  await clock.advance(2_001);   // attempt 3 at +4s
  assert.equal(save.count, 3);
  await clock.advance(8_000);   // attempt 4 succeeds
  assert.equal(save.count, 4);
  assert.deepEqual(save.last, { body: 'keep me' });
  assert.equal(saver.state().dirty, false);
});

test('the mirror is written while typing and cleared once the server has it', async () => {
  const { saver, clock, mirrored, clearedCount } = makeSaver();
  saver.change({ body: 'x' });
  assert.equal(mirrored.length, 1, 'mirrored the instant it was typed');
  assert.equal(clearedCount(), 0);
  await clock.advance(1_000);
  assert.equal(clearedCount(), 1, 'and dropped once it is safe');
});

test('a failed save leaves the mirror where it is', async () => {
  const { saver, clock, save, clearedCount } = makeSaver();
  save.failNext(1);
  saver.change({ body: 'x' });
  await clock.advance(1_000);
  assert.equal(clearedCount(), 0, 'the local copy is the net; it does not go first');
});

test('the default debounce is a pause to think, not a keystroke', () => {
  assert.equal(AUTOSAVE_DELAY_MS, 1_500);
});

// ---------------------------------------------------------------------------
// A. The registry and the guard's rule
// ---------------------------------------------------------------------------

test('nothing unsaved means nothing to ask about', () => {
  resetUnsavedRegistry();
  assert.equal(isWorkUnsaved(), false);
});

test('one dirty surface is enough, and saving it is enough to stop', async () => {
  resetUnsavedRegistry();
  const { saver, clock } = makeSaver();
  const unregister = registerUnsavedSource('page:1', {
    state: () => saver.state(),
    flush: () => saver.flush(),
  });
  saver.change({ body: 'typed' });
  assert.equal(isWorkUnsaved(), true);
  await clock.advance(1_000);
  assert.equal(isWorkUnsaved(), false);
  unregister();
  assert.equal(isWorkUnsaved(), false);
});

test('flushAllUnsaved answers false while anything is still unsaved', async () => {
  resetUnsavedRegistry();
  const { saver, clock, save } = makeSaver();
  registerUnsavedSource('page:2', { state: () => saver.state(), flush: () => saver.flush() });
  save.failNext(5);
  saver.change({ body: 'unsendable' });
  assert.equal(await flushAllUnsaved(), false, 'the banner must not reload on this');
  assert.equal(isWorkUnsaved(), true);
  save.failNext(0);
  await clock.advance(60_000);
  assert.equal(await flushAllUnsaved(), true);
  resetUnsavedRegistry();
});

// ---------------------------------------------------------------------------
// A. The keyed store
// ---------------------------------------------------------------------------

const DRAFT = { userId: 'user-a', itemId: 'page-1', savedAt: 1_000, baseUpdatedAt: null, data: { body: 'mine' } };

test('a draft is keyed by the user AND the item', () => {
  assert.equal(draftKey('user-a', 'page-1'), `${DRAFT_PREFIX}user-a.page-1`);
  assert.notEqual(draftKey('user-a', 'page-1'), draftKey('user-b', 'page-1'));
});

test("one account's draft never surfaces under another on the same machine", () => {
  const store = fakeStore();
  writeDraft(store, DRAFT);
  assert.deepEqual(readDraft(store, 'user-a', 'page-1').data, { body: 'mine' });
  assert.equal(readDraft(store, 'user-b', 'page-1'), null, 'the same page, a different lawyer');
});

test('a record whose owner does not match its key is refused', () => {
  // Belt and braces: the key names the owner, and so does the record.
  const store = fakeStore({
    [draftKey('user-b', 'page-1')]: JSON.stringify({ ...DRAFT, v: 1 }),
  });
  assert.equal(readDraft(store, 'user-b', 'page-1'), null);
});

test("one item's draft never appears under another item", () => {
  const store = fakeStore();
  writeDraft(store, DRAFT);
  assert.equal(readDraft(store, 'user-a', 'page-2'), null);
});

test('discarding removes exactly one draft', () => {
  const store = fakeStore();
  writeDraft(store, DRAFT);
  writeDraft(store, { ...DRAFT, itemId: 'page-2' });
  clearDraft(store, 'user-a', 'page-1');
  assert.equal(readDraft(store, 'user-a', 'page-1'), null);
  assert.notEqual(readDraft(store, 'user-a', 'page-2'), null);
});

test('sign-out wipes every account on the machine, drafts and conversations alike', () => {
  const store = fakeStore({ 'cs.assistant.wide': '1', 'unrelated': 'x' });
  writeDraft(store, DRAFT);
  writeDraft(store, { ...DRAFT, userId: 'user-b' });
  writeConversation(store, { userId: 'user-a', scopeId: 'matter-1', messages: [], input: 'hi', savedAt: 1 });
  const removed = clearAllDrafts(store);
  assert.equal(removed, 3);
  assert.equal(readDraft(store, 'user-a', 'page-1'), null);
  assert.equal(readDraft(store, 'user-b', 'page-1'), null);
  assert.equal(readConversation(store, 'user-a', 'matter-1'), null);
  assert.deepEqual(Object.keys(store.all()).sort(), ['cs.assistant.wide', 'unrelated'],
    'and touches nothing that is not a draft');
});

test('a store that refuses is a thinner net, never an exception', () => {
  const store = fakeStore();
  store.refuse = true;
  assert.equal(writeDraft(store, DRAFT), false);
  assert.equal(readDraft(store, 'user-a', 'page-1'), null);
  assert.equal(writeDraft(null, DRAFT), false);
  assert.equal(readDraft(null, 'user-a', 'page-1'), null);
  clearDraft(null, 'user-a', 'page-1');
});

test('a draft too big to be a draft is dropped, not thrown', () => {
  const store = fakeStore();
  const huge = 'x'.repeat(MAX_DRAFT_CHARS + 10);
  assert.equal(writeDraft(store, { ...DRAFT, data: { body: huge } }), false);
  assert.equal(Object.keys(store.all()).length, 0);
});

test('quota makes room by dropping this user’s OTHER drafts first', () => {
  const store = fakeStore();
  writeDraft(store, { ...DRAFT, itemId: 'old-1' });
  writeDraft(store, { ...DRAFT, itemId: 'old-2' });
  let refusals = 0;
  const original = store.setItem.bind(store);
  store.setItem = (k, v) => {
    if (refusals === 0 && k === draftKey('user-a', 'page-1')) {
      refusals += 1;
      throw new Error('QuotaExceededError');
    }
    original(k, v);
  };
  assert.equal(writeDraft(store, DRAFT), true, 'the document in front of them wins');
  assert.notEqual(readDraft(store, 'user-a', 'page-1'), null);
  assert.equal(readDraft(store, 'user-a', 'old-1'), null);
});

// ---------------------------------------------------------------------------
// A. What it says
// ---------------------------------------------------------------------------

test('the status line never says "saved" about work that is not', () => {
  assert.equal(saveStatusLine({ dirty: false, saving: false, savedAt: null, error: null, attempts: 0 }), null);
  assert.equal(saveStatusLine({ dirty: true, saving: true, savedAt: 1, error: null, attempts: 0 }), 'Saving…');
  assert.equal(saveStatusLine({ dirty: true, saving: false, savedAt: 1, error: null, attempts: 0 }), 'Unsaved…');
  assert.match(saveStatusLine({ dirty: true, saving: false, savedAt: 1, error: 'no', attempts: 1 }), /^Not saved/);
  assert.match(saveStatusLine({ dirty: false, saving: false, savedAt: Date.now(), error: null, attempts: 0 }), /^Saved \S/);
});

test('the restore offer names both clocks and promises nothing', () => {
  const line = restoreOfferLine(Date.parse('2026-09-20T15:58:00Z'), '2026-09-20T16:30:00Z');
  assert.match(line, /Unsaved changes from /);
  assert.match(line, /The saved copy is from /);
  assert.ok(!/overwrit/i.test(line));
  // A server copy we cannot date simply is not mentioned.
  assert.ok(!/The saved copy/.test(restoreOfferLine(Date.now(), null)));
});

// ---------------------------------------------------------------------------
// A. The Assistant's conversation
// ---------------------------------------------------------------------------

const CONVERSATION = {
  userId: 'user-a',
  scopeId: 'matter-1',
  messages: [{ id: '1', role: 'user', content: 'what is the deadline?', timestamp: '2026-09-20T12:00:00.000Z' }],
  input: 'and the reply brief',
  savedAt: 5,
};

test('a conversation comes back under its own scope, and only there', () => {
  const store = fakeStore();
  writeConversation(store, CONVERSATION);
  const back = readConversation(store, 'user-a', 'matter-1');
  assert.equal(back.messages[0].content, 'what is the deadline?');
  assert.equal(back.input, 'and the reply brief', 'the unsent question survives too');
  assert.equal(readConversation(store, 'user-a', 'matter-2'), null, 'never another matter');
  assert.equal(readConversation(store, 'user-b', 'matter-1'), null, 'never another account');
  assert.equal(readConversation(store, 'user-a', NO_MATTER_SCOPE), null,
    'a matter-less panel has its own scope and does not inherit one');
});

test('a conversation carries the scope in its key and in the record', () => {
  assert.equal(chatKey('user-a', 'matter-1'), `${CHAT_PREFIX}user-a.matter-1`);
  const store = fakeStore({ [chatKey('user-a', 'matter-2')]: JSON.stringify({ v: 1, ...CONVERSATION }) });
  assert.equal(readConversation(store, 'user-a', 'matter-2'), null,
    'a record filed under the wrong scope is refused, not shown');
});

test('clearing a conversation clears that one', () => {
  const store = fakeStore();
  writeConversation(store, CONVERSATION);
  writeConversation(store, { ...CONVERSATION, scopeId: 'matter-2' });
  clearConversation(store, 'user-a', 'matter-1');
  assert.equal(readConversation(store, 'user-a', 'matter-1'), null);
  assert.notEqual(readConversation(store, 'user-a', 'matter-2'), null);
});

// ---------------------------------------------------------------------------
// B. The real hook, in a real DOM
// ---------------------------------------------------------------------------

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useAutosave, createUnsavedGuard } = await import('../src/hooks/useUnsavedGuard.ts');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(props, { strict = false } = {}) {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const api = { current: null };
  function Probe({ userId, itemId, save }) {
    api.current = useAutosave({ userId, itemId, save, delayMs: 20 });
    return null;
  }
  // StrictMode is how this app actually mounts (src/main.tsx): in development
  // React runs every effect mount -> cleanup -> mount. The tree below is the
  // real one, not a stand-in.
  const tree = (p) =>
    strict
      ? React.createElement(React.StrictMode, null, React.createElement(Probe, p))
      : React.createElement(Probe, p);
  let root;
  await act(async () => {
    root = createRoot(container);
    root.render(tree(props));
  });
  return {
    api,
    async rerender(next) {
      await act(async () => { root.render(tree(next)); });
    },
    async unmount() {
      await act(async () => { root.unmount(); });
      await sleep(5);
    },
  };
}

test('B: typing mirrors to localStorage under user+item, and the save clears it', async () => {
  resetUnsavedRegistry();
  window.localStorage.clear();
  const seen = [];
  const view = await mount({
    userId: 'u1',
    itemId: 'p1',
    save: async (value) => { seen.push(value); },
  });

  await act(async () => { view.api.current.change({ body: 'half a sentence' }); });
  const raw = window.localStorage.getItem(`${DRAFT_PREFIX}u1.p1`);
  assert.ok(raw, 'the mirror is there before the server is');
  assert.equal(JSON.parse(raw).data.body, 'half a sentence');
  assert.equal(seen.length, 0);

  await act(async () => { await sleep(60); });
  assert.equal(seen.length, 1);
  assert.equal(window.localStorage.getItem(`${DRAFT_PREFIX}u1.p1`), null,
    'once the server has it the local copy is not kept');
  await view.unmount();
});

test('B: a second account on the same machine sees none of it', async () => {
  resetUnsavedRegistry();
  window.localStorage.clear();
  const view = await mount({ userId: 'u1', itemId: 'p1', save: async () => { await sleep(1000); } });
  await act(async () => { view.api.current.change({ body: 'privileged' }); });
  assert.ok(window.localStorage.getItem(`${DRAFT_PREFIX}u1.p1`));
  await view.unmount();

  const other = await mount({ userId: 'u2', itemId: 'p1', save: async () => {} });
  assert.equal(other.api.current.draft, null, "the next lawyer at this desk sees nothing of the last one's");
  await other.unmount();

  const same = await mount({ userId: 'u1', itemId: 'p1', save: async () => {} });
  assert.equal(same.api.current.draft?.data.body, 'privileged', 'and its owner is offered it back');
  await same.unmount();
});

test('B: discarding a draft throws it away', async () => {
  resetUnsavedRegistry();
  window.localStorage.clear();
  window.localStorage.setItem(
    `${DRAFT_PREFIX}u1.p1`,
    JSON.stringify({ v: 1, userId: 'u1', itemId: 'p1', savedAt: 1, baseUpdatedAt: null, data: { body: 'old' } }),
  );
  const view = await mount({ userId: 'u1', itemId: 'p1', save: async () => {} });
  assert.equal(view.api.current.draft.data.body, 'old');
  await act(async () => { view.api.current.discardDraft(); });
  assert.equal(view.api.current.draft, null);
  assert.equal(window.localStorage.getItem(`${DRAFT_PREFIX}u1.p1`), null);
  await view.unmount();
});

test('B: pagehide flushes, and so does leaving the page', async () => {
  resetUnsavedRegistry();
  window.localStorage.clear();
  const seen = [];
  const view = await mount({ userId: 'u1', itemId: 'p1', save: async (v) => { seen.push(v); } });
  await act(async () => { view.api.current.change({ body: 'mid-word' }); });
  assert.equal(seen.length, 0);
  await act(async () => { window.dispatchEvent(new window.Event('pagehide')); });
  await act(async () => { await sleep(5); });
  assert.equal(seen.length, 1, 'the tab closing is a save, not a loss');

  await act(async () => { view.api.current.change({ body: 'and more' }); });
  await view.unmount();
  assert.equal(seen.length, 2, 'and so is navigating away');
});

test('B: under StrictMode the editor still saves — the saver is not disposed under it', async () => {
  // The bug this guards: a cleanup that disposed the CURRENT saver. StrictMode
  // runs cleanup between two mounts with the SAME memoised saver, so the
  // second mount would hold a dead one — typing marks nothing dirty, nothing
  // is mirrored, and blur reports success having written nothing. In
  // development every Page, List and Table would silently stop saving.
  resetUnsavedRegistry();
  window.localStorage.clear();
  const seen = [];
  const view = await mount(
    { userId: 'u1', itemId: 'p1', save: async (v) => { seen.push(v); } },
    { strict: true },
  );

  await act(async () => { view.api.current.change({ body: 'after the double mount' }); });
  assert.ok(window.localStorage.getItem(`${DRAFT_PREFIX}u1.p1`), 'still mirroring');
  assert.equal(view.api.current.status.dirty, true, 'still marking the work unsaved');

  await act(async () => { await sleep(60); });
  assert.equal(seen.length, 1, 'and still writing to the server');
  assert.deepEqual(seen[0], { body: 'after the double mount' });
  await view.unmount();
});

test('B: the guard is absent until something is unsaved, and goes again after', async () => {
  resetUnsavedRegistry();
  const attached = [];
  const target = {
    addEventListener: (type) => attached.push(type),
    removeEventListener: (type) => {
      const at = attached.indexOf(type);
      if (at >= 0) attached.splice(at, 1);
    },
  };
  const { saver, clock } = makeSaver();
  const stop = createUnsavedGuard(target);
  assert.deepEqual(attached, [], 'a clean app never nags');

  const unregister = registerUnsavedSource('page:guard', {
    state: () => saver.state(),
    flush: () => saver.flush(),
  });
  saver.change({ body: 'typed' });
  assert.deepEqual(attached, ['beforeunload'], 'and speaks the moment there is something to lose');

  await clock.advance(1_000);
  assert.deepEqual(attached, [], 'and stops the moment the server has it');

  saver.change({ body: 'more' });
  assert.deepEqual(attached, ['beforeunload']);
  stop();
  assert.deepEqual(attached, [], 'unmounting takes the listener with it');
  unregister();
});

// ---------------------------------------------------------------------------
// C. The surfaces still do it
// ---------------------------------------------------------------------------

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('C: the Page editor reports every keystroke, and the page debounces it', () => {
  const editor = read('src/components/content/Editor.tsx');
  assert.match(editor, /onUpdate: \(\{ editor \}\) => \{/, 'TipTap reports as it is typed');
  assert.match(editor, /onBlur: \(\{ editor \}\) => \{/, 'and blur still saves');

  const page = read('src/pages/PageView.tsx');
  assert.match(page, /useAutosave<PageDraft>/);
  assert.match(page, /onChange=\{handleEditorChange\}/);
  assert.match(page, /saveStatusLine\(autosave\.status\)/, 'the header says what is happening');
  assert.match(page, /restoreOfferLine\(/, 'and a found draft is offered, never applied');
  assert.match(page, /adopt\(draftRef\.current\)/, 'the server copy is a baseline, not a change');
});

test('C: Lists and Tables go through the same serialized writer', () => {
  for (const [file, hook] of [['src/pages/ListView.tsx', 'ListDraft'], ['src/pages/TableView.tsx', 'TableDraft']]) {
    const source = read(file);
    assert.match(source, new RegExp(`useAutosave<${hook}>`), `${file} autosaves`);
    assert.match(source, /commitSoon\(/, `${file} debounces typed text`);
    assert.match(source, /saveStatusLine\(saver\.status\)/, `${file} says what is happening`);
    assert.ok(!/await updateContentItem\(id, \{ content:/.test(source),
      `${file} no longer writes content outside the queue`);
  }
});

test('C: the Editor desk keeps the manuscript, the pass and the rulings', () => {
  const room = read('src/pages/editor/EditorRoom.tsx');
  assert.match(room, /DESK_ITEM_ID/);
  assert.match(room, /writeDraft<DeskDraft>/);
  assert.match(room, /decisions, insertions/, 'the rulings and the lawyer’s own ink travel with it');
  assert.match(room, /readDraft<DeskDraft>/);
  assert.match(room, /restoreOfferLine\(/, 'and it is offered, never applied');
  assert.match(room, /if \(!user\?\.id \|\| !hasWork \|\| offerOutstanding\) return;/,
    'and an unanswered offer is never overwritten by what is typed next');
});

test('C: the Assistant keeps a conversation per scope, and keeps none of a sealed one', () => {
  const panel = read('src/components/ai/Assistant.tsx');
  assert.match(panel, /readConversation\(chatStore, user\.id, scopeKey\)/);
  assert.match(panel, /writeConversation\(chatStore, \{/);
  assert.match(panel, /browserSessionStore\(\)/, 'the session, not the disk');
  assert.match(panel, /mayKeepConversation = !scoped \? true : !ai\.loading && ai\.tier === 'A' && ai\.paused === false/,
    'sealed keeps nothing, paused keeps nothing, unknown is not open');
  assert.match(panel, /aria-label="Clear conversation"/);
  assert.match(panel, /scopeId: scopeKeyRef\.current/, 'a conversation carries the scope it belongs to');
});

test('C: the version banner saves before it reloads, and only the guard says beforeunload', () => {
  const banner = read('src/components/ui/RefusalBanner.tsx');
  assert.match(banner, /const saved = await flushAllUnsaved\(\)/);
  assert.match(banner, /if \(!saved\) \{/, 'a refresh that would lose work does not happen');
  assert.match(banner, /useUnsavedGuard\(\)/);

  const guard = read('src/hooks/useUnsavedGuard.ts');
  assert.match(guard, /addEventListener\('beforeunload', handler\)/);
  assert.match(guard, /const dirty = isDirty\(\)/, 'attached on a condition, never unconditionally');
  assert.ok(!/=> \(\) => \{?\s*void saver\.flush\(\)\.finally\(\(\) => saver\.dispose\(\)\)/.test(guard),
    'the CURRENT saver is never disposed in a cleanup — StrictMode remounts it');
  assert.match(guard, /onState: \(next\) => \{\s*setStatus\(next\);\s*notifyUnsaved\(\);/,
    'and every saver tells the registry, which is how the guard hears');
});

test('C: sign-out flushes first and wipes second', () => {
  const auth = read('src/contexts/AuthContext.tsx');
  const signOut = auth.slice(auth.indexOf('const signOut = async'), auth.indexOf('const resetPassword'));
  assert.ok(signOut.indexOf('flushAllUnsaved') < signOut.indexOf('clearAllDrafts'),
    'nothing is discarded that the server was not first offered');
  assert.ok(!/onAuthStateChange[\s\S]{0,400}clearAllDrafts/.test(auth),
    'a session that merely EXPIRED must not wipe an hour of unsaved text');
});

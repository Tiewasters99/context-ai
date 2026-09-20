// "Pin" on a Contextspaces card means FIX IN PLACE: the card stops moving and
// resizing, and it comes back next session exactly where it was left. This
// harness is the proof, run against the real hook in a real DOM.
//
//   node --import ./scripts/_node-src-loader.mjs --test scripts/_test-card-pin.mjs
//   (jsdom is installed --no-save; it is a harness dependency, never a repo one.)
//
// What it holds the hook to, in the order a user meets it:
//   1. drag  → the rect is in localStorage under the card's own key
//   2. pin   → `pinned: true` lands beside that rect, and the card stops moving
//   3. remount (a reload, or navigating back to the same item) → still pinned,
//      same rect, still immovable
//   4. unpin → `pinned: false`, rect KEPT
//   5. remount → draggable again, and still at that rect
//   6. right-click pins through the same state the button uses — one source of
//      truth, so the visible control and the power gesture can never disagree
//   7. a second item's key inherits nothing from the first
//
// Untracked by convention elsewhere in scripts/, but this one runs in CI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// A DOM, installed as globals BEFORE react-dom is imported (it reads them at
// module init, so the order is not negotiable).
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://contextspaces.test/app/page/abc',
  pretendToBeVisual: true,
});
const { window } = dom;

// Node itself defines some of these (navigator, localStorage) as read-only
// accessors, so a plain assignment either throws or silently loses to Node's
// version. defineProperty is the only reliable route.
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
                   'HTMLElement', 'Element', 'Node', 'MouseEvent', 'Event', 'getComputedStyle',
                   'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver']) {
  if (window[key] !== undefined) force(key, typeof window[key] === 'function' && /^(getComputedStyle|requestAnimationFrame|cancelAnimationFrame)$/.test(key)
    ? window[key].bind(window)
    : window[key]);
}

// jsdom ships no matchMedia, and useIsMobile is built on it. Desktop: the
// whole drag/pin machinery is live (on a phone the hook disables itself).
window.matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

// jsdom has no layout, so every rect is zero and a drag would be untestable.
// Read the rect back off the inline styles the hook itself writes, with a
// plausible starting frame for a card that has not been moved yet.
const DEFAULT_RECT = { left: 200, top: 100, width: 800, height: 600 };
window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  const style = this.style ?? {};
  const read = (value, fallback) => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const left = read(style.left, DEFAULT_RECT.left);
  const top = read(style.top, DEFAULT_RECT.top);
  const width = read(style.width, DEFAULT_RECT.width);
  const height = read(style.height, DEFAULT_RECT.height);
  return {
    x: left, y: top, left, top, width, height,
    right: left + width, bottom: top + height,
    toJSON() { return this; },
  };
};

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useDraggableResizable } = await import('../src/hooks/useDraggableResizable.ts');

// ---------------------------------------------------------------------------
// A card, as thin as a route card can be: the ref, and the pin API a ribbon
// button would be wired to.
// ---------------------------------------------------------------------------

function Card({ storageKey, api }) {
  const hook = useDraggableResizable(storageKey, { boundToViewport: true });
  api.current = hook;
  return React.createElement('div', { ref: hook.cardRef, 'data-card': storageKey ?? 'none' }, 'card body');
}

function readStored(key) {
  const raw = window.localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

async function mount(storageKey) {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const api = { current: null };
  let root;
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(Card, { storageKey, api }));
  });
  const card = container.querySelector('[data-card]');
  return {
    api,
    card,
    async rerender(nextKey) {
      await act(async () => { root.render(React.createElement(Card, { storageKey: nextKey, api })); });
      return container.querySelector('[data-card]');
    },
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

function fire(target, type, clientX, clientY) {
  target.dispatchEvent(new window.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX, clientY,
  }));
}

// A drag from a point well inside the card (the outer 8px are resize zones).
async function drag(card, from, to) {
  await act(async () => {
    fire(card, 'pointerdown', from.x, from.y);
    fire(window.document, 'pointermove', to.x, to.y);
    fire(window.document, 'pointerup', to.x, to.y);
  });
}

// The centre of whatever rect the card currently reports.
function centre(card) {
  const r = card.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// ---------------------------------------------------------------------------

test('a dragged card remembers where it was left', async () => {
  const KEY = 'cs.test.card.drag';
  window.localStorage.clear();

  const view = await mount(KEY);
  const start = centre(view.card);
  await drag(view.card, start, { x: start.x + 120, y: start.y + 80 });

  assert.equal(view.card.style.left, '320px', 'dragged 120px right of 200');
  assert.equal(view.card.style.top, '180px', 'dragged 80px below 100');

  const stored = readStored(KEY);
  assert.ok(stored, 'the drag was written to the card key');
  assert.equal(stored.left, '320px');
  assert.equal(stored.top, '180px');
  assert.notEqual(stored.pinned, true, 'dragging alone does not pin');

  await view.unmount();
});

test('Pin fixes the card in place, and the flag lands beside the rect', async () => {
  const KEY = 'cs.test.card.pin';
  window.localStorage.clear();

  const view = await mount(KEY);
  const start = centre(view.card);
  await drag(view.card, start, { x: start.x + 120, y: start.y + 80 });

  await act(async () => { view.api.current.togglePin(); });

  assert.equal(view.api.current.pinned, true, 'the hook reports pinned');
  assert.equal(view.card.style.cursor, 'default', 'a pinned card shows no grab cursor');

  const stored = readStored(KEY);
  assert.equal(stored.pinned, true);
  assert.equal(stored.left, '320px', 'the rect survives the pin');
  assert.equal(stored.top, '180px');

  // The whole point: it does not move.
  const held = centre(view.card);
  await drag(view.card, held, { x: held.x + 200, y: held.y + 200 });
  assert.equal(view.card.style.left, '320px', 'a pinned card refuses to drag');
  assert.equal(view.card.style.top, '180px');

  await view.unmount();
});

test('a reload comes back pinned, in the same place, still immovable', async () => {
  const KEY = 'cs.test.card.reload';
  window.localStorage.clear();
  window.localStorage.setItem(KEY, JSON.stringify({
    pinned: true, left: '320px', top: '180px', width: '800px',
  }));

  const view = await mount(KEY);

  assert.equal(view.api.current.pinned, true, 'restored as pinned');
  assert.equal(view.card.style.position, 'fixed');
  assert.equal(view.card.style.left, '320px');
  assert.equal(view.card.style.top, '180px');
  assert.equal(view.card.style.cursor, 'default');

  const held = centre(view.card);
  await drag(view.card, held, { x: held.x + 150, y: held.y + 150 });
  assert.equal(view.card.style.left, '320px', 'still immovable after the reload');

  await view.unmount();
});

test('Unpin releases the card but keeps its place, across a reload', async () => {
  const KEY = 'cs.test.card.unpin';
  window.localStorage.clear();
  window.localStorage.setItem(KEY, JSON.stringify({
    pinned: true, left: '320px', top: '180px', width: '800px',
  }));

  const pinnedView = await mount(KEY);
  assert.equal(pinnedView.api.current.pinned, true);

  await act(async () => { pinnedView.api.current.togglePin(); });
  assert.equal(pinnedView.api.current.pinned, false, 'unpinned');

  const stored = readStored(KEY);
  assert.equal(stored.pinned, false, 'the flag flipped');
  assert.equal(stored.left, '320px', 'the rect was NOT thrown away');
  assert.equal(stored.top, '180px');
  await pinnedView.unmount();

  // Reload: same place, but it moves again.
  const view = await mount(KEY);
  assert.equal(view.api.current.pinned, false);
  assert.equal(view.card.style.left, '320px', 'reopened where it was left');
  assert.equal(view.card.style.top, '180px');

  const start = centre(view.card);
  await drag(view.card, start, { x: start.x + 50, y: start.y + 25 });
  assert.equal(view.card.style.left, '370px', 'draggable again');
  assert.equal(view.card.style.top, '205px');

  await view.unmount();
});

test('right-click and the Pin button are the same switch', async () => {
  const KEY = 'cs.test.card.contextmenu';
  window.localStorage.clear();

  const view = await mount(KEY);

  await act(async () => {
    view.card.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  assert.equal(view.api.current.pinned, true, 'right-click pins through the hook state the button reads');
  assert.equal(readStored(KEY).pinned, true);

  // …and the button releases what the gesture pinned.
  await act(async () => { view.api.current.togglePin(); });
  assert.equal(view.api.current.pinned, false);
  assert.equal(readStored(KEY).pinned, false);

  // …and a double-click releases what the button pinned.
  await act(async () => { view.api.current.togglePin(); });
  assert.equal(view.api.current.pinned, true);
  await act(async () => {
    view.card.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  assert.equal(view.api.current.pinned, false, 'double-click unpins the same state');

  await view.unmount();
});

test('a second item inherits nothing from the first', async () => {
  const FIRST = 'cs.test.card.first';
  const SECOND = 'cs.test.card.second';
  window.localStorage.clear();
  window.localStorage.setItem(FIRST, JSON.stringify({
    pinned: true, left: '320px', top: '180px', width: '800px',
  }));

  const view = await mount(FIRST);
  assert.equal(view.api.current.pinned, true, 'the first item is pinned');

  // Navigating straight from one page to the next: same component, new key.
  const card = await view.rerender(SECOND);
  assert.equal(view.api.current.pinned, false, 'the second item is NOT pinned');
  assert.equal(card.style.left, '', 'and did not inherit the first item\'s rect');
  assert.equal(card.style.position, '', 'nor its fixed positioning');
  assert.equal(readStored(SECOND), null, 'nothing was written under the second key');
  assert.equal(readStored(FIRST).pinned, true, 'the first item is still pinned in storage');

  await view.unmount();
});

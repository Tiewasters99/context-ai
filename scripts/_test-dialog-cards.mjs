// Every dialog is a card: draggable, resizable on all four edges, pinnable.
// Eden, 2026-09-25: "All cards throughout should be draggable, resizable
// along all four edges, and pinnable."
//
//   node --import ./scripts/_node-src-loader.mjs --test scripts/_test-dialog-cards.mjs
//   (jsdom is installed --no-save, as for _test-card-pin.mjs; `typescript`, a
//   devDependency, compiles the .tsx components for this run only.)
//
// Two halves:
//   1. THE SHELL, mounted for real (jsdom + the real hook + the real
//      CardDialog): it opens as a card with a ribbon, Pin, fullscreen and
//      close; the hook is actually bound to it (a drag moves it and is
//      remembered); Pin persists across a reopen; Escape closes the topmost
//      dialog only, and not while busy; the backdrop closes only where the
//      dialog allows it, never after a drag released over it, and never with
//      a half-typed form (`closeOnBackdrop={!dirty}`); focus lands in the
//      first field.
//   2. THE WIRING, as source: each converted dialog renders <CardDialog> with
//      its own `cs.dialog.*` key and builds no overlay of its own. The dialogs
//      themselves import Supabase, the router and the rest of the app, so they
//      are held to the shell by their source, the way _test-agent-ui.mjs holds
//      the agents cards to AgentCard.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// .tsx for this run: '@/x' → src/x, then .ts / .tsx / index; .tsx compiled by
// TypeScript's own transpiler (react-jsx). Registered after the src loader,
// so it runs first and hands everything else on unchanged.
// ---------------------------------------------------------------------------

const TS_URL = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;

register(
  `data:text/javascript,${encodeURIComponent(`
    import { readFile } from 'node:fs/promises';
    import { fileURLToPath } from 'node:url';
    import ts from ${JSON.stringify(TS_URL)};
    const SRC = ${JSON.stringify(new URL('../src/', import.meta.url).href)};
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith('@/')) specifier = SRC + specifier.slice(2);
      try {
        return await next(specifier, context);
      } catch (e) {
        if (e?.code !== 'ERR_MODULE_NOT_FOUND' || /\\.[a-z]+$/.test(specifier)) throw e;
        for (const ext of ['.tsx', '/index.tsx']) {
          try { return await next(specifier + ext, context); } catch { /* next */ }
        }
        throw e;
      }
    }
    export async function load(url, context, next) {
      if (!url.endsWith('.tsx')) return next(url, context);
      const source = await readFile(fileURLToPath(url), 'utf8');
      const out = ts.transpileModule(source, {
        fileName: fileURLToPath(url),
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: false,
        },
      });
      return { format: 'module', source: out.outputText, shortCircuit: true };
    }
  `)}`,
  import.meta.url,
);

// ---------------------------------------------------------------------------
// A DOM, installed as globals BEFORE react-dom is imported (same recipe as
// _test-card-pin.mjs).
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://contextspaces.test/app/matterspace/abc',
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
  } catch { /* a few refuse to copy; none are used here */ }
}
for (const key of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage',
                   'HTMLElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent', 'Event',
                   'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
                   'MutationObserver']) {
  if (window[key] !== undefined) force(key, typeof window[key] === 'function' && /^(getComputedStyle|requestAnimationFrame|cancelAnimationFrame)$/.test(key)
    ? window[key].bind(window)
    : window[key]);
}

// Desktop: the drag/pin machinery is live (the hook disables itself on a phone).
let phone = false;
window.matchMedia = (query) => ({
  matches: phone,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

// jsdom has no layout: read the rect back off the inline styles the hook writes.
const DEFAULT_RECT = { left: 300, top: 150, width: 440, height: 320 };
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
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON() { return this; } };
};

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
const { act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: CardDialog } = await import('../src/components/ui/CardDialog.tsx');

const h = React.createElement;

// A frame so CardDialog's first-field focus (requestAnimationFrame) runs.
const nextFrame = () => new Promise((r) => window.requestAnimationFrame(() => r()));

async function mount(element) {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  let root;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
  await act(async () => { await nextFrame(); });
  return {
    async render(next) { await act(async () => { root.render(next); }); },
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const cardFor = (key) => window.document.querySelector(`[data-card-dialog="${key}"]`);
const backdropOf = (card) => card.closest('[data-card-dialog-backdrop]');

function fire(target, type, init = {}) {
  target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}
async function press(target) {
  await act(async () => {
    fire(target, 'pointerdown');
    fire(target, 'mousedown');
    fire(target, 'pointerup');
    fire(target, 'mouseup');
    fire(target, 'click');
  });
}
async function escape() {
  await act(async () => {
    // From the page, as a browser sends it (the focused element, or <body>),
    // so it travels window-capture → target → document → window.
    (window.document.activeElement ?? window.document.body)
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}
function readStored(key) {
  const raw = window.localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

// A dialog in the shape the converted ones take: a form whose dirtiness
// decides whether the backdrop may close it.
function FormDialog({ storageKey, onClose, busy = false, backdropWhenClean = true }) {
  const [name, setName] = useState('');
  return h(CardDialog, {
    storageKey,
    title: 'New Matter',
    onClose,
    busy,
    closeOnBackdrop: backdropWhenClean && !name.trim(),
    footer: h('button', { type: 'submit', form: 'f' }, 'Create'),
  },
  h('form', { id: 'f', onSubmit: (e) => e.preventDefault() },
    h('input', { 'data-first': '', value: name, onChange: (e) => setName(e.target.value), placeholder: 'Matter name' }),
    h('textarea', { placeholder: 'Description' }),
  ));
}

// Type into a React-controlled input the way the browser does.
async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

// ---------------------------------------------------------------------------
// 1. The shell
// ---------------------------------------------------------------------------

test('a dialog opens as a card: ribbon, Pin, fullscreen, close, role=dialog', async () => {
  window.localStorage.clear();
  const KEY = 'cs.dialog.test.shell';
  const view = await mount(h(FormDialog, { storageKey: KEY, onClose() {} }));
  const card = cardFor(KEY);
  assert.ok(card, 'the card is in the document (portalled to <body>)');
  assert.equal(card.parentElement.parentElement, window.document.body, 'portalled to <body>');
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(card.getAttribute('aria-label'), 'New Matter');
  const ribbon = card.querySelector('[data-card-ribbon]');
  assert.ok(ribbon, 'the ribbon header is there');
  assert.ok(ribbon.querySelector('[title="Drag to move"]'), 'with a visible drag handle');
  assert.ok([...ribbon.querySelectorAll('button')].some((b) => /^Pin/.test(b.textContent)), 'Pin is in the ribbon');
  assert.ok(ribbon.querySelector('button[title="Fullscreen"]'), 'fullscreen is in the ribbon');
  assert.ok(ribbon.querySelector('button[aria-label="Close"]'), 'close is in the ribbon');
  assert.equal(card.style.getPropertyValue('--card-max-w'), '440px', 'the width cap survives the hook (it clears inline max-width)');
  assert.ok(/max-w-\[var\(--card-max-w\)\]/.test(card.className));
  await view.unmount();
});

test('the hook is bound to the card: a drag moves it and is remembered', async () => {
  window.localStorage.clear();
  const KEY = 'cs.dialog.test.drag';
  const view = await mount(h(FormDialog, { storageKey: KEY, onClose() {} }));
  const ribbon = cardFor(KEY).querySelector('[data-card-ribbon]');
  await act(async () => {
    fire(ribbon, 'pointerdown', { clientX: 500, clientY: 160 });
    fire(window.document, 'pointermove', { clientX: 620, clientY: 240 });
    fire(window.document, 'pointerup', { clientX: 620, clientY: 240 });
  });
  const card = cardFor(KEY);
  assert.equal(card.style.position, 'fixed');
  assert.equal(card.style.left, '420px', 'moved 120px right of 300');
  assert.equal(card.style.top, '230px', 'moved 80px below 150');
  assert.equal(readStored(KEY).left, '420px', 'written under the dialog\'s own key');
  await view.unmount();
});

test('it resizes from an edge, and not from a field', async () => {
  window.localStorage.clear();
  const KEY = 'cs.dialog.test.resize';
  const view = await mount(h(FormDialog, { storageKey: KEY, onClose() {} }));
  const card = cardFor(KEY);
  // Left edge (x within 8px of 300): width grows as the edge moves left.
  await act(async () => {
    fire(card, 'pointerdown', { clientX: 302, clientY: 300 });
    fire(window.document, 'pointermove', { clientX: 252, clientY: 300 });
    fire(window.document, 'pointerup', { clientX: 252, clientY: 300 });
  });
  assert.equal(cardFor(KEY).style.width, '490px', 'the left edge resizes');
  // Top edge.
  await act(async () => {
    fire(card, 'pointerdown', { clientX: 450, clientY: 152 });
    fire(window.document, 'pointermove', { clientX: 450, clientY: 112 });
    fire(window.document, 'pointerup', { clientX: 450, clientY: 112 });
  });
  assert.equal(cardFor(KEY).style.height, '360px', 'the top edge resizes');
  // A press in a field neither drags nor resizes.
  const before = cardFor(KEY).style.left;
  const input = card.querySelector('input');
  await act(async () => {
    fire(input, 'pointerdown', { clientX: 400, clientY: 250 });
    fire(window.document, 'pointermove', { clientX: 500, clientY: 350 });
    fire(window.document, 'pointerup', { clientX: 500, clientY: 350 });
  });
  assert.equal(cardFor(KEY).style.left, before, 'typing in a field never moves the card');
  await view.unmount();
});

// A picker, a member list, a track grid: rows that are buttons wall to wall.
function ButtonRowDialog({ storageKey, onRow }) {
  return h(CardDialog, { storageKey, title: 'Attach documents', onClose() {}, bodyClassName: 'p-0' },
    h('button', { 'data-row': '', onClick: onRow, style: { display: 'block', width: '100%' } },
      h('span', { 'data-row-label': '' }, 'Exhibit A')));
}

test('the side edge resizes even over a full-width button row, and does not click it', async () => {
  window.localStorage.clear();
  const KEY = 'cs.dialog.test.rowedge';
  let clicks = 0;
  const view = await mount(h(ButtonRowDialog, { storageKey: KEY, onRow: () => { clicks += 1; } }));
  const card = cardFor(KEY);
  const row = card.querySelector('[data-row]');
  // The card spans x 300..740. 3px inside the right edge, on the button.
  await act(async () => {
    fire(row, 'pointerdown', { clientX: 737, clientY: 300 });
    fire(window.document, 'pointermove', { clientX: 787, clientY: 300 });
    fire(window.document, 'pointerup', { clientX: 787, clientY: 300 });
    fire(row, 'click', { clientX: 787, clientY: 300 });
  });
  assert.equal(cardFor(KEY).style.width, '490px', 'the right edge resized the card');
  assert.equal(clicks, 0, 'and the row under it was not clicked');

  // The same on the left edge, pressing on the row's label (a span).
  await act(async () => {
    fire(row.querySelector('[data-row-label]'), 'pointerdown', { clientX: 303, clientY: 300 });
    fire(window.document, 'pointermove', { clientX: 263, clientY: 300 });
    fire(window.document, 'pointerup', { clientX: 263, clientY: 300 });
    fire(row, 'click', { clientX: 263, clientY: 300 });
  });
  assert.equal(cardFor(KEY).style.width, '530px', 'the left edge resized it too');
  assert.equal(clicks, 0);
  await view.unmount();
});

test('a click in the middle of that row still clicks it, and moves nothing', async () => {
  window.localStorage.clear();
  const KEY = 'cs.dialog.test.rowmiddle';
  let clicks = 0;
  const view = await mount(h(ButtonRowDialog, { storageKey: KEY, onRow: () => { clicks += 1; } }));
  const row = cardFor(KEY).querySelector('[data-row]');
  await act(async () => {
    fire(row, 'pointerdown', { clientX: 520, clientY: 300 });
    fire(window.document, 'pointerup', { clientX: 520, clientY: 300 });
    fire(row, 'click', { clientX: 520, clientY: 300 });
  });
  assert.equal(clicks, 1, 'the row was clicked');
  const card = cardFor(KEY);
  assert.equal(card.style.width, '', 'no resize');
  assert.equal(card.style.position, '', 'no drag');
  await view.unmount();
});

test('an edge press on a text field goes to the field, not to a resize', async () => {
  window.localStorage.clear();
  const KEY = 'cs.dialog.test.fieldedge';
  const view = await mount(h(CardDialog, { storageKey: KEY, title: 'Share', onClose() {}, bodyClassName: 'p-0' },
    h('input', { 'data-field': '', style: { width: '100%' } })));
  const input = cardFor(KEY).querySelector('[data-field]');
  await act(async () => {
    fire(input, 'pointerdown', { clientX: 737, clientY: 300 });
    fire(window.document, 'pointermove', { clientX: 787, clientY: 300 });
    fire(window.document, 'pointerup', { clientX: 787, clientY: 300 });
  });
  assert.equal(cardFor(KEY).style.width, '', 'the field kept its own gesture');
  await view.unmount();
});

test('Pin fixes it in place and it reopens pinned, where it was left', async () => {
  window.localStorage.clear();
  const KEY = 'cs.dialog.test.pin';
  let view = await mount(h(FormDialog, { storageKey: KEY, onClose() {} }));
  const pinButton = () => [...cardFor(KEY).querySelectorAll('[data-card-ribbon] button')].find((b) => /^Pin/.test(b.textContent));
  await act(async () => { pinButton().click(); });
  assert.equal(pinButton().textContent, 'Pinned');
  const stored = readStored(KEY);
  assert.equal(stored.pinned, true);
  assert.equal(stored.left, '300px');
  await view.unmount();

  view = await mount(h(FormDialog, { storageKey: KEY, onClose() {} }));
  const card = cardFor(KEY);
  assert.equal(pinButton().textContent, 'Pinned', 'reopened pinned');
  assert.equal(card.style.left, '300px');
  await act(async () => {
    fire(card.querySelector('[data-card-ribbon]'), 'pointerdown', { clientX: 500, clientY: 160 });
    fire(window.document, 'pointermove', { clientX: 700, clientY: 400 });
    fire(window.document, 'pointerup', { clientX: 700, clientY: 400 });
  });
  assert.equal(card.style.left, '300px', 'a pinned dialog does not move');
  await view.unmount();
});

test('Escape closes, and not while busy', async () => {
  window.localStorage.clear();
  let closed = 0;
  const onClose = () => { closed += 1; };
  const view = await mount(h(FormDialog, { storageKey: 'cs.dialog.test.esc', onClose, busy: true }));
  await escape();
  assert.equal(closed, 0, 'busy: Escape does nothing');
  await press(cardFor('cs.dialog.test.esc').querySelector('button[aria-label="Close"]'));
  assert.equal(closed, 0, 'busy: the ribbon X does nothing');
  await view.render(h(FormDialog, { storageKey: 'cs.dialog.test.esc', onClose, busy: false }));
  await escape();
  assert.equal(closed, 1, 'Escape closes');
  await view.unmount();
});

test('Escape closes only the topmost dialog', async () => {
  window.localStorage.clear();
  const log = [];
  const view = await mount(h('div', null,
    h(CardDialog, { storageKey: 'cs.dialog.test.under', title: 'Under', onClose: () => log.push('under') }, h('p', null, 'under')),
    h(CardDialog, { storageKey: 'cs.dialog.test.over', title: 'Over', onClose: () => log.push('over') }, h('p', null, 'over')),
  ));
  await escape();
  assert.deepEqual(log, ['over']);
  await view.unmount();
});

test('the Escape a dialog takes never reaches the surface under it', async () => {
  window.localStorage.clear();
  // The reader's margin panel, a menu: they close themselves on Escape from a
  // window/document listener, and must not close along with the dialog.
  let hostClosed = 0;
  const host = () => { hostClosed += 1; };
  window.document.addEventListener('keydown', host);
  window.addEventListener('keydown', host);
  let closed = 0;
  let view = await mount(h(CardDialog, { storageKey: 'cs.dialog.test.host', title: 'Over', onClose: () => { closed += 1; } }, h('p', null, 'x')));
  await escape();
  assert.equal(closed, 1);
  assert.equal(hostClosed, 0, 'the host did not see the Escape');
  await view.unmount();

  // Even when the dialog declines to close (a one-time token card).
  view = await mount(h(CardDialog, { storageKey: 'cs.dialog.test.host2', title: 'Token', closeOnEscape: false, onClose: () => { closed += 1; } }, h('p', null, 'x')));
  await escape();
  assert.equal(closed, 1, 'the token card stayed open');
  assert.equal(hostClosed, 0, 'and the host still did not see it');
  await view.unmount();

  // No dialog open: the host has it again.
  await escape();
  assert.equal(hostClosed, 2);
  window.document.removeEventListener('keydown', host);
  window.removeEventListener('keydown', host);
});

test('the backdrop: closes a clean form, keeps a half-typed one, never closes after a drag', async () => {
  window.localStorage.clear();
  const KEY = 'cs.dialog.test.backdrop';
  let closed = 0;
  const view = await mount(h(FormDialog, { storageKey: KEY, onClose: () => { closed += 1; } }));
  const card = cardFor(KEY);
  const backdrop = backdropOf(card);

  // Half-typed: a stray click outside must not lose it.
  await type(card.querySelector('input'), 'Smith v. Jones');
  await press(backdrop);
  assert.equal(closed, 0, 'a half-typed form is not lost to a backdrop click');
  assert.equal(card.querySelector('input').value, 'Smith v. Jones');

  // Cleared again: the backdrop closes it, as it did before it was a card.
  await type(card.querySelector('input'), '');
  // A drag that starts on the card and is released over the backdrop fires
  // click on the backdrop — that is a move, not a dismissal.
  await act(async () => {
    fire(card.querySelector('[data-card-ribbon]'), 'pointerdown', { clientX: 500, clientY: 160 });
    fire(card.querySelector('[data-card-ribbon]'), 'mousedown', { clientX: 500, clientY: 160 });
    fire(window.document, 'pointermove', { clientX: 900, clientY: 700 });
    fire(window.document, 'pointerup', { clientX: 900, clientY: 700 });
    fire(backdrop, 'click', { clientX: 900, clientY: 700 });
  });
  assert.equal(closed, 0, 'a drag released over the backdrop does not close');
  await press(backdrop);
  assert.equal(closed, 1, 'a clean form still closes on the backdrop');
  await view.unmount();
});

test('a dialog that never closed on its backdrop still does not', async () => {
  window.localStorage.clear();
  const KEY = 'cs.dialog.test.nobackdrop';
  let closed = 0;
  const view = await mount(h(FormDialog, { storageKey: KEY, onClose: () => { closed += 1; }, backdropWhenClean: false }));
  await press(backdropOf(cardFor(KEY)));
  assert.equal(closed, 0);
  await view.unmount();
});

test('focus lands in the first field', async () => {
  window.localStorage.clear();
  const KEY = 'cs.dialog.test.focus';
  const view = await mount(h(FormDialog, { storageKey: KEY, onClose() {} }));
  assert.equal(window.document.activeElement, cardFor(KEY).querySelector('[data-first]'));
  await view.unmount();
});

test('the overlay keeps the dialog\'s own layer', async () => {
  window.localStorage.clear();
  const KEY = 'cs.dialog.test.z';
  const view = await mount(h(CardDialog, { storageKey: KEY, title: 'Seal', z: 80, maxWidth: 384, onClose() {} }, h('p', null, 'x')));
  const card = cardFor(KEY);
  assert.equal(backdropOf(card).style.zIndex, '80');
  assert.equal(card.style.getPropertyValue('--card-max-w'), '384px');
  await view.unmount();
});

test('on a phone: no drag, no Pin or fullscreen, still a full-width dialog that closes', async () => {
  window.localStorage.clear();
  phone = true;
  try {
    const KEY = 'cs.dialog.test.phone';
    window.localStorage.setItem(KEY, JSON.stringify({ left: '900px', top: '700px', width: '440px' }));
    let closed = 0;
    const view = await mount(h(FormDialog, { storageKey: KEY, onClose: () => { closed += 1; } }));
    const card = cardFor(KEY);
    assert.equal(card.style.left, '', 'a desktop position is not restored on a phone');
    assert.equal(card.style.position, '');
    assert.ok(/\bw-full\b/.test(card.className), 'full width');
    const ribbon = card.querySelector('[data-card-ribbon]');
    assert.ok(![...ribbon.querySelectorAll('button')].some((b) => /^Pin/.test(b.textContent)), 'no Pin on a phone');
    await press(ribbon.querySelector('button[aria-label="Close"]'));
    assert.equal(closed, 1);
    await view.unmount();
  } finally {
    phone = false;
  }
});

// ---------------------------------------------------------------------------
// 2. The wiring
// ---------------------------------------------------------------------------

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// file → the storage keys it must use (one per dialog in the file).
const CONVERTED = {
  'src/components/matter/NewMatterModal.tsx': ['cs.dialog.newMatter'],
  'src/components/matter/DeleteMatterModal.tsx': ['cs.dialog.deleteMatter'],
  'src/components/matter/AiPauseControl.tsx': ['cs.dialog.aiPause'],
  'src/components/serverspace/NewServerspaceModal.tsx': ['cs.dialog.newServerspace'],
  'src/components/securespace/SealMatterModal.tsx': ['cs.dialog.sealMatter'],
  'src/components/reader/SealedExportDialog.tsx': ['cs.dialog.sealedExport'],
  'src/components/matter/DocumentPicker.tsx': ['cs.dialog.documentPicker'],
  'src/components/matter/BucketizerSurface.tsx': ['cs.dialog.bucketizerRunEstimate'],
  'src/components/matter/BucketizerEvidenceRunDialog.tsx': ['cs.dialog.bucketizerEvidenceRun'],
  'src/components/matter/BucketizerOutlineDialog.tsx': ['cs.dialog.bucketizerOutline'],
  'src/components/vault/UploadEstimateDialog.tsx': ['cs.dialog.uploadEstimate'],
  'src/components/vault/DeckComposerModal.tsx': ['cs.dialog.deckComposer'],
  'src/components/vault/SandboxPanel.tsx': ['cs.dialog.sandboxAddFromMatter'],
  'src/components/serverspace/ShareModal.tsx': ['cs.dialog.share'],
  'src/components/layout/MusicLibrary.tsx': ['cs.dialog.musicLibrary'],
  'src/components/reader/AnimationAttach.tsx': ['cs.dialog.animationAttach'],
  'src/components/vault/DocumentEditor.tsx': ['cs.dialog.documentEditor'],
};

test('the document editor: unsaved edits survive the backdrop, and one Escape handler', () => {
  const s = src('src/components/vault/DocumentEditor.tsx');
  assert.match(s, /closeOnBackdrop=\{!dirty\}/, 'the backdrop used to close it whatever was typed');
  assert.match(s, /busy=\{saving\}/, 'no closing mid-save');
  assert.doesNotMatch(s, /e\.key === 'Escape'/, 'Escape is CardDialog\'s, not a second listener');
  assert.match(s, /data-card-inert/, 'the read-only text can be selected, not dragged');
});

// A file whose own route card or page shell is `fixed inset-0` legitimately:
// only the named dialog inside it is held to the shell.
const CONVERTED_INSIDE = {
  'src/pages/MatterspaceView.tsx': { fn: 'MoveToMatterModal', key: 'cs.dialog.moveToMatter' },
  'src/pages/ClaudeConnect.tsx': { fn: 'NewTokenModal', key: 'cs.dialog.newToken' },
  'src/pages/ChatGPTConnect.tsx': { fn: 'NewTokenModal', key: 'cs.dialog.newToken' },
  'src/pages/GeminiConnect.tsx': { fn: 'NewTokenModal', key: 'cs.dialog.newToken' },
  'src/pages/GrokConnect.tsx': { fn: 'NewTokenModal', key: 'cs.dialog.newToken' },
};

// A token is shown once: its card closes only on a deliberate click, and the
// token and config text can be selected rather than dragging the card.
for (const f of ['ClaudeConnect', 'ChatGPTConnect', 'GeminiConnect', 'GrokConnect']) {
  test(`${f}: the one-time token card ignores Escape and keeps its text selectable`, () => {
    const s = src(`src/pages/${f}.tsx`);
    const body = s.slice(s.indexOf('function NewTokenModal('));
    assert.match(body, /closeOnEscape=\{false\}/);
    assert.doesNotMatch(body.slice(0, body.indexOf('</CardDialog>')), /closeOnBackdrop/);
    assert.match(body, /<code data-card-inert=""/);
  });
}

for (const [file, { fn, key }] of Object.entries(CONVERTED_INSIDE)) {
  test(`${fn} (${file.split('/').pop()}) is a card`, () => {
    const s = src(file);
    const start = s.indexOf(`function ${fn}(`);
    assert.ok(start >= 0, `${fn} is still in ${file}`);
    const next = s.indexOf('\nfunction ', start + 1);
    const body = s.slice(start, next < 0 ? undefined : next);
    assert.match(body, /<CardDialog\b/);
    assert.ok(body.includes(`storageKey="${key}"`), `uses its own key ${key}`);
    assert.doesNotMatch(body, /fixed inset-0|top-1\/2 left-1\/2/);
  });
}

for (const [file, keys] of Object.entries(CONVERTED)) {
  test(`${file.split('/').pop()} is a card`, () => {
    const s = src(file);
    assert.match(s, /<CardDialog\b/, 'renders the shared card shell');
    for (const key of keys) assert.ok(s.includes(`storageKey="${key}"`), `uses its own key ${key}`);
    assert.doesNotMatch(s, /fixed inset-0/, 'builds no overlay of its own');
    assert.doesNotMatch(s, /top-1\/2 left-1\/2/, 'no translate-centred frame (it jumps on the first drag)');
  });
}

test('the shell itself: the hook, the ribbon, Pin, and the mousedown backdrop rule', () => {
  const s = src('src/components/ui/CardDialog.tsx');
  assert.match(s, /useDraggableResizable\(storageKey\)/);
  assert.match(s, /ref=\{cardRef\}/);
  assert.match(s, /\{!isMobile && <PinToggle pinned=\{pinned\} onToggle=\{togglePin\} \/>\}/);
  assert.match(s, /\{!isMobile && <FullscreenToggle onToggle=\{toggleFullscreen\} \/>\}/);
});

test('ModalPortal stays a bare portal (menus and popovers use it too)', () => {
  const s = src('src/components/ui/ModalPortal.tsx');
  assert.doesNotMatch(s, /useDraggableResizable\(/, 'it binds no card hook');
});

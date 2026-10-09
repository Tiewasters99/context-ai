// The Workshop button in the Reader's toolbar. Eden, 2026-10-08: "when you
// open a book, there is a button for opening the Workshop." The bench (#370,
// migration 106) was the fourth tab of the left sidebar and nobody found it.
//
//   node --import ./scripts/_node-src-loader.mjs --test scripts/_test-reader-workshop-button.mjs
//   (jsdom is installed --no-save, as for _test-card-pin.mjs; `typescript`, a
//   devDependency, compiles the .tsx components for this run only.)
//
// Two halves:
//   1. THE SIDEBAR, mounted for real (jsdom + the real ReaderSidebar and
//      WorkshopPanel): told to show the Workshop tab, it shows the bench at
//      its 360px width; its tabs report a choice to the Reader instead of
//      keeping it; a document with no bench (no matter) falls back to Pages.
//   2. THE BUTTON, as source: DocumentReader imports Supabase, pdfjs, the
//      router and the rest of the app, so the toolbar button is held to its
//      wiring by its source — when it shows, what a click does, and that the
//      sidebar's tab is the Reader's to set.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// .tsx for this run (same recipe as _test-dialog-cards.mjs), plus a stand-in
// for vite's import.meta.env so src/lib/supabase.ts can be imported: the
// Workshop's data helpers import the client, and nothing here calls it.
// ---------------------------------------------------------------------------

const TS_URL = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;

register(
  `data:text/javascript,${encodeURIComponent(`
    import { readFile } from 'node:fs/promises';
    import { fileURLToPath } from 'node:url';
    import ts from ${JSON.stringify(TS_URL)};
    const SRC = ${JSON.stringify(new URL('../src/', import.meta.url).href)};
    const ENV = '({ VITE_SUPABASE_URL: "http://stub.supabase.local", VITE_SUPABASE_ANON_KEY: "anon-stub" })';
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
      if (!url.startsWith(SRC) || !/\\.tsx?$/.test(url)) return next(url, context);
      let source = await readFile(fileURLToPath(url), 'utf8');
      source = source.replaceAll('import.meta.env', ENV);
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
// A DOM, installed as globals BEFORE react-dom is imported.
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://contextspaces.test/app/document/abc',
  pretendToBeVisual: true,
});
const { window } = dom;
for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue;
  const descriptor = Object.getOwnPropertyDescriptor(window, key);
  if (!descriptor) continue;
  try {
    Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
  } catch { /* a few refuse to copy; none are used here */ }
}
for (const key of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage',
                   'HTMLElement', 'Element', 'Node', 'MouseEvent', 'Event']) {
  Object.defineProperty(globalThis, key, { value: window[key], writable: true, configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ReaderSidebar } = await import('../src/components/reader/ReaderSidebar.tsx');

// In a DOM the Supabase client opens a BroadcastChannel (to share the
// session across tabs) and a token-refresh timer, either of which would keep
// this run alive after the last test. Nothing here signs in; close them.
const { supabase } = await import('../src/lib/supabase.ts');
test.after(async () => {
  await supabase.auth.stopAutoRefresh();
  supabase.auth.broadcastChannel?.close();
  window.close();
});

const h = React.createElement;
const noop = () => {};
const asyncNoop = async () => {};

const WORKSHOP = {
  page: 1,
  items: [],
  snipping: false,
  selectionText: null,
  canWrite: true,
  notice: null,
  onSnip: noop,
  onCancelSnip: noop,
  onSnippet: asyncNoop,
  makePreview: async () => null,
  onDownload: asyncNoop,
  onTurn: asyncNoop,
  onResnip: noop,
  onDelete: asyncNoop,
  onBringIn: asyncNoop,
  onLayOnPage: asyncNoop,
  onJumpPage: noop,
};

function sidebar(props) {
  return h(ReaderSidebar, {
    totalPages: 2,
    currentPage: 1,
    thumbnails: [null, null],
    outline: null,
    onJumpPage: noop,
    onJumpDest: noop,
    animations: [],
    onAddAnimation: null,
    onRemoveAnimation: noop,
    addingAnimation: false,
    workshop: WORKSHOP,
    tab: 'pages',
    onTabChange: noop,
    ...props,
  });
}

async function mount(element) {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  let root;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const tabButton = (container, label) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

// ---------------------------------------------------------------------------
// 1. The sidebar
// ---------------------------------------------------------------------------

test('told to show the Workshop tab, the sidebar shows the bench, 360px wide', async () => {
  const m = await mount(sidebar({ tab: 'workshop' }));
  try {
    assert.match(m.container.textContent, /Nothing on the bench\. Snip a plate off the page/);
    assert.ok(m.container.querySelector('aside').className.includes('w-[360px]'));
  } finally { await m.unmount(); }
});

test('the tabs report a choice to the Reader instead of keeping it', async () => {
  const chosen = [];
  const m = await mount(sidebar({ tab: 'workshop', onTabChange: (t) => chosen.push(t) }));
  try {
    await act(async () => { tabButton(m.container, 'Pages').click(); });
    await act(async () => { tabButton(m.container, 'Animations').click(); });
    assert.deepEqual(chosen, ['pages', 'animations']);
    // Still the bench: the Reader, which holds the tab, has not re-rendered.
    assert.match(m.container.textContent, /Nothing on the bench/);
  } finally { await m.unmount(); }
});

test('Pages shows the pages, not the bench', async () => {
  const m = await mount(sidebar({ tab: 'pages' }));
  try {
    assert.doesNotMatch(m.container.textContent, /Nothing on the bench/);
    assert.ok(m.container.querySelector('aside').className.includes('w-60'));
  } finally { await m.unmount(); }
});

test('a remembered Workshop tab on a document with no bench falls back to Pages', async () => {
  const m = await mount(sidebar({ tab: 'workshop', workshop: null }));
  try {
    assert.doesNotMatch(m.container.textContent, /Nothing on the bench/);
    assert.equal(tabButton(m.container, 'Workshop'), undefined);
    assert.ok(m.container.querySelector('aside').className.includes('w-60'));
  } finally { await m.unmount(); }
});

// ---------------------------------------------------------------------------
// 2. The button, as source
// ---------------------------------------------------------------------------

const READER = readFileSync(new URL('../src/pages/DocumentReader.tsx', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

test('the toolbar has a Workshop button, shown where the bench exists and not on a phone', () => {
  const at = READER.indexOf('title="Workshop: snip, snippets, bring in, lay on page"');
  assert.ok(at > 0, 'the button and its tooltip');
  const block = READER.slice(READER.lastIndexOf('{workshop && ', at), at + 200);
  assert.match(block, /^\{workshop && fileKind === 'pdf' && loadState === 'ready' && !isMobile && \(/);
  // Not hidden in a pane: the sidebar toggle is, the bench button is not.
  assert.doesNotMatch(block, /hideSidebarToggle/);
  assert.match(block, /<Hammer size=\{15\} \/>\s*<span>Workshop<\/span>/);
});

test('a click opens the sidebar on the bench; a click while it shows closes it', () => {
  const at = READER.indexOf('title="Workshop: snip, snippets, bring in, lay on page"');
  const block = READER.slice(READER.lastIndexOf('{workshop && ', at), at);
  assert.match(
    block,
    /if \(sidebarOpen && sidebarTab === 'workshop'\) \{ setSidebarOpen\(false\); return; \}\s*setSidebarTab\('workshop'\);\s*setSidebarOpen\(true\);/,
  );
  assert.match(block, /sidebarOpen && sidebarTab === 'workshop' \? 'text-\[var\(--color-primary\)\]'/);
});

test('the Reader holds the sidebar tab and hands it down', () => {
  assert.match(READER, /const \[sidebarTab, setSidebarTab\] = useState<SidebarTabId>\('pages'\);/);
  assert.match(READER, /<ReaderSidebar[\s\S]*?tab=\{sidebarTab\}\s*onTabChange=\{setSidebarTab\}/);
  // The pane's sidebar state is still never saved as the reader's preference.
  assert.match(READER, /if \(pane\) return; \/\/ the pane's shut sidebar is not the reader's preference/);
});

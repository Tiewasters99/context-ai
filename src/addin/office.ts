/// <reference types="office-js" />
// The Office bridge for the Word task pane (docs/specs/WORD-ADDIN-2026-11-01.md).
//
// Everything the pane asks of Word goes through this one module, so the rest
// of the pane is plain React, and so a browser can drive it with ?mock=1 when
// Word is not around: the mock takes a .docx from a file input in place of
// getFileAsync, logs select/comment calls, and keeps the document settings in
// localStorage. tsc and the mock are how this is tested here; Word itself is
// Eden's trip (C:\Users\equai\WORD-ADDIN-INSTALL-2026-11-01.txt).

export type HostKind = 'word' | 'mock' | 'none';

export interface DocBridge {
  kind: HostKind;
  /** The document as a .docx (Office.FileType.Compressed), whole. */
  getDocxBytes(): Promise<Uint8Array>;
  /** Select the first place these words occur and scroll to it. Returns how many places there are (0 = not found). */
  selectText(words: string): Promise<number>;
  /** Put a comment on the first place these words occur. WordApi 1.4; `canComment` says whether it is there. */
  addComment(words: string, text: string): Promise<boolean>;
  /** Remove every comment on these words whose text starts with `prefix` (ours). Returns how many went. */
  removeComments(words: string, prefix: string): Promise<number>;
  canComment: boolean;
  /** Per-document settings, saved inside the file (Office.context.document.settings). */
  getSetting(name: string): string | null;
  setSetting(name: string, value: string | null): Promise<void>;
  /** The document's own name, when Word gives it. */
  fileName(): Promise<string | null>;
  /** Open a page in the person's browser (the Desk, a case) — outside the pane. */
  openUrl(url: string): void;
  /** Mock only: the file input's chosen file lands here. */
  mockSetFile?: (f: File) => void;
}

const SEARCH_MAX = 240; // Word throws over 255; leave room.

/**
 * A search string Word will take: no `^` (a code even without wildcards),
 * collapsed whitespace, and at most SEARCH_MAX characters — a distinctive
 * window from the start of the cite, which is where the case name is.
 */
export function searchWindow(words: string): string {
  const flat = words.replace(/\^/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= SEARCH_MAX) return flat;
  const cut = flat.slice(0, SEARCH_MAX);
  const sp = cut.lastIndexOf(' ');
  return sp > SEARCH_MAX / 2 ? cut.slice(0, sp) : cut;
}

// ---------------------------------------------------------------------------
// Office.js
// ---------------------------------------------------------------------------

function restoreHistory() {
  const saved = (window as unknown as { __equaziaHistory?: { pushState: History['pushState']; replaceState: History['replaceState'] } }).__equaziaHistory;
  if (!saved) return;
  // Office.js nulls both on load; MemoryRouter does not need them, but nothing
  // else in the bundle should die on a null call either.
  if (typeof history.pushState !== 'function') history.pushState = saved.pushState;
  if (typeof history.replaceState !== 'function') history.replaceState = saved.replaceState;
}

function officeAvailable(): boolean {
  return typeof (window as unknown as { Office?: unknown }).Office !== 'undefined'
    && typeof Office.onReady === 'function';
}

/** Waits for Office.onReady, or gives up after `ms` (the page is open in a plain browser). */
function waitForOffice(ms: number): Promise<Office.HostType | null> {
  return new Promise((resolve) => {
    if (!officeAvailable()) { resolve(null); return; }
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    Office.onReady((info) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      restoreHistory();
      resolve(info.host ?? null);
    });
  });
}

function getFileSlices(file: Office.File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const total = file.sliceCount;
    const parts: Uint8Array[] = [];
    let i = 0;
    const next = () => {
      if (i >= total) {
        file.closeAsync(() => {
          let size = 0;
          for (const p of parts) size += p.length;
          const out = new Uint8Array(size);
          let off = 0;
          for (const p of parts) { out.set(p, off); off += p.length; }
          resolve(out);
        });
        return;
      }
      file.getSliceAsync(i, (res) => {
        if (res.status !== Office.AsyncResultStatus.Succeeded) {
          file.closeAsync(() => reject(new Error(res.error?.message ?? 'Word could not hand over the document.')));
          return;
        }
        const data = res.value.data as unknown;
        // Word desktop gives a byte array; Word on the web has given a base64 string.
        if (typeof data === 'string') {
          const bin = atob(data);
          const u8 = new Uint8Array(bin.length);
          for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
          parts.push(u8);
        } else {
          parts.push(new Uint8Array(data as ArrayLike<number>));
        }
        i += 1;
        next();
      });
    };
    next();
  });
}

function wordBridge(): DocBridge {
  const settings = Office.context.document.settings;
  const canComment = Office.context.requirements.isSetSupported('WordApi', '1.4');
  const saveSettings = () => new Promise<void>((resolve) => settings.saveAsync(() => resolve()));

  return {
    kind: 'word',
    canComment,
    getDocxBytes: () => new Promise((resolve, reject) => {
      Office.context.document.getFileAsync(Office.FileType.Compressed, { sliceSize: 4 * 1024 * 1024 }, (res) => {
        if (res.status !== Office.AsyncResultStatus.Succeeded) {
          reject(new Error(res.error?.message ?? 'Word could not hand over the document.'));
          return;
        }
        getFileSlices(res.value).then(resolve, reject);
      });
    }),
    selectText: (words) => Word.run(async (ctx) => {
      const q = searchWindow(words);
      if (!q) return 0;
      const hits = ctx.document.body.search(q, { matchCase: true, matchWildcards: false });
      hits.load('items');
      await ctx.sync();
      if (hits.items.length === 0) return 0;
      hits.items[0].select('Select');
      await ctx.sync();
      return hits.items.length;
    }),
    addComment: (words, text) => {
      if (!canComment) return Promise.resolve(false);
      return Word.run(async (ctx) => {
        const q = searchWindow(words);
        if (!q) return false;
        const hits = ctx.document.body.search(q, { matchCase: true, matchWildcards: false });
        hits.load('items');
        await ctx.sync();
        if (hits.items.length === 0) return false;
        hits.items[0].insertComment(text);
        await ctx.sync();
        return true;
      });
    },
    removeComments: (words, prefix) => {
      if (!canComment) return Promise.resolve(0);
      return Word.run(async (ctx) => {
        const q = searchWindow(words);
        if (!q) return 0;
        const hits = ctx.document.body.search(q, { matchCase: true, matchWildcards: false });
        hits.load('items');
        await ctx.sync();
        let gone = 0;
        for (const r of hits.items) {
          const cs = r.getComments();
          cs.load('items/content');
          await ctx.sync();
          for (const c of cs.items) {
            if (c.content.startsWith(prefix)) { c.delete(); gone += 1; }
          }
        }
        await ctx.sync();
        return gone;
      });
    },
    openUrl: (url) => {
      try {
        const ui = Office.context.ui as unknown as { openBrowserWindow?: (u: string) => void };
        if (ui && typeof ui.openBrowserWindow === 'function') { ui.openBrowserWindow(url); return; }
      } catch { /* fall through */ }
      window.open(url, '_blank', 'noopener');
    },
    getSetting: (name) => {
      const v = settings.get(name) as unknown;
      return typeof v === 'string' ? v : null;
    },
    setSetting: async (name, value) => {
      if (value === null) settings.remove(name); else settings.set(name, value);
      await saveSettings();
    },
    fileName: () => new Promise((resolve) => {
      try {
        Office.context.document.getFilePropertiesAsync((res) => {
          const url = res.status === Office.AsyncResultStatus.Succeeded ? res.value?.url : null;
          if (!url) { resolve(null); return; }
          const m = /([^\\/]+)$/.exec(url);
          resolve(m ? decodeURIComponent(m[1]) : null);
        });
      } catch { resolve(null); }
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock (a browser, ?mock=1)
// ---------------------------------------------------------------------------

const MOCK_KEY = 'equazia.addin.mock.settings';

function mockBridge(): DocBridge {
  let file: File | null = null;
  const read = (): Record<string, string> => {
    try { return JSON.parse(localStorage.getItem(MOCK_KEY) ?? '{}') as Record<string, string>; } catch { return {}; }
  };
  const write = (s: Record<string, string>) => { try { localStorage.setItem(MOCK_KEY, JSON.stringify(s)); } catch { /* private window */ } };
  return {
    kind: 'mock',
    canComment: true,
    mockSetFile: (f) => { file = f; },
    getDocxBytes: async () => {
      if (!file) throw new Error('Mock: choose a .docx first.');
      return new Uint8Array(await file.arrayBuffer());
    },
    selectText: async (words) => { console.log('[mock Word] select', searchWindow(words)); return 1; },
    addComment: async (words, text) => { console.log('[mock Word] comment on', searchWindow(words), '→', text); return true; },
    removeComments: async (words, prefix) => { console.log('[mock Word] remove comments on', searchWindow(words), 'starting', prefix); return 1; },
    openUrl: (url) => { window.open(url, '_blank', 'noopener'); },
    getSetting: (name) => read()[name] ?? null,
    setSetting: async (name, value) => { const s = read(); if (value === null) delete s[name]; else s[name] = value; write(s); },
    fileName: async () => file?.name ?? null,
  };
}

// ---------------------------------------------------------------------------

/**
 * The bridge for this page: Word when Office.onReady fires with Word as the
 * host, the mock under ?mock=1, else 'none' (the page is open in a browser:
 * the pane says "open this inside Word").
 */
export async function connect(): Promise<DocBridge | { kind: 'none' }> {
  const mock = new URLSearchParams(window.location.search).get('mock') === '1';
  if (mock) return mockBridge();
  const host = await waitForOffice(4000);
  if (host !== null && officeAvailable() && host === Office.HostType.Word) return wordBridge();
  return { kind: 'none' };
}

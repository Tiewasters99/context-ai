// The account's default cover, and the switch that turns covers off.
//
// THE RULE: a surface shows its own cover if it has one, else the cover of
// its matter (walking up through parent matters), else the default cover,
// else nothing. And when covers are switched off, nothing shows anywhere.
//
// The default is the cover on the welcome page (the Dashboard has no row of
// its own, so its cover IS the default). It used to show on the Dashboard
// alone; now every page without a cover of its own carries it (Eden,
// 2026-09-23: "the default should be a persistent banner, with the option of
// per matter or even per sub-matter modification, and a clear all button").
//
// Both values are kept per device in localStorage, under the key the
// Dashboard has always used, so a cover already picked there carries over.
// Every mounted CoverImage reads them through useSyncExternalStore, so a
// change on one page is on every other at once (and in other tabs, via the
// storage event).

import { useSyncExternalStore } from 'react';

// A member of the core set (public/templates/core-covers.json), so it is a
// cover every plan is entitled to; named here rather than picked at random
// so the product looks the same in every demo and every screenshot.
export const DEFAULT_DASHBOARD_COVER = '/templates/a-board-room-with-a-long-table-1.webp';

const DEFAULT_KEY = 'cs.dashboard.cover';
// An explicit "no default" is remembered as this, rather than by deleting
// the key, which would only bring the boardroom back on reload.
const HIDDEN = 'none';
const OFF_KEY = 'cs.covers.off';

const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === DEFAULT_KEY || e.key === OFF_KEY || e.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* a blocked store costs the backdrop, nothing more */ }
  emit();
}

function getDefaultCover(): string | null {
  const raw = read(DEFAULT_KEY);
  if (raw === HIDDEN) return null;
  return raw || DEFAULT_DASHBOARD_COVER;
}

function getCoversOff(): boolean {
  return read(OFF_KEY) === '1';
}

/** The default cover (null = the person removed it). */
export function useDefaultCover(): string | null {
  return useSyncExternalStore(subscribe, getDefaultCover, () => DEFAULT_DASHBOARD_COVER);
}

export function setDefaultCover(url: string | null) {
  write(DEFAULT_KEY, url ?? HIDDEN);
}

/** True when the person has turned covers off everywhere. */
export function useCoversOff(): boolean {
  return useSyncExternalStore(subscribe, getCoversOff, () => false);
}

export function setCoversOff(off: boolean) {
  write(OFF_KEY, off ? '1' : null);
}

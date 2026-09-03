// The plates: a book with no cover of its own is given one from the
// Contextspaces template library, chosen by a stable hash of its title, so
// it looks the same tomorrow without a column to remember it in.
//
// This is the piece of the Student Hub's cover resolution that needs no
// sign-in and no Supabase — the manifest is a public static file — so the
// Reading Room (reader.html, the office's door into the Reader) can share
// it without carrying the whole hub's cover machinery into its bundle.

import { useMemo, useSyncExternalStore } from 'react';

interface Template {
  id: string;
  name: string;
  file: string;
  category: string;
}

// Of the twelve categories in the library these three read as a bound book
// at thumbnail size — literary scenes, quiet still lifes, and the Alhambra's
// arches and tilework. The rest (Tech, Fantasy, People & Life, and the travel
// sets) would furnish a shelf of law texts with the wrong century.
const COVER_CATEGORIES = new Set(['Literary', 'Still Life', 'Alhambra']);

let plates: string[] | null = null;
let loading: Promise<void> | null = null;
const watchers = new Set<() => void>();

/** Fetch the library's manifest once, keep the plates, tell anyone waiting. */
export function loadPlates(): Promise<void> {
  loading ??= fetch('/templates/manifest.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`manifest ${r.status}`))))
    .then((all: Template[]) => {
      plates = all
        .filter((t) => COVER_CATEGORIES.has(t.category))
        .map((t) => t.file)
        .sort();
    })
    // A library that will not open costs a book its plate, nothing more.
    .catch(() => { plates = []; })
    .finally(() => { watchers.forEach((w) => w()); });
  return loading;
}

export function subscribePlates(onChange: () => void): () => void {
  watchers.add(onChange);
  void loadPlates();
  return () => { watchers.delete(onChange); };
}

// A stable reference either way, so the snapshot never churns a render.
export function platesSnapshot(): string[] | null {
  return plates;
}

/** FNV-1a over the title, so a book always lands on the same plate. */
function hashTitle(title: string): number {
  const s = title.trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The plate this title always gets — null until the manifest has arrived. */
export function coverForTitle(title: string): string | null {
  if (!plates?.length) return null;
  return plates[hashTitle(title) % plates.length];
}

/** The plate for one title, re-rendering once the manifest is in hand. */
export function useTemplateCover(title: string): string | null {
  const list = useSyncExternalStore(subscribePlates, platesSnapshot);
  return useMemo(() => (list?.length ? coverForTitle(title) : null), [list, title]);
}

// Every book on the shelf shows a cover, and nothing is stored to make it so.
//
// A book whose first reading carries scanned pages shows its own first page —
// the most honest cover a scanned book can have. A book with no scan behind it
// is given a plate from the Contextspaces template library, chosen by a stable
// hash of its title: the same title always lands on the same plate, so the
// shelf looks the same tomorrow without a column to remember it in.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { supabase } from '@/lib/supabase';
import { SCAN_BUCKET, type StudyText } from '@/lib/student-hub';

interface Template {
  id: string;
  name: string;
  file: string;
  category: string;
}

// The plates a book may be given. Of the twelve categories in the library
// these three read as a bound book at thumbnail size — literary scenes, quiet
// still lifes, and the Alhambra's arches and tilework. The rest (Tech,
// Fantasy, People & Life, and the travel sets) would furnish a shelf of law
// texts with the wrong century.
const COVER_CATEGORIES = new Set(['Literary', 'Still Life', 'Alhambra']);

let plates: string[] | null = null;
let loading: Promise<void> | null = null;
const watchers = new Set<() => void>();

/** Fetch the library's manifest once, keep the plates, tell anyone waiting. */
function loadPlates(): Promise<void> {
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

function subscribePlates(onChange: () => void): () => void {
  watchers.add(onChange);
  void loadPlates();
  return () => { watchers.delete(onChange); };
}

// A stable reference either way, so the snapshot never churns a render.
function platesSnapshot(): string[] | null {
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

/**
 * Page one of each book's first scanned reading, signed for an hour: one query
 * for the readings, one signing call for the pages (as getPageUrls does).
 * Books with nothing scanned are simply absent from the map.
 */
export async function getTextCoverUrls(textIds: string[]): Promise<Map<string, string>> {
  const covers = new Map<string, string>();
  if (!textIds.length) return covers;

  const { data, error } = await supabase
    .from('student_hub_sessions')
    .select('text_id, pages, sort')
    .in('text_id', textIds)
    .not('pages', 'is', null)
    .order('sort', { ascending: true });
  if (error) throw new Error(error.message);

  // First by sort order wins; a reading filed with an empty page list is
  // passed over for the next one that actually has pages.
  const firstPage = new Map<string, string>();
  for (const row of (data ?? []) as { text_id: string | null; pages: string[] | null }[]) {
    const page = row.pages?.[0];
    if (!row.text_id || !page || firstPage.has(row.text_id)) continue;
    firstPage.set(row.text_id, page);
  }
  if (!firstPage.size) return covers;

  const ids: string[] = [];
  const paths: string[] = [];
  for (const [id, path] of firstPage) {
    ids.push(id);
    paths.push(path);
  }
  const { data: signed, error: signError } = await supabase.storage
    .from(SCAN_BUCKET)
    .createSignedUrls(paths, 3600);
  if (signError) throw new Error(signError.message);
  (signed ?? []).forEach((s, i) => {
    if (s.signedUrl) covers.set(ids[i], s.signedUrl);
  });
  return covers;
}

/**
 * A cover for every book handed in: its own first scanned page where there is
 * one, otherwise its plate from the library. A book missing from the map has
 * no cover yet — render whatever stood there before.
 */
export function useTextCovers(texts: StudyText[] | null | undefined): Map<string, string> {
  const plateList = useSyncExternalStore(subscribePlates, platesSnapshot);
  const [scans, setScans] = useState<Map<string, string>>(() => new Map());

  // The ids as one string, so the query runs when the shelf changes, not on
  // every render that hands over a fresh array.
  const ids = (texts ?? []).map((t) => t.id).join(',');
  useEffect(() => {
    if (!ids) return;
    let stale = false;
    getTextCoverUrls(ids.split(','))
      .then((m) => { if (!stale) setScans(m); })
      // A scan that cannot be signed falls back to the book's plate.
      .catch(() => { /* nothing to report on a shelf */ });
    return () => { stale = true; };
  }, [ids]);

  return useMemo(() => {
    const covers = new Map<string, string>();
    for (const t of texts ?? []) {
      const url = scans.get(t.id) ?? (plateList?.length ? coverForTitle(t.title) : null);
      if (url) covers.set(t.id, url);
    }
    return covers;
  }, [texts, scans, plateList]);
}

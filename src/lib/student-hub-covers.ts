// Every book on the shelf shows a cover — its own, whenever it has one.
//
// Resolution order: a cover the student gave the book (page one of an
// uploaded PDF, captured at upload time, or an image handed over later) wins;
// a book whose first reading carries scanned pages shows its own first page;
// a book with neither is looked up by title in the public catalogs and wears
// its real published jacket; only when the catalogs draw a blank is it given
// a plate from the Contextspaces template library, chosen by a stable hash
// of its title, so the shelf looks the same tomorrow without a column to
// remember it in.
//
// A given cover is one storage object at {uid}/covers/{textId}.jpg in the
// private scan bucket — the deterministic path IS the record, so no schema
// changes and the same RLS (038) that locks the scans locks the covers.

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

// ---------------------------------------------------------------------------
// The catalog: a book with no cover of its own is looked up by title in the
// public catalogs — Google Books first, Open Library second — and wears its
// real published jacket. Only an exact title match (or title + subtitle) is
// accepted: a shelf showing the wrong book's jacket is worse than a plate,
// so a near-miss falls through to the template library. Verdicts — jackets
// and blanks alike — are kept in localStorage, one lookup per title, ever.
// ---------------------------------------------------------------------------

const CATALOG_CACHE_KEY = 'student-hub-catalog-covers-v1';

/** A title flattened for comparison: case, accents, punctuation set aside. */
function catalogKey(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const catalog = new Map<string, string | null>(); // key -> jacket URL; null = the catalogs drew a blank
const catalogPending = new Set<string>();
const catalogWatchers = new Set<() => void>();
let catalogVersion = 0;
let catalogHydrated = false;

function hydrateCatalog(): void {
  if (catalogHydrated) return;
  catalogHydrated = true;
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY);
    if (!raw) return;
    for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
      catalog.set(k, v || null);
    }
  } catch { /* a cold cache only means the lookups run again */ }
}

function persistCatalog(): void {
  try {
    const out: Record<string, string> = {};
    for (const [k, v] of catalog) out[k] = v ?? '';
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(out));
  } catch { /* blocked storage still leaves the session cache standing */ }
}

function subscribeCatalog(onChange: () => void): () => void {
  catalogWatchers.add(onChange);
  return () => { catalogWatchers.delete(onChange); };
}
const catalogSnapshot = () => catalogVersion;

const titleMatches = (want: string, title?: string, subtitle?: string) =>
  catalogKey(title ?? '') === want ||
  catalogKey(`${title ?? ''} ${subtitle ?? ''}`) === want;

/** The jacket Google Books holds for exactly this title, if any. */
async function googleJacket(title: string, want: string): Promise<string | null> {
  const q = encodeURIComponent(`intitle:"${title}"`);
  const r = await fetch(
    `https://www.googleapis.com/books/v1/volumes?q=${q}&printType=books&maxResults=10`,
  );
  if (!r.ok) return null;
  const data = (await r.json()) as {
    items?: {
      volumeInfo?: { title?: string; subtitle?: string; imageLinks?: { thumbnail?: string } };
    }[];
  };
  for (const item of data.items ?? []) {
    const info = item.volumeInfo;
    const jacket = info?.imageLinks?.thumbnail;
    if (jacket && titleMatches(want, info?.title, info?.subtitle)) {
      return jacket.replace(/^http:/, 'https:').replace(/&edge=curl/, '');
    }
  }
  return null;
}

/** The jacket Open Library holds for exactly this title, most-published first. */
async function openLibraryJacket(title: string, want: string): Promise<string | null> {
  const q = encodeURIComponent(`title:"${title}"`);
  const r = await fetch(
    `https://openlibrary.org/search.json?q=${q}&fields=title,subtitle,cover_i&limit=20&sort=editions`,
  );
  if (!r.ok) return null;
  const data = (await r.json()) as {
    docs?: { title?: string; subtitle?: string; cover_i?: number }[];
  };
  const hit = (data.docs ?? []).find((d) => d.cover_i && titleMatches(want, d.title, d.subtitle));
  return hit?.cover_i ? `https://covers.openlibrary.org/b/id/${hit.cover_i}-L.jpg` : null;
}

/** Look a title up once; watchers hear when its verdict is in. */
function ensureCatalogCover(title: string): void {
  hydrateCatalog();
  const key = catalogKey(title);
  if (!key || catalog.has(key) || catalogPending.has(key)) return;
  catalogPending.add(key);
  void (async () => {
    let jacket: string | null = null;
    try { jacket = await googleJacket(title, key); } catch { /* quota or offline — ask the next catalog */ }
    if (!jacket) {
      try { jacket = await openLibraryJacket(title, key); } catch { /* the plate will stand in */ }
    }
    catalog.set(key, jacket);
    persistCatalog();
    catalogPending.delete(key);
    catalogVersion += 1;
    catalogWatchers.forEach((w) => w());
  })();
}

export interface TextCover {
  url: string;
  /** True when the cover is the book's own — given, not assigned. */
  custom: boolean;
}

const COVER_FOLDER = 'covers';

async function ownUid(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const uid = data.user?.id;
  if (!uid) throw new Error('Not signed in');
  return uid;
}

const coverObjectPath = (uid: string, textId: string) =>
  `${uid}/${COVER_FOLDER}/${textId}.jpg`;

/** Give a book its cover. The bucket has no UPDATE policy (038), so a
 *  replacement is a removal followed by a fresh upload. */
export async function uploadCover(textId: string, blob: Blob): Promise<void> {
  const uid = await ownUid();
  const path = coverObjectPath(uid, textId);
  await supabase.storage.from(SCAN_BUCKET).remove([path]);
  const { error } = await supabase.storage
    .from(SCAN_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw new Error(error.message);
}

/** Take a given cover back; the book returns to its scan page or plate. */
export async function removeCover(textId: string): Promise<void> {
  const uid = await ownUid();
  const { error } = await supabase.storage
    .from(SCAN_BUCKET)
    .remove([coverObjectPath(uid, textId)]);
  if (error) throw new Error(error.message);
}

/**
 * The real cover of every book that has one, signed for an hour: one listing
 * of the covers folder, one query for scanned first pages, one signing call
 * for everything found. Books with neither are simply absent from the map —
 * the caller's plate stands in.
 */
export async function getTextCoverUrls(textIds: string[]): Promise<Map<string, TextCover>> {
  const covers = new Map<string, TextCover>();
  if (!textIds.length) return covers;

  // Covers the student gave their books, found by the path alone.
  const wanted = new Set(textIds);
  const given = new Map<string, string>();
  try {
    const uid = await ownUid();
    const { data: names } = await supabase.storage
      .from(SCAN_BUCKET)
      .list(`${uid}/${COVER_FOLDER}`, { limit: 1000 });
    for (const entry of names ?? []) {
      const id = entry.name.replace(/\.jpg$/, '');
      if (id !== entry.name && wanted.has(id)) given.set(id, coverObjectPath(uid, id));
    }
  } catch { /* an unlistable folder costs the given covers, not the shelf */ }

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
    if (!row.text_id || !page || given.has(row.text_id) || firstPage.has(row.text_id)) continue;
    firstPage.set(row.text_id, page);
  }
  if (!given.size && !firstPage.size) return covers;

  const ids: string[] = [];
  const paths: string[] = [];
  const custom: boolean[] = [];
  for (const [id, path] of given) { ids.push(id); paths.push(path); custom.push(true); }
  for (const [id, path] of firstPage) { ids.push(id); paths.push(path); custom.push(false); }
  const { data: signed, error: signError } = await supabase.storage
    .from(SCAN_BUCKET)
    .createSignedUrls(paths, 3600);
  if (signError) throw new Error(signError.message);
  (signed ?? []).forEach((s, i) => {
    if (s.signedUrl) covers.set(ids[i], { url: s.signedUrl, custom: custom[i] });
  });
  return covers;
}

/**
 * A cover for every book handed in: its own given cover, else its first
 * scanned page, else its real jacket from the catalogs, else its plate from
 * the library. A book missing from the map has no cover yet — render whatever
 * stood there before. Bump `version` after giving or taking back a cover and
 * the map refreshes.
 */
export function useTextCovers(
  texts: StudyText[] | null | undefined,
  version = 0,
): Map<string, TextCover> {
  const plateList = useSyncExternalStore(subscribePlates, platesSnapshot);
  const catalogTick = useSyncExternalStore(subscribeCatalog, catalogSnapshot);
  const [own, setOwn] = useState<Map<string, TextCover>>(() => new Map());
  const [ownReady, setOwnReady] = useState(false);

  // The ids as one string, so the query runs when the shelf changes, not on
  // every render that hands over a fresh array.
  const ids = (texts ?? []).map((t) => t.id).join(',');
  useEffect(() => {
    if (!ids) return;
    let stale = false;
    setOwnReady(false);
    getTextCoverUrls(ids.split(','))
      .then((m) => { if (!stale) setOwn(m); })
      // A cover that cannot be signed falls back to the book's jacket or plate.
      .catch(() => { /* nothing to report on a shelf */ })
      .finally(() => { if (!stale) setOwnReady(true); });
    return () => { stale = true; };
  }, [ids, version]);

  // Only a book the shelf could not dress from its own pages asks the catalog.
  useEffect(() => {
    if (!ownReady) return;
    for (const t of texts ?? []) if (!own.has(t.id)) ensureCatalogCover(t.title);
  }, [ownReady, own, texts]);

  return useMemo(() => {
    const covers = new Map<string, TextCover>();
    for (const t of texts ?? []) {
      const found = own.get(t.id);
      if (found) { covers.set(t.id, found); continue; }
      const jacket = catalog.get(catalogKey(t.title));
      if (jacket) { covers.set(t.id, { url: jacket, custom: false }); continue; }
      const plate = plateList?.length ? coverForTitle(t.title) : null;
      if (plate) covers.set(t.id, { url: plate, custom: false });
    }
    return covers;
    // catalogTick names the external catalog map's version, not a value read
    // directly in this body — it is what re-runs the memo when a verdict lands.
  }, [texts, own, plateList, catalogTick]);
}

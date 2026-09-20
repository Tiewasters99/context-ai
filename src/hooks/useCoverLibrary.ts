// The cover library, already narrowed to what this account may be offered.
//
// Every picker in the app goes through this hook, so there is one place that
// knows the rule and one place to change it. The rule itself lives in
// lib/covers.ts; this only wires it to the signed-in account's plan.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  coversForPlan,
  loadCoreCovers,
  loadCoverManifest,
  resetCoverCaches,
  showsFullCoverLibrary,
  type CoverTemplate,
  type FeaturedCover,
} from '@/lib/covers';

export interface CoverLibrary {
  /** The covers this account may be offered, already filtered. */
  covers: CoverTemplate[];
  /** The eight shown before the full library is opened. */
  featured: FeaturedCover[];
  /** True while the manifest, the core list or the plan is still in flight. */
  loading: boolean;
  /** Set when the manifest itself could not be read. */
  error: string | null;
  /** Throw away the cached fetches and try again. */
  reload: () => void;
}

/** The eight Eden has always had on the picker. Workshop keeps them. */
const WORKSHOP_FEATURED: FeaturedCover[] = [
  { id: 'abstract-painting', name: 'Abstract',        file: '/templates/abstract-painting.png' },
  { id: 'alhambra-light',    name: 'Alhambra Light',  file: '/templates/alhambra-light.png' },
  { id: 'algiers-bay-day',   name: 'Algiers Bay',     file: '/templates/algiers-bay-day.png' },
  { id: 'atlantis-ruins',    name: 'Atlantis Ruins',  file: '/templates/atlantis-ruins.png' },
  { id: 'big-bang',          name: 'Big Bang',        file: '/templates/big-bang.png' },
  { id: 'boat-1',            name: 'Boat',            file: '/templates/boat-1.png' },
  { id: 'ballerina-1',       name: 'Ballerina',       file: '/templates/ballerina-1.png' },
  { id: 'alhambra-arches',   name: 'Alhambra Arches', file: '/templates/alhambra-arches.png' },
];

interface Loaded {
  attempt: number;
  all: CoverTemplate[];
  core: { files: string[]; featured: FeaturedCover[] } | null;
  error: string | null;
}

export function useCoverLibrary(): CoverLibrary {
  const { plan, planLoading } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Derived, not stored: nothing is offered until the fetches for THIS
  // attempt have landed, so a picker never shows the full library for a frame
  // and then takes it away, and Retry goes straight back to pending without a
  // second setState.
  const pending = loaded?.attempt !== attempt;
  const error = pending ? null : loaded?.error ?? null;

  useEffect(() => {
    let live = true;
    let failure: string | null = null;
    Promise.all([
      loadCoverManifest().catch((e: unknown) => {
        failure = e instanceof Error ? e.message : String(e);
        return [] as CoverTemplate[];
      }),
      loadCoreCovers(),
    ]).then(([manifest, coreData]) => {
      if (!live) return;
      setLoaded({
        attempt,
        all: manifest,
        core: coreData ? { files: coreData.core, featured: coreData.featured ?? [] } : null,
        error: failure,
      });
    });
    return () => { live = false; };
  }, [attempt]);

  const reload = useCallback(() => {
    resetCoverCaches();
    setAttempt((n) => n + 1);
  }, []);

  const all = pending ? null : loaded?.all ?? null;
  const core = pending ? null : loaded?.core ?? null;

  const coreSet = useMemo(
    () => (core ? new Set(core.files) : null),
    [core],
  );

  const covers = useMemo(
    () => coversForPlan(all ?? [], coreSet, plan, planLoading),
    [all, coreSet, plan, planLoading],
  );

  const featured = useMemo(() => {
    if (showsFullCoverLibrary(plan, planLoading)) return WORKSHOP_FEATURED;
    return core?.featured ?? [];
  }, [core, plan, planLoading]);

  return {
    covers,
    featured,
    loading: pending || planLoading,
    error,
    reload,
  };
}

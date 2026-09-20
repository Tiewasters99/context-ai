// Which cover images a picker is allowed to offer.
//
// `public/templates` holds 1,187 images — Eden's own Midjourney output, built
// up over a year of prompting for himself. It is his library and it stays
// whole: nothing here deletes, renames or re-encodes a file, and a cover
// already saved on a matter, page or document keeps rendering whatever it
// points at. What this file decides is narrower and only about the PICKER:
// **which of those images a stranger is offered when they choose a cover.**
//
// A new account is a lawyer who signed up this morning, or an investor being
// shown the product. The set they are offered is `public/templates/
// core-covers.json` — an allow-list of file paths, chosen by looking at every
// image, that suits a law practice: architecture and interiors, libraries,
// cityscapes, landscapes, skies and water, abstract and texture, still life.
// The `workshop` plan (see lib/plan.ts — Eden's own account) is offered the
// whole library, exactly as before.
//
// Two rules matter more than the list itself:
//
//   1. **Fail closed.** If the allow-list does not load, a non-workshop
//      account is offered NOTHING, never everything. A failed read must not
//      be a way in — the same rule AuthContext applies to the plan.
//   2. **Never flash the library.** While the plan is still being read the
//      answer is "core". An account that turns out to be workshop sees more a
//      moment later; an account that is not never saw more at all.
//
// To add or remove a core cover: edit `public/templates/core-covers.json` —
// one line per image path — and run `node scripts/_validate-cover-manifest.mjs`.

import type { Plan } from './plan';

export interface CoverTemplate {
  id: string;
  name: string;
  file: string;
  category: string;
}

/** The eight covers offered without opening the full library. */
export interface FeaturedCover {
  id: string;
  name: string;
  file: string;
}

export interface CoreCoverData {
  featured: FeaturedCover[];
  /** Every file path a non-workshop account may be offered. */
  core: string[];
}

export const MANIFEST_URL = '/templates/manifest.json';
export const CORE_COVERS_URL = '/templates/core-covers.json';

/**
 * Does this plan get the whole library, or the core set?
 *
 * `planLoading` wins over everything: while the plan is unknown the answer is
 * "core", so the full library never appears and then vanishes.
 */
export function showsFullCoverLibrary(plan: Plan | null, planLoading: boolean): boolean {
  if (planLoading) return false;
  return plan === 'workshop';
}

/**
 * The covers a picker may offer this account.
 *
 * `coreFiles` is null when the allow-list has not arrived or failed to load;
 * a non-workshop account then gets an empty list rather than the full one.
 */
export function coversForPlan(
  all: readonly CoverTemplate[],
  coreFiles: ReadonlySet<string> | null,
  plan: Plan | null,
  planLoading: boolean,
): CoverTemplate[] {
  if (showsFullCoverLibrary(plan, planLoading)) return [...all];
  if (!coreFiles) return [];
  return all.filter((t) => coreFiles.has(t.file));
}

/** Is this saved cover one the core set would have offered? */
export function isCoreCover(file: string | null | undefined, coreFiles: ReadonlySet<string> | null): boolean {
  return !!file && !!coreFiles && coreFiles.has(file);
}

/** FNV-1a over a name, so the same space always lands on the same cover. */
export function hashName(name: string): number {
  const s = name.trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The cover a brand-new thing is born with: a core image, picked by a stable
 * hash of its name so two people creating "Smith v. Jones" do not both get
 * cover #1, and so the same name looks the same tomorrow. Null when there is
 * no list — a space with no cover is the old behaviour and breaks nothing.
 */
export function defaultCoverFor(name: string, coreFiles: readonly string[] | null): string | null {
  if (!coreFiles?.length) return null;
  return coreFiles[hashName(name) % coreFiles.length];
}

// ── loading ───────────────────────────────────────────────────────────────
// Both files are static and immutable for the life of a deploy, so one fetch
// each per page load is plenty. A failed fetch is remembered as a failure
// (core = null) rather than retried on every picker open; the library modal
// has its own Retry, which clears the cache below.

let manifestPromise: Promise<CoverTemplate[]> | null = null;
let corePromise: Promise<CoreCoverData | null> | null = null;

export function loadCoverManifest(): Promise<CoverTemplate[]> {
  manifestPromise ??= fetch(MANIFEST_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`manifest ${r.status}`);
      return r.json() as Promise<CoverTemplate[]>;
    });
  return manifestPromise;
}

export function loadCoreCovers(): Promise<CoreCoverData | null> {
  corePromise ??= fetch(CORE_COVERS_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`core-covers ${r.status}`);
      return r.json() as Promise<CoreCoverData>;
    })
    .then((d) => (Array.isArray(d?.core) ? d : null))
    // Fail closed: null means "no core set", which offers nothing.
    .catch(() => null);
  return corePromise;
}

/** Drop the cached fetches so a Retry button actually retries. */
export function resetCoverCaches(): void {
  manifestPromise = null;
  corePromise = null;
}

// One plan value per account, and one definition of what it lets you see.
//
// Eden decided on 2026-09-19 that `profiles.pricing_tier` is the single switch
// behind the investor/new-user account, the Beta labels and (later) billing.
// One app, one deployment: no fork, no env flag, no second build. A surface is
// hidden because of the row in the database, not because of how the bundle was
// compiled.
//
// Three tiers:
//
//   core    Everyone sees it. This is the product a new account is handed.
//   frozen  Built but not ready to be met by a stranger. Hidden entirely, and
//           the route redirects to /app — no tile, no link, no deep link.
//   beta    Named but not entered. Still listed in the Productivity Suite as a
//           quiet "Beta — coming" tile that does not click through, so the
//           roadmap is visible without promising a room that isn't furnished.
//
// `workshop` is the plan that sees everything, frozen and beta included —
// Eden's own account, and the one to demo from. free / basic / pro / max all
// see the core today; when billing arrives, the difference between them
// belongs in the table and nowhere else.
//
// ── WHERE THE TABLE NOW LIVES ──────────────────────────────────────────────
//
// The list itself moved to `lib/surfaces.mjs`, one directory up and outside
// src/, because a Vercel function cannot import a .ts module from the browser
// bundle. Hiding a room was only ever half of it: `lib/entitlements.mjs` reads
// the SAME table to refuse a non-entitled account at the endpoint, and
// migration 083 carries the same core/non-core split into `plan_can_open` for
// the modules that have no endpoint of their own. Two lists would drift, and
// the day they drift is the day a stranger walks into the workshop.
//
// This file is the browser's door to that table and nothing more. Its exports
// are exactly what they were — ProductivitySuite, the Dashboard quick actions,
// covers.ts and <PlanRoute> in App.tsx read from here and did not change. To
// move a surface, change its tier in lib/surfaces.mjs.
//
// 'basic' arrived with migration 067 (billing): Eden's instinct is three paid
// price points, and 062 had left room for only two. It is a neutral INTERNAL
// key — the customer-facing name is billing_plans.display_name, which is a row
// he edits.

import {
  SURFACES as SHARED_SURFACES,
  canOpenPathname,
  canOpenSurfaceId,
  isWorkshopPlan,
  normalizePlan,
  surfaceForPathname,
  surfacePresentationFor,
} from '../../lib/surfaces.mjs';
import type { Plan, Surface, SurfaceId, SurfaceTier } from '../../lib/surfaces.mjs';

export type { Plan, Surface, SurfaceId, SurfaceTier };

export const SURFACES = SHARED_SURFACES;

export function isWorkshop(plan: Plan | null): boolean {
  return isWorkshopPlan(plan);
}

/** May an account on this plan actually open this surface? */
export function canOpenSurface(id: SurfaceId, plan: Plan | null): boolean {
  return canOpenSurfaceId(id, plan);
}

/**
 * How a surface should be presented to this plan:
 *   'open'   — show it, it works
 *   'beta'   — show it, labelled and not clickable
 *   'hidden' — do not show it at all
 */
export function surfacePresentation(
  id: SurfaceId,
  plan: Plan | null,
): 'open' | 'beta' | 'hidden' {
  return surfacePresentationFor(id, plan);
}

/** Which surface owns this route, if any. Longest prefix wins. */
export function surfaceForPath(pathname: string): SurfaceId | null {
  return surfaceForPathname(pathname);
}

/**
 * The route guard's question. A path no surface claims — the dashboard, a
 * serverspace, a matter — is always open; gating is a list of what is closed,
 * never a list of what is allowed, so a new route is reachable by default.
 */
export function canOpenPath(pathname: string, plan: Plan | null): boolean {
  return canOpenPathname(pathname, plan);
}

/** Narrow whatever came back from the profiles row; anything odd reads as free. */
export function asPlan(value: unknown): Plan {
  return normalizePlan(value);
}

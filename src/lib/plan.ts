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
// Eden's own account, and the one to demo from. free / pro / max all see the
// core today; when billing arrives, the difference between them belongs here
// and nowhere else.
//
// To move a surface, change its tier below. Nothing else in the app decides
// this: ProductivitySuite, the Dashboard quick actions and <PlanRoute> in
// App.tsx all read from this file.

// 'basic' arrived with migration 067 (billing): Eden's instinct is three paid
// price points, and 062 had left room for only two. It is a neutral INTERNAL
// key — the customer-facing name is billing_plans.display_name, which is a row
// he edits. Like free / pro / max it sees the core today; the day the tiers
// differ, that difference belongs in SURFACES below and nowhere else.
export type Plan = 'free' | 'basic' | 'pro' | 'max' | 'workshop';

export type SurfaceTier = 'core' | 'frozen' | 'beta';

export interface Surface {
  /** How this surface is treated for an account that is not on workshop. */
  tier: SurfaceTier;
  /**
   * Route prefixes this surface owns. Matched on whole path segments, so
   * '/app/m' covers '/app/m/:id' without swallowing '/app/mediation'.
   * An empty list means the surface has no route of its own (FileSaver
   * leaves the app entirely).
   */
  paths: string[];
}

export const SURFACES = {
  // ── core: the focused product every account gets ───────────────────────
  vault:        { tier: 'core',   paths: ['/app/vault'] },
  serverspaces: { tier: 'core',   paths: ['/app/serverspace', '/app/matterspace'] },
  calendar:     { tier: 'core',   paths: ['/app/calendar'] },
  bucketizer:   { tier: 'core',   paths: ['/app/bucketizer'] },
  discovery:    { tier: 'core',   paths: ['/app/discovery', '/discovery'] },
  reader:       { tier: 'core',   paths: ['/app/document'] },
  connections:  { tier: 'core',   paths: ['/app/connections'] },
  settings:     { tier: 'core',   paths: ['/app/settings'] },
  suite:        { tier: 'core',   paths: ['/app/suite'] },
  // Lists, pages and tables inside matters stay open — Eden: leave those for
  // now. They are only reachable from inside a matter anyway.
  matterPages:  { tier: 'core',   paths: ['/app/list', '/app/page', '/app/table'] },
  // Not a route: the link leaves for filesaver.ai and stays as it is.
  fileSaver:    { tier: 'core',   paths: [] },

  // ── frozen: real rooms, not ready for a stranger ───────────────────────
  office:       { tier: 'frozen', paths: ['/app/office'] },
  agents:       { tier: 'frozen', paths: ['/app/agents'] },
  mootBench:    { tier: 'frozen', paths: ['/app/moot-bench'] },
  mediation:    { tier: 'frozen', paths: ['/app/mediation'] },
  // Connect: the standalone meetings shell and the meeting view inside /app.
  connect:      { tier: 'frozen', paths: ['/connect', '/app/m'] },
  // An explicit "PLACEHOLDER … stub" (src/pages/DocumentBuilder.tsx:7-9),
  // reachable but unlinked.
  docBuilder:   { tier: 'frozen', paths: ['/app/document-builder'] },

  // ── beta: named, not entered ───────────────────────────────────────────
  editor:       { tier: 'beta',   paths: ['/app/editor'] },
  studentHub:   { tier: 'beta',   paths: ['/app/student-hub'] },
} as const satisfies Record<string, Surface>;

export type SurfaceId = keyof typeof SURFACES;

export function isWorkshop(plan: Plan | null): boolean {
  return plan === 'workshop';
}

/** May an account on this plan actually open this surface? */
export function canOpenSurface(id: SurfaceId, plan: Plan | null): boolean {
  return isWorkshop(plan) || SURFACES[id].tier === 'core';
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
  if (isWorkshop(plan)) return 'open';
  const { tier } = SURFACES[id];
  if (tier === 'core') return 'open';
  return tier === 'beta' ? 'beta' : 'hidden';
}

/** Whole-segment prefix match: '/app/m' matches '/app/m/1' but not '/app/mediation'. */
function pathOwnedBy(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Which surface owns this route, if any. Longest prefix wins. */
export function surfaceForPath(pathname: string): SurfaceId | null {
  let best: SurfaceId | null = null;
  let bestLength = -1;
  for (const id of Object.keys(SURFACES) as SurfaceId[]) {
    for (const prefix of SURFACES[id].paths as readonly string[]) {
      if (pathOwnedBy(pathname, prefix) && prefix.length > bestLength) {
        best = id;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * The route guard's question. A path no surface claims — the dashboard, a
 * serverspace, a matter — is always open; gating is a list of what is closed,
 * never a list of what is allowed, so a new route is reachable by default.
 */
export function canOpenPath(pathname: string, plan: Plan | null): boolean {
  const id = surfaceForPath(pathname);
  return id === null || canOpenSurface(id, plan);
}

const PLANS: readonly string[] = ['free', 'basic', 'pro', 'max', 'workshop'];

/** Narrow whatever came back from the profiles row; anything odd reads as free. */
export function asPlan(value: unknown): Plan {
  return typeof value === 'string' && PLANS.includes(value) ? (value as Plan) : 'free';
}

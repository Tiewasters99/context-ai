// Types for lib/surfaces.mjs — the shared surface table.
//
// The browser bundle imports that module through src/lib/plan.ts, the same way
// src/ already imports lib/ingest-formats.mjs and lib/usage-prices.mjs. The
// keys below are spelled out one by one on purpose: `SurfaceId` is
// `keyof typeof SURFACES`, and the Dashboard and the Productivity Suite key
// their entries on it, so a surface that exists in the .mjs and not here would
// be invisible to the type checker. scripts/_verify-entitlements.mjs compares
// the two lists and fails CI on any difference.

export type Plan = 'free' | 'basic' | 'pro' | 'max' | 'workshop';

export type SurfaceTier = 'core' | 'frozen' | 'beta';

export type EnforcementExemption = 'core-open' | 'public-by-design' | 'front-end-only';

/** How the SERVER holds this surface shut. See the header of surfaces.mjs. */
export interface SurfaceEnforcement {
  /** Handlers that call requireEntitlement(uid, '<this surface>') after auth. */
  readonly endpoints: readonly string[];
  /** Tables whose INSERT migration 083 fences with public.plan_can_open. */
  readonly tables: readonly string[];
  /** A written reason there is no gate, where there honestly is none. */
  readonly exempt?: EnforcementExemption;
  /** Why the line above is true. Required wherever `exempt` is used. */
  readonly note: string;
}

export interface Surface {
  /** How this surface is treated for an account that is not on workshop. */
  readonly tier: SurfaceTier;
  /**
   * Route prefixes this surface owns. Matched on whole path segments, so
   * '/app/m' covers '/app/m/:id' without swallowing '/app/mediation'.
   * An empty list means the surface has no route of its own (FileSaver
   * leaves the app entirely).
   */
  readonly paths: readonly string[];
  readonly enforcement: SurfaceEnforcement;
}

export declare const PLANS: readonly Plan[];
export declare const SURFACE_TIERS: readonly SurfaceTier[];
export declare const ENFORCEMENT_EXEMPTIONS: readonly EnforcementExemption[];

export declare const SURFACES: {
  readonly vault: Surface;
  readonly serverspaces: Surface;
  readonly calendar: Surface;
  readonly bucketizer: Surface;
  readonly discovery: Surface;
  readonly reader: Surface;
  readonly connections: Surface;
  readonly settings: Surface;
  readonly suite: Surface;
  readonly matterPages: Surface;
  readonly fileSaver: Surface;
  readonly office: Surface;
  readonly agents: Surface;
  readonly mootBench: Surface;
  readonly mediation: Surface;
  readonly connect: Surface;
  readonly docBuilder: Surface;
  readonly editor: Surface;
  readonly studentHub: Surface;
};

export type SurfaceId = keyof typeof SURFACES;

export declare function isWorkshopPlan(plan: Plan | null): boolean;
export declare function canOpenSurfaceId(id: SurfaceId, plan: Plan | null): boolean;
export declare function surfacePresentationFor(
  id: SurfaceId,
  plan: Plan | null,
): 'open' | 'beta' | 'hidden';
export declare function surfaceForPathname(pathname: string): SurfaceId | null;
export declare function canOpenPathname(pathname: string, plan: Plan | null): boolean;
export declare function normalizePlan(value: unknown): Plan;

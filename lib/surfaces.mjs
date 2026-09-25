// THE SURFACE TABLE — one list, read by the browser and by the server.
//
// Why this file is not in src/
// ---------------------------------------------------------------------------
// `src/lib/plan.ts` decided what a plan may SEE. Nothing decided what a plan
// may DO: every /api/* handler authenticated the caller and then served them,
// whatever their plan, so a frozen room was hidden by the bundle and wide open
// to `curl`. Hidden has to mean locked, and locked has to be decided on the
// server — which cannot import a .ts module from src/.
//
// So the table lives here, framework-free ESM with no imports of its own, and
// BOTH sides read it:
//
//   browser   src/lib/plan.ts re-exports it (its public API is unchanged, so
//             <PlanRoute>, the Suite, the Dashboard and covers.ts are
//             untouched) — the same way src/ already imports
//             lib/ingest-formats.mjs and lib/usage-prices.mjs.
//   server    lib/entitlements.mjs answers requireEntitlement() from it, and
//             supabase/migrations/083 carries the same core/non-core split
//             into `public.plan_can_open` for the modules that have no
//             endpoint of their own.
//
// A client and a server that keep two lists eventually disagree, and the day
// they disagree is the day a paying stranger walks into the workshop. There is
// one list. scripts/_verify-entitlements.mjs fails the build if 083, the .d.mts
// or any declared enforcement drifts from it.
//
// Three tiers, unchanged from the file this was lifted out of:
//
//   core    Everyone sees it. This is the product a new account is handed.
//   frozen  Built but not ready to be met by a stranger. Hidden entirely, and
//           the route redirects to /app — no tile, no link, no deep link.
//   beta    Named but not entered. Still listed in the Productivity Suite as a
//           quiet "Beta — coming" tile that does not click through.
//
// `workshop` is the plan that sees everything, frozen and beta included —
// Eden's own account, and the one to demo from.
//
// ── `enforcement`: how the SERVER holds each surface shut ───────────────────
//
// Every surface must say which of these keeps a non-entitled account out, and
// the static half of scripts/_verify-entitlements.mjs checks the claim rather
// than taking it:
//
//   endpoints[]  API handlers that call requireEntitlement(uid, '<this id>')
//                right after authenticating. The test greps each named file
//                for that call with this surface's id.
//   tables[]     Tables whose INSERT is fenced by `public.plan_can_open` in
//                migration 083, so a non-entitled account cannot START
//                anything there. The test greps 083 for each table name.
//   exempt       A written reason there is no gate. Only these are accepted:
//                  'core-open'        tier is core — every plan may open it,
//                                     so there is nothing to enforce.
//                  'public-by-design' the endpoint is meant to answer a
//                                     stranger (The Office's published shelf).
//                  'front-end-only'   honest admission: hidden in the bundle,
//                                     with no server surface of its own to
//                                     lock. `note` must say why that is safe.
//
// A new frozen or beta surface with none of the three fails CI. That is the
// point of the field: the next hidden room cannot ship unlocked in silence.

/** The plan values `profiles.pricing_tier` may hold (062 + 067). */
export const PLANS = ['free', 'basic', 'pro', 'max', 'workshop'];

/** The tiers a surface may be filed under. */
export const SURFACE_TIERS = ['core', 'frozen', 'beta'];

/** The exemption words `enforcement.exempt` may use. Anything else fails CI. */
export const ENFORCEMENT_EXEMPTIONS = ['core-open', 'public-by-design', 'front-end-only'];

/** Shorthand for the commonest declaration: a core surface has nothing to lock. */
const coreOpen = (note) => ({ endpoints: [], tables: [], exempt: 'core-open', note });

export const SURFACES = {
  // ── core: the focused product every account gets ───────────────────────
  vault: {
    tier: 'core',
    paths: ['/app/vault'],
    enforcement: coreOpen('Core. /api/ingest and /api/llm still meter every account.'),
  },
  serverspaces: {
    tier: 'core',
    paths: ['/app/serverspace', '/app/matterspace'],
    enforcement: coreOpen('Core. Matter isolation is RLS, not a plan.'),
  },
  calendar: {
    tier: 'core',
    paths: ['/app/calendar'],
    enforcement: coreOpen('Core. Rows are the caller’s own under RLS (053).'),
  },
  bucketizer: {
    tier: 'core',
    paths: ['/app/bucketizer'],
    enforcement: coreOpen('Core. Every classify pass is metered through /api/llm.'),
  },
  discovery: {
    tier: 'core',
    paths: ['/app/discovery', '/discovery'],
    enforcement: coreOpen('Core. Productions are matter-scoped under RLS (030).'),
  },
  reader: {
    tier: 'core',
    paths: ['/app/document'],
    enforcement: coreOpen('Core. Reads what the caller may already read.'),
  },
  connections: {
    tier: 'core',
    paths: ['/app/connections'],
    enforcement: coreOpen('Core. Tokens are server-only columns (080).'),
  },
  settings: {
    tier: 'core',
    paths: ['/app/settings'],
    enforcement: coreOpen('Core. pricing_tier itself is service-role-only (062).'),
  },
  suite: {
    tier: 'core',
    paths: ['/app/suite'],
    enforcement: coreOpen('Core. The Suite is a menu; each tile is gated on its own.'),
  },
  // Lists, pages and tables inside matters stay open — Eden: leave those for
  // now. They are only reachable from inside a matter anyway.
  matterPages: {
    tier: 'core',
    paths: ['/app/list', '/app/page', '/app/table'],
    enforcement: coreOpen('Core. Reachable only from inside a matter the caller may open.'),
  },
  // Not a route: the link leaves for filesaver.ai and stays as it is.
  fileSaver: {
    tier: 'core',
    paths: [],
    enforcement: coreOpen('Core, and not this deployment: the link leaves for filesaver.ai.'),
  },
  // The Agents page (2026-09-25): every connected AI and every task handed to
  // one, across all matters. Not the frozen `agents` surface below — that is
  // the in-app agent-charters workshop, and it stays frozen. Eden (09-24):
  // agents are for customers, so this is core. Migration 089 adds the id to
  // plan_can_open's core list.
  agentTasks: {
    tier: 'core',
    paths: ['/app/agent-tasks'],
    enforcement: coreOpen('Core. Tasks are owner-only under RLS (085, 089); the seal and pause hold in /api/mcp.'),
  },

  // ── frozen: real rooms, not ready for a stranger ───────────────────────
  office: {
    tier: 'frozen',
    paths: ['/app/office'],
    enforcement: {
      endpoints: [],
      tables: [],
      exempt: 'public-by-design',
      note:
        'api/office.mjs answers ONE configured owner’s published shelf to anyone, '
        + 'signed in or not — that is the feature (hardened in PR #156). The frozen '
        + 'tier hides the AUTHORING room at /app/office; the published shelf is not a '
        + 'room and has no plan to check.',
    },
  },
  agents: {
    tier: 'frozen',
    paths: ['/app/agents'],
    enforcement: {
      endpoints: ['api/assistant.mjs'],
      tables: ['agent_charters'],
      note:
        'api/assistant.mjs gates the surface when the turn names a charterId — a '
        + 'charter IS the Agents surface, and a request without one is the core '
        + 'Assistant, which every plan gets. 083 is the real lock: without a charter '
        + 'row there is no charterId to send.',
    },
  },
  mootBench: {
    tier: 'frozen',
    paths: ['/app/moot-bench'],
    enforcement: {
      endpoints: [],
      tables: ['argument_prep_sessions'],
      note:
        'No endpoint of its own: Moot Bench runs on /api/llm, which cannot be gated on '
        + 'a client-sent feature label. 083 refuses the INSERT that starts a session.',
    },
  },
  mediation: {
    tier: 'frozen',
    paths: ['/app/mediation'],
    enforcement: {
      endpoints: ['api/mediation.mjs'],
      tables: [],
      note:
        'Gated where a mediation BEGINS (cases.create / join), so a case already on '
        + 'foot can be finished. api/mediation-webhook.mjs is called by Stripe, not by '
        + 'a person, and is deliberately not gated. Every runMediator call is metered.',
    },
  },
  // Connect: the standalone meetings shell and the meeting view inside /app.
  connect: {
    tier: 'frozen',
    paths: ['/connect', '/app/m'],
    enforcement: {
      endpoints: ['api/meeting-chat.mjs', 'api/meeting-flag.mjs', 'api/deepgram-token.mjs'],
      tables: [],
      note:
        'These three are Connect’s and nothing else’s: src/pages/MeetingView.tsx and '
        + 'src/lib/meetings/deepgram.ts are their only callers (the Student Hub’s '
        + '"group video" opens an external room and touches none of them).',
    },
  },
  // An explicit "PLACEHOLDER … stub" (src/pages/DocumentBuilder.tsx:7-9),
  // reachable but unlinked.
  docBuilder: {
    tier: 'frozen',
    paths: ['/app/document-builder'],
    enforcement: {
      endpoints: [],
      tables: [],
      exempt: 'front-end-only',
      note:
        'A placeholder stub that calls no endpoint and writes no row. There is nothing '
        + 'on the server to lock. The day it grows one, this entry has to change or CI '
        + 'has been told a lie.',
    },
  },

  // ── beta: named, not entered ───────────────────────────────────────────
  editor: {
    tier: 'beta',
    paths: ['/app/editor'],
    enforcement: {
      endpoints: [],
      tables: [],
      exempt: 'front-end-only',
      note:
        'The Editor has no endpoint and no table of its own: it edits documents and '
        + 'content_items the caller already owns under RLS, and its passes go through '
        + '/api/llm, which meters and matter-gates every account. So the plan hides the '
        + 'room; it does not add a lock, because there is no separate door.',
    },
  },
  studentHub: {
    tier: 'beta',
    paths: ['/app/student-hub'],
    enforcement: {
      endpoints: ['api/student-hub-ocr.mjs', 'api/student-hub-invite.mjs'],
      tables: ['student_hub_sessions', 'student_hub_texts', 'student_hub_groups'],
      note:
        'Both endpoints gate after authenticating; 083 fences the three root tables, so '
        + 'a non-entitled account cannot open a text, start a session or form a group.',
    },
  },
};

/** Eden's own plan: sees and may open everything. */
export function isWorkshopPlan(plan) {
  return plan === 'workshop';
}

/** May an account on this plan actually open this surface? */
export function canOpenSurfaceId(id, plan) {
  const surface = SURFACES[id];
  if (!surface) return true; // an unknown id is not a closed door — see canOpenPathname
  return isWorkshopPlan(plan) || surface.tier === 'core';
}

/**
 * How a surface should be presented to this plan:
 *   'open'   — show it, it works
 *   'beta'   — show it, labelled and not clickable
 *   'hidden' — do not show it at all
 */
export function surfacePresentationFor(id, plan) {
  if (isWorkshopPlan(plan)) return 'open';
  const tier = SURFACES[id]?.tier;
  if (tier === 'core') return 'open';
  return tier === 'beta' ? 'beta' : 'hidden';
}

/** Whole-segment prefix match: '/app/m' matches '/app/m/1' but not '/app/mediation'. */
function pathOwnedBy(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Which surface owns this route, if any. Longest prefix wins. */
export function surfaceForPathname(pathname) {
  let best = null;
  let bestLength = -1;
  for (const id of Object.keys(SURFACES)) {
    for (const prefix of SURFACES[id].paths) {
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
export function canOpenPathname(pathname, plan) {
  const id = surfaceForPathname(pathname);
  return id === null || canOpenSurfaceId(id, plan);
}

/** Narrow whatever came back from the profiles row; anything odd reads as free. */
export function normalizePlan(value) {
  return typeof value === 'string' && PLANS.includes(value) ? value : 'free';
}

// The seal on /api/ext/* — the browser extension's three routes (S1b, 098)
// -----------------------------------------------------------------------------
// /api/ext/matters, /api/ext/documents and /api/ext/push-to-drive authenticate
// a pasted csp_ connector token and then read as the user through a JWT our
// own server signs (lib/supabase-user-jwt.mjs). That JWT carries
// cs_via:'connector', which migration 094's second-factor gate deliberately
// lets through, because every connector path is supposed to be governed by
// the seal in code — lib/mcp-core.mjs hides sealed matters from list_matters
// and refuses any tool call that names one.
//
// These three routes were the exception. Their 2026-09-20 headers chose to
// MARK sealed matters rather than refuse them ("the extension is the user's
// own tool"), and push-to-drive let the body's confirm_leave_seal carry a
// sealed document's bytes to Google. The #245 review showed what that means
// when the token is not the user's own: anyone who has the password can make a
// token at the Connect page (at aal1, before 098) and use these three routes
// to list a sealed matter's documents and push its files to their own Drive —
// a confirmation typed by the attacker is no confirmation at all.
//
// So the extension now obeys the seal exactly as an MCP connector does:
//   * a sealed matter is not listed;
//   * a sealed matter's documents are not listed, and a sealed document is
//     not pushed, confirmed or not — refused with the seal's sentence and a
//     `tool.invoked {refused:'sealed', connector:true}` row in the matter's
//     Record, which is what S5's tripwires count;
//   * the seal is resolved with the SERVICE ROLE (an ancestor the user cannot
//     see still seals its children) and fails CLOSED: a seal that cannot be
//     read refuses rather than lists.
// Sealed work is done in Contextspaces itself, where the web app's own export
// gate asks, per copy, and records what left.
//
// Membership is still asked first, as the user: a matter or document the
// person cannot reach is "not found" whether or not it is sealed, so these
// routes are not an oracle for which ids are sealed.

import { record } from './ledger.mjs';

const DEDUPE_MS = 60_000;

export const EXT_SEALED_ERROR = 'sealed_matter';
export const EXT_SEALED_MESSAGE =
  'That matter is sealed (SecureSpace). Sealed matters are not available to connected ' +
  'apps, including the browser extension. Open it in Contextspaces.';

/** The body every refusal carries. */
export function sealedRefusal() {
  return { error: EXT_SEALED_ERROR, message: EXT_SEALED_MESSAGE };
}

/**
 * The Record row for a refusal, on the sealed matter's own chain. Best effort,
 * like every tool.invoked row: the Record is never the reason a request fails.
 * Metadata only — the route, the ids, and that the seal refused it. At most
 * one row per person, matter and route per minute.
 */
export async function recordExtRefusal(supabase, { route, matterId, documentId = null, userId = null, recorder = record }) {
  if (!matterId) return;
  try {
    // One row per (person, matter, route) per minute. A csp_ token costs
    // nothing to replay, and every refusal is a hash-chained row nobody can
    // delete: without this a member could fill a sealed matter's Record with
    // refusals and bury what S5 looks for. The check reads the Record itself
    // (the connector JWT can, as the actor), so it needs no new table; if the
    // read fails, the row is written — a duplicate is better than a gap.
    if (userId) {
      const since = new Date(Date.now() - DEDUPE_MS).toISOString();
      const { data: recent, error } = await supabase
        .from('events')
        .select('id')
        .eq('kind', 'tool.invoked')
        .eq('matterspace_id', matterId)
        .eq('actor_user_id', userId)
        .eq('payload->>tool', route)
        .gte('ts', since)
        .limit(1);
      if (!error && Array.isArray(recent) && recent.length > 0) return;
    }
    await recorder(supabase, {
      kind: 'tool.invoked',
      matterId,
      actor: { kind: 'connector', ref: 'browser-extension', label: 'Contextspaces browser extension' },
      payload: {
        tool: route,
        args: {},
        document_ids: documentId ? [documentId] : [],
        connector: true,
        ok: false,
        refused: 'sealed',
      },
    });
  } catch {
    // never the reason the request fails
  }
}

// SecureSpace — the seal on a MEETING (2026-09-19)
// -----------------------------------------------------------------------------
// A meeting is the rawest thing in the product: a verbatim transcript of what
// was said in the room, assembled live. Two routes send it to a model —
// /api/meeting-chat (the user asks a question with the transcript attached) and
// /api/meeting-flag (a background timer that rescans the whole transcript every
// 90 seconds, unprompted). Both speak to first-party Anthropic.
//
// Until 2026-09-19 neither consulted the tier policy. Both read the tier, and
// both used it only to refuse Tier C: a Tier-B (SEALED) meeting set a flag that
// dropped the `web_search` tool and then sent the transcript to
// api.anthropic.com anyway, with no escalation flag and nothing written to the
// record. That is the same silent escape PR #159 closed on every other route,
// and narrowing TIER_PROVIDERS.B could not reach it, because this path never
// asked.
//
// This module is where it asks. One function, used by both routes, so that a
// third meeting surface cannot quietly grow its own answer:
//
//   * The decision comes from providerAllowed() — the SAME function the
//     /api/llm gate calls. There is no second policy here and no second
//     allowlist; when Eden changes what a tier admits, meetings change with it.
//   * A refusal happens BEFORE any provider client is constructed, so the
//     promise a refusal makes ("nothing was sent") is true of the process and
//     not just of the prose.
//   * Fail closed, in the register of lib/seal-pipes.mjs: anything that is not
//     a definite "open" is closed. An unreadable tier, a meeting row that does
//     not resolve, a lookup that throws — refuse. The one case that legitimately
//     passes is a meeting bound to NO matter (an ad-hoc recording on the
//     dashboard): there is no seal to violate, which is the same rule /api/llm
//     applies to an unbound draft.
//
// What it costs, stated plainly: a sealed matter has no meeting assistant and
// no background flagging. It is not a degraded one — it is none, and the user
// is told so in a sentence. Live transcription is already refused for the same
// matters (api/deepgram-token.mjs, through lib/seal-pipes.mjs), so the sealed
// meeting room is: record it, ingest it later through a sealed route. A
// transcript typed or captured while the matter was Tier A and sealed
// afterwards is exactly the case this closes — the seal is prospective about
// what has already left, but it governs every send from now on.

import { isSealedTier, matterTierWithClient, providerAllowed } from './ai-tier-policy.mjs';

/**
 * What the user is told. The voice is SealedPipeError's (lib/seal-pipes.mjs)
 * and choosePen's: name the step, say what was and was not sent, say what would
 * unblock it. No product ever shows the code — the code is for the client and
 * the logs, the sentence is for the person in the meeting.
 */
export function meetingRefusalMessage(tier) {
  if (tier === 'C') {
    return (
      'This meeting is in a Silo matter (SecureSpace Tier C): nothing may leave the building, ' +
      'and the Silo appliance is not connected yet. Nothing was sent — no model saw the ' +
      'transcript. The meeting itself keeps running and stays recorded.'
    );
  }
  if (tier === 'B') {
    return (
      'This meeting is in a sealed matter (SecureSpace Tier B), and the meeting assistant runs ' +
      'on a model outside the seal. Nothing was sent: the transcript did not leave the room and ' +
      'no provider was asked. The meeting itself keeps running and stays recorded — unseal the ' +
      'matter to use the meeting assistant, or wait for a sealed route for meetings.'
    );
  }
  return (
    'This meeting belongs to a matter whose seal could not be read, so nothing was sent — a ' +
    'matter is treated as sealed until its tier is known. The meeting itself keeps running and ' +
    'stays recorded. Try again in a moment; if it keeps failing, the matter needs attention.'
  );
}

/**
 * May this meeting's content go to `provider`?
 *
 *   supabase  — the USER-SCOPED client (RLS applies: a meeting the caller
 *               cannot see does not resolve, and is therefore refused).
 *   meetingId — meetings.id from the client. Absent means an unbound session.
 *   provider  — the provider the route is about to call ('anthropic' today).
 *
 * Resolves to one of:
 *   { ok: true,  tier, sealed, matterId }  — send, and `sealed` says whether
 *                                            the matter is nonetheless B/C.
 *   { ok: false, status, code, tier, message } — refuse, and tell them this.
 *
 * `sealed` on an `ok` result is not redundant: if a zero-retention arrangement
 * ever puts a first-party provider back into Tier B's set (the Anthropic
 * org-level ZDR request of 2026-09-18), the model call becomes permitted while
 * a tool that queries the open web does not. The caller keeps that distinction.
 */
export async function meetingModelDecision(supabase, meetingId, { provider } = {}) {
  const open = (tier, matterId) => ({ ok: true, tier: tier ?? null, sealed: isSealedTier(tier), matterId: matterId ?? null });
  const refuse = (tier, code = 'tier_violation') => ({
    ok: false, status: 403, code, tier: tier ?? null, message: meetingRefusalMessage(tier),
  });

  // No meeting id: nothing binds this text to a matter (the same unbound case
  // /api/llm passes through). The routes that care send one.
  if (!meetingId) return open(null, null);

  // meetings.matterspace_id (migration 019) is the binding. A row that errors,
  // or that RLS does not return, leaves us unable to read a seal — so we do not
  // send. This is deliberately stricter than the code it replaces, which
  // treated an unreadable meeting as unbound and proceeded.
  let meeting = null;
  try {
    const { data, error } = await supabase
      .from('meetings').select('matterspace_id').eq('id', meetingId).maybeSingle();
    if (!error) meeting = data;
  } catch {
    meeting = null; // a client that throws is not an open door either
  }
  if (!meeting) return refuse(null, 'meeting_unresolved');
  if (!meeting.matterspace_id) return open(null, null);

  let tier = null;
  try {
    tier = await matterTierWithClient(supabase, meeting.matterspace_id);
  } catch {
    tier = null; // a lookup that throws is not an open door
  }
  if (!tier) return refuse(null);
  if (!providerAllowed(tier, provider)) return refuse(tier);
  return open(tier, meeting.matterspace_id);
}

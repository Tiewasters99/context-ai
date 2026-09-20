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
// What this costs, stated plainly — and what it no longer costs (2026-09-20).
// This module still answers ONE question: may this meeting's content go to
// THIS provider? For 'anthropic' on a sealed matter the answer is no, and it
// stays no. What changed is what the caller does with that no:
//
//   * /api/meeting-chat now hands the refusal to the SEALED PEN — Kimi K2.5 in
//     our own AWS account, through the Assistant's own agentic harness
//     (lib/meeting-sealed-chat.mjs), per Eden's decision of 2026-09-20. The
//     transcript still never reaches a provider outside the seal; it reaches
//     the one inside it. A refusal reaching the user now means the sealed pen
//     itself is unavailable or failed, in its own words.
//   * /api/meeting-flag stays refused and quiet. It runs on a 90-second timer
//     nobody asked for, and a decision about answering a question a person asks
//     is not a licence to start feeding every sealed transcript segment to a
//     model unprompted. That is a separate decision, and it is Eden's.
//
// Live transcription remains refused for the same matters
// (api/deepgram-token.mjs, through lib/seal-pipes.mjs). A transcript typed or
// captured while the matter was Tier A and sealed afterwards is exactly the
// case this closes — the seal is prospective about what has already left, but
// it governs every send from now on.

import { isSealedTier, matterTierWithClient, providerAllowed } from './ai-tier-policy.mjs';

/**
 * What the user is told. The voice is SealedPipeError's (lib/seal-pipes.mjs)
 * and choosePen's: name the step, say what was and was not sent, say what would
 * unblock it. No product ever shows the code — the code is for the client and
 * the logs, the sentence is for the person in the meeting.
 */
export function meetingRefusalMessage(tier, { sealedChat = true } = {}) {
  if (tier === 'C') {
    return (
      'This meeting is in a Silo matter (SecureSpace Tier C): nothing may leave the building, ' +
      'and the Silo appliance is not connected yet. Nothing was sent — no model saw the ' +
      'transcript. The meeting itself keeps running and stays recorded.'
    );
  }
  if (tier === 'B') {
    // 2026-09-20: this sentence is now the FLAGGING surface's, because chat on
    // a sealed meeting is no longer refused — it is answered by the sealed pen
    // (lib/meeting-sealed-chat.mjs). Automatic flagging still does not run: it
    // scans the whole transcript on a timer that nobody asked for, and Eden's
    // decision covers the question a person asks. `sealedChat: false` drops the
    // closing offer for the one case where there is no sealed route to offer —
    // a policy that has stopped admitting aws-bedrock on Tier B.
    const base =
      'This meeting is in a sealed matter (SecureSpace Tier B), and background flagging runs ' +
      'unprompted against the whole transcript, so it does not run inside the seal. Nothing was ' +
      'sent: the transcript did not leave the room and no provider was asked. The meeting itself ' +
      'keeps running and stays recorded';
    return sealedChat
      ? `${base} — and asking a question is different: put it to the meeting assistant and the ` +
        'sealed pen answers it inside the seal.'
      : `${base}, and the sealed pen is not available on this server, so nothing answers here ` +
        'until it is — or until the matter is unsealed.';
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
  // `matterId` travels on a REFUSAL too (2026-09-20). A sealed meeting is no
  // longer the end of the road — /api/meeting-chat hands a Tier-B refusal to
  // the sealed pen, and the pen needs to know which matter it is working in to
  // scope its tools and to open the right ledger row.
  const refuse = (tier, code = 'tier_violation', matterId = null) => ({
    ok: false, status: 403, code, tier: tier ?? null, matterId, message: meetingRefusalMessage(tier),
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
  if (!tier) return refuse(null, 'tier_violation', meeting.matterspace_id);
  if (!providerAllowed(tier, provider)) return refuse(tier, 'tier_violation', meeting.matterspace_id);
  return open(tier, meeting.matterspace_id);
}

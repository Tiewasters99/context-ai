// POST /api/student-hub-invite  { groupId, email }
//
// Sends one study-group invitation. A Student Hub group holds six people —
// the person who formed it and five invitees (GROUP_CAP in
// src/lib/student-hub-groups.ts), and that person admits and removes the
// others — no site administrator sits in the middle. The seat row itself is
// written client-side under RLS before this call; all this endpoint does is
// tell the person their seat is waiting.
//
// Auth: a Supabase session JWT identifies the caller. The privileged work
// then runs with the service role, but only after the caller's own identity
// has been checked against two facts:
//   1. the caller formed this group (student_hub_groups.created_by), and
//   2. the address already holds an UNCLAIMED seat in that group
//      (student_hub_group_members row with user_id still null).
// So this endpoint can only ever mail someone the group's own owner has
// already given a seat to — it is not a general mail sender.
//
// Two things were missing until 2026-09-21, and they were the same thing twice:
//
//   1. The Student Hub is a BETA surface (lib/surfaces.mjs) — named in the
//      Suite, not entered. This endpoint served any signed-in account.
//   2. An UNCLAIMED seat could be re-invited without limit. Both checks above
//      pass every time while the seat stays unclaimed, so one seat was an
//      unmetered, un-rate-limited mail button aimed at an address of the
//      caller's choosing — our Resend reputation, someone else's inbox.
//
// So: requireEntitlement() right after the session is verified, and a counted
// cap (migration 083, `student_hub_invite_charge`) charged immediately before
// the mail goes out — three sends per seat and twenty per owner in a rolling
// 24 hours, counted in the database because Vercel has no shared memory.
//
// Response:
//   200 { ok: true }
//   400 { error: 'bad_request', detail }      malformed body
//   401 { error: 'missing_bearer' | 'invalid_session' }
//   403 { error: 'not_in_plan' }              the Student Hub is not in this plan
//   403 { error: 'not_group_owner' | 'not_an_invited_seat' | 'seat_already_claimed' }
//   404 { error: 'group_not_found' }
//   429 { error: 'invite_seat_cap' | 'invite_daily_cap' | 'invite_cap_unavailable' }
//   501 { error: 'email_not_configured' }     no RESEND_API_KEY yet
//   502 { error: 'send_failed', detail }      Resend refused or was unreachable
//   503 { error: 'plan_unreadable' }          the plan could not be read twice
//
// Env on Vercel:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//   RESEND_API_KEY, RESEND_FROM (optional override of the From line)

import { createClient } from '@supabase/supabase-js';

import { requireEntitlement, sendEntitlementRefusal } from '../lib/entitlements.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DEFAULT_FROM = 'Contextspaces Student Hub <invites@contextspaces.ai>';
const HUB_URL = 'https://www.contextspaces.ai/app/student-hub';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Deliberately loose: the address only has to be shaped like one. The real
// test is whether it already holds a seat in this group.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_KEY) {
    return json(res, 500, { error: 'supabase_env_missing' });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = authHeader.slice(7).trim();
  const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await asUser.auth.getUser();
  if (userErr || !userData?.user) return json(res, 401, { error: 'invalid_session' });
  const caller = userData.user;

  // The plan, read on the server from the caller's own profiles row — never
  // from anything the request said about itself.
  const gate = await requireEntitlement(caller.id, 'studentHub', { bearer: userToken });
  if (!gate.ok) return sendEntitlementRefusal(res, gate);

  const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!UUID_RE.test(groupId)) return json(res, 400, { error: 'bad_request', detail: 'groupId must be a uuid' });
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'bad_request', detail: 'email required' });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: group, error: gErr } = await admin
    .from('student_hub_groups')
    .select('id, name, text_id, created_by')
    .eq('id', groupId)
    .maybeSingle();
  if (gErr) return json(res, 500, { error: 'lookup_failed', detail: gErr.message });
  if (!group) return json(res, 404, { error: 'group_not_found' });
  // The caller must be the person who formed the group. Everything below
  // rides on this check.
  if (group.created_by !== caller.id) return json(res, 403, { error: 'not_group_owner' });

  const { data: seat, error: mErr } = await admin
    .from('student_hub_group_members')
    .select('email, user_id')
    .eq('group_id', groupId)
    .ilike('email', email)
    .maybeSingle();
  if (mErr) return json(res, 500, { error: 'lookup_failed', detail: mErr.message });
  if (!seat) return json(res, 403, { error: 'not_an_invited_seat' });
  if (seat.user_id) return json(res, 403, { error: 'seat_already_claimed' });

  // The text the group reads together — named in the invitation so the
  // person can tell at a glance what they are being asked to join.
  let textTitle = '';
  if (group.text_id) {
    const { data: text } = await admin
      .from('student_hub_texts')
      .select('title')
      .eq('id', group.text_id)
      .maybeSingle();
    textTitle = text?.title || '';
  }

  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  // The seat exists either way — it was written before this call. Without a
  // key we simply cannot announce it, and the caller says so in the panel.
  if (!apiKey) return json(res, 501, { error: 'email_not_configured' });

  // ── The cap, charged before the mail goes out ────────────────────────────
  //
  // Counted and recorded inside one transaction by migration 083: two requests
  // landing on two Vercel instances cannot both read "none sent yet". The row
  // is written first, so a Resend failure does consume one of the three — the
  // safe direction, because the other one lets a slow provider be retried
  // without limit, which is the abuse this exists to stop.
  //
  // Failure policy is lib/usage-meter.mjs's consumeIpUsage, verbatim: while
  // the function is NOT DEPLOYED the send goes through with a loud log (a
  // merge that lands before the paste must not break invitations), and once
  // the function exists any error refuses.
  const charged = await chargeInvite(admin, { groupId, email, senderId: caller.id });
  if (!charged.allowed) {
    if (charged.retry_after_seconds) res.setHeader('retry-after', String(charged.retry_after_seconds));
    return json(res, charged.status || 429, {
      error: charged.reason,
      message: charged.message,
      retry_after_seconds: charged.retry_after_seconds ?? null,
    });
  }

  const inviter =
    (caller.user_metadata?.full_name || caller.user_metadata?.name || '').trim() ||
    caller.email ||
    'Someone';
  const mail = invitation({ inviter, groupName: group.name, textTitle, email });

  let sendRes;
  try {
    sendRes = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || DEFAULT_FROM,
        to: [email],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    });
  } catch (err) {
    return json(res, 502, { error: 'send_failed', detail: short(err?.message) });
  }
  if (!sendRes.ok) {
    // Report the status and Resend's own short message, never the key and
    // never the whole payload.
    let detail = '';
    try {
      const body = await sendRes.json();
      detail = short(body?.message || body?.error?.message || '');
    } catch { /* a non-JSON error body tells us nothing worth keeping */ }
    return json(res, 502, { error: 'send_failed', detail: `resend ${sendRes.status}${detail ? `: ${detail}` : ''}` });
  }
  return json(res, 200, { ok: true });
}

/**
 * Ask migration 083 whether this seat may be mailed again, and record the send.
 *
 * Returns the RPC's own answer shape — { allowed, reason, status, message,
 * retry_after_seconds } — so the handler treats a cap exactly the way it
 * treats a spend refusal.
 */
export async function chargeInvite(admin, { groupId, email, senderId }) {
  let result;
  try {
    result = await admin.rpc('student_hub_invite_charge', {
      p_group: groupId,
      p_email: email,
      p_sender: senderId,
    });
  } catch (err) {
    console.error(`[student-hub-invite] FAIL-CLOSED — invite cap threw: ${short(err?.message)}`);
    return {
      allowed: false, reason: 'invite_cap_unavailable', status: 429,
      message: 'Invitations are temporarily unavailable. Try again shortly.',
      retry_after_seconds: 60,
    };
  }
  if (result?.error) {
    const said = `${result.error.code || ''} ${result.error.message || ''}`;
    if (/PGRST202|could not find the function|does not exist/i.test(said)) {
      console.error('[student-hub-invite] FAIL-OPEN — the invite cap is not deployed yet; paste migration 083');
      return { allowed: true, reason: 'cap_undeployed', status: 200 };
    }
    console.error(`[student-hub-invite] FAIL-CLOSED — invite cap error: ${short(said)}`);
    return {
      allowed: false, reason: 'invite_cap_unavailable', status: 429,
      message: 'Invitations are temporarily unavailable. Try again shortly.',
      retry_after_seconds: 60,
    };
  }
  const answer = result?.data;
  if (!answer || typeof answer !== 'object') {
    console.error('[student-hub-invite] FAIL-CLOSED — the invite cap answered with nothing');
    return {
      allowed: false, reason: 'invite_cap_unavailable', status: 429,
      message: 'Invitations are temporarily unavailable. Try again shortly.',
      retry_after_seconds: 60,
    };
  }
  return answer;
}

/** The invitation itself — plain words, no images, nothing to click but the Hub. */
export function invitation({ inviter, groupName, textTitle, email }) {
  const on = textTitle ? ` on ${textTitle}` : '';
  const subject = `${inviter} invited you to ${groupName} on Contextspaces`;

  const text = [
    `${inviter} has given you a seat in ${groupName}, a study group${on} in the Contextspaces Student Hub.`,
    '',
    `A group holds six people, and one of those seats is yours. To take it, create a Contextspaces account with this address — ${email} — and the seat is waiting for you the moment you sign in.`,
    '',
    HUB_URL,
    '',
    'Inside, the group reads the same text together: ask a question of the passage in front of you, talk it through with everyone else, and open a video room when that is easier than typing.',
  ].join('\n');

  const html = `<div style="font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.6;color:#1C1B17;max-width:520px">
  <p style="margin:0 0 14px"><strong>${esc(inviter)}</strong> has given you a seat in
    <strong>${esc(groupName)}</strong>, a study group${on ? ` on ${esc(textTitle)}` : ''} in the Contextspaces Student Hub.</p>
  <p style="margin:0 0 14px">A group holds six people, and one of those seats is yours. To take it, create a
    Contextspaces account with this address &mdash; <span style="font-family:Consolas,monospace;font-size:13px">${esc(email)}</span>
    &mdash; and the seat is waiting for you the moment you sign in.</p>
  <p style="margin:0 0 18px"><a href="${HUB_URL}" style="color:#1F4D3A">${HUB_URL}</a></p>
  <p style="margin:0;color:#6E6A5E;font-size:14px">Inside, the group reads the same text together: ask a question of the
    passage in front of you, talk it through with everyone else, and open a video room when that is easier than typing.</p>
</div>`;

  return { subject, text, html };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function short(s) {
  return String(s || '').slice(0, 200);
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

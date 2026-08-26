// POST /api/student-hub-invite  { groupId, email }
//
// Sends one study-group invitation. A Student Hub group holds five people
// counting the person who formed it (migration 041; GROUP_CAP in
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
// Response:
//   200 { ok: true }
//   400 { error: 'bad_request', detail }      malformed body
//   401 { error: 'missing_bearer' | 'invalid_session' }
//   403 { error: 'not_group_owner' | 'not_an_invited_seat' | 'seat_already_claimed' }
//   404 { error: 'group_not_found' }
//   501 { error: 'email_not_configured' }     no RESEND_API_KEY yet
//   502 { error: 'send_failed', detail }      Resend refused or was unreachable
//
// Env on Vercel:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//   RESEND_API_KEY, RESEND_FROM (optional override of the From line)

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DEFAULT_FROM = 'Contextspaces Student Hub <invites@send.contextspaces.ai>';
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

/** The invitation itself — plain words, no images, nothing to click but the Hub. */
export function invitation({ inviter, groupName, textTitle, email }) {
  const on = textTitle ? ` on ${textTitle}` : '';
  const subject = `${inviter} invited you to ${groupName} on Contextspaces`;

  const text = [
    `${inviter} has given you one of the five seats in ${groupName}, a study group${on} in the Contextspaces Student Hub.`,
    '',
    `A group holds five people, and one of those seats is yours. To take it, create a Contextspaces account with this address — ${email} — and the seat is waiting for you the moment you sign in.`,
    '',
    HUB_URL,
    '',
    'Inside, the group reads the same text together: ask a question of the passage in front of you, talk it through with everyone else, and open a video room when that is easier than typing.',
  ].join('\n');

  const html = `<div style="font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.6;color:#1C1B17;max-width:520px">
  <p style="margin:0 0 14px"><strong>${esc(inviter)}</strong> has given you one of the five seats in
    <strong>${esc(groupName)}</strong>, a study group${on ? ` on ${esc(textTitle)}` : ''} in the Contextspaces Student Hub.</p>
  <p style="margin:0 0 14px">A group holds five people, and one of those seats is yours. To take it, create a
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

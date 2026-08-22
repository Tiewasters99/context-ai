// POST /api/calendar-import
//
// Pulls the signed-in user's upcoming events out of their connected
// Google Calendar and mirrors them into `calendar_events` (migration
// 053) with source = 'google'. Read-only in the Google direction: this
// endpoint never creates, edits, or deletes anything in Google.
//
// Request body (all optional):
//   { timeZone: "America/New_York",   // IANA zone; browser supplies it
//     days: 120 }                     // how far ahead to import (max 365)
//
// Response:
//   { ok: true, imported: 41, from: "2026-08-15", to: "2026-12-20",
//     calendarEmail: "…" }
//   { error: "calendar_not_connected" }        404 — no connection row
//   { error: "calendar_needs_reconnect" }      412 — token dead / scope gone
//   { error: "calendar_storage_not_enabled" }  501 — migration 053 unapplied
//
// Idempotent: every imported ('google') row from the floor date forward
// is deleted and rewritten on each run, so re-importing updates in place
// and never duplicates. User-authored rows (source 'contextspaces') are
// untouched.
//
// Scope note: the google_calendar connection is granted
// `https://www.googleapis.com/auth/calendar.events`, which already
// permits reading events on the user's calendars — no reconnect is
// required for import. Listing *secondary* calendars would additionally
// need `calendar.readonly`; v1 imports the primary calendar only.
//
// Env required on Vercel:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, CONNECTIONS_ENC_KEY

import { createClient } from '@supabase/supabase-js';
import { decrypt } from '../lib/connections-crypto.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();

const DEFAULT_DAYS = 120;
const MAX_DAYS = 365;
const MAX_EVENTS = 500;
// Events that started up to a week ago can still be running, so the
// import window opens slightly in the past — and the delete-and-rewrite
// uses the same floor so the two always agree.
const FLOOR_DAYS_BACK = 7;

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const missing = [];
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!GOOGLE_CLIENT_ID) missing.push('GOOGLE_OAUTH_CLIENT_ID');
  if (!GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!process.env.CONNECTIONS_ENC_KEY) missing.push('CONNECTIONS_ENC_KEY');
  if (missing.length) return json(res, 500, { error: 'config_error', missing_env: missing });

  // ── who is asking ──────────────────────────────────────────────────
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = authHeader.slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return json(res, 401, { error: 'invalid_session' });
  const userId = userData.user.id;

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const provider = String(body.provider || 'google');

  // ── Outlook / Microsoft 365: the hook, not the implementation ──────
  // The plumbing this would hang off already exists on the
  // `retrieval-backend` branch (api/microsoft-connect.mjs,
  // api/microsoft-callback.mjs, migration 027 extending
  // connections_kind_check to 'microsoft_365'). Flipping Outlook on is:
  //   1. finish the Entra app registration + Vercel client id/secret,
  //   2. add `Calendars.Read` to the requested scopes,
  //   3. swap the fetch below for
  //      GET https://graph.microsoft.com/v1.0/me/calendarview
  //      and map `start`/`end` (which carry their own timeZone) through
  //      the same toLocalParts() conversion used here.
  // Everything downstream — the rows, the RLS, the UI — is provider
  // agnostic already: source just becomes 'outlook'.
  if (provider === 'outlook' || provider === 'microsoft_365') {
    return json(res, 501, {
      error: 'outlook_not_enabled',
      detail:
        'Outlook / Microsoft 365 calendar import is not switched on yet. ' +
        'It needs the Entra app registration and Calendars.Read scope first.',
    });
  }
  if (provider !== 'google') return json(res, 400, { error: 'unknown_provider' });

  const timeZone = safeZone(body.timeZone);
  let days = Number(body.days);
  if (!Number.isFinite(days) || days <= 0) days = DEFAULT_DAYS;
  days = Math.min(Math.round(days), MAX_DAYS);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── the connection ─────────────────────────────────────────────────
  const { data: conn, error: connErr } = await admin
    .from('connections')
    .select('encrypted_refresh_token, status, scopes, connected_email')
    .eq('user_id', userId)
    .eq('kind', 'google_calendar')
    .maybeSingle();
  if (connErr) return json(res, 500, { error: `connections: ${connErr.message}` });
  if (!conn || !conn.encrypted_refresh_token) {
    return json(res, 404, { error: 'calendar_not_connected' });
  }
  // A connection stored before calendar scopes were requested can't read
  // events — ask for a reconnect rather than failing opaquely at Google.
  if (conn.scopes && !/auth\/calendar/.test(conn.scopes)) {
    return json(res, 412, {
      error: 'calendar_needs_reconnect',
      detail: 'The stored Google connection does not carry a Calendar scope.',
    });
  }

  let refreshToken;
  try {
    refreshToken = decrypt(conn.encrypted_refresh_token);
  } catch {
    return json(res, 500, { error: 'token_decrypt_failed' });
  }

  // ── access token ───────────────────────────────────────────────────
  let accessToken;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      const errMsg = data.error || 'token_refresh_failed';
      if (errMsg === 'invalid_grant') {
        await admin
          .from('connections')
          .update({
            status: 'needs_attention',
            last_error: 'invalid_grant',
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .eq('kind', 'google_calendar');
        return json(res, 412, { error: 'calendar_needs_reconnect' });
      }
      return json(res, 500, { error: `token_refresh: ${errMsg}` });
    }
    accessToken = data.access_token;
  } catch (e) {
    return json(res, 500, { error: `token_refresh_failed: ${e.message}` });
  }

  // ── fetch the window ───────────────────────────────────────────────
  const now = new Date();
  const floor = new Date(now.getTime() - FLOOR_DAYS_BACK * 86400000);
  const ceiling = new Date(now.getTime() + days * 86400000);
  const floorDate = localDate(floor, timeZone);
  const ceilingDate = localDate(ceiling, timeZone);

  const items = [];
  let pageToken = null;
  try {
    do {
      const params = new URLSearchParams({
        timeMin: floor.toISOString(),
        timeMax: ceiling.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        timeZone,
      });
      if (pageToken) params.set('pageToken', pageToken);
      const r = await fetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params.toString(),
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const data = await r.json();
      if (!r.ok) {
        const msg = data?.error?.message || 'events_list_failed';
        if (r.status === 401 || r.status === 403) {
          return json(res, 412, { error: 'calendar_needs_reconnect', detail: msg });
        }
        return json(res, 502, { error: `google_calendar: ${msg}` });
      }
      for (const ev of data.items ?? []) items.push(ev);
      pageToken = data.nextPageToken || null;
    } while (pageToken && items.length < MAX_EVENTS);
  } catch (e) {
    return json(res, 502, { error: `google_calendar_fetch_failed: ${e.message}` });
  }

  // ── map to rows ────────────────────────────────────────────────────
  const rows = [];
  for (const ev of items.slice(0, MAX_EVENTS)) {
    if (!ev || ev.status === 'cancelled') continue;
    const mapped = mapEvent(ev, userId, timeZone);
    if (!mapped) continue;
    if (mapped.start_date < floorDate) continue; // long-running outlier
    rows.push(mapped);
  }

  // ── rewrite the imported slice ─────────────────────────────────────
  const { error: delErr } = await admin
    .from('calendar_events')
    .delete()
    .eq('owner_id', userId)
    .eq('source', 'google')
    .gte('start_date', floorDate);
  if (delErr) {
    if (isMissingRelation(delErr)) {
      return json(res, 501, { error: 'calendar_storage_not_enabled' });
    }
    return json(res, 500, { error: `clear_previous_import: ${delErr.message}` });
  }

  if (rows.length) {
    const { error: insErr } = await admin.from('calendar_events').insert(rows);
    if (insErr) {
      if (isMissingRelation(insErr)) {
        return json(res, 501, { error: 'calendar_storage_not_enabled' });
      }
      return json(res, 500, { error: `insert: ${insErr.message}` });
    }
  }

  await admin
    .from('connections')
    .update({
      status: 'connected',
      last_error: null,
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('kind', 'google_calendar');

  return json(res, 200, {
    ok: true,
    imported: rows.length,
    from: floorDate,
    to: ceilingDate,
    calendarEmail: conn.connected_email || null,
    timeZone,
  });
}

// ── helpers ──────────────────────────────────────────────────────────

function mapEvent(ev, userId, timeZone) {
  const title = String(ev.summary || '(no title)').trim() || '(no title)';
  let start_date = null;
  let start_time = null;
  let end_date = null;
  let end_time = null;

  if (ev.start?.date) {
    // All-day. Google's end.date is exclusive — step back one day so a
    // single-day event doesn't render as two.
    start_date = ev.start.date;
    if (ev.end?.date) end_date = addDays(ev.end.date, -1);
    if (end_date && end_date < start_date) end_date = start_date;
  } else if (ev.start?.dateTime) {
    const s = toLocalParts(ev.start.dateTime, timeZone);
    if (!s) return null;
    start_date = s.date;
    start_time = s.time;
    if (ev.end?.dateTime) {
      const e = toLocalParts(ev.end.dateTime, timeZone);
      if (e) { end_date = e.date; end_time = e.time; }
    }
  } else {
    return null;
  }

  return {
    owner_id: userId,
    matterspace_id: null,
    title,
    notes: ev.description ? String(ev.description).slice(0, 2000) : null,
    location: ev.location ? String(ev.location).slice(0, 500) : null,
    start_date,
    start_time,
    end_date: end_date && end_date !== start_date ? end_date : null,
    end_time,
    event_type: 'meeting',
    source: 'google',
    external_id: String(ev.id),
    external_calendar_id: 'primary',
    external_link: ev.htmlLink || null,
    external_tz: timeZone,
    last_synced_at: new Date().toISOString(),
  };
}

/** RFC3339 instant -> { date: 'YYYY-MM-DD', time: 'HH:MM' } in `tz`. */
function toLocalParts(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function localDate(d, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function safeZone(tz) {
  const candidate = typeof tz === 'string' && tz ? tz : 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

function isMissingRelation(err) {
  const code = err?.code ?? '';
  if (['PGRST205', 'PGRST204', '42P01', '42703'].includes(code)) return true;
  return /schema cache|does not exist|could not find the table/i.test(err?.message ?? '');
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  return res.end(JSON.stringify(obj));
}

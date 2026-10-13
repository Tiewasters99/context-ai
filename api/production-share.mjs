// POST /api/production-share — send a packaged production by link
//
// Migration 115. One file, five actions, because a link has two kinds of
// caller and the rules for both belong side by side:
//
// A MATTER MEMBER (Supabase bearer, browser sessions only):
//   create  { production_id, recipient_name, audience: 'anyone'|'people',
//             emails, password?, expiry: {hours}|{date}, send: boolean }
//           -> { link_id, url, expires_at, emailed: [..], email_error? }
//   revoke  { link_id } -> { ok: true }
//
//   Before a link is made the caller is checked the way api/document-url.mjs
//   checks a download: the bearer with Supabase Auth; the Discovery plan; the
//   production read AS THE USER (RLS: is it theirs to send?); the step-up
//   gate asked out loud (a sealed matter at aal1 gets the code prompt); the
//   seal decided with the service role, failing closed. A sealed matter's
//   link must name its people (and 115's CHECK refuses the row otherwise),
//   and its default life is 48 hours. The delivery log row is written as the
//   user (030's RLS) and the matter's Record gets `file.delivered`; on a
//   sealed matter a link whose Record could not be written is deleted again
//   and nothing is handed out.
//
// THE RECIPIENT (no account; the link's token is the only key):
//   info          { token } -> what the link is, and what it needs
//   request_code  { token, email } -> a six-digit code, mailed to that
//                 address IF it is one of the link's people. The answer is
//                 the same either way, so the page cannot be used to learn
//                 who is on the list.
//   download      { token, email?, code?, password? } -> { url } a signed
//                 URL to the package ZIP, valid ten minutes.
//
//   Every refusal and every download is written to production_share_events
//   with the IP and browser. A sealed matter's package is not handed out if
//   that row cannot be written. Ten failures from one IP on one link in
//   fifteen minutes and the link refuses that IP for a while.
//
// Email goes through Resend (RESEND_API_KEY), as api/student-hub-invite.mjs
// does. Without a key the link is still made and the panel shows it to copy;
// the answer says email_not_configured. The password is never emailed.
//
// Env on Vercel: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//   SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, RESEND_FROM_PRODUCTIONS
//   (optional From line), PUBLIC_SITE_URL (optional; default
//   https://www.contextspaces.ai).
//
// Plain fetch with an injectable fetchImpl, so scripts/_test-share-links.mjs
// can drive the rules with no network.

import {
  json, corsPreflight, bearerFrom, readJsonBody, authUser, jwtClaims, serviceRpc,
  userRpcClient, SUPABASE_URL, ANON_KEY, SERVICE_KEY,
} from '../lib/account-security.mjs';
import { requireEntitlement, sendEntitlementRefusal } from '../lib/entitlements.mjs';
import { record } from '../lib/ledger.mjs';
import { walkEffectiveTier, isSealedTier } from '../lib/ai-tier-policy.mjs';
import {
  newLinkToken, hashToken, isTokenShaped, hashPassword, verifyPassword, newCode, hashCode,
  normalizeEmail, validateLinkRequest, linkState, linkNeeds, emailAllowed, judgeCode,
  packageFilename, batesRange, REFUSAL_WORDS,
  CODE_TTL_MS, CODES_PER_HOUR, FAILS_PER_WINDOW, FAIL_WINDOW_MS, LINKS_PER_DAY,
  DOWNLOAD_URL_TTL_SECONDS, CODE_MAX_ATTEMPTS,
} from '../lib/discovery/share-links.mjs';

const TIMEOUT_MS = 8000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Contextspaces Productions <productions@contextspaces.ai>';
const DEFAULT_SITE = 'https://www.contextspaces.ai';
const BUCKET = 'discovery-files';
const SENDABLE = new Set(['packaged', 'delivered']);

const base = () => String(SUPABASE_URL() || '').replace(/\/$/, '');

// ── PostgREST, as the service role and as the user ──────────────────────────

async function rest(doFetch, pathAndQuery, { method = 'GET', body, bearer = null, prefer } = {}) {
  const key = bearer ? ANON_KEY() : SERVICE_KEY();
  try {
    const res = await doFetch(`${base()}/rest/v1/${pathAndQuery}`, {
      method,
      headers: {
        apikey: key,
        authorization: `Bearer ${bearer || SERVICE_KEY()}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(prefer ? { prefer } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) return { ok: false, status: res.status, rows: [], error: data?.message || data?.code || `rest_${res.status}` };
    return { ok: true, status: res.status, rows: Array.isArray(data) ? data : data ? [data] : [] };
  } catch (err) {
    return { ok: false, status: 0, rows: [], error: err?.message || 'unreachable' };
  }
}

const rpcNotDeployed = (r) => r.status === 404 || r.error === 'PGRST202' || r.error === '42883';

/** Sealed, as the bucket policy sees it (api/document-url.mjs's rule). null = could not tell. */
async function isSealedMatter(matterId, doFetch) {
  const r = await serviceRpc('effective_tier_is_sealed', { p_matter: matterId }, { fetchImpl: doFetch });
  if (r.ok && typeof r.data === 'boolean') return r.data;
  if (!r.ok && rpcNotDeployed(r)) {
    try {
      const fetchRow = async (id) => {
        const m = await rest(doFetch, `matterspaces?select=id,parent_matterspace_id,ai_tier&id=eq.${id}&limit=1`);
        if (!m.ok) throw new Error('tier lookup failed');
        return m.rows[0] ?? null;
      };
      const tier = await walkEffectiveTier(fetchRow, matterId);
      return tier == null ? null : isSealedTier(tier);
    } catch {
      return null;
    }
  }
  return null;
}

async function mintPackageUrl(objectPath, filename, doFetch) {
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  try {
    const res = await doFetch(`${base()}/storage/v1/object/sign/${BUCKET}/${encoded}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SERVICE_KEY(), authorization: `Bearer ${SERVICE_KEY()}` },
      body: JSON.stringify({ expiresIn: DOWNLOAD_URL_TTL_SECONDS }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    const signed = data?.signedURL ?? data?.signedUrl;
    if (!res.ok || typeof signed !== 'string') return null;
    return `${base()}/storage/v1${signed}&download=${encodeURIComponent(filename)}`;
  } catch {
    return null;
  }
}

// ── Mail ────────────────────────────────────────────────────────────────────

async function sendMail(doFetch, { to, subject, text, html }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) return { ok: false, error: 'email_not_configured' };
  try {
    const res = await doFetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM_PRODUCTIONS || DEFAULT_FROM, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = '';
      try { const b = await res.json(); detail = short(b?.message || b?.error?.message || ''); } catch { /* nothing to keep */ }
      return { ok: false, error: 'send_failed', detail: `resend ${res.status}${detail ? `: ${detail}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'send_failed', detail: short(err?.message) };
  }
}

/** The link email: what was sent, by whom, until when, and what will be asked. */
export function linkEmail({ sender, prod, url, expiresAt, needsCode, hasPassword }) {
  const range = batesRange(prod);
  const until = new Date(expiresAt).toUTCString().replace(' GMT', ' UTC');
  const lines = [
    `${sender} has sent you a document production: ${prod.name}.`,
    '',
    ...(range ? [`Bates range: ${range}`] : []),
    ...(prod.package_sha256 ? [`Package sha256: ${prod.package_sha256}`] : []),
    `The link works until ${until}.`,
    '',
    url,
    '',
    ...(needsCode ? ['When you open it, enter this email address and you will be sent a one-time code.'] : []),
    ...(hasPassword ? ['It also asks for a password. The sender will give you that separately.'] : []),
    'The sha256 above lets you check that the file you download is the one that was sent.',
  ];
  const text = lines.join('\n');
  const html = `<div style="font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.6;color:#1C1B17;max-width:560px">
  <p style="margin:0 0 14px"><strong>${esc(sender)}</strong> has sent you a document production: <strong>${esc(prod.name)}</strong>.</p>
  <p style="margin:0 0 14px;font-size:14px">${range ? `Bates range: <span style="font-family:Consolas,monospace">${esc(range)}</span><br>` : ''}${prod.package_sha256 ? `Package sha256: <span style="font-family:Consolas,monospace;font-size:12px;word-break:break-all">${esc(prod.package_sha256)}</span><br>` : ''}The link works until ${esc(until)}.</p>
  <p style="margin:0 0 18px"><a href="${esc(url)}" style="color:#1F4D3A">Open the production</a></p>
  ${needsCode ? '<p style="margin:0 0 10px;font-size:14px">When you open it, enter this email address and you will be sent a one-time code.</p>' : ''}
  ${hasPassword ? '<p style="margin:0 0 10px;font-size:14px">It also asks for a password. The sender will give you that separately.</p>' : ''}
  <p style="margin:0;color:#6E6A5E;font-size:13px">The sha256 above lets you check that the file you download is the one that was sent.</p>
</div>`;
  return { subject: `${sender} sent you a production: ${prod.name}`, text, html };
}

function codeEmail({ code, prod }) {
  const text = `Your code to open the production "${prod.name}" is ${code}.\n\nIt works for ten minutes. If you did not ask for it, ignore this email.`;
  const html = `<div style="font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.6;color:#1C1B17;max-width:520px">
  <p style="margin:0 0 14px">Your code to open the production <strong>${esc(prod.name)}</strong> is</p>
  <p style="margin:0 0 14px;font-family:Consolas,monospace;font-size:26px;letter-spacing:4px">${code}</p>
  <p style="margin:0;color:#6E6A5E;font-size:13px">It works for ten minutes. If you did not ask for it, ignore this email.</p>
</div>`;
  return { subject: `Your code: ${code}`, text, html };
}

// ── The handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  if (corsPreflight(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (!SUPABASE_URL() || !ANON_KEY() || !SERVICE_KEY()) return json(res, 500, { error: 'config_error' });

  const body = await readJsonBody(req);
  const action = body?.action;
  const ctx = { req, res, body, doFetch, now: deps.now ? deps.now() : new Date() };
  switch (action) {
    case 'create': return createLink(ctx);
    case 'revoke': return revokeLink(ctx);
    case 'info': return linkInfo(ctx);
    case 'request_code': return requestCode(ctx);
    case 'download': return download(ctx);
    default: return json(res, 400, { error: 'unknown_action' });
  }
}

// ── Member: make a link ─────────────────────────────────────────────────────

async function memberFrom(ctx) {
  const { req, res, doFetch } = ctx;
  const bearer = bearerFrom(req);
  if (!bearer) { json(res, 401, { error: 'missing_bearer' }); return null; }
  const user = await authUser(bearer, { fetchImpl: doFetch });
  if (!user) { json(res, 401, { error: 'invalid_session' }); return null; }
  if (jwtClaims(bearer).cs_via === 'connector') { json(res, 403, { error: 'browser_sessions_only' }); return null; }
  return { bearer, user };
}

/** The step-up gate (094), asked as the user. Returns null when the caller may proceed. */
async function gateRefusal(bearer, matterId, doFetch) {
  const entry = await userRpcClient(bearer, { fetchImpl: doFetch }).rpc('matter_entry', { p_matter: matterId });
  if (entry.error) {
    const notPasted = entry.error.code === 'PGRST202' || entry.error.code === '404' || entry.error.code === '42883';
    return notPasted ? null : { status: 503, body: { error: 'seal_unresolved' } };
  }
  if (entry.data === 'stepup' || entry.data === 'enrol') {
    return { status: 403, body: { error: 'step_up_required', mode: entry.data, matter_id: matterId } };
  }
  if (entry.data !== 'open') return { status: 404, body: { error: 'not_found' } };
  return null;
}

async function createLink(ctx) {
  const { res, body, doFetch, now } = ctx;
  const who = await memberFrom(ctx);
  if (!who) return;
  const { bearer, user } = who;

  const gate = await requireEntitlement(user.id, 'discovery', { bearer, fetchImpl: doFetch });
  if (!gate.ok) return sendEntitlementRefusal(res, gate);

  const productionId = typeof body?.production_id === 'string' && UUID_RE.test(body.production_id) ? body.production_id : null;
  if (!productionId) return json(res, 400, { error: 'production_id required' });
  const recipientName = String(body?.recipient_name ?? '').trim().slice(0, 200);
  if (!recipientName) return json(res, 400, { error: 'recipient_name required', message: 'Say who the production is going to.' });

  // The production, as the user: RLS decides whether it is theirs to send.
  const p = await rest(doFetch,
    `productions?select=id,name,matterspace_id,status,direction,package_storage_path,package_sha256,bates_prefix,bates_pad,bates_start,bates_end&id=eq.${productionId}&limit=1`,
    { bearer });
  if (!p.ok) return json(res, 503, { error: 'lookup_failed' });
  const prod = p.rows[0];
  if (!prod) return json(res, 404, { error: 'not_found' });
  if (!SENDABLE.has(prod.status) || !prod.package_storage_path) {
    return json(res, 409, { error: 'not_packaged', message: 'Package the production before sending it.' });
  }
  if (!String(prod.package_storage_path).startsWith(`${prod.matterspace_id}/`)) {
    return json(res, 409, { error: 'storage_path_mismatch' });
  }

  const refusal = await gateRefusal(bearer, prod.matterspace_id, doFetch);
  if (refusal) return json(res, refusal.status, refusal.body);
  const sealed = await isSealedMatter(prod.matterspace_id, doFetch);
  if (sealed === null) return json(res, 503, { error: 'seal_unresolved' });

  const v = validateLinkRequest(body, { sealed, now });
  if (!v.ok) return json(res, 400, { error: v.code, message: v.error });

  // A cap on links per person per day: each one can send mail.
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const recent = await rest(doFetch,
    `production_share_links?select=id&created_by=eq.${user.id}&created_at=gte.${encodeURIComponent(since)}&limit=${LINKS_PER_DAY + 1}`);
  if (!recent.ok) {
    return json(res, 503, { error: 'links_unavailable', message: 'Links need one database update (migration 115) that has not been run yet.' });
  }
  if (recent.rows.length >= LINKS_PER_DAY) {
    return json(res, 429, { error: 'link_daily_cap', message: `At most ${LINKS_PER_DAY} links a day.` });
  }

  // The delivery log row, as the user (030's RLS), exactly as before.
  const range = batesRange(prod);
  const del = await rest(doFetch, 'deliveries?select=id', {
    method: 'POST', bearer, prefer: 'return=representation',
    body: {
      matterspace_id: prod.matterspace_id, production_id: prod.id,
      recipient_name: recipientName, recipient_email: v.emails.join(', ') || null,
      method: 'email_link', package_storage_path: prod.package_storage_path,
      package_sha256: prod.package_sha256, bates_range: range, created_by: user.id,
    },
  });
  if (!del.ok || !del.rows[0]?.id) return json(res, 503, { error: 'delivery_not_recorded', detail: short(del.error) });

  const { token, hash } = newLinkToken();
  const ins = await rest(doFetch, 'production_share_links?select=id,expires_at', {
    method: 'POST', prefer: 'return=representation',
    body: {
      matterspace_id: prod.matterspace_id, production_id: prod.id, delivery_id: del.rows[0].id,
      token_hash: hash, audience: v.audience, allowed_emails: v.emails,
      password_hash: v.password ? hashPassword(v.password) : null,
      sealed, recipient_name: recipientName, expires_at: v.expiresAt.toISOString(), created_by: user.id,
    },
  });
  if (!ins.ok || !ins.rows[0]?.id) return json(res, 503, { error: 'link_not_saved', detail: short(ins.error) });
  const linkId = ins.rows[0].id;

  // The matter's Record, as the user. A sealed matter's link does not exist
  // unrecorded: undo it and hand nothing out.
  const rec = await record(userRpcClient(bearer, { fetchImpl: doFetch }), {
    kind: 'file.delivered', matterId: prod.matterspace_id,
    actor: { kind: 'user', ref: user.id, user_id: user.id },
    payload: {
      production_id: prod.id, delivery_id: del.rows[0].id, recipient: recipientName,
      package_sha256: prod.package_sha256, bates_range: range,
      via: 'link', audience: v.audience, expires_at: v.expiresAt.toISOString(), sealed,
    },
  });
  if (!rec?.ok && sealed) {
    await rest(doFetch, `production_share_links?id=eq.${linkId}`, { method: 'DELETE' });
    return json(res, 503, { error: 'record_failed', message: 'This matter is sealed and its Record could not be written, so no link was made. Try again in a moment.' });
  }
  await logEvent(doFetch, { link_id: linkId, matterspace_id: prod.matterspace_id, kind: 'created', detail: `${v.audience}; ${v.emails.length} named` });

  const url = `${siteUrl(ctx.req)}/p/${token}`;
  const emailed = [];
  let emailError = null;
  let emailDetail = null;
  if (body?.send === true && v.emails.length) {
    const sender = (user.user_metadata?.full_name || user.user_metadata?.name || '').trim() || user.email || 'Someone';
    const mail = linkEmail({ sender, prod, url, expiresAt: v.expiresAt, needsCode: v.audience === 'people', hasPassword: Boolean(v.password) });
    for (const to of v.emails) {
      const sent = await sendMail(doFetch, { to, ...mail });
      if (sent.ok) {
        emailed.push(to);
        await logEvent(doFetch, { link_id: linkId, matterspace_id: prod.matterspace_id, kind: 'emailed', email: to });
      } else {
        emailError = sent.error;
        emailDetail = sent.detail ?? null;
        if (sent.error === 'email_not_configured') break;
      }
    }
  }

  return json(res, 200, {
    link_id: linkId, url, expires_at: v.expiresAt.toISOString(), sealed, audience: v.audience,
    emailed, email_error: emailError, email_detail: emailDetail,
  });
}

async function revokeLink(ctx) {
  const { res, body, doFetch, now } = ctx;
  const who = await memberFrom(ctx);
  if (!who) return;
  const linkId = typeof body?.link_id === 'string' && UUID_RE.test(body.link_id) ? body.link_id : null;
  if (!linkId) return json(res, 400, { error: 'link_id required' });
  // Visible to the user (RLS) = theirs to revoke.
  const mine = await rest(doFetch, `production_share_links?select=id,matterspace_id,revoked_at&id=eq.${linkId}&limit=1`, { bearer: who.bearer });
  if (!mine.ok) return json(res, 503, { error: 'lookup_failed' });
  const link = mine.rows[0];
  if (!link) return json(res, 404, { error: 'not_found' });
  if (link.revoked_at) return json(res, 200, { ok: true, already: true });
  const up = await rest(doFetch, `production_share_links?id=eq.${linkId}&revoked_at=is.null`, {
    method: 'PATCH', body: { revoked_at: now.toISOString(), revoked_by: who.user.id },
  });
  if (!up.ok) return json(res, 503, { error: 'revoke_failed' });
  await logEvent(doFetch, { link_id: linkId, matterspace_id: link.matterspace_id, kind: 'revoked' });
  return json(res, 200, { ok: true });
}

// ── Recipient ───────────────────────────────────────────────────────────────

const LINK_COLS = 'id,matterspace_id,production_id,audience,allowed_emails,password_hash,sealed,expires_at,revoked_at,first_downloaded_at,download_count,created_by';

async function linkByToken(doFetch, token) {
  if (!isTokenShaped(token)) return { ok: true, link: null };
  const r = await rest(doFetch, `production_share_links?select=${LINK_COLS}&token_hash=eq.${hashToken(token)}&limit=1`);
  if (!r.ok) return { ok: false };
  return { ok: true, link: r.rows[0] ?? null };
}

async function productionFor(doFetch, link) {
  const r = await rest(doFetch,
    `productions?select=id,name,matterspace_id,package_storage_path,package_sha256,bates_prefix,bates_pad,bates_start,bates_end&id=eq.${link.production_id}&limit=1`);
  return r.ok ? r.rows[0] ?? null : null;
}

/** Shared opening checks: the link exists, is live, and this IP is not throttled. */
async function openLink(ctx) {
  const { res, body, doFetch, now } = ctx;
  const found = await linkByToken(doFetch, body?.token);
  if (!found.ok) { json(res, 503, { error: 'unavailable' }); return null; }
  const link = found.link;
  const state = linkState(link, now);
  if (state !== 'active') {
    if (link) {
      await logEvent(doFetch, {
        link_id: link.id, matterspace_id: link.matterspace_id,
        kind: state === 'revoked' ? 'refused_revoked' : 'refused_expired', ...client(ctx.req),
      });
    }
    json(res, state === 'missing' ? 404 : 410, { error: state, message: REFUSAL_WORDS[state] });
    return null;
  }
  const since = new Date(now.getTime() - FAIL_WINDOW_MS).toISOString();
  const ip = client(ctx.req).ip;
  if (ip) {
    const fails = await rest(doFetch,
      `production_share_events?select=id&link_id=eq.${link.id}&ip=eq.${encodeURIComponent(ip)}&kind=like.refused_*&created_at=gte.${encodeURIComponent(since)}&limit=${FAILS_PER_WINDOW}`);
    if (fails.ok && fails.rows.length >= FAILS_PER_WINDOW) {
      json(res, 429, { error: 'throttled', message: REFUSAL_WORDS.throttled });
      return null;
    }
  }
  return link;
}

async function linkInfo(ctx) {
  const link = await openLink(ctx);
  if (!link) return;
  const prod = await productionFor(ctx.doFetch, link);
  if (!prod) return json(ctx.res, 404, { error: 'missing', message: REFUSAL_WORDS.missing });
  return json(ctx.res, 200, {
    name: prod.name, bates_range: batesRange(prod), package_sha256: prod.package_sha256,
    filename: packageFilename(prod), expires_at: link.expires_at, needs: linkNeeds(link),
  });
}

async function requestCode(ctx) {
  const { res, body, doFetch, now } = ctx;
  const link = await openLink(ctx);
  if (!link) return;
  if (link.audience !== 'people') return json(res, 400, { error: 'no_code_needed' });
  const email = normalizeEmail(body?.email);
  const generic = { ok: true, message: 'If that address can open this link, a code is on its way. It works for ten minutes.' };
  if (!email || !emailAllowed(link, email)) {
    await logEvent(doFetch, { link_id: link.id, matterspace_id: link.matterspace_id, kind: 'refused_not_allowed', email: email.slice(0, 200) || null, ...client(ctx.req) });
    return json(res, 200, generic);
  }
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const recent = await rest(doFetch,
    `production_share_codes?select=id&link_id=eq.${link.id}&email=eq.${encodeURIComponent(email)}&created_at=gte.${encodeURIComponent(hourAgo)}&limit=${CODES_PER_HOUR}`);
  if (!recent.ok) return json(res, 503, { error: 'unavailable' });
  if (recent.rows.length >= CODES_PER_HOUR) return json(res, 429, { error: 'throttled', message: REFUSAL_WORDS.throttled });

  const prod = await productionFor(doFetch, link);
  if (!prod) return json(res, 404, { error: 'missing', message: REFUSAL_WORDS.missing });
  const code = newCode();
  const saved = await rest(doFetch, 'production_share_codes', {
    method: 'POST',
    body: { link_id: link.id, email, code_hash: hashCode(code, { linkId: link.id, email }), expires_at: new Date(now.getTime() + CODE_TTL_MS).toISOString() },
  });
  if (!saved.ok) return json(res, 503, { error: 'unavailable' });
  const sent = await sendMail(doFetch, { to: email, ...codeEmail({ code, prod }) });
  if (!sent.ok) {
    return json(res, sent.error === 'email_not_configured' ? 501 : 502, {
      error: sent.error, message: 'The code could not be sent just now. Ask the sender to check, or try again shortly.',
    });
  }
  await logEvent(doFetch, { link_id: link.id, matterspace_id: link.matterspace_id, kind: 'code_sent', email, ...client(ctx.req) });
  return json(res, 200, generic);
}

async function download(ctx) {
  const { res, body, doFetch, now } = ctx;
  const link = await openLink(ctx);
  if (!link) return;
  const who = client(ctx.req);
  const refuse = async (kind, error, email = null) => {
    await logEvent(doFetch, { link_id: link.id, matterspace_id: link.matterspace_id, kind, email, ...who, detail: error });
    return json(res, 403, { error, message: REFUSAL_WORDS[error] ?? REFUSAL_WORDS.wrong_code });
  };

  let codeRow = null;
  const email = normalizeEmail(body?.email);
  if (link.audience === 'people') {
    if (!email || !emailAllowed(link, email)) return refuse('refused_not_allowed', 'not_allowed', email || null);
    const rows = await rest(doFetch,
      `production_share_codes?select=id,code_hash,expires_at,attempts,used_at&link_id=eq.${link.id}&email=eq.${encodeURIComponent(email)}&used_at=is.null&order=created_at.desc&limit=1`);
    if (!rows.ok) return json(res, 503, { error: 'unavailable' });
    codeRow = rows.rows[0] ?? null;
    const verdict = judgeCode(codeRow, body?.code, { linkId: link.id, email, now });
    if (verdict !== 'ok') {
      if (verdict === 'wrong' && codeRow) {
        await rest(doFetch, `production_share_codes?id=eq.${codeRow.id}`, { method: 'PATCH', body: { attempts: Math.min((codeRow.attempts ?? 0) + 1, CODE_MAX_ATTEMPTS) } });
      }
      const error = verdict === 'wrong' ? 'wrong_code' : verdict === 'expired' ? 'code_expired' : verdict;
      return refuse('refused_code', error, email);
    }
  }
  if (link.password_hash && !verifyPassword(String(body?.password ?? ''), link.password_hash)) {
    return refuse('refused_password', 'wrong_password', email || null);
  }

  const prod = await productionFor(doFetch, link);
  if (!prod?.package_storage_path || !String(prod.package_storage_path).startsWith(`${link.matterspace_id}/`)) {
    return json(res, 404, { error: 'missing', message: REFUSAL_WORDS.missing });
  }

  // Record first: a sealed matter's package does not leave unrecorded.
  const logged = await logEvent(doFetch, { link_id: link.id, matterspace_id: link.matterspace_id, kind: 'downloaded', email: email || null, ...who });
  if (!logged && link.sealed) return json(res, 503, { error: 'record_failed', message: 'The download could not be recorded just now, so it was not started. Try again in a moment.' });

  const url = await mintPackageUrl(prod.package_storage_path, packageFilename(prod), doFetch);
  if (!url) return json(res, 503, { error: 'unavailable' });

  if (codeRow) await rest(doFetch, `production_share_codes?id=eq.${codeRow.id}`, { method: 'PATCH', body: { used_at: now.toISOString() } });
  const first = !link.first_downloaded_at;
  await rest(doFetch, `production_share_links?id=eq.${link.id}`, {
    method: 'PATCH',
    body: { download_count: (link.download_count ?? 0) + 1, ...(first ? { first_downloaded_at: now.toISOString() } : {}) },
  });
  if (first) await tellSender(doFetch, link, prod, email);

  return json(res, 200, { url, filename: packageFilename(prod), expires_in: DOWNLOAD_URL_TTL_SECONDS });
}

/** On the first download, a line to the person who made the link. Best effort. */
async function tellSender(doFetch, link, prod, email) {
  if (!link.created_by) return;
  const p = await rest(doFetch, `profiles?select=email&id=eq.${link.created_by}&limit=1`);
  const to = p.ok ? p.rows[0]?.email : null;
  if (!to) return;
  const by = email ? ` by ${email}` : '';
  await sendMail(doFetch, {
    to,
    subject: `Downloaded: ${prod.name}`,
    text: `The production "${prod.name}" you sent by link was downloaded for the first time${by}.\n\nEvery download is listed in the production's Bates & Produce panel.`,
    html: `<div style="font-family:Georgia,serif;font-size:15px;line-height:1.6;color:#1C1B17">The production <strong>${esc(prod.name)}</strong> you sent by link was downloaded for the first time${esc(by)}.<br><br><span style="color:#6E6A5E;font-size:13px">Every download is listed in the production's Bates &amp; Produce panel.</span></div>`,
  }).catch(() => {});
}

// ── Small things ────────────────────────────────────────────────────────────

async function logEvent(doFetch, row) {
  const r = await rest(doFetch, 'production_share_events', {
    method: 'POST',
    body: {
      link_id: row.link_id, matterspace_id: row.matterspace_id, kind: row.kind,
      email: row.email ?? null, ip: row.ip ?? null, user_agent: row.user_agent ?? null,
      detail: row.detail ? short(row.detail, 500) : null,
    },
  });
  if (!r.ok) console.warn(`[production-share] event ${row.kind} not written: ${short(r.error)}`);
  return r.ok;
}

function client(req) {
  const fwd = String(req?.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
  const ip = (fwd || String(req?.headers?.['x-real-ip'] ?? '') || req?.socket?.remoteAddress || '').slice(0, 64) || null;
  const ua = String(req?.headers?.['user-agent'] ?? '').slice(0, 300) || null;
  return { ip, user_agent: ua };
}

/** The site the link points at: ours, or a Vercel preview of ours — never a Host header's say-so. */
export function siteUrl(req) {
  const configured = (process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
  if (configured) return configured;
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').toLowerCase();
  if (/^([a-z0-9-]+\.)*contextspaces\.ai$/.test(host) || /^context-ai[a-z0-9-]*\.vercel\.app$/.test(host)) return `https://${host}`;
  return DEFAULT_SITE;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function short(s, n = 200) {
  return String(s || '').slice(0, n);
}

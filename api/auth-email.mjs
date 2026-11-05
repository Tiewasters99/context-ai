// api/auth-email.mjs — the Supabase "Send Email" auth hook.
//
// Supabase Auth POSTs here instead of sending its own mail, for every auth
// email the project produces: sign-up confirmation, magic link, invite,
// password recovery, email change, the one-time codes, and the account
// notifications. We write the mail ourselves and send it through Resend,
// branded for the site the reader came from:
//
//   redirect_to on reader.grapheon.ai (or equazia.ai/reader) → the Grapheon Reader
//   anything else                                            → Equazia
//
// The request is signed (Standard Webhooks): headers webhook-id,
// webhook-timestamp, webhook-signature; the signed string is
// `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the base64 secret that
// follows `v1,whsec_` in SEND_EMAIL_HOOK_SECRET. The body is read raw so the
// bytes we verify are the bytes Supabase signed.
//
// Responses: 200 {} once every mail is accepted by Resend. Anything else makes
// Supabase treat the mail as unsent, so the only non-200s are a bad signature
// (401), a body we cannot read (400), a missing secret or key (500) and a
// Resend refusal (502).
//
// Links are the same ones Supabase's own templates build:
//   {SUPABASE_URL}/auth/v1/verify?token={token_hash}&type={type}&redirect_to={redirect_to}
// so the Site URL / redirect allow-list rules are unchanged by this hook.

import { createHmac, timingSafeEqual } from 'crypto';
import { json, SUPABASE_URL } from '../lib/account-security.mjs';

export const config = { api: { bodyParser: false } };

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 4000;
/** How old a signed request may be, in seconds. */
export const TOLERANCE_S = 300;

export const BRANDS = Object.freeze({
  reader: {
    key: 'reader',
    name: 'Grapheon Reader',
    home: 'https://reader.grapheon.ai',
    fromEnv: 'RESEND_FROM_READER',
    from: 'Grapheon Reader <reader@contextspaces.ai>',
    sign: 'The Grapheon Reader',
  },
  equazia: {
    key: 'equazia',
    name: 'Equazia',
    home: 'https://www.equazia.ai',
    fromEnv: 'RESEND_FROM_AUTH',
    from: 'Equazia <no-reply@contextspaces.ai>',
    sign: 'Equazia',
  },
});

/** Which site asked for the mail, read from where its link goes back to. */
export function brandFor(redirectTo) {
  try {
    const u = new URL(String(redirectTo || ''));
    const host = u.hostname.toLowerCase();
    if (host === 'grapheon.ai' || host.endsWith('.grapheon.ai')) return BRANDS.reader;
    if (/^\/reader(\/|$)/.test(u.pathname)) return BRANDS.reader;
  } catch { /* no usable redirect: Equazia, the project's own site */ }
  return BRANDS.equazia;
}

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

function secretBytes(secret) {
  const s = String(secret || '').trim();
  const m = /^v1,whsec_(.+)$/.exec(s) || /^whsec_(.+)$/.exec(s);
  const b64 = m ? m[1] : s;
  if (!b64) return null;
  try { return Buffer.from(b64, 'base64'); } catch { return null; }
}

/** Sign a body the way Supabase does; the harness uses it, and so would a replay tool. */
export function signPayload({ id, timestamp, body }, secret) {
  const key = secretBytes(secret);
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

/** Standard Webhooks verification. `headers` is the request's (lower-cased) header map. */
export function verifySignature(rawBody, headers, secret, now = Date.now()) {
  const key = secretBytes(secret);
  if (!key || key.length === 0) return { ok: false, reason: 'no_secret' };
  const id = String(headers['webhook-id'] || '');
  const ts = String(headers['webhook-timestamp'] || '');
  const sigHeader = String(headers['webhook-signature'] || '');
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing_headers' };
  const t = Number(ts);
  if (!Number.isFinite(t)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(now / 1000 - t) > TOLERANCE_S) return { ok: false, reason: 'stale' };
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest();
  for (const part of sigHeader.split(/\s+/)) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    let given;
    try { given = Buffer.from(value, 'base64'); } catch { continue; }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, reason: null };
  }
  return { ok: false, reason: 'mismatch' };
}

// ---------------------------------------------------------------------------
// The mail
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function verifyLink(supabaseUrl, { tokenHash, type, redirectTo, siteUrl }) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '');
  const back = redirectTo || siteUrl || '';
  return `${base}/auth/v1/verify?token=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(type)}&redirect_to=${encodeURIComponent(back)}`;
}

function wrapHtml(brand, paragraphs) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px 0">${p}</p>`).join('\n');
  const homeText = esc(brand.home.replace(/^https?:\/\//, ''));
  return [
    `<div style="font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.5;color:#1d1a12;max-width:560px;margin:0 auto;padding:24px 16px">`,
    `<div style="font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#8a7742;margin-bottom:18px">${esc(brand.name)}</div>`,
    body,
    `<p style="margin:22px 0 0 0;color:#6b6353;font-size:14px">${esc(brand.sign)} · <a href="${esc(brand.home)}" style="color:#6b6353">${homeText}</a></p>`,
    `</div>`,
  ].join('\n');
}

function linkMail(brand, { to, subject, lead, action, link, closing }) {
  const text = [lead, '', `${action}:`, link, '', closing, '', brand.sign].join('\n');
  const html = wrapHtml(brand, [
    esc(lead),
    `<a href="${esc(link)}" style="display:inline-block;padding:10px 18px;background:#1d1a12;color:#f1e3b8;text-decoration:none;border-radius:4px">${esc(action)}</a>`,
    `<span style="font-size:14px;color:#6b6353">Or open this address: <a href="${esc(link)}" style="color:#6b6353">${esc(link)}</a></span>`,
    esc(closing),
  ]);
  return { to, subject, text, html };
}

function codeMail(brand, { to, subject, lead, code, closing }) {
  const text = [lead, '', code, '', closing, '', brand.sign].join('\n');
  const html = wrapHtml(brand, [
    esc(lead),
    `<span style="display:inline-block;font-size:28px;letter-spacing:0.25em;padding:8px 14px;border:1px solid #c9b989;border-radius:4px">${esc(code)}</span>`,
    esc(closing),
  ]);
  return { to, subject, text, html };
}

function noteMail(brand, { to, subject, lines }) {
  const text = [...lines, '', brand.sign].join('\n');
  return { to, subject, text, html: wrapHtml(brand, lines.map(esc)) };
}

const NOTICES = {
  password_changed_notification: 'The password on your account was just changed.',
  email_changed_notification: 'The email address on your account was just changed.',
  phone_changed_notification: 'The phone number on your account was just changed.',
  identity_linked_notification: 'A new sign-in method was just linked to your account.',
  identity_unlinked_notification: 'A sign-in method was just removed from your account.',
  mfa_factor_enrolled_notification: 'A second factor was just added to your account.',
  mfa_factor_unenrolled_notification: 'A second factor was just removed from your account.',
};

/** The mail(s) for one hook call. Email change under Secure Email Change is two mails. */
export function composeAuthMail({ user, emailData, supabaseUrl }) {
  const d = emailData || {};
  const type = String(d.email_action_type || '');
  const brand = brandFor(d.redirect_to);
  const email = String(user?.email || '');
  const ignore = 'If this was not you, you can ignore this message; nothing changes.';
  const link = (tokenHash, t = type) => verifyLink(supabaseUrl, { tokenHash, type: t, redirectTo: d.redirect_to, siteUrl: d.site_url });

  switch (type) {
    case 'signup':
      return [linkMail(brand, {
        to: email,
        subject: `Confirm your email for ${brand.name}`,
        lead: `Welcome to ${brand.name}. Confirm that ${email} is yours and your account is ready.`,
        action: 'Confirm my email',
        link: link(d.token_hash),
        closing: ignore,
      })];
    case 'invite':
      return [linkMail(brand, {
        to: email,
        subject: `You are invited to ${brand.name}`,
        lead: `You have been invited to ${brand.name}. Accept the invitation and choose how you will sign in.`,
        action: 'Accept the invitation',
        link: link(d.token_hash),
        closing: ignore,
      })];
    case 'magiclink':
      return [linkMail(brand, {
        to: email,
        subject: `Your sign-in link for ${brand.name}`,
        lead: `Here is your sign-in link for ${brand.name}. It works once and expires soon.`,
        action: 'Sign in',
        link: link(d.token_hash),
        closing: ignore,
      })];
    case 'recovery':
      return [linkMail(brand, {
        to: email,
        subject: `Reset your ${brand.name} password`,
        lead: `Someone asked to reset the password for ${email} at ${brand.name}. If that was you, choose a new one here.`,
        action: 'Choose a new password',
        link: link(d.token_hash),
        closing: 'If it was not you, ignore this message: your password stays as it is.',
      })];
    case 'email_change': {
      const newEmail = String(user?.new_email || '');
      // Secure Email Change: both addresses must confirm. Supabase pairs
      // `token` with `token_hash_new` for the current address and `token_new`
      // with `token_hash` for the new one; we follow that pairing exactly.
      const mails = [];
      if (d.token_hash_new) {
        mails.push(linkMail(brand, {
          to: email,
          subject: `Confirm the change of email at ${brand.name}`,
          lead: `You asked to change the email on your ${brand.name} account from ${email} to ${newEmail || 'a new address'}. Confirm from this address too.`,
          action: 'Confirm the change',
          link: link(d.token_hash_new),
          closing: ignore,
        }));
      }
      mails.push(linkMail(brand, {
        to: newEmail || email,
        subject: `Confirm your new email for ${brand.name}`,
        lead: `Confirm that ${newEmail || email} is the new address for your ${brand.name} account.`,
        action: 'Confirm my new email',
        link: link(d.token_hash),
        closing: ignore,
      }));
      return mails;
    }
    case 'email':
      return [codeMail(brand, {
        to: email,
        subject: `Your ${brand.name} sign-in code`,
        lead: `Your one-time code for ${brand.name}:`,
        code: String(d.token || ''),
        closing: 'It expires soon and works once. ' + ignore,
      })];
    case 'reauthentication':
      return [codeMail(brand, {
        to: email,
        subject: `Your ${brand.name} confirmation code`,
        lead: `Enter this code at ${brand.name} to confirm it is you:`,
        code: String(d.token || ''),
        closing: ignore,
      })];
    default: {
      const line = NOTICES[type];
      if (line) {
        return [noteMail(brand, {
          to: email,
          subject: `A change to your ${brand.name} account`,
          lines: [line, `If this was not you, sign in to ${brand.name} and check your account, or reply to this message.`],
        })];
      }
      // A type this file does not know yet: say so plainly rather than drop it,
      // and carry the link when there is one, so nothing is lost.
      const lines = [`${brand.name} sent you a message about your account (${type || 'unknown'}).`];
      if (d.token_hash) lines.push(`Open this address to continue: ${link(d.token_hash)}`);
      if (d.token) lines.push(`Your code: ${d.token}`);
      return [noteMail(brand, { to: email, subject: `A message from ${brand.name}`, lines })];
    }
  }
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

async function readRaw(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const secret = String(env.SEND_EMAIL_HOOK_SECRET || '').trim();
  if (!secret) {
    console.error('[auth-email] SEND_EMAIL_HOOK_SECRET is not set');
    return json(res, 500, { error: 'hook_not_configured' });
  }
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    console.error('[auth-email] RESEND_API_KEY is not set');
    return json(res, 500, { error: 'email_not_configured' });
  }

  let raw;
  try { raw = await readRaw(req); } catch { return json(res, 400, { error: 'unreadable_body' }); }
  const sig = verifySignature(raw, req.headers || {}, secret, now());
  if (!sig.ok) {
    console.error(`[auth-email] signature refused: ${sig.reason}`);
    return json(res, 401, { error: 'bad_signature' });
  }

  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad_json' }); }
  const user = body?.user;
  const emailData = body?.email_data;
  if (!user || typeof user !== 'object' || !user.email || !emailData || typeof emailData !== 'object') {
    return json(res, 400, { error: 'bad_request' });
  }

  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || SUPABASE_URL();
  const mails = composeAuthMail({ user, emailData, supabaseUrl });
  const brand = brandFor(emailData.redirect_to);
  const from = String(env[brand.fromEnv] || '').trim() || brand.from;

  const send = async (m) => {
    let r;
    try {
      r = await doFetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      console.error('[auth-email] Resend unreachable for ' + emailData.email_action_type + ': ' + (e?.message || e));
      return false;
    }
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[auth-email] Resend ' + r.status + ' for ' + emailData.email_action_type + ': ' + detail.slice(0, 300));
      return false;
    }
    return true;
  };
  // The mails go out together: a secure email change is two of them, and the
  // hook has only a few seconds before Supabase gives up on it.
  const results = await Promise.all(mails.map(send));
  if (results.some((ok) => !ok)) return json(res, 502, { error: 'send_failed' });
  return json(res, 200, {});
}

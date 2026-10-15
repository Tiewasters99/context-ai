// Discovery — links that send a packaged production (migration 115).
//
// A link opens ONE production's package ZIP and nothing else. Who may open it
// is chosen when it is made, the way OneDrive shares a file:
//
//   audience 'anyone'  anyone holding the link
//   audience 'people'  only the addresses named; the recipient types theirs
//                      and gets a one-time six-digit code by email (no account)
//   password           optional, on either; never emailed
//   expires_at         always; 24 h / 48 h / 7 days / 30 days / a date
//
// A SEALED matter never gets an 'anyone' link: the server refuses one (and
// migration 115's CHECK refuses the row), and its default expiry is 48 hours.
//
// Nothing secret is stored in the clear: the link token is stored as its
// sha256 (it is 32 random bytes, so a fast hash is enough), the password as
// scrypt with a salt, and each emailed code as a salted sha256 that dies in
// ten minutes or after five wrong tries. This file holds the rules only, so
// scripts/_test-share-links.mjs can hold them to account with no network;
// api/production-share.mjs does the I/O.

import crypto from 'node:crypto';

export const EXPIRY_CHOICES_HOURS = Object.freeze([24, 48, 24 * 7, 24 * 30]);
export const SEALED_DEFAULT_HOURS = 48;
export const OPEN_DEFAULT_HOURS = 24 * 7;
export const MAX_EXPIRY_DAYS = 90;
export const MAX_RECIPIENTS = 20;
export const MIN_PASSWORD = 8;
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
/** Codes one address may be sent for one link in an hour. */
export const CODES_PER_HOUR = 5;
/** Failed opens from one IP on one link in 15 minutes before it is refused. */
export const FAILS_PER_WINDOW = 10;
export const FAIL_WINDOW_MS = 15 * 60_000;
/** Links one person may make in 24 hours (each can send mail). */
export const LINKS_PER_DAY = 30;
/** The signed URL a successful open hands out. */
export const DOWNLOAD_URL_TTL_SECONDS = 600;
/** A production in volumes: one open hands out every volume's URL, for longer,
 *  so a recipient can work through them without a fresh code for each. */
export const VOLUME_URL_TTL_SECONDS = 3600;

/** A production packaged in volumes (lib/discovery/volumes.mjs): its package is the volume list. */
export const isVolumeListPath = (p) => typeof p === 'string' && p.endsWith('/package/volumes.json');

/**
 * The volumes a link may hand out, from the production's volume list. Only
 * ZIPs inside that production's own package folder, and only a finished list;
 * anything else answers [] (nothing is handed out).
 */
export function volumesFromManifest(prod, manifest) {
  if (!prod?.matterspace_id || !prod?.id || !manifest || manifest.complete !== true) return [];
  const dir = `${prod.matterspace_id}/${prod.id}/package/`;
  const out = [];
  for (const v of Array.isArray(manifest.volumes) ? manifest.volumes : []) {
    const p = v?.storage_path;
    if (typeof p !== 'string' || !p.startsWith(dir) || !p.endsWith('.zip') || p.includes('..') || p.slice(dir.length).includes('/')) return [];
    out.push({
      name: String(v.name ?? ''), storage_path: p, sha256: String(v.sha256 ?? ''), bytes: Number(v.bytes) || 0,
      docs: Number(v.docs) || 0, pages: Number(v.pages) || 0,
      bates_first: String(v.bates_first ?? ''), bates_last: String(v.bates_last ?? ''),
    });
  }
  return out;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// ── Tokens and secrets ──────────────────────────────────────────────────────

/** A fresh link token (base64url, 43 chars) and the hash that is stored. */
export function newLinkToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** A token is only ever looked up if it is shaped like one we made. */
export function isTokenShaped(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [scheme, n, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const want = Buffer.from(keyB64, 'base64url');
  let got;
  try {
    got = crypto.scryptSync(password, Buffer.from(saltB64, 'base64url'), want.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  } catch {
    return false;
  }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** A six-digit code, uniformly drawn. */
export function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Codes are bound to their link and address, so one cannot stand in for another. */
export function hashCode(code, { linkId, email }) {
  return crypto.createHash('sha256').update(`${linkId}\n${normalizeEmail(email)}\n${String(code).trim()}`).digest('hex');
}

// ── Addresses ───────────────────────────────────────────────────────────────

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/**
 * The recipients a person typed: one string (commas, semicolons, spaces or
 * new lines) or a list. Returns { emails } or { error }.
 */
export function parseRecipients(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\s,;]+/);
  const emails = [...new Set(raw.map(normalizeEmail).filter(Boolean))];
  const bad = emails.filter((e) => !EMAIL_RE.test(e));
  if (bad.length) return { error: `Not an email address: ${bad.slice(0, 3).join(', ')}` };
  if (emails.length > MAX_RECIPIENTS) return { error: `At most ${MAX_RECIPIENTS} people per link.` };
  return { emails };
}

// ── Making a link ───────────────────────────────────────────────────────────

/**
 * When the link stops working. `expiry` is { hours } (one of the four
 * choices) or { date } ("YYYY-MM-DD": the end of that day, UTC) or nothing
 * (the default for the matter). Returns { expiresAt: Date } or { error }.
 */
export function resolveExpiry(expiry, { sealed, now = new Date() } = {}) {
  const hours = expiry?.hours;
  const date = expiry?.date;
  let at;
  if (hours != null) {
    if (!EXPIRY_CHOICES_HOURS.includes(Number(hours))) return { error: 'Pick 24 hours, 48 hours, 7 days or 30 days, or a date.' };
    at = new Date(now.getTime() + Number(hours) * 3_600_000);
  } else if (date != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return { error: 'The date must look like 2026-10-31.' };
    at = new Date(`${date}T23:59:59Z`);
    if (Number.isNaN(at.getTime())) return { error: 'That date does not exist.' };
  } else {
    at = new Date(now.getTime() + (sealed ? SEALED_DEFAULT_HOURS : OPEN_DEFAULT_HOURS) * 3_600_000);
  }
  if (at.getTime() <= now.getTime()) return { error: 'That date has already passed.' };
  if (at.getTime() - now.getTime() > MAX_EXPIRY_DAYS * 86_400_000) return { error: `A link can last at most ${MAX_EXPIRY_DAYS} days.` };
  return { expiresAt: at };
}

/**
 * Check what a person asked for before anything is written.
 * Returns { ok: true, audience, emails, password, expiresAt } or { ok: false, error, code }.
 */
export function validateLinkRequest(body, { sealed, now = new Date() }) {
  const audience = body?.audience;
  if (audience !== 'anyone' && audience !== 'people') return { ok: false, code: 'bad_audience', error: 'Choose who can open the link.' };
  if (sealed && audience !== 'people') {
    return { ok: false, code: 'sealed_requires_people', error: 'This matter is sealed: a link must name the people who can open it.' };
  }
  const parsed = parseRecipients(body?.emails ?? []);
  if (parsed.error) return { ok: false, code: 'bad_emails', error: parsed.error };
  if (audience === 'people' && parsed.emails.length === 0) {
    return { ok: false, code: 'no_people', error: 'Name at least one person who can open the link.' };
  }
  const password = body?.password == null || body.password === '' ? null : String(body.password);
  if (password != null && password.length < MIN_PASSWORD) {
    return { ok: false, code: 'short_password', error: `A password needs at least ${MIN_PASSWORD} characters.` };
  }
  if (password != null && password.length > 200) return { ok: false, code: 'long_password', error: 'That password is too long.' };
  const exp = resolveExpiry(body?.expiry, { sealed, now });
  if (exp.error) return { ok: false, code: 'bad_expiry', error: exp.error };
  return { ok: true, audience, emails: parsed.emails, password, expiresAt: exp.expiresAt };
}

// ── Opening a link ──────────────────────────────────────────────────────────

/** 'active' | 'revoked' | 'expired'. Revoked wins: it is the deliberate act. */
export function linkState(link, now = new Date()) {
  if (!link) return 'missing';
  if (link.revoked_at) return 'revoked';
  if (new Date(link.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** What the recipient has to supply. */
export function linkNeeds(link) {
  return { email_code: link.audience === 'people', password: Boolean(link.password_hash) };
}

export function emailAllowed(link, email) {
  if (link.audience !== 'people') return true;
  const e = normalizeEmail(email);
  return (link.allowed_emails ?? []).some((a) => normalizeEmail(a) === e);
}

/**
 * Judge a code against the newest unused code row for this link and address.
 * Returns 'ok' | 'no_code' | 'expired' | 'too_many' | 'wrong'.
 */
export function judgeCode(row, code, { linkId, email, now = new Date() }) {
  if (!row || row.used_at) return 'no_code';
  if ((row.attempts ?? 0) >= CODE_MAX_ATTEMPTS) return 'too_many';
  if (new Date(row.expires_at).getTime() <= now.getTime()) return 'expired';
  if (!/^\d{6}$/.test(String(code ?? '').trim())) return 'wrong';
  const want = Buffer.from(row.code_hash, 'hex');
  const got = Buffer.from(hashCode(code, { linkId, email }), 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? 'ok' : 'wrong';
}

/** Plain words for each refusal the recipient page can show. */
export const REFUSAL_WORDS = Object.freeze({
  expired: 'This link has expired. Ask the sender for a new one.',
  revoked: 'This link has been turned off by the sender.',
  missing: 'This link does not work. Check that it was copied in full.',
  not_allowed: 'This link is for named people only, and a code could not be sent to that address.',
  no_code: 'Ask for a code first, or ask for a new one.',
  wrong_code: 'That code is not right.',
  code_expired: 'That code has expired. Ask for a new one.',
  too_many: 'Too many wrong tries for that code. Ask for a new one.',
  wrong_password: 'That password is not right.',
  throttled: 'Too many tries. Wait a few minutes and try again.',
});

/** The ZIP's download name: the Bates range when there is one. */
export function packageFilename(prod) {
  const range = batesRange(prod);
  const stem = (range ? range.replace(' – ', '-') : prod?.name || 'production').replace(/[^\w.-]+/g, '_');
  return `${stem}.zip`;
}

export function batesRange(prod) {
  if (!prod?.bates_prefix || prod.bates_start == null) return null;
  const fmt = (n) => `${prod.bates_prefix}${String(n).padStart(prod.bates_pad ?? 7, '0')}`;
  if (prod.bates_end == null || Number(prod.bates_end) === Number(prod.bates_start)) return fmt(prod.bates_start);
  return `${fmt(prod.bates_start)} – ${fmt(prod.bates_end)}`;
}

// The cloud drives a document can be exported to, and the OAuth plumbing they
// share. Google Drive is NOT here: api/drive-export.mjs and the
// google-connect/google-callback pair are older, they work, and they are left
// byte-identical on purpose. This module is the second door, not a rewrite of
// the first.
//
// Everything in here is DORMANT until Eden registers the two applications and
// sets their keys. With the environment variables absent, `isConfigured()` is
// false, every endpoint answers 503 `not_configured` with the variable names
// it wants, and the Connections cards say "Not available yet" instead of
// offering a button that cannot work.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { dropbox } from './dropbox.mjs';
import { onedrive } from './onedrive.mjs';

export const CLOUD_DRIVES = Object.freeze({ onedrive, dropbox });

/** The connections.kind values this module owns. */
export const CLOUD_DRIVE_KINDS = Object.freeze(Object.keys(CLOUD_DRIVES));

export function getDrive(service) {
  return Object.prototype.hasOwnProperty.call(CLOUD_DRIVES, service)
    ? CLOUD_DRIVES[service]
    : null;
}

// The house pattern, matching api/google-callback.mjs: one production origin,
// written down rather than derived from a request header. A redirect URI
// assembled from `req.headers.host` is an open redirect waiting to happen, and
// both providers require the registered value to match exactly anyway.
export const SITE_ORIGIN = 'https://www.contextspaces.ai';
export const APP_CONNECTIONS = `${SITE_ORIGIN}/app/connections`;

export function redirectUriFor(drive) {
  return `${SITE_ORIGIN}${drive.redirectPath}`;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────
// Both providers are confidential clients here — we hold a secret — so PKCE is
// belt and braces rather than the only lock. It is still worth having: it
// binds the authorization code to the browser that started the flow, so a code
// intercepted in a redirect (a logged URL, a shared machine, a referrer leak)
// cannot be redeemed by anyone else.
//
// WHERE THE VERIFIER LIVES, AND WHY NOT IN THE STATE. The obvious serverless
// trick is to put the verifier inside the signed `state`. That defeats the
// point: `state` travels in the same redirect URL as `code`, so anything that
// sees the code sees the verifier. The verifier goes in an HttpOnly cookie
// instead — set on the connect POST, scoped to the callback path, SameSite=Lax
// so the provider's top-level redirect still sends it, ten-minute life. The
// state carries only the user id and which integration this is.

export function newVerifier() {
  // 43–128 characters of [A-Za-z0-9-._~] — base64url of 32 bytes is 43.
  return randomBytes(32).toString('base64url');
}

export function challengeFor(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function verifierCookieName(service) {
  return `csp_cd_pkce_${service}`;
}

export function setVerifierCookie(res, drive, verifier) {
  const cookie = [
    `${verifierCookieName(drive.service)}=${verifier}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Path=${drive.redirectPath}`,
    'Max-Age=600',
  ].join('; ');
  appendSetCookie(res, cookie);
}

export function clearVerifierCookie(res, drive) {
  appendSetCookie(
    res,
    `${verifierCookieName(drive.service)}=; HttpOnly; Secure; SameSite=Lax; Path=${drive.redirectPath}; Max-Age=0`,
  );
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader ? res.getHeader('set-cookie') : undefined;
  const all = existing ? [].concat(existing, cookie) : [cookie];
  res.setHeader('set-cookie', all);
}

export function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Constant-time compare for the PKCE verifier and any other short secret. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── shared HTTP shapes ───────────────────────────────────────────────────────

export function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

export function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader('location', url);
  return res.end();
}

/**
 * The one answer every endpoint gives before the applications exist. A 503
 * with the variable names, not a 500 and not a broken button: "this is not
 * switched on yet" is a different fact from "this is broken", and the
 * Connections card reads the difference.
 */
export function notConfigured(res, drive) {
  return json(res, 503, {
    error: 'not_configured',
    code: 'not_configured',
    service: drive.service,
    label: drive.label,
    missing_env: drive.missingEnv(),
    message:
      `${drive.label} is not available yet — the ${drive.label} application has not been registered for this ` +
      'deployment. Nothing was sent.',
  });
}

export const CORS_HEADERS = Object.freeze({
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
});

export function applyCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}
